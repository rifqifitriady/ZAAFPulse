// GET /api/cost/view (Cost Control 3a): in-process on the demo ledger, then a spawned server.js for the demo answers
// and the sign-in. No real provider, no network: pricing sync is off and the gateway has no upstream.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { createBudgetService } = require('../lib/cost/budget-service');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');
const { createGateway } = require('../lib/gateway');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const NOW = new Date(2026, 9, 22, 15).getTime(); // a Thursday afternoon, 70 % into October
const TODAY = dayOf(NOW);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, msg || `${a} is not ${b}`);

function setup({ accuracy, passRates, cost: fake } = {}) {
  const d = costDemo(NOW);
  const cost =
    fake || createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => NOW, nocase: false });
  const budgets = fake
    ? null
    : createBudgetService({
        getSettings: () => d.settings,
        getLegacy: () => ({ monthlyBudgetUSD: 1000, keys: [] }),
        cost,
        home: HOME,
        now: () => NOW,
        nocase: false,
        demo: { noData: d.budgetNoData },
      });
  const seen = [];
  const api = createCostApi({
    cost,
    settings: { get: () => d.settings, save: () => {} },
    home: HOME,
    now: () => NOW,
    budgets,
    accuracy:
      accuracy ||
      ((range) => {
        seen.push(range);
        return { 'claude-opus-5-5': { results: 300, modelFailures: 3, accuracy: 0.99, daily: {} } };
      }),
    passRates: passRates || (() => ({ 'claude-opus-5-5': { pass: 3, total: 4, rate: 0.75 } })),
  });
  const bodies = [];
  const get = async (query) => {
    const r = await api.route({ method: 'GET', path: '/api/cost/view', query: new URLSearchParams(query) });
    bodies.push(JSON.stringify(r.body));
    return r;
  };
  return { get, bodies, seen, d };
}

test('cost view: the Overview of the demo month, with the global monthly budgets as lines', async () => {
  const s = setup();
  const r = await s.get('page=overview&from=garbage');
  assert.equal(r.status, 200, 'Overview ignores from and to');
  const o = r.body;
  assert.deepEqual([o.page, o.from, o.to, o.currency, o.measure], ['overview', '2026-10-01', TODAY, 'USD', 'list']);
  assert.deepEqual(o.unread, []);
  assert.deepEqual(o.billing, { error: null, historyLost: false });
  assert.deepEqual(o.missingRate, []);
  assert.equal(o.month.day, 22);
  assert.equal(o.daily.length, 22);
  assert.ok(o.total > 0 && o.forecast.projected > o.total);
  assert.ok(o.forecast.low <= o.forecast.projected && o.forecast.projected <= o.forecast.high + 1e-9);
  const lines = Object.fromEntries(o.budgetLines.map((l) => [l.id, l.amount]));
  assert.equal(lines['legacy-monthly'], 1000);
  assert.ok(lines.team > 0, 'the IDR budget at the latest rate');
  assert.equal(o.rings[0].id, 'acme-gateway', 'the used-up budget first');
  assert.equal(o.rings[0].tone, 'exceeded');
  const idr = (await s.get('page=overview&currency=IDR')).body;
  assert.equal(idr.currency, 'IDR');
  assert.ok(idr.total > o.total * 16000);
  assert.equal(idr.budgetLines.find((l) => l.id === 'legacy-monthly').amount, 1000 * 16420);
  const paid = (await s.get('page=overview&measure=billed')).body;
  assert.equal(paid.measure, 'billed');
  assert.equal(paid.spent.billed, paid.total);
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('cost view: Breakdown and Value over a range, with the quality readers given the same range', async () => {
  const s = setup();
  const from = addDays(TODAY, -6);
  const b = (await s.get(`page=breakdown&from=${from}&to=${TODAY}`)).body;
  assert.deepEqual([b.from, b.to], [from, TODAY]);
  assert.ok(b.flow.nodes.some((n) => n.id === 'source:claude'));
  assert.ok(b.treemap.length >= 3, 'a block group per center');
  assert.equal(b.calendar.days.length, 7);
  const dflt = (await s.get('page=breakdown')).body;
  assert.deepEqual([dflt.from, dflt.to], [addDays(TODAY, -29), TODAY], 'the last 30 days by default');
  const v = (await s.get(`page=value&from=${from}&to=${TODAY}&measure=billed`)).body;
  assert.equal(v.measure, 'billed');
  assert.deepEqual(s.seen.pop(), { from, to: TODAY });
  assert.equal(v.plans[0].source, 'claude');
  assert.ok(v.plans[0].multiplier > 0);
  const w = v.waterfall;
  near(w.withoutCache - w.cacheSaved - w.planSaved, w.paid);
  assert.ok(w.cacheSaved > 0, 'the demo reads its cache');
  const opus = v.scatter.dots.find((x) => x.model === 'claude-opus-5-5');
  assert.deepEqual([opus.accuracy, opus.passRate.rate], [0.99, 0.75]);
  assert.ok(v.scatter.noToolCalls.some((x) => x.model === 'deepseek-chat'));
  assert.ok(v.local.requests > 0, 'the free local judge');
  assert.equal(v.unit.length, 7);
});

test('cost view: 400 for a bad page, measure, currency or range; quality readers that throw leave the scatter empty', async () => {
  const s = setup({
    accuracy: () => {
      throw new Error(`index unreadable at ${path.join(HOME, '.cache', 'index.json')}`);
    },
    passRates: () => {
      throw new Error('no store');
    },
  });
  for (const [q, why] of [
    ['', /page: overview, breakdown, value/],
    ['page=settings', /page/],
    ['page=overview&measure=both', /measure: list or billed/],
    ['page=breakdown&currency=EUR', /no rates for that currency/],
    ['page=value&from=2026-10-40', /dates/],
    ['page=value&from=2026-10-20&to=2026-10-01', /on or before/],
    ['page=breakdown&from=2025-01-01&to=2026-10-22', /at most 400 days/],
  ]) {
    const r = await s.get(q);
    assert.equal(r.status, 400, q);
    assert.match(r.body.error, why, q);
  }
  const v = await s.get('page=value');
  assert.equal(v.status, 200);
  assert.deepEqual(v.body.scatter.dots, []);
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('cost view: a ledger that is not available is a path-free 503 with its code', async () => {
  const where = path.join(HOME, '.data', 'cost', 'ledger-2026-10.jsonl');
  const fake = {
    budgetRows: () => {
      throw Object.assign(new Error(`not available at ${where}`), { code: 'LEDGER_MONTH_UNREAD' });
    },
  };
  const s = setup({ cost: fake });
  for (const page of ['overview', 'breakdown', 'value']) {
    const r = await s.get(`page=${page}`);
    assert.equal(r.status, 503, page);
    assert.equal(r.body.code, 'LEDGER_MONTH_UNREAD');
    assert.doesNotMatch(JSON.stringify(r.body), PATHS);
  }
});

// ---- over HTTP ----

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-view-'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own: no other test uses 8800-9199.
    const port = 8800 + Math.floor(Math.random() * 400);
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
  const call = async (p) => {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(10000), headers });
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
  return { call, bodies };
}

test('cost view over HTTP: every demo page answers, Value with a scatter from the demo signals, path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const o = await c.call('/api/cost/view?page=overview');
    assert.equal(o.status, 200);
    assert.ok(o.json.rings.length > 0);
    assert.ok(o.json.budgetLines.some((l) => l.id === 'legacy-monthly'));
    const b = await c.call('/api/cost/view?page=breakdown&measure=billed&currency=IDR');
    assert.equal(b.status, 200);
    assert.ok(
      b.json.flow.links.some((l) => l.target === 'provider:__plan'),
      'the Claude plan fee',
    );
    const v = await c.call('/api/cost/view?page=value');
    assert.equal(v.status, 200);
    const models = v.json.scatter.dots.map((d) => d.model);
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']) assert.ok(models.includes(m), m);
    for (const body of c.bodies) assert.doesNotMatch(body, PATHS);
  } finally {
    await s.stop();
  }
});

test('cost view over HTTP: the dashboard sign-in only, never a gateway key', async () => {
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
  try {
    const bearer = client(s.base, { authorization: `Bearer ${secret}`, 'x-api-key': secret });
    for (const who of [client(s.base), bearer])
      for (const page of ['overview', 'breakdown', 'value'])
        assert.equal((await who.call(`/api/cost/view?page=${page}`)).status, 401, page);
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
    const r = await c.call('/api/cost/view?page=value');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.scatter, { dots: [], noToolCalls: [] }, 'an empty ledger');
    assert.equal((await c.call('/api/cost/view?page=nope')).status, 400);
    for (const body of [...c.bodies, ...bearer.bodies]) assert.doesNotMatch(body, PATHS);
  } finally {
    await s.stop();
  }
});
