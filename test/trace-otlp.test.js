const test = require('node:test');
const assert = require('node:assert/strict');
const { createReceiver } = require('../lib/trace/otlp');
const { createRecorder } = require('../lib/trace/recorder');

const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const CLIENT = '00f067aa0ba902b7';
const memStore = () => {
  const spans = [];
  return { spans, writeSpans: (l) => (spans.push(...l), l.length) };
};
function known() {
  const store = memStore();
  const recorder = createRecorder({ store, flushMs: 0 });
  // The recorder saw this trace go out (the a2a client span).
  recorder.add({ traceId: T, spanId: CLIENT, parentSpanId: '', name: 'a2a far', kind: 3, startNs: 1n, endNs: 2n, attributes: {}, status: { code: 0 } });
  recorder.flush();
  store.spans.length = 0;
  return { store, recorder };
}
const span = (traceId, spanId, extra = {}) => ({
  traceId,
  spanId,
  parentSpanId: CLIENT,
  name: 'handle',
  kind: 2,
  startTimeUnixNano: '1792642201123456789',
  endTimeUnixNano: '1792642201223456789',
  attributes: [
    { key: 'http.route', value: { stringValue: '/a2a' } },
    { key: 'n', value: { intValue: '3' } },
  ],
  ...extra,
});

test('otlp: spans of a trace this ZAAFPulse started are kept; unknown, malformed and excess spans are refused', () => {
  const { store, recorder } = known();
  const recv = createReceiver({ recorder, maxPerTrace: 2 });
  const out = recv.receive({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'far-agent' } }] },
        scopeSpans: [
          {
            spans: [
              span(T, '1111111111111111', { status: { code: 2, message: 'boom' } }),
              span('f'.repeat(32), '2222222222222222'), // a trace ZAAFPulse did not start
              span(T, 'zz'), // malformed span id
              span(T, '3333333333333333'),
              span(T, '4444444444444444'), // over the per-trace limit
            ],
          },
        ],
      },
    ],
  });
  assert.equal(out.partialSuccess.rejectedSpans, 3);
  recorder.flush();
  assert.equal(store.spans.length, 2);
  const [a] = store.spans;
  assert.deepEqual(
    { t: a.t, p: a.p, k: a.k, src: a.src, svc: a.svc, st: a.st, d: a.d, ok: a.ok, err: a.err },
    { t: T, p: CLIENT, k: 'server', src: 'remote', svc: 'far-agent', st: 1792642201123456, d: 100000, ok: false, err: 'boom' },
  );
  assert.deepEqual(a.a, { 'http.route': '/a2a', n: 3 });
  assert.deepEqual(recv.receive({ resourceSpans: [] }), {});
  assert.deepEqual(recv.receive(null), {});
});

test('otlp: content attributes from outside are not kept either', () => {
  const { store, recorder } = known();
  createReceiver({ recorder }).receive({
    resourceSpans: [
      { scopeSpans: [{ spans: [span(T, '5555555555555555', { attributes: [{ key: 'gen_ai.input.messages', value: { stringValue: 'secret' } }] })] }] },
    ],
  });
  recorder.flush();
  assert.deepEqual(store.spans[0].a, {});
  assert.equal(store.spans[0].svc, 'remote');
});
