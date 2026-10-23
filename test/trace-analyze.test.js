const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, criticalPath } = require('../lib/trace/analyze');

const sp = (id, parent, start, dur, extra = {}) => ({ id, parent, kind: 'tool', name: `op ${id}`, start, end: start + dur, status: 'ok', usage: null, cost: null, ...extra });
const chat = (id, parent, start, dur, input, output, cost) => sp(id, parent, start, dur, { kind: 'chat', usage: { input, output, cacheRead: 0 }, cost });
const failed = (id, parent, start, dur) => sp(id, parent, start, dur, { status: 'error', error: `${id} failed` });
const path = (spans, rootId) => criticalPath(spans, rootId).map((x) => [x.spanId, x.start, x.end]);

test('critical path: sequential children (the example in Jaeger)', () => {
  assert.deepEqual(path([sp('a', null, 0, 100), sp('b', 'a', 10, 30), sp('c', 'a', 50, 40)]), [
    ['a', 0, 10],
    ['b', 10, 40],
    ['a', 40, 50],
    ['c', 50, 90],
    ['a', 90, 100],
  ]);
});

test('critical path: an overlapped child that finishes earlier is not on it', () => {
  assert.deepEqual(path([sp('a', null, 0, 100), sp('b', 'a', 10, 70), sp('c', 'a', 20, 40)]), [
    ['a', 0, 10],
    ['b', 10, 80],
    ['a', 80, 100],
  ]);
});

test('critical path: a child outliving its parent is cut at the parent end', () => {
  assert.deepEqual(path([sp('a', null, 0, 100), sp('b', 'a', 50, 100)]), [
    ['a', 0, 50],
    ['b', 50, 100],
  ]);
});

const tree = () => [
  sp('a', null, 0, 100),
  chat('b', 'a', 0, 40, 10, 5, 0.01),
  failed('c', 'a', 50, 40),
  chat('d', 'c', 60, 20, 3, 1, 0.002),
  failed('e', 'a', 5, 1), // fails earlier, but off the critical path
];

test('analyze: rollups from chat spans only, self time, and the failing span on the critical path', () => {
  const spans = tree();
  spans[0].cost = 99; // a parent's own cost repeats its children's: not counted
  const r = analyze(spans);
  assert.equal(r.rootSpanId, 'a');
  assert.deepEqual(r.rollup.a, { tokensIn: 13, tokensOut: 6, costUSD: 0.012, spans: 5, errors: 2 });
  assert.deepEqual(r.rollup.c, { tokensIn: 3, tokensOut: 1, costUSD: 0.002, spans: 2, errors: 1 });
  assert.equal(r.selfTime.a, 20);
  assert.equal(r.selfTime.c, 20);
  assert.deepEqual(r.rootCause, { spanId: 'c', name: 'op c', error: 'c failed', onCriticalPath: true });
  assert.equal(analyze([sp('a', null, 0, 10)]).rootCause, null);
});

test('analyze: a given root limits the critical path and the root cause to its subtree', () => {
  const r = analyze(tree(), { rootId: 'c' });
  assert.equal(r.rootSpanId, 'c');
  assert.deepEqual(r.criticalPath.map((x) => x.spanId), ['c', 'd', 'c']);
  assert.equal(r.rootCause.spanId, 'c');
  assert.ok(r.rollup.a, 'rollups still cover every span');
});

test('analyze: a running span ends at the latest end seen', () => {
  const r = analyze([sp('a', null, 0, 0, { end: null, status: 'running' }), sp('b', 'a', 0, 40)]);
  assert.deepEqual(r.criticalPath.map((x) => [x.spanId, x.start, x.end]), [['b', 0, 40]]);
  assert.equal(r.selfTime.a, 0);
});

test('analyze: cache tokens count as input', () => {
  const r = analyze([sp('a', null, 0, 10), sp('b', 'a', 0, 5, { kind: 'chat', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 } })]);
  assert.equal(r.rollup.a.tokensIn, 13);
});
