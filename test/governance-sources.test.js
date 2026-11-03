// Governance inventory (AI Governance 3): a source that reports its failure as data must throw, so that the inventory
// lists it as failed (lib/governance/sources.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { liveOrThrow, runtimesOrThrow } = require('../lib/governance/sources');

test('liveOrThrow: a snapshot with an error throws; a good one passes through unchanged', () => {
  assert.throws(() => liveOrThrow({ apps: [], installed: [], error: 'ps failed' }), /could not be read/);
  assert.throws(() => liveOrThrow(null), /could not be read/);
  const ok = { apps: [{ id: 'claude' }], installed: [] };
  assert.equal(liveOrThrow(ok), ok);
});

test('runtimesOrThrow: a non-200 reply or a body that is not a list throws; a good one gives the list', () => {
  assert.throws(() => runtimesOrThrow({ status: 500, body: [] }), /could not be read/);
  assert.throws(() => runtimesOrThrow({ status: 200, body: { error: 'x' } }), /could not be read/);
  assert.throws(() => runtimesOrThrow(undefined), /could not be read/);
  const list = [{ id: 'ollama' }];
  assert.equal(runtimesOrThrow({ status: 200, body: list }), list);
});
