// Governance inventory (AI Governance 3): the Monitors rule inventory_unreviewed (lib/monitors/rules.js), its input in
// the engine (lib/monitors/index.js) from the inventory's last counts (lib/governance/api.js inventoryStatus), and its
// words on the Monitors page. The alert carries a count and kinds only, never a name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RULES, evaluate } = require('../lib/monitors/rules');
const { createMonitors } = require('../lib/monitors');
const { createMonitorState } = require('../lib/monitors/state');
const { createGovernanceApi } = require('../lib/governance/api');

const NOW = Date.UTC(2026, 10, 3, 12);
const rule = RULES.find((r) => r.id === 'inventory_unreviewed');
const run = (snap) => evaluate(rule, {}, snap, NOW);

test('the rule: aggregate, on by default, never pausing, no parameters', () => {
  assert.deepEqual(
    [rule.title, rule.kind, rule.params, rule.defaultOn({}), rule.mayAutoPause],
    ['Unreviewed AI system', 'aggregate', {}, true, false],
  );
  assert.equal(rule.describe, 'An AI system first seen in the last 7 days has no review in Governance → Inventory.');
});

test('inventory_unreviewed: triggered by new unreviewed items, titled with their kinds only', () => {
  assert.deepEqual(run({ inventory: { newUnreviewed: 3, newKinds: ['mcp', 'app', 'github-token', 'mcp'] } }), [
    { instance: 'all', sessionId: null, state: 'triggered', value: 3, threshold: 1, title: 'app, mcp' },
  ]);
  assert.deepEqual(run({ inventory: { newUnreviewed: 0, newKinds: [] } }), [
    { instance: 'all', sessionId: null, state: 'ok', value: 0, threshold: 1 },
  ]);
  assert.equal(run({}).at(0).state, 'no_data');
  assert.equal(run({ inventory: { newUnreviewed: -1 } }).at(0).state, 'no_data');
  assert.equal(run({ inventory: { newUnreviewed: 2, newKinds: 'mcp' } }).at(0).title, undefined, 'no kinds: no title');
});

test('the Monitors page words', () => {
  const { monMeasure } = require('../public/monitorsview');
  assert.equal(monMeasure('inventory_unreviewed', 1, 1), '1 new AI system not reviewed');
  assert.equal(monMeasure('inventory_unreviewed', 4, 1), '4 new AI systems not reviewed');
});

test('engine: the counts of the last inventory build are read on each aggregate pass and alert once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-inv-mon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW };
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
  });
  const sent = [];
  let servers = [{ name: 'github-token-server', transport: 'stdio', command: 'npx', package: 'x', origin: null }];
  const api = createGovernanceApi({
    audit: {},
    settings: { get: () => ({}), save: () => {} },
    sources: async () => ({
      mcp: [{ client: 'cursor', name: 'Cursor', file: '~/.cursor/mcp.json', state: 'ok', servers }],
    }),
    // A seen store already past its baseline, so what the first build finds counts as new.
    seen: { read: () => ({ exists: true, baselineDone: true, map: {} }), write: () => true },
    now: () => clock.t,
  });
  assert.equal(api.inventoryStatus(), null, 'nothing built yet');
  const monitors = createMonitors({
    indexer: { results: () => [] },
    office: { snapshot: () => ({ agents: [] }), demoSnapshot: () => ({ agents: [] }) },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({}),
    state,
    channels: { notify: async (alert) => sent.push(alert) },
    now: () => clock.t,
    inventoryStatus: () => api.inventoryStatus(),
  });
  await api.inventory();
  assert.deepEqual(api.inventoryStatus(), { newUnreviewed: 1, newKinds: ['mcp'] });
  await monitors.tickAggregate();
  const alerts = sent.filter((a) => a.rule === 'inventory_unreviewed');
  assert.deepEqual(
    alerts.map((a) => [a.state, a.value, a.title]),
    [['triggered', 1, 'mcp']],
  );
  assert.ok(!JSON.stringify(sent).includes('github-token-server'), 'no name in an alert');
  clock.t += 6e3;
  await monitors.tickAggregate();
  assert.equal(sent.filter((a) => a.rule === 'inventory_unreviewed').length, 1, 'still triggered: no repeat alert');
  servers = [];
  clock.t += 6e3;
  await api.inventory();
  clock.t += 60e3;
  await monitors.tickAggregate();
  assert.equal(sent.filter((a) => a.rule === 'inventory_unreviewed').length, 1, 'no second alert');
  assert.equal(state.states().find((s) => s.rule === 'inventory_unreviewed').state, 'ok');
});
