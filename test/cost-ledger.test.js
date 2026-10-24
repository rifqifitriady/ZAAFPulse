// test/cost-ledger.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/cost/ledger');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-ledger-'));
const mode = (p) => fs.statSync(p).mode & 0o777;
const row = (day, extra = {}) => ({
  ...L.newRow({
    day,
    source: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
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

test('store: rows by month in private files; put replaces by key; reads are copies', () => {
  const dir = path.join(tmp(), 'cost');
  const s = L.createLedgerStore({ dir });
  s.load();
  s.put(row('2026-09-30'));
  s.put(row('2026-10-01'));
  s.put(row('2026-10-01', { listUSD: 2 }));
  s.put(row('2026-10-02', { source: 'codex' }));
  s.flush();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ledger-2026-09.jsonl', 'ledger-2026-10.jsonl']);
  if (process.platform !== 'win32') {
    assert.equal(mode(dir), 0o700);
    for (const f of fs.readdirSync(dir)) assert.equal(mode(path.join(dir, f)), 0o600, f);
  }
  const again = L.createLedgerStore({ dir });
  again.load();
  assert.equal(again.get(row('2026-10-01')).listUSD, 2);
  assert.equal(again.day('2026-10-01').length, 1);
  assert.deepEqual(
    again
      .range('2026-09-30', '2026-10-01')
      .map((r) => r.day)
      .sort(),
    ['2026-09-30', '2026-10-01'],
  );
  assert.equal(again.earliestDay('claude'), '2026-09-30');
  assert.equal(again.earliestDay('codex'), '2026-10-02');
  assert.equal(again.earliestDay('gateway'), null);
  const copy = again.get(row('2026-10-01'));
  copy.listUSD = 99;
  assert.equal(again.get(row('2026-10-01')).listUSD, 2, 'reads are copies');
  again.remove(row('2026-10-01'));
  assert.equal(again.get(row('2026-10-01')), null);
});

test('store: a corrupt line goes to .bad (0600) and the month still loads', () => {
  const dir = path.join(tmp(), 'cost');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger-2026-10.jsonl');
  // The second bad line is valid JSON for the wrong month.
  fs.writeFileSync(file, `${JSON.stringify(row('2026-10-01'))}\nnot json\n${JSON.stringify(row('2026-09-30'))}\n`);
  const s = L.createLedgerStore({ dir });
  s.load();
  assert.equal(s.range('2026-09-01', '2026-10-31').length, 1);
  assert.equal(s.badLines(), 2);
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8').split('\n').filter(Boolean).length, 2);
  if (process.platform !== 'win32') assert.equal(mode(`${file}.bad`), 0o600);
  s.flush();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'the month is written again without them');
});

test('view: a correction moves amounts by after - before, so later growth still counts; an added row shows in range', () => {
  const s = L.createLedgerStore();
  const base = row('2026-10-01', { center: 'a' });
  s.put(base);
  const before = { listUSD: 1, billedUSD: 1, priceVersion: 1, center: 'a', unpriced: false };
  const after = { listUSD: 2, billedUSD: 0, priceVersion: 2, center: 'b', unpriced: false };
  const plan = L.planRow('2026-10-01', 'claude', { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' }, false);
  s.addCorrection({
    ts: 1,
    from: '2026-10-01',
    to: '2026-10-01',
    reason: 'r',
    priceVersion: 2,
    rows: [
      { key: L.rowKey(base), before, after },
      { key: L.rowKey(plan), before: null, after: { ...after, listUSD: 0, billedUSD: 10 }, row: plan },
    ],
  });
  let v = s.view('2026-10-01', '2026-10-01');
  const use = v.find((r) => r.kind === 'chat');
  assert.deepEqual([use.listUSD, use.billedUSD, use.center, use.priceVersion], [2, 0, 'b', 2]);
  assert.equal(v.find((r) => r.kind === 'plan').billedUSD, 10);
  s.put({ ...base, requests: 2, listUSD: 1.5, billedUSD: 1.5 }); // a late event, priced at the day's version
  v = s.view('2026-10-01', '2026-10-01');
  assert.equal(v.find((r) => r.kind === 'chat').listUSD, 2.5);
  assert.equal(s.view('2026-10-02', '2026-10-31').length, 0, 'out of range');
  assert.equal(s.get(base).center, 'a', 'the stored row is unchanged');
});

test('groupRows: sums by dimension, flags are "any row", amounts convert with the rate of each day', () => {
  const rows = [
    row('2026-10-01', { center: 'a', tokens: { in: 10, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }),
    row('2026-10-01', { center: 'b', model: 'm2', listUSD: 2, billedUSD: 0, unpriced: true }),
    row('2026-10-02', { center: 'a', listUSD: 4, billedUSD: 4, backfilled: true }),
  ];
  const g = L.groupRows(rows, { groupBy: ['center'] });
  assert.deepEqual(
    g.rows.map((x) => [x.center, x.requests, x.listUSD, x.billedUSD, x.unpriced, x.backfilled, x.tokens.in]),
    [
      ['a', 2, 5, 5, false, true, 10],
      ['b', 1, 2, 0, true, false, 0],
    ],
  );
  assert.deepEqual(g.totals, { requests: 3, listUSD: 7, billedUSD: 5 });
  const c = L.groupRows(rows, { groupBy: ['day'], rateOf: (d) => (d === '2026-10-01' ? 16000 : null) });
  assert.deepEqual(
    c.rows.map((x) => [x.day, x.list, x.billed]),
    [
      ['2026-10-01', 48000, 16000],
      ['2026-10-02', null, null],
    ],
  );
  assert.equal(c.missingRate, 1);
  assert.deepEqual([c.totals.list, c.totals.billed, c.totals.listUSD], [null, null, 7]);
});

test('keys: geo and plan are part of the key, baseKey leaves the center out, mergeRows adds', () => {
  assert.notEqual(L.rowKey(row('2026-10-01')), L.rowKey(row('2026-10-01', { geo: 'us' })));
  assert.equal(L.baseKey(row('2026-10-01', { center: 'a' })), L.baseKey(row('2026-10-01', { center: 'b' })));
  const m = L.mergeRows(row('2026-10-01', { unpriced: true }), row('2026-10-01', { priceVersion: 3 }));
  assert.deepEqual([m.requests, m.listUSD, m.billedUSD, m.priceVersion, m.unpriced], [2, 2, 2, 3, true]);
  assert.equal(L.tokenTotal({ tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 } }), 15);
});
