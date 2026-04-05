/**
 * nextcloud.js — Nextcloud WebDAV client
 *
 * Handles all communication with the Nextcloud instance:
 *   - File downloads via WebDAV
 *   - Directory listings via PROPFIND
 *   - Webhook token generation for Nextcloud Flow
 */

import fetch from 'node-fetch';

const NEXTCLOUD_URL  = process.env.NEXTCLOUD_URL  || 'http://nextcloud';
const NEXTCLOUD_USER = process.env.NEXTCLOUD_USER || 'admin';
const NEXTCLOUD_PASS = process.env.NEXTCLOUD_PASS || '';

// Build Basic Auth header
function authHeader() {
  return 'Basic ' + Buffer.from(`${NEXTCLOUD_USER}:${NEXTCLOUD_PASS}`).toString('base64');
}

// Build WebDAV base URL for the admin user
function davBase() {
  return `${NEXTCLOUD_URL}/remote.php/dav/files/${encodeURIComponent(NEXTCLOUD_USER)}`;
}

// ── File download ────────────────────────────────────────────────────────────

/**
 * Download a file from Nextcloud and return a Buffer.
 * @param {string} filePath - e.g. "/Documents/invoice.pdf"
 * @returns {Promise<{buffer: Buffer, mimeType: string, size: number}>}
 */
export async function downloadFile(filePath) {
  const url = `${davBase()}${encodeURIPath(filePath)}`;

  const response = await fetch(url, {
    headers: { Authorization: authHeader() },
  });

  if (!response.ok) {
    throw new Error(
      `Nextcloud WebDAV download failed [${response.status}]: ${filePath}`
    );
  }

  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer   = Buffer.from(await response.arrayBuffer());
  const size     = buffer.length;

  return { buffer, mimeType, size };
}

// ── Directory listing ────────────────────────────────────────────────────────

/**
 * List files in a Nextcloud directory using WebDAV PROPFIND.
 * @param {string} dirPath - e.g. "/" or "/Documents"
 * @returns {Promise<Array<{name, path, mimeType, size, lastModified}>>}
 */
export async function listFiles(dirPath = '/') {
  const url = `${davBase()}${encodeURIPath(dirPath)}`;

  const propfindBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontenttype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization:   authHeader(),
      Depth:           '1',
      'Content-Type':  'application/xml; charset=utf-8',
    },
    body: propfindBody,
  });

  if (!response.ok) {
    throw new Error(`Nextcloud PROPFIND failed [${response.status}]: ${dirPath}`);
  }

  const xml   = await response.text();
  return parseWebDAVResponse(xml, dirPath);
}

// ── File metadata ────────────────────────────────────────────────────────────

/**
 * Get metadata for a single file (size, mime, last modified).
 * @param {string} filePath
 * @returns {Promise<{name, path, mimeType, size, lastModified}>}
 */
export async function getFileMeta(filePath) {
  const url = `${davBase()}${encodeURIPath(filePath)}`;

  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization:  authHeader(),
      Depth:          '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontenttype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`,
  });

  if (!response.ok) {
    throw new Error(`Nextcloud PROPFIND failed [${response.status}]: ${filePath}`);
  }

  const xml    = await response.text();
  const items  = parseWebDAVResponse(xml, filePath);
  return items[0] || null;
}

// ── OCS API — ping ────────────────────────────────────────────────────────────

/**
 * Verify that Nextcloud is reachable and credentials are valid.
 * @returns {Promise<boolean>}
 */
export async function pingNextcloud() {
  try {
    const url = `${NEXTCLOUD_URL}/ocs/v2.php/apps/admin_audit/whoami`;
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(),
        'OCS-APIRequest': 'true',
      },
    });
    return res.status === 200 || res.status === 997; // 997 = auth required but alive
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Encode file path segments but preserve slashes.
 */
function encodeURIPath(p) {
  return p.split('/').map(s => encodeURIComponent(s)).join('/');
}

/**
 * Minimal WebDAV XML parser — extracts file entries from a PROPFIND response.
 * Avoids adding an xml2js dependency by using simple regex extraction.
 */
function parseWebDAVResponse(xml, basePath) {
  const items = [];

  // Match each <d:response> block
  const responseBlocks = xml.match(/<(?:d:)?response>([\s\S]*?)<\/(?:d:)?response>/gi) || [];

  for (const block of responseBlocks) {
    const href         = extractTag(block, 'href');
    const displayname  = extractTag(block, 'displayname') || '';
    const contenttype  = extractTag(block, 'getcontenttype') || '';
    const contentlength = extractTag(block, 'getcontentlength') || '0';
    const lastmodified = extractTag(block, 'getlastmodified') || '';
    const isCollection = block.includes('<d:collection') || block.includes('<collection');

    if (!href || isCollection) continue; // Skip directories

    // Decode the path from the href
    let filePath = decodeURIComponent(href);
    // Strip the WebDAV prefix to get just the file path
    const davPrefix = `/remote.php/dav/files/${NEXTCLOUD_USER}`;
    if (filePath.includes(davPrefix)) {
      filePath = filePath.slice(filePath.indexOf(davPrefix) + davPrefix.length);
    }

    // Skip the base directory itself
    if (filePath === basePath || filePath === basePath + '/') continue;

    items.push({
      name:         displayname || filePath.split('/').pop(),
      path:         filePath,
      mimeType:     contenttype,
      size:         parseInt(contentlength, 10) || 0,
      lastModified: lastmodified,
    });
  }

  return items;
}

function extractTag(xml, tag) {
  // Match both namespaced (d:tag) and plain (tag)
  const patterns = [
    new RegExp(`<(?:d:)?${tag}[^>]*>(.*?)<\/(?:d:)?${tag}>`, 'is'),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return m[1].trim();
  }
  return null;
}
