const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecorder, toRecord } = require('../lib/trace/recorder');

const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const otelRec = (extra = {}) => ({
  traceId: T,
  spanId: '00f067aa0ba902b7',
  parentSpanId: '',
  name: 'chat m',
  kind: 3,
  startNs: 1792642201123456789n,
  endNs: 1792642201223456789n,
  attributes: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.input.messages': '[{"role":"user"}]',
    'gen_ai.output.messages': '[]',
    'gen_ai.system_instructions': '[]',
    'gen_ai.tool.call.arguments': '{}',
    'gen_ai.tool.call.result': 'x',
    'zaafpulse.cost.usd': 0.01,
  },
  status: { code: 0, message: '' },
  ...extra,
});
const memStore = () => {
  const spans = [];
  return { spans, writeSpans: (l) => (spans.push(...l), l.length) };
};

test('recorder: an OTel span becomes a record in microseconds, without content attributes', () => {
  const r = toRecord(otelRec());
  assert.deepEqual(r, {
    t: T,
    s: '00f067aa0ba902b7',
    p: null,
    n: 'chat m',
    k: 'client',
    st: 1792642201123456,
    d: 100000,
    ok: true,
    src: 'gateway',
    svc: 'zaafpulse',
    a: { 'gen_ai.operation.name': 'chat', 'zaafpulse.cost.usd': 0.01 },
  });
  const failed = toRecord(otelRec({ parentSpanId: 'b7ad6b7169203331', status: { code: 2, message: 'x'.repeat(500) } }));
  assert.equal(failed.ok, false);
  assert.equal(failed.err.length, 200);
  assert.equal(failed.p, 'b7ad6b7169203331');
});

test('recorder: buffers until flush, writes in one batch, and knows the trace IDs it saw', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  rec.add(otelRec());
  assert.equal(store.spans.length, 0);
  assert.equal(rec.flush(), 1);
  assert.equal(store.spans.length, 1);
  assert.equal(rec.knows(T), true);
  assert.equal(rec.knows('f'.repeat(32)), false);
  assert.deepEqual(rec.stats(), { buffered: 0, written: 1, dropped: 0, writeErrors: 0 });
});

test('recorder: off means nothing is kept; a full buffer drops and counts; a failed write never throws', () => {
  let on = false;
  const store = memStore();
  const rec = createRecorder({ store, enabled: () => on, flushMs: 0, batch: 100, maxBuffer: 2 });
  rec.add(otelRec());
  assert.equal(rec.stats().buffered, 0);
  on = true;
  rec.add(otelRec());
  rec.add(otelRec());
  rec.add(otelRec());
  assert.equal(rec.stats().dropped, 1);
  const broken = createRecorder({
    store: {
      writeSpans: () => {
        throw new Error('disk full');
      },
    },
    flushMs: 0,
    log: () => {},
  });
  broken.add(otelRec());
  assert.equal(broken.flush(), 0);
  assert.equal(broken.stats().writeErrors, 1);
});

test('recorder: a full batch is written at once; known trace IDs expire', () => {
  let t = 0;
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0, batch: 2, knownMs: 1000, now: () => t });
  rec.add(otelRec());
  rec.add(otelRec());
  assert.equal(store.spans.length, 2);
  t = 2000;
  assert.equal(rec.knows(T), false);
});

test('recorder: ingest takes ready records from the return channel', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  const r = { t: T, s: '1'.repeat(16), p: null, n: 'x', k: 'server', st: 1, d: 1, ok: true, src: 'remote', svc: 'far', a: {} };
  assert.equal(rec.ingest([r]), 1);
  rec.flush();
  assert.deepEqual(store.spans, [r]);
});
