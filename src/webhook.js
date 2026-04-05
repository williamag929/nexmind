/**
 * webhook.js — Nextcloud → NexMind file processing pipeline
 *
 * Flow:
 *   1. Nextcloud Flow triggers POST /api/webhook/nextcloud on file upload
 *   2. Verify webhook secret
 *   3. Download file from Nextcloud via WebDAV
 *   4. Analyze file with Claude (analyzer.js)
 *   5. Persist entities + relations into NexMind memory (db.js)
 *   6. Mark file as processed in nextcloud_files table
 *
 * Nextcloud payload (from Flow → Webhook action):
 *   {
 *     "event":     "file_created" | "file_updated",
 *     "file_path": "/Documents/invoice.pdf",
 *     "file_name": "invoice.pdf",
 *     "mime_type": "application/pdf",
 *     "user":      "admin",
 *     "timestamp": "2026-04-05T10:00:00Z"
 *   }
 *
 * Alternative payload (older Nextcloud / workflow_webhook app):
 *   { "path": "/Documents/invoice.pdf", "event": "create" }
 */

import { downloadFile }   from './nextcloud.js';
import { analyzeDocument, isAnalyzable } from './analyzer.js';
import {
  createEntity, createRelation,
  saveNextcloudFile, updateNextcloudFile,
  getNextcloudFileByPath,
} from '../db.js';

// ── Secret verification ───────────────────────────────────────────────────────

/**
 * Verify the webhook request is coming from our Nextcloud instance.
 * Returns true if no secret is configured (open mode) or if secret matches.
 */
export function verifyWebhookSecret(req) {
  const configuredSecret = process.env.WEBHOOK_SECRET;
  if (!configuredSecret) return true; // No secret configured — allow all

  const incoming =
    req.headers['x-webhook-secret'] ||
    req.headers['x-nexmind-secret'] ||
    req.query?.secret;

  return incoming === configuredSecret;
}

// ── Payload normalization ─────────────────────────────────────────────────────

/**
 * Normalize different Nextcloud webhook payload formats into a canonical shape.
 * Handles both newer Flow format and older workflow_webhook format.
 */
export function normalizePayload(raw) {
  // Newer Nextcloud Flow format
  if (raw.file_path || raw.file_name) {
    return {
      event:    raw.event || 'file_created',
      filePath: raw.file_path || raw.path || '',
      fileName: raw.file_name || raw.file || (raw.file_path || '').split('/').pop(),
      mimeType: raw.mime_type || raw.mimetype || '',
      user:     raw.user || 'admin',
      timestamp: raw.timestamp || new Date().toISOString(),
    };
  }

  // Older workflow_webhook format
  if (raw.path) {
    return {
      event:    raw.event === 'create' ? 'file_created' : raw.event || 'file_created',
      filePath: raw.path,
      fileName: raw.file || raw.path.split('/').pop(),
      mimeType: raw.mimetype || '',
      user:     raw.user || 'admin',
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error('Unrecognized webhook payload format');
}

// ── Main processing pipeline ──────────────────────────────────────────────────

/**
 * Process a file from Nextcloud: download → analyze → store in memory.
 * This is called asynchronously AFTER the webhook 200 response is sent.
 *
 * @param {string} filePath  - Nextcloud path, e.g. "/Documents/invoice.pdf"
 * @param {string} fileName  - Original filename
 * @param {string} mimeType  - MIME type from Nextcloud
 * @returns {Promise<{ok: boolean, entityCount: number, fileId: string}>}
 */
export async function processNextcloudFile(filePath, fileName, mimeType) {
  const startAt = Date.now();
  console.log(`[webhook] Processing: ${filePath}`);

  // Check if this file was already processed (avoid duplicates)
  const existing = getNextcloudFileByPath(filePath);
  if (existing?.status === 'done') {
    console.log(`[webhook] Already processed, skipping: ${filePath}`);
    return { ok: true, skipped: true, fileId: existing.id };
  }

  // Save/update file record with "processing" status
  const fileRecord = saveNextcloudFile({
    path:      filePath,
    name:      fileName,
    mime_type: mimeType,
    status:    'processing',
  });

  try {
    // ── Step 1: Download from Nextcloud ──────────────────────────────────────
    console.log(`[webhook] Downloading: ${filePath}`);
    const { buffer, mimeType: detectedMime, size } = await downloadFile(filePath);

    const effectiveMime = mimeType || detectedMime;

    // ── Step 2: Check if analyzable ──────────────────────────────────────────
    if (!isAnalyzable(fileName, effectiveMime)) {
      console.log(`[webhook] Not analyzable (${effectiveMime}): ${fileName}`);
      updateNextcloudFile(fileRecord.id, { status: 'skipped', reason: 'unsupported_type', size });
      return { ok: true, skipped: true, fileId: fileRecord.id };
    }

    // ── Step 3: Analyze with Claude ──────────────────────────────────────────
    console.log(`[webhook] Analyzing with Claude: ${fileName} (${size} bytes)`);
    const analysis = await analyzeDocument(buffer, fileName, effectiveMime, filePath);

    // ── Step 4: Persist extracted entities ───────────────────────────────────
    const createdIds = {}; // tempId → real DB id mapping

    // Always create a document entity linking to this file
    const docEntity = createEntity('document', {
      title:         fileName,
      type:          analysis.document_type,
      date:          analysis.metadata?.date,
      notes:         analysis.summary,
      nextcloud_path: filePath,
      analyzed_at:   analysis.analyzed_at,
      reference:     analysis.metadata?.reference_number,
    });
    createdIds['__document__'] = docEntity.id;

    // Create all extracted entities
    for (const entity of analysis.entities) {
      if (!entity.type || !entity.data) continue;
      try {
        const created = createEntity(entity.type, entity.data);
        if (entity.tempId) createdIds[entity.tempId] = created.id;
      } catch (err) {
        console.error(`[webhook] Failed to create ${entity.type}:`, err.message);
      }
    }

    // ── Step 5: Create relations ──────────────────────────────────────────────
    for (const rel of analysis.relations) {
      const fromId = createdIds[rel.from_temp_id];
      const toId   = createdIds[rel.to_temp_id];
      if (fromId && toId) {
        try {
          createRelation(fromId, toId, rel.type || 'related_to');
        } catch (err) {
          console.error(`[webhook] Failed to create relation:`, err.message);
        }
      }
    }

    // Link the document entity to extracted entities (first contact, first company, first project)
    const firstContact = analysis.entities.find(e => e.type === 'contact' && e.tempId);
    const firstCompany = analysis.entities.find(e => e.type === 'company' && e.tempId);
    const firstProject = analysis.entities.find(e => e.type === 'project' && e.tempId);
    const firstTxn     = analysis.entities.find(e => e.type === 'transaction' && e.tempId);

    if (firstContact && createdIds[firstContact.tempId]) {
      createRelation(docEntity.id, createdIds[firstContact.tempId], 'related_to');
    }
    if (firstCompany && createdIds[firstCompany.tempId]) {
      createRelation(docEntity.id, createdIds[firstCompany.tempId], 'related_to');
    }
    if (firstProject && createdIds[firstProject.tempId]) {
      createRelation(docEntity.id, createdIds[firstProject.tempId], 'part_of');
    }
    if (firstTxn && createdIds[firstTxn.tempId]) {
      createRelation(docEntity.id, createdIds[firstTxn.tempId], 'related_to');
    }

    const elapsedMs = Date.now() - startAt;
    const entityCount = analysis.entities.length + 1; // +1 for document entity itself

    // ── Step 6: Update file record with results ───────────────────────────────
    updateNextcloudFile(fileRecord.id, {
      status:        'done',
      size,
      document_type: analysis.document_type,
      summary:       analysis.summary,
      entity_count:  entityCount,
      document_id:   docEntity.id,
      analysis_json: JSON.stringify(analysis),
      elapsed_ms:    elapsedMs,
    });

    console.log(
      `[webhook] Done: ${fileName} → ${entityCount} entities in ${elapsedMs}ms`
    );

    return { ok: true, fileId: fileRecord.id, documentId: docEntity.id, entityCount };

  } catch (err) {
    console.error(`[webhook] Error processing ${filePath}:`, err);
    updateNextcloudFile(fileRecord.id, {
      status:    'error',
      error_msg: err.message,
    });
    return { ok: false, fileId: fileRecord.id, error: err.message };
  }
}

// ── Event filter ──────────────────────────────────────────────────────────────

/**
 * Determine if a webhook event should trigger file analysis.
 */
export function shouldProcess(event) {
  return ['file_created', 'file_updated', 'create', 'update'].includes(event);
}
