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

test('config changes: both writers leave a config.change entry with the fields, secrets masked', async (t) => {
  const s = await startServer(t);
  assert.equal((await call(s, '/api/config', { method: 'POST', body: { userName: 'Ana' } })).status, 200);
  const guard = { guardrails: { secrets: 'block' } };
  assert.equal((await call(s, '/api/gateway/settings', { method: 'POST', body: guard })).status, 200);
  const integration = { id: 'r1', type: 'router', values: { baseUrl: 'http://127.0.0.1:9', flavor: '9router' } };
  assert.equal((await call(s, '/api/integrations/save', { method: 'POST', body: integration })).status, 200);
  assert.equal((await call(s, '/api/integrations/delete', { method: 'POST', body: { id: 'r1' } })).status, 200);
  const all = entries(s).filter((e) => e.action !== 'audit.key_created');
  assert.deepEqual(
    all.map((e) => e.action),
    [
      'config.change',
      'POST /api/config',
      'config.change',
      'POST /api/gateway/settings',
      'config.change',
      'POST /api/integrations/save',
      'config.change',
      'POST /api/integrations/delete',
    ],
  );
  const [cfg, , gw, , saved, , gone] = all;
  assert.deepEqual(cfg.target, { type: 'config', id: 'monthlyBudgetUSD,userName,vaultPaths' });
  assert.deepEqual(
    cfg.changes.find((c) => c.path === 'userName'),
    { path: 'userName', from: null, to: 'Ana' },
  );
  assert.ok(gw.changes.some((c) => c.path === 'gateway.guardrails.secrets' && c.to === 'block'));
  assert.ok(saved.changes.some((c) => c.path === 'integrations.r1.baseUrl' && c.to === 'http://127.0.0.1:9'));
  assert.ok(gone.changes.some((c) => c.path === 'integrations.r1.baseUrl' && c.from === 'http://127.0.0.1:9'));
  assert.deepEqual(all[5].target, { type: 'integrations', id: 'r1' });
  for (const e of all) assert.deepEqual(e.actor, LOCAL);
  assert.ok(s.alive());
});

test('request bodies over 64 KiB lose only op and target in their entry', async (t) => {
  const s = await startServer(t);
  const pad = 'a'.repeat(70 * 1024);
  const r = await call(s, '/api/integrations/delete', { method: 'POST', body: { id: 'nope', pad } });
  assert.equal(r.status, 200);
  await call(s, '/api/integrations/delete', { method: 'POST', body: { id: 'nope' } });
  const reqs = entries(s).filter((e) => e.action === 'POST /api/integrations/delete');
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].target, undefined);
  assert.deepEqual(reqs[1].target, { type: 'integrations', id: 'nope' });
  assert.equal(reqs[0].status, reqs[1].status);
  assert.ok(s.alive());
});

test('config changes: a diff that fails never fails the save that was already written', async (t) => {
  // A value nested deeper than the diff can walk makes it throw; the save must still answer and show up on the next GET.
  const deep = '['.repeat(3000) + ']'.repeat(3000);
  const s = await startServer(t, {}, (data) => {
    fs.writeFileSync(path.join(data, 'config.json'), `{"deep":${deep},"userName":"Old"}`);
  });
  const r = await call(s, '/api/config', { method: 'POST', body: { userName: 'New' } });
  assert.equal(r.status, 200);
  const g = await call(s, '/api/config');
  assert.equal(g.body.userName, 'New');
  assert.ok(s.alive());
});

test('keys, runs, reveal and control: the gateway key and the API key that acts are named', async (t) => {
  const upstream = await fakeServer({
    'POST /chat/completions': {
      body: {
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    },
    'GET /models': { body: { data: [{ id: 'm' }] } },
  });
  t.after(() => upstream.close());
  const s = await startServer(t);
  const admin = async (route, body) => (await call(s, `/api/gateway/${route}`, { method: 'POST', body })).body;
  await admin('providers', { action: 'save', id: 'fake', preset: 'custom', baseUrl: upstream.url, tier: 'private' });
  await admin('defaults', { model: 'fake/m', plannerModel: 'fake/m' });
  await admin('workflows', {
    action: 'save',
    id: 'gated',
    name: 'Gated',
    steps: [
      { agent: 'hr-finance', prompt: 'Review {{input}}' },
      { agent: 'legal-compliance', prompt: 'Sign off {{step1}}', approve: true },
    ],
  });
  const made = await admin('keys', { action: 'create', name: 'pipeline', scopes: ['agents', 'llm'] });
  const auth = { authorization: `Bearer ${made.secret}` };
  const run = await call(s, '/v1/workflows/gated/run', { method: 'POST', body: { input: 'x' }, headers: auth });
  assert.equal(run.body.state, 'input-required');
  const resume = (approve) =>
    call(s, `/v1/runs/${run.body.id}/resume`, { method: 'POST', body: { approve }, headers: auth });
  assert.equal((await resume(true)).status, 403);
  assert.equal((await resume(false)).body.state, 'rejected');
  assert.equal((await call(s, '/api/trace/reveal', { method: 'POST', body: { id: 'nope', index: 0 } })).status, 404);
  const start = await call(s, '/api/runtimes/start', { method: 'POST', body: { id: 'ollama' } });
  assert.equal(start.status, 403);
  const all = entries(s);
  const one = (action) => all.filter((e) => e.action === action);
  assert.deepEqual(one('key.create')[0].target, { type: 'key', id: made.key.id, name: 'pipeline' });
  assert.deepEqual(one('key.create')[0].actor, LOCAL);
  const byKey = { via: 'apikey', keyId: made.key.id };
  assert.deepEqual(
    [...one('run.approve'), ...one('run.reject')].map((e) => [e.action, e.outcome, e.actor]),
    [
      ['run.approve', 'refused', byKey],
      ['run.reject', 'ok', byKey],
    ],
  );
  assert.deepEqual(
    one('trace.reveal').map((e) => [e.target, e.outcome, e.status, e.actor]),
    [[{ type: 'content', id: 'nope' }, 'refused', 404, LOCAL]],
  );
  assert.deepEqual(
    one('runtime.start').map((e) => [e.target, e.outcome, e.status, e.actor]),
    [[{ type: 'runtime', id: 'ollama' }, 'refused', 403, LOCAL]],
  );
  assert.ok(fs.existsSync(path.join(s.data, '.data', 'agent-audit.jsonl')), 'the control log stays');
  assert.ok(!JSON.stringify(all).includes(made.secret));
  assert.ok(s.alive());
});

test('sign-in: login, a change, logout, five failures and one lockout, with the device and address', async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: 'correct horse battery' });
  const ok = await call(s, '/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const headers = { cookie, origin: s.base };
  assert.equal((await call(s, '/api/config', { method: 'POST', body: { userName: 'Ana' }, headers })).status, 200);
  assert.equal((await call(s, '/api/logout', { method: 'POST', body: {}, headers })).status, 200);
  for (let i = 0; i < 5; i++)
    assert.equal((await call(s, '/api/login', { method: 'POST', body: { password: `nope ${i}` } })).status, 401);
  assert.equal((await call(s, '/api/login', { method: 'POST', body: { password: 'nope' } })).status, 429);
  const all = entries(s).filter((e) => e.action !== 'audit.key_created');
  assert.deepEqual(
    all.map((e) => e.action),
    [
      'auth.login',
      'config.change',
      'POST /api/config',
      'auth.logout',
      'auth.login_failed',
      'auth.login_failed',
      'auth.login_failed',
      'auth.login_failed',
      'auth.login_failed',
      'auth.lockout',
    ],
  );
  const device = all[0].actor.device;
  assert.ok(device);
  for (const e of all.slice(0, 4))
    assert.deepEqual(e.actor, { via: 'dashboard', mode: 'password', device, ip: '127.0.0.1' });
  assert.deepEqual(all[4].actor, { via: 'dashboard', mode: 'password', device: null, ip: '127.0.0.1' });
  assert.ok(!JSON.stringify(all).includes('nope') && !JSON.stringify(all).includes('horse'));
  assert.ok(s.alive());
});
