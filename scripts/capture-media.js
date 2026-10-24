#!/usr/bin/env node
// Regenerates the README screenshots and GIFs in docs/assets from the demo dataset.
// Starts `DEMO=1 node server.js` on a spare port and drives headless Chrome over the DevTools
// protocol; GIFs are encoded with ffmpeg. Needs Google Chrome and ffmpeg, no npm packages.
//   npm run media            all screenshots and GIFs
//   npm run media -- shots   screenshots only
//   npm run media -- gifs    GIFs only
//   npm run media -- shots screen-settings   one screenshot (or: gifs demo-brain); a comma list picks several
// MEDIA_PORT and MEDIA_CDP_PORT move the demo server and Chrome's DevTools port (defaults 4791 and 9339), for a
// machine where those are taken. The server runs with a throwaway HOME, so it never reads your own tool configs.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'assets');
const PORT = Number(process.env.MEDIA_PORT) || 4791;
const CDP_PORT = Number(process.env.MEDIA_CDP_PORT) || 9339;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEW = { width: 1440, height: 900 };
const only = process.argv[2];
const pick = process.argv[3] ? process.argv[3].split(',') : null; // optional: shot or GIF names, comma-separated
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Switch the second-brain map to one source and scroll it into view; the shot waits until it has settled.
const brainSource = (id) =>
  `document.querySelector('[data-brainsource="${id}"]')?.click(); new Promise((r) => setTimeout(() => { document.querySelector('#brain-canvas')?.scrollIntoView({ block: 'center' }); setTimeout(r, 1500); }, 2500))`;
// Scroll so the element `expr` finds sits just under the top bar.
const scrollToEl = (expr, gap = 84) =>
  `js:(() => { const e = ${expr}; scrollTo(0, e.getBoundingClientRect().top + scrollY - ${gap}); })()`;
const TOPO_HEAD = "document.querySelector('.card.topo').previousElementSibling";
const SHOTS = [
  ['screen-overview', '#overview'],
  ['screen-topology', '#overview', scrollToEl(TOPO_HEAD, 70)],
  ['screen-live', '#live'],
  ['screen-office', '#squad'],
  // The installed-tool cards at the foot of AI Office, with Start and Stop for the local model servers.
  ['screen-runtimes', '#squad', 'js:scrollTo(0, document.body.scrollHeight)'],
  ['screen-logs', '#squad/logs'],
  ['screen-proxy', '#squad/proxy'],
  ['screen-time', '#squad/time'],
  ['screen-quality', '#quality'],
  ['screen-evals', '#quality', scrollToEl("document.getElementById('ev-card')")],
  ['screen-utilization', '#quality/utilization'],
  ['screen-cache', '#quality/cache'],
  ['screen-compression', '#quality/compression'],
  ['screen-providers', '#quality/providers'],
  ['screen-models', '#quality/models'],
  ['screen-rankings', '#quality/rankings'],
  ['screen-sessions', '#sessions'],
  ['screen-projects', '#projects'],
  ['screen-trace', '#trace'],
  ['screen-datasets', '#datasets?ds=auth-regressions'],
  ['screen-experiments', '#datasets/experiments'],
  ['screen-agents', '#skills/usage'],
  ['screen-brain', '#brain'],
  ['screen-integrations', '#integrations'],
  ['screen-brain-all', '#brain', `js:${brainSource('all')}`],
  ['screen-brain-semantic', '#brain', `js:${brainSource('qdrant')}`],
  ['screen-brain-para', '#brain', `js:${brainSource('para')}`],
  // Agentic workspace (demo providers, keys, runs and knowledge bases come from lib/demo-gateway.js).
  ['screen-endpoint', '#endpoint'],
  ['screen-keys', '#endpoint/keys'],
  ['screen-mcp', '#endpoint/mcp'],
  ['screen-connect', '#endpoint/connect'],
  ['screen-code-tools', '#endpoint/tools'],
  ['screen-gateway', '#gateway'],
  ['screen-gateway-providers', '#gateway/providers'],
  ['screen-router', '#gateway/router'],
  [
    'screen-playground',
    '#gateway/playground',
    "js:(() => { const f = document.querySelector('#gw-pg-form'); f.input.value = 'Customers report slow checkout since 10:00. Check the network and recent deploys, then draft a status update.'; f.requestSubmit(); return new Promise((r) => setTimeout(r, 6000)); })()",
  ],
  // Dataset mode, with a $1 cost cap typed in: on macOS a number field shows the system region's decimal comma
  // ("0,5"), which no Chrome switch changes.
  [
    'screen-replay',
    '#gateway/playground',
    "js:document.querySelector('[data-gwpg=\"dataset\"]').click(); new Promise((r) => setTimeout(r, 1200)).then(() => { const c = document.getElementById('ds-pg-cost'); c.value = '1'; c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); })",
  ],
  ['screen-skills', '#skills'],
  ['screen-workflows', '#a2a'],
  ['screen-collaborate', '#a2a/collaborate'],
  ['screen-runs', '#a2a/runs'],
  ['screen-run-trace', '#a2a/runs', 'js:document.querySelectorAll(\'[data-a2arun="view"]\')[2]?.click()'],
  ['screen-rag', '#rag'],
  ['screen-settings', '#settings', scrollToEl("document.getElementById('prices-panel')")],
  ['screen-local-models', '#settings', scrollToEl("document.getElementById('rt-settings')")],
  ['screen-monitors', '#settings', scrollToEl("document.getElementById('mon-settings')")],
  ['screen-alerts', '#overview', '#mon-bell'],
  ['screen-integration-editor', '#integrations', '[data-integ-edit="omniroute"]'],
  ['screen-drawer-spend', '#overview', '[data-drill="spend"]'],
  ['screen-drawer-poisoning', '#quality', '[data-drill="poisoning"]'],
];
// [file, hash, seconds, before(): waits before recording, onStart: page script, crop, prep]
// crop: true = the content area without the sidebar; a string = an ffmpeg crop and scale of its own.
// prep: a page script run before recording starts (to scroll to a section, say).
// The topology GIF clicks three requests and then a node, so each path lights up in turn, and clears at the end.
const TOPO_CLICKS = `(() => {
  const req = (i) => () => document.querySelectorAll('[data-topo-req]')[i]?.click();
  const node = (id) => () => document.querySelector('[data-topo-node="' + id + '"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  [[600, req(0)], [2600, req(2)], [4600, req(4)], [6600, node('router:omniroute')], [8600, node('router:omniroute')]]
    .forEach(([ms, fn]) => setTimeout(fn, ms));
})()`;
const GIFS = [
  ['demo-overview', '#overview', 7],
  // Demo agents change activity every 15 s; start just before a change so they walk between rooms.
  [
    'demo-office',
    '#squad',
    8,
    async () => {
      const ms = 15000 - (Date.now() % 15000);
      await sleep(ms > 4000 ? ms - 4000 : ms + 11000);
    },
    'new Promise((r) => setTimeout(r, 1))',
    true,
  ],
  [
    'demo-brain',
    '#brain',
    9,
    null,
    "document.querySelector('[data-brainsource=\"all\"]')?.click(); new Promise((r) => setTimeout(r, 1800)).then(() => { document.querySelector('#brain-canvas')?.scrollIntoView({ block: 'center' }); document.querySelector('#brain-replay-btn')?.click(); })",
    true,
  ],
  ['demo-gateway', '#gateway', 7],
  // A group chat run from the Collaborate form, so the live trace and blackboard fill in.
  [
    'demo-collab',
    '#a2a/collaborate',
    9,
    null,
    "document.querySelector('[data-a2apattern=\"group\"]')?.click(); new Promise((r) => setTimeout(r, 600)).then(() => { const f = document.querySelector('#a2a-form'); f.task.value = 'Checkout p95 is 4.8 s since 10:02 and payment-api v2.14 went out at 09:55. Find the cause and draft a customer update.'; f.task.dispatchEvent(new Event('input', { bubbles: true })); f.requestSubmit(); return new Promise((r) => setTimeout(r, 900)); }).then(() => document.querySelector('#a2a-run')?.scrollIntoView({ block: 'start' }))",
    true,
  ],
  [
    'demo-topology',
    '#overview',
    10,
    null,
    TOPO_CLICKS,
    'crop=1120:490:284:62,scale=960:-1',
    `(${scrollToEl(TOPO_HEAD, 84).slice(3)}, new Promise((r) => setTimeout(r, 1500)))`,
  ],
];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) (this.handlers.get(msg.method) || []).forEach((h) => h(msg.params));
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) =>
      this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))),
    );
  }
  on(method, fn) {
    (this.handlers.get(method) || this.handlers.set(method, []).get(method)).push(fn);
  }
  off(method) {
    this.handlers.delete(method);
  }
}

async function waitFor(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if (await fn()) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('timed out waiting');
}

// True when something already answers on the port: another server, or another session's Chrome.
async function taken(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  // Demo mode fetches nothing: the Models, Rankings and live-price shots show OpenRouter's public lists only from a
  // copy that a normal run left in .cache/.
  const cache = path.join(process.env.ZAAFPULSE_DATA || ROOT, '.cache');
  for (const f of ['openrouter-models.json', 'openrouter-rankings.json', 'prices.json'])
    if (!fs.existsSync(path.join(cache, f)))
      console.warn(`note: no .cache/${f}; the Models, Rankings and price shots will say "not fetched"`);
  // Never drive a Chrome or read a server this script did not start.
  for (const [port, env] of [
    [PORT, 'MEDIA_PORT'],
    [CDP_PORT, 'MEDIA_CDP_PORT'],
  ]) {
    if (await taken(port)) throw new Error(`port ${port} is in use; pick a free one with ${env}=<port>`);
  }
  // A throwaway HOME: demo mode reads no logs, and this keeps your own tool configs out of it all the same.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-media-home-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DEMO: '1', PORT: String(PORT), HOME: home, USERPROFILE: home },
    stdio: 'ignore',
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-media-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      '--disable-gpu',
      '--lang=en-US',
      `--window-size=${VIEW.width},${VIEW.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      chrome.kill();
    } catch {
      /* gone */
    }
    try {
      server.kill();
    } catch {
      /* gone */
    }
    for (const dir of [profile, home]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* Chrome or the server still closing; the OS temp dir is cleaned later */
      }
    }
  };
  process.on('exit', cleanup);
  try {
    // Demo mode seeds the agentic workspace after start (keys, history, runs); wait until it is done.
    await waitFor(
      async () => (await (await fetch(`http://127.0.0.1:${PORT}/api/live`)).json()).demoReady === true,
      60000,
    );
    await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok);
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => {
      ws.onopen = r;
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    // Dates and numbers the page formats itself (toLocaleString) read as en-US, whatever this machine's region is.
    await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' });
    const open = async (hash) => {
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await sleep(200);
      await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/${hash}` });
      await waitFor(
        async () =>
          (
            await cdp.send('Runtime.evaluate', {
              expression:
                "!!document.querySelector('.holo-deck') && !document.querySelector('#view .skeleton') && !document.querySelector('#prices-panel .skeleton')",
              returnByValue: true,
            })
          ).result.value,
        20000,
      );
    };
    const evaluate = (expression) => cdp.send('Runtime.evaluate', { expression, awaitPromise: true });

    if (only !== 'gifs') {
      for (const [name, hash, click] of SHOTS.filter(([n]) => !pick || pick.includes(n))) {
        await open(hash);
        await sleep(5000); // let scenes grow and polls land
        // click: a selector to click, or `js:<script>` to run (e.g. scroll to a section).
        if (click) {
          await evaluate(click.startsWith('js:') ? click.slice(3) : `document.querySelector('${click}').click()`);
          await sleep(1400);
        }
        // JPEG keeps the dark gradients small; PNG is several times larger for no visible gain.
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
        fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(data, 'base64'));
        console.log(`shot  ${name}.jpg`);
        if (click) await evaluate("document.querySelector('#drawer-close')?.click()");
      }
    }
    if (only !== 'shots') {
      for (const [name, hash, seconds, before, onStart, crop, prep] of GIFS.filter(
        ([n]) => !pick || pick.includes(n),
      )) {
        if (before) await before();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `acc-${name}-`));
        const frames = [];
        await open(hash); // record from the first painted frame, so the entrance motion is kept without blank frames
        if (prep) await evaluate(prep);
        // Listen only now: frames the previous GIF's screencast still sends after it stopped would otherwise open
        // this GIF with a few frames of the last page, held for seconds.
        cdp.on('Page.screencastFrame', async (p) => {
          const file = path.join(dir, `f${String(frames.length).padStart(4, '0')}.jpg`);
          fs.writeFileSync(file, Buffer.from(p.data, 'base64'));
          frames.push({ file, t: p.metadata.timestamp });
          cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
        });
        await cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 88,
          maxWidth: VIEW.width,
          maxHeight: VIEW.height,
          everyNthFrame: 1,
        });
        if (onStart) {
          await sleep(1500);
          await evaluate(onStart);
        }
        await sleep(seconds * 1000);
        await cdp.send('Page.stopScreencast');
        cdp.off('Page.screencastFrame');
        // Concat list with each frame's real duration, then a two-pass palette GIF (960 px at 12 fps, or the
        // content area at 820 px and 10 fps for the busier scenes).
        const list =
          frames
            .map(
              (f, i) =>
                `file '${f.file}'\nduration ${Math.max(0.01, (frames[i + 1] || f).t - f.t || 1 / 12).toFixed(3)}`,
            )
            .join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
        fs.writeFileSync(path.join(dir, 'list.txt'), list);
        const gif = path.join(OUT, `${name}.gif`);
        execFileSync('ffmpeg', [
          '-y',
          '-loglevel',
          'error',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          path.join(dir, 'list.txt'),
          '-vf',
          `${crop === true ? 'fps=10,crop=1192:900:248:0,scale=760:-1' : crop ? `fps=12,${crop}` : 'fps=12,scale=960:-1'}:flags=lanczos,split[a][b];[a]palettegen=max_colors=${crop === true ? 128 : 160}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
          gif,
        ]);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`gif   ${name}.gif  ${frames.length} frames  ${(fs.statSync(gif).size / 1e6).toFixed(1)} MB`);
      }
    }
    ws.close();
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
