// test/cost-api.test.js (in-process part; Task 9 appends the spawned-server part)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-api-'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);
// One gateway line: a Sonnet call of 1,000 in and 100 out (0.003 at PRICE_A).
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

function setup({ saved, saveThrows = false, demo = null, dir = tmp() } = {}) {
  const st = { saved, t: at(22) };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost = createCost({
    dir: demo ? null : path.join(dir, 'cost'),
    gatewayLog: demo ? null : gatewayLog,
    getPricing: () => PRICE_A,
    getSettings: () => st.saved,
    home: HOME,
    now: () => st.t,
    nocase: false,
    demo,
  });
  const api = createCostApi({
    cost,
    settings: {
      get: () => st.saved,
      save: (v) => {
        if (saveThrows)
          throw Object.assign(new Error(`could not write ${path.join(HOME, 'zp', 'config.json')}`), { status: 500 });
        st.saved = v;
      },
    },
    listKeys: () => [{ id: 'key_a', name: 'Acme app', hash: 'never-shown' }],
    home: HOME,
    now: () => st.t,
  });
  const bodies = [];
  const call = async (method, p, { query = '', body, type = 'application/json', readBody } = {}) => {
    const res = await api.route({
      method,
      path: p,
      query: new URLSearchParams(query),
      contentType: type,
      readBody:
        readBody || (async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body))),
    });
    if (res) bodies.push(JSON.stringify(res.body));
    return res;
  };
  return { st, cost, call, bodies, gatewayLog, dir };
}

// A file the process cannot read: no read permission where that holds (not on Windows, not as root), else a folder
// in its place. `restore` puts the readable file back, so the temp folder can be cleaned up.
function makeUnreadable(f) {
  const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  if (byMode) fs.chmodSync(f, 0o000);
  else {
    fs.rmSync(f, { force: true });
    fs.mkdirSync(f);
  }
  return {
    restore() {
      if (byMode) fs.chmodSync(f, 0o600);
      else {
        fs.rmSync(f, { recursive: true });
        fs.writeFileSync(f, text);
      }
    },
  };
}

test('cost api: route() answers only its own paths; unknown is 404, a wrong method 405', async () => {
  const s = setup();
  assert.equal(await s.call('GET', '/api/costs'), null);
  assert.equal(await s.call('GET', '/api/monitors'), null);
  assert.equal((await s.call('GET', '/api/cost/nope')).status, 404);
  assert.equal((await s.call('POST', '/api/cost/status', { body: {} })).status, 405);
  assert.equal((await s.call('GET', '/api/cost/restate')).status, 405);
});

test('cost api: the ledger checks its query and converts with the configured currency', async () => {
  const s = setup({
    saved: {
      currency: {
        code: 'IDR',
        rates: [
          { from: '2026-10-01', perUSD: 16000 },
          { from: '2026-10-22', perUSD: 16500 },
        ],
      },
    },
  });
  fs.writeFileSync(s.gatewayLog, line(at(22)));
  s.cost.update();
  for (const [query, why] of [
    ['from=2026-10-40', /dates/],
    ['from=2026-10-22&to=2026-10-01', /on or before/],
    ['from=2025-01-01&to=2026-10-22', /at most 400 days/],
    ['groupBy=day,nope', /unknown dimension nope/],
    ['groupBy=day,day', /named twice/],
    ['groupBy=day,source,model,kind,agent', /1 to 4/],
    ['currency=EUR', /no rates for that currency/],
  ]) {
    const r = await s.call('GET', '/api/cost/ledger', { query });
    assert.equal(r.status, 400, query);
    assert.match(r.body.error, why, query);
  }
  const plain = await s.call('GET', '/api/cost/ledger');
  assert.equal(plain.status, 200);
  assert.deepEqual(
    [plain.body.from, plain.body.to, plain.body.groupBy, plain.body.currency],
    ['2026-10-01', '2026-10-22', ['day'], 'USD'],
  );
  assert.equal('list' in plain.body.rows[0], false);
  assert.deepEqual(plain.body.unread, []);
  assert.deepEqual(plain.body.billing, { error: null, historyLost: false });
  const idr = await s.call('GET', '/api/cost/ledger', { query: 'currency=IDR&groupBy=day,keyId' });
  assert.equal(idr.status, 200);
  near(idr.body.rows[0].listUSD, 0.003);
  near(idr.body.rows[0].list, 49.5); // 0.003 × 16,500, the rate in force on the 22nd
  assert.equal(idr.body.missingRate, 0);
});

test('cost api: settings are read with defaults, validated on save (415, 400 with reasons), and stored normalized', async () => {
  const s = setup();
  const got = await s.call('GET', '/api/cost/settings');
  assert.deepEqual(got.body.settings, { centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null });
  assert.deepEqual(got.body.keys, [{ id: 'key_a', name: 'Acme app' }]);
  assert.equal(got.body.unassigned, 'unassigned');
  assert.equal((await s.call('POST', '/api/cost/settings', { body: {}, type: 'text/plain' })).status, 415);
  assert.equal((await s.call('POST', '/api/cost/settings', { body: '[1]' })).status, 400);
  const bad = await s.call('POST', '/api/cost/settings', {
    body: {
      centers: [{ id: 'acme', name: 'Acme' }],
      keyCenters: { key_a: 'nope' },
      folderRules: [{ glob: 'work/**', center: 'acme' }],
      currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 0 }] },
    },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid cost settings');
  for (const want of [
    'keyCenters.key_a: unknown cost center',
    'folderRules[0].glob: starts with ~, /, * or a drive letter like C:/',
    'currency.rates[0].perUSD: a number above 0',
  ])
    assert.ok(bad.body.reasons.includes(want), want);
  const ok = await s.call('POST', '/api/cost/settings', {
    body: { centers: [{ id: 'acme', name: 'Acme' }], folderRules: [{ glob: `${HOME}/work/**`, center: 'acme' }] },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.st.saved.folderRules, [{ glob: '~/work/**', center: 'acme' }]);
  const failing = setup({ saveThrows: true });
  const r = await failing.call('POST', '/api/cost/settings', { body: {} });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /\[path\]/);
  for (const b of [...s.bodies, ...failing.bodies]) assert.doesNotMatch(b, PATHS);
});

test('cost api: a state change needs JSON and a readable body', async () => {
  const s = setup();
  for (const p of ['/api/cost/settings', '/api/cost/restate']) {
    assert.equal((await s.call('POST', p, { body: {}, type: 'application/x-www-form-urlencoded' })).status, 415, p);
    assert.equal((await s.call('POST', p, { body: {}, type: '' })).status, 415, p);
    assert.equal((await s.call('POST', p, { body: '{not json' })).status, 400, p);
    const big = await s.call('POST', p, {
      readBody: async () => {
        throw new Error('too large');
      },
    });
    assert.equal(big.status, 413, p);
  }
});

test('cost api: restate needs confirm, a reason and a past range; versions and status answer', async () => {
  const s = setup();
  s.cost.update();
  const body = { from: '2026-10-20', to: '2026-10-21', reason: 'check', confirm: true };
  assert.match(
    (await s.call('POST', '/api/cost/restate', { body: { ...body, confirm: undefined } })).body.error,
    /confirm: true/,
  );
  assert.match(
    (await s.call('POST', '/api/cost/restate', { body: { ...body, confirm: 'yes' } })).body.error,
    /confirm: true/,
  );
  assert.match((await s.call('POST', '/api/cost/restate', { body: { ...body, reason: ' ' } })).body.error, /reason/);
  assert.match(
    (await s.call('POST', '/api/cost/restate', { body: { ...body, extra: 1 } })).body.error,
    /unknown field: extra/,
  );
  const todayToo = await s.call('POST', '/api/cost/restate', { body: { ...body, to: '2026-10-22' } });
  assert.equal(todayToo.status, 400);
  assert.match(todayToo.body.error, /up to yesterday/);
  assert.equal(s.cost.status().ledger.corrections, 0, 'nothing was restated by a refused request');
  const ok = await s.call('POST', '/api/cost/restate', { body });
  assert.equal(ok.status, 200);
  // `billing` is each source's billing as restated (Task 7), written as one override per source.
  assert.deepEqual(Object.keys(ok.body.correction).sort(), [
    'billing',
    'from',
    'priceVersion',
    'reason',
    'rows',
    'to',
    'ts',
  ]);
  assert.equal(ok.body.overrides.length, 6);
  assert.ok(ok.body.overrides.every((o) => o.from === body.from && o.to === body.to && o.billing.mode === 'metered'));
  const v = await s.call('GET', '/api/cost/prices/versions');
  assert.equal(v.body.current, 1);
  const st = await s.call('GET', '/api/cost/status');
  assert.equal(st.body.demo, false);
  assert.equal(st.body.ledger.corrections, 1);
});

test('cost api: a restate while the saved settings are invalid is refused with 409', async () => {
  const s = setup({ saved: { centers: 'not a list' } });
  s.cost.update();
  const r = await s.call('POST', '/api/cost/restate', {
    body: { from: '2026-10-20', to: '2026-10-21', reason: 'check', confirm: true },
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /saved cost settings are invalid/);
  assert.equal(s.cost.status().ledger.corrections, 0);
});

test('cost api: status shows each collector (since, error, skipped local clients), price problems, billing and unread', async () => {
  const s = setup();
  // A Claude Code line from this machine: the local collector counts it from its own log, so the gateway skips it.
  const mine = JSON.parse(line(at(22)));
  fs.writeFileSync(s.gatewayLog, line(at(22)) + JSON.stringify({ ...mine, client: 'claude-code', local: true }) + '\n');
  s.cost.update();
  const st = (await s.call('GET', '/api/cost/status')).body;
  for (const k of ['local', 'gateway', 'judge']) {
    const c = st.collectors[k];
    assert.equal(c.since, at(22), k);
    assert.equal(c.error, null, k);
    assert.equal(c.skippedLocalClients, k === 'gateway' ? 1 : 0, k);
  }
  assert.equal(st.collectors.gateway.read, 1);
  assert.deepEqual(st.prices.problems, []);
  assert.deepEqual(st.ledger.unread, []);
  assert.deepEqual(st.billing, { error: null, historyLost: false, problems: [] });
});

test('cost api: an unreadable month is named in the ledger and the status, and a restate over it is a 503', async () => {
  const dir = tmp();
  const first = setup({ dir });
  fs.writeFileSync(first.gatewayLog, line(new Date(2026, 8, 30, 12).getTime()) + line(at(21)));
  first.cost.update();
  const oct = path.join(dir, 'cost', 'ledger-2026-10.jsonl');
  assert.ok(fs.existsSync(oct));
  const u = makeUnreadable(oct);
  try {
    const s = setup({ dir }); // a restart: October does not read
    const led = await s.call('GET', '/api/cost/ledger', { query: 'from=2026-09-01&to=2026-10-21' });
    assert.equal(led.status, 200);
    assert.deepEqual(led.body.unread, ['2026-10']);
    assert.deepEqual(
      led.body.rows.map((r) => r.day),
      ['2026-09-30'],
    );
    const st = (await s.call('GET', '/api/cost/status')).body;
    assert.deepEqual(st.ledger.unread, ['2026-10']);
    const r = await s.call('POST', '/api/cost/restate', {
      body: { from: '2026-10-20', to: '2026-10-21', reason: 'check', confirm: true },
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'LEDGER_MONTH_UNREAD');
    assert.match(r.body.error, /ledger month 2026-10 could not be read/);
    for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
  } finally {
    u.restore();
  }
});

test('cost api: a restate while the billing history does not read is a 503', async () => {
  const dir = tmp();
  const first = setup({ dir });
  first.cost.update();
  const bill = path.join(dir, 'cost', 'billing.json');
  assert.ok(fs.existsSync(bill));
  const u = makeUnreadable(bill);
  try {
    const s = setup({ dir });
    const st = (await s.call('GET', '/api/cost/status')).body;
    assert.match(st.billing.error, /billing history could not be read/);
    const r = await s.call('POST', '/api/cost/restate', {
      body: { from: '2026-10-20', to: '2026-10-21', reason: 'check', confirm: true },
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'BILLING_UNREAD');
    for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
  } finally {
    u.restore();
  }
});

test('cost api: every store and billing code is a path-free 503; any other failure a fixed 500', async () => {
  const where = path.join(HOME, '.data', 'cost', 'ledger-2026-10.jsonl');
  let thrown = null;
  const fake = {
    restate: () => {
      throw thrown;
    },
    status: () => {
      throw new Error(`EACCES: permission denied, open '${where}'`);
    },
  };
  const api = createCostApi({
    cost: fake,
    settings: { get: () => undefined, save: () => {} },
    home: HOME,
    now: () => at(22),
  });
  const restate = () =>
    api.route({
      method: 'POST',
      path: '/api/cost/restate',
      query: new URLSearchParams(),
      contentType: 'application/json',
      readBody: async () => JSON.stringify({ from: '2026-10-20', to: '2026-10-21', reason: 'x', confirm: true }),
    });
  for (const code of ['LEDGER_MONTH_UNREAD', 'LEDGER_CORRECTIONS_UNREAD', 'BILLING_UNREAD', 'BILLING_NOT_READY']) {
    thrown = Object.assign(new Error(`not available at ${where}`), { code });
    const r = await restate();
    assert.equal(r.status, 503, code);
    assert.equal(r.body.code, code);
    assert.doesNotMatch(JSON.stringify(r.body), PATHS, code);
  }
  thrown = new Error(`boom at ${where}`);
  const r = await restate();
  assert.deepEqual(r, { status: 500, body: { error: 'cost request failed' } });
  const st = await api.route({ method: 'GET', path: '/api/cost/status', query: new URLSearchParams() });
  assert.deepEqual(st, { status: 500, body: { error: 'cost request failed' } });
});

test('cost api: the ledger names a non-enumerable unread list, and the status never carries a path', async () => {
  const where = path.join(HOME, '.data', 'cost', 'ledger-2026-10.jsonl');
  const fake = {
    ledger: (q) => Object.defineProperty({ ...q, rows: [], totals: {} }, 'unread', { value: ['2026-10'] }),
    status: () => ({ collectors: { local: { error: `could not open ${where}` } }, prices: { problems: [where] } }),
  };
  const api = createCostApi({
    cost: fake,
    settings: { get: () => undefined, save: () => {} },
    home: HOME,
    now: () => at(22),
  });
  const get = (p, q = '') => api.route({ method: 'GET', path: p, query: new URLSearchParams(q) });
  const led = await get('/api/cost/ledger', 'from=2026-10-01&to=2026-10-21');
  assert.deepEqual(JSON.parse(JSON.stringify(led.body)).unread, ['2026-10']);
  const st = await get('/api/cost/status');
  assert.doesNotMatch(JSON.stringify(st.body), PATHS);
  assert.match(st.body.collectors.local.error, /could not open/);
});

test('cost demo: three centers, Claude Code on a plan, an IDR rate, two price versions; all in memory', async () => {
  const now = Date.now();
  const d = costDemo(now);
  assert.deepEqual(
    d.settings.centers.map((c) => c.id),
    ['platform', 'client-acme', 'research'],
  );
  assert.equal(d.settings.billing.claude.mode, 'plan');
  assert.equal(d.settings.currency.code, 'IDR');
  assert.ok(
    d.rows.every((r) => r.kind !== 'plan'),
    'billing is derived when the ledger is read: no stored plan rows',
  );
  assert.deepEqual(
    d.billing.map((b) => [b.source, b.billing.mode]),
    [['claude', 'plan']],
  );
  const s = setup({ saved: d.settings, demo: d });
  s.st.t = now;
  const from = addDays(dayOf(now), -29);
  const led = await s.call('GET', '/api/cost/ledger', { query: `from=${from}&groupBy=center&currency=IDR` });
  assert.equal(led.status, 200);
  const centers = led.body.rows.map((x) => x.center);
  for (const c of ['client-acme', 'platform', 'research', 'unassigned', null])
    assert.ok(centers.includes(c), String(c));
  assert.ok(led.body.totals.list > led.body.totals.listUSD * 16000);
  // The plan rows are synthesized from the billing history: one a day, with the day's share of the fee.
  const plans = (await s.call('GET', '/api/cost/ledger', { query: `from=${from}&groupBy=day,kind` })).body.rows.filter(
    (x) => x.kind === 'plan',
  );
  assert.equal(plans.length, 30);
  assert.ok(plans.every((x) => x.billedUSD > 0 && x.listUSD === 0));
  const bySource = (await s.call('GET', '/api/cost/ledger', { query: `from=${from}&groupBy=source,kind` })).body.rows;
  const claudeUsage = bySource.filter((x) => x.source === 'claude' && x.kind !== 'plan');
  assert.ok(
    claudeUsage.length && claudeUsage.every((x) => x.billedUSD === 0 && x.listUSD > 0),
    'on the plan: billed 0',
  );
  const st = (await s.call('GET', '/api/cost/status')).body;
  assert.equal(st.demo, true);
  assert.ok(st.unpriced.rows > 0, 'the demo shows an unpriced model');
  assert.ok(st.backfill.rows > 0);
  const v = (await s.call('GET', '/api/cost/prices/versions')).body;
  assert.deepEqual(
    v.versions.map((x) => x.changed),
    [[], ['claude-sonnet-5-5']],
  );
  const r = await s.call('POST', '/api/cost/restate', {
    body: { from, to: addDays(dayOf(now), -1), reason: 'demo', confirm: true },
  });
  assert.equal(r.status, 200);
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

// ---- spawned server.js ----
const net = require('net');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own (trace 5100-5899, evals 5900-6399, datasets/monitors 6400-6899, topology 6900-7299,
    // monitors engine and OTLP 7000-7799).
    const port = 8000 + Math.floor(Math.random() * 400);
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
        // The logs read are the ones under the test's HOME only, never this machine's.
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
  const call = async (p, { method = 'GET', body, extra = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...extra },
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
    return { status: r.status, json, text };
  };
  return { call, post: (p, body) => call(p, { method: 'POST', body, extra: JSON_HEADERS }), bodies };
}
// The ledger pass runs after the first index refresh: wait until the named collector has read.
async function passed(c, collector) {
  let st = null;
  for (let i = 0; i < 60; i++) {
    st = (await c.call('/api/cost/status')).json;
    if (st && st.collectors && st.collectors[collector].at) return st;
    await new Promise((r) => setTimeout(r, 200));
  }
  return st;
}

test('cost api over HTTP: the demo ledger, path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const from = addDays(dayOf(Date.now()), -29);
    const led = await c.call(`/api/cost/ledger?from=${from}&groupBy=center&currency=IDR`);
    assert.equal(led.status, 200);
    const centers = led.json.rows.map((x) => x.center);
    for (const id of ['client-acme', 'platform', 'research', 'unassigned']) assert.ok(centers.includes(id), id);
    assert.ok(led.json.totals.list > 0);
    assert.equal((await c.call('/api/cost/status')).json.demo, true);
    assert.equal((await c.call('/api/cost/prices/versions')).json.versions.length >= 2, true);
    assert.equal((await c.call('/api/cost/settings')).json.settings.billing.claude.mode, 'plan');
    assert.equal((await c.call('/api/cost/settings', { method: 'POST', body: {} })).status, 415);
    assert.equal((await c.post('/api/cost/restate', { from, to: from, reason: 'x' })).status, 400);
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
  } finally {
    await s.stop();
  }
});

test('cost api over HTTP: a gateway key is not a sign-in; the ledger fills from the gateway log into private files', async () => {
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
  const { key, secret } = gw.keys.create({ name: 'acme app', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 });
  gw.flush();
  const now = Date.now();
  const yesterday = now - 86400e3;
  const gwLine = (ts) =>
    JSON.stringify({
      ts,
      keyId: key.id,
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-5.5',
      kind: 'chat',
      status: 200,
      input: 1000,
      output: 100,
      cached: 0,
    }) + '\n';
  fs.writeFileSync(path.join(data, '.data', 'gateway-usage.jsonl'), gwLine(yesterday) + gwLine(now), { mode: 0o600 });
  // pricingSync off: the spawned server never fetches the live price list.
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      pricingSync: { enabled: false },
      cost: { centers: [{ id: 'acme', name: 'Acme' }], keyCenters: { [key.id]: 'acme' } },
    }),
  );
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  try {
    const bearer = client(s.base, { authorization: `Bearer ${secret}`, 'x-api-key': secret });
    for (const who of [client(s.base), bearer]) {
      for (const p of ['/api/cost/ledger', '/api/cost/status', '/api/cost/settings', '/api/cost/prices/versions'])
        assert.equal((await who.call(p)).status, 401, p);
      for (const p of ['/api/cost/settings', '/api/cost/restate']) assert.equal((await who.post(p, {})).status, 401, p);
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
    const st = await passed(c, 'gateway');
    assert.ok(st.collectors.gateway.at, 'the ledger pass ran after the first index refresh');
    const today = dayOf(now);
    const yday = dayOf(yesterday);
    const led = await c.call(`/api/cost/ledger?from=${yday}&to=${today}&groupBy=day,center,keyId`);
    assert.equal(led.status, 200);
    assert.deepEqual(
      led.json.rows.map((x) => [x.day, x.center, x.keyId, x.backfilled]),
      [
        [yday, 'acme', key.id, true],
        [today, 'acme', key.id, false],
      ],
    );
    for (const x of led.json.rows) near(x.listUSD, 0.003);
    const badGlob = { folderRules: [{ glob: 'relative/**', center: 'acme' }] };
    assert.equal((await c.post('/api/cost/settings', badGlob)).status, 400);
    const restate = { from: yday, to: yday, reason: 'check', confirm: true };
    assert.equal((await c.call('/api/cost/restate', { method: 'POST', body: restate })).status, 415);
    assert.equal((await c.post('/api/cost/restate', restate)).status, 200);
    const dir = path.join(data, '.data', 'cost');
    const files = [
      `ledger-${today.slice(0, 7)}.jsonl`,
      'cursors.json',
      'corrections.jsonl',
      'billing.json',
      path.join('prices', 'versions.json'),
      path.join('prices', '1.json'),
    ];
    for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), f);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, 'prices')).mode & 0o777, 0o700);
      for (const f of files) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
    }
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS);
  } finally {
    await s.stop();
  }
});

test('cost api over HTTP: Claude Code logs fill the ledger after the first refresh; home is ~, other folders in full', async () => {
  const data = tmp();
  const now = Date.now();
  const inHome = path.join(data, 'work', 'acme', 'web');
  const outside = process.platform === 'win32' ? 'D:\\srv\\app' : '/srv/app';
  // One Claude Code session per folder, one answered request each (1,000 in, 100 out: 0.003 at the built-in prices).
  const session = (sid, cwd, i) =>
    [
      {
        type: 'user',
        sessionId: sid,
        uuid: `u-${i}`,
        timestamp: new Date(now - 60e3).toISOString(),
        cwd,
        message: { role: 'user', content: 'hi' },
      },
      {
        type: 'assistant',
        sessionId: sid,
        timestamp: new Date(now - 50e3).toISOString(),
        requestId: `req_${i}`,
        cwd,
        message: {
          id: `msg_${i}`,
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: 'Done.' }],
          usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0 },
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n';
  for (const [sid, cwd, i] of [
    ['c0ffee00-0000-4000-8000-000000000001', inHome, 1],
    ['c0ffee00-0000-4000-8000-000000000002', outside, 2],
  ]) {
    const folder = path.join(data, '.claude', 'projects', `-p${i}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${sid}.jsonl`), session(sid, cwd, i));
  }
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      pricingSync: { enabled: false },
      cost: { centers: [{ id: 'acme', name: 'Acme' }], folderRules: [{ glob: '~/work/acme/**', center: 'acme' }] },
    }),
  );
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const st = await passed(c, 'local');
    assert.ok(st.collectors.local.at, 'the ledger pass ran after the first index refresh');
    assert.equal(st.collectors.local.error, null);
    const led = await c.call(`/api/cost/ledger?from=${dayOf(now)}&groupBy=source,project,center`);
    assert.equal(led.status, 200);
    assert.deepEqual(
      led.json.rows.map((x) => [x.source, x.project, x.center, x.requests]).sort(),
      [
        ['claude', process.platform === 'win32' ? 'D:/srv/app' : '/srv/app', 'unassigned', 1],
        ['claude', '~/work/acme/web', 'acme', 1],
      ],
    );
    for (const x of led.json.rows) near(x.listUSD, 0.003);
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS);
  } finally {
    await s.stop();
  }
});

test('cost api over HTTP: a config.json that does not parse is an error, not empty settings; once fixed all is normal', async () => {
  const data = tmp();
  const now = Date.now();
  const today = dayOf(now);
  const yday = addDays(today, -1);
  const gwAt = (ts) =>
    JSON.stringify({
      ts,
      keyId: 'key_a',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-5.5',
      kind: 'chat',
      status: 200,
      input: 1000,
      output: 100,
      cached: 0,
    }) + '\n';
  const log = path.join(data, '.data', 'gateway-usage.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, gwAt(now), { mode: 0o600 });
  const config = path.join(data, 'config.json');
  const good = JSON.stringify({
    pricingSync: { enabled: false },
    cost: {
      centers: [{ id: 'acme', name: 'Acme' }],
      keyCenters: { key_a: 'acme' },
      billing: { gateway: { mode: 'plan', plan: 'Team', feeUSD: 31, period: 'month' } },
    },
  });
  fs.writeFileSync(config, good);
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  const today_ = async () =>
    (await c.call(`/api/cost/ledger?from=${today}&to=${today}&groupBy=source,kind,center`)).json.rows
      .map((x) => [x.source, x.kind, x.center])
      .sort();
  const want = [
    ['gateway', 'chat', 'acme'],
    ['gateway', 'plan', null],
  ];
  const rescan = () => c.post('/api/rescan', {});
  try {
    assert.equal((await passed(c, 'gateway')).collectors.gateway.error, null);
    assert.deepEqual(await today_(), want);

    fs.writeFileSync(config, good.slice(0, 40)); // a hand edit cut short
    const broken = /^config\.json could not be read/;
    assert.match((await c.call('/api/cost/status')).json.settings.error, broken);
    assert.match((await c.call('/api/cost/settings')).json.error, broken);
    const restate = { from: yday, to: yday, reason: 'check', confirm: true };
    const refused = await c.post('/api/cost/restate', restate);
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, broken);
    assert.equal((await rescan()).status, 202);
    await new Promise((r) => setTimeout(r, 2000)); // the pass after the refresh, which waits
    assert.deepEqual(await today_(), want, 'the gateway stays on its plan and its row in its center');

    fs.writeFileSync(config, good);
    fs.appendFileSync(log, gwAt(Date.now()));
    assert.equal((await c.call('/api/cost/status')).json.settings.error, null);
    await rescan();
    let rows = [];
    for (let i = 0; i < 60; i++) {
      rows = (await c.call(`/api/cost/ledger?from=${today}&to=${today}&groupBy=source,kind`)).json.rows;
      if (rows.some((x) => x.kind === 'chat' && x.requests === 2)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(rows.find((x) => x.kind === 'chat').requests, 2);
    assert.deepEqual(await today_(), want);
    assert.equal((await c.post('/api/cost/restate', restate)).status, 200);
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS);
  } finally {
    await s.stop();
  }
});

// A Windows home folder: after it becomes ~, the rest of the path uses backslashes and must still be hidden.
test('cost api: a Windows-style path in an error is hidden after the home folder becomes ~', async () => {
  const s = setup();
  const winHome = 'C:\\Users\\alex';
  const api = createCostApi({
    cost: s.cost,
    settings: {
      get: () => s.st.saved,
      save: () => {
        throw Object.assign(new Error(`could not write ${winHome}\\zp\\config.json`), { status: 500 });
      },
    },
    home: winHome,
    now: () => s.st.t,
  });
  const r = await api.route({
    method: 'POST',
    path: '/api/cost/settings',
    query: new URLSearchParams(''),
    contentType: 'application/json',
    readBody: async () => '{}',
  });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /\[path\]/);
  assert.doesNotMatch(r.body.error, /zp|config\.json|\\/);
});
