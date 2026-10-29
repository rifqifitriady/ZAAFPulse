// Cost Control 5: the weekly digest. Its figures (lib/cost/report.js lastWeek, digestFigures), its desktop line and
// webhook body (lib/monitors/channels.js), and (Task 7, appended below) its scheduler (lib/cost/digest.js). No real
// notification and no network: a fake spawn and a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const R = require('../lib/cost/report');
const { createChannels, digestLine, digestBody } = require('../lib/monitors/channels');
const { secretsFor } = require('./helpers');
const { addDays, daysBetween } = require('../lib/cost/days');

const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  model: 'claude-sonnet-5-5',
  project: '~/secret-client/app',
  center: 'acme',
  keyId: 'key_a',
  kind: 'chat',
  requests: 1,
  tokens: {},
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
// Thursday 29 October 2026: last week is Monday 19 to Sunday 25 October.
const TODAY = '2026-10-29';
const WEEK = { from: '2026-10-19', to: '2026-10-25' };
// Four quiet weeks of $1 a day before last week, then last week at $2 a day with a $30 spike on the 21st.
function ledger() {
  const rows = [];
  for (const day of daysBetween(addDays(WEEK.from, -28), WEEK.to)) {
    const lastWeek = day >= WEEK.from;
    rows.push(row(day, { listUSD: lastWeek ? 2 : 1, billedUSD: lastWeek ? 2 : 1 }));
  }
  rows.push(row('2026-10-21', { model: 'claude-opus-5-5', center: 'lab', listUSD: 30, billedUSD: 30 }));
  rows.push(row('2026-10-20', { center: null, kind: 'plan', model: null, requests: 0, listUSD: 0, billedUSD: 6.5 }));
  return rows;
}
const FIG = (over = {}) =>
  R.digestFigures({
    rows: ledger(),
    week: WEEK,
    since: addDays(WEEK.from, -28),
    centers: [
      { id: 'acme', name: 'Client: Acme' },
      { id: 'lab', name: 'Lab' },
    ],
    budgets: [
      { id: 'team', name: 'Team', state: 'warn_80', projected: true, percent: 84.2, enforce: 'block' },
      { id: 'quiet', name: 'Quiet', state: 'ok', projected: false, percent: 10 },
      { id: 'acme', name: 'Key Acme app', state: 'exceeded', projected: false, percent: 120 },
    ],
    anomalyParams: { ratio: 2, minUSD: 1 },
    recommendation: { model: 'claude-opus-5-5', candidate: 'claude-sonnet-5-5', savingUSD: 42.4, spendUSD: 100 },
    ...over,
  });

test('last week: Monday to Sunday before the current week', () => {
  assert.deepEqual(R.lastWeek(TODAY), WEEK);
  assert.deepEqual(R.lastWeek('2026-10-26'), WEEK, 'on a Monday');
  assert.deepEqual(R.lastWeek('2026-11-01'), WEEK, 'on a Sunday');
  assert.deepEqual(R.lastWeek('2027-01-04'), { from: '2026-12-28', to: '2027-01-03' });
});

test('figures: totals, the change, top centers and models, budgets at risk, anomalies, the recommendation', () => {
  const f = FIG();
  assert.deepEqual(f.week, WEEK);
  assert.deepEqual(f.totals, { listUSD: 44, billedUSD: 50.5 }, 'paid counts the plan fee');
  assert.deepEqual(f.change, { listUSD: 37, percent: 528.6 });
  assert.deepEqual(f.centers, [
    { id: 'lab', name: 'Lab', listUSD: 30 },
    { id: 'acme', name: 'Client: Acme', listUSD: 14 },
  ]);
  assert.deepEqual(f.models, [
    { model: 'claude-opus-5-5', listUSD: 30 },
    { model: 'claude-sonnet-5-5', listUSD: 14 },
  ]);
  assert.deepEqual(
    f.budgets.map((b) => b.id),
    ['team', 'acme'],
  );
  assert.ok(!('enforce' in f.budgets[0]));
  assert.ok(f.anomalies.some((a) => a.day === '2026-10-21' && a.spentUSD === 32));
  assert.deepEqual(f.recommendation, { model: 'claude-opus-5-5', candidate: 'claude-sonnet-5-5', savingUSD: 42.4 });
  assert.doesNotMatch(JSON.stringify(f), /secret-client/, 'no project folder');
  const strict = FIG({ anomalyParams: { ratio: 50, minUSD: 1 } });
  assert.deepEqual(strict.anomalies, [], 'the rule’s saved parameters decide');
  assert.equal(
    FIG({ rows: ledger().filter((r) => r.day >= WEEK.from) }).change.percent,
    null,
    'nothing the week before',
  );
  assert.equal(FIG({ recommendation: null }).recommendation, null);
  assert.throws(() => FIG({ unread: ['2026-10'] }), /the ledger could not read 2026-10/);
  assert.doesNotThrow(() => FIG({ unread: ['2026-08'] }), 'an older month only weakens the anomaly history');
});

test('the desktop line and the webhook body: numbers and names only, never a project folder or text', () => {
  const f = FIG();
  assert.equal(digestLine(f), 'ZAAFPulse weekly cost: $44.00 (+529 %), 2 budgets at risk, 1 anomaly');
  assert.equal(
    digestLine({ totals: { listUSD: 1412.3 }, change: { percent: -12.4 }, budgets: [{}], anomalies: [{}, {}] }),
    'ZAAFPulse weekly cost: $1,412.30 (-12 %), 1 budget at risk, 2 anomalies',
  );
  assert.equal(
    digestLine({ totals: { listUSD: 3 }, change: { percent: null } }),
    'ZAAFPulse weekly cost: $3.00, 0 budgets at risk, 0 anomalies',
  );
  const body = digestBody({
    ...f,
    centers: [{ id: 'acme', name: 'Acme\nInjected', listUSD: 1, project: '~/secret-client/app' }],
    extra: 'text',
  });
  assert.deepEqual(Object.keys(body), [
    'type',
    'week',
    'totals',
    'change',
    'centers',
    'models',
    'budgets',
    'anomalies',
    'recommendation',
  ]);
  assert.equal(body.type, 'cost_digest');
  assert.deepEqual(body.centers, [{ id: 'acme', name: 'Acme Injected', listUSD: 1 }]);
  assert.doesNotMatch(JSON.stringify(body), /secret-client|text/);
});

// A spawn that records each call and plays a child that exits cleanly (or fails).
function recorder(mode = 'ok') {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    calls.push({ cmd, args, opts });
    child.kill = () => {};
    setImmediate(() => child.emit('close', mode === 'fail' ? 1 : 0));
    return child;
  };
  return { calls, spawn };
}
const make = ({ settings, spawn, fetchImpl }) =>
  createChannels({
    spawn,
    fetchImpl,
    secrets: secretsFor({ HOOK: 'https://hooks.example/x' }),
    settings: () => settings,
    platform: 'darwin',
    sleep: () => Promise.resolve(),
  });

test('channels: the digest goes to the desktop as one line and to the webhook as its own body', async () => {
  const r = recorder();
  const sent = [];
  const fetchImpl = async (url, opts) => (sent.push({ url, body: JSON.parse(opts.body) }), { ok: true, status: 200 });
  const ch = make({ settings: { desktop: true, webhook: { url: { env: 'HOOK' } } }, spawn: r.spawn, fetchImpl });
  const out = await ch.digest(FIG());
  assert.deepEqual([out.desktop, out.webhook, out.tried, out.ok], [true, true, 2, true]);
  assert.deepEqual(r.calls[0].args.slice(-2), [
    'ZAAFPulse',
    'ZAAFPulse weekly cost: $44.00 (+529 %), 2 budgets at risk, 1 anomaly',
  ]);
  assert.equal(sent[0].url, 'https://hooks.example/x');
  assert.equal(sent[0].body.type, 'cost_digest');
  assert.doesNotMatch(JSON.stringify(sent[0].body), /secret-client/);

  const none = make({ settings: { desktop: false, webhook: null }, spawn: r.spawn, fetchImpl });
  assert.deepEqual(await none.digest(FIG()), { desktop: false, webhook: false, tried: 0, ok: false, errors: [] });
  const down = make({
    settings: { desktop: true, webhook: { url: { env: 'HOOK' } } },
    spawn: recorder('fail').spawn,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  const failed = await down.digest(FIG());
  assert.deepEqual([failed.ok, failed.tried, failed.errors.length], [false, 2, 2]);
});
