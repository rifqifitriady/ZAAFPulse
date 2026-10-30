// The Settings page's routes (Cost Control 3b, lib/cost/api.js): POST /api/cost/settings/preview,
// POST /api/cost/restate/preview, GET /api/cost/restates and `reasons` in GET /api/cost/settings. In process with a
// real cost object, then over HTTP: the dashboard sign-in only, and the demo. Never the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-settings-api-'));
const ACME = { centers: [{ id: 'acme', name: 'Acme' }], keyCenters: { key_a: 'acme' } };
// One gateway line of key_a: a Sonnet call of 1,000 in and 100 out (0.003 at PRICE_A).
const line = (ts) =>
  JSON.stringify({
    ts,
    keyId: 'key_a',
    provider: 'p',
    model: 'claude-sonnet-5-5',
    kind: 'chat',
    input: 1000,
    output: 100,
  }) + '\n';

function setup({ saved, demo = null, cost: fake = null } = {}) {
  const dir = tmp();
  const st = { saved, t: at(22), pricing: PRICE_A };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost =
    fake ||
    createCost({
      dir: demo ? null : path.join(dir, 'cost'),
      gatewayLog: demo ? null : gatewayLog,
      getPricing: () => st.pricing,
      getSettings: () => st.saved,
      home: HOME,
      now: () => st.t,
      nocase: false,
      demo,
    });
  const api = createCostApi({
    cost,
    settings: { get: () => st.saved, save: (v) => (st.saved = v) },
    listKeys: () => [{ id: 'key_a', name: 'Acme app', hash: 'never-shown' }],
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const bodies = [];
  const call = async (method, p, body) => {
    const res = await api.route({
      method,
      path: p,
      query: new URLSearchParams(),
      contentType: 'application/json',
      readBody: async () => (body === undefined ? '' : JSON.stringify(body)),
    });
    if (res) bodies.push(JSON.stringify(res.body));
    return res;
  };
  return { st, cost, call, bodies, gatewayLog, dir };
}

test('settings answer: reasons are the scrubbed validation reasons, [] when the section reads or config.json does not', async () => {
  const ok = await setup({ saved: ACME }).call('GET', '/api/cost/settings');
  assert.deepEqual([ok.body.error, ok.body.reasons], [null, []]);
  assert.deepEqual(Object.keys(ok.body).sort(), ['error', 'keys', 'reasons', 'settings', 'sources', 'unassigned']);
  const bad = setup({ saved: { centers: 'nope', [`${HOME}/x`]: 1 } });
  const b = await bad.call('GET', '/api/cost/settings');
  assert.match(b.body.error, /cost settings in config\.json are invalid/);
  assert.ok(b.body.reasons.includes('centers must be a list'));
  assert.equal(b.body.reasons.length, 2);
  assert.match(
    b.body.reasons.find((r) => r.startsWith('unknown field')),
    /\[path\]/,
  );
  const broken = await setup({ saved: false }).call('GET', '/api/cost/settings');
  assert.match(broken.body.error, /config\.json could not be read/);
  assert.deepEqual(broken.body.reasons, []);
  for (const x of bad.bodies) assert.doesNotMatch(x, PATHS);
});

test('settings preview: a draft against the settings in force over the last 30 days; nothing saved', async () => {
  const s = setup();
  fs.writeFileSync(s.gatewayLog, line(at(21)) + line(at(22)));
  s.cost.update();
  const draft = { ...ACME, folderRules: [{ glob: `${HOME}/work/**`, center: 'acme' }] };
  const r = await s.call('POST', '/api/cost/settings/preview', { settings: draft, testPath: `${HOME}/work/site` });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.from, r.body.to, r.body.unread], ['2026-09-23', '2026-10-22', []]);
  assert.deepEqual(r.body.moves, [
    { project: null, keyId: 'key_a', keyName: 'Acme app', listUSD: 0.006, from: 'unassigned', to: 'acme', by: 'key' },
  ]);
  assert.equal(r.body.more, 0);
  assert.deepEqual(r.body.rules, [{ index: 0, status: 'none', by: null }]);
  assert.deepEqual(r.body.test, { center: 'acme', rule: 0 }, 'the test path is rewritten to ~ like a glob');
  assert.equal(s.st.saved, undefined, 'a preview saves nothing');
  const none = await s.call('POST', '/api/cost/settings/preview', { settings: {} });
  assert.deepEqual([none.body.moves, none.body.test], [[], null]);
});

test('settings preview: unknown fields, a bad test path and a draft that does not validate are 400s', async () => {
  const s = setup();
  const post = (body) => s.call('POST', '/api/cost/settings/preview', body);
  const extra = await post({ settings: {}, budgets: [] });
  assert.deepEqual([extra.status, extra.body.error], [400, 'unknown field: budgets']);
  assert.equal((await post({ settings: {}, testPath: 7 })).status, 400);
  const long = await post({ settings: {}, testPath: `~/${'a'.repeat(1000)}` });
  assert.deepEqual([long.status, long.body.error], [400, 'testPath: a string of at most 1000 characters']);
  const bad = await post({ settings: { centers: [{ id: 'acme', name: 'Acme' }], folderRules: [{ glob: 'x/**' }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid cost settings');
  assert.deepEqual(bad.body.reasons, ['folderRules[0].glob: starts with ~, /, * or a drive letter like C:/']);
  assert.equal((await post({})).body.reasons[0], 'cost settings must be an object');
});

test('restate preview: the restate rules without reason and confirm; it writes nothing', async () => {
  const s = setup();
  fs.writeFileSync(s.gatewayLog, line(at(20)) + line(at(21)));
  s.cost.update();
  s.st.saved = ACME;
  s.st.pricing = PRICE_B;
  const post = (body) => s.call('POST', '/api/cost/restate/preview', body);
  for (const [body, why] of [
    [{ from: '2026-10-20', to: '2026-10-22' }, /up to yesterday/],
    [{ from: '2025-01-01', to: '2026-10-21' }, /at most 400 days/],
    [{ from: '2026-10-21', to: '2026-10-20' }, /on or before/],
    [{ from: '2026-10-20', to: '2026-10-21', reason: 'x' }, /unknown field: reason/],
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  const r = await post({ from: '2026-10-20', to: '2026-10-21' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    [r.body.from, r.body.to, r.body.changed, r.body.total, r.body.versionsBefore, r.body.version, r.body.newPrices],
    ['2026-10-20', '2026-10-21', 2, 2, [1], null, true],
  );
  assert.deepEqual([r.body.beforeUSD, r.body.afterUSD], [0.006, 0.012]);
  assert.deepEqual(r.body.moves, [{ from: 'unassigned', to: 'acme', listUSD: 0.012 }]);
  assert.equal(r.body.billing.length, 6);
  assert.equal(s.cost.status().ledger.corrections, 0, 'nothing restated');
  assert.equal(s.cost.versions().versions.length, 1, 'no price version recorded');
  s.st.saved = { centers: 'nope' };
  const invalid = await post({ from: '2026-10-20', to: '2026-10-21' });
  assert.equal(invalid.status, 409);
  assert.match(invalid.body.error, /invalid/);
});

test('restates: newest first, the reasons as written; [] before any', async () => {
  const s = setup({ saved: ACME });
  fs.writeFileSync(s.gatewayLog, line(at(20)));
  s.cost.update();
  assert.deepEqual((await s.call('GET', '/api/cost/restates')).body, { restates: [] });
  const reason = 'Acme <b>moved</b> & "fixed"';
  const done = await s.call('POST', '/api/cost/restate', {
    from: '2026-10-20',
    to: '2026-10-20',
    reason,
    confirm: true,
  });
  assert.equal(done.status, 200);
  const list = (await s.call('GET', '/api/cost/restates')).body.restates;
  assert.deepEqual(
    list.map((c) => [c.reason, c.from, c.to, c.rows, c.priceVersion]),
    [[reason, '2026-10-20', '2026-10-20', 0, 1]], // the rows were attributed with these settings already
  );
  assert.equal((await s.call('POST', '/api/cost/restates', {})).status, 405);
});

test('the new routes: store codes are path-free 503s, any other failure a fixed 500', async () => {
  const where = path.join(HOME, '.data', 'cost', 'ledger-2026-10.jsonl');
  let thrown = null;
  const boom = () => {
    throw thrown;
  };
  const s = setup({ cost: { restatePreview: boom, corrections: boom, ledger: boom } });
  const calls = [
    () => s.call('POST', '/api/cost/restate/preview', { from: '2026-10-20', to: '2026-10-21' }),
    () => s.call('GET', '/api/cost/restates'),
    () => s.call('POST', '/api/cost/settings/preview', { settings: {} }),
  ];
  for (const code of ['LEDGER_MONTH_UNREAD', 'LEDGER_CORRECTIONS_UNREAD', 'BILLING_UNREAD']) {
    thrown = Object.assign(new Error(`not available at ${where}`), { code });
    for (const c of calls) {
      const r = await c();
      assert.equal(r.status, 503, code);
      assert.equal(r.body.code, code);
    }
  }
  thrown = new Error(`boom at ${where}`);
  for (const c of calls) assert.deepEqual(await c(), { status: 500, body: { error: 'cost request failed' } });
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('the demo: previews from the demo ledger and settings, an empty history; all in memory', async () => {
  const now = Date.now();
  const d = costDemo(now);
  const s = setup({ saved: d.settings, demo: d });
  s.st.t = now;
  const { budgets, ...saved } = d.settings;
  const same = await s.call('POST', '/api/cost/settings/preview', { settings: saved });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.moves, []);
  assert.ok(same.body.rules.every((r) => r.status === 'ok'));
  const bare = await s.call('POST', '/api/cost/settings/preview', { settings: { ...saved, folderRules: [] } });
  assert.ok(bare.body.moves.length > 0);
  assert.ok(bare.body.moves.every((m) => m.to === 'unassigned' && m.project));
  assert.ok(bare.body.unassigned.some((u) => u.project === '~/acme-web'));
  const y = addDays(dayOf(now), -1);
  const r = await s.call('POST', '/api/cost/restate/preview', { from: addDays(y, -6), to: y });
  assert.equal(r.status, 200);
  assert.ok(r.body.total > 0);
  assert.deepEqual((await s.call('GET', '/api/cost/restates')).body, { restates: [] });
  assert.equal(budgets.length, 3, 'budgets are saved through their own routes, never sent here');
});

// ---- over HTTP ----

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own: 9200-9399 (no other test uses it; 3a takes 8800-9199).
    const port = 9200 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
async function startServer(env, { data = tmp() } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        CLAUDE_CONFIG_DIR: '',
        ZAAFPULSE_CLAUDE_DIRS: '',
        XDG_CONFIG_HOME: '',
        CODEX_HOME: '',
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
        // An answer could come from another process on the port: trust it only while our child is still up.
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { base, stop };
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
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...(body !== undefined ? JSON_HEADERS : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json };
  };
  return { call, post: (p, body) => call(p, { method: 'POST', body }), bodies };
}

test('over HTTP: the dashboard sign-in only, never a gateway key', async () => {
  const data = tmp();
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const { secret } = gw.keys.create({ name: 'app', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 });
  gw.flush();
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ pricingSync: { enabled: false } }));
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  const y = addDays(dayOf(Date.now()), -1);
  try {
    const bearer = client(s.base, { authorization: `Bearer ${secret}`, 'x-api-key': secret });
    for (const who of [client(s.base), bearer]) {
      assert.equal((await who.call('/api/cost/restates')).status, 401);
      assert.equal((await who.post('/api/cost/settings/preview', { settings: {} })).status, 401);
      assert.equal((await who.post('/api/cost/restate/preview', { from: y, to: y })).status, 401);
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
    assert.deepEqual((await c.call('/api/cost/restates')).json, { restates: [] });
    const p = await c.post('/api/cost/settings/preview', { settings: {} });
    assert.equal(p.status, 200);
    assert.deepEqual(p.json.moves, []);
    const r = await c.post('/api/cost/restate/preview', { from: y, to: y });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, 0);
    assert.deepEqual((await c.call('/api/cost/settings')).json.reasons, []);
    for (const body of [...c.bodies, ...bearer.bodies]) assert.doesNotMatch(body, PATHS);
  } finally {
    await s.stop();
  }
});

test('over HTTP: the demo answers the previews and records a restate in memory, path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const saved = (await c.call('/api/cost/settings')).json;
    assert.deepEqual(saved.reasons, []);
    const p = await c.post('/api/cost/settings/preview', { settings: { ...saved.settings, folderRules: [] } });
    assert.equal(p.status, 200);
    assert.ok(p.json.moves.length > 0);
    const y = addDays(dayOf(Date.now()), -1);
    const from = addDays(y, -6);
    assert.equal((await c.post('/api/cost/restate/preview', { from, to: y })).status, 200);
    assert.deepEqual((await c.call('/api/cost/restates')).json, { restates: [] });
    const done = await c.post('/api/cost/restate', { from, to: y, reason: 'demo check', confirm: true });
    assert.equal(done.status, 200);
    const list = (await c.call('/api/cost/restates')).json.restates;
    assert.deepEqual(
      list.map((x) => [x.reason, x.from, x.to]),
      [['demo check', from, y]],
    );
    for (const body of c.bodies) assert.doesNotMatch(body, PATHS);
  } finally {
    await s.stop();
  }
});
