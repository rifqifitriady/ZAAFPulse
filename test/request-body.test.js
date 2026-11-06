// A request body is read once (lib/request-body.js): the role check and the route get the same text and the same
// parsed object; a later read may not ask for a larger limit than the first one cut the body at.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createBodyReader } = require('../lib/request-body');

// A request that sends `chunks` once its reader is listening.
function reqOf(chunks) {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => (req.destroyed = true);
  setImmediate(() => {
    for (const c of chunks) req.emit('data', Buffer.from(c));
    req.emit('end');
  });
  return req;
}

test('read once: the same text and the same parsed body for every reader; the text is kept for the audit entry', async () => {
  const kept = [];
  const { readBody, jsonBody } = createBodyReader({ keep: (req, data) => kept.push(data) });
  const req = reqOf(['{"action":', '"list"}']);
  const [a, b] = [readBody(req), readBody(req)];
  assert.equal(a, b);
  assert.equal(await a, '{"action":"list"}');
  assert.equal(jsonBody(req), jsonBody(req));
  assert.deepEqual(await jsonBody(req), { action: 'list' });
  assert.deepEqual(kept, ['{"action":"list"}']);
});

test('a body over the limit is cut off; a later read with a larger limit throws, one with the same or smaller does not', async () => {
  const { readBody } = createBodyReader();
  const big = reqOf(['x'.repeat(20)]);
  await assert.rejects(readBody(big, 10), /too large/);
  assert.ok(big.destroyed);
  const req = reqOf(['hello']);
  const first = readBody(req, 100);
  assert.equal(readBody(req, 100), first);
  assert.equal(readBody(req, 50), first);
  assert.throws(() => readBody(req, 1e6), /body already read with a limit of 100 characters/);
  assert.equal(await first, 'hello');
});
