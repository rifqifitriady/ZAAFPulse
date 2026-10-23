const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS } = require('./helpers');
const demo = require('../lib/demo');

const ROOT = path.join(__dirname, '..');
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 6900 + Math.floor(Math.random() * 400);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

// Starts server.js on a free port with a throwaway HOME and data folder; the real ones are never read.
async function startServer(env) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-topo-api-'));
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const base = `http://127.0.0.1:${port}`;
    const stop = async () => {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { base, stop };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await stop();
  }
  throw new Error('could not start server.js on a free port');
}

test('topologyDemo: three layers, OmniRoute in error, Ollama model, 8 requests', () => {
  const t = demo.topologyDemo();
  const by = (id) => t.nodes.find((n) => n.id === id);
  assert.deepEqual([...new Set(t.nodes.map((n) => n.layer))], [0, 1, 2]);
  assert.equal(by('claude').label, 'Claude Code');
  assert.equal(by('codex').label, 'Codex');
  const router = t.nodes.find((n) => n.kind === 'router');
  assert.equal(router.label, 'OmniRoute');
  assert.equal(router.status, 'error');
  assert.equal(router.note, 'timed out');
  assert.ok(by('gateway'));
  assert.ok(by('runtime:ollama'));
  assert.ok(by('model:ollama:llama3.2:3b'));
  for (const p of ['anthropic', 'openai', 'google']) assert.ok(by(`provider:${p}`), p);
  assert.equal(t.requests.length, 8);
  assert.ok(t.edges.some((e) => e.from === 'codex' && e.to === router.id));
  assert.ok(t.requests.some((q) => q.source === 'router' && q.path[0] === 'codex'));
  assert.doesNotMatch(JSON.stringify(t), /https?:\/\//);
});

test('GET /api/topology: demo answer over HTTP, with no URL in the body', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  try {
    const r = await fetch(`${s.base}/api/topology`, { signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, 200);
    const text = await r.text();
    const t = JSON.parse(text);
    assert.deepEqual([...new Set(t.nodes.map((n) => n.layer))], [0, 1, 2]);
    assert.equal(t.nodes.find((n) => n.kind === 'router').status, 'error');
    assert.equal(t.requests.length, 8);
    assert.doesNotMatch(text, /http:\/\/|https:\/\//);
  } finally {
    await s.stop();
  }
});

test('GET /api/topology: 401 without sign-in, like the other routes', async () => {
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: 'correct horse battery' });
  try {
    const r = await fetch(`${s.base}/api/topology`, { signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, 401);
  } finally {
    await s.stop();
  }
});

test('GET /api/topology: a real (non-demo) server answers with an empty graph and no router', async () => {
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' });
  try {
    const r = await fetch(`${s.base}/api/topology`, { signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, 200);
    const t = await r.json();
    assert.ok(Array.isArray(t.nodes) && Array.isArray(t.edges) && Array.isArray(t.requests));
    assert.ok(!t.nodes.some((n) => n.kind === 'router'));
  } finally {
    await s.stop();
  }
});
