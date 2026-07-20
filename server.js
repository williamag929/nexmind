import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDB, createEntity, updateEntity, deleteEntity,
  getEntity, getEntitiesByType, searchEntities, getAllEntities,
  createRelation, getRelations, getAllRelations, buildMemoryContext,
  logMemory, saveConversation, getConversation, getConversations, deleteConversation,
  listNextcloudFiles, nextcloudFileStats, getNextcloudFile,
} from './db.js';
import {
  verifyWebhookSecret, normalizePayload,
  processNextcloudFile, shouldProcess,
} from './src/webhook.js';
import { pingNextcloud } from './src/nextcloud.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

initDB();

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const API_TOKEN = process.env.API_TOKEN || '';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '30', 10); // messages sent to Claude per chat turn

const ENTITY_TYPES = new Set(['contact', 'company', 'event', 'task', 'transaction', 'project', 'document']);

// Extraction results awaiting user confirmation before they're written to
// memory. Keyed by reviewId (crypto.randomUUID()). In-memory only — this is a
// single-user, single-process app, so a restart simply drops pending reviews
// (they were never persisted, so nothing is lost from the actual memory).
const pendingReviews = new Map();
const PENDING_REVIEW_TTL_MS = 30 * 60 * 1000; // 30 min
setInterval(() => {
  const cutoff = Date.now() - PENDING_REVIEW_TTL_MS;
  for (const [id, r] of pendingReviews) if (r.createdAt < cutoff) pendingReviews.delete(id);
}, 5 * 60 * 1000).unref();

// ── Helpers ───────────────────────────────────────────────
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Strip markdown code fences that Claude sometimes wraps around JSON. */
function stripJsonFences(text) {
  return text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// ── Auth middleware ───────────────────────────────────────
// All /api routes require `Authorization: Bearer <API_TOKEN>` when API_TOKEN is set.
// Exception: /api/webhook/* — authenticated separately via WEBHOOK_SECRET.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/webhook')) return next();
  if (!API_TOKEN) return next(); // auth disabled — warned at boot
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token && timingSafeEqual(token, API_TOKEN)) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// ── Entity extraction prompt ──────────────────────────────
// NOTE: deliberately no "delete" action — automatic deletion driven by LLM
// extraction is a prompt-injection risk (a message/document could wipe data).
function extractionPrompt(lang) {
  return `You are a data extraction engine. Analyze the user message and extract structured entities.
Return ONLY valid JSON, no explanation, no markdown fences. Format:
{
  "entities": [
    {
      "type": "contact|company|event|task|transaction|project|document",
      "action": "create|update",
      "id": "existing-id-if-update",
      "tempId": "temp_0",
      "data": { ...fields }
    }
  ],
  "relations": [
    { "from_id": "temp-or-real-id", "to_id": "temp-or-real-id", "type": "relation_type" }
  ]
}

Entity field schemas:
- contact: { name, email, phone, company, role, notes, tags[] }
- company: { name, industry, address, website, notes }
- event: { title, date, time, location, contact, description, status }
- task: { title, due, priority(low|normal|high|urgent), status(pending|in_progress|done), assignee, project, notes }
- transaction: { type(income|expense), amount(number), currency(USD), description, contact, project, date, category, receipt }
- project: { name, client, status(active|paused|done), value(number), currency, start_date, end_date, description }
- document: { title, type, date, contact, project, notes }

Relation types: works_at, owns, attended, paid_by, assigned_to, part_of, related_to, client_of

Give every created entity a unique tempId (temp_0, temp_1, ...) and reference those tempIds in relations.
If nothing to extract, return: { "entities": [], "relations": [] }
Language hint: ${lang}`;
}

// ── Claude API call ───────────────────────────────────────
async function callClaude(messages, system, stream = false, signal = null) {
  const body = {
    model: MODEL,
    max_tokens: 4096,
    // Prompt caching: system prompts (memory context / extraction rules) are
    // reused across requests — cache them to cut latency and cost.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    stream,
  };
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal,
  });
}

async function callClaudeJSON(messages, system) {
  const res = await callClaude(messages, system, false);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Claude API ${res.status}: ${data?.error?.message || 'unknown error'}`);
  }
  const text = data.content?.find(b => b.type === 'text')?.text || '{}';
  try { return JSON.parse(stripJsonFences(text)); } catch { return { entities: [], relations: [] }; }
}

// ── Routes: Entities ──────────────────────────────────────
app.get('/api/entities', (req, res) => {
  const { type, q } = req.query;
  if (q) return res.json(searchEntities(q));
  if (type) return res.json(getEntitiesByType(type));
  res.json(getAllEntities());
});

app.post('/api/entities', (req, res) => {
  const { type, data } = req.body || {};
  if (!ENTITY_TYPES.has(type)) return res.status(400).json({ error: `Invalid type. Must be one of: ${[...ENTITY_TYPES].join(', ')}` });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object is required' });
  res.json(createEntity(type, data));
});

app.put('/api/entities/:id', (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object is required' });
  const entity = updateEntity(req.params.id, data);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });
  res.json(entity);
});

app.delete('/api/entities/:id', (req, res) => {
  deleteEntity(req.params.id);
  res.json({ ok: true });
});

app.get('/api/entities/:id/relations', (req, res) => {
  res.json(getRelations(req.params.id));
});

app.get('/api/relations', (req, res) => {
  res.json(getAllRelations());
});

// ── Routes: Memory review (confirm/discard pending extractions) ───────────
app.get('/api/memory/review/:id', (req, res) => {
  const r = pendingReviews.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Review not found or expired' });
  res.json({ entities: r.entities, relations: r.relations });
});

app.post('/api/memory/review/:id/confirm', (req, res) => {
  const r = pendingReviews.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Review not found or expired' });

  const { indexes } = req.body || {};
  // An array (even empty) means "persist exactly these indexes". Omitting
  // the field entirely means "accept everything" (null = no filter).
  const acceptedSet = Array.isArray(indexes) ? new Set(indexes.filter(i => Number.isInteger(i))) : null;

  const count = persistExtraction(r.convId, r.userContent, { entities: r.entities, relations: r.relations }, acceptedSet);
  pendingReviews.delete(req.params.id);
  res.json({ ok: true, count });
});

app.post('/api/memory/review/:id/discard', (req, res) => {
  pendingReviews.delete(req.params.id);
  res.json({ ok: true });
});

// ── Routes: Finance summary ───────────────────────────────
app.get('/api/finance/summary', (req, res) => {
  const transactions = getEntitiesByType('transaction');
  const income = transactions.filter(t => t.data.type === 'income');
  const expense = transactions.filter(t => t.data.type === 'expense');
  const totalIncome = income.reduce((s, t) => s + (Number(t.data.amount) || 0), 0);
  const totalExpense = expense.reduce((s, t) => s + (Number(t.data.amount) || 0), 0);

  // Group by category
  const byCategory = {};
  transactions.forEach(t => {
    const type = t.data.type === 'income' ? 'income' : 'expense';
    const cat = t.data.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = { income: 0, expense: 0 };
    byCategory[cat][type] += Number(t.data.amount) || 0;
  });

  res.json({ totalIncome, totalExpense, balance: totalIncome - totalExpense, byCategory, transactions: transactions.slice(0, 50) });
});

// ── Routes: Conversations ─────────────────────────────────
app.get('/api/conversations', (req, res) => res.json(getConversations()));

app.get('/api/conversations/:id', (req, res) => {
  const conv = getConversation(req.params.id);
  res.json(conv || { id: req.params.id, messages: [] });
});

app.delete('/api/conversations/:id', (req, res) => {
  deleteConversation(req.params.id);
  res.json({ ok: true });
});

// ── Routes: Memory context ────────────────────────────────
app.get('/api/memory', (req, res) => {
  const lang = req.query.lang || 'es';
  res.json({ context: buildMemoryContext(lang) });
});

// ── Persist extraction results (create/update only) ───────
// acceptedIndexes: optional Set of indexes into extracted.entities to persist.
// null/undefined means accept everything (used for internal/legacy callers).
function persistExtraction(convId, userContent, extracted, acceptedIndexes = null) {
  if (!extracted?.entities?.length) return 0;

  const createdIds = {};
  let count = 0;
  extracted.entities.forEach((e, i) => {
    if (acceptedIndexes && !acceptedIndexes.has(i)) return;
    if (!ENTITY_TYPES.has(e.type) || !e.data || typeof e.data !== 'object') return;
    try {
      if (e.action === 'update' && e.id) {
        updateEntity(e.id, e.data);
      } else {
        const entity = createEntity(e.type, e.data);
        if (e.tempId) createdIds[e.tempId] = entity.id;
      }
      count++;
    } catch (err) {
      console.error('[extract] Failed to persist entity:', err.message);
    }
  });

  if (extracted.relations?.length) {
    for (const r of extracted.relations) {
      const fromId = createdIds[r.from_id] || r.from_id;
      const toId = createdIds[r.to_id] || r.to_id;
      // Only create relations between entities that actually exist (FK would
      // throw otherwise) — this also naturally drops relations pointing at
      // entities the user chose not to save.
      if (fromId && toId && getEntity(fromId) && getEntity(toId)) {
        try { createRelation(fromId, toId, r.type); } catch (err) {
          console.error('[extract] Failed to create relation:', err.message);
        }
      }
    }
  }

  logMemory(convId, userContent, extracted);
  return count;
}

// ── Routes: Chat (main) ───────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { conv_id, message, lang } = req.body || {};
  if (!conv_id || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'conv_id and message are required' });
  }
  const language = lang === 'en' ? 'en' : 'es';

  // Load or create conversation
  const conv = getConversation(conv_id) || { id: conv_id, messages: [] };
  conv.messages.push({ role: 'user', content: message });

  // 1. Extract entities from message (runs in parallel; failures never break chat)
  const extractionPromise = callClaudeJSON(
    [{ role: 'user', content: message }],
    extractionPrompt(language)
  ).catch(err => {
    console.error('[extract] Extraction failed:', err.message);
    return { entities: [], relations: [] };
  });

  // 2. Build memory context
  const memoryCtx = buildMemoryContext(language);

  const systemPrompt = language === 'es'
    ? `Eres NexMind, un asistente personal inteligente con memoria persistente.
Tienes acceso completo a la información del usuario: contactos, agenda, finanzas, proyectos y tareas.
Responde siempre en español a menos que el usuario escriba en inglés.
Cuando el usuario mencione personas, eventos, transacciones o proyectos, los recuerdas y conectas automáticamente.
Sé conciso, preciso y útil. Usa los datos de memoria para dar respuestas personalizadas.

${memoryCtx}`
    : `You are NexMind, an intelligent personal assistant with persistent memory.
You have full access to user data: contacts, calendar, finances, projects and tasks.
Respond in English unless the user writes in Spanish.
When users mention people, events, transactions or projects, you recall and connect them automatically.
Be concise, precise and helpful. Use memory data for personalized responses.

${memoryCtx}`;

  // 3. Stream response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const abortCtrl = new AbortController();
  // Abort the upstream Claude request only if the client disconnects mid-stream.
  // NOTE: req 'close' fires when the request body completes in modern Node (wrong
  // signal — it aborted every request immediately). res 'close' + writableEnded
  // check correctly detects a premature client disconnect.
  res.on('close', () => { if (!res.writableEnded) abortCtrl.abort(); });

  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  let fullResponse = '';
  try {
    // Truncate history sent to Claude (full history is still stored in the DB)
    const history = conv.messages.slice(-MAX_HISTORY);
    const claudeRes = await callClaude(history, systemPrompt, true, abortCtrl.signal);

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error(`Claude API ${claudeRes.status}: ${errText.slice(0, 300)}`);
    }

    // Buffered SSE parsing — events can span chunk boundaries
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of claudeRes.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep trailing partial line for next chunk
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          fullResponse += parsed.delta.text;
          send({ text: parsed.delta.text });
        } else if (parsed.type === 'error') {
          throw new Error(parsed.error?.message || 'Stream error');
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[chat]', err);
      send({ error: err.message });
    }
  }

  // 4. Stage extraction results for review — nothing is written to memory
  // until the user confirms via POST /api/memory/review/:id/confirm. This
  // gives a chance to catch bad extractions (wrong name, wrong amount, a
  // prompt-injected entry from a document) before they land in memory.
  try {
    const extracted = await extractionPromise;
    if (extracted.entities?.length) {
      const reviewId = crypto.randomUUID();
      pendingReviews.set(reviewId, {
        convId: conv_id,
        userContent: message,
        entities: extracted.entities,
        relations: extracted.relations || [],
        createdAt: Date.now(),
      });
      send({
        memory_pending: true,
        reviewId,
        entities: extracted.entities.map(e => ({ type: e.type, action: e.action, data: e.data })),
      });
    }
  } catch (err) {
    console.error('[chat] Extraction staging error:', err);
  }

  if (fullResponse) {
    conv.messages.push({ role: 'assistant', content: fullResponse });
    const title = conv.messages[0]?.content?.slice(0, 50) || 'Conversación';
    try { saveConversation(conv_id, title, conv.messages); } catch (err) {
      console.error('[chat] Failed to save conversation:', err);
    }
  }

  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ── Nextcloud Webhook ─────────────────────────────────────────────────────────
// Nextcloud Flow sends POST requests here when files are created/updated.
// Configure this URL in Nextcloud: Settings → Flow → Webhook → http://nexmind:3000/api/webhook/nextcloud
// Set the X-Webhook-Secret header to match WEBHOOK_SECRET in .env (required)

app.post('/api/webhook/nextcloud', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  // Verify the shared secret
  if (!verifyWebhookSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized — invalid or missing webhook secret' });
  }

  let payload;
  try {
    // Body may arrive as a Buffer (express.raw), a string, or an already-parsed
    // object (global express.json runs first for application/json requests).
    let parsed;
    if (Buffer.isBuffer(req.body)) parsed = JSON.parse(req.body.toString() || '{}');
    else if (typeof req.body === 'string') parsed = JSON.parse(req.body || '{}');
    else parsed = req.body || {};
    payload = normalizePayload(parsed);
  } catch (err) {
    return res.status(400).json({ error: `Invalid payload: ${err.message}` });
  }

  const { event, filePath, fileName, mimeType } = payload;

  // Respond immediately so Nextcloud doesn't time out
  res.json({ ok: true, message: 'Queued for processing', file: fileName });

  // Process asynchronously after response is sent
  if (shouldProcess(event)) {
    setImmediate(() => {
      processNextcloudFile(filePath, fileName, mimeType).catch(err => {
        console.error('[webhook] Unhandled error:', err);
      });
    });
  }
});

// ── Nextcloud Files — API ─────────────────────────────────────────────────────

// List all files processed by NexMind from Nextcloud
app.get('/api/files', (req, res) => {
  const { status, limit = 100 } = req.query;
  const files = listNextcloudFiles(status || null, parseInt(limit));
  const stats  = nextcloudFileStats();
  res.json({ files, stats });
});

// Get a single processed file record
app.get('/api/files/:id', (req, res) => {
  const file = getNextcloudFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  // Parse the stored analysis JSON for a richer response
  if (file.analysis_json) {
    try { file.analysis = JSON.parse(file.analysis_json); } catch {}
    delete file.analysis_json;
  }
  res.json(file);
});

// Manually trigger analysis of a Nextcloud file (for testing / re-processing)
// Protected by the API token middleware above.
app.post('/api/files/analyze', async (req, res) => {
  const { path: filePath, name: fileName, mime_type: mimeType } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'path is required' });

  res.json({ ok: true, message: 'Analysis started', path: filePath });

  setImmediate(() => {
    processNextcloudFile(filePath, fileName || filePath.split('/').pop(), mimeType || '')
      .catch(err => console.error('[analyze] Error:', err));
  });
});

// ── Nextcloud Connection status ───────────────────────────────────────────────

app.get('/api/nextcloud/status', async (req, res) => {
  try {
    const alive = await pingNextcloud();
    res.json({
      connected: alive,
      url:       process.env.NEXTCLOUD_URL || 'http://nextcloud',
      user:      process.env.NEXTCLOUD_USER || 'admin',
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// Webhook test endpoint — simulate a Nextcloud file event (dev/debug only)
app.post('/api/webhook/test', express.json(), async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Test endpoint disabled in production' });
  }
  const { path: filePath, name: fileName, mime_type: mimeType } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'path required' });

  res.json({ ok: true, message: 'Test processing started', path: filePath });

  setImmediate(() => {
    processNextcloudFile(filePath, fileName || filePath.split('/').pop(), mimeType || '')
      .catch(err => console.error('[webhook-test] Error:', err));
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
if (!ANTHROPIC_KEY) console.warn('⚠ ANTHROPIC_API_KEY is not set — AI features will fail.');
if (!API_TOKEN) console.warn('⚠ API_TOKEN is not set — the API is UNAUTHENTICATED. Set API_TOKEN in .env to protect it.');
if (!process.env.WEBHOOK_SECRET) console.warn('⚠ WEBHOOK_SECRET is not set — Nextcloud webhooks will be rejected.');

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

app.listen(PORT, () => console.log(`NexMind running → http://localhost:${PORT}`));
