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

// A month file the store cannot read: no read permission where that holds (not on Windows, not as root), else a folder
// in its place. `restore` puts the readable file back.
function makeUnreadable(file) {
  const text = fs.readFileSync(file, 'utf8');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  if (byMode) fs.chmodSync(file, 0o000);
  else {
    fs.rmSync(file);
    fs.mkdirSync(file);
  }
  return {
    byMode,
    restore() {
      if (byMode) fs.chmodSync(file, 0o600);
      else {
        fs.rmSync(file, { recursive: true });
        fs.writeFileSync(file, text);
      }
    },
  };
}

const unreadCode = (e) => e.code === L.UNREAD;

test('store: a month that does not read is unavailable: it throws, is never written, and the others still work', () => {
  const dir = path.join(tmp(), 'cost');
  const seed = L.createLedgerStore({ dir });
  seed.load();
  for (const d of ['01', '02']) seed.put(row(`2026-09-${d}`));
  for (const d of ['01', '02']) seed.put(row(`2026-10-${d}`));
  seed.flush();
  const sep = path.join(dir, 'ledger-2026-09.jsonl');
  const oct = path.join(dir, 'ledger-2026-10.jsonl');
  const octBytes = fs.readFileSync(oct);
  const lineCount = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').length;
  const u = makeUnreadable(oct);
  try {
    const s = L.createLedgerStore({ dir });
    assert.throws(
      () => s.load(),
      (e) => unreadCode(e) && e.message === 'ledger month 2026-10 could not be read' && !e.message.includes(dir),
    );
    assert.deepEqual(s.unread(), ['2026-10']);
    assert.throws(() => s.put(row('2026-10-03')), unreadCode);
    assert.throws(() => s.get(row('2026-10-01')), unreadCode, 'not answered from an empty memory');
    assert.throws(() => s.day('2026-10-01'), unreadCode);
    assert.throws(() => s.remove(row('2026-10-01')), unreadCode);
    s.put(row('2026-09-03'));
    assert.throws(() => s.flush(), unreadCode, 'the error stays while a month is unavailable');
    assert.equal(lineCount(sep), 3, 'a readable month is written');
    // The reader view skips the month and says so, so the dashboard still shows the others.
    const v = s.view('2026-09-01', '2026-10-31');
    assert.deepEqual(v.map((r) => r.day).sort(), ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.deepEqual(v.unread, ['2026-10']);
    assert.deepEqual(L.groupRows(v, { groupBy: ['day'] }).unread, ['2026-10']);
    assert.deepEqual(s.view('2026-09-01', '2026-09-30').unread, []);
    assert.equal(s.earliestDay('claude'), '2026-09-01', 'a later unavailable month cannot hold an earlier day');
    assert.throws(() => s.earliestDay('codex'), unreadCode, 'it could, when nothing earlier was found');
    const before = { listUSD: 1, billedUSD: 1, priceVersion: 1, center: 'unassigned', unpriced: false };
    const c = (day) => ({
      ts: 1,
      from: day,
      to: day,
      reason: 'r',
      priceVersion: 2,
      rows: [{ key: L.rowKey(row(day)), before, after: { ...before, listUSD: 2, priceVersion: 2 } }],
    });
    assert.throws(() => s.addCorrection(c('2026-10-01')), unreadCode, 'a restate over a partial view is refused');
    s.addCorrection(c('2026-09-01'));
    if (!u.byMode) assert.ok(fs.statSync(oct).isDirectory());
    u.restore();
    assert.deepEqual(fs.readFileSync(oct), octBytes, 'the unavailable month is byte-identical on disk');
    s.flush(); // reads it now: nothing was held, so nothing is replayed
    assert.deepEqual(s.unread(), []);
    assert.equal(s.day('2026-10-01').length, 1);
    s.put(row('2026-10-03'));
    s.flush();
    const again = L.createLedgerStore({ dir });
    again.load();
    assert.equal(again.range('2026-10-01', '2026-10-31').length, 3);
    assert.equal(again.range('2026-09-01', '2026-09-30').length, 3);
  } finally {
    if (u.byMode && fs.existsSync(oct)) fs.chmodSync(oct, 0o600); // so the temp folder can be cleaned up
  }
});

test('store: before a load every month is unavailable; a flush lists the folder and then it works', () => {
  const dir = path.join(tmp(), 'cost');
  const seed = L.createLedgerStore({ dir });
  seed.load();
  seed.put(row('2026-10-01'));
  seed.put(row('2026-10-02'));
  seed.flush();
  const s = L.createLedgerStore({ dir });
  assert.throws(
    () => s.put(row('2026-10-03')),
    (e) => unreadCode(e) && e.message === 'the ledger folder could not be read',
  );
  assert.deepEqual(s.unread(), ['folder', 'corrections']);
  assert.deepEqual(s.view('2026-09-30', '2026-10-31').unread, ['2026-09', '2026-10', 'corrections']);
  s.flush();
  assert.deepEqual(s.unread(), []);
  s.put(row('2026-10-03'));
  s.flush();
  const again = L.createLedgerStore({ dir });
  again.load();
  assert.equal(again.range('2026-10-01', '2026-10-31').length, 3);
});

test('store: corrections that do not read refuse a new correction but leave the months writable', () => {
  const dir = path.join(tmp(), 'cost');
  const seed = L.createLedgerStore({ dir });
  seed.load();
  const base = row('2026-10-01');
  seed.put(base);
  seed.flush();
  const before = { listUSD: 1, billedUSD: 1, priceVersion: 1, center: 'unassigned', unpriced: false };
  const c = {
    ts: 1,
    from: '2026-10-01',
    to: '2026-10-01',
    reason: 'r',
    priceVersion: 2,
    rows: [{ key: L.rowKey(base), before, after: { ...before, listUSD: 2, priceVersion: 2 } }],
  };
  seed.addCorrection(c);
  const file = path.join(dir, 'corrections.jsonl');
  const u = makeUnreadable(file);
  try {
    const s = L.createLedgerStore({ dir });
    assert.throws(
      () => s.load(),
      (e) => e.code === L.CORRECTIONS_UNREAD && !e.message.includes(dir),
    );
    assert.deepEqual(s.unread(), ['corrections']);
    assert.deepEqual(s.view('2026-10-01', '2026-10-01').unread, ['corrections']);
    s.put(row('2026-10-02'));
    s.flush(); // the months are safe to write
    assert.throws(
      () => s.addCorrection(c),
      (e) => e.code === L.CORRECTIONS_UNREAD,
    );
    u.restore();
    s.flush();
    assert.deepEqual(s.unread(), []);
    assert.equal(s.view('2026-10-01', '2026-10-01')[0].listUSD, 2, 'the earlier restate shows once it reads');
  } finally {
    if (u.byMode && fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
});

test('store: a second load before a flush does not set the same bad lines aside again', () => {
  const dir = path.join(tmp(), 'cost');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger-2026-10.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(row('2026-10-01'))}\nnot json\n`);
  const s = L.createLedgerStore({ dir });
  s.load();
  s.load();
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8').split('\n').filter(Boolean).length, 1);
  assert.equal(s.badLines(), 0, 'the month was written again without it');
  assert.equal(s.range('2026-10-01', '2026-10-31').length, 1);
});

test('store: a row with a count that is not a number goes to .bad, so sums stay numbers', () => {
  const dir = path.join(tmp(), 'cost');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger-2026-10.jsonl');
  const good = row('2026-10-01', { tokens: { in: 3, out: 1 } });
  const lines = [
    good,
    row('2026-10-02', { tokens: { in: '5', out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }),
    row('2026-10-03', { webSearches: '2' }),
    row('2026-10-04', { tokens: { in: 1, prompt: 2 } }),
    row('2026-10-05', { requests: -1 }),
    row('2026-10-06', { listUSD: '1' }),
  ];
  fs.writeFileSync(file, lines.map((r) => JSON.stringify(r) + '\n').join(''));
  const s = L.createLedgerStore({ dir });
  s.load();
  assert.equal(s.badLines(), 5);
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8').split('\n').filter(Boolean).length, 5);
  const rows = s.range('2026-10-01', '2026-10-31');
  assert.deepEqual(rows[0].tokens, { in: 3, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  const g = L.groupRows(rows, { groupBy: ['source'] });
  assert.deepEqual([g.rows[0].tokens.in, g.rows[0].webSearches, g.totals.requests], [3, 0, 1]);
  assert.equal(L.tokenTotal(rows[0]), 4);
  assert.equal(L.tokenTotal({ tokens: { in: '5', out: 1 } }), 1, 'tokenTotal never returns a string');
  const m = L.mergeRows(good, { ...good, requests: '2', tokens: { in: '5' } });
  assert.deepEqual([m.requests, m.tokens.in], [1, 3]);
});

test('corrections: one that does not validate is skipped whole, counted and moved to .bad; totals stay', () => {
  const dir = path.join(tmp(), 'cost');
  const seed = L.createLedgerStore({ dir });
  seed.load();
  const base = row('2026-10-01', { center: 'a' });
  seed.put(base);
  seed.flush();
  const state = (listUSD, billedUSD) => ({ listUSD, billedUSD, priceVersion: 2, center: 'a', unpriced: false });
  const correction = (after, extra = {}) => ({
    ts: 1,
    from: '2026-10-01',
    to: '2026-10-01',
    reason: 'r',
    priceVersion: 2,
    rows: [{ key: L.rowKey(base), before: state(1, 1), after }],
    ...extra,
  });
  assert.throws(() => seed.addCorrection(correction(state(NaN, 1))), TypeError, 'NaN is refused on the way in');
  const file = path.join(dir, 'corrections.jsonl');
  const added = { ...L.newRow({ day: '2026-10-01', source: 'claude', kind: 'plan', plan: 'Max' }), billedUSD: '9' };
  fs.appendFileSync(
    file,
    [
      correction(state('x', 1)),
      correction(state(null, 1)), // NaN written as JSON
      correction(state(5, 5), { from: 'soon' }),
      correction(state(5, 5), {
        rows: [
          { key: L.rowKey(base), before: state(1, 1), after: state(4, 4) },
          { key: L.rowKey(added), before: null, after: state(0, 9), row: added },
        ],
      }),
      correction(state(3, 2)),
    ]
      .map((c) => JSON.stringify(c) + '\n')
      .join(''),
  );
  const s = L.createLedgerStore({ dir });
  s.load();
  assert.equal(s.corrections().length, 1);
  assert.equal(s.badLines(), 4);
  assert.equal(fs.readFileSync(`${file}.bad`, 'utf8').split('\n').filter(Boolean).length, 4);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1, 'moved, not copied');
  const v = s.view('2026-10-01', '2026-10-01');
  assert.equal(v.length, 1, 'no half-applied correction adds its row');
  assert.deepEqual([v[0].listUSD, v[0].billedUSD], [3, 2]);
  const g = L.groupRows(v, { groupBy: ['day'] });
  assert.deepEqual(g.totals, { requests: 1, listUSD: 3, billedUSD: 2 });
});

test('corrections: a torn last line does not swallow the next correction', () => {
  const dir = path.join(tmp(), 'cost');
  const s = L.createLedgerStore({ dir });
  s.load();
  const base = row('2026-10-01');
  s.put(base);
  s.flush();
  const file = path.join(dir, 'corrections.jsonl');
  fs.writeFileSync(file, '{"ts":1,"from":"2026-10-01","to":"2026-10-'); // a crash mid-append
  const before = { listUSD: 1, billedUSD: 1, priceVersion: 1, center: 'unassigned', unpriced: false };
  s.addCorrection({
    ts: 2,
    from: '2026-10-01',
    to: '2026-10-01',
    reason: 'r',
    priceVersion: 2,
    rows: [{ key: L.rowKey(base), before, after: { ...before, listUSD: 3, priceVersion: 2 } }],
  });
  const again = L.createLedgerStore({ dir });
  again.load();
  assert.equal(again.corrections().length, 1);
  assert.equal(again.badLines(), 1, 'only the torn line is bad');
  assert.equal(again.view('2026-10-01', '2026-10-01')[0].listUSD, 3);
});

test('corrections: written to disk, read back, and copies on the way in and out', () => {
  const dir = path.join(tmp(), 'cost');
  const s = L.createLedgerStore({ dir });
  s.load();
  const base = row('2026-10-01');
  s.put(base);
  s.flush();
  const before = { listUSD: 1, billedUSD: 1, priceVersion: 1, center: 'unassigned', unpriced: false };
  const c = {
    ts: 1,
    from: '2026-10-01',
    to: '2026-10-01',
    reason: 'r',
    priceVersion: 2,
    rows: [{ key: L.rowKey(base), before, after: { ...before, billedUSD: 0 } }],
  };
  s.addCorrection(c);
  c.rows[0].after.billedUSD = 50;
  s.corrections()[0].rows[0].after.billedUSD = 60;
  assert.equal(s.view('2026-10-01', '2026-10-01')[0].billedUSD, 0);
  if (process.platform !== 'win32') assert.equal(mode(path.join(dir, 'corrections.jsonl')), 0o600);
  const again = L.createLedgerStore({ dir });
  again.load();
  assert.equal(again.view('2026-10-01', '2026-10-01')[0].billedUSD, 0);
});
