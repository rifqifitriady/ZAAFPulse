const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBillingHistory } = require('../lib/cost/billing');
const { billedRows } = require('../lib/cost/billing-view');
const L = require('../lib/cost/ledger');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-billing-'));
const PLAN = { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' };
const METERED = { mode: 'metered' };
const fileOf = (dir) => path.join(dir, 'billing.json');

test('history: the first record dates from first use, a change starts on its day, the newest of a day wins', () => {
  const dir = tmp();
  const b = createBillingHistory({ dir });
  assert.deepEqual(b.billingFor('claude', '2026-10-01'), METERED, 'no entry is metered');
  const firstUse = (s) => (s === 'claude' ? '2026-10-15' : null);
  assert.equal(b.observe({ claude: PLAN }, '2026-10-22', { firstUse }), true);
  assert.deepEqual(b.billingFor('claude', '2026-10-14'), METERED, 'before first use');
  assert.deepEqual(b.billingFor('claude', '2026-10-15'), PLAN);
  assert.deepEqual(b.billingFor('codex', '2026-10-22'), METERED);
  assert.equal(b.observe({ claude: PLAN }, '2026-10-23', {}), false, 'unchanged: nothing written');
  b.observe({ claude: { ...PLAN, feeUSD: 365, period: 'year' } }, '2026-10-24', {});
  b.observe({}, '2026-10-24', {}); // switched again the same day: that one wins
  assert.deepEqual(b.billingFor('claude', '2026-10-23'), PLAN);
  assert.deepEqual(b.billingFor('claude', '2026-10-24'), METERED);
  b.observe({ claude: PLAN }, '2026-10-20', {}); // a clock that went back: never dated before the last entry
  assert.deepEqual(b.billingFor('claude', '2026-10-23'), PLAN);
  assert.deepEqual(b.billingFor('claude', '2026-10-24'), PLAN);
  assert.deepEqual(
    b.list().entries.filter((e) => e.source === 'claude').map((e) => [e.from, e.billing.mode]),
    [
      ['2026-10-15', 'plan'],
      ['2026-10-24', 'plan'],
    ],
  );
  const again = createBillingHistory({ dir });
  assert.deepEqual(again.list(), b.list());
  if (process.platform !== 'win32') assert.equal(fs.statSync(fileOf(dir)).mode & 0o777, 0o600);
});

test('history: a source left for later is not recorded, and without firstUse a source with no entry is left alone', () => {
  const b = createBillingHistory({ dir: null });
  b.observe({ claude: PLAN }, '2026-10-22', { firstUse: () => undefined });
  assert.equal(b.has('claude'), false);
  b.observe({ claude: PLAN }, '2026-10-22', {});
  assert.equal(b.has('claude'), false);
  b.observe({ claude: PLAN }, '2026-10-22', { firstUse: () => null }); // never used: from today
  assert.deepEqual(b.list().entries.find((e) => e.source === 'claude').from, '2026-10-22');
});

test('overrides: a restated range is billed as restated, the latest override wins, and bad ones are refused', () => {
  const dir = tmp();
  const b = createBillingHistory({ dir });
  b.observe({}, '2026-10-22', { firstUse: () => '2026-10-01' });
  b.addOverride({ source: 'claude', from: '2026-10-05', to: '2026-10-10', billing: PLAN });
  b.addOverride({ source: 'claude', from: '2026-10-08', to: '2026-10-08', billing: METERED });
  assert.deepEqual(b.billingFor('claude', '2026-10-04'), METERED);
  assert.deepEqual(b.billingFor('claude', '2026-10-05'), PLAN);
  assert.deepEqual(b.billingFor('claude', '2026-10-08'), METERED);
  assert.deepEqual(b.billingFor('claude', '2026-10-10'), PLAN);
  assert.deepEqual(b.billingFor('codex', '2026-10-05'), METERED);
  for (const bad of [
    { source: 'nope', from: '2026-10-01', to: '2026-10-02', billing: PLAN },
    { source: 'claude', from: '2026-10-03', to: '2026-10-02', billing: PLAN },
    {
      source: 'claude',
      from: '2026-10-01',
      to: '2026-10-02',
      billing: { mode: 'plan', plan: '', feeUSD: 1, period: 'month' },
    },
  ])
    assert.throws(() => b.addOverride(bad), TypeError);
  assert.deepEqual(createBillingHistory({ dir }).billingFor('claude', '2026-10-06'), PLAN, 'kept on disk');
});

test('a billing file that does not parse is kept aside; one that does not read is never overwritten', () => {
  const dir = tmp();
  fs.writeFileSync(fileOf(dir), '{ nope');
  const b = createBillingHistory({ dir });
  assert.match(b.problems().join('\n'), /billing history was unreadable/);
  assert.ok(fs.existsSync(`${fileOf(dir)}.bad`));

  const dir2 = tmp();
  const ok = createBillingHistory({ dir: dir2 });
  ok.observe({ claude: PLAN }, '2026-10-22', { firstUse: () => '2026-10-20' });
  const bytes = fs.readFileSync(fileOf(dir2));
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  if (byMode) fs.chmodSync(fileOf(dir2), 0o000);
  else {
    fs.rmSync(fileOf(dir2));
    fs.mkdirSync(fileOf(dir2));
  }
  const blocked = createBillingHistory({ dir: dir2 });
  try {
    assert.equal(blocked.error().code, 'BILLING_UNREAD');
    assert.doesNotMatch(blocked.error().message, /zp-cost-billing/);
    assert.throws(() => blocked.observe({}, '2026-10-23', {}), (e) => e.code === 'BILLING_UNREAD');
    assert.throws(() => blocked.addOverride({ source: 'claude', from: '2026-10-01', to: '2026-10-02', billing: PLAN }));
  } finally {
    if (byMode) fs.chmodSync(fileOf(dir2), 0o600);
    else {
      fs.rmSync(fileOf(dir2), { recursive: true });
      fs.writeFileSync(fileOf(dir2), bytes);
    }
  }
  assert.deepEqual(fs.readFileSync(fileOf(dir2)), bytes);
  assert.equal(blocked.observe({}, '2026-10-23', {}), true, 'read again once it reads');
  assert.equal(blocked.error(), null);
  assert.deepEqual(blocked.billingFor('claude', '2026-10-21'), PLAN);
});

test('read side: usage is billed by the day it was on, one plan row per plan day up to today, stored plan rows ignored', () => {
  const b = createBillingHistory({ dir: null });
  b.seed([{ source: 'claude', from: '2026-10-21', billing: PLAN }]);
  const use = (day, source) => ({
    ...L.newRow({ day, source, kind: 'chat' }),
    requests: 1,
    listUSD: 0.5,
    billedUSD: 0.5,
  });
  const stale = L.planRow('2026-10-20', 'codex', { mode: 'plan', plan: 'Old', feeUSD: 31, period: 'month' });
  const list = [use('2026-10-20', 'claude'), use('2026-10-21', 'claude'), use('2026-10-21', 'codex'), stale];
  const rows = Object.defineProperty(list, 'unread', { value: ['2026-11'] });
  const out = billedRows(rows, { from: '2026-10-20', to: '2026-11-02', today: '2026-11-01', billingFor: b.billingFor });
  const pick = (day, source, kind) => out.filter((r) => r.day === day && r.source === source && r.kind === kind);
  assert.equal(pick('2026-10-20', 'claude', 'chat')[0].billedUSD, 0.5);
  assert.equal(pick('2026-10-20', 'claude', 'plan').length, 0);
  assert.equal(pick('2026-10-21', 'claude', 'chat')[0].billedUSD, 0);
  assert.equal(pick('2026-10-21', 'claude', 'plan').length, 1);
  assert.equal(pick('2026-10-21', 'codex', 'chat')[0].billedUSD, 0.5);
  assert.equal(out.filter((r) => r.source === 'codex' && r.kind === 'plan').length, 0, 'a stored plan row is ignored');
  assert.equal(out.filter((r) => r.kind === 'plan').length, 11, 'Oct 21 to 31; November did not read');
  assert.deepEqual(out.unread, ['2026-11']);
});
