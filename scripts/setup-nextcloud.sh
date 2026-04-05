#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-nextcloud.sh — Configure Nextcloud webhook → NexMind integration
#
# Run this ONCE after "docker compose up -d" and Nextcloud is fully initialized
# (usually ~60 seconds after first start).
#
# Usage:
#   bash scripts/setup-nextcloud.sh
#
# What this does:
#   1. Sets background job mode to cron (required for Nextcloud stability)
#   2. Enables the workflow_webhook app for webhook delivery
#   3. Creates a Flow automation: file created/updated → POST to NexMind
#   4. Verifies the NexMind webhook endpoint is reachable from Nextcloud
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Load environment variables
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
else
  echo "ERROR: .env file not found. Copy .env.example to .env first."
  exit 1
fi

NEXTCLOUD_CONTAINER="${NEXTCLOUD_CONTAINER:-nexmind_nextcloud}"
NEXMIND_WEBHOOK_URL="http://nexmind:3000/api/webhook/nextcloud"
SECRET="${WEBHOOK_SECRET:-}"

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  NexMind + Nextcloud Webhook Setup"
echo "══════════════════════════════════════════════════════════"
echo ""

# ── Wait for Nextcloud to be ready ─────────────────────────────────────────────
echo "→ Waiting for Nextcloud to finish initialization..."
MAX_WAIT=120
ELAPSED=0
until docker exec "$NEXTCLOUD_CONTAINER" php occ status --output=json 2>/dev/null | grep -q '"installed":true'; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "ERROR: Nextcloud did not start within ${MAX_WAIT}s. Try again later."
    exit 1
  fi
  echo "  Still waiting... (${ELAPSED}s)"
done
echo "  ✓ Nextcloud is ready"
echo ""

# ── Step 1: Set background job to cron ─────────────────────────────────────────
echo "→ Setting background job mode to cron..."
docker exec -u www-data "$NEXTCLOUD_CONTAINER" php occ background:cron
echo "  ✓ Background job mode: cron"
echo ""

# ── Step 2: Enable required apps ───────────────────────────────────────────────
echo "→ Enabling required Nextcloud apps..."

# workflow_webhook — delivers webhook calls from Flow automation
docker exec -u www-data "$NEXTCLOUD_CONTAINER" php occ app:enable workflow_webhook 2>/dev/null && \
  echo "  ✓ workflow_webhook enabled" || \
  echo "  ℹ workflow_webhook already enabled or not available (using built-in Flow)"

# files — ensure files app is enabled
docker exec -u www-data "$NEXTCLOUD_CONTAINER" php occ app:enable files 2>/dev/null || true
echo ""

# ── Step 3: Create Flow automation ─────────────────────────────────────────────
echo "→ Creating Flow automation (file events → NexMind webhook)..."

# Build the webhook URL with secret as a query param (fallback if header not supported)
WEBHOOK_URL_WITH_SECRET="${NEXMIND_WEBHOOK_URL}"
if [ -n "$SECRET" ]; then
  WEBHOOK_URL_WITH_SECRET="${NEXMIND_WEBHOOK_URL}?secret=${SECRET}"
fi

# Check if Flow already exists (avoid duplicates)
EXISTING=$(docker exec -u www-data "$NEXTCLOUD_CONTAINER" php occ workflows:list 2>/dev/null | grep -c "nexmind" || true)
if [ "$EXISTING" -gt "0" ]; then
  echo "  ℹ Flow automation already exists — skipping creation"
else
  # Create the webhook automation via OCC
  # Triggers: NodeCreatedEvent, NodeWrittenEvent (file created or updated)
  docker exec -u www-data "$NEXTCLOUD_CONTAINER" php occ workflows:create \
    'OCA\WorkflowEngine\Check\FileMimeType' \
    '{"mimetype":{"operator":"!is","value":"httpd/unix-directory"}}' \
    'OCA\WorkflowWebhook\Operation' \
    "{\"url\":\"${WEBHOOK_URL_WITH_SECRET}\",\"method\":\"POST\",\"headers\":{\"X-Webhook-Secret\":\"${SECRET}\",\"Content-Type\":\"application/json\"}}" \
    2>/dev/null && echo "  ✓ Flow automation created via OCC" || \
    echo "  ℹ Could not create via OCC — see manual setup instructions below"
fi
echo ""

# ── Step 4: Verify NexMind webhook endpoint ─────────────────────────────────────
echo "→ Testing NexMind webhook endpoint from within Nextcloud container..."
WEBHOOK_STATUS=$(docker exec "$NEXTCLOUD_CONTAINER" \
  curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://nexmind:3000/api/webhook/nextcloud" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: ${SECRET}" \
  -d '{"event":"ping","file_name":"test.txt","file_path":"/test.txt"}' \
  2>/dev/null || echo "000")

if [ "$WEBHOOK_STATUS" = "200" ]; then
  echo "  ✓ NexMind webhook is reachable (HTTP 200)"
else
  echo "  ⚠ Webhook test returned HTTP ${WEBHOOK_STATUS} — check that NexMind is running"
fi
echo ""

# ── Done ─────────────────────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo "══════════════════════════════════════════════════════════"
echo ""
echo "  NexMind   → http://localhost"
echo "  Nextcloud → http://localhost:8080"
echo ""
echo "  Webhook URL (configure in Nextcloud Flow if not auto-created):"
echo "  ${NEXMIND_WEBHOOK_URL}"
echo ""
echo "  Manual Nextcloud Flow setup (if OCC method above failed):"
echo "  1. Open http://localhost:8080 → Settings → Flow"
echo "  2. Click 'Add new flow' → choose 'Webhook'"
echo "  3. Trigger: 'File created' and 'File updated'"
echo "  4. Action URL: ${NEXMIND_WEBHOOK_URL}"
echo "  5. Method: POST"
echo "  6. Header: X-Webhook-Secret: ${SECRET}"
echo ""
echo "  Supported file types: PDF, JPG, PNG, WEBP, TXT, CSV, DOCX"
echo ""
