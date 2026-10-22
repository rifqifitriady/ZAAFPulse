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
