const test = require('node:test');
const assert = require('node:assert/strict');
const { createGatewayAdapter } = require('../lib/trace/gateway');
const { validate } = require('../lib/trace/model');

const T0 = 1700000000000;
// Span times in a run are milliseconds since createdAt, as lib/gateway/collab.js writes them.
const run = {
  id: 'r1',
  pattern: 'vote',
  state: 'completed',
  createdAt: T0,
  updatedAt: T0 + 5000,
  task: 'secret task text',
  answer: 'final answer',
  spent: { input: 8, output: 5, tokens: 13, cost: 0.002, requests: 2 },
  steps: [
    { n: 1, agent: 'a', model: 'm', text: 'step a text', calls: [], usage: { input: 5, output: 3 }, status: 'done' },
    { n: 2, agent: 'b', model: 'm', text: 'step b text', calls: [], usage: { input: 3, output: 2 }, status: 'done' },
  ],
  trace: [
    { id: 'x0', parent: null, name: 'invoke_workflow vote', start: 0, end: 5000, status: 'ok', attrs: {} },
    { id: 'x1', parent: 'x0', name: 'invoke_agent a', start: 100, end: 3000, status: 'ok', attrs: {} },
    { id: 'x2', parent: 'x1', name: 'chat m', start: 200, end: 2000, status: 'ok', attrs: { 'zp.agent': 'a', 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 3, 'zp.cost_usd': 0.001 } },
    { id: 'x3', parent: 'x0', name: 'chat m', start: 2100, end: 3000, status: 'ok', attrs: { 'zp.agent': 'b', 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 3, 'gen_ai.usage.output_tokens': 2, 'zp.cost_usd': 0.001 } },
  ],
};
const g = {
  runs: () => [run],
  run: (id) => (id === 'r1' ? run : null),
  requests: () => [
    { ts: 2500, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-1', kind: 'chat', status: 500, ms: 90, input: 3, output: 0, cost: 0, error: 'upstream' },
    { ts: 2000, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-1', kind: 'chat', status: 200, ms: 300, input: 10, output: 4, cost: 0.001 },
  ],
};

test('runs and request sessions are listed without task text', () => {
  const rows = createGatewayAdapter(g).sessions();
  assert.deepEqual(rows.map((r) => r.id).sort(), ['req:conv-1', 'run:r1']);
  assert.ok(!JSON.stringify(rows).includes('secret task text'));
  const r = rows.find((x) => x.id === 'run:r1');
  assert.equal(r.title, 'vote run · completed · 2 steps');
  assert.equal(r.start, T0);
  assert.equal(r.end, T0 + 5000);
  assert.equal(r.cost, 0.002);
});

test('a run skeleton maps its trace spans onto epoch times', async () => {
  const sk = await createGatewayAdapter(g).skeleton(null, 'run:r1', {});
  assert.deepEqual(validate(sk.spans), []);
  assert.deepEqual(sk.spans.map((s) => s.kind), ['session', 'agent', 'chat', 'chat', 'answer']);
  const [root, agent, chat] = sk.spans;
  assert.equal(root.start, T0);
  assert.equal(root.end, T0 + 5000);
  assert.equal(agent.start, T0 + 100);
  assert.equal(chat.start, T0 + 200);
  assert.deepEqual(chat.usage, { input: 5, output: 3, cacheRead: 0 });
  assert.equal(chat.cost, 0.001);
  assert.equal(chat.model, 'm');
  assert.equal(root.name, 'invoke_workflow vote');
});

test('chat spans point at their step by agent and model, the answer at the answer', async () => {
  const sk = await createGatewayAdapter(g).skeleton(null, 'run:r1', {});
  const chats = sk.spans.filter((s) => s.kind === 'chat');
  assert.deepEqual(chats.map((c) => c.text), [{ g: 'run', id: 'r1', step: 0 }, { g: 'run', id: 'r1', step: 1 }]);
  const answer = sk.spans.find((s) => s.kind === 'answer');
  assert.deepEqual(answer.text, { g: 'run', id: 'r1', answer: true });
  assert.equal(answer.parent, sk.spans[0].id);
  assert.ok(!JSON.stringify(sk).includes('step a text'), 'no text in the skeleton');
});

test('an unmatched chat span, and a repeat of one agent, map by order', async () => {
  const r2 = {
    ...run,
    id: 'r2',
    answer: undefined,
    steps: [
      { n: 1, agent: 'a', model: 'm', text: 'first', status: 'done' },
      { n: 2, agent: 'a', model: 'm', text: 'second', status: 'done' },
    ],
    trace: [
      run.trace[0],
      { id: 'y1', parent: 'x0', name: 'chat m', start: 10, end: 20, status: 'ok', attrs: { 'zp.agent': 'a', 'gen_ai.request.model': 'm' } },
      { id: 'y2', parent: 'x0', name: 'chat m', start: 30, end: 40, status: 'ok', attrs: { 'zp.agent': 'a', 'gen_ai.request.model': 'm' } },
      { id: 'y3', parent: 'x0', name: 'chat m', start: 50, end: 60, status: 'ok', attrs: { 'zp.agent': 'a', 'gen_ai.request.model': 'm' } },
      { id: 'y4', parent: 'x0', name: 'judge', start: 70, end: 80, status: 'ok', attrs: {} },
    ],
  };
  const sk = await createGatewayAdapter({ ...g, run: () => r2 }).skeleton(null, 'run:r2', {});
  const chats = sk.spans.filter((s) => s.kind === 'chat');
  assert.deepEqual([chats[0].text.step, chats[1].text.step], [0, 1]);
  assert.equal(chats[2].text, null);
  assert.equal(sk.spans.find((s) => s.name === 'judge').kind, 'tool');
  assert.ok(!sk.spans.some((s) => s.kind === 'answer'), 'no answer span without an answer');
});

test('a run without a root, or with several, still validates', async () => {
  const none = { ...run, id: 'r3', trace: run.trace.slice(1) };
  const many = { ...run, id: 'r4', trace: [run.trace[0], { ...run.trace[0], id: 'z0' }, run.trace[3]] };
  for (const r of [none, many]) {
    const sk = await createGatewayAdapter({ ...g, run: () => r }).skeleton(null, `run:${r.id}`, {});
    assert.deepEqual(validate(sk.spans), [], r.id);
    assert.equal(sk.spans.filter((s) => !s.parent).length, 1);
  }
});

test('an unfinished span keeps a null end, and an unknown run is a 404', async () => {
  const live = { ...run, id: 'r5', state: 'working', trace: [{ ...run.trace[0], end: null }, { ...run.trace[1], end: null }] };
  const sk = await createGatewayAdapter({ ...g, run: () => live }).skeleton(null, 'run:r5', {});
  assert.equal(sk.spans[1].end, null);
  assert.equal(sk.spans[1].status, 'running');
  await assert.rejects(createGatewayAdapter(g).skeleton(null, 'run:nope', {}), (e) => e.status === 404);
  await assert.rejects(createGatewayAdapter(g).skeleton(null, 'req:nope', {}), (e) => e.status === 404);
});

test('a request session has one chat span per request in time order, the failed one marked', async () => {
  const sk = await createGatewayAdapter(g).skeleton(null, 'req:conv-1', {});
  assert.deepEqual(validate(sk.spans), []);
  const chats = sk.spans.filter((s) => s.kind === 'chat');
  assert.equal(chats.length, 2);
  assert.deepEqual(chats.map((c) => c.start), [2000, 2500]);
  assert.equal(chats[0].status, 'ok');
  assert.equal(chats[1].status, 'error');
  assert.ok(chats.every((c) => c.text === null));
});

test('requests without a session id group per key per hour', () => {
  const H = 3600000;
  const reqs = [
    { ts: 5 * H + 10, keyId: 'k1', model: 'm', status: 200 },
    { ts: 5 * H + 20, keyId: 'k1', model: 'm', status: 200 },
    { ts: 6 * H + 1, keyId: 'k1', model: 'm', status: 200 },
    { ts: 5 * H + 30, keyId: 'k2', model: 'm', status: 200 },
  ];
  const rows = createGatewayAdapter({ ...g, runs: () => [], requests: () => reqs }).sessions();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => /^req:k[12]:\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/.test(r.id)));
  assert.equal(rows.find((r) => r.title.startsWith('2 requests')).turns, 1);
});
