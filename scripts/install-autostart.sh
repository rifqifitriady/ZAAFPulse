#!/bin/bash
# Installs two LaunchAgents for the current user:
#   com.zaaf.aipulse.server  keeps the dashboard server running (starts at login, restarts on crash)
#   com.zaaf.aipulse.opener  shows the dashboard in Chrome at login and whenever the Mac wakes
# Undo with scripts/uninstall-autostart.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/AIPulse"
UID_NUM="$(id -u)"
mkdir -p "$AGENTS" "$LOGS"
chmod +x "$DIR/scripts/launch.sh"

write_plist() { # label script keepalive
  cat > "$AGENTS/$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/scripts/launch.sh</string>
    <string>$2</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><$3/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOGS/$(basename "$2" .js).log</string>
  <key>StandardErrorPath</key><string>$LOGS/$(basename "$2" .js).log</string>
</dict>
</plist>
PLIST
  plutil -lint "$AGENTS/$1.plist" >/dev/null
}

write_plist com.zaaf.aipulse.server server.js true
write_plist com.zaaf.aipulse.opener scripts/open-dashboard.js true

# Stop any copy started by hand so the port is free, then (re)load both agents.
pkill -f "$DIR/server.js" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true
for label in com.zaaf.aipulse.server com.zaaf.aipulse.opener; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
done
sleep 1
for label in com.zaaf.aipulse.server com.zaaf.aipulse.opener; do
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$label.plist"
  launchctl enable "gui/$UID_NUM/$label"
done
echo "Installed. Dashboard: http://localhost:4777  ·  Logs: $LOGS"
