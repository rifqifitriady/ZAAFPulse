// Brings the dashboard to the front in Chrome at login and every time the Mac wakes
// (lid opened). Reuses an existing dashboard tab instead of opening a new one each time.
// With local sign-in (the default) a new tab, or one showing the sign-in page, gets a private one-time
// sign-in file from the data folder, so the owner lands signed in and no code is put on a command line.
const { execFile } = require('child_process');
const http = require('http');
const { pathToFileURL } = require('url');
const platform = require('../lib/platform');
const { localLoginPage } = require('../lib/auth');

const URL = `http://localhost:${Number(process.env.PORT) || 4777}`;
const TICK_MS = 5000;
const WAKE_GAP_MS = 30000; // timers stop during sleep, so a long gap between ticks means we just woke

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Resolves to the server's sign-in mode once it answers, or null.
function serverMode() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/session`, { timeout: 2000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(d).mode || 'none' : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitForServer(maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const mode = await serverMode();
    if (mode) return mode;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

// Focus an existing dashboard tab, or open one. Waits for Chrome to restore its session
// first, so a restored dashboard tab is reused rather than duplicated.
//   find u         focus a dashboard tab: "focused", "login" (it shows the sign-in page) or "missing"
//   show u target  load target in the sign-in tab, or in a new tab
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
          if (URL of t) starts with (u & "/login.html") then return "login"
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end findTab

on run argv
  set cmd to item 1 of argv
  set u to item 2 of argv
  set wasRunning to application "Google Chrome" is running
  tell application "Google Chrome" to activate
  if not wasRunning then delay 4
  if cmd is "find" then return my findTab(u)
  set target to item 3 of argv
  tell application "Google Chrome"
    if my findTab(u) is "login" then
      set URL of active tab of front window to target
    else if (count of windows) = 0 then
      make new window
      set URL of active tab of front window to target
    else
      tell front window to make new tab with properties {URL:target}
    end if
  end tell
  return "opened"
end run`;

const osa = (args) =>
  new Promise((resolve, reject) =>
    // The timeout covers an unanswered "allow to control Google Chrome" prompt.
    execFile('osascript', ['-e', SCRIPT, ...args], { timeout: 90000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    ),
  );

// Where a new tab goes: the dashboard, or with local sign-in a fresh sign-in file (only its path is passed on).
const targetFor = (mode) => (mode === 'local' ? pathToFileURL(localLoginPage(platform.dataDir(), URL)).href : URL);

async function showDashboard(reason, mode) {
  try {
    const found = await osa(['find', URL]);
    if (found === 'focused') return log(reason, found);
    log(reason, await osa(['show', URL, targetFor(mode)]));
  } catch (err) {
    log(reason, 'AppleScript failed, opening with the default browser:', err.message.split('\n')[0]);
    execFile('open', [mode === 'local' ? localLoginPage(platform.dataDir(), URL) : URL]);
  }
}

let busy = false;
async function show(reason) {
  if (busy) return;
  busy = true;
  try {
    const mode = await waitForServer();
    if (mode) await showDashboard(reason, mode);
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
