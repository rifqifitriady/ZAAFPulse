const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraceStore } = require('../lib/trace/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-trace-'));
const T1 = '1'.repeat(32);
const T2 = '2'.repeat(32);
const T3 = '3'.repeat(32);
const sp = (t, s, p = null, st = 1000, d = 10, a = {}) => ({
  t,
  s,
  p,
  n: `op ${s.slice(0, 2)}`,
  k: 'internal',
  st,
  d,
  ok: true,
  src: 'gateway',
  svc: 'zaafpulse',
  a,
});
const NOON = () => Date.UTC(2026, 9, 22, 12);

test('store: appended spans read back by trace; summaries and runs are kept', () => {
  const dir = tmp();
  const store = createTraceStore({ dir, now: NOON });
  const B = NOON() * 1000 - 3600e6; // an hour ago, in microseconds
  store.writeSpans([
    sp(T1, 'a'.repeat(16), null, B + 1000, 50, { 'zaafpulse.run.id': 'run_1' }),
    sp(T2, 'b'.repeat(16), null, B + 5000, 10),
    sp(T1, 'c'.repeat(16), 'a'.repeat(16), B + 1005, 2),
  ]);
  assert.deepEqual(store.getSpans(T1).map((s) => s.s), ['a'.repeat(16), 'c'.repeat(16)]);
  assert.equal(store.getSpans(T2).length, 1);
  assert.equal(store.getSpans('9'.repeat(32)), null);
  assert.equal(store.summaries().length, 2);
  assert.equal(store.getSummary(T1).spans, 2);
  assert.equal(store.byRun('run_1').traceId, T1);
  assert.equal(store.byRun('run_2'), null);
  const file = path.join(dir, '2026-10-22.ndjson');
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

test('store: a new instance loads the snapshot and reads only what was appended after it', () => {
  const dir = tmp();
  const a = createTraceStore({ dir, now: NOON });
  a.writeSpans([sp(T1, 'a'.repeat(16))]);
  a.snapshot();
  const snapFile = path.join(dir, 'index.json');
  assert.ok(fs.existsSync(snapFile));
  if (process.platform !== 'win32') assert.equal(fs.statSync(snapFile).mode & 0o777, 0o600);
  // Edit the snapshot on disk: a new instance must show this value, which only a load from the snapshot can give.
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  snap.traces.find((s) => s.traceId === T1).root = 'from-snapshot';
  fs.writeFileSync(snapFile, JSON.stringify(snap));
  a.writeSpans([sp(T2, 'b'.repeat(16))]);
  const b = createTraceStore({ dir, now: NOON });
  assert.equal(b.summaries().length, 2);
  assert.equal(b.getSummary(T1).root, 'from-snapshot');
  assert.equal(b.getSummary(T1).spans, 1);
  assert.equal(b.getSummary(T2).spans, 1);
});

test('store: one trace over two daily segments, with a foreign trace between, reads back whole after a restart', () => {
  const dir = tmp();
  let t = Date.UTC(2026, 9, 21, 12);
  const store = createTraceStore({ dir, now: () => t });
  store.writeSpans([sp(T1, 'a'.repeat(16), null, 1000, 10)]);
  t = Date.UTC(2026, 9, 22, 12);
  store.writeSpans([sp(T2, 'b'.repeat(16), null, 2000, 10), sp(T1, 'c'.repeat(16), 'a'.repeat(16), 1005, 2)]);
  const ids = (spans) => spans.map((s) => s.s).sort();
  const expected = ['a'.repeat(16), 'c'.repeat(16)];
  assert.deepEqual(ids(store.getSpans(T1)), expected);
  assert.deepEqual(Object.keys(store.getSummary(T1).ref).sort(), ['2026-10-21.ndjson', '2026-10-22.ndjson']);
  store.snapshot();
  const reopened = createTraceStore({ dir, now: () => t });
  assert.deepEqual(ids(reopened.getSpans(T1)), expected);
  assert.ok(reopened.getSpans(T1).every((s) => s.t === T1));
});

test('store: an existing folder with a looser mode is made private', () => {
  const dir = tmp();
  fs.chmodSync(dir, 0o755);
  createTraceStore({ dir, now: NOON });
  if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('store: a line cut short by a crash is closed and skipped; later writes stay intact', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '2026-10-22.ndjson'), JSON.stringify(sp(T1, 'a'.repeat(16))) + '\n{"t":"cut');
  const store = createTraceStore({ dir, now: NOON });
  store.writeSpans([sp(T2, 'b'.repeat(16))]);
  assert.equal(store.getSpans(T1).length, 1);
  assert.equal(store.getSpans(T2).length, 1);
  assert.equal(store.stats().skipped, 1);
});

test('store: retention deletes whole segments by age, then by size, never today', () => {
  const dir = tmp();
  let t = Date.UTC(2026, 9, 1, 12);
  const store = createTraceStore({ dir, now: () => t });
  store.writeSpans([sp(T1, 'a'.repeat(16), null, 1000, 1, { 'zaafpulse.run.id': 'run_old' })]);
  t = Date.UTC(2026, 9, 10, 12);
  store.writeSpans([sp(T2, 'b'.repeat(16))]);
  t = Date.UTC(2026, 9, 22, 12);
  assert.deepEqual(store.applyRetention().deleted, ['2026-10-01.ndjson']);
  assert.equal(store.getSummary(T1), null);
  assert.equal(store.byRun('run_old'), null);
  assert.ok(store.getSummary(T2));

  const small = createTraceStore({ dir, now: () => t, maxBytes: 1 });
  small.writeSpans([sp(T3, 'c'.repeat(16))]);
  assert.deepEqual(small.applyRetention().deleted, ['2026-10-10.ndjson']);
  assert.ok(small.getSummary(T3));
});

