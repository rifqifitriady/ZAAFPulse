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
// Built at run time so no secret-looking string sits in the source.
const fakeKey = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return 'sk-' + 'ant-api03-' + Array.from({ length: 48 }, (_, i) => chars[(i * 7) % 36]).join('');
};
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

test('recorder: buffers until flush, writes in one batch; knows only the trace IDs it was told went out', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  rec.add(otelRec());
  assert.equal(store.spans.length, 0);
  assert.equal(rec.flush(), 1);
  assert.equal(store.spans.length, 1);
  // A stored span (here or a SERVER span continuing a caller's traceparent) does not make its trace known.
  assert.equal(rec.knows(T), false);
  rec.add(otelRec({ kind: 2, parentSpanId: 'f'.repeat(16), name: 'POST /v1/chat/completions' }));
  assert.equal(rec.flush(), 1);
  assert.equal(rec.knows(T), false);
  rec.expect(T);
  assert.equal(rec.knows(T), true);
  assert.equal(rec.knows('f'.repeat(32)), false);
  for (const bad of ['0'.repeat(32), 'xyz', null, 42]) {
    assert.doesNotThrow(() => rec.expect(bad));
    assert.equal(rec.knows(bad), false);
  }
  assert.deepEqual(rec.stats(), { buffered: 0, written: 2, dropped: 0, writeErrors: 0 });
});

test('recorder: off means nothing is kept; a full buffer drops and counts; a failed write never throws', () => {
  let on = false;
  const store = memStore();
  const rec = createRecorder({ store, enabled: () => on, flushMs: 0, batch: 100, maxBuffer: 2 });
  rec.add(otelRec());
  rec.expect(T);
  assert.equal(rec.stats().buffered, 0);
  assert.equal(rec.knows(T), false);
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
  broken.add(otelRec());
  assert.equal(broken.flush(), 0);
  assert.equal(broken.stats().writeErrors, 1);
  assert.equal(broken.stats().dropped, 2);
  const odd = createRecorder({ store: { writeSpans: () => undefined }, flushMs: 0 });
  odd.add(otelRec());
  odd.flush();
  assert.equal(odd.stats().written, 0);
});

test('recorder: a full batch is written at once; known trace IDs expire', async () => {
  let t = 0;
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0, batch: 2, knownMs: 1000, now: () => t });
  rec.expect(T);
  rec.add(otelRec());
  rec.add(otelRec());
  assert.equal(store.spans.length, 0); // never on the request path
  await new Promise((res) => setImmediate(res));
  assert.equal(store.spans.length, 2);
  assert.equal(rec.knows(T), true);
  t = 2000;
  assert.equal(rec.knows(T), false);
});

test('recorder: ingest takes ready records from the return channel', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  const base = { t: T, s: '1'.repeat(16), p: null, n: 'x', k: 'server', st: 1, d: 1, ok: true };
  const r = { ...base, src: 'remote', svc: 'far', a: {} };
  assert.equal(rec.ingest([r]), 1);
  rec.flush();
  assert.deepEqual(store.spans, [r]);
});

test('recorder: maxBuffer drops spans beyond it within one tick; the flush is scheduled once', async () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0, batch: 2, maxBuffer: 3 });
  for (let i = 0; i < 5; i++) rec.add(otelRec());
  assert.equal(rec.stats().dropped, 2);
  await new Promise((res) => setImmediate(res));
  assert.equal(store.spans.length, 3);
  assert.equal(rec.stats().written, 3);
});

test('recorder: err is masked and cut to 200 characters', () => {
  const key = fakeKey();
  const r = toRecord(otelRec({ status: { code: 2, message: `bad header ${key} rejected` } }));
  assert.equal(r.err.includes(key), false);
  assert.match(r.err, /hidden/);
  const long = toRecord(otelRec({ status: { code: 2, message: 'a'.repeat(199) + '\u{1F600}' } }));
  assert.ok(long.err.length <= 200);
  assert.equal(/[\ud800-\udbff]$/.test(long.err), false);
});

test('recorder: a span that cannot be converted is dropped and its trace stays unknown', () => {
  const rec = createRecorder({ store: memStore(), flushMs: 0 });
  assert.doesNotThrow(() => rec.add({ traceId: T }));
  assert.equal(rec.knows(T), false);
  assert.equal(rec.stats().dropped, 1);
});

test('recorder: the oldest known trace IDs are forgotten past maxKnown', () => {
  const rec = createRecorder({ store: memStore(), flushMs: 0, maxKnown: 3 });
  const id = (i) => String(i).padStart(32, '0');
  for (let i = 1; i <= 5; i++) rec.expect(id(i));
  assert.equal(rec.knows(id(1)), false);
  assert.equal(rec.knows(id(2)), false);
  for (let i = 3; i <= 5; i++) assert.equal(rec.knows(id(i)), true);
  // Sent out again, a trace is recent again: the next one to go is the oldest of the others.
  rec.expect(id(3));
  rec.expect(id(6));
  assert.equal(rec.knows(id(4)), false);
  for (const i of [3, 5, 6]) assert.equal(rec.knows(id(i)), true);
});

test('recorder: ingest never throws, keeps only well-formed records, strips content and masks err', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  assert.equal(rec.ingest(null), 0);
  assert.equal(rec.ingest(42), 0);
  const key = fakeKey();
  const good = { t: T, s: '1'.repeat(16), p: null, n: 'x', k: 'server', st: 1, d: 1, ok: false, src: 'r', svc: 'f' };
  const withContent = { ...good, err: `leak ${key}`, a: { 'gen_ai.input.messages': 'secret', 'gen_ai.request.model': 'm' } };
  const bad = [null, 'x', { ...good, t: 'zz' }, { ...good, s: '1' }];
  assert.equal(rec.ingest([withContent, ...bad]), 1);
  assert.equal(rec.stats().dropped, 4);
  rec.flush();
  assert.equal(store.spans.length, 1);
  assert.deepEqual(store.spans[0].a, { 'gen_ai.request.model': 'm' });
  assert.equal(store.spans[0].err.includes(key), false);
});

test('recorder: ingest rebuilds each record from the named fields only', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  const good = { t: T, s: '1'.repeat(16), p: null, n: 'x', k: 'server', st: 1, d: 1, ok: true, src: 'r', svc: 'f' };
  const long = 'y'.repeat(2000);
  const attrs = {
    'gen_ai.usage.input_tokens': 1,
    'gen_ai.tool.name': long,
    'gen_ai.agent.id': { x: 1 },
    'gen_ai.agent.name': [1],
    'gen_ai.request.model': null,
    'server.port': 8080,
    ['k'.repeat(101)]: 1,
  };
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])); // none allowed
  const input = [
    { ...good, prompt: 'secret text', extra: 1, err: null, a: 'text' },
    { ...good, a: [1, 2] },
    { ...good, a: attrs, k: 'weird', n: 'n'.repeat(300), src: undefined },
    { ...good, a: many },
    { ...good, p: 'nope' },
    { ...good, d: -1 },
    { ...good, st: NaN },
  ];
  assert.equal(rec.ingest(input), 4);
  assert.equal(rec.stats().dropped, 3);
  rec.flush();
  const [a, b, c, d] = store.spans;
  assert.deepEqual(Object.keys(a), ['t', 's', 'p', 'n', 'k', 'st', 'd', 'ok', 'src', 'svc', 'a']);
  assert.equal('err' in a, false);
  assert.deepEqual(a.a, {});
  assert.deepEqual(b.a, {});
  assert.deepEqual(Object.keys(c.a), ['gen_ai.usage.input_tokens', 'gen_ai.tool.name', 'server.port']);
  assert.equal(c.a['gen_ai.tool.name'].length, 1000);
  assert.equal(c.k, 'internal');
  assert.equal(c.n.length, 200);
  assert.equal(c.src, 'remote');
  assert.deepEqual(d.a, {});
});

test('recorder: ingest keeps only allowed attributes: no OpenInference or OpenLLMetry text', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  const good = { t: T, s: '1'.repeat(16), p: null, n: 'x', k: 'client', st: 1, d: 1, ok: true, src: 'remote', svc: 'far' };
  const a = {
    'input.value': 'PROMPT-TEXT',
    'output.value': 'REPLY-TEXT',
    'llm.input_messages.0.message.content': 'PROMPT-TEXT',
    'gen_ai.prompt.0.content': 'PROMPT-TEXT',
    'gen_ai.completion.0.content': 'REPLY-TEXT',
    'gen_ai.operation.name': 'chat',
    'gen_ai.response.model': 'm',
    'rpc.method': 'message/send',
  };
  assert.equal(rec.ingest([{ ...good, a }]), 1);
  rec.flush();
  assert.deepEqual(store.spans[0].a, { 'gen_ai.operation.name': 'chat', 'gen_ai.response.model': 'm', 'rpc.method': 'message/send' });
});

test('recorder: ingest takes only string ids; a non-string id is not coerced, and err numbers are stored as text', () => {
  const store = memStore();
  const rec = createRecorder({ store, flushMs: 0 });
  const good = { t: T, s: '1'.repeat(16), p: null, n: 'x', k: 'server', st: 1, d: 1, ok: true, src: 'r', svc: 'f' };
  const arrId = { ...good, t: ['a'.repeat(32)] };
  const objId = { ...good, s: { toString: () => '1'.repeat(16) } };
  assert.equal(rec.ingest([arrId, objId]), 0);
  assert.equal(rec.stats().dropped, 2);
  assert.equal(rec.ingest([{ ...good, err: 500, ok: false }]), 1);
  rec.flush();
  assert.equal(store.spans.length, 1);
  assert.equal(store.spans[0].err, '500');
});
