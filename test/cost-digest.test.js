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

test('figures: an unread ledger folder fails the digest', () => {
  assert.throws(() => FIG({ unread: ['folder'] }), /the ledger could not read folder/);
});

test('last week around a daylight-saving weekend: Monday to Sunday, six days apart', () => {
  for (const [y, m, d] of [
    [2026, 2, 29], // clocks forward in Europe
    [2026, 9, 25], // clocks back in Europe
    [2026, 10, 1], // clocks back in the US
    [2026, 2, 8], // clocks forward in the US
  ]) {
    for (let i = 0; i < 14; i++) {
      const dt = new Date(y, m, d + i, 12);
      const today = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const w = R.lastWeek(today);
      const from = new Date(`${w.from}T12:00:00Z`);
      assert.equal(from.getUTCDay(), 1, `${today}: from is a Monday`);
      assert.equal(new Date(`${w.to}T12:00:00Z`).getUTCDay(), 0, `${today}: to is a Sunday`);
      assert.equal(w.to, addDays(w.from, 6));
      assert.ok(w.to < today && addDays(w.to, 7) >= today, `${today}: the week just before the current one`);
    }
  }
});

test('the digest body: a null list item, control characters, surrogate pairs and paths', () => {
  const body = digestBody({
    ...FIG(),
    centers: [
      null,
      'x',
      { id: 'a', name: 'A\u0085B\u2028C\u2029D', listUSD: 1 },
      { id: 'p', name: '/Users/me/app', listUSD: 2 },
    ],
    models: [
      { model: `${'a'.repeat(79)}\u{1F600}tail`, listUSD: 1 },
      { model: 'C:\\work\\app', listUSD: 1 },
      { model: 'c:/w', listUSD: 1 },
    ],
    budgets: [undefined, { id: 'b', name: '~/proj', state: 'ok' }],
    anomalies: [null],
  });
  assert.deepEqual(body.centers, [
    { id: 'a', name: 'A B C D', listUSD: 1 },
    { id: 'p', name: null, listUSD: 2 },
  ]);
  assert.equal(body.models[0].model, `${'a'.repeat(79)}\u{1F600}`, 'cut by code point, pair kept whole');
  assert.deepEqual([body.models[1].model, body.models[2].model], [null, null]);
  assert.equal(body.budgets.length, 1);
  assert.equal(body.budgets[0].name, null);
  assert.deepEqual(body.anomalies, []);
  assert.doesNotMatch(JSON.stringify(body), /Users|work|~/);
});

test('channels: desktop ok and webhook refused is a partial success; a bad figure sends nothing', async () => {
  const r = recorder();
  let fetches = 0;
  const ch = make({
    settings: { desktop: true, webhook: { url: { env: 'HOOK' } } },
    spawn: r.spawn,
    fetchImpl: async () => (fetches++, { ok: false, status: 500 }),
  });
  const out = await ch.digest(FIG());
  assert.deepEqual([out.desktop, out.webhook, out.ok, out.tried], [true, false, true, 2]);
  assert.equal(fetches, 4, 'the first try and three retries');
  assert.equal(r.calls.length, 1);

  const calls = r.calls.length;
  const bad = await ch.digest({
    ...FIG(),
    centers: [null],
    totals: {
      get listUSD() {
        throw new Error('boom');
      },
    },
  });
  assert.equal(bad.ok, false);
  assert.equal(r.calls.length, calls, 'no desktop notice was started');
  assert.equal(fetches, 4);
});

test('channels: a busy desktop is reported busy and does not log the alerts hint', async () => {
  const children = [];
  const logs = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.kill = () => {};
    children.push(child);
    return child;
  };
  const ch = createChannels({
    spawn,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    secrets: secretsFor({}),
    settings: () => ({ desktop: true, webhook: null }),
    platform: 'darwin',
    sleep: () => Promise.resolve(),
    log: (m) => logs.push(m),
  });
  const a = ch.digest(FIG());
  const b = ch.digest(FIG());
  const c = await ch.digest(FIG());
  assert.deepEqual(c.errors, ['desktop: busy']);
  assert.equal(c.ok, false);
  assert.deepEqual(logs, []);
  for (const child of children) child.emit('close', 0);
  await Promise.all([a, b]);
});
