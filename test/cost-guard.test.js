// test/cost-guard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createGuard } = require('../lib/cost/guard');
const { createBudgetService } = require('../lib/cost/budget-service');
const { createCost } = require('../lib/cost');
const { createGateway } = require('../lib/gateway');
const { fakeServer, secretsFor } = require('./helpers');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (m, d, h = 12) => new Date(2026, m - 1, d, h).getTime();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} is not ${b}`);
const blk = (id, scope, over = {}) => ({
  id,
  name: id.toUpperCase(),
  scope,
  period: 'month',
  amount: 1,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'block',
  legacy: null,
  ...over,
});
function fake(budgets, views = {}) {
  const reports = [];
  const service = {
    list: () => {
      if (budgets instanceof Error) throw budgets;
      return { budgets };
    },
    evaluateOne: (b) => {
      const v = views[b.id];
      if (v instanceof Error) throw v;
      return { state: 'ok', reason: null, ...v };
    },
    keyCenter: (k) => (k === 'key_a' ? 'acme' : 'unassigned'),
    reportGuard: (m) => reports.push(m),
  };
  return { reports, guard: createGuard({ service }) };
}

test('guard: which blocking budgets a call meets; dashboard calls meet only global, model and provider', () => {
  const all = [
    blk('glob', 'global'),
    blk('key', { dim: 'key', value: 'key_a' }),
    blk('center', { dim: 'center', value: 'acme' }),
    blk('model', { dim: 'model', value: 'claude-sonnet-5-5' }),
    blk('prov', { dim: 'provider', value: 'groq' }),
    blk('gw', { dim: 'source', value: 'gateway' }),
  ];
  const hit = (id, ctx) => {
    const r = fake(all, { [id]: { state: 'exceeded' } }).guard.check(ctx);
    return r && r.budget;
  };
  const key = { keyId: 'key_a', model: 'fake/x', provider: 'openrouter' };
  const dash = { keyId: 'dashboard', model: 'fake/x', provider: 'openrouter' };
  assert.equal(hit('glob', key), 'glob');
  assert.equal(hit('glob', dash), 'glob');
  assert.equal(hit('key', key), 'key');
  assert.equal(hit('key', { ...key, keyId: 'key_b' }), null);
  assert.equal(hit('key', dash), null);
  assert.equal(hit('center', key), 'center', 'through the key center');
  assert.equal(hit('center', { ...key, keyId: 'key_b' }), null);
  assert.equal(hit('center', dash), null);
  assert.equal(hit('model', { ...key, model: 'anthropic/claude-sonnet-5.5' }), 'model', 'normalized like the ledger');
  assert.equal(hit('model', { ...dash, model: 'anthropic/claude-sonnet-5.5' }), 'model');
  assert.equal(hit('prov', { ...dash, provider: 'groq' }), 'prov');
  assert.equal(hit('prov', key), null);
  assert.equal(hit('gw', key), 'gw');
  assert.equal(hit('gw', { ...key, runId: 'r1' }), null, 'a collaboration run is source collab');
  assert.equal(hit('gw', { ...key, agent: 'replay' }), null);
  assert.equal(hit('gw', { ...key, agent: 'judge' }), null);
  assert.equal(hit('gw', dash), null);
});

test('guard: the refusal names only its budget and period; warnings, notify-only and pause never block', () => {
  const one = fake([blk('team', 'global', { name: 'Team', period: 'day' })], { team: { state: 'exceeded' } });
  assert.deepEqual(one.guard.check({ keyId: 'key_a' }), {
    budget: 'team',
    message: 'budget "Team" is used up for this day',
  });
  assert.equal(fake([blk('a', 'global')], { a: { state: 'warn_80' } }).guard.check({ keyId: 'key_a' }), null);
  assert.equal(fake([blk('a', 'global', { enforce: 'none' })], { a: { state: 'exceeded' } }).guard.check({}), null);
  assert.equal(fake([blk('a', 'global', { enforce: 'pause' })], { a: { state: 'exceeded' } }).guard.check({}), null);
  const both = fake([blk('first', 'global'), blk('second', 'global')], {
    first: { state: 'ok' },
    second: { state: 'exceeded' },
  });
  assert.equal(both.guard.check({}).budget, 'second', 'the first exhausted one in scope');
});

test('guard: allows when spent cannot be computed, and says why', () => {
  const nd = fake([blk('a', 'global', { name: 'Team' })], {
    a: { state: 'no_data', reason: 'the ledger could not read 2026-10' },
  });
  assert.equal(nd.guard.check({ keyId: 'key_a' }), null);
  assert.match(
    nd.reports.at(-1),
    /budget "Team" has no data \(the ledger could not read 2026-10\), so its requests are allowed/,
  );
  const thrown = fake([blk('a', 'global')], { a: new Error('EIO') });
  assert.equal(thrown.guard.check({}), null);
  assert.match(thrown.reports.at(-1), /could not be checked/);
  const unreadable = fake(new Error('boom'));
  assert.equal(unreadable.guard.check({}), null);
  assert.match(unreadable.reports.at(-1), /budgets could not be read/);
  const clean = fake([blk('a', 'global')]);
  clean.guard.check({});
  assert.equal(clean.reports.at(-1), null, 'a clean check clears the report');
  // With the real service: a ledger month that did not read lets even an exhausted key through.
  const broken = {
    budgetRows: () => ({ rows: [], unread: ['2026-10'], billingError: null }),
    priceGatewayLine: () => null,
    gatewayPasses: () => 0,
  };
  const svc = createBudgetService({
    getSettings: () => undefined,
    getLegacy: () => ({ keys: [{ id: 'key_a', name: 'App', budgetUSD: 0 }] }),
    cost: broken,
    now: () => at(10, 22),
  });
  assert.equal(createGuard({ service: svc }).check({ keyId: 'key_a' }), null);
  assert.match(svc.status().guard, /could not read 2026-10/);
  assert.deepEqual(svc.status().guardProblems.map((p) => p.budget), ['legacy-key-key_a']);
});

// A service whose list, views and clock the test changes between checks.
function live() {
  const st = { budgets: [], views: {}, t: 1000, reports: [], lists: [] };
  const service = {
    list: () => {
      if (st.budgets instanceof Error) throw st.budgets;
      return { budgets: st.budgets };
    },
    evaluateOne: (b) => {
      const v = st.views[b.id];
      if (v instanceof Error) throw v;
      return { state: 'ok', reason: null, ...v };
    },
    keyCenter: () => 'unassigned',
    reportGuard: (m, list) => {
      st.reports.push(m);
      st.lists.push(list);
    },
  };
  st.guard = createGuard({ service, now: () => st.t });
  st.listed = () => st.lists.at(-1).map((p) => [p.budget, p.since]);
  return st;
}

test('guard: a budget failing open stays in the status until that budget evaluates again', () => {
  const s = live();
  s.budgets = [blk('a', { dim: 'provider', value: 'pa' }, { name: 'A' }), blk('b', { dim: 'provider', value: 'pb' })];
  s.views = { a: { state: 'no_data', reason: 'the ledger could not read 2026-10' } };
  assert.equal(s.guard.check({ keyId: 'key_a', provider: 'pa' }), null);
  assert.match(s.reports.at(-1), /budget "A" has no data \(the ledger could not read 2026-10\)/);
  assert.deepEqual(s.listed(), [['a', 1000]]);
  s.t = 2000;
  // Another route target, another client: B checks clean, A stays listed with its first time.
  assert.equal(s.guard.check({ keyId: 'key_a', provider: 'pb' }), null);
  assert.equal(s.guard.check({ keyId: 'key_b', provider: 'pb' }), null);
  assert.equal(s.guard.check({}), null);
  assert.match(s.reports.at(-1), /budget "A" has no data/);
  assert.deepEqual(s.listed(), [['a', 1000]]);
  assert.equal(s.guard.check({ provider: 'pa' }), null, 'still failing open');
  assert.deepEqual(s.listed(), [['a', 1000]], 'since is when it started');
  s.views.b = new Error('EIO');
  s.guard.check({ provider: 'pb' });
  assert.deepEqual(s.listed(), [['a', 1000], ['b', 2000]]);
  assert.match(s.reports.at(-1), /^budget "A" has no data .* \(and 1 more\)$/);
  s.views = {}; // both read again, but only a check that reaches a budget clears it
  s.guard.check({ provider: 'pb' });
  assert.deepEqual(s.listed(), [['a', 1000]]);
  s.guard.check({ provider: 'pa' });
  assert.deepEqual(s.lists.at(-1), []);
  assert.equal(s.reports.at(-1), null);
  // A budget removed from the list, or no longer blocking, leaves the status.
  s.views = { a: { state: 'no_data', reason: 'r' }, b: { state: 'no_data', reason: 'r' } };
  s.guard.check({ provider: 'pa' });
  s.guard.check({ provider: 'pb' });
  assert.deepEqual(s.listed().map((x) => x[0]), ['a', 'b']);
  s.budgets = [{ ...s.budgets[0], enforce: 'none' }];
  s.guard.check({});
  assert.deepEqual(s.lists.at(-1), []);
});

test('guard: an unread list is reported until a list reads; a refusal keeps the other reasons', () => {
  const s = live();
  s.budgets = new Error('boom');
  assert.equal(s.guard.check({ keyId: 'key_a' }), null);
  assert.equal(s.reports.at(-1), 'the budgets could not be read, so requests are allowed');
  assert.deepEqual(s.listed(), [[null, 1000]]);
  s.t = 3000;
  assert.equal(s.guard.check({}), null);
  assert.deepEqual(s.listed(), [[null, 1000]], 'since is when it started');
  s.budgets = [blk('a', 'global'), blk('b', 'global', { name: 'B' })];
  s.views = { a: { state: 'no_data', reason: 'r' }, b: { state: 'exceeded' } };
  assert.deepEqual(s.guard.check({}), { budget: 'b', message: 'budget "B" is used up for this month' });
  assert.deepEqual(s.listed(), [['a', 3000]], 'the list read: only budget a is left');
});

test('guard: a check that throws lets the request through and says so until a check works again', () => {
  const s = live();
  s.budgets = [blk('a', 'global')];
  // A failure outside the guard's own reads (here the request itself): fail open, one guard-level reason.
  const bad = {
    get keyId() {
      throw new Error(`no such file ${HOME}/x`);
    },
  };
  assert.equal(s.guard.check(bad), null);
  assert.equal(s.reports.at(-1), 'the budget check failed, so requests are allowed');
  assert.deepEqual(s.listed(), [[null, 1000]]);
  s.t = 2000;
  assert.equal(s.guard.check(bad), null);
  assert.deepEqual(s.listed(), [[null, 1000]], 'since is when it started; still one reason');
  assert.equal(s.guard.check({}), null);
  assert.equal(s.reports.at(-1), null, 'cleared by the next check that works');
  assert.deepEqual(s.listed(), []);
  // keyLimited fails open (the key is not limited) and is reported the same way.
  s.budgets = new Error('boom');
  assert.equal(s.guard.keyLimited('key_a'), false);
  assert.equal(s.reports.at(-1), 'the budget check failed, so requests are allowed');
  // The gateway's own catch reports through failed().
  s.budgets = [];
  s.guard.check({});
  s.guard.failed();
  assert.deepEqual(s.listed(), [[null, 2000]]);
  // A status that cannot be kept never breaks the check.
  const quiet = createGuard({
    service: {
      list: () => ({ budgets: [] }),
      evaluateOne: () => ({ state: 'ok' }),
      keyCenter: () => 'unassigned',
      reportGuard: () => {
        throw new Error('down');
      },
    },
  });
  assert.equal(quiet.check({}), null);
  assert.equal(quiet.check(bad), null);
});

test('guard: keyLimited for blocking key and center budgets only', () => {
  const g = (list) => fake(list).guard;
  assert.equal(g([blk('k', { dim: 'key', value: 'key_a' })]).keyLimited('key_a'), true);
  assert.equal(g([blk('k', { dim: 'key', value: 'key_a' })]).keyLimited('key_b'), false);
  assert.equal(g([blk('c', { dim: 'center', value: 'acme' })]).keyLimited('key_a'), true);
  assert.equal(g([blk('c', { dim: 'center', value: 'acme' }, { enforce: 'none' })]).keyLimited('key_a'), false);
  assert.equal(g([blk('all', 'global')]).keyLimited('key_a'), false);
});

// ---- in process: the gateway with a fake upstream, the real ledger, service and guard ----
const PRICING = { 'llama-9': { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 } };
const completion = () => ({
  id: 'c1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 500 }, // 0.002 at PRICING
});

async function setup() {
  const upstream = await fakeServer({
    'POST /chat/completions': () => ({ body: completion() }),
    'GET /models': { body: { data: [{ id: 'llama-9' }, { id: 'tiny' }] } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-guard-'));
  const clock = { t: at(10, 22) };
  const st = { settings: undefined };
  const cost = createCost({
    dir: path.join(dataDir, 'cost'),
    gatewayLog: path.join(dataDir, 'gateway-usage.jsonl'),
    getPricing: () => PRICING,
    getSettings: () => st.settings,
    home: HOME,
    now: () => clock.t,
    nocase: false,
  });
  let gateway = null;
  const service = createBudgetService({
    getSettings: () => st.settings,
    getLegacy: () => ({ keys: gateway ? gateway.keys.list() : [] }),
    cost,
    home: HOME,
    now: () => clock.t,
  });
  const guard = createGuard({ service });
  gateway = createGateway({
    dataDir,
    getConfig: () => ({
      gateway: { providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, models: [], enabled: true }] },
    }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => PRICING,
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
    now: () => clock.t,
    budgetGuard: { check: guard.check, keyLimited: guard.keyLimited, record: service.record },
  });
  const server = http.createServer(async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = async (secret, model = 'fake/llama-9') => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }] }),
    });
    return { status: r.status, text: await r.text() };
  };
  const spent = (id) => service.evaluate().find((v) => v.id === id).spentUSD;
  const close = async () => {
    server.close();
    await upstream.close();
  };
  return { gateway, cost, service, st, clock, chat, spent, close };
}

test('gateway: a key budget blocks at once, is counted once across a pass, and lifts on a raised amount or a new month', async () => {
  const t = await setup();
  try {
    const { key, secret } = t.gateway.keys.create({ name: 'app', scopes: ['llm'], budgetUSD: 0.002 });
    const id = `legacy-key-${key.id}`;
    t.st.settings = {
      budgets: [
        { id: 'secret-team', name: 'Secret team', scope: 'global', period: 'month', amount: 100, enforce: 'block' },
      ],
    };
    assert.equal((await t.chat(secret)).status, 200);
    near(t.spent(id), 0.002, 'counted before the ledger read it');
    const refused = await t.chat(secret);
    assert.equal(refused.status, 402);
    assert.match(refused.text, /budget \\?"Key app\\?" is used up for this month/);
    assert.doesNotMatch(refused.text, /Secret team|\$|0\.002/, 'no other budget, no figures');
    t.service.pass(() => t.cost.update());
    assert.equal(t.service.pendingCount(), 0);
    near(t.spent(id), 0.002, 'once, now from the ledger');
    assert.equal((await t.chat(secret)).status, 402);
    t.gateway.keys.update(key.id, { budgetUSD: 1 });
    assert.equal((await t.chat(secret)).status, 200, 'a raised amount lifts the block');
    t.gateway.keys.update(key.id, { budgetUSD: 0.002 });
    assert.equal((await t.chat(secret)).status, 402);
    t.clock.t = at(11, 2);
    assert.equal((await t.chat(secret)).status, 200, 'a new month starts at 0');
  } finally {
    await t.close();
  }
});

test('gateway: a budget can pass its amount by one call; dashboard calls meet global and provider budgets only', async () => {
  const t = await setup();
  try {
    const { secret } = t.gateway.keys.create({ name: 'app', scopes: ['llm'], budgetUSD: 0.003 });
    assert.equal((await t.chat(secret)).status, 200);
    assert.equal((await t.chat(secret)).status, 200, 'under the amount when it started');
    assert.equal((await t.chat(secret)).status, 402, 'over by one call, then blocked');
    const ask = () => t.gateway.judge.complete({ model: 'fake/llama-9', messages: [{ role: 'user', content: 'x' }] });
    await ask(); // the key's budget does not reach the dashboard
    t.st.settings = {
      budgets: [
        {
          id: 'fake-day',
          name: 'Fake provider',
          scope: { dim: 'provider', value: 'fake' },
          period: 'day',
          amount: 0.001,
          enforce: 'block',
        },
      ],
    };
    await assert.rejects(
      ask(),
      (e) => e.status === 402 && /budget "Fake provider" is used up for this day/.test(e.message),
    );
    t.st.settings = {
      budgets: [
        {
          id: 'gw',
          name: 'Gateway',
          scope: { dim: 'source', value: 'gateway' },
          period: 'month',
          amount: 0.001,
          enforce: 'block',
        },
      ],
    };
    await ask(); // source gateway needs a key: the judge is the dashboard
    t.st.settings = {
      budgets: [{ id: 'all', name: 'Everything', scope: 'global', period: 'month', amount: 0.001, enforce: 'block' }],
    };
    await assert.rejects(
      ask(),
      (e) => e.status === 402 && /budget "Everything" is used up for this month/.test(e.message),
    );
  } finally {
    await t.close();
  }
});

test('gateway: a key under a blocking key budget saved in Budgets may use only priced models', async () => {
  const t = await setup();
  try {
    const { key, secret } = t.gateway.keys.create({ name: 'app', scopes: ['llm'] }); // no budgetUSD of its own
    assert.equal((await t.chat(secret, 'fake/tiny')).status, 200, 'no budget yet: an unpriced model is fine');
    t.st.settings = {
      budgets: [
        { id: 'k', name: 'K', scope: { dim: 'key', value: key.id }, period: 'month', amount: 5, enforce: 'block' },
      ],
    };
    const unpriced = await t.chat(secret, 'fake/tiny');
    assert.equal(unpriced.status, 402, 'its spend could not be counted');
    assert.match(unpriced.text, /has no known price/);
    assert.equal((await t.chat(secret)).status, 200, 'a priced model still goes');
  } finally {
    await t.close();
  }
});

// ---- a route of two providers: the guard skips a refused target, and its status covers every target ----
async function routeSetup(guardFor) {
  const answer = (who) => () => ({ body: { ...completion(), id: who } });
  const models = { body: { data: [{ id: 'llama-9' }] } };
  const a = await fakeServer({ 'POST /chat/completions': answer('A'), 'GET /models': models });
  const b = await fakeServer({ 'POST /chat/completions': answer('B'), 'GET /models': models });
  const s = live();
  const gateway = createGateway({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-guard-route-')),
    getConfig: () => ({
      gateway: {
        providers: [
          { id: 'pa', preset: 'custom', baseUrl: a.url, models: [], enabled: true },
          { id: 'pb', preset: 'custom', baseUrl: b.url, models: [], enabled: true },
        ],
        routes: [{ name: 'router/r', targets: ['pa/llama-9', 'pb/llama-9'], strategy: 'fallback' }],
      },
    }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => PRICING,
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
    budgetGuard: guardFor(s),
  });
  const server = http.createServer(async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { secret } = gateway.keys.create({ name: 'app', scopes: ['llm'] });
  const chat = async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'router/r', messages: [{ role: 'user', content: 'x' }] }),
    });
    return { status: r.status, text: await r.text() };
  };
  const posts = (up) => up.requests.filter((x) => x.method === 'POST').length;
  const close = async () => {
    server.close();
    await a.close();
    await b.close();
  };
  return { s, chat, posts, a, b, close };
}
const realGuard = (s) => ({ check: s.guard.check, keyLimited: s.guard.keyLimited, record: () => {} });

test('route: a refused target is skipped, all refused is one 402, a no_data target stays reported', async () => {
  const t = await routeSetup(realGuard);
  try {
    t.s.budgets = [blk('aaa', { dim: 'provider', value: 'pa' }), blk('bbb', { dim: 'provider', value: 'pb' })];
    t.s.views = { aaa: { state: 'exceeded' } };
    const skipped = await t.chat();
    assert.equal(skipped.status, 200);
    assert.match(skipped.text, /"id":"B"/);
    assert.equal(t.posts(t.a), 0, 'the refused provider is never called');
    t.s.views = { aaa: { state: 'exceeded' }, bbb: { state: 'exceeded' } };
    const refused = await t.chat();
    assert.equal(refused.status, 402);
    assert.match(refused.text, /budget \\"AAA\\" is used up for this month/);
    assert.match(refused.text, /insufficient_quota/);
    assert.doesNotMatch(refused.text, /BBB/);
    // The first target fails open and the second checks clean in the same request: the status keeps the first.
    t.s.views = { aaa: { state: 'no_data', reason: 'the ledger could not read 2026-10' } };
    const open = await t.chat();
    assert.equal(open.status, 200);
    assert.match(open.text, /"id":"A"/);
    assert.match(t.s.reports.at(-1), /budget "AAA" has no data/);
    assert.deepEqual(t.s.listed().map((x) => x[0]), ['aaa']);
  } finally {
    await t.close();
  }
});

test('route: a guard whose methods throw lets the request through', async () => {
  const boom = () => {
    throw new Error('guard down');
  };
  const failed = [];
  const t = await routeSetup(() => ({ check: boom, keyLimited: boom, record: boom, failed: () => failed.push(1) }));
  try {
    const r = await t.chat();
    assert.equal(r.status, 200);
    assert.match(r.text, /"id":"A"/);
    assert.ok(failed.length >= 1, 'the gateway reports the failure to the guard');
  } finally {
    await t.close();
  }
});
