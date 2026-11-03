// Governance audit log (AI Governance 2) through a spawned server.js: a temp data folder, no network, no sign-in (or a
// password where sign-in is tested). The entries are read from the month files the server writes; each one is
// written before the answer it records. Ports 9600-9799 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS, fakeServer } = require('./helpers');
const { queueEvent } = require('../lib/governance/audit');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 9600 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

// Starts server.js on a free port of the range (again when another test took the port first); stopped and its data
// folder removed when the test ends. An answer counts only while the child is still running. prepare(data) runs on
// the empty data folder before the server starts.
async function startServer(t, env = {}, prepare = null) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-http-'));
    if (prepare) prepare(data);
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: 'none',
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
    const gone = new Promise((r) => child.on('exit', () => r((exited = true))));
    const stop = async () => {
      if (!exited) child.kill();
      await gone;
      fs.rmSync(data, { recursive: true, force: true });
    };
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await sleep(200);
        if (!exited) {
          t.after(stop);
          return { base, data, alive: () => !exited };
        }
      } catch {
        await sleep(150);
      }
    }
    await stop();
  }
  throw new Error('could not start server.js on a free port');
}
// One request: JSON in and out (text when the answer is not JSON).
async function call(s, p, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(s.base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: json === null ? text : json, headers: r.headers };
}
// Every entry the server wrote, oldest first.
function entries(s) {
  const dir = path.join(s.data, '.data', 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^governance-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
const LOCAL = { via: 'dashboard', mode: 'none', device: null, ip: '127.0.0.1' };

test('dashboard changes: one entry each, with the dashboard actor and the outcome; reads are not entries', async (t) => {
  const s = await startServer(t);
  assert.equal((await call(s, '/api/config')).status, 200);
  assert.equal(
    (await call(s, '/api/gateway/collab', { method: 'POST', body: { action: 'get', id: 'run_0' } })).status,
    200,
  );
  assert.deepEqual(entries(s), [], 'reads write nothing (and make no key)');
  assert.equal((await call(s, '/api/config', { method: 'POST', body: { userName: 'Ana' } })).status, 200);
  const made = await call(s, '/api/gateway/keys', { method: 'POST', body: { action: 'create', name: 'ci' } });
  assert.match(made.body.secret, /^zp_/);
  const bad = await call(s, '/api/gateway/keys', { method: 'POST', body: { action: 'create' } });
  assert.deepEqual(bad.body.errors, ['name is required']);
  assert.equal((await call(s, '/api/monitors/tool_loop', { method: 'POST', body: { enabled: false } })).status, 200);
  assert.equal(
    (await call(s, '/api/config', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status,
    415,
  );
  const all = entries(s);
  const requests = all.filter((e) => /^(POST|PUT|PATCH|DELETE) /.test(e.action));
  assert.deepEqual(
    requests.map((e) => [e.action, e.op || null, e.target || null, e.outcome, e.status]),
    [
      ['POST /api/config', null, null, 'ok', 200],
      ['POST /api/gateway/keys', 'create', { type: 'gateway.keys', name: 'ci' }, 'ok', 200],
      ['POST /api/gateway/keys', 'create', null, 'refused', 200],
      ['POST /api/monitors/:id', null, { type: 'monitors', id: 'tool_loop' }, 'ok', 200],
      ['POST /api/config', null, null, 'refused', 415],
    ],
  );
  for (const e of requests) assert.deepEqual(e.actor, LOCAL);
  assert.equal(all[0].action, 'audit.key_created');
  assert.ok(!JSON.stringify(all).includes(made.body.secret), 'a key secret is never written');
  assert.ok(s.alive());
});
