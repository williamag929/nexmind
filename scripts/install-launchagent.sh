#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Install NexMind as a macOS LaunchAgent
# Runs the server at login and keeps it alive (auto-restart on crash).
#
# Usage:    bash scripts/install-launchagent.sh
# Remove:   launchctl unload ~/Library/LaunchAgents/com.nexmind.server.plist \
#           && rm ~/Library/LaunchAgents/com.nexmind.server.plist
# Logs:     tail -f ~/Library/Logs/nexmind.log
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.nexmind.server.plist"
LOG="$HOME/Library/Logs/nexmind.log"

if [ -z "$NODE_BIN" ]; then
  echo "✗ node not found in PATH. Install Node.js first (brew install node)." >&2
  exit 1
fi

if [ ! -f "$APP_DIR/.env" ]; then
  echo "⚠ No .env found in $APP_DIR — copy .env.example to .env and set your keys first." >&2
fi

if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "→ Installing dependencies..."
  (cd "$APP_DIR" && npm install --no-audit --no-fund)
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.nexmind.server</string>
  <key>WorkingDirectory</key> <string>${APP_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>server.js</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key> <string>production</string>
    <key>PATH</key>     <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

# Reload if already installed
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

sleep 2
if curl -s -o /dev/null http://localhost:3000; then
  echo "✓ NexMind is running → http://localhost:3000"
  echo "  Starts automatically at login. Logs: $LOG"
else
  echo "⚠ Service loaded but not responding yet. Check: tail -f $LOG"
fi
