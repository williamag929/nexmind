# NexMind — Product Roadmap

A phased plan to evolve NexMind from a personal prototype into a reliable, daily-use professional tool.

---

## Phase 1 — Foundation for Real Use
**Goal:** Make the system trustworthy enough to depend on every day.
**Timeline:** Weeks 1–3

### Tasks
- [ ] **Auth** — Add user login with session management (Lucia Auth or Clerk). Currently the app is fully open with no access control.
- [ ] **Input validation** — Validate all API request bodies (type, shape, required fields). Malformed payloads can crash routes.
- [ ] **UI error boundaries** — Add loading states and error feedback to the frontend for failed API calls.
- [ ] **Backup strategy** — Automate SQLite backup so `db/` is not lost on `docker compose down -v`. Options: scheduled dump to Nextcloud, or volume-level backup script.
- [ ] **Environment validation on startup** — Fail fast with a clear message if `ANTHROPIC_API_KEY` or other required vars are missing.

---

## Phase 2 — Memory Quality
**Goal:** Make the AI brain accurate and scalable.
**Timeline:** Weeks 3–6

### Tasks
- [ ] **Entity deduplication** — Before inserting a contact or company, fuzzy-match against existing records to prevent duplicates (e.g., "María" vs "Maria López").
- [ ] **Entity editing UI** — Add inline edit/delete for any entity card in the frontend. Currently corrections require direct API calls.
- [ ] **Prompt caching** — Cache the memory context system prompt using Anthropic's cache-control headers. The context is injected on every request and is a perfect cache candidate (~80% cost reduction).
- [ ] **Semantic retrieval** — Replace full-context injection with `sqlite-vec` or a simple embedding index. Query only the top-K relevant records per message instead of injecting everything.
- [ ] **Claude tool use for queries** — Give Claude tools (`search_contacts`, `get_transactions`, `list_tasks`) so it can query specific data rather than relying on what was injected. Dramatically improves answer accuracy for specific questions.
- [ ] **Memory audit log UI** — Show users what was extracted from each conversation so they can review and correct extractions.

---

## Phase 3 — Agent Access Channels
**Goal:** Talk to the agent from anywhere, not just the web UI.
**Timeline:** Weeks 6–10

### Tasks
- [ ] **Telegram bot** — Connect `node-telegram-bot-api` to the existing `/api/chat` endpoint. Enables mobile access with no new infrastructure. (~50 lines of code)
- [ ] **CLI script (`ask.js`)** — Simple Node script: `node ask.js "who owes me money?"` streams a response from the local server.
- [ ] **REST-friendly SSE client docs** — Document how to call `/api/chat` via curl / Insomnia / Raycast so power users can integrate without code.
- [ ] **WhatsApp / Telegram voice note ingestion** — Accept voice messages, transcribe via Whisper API, feed transcript into the memory pipeline.
- [ ] **Browser extension (clip to memory)** — Save web pages, contacts, and receipts directly from the browser into NexMind.

---

## Phase 4 — Daily Driver UX
**Goal:** Remove friction so the tool becomes a daily habit.
**Timeline:** Weeks 10–14

### Tasks
- [ ] **Mobile-responsive layout** — Refactor `public/index.html` for phone screens. Current layout is desktop-only.
- [ ] **Quick capture mode** — A minimal "just type a thought" entry point that bypasses section navigation.
- [ ] **Reminders and notifications** — Surface tasks and events that are due. Tasks and events exist in SQLite but nothing triggers alerts.
- [ ] **Keyboard shortcuts** — Add hotkeys for common actions (new conversation, search, navigate sections).
- [ ] **Global search** — Single search bar across all entity types (contacts, tasks, transactions, projects).

---

## Phase 5 — Integrations
**Goal:** Memory fills itself automatically from existing workflows.
**Timeline:** Weeks 14–20

### Tasks
- [ ] **Email ingestion** — Parse incoming emails (IMAP or Gmail API) into contacts, events, and transactions automatically.
- [ ] **Google Calendar / CalDAV sync** — Bidirectional sync so events created in NexMind appear in the calendar and vice versa.
- [ ] **Nextcloud Files auto-watch** — Poll or webhook-trigger on any new file in designated Nextcloud folders (already partially built via webhook pipeline).
- [ ] **CSV / bank statement import** — Upload a bank export CSV → transactions auto-extracted and categorized.

---

## Phase 6 — Product Polish
**Goal:** Make it shippable and trustworthy for others.
**Timeline:** Weeks 20+

### Tasks
- [ ] **Data export** — Export full knowledge base as Obsidian-compatible markdown, CSV, or JSON. Users need data portability to trust the tool long-term.
- [ ] **One-click setup wizard** — Replace the manual `setup-nextcloud.sh` flow with a guided web UI that configures everything on first boot.
- [ ] **Multi-user / team mode** — Shared knowledge graphs with per-user access control (e.g., for a small firm or family).
- [ ] **Usage dashboard** — Show token usage, memory size, extraction counts, and API cost over time.
- [ ] **Security review** — Audit webhook validation, file upload handling, and API exposure before any public deployment.

---

## Priority Order (What to Build First)

| Priority | Task | Impact | Effort |
|----------|------|--------|--------|
| 🔴 1 | Auth (Phase 1) | Unblocks sharing / team use | Medium |
| 🔴 2 | Prompt caching (Phase 2) | ~80% API cost reduction | Low |
| 🔴 3 | Claude tool use (Phase 2) | Major answer quality jump | Medium |
| 🟡 4 | Entity deduplication (Phase 2) | Memory reliability | Medium |
| 🟡 5 | Telegram bot (Phase 3) | Daily mobile use | Low |
| 🟡 6 | Entity editing UI (Phase 2) | User trust in memory | Low |
| 🟢 7 | Mobile layout (Phase 4) | Broader usability | High |
| 🟢 8 | Email ingestion (Phase 5) | Automatic memory | High |
