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

test('store: appended spans read back by trace; summaries, runs and the covered window are kept', () => {
  const dir = tmp();
  const store = createTraceStore({ dir, now: NOON });
  store.writeSpans([
    sp(T1, 'a'.repeat(16), null, 1000, 50, { 'zaafpulse.run.id': 'run_1' }),
    sp(T2, 'b'.repeat(16), null, 5000, 10),
    sp(T1, 'c'.repeat(16), 'a'.repeat(16), 1005, 2),
  ]);
  assert.deepEqual(store.getSpans(T1).map((s) => s.s), ['a'.repeat(16), 'c'.repeat(16)]);
  assert.equal(store.getSpans(T2).length, 1);
  assert.equal(store.getSpans('9'.repeat(32)), null);
  assert.equal(store.summaries().length, 2);
  assert.equal(store.getSummary(T1).spans, 2);
  assert.equal(store.byRun('run_1').traceId, T1);
  assert.equal(store.byRun('run_2'), null);
  assert.deepEqual(store.covered(), { from: 1000, to: 5010 });
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
  a.writeSpans([sp(T2, 'b'.repeat(16))]);
  const b = createTraceStore({ dir, now: NOON });
  assert.equal(b.summaries().length, 2);
  assert.equal(b.getSummary(T1).spans, 1);
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
