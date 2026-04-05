import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDB, createEntity, updateEntity, deleteEntity,
  getEntity, getEntitiesByType, searchEntities, getAllEntities,
  createRelation, getRelations, buildMemoryContext,
  logMemory, saveConversation, getConversation, getConversations, deleteConversation,
  listNextcloudFiles, nextcloudFileStats, getNextcloudFile,
} from './db.js';
import {
  verifyWebhookSecret, normalizePayload,
  processNextcloudFile, shouldProcess,
} from './src/webhook.js';
import { analyzeDocument, isAnalyzable, detectFileType } from './src/analyzer.js';
import { pingNextcloud } from './src/nextcloud.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

initDB();

const upload = multer({ dest: 'uploads/', limits: { fileSize: 20 * 1024 * 1024 } });
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// ── Entity extraction prompt ──────────────────────────────
function extractionPrompt(lang) {
  return `You are a data extraction engine. Analyze the user message and extract structured entities.
Return ONLY valid JSON, no explanation. Format:
{
  "entities": [
    {
      "type": "contact|company|event|task|transaction|project|document",
      "action": "create|update|delete",
      "id": "existing-id-if-update-or-delete",
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

If nothing to extract, return: { "entities": [], "relations": [] }
Language hint: ${lang}`;
}

// ── Claude API call ───────────────────────────────────────
async function callClaude(messages, system, stream = false, signal = null) {
  const body = { model: MODEL, max_tokens: 4096, system, messages, stream };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal
  });
  return res;
}

async function callClaudeJSON(messages, system) {
  const res = await callClaude(messages, system, false);
  const data = await res.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '{}';
  try { return JSON.parse(text); } catch { return { entities: [], relations: [] }; }
}

// ── Routes: Entities ──────────────────────────────────────
app.get('/api/entities', (req, res) => {
  const { type, q } = req.query;
  if (q) return res.json(searchEntities(q));
  if (type) return res.json(getEntitiesByType(type));
  res.json(getAllEntities());
});

app.post('/api/entities', (req, res) => {
  const { type, data } = req.body;
  const entity = createEntity(type, data);
  res.json(entity);
});

app.put('/api/entities/:id', (req, res) => {
  const entity = updateEntity(req.params.id, req.body.data);
  res.json(entity);
});

app.delete('/api/entities/:id', (req, res) => {
  deleteEntity(req.params.id);
  res.json({ ok: true });
});

app.get('/api/entities/:id/relations', (req, res) => {
  res.json(getRelations(req.params.id));
});

// ── Routes: Finance summary ───────────────────────────────
app.get('/api/finance/summary', (req, res) => {
  const transactions = getEntitiesByType('transaction');
  const income = transactions.filter(t => t.data.type === 'income');
  const expense = transactions.filter(t => t.data.type === 'expense');
  const totalIncome = income.reduce((s, t) => s + (t.data.amount || 0), 0);
  const totalExpense = expense.reduce((s, t) => s + (t.data.amount || 0), 0);

  // Group by category
  const byCategory = {};
  transactions.forEach(t => {
    const cat = t.data.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = { income: 0, expense: 0 };
    byCategory[cat][t.data.type] = (byCategory[cat][t.data.type] || 0) + (t.data.amount || 0);
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

// ── Routes: Chat (main) ───────────────────────────────────
app.post('/api/chat', upload.single('file'), async (req, res) => {
  try {
    const { conv_id, message, lang } = req.body;
    const language = lang || 'es';

    // Load or create conversation
    const conv = getConversation(conv_id) || { id: conv_id, messages: [] };
    const userContent = message;

    // Add user message
    conv.messages.push({ role: 'user', content: userContent });

    // 1. Extract entities from message (non-blocking parallel)
    const extractionPromise = callClaudeJSON(
      [{ role: 'user', content: userContent }],
      extractionPrompt(language)
    );

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

    // Stream response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const abortCtrl = new AbortController();
    req.on('close', () => abortCtrl.abort());

    const claudeRes = await callClaude(conv.messages, systemPrompt, true, abortCtrl.signal);

    let fullResponse = '';
    const decoder = new TextDecoder();

    for await (const chunk of claudeRes.body) {
      const text = decoder.decode(chunk);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullResponse += parsed.delta.text;
            res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
          }
          if (parsed.type === 'message_stop') {
            // Process extraction results
            const extracted = await extractionPromise;
            const createdIds = {};

            if (extracted.entities?.length) {
              for (const e of extracted.entities) {
                if (e.action === 'create') {
                  const entity = createEntity(e.type, e.data);
                  if (e.tempId) createdIds[e.tempId] = entity.id;
                  else createdIds[e.type + '_latest'] = entity.id;
                } else if (e.action === 'update' && e.id) {
                  updateEntity(e.id, e.data);
                } else if (e.action === 'delete' && e.id) {
                  deleteEntity(e.id);
                }
              }

              // Create relations
              if (extracted.relations?.length) {
                for (const r of extracted.relations) {
                  const fromId = createdIds[r.from_id] || r.from_id;
                  const toId = createdIds[r.to_id] || r.to_id;
                  if (fromId && toId) createRelation(fromId, toId, r.type);
                }
              }

              logMemory(conv_id, userContent, extracted);
              res.write(`data: ${JSON.stringify({ memory_updated: true, count: extracted.entities.length })}\n\n`);
            }

            // Save conversation
            conv.messages.push({ role: 'assistant', content: fullResponse });
            const title = conv.messages[0]?.content?.slice(0, 50) || 'Conversación';
            saveConversation(conv_id, title, conv.messages);

            res.write('data: [DONE]\n\n');
            res.end();
          }
        } catch {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ── Nextcloud Webhook ─────────────────────────────────────────────────────────
// Nextcloud Flow sends POST requests here when files are created/updated.
// Configure this URL in Nextcloud: Settings → Flow → Webhook → http://nexmind:3000/api/webhook/nextcloud
// Set the X-Webhook-Secret header to match WEBHOOK_SECRET in .env

app.post('/api/webhook/nextcloud', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  // Verify the shared secret
  if (!verifyWebhookSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized — invalid webhook secret' });
  }

  let payload;
  try {
    const rawBody = req.body?.toString() || '{}';
    payload = normalizePayload(JSON.parse(rawBody));
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
app.post('/api/files/analyze', express.json(), async (req, res) => {
  const { path: filePath, name: fileName, mime_type: mimeType } = req.body;
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
  const { path: filePath, name: fileName, mime_type: mimeType } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  res.json({ ok: true, message: 'Test processing started', path: filePath });

  setImmediate(() => {
    processNextcloudFile(filePath, fileName || filePath.split('/').pop(), mimeType || '')
      .catch(err => console.error('[webhook-test] Error:', err));
  });
});

app.listen(PORT, () => console.log(`NexMind running → http://localhost:${PORT}`));
