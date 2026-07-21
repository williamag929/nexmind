import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'db', 'nexmind.db');

let db;

export function initDB() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER DEFAULT 0,
      verification_token TEXT,
      reset_token TEXT,
      reset_token_expires TEXT,
      webhook_secret TEXT,
      settings TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    );

    -- Core entities table (polymorphic)
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL, -- contact, company, event, task, transaction, project, document
      data TEXT NOT NULL, -- JSON blob
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Relations graph
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation_type TEXT NOT NULL, -- works_at, owns, attended, paid, assigned_to, etc
      meta TEXT, -- JSON extra data
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(from_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY(to_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    -- Memory log (what Claude extracted from conversations)
    CREATE TABLE IF NOT EXISTS memory_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      user_message TEXT,
      extracted TEXT, -- JSON: what was extracted
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Conversations
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT,
      messages TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Nextcloud file tracking table
    CREATE TABLE IF NOT EXISTS nextcloud_files (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      path          TEXT NOT NULL,
      name          TEXT NOT NULL,
      mime_type     TEXT,
      size          INTEGER,
      status        TEXT DEFAULT 'pending', -- pending | processing | done | skipped | error
      document_type TEXT,
      summary       TEXT,
      entity_count  INTEGER DEFAULT 0,
      document_id   TEXT,
      analysis_json TEXT,
      error_msg     TEXT,
      elapsed_ms    INTEGER,
      reason        TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(document_id) REFERENCES entities(id) ON DELETE SET NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
    CREATE INDEX IF NOT EXISTS idx_entities_user_type ON entities(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_entities_type      ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_relations_user     ON relations(user_id);
    CREATE INDEX IF NOT EXISTS idx_relations_from     ON relations(from_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to       ON relations(to_id);
    CREATE INDEX IF NOT EXISTS idx_memory_user        ON memory_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_conv_user          ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_nc_files_user      ON nextcloud_files(user_id);
    CREATE INDEX IF NOT EXISTS idx_nc_files_status    ON nextcloud_files(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nc_files_path ON nextcloud_files(user_id, path);
  `);

  return db;
}

export function getDB() { return db; }

// ── Users ─────────────────────────────────────────────────
export function createUser(id, email, passwordHash) {
  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`).run(id, email, passwordHash);
  return getUserById(id);
}

export function getUserByEmail(email) {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) || null;
}

export function getUserById(id) {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, settings: JSON.parse(row.settings || '{}') };
}

export function updateUser(id, fields) {
  const allowed = ['email_verified', 'verification_token', 'reset_token', 'reset_token_expires', 'webhook_secret', 'settings', 'last_login', 'password_hash'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => k === 'settings' ? JSON.stringify(fields[k]) : fields[k]);
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, id);
  return getUserById(id);
}

export function deleteUser(id) {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

// ── Entities ──────────────────────────────────────────────
export function createEntity(type, data, userId) {
  const id = uuidv4();
  db.prepare(`INSERT INTO entities (id, user_id, type, data) VALUES (?, ?, ?, ?)`).run(id, userId, type, JSON.stringify(data));
  return { id, type, data, user_id: userId };
}

export function updateEntity(id, data, userId) {
  const existing = getEntity(id, userId);
  if (!existing) return null;
  const merged = { ...existing.data, ...data };
  db.prepare(`UPDATE entities SET data=?, updated_at=datetime('now') WHERE id=? AND user_id=?`).run(JSON.stringify(merged), id, userId);
  return getEntity(id, userId);
}

export function deleteEntity(id, userId) {
  db.prepare(`DELETE FROM entities WHERE id=? AND user_id=?`).run(id, userId);
}

export function getEntity(id, userId) {
  const row = userId
    ? db.prepare(`SELECT * FROM entities WHERE id=? AND user_id=?`).get(id, userId)
    : db.prepare(`SELECT * FROM entities WHERE id=?`).get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

export function getEntitiesByType(type, userId) {
  return db.prepare(`SELECT * FROM entities WHERE type=? AND user_id=? ORDER BY updated_at DESC`).all(type, userId)
    .map(r => ({ ...r, data: JSON.parse(r.data) }));
}

export function searchEntities(query, userId) {
  const q = `%${query}%`;
  return db.prepare(`SELECT * FROM entities WHERE data LIKE ? AND user_id=? ORDER BY updated_at DESC LIMIT 20`).all(q, userId)
    .map(r => ({ ...r, data: JSON.parse(r.data) }));
}

export function getAllEntities(userId) {
  return db.prepare(`SELECT * FROM entities WHERE user_id=? ORDER BY updated_at DESC`).all(userId)
    .map(r => ({ ...r, data: JSON.parse(r.data) }));
}

// ── Relations ─────────────────────────────────────────────
export function createRelation(fromId, toId, relationType, meta = {}, userId) {
  const id = uuidv4();
  db.prepare(`INSERT OR IGNORE INTO relations (id, user_id, from_id, to_id, relation_type, meta) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, userId, fromId, toId, relationType, JSON.stringify(meta));
  return id;
}

export function getAllRelations(userId) {
  return db.prepare(`SELECT id, from_id, to_id, relation_type, meta, created_at FROM relations WHERE user_id=?`).all(userId);
}

export function getRelations(entityId, userId) {
  const outgoing = db.prepare(`
    SELECT r.*, e.type as to_type, e.data as to_data
    FROM relations r JOIN entities e ON r.to_id = e.id
    WHERE r.from_id = ? AND r.user_id = ?
  `).all(entityId, userId).map(r => ({ ...r, to_data: JSON.parse(r.to_data), meta: r.meta ? JSON.parse(r.meta) : {} }));

  const incoming = db.prepare(`
    SELECT r.*, e.type as from_type, e.data as from_data
    FROM relations r JOIN entities e ON r.from_id = e.id
    WHERE r.to_id = ? AND r.user_id = ?
  `).all(entityId, userId).map(r => ({ ...r, from_data: JSON.parse(r.from_data), meta: r.meta ? JSON.parse(r.meta) : {} }));

  return { outgoing, incoming };
}

// ── Memory context builder ─────────────────────────────────
export function buildMemoryContext(lang = 'es', userId) {
  const contacts = getEntitiesByType('contact', userId).slice(0, 20);
  const companies = getEntitiesByType('company', userId).slice(0, 10);
  const events = getEntitiesByType('event', userId).slice(0, 10);
  const tasks = getEntitiesByType('task', userId).filter(t => t.data.status !== 'done').slice(0, 10);
  const transactions = getEntitiesByType('transaction', userId).slice(0, 20);
  const projects = getEntitiesByType('project', userId).slice(0, 10);

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
export function logMemory(convId, userMsg, extracted, userId) {
  db.prepare(`INSERT INTO memory_log (id, user_id, conversation_id, user_message, extracted) VALUES (?, ?, ?, ?, ?)`)
    .run(uuidv4(), userId, convId, userMsg, JSON.stringify(extracted));
}

// ── Conversations ─────────────────────────────────────────
export function saveConversation(id, title, messages, userId) {
  db.prepare(`INSERT OR REPLACE INTO conversations (id, user_id, title, messages, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`)
    .run(id, userId, title, JSON.stringify(messages));
}

export function getConversation(id, userId) {
  const row = db.prepare(`SELECT * FROM conversations WHERE id=? AND user_id=?`).get(id, userId);
  if (!row) return null;
  return { ...row, messages: JSON.parse(row.messages) };
}

export function getConversations(userId) {
  return db.prepare(`SELECT id, title, created_at, updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 50`).all(userId);
}

export function deleteConversation(id, userId) {
  db.prepare(`DELETE FROM conversations WHERE id=? AND user_id=?`).run(id, userId);
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
// Whitelisted columns for dynamic UPDATE clauses — prevents SQL injection via field names
const NC_FILE_COLUMNS = new Set([
  'name', 'mime_type', 'size', 'status', 'document_type', 'summary',
  'entity_count', 'document_id', 'analysis_json', 'error_msg', 'elapsed_ms', 'reason',
]);

export function saveNextcloudFile(fields, userId) {
  const existing = db.prepare(`SELECT id FROM nextcloud_files WHERE path = ? AND user_id = ?`).get(fields.path, userId);

  if (existing) {
    // Update all provided (whitelisted) fields
    const keys = Object.keys(fields).filter(k => NC_FILE_COLUMNS.has(k));
    const sets = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => fields[k]);

    db.prepare(
      `UPDATE nextcloud_files SET ${sets}, updated_at = datetime('now') WHERE id = ?`
    ).run(...values, existing.id);

    return getNextcloudFile(existing.id, userId);
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO nextcloud_files (id, user_id, path, name, mime_type, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, fields.path, fields.name, fields.mime_type || '', fields.status || 'pending');

  return getNextcloudFile(id, userId);
}

/**
 * Update specific fields on a nextcloud_files record by id.
 */
export function updateNextcloudFile(id, fields) {
  const keys = Object.keys(fields || {}).filter(k => NC_FILE_COLUMNS.has(k));
  if (!keys.length) return;

  const sets   = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);

  db.prepare(
    `UPDATE nextcloud_files SET ${sets}, updated_at = datetime('now') WHERE id = ?`
  ).run(...values, id);

  return getNextcloudFile(id);
}

/**
 * Fetch a single nextcloud_files record by id.
 */
export function getNextcloudFile(id, userId) {
  if (userId) {
    return db.prepare(`SELECT * FROM nextcloud_files WHERE id = ? AND user_id = ?`).get(id, userId) || null;
  }
  return db.prepare(`SELECT * FROM nextcloud_files WHERE id = ?`).get(id) || null;
}

/**
 * Fetch a nextcloud_files record by Nextcloud path.
 */
export function getNextcloudFileByPath(filePath, userId) {
  return db.prepare(`SELECT * FROM nextcloud_files WHERE path = ? AND user_id = ?`).get(filePath, userId) || null;
}

/**
 * List all Nextcloud file records, optionally filtered by status.
 * @param {string|null} status - 'done' | 'error' | 'processing' | null (all)
 * @param {number} limit
 */
export function listNextcloudFiles(status = null, limit = 100, userId) {
  if (status) {
    return db.prepare(
      `SELECT * FROM nextcloud_files WHERE status = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?`
    ).all(status, userId, limit);
  }
  return db.prepare(
    `SELECT * FROM nextcloud_files WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`
  ).all(userId, limit);
}

/**
 * Summary statistics for the Nextcloud files dashboard.
 */
export function nextcloudFileStats(userId) {
  const rows = db.prepare(
    `SELECT status, COUNT(*) as count FROM nextcloud_files WHERE user_id = ? GROUP BY status`
  ).all(userId);

  const stats = { total: 0, done: 0, error: 0, processing: 0, skipped: 0, pending: 0 };
  for (const r of rows) {
    stats[r.status] = r.count;
    stats.total += r.count;
  }
  return stats;
}
