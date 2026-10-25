// test/cost-budget-service.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createBudgetService } = require('../lib/cost/budget-service');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026, local time
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} is not ${b}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-budget-service-'));
const BASE = {
  centers: [{ id: 'acme', name: 'Acme' }],
  keyCenters: { key_a: 'acme' },
  folderRules: [{ glob: '~/work/acme/**', center: 'acme' }],
};
const CENTER_BUDGET = {
  id: 'acme-center',
  name: 'Acme center',
  scope: { dim: 'center', value: 'acme' },
  period: 'month',
  amount: 1,
  enforce: 'block',
};
const KEY_BUDGET = {
  id: 'acme',
  name: 'Acme',
  scope: { dim: 'key', value: 'key_a' },
  period: 'month',
  amount: 1,
  enforce: 'block',
};
// One gateway call of Sonnet, 1,000 in and 100 out: 0.003 at PRICE_A.
const entry = (ts, extra = {}) => ({
  ts,
  keyId: 'key_a',
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-5.5',
  kind: 'chat',
  status: 200,
  input: 1000,
  output: 100,
  cached: 0,
  ...extra,
});

function rig({ budgets = [], legacy = {}, demo = null, dir = tmp() } = {}) {
  const st = { pricing: PRICE_A, settings: { ...BASE, budgets }, legacy, t: at(22) };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost = createCost({
    dir: path.join(dir, 'cost'),
    gatewayLog,
    getPricing: () => st.pricing,
    getSettings: () => st.settings,
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const make = () =>
    createBudgetService({
      getSettings: () => st.settings,
      getLegacy: () => st.legacy,
      cost,
      home: HOME,
      now: () => st.t,
      nocase: false,
      demo,
      lastFile,
    });
  const lastFile = path.join(dir, 'cost', 'budgets.last.json');
  const s = make();
  // As the gateway does it: the line is appended (synchronously), then the call is reported.
  const send = (ts, extra) => {
    const e = entry(ts, extra);
    fs.appendFileSync(gatewayLog, JSON.stringify(e) + '\n');
    s.record(e);
  };
  return { st, cost, s, make, send, gatewayLog, lastFile, dir };
}
const spentOf = (s, id) => s.evaluate().find((v) => v.id === id).spentUSD;

test('priceGatewayLine: the row the next pass adds, or null for a line the ledger skips', () => {
  const r = rig();
  const row = r.cost.priceGatewayLine(entry(at(22, 10)));
  assert.deepEqual(
    { day: row.day, source: row.source, model: row.model, keyId: row.keyId, center: row.center, kind: row.kind },
    { day: '2026-10-22', source: 'gateway', model: 'claude-sonnet-5-5', keyId: 'key_a', center: 'acme', kind: 'chat' },
  );
  near(row.listUSD, 0.003);
  near(row.billedUSD, 0.003);
  assert.equal(r.cost.priceGatewayLine(entry(at(22), { client: 'claude-code', local: true })), null, 'from the logs');
  assert.equal(r.cost.priceGatewayLine(entry(at(22), { input: 0, output: 0 })), null, 'a failed attempt');
  assert.equal(r.cost.priceGatewayLine(entry(at(22), { keyId: 'dashboard', agent: 'judge' })).source, 'judge');
  assert.equal(r.cost.priceGatewayLine(entry(at(22), { runId: 'r1', agent: 'planner' })).source, 'collab');
  assert.equal(r.cost.gatewayPasses(), 0);
  r.cost.update();
  assert.equal(r.cost.gatewayPasses(), 1);
});

test('a pass between two requests: each call counts once, before and after the ledger reads it', () => {
  const r = rig({ budgets: [KEY_BUDGET] });
  r.send(at(22, 10));
  near(spentOf(r.s, 'acme'), 0.003, 'in memory only: the ledger has not read it');
  assert.equal(r.s.pendingCount(), 1);
  r.s.pass(() => r.cost.update());
  assert.equal(r.s.pendingCount(), 0, 'the pass read it');
  near(spentOf(r.s, 'acme'), 0.003, 'counted once, now from the ledger');
  r.send(at(22, 10, 5));
  near(spentOf(r.s, 'acme'), 0.006);
  r.s.pass(() => {}); // a pass whose gateway step did not run (the log did not read, or the positions are lost)
  assert.equal(r.s.pendingCount(), 1, 'kept until a pass reads it');
  near(spentOf(r.s, 'acme'), 0.006);
  r.s.pass(() => {
    r.cost.update();
    r.send(at(22, 10, 10)); // recorded after this pass read the log
  });
  assert.equal(r.s.pendingCount(), 1, 'a call after the mark waits for the next pass');
  near(spentOf(r.s, 'acme'), 0.009);
  r.s.pass(() => r.cost.update());
  assert.equal(r.s.pendingCount(), 0);
  near(spentOf(r.s, 'acme'), 0.009);
});

test('an increment from before the current periods is dropped', () => {
  const r = rig({ budgets: [KEY_BUDGET] });
  r.send(at(22, 10));
  r.st.t = new Date(2026, 10, 3, 12).getTime(); // Tuesday 3 November: the week and the month began after the call
  r.send(new Date(2026, 10, 3, 9).getTime());
  assert.equal(r.s.pendingCount(), 1);
  near(spentOf(r.s, 'acme'), 0.003, 'the new month counts only its own call');
});

test('spent follows the ledger read: a restate correction and a billing override apply', () => {
  const all = { id: 'all', name: 'All', scope: 'global', period: 'month', amount: 1 };
  const paid = {
    id: 'paid',
    name: 'Paid',
    scope: { dim: 'source', value: 'gateway' },
    period: 'month',
    amount: 100,
    measure: 'billed',
  };
  const r = rig({ budgets: [all, paid] });
  r.st.t = at(21);
  fs.appendFileSync(r.gatewayLog, JSON.stringify(entry(at(21, 10))) + '\n');
  r.cost.update();
  r.st.t = at(22);
  r.st.pricing = PRICE_B;
  r.cost.update();
  near(spentOf(r.s, 'all'), 0.003, 'a closed day keeps the price of its day');
  r.cost.restate({ from: '2026-10-21', to: '2026-10-21', reason: 'new prices' });
  r.s.invalidate();
  near(spentOf(r.s, 'all'), 0.006, 'the correction applies');
  near(spentOf(r.s, 'paid'), 0.006);
  r.cost.addBillingOverride({
    source: 'gateway',
    from: '2026-10-01',
    to: '2026-10-21',
    billing: { mode: 'plan', plan: 'Team', feeUSD: 31, period: 'month' },
  });
  r.s.invalidate();
  near(spentOf(r.s, 'paid'), 21, 'on the plan: one day of the fee a day, the usage billed 0');
  near(spentOf(r.s, 'all'), 0.006, 'the usage value does not change');
});

test('the last valid list stays in force while a hand edit does not validate, and is kept in budgets.last.json', () => {
  const r = rig({ budgets: [KEY_BUDGET] });
  assert.deepEqual(r.s.list().budgets.map((b) => b.id), ['acme']);
  assert.equal(r.s.list().complete, true);
  const kept = JSON.parse(fs.readFileSync(r.lastFile, 'utf8'));
  assert.deepEqual(
    [kept.version, kept.budgets.map((b) => b.id), kept.context],
    [1, ['acme'], { currency: null, ...BASE }],
    'the list with the last good cost settings',
  );
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.lastFile).mode & 0o777, 0o600);
  r.st.settings = { ...BASE, budgets: [{ id: 'acme', name: '' }] };
  let l = r.s.list();
  assert.deepEqual(l.budgets.map((b) => b.id), ['acme']);
  assert.equal(l.complete, false);
  assert.equal(l.error, 'budgets in config.json are invalid; the last valid list is in force');
  assert.ok(l.reasons.some((x) => /budgets\[0\]\.name/.test(x)), l.reasons.join());
  assert.deepEqual(
    JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).budgets.map((b) => b.id),
    ['acme'],
    'not overwritten',
  );
  r.st.settings = false; // config.json does not parse
  l = r.s.list();
  assert.equal(l.error, 'config.json could not be read; the last valid budget list is in force');
  assert.deepEqual(l.budgets.map((b) => b.id), ['acme']);
  r.st.settings = { ...BASE, budgets: [] };
  l = r.s.list();
  assert.equal(l.complete, true);
  assert.deepEqual(l.budgets, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).budgets, [], 'a valid save overwrites the file');
});

test('a restart on a broken hand edit still enforces the last valid list, a blocking budget included', () => {
  const tiny = { ...KEY_BUDGET, amount: 0.001 };
  const r = rig({ budgets: [tiny] });
  r.send(at(22, 10));
  r.s.pass(() => r.cost.update()); // the call is in the ledger: 0.003 against 0.001
  r.st.settings = { ...BASE, budgets: [{ id: 'acme', name: '' }] }; // the hand edit
  const after = r.make(); // the restart: nothing in memory
  const l = after.list();
  assert.deepEqual(l.budgets.map((b) => [b.id, b.enforce]), [['acme', 'block']]);
  assert.equal(l.error, 'budgets in config.json are invalid; the last valid list is in force');
  // What the gateway guard (lib/cost/guard.js, Task 3) refuses on: a blocking budget whose state is exceeded.
  const v = after.evaluateOne(l.budgets[0]);
  assert.deepEqual([v.id, v.state], ['acme', 'exceeded'], 'still blocks');
  r.st.settings = false;
  assert.deepEqual(r.make().list().budgets.map((b) => b.id), ['acme'], 'also when config.json does not parse');
});

test('a corrupt budgets.last.json with an invalid config: the old settings alone, with a warning; a valid config wins', () => {
  const r = rig({ budgets: [KEY_BUDGET], legacy: { monthlyBudgetUSD: 300 } });
  r.s.list(); // writes the file
  fs.writeFileSync(r.lastFile, '{"version":1,"budgets":[{"id":', { mode: 0o600 });
  r.st.settings = { ...BASE, budgets: [{ id: 'x' }] };
  let l = r.make().list();
  assert.deepEqual(l.budgets.map((b) => b.id), ['legacy-monthly']);
  assert.equal(l.error, 'budgets in config.json are invalid and no valid list was kept; only the old settings apply');
  fs.writeFileSync(r.lastFile, JSON.stringify({ version: 1, budgets: [{ id: 'bad' }], context: {} }), { mode: 0o600 });
  assert.deepEqual(r.make().list().budgets.map((b) => b.id), ['legacy-monthly'], 'a kept list that does not validate');
  const other = { id: 'other', name: 'Other', scope: 'global', period: 'day', amount: 5 };
  fs.writeFileSync(
    r.lastFile,
    JSON.stringify({ version: 1, budgets: [other], context: { currency: null, centers: [] } }),
  );
  r.st.settings = { ...BASE, budgets: [KEY_BUDGET] };
  l = r.make().list();
  assert.deepEqual(l.budgets.map((b) => b.id), ['acme', 'legacy-monthly'], 'the valid config wins over the file');
  assert.equal(l.error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).budgets.map((b) => b.id), ['acme']);
  const onDisk = JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).budgets;
  assert.ok(onDisk.every((b) => b.legacy === null && !b.id.startsWith('legacy-')), 'legacy budgets are never kept');
});

test('legacy budgets merge, the key and folder centers, the monthly figure, the demo stand-in', () => {
  const r = rig({
    budgets: [{ id: 'legacy-monthly', name: 'Team month', scope: 'global', period: 'month', amount: 400 }],
    legacy: { monthlyBudgetUSD: 300, keys: [{ id: 'key_a', name: 'Acme app', budgetUSD: 5 }] },
  });
  const l = r.s.list();
  assert.deepEqual(
    l.budgets.map((b) => [b.id, b.legacy]),
    [
      ['legacy-monthly', null],
      ['legacy-key-key_a', 'keyBudget'],
    ],
  );
  assert.deepEqual(l.legacy.map((b) => b.id), ['legacy-monthly', 'legacy-key-key_a']);
  assert.equal(r.s.keyCenter('key_a'), 'acme');
  assert.equal(r.s.keyCenter('key_x'), 'unassigned');
  assert.equal(r.s.centerOfProject('~/work/acme/web'), 'acme');
  assert.equal(r.s.centerOfProject('~/elsewhere'), 'unassigned');
  assert.deepEqual(r.s.monthly(), { monthlyBudgetUSD: 400, monthlyBudgetManaged: true });
  const d = rig({ budgets: [KEY_BUDGET], demo: { noData: { acme: 'the billing history could not be read (demo)' } } });
  const v = d.s.evaluate()[0];
  assert.equal(v.state, 'no_data');
  assert.match(v.reason, /\(demo\)/);
});

test('config.json does not parse: a call not read yet is attributed with the last good settings', () => {
  const r = rig({ budgets: [KEY_BUDGET, CENTER_BUDGET] });
  r.send(at(22, 10));
  r.s.pass(() => r.cost.update());
  r.st.settings = false;
  r.send(at(22, 10, 5)); // the pass waits meanwhile: this call stays in memory
  r.s.pass(() => r.cost.update());
  assert.equal(r.s.pendingCount(), 1);
  near(spentOf(r.s, 'acme'), 0.006, 'the key budget');
  near(spentOf(r.s, 'acme-center'), 0.006, 'the center budget: key_a is still acme');
  assert.equal(r.s.keyCenter('key_a'), 'acme');
});

test('an invalid cost section across a day boundary: the pass waits, the center budget keeps every call', () => {
  const r = rig({ budgets: [CENTER_BUDGET] });
  const centers = () =>
    r.cost
      .ledger({ from: '2026-10-22', to: '2026-10-23', groupBy: ['center'] })
      .rows.map((x) => [x.center, x.requests]);
  r.send(at(22, 10));
  r.s.pass(() => r.cost.update());
  near(spentOf(r.s, 'acme-center'), 0.003, 'from the ledger');
  r.st.settings = { ...BASE, billing: 5, budgets: [CENTER_BUDGET] }; // parses; the cost section does not validate
  r.send(at(22, 11));
  r.st.t = at(23, 1); // the 22nd closes meanwhile
  r.s.pass(() => r.cost.update());
  assert.equal(r.s.pendingCount(), 1, 'the pass waited: the call stays in memory');
  assert.deepEqual(centers(), [['acme', 1]], 'no row written while the section is invalid');
  near(spentOf(r.s, 'acme-center'), 0.006, 'the call attributed with the last good settings');
  r.st.settings = { ...BASE, budgets: [CENTER_BUDGET] }; // fixed
  r.s.pass(() => r.cost.update());
  assert.equal(r.s.pendingCount(), 0);
  assert.deepEqual(centers(), [['acme', 2]], 'the late line of the closed day, with the fixed rules');
  near(spentOf(r.s, 'acme-center'), 0.006, 'counted once');
});

test('a restart on an unparsable config.json: the kept settings attribute and a center budget still blocks', () => {
  const r = rig({ budgets: [{ ...CENTER_BUDGET, amount: 0.005 }] });
  r.send(at(22, 10));
  r.s.pass(() => r.cost.update());
  r.st.settings = false;
  const after = r.make(); // the restart: nothing in memory
  assert.equal(after.keyCenter('key_a'), 'acme', 'from budgets.last.json');
  assert.equal(after.centerOfProject('~/work/acme/web'), 'acme');
  const b = after.list().budgets[0];
  assert.deepEqual([b.id, after.evaluateOne(b).state], ['acme-center', 'warn_50']);
  near(after.evaluateOne(b).spentUSD, 0.003, 'the ledger row');
  r.send(at(22, 10, 5)); // recorded by the old service; the new one records it as the gateway would
  after.record(entry(at(22, 10, 5)));
  near(after.evaluateOne(b).spentUSD, 0.006);
  assert.equal(after.evaluateOne(b).state, 'exceeded', 'what the gateway guard refuses on');
});

test('a valid config.json with other key centers wins and overwrites the kept settings', () => {
  const r = rig({ budgets: [CENTER_BUDGET] });
  r.s.list();
  r.st.settings = {
    ...BASE,
    centers: [...BASE.centers, { id: 'beta', name: 'Beta' }],
    keyCenters: { key_a: 'beta' },
    budgets: [CENTER_BUDGET],
  };
  assert.equal(r.s.keyCenter('key_a'), 'beta');
  const ctx = JSON.parse(fs.readFileSync(r.lastFile, 'utf8')).context;
  assert.deepEqual([ctx.keyCenters, ctx.centers.map((c) => c.id)], [{ key_a: 'beta' }, ['acme', 'beta']]);
  r.st.settings = false;
  assert.equal(r.make().keyCenter('key_a'), 'beta', 'the restart takes the newer settings');
});

test('a valid cost section is kept while the budget list is invalid, and a restart takes it', () => {
  const r = rig({ budgets: [CENTER_BUDGET] });
  r.s.list();
  r.st.settings = {
    ...BASE,
    centers: [...BASE.centers, { id: 'beta', name: 'Beta' }],
    keyCenters: { key_a: 'beta' },
    budgets: [{ id: 'x', name: '' }], // the list does not validate
  };
  assert.equal(r.s.keyCenter('key_a'), 'beta');
  assert.equal(r.s.list().error, 'budgets in config.json are invalid; the last valid list is in force');
  const f = JSON.parse(fs.readFileSync(r.lastFile, 'utf8'));
  assert.deepEqual([f.budgets.map((b) => b.id), f.context.keyCenters], [['acme-center'], { key_a: 'beta' }]);
  r.st.settings = false;
  const after = r.make();
  assert.equal(after.keyCenter('key_a'), 'beta', 'the newest valid settings, not the ones kept with the list');
  assert.deepEqual(after.list().budgets.map((b) => b.id), ['acme-center']);
});
