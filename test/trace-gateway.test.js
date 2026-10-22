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

// --- step text goes to the final chat round of the agent call that made the step ---
const chatAttrs = (agent) => ({ 'zp.agent': agent, 'gen_ai.request.model': 'm' });
const agentSpan = (id, agent, start, end, status = 'ok') => ({ id, parent: 'x0', name: `invoke_agent ${agent}`, start, end, status, attrs: { 'gen_ai.agent.id': agent } });
const chatSpan = (id, parent, agent, start, end) => ({ id, parent, name: 'chat m', start, end, status: 'ok', attrs: chatAttrs(agent) });
const withTrace = (steps, spans) => ({ ...run, id: 'rt', answer: undefined, steps, trace: [run.trace[0], ...spans] });
const stepsOf = async (r) => {
  const sk = await createGatewayAdapter({ ...g, run: () => r }).skeleton(null, 'run:rt', {});
  return Object.fromEntries(sk.spans.filter((s) => s.kind === 'chat').map((s, i) => [i, s.text ? s.text.step : undefined]));
};

test('two tool rounds in one agent call: only the last chat round shows the step text', async () => {
  const spans = [agentSpan('a1', 'a', 10, 500), chatSpan('c1', 'a1', 'a', 20, 100), chatSpan('c2', 'a1', 'a', 200, 400)];
  const steps = [{ agent: 'a', model: 'm', text: 'done' }];
  // old run (no step.span): structural match
  assert.deepEqual(await stepsOf(withTrace(steps, spans)), { 0: undefined, 1: 0 });
  // new run: exact link
  assert.deepEqual(await stepsOf(withTrace([{ ...steps[0], span: 'a1' }], spans)), { 0: undefined, 1: 0 });
});

test('a failed step before a successful one does not take its slot', async () => {
  const spans = [
    agentSpan('a1', 'a', 10, 50, 'error'),
    chatSpan('c1', 'a1', 'a', 20, 40),
    agentSpan('a2', 'a', 60, 200),
    chatSpan('c2', 'a2', 'a', 70, 150),
  ];
  const steps = [
    { agent: 'a', model: 'm', text: '', status: 'failed', error: 'boom' },
    { agent: 'a', model: 'm', text: 'second try worked', status: 'done' },
  ];
  assert.deepEqual(await stepsOf(withTrace(steps, spans)), { 0: undefined, 1: 1 });
});

test('step.span links exactly, even when parallel steps finish in the other order', async () => {
  const spans = [
    agentSpan('a1', 'a', 10, 900),
    chatSpan('c1', 'a1', 'a', 20, 880),
    agentSpan('a2', 'a', 15, 100),
    chatSpan('c2', 'a2', 'a', 25, 90),
  ];
  // a2 finished first, so its step was recorded first
  const steps = [
    { agent: 'a', model: 'm', text: 'fast', span: 'a2' },
    { agent: 'a', model: 'm', text: 'slow', span: 'a1' },
  ];
  assert.deepEqual(await stepsOf(withTrace(steps, spans)), { 0: 1, 1: 0 });
});

test('a consulted agent inside another agent call does not take a slot', async () => {
  const spans = [
    agentSpan('a1', 'a', 10, 500),
    { id: 'k1', parent: 'a1', name: 'invoke_agent b', start: 30, end: 80, status: 'ok', attrs: { 'gen_ai.agent.id': 'b' } },
    chatSpan('ck', 'k1', 'b', 35, 70),
    chatSpan('c1', 'a1', 'a', 100, 400),
    agentSpan('b2', 'b', 510, 600),
    chatSpan('c3', 'b2', 'b', 520, 590),
  ];
  const steps = [
    { agent: 'a', model: 'm', text: 'A' },
    { agent: 'b', model: 'm', text: 'B' },
  ];
  assert.deepEqual(await stepsOf(withTrace(steps, spans)), { 0: undefined, 1: 0, 2: 1 });
});

test('a run own model calls are not request sessions, a standalone agent call is', () => {
  const rows = createGatewayAdapter({
    ...g,
    runs: () => [],
    requests: () => [
      { ts: 1000, keyId: 'k1', model: 'm', kind: 'agent', status: 200, runId: 'r1', sessionId: 'ctx-1' },
      { ts: 1100, keyId: 'k1', model: 'm', kind: 'agent', status: 200, cost: 0.5 },
    ],
  }).sessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 0.5);
});

test('long session ids and model names are clipped to 80 characters', () => {
  const rows = createGatewayAdapter({ ...g, runs: () => [], requests: () => [{ ts: 1, keyId: 'k', model: 'x'.repeat(300), sessionId: 's'.repeat(300), status: 200 }] }).sessions();
  assert.equal(rows[0].id, 'req:' + 's'.repeat(80));
  assert.equal(rows[0].title, '1 request · ' + 'x'.repeat(80));
});

test('gateway model, provider and span names are masked and capped like a title', async () => {
  const key = ['sk', 'ant', 'Ab3dE7gH1jK5mN9pQ2sT4vX6zC8'].join('-'); // built here so no key sits in the repo
  const model = `m.${key}.${'x'.repeat(200)}`;
  const r2 = { ...run, id: 'r2', trace: run.trace.map((s) => (s.attrs['gen_ai.request.model'] ? { ...s, name: `chat ${model}`, attrs: { ...s.attrs, 'gen_ai.request.model': model } } : s)) };
  const gg = {
    runs: () => [r2],
    run: (id) => (id === 'r2' ? r2 : null),
    requests: () => [{ ts: 2000, keyId: 'k1', provider: `p.${key}`, model, sessionId: 'conv-2', kind: 'chat', status: 200, ms: 300, input: 10, output: 4, cost: 0.001 }],
  };
  const a = createGatewayAdapter(gg);
  const rows = a.sessions();
  const spans = [...(await a.skeleton(null, 'run:r2')).spans, ...(await a.skeleton(null, 'req:conv-2')).spans];
  const shown = [...rows.map((r) => r.title), ...spans.flatMap((s) => [s.name, s.model, s.provider])].filter((v) => typeof v === 'string');
  assert.ok(shown.some((v) => v.includes('hidden')), 'the key was found and masked');
  for (const v of shown) {
    assert.ok(!v.includes(key), v.slice(0, 40));
    assert.ok(v.length <= 100, `capped: ${v.length}`);
  }
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraceStore } = require('../lib/trace/store');
const { runSpanId } = require('../lib/otel');
const { createTrace } = require('../lib/trace');

const US = (ms) => Math.round(ms * 1000);
const R0 = Date.now() - 60000; // the stored run starts a minute ago
const TS = 'a'.repeat(32); // the run's trace
const TQ = 'b'.repeat(32); // a plain chat request
const rec = (t, s, p, n, k, startMs, durMs, a = {}, extra = {}) => ({ t, s, p, n, k, st: US(startMs), d: US(durMs), ok: true, src: 'gateway', svc: 'zaafpulse', a, ...extra });
const storedChatAttrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm', 'gen_ai.provider.name': 'openai', 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 3, 'gen_ai.usage.cache_read.input_tokens': 2, 'zaafpulse.cost.usd': 0.001 };
const SERVER = '1'.repeat(16);
const ROOT = runSpanId('r1', 'x0');
const AGENT = runSpanId('r1', 'x1');
const CHAT = runSpanId('r1', 'x2');
function storedFixture() {
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
  store.writeSpans([
    rec(TS, SERVER, 'f'.repeat(16), 'POST /v1/collaborate', 'server', R0, 5000),
    rec(TS, ROOT, SERVER, 'invoke_workflow vote', 'internal', R0 + 10, 4900, { 'gen_ai.operation.name': 'invoke_workflow', 'zaafpulse.run.id': 'r1' }),
    rec(TS, AGENT, ROOT, 'invoke_agent a', 'internal', R0 + 100, 2900, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'a' }),
    rec(TS, CHAT, AGENT, 'chat m', 'client', R0 + 200, 1800, storedChatAttrs),
    rec(TS, '3'.repeat(16), AGENT, 'execute_tool web', 'internal', R0 + 2100, 100, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }, { ok: false, err: 'HTTP 500' }),
    rec(TQ, '4'.repeat(16), null, 'POST /v1/chat/completions', 'server', R0 + 20000, 300),
    rec(TQ, '5'.repeat(16), '4'.repeat(16), 'chat m', 'client', R0 + 20050, 200, storedChatAttrs),
  ]);
  // The run as runs.json holds it, at the time its spans were stored.
  const sr = { ...run, createdAt: R0, updatedAt: R0 + 5000 };
  // A request whose trace the store holds is not listed again from the usage log; the others are.
  const g2 = {
    ...g,
    runs: () => [sr],
    run: (id) => (id === 'r1' ? sr : null),
    requests: () => [
      ...g.requests(),
      { ts: R0 + 20000, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-2', kind: 'chat', status: 200, ms: 300, traceId: TQ },
      // In the same time span, but not stored: unsampled (no trace id), or its spans were lost (buffer, write error).
      { ts: R0 + 20100, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-unsampled', kind: 'chat', status: 200, ms: 300 },
      { ts: R0 + 20200, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-lost', kind: 'chat', status: 200, ms: 300, traceId: 'd'.repeat(32) },
      { ts: R0 + 3600000 * 2, keyId: 'k1', provider: 'p', model: 'm', sessionId: 'conv-late', kind: 'chat', status: 200, ms: 300 },
    ],
  };
  return { store, g2 };
}

test('stored traces are listed once: a run keeps its run: row, requests the store holds are not listed again', () => {
  const { store, g2 } = storedFixture();
  const rows = createGatewayAdapter(g2, store).sessions();
  // The run's trace is stored, but the run keeps its own id (evals, feedback and links use it): no trace: row for it.
  assert.deepEqual(rows.map((r) => r.id).sort(), ['req:conv-1', 'req:conv-late', 'req:conv-lost', 'req:conv-unsampled', 'run:r1', `trace:${TQ}`]);
  const own = rows.find((x) => x.id === 'run:r1');
  assert.equal(own.title, 'vote run · completed · 2 steps');
  assert.equal(own.start, R0);
  assert.equal(own.cost, 0.002);
  assert.deepEqual(own.tags.sort(), ['a', 'm', 'web'], 'the stored trace still makes the run searchable');
  // A stored trace that belongs to no listed run is a row of its own.
  const alone = createGatewayAdapter({ ...g2, runs: () => [] }, store).sessions();
  const r = alone.find((x) => x.id === `trace:${TS}`);
  assert.equal(r.title, 'POST /v1/collaborate · 5 spans · m');
  assert.equal(r.start, R0);
  assert.equal(r.end, R0 + 5000);
  assert.equal(r.tools, 1);
  assert.equal(r.errors, 1);
  assert.equal(r.cost, 0.001);
  assert.deepEqual(r.flags, { errors: true, loop: false, injection: false });
  assert.deepEqual(r.tags.sort(), ['a', 'm', 'web']);
  assert.equal(typeof r.stamp, 'string');
  assert.ok(!JSON.stringify(rows.concat(alone)).includes('secret task text'));
  // Without a store, the adapter lists what it always did.
  assert.deepEqual(createGatewayAdapter(g).sessions().map((x) => x.id).sort(), ['req:conv-1', 'run:r1']);
});

test('a run whose trace is stored opens from the store under its run: id', async () => {
  const { store, g2 } = storedFixture();
  const sk = await createGatewayAdapter(g2, store).skeleton(null, 'run:r1');
  assert.deepEqual(validate(sk.spans), []);
  assert.equal(sk.session.id, 'run:r1');
  const chat = sk.spans.find((s) => s.name === 'chat m');
  assert.equal(chat.id, CHAT);
  assert.deepEqual(chat.usage, { input: 3, output: 3, cacheRead: 2 }, 'the stored span, with provider details');
  assert.deepEqual(chat.text, { g: 'run', id: 'r1', step: 0 });
  assert.equal(sk.spans.find((s) => s.name === 'POST /v1/collaborate').parent, null);
  assert.equal(sk.spans.find((s) => s.name === 'execute_tool web').status, 'error');
  // run.trace's second chat span (x3) was never stored: merged in under the run's root.
  const merged = sk.spans.find((s) => s.id === runSpanId('r1', 'x3'));
  assert.equal(merged.parent, ROOT);
  assert.deepEqual(merged.text, { g: 'run', id: 'r1', step: 1 });
  assert.equal(sk.spans.filter((s) => s.id === ROOT).length, 1, 'a span the store holds is not added again');
  assert.deepEqual(sk.spans.find((s) => s.kind === 'answer').text, { g: 'run', id: 'r1', answer: true });
});
test('a stored trace opens as explorer spans, with the run step text linked and an answer', async () => {
  const { store, g2 } = storedFixture();
  const sk = await createGatewayAdapter(g2, store).skeleton(null, `trace:${TS}`);
  assert.deepEqual(validate(sk.spans), []);
  const by = (name) => sk.spans.find((s) => s.name === name);
  const root = by('POST /v1/collaborate');
  assert.equal(root.parent, null);
  assert.equal(root.kind, 'session');
  assert.equal(root.start, R0);
  assert.equal(by('invoke_agent a').kind, 'agent');
  const chat = by('chat m');
  assert.equal(chat.kind, 'chat');
  assert.deepEqual(chat.usage, { input: 3, output: 3, cacheRead: 2 });
  assert.equal(chat.cost, 0.001);
  assert.equal(chat.model, 'm');
  assert.equal(chat.provider, 'openai');
  assert.equal(chat.service, 'zaafpulse');
  assert.deepEqual(chat.text, { g: 'run', id: 'r1', step: 0 });
  const tool = by('execute_tool web');
  assert.equal(tool.status, 'error');
  assert.equal(tool.error, 'HTTP 500');
  assert.deepEqual(tool.tool, { name: 'web', target: null });
  const answer = sk.spans.find((s) => s.kind === 'answer');
  assert.equal(answer.parent, ROOT);
  assert.deepEqual(answer.text, { g: 'run', id: 'r1', answer: true });
  assert.equal(sk.session.start, R0);
  await assert.rejects(createGatewayAdapter(g2, store).skeleton(null, `trace:${'c'.repeat(32)}`), (e) => e.status === 404);
});

test('registry: stored gateway rows are found by agent, model or tool', () => {
  const { store, g2 } = storedFixture();
  const t = createTrace({ gateway: g2, traceStore: store, light: [] });
  const titles = (q) => t.sessions({ q, range: 30 }).map((r) => r.title);
  assert.deepEqual(titles('web'), ['vote run · completed · 2 steps']); // the run's row, by its stored trace's tags
  assert.equal(titles('m').length, 5); // the run and the stored request, and three requests the store does not hold
  assert.deepEqual(titles('no-such-agent'), []);

});

test('registry: tags are searched (agent id and model names that are in no title)', () => {
  const { store, g2 } = storedFixture();
  const T9 = '9'.repeat(32);
  store.writeSpans([
    rec(T9, '6'.repeat(16), null, 'POST /v1/collaborate', 'server', R0 + 30000, 500),
    rec(T9, '7'.repeat(16), '6'.repeat(16), 'invoke_agent planner-7', 'internal', R0 + 30010, 400, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'planner-7' }),
    rec(T9, '8'.repeat(16), '7'.repeat(16), 'chat alpha-1', 'client', R0 + 30020, 100, { ...storedChatAttrs, 'gen_ai.request.model': 'alpha-1' }),
    rec(T9, 'e'.repeat(16), '7'.repeat(16), 'chat beta-2', 'client', R0 + 30150, 100, { ...storedChatAttrs, 'gen_ai.request.model': 'beta-2' }),
  ]);
  const t = createTrace({ gateway: g2, traceStore: store, light: [] });
  const titles = (q) => t.sessions({ q, range: 30 }).map((r) => r.title);
  const T9TITLE = 'POST /v1/collaborate · 4 spans · 2 models';
  assert.ok(titles().includes(T9TITLE));
  assert.deepEqual(titles('planner-7'), [T9TITLE]);
  assert.deepEqual(titles('beta-2'), [T9TITLE]);
});

test('a running run keeps its run: row and shows its real tree while only chat spans are stored', async () => {
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
  store.writeSpans([rec(TS, CHAT, AGENT, 'chat m', 'client', R0 + 200, 1800, storedChatAttrs)]); // agent spans come at the end
  const working = {
    ...run,
    state: 'working',
    answer: undefined,
    createdAt: R0,
    updatedAt: R0 + 2000,
    otel: { traceId: TS, spanId: SERVER },
    trace: [
      { ...run.trace[0], end: null },
      { ...run.trace[1], end: null },
      run.trace[2],
    ],
  };
  const gw = { ...g, runs: () => [working], run: (id) => (id === 'r1' ? working : null), requests: () => [] };
  const a = createGatewayAdapter(gw, store);
  const rows = a.sessions();
  assert.deepEqual(rows.map((x) => x.id), ['run:r1']);
  const sk = await a.skeleton(null, 'run:r1');
  assert.deepEqual(validate(sk.spans), []);
  const chat = sk.spans.find((s) => s.name === 'chat m');
  assert.equal(chat.parent, AGENT, 'under its agent span, not flattened under the root');
  assert.deepEqual(chat.usage, { input: 3, output: 3, cacheRead: 2 });
  assert.deepEqual(chat.text, { g: 'run', id: 'r1', step: 0 });
  const agent = sk.spans.find((s) => s.id === AGENT);
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.parent, ROOT);
  assert.equal(agent.status, 'running');
  // The request span is not stored yet: the run's root is the trace's root.
  assert.equal(sk.spans.find((s) => s.id === ROOT).parent, null);
  assert.equal(sk.spans.filter((s) => !s.parent).length, 1);
  // A stored span changes the row's stamp, so a cached skeleton is not served stale.
  const before = rows[0].stamp;
  store.writeSpans([rec(TS, SERVER, 'f'.repeat(16), 'POST /v1/collaborate', 'server', R0, 100)]);
  assert.notEqual(a.sessions()[0].stamp, before);
  const sk2 = await a.skeleton(null, 'run:r1');
  assert.equal(sk2.spans.find((s) => s.id === ROOT).parent, SERVER, 'once stored, the request span holds the run');
});

test('registry: a stored run stays judgeable under its run: id', async () => {
  const { store, g2 } = storedFixture();
  const t = createTrace({ gateway: g2, traceStore: store, light: [], indexer: { entries: () => [] }, roots: [] });
  // What the eval engine's sweep reads: the gateway rows and the sid behind each key.
  const sids = t.sessions({ source: 'gateway', range: 30 }).map((r) => t.sourceOf(r.key).sid);
  assert.ok(sids.includes('run:r1'));
  assert.ok(!sids.includes(`trace:${TS}`));
  const m = await t.material('gateway', 'run:r1', 0);
  assert.ok(m, 'judgeable');
  assert.deepEqual(m.target, { source: 'gateway', session: 'run:r1', turn: 0, span: null });
  assert.ok(m.material.tools.some((x) => x.output === 'step a text'));
});

test('stored op and service are a known operation and masked', () => {
  const key = ['sk', 'ant', 'Ab3dE7gH1jK5mN9pQ2sT4vX6zC8'].join('-');
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
  store.writeSpans([
    rec(TS, SERVER, null, `${key} rest`, 'internal', R0, 100, {}, { svc: `svc.${key}` }),
    rec(TS, AGENT, SERVER, 'plan x', 'internal', R0 + 10, 50, { 'gen_ai.operation.name': `${key}` }),
  ]);
  return createGatewayAdapter(g, store).skeleton(null, `trace:${TS}`).then((sk) => {
    const first = sk.spans.find((s) => s.id === SERVER);
    assert.equal(first.op, 'span');
    assert.equal(sk.spans.find((s) => s.id === AGENT).op, 'plan');
    assert.ok(!JSON.stringify(sk.spans).includes(key));
    assert.ok(first.service.includes('hidden'));
  });
});

test('a remote span cannot take the place of ours, and carries no usage or cost', async () => {
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
  const CLIENT = '6'.repeat(16);
  const far = { src: 'remote', svc: 'far-agent' };
  store.writeSpans([
    rec(TQ, SERVER, null, 'POST /v1/agents/far', 'server', R0, 1000),
    rec(TQ, CLIENT, SERVER, 'a2a far', 'client', R0 + 10, 900, { 'gen_ai.agent.id': 'far' }),
    // The callee knows our client span id from the traceparent; a longer copy must not replace ours.
    rec(TQ, CLIENT, SERVER, 'forged', 'client', R0 - 5000, 60000, {}, far),
    rec(TQ, '7'.repeat(16), CLIENT, 'chat far-model', 'client', R0 + 20, 500, storedChatAttrs, far),
  ]);
  const sk = await createGatewayAdapter(g, store).skeleton(null, `trace:${TQ}`);
  assert.deepEqual(validate(sk.spans), []);
  assert.equal(sk.spans.filter((s) => s.id === CLIENT).length, 1);
  assert.equal(sk.spans.find((s) => s.id === CLIENT).name, 'a2a far');
  assert.ok(!sk.spans.some((s) => s.name === 'forged'));
  const chat = sk.spans.find((s) => s.name === 'chat far-model');
  assert.equal(chat.kind, 'chat');
  assert.equal(chat.usage, null);
  assert.equal(chat.cost, null);
  assert.equal(chat.service, 'far-agent');
  assert.equal(sk.session.start, R0);
});

test('stored rows are rebuilt only when the store changed', () => {
  const { store, g2 } = storedFixture();
  let reads = 0;
  const summaries = store.summaries;
  store.summaries = () => (reads++, summaries());
  const a = createGatewayAdapter({ ...g2, runs: () => [] }, store);
  const first = a.sessions().filter((r) => r.id.startsWith('trace:')).length;
  a.sessions();
  assert.equal(reads, 1, 'same generation: the rows of the last listing');
  store.writeSpans([rec('c'.repeat(32), '9'.repeat(16), null, 'POST /v1/chat/completions', 'server', R0 + 40000, 100)]);
  assert.equal(a.sessions().filter((r) => r.id.startsWith('trace:')).length, first + 1);
  assert.equal(reads, 2);
});

test('a failed model call shows once in the run: skeleton, under the id the run reserved for it', async () => {
  const otel = require('../lib/otel');
  const { createRecorder } = require('../lib/trace/recorder');
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
  const recorder = createRecorder({ store, flushMs: 0 });
  const o = otel.createOtel({ getConfig: () => ({}), env: {}, refreshMs: 0, log: () => {}, sink: recorder });
  const C0 = Date.now() - 10000;
  const ctx = (sp) => ({ traceId: TS, spanId: runSpanId('r1', sp), sampled: true });
  const attempt = (ms, extra = {}) => ({ ts: C0 + ms, ms: 100, model: 'm', provider: 'p', kind: 'agent', status: 200, input: 5, output: 3, cost: 0.001, ...extra });
  // What rt.llm does for each call: the gateway's attempts run inside within(), with the run span's id reserved.
  const call = (parent, chat, attempts) =>
    o
      .within(ctx(parent), async () => {
        for (const a of attempts) {
          o.onUsage(a);
          await null;
        }
        if (attempts.every((a) => a.status >= 400)) throw new Error('upstream failed');
      }, runSpanId('r1', chat))
      .catch(() => {});
  const chat = (id, parent, start, end, status) => ({ id, parent, name: 'chat m', start, end, status, ...(status === 'error' ? { error: 'upstream failed' } : {}), attrs: { 'zp.agent': 'a', 'gen_ai.request.model': 'm' } });
  const make = (trace, extra = {}) => ({ ...run, createdAt: C0, updatedAt: C0 + 5000, otel: { traceId: TS, spanId: '', sampled: true }, trace, ...extra });
  const chatsOf = async (r) => {
    recorder.flush();
    const gw = { ...g, runs: () => [r], run: (id) => (id === r.id ? r : null), requests: () => [] };
    const sk = await createGatewayAdapter(gw, store).skeleton(null, 'run:r1');
    assert.deepEqual(validate(sk.spans), []);
    return sk;
  };
  const top = { id: 'x0', parent: null, name: 'invoke_workflow vote', start: 0, end: 5000, status: 'ok', attrs: {} };
  const agent = { id: 'x1', parent: 'x0', name: 'invoke_agent a', start: 100, end: 3000, status: 'ok', attrs: {} };

  // 1. A run whose only call failed (two attempts, both failed).
  await call('x1', 'c1', [attempt(300, { status: 599, error: 'network', input: 0, output: 0 }), attempt(500, { status: 500, error: 'HTTP 500', input: 0, output: 0 })]);
  let r = make([top, agent, chat('c1', 'x1', 200, 600, 'error')], { state: 'failed', answer: undefined });
  for (const exported of [false, true]) {
    if (exported) o.exportRun(r, r.trace);
    const sk = await chatsOf(r);
    const own = sk.spans.filter((s) => s.id === runSpanId('r1', 'c1'));
    assert.equal(own.length, 1, 'the run span and the stored last attempt are one span');
    assert.equal(own[0].provider, 'p', 'the stored span, with provider details');
    assert.equal(own[0].status, 'error');
    // The first attempt is its own (stored) chat span; the run's span is not added a second time.
    assert.equal(sk.spans.filter((s) => s.kind === 'chat').length, 2);
    assert.equal(sk.spans.filter((s) => s.status === 'error').length, 2, 'one error per failed attempt, none doubled');
  }

  // 2. One failed call, then a successful one: exactly one chat span per run.trace chat span.
  const T2 = 'c'.repeat(32);
  const ctx2 = (sp) => ({ traceId: T2, spanId: runSpanId('r2', sp), sampled: true });
  await o.within(ctx2('x1'), async () => o.onUsage(attempt(300, { status: 500, error: 'HTTP 500', input: 0, output: 0 })), runSpanId('r2', 'c1'));
  await o.within(ctx2('x1'), async () => o.onUsage(attempt(1000)), runSpanId('r2', 'c2'));
  r = { ...make([top, agent, chat('c1', 'x1', 200, 400, 'error'), chat('c2', 'x1', 900, 1100, 'ok')]), id: 'r2', otel: { traceId: T2, spanId: '', sampled: true } };
  recorder.flush();
  const gw2 = { ...g, runs: () => [r], run: (id) => (id === 'r2' ? r : null), requests: () => [] };
  const sk = await createGatewayAdapter(gw2, store).skeleton(null, 'run:r2');
  assert.deepEqual(validate(sk.spans), []);
  const chats = sk.spans.filter((s) => s.kind === 'chat');
  assert.deepEqual(chats.map((s) => s.id).sort(), [runSpanId('r2', 'c1'), runSpanId('r2', 'c2')].sort());
  assert.ok(chats.every((s) => s.provider === 'p'));
  assert.equal(sk.spans.filter((s) => s.status === 'error').length, 1);
});

test('a resumed run with no stored span above its executions is still one tree', async () => {
  // A dashboard run (run.otel.spanId '') resumed once: each execution has its own root workflow span.
  const rtrace = [
    { id: 'x0', parent: null, name: 'invoke_workflow vote', start: 10, end: 4910, status: 'ok', attrs: {} },
    { id: 'x1', parent: 'x0', name: 'invoke_agent a', start: 100, end: 3000, status: 'ok', attrs: {} },
    { id: 'x2', parent: 'x1', name: 'chat m', start: 200, end: 2000, status: 'ok', attrs: { 'zp.agent': 'a', 'gen_ai.request.model': 'm' } },
    { id: 'y0', parent: null, name: 'invoke_workflow vote', start: 6000, end: 7000, status: 'ok', attrs: {} },
    { id: 'y1', parent: 'y0', name: 'invoke_agent b', start: 6100, end: 6900, status: 'ok', attrs: {} },
    { id: 'y2', parent: 'y1', name: 'chat m', start: 6200, end: 6800, status: 'ok', attrs: { 'zp.agent': 'b', 'gen_ai.request.model': 'm' } },
  ];
  const id = (x) => runSpanId('r1', x);
  const resumed = { ...run, createdAt: R0, updatedAt: R0 + 7000, trace: rtrace, otel: { traceId: TS, spanId: '', sampled: true } };
  const open = async (records, r) => {
    const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
    store.writeSpans(records);
    const gw = { ...g, runs: () => [r], run: (i) => (i === 'r1' ? r : null), requests: () => [] };
    const sk = await createGatewayAdapter(gw, store).skeleton(null, 'run:r1');
    assert.deepEqual(validate(sk.spans), [], 'one root, every parent present');
    const ids = sk.spans.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    return sk;
  };
  // Both executions exported: two stored workflow spans without a parent.
  let sk = await open(
    [
      rec(TS, id('x0'), null, 'invoke_workflow vote', 'internal', R0 + 10, 4900, { 'zaafpulse.run.id': 'r1' }),
      rec(TS, id('x1'), id('x0'), 'invoke_agent a', 'internal', R0 + 100, 2900),
      rec(TS, id('x2'), id('x1'), 'chat m', 'client', R0 + 200, 1800, storedChatAttrs),
      rec(TS, id('y0'), null, 'invoke_workflow vote', 'internal', R0 + 6000, 1000, { 'zaafpulse.run.id': 'r1' }),
      rec(TS, id('y1'), id('y0'), 'invoke_agent b', 'internal', R0 + 6100, 800),
      rec(TS, id('y2'), id('y1'), 'chat m', 'client', R0 + 6200, 600, storedChatAttrs),
    ],
    resumed,
  );
  const root = sk.spans.find((s) => !s.parent);
  assert.equal(root.kind, 'session');
  assert.equal(root.start, R0 + 10);
  assert.equal(root.end, R0 + 7000);
  assert.deepEqual(sk.spans.filter((s) => s.parent === root.id).map((s) => s.id).sort(), [id('x0'), id('y0')].sort());
  assert.equal(sk.spans.find((s) => s.kind === 'answer').parent, id('y0'), 'the answer stays with the last execution');
  // The second execution still running, only its chat spans stored: the two run.trace roots are merged in.
  sk = await open(
    [rec(TS, id('x2'), id('x1'), 'chat m', 'client', R0 + 200, 1800, storedChatAttrs), rec(TS, id('y2'), id('y1'), 'chat m', 'client', R0 + 6200, 600, storedChatAttrs)],
    { ...resumed, state: 'working', answer: undefined, trace: rtrace.map((s) => (s.id === 'y0' || s.id === 'y1' ? { ...s, end: null } : s)) },
  );
  const live = sk.spans.find((s) => !s.parent);
  assert.equal(live.status, 'running');
  assert.equal(live.end, null);
  assert.deepEqual(sk.spans.filter((s) => s.parent === live.id).map((s) => s.id).sort(), [id('x0'), id('y0')].sort());
});

test('a resumed run keeps one tree shape while its second execution is live and after it is exported', async () => {
  // Dashboard run (no request span): the first execution is exported, the second still live.
  const id = (x) => runSpanId('r1', x);
  const rtrace = [
    { id: 'x0', parent: null, name: 'invoke_workflow vote', start: 10, end: 4910, status: 'ok', attrs: {} },
    { id: 'x1', parent: 'x0', name: 'invoke_agent a', start: 100, end: 3000, status: 'ok', attrs: {} },
    { id: 'y0', parent: null, name: 'invoke_workflow vote', start: 6000, end: null, status: 'running', attrs: {} },
    { id: 'y1', parent: 'y0', name: 'invoke_agent b', start: 6100, end: null, status: 'running', attrs: {} },
  ];
  const first = [
    rec(TS, id('x0'), null, 'invoke_workflow vote', 'internal', R0 + 10, 4900, { 'zaafpulse.run.id': 'r1' }),
    rec(TS, id('x1'), id('x0'), 'invoke_agent a', 'internal', R0 + 100, 2900),
  ];
  const view = async (records, r) => {
    const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
    store.writeSpans(records);
    const gw = { ...g, runs: () => [r], run: (i) => (i === 'r1' ? r : null), requests: () => [] };
    const sk = await createGatewayAdapter(gw, store).skeleton(null, 'run:r1');
    assert.deepEqual(validate(sk.spans), []);
    return sk.spans;
  };
  const shape = (spans) => {
    const root = spans.find((x) => !x.parent);
    const wf = spans.filter((x) => x.parent === root.id && /^invoke_workflow/.test(x.name)).map((x) => x.id).sort();
    return { rootKind: root.kind, wf, y1Parent: spans.find((x) => x.id === id('y1')).parent };
  };
  const live = { ...run, createdAt: R0, updatedAt: R0 + 6500, state: 'working', answer: undefined, trace: rtrace, otel: { traceId: TS, spanId: '', sampled: true } };
  const during = shape(await view(first, live));
  assert.deepEqual(during, { rootKind: 'session', wf: [id('x0'), id('y0')].sort(), y1Parent: id('y0') }, 'the second execution is a sibling, not under the first');
  const done = { ...live, state: 'completed', updatedAt: R0 + 7000, answer: 'ans', trace: rtrace.map((x) => (x.end == null ? { ...x, end: 7000, status: 'ok' } : x)) };
  const after = shape(
    await view([...first, rec(TS, id('y0'), null, 'invoke_workflow vote', 'internal', R0 + 6000, 1000), rec(TS, id('y1'), id('y0'), 'invoke_agent b', 'internal', R0 + 6100, 800)], done),
  );
  assert.deepEqual(after, during);
});

test('an integration tool call is one call in eval material, with or without the store', async () => {
  // The agent's execute_tool span, and the integration's own span nested inside it (the same call).
  const store = createTraceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gw-store-')) });
  const id = (x) => runSpanId('r1', x);
  store.writeSpans([
    rec(TS, SERVER, null, 'POST /v1/collaborate', 'server', R0, 5000),
    rec(TS, id('x0'), SERVER, 'invoke_workflow vote', 'internal', R0 + 10, 4900, { 'zaafpulse.run.id': 'r1' }),
    rec(TS, id('x1'), id('x0'), 'invoke_agent a', 'internal', R0 + 100, 2900),
    rec(TS, id('x2'), id('x1'), 'chat m', 'client', R0 + 200, 800, { 'gen_ai.operation.name': 'chat' }),
    rec(TS, id('t1'), id('x1'), 'execute_tool web', 'internal', R0 + 1100, 500, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web' }),
    rec(TS, '7'.repeat(16), id('t1'), 'execute_tool web', 'client', R0 + 1150, 400, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web', 'zaafpulse.tool.nested': true }),
  ]);
  const r = {
    ...run,
    createdAt: R0,
    updatedAt: R0 + 5000,
    otel: { traceId: TS, spanId: SERVER },
    steps: [{ n: 1, agent: 'a', model: 'm', text: 'step a', status: 'done' }],
    trace: [
      { id: 'x0', parent: null, name: 'invoke_workflow vote', start: 10, end: 4910, status: 'ok', attrs: {} },
      { id: 'x1', parent: 'x0', name: 'invoke_agent a', start: 100, end: 3000, status: 'ok', attrs: {} },
      { id: 'x2', parent: 'x1', name: 'chat m', start: 200, end: 1000, status: 'ok', attrs: {} },
      { id: 't1', parent: 'x1', name: 'execute_tool web', start: 1100, end: 1600, status: 'ok', attrs: {} },
    ],
  };
  const gw = { ...g, runs: () => [r], run: (i) => (i === 'r1' ? r : null), requests: () => [] };
  const toolsOf = async (ts) => {
    const t = createTrace({ gateway: gw, traceStore: ts, light: [], indexer: { entries: () => [] }, roots: [] });
    t.sessions({ source: 'gateway', range: 30 });
    const m = await t.material('gateway', 'run:r1', 0);
    return m.material.tools.map((x) => x.name);
  };
  const without = await toolsOf(null);
  assert.equal(without.filter((n) => /web/.test(n)).length, 1);
  assert.deepEqual(await toolsOf(store), without);
  // The nested span is still shown, marked, so a count of tool calls can leave it out.
  const sk = await createGatewayAdapter(gw, store).skeleton(null, 'run:r1');
  const tools = sk.spans.filter((s) => s.kind === 'tool');
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((s) => !!s.nested).sort(), [false, true]);
  assert.equal(tools.find((s) => s.nested).parent, id('t1'));
  const { totals } = require('../lib/trace/model');
  assert.equal(totals(sk.spans).tools, 1);
});
