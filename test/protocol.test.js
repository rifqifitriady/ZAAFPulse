const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { createServer } = require('../lib/mcp/protocol');

const server = () =>
  createServer({
    name: 'acc',
    version: '1.0.0',
    listTools: async () => [{ name: 'acc_x', description: 'x', inputSchema: { type: 'object' } }],
    callTool: async (name, args) =>
      name === 'acc_x'
        ? { result: { content: [{ type: 'text', text: JSON.stringify(args) }] } }
        : { error: { code: -32602, message: `Unknown tool: ${name}` } },
  });
const ask = async (s, msg) => {
  const out = await s.handleLine(JSON.stringify(msg));
  return out && JSON.parse(out);
};
const init = (v) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

test('initialize echoes a supported protocol version', async () => {
  const r = await ask(server(), init('2025-03-26'));
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.serverInfo, { name: 'acc', version: '1.0.0' });
  assert.ok(r.result.capabilities.tools);
});

test('initialize offers the newest version for an unknown one', async () => {
  const r = await ask(server(), init('1999-01-01'));
  assert.equal(r.result.protocolVersion, '2025-11-25');
});

test('tools/list and tools/call', async () => {
  const s = server();
  const list = await ask(s, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools[0].name, 'acc_x');
  const call = await ask(s, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'acc_x', arguments: { a: 1 } },
  });
  assert.equal(call.result.content[0].text, '{"a":1}');
});

test('unknown tool is a JSON-RPC error', async () => {
  const r = await ask(server(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(r.error.code, -32602);
});

test('unknown method', async () => {
  const r = await ask(server(), { jsonrpc: '2.0', id: 5, method: 'resources/list' });
  assert.equal(r.error.code, -32601);
});

test('notifications get no reply', async () => {
  assert.equal(
    await server().handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
    null,
  );
});

test('malformed JSON is a parse error', async () => {
  const r = JSON.parse(await server().handleLine('{not json'));
  assert.deepEqual(r, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
});

test('serve answers every line before it resolves', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => {
    text += c;
  });
  const done = server().serve(input, output);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
  input.end();
  await done;
  assert.deepEqual(JSON.parse(text.trim()), { jsonrpc: '2.0', id: 7, result: {} });
});

test('a JSON-RPC response is dropped, never answered', async () => {
  const s = server();
  assert.equal(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} })), null);
  assert.equal(
    await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'x' } })),
    null,
  );
  // An id with neither a method nor a result is still an invalid request.
  assert.equal((await ask(s, { jsonrpc: '2.0', id: 9 })).error.code, -32600);
});

test('params: null means no params; arguments must be an object', async () => {
  const s = server();
  assert.ok((await ask(s, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: null })).result.tools);
  assert.ok((await ask(s, { jsonrpc: '2.0', id: 2, method: 'ping', params: null })).result);
  const nullArgs = await ask(s, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'acc_x', arguments: null },
  });
  assert.equal(nullArgs.result.content[0].text, '{}');
  const bad = await ask(s, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'acc_x', arguments: 'x' } });
  assert.equal(bad.error.code, -32602);
  assert.equal((await ask(s, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: 'x' })).error.code, -32602);
  assert.equal(
    (await ask(s, { jsonrpc: '2.0', id: 6, method: 'initialize', params: null })).result.protocolVersion,
    '2025-11-25',
  );
});

test('initialize accepts 2025-11-25 and every older supported version', async () => {
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
    assert.equal((await ask(server(), init(v))).result.protocolVersion, v);
});
