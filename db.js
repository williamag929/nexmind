import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'db', 'nexmind.db');

let db;

export function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Core entities table (polymorphic)
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL, -- contact, company, event, task, transaction, project, document
      data TEXT NOT NULL, -- JSON blob
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Relations graph
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation_type TEXT NOT NULL, -- works_at, owns, attended, paid, assigned_to, etc
      meta TEXT, -- JSON extra data
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(from_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY(to_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    -- Memory log (what Claude extracted from conversations)
    CREATE TABLE IF NOT EXISTS memory_log (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      user_message TEXT,
      extracted TEXT, -- JSON: what was extracted
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Conversations
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      messages TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Nextcloud file tracking table
    -- Records every file received via webhook and its analysis status/results
    CREATE TABLE IF NOT EXISTS nextcloud_files (
      id            TEXT PRIMARY KEY,
      path          TEXT UNIQUE NOT NULL,  -- Nextcloud path e.g. /Documents/invoice.pdf
      name          TEXT NOT NULL,
      mime_type     TEXT,
      size          INTEGER,
      status        TEXT DEFAULT 'pending', -- pending | processing | done | skipped | error
      document_type TEXT,                   -- invoice | contract | receipt | other
      summary       TEXT,
      entity_count  INTEGER DEFAULT 0,
      document_id   TEXT,                   -- FK to entities.id (the linked document entity)
      analysis_json TEXT,                   -- Full Claude analysis result (JSON blob)
      error_msg     TEXT,
      elapsed_ms    INTEGER,
      reason        TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(document_id) REFERENCES entities(id) ON DELETE SET NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_entities_type   ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_relations_from  ON relations(from_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to    ON relations(to_id);
    CREATE INDEX IF NOT EXISTS idx_nc_files_status ON nextcloud_files(status);
    CREATE INDEX IF NOT EXISTS idx_nc_files_path   ON nextcloud_files(path);
  `);

  return db;
}

export function getDB() { return db; }

// ── Entities ──────────────────────────────────────────────
export function createEntity(type, data) {
  const id = uuidv4();
  db.prepare(`INSERT INTO entities (id, type, data) VALUES (?, ?, ?)`).run(id, type, JSON.stringify(data));
  return { id, type, data };
}

export function updateEntity(id, data) {
  const existing = getEntity(id);
  if (!existing) return null;
  const merged = { ...existing.data, ...data };
  db.prepare(`UPDATE entities SET data=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(merged), id);
  return getEntity(id);
}

export function deleteEntity(id) {
  db.prepare(`DELETE FROM entities WHERE id=?`).run(id);
}

export function getEntity(id) {
  const row = db.prepare(`SELECT * FROM entities WHERE id=?`).get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

export function getEntitiesByType(type) {
  return db.prepare(`SELECT * FROM entities WHERE type=? ORDER BY updated_at DESC`).all(type)
    .map(r => ({ ...r, data: JSON.parse(r.data) }));
}

export function searchEntities(query) {
  const q = `%${query}%`;
  return db.prepare(`SELECT * FROM entities WHERE data LIKE ? ORDER BY updated_at DESC LIMIT 20`).all(q)
    .map(r => ({ ...r, data: JSON.parse(r.data) }));
}

export function getAllEntities() {
  return db.prepare(`SELECT * FROM entities ORDER BY updated_at DESC`).all()
    .map(r => ({ ...r, data: JSON.parse(r.data) }));
}

// ── Relations ─────────────────────────────────────────────
export function createRelation(fromId, toId, relationType, meta = {}) {
  const id = uuidv4();
  db.prepare(`INSERT OR IGNORE INTO relations (id, from_id, to_id, relation_type, meta) VALUES (?, ?, ?, ?, ?)`)
    .run(id, fromId, toId, relationType, JSON.stringify(meta));
  return id;
}

export function getRelations(entityId) {
  const outgoing = db.prepare(`
    SELECT r.*, e.type as to_type, e.data as to_data
    FROM relations r JOIN entities e ON r.to_id = e.id
    WHERE r.from_id = ?
  `).all(entityId).map(r => ({ ...r, to_data: JSON.parse(r.to_data), meta: r.meta ? JSON.parse(r.meta) : {} }));

  const incoming = db.prepare(`
    SELECT r.*, e.type as from_type, e.data as from_data
    FROM relations r JOIN entities e ON r.from_id = e.id
    WHERE r.to_id = ?
  `).all(entityId).map(r => ({ ...r, from_data: JSON.parse(r.from_data), meta: r.meta ? JSON.parse(r.meta) : {} }));

  return { outgoing, incoming };
}

// ── Memory context builder ─────────────────────────────────
export function buildMemoryContext(lang = 'es') {
  const contacts = getEntitiesByType('contact').slice(0, 20);
  const companies = getEntitiesByType('company').slice(0, 10);
  const events = getEntitiesByType('event').slice(0, 10);
  const tasks = getEntitiesByType('task').filter(t => t.data.status !== 'done').slice(0, 10);
  const transactions = getEntitiesByType('transaction').slice(0, 20);
  const projects = getEntitiesByType('project').slice(0, 10);

  const totalIncome = transactions.filter(t => t.data.type === 'income').reduce((s, t) => s + (t.data.amount || 0), 0);
  const totalExpense = transactions.filter(t => t.data.type === 'expense').reduce((s, t) => s + (t.data.amount || 0), 0);

  const label = lang === 'es' ? {
    mem: 'MEMORIA DEL SISTEMA', contacts: 'CONTACTOS', companies: 'EMPRESAS',
    events: 'PRÓXIMOS EVENTOS', tasks: 'TAREAS PENDIENTES', finance: 'FINANZAS',
    projects: 'PROYECTOS', balance: 'Balance', income: 'Ingresos', expense: 'Gastos'
  } : {
    mem: 'SYSTEM MEMORY', contacts: 'CONTACTS', companies: 'COMPANIES',
    events: 'UPCOMING EVENTS', tasks: 'PENDING TASKS', finance: 'FINANCES',
    projects: 'PROJECTS', balance: 'Balance', income: 'Income', expense: 'Expenses'
  };

  let ctx = `[${label.mem}]\n`;

  if (contacts.length) {
    ctx += `\n${label.contacts}:\n`;
    contacts.forEach(c => {
      const d = c.data;
      ctx += `- ${d.name}${d.email ? ` <${d.email}>` : ''}${d.phone ? ` | ${d.phone}` : ''}${d.company ? ` @ ${d.company}` : ''} [id:${c.id.slice(0,8)}]\n`;
    });
  }

  if (companies.length) {
    ctx += `\n${label.companies}:\n`;
    companies.forEach(c => ctx += `- ${c.data.name}${c.data.industry ? ` (${c.data.industry})` : ''} [id:${c.id.slice(0,8)}]\n`);
  }

  if (events.length) {
    ctx += `\n${label.events}:\n`;
    events.forEach(e => {
      const d = e.data;
      ctx += `- ${d.title}${d.date ? ` | ${d.date}` : ''}${d.contact ? ` | con: ${d.contact}` : ''} [id:${e.id.slice(0,8)}]\n`;
    });
  }

  if (tasks.length) {
    ctx += `\n${label.tasks}:\n`;
    tasks.forEach(t => {
      const d = t.data;
      ctx += `- [${d.priority || 'normal'}] ${d.title}${d.due ? ` | vence: ${d.due}` : ''}${d.assignee ? ` | ${d.assignee}` : ''} [id:${t.id.slice(0,8)}]\n`;
    });
  }

  if (transactions.length) {
    ctx += `\n${label.finance}:\n`;
    ctx += `  ${label.balance}: $${(totalIncome - totalExpense).toLocaleString()} | ${label.income}: $${totalIncome.toLocaleString()} | ${label.expense}: $${totalExpense.toLocaleString()}\n`;
    transactions.slice(0, 8).forEach(t => {
      const d = t.data;
      ctx += `  - [${d.type}] $${d.amount} ${d.description || ''}${d.contact ? ` | ${d.contact}` : ''}${d.date ? ` | ${d.date}` : ''}\n`;
    });
  }

  if (projects.length) {
    ctx += `\n${label.projects}:\n`;
    projects.forEach(p => {
      const d = p.data;
      ctx += `- ${d.name}${d.status ? ` [${d.status}]` : ''}${d.client ? ` | cliente: ${d.client}` : ''}${d.value ? ` | $${d.value}` : ''} [id:${p.id.slice(0,8)}]\n`;
    });
  }

  return ctx;
}

// ── Memory log ────────────────────────────────────────────
export function logMemory(convId, userMsg, extracted) {
  db.prepare(`INSERT INTO memory_log (id, conversation_id, user_message, extracted) VALUES (?, ?, ?, ?)`)
    .run(uuidv4(), convId, userMsg, JSON.stringify(extracted));
}

// ── Conversations ─────────────────────────────────────────
export function saveConversation(id, title, messages) {
  db.prepare(`INSERT OR REPLACE INTO conversations (id, title, messages, updated_at) VALUES (?, ?, ?, datetime('now'))`)
    .run(id, title, JSON.stringify(messages));
}

export function getConversation(id) {
  const row = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(id);
  if (!row) return null;
  return { ...row, messages: JSON.parse(row.messages) };
}

export function getConversations() {
  return db.prepare(`SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50`).all();
}

export function deleteConversation(id) {
  db.prepare(`DELETE FROM conversations WHERE id=?`).run(id);
}

// ── Nextcloud Files ───────────────────────────────────────────────────────────

/**
 * Insert or update a Nextcloud file record.
 * Uses path as the unique key (UPSERT pattern).
 * @param {{ path, name, mime_type, status, size?, document_type?, summary?,
 *           entity_count?, document_id?, analysis_json?, error_msg?,
 *           elapsed_ms?, reason? }} fields
 * @returns {{ id, path, name, ... }}
 */
export function saveNextcloudFile(fields) {
  const existing = db.prepare(`SELECT id FROM nextcloud_files WHERE path = ?`).get(fields.path);

  if (existing) {
    // Update all provided fields
    const sets = Object.keys(fields)
      .filter(k => k !== 'path')
      .map(k => `${k} = ?`)
      .join(', ');
    const values = Object.keys(fields)
      .filter(k => k !== 'path')
      .map(k => fields[k]);

    db.prepare(
      `UPDATE nextcloud_files SET ${sets}, updated_at = datetime('now') WHERE id = ?`
    ).run(...values, existing.id);

    return getNextcloudFile(existing.id);
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO nextcloud_files (id, path, name, mime_type, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, fields.path, fields.name, fields.mime_type || '', fields.status || 'pending');

  return getNextcloudFile(id);
}

/**
 * Update specific fields on a nextcloud_files record by id.
 */
export function updateNextcloudFile(id, fields) {
  if (!fields || Object.keys(fields).length === 0) return;

  const sets   = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);

  db.prepare(
    `UPDATE nextcloud_files SET ${sets}, updated_at = datetime('now') WHERE id = ?`
  ).run(...values, id);

  return getNextcloudFile(id);
}

/**
 * Fetch a single nextcloud_files record by id.
 */
export function getNextcloudFile(id) {
  return db.prepare(`SELECT * FROM nextcloud_files WHERE id = ?`).get(id) || null;
}

/**
 * Fetch a nextcloud_files record by Nextcloud path.
 */
export function getNextcloudFileByPath(path) {
  return db.prepare(`SELECT * FROM nextcloud_files WHERE path = ?`).get(path) || null;
}

/**
 * List all Nextcloud file records, optionally filtered by status.
 * @param {string|null} status - 'done' | 'error' | 'processing' | null (all)
 * @param {number} limit
 */
export function listNextcloudFiles(status = null, limit = 100) {
  if (status) {
    return db.prepare(
      `SELECT * FROM nextcloud_files WHERE status = ? ORDER BY updated_at DESC LIMIT ?`
    ).all(status, limit);
  }
  return db.prepare(
    `SELECT * FROM nextcloud_files ORDER BY updated_at DESC LIMIT ?`
  ).all(limit);
}

/**
 * Summary statistics for the Nextcloud files dashboard.
 */
export function nextcloudFileStats() {
  const rows = db.prepare(
    `SELECT status, COUNT(*) as count FROM nextcloud_files GROUP BY status`
  ).all();

  const stats = { total: 0, done: 0, error: 0, processing: 0, skipped: 0, pending: 0 };
  for (const r of rows) {
    stats[r.status] = r.count;
    stats.total += r.count;
  }
  return stats;
}
