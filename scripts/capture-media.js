#!/usr/bin/env node
// Regenerates the README screenshots and GIFs in docs/assets from the demo dataset.
// Starts `DEMO=1 node server.js` on a spare port and drives headless Chrome over the DevTools
// protocol; GIFs are encoded with ffmpeg. Needs Google Chrome and ffmpeg, no npm packages.
//   npm run media            all screenshots and GIFs
//   npm run media -- shots   screenshots only
//   npm run media -- gifs    GIFs only
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'assets');
const PORT = 4791; const CDP_PORT = 9339;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEW = { width: 1440, height: 900 };
const only = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOTS = [
  ['screen-overview', '#overview'], ['screen-live', '#live'], ['screen-office', '#squad'], ['screen-logs', '#squad/logs'],
  ['screen-proxy', '#squad/proxy'], ['screen-time', '#squad/time'], ['screen-quality', '#quality'], ['screen-utilization', '#quality/utilization'],
  ['screen-cache', '#quality/cache'], ['screen-compression', '#quality/compression'], ['screen-providers', '#quality/providers'],
  ['screen-sessions', '#sessions'], ['screen-projects', '#projects'], ['screen-agents', '#agents'], ['screen-brain', '#brain'], ['screen-integrations', '#integrations'],
  ['screen-drawer-spend', '#overview', '[data-drill="spend"]'], ['screen-drawer-poisoning', '#quality', '[data-drill="poisoning"]'],
];
// [file, hash, seconds, before(): waits before recording, onStart: page script, crop: true = content only, no sidebar]
const GIFS = [
  ['demo-overview', '#overview', 7],
  // Demo agents change activity every 15 s; start just before a change so they walk between rooms.
  ['demo-office', '#squad', 8, async () => { const ms = 15000 - (Date.now() % 15000); await sleep(ms > 4000 ? ms - 4000 : ms + 11000); }, 'new Promise((r) => setTimeout(r, 1))', true],
  ['demo-brain', '#brain', 8, null, "document.querySelector('#brain-replay-btn')?.click()", true],
];

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); } else if (msg.method) (this.handlers.get(msg.method) || []).forEach((h) => h(msg.params)); }; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))); }
  on(method, fn) { (this.handlers.get(method) || this.handlers.set(method, []).get(method)).push(fn); }
  off(method) { this.handlers.delete(method); }
}

async function waitFor(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await fn()) return; } catch { /* not up yet */ } await sleep(250); }
  throw new Error('timed out waiting');
}

async function main() {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DEMO: '1', PORT: String(PORT) }, stdio: 'ignore' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-media-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--disable-gpu', `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank'], { stdio: 'ignore' });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    try { chrome.kill(); } catch { /* gone */ } try { server.kill(); } catch { /* gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Chrome still closing; the OS temp dir is cleaned later */ }
  };
  process.on('exit', cleanup);
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/api/live`)).ok);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok);
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    const open = async (hash) => {
      await cdp.send('Page.navigate', { url: 'about:blank' }); await sleep(200);
      await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/${hash}` });
      await waitFor(async () => (await cdp.send('Runtime.evaluate', { expression: "!!document.querySelector('.holo-deck') && !document.querySelector('#view .skeleton')", returnByValue: true })).result.value, 20000);
    };
    const evaluate = (expression) => cdp.send('Runtime.evaluate', { expression, awaitPromise: true });

    if (only !== 'gifs') {
      for (const [name, hash, click] of SHOTS) {
        await open(hash); await sleep(5000); // let scenes grow and polls land
        if (click) { await evaluate(`document.querySelector('${click}').click()`); await sleep(1400); }
        // JPEG keeps the dark gradients small; PNG is several times larger for no visible gain.
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
        fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(data, 'base64'));
        console.log(`shot  ${name}.jpg`);
        if (click) await evaluate("document.querySelector('#drawer-close')?.click()");
      }
    }
    if (only !== 'shots') {
      for (const [name, hash, seconds, before, onStart, crop] of GIFS) {
        if (before) await before();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `acc-${name}-`));
        const frames = [];
        cdp.on('Page.screencastFrame', async (p) => {
          const file = path.join(dir, `f${String(frames.length).padStart(4, '0')}.jpg`);
          fs.writeFileSync(file, Buffer.from(p.data, 'base64')); frames.push({ file, t: p.metadata.timestamp });
          cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
        });
        await open(hash); // record from the first painted frame, so the entrance motion is kept without blank frames
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
        if (onStart) { await sleep(1500); await evaluate(onStart); }
        await sleep(seconds * 1000);
        await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame');
        // Concat list with each frame's real duration, then a two-pass palette GIF (960 px at 12 fps, or the
        // content area at 820 px and 10 fps for the busier scenes).
        const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.01, ((frames[i + 1] || f).t - f.t) || 1 / 12).toFixed(3)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
        fs.writeFileSync(path.join(dir, 'list.txt'), list);
        const gif = path.join(OUT, `${name}.gif`);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
          '-vf', `${crop ? 'fps=10,crop=1192:900:248:0,scale=760:-1' : 'fps=12,scale=960:-1'}:flags=lanczos,split[a][b];[a]palettegen=max_colors=${crop ? 128 : 160}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif]);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`gif   ${name}.gif  ${frames.length} frames  ${(fs.statSync(gif).size / 1e6).toFixed(1)} MB`);
      }
    }
    ws.close();
  } finally { cleanup(); }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
