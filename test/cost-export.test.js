// Cost Control 5: lib/cost/export.js, the ledger grouping as CSV or JSON. Pure: a grouped ledger answer in, text out.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../lib/cost/export');

const tokens = (i, o, cr = 0, w5 = 0, w1 = 0) => ({ in: i, out: o, cacheRead: cr, cacheWrite5m: w5, cacheWrite1h: w1 });
const LED = {
  from: '2026-10-01',
  to: '2026-10-29',
  groupBy: ['model', 'project'],
  currency: 'USD',
  rows: [
    { model: 'opus', project: '~/acme', requests: 3, tokens: tokens(100, 20, 5, 2, 1), listUSD: 1.5, billedUSD: 0 },
    { model: 'sonnet', project: null, requests: 2, tokens: tokens(10, 2), listUSD: 0.12345678912, billedUSD: 0.1 },
    { model: null, project: null, requests: 0, tokens: tokens(0, 0), listUSD: 0, billedUSD: 6.4516129 }, // a plan fee
  ],
  unread: [],
};

test('export rows: the groupBy dimensions, then the counts and the USD amounts; a plan fee only under paid', () => {
  assert.deepEqual(X.columnsOf(['model'], 'USD'), ['model', ...X.COLUMNS]);
  assert.deepEqual(X.columnsOf(['day'], 'IDR').slice(-2), ['listIDR', 'billedIDR']);
  const list = X.exportRows(LED, { measure: 'list' });
  assert.equal(list.length, 2, 'the plan fee row has no usage value');
  assert.deepEqual(list[0], {
    model: 'opus',
    project: '~/acme',
    requests: 3,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    listUSD: 1.5,
    billedUSD: 0,
  });
  assert.equal(X.exportRows(LED, { measure: 'billed' }).length, 3);
  const idr = X.exportRows(
    { ...LED, currency: 'IDR', rows: [{ ...LED.rows[0], list: 24375, billed: null }] },
    { measure: 'list' },
  );
  assert.deepEqual([idr[0].listIDR, idr[0].billedIDR], [24375, null]);
  const t = X.totalsOf(X.exportRows(LED, { measure: 'billed' }), 'USD');
  assert.deepEqual([t.requests, t.inputTokens, t.cacheWriteTokens], [5, 110, 3]);
  assert.equal(t.listUSD, 1.62345679);
  assert.equal(t.billedUSD, 6.5516129);
  const ti = X.totalsOf(idr, 'IDR');
  assert.deepEqual([ti.listIDR, ti.billedIDR], [24375, null], 'a day without a rate makes that total null');
});

test('csv: RFC 4180 with CRLF, quotes doubled, formula cells prefixed, plain numbers', () => {
  assert.equal(X.csvCell('plain'), 'plain');
  assert.equal(X.csvCell('a,b'), '"a,b"');
  assert.equal(X.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(X.csvCell('two\nlines'), '"two\nlines"');
  for (const bad of ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx', '\rx'])
    assert.equal(X.csvCell(bad).replace(/^"/, '')[0], "'", JSON.stringify(bad));
  assert.equal(X.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"', 'prefixed, then quoted');
  assert.equal(X.csvCell(null), '');
  assert.equal(X.csvCell(12), '12');
  assert.equal(X.csvCell(0.1, { amount: true }), '0.10000000');
  assert.equal(X.csvCell(1234567.5, { amount: true }), '1234567.50000000', 'no thousands separator');
  assert.equal(X.csvCell(-0.5, { amount: true }), '-0.50000000', 'a number is never prefixed');
  const rows = X.exportRows(LED, { measure: 'list' });
  const text = X.toCsv({ groupBy: LED.groupBy, currency: 'USD', rows, unread: [] });
  const lines = text.split('\r\n');
  assert.equal(lines.pop(), '', 'every line ends with CRLF');
  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    'model,project,requests,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,listUSD,billedUSD',
  );
  assert.equal(lines[1], 'opus,~/acme,3,100,20,5,3,1.50000000,0.00000000');
  assert.equal(lines[2], 'sonnet,,2,10,2,0,0,0.12345679,0.10000000');
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /[\r\n]/, 'no bare line end');
});

test('csv: the display currency adds two columns, and an unread month is a last comment line', () => {
  const led = { ...LED, currency: 'IDR', rows: [{ ...LED.rows[0], list: 24375.5, billed: null }] };
  const text = X.toCsv({
    groupBy: led.groupBy,
    currency: 'IDR',
    rows: X.exportRows(led, { measure: 'list' }),
    unread: ['2026-09', 'corrections'],
  });
  const lines = text.split('\r\n');
  assert.match(lines[0], /,listUSD,billedUSD,listIDR,billedIDR$/);
  assert.match(lines[1], /,1\.50000000,0\.00000000,24375\.50000000,$/, 'no rate: an empty cell');
  assert.equal(lines[2], '# unread: 2026-09, corrections');
  const evil = X.toCsv({
    groupBy: ['project'],
    currency: 'USD',
    rows: X.exportRows({ groupBy: ['project'], rows: [{ project: '=cmd|"/c calc"!A1', requests: 1, listUSD: 1 }] }),
  });
  assert.equal(evil.split('\r\n')[1].split(',')[0], '"\'=cmd|""/c calc""!A1"');
});

test('json: the range, the grouping, the rows as the CSV has them, the totals and what did not read', () => {
  const rows = X.exportRows(LED, { measure: 'billed' });
  const j = X.toJson({
    from: LED.from,
    to: LED.to,
    groupBy: LED.groupBy,
    currency: 'USD',
    measure: 'billed',
    rows,
    unread: ['2026-09'],
  });
  assert.deepEqual(Object.keys(j), ['from', 'to', 'groupBy', 'currency', 'measure', 'rows', 'totals', 'unread']);
  assert.equal(j.rows.length, 3);
  assert.deepEqual(j.unread, ['2026-09']);
  assert.equal(j.totals.requests, 5);
  assert.equal(X.fileName('2026-10-01', '2026-10-29', 'csv'), 'zaafpulse-cost-2026-10-01-2026-10-29.csv');
});

test('size: more than 100,000 rows is a 413 that says what to do', () => {
  assert.equal(X.MAX_ROWS, 100000);
  X.checkSize(new Array(3), 3);
  assert.throws(
    () => X.checkSize(new Array(4), 3),
    (e) => e.status === 413 && e.message === 'too many rows; narrow the range or group by fewer dimensions',
  );
});
