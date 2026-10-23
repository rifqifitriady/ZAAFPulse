const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../lib/trace/summary');

const T = 'a'.repeat(32);
const rec = (s, p, n, st, d, a = {}, ok = true) => ({ t: T, s, p, n, k: 'internal', st, d, ok, src: 'gateway', svc: 'zaafpulse', a });

test('summary: root, time range and counts; tokens and cost from chat spans only', () => {
  const root = '1'.repeat(16);
  const agent = '4'.repeat(16);
  const s = summarize(T, [
    rec('2'.repeat(16), agent, 'chat m1', 1100, 200, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'm1',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
      'zaafpulse.cost.usd': 0.01,
    }),
    rec('3'.repeat(16), agent, 'execute_tool web', 1300, 100, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }, false),
    // The agent span repeats its children's totals; they must not be counted twice.
    rec(agent, root, 'invoke_agent sales', 1050, 400, {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': 'sales',
      'gen_ai.usage.input_tokens': 10,
      'zaafpulse.cost.usd': 0.01,
    }),
    rec(root, null, 'invoke_workflow auto', 1000, 500, { 'zaafpulse.run.id': 'run_1' }),
  ]);
  assert.equal(s.root, 'invoke_workflow auto');
  assert.equal(s.rootStart, 1000);
  assert.equal(s.start, 1000);
  assert.equal(s.end, 1500);
  assert.equal(s.spans, 4);
  assert.equal(s.errors, 1);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.tokensIn, 10);
  assert.equal(s.tokensOut, 5);
  assert.equal(s.costUSD, 0.01);
  assert.deepEqual(s.models, ['m1']);
  assert.deepEqual(s.agents, ['sales']);
  assert.deepEqual(s.tools, ['web']);
  assert.equal(s.runId, 'run_1');
  assert.equal(s.src, 'gateway');
  assert.equal(s.svc, 'zaafpulse');
});

test('summary: a span with a remote parent still becomes the root when it starts first', () => {
  const s = summarize(T, [
    rec('2'.repeat(16), '1'.repeat(16), 'chat m', 1100, 10, { 'gen_ai.operation.name': 'chat' }),
    rec('1'.repeat(16), 'f'.repeat(16), 'POST /v1/chat/completions', 1000, 200),
  ]);
  assert.equal(s.root, 'POST /v1/chat/completions');
  assert.equal(s.runId, null);
});

test('summary: an integration call under the agent\'s tool span is one tool call', () => {
  const tool = { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' };
  const s = summarize(T, [
    rec('1'.repeat(16), null, 'invoke_agent a', 1000, 300, { 'gen_ai.operation.name': 'invoke_agent' }),
    rec('2'.repeat(16), '1'.repeat(16), 'execute_tool web', 1100, 100, tool),
    rec('3'.repeat(16), '2'.repeat(16), 'execute_tool web', 1110, 80, { ...tool, 'zaafpulse.tool.nested': true }),
  ]);
  assert.equal(s.toolCalls, 1);
  assert.deepEqual(s.tools, ['web']);
});

const remote = (s, p, n, st, d, a = {}) => ({ ...rec(s, p, n, st, d, a), src: 'remote', svc: 'far-agent' });
const remoteChat = {
  'gen_ai.operation.name': 'chat',
  'gen_ai.request.model': 'far-model',
  'gen_ai.agent.id': 'far',
  'gen_ai.usage.input_tokens': 1000,
  'gen_ai.usage.output_tokens': 500,
  'zaafpulse.cost.usd': Infinity,
  'zaafpulse.run.id': 'run_forged',
};

test('summary: a remote span is never the root while one of ours exists, in any order', () => {
  const ours = rec('1'.repeat(16), null, 'invoke_workflow auto', 1000, 500);
  const early = remote('2'.repeat(16), '1'.repeat(16), 'handle', 0, 9000);
  for (const spans of [
    [ours, early],
    [early, ours],
  ]) {
    const s = summarize(T, spans);
    assert.equal(s.root, 'invoke_workflow auto');
    assert.equal(s.rootStart, 1000);
    assert.equal(s.src, 'gateway');
    assert.equal(s.svc, 'zaafpulse');
  }
  // Only remote spans: the earliest of them is the root.
  const only = summarize(T, [remote('3'.repeat(16), null, 'later', 2000, 10), remote('4'.repeat(16), null, 'first', 1500, 10)]);
  assert.equal(only.root, 'first');
  assert.equal(only.src, 'remote');
});

test('summary: remote spans add no tokens, cost, tool calls or run id; their names still count', () => {
  const s = summarize(T, [
    rec('1'.repeat(16), null, 'invoke_workflow auto', 1000, 500, { 'zaafpulse.run.id': 'run_1' }),
    remote('2'.repeat(16), '1'.repeat(16), 'chat far-model', 1100, 100, remoteChat),
    remote('3'.repeat(16), '2'.repeat(16), 'execute_tool db', 1150, 10, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'db' }),
  ]);
  assert.equal(s.tokensIn, 0);
  assert.equal(s.tokensOut, 0);
  assert.equal(s.costUSD, 0);
  assert.equal(s.toolCalls, 0);
  assert.equal(s.runId, 'run_1');
  assert.deepEqual(s.models, ['far-model']);
  assert.deepEqual(s.agents, ['far']);
  assert.deepEqual(s.tools, ['db']);
  assert.equal(summarize(T, [remote('2'.repeat(16), null, 'chat far-model', 1100, 100, remoteChat)]).runId, null);
});
