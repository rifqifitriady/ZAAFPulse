// Gateway guardrails (AI Governance 1): the Monitors rule guardrail_block (lib/monitors/rules.js) and the engine's
// snapshot provider for it (lib/monitors/index.js). The alert carries the count and the check names, nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RULES, evaluate } = require('../lib/monitors/rules');
const { createMonitors } = require('../lib/monitors');
const { createMonitorState } = require('../lib/monitors/state');

const MIN = 60e3;
const NOW = new Date(2026, 10, 3, 12).getTime();
const RULE = RULES.find((r) => r.id === 'guardrail_block');
const run = (snap, now = NOW) => evaluate(RULE, {}, snap, now);

test('the rule: aggregate, on by default, never pausing, no parameters', () => {
  assert.deepEqual(
    [RULE.title, RULE.describe, RULE.kind, RULE.params, RULE.defaultOn({}), RULE.mayAutoPause],
    [
      'Guardrail block',
      'The gateway guardrails blocked one or more requests in the last 60 minutes.',
      'aggregate',
      {},
      true,
      false,
    ],
  );
});

test('the rule: triggered by a block in the last 60 minutes, titled with the check names only', () => {
  const blocks = [
    { ts: NOW - 5 * MIN, checks: ['secrets'] },
    { ts: NOW - 59 * MIN, checks: ['injection', 'secrets'] },
    { ts: NOW - 61 * MIN, checks: ['pii'] },
  ];
  assert.deepEqual(run({ guardBlocks: blocks }), [
    { instance: 'all', sessionId: null, state: 'triggered', value: 2, threshold: 1, title: 'injection, secrets' },
  ]);
  assert.deepEqual(run({ guardBlocks: [blocks[2]] }), [
    { instance: 'all', sessionId: null, state: 'ok', value: 0, threshold: 1 },
  ]);
  assert.deepEqual(run({ guardBlocks: [] })[0].state, 'ok');
  assert.deepEqual(run({})[0].state, 'no_data');
  assert.deepEqual(run({ guardBlocks: [{ ts: NOW, checks: ['secrets', 'whatever<b>'] }] })[0].title, 'secrets');
});

test('the Monitors page words: how many requests were blocked in the last hour', () => {
  const { monMeasure } = require('../public/monitorsview');
  assert.equal(monMeasure('guardrail_block', 2, 1), '2 blocked requests in the last hour');
  assert.equal(monMeasure('guardrail_block', 1, 1), '1 blocked request in the last hour');
});

test('engine: the provider is read on each aggregate pass and its blocks alert once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-mon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW };
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
  });
  const sent = [];
  const seen = [];
  let blocks = [{ ts: NOW - MIN, checks: ['secrets'] }];
  const monitors = createMonitors({
    indexer: { results: () => [] },
    office: { snapshot: () => ({ agents: [] }), demoSnapshot: () => ({ agents: [] }) },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({}),
    state,
    channels: { notify: async (alert) => sent.push(alert) },
    now: () => clock.t,
    guardBlocks: (now) => {
      seen.push(now);
      return blocks;
    },
  });
  await monitors.tickAggregate();
  assert.deepEqual(seen, [NOW]);
  const alerts = sent.filter((a) => a.rule === 'guardrail_block');
  assert.equal(alerts.length, 1);
  assert.deepEqual(
    [alerts[0].state, alerts[0].value, alerts[0].threshold, alerts[0].title],
    ['triggered', 1, 1, 'secrets'],
  );
  assert.deepEqual(Object.keys(alerts[0]).sort(), [
    'id',
    'instance',
    'previous',
    'rule',
    'sessionId',
    'state',
    'threshold',
    'title',
    'ts',
    'value',
  ]);
  blocks = null; // the provider has nothing to say: no_data, no alert
  clock.t += MIN;
  await monitors.tickAggregate();
  assert.equal(sent.filter((a) => a.rule === 'guardrail_block').length, 1);
});
