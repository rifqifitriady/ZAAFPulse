const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const otel = require('../lib/otel');

function setup(on = () => true) {
  const got = [];
  const o = otel.createOtel({
    getConfig: () => ({}),
    env: {},
    refreshMs: 0,
    log: () => {},
    sink: { enabled: on, add: (r) => got.push(r) },
  });
  return { o, got };
}
const usage = (extra = {}) => ({ ts: Date.now(), ms: 5, model: 'm', provider: 'p', status: 200, kind: 'chat', input: 3, output: 2, cost: 0.01, ...extra });

test('sink: spans reach the local sink while OTLP export is off', () => {
  const { o, got } = setup();
  assert.equal(o.status().enabled, false);
  assert.equal(o.live(), true);
  o.startSpan('x').end();
  o.onUsage(usage());
  o.toolCall('t', { id: 'f', type: 'http' }, { a: 1 }).end(true, { content: [{ type: 'text', text: 'result' }] });
  assert.deepEqual(got.map((r) => r.name), ['x', 'chat m', 'execute_tool t']);
  const tool = got[2];
  assert.equal(tool.attributes['gen_ai.tool.call.arguments'], undefined);
  assert.equal(tool.attributes['gen_ai.tool.call.result'], undefined);
});

test('sink: a disabled sink and no export means no spans at all', () => {
  const { o, got } = setup(() => false);
  assert.equal(o.live(), false);
  o.onUsage(usage());
  o.toolCall('t', { id: 'f', type: 'http' }, {}).end(true, { content: [] });
  assert.equal(got.length, 0);
});

test('sink: a gateway request is traced for the sink, continues traceparent, and copies no body', async () => {
  const { o, got } = setup();
  let iterWrapped = null;
  const server = http.createServer(
    o.wrapHandler(async (req, res) => {
      iterWrapped = Object.hasOwn(req, Symbol.asyncIterator);
      for await (const _ of req); // the gateway reads the body this way
      o.onUsage(usage());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }));
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent: parent },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'secret prompt' }] }),
    });
    await r.text();
    await new Promise((res) => setTimeout(res, 20));
    const serverSpan = got.find((s) => s.kind === 2);
    const chat = got.find((s) => s.name === 'chat m');
    assert.equal(serverSpan.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(serverSpan.parentSpanId, '00f067aa0ba902b7');
    assert.equal(chat.parentSpanId, serverSpan.spanId);
    assert.equal(chat.attributes['gen_ai.response.id'], 'chatcmpl-1');
    assert.equal(iterWrapped, false, 'the request body is not copied when export is off');
    assert.ok(!JSON.stringify(got, (k, v) => (typeof v === 'bigint' ? String(v) : v)).includes('secret prompt'));
  } finally {
    server.close();
  }
});

test('sink: a sink that throws never breaks the hooks', () => {
  for (const sink of [
    { enabled: () => { throw new Error('boom'); }, add: () => {} },
    { enabled: () => true, add: () => { throw new Error('boom'); } },
  ]) {
    const o = otel.createOtel({ getConfig: () => ({}), env: {}, refreshMs: 0, log: () => {}, sink });
    assert.doesNotThrow(() => {
      o.startSpan('x').end();
      o.onUsage(usage());
      o.toolCall('t', { id: 'f', type: 'http' }, {}).end(true, { content: [] });
    });
  }
});

test('sink: within() parents the spans started inside it; the first successful model call takes the given id', () => {
  const { o, got } = setup();
  const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
  o.within(parent, () => {
    o.onUsage(usage({ status: 500, error: 'upstream' }));
    o.onUsage(usage());
    o.onUsage(usage());
  }, 'c'.repeat(16));
  assert.equal(got.length, 3);
  for (const r of got) {
    assert.equal(r.traceId, 'a'.repeat(32));
    assert.equal(r.parentSpanId, 'b'.repeat(16));
  }
  assert.notEqual(got[0].spanId, 'c'.repeat(16), 'a failed attempt keeps a random id');
  assert.equal(got[1].spanId, 'c'.repeat(16));
  assert.notEqual(got[2].spanId, 'c'.repeat(16), 'the id is used once');
});

test('sink: a run exported with its fixed trace context and an explicit span list', () => {
  const { o, got } = setup();
  const T0 = Date.now() - 1000;
  const spans = [
    { id: 'r0', parent: null, name: 'invoke_workflow auto', start: 0, end: 900, status: 'ok', attrs: { 'zp.pattern': 'auto' } },
    { id: 'r1', parent: 'r0', name: 'invoke_agent a', start: 10, end: 800, status: 'ok', attrs: { 'zp.agent': 'a', 'zp.cost_usd': 0.5 } },
  ];
  o.exportRun({ id: 'run_9', pattern: 'auto', state: 'completed', createdAt: T0, updatedAt: T0 + 900, otel: { traceId: 'd'.repeat(32), spanId: 'e'.repeat(16), sampled: true }, trace: [] }, spans);
  const [root, agent] = got;
  assert.equal(root.traceId, 'd'.repeat(32));
  assert.equal(root.parentSpanId, 'e'.repeat(16));
  assert.equal(root.spanId, otel.runSpanId('run_9', 'r0'));
  assert.equal(agent.parentSpanId, root.spanId);
  assert.equal(agent.attributes['gen_ai.agent.id'], 'a');
  assert.equal(agent.attributes['zaafpulse.cost.usd'], 0.5);
  // Outside a request, a run gets a stable trace of its own and no parent.
  const own = o.runContext('run_9');
  assert.match(own.traceId, /^[0-9a-f]{32}$/);
  assert.deepEqual(o.runContext('run_9'), { traceId: own.traceId, spanId: '', sampled: true });
});

test('sink: a span book nests agent, tool and model spans like a run does', () => {
  const { o, got } = setup();
  const book = o.spanBook();
  const agent = book.span('invoke_agent a', { 'gen_ai.operation.name': 'invoke_agent', 'zp.agent': 'a' });
  const tool = book.span('execute_tool t', { 'gen_ai.operation.name': 'execute_tool' }, agent.id);
  book.within(tool.id, () => o.toolCall('mcp_x', { id: 'm', type: 'mcp' }, {}).end(true, { content: [] }));
  tool.end({}, new Error('boom'));
  book.within(agent.id, () => o.onUsage(usage()));
  agent.end({ 'zp.cost_usd': 0.01 });
  const by = (n) => got.find((r) => r.name === n);
  assert.equal(by('execute_tool t').parentSpanId, agent.id);
  assert.equal(by('execute_tool t').status.code, 2);
  assert.equal(by('execute_tool mcp_x').parentSpanId, tool.id);
  assert.equal(by('chat m').parentSpanId, agent.id);
  assert.equal(by('invoke_agent a').attributes['gen_ai.agent.id'], 'a');
  assert.equal(by('invoke_agent a').attributes['zaafpulse.cost.usd'], 0.01);
  assert.deepEqual(book.traceCtx(agent.id).spanId, agent.id);
  assert.equal(setup(() => false).o.spanBook(), null);
});
