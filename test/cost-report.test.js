// Cost Control 5: lib/cost/report.js showback, one cost center's month for a client. Pure: ledger rows in, the
// report's totals, tables, daily spend, budgets and notes out.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/cost/report');

const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  project: null,
  center: 'acme',
  keyId: 'key_a',
  agent: null,
  kind: 'chat',
  requests: 2,
  tokens: { in: 100, out: 10, cacheRead: 5, cacheWrite5m: 1, cacheWrite1h: 2 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const plan = (day) => ({
  ...row(day),
  source: 'claude',
  model: null,
  center: null,
  keyId: null,
  kind: 'plan',
  requests: 0,
  tokens: {},
  listUSD: 0,
  billedUSD: 6.5,
});
const CENTERS = [
  { id: 'acme', name: 'Client: Acme' },
  { id: 'lab', name: 'Lab' },
];
const ROWS = [
  row('2026-09-03'),
  row('2026-09-03', {
    model: 'claude-sonnet-5-5',
    keyId: null,
    source: 'claude',
    project: '~/acme-web',
    listUSD: 2,
    billedUSD: 0,
  }),
  row('2026-09-10', { center: 'lab', listUSD: 4, billedUSD: 4 }),
  row('2026-09-12', { center: 'unassigned', keyId: 'key_b', listUSD: 0.5, billedUSD: 0.5 }),
  plan('2026-09-03'),
  row('2026-10-01', { listUSD: 100 }), // another month
];

test('months: the range of a month, the picker back to the first month, and the default month', () => {
  assert.deepEqual(R.monthRange('2026-09', '2026-10-29'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(R.monthRange('2026-10', '2026-10-29'), { from: '2026-10-01', to: '2026-10-29' });
  assert.deepEqual(R.monthRange('2024-02', '2026-10-29'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(R.reportMonths('2026-10-29', '2026-08-15'), ['2026-10', '2026-09', '2026-08']);
  assert.deepEqual(R.reportMonths('2026-01-05', '2025-11-30'), ['2026-01', '2025-12', '2025-11']);
  assert.deepEqual(R.reportMonths('2026-10-29', null), ['2026-10']);
  assert.equal(R.reportMonths('2026-10-29', '1990-01-01').length, 120, 'ten years at most');
  assert.equal(R.defaultMonth('2026-10-29', '2026-09-01'), '2026-09', 'all of last month is in the ledger');
  assert.equal(R.defaultMonth('2026-10-29', '2026-09-30'), '2026-10', 'the first days of the ledger');
  assert.equal(R.defaultMonth('2026-10-29', null), '2026-10');
  assert.equal(R.defaultMonth('2026-01-03', '2025-06-01'), '2025-12');
});

test('showback: one center in both measures, by source, model, key and project; plan fees only for all', () => {
  const r = R.showback({
    rows: ROWS,
    month: '2026-09',
    today: '2026-10-29',
    center: 'acme',
    centers: CENTERS,
    keyNames: new Map([['key_a', 'Acme app']]),
    generatedAt: 123,
  });
  assert.deepEqual(
    [r.month, r.from, r.to, r.center, r.currency, r.generatedAt],
    ['2026-09', '2026-09-01', '2026-09-30', { id: 'acme', name: 'Client: Acme' }, 'USD', 123],
  );
  assert.deepEqual(r.totals, {
    requests: 4,
    tokens: { input: 200, output: 20, cacheRead: 10, cacheWrite: 6 },
    listUSD: 3,
    billedUSD: 1,
  });
  assert.deepEqual(
    r.tables.source.map((x) => [x.key, x.listUSD, x.billedUSD]),
    [
      ['claude', 2, 0],
      ['gateway', 1, 1],
    ],
  );
  assert.deepEqual(
    r.tables.key.map((x) => [x.key, x.name]),
    [
      ['__none', null],
      ['key_a', 'Acme app'],
    ],
  );
  assert.deepEqual(
    r.tables.project.map((x) => x.key),
    ['~/acme-web', '__none'],
  );
  assert.equal(r.tables.model[0].tokens, 118, 'every token kind counts');
  assert.equal(r.daily.length, 30);
  assert.deepEqual(r.daily[2], { day: '2026-09-03', listUSD: 3, billedUSD: 1 });
  assert.equal(r.budgets, null, 'a past month');

  const all = R.showback({ rows: ROWS, month: '2026-09', today: '2026-10-29', center: '__all', centers: CENTERS });
  assert.equal(all.center.name, 'All centers');
  assert.equal(all.totals.listUSD, 7.5);
  assert.equal(all.totals.billedUSD, 12, 'the plan fee is paid by all centers');
  assert.ok(all.tables.model.some((x) => x.key === '__plan' && x.billedUSD === 6.5));
  assert.ok(
    all.tables.source.some((x) => x.key === 'claude' && x.billedUSD === 6.5),
    'the fee under its source',
  );

  const none = R.showback({
    rows: ROWS,
    month: '2026-09',
    today: '2026-10-29',
    center: 'unassigned',
    centers: CENTERS,
  });
  assert.deepEqual([none.center.name, none.totals.listUSD, none.tables.key[0].key], ['Unassigned', 0.5, 'key_b']);
});

test('showback: 20 rows per table, then Other with how many it holds', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    row('2026-09-05', { model: `m-${String(i).padStart(2, '0')}`, listUSD: 25 - i, billedUSD: 1 }),
  );
  const r = R.showback({ rows: many, month: '2026-09', today: '2026-10-29', center: 'acme', centers: CENTERS });
  assert.equal(r.tables.model.length, 21);
  assert.equal(r.tables.model[0].key, 'm-00');
  const other = r.tables.model[20];
  assert.deepEqual([other.key, other.count, other.listUSD, other.billedUSD, other.requests], ['__other', 5, 15, 5, 10]);
});

test('showback: the budgets of the center (every one for all), and the notes', () => {
  const view = (id, scope, over = {}) => ({
    id,
    name: id,
    scope,
    period: 'month',
    from: '2026-10-01',
    to: '2026-10-31',
    amount: 100,
    currency: 'USD',
    measure: 'list',
    enforce: 'block',
    state: 'warn_80',
    projected: true,
    percent: 84.5,
    spent: 84.5,
    reason: null,
    ...over,
  });
  const budgets = [
    view('acme', { dim: 'center', value: 'acme' }),
    view('global', 'global'),
    view('opus', { dim: 'model', value: 'x' }),
  ];
  const rows = [row('2026-10-02', { billingAssumed: true }), row('2026-10-05')];
  const corrections = [
    { ts: 5, from: '2026-10-03', to: '2026-10-04', reason: 'new prices', rows: 3 },
    { ts: 4, from: '2026-08-01', to: '2026-08-31', reason: 'old', rows: 1 },
  ];
  const r = R.showback({
    rows,
    month: '2026-10',
    today: '2026-10-29',
    center: 'acme',
    centers: CENTERS,
    budgets,
    corrections,
    unread: ['corrections'],
    billingError: 'the billing history could not be read',
  });
  assert.equal(r.to, '2026-10-29', 'the current month up to today');
  assert.deepEqual(
    r.budgets.map((b) => [b.id, b.state, b.percent]),
    [['acme', 'warn_80', 84.5]],
  );
  assert.ok(!('enforce' in r.budgets[0]));
  const all = R.showback({ rows, month: '2026-10', today: '2026-10-29', center: '__all', budgets });
  assert.equal(all.budgets.length, 3);
  assert.deepEqual(r.notes, {
    unread: ['corrections'],
    assumed: ['2026-10-02'],
    billingError: 'the billing history could not be read',
    corrections: [{ ts: 5, from: '2026-10-03', to: '2026-10-04', reason: 'new prices' }],
  });
  assert.equal(R.showback({ rows, month: '2026-10', today: '2026-10-29', corrections: null }).notes.corrections, null);
});

test('showback: the display currency per day, null once a day has no rate', () => {
  const rateOf = (day) => (day >= '2026-09-10' ? 16000 : null);
  const r = R.showback({
    rows: ROWS,
    month: '2026-09',
    today: '2026-10-29',
    center: 'lab',
    centers: CENTERS,
    rateOf,
    currency: 'IDR',
  });
  assert.deepEqual([r.totals.list, r.totals.billed], [64000, 64000]);
  assert.deepEqual(r.daily[9], { day: '2026-09-10', listUSD: 4, billedUSD: 4, list: 64000, billed: 64000 });
  const acme = R.showback({
    rows: ROWS,
    month: '2026-09',
    today: '2026-10-29',
    center: 'acme',
    rateOf,
    currency: 'IDR',
  });
  assert.deepEqual([acme.totals.list, acme.tables.source[0].list], [null, null], 'the 3rd has no rate');
});
