// Cost Control 5: GET /api/cost/report, in-process on the demo ledger: the default month, one center, all centers and
// Unassigned, the budgets of the current month, the display currency, the 400s and the 503; path-free.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { createBudgetService } = require('../lib/cost/budget-service');
const { costDemo } = require('../lib/demo');
const { dayOf } = require('../lib/cost/days');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const NOW = new Date(2026, 9, 22, 15).getTime(); // the demo ledger starts 29 days before: 23 September
const TODAY = dayOf(NOW);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);

function setup({ cost: fake } = {}) {
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
  const api = createCostApi({
    cost,
    settings: { get: () => d.settings, save: () => {} },
    listKeys: () => [{ id: 'key_demo0acme01', name: 'Acme client' }],
    home: HOME,
    now: () => NOW,
    budgets,
  });
  const bodies = [];
  const get = async (query) => {
    const r = await api.route({ method: 'GET', path: '/api/cost/report', query: new URLSearchParams(query) });
    bodies.push(JSON.stringify(r.body));
    return r;
  };
  return { get, bodies, cost };
}

test('report: this month by default while the ledger lacks part of last month; all centers; the months', async () => {
  const s = setup();
  const r = await s.get('');
  assert.equal(r.status, 200);
  const b = r.body;
  assert.deepEqual(
    [b.month, b.from, b.to, b.center, b.currency],
    ['2026-10', '2026-10-01', TODAY, { id: 'all', name: 'All centers' }, 'USD'],
  );
  assert.deepEqual(b.months, ['2026-10', '2026-09']);
  assert.equal(b.generatedAt, NOW);
  const led = s.cost.ledger({ from: '2026-10-01', to: TODAY, groupBy: ['day'] });
  near(b.totals.listUSD, led.totals.listUSD);
  near(b.totals.billedUSD, led.totals.billedUSD);
  assert.equal(b.daily.length, 22);
  for (const t of ['source', 'model', 'key', 'project']) assert.ok(b.tables[t].length > 0, t);
  assert.deepEqual(
    b.budgets.map((x) => x.id).sort(),
    ['acme-gateway', 'legacy-monthly', 'research-week', 'team'],
    'every budget for all centers',
  );
  assert.equal(b.budgetsError, null);
  assert.deepEqual(b.notes.unread, []);
  assert.deepEqual(b.notes.corrections, []);
});

test('report: one center, Unassigned, a past month without budget states, and the display currency', async () => {
  const s = setup();
  const acme = (await s.get('month=2026-10&center=client-acme')).body;
  assert.deepEqual(acme.center, { id: 'client-acme', name: 'Client: Acme' });
  const byCenter = s.cost.ledger({ from: '2026-10-01', to: TODAY, groupBy: ['center'] });
  near(acme.totals.listUSD, byCenter.rows.find((x) => x.center === 'client-acme').listUSD);
  assert.ok(
    acme.tables.key.some((k) => k.name === 'Acme client'),
    'keys by their names',
  );
  assert.deepEqual(acme.budgets, [], 'no budget is scoped to the Acme center');
  const research = (await s.get('center=research')).body;
  assert.deepEqual(
    research.budgets.map((x) => x.id),
    ['research-week'],
  );
  const none = await s.get('center=unassigned');
  assert.equal(none.status, 200);
  assert.equal(none.body.center.name, 'Unassigned');
  const sep = (await s.get('month=2026-09')).body;
  assert.deepEqual([sep.from, sep.to, sep.budgets], ['2026-09-01', '2026-09-30', null]);
  assert.equal(sep.daily.length, 30);
  const idr = (await s.get('currency=IDR')).body;
  assert.equal(idr.currency, 'IDR');
  assert.ok(idr.totals.list > idr.totals.listUSD * 16000);
  for (const body of s.bodies) assert.doesNotMatch(body, PATHS);
});

test('report: 400 for a bad month, unknown center or currency; 503 for a ledger that does not read', async () => {
  const s = setup();
  for (const [q, msg] of [
    ['month=2026-13', 'month: YYYY-MM'],
    ['month=26-10', 'month: YYYY-MM'],
    ['month=2026-11', 'month: this month or earlier'],
    ['month=0000-01', 'month: not in the ledger'],
    ['month=2026-07', 'month: not in the ledger'],
    ['center=nobody', 'unknown center'],
    ['currency=EUR', 'no rates for that currency; set it in the cost settings'],
  ]) {
    const r = await s.get(q);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.error, msg, q);
  }
  const down = setup({
    cost: {
      firstDay: () => null,
      corrections: () => [],
      budgetRows: () => ({ rows: [], unread: ['folder'], billingError: null }),
    },
  });
  const d = await down.get('');
  assert.equal(d.status, 503);
  assert.deepEqual(d.body, { error: 'the ledger folder could not be read', code: 'LEDGER_MONTH_UNREAD' });
  const part = setup({
    cost: {
      firstDay: () => '2026-08-20',
      corrections: () => {
        throw Object.assign(new Error('the ledger corrections could not be read'), {
          code: 'LEDGER_CORRECTIONS_UNREAD',
        });
      },
      budgetRows: () => ({ rows: [], unread: ['2026-09', 'corrections'], billingError: null }),
    },
  });
  const p = await part.get('');
  assert.equal(p.status, 200);
  assert.equal(p.body.month, '2026-09', 'all of last month is in the ledger');
  assert.deepEqual(p.body.notes.unread, ['2026-09', 'corrections']);
  assert.equal(p.body.notes.corrections, null);
  for (const body of [...s.bodies, ...down.bodies]) assert.doesNotMatch(body, PATHS);
});

test('report: budgetsError when the budgets of the current month do not evaluate', async () => {
  const s = setup();
  const d = costDemo(NOW);
  const api = createCostApi({
    cost: s.cost,
    settings: { get: () => d.settings, save: () => {} },
    home: HOME,
    now: () => NOW,
    budgets: {
      evaluate: () => {
        throw new Error('budgets broke');
      },
    },
  });
  const r = await api.route({ method: 'GET', path: '/api/cost/report', query: new URLSearchParams('') });
  assert.equal(r.status, 200);
  assert.equal(r.body.budgetsError, 'budgets could not be read');
  assert.deepEqual(r.body.budgets, []);
});
