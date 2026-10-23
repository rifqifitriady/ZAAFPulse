const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraceStore } = require('../lib/trace/store');
const { dependencies } = require('../lib/trace/deps');

const T = 'a'.repeat(32);
const NOW = Date.now();
const rec = (s, p, n, k, a = {}, ok = true, svc = 'zaafpulse', durMs = 5) => ({ t: T, s, p, n, k, st: (NOW - 1000) * 1000, d: durMs * 1000, ok, src: 'gateway', svc, a });

test('deps: agents to models, tools, agents and remote services, with counts, failures and p95', () => {
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-deps-')) });
  store.writeSpans([
    rec('1'.repeat(16), null, 'POST /v1/collaborate', 'server'),
    rec('2'.repeat(16), '1'.repeat(16), 'invoke_agent sales', 'internal', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'sales' }),
    rec('3'.repeat(16), '2'.repeat(16), 'chat m', 'client', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm' }),
    rec('4'.repeat(16), '2'.repeat(16), 'execute_tool web', 'internal', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }, false),
    rec('5'.repeat(16), '4'.repeat(16), 'execute_tool web', 'internal', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }, true, 'zaafpulse', 15),
    rec('6'.repeat(16), '2'.repeat(16), 'a2a far', 'client', { 'rpc.system': 'a2a', 'server.address': 'far:9' }),
    rec('7'.repeat(16), '6'.repeat(16), 'handle', 'server', {}, true, 'far-agent'),
  ]);
  const d = dependencies(store, { from: NOW - 60000, to: NOW + 60000 });
  const edge = (from, to) => d.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(edge('agent:sales', 'model:m'), { from: 'agent:sales', to: 'model:m', count: 1, errors: 0, p95Ms: 5 });
  assert.deepEqual(edge('agent:sales', 'tool:web'), { from: 'agent:sales', to: 'tool:web', count: 2, errors: 1, p95Ms: 15 });
  assert.equal(edge('agent:sales', 'remote:far:9').count, 1);
  assert.equal(edge('remote:far:9', 'service:far-agent').count, 1);
  assert.ok(d.nodes.some((n) => n.id === 'tool:web' && n.kind === 'tool' && n.label === 'web' && n.count === 2));
  assert.deepEqual(dependencies(store, { from: NOW + 3600000, to: NOW + 7200000 }), { nodes: [], edges: [] });
});

const mk = () => createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-deps-')) });
const win = { from: NOW - 60000, to: NOW + 60000 };

test('deps: a secret in a model name reaches neither a node id, a label nor an edge', () => {
  const secret = 'ghp_' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xYz'.padEnd(36, 'Q'); // varied enough to count as a live key
  const store = mk();
  store.writeSpans([
    rec('1'.repeat(16), null, 'invoke_agent sales', 'internal', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'sales' }),
    rec('3'.repeat(16), '1'.repeat(16), `chat ${secret}`, 'client', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': secret }),
  ]);
  const d = dependencies(store, win);
  assert.ok(d.edges.length === 1 && d.nodes.length === 2);
  assert.ok(!JSON.stringify(d).includes(secret));
  assert.ok(d.nodes.every((n) => n.id === `${n.kind}:${n.label}`));
});

test('deps: a remote call counts once however many spans the remote service sent back', () => {
  const store = mk();
  store.writeSpans([
    rec('1'.repeat(16), null, 'invoke_agent sales', 'internal', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'sales' }),
    rec('6'.repeat(16), '1'.repeat(16), 'a2a far', 'client', { 'rpc.system': 'a2a', 'server.address': 'far:9' }),
    rec('7'.repeat(16), '6'.repeat(16), 'handle', 'server', {}, true, 'far-agent'),
    rec('8'.repeat(16), '7'.repeat(16), 'inner1', 'internal', {}, true, 'far-agent'),
    rec('9'.repeat(16), '7'.repeat(16), 'inner2', 'internal', {}, true, 'far-agent'),
  ]);
  const d = dependencies(store, win);
  assert.equal(d.edges.find((e) => e.from === 'remote:far:9' && e.to === 'service:far-agent').count, 1);
  assert.equal(d.nodes.find((n) => n.id === 'service:far-agent').count, 1);
});

test('deps: an operation attribute without the name prefix falls back to the kind, not a sliced name', () => {
  const store = mk();
  store.writeSpans([rec('1'.repeat(16), null, 'planner', 'internal', { 'gen_ai.operation.name': 'invoke_agent' })]);
  assert.deepEqual(dependencies(store, win).nodes.map((n) => n.id), ['agent:agent']);
});

test('deps: an integration\'s nested tool span is its parent call, not a second one', () => {
  const store = mk();
  const tool = { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' };
  store.writeSpans([
    rec('1'.repeat(16), null, 'invoke_agent a', 'internal', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'a' }),
    rec('2'.repeat(16), '1'.repeat(16), 'execute_tool web', 'internal', tool, true, 'zaafpulse', 10),
    rec('3'.repeat(16), '2'.repeat(16), 'execute_tool web', 'client', { ...tool, 'zaafpulse.tool.nested': true }, true, 'zaafpulse', 900),
  ]);
  const d = dependencies(store, win);
  assert.equal(d.nodes.find((n) => n.id === 'tool:web').count, 1);
  const e = d.edges.find((x) => x.from === 'agent:a' && x.to === 'tool:web');
  assert.equal(e.count, 1);
  assert.equal(e.p95Ms, 10, 'the nested span\'s duration is not in the p95');
});
