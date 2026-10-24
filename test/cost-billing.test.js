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
const parseFile = (dir) => {
  const { entries, overrides, lostBefore } = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
  return { entries, overrides, lostBefore };
};

test('history: the first record dates from first use, a change starts on its day, the newest of a day wins, the past is never rewritten', () => {
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
  assert.equal(b.observe({ claude: PLAN }, '2026-10-20', {}), false, 'a clock that went back rewrites no entry');
  assert.deepEqual(b.billingFor('claude', '2026-10-23'), PLAN);
  assert.deepEqual(b.billingFor('claude', '2026-10-24'), METERED);
  assert.deepEqual(
    b.list().entries.filter((e) => e.source === 'claude').map((e) => [e.from, e.billing.mode]),
    [
      ['2026-10-15', 'plan'],
      ['2026-10-24', 'metered'],
    ],
  );
  const again = createBillingHistory({ dir });
  assert.deepEqual(again.list(), b.list());
  const text = (f) => fs.readFileSync(f, 'utf8');
  assert.equal(text(`${fileOf(dir)}.bak`), text(fileOf(dir)), 'the last good copy');
  if (process.platform !== 'win32')
    for (const f of [fileOf(dir), `${fileOf(dir)}.bak`]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
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
  assert.match(b.problems().join('\n'), /billing history was damaged and kept aside/);
  assert.ok(fs.existsSync(`${fileOf(dir)}.bad`));
  assert.equal(b.lost(), false, 'no earlier data: a first run');

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

test('recovery: a damaged or missing history comes back from its last good copy; a partly unusable one too', () => {
  for (const damage of ['{ nope', null, JSON.stringify({ version: 1, entries: [{ source: 'claude', from: 'x' }] })]) {
    const dir = tmp();
    const b = createBillingHistory({ dir });
    b.observe({ claude: PLAN }, '2026-10-22', { firstUse: () => '2026-10-15' });
    b.addOverride({ source: 'codex', from: '2026-10-16', to: '2026-10-17', billing: PLAN });
    const want = b.list();
    if (damage === null) fs.rmSync(fileOf(dir));
    else fs.writeFileSync(fileOf(dir), damage);
    const again = createBillingHistory({ dir, earlierData: () => true });
    assert.deepEqual(again.list(), want, String(damage));
    assert.equal(again.lost(), false);
    assert.match(again.problems().join('\n'), /recovered from its last good copy/);
    assert.doesNotMatch(again.problems().join('\n'), /zp-cost-billing/);
    assert.equal(fs.existsSync(`${fileOf(dir)}.bad`), damage !== null);
    assert.deepEqual(parseFile(dir), want, 'the file is written back');
  }
});

test('lost: with no good copy and earlier data, closed days are assumed metered and the history starts today', () => {
  const dir = tmp();
  const b = createBillingHistory({ dir });
  b.observe({ claude: PLAN }, '2026-10-22', { firstUse: () => '2026-10-15' });
  fs.writeFileSync(fileOf(dir), '{ nope');
  fs.writeFileSync(`${fileOf(dir)}.bak`, '[]');
  const lost = createBillingHistory({ dir, earlierData: () => true });
  assert.equal(lost.lost(), true);
  assert.deepEqual(lost.billingFor('claude', '2026-10-20'), { mode: 'metered', assumed: true });
  lost.observe({ claude: PLAN }, '2026-10-23', { firstUse: () => '2026-10-15' }); // first use is not used
  const claude = lost.list().entries.find((e) => e.source === 'claude');
  assert.deepEqual(claude, { source: 'claude', from: '2026-10-23', billing: PLAN });
  assert.equal(lost.billingFor('claude', '2026-10-22').assumed, true);
  assert.deepEqual(lost.billingFor('claude', '2026-10-23'), PLAN);
  assert.ok(lost.problems().includes('history lost: past days are billed as metered until restated'));
  lost.addOverride({ source: 'claude', from: '2026-10-15', to: '2026-10-22', billing: PLAN }); // a restate fixes it
  assert.deepEqual(lost.billingFor('claude', '2026-10-20'), PLAN);
  const later = createBillingHistory({ dir, earlierData: () => true });
  assert.equal(later.list().lostBefore, '2026-10-23', 'the loss is kept across restarts');
  assert.equal(later.billingFor('codex', '2026-10-20').assumed, true);
});

test('overrides are written only to a history that was set up: a lost one is dated first, and its loss is kept', () => {
  const dir = tmp();
  const b = createBillingHistory({ dir });
  b.observe({ claude: PLAN }, '2026-10-22', { firstUse: () => '2026-10-15' });
  fs.rmSync(fileOf(dir));
  fs.rmSync(`${fileOf(dir)}.bak`);
  const o = { source: 'claude', from: '2026-10-20', to: '2026-10-20', billing: PLAN };
  const lost = createBillingHistory({ dir, earlierData: () => true });
  assert.throws(() => lost.addOverride(o), { code: 'BILLING_NOT_READY' });
  assert.throws(() => lost.addOverrides([o]), { code: 'BILLING_NOT_READY' });
  assert.equal(fs.existsSync(fileOf(dir)), false, 'nothing was written');
  lost.ensure('2026-10-23');
  lost.addOverride(o);
  const later = createBillingHistory({ dir, earlierData: () => true });
  assert.equal(later.lost(), true);
  assert.deepEqual(parseFile(dir).lostBefore, '2026-10-23', 'the loss is kept');
  assert.equal(later.billingFor('claude', '2026-10-19').assumed, true);
  assert.deepEqual(later.billingFor('claude', '2026-10-20'), PLAN);

  const first = createBillingHistory({ dir: tmp() }); // a first run: set up by its first ensure
  assert.throws(() => first.addOverride(o), { code: 'BILLING_NOT_READY' });
  first.ensure('2026-10-23');
  first.addOverride(o);
  assert.equal(first.lost(), false);
});

test('overrides: one that a newer override of the same source covers is dropped; the billing is unchanged', () => {
  const b = createBillingHistory({ dir: tmp() });
  b.observe({}, '2026-10-22', { firstUse: () => '2026-10-01' });
  const o = (source, from, to, billing) => ({ source, from, to, billing });
  b.addOverrides([o('claude', '2026-10-05', '2026-10-06', PLAN), o('codex', '2026-10-05', '2026-10-06', PLAN)]);
  b.addOverride(o('claude', '2026-10-06', '2026-10-09', METERED)); // overlaps only: both kept
  b.addOverride(o('claude', '2026-10-04', '2026-10-06', PLAN)); // covers the first claude one
  b.addOverride(o('claude', '2026-10-04', '2026-10-06', PLAN)); // the same again: replaces it
  assert.deepEqual(
    b.list().overrides.map((x) => [x.source, x.from, x.to, x.billing.mode]),
    [
      ['codex', '2026-10-05', '2026-10-06', 'plan'],
      ['claude', '2026-10-06', '2026-10-09', 'metered'],
      ['claude', '2026-10-04', '2026-10-06', 'plan'],
    ],
  );
  for (const [day, mode] of [
    ['2026-10-03', 'metered'],
    ['2026-10-04', 'plan'],
    ['2026-10-06', 'plan'],
    ['2026-10-07', 'metered'],
  ])
    assert.equal(b.billingFor('claude', day).mode, mode, day);
});
