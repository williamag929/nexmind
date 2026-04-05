/**
 * analyzer.js — Claude-powered document analysis engine
 *
 * Supports:
 *   - PDF files          → Claude document API (native PDF understanding)
 *   - Images (jpg/png)   → Claude vision API
 *   - Text / CSV / MD    → Plain text analysis
 *   - DOCX               → Text extraction via mammoth (if installed)
 *
 * Extraction targets:
 *   - Invoices  → transaction entities (income / expense)
 *   - Contracts → project + contact/company entities
 *   - Receipts  → transaction entities
 *   - Letters   → contact + event entities
 *   - Generic   → best-effort entity extraction
 */

import fetch from 'node-fetch';
import path from 'path';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = 'claude-sonnet-4-6';

// ── File type detection ───────────────────────────────────────────────────────

const EXT_MAP = {
  pdf:  'pdf',
  jpg:  'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  doc:  'docx',  docx: 'docx',
  txt:  'text',  md:   'text',  csv: 'text',  log: 'text',
  xls:  'spreadsheet', xlsx: 'spreadsheet',
};

const MIME_MAP = {
  'application/pdf':   'pdf',
  'image/jpeg':        'image',
  'image/png':         'image',
  'image/gif':         'image',
  'image/webp':        'image',
  'text/plain':        'text',
  'text/csv':          'text',
  'text/markdown':     'text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'docx',
};

/**
 * Detect the file category from filename and/or MIME type.
 */
export function detectFileType(fileName, mimeType) {
  const ext = (fileName || '').toLowerCase().split('.').pop();
  return EXT_MAP[ext] || MIME_MAP[mimeType] || 'unknown';
}

/**
 * Returns true if this file type can be analyzed by Claude.
 */
export function isAnalyzable(fileName, mimeType) {
  const t = detectFileType(fileName, mimeType);
  return ['pdf', 'image', 'text', 'docx'].includes(t);
}

// ── Build Claude message content ──────────────────────────────────────────────

/**
 * Convert a file buffer into the appropriate Claude API content block.
 * @returns {Promise<Object>} - Claude message content block
 */
async function buildContentBlock(buffer, fileName, mimeType) {
  const fileType = detectFileType(fileName, mimeType);

  // PDF — use Claude's native document understanding
  if (fileType === 'pdf') {
    return {
      type: 'document',
      source: {
        type:       'base64',
        media_type: 'application/pdf',
        data:       buffer.toString('base64'),
      },
    };
  }

  // Image — use Claude's vision capabilities
  if (fileType === 'image') {
    // Normalize MIME type for Claude
    const ext     = fileName.toLowerCase().split('.').pop();
    const imgMime = mimeType?.startsWith('image/') ? mimeType : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    return {
      type: 'image',
      source: {
        type:       'base64',
        media_type: imgMime,
        data:       buffer.toString('base64'),
      },
    };
  }

  // DOCX — attempt mammoth extraction, fall back to raw bytes as text
  if (fileType === 'docx') {
    const text = await extractDocxText(buffer);
    return { type: 'text', text: `[DOCX: ${fileName}]\n\n${text}` };
  }

  // Plain text / CSV / Markdown
  return { type: 'text', text: `[FILE: ${fileName}]\n\n${buffer.toString('utf-8')}` };
}

/**
 * Extract text from a DOCX buffer using mammoth (optional dependency).
 * Falls back to a placeholder if mammoth is not installed.
 */
async function extractDocxText(buffer) {
  try {
    const mammoth = await import('mammoth');
    const result  = await mammoth.extractRawText({ buffer });
    return result.value || '[empty document]';
  } catch {
    // mammoth not installed or failed — return generic notice
    return '[DOCX content could not be extracted — install mammoth for better DOCX support]';
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT = `You are a document analysis engine integrated into NexMind, a personal AI memory system.
Analyze the provided document and extract ALL relevant structured information.

Return ONLY valid JSON — no markdown fences, no explanation — in this exact format:

{
  "document_type": "invoice|receipt|contract|report|letter|id|other",
  "summary": "1-2 sentence description of the document",
  "language": "es|en|fr|etc",
  "entities": [
    {
      "type": "contact|company|transaction|project|event|task|document",
      "action": "create",
      "tempId": "temp_0",
      "data": { ...fields }
    }
  ],
  "relations": [
    { "from_temp_id": "temp_0", "to_temp_id": "temp_1", "type": "relation_type" }
  ],
  "metadata": {
    "date": "YYYY-MM-DD or null",
    "total_amount": null or number,
    "currency": "USD|EUR|MXN|etc or null",
    "parties": ["Name 1", "Name 2"],
    "reference_number": "invoice/contract/order number or null",
    "due_date": "YYYY-MM-DD or null"
  }
}

Entity field schemas:
- contact:     { name*, email, phone, company, role, address, tax_id, notes }
- company:     { name*, industry, address, website, tax_id, notes }
- transaction: { type*(income|expense), amount*(number), currency, description*, contact, project, date, category, reference }
- project:     { name*, client, status(active|paused|done), value, currency, start_date, end_date, description }
- event:       { title*, date, time, location, contact, description }
- task:        { title*, due, priority(low|normal|high|urgent), status(pending), assignee, project, notes }
- document:    { title*, type, date, contact, project, notes, nextcloud_path }

Relation types:
  client_of    — company/contact is a client of project
  issued_by    — transaction/document was issued by contact/company
  billed_to    — transaction/document was billed to contact/company
  part_of      — entity belongs to a project
  works_at     — contact works at company
  assigned_to  — task assigned to contact
  related_to   — generic relation

Document-specific extraction rules:
- INVOICE received (you pay)  → transaction { type: "expense" }; extract vendor as contact/company
- INVOICE issued  (you receive) → transaction { type: "income" }; extract client as contact/company
- RECEIPT                     → transaction { type: "expense" }; extract merchant as company
- CONTRACT                    → project + all involved parties as contacts/companies
- EMPLOYMENT CONTRACT         → contact + task (start date) + company
- LETTER / EMAIL              → contact (sender) + event if meeting is mentioned
- ID / PASSPORT               → contact with full details

If nothing useful can be extracted, return:
{ "document_type": "other", "summary": "...", "entities": [], "relations": [], "metadata": {} }`;

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * Analyze a document buffer with Claude and return structured extraction.
 *
 * @param {Buffer}  buffer    - Raw file bytes
 * @param {string}  fileName  - Original filename (for type detection)
 * @param {string}  mimeType  - MIME type from Nextcloud
 * @param {string}  ncPath    - Original Nextcloud path (stored in metadata)
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzeDocument(buffer, fileName, mimeType, ncPath = '') {
  // Build the appropriate content block for this file type
  const contentBlock = await buildContentBlock(buffer, fileName, mimeType);

  // Inject filename and path into the user message for context
  const userMessage = {
    role: 'user',
    content: [
      contentBlock,
      {
        type: 'text',
        text: `Analyze this document. File name: "${fileName}". Nextcloud path: "${ncPath}".
Extract all structured information and return JSON as instructed.`,
      },
    ],
  };

  // Build request headers — add PDF beta for document type
  const headers = {
    'Content-Type':     'application/json',
    'x-api-key':        ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
  };

  const fileType = detectFileType(fileName, mimeType);
  if (fileType === 'pdf') {
    // PDF support is native in claude-sonnet-4-6 — beta header kept for compatibility
    headers['anthropic-beta'] = 'pdfs-2024-09-25';
  }

  let responseJson;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 2048,
        system:     ANALYSIS_SYSTEM_PROMPT,
        messages:   [userMessage],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[analyzer] Claude API error:', data);
      throw new Error(`Claude API ${response.status}: ${data?.error?.message || 'unknown error'}`);
    }

    const rawText = data.content?.find(b => b.type === 'text')?.text || '{}';
    responseJson  = JSON.parse(rawText);
  } catch (err) {
    if (err instanceof SyntaxError) {
      // JSON parse failure — return safe fallback
      console.error('[analyzer] JSON parse failed for:', fileName);
      return fallbackResult(fileName, ncPath, 'JSON parse error');
    }
    throw err;
  }

  // Validate structure — ensure required keys exist
  return {
    document_type: responseJson.document_type || 'other',
    summary:       responseJson.summary       || '',
    language:      responseJson.language      || 'en',
    entities:      Array.isArray(responseJson.entities)  ? responseJson.entities  : [],
    relations:     Array.isArray(responseJson.relations) ? responseJson.relations : [],
    metadata:      responseJson.metadata      || {},
    file_name:     fileName,
    nc_path:       ncPath,
    analyzed_at:   new Date().toISOString(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fallbackResult(fileName, ncPath, reason) {
  return {
    document_type: 'other',
    summary:       `Could not analyze file: ${reason}`,
    language:      'en',
    entities:      [],
    relations:     [],
    metadata:      {},
    file_name:     fileName,
    nc_path:       ncPath,
    analyzed_at:   new Date().toISOString(),
    error:         reason,
  };
}

/**
 * @typedef {Object} AnalysisResult
 * @property {string}   document_type
 * @property {string}   summary
 * @property {string}   language
 * @property {Array}    entities
 * @property {Array}    relations
 * @property {Object}   metadata
 * @property {string}   file_name
 * @property {string}   nc_path
 * @property {string}   analyzed_at
 */
