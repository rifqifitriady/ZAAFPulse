// Brings the dashboard to the front in Chrome at login and every time the Mac wakes
// (lid opened). Reuses an existing dashboard tab instead of opening a new one each time.
const { execFile } = require('child_process');
const http = require('http');

const URL = `http://localhost:${Number(process.env.PORT) || 4777}`;
const TICK_MS = 5000;
const WAKE_GAP_MS = 30000; // timers stop during sleep, so a long gap between ticks means we just woke

const log = (...a) => console.log(new Date().toISOString(), ...a);

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/live`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await serverUp()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// Focus an existing dashboard tab, or open one. Waits for Chrome to restore its session
// first, so a restored dashboard tab is reused rather than duplicated.
const SCRIPT = `
on findTab(u)
  tell application "Google Chrome"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if (URL of t) starts with u then
          set active tab index of w to i
          set index of w to 1
          return true
        end if
      end repeat
    end repeat
  end tell
  return false
end findTab

on run argv
  set u to item 1 of argv
  set wasRunning to application "Google Chrome" is running
  tell application "Google Chrome" to activate
  if not wasRunning then delay 4
  if my findTab(u) then return "focused"
  tell application "Google Chrome"
    if (count of windows) = 0 then
      make new window
      set URL of active tab of front window to u
    else
      tell front window to make new tab with properties {URL:u}
    end if
  end tell
  return "opened"
end run`;

function showDashboard(reason) {
  // The timeout covers an unanswered "allow to control Google Chrome" prompt.
  execFile('osascript', ['-e', SCRIPT, URL], { timeout: 90000 }, (err, stdout) => {
    if (!err) return log(reason, stdout.trim());
    log(reason, 'AppleScript failed, opening with the default browser:', err.message.split('\n')[0]);
    execFile('open', [URL]);
  });
}

let busy = false;
async function show(reason) {
  if (busy) return;
  busy = true;
  try {
    if (await waitForServer()) showDashboard(reason);
    else log(reason, 'server did not come up; not opening');
  } finally {
    busy = false;
  }
}

show('login');
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - last > WAKE_GAP_MS) setTimeout(() => show('wake'), 3000);
  last = now;
}, TICK_MS);
