// /api/runtimes through a spawned server.js: demo data and demo actions, the owner's entries saved to config.json,
// the sign-in gate (gateway keys refused) and control off with password sign-in. Nothing here starts a runtime: the
// only start is in demo mode, and the real server is asked to start an entry that is not approved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { detectDocker } = require('../lib/agents/control');
const { secretsFor, NO_JUDGE_PORTS } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const noPaths = (bodies) => {
  for (const b of bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
};
const ROUTES = {
  get: ['/api/runtimes', '/api/runtimes/config'],
  post: ['/api/runtimes/start', '/api/runtimes/stop', '/api/runtimes/approve', '/api/runtimes/save', '/api/runtimes/delete'],
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function startServer(env, { data = tmp('zp-rt-http-') } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ZAAFPULSE_SECRET_STORE: 'file',
        ZAAFPULSE_MASTER_KEY: 'a-master-key-for-the-tests-only',
        ...NO_JUDGE_PORTS,
        // ps still works; nothing here starts a runtime, and the lookups see only system folders
        PATH: '/usr/bin:/bin',
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
    const kill = async () => {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
    };
    const stop = async () => {
      await kill();
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { port, data, base, stop };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}
function client(base, headers = {}) {
  const bodies = [];
  const call = async (p, { method = 'GET', body, raw, extra = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...extra },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  };
  const post = (p, body, extra = JSON_HEADERS) => call(p, { method: 'POST', body, extra });
  return { call, post, bodies };
}

test('runtimes over HTTP: demo runtimes, demo start and stop, approve, nothing saved', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const list = await c.call('/api/runtimes');
    assert.equal(list.status, 200);
    const by = Object.fromEntries(list.json.map((r) => [r.id, r]));
    assert.equal(by.ollama.running, true);
    assert.equal(by.ollama.how, 'service');
    assert.equal(by['qwen-local'].reason, 'approve it in Settings first');
    const stop = await c.post('/api/runtimes/stop', { id: 'ollama', pid: by.ollama.pid, startTime: by.ollama.startTime });
    assert.deepEqual(stop.json, { state: 'stopped', demo: true });
    assert.deepEqual((await c.post('/api/runtimes/start', { id: 'ollama' })).json, { state: 'running', demo: true });
    assert.equal((await c.post('/api/runtimes/start', { id: 'qwen-local' })).status, 403);
    assert.equal((await c.post('/api/runtimes/approve', { id: 'qwen-local' })).status, 200);
    assert.equal((await c.post('/api/runtimes/start', { id: 'qwen-local' })).status, 200);
    const cfg = await c.call('/api/runtimes/config');
    assert.deepEqual(cfg.json.entries[0].command.slice(0, 3), ['llama-server', '-m', '~/models/qwen2.5-7b-instruct-q4_k_m.gguf']);
    assert.equal(cfg.json.demo, true);
    assert.equal((await c.post('/api/runtimes/save', { entry: { id: 'x', command: ['x'], port: 1 } })).status, 409);
    assert.equal((await c.call('/api/runtimes/start', { method: 'POST', raw: '{"id":"ollama"}' })).status, 415);
    assert.ok(!fs.existsSync(path.join(s.data, 'config.json')), 'demo mode writes no config.json');
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('runtimes over HTTP: an owner entry is saved to config.json, listed, and starts only once approved', async () => {
  const data = tmp('zp-rt-http-cfg-');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ userName: 'Kept' }));
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const entry = { id: 'fake-llm', name: 'Fake', command: ['zp-no-such-program', '--port', '18081'], port: 18081 };
    const saved = await c.post('/api/runtimes/save', { entry });
    assert.equal(saved.status, 200);
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(cfg.userName, 'Kept');
    assert.deepEqual(cfg.localRuntimes, [entry], 'the default health URL is not stored');
    const row = (await c.call('/api/runtimes')).json.find((r) => r.id === 'fake-llm');
    assert.equal(row.installed, false);
    assert.equal(row.canStart, false);
    const start = await c.post('/api/runtimes/start', { id: 'fake-llm' });
    assert.ok([403, 409].includes(start.status), `refused (${start.status})`);
    if (!detectDocker()) {
      assert.equal(start.status, 409);
      assert.equal(start.json.error, 'not installed');
      assert.equal((await c.post('/api/runtimes/approve', { id: 'fake-llm' })).status, 200);
      const approved = path.join(data, '.data', 'runtimes', 'approved.json');
      assert.ok(fs.existsSync(approved));
      if (process.platform !== 'win32') assert.equal(fs.statSync(approved).mode & 0o777, 0o600);
      const audit = fs.readFileSync(path.join(data, '.data', 'agent-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(
        audit.map((l) => [l.kind, l.action, l.id, l.ok]),
        [
          ['runtime', 'save', 'fake-llm', true],
          ['runtime', 'start', 'fake-llm', false],
          ['runtime', 'approve', 'fake-llm', true],
        ],
      );
    }
    assert.equal((await c.post('/api/runtimes/delete', { id: 'fake-llm' })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).localRuntimes, []);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('runtimes over HTTP: a config.json that does not parse is refused, never overwritten', async () => {
  const data = tmp('zp-rt-http-bad-');
  const file = path.join(data, 'config.json');
  const broken = '{ "userName": "Kept", "gateway": { "port": 4000 }, }\n';
  fs.writeFileSync(file, broken);
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const entry = { id: 'fake-llm', command: ['zp-no-such-program', '--port', '18081'], port: 18081 };
    const saved = await c.post('/api/runtimes/save', { entry });
    assert.equal(saved.status, 500);
    assert.equal(saved.json.error, 'the settings could not be saved');
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'config.json is untouched');
    assert.deepEqual(fs.readdirSync(data).filter((f) => f.startsWith('config.json')), ['config.json'], 'no temp file left');
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('runtimes over HTTP: a save writes config.json with mode 0600', { skip: process.platform === 'win32' }, async () => {
  const data = tmp('zp-rt-http-mode-');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ userName: 'Kept' }), { mode: 0o644 });
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const entry = { id: 'fake-llm', command: ['zp-no-such-program', '--port', '18081'], port: 18081 };
    assert.equal((await c.post('/api/runtimes/save', { entry })).status, 200);
    assert.equal(fs.statSync(path.join(data, 'config.json')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).userName, 'Kept');
  } finally {
    await s.stop();
  }
});

test('runtimes over HTTP: sign-in only, gateway keys refused, control off with password sign-in', async () => {
  const data = tmp('zp-rt-http-auth-');
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'rt', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 }).secret;
  gw.flush();
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  const anon = client(s.base);
  const bearer = client(s.base, { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey });
  try {
    for (const who of [anon, bearer]) {
      for (const p of ROUTES.get) assert.equal((await who.call(p)).status, 401, p);
      for (const p of ROUTES.post) assert.equal((await who.post(p, { id: 'ollama' })).status, 401, p);
    }
    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const c = client(s.base, { cookie });
    const list = await c.call('/api/runtimes');
    assert.equal(list.status, 200);
    for (const r of list.json) {
      assert.equal(r.canStart, false);
      assert.equal(r.canStop, false);
      assert.equal(r.reason, 'runtime control is off on this server');
    }
    const start = await c.post('/api/runtimes/start', { id: 'ollama' });
    assert.equal(start.status, 403);
    assert.equal(start.json.error, 'runtime control is off on this server');
    assert.equal((await c.post('/api/runtimes/stop', { id: 'ollama', pid: 4242, startTime: 1 })).status, 403);
    assert.equal((await c.post('/api/runtimes/approve', { id: 'ollama' })).status, 403);
    for (const who of [c, anon, bearer]) noPaths(who.bodies);
  } finally {
    await s.stop();
  }
});
