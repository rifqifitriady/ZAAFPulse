const test = require('node:test');
const assert = require('node:assert/strict');
const { adjust } = require('../lib/trace/adjust');

const sp = (id, parent, start, dur, extra = {}) => ({ id, parent, kind: 'tool', name: `op ${id}`, start, end: start + dur, status: 'ok', ...extra });
const get = (list, id) => list.find((s) => s.id === id);

test('adjust: a duplicated span keeps its longer record; the input is not modified', () => {
  const input = [
    sp('a', null, 0, 100, { service: 'x' }),
    sp('b', 'a', 10, 0),
    sp('b', 'a', 10, 50),
    sp('c', 'z', 10, 5), // orphan: reparented under a
    sp('e', 'a', 5000, 10, { service: 'far' }), // cross-service, outside its parent: shifted
  ];
  const before = input.map((s) => ({ id: s.id, parent: s.parent, start: s.start, end: s.end }));
  const out = adjust(input);
  assert.equal(out.length, 4);
  assert.equal(get(out, 'b').end, 60);
  assert.equal(get(out, 'c').parent, 'a');
  assert.notEqual(get(out, 'e').start, 5000);
  assert.equal(input[1].end, 10);
  assert.deepEqual(
    input.map((s) => ({ id: s.id, parent: s.parent, start: s.start, end: s.end })),
    before,
  );
});

test('adjust: orphans hang under the root and keep their lost parent', () => {
  const out = adjust([sp('a', null, 0, 100), sp('c', 'z', 10, 5)]);
  assert.equal(get(out, 'c').parent, 'a');
  assert.equal(get(out, 'c').orphanOf, 'z');
});

test('adjust: without a root, the earliest span becomes it', () => {
  const out = adjust([sp('c', 'y', 20, 5), sp('b', 'x', 5, 10)]);
  assert.equal(get(out, 'b').parent, null);
  assert.equal(get(out, 'b').orphanOf, 'x');
  assert.equal(get(out, 'c').parent, 'b');
});

test('adjust: without a root, a parent cycle names no lost span', () => {
  const out = adjust([sp('a', 'b', 0, 10), sp('b', 'a', 20, 10)]);
  assert.equal(get(out, 'a').parent, null);
  assert.equal(get(out, 'a').orphanOf, undefined);
  assert.equal(get(out, 'b').parent, 'a');
});

test('adjust: clock skew is corrected only across services, and carried to the same service below', () => {
  const out = adjust([
    sp('a', null, 1000, 1000, { service: 'zaafpulse' }),
    sp('b', 'a', 5000, 200, { service: 'far' }), // outside its parent: centred inside it
    sp('c', 'b', 5050, 50, { service: 'far' }), // same service as b: moves with it
    sp('d', 'a', 9000, 10, { service: 'zaafpulse' }), // same service as a: left alone
  ]);
  assert.equal(get(out, 'b').start, 1400);
  assert.equal(get(out, 'b').end, 1600);
  assert.equal(get(out, 'b').skewMs, -3600);
  assert.equal(get(out, 'c').start, 1450);
  assert.equal(get(out, 'd').start, 9000);
  assert.deepEqual(out.map((s) => s.start), [1000, 1400, 1450, 9000]);
});

test('adjust: a longer child that starts before its parent moves to the parent start', () => {
  const out = adjust([sp('a', null, 1000, 100, { service: 'x' }), sp('b', 'a', 900, 500, { service: 'far' })]);
  assert.equal(get(out, 'b').start, 1000);
});

test('adjust: a running span is never moved by clock skew', () => {
  const out = adjust([
    sp('a', null, 1000, 0, { service: 'x', end: null }),
    sp('b', 'a', 1500, 0, { service: 'y', end: null }),
  ]);
  assert.equal(get(out, 'b').start, 1500);
  assert.equal(get(out, 'b').skewMs, undefined);
});

test('adjust: a finished remote child under a running parent is not shifted', () => {
  const out = adjust([
    sp('a', null, 1000, 0, { service: 'x', end: null }),
    sp('b', 'a', 1500, 0, { service: 'y' }),
    sp('c', 'b', 1500, 10, { service: 'y' }),
  ]);
  assert.equal(get(out, 'b').start, 1500);
  assert.equal(get(out, 'b').skewMs, undefined);
  assert.equal(get(out, 'c').start, 1500);
});

test('adjust: spans without a service (log sources) are never shifted', () => {
  const out = adjust([sp('a', null, 1000, 100), sp('b', 'a', 5000, 10)]);
  assert.equal(get(out, 'b').start, 5000);
});
