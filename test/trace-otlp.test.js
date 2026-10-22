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
function known(opts = {}) {
  const store = memStore();
  const recorder = createRecorder({ store, flushMs: 0, ...opts });
  // This trace's traceparent went out to a remote agent (the a2a client span).
  recorder.expect(T);
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

const body = (spans, resource = { attributes: [{ key: 'service.name', value: { stringValue: 'far-agent' } }] }) => ({
  resourceSpans: [{ resource, scopeSpans: [{ spans }] }],
});

test('otlp: a trace whose spans were only recorded here, never sent out, is not accepted', () => {
  const store = memStore();
  const recorder = createRecorder({ store, flushMs: 0 });
  // A SERVER span of a request that came in with the caller's own traceparent.
  recorder.add({ traceId: T, spanId: CLIENT, parentSpanId: 'f'.repeat(16), name: 'POST /v1/chat/completions', kind: 2, startNs: 1000n, endNs: 2000n, attributes: {}, status: { code: 0 } });
  const out = createReceiver({ recorder }).receive(body([span(T, '1111111111111111')]));
  assert.equal(out.partialSuccess.rejectedSpans, 1);
});

test('otlp: spans without a start, starting at or before 0, or ending before they start are refused', () => {
  const { store, recorder } = known();
  const out = createReceiver({ recorder }).receive(
    body([
      span(T, '1111111111111111', { startTimeUnixNano: undefined }),
      span(T, '2222222222222222', { startTimeUnixNano: '0' }),
      span(T, '3333333333333333', { startTimeUnixNano: '-5000' }),
      span(T, '4444444444444444', { endTimeUnixNano: '1792642201023456789' }),
      span(T, '5555555555555555', { startTimeUnixNano: 'soon' }),
      span(T, '6666666666666666'),
    ]),
  );
  assert.equal(out.partialSuccess.rejectedSpans, 5);
  recorder.flush();
  assert.deepEqual(
    store.spans.map((s) => s.s),
    ['6666666666666666'],
  );
});

test('otlp: zaafpulse.* attributes and numbers that are not finite are dropped from remote spans', () => {
  const { store, recorder } = known();
  createReceiver({ recorder }).receive(
    body([
      span(T, '1111111111111111', {
        attributes: [
          { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
          { key: 'zaafpulse.cost.usd', value: { doubleValue: '1e309' } },
          { key: 'zaafpulse.run.id', value: { stringValue: 'run_x' } },
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '1e400' } },
          { key: 'gen_ai.usage.output_tokens', value: { doubleValue: 'NaN' } },
          { key: 'ratio', value: { doubleValue: 0.5 } },
        ],
      }),
    ]),
  );
  recorder.flush();
  assert.deepEqual(store.spans[0].a, { 'gen_ai.operation.name': 'chat', ratio: 0.5 });
});

test('otlp: malformed shapes never throw and are counted as rejected', () => {
  const { store, recorder } = known();
  const recv = createReceiver({ recorder });
  const shapes = [
    { resourceSpans: [{ scopeSpans: 'x' }] },
    { resourceSpans: [{ scopeSpans: [{ spans: { length: 2 } }] }] },
    { resourceSpans: 'x' },
    { resourceSpans: [null, 7] },
    body([span(T, '1111111111111111', { attributes: [{ key: 'k', value: 'str' }, { key: 'j', value: 5 }, { key: 'm', value: null }] })]),
  ];
  for (const b of shapes) assert.doesNotThrow(() => recv.receive(b));
  assert.equal(recv.receive({ resourceSpans: [{ scopeSpans: 'x' }, { scopeSpans: [{ spans: 3 }] }] }).partialSuccess.rejectedSpans, 2);
  recorder.flush();
  assert.equal(store.spans.length, 1);
});

test('otlp: spans the recorder drops are reported as rejected', () => {
  const { store, recorder } = known({ maxBuffer: 1 });
  const out = createReceiver({ recorder }).receive(body([span(T, '1111111111111111'), span(T, '2222222222222222')]));
  assert.equal(out.partialSuccess.rejectedSpans, 1);
  recorder.flush();
  assert.equal(store.spans.length, 1);
});

test('otlp: spans from a resource named zaafpulse (our own export pointed back here) are refused', () => {
  const { store, recorder } = known();
  const out = createReceiver({ recorder }).receive(
    body([span(T, '1111111111111111'), span(T, '2222222222222222')], { attributes: [{ key: 'service.name', value: { stringValue: 'zaafpulse' } }] }),
  );
  assert.equal(out.partialSuccess.rejectedSpans, 2);
  recorder.flush();
  assert.equal(store.spans.length, 0);
});

test('otlp: past maxTraces the oldest trace counts are forgotten, recent ones keep their limit', () => {
  const store = memStore();
  const recorder = createRecorder({ store, flushMs: 0 });
  const ids = ['1', '2', '3'].map((c) => c.repeat(32));
  for (const t of ids) recorder.expect(t);
  const recv = createReceiver({ recorder, maxPerTrace: 1, maxTraces: 2 });
  for (const t of ids) assert.deepEqual(recv.receive(body([span(t, 'a'.repeat(16))])), {});
  // The most recent trace is still counted, so its limit holds.
  assert.equal(recv.receive(body([span(ids[2], 'b'.repeat(16))])).partialSuccess.rejectedSpans, 1);
  // The oldest one was forgotten to stay within maxTraces.
  assert.deepEqual(recv.receive(body([span(ids[0], 'b'.repeat(16))])), {});
});
