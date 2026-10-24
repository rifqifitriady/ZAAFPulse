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
