#!/bin/bash
# Removes the LaunchAgents added by install-autostart.sh. The app files are left untouched.
UID_NUM="$(id -u)"
for label in com.zaaf.aipulse.server com.zaaf.aipulse.opener; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
echo "Autostart removed. Start the dashboard by hand with: npm start"
