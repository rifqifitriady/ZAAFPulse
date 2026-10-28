// Cost Control 4a: the forecast's known days start at the ledger's first day (cost.firstDay), not at the first row a
// reader's window happens to hold, so the Monitors rule, the budgets and the Overview agree on every day.
// Wednesday 28 October 2026, 15:00: yesterday is Tuesday the 27th.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../lib/cost/forecast');
const A = require('../lib/cost/anomaly');
const B = require('../lib/cost/budgets');
const V = require('../lib/cost/views');
const L = require('../lib/cost/ledger');
const { createBudgetService } = require('../lib/cost/budget-service');
const { createCostApi } = require('../lib/cost/api');
const { addDays, daysBetween } = require('../lib/cost/days');

const NOW = new Date(2026, 9, 28, 15).getTime();
const TODAY = '2026-10-28';
const row = (day, usd) => ({
  day,
  source: 'gateway',
  provider: 'openrouter',
  model: 'deepseek-chat',
  project: null,
  center: 'client',
  keyId: 'key_a',
  kind: 'chat',
  listUSD: usd,
  billedUSD: usd,
});
const weekdays = (from, to, skip = []) =>
  daysBetween(from, to)
    .filter((d) => F.weekday(d) < 5 && !skip.includes(d))
    .map((d) => row(d, 5));
// The repro: $5 each weekday since 17 August, nothing on Tuesday 29 and Wednesday 30 September (today − 29 and
// today − 28), $12 yesterday and $1 so far today.
const FIRST = '2026-08-17';
const LEDGER = [...weekdays(FIRST, '2026-10-26', ['2026-09-29', '2026-09-30']), row('2026-10-27', 12), row(TODAY, 1)];
const cut = (rows, from, to) => rows.filter((r) => r.day >= from && r.day <= to);
const budget = {
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  amount: 1000,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'none',
  legacy: null,
};

test('dailyModel: since starts the known days at the ledger’s first day; without it the first row does', () => {
  const rows = [row('2026-10-06', 5), row('2026-10-20', 5)];
  assert.equal(F.dailyModel(rows, { today: '2026-10-29' }).known, 23, 'from the 6th');
  const m = F.dailyModel(rows, { today: '2026-10-29', since: '2026-09-01' });
  assert.equal(m.known, 28, 'the whole window: the ledger is older');
  assert.equal(m.days[0], '2026-10-01');
  assert.equal(F.dailyModel(rows, { today: '2026-10-29', since: '2026-10-25' }).known, 23, 'a row before since counts');
  assert.equal(F.dailyModel([], { today: '2026-10-29', since: '2026-10-01' }).known, 28, 'no spend: zeros');
  assert.equal(F.dailyModel([], { today: '2026-10-29', since: '2026-10-28' }), null, 'one known day');
  assert.equal(F.dailyModel([], { today: '2026-10-29', since: '2026-10-29' }), null, 'a ledger that began today');
});

test('the repro: Monitors, the budgets and the Overview see the same usual amount through their own windows', () => {
  // Monitors: [today − 29, today]. Tuesday 29 September is a zero, not unknown: (0 + 5 + 5 + 5) / 4.
  const mon = A.recentDays(cut(LEDGER, addDays(TODAY, -A.HISTORY_DAYS), TODAY), { today: TODAY, since: FIRST });
  assert.equal(mon.yesterday.expectedUSD, 3.75);
  assert.equal(mon.today.expectedUSD, 3.75, 'Wednesday 30 September is a zero too');
  // The Overview: the 29 days before the 1st and the month.
  const o = V.overview({
    history: cut(LEDGER, '2026-09-02', '2026-09-30'),
    rows: cut(LEDGER, '2026-10-01', TODAY),
    today: TODAY,
    since: FIRST,
  });
  assert.equal(o.anomalies.yesterday.expectedUSD, 3.75);
  assert.equal(o.anomalies.today.expectedUSD, 3.75);
  // The budgets: [today − 28, today − 1]. The same forecast as from the whole ledger, and as the Overview's line.
  const month = cut(LEDGER, '2026-10-01', TODAY);
  const narrow = B.evaluateBudget(budget, {
    rows: month,
    history: cut(LEDGER, '2026-09-30', '2026-10-27'),
    now: NOW,
    since: FIRST,
  });
  const wide = B.evaluateBudget(budget, { rows: month, history: cut(LEDGER, FIRST, '2026-10-27'), now: NOW });
  assert.equal(narrow.forecastUSD, wide.forecastUSD);
  assert.ok(Math.abs(narrow.forecastUSD - o.forecast.projected) < 1e-4, 'the budget and the burn-down agree');
});

test('the readers pass cost.firstDay: the budget service and GET /api/cost/view', async () => {
  const cost = {
    budgetRows: ({ from, to }) => ({ rows: cut(LEDGER, from, to), unread: [], billingError: null, historyLost: false }),
    planFeeFor: () => 0,
    firstDay: () => FIRST,
  };
  const budgets = createBudgetService({
    getSettings: () => ({ budgets: [budget] }),
    cost,
    now: () => NOW,
    nocase: false,
  });
  const month = cut(LEDGER, '2026-10-01', TODAY);
  const wide = B.evaluateBudget(budget, { rows: month, history: cut(LEDGER, FIRST, '2026-10-27'), now: NOW });
  assert.equal(budgets.evaluate()[0].forecastUSD, wide.forecastUSD);
  const api = createCostApi({
    cost,
    settings: { get: () => ({}), save: () => {} },
    listKeys: () => [],
    now: () => NOW,
    budgets,
  });
  // A history window that starts on an empty day: the Overview still counts it as a zero, from the ledger's first day.
  const short = {
    ...cost,
    budgetRows: ({ from, to }) => cost.budgetRows({ from: from < '2026-09-29' ? '2026-09-29' : from, to }),
  };
  const api2 = createCostApi({
    cost: short,
    settings: { get: () => ({}), save: () => {} },
    listKeys: () => [],
    now: () => NOW,
    budgets,
  });
  for (const a of [api, api2]) {
    const r = await a.route({ method: 'GET', path: '/api/cost/view', query: new URLSearchParams('page=overview') });
    assert.equal(r.status, 200);
    assert.equal(r.body.anomalies.yesterday.expectedUSD, 3.75);
  }
});

test('a day before the ledger’s first day is still unknown, in every window', () => {
  // The ledger began on Wednesday 14 October: Tuesday 20 October is the only Tuesday it knows.
  const start = '2026-10-14';
  const rows = [...weekdays(start, '2026-10-26'), row('2026-10-27', 12), row(TODAY, 1)];
  const mon = A.recentDays(cut(rows, addDays(TODAY, -A.HISTORY_DAYS), TODAY), { today: TODAY, since: start });
  assert.equal(mon.yesterday.expectedUSD, 5);
  const model = F.dailyModel(
    rows.map((r) => ({ day: r.day, usd: r.listUSD })),
    { today: TODAY, since: start },
  );
  assert.deepEqual([model.known, model.days[0]], [14, start]);
  const o = V.overview({ history: [], rows: cut(rows, '2026-10-01', TODAY), today: TODAY, since: start });
  assert.equal(o.anomalies.yesterday.expectedUSD, 5);
});

test('the ledger’s first day: the earliest usage row, an unread earlier month from its 1st, none without rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-since-'));
  try {
    const s = L.createLedgerStore({ dir: path.join(dir, 'cost') });
    s.load();
    assert.equal(s.firstDay(), null, 'an empty ledger');
    const r = (day, extra = {}) => ({
      ...L.newRow({
        day,
        source: 'claude',
        provider: 'anthropic',
        model: 'm',
        project: '~/a',
        center: 'unassigned',
        kind: 'chat',
      }),
      requests: 1,
      listUSD: 1,
      billedUSD: 1,
      priceVersion: 1,
      ...extra,
    });
    s.put(r('2026-10-03'));
    s.put(r('2026-09-12'));
    s.put(r('2026-09-20', { source: 'codex' }));
    s.flush();
    assert.equal(s.firstDay(), '2026-09-12');
    // A month file that does not read could hold an earlier day: the ledger is known from that month's 1st.
    fs.mkdirSync(path.join(dir, 'cost', 'ledger-2026-08.jsonl'));
    const again = L.createLedgerStore({ dir: path.join(dir, 'cost') });
    assert.throws(() => again.load());
    assert.equal(again.firstDay(), '2026-08-01');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cost.firstDay: the demo’s first day in demo mode', () => {
  const { costDemo } = require('../lib/demo');
  const { createCost } = require('../lib/cost');
  const d = costDemo(NOW);
  const cost = createCost({
    demo: d,
    getSettings: () => d.settings,
    home: '/Users/owner',
    now: () => NOW,
    nocase: false,
  });
  const first = d.rows.filter((x) => x.kind !== 'plan').reduce((a, x) => (x.day < a ? x.day : a), TODAY);
  assert.equal(cost.firstDay(), first);
  assert.equal(first, addDays(TODAY, -29));
});

test('under Paid, the known days start after the last assumed day even when the ledger is older', () => {
  // Every day to Sunday 11 October lost its billing (metered $50); the model rests on Monday 12 October onward.
  const lost = LEDGER.map((r) => (r.day <= '2026-10-11' ? { ...r, billedUSD: 50, billingAssumed: true } : r));
  const paid = { ...budget, measure: 'billed' };
  const month = cut(LEDGER, '2026-10-01', TODAY);
  const v = B.evaluateBudget(paid, {
    rows: month,
    history: cut(lost, '2026-09-30', '2026-10-27'),
    now: NOW,
    since: FIRST,
  });
  const after = B.evaluateBudget(paid, { rows: month, history: cut(LEDGER, '2026-10-12', '2026-10-27'), now: NOW });
  assert.equal(v.forecastUSD, after.forecastUSD);
});

test('a scoped budget’s known days start at its own first row: a young center is not diluted by the ledger’s age', () => {
  // The center began on Friday 23 October at $10 a day; the ledger is weeks older.
  const young = [...LEDGER, ...daysBetween('2026-10-23', '2026-10-27').map((d) => ({ ...row(d, 10), center: 'acme' }))];
  const acme = { ...budget, id: 'acme', scope: { dim: 'center', value: 'acme' }, amount: 80 };
  const month = cut(young, '2026-10-01', TODAY);
  const history = cut(young, '2026-09-30', '2026-10-27');
  const v = B.evaluateBudget(acme, { rows: month, history, now: NOW, since: FIRST });
  // $50 spent, then $10 for today and each of the 3 days left: $80 on the 30th (equal), past it on the 31st.
  assert.deepEqual([v.forecastUSD, v.projected, v.runsOut], [90, true, '2026-10-31']);
  assert.deepEqual(
    B.evaluateBudget(acme, { rows: month, history, now: NOW }).forecastUSD,
    90,
    'the same without since',
  );
  // The global budget still counts from the ledger's first day, as the Overview does.
  const g = B.evaluateBudget(budget, { rows: month, history, now: NOW, since: FIRST });
  const o = V.overview({ history: cut(young, '2026-09-02', '2026-09-30'), rows: month, today: TODAY, since: FIRST });
  assert.ok(Math.abs(g.forecastUSD - o.forecast.projected) < 1e-4);
});
