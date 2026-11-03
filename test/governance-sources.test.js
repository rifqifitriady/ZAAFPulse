// Governance inventory (AI Governance 3): a source that reports its failure as data must throw, so that the inventory
// lists it as failed (lib/governance/sources.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { liveOrThrow, runtimesOrThrow, indexReadyOrThrow } = require('../lib/governance/sources');

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

test('indexReadyOrThrow: scanning or never scanned throws; a scanned idle index passes', () => {
  assert.throws(() => indexReadyOrThrow({ indexing: true, lastScan: 5 }), /not ready/);
  assert.throws(() => indexReadyOrThrow({ indexing: false, lastScan: null }), /not ready/);
  assert.throws(() => indexReadyOrThrow(null), /not ready/);
  const ok = { indexing: false, lastScan: 5 };
  assert.equal(indexReadyOrThrow(ok), ok);
});

test('a first build while the index is scanning keeps the baseline open; after the scan it is done', () => {
  const { buildInventory } = require('../lib/governance/inventory');
  const NOW = Date.UTC(2026, 10, 3, 12);
  const read = (state) => {
    try {
      indexReadyOrThrow(state);
      return { tools: [{ id: 'cursor', name: 'Cursor', lastActive: NOW }], toolUse: [], models: [] };
    } catch {
      return null;
    }
  };
  const none = { exists: false, baselineDone: false, map: {} };
  const during = buildInventory({ summary: read({ indexing: true, lastScan: null }) }, {}, none, NOW);
  assert.ok(during.failed.includes('summary'));
  assert.equal(during.nextSeen.baselineDone, false);
  const after = buildInventory({ summary: read({ indexing: false, lastScan: NOW }) }, {}, none, NOW);
  assert.ok(!after.failed.includes('summary'));
  assert.equal(after.nextSeen.baselineDone, true);
});
