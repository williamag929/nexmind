# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (auto-restart on file changes)
node --watch server.js

# Production
node server.js

# Docker (full stack: NexMind + Nextcloud + MariaDB + Nginx)
docker compose up -d
docker compose logs -f nexmind

# Run Nextcloud integration setup after first boot
bash scripts/setup-nextcloud.sh
```

No test suite or linter is configured.

## Environment Setup

Copy `.env.example` to `.env` and populate:
- `ANTHROPIC_API_KEY` — required for all AI features
- `JWT_SECRET` — REQUIRED for production; signs user session tokens (generate with `openssl rand -hex 64`)
- `API_TOKEN` — optional legacy admin/service bypass token
- `CLAUDE_MODEL` — Claude model ID used everywhere (default `claude-sonnet-4-20250514`)
- `NEXTCLOUD_*` / `MYSQL_*` — required only if using Nextcloud integration
- `WEBHOOK_SECRET` — REQUIRED for Nextcloud webhooks; requests are rejected if unset (fail closed)

## Architecture

**NexMind** is a self-hosted multi-user AI memory system. A single Express app (`server.js`) serves both the API and static frontend (`public/index.html`).

### Authentication — `src/auth.js`
- Users register/login with email + password (bcrypt hashed, 12 rounds)
- JWT session tokens (httpOnly cookies + optional Authorization header)
- All data is isolated per user via `user_id` foreign keys on every table
- Rate limiting on auth routes (10 attempts/15min) and API routes (100 req/min)
- Legacy `API_TOKEN` bearer still supported for admin/service access

### Data Layer — `db.js`
SQLite via `better-sqlite3` (synchronous, WAL mode). The schema uses:
- **`users`** — user accounts with email, password_hash, settings
- **`entities`** — polymorphic store for 7 types: `contact`, `company`, `event`, `task`, `transaction`, `project`, `document` (scoped by `user_id`)
- **`relations`** — knowledge-graph edges between entities (scoped by `user_id`)

Supporting tables: `memory_log`, `conversations`, `nextcloud_files` — all scoped by `user_id`.

`buildMemoryContext(lang, userId)` formats the top N entities of each type into a text block injected as Claude's system prompt on every chat request.

### Chat Flow — `POST /api/chat`
1. User message arrives → entity extraction runs in parallel via a separate Claude call (JSON mode)
2. `buildMemoryContext()` assembles the current knowledge state into the system prompt
3. Claude streams the response back via SSE (`text/event-stream`)
4. After the stream completes, extracted entities/relations are persisted and `memory_log` is updated

### Document Processing Pipeline — `src/`
- **`src/analyzer.js`** — Sends files to Claude using the appropriate API mode: Document API for PDFs, Vision for images, plain text for TXT/CSV/MD. Returns structured JSON with `entities`, `relations`, and `metadata`.
- **`src/nextcloud.js`** — WebDAV client (Basic Auth) for downloading files and listing directories from Nextcloud.
- **`src/webhook.js`** — Receives Nextcloud Flow webhook on `POST /api/webhook/nextcloud/:userId`, downloads the file, runs `analyzer.js`, and persists results scoped to the target user. Responds immediately; analysis is fire-and-forget.

### Infrastructure
- **Nginx** routes port 80 → NexMind (port 3000) and port 8080 → Nextcloud. SSE for `/api/chat` requires `proxy_buffering off` and a 300 s timeout — already configured.
- The frontend is a single-file SPA (`public/index.html`) with vanilla JS, dark theme, and bilingual (ES/EN) support controlled by a runtime toggle that switches the Claude system prompt language.
- Login/register page at `public/login.html` — unauthenticated visitors are redirected there automatically.

### Claude API Usage
- Model: `CLAUDE_MODEL` env var (default `claude-sonnet-4-20250514`) — used for chat, extraction, and document analysis
- Chat streaming: SSE via `stream: true`, buffered line parsing (events can span chunks)
- Entity extraction: separate non-streaming call with JSON response; only `create`/`update` actions are honored (no LLM-driven deletes — prompt-injection safety)
- Document analysis: `max_tokens: 4096`, 20MB file size limit
- Prompt caching: all system prompts sent with `cache_control: ephemeral`
- Chat history sent to Claude is truncated to `MAX_HISTORY` (default 30) messages; full history is stored in SQLite
