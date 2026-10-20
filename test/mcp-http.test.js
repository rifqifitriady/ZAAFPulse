// The gateway's MCP endpoint over HTTP (Streamable HTTP, 2025-06-18) and the URLs it advertises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');

async function setup({ gateway: gwConfig = {}, ...opts } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-mcp-http-'));
  const calls = [];
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({ gateway: gwConfig }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({
      listTools: async () => [{ name: 'acc_x', description: 'x', inputSchema: { type: 'object' } }],
      callTool: async (name, args) => (calls.push(name), { result: { content: [{ type: 'text', text: 'ok' }] } }),
    }),
    ...opts,
  });
  const server = http.createServer(async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) (res.writeHead(404), res.end());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { key, method = 'POST', body, raw, headers = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* empty */
    }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { gateway, call, calls, base, close: () => server.close() };
}
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('mcp http: a batch cannot run past the key rate limit, and is capped', async () => {
  const t = await setup();
  try {
    const key = t.gateway.keys.create({ name: 'slow', scopes: ['mcp'], rpm: 2 }).secret;
    // The review's attack: 1,000 tool calls in one POST with a key allowed 2 requests per minute.
    const flood = Array.from({ length: 1000 }, (_, i) => rpc(i + 1, 'tools/call', { name: 'acc_x' }));
    const big = await t.call('/mcp', { key, body: flood });
    assert.equal(big.status, 400);
    assert.equal(big.json.error.code, -32600);
    assert.match(big.json.error.message, /at most 20/);
    assert.equal(t.calls.length, 0, 'nothing ran');
    // Three messages are three requests: over a limit of two.
    const three = await t.call('/mcp', { key, body: flood.slice(0, 3) });
    assert.equal(three.status, 429);
    assert.ok(Number(three.headers.get('retry-after')) > 0);
    assert.equal(t.calls.length, 0);
    // A key with room runs a small batch and gets one reply per request.
    const roomy = t.gateway.keys.create({ name: 'roomy', scopes: ['mcp'], rpm: 60 }).secret;
    const ok = await t.call('/mcp', {
      key: roomy,
      body: [rpc(1, 'ping'), rpc(2, 'tools/call', { name: 'acc_x' }), { jsonrpc: '2.0', method: 'notifications/x' }],
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      ok.json.map((r) => r.id),
      [1, 2],
    );
    // …and the batch was charged per message: 3 used, so 57 more single requests fit, then 429.
    let last;
    for (let i = 0; i < 58; i++) last = (await t.call('/mcp', { key: roomy, body: rpc(i, 'ping') })).status;
    assert.equal(last, 429);
  } finally {
    t.close();
  }
});

test('mcp http: batches are refused for 2025-06-18 and later, by header or by initialize', async () => {
  const t = await setup();
  try {
    const key = t.gateway.keys.create({ name: 'm', scopes: ['mcp'] }).secret;
    const byHeader = await t.call('/mcp', {
      key,
      body: [rpc(1, 'ping'), rpc(2, 'ping')],
      headers: { 'mcp-protocol-version': '2025-06-18' },
    });
    assert.equal(byHeader.status, 400);
    assert.deepEqual(Object.keys(byHeader.json).sort(), ['error', 'id', 'jsonrpc']);
    assert.equal(byHeader.json.id, null);
    assert.match(byHeader.json.error.message, /batches/);
    const byInit = await t.call('/mcp', {
      key,
      body: [rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c' } })],
    });
    assert.equal(byInit.status, 400);
    const empty = await t.call('/mcp', { key, body: [] });
    assert.equal(empty.status, 400);
  } finally {
    t.close();
  }
});

test('mcp http: protocol version header, parse errors, no session id, 202 for responses', async () => {
  const t = await setup();
  try {
    const key = t.gateway.keys.create({ name: 'm', scopes: ['mcp'] }).secret;
    const bad = await t.call('/mcp', { key, body: rpc(1, 'ping'), headers: { 'mcp-protocol-version': '1999-01-01' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.jsonrpc, '2.0');
    assert.match(bad.json.error.message, /MCP-Protocol-Version/);
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', undefined]) {
      const r = await t.call('/mcp', { key, body: rpc(1, 'ping'), headers: v ? { 'mcp-protocol-version': v } : {} });
      assert.equal(r.status, 200, String(v));
      assert.equal(r.headers.get('mcp-session-id'), null, 'stateless: no session id');
    }
    const parse = await t.call('/mcp', { key, raw: '{"jsonrpc":"2.0",' });
    assert.equal(parse.status, 400);
    assert.deepEqual(parse.json, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    const response = await t.call('/mcp', { key, body: { jsonrpc: '2.0', id: 5, result: {} } });
    assert.equal(response.status, 202);
    assert.equal(response.text, '');
  } finally {
    t.close();
  }
});

test('mcp http: 401 names the bearer scheme; CORS lets browser MCP clients send their headers', async () => {
  const t = await setup();
  try {
    for (const [p, body] of [
      ['/mcp', rpc(1, 'ping')],
      ['/v1/chat/completions', { model: 'x', messages: [] }],
    ]) {
      const r = await t.call(p, { body });
      assert.equal(r.status, 401, p);
      assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="zaafpulse"', p);
    }
    assert.equal(
      (await t.call('/v1/models', { method: 'GET' })).headers.get('www-authenticate'),
      'Bearer realm="zaafpulse"',
    );
    const pre = await t.call('/mcp', { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    for (const h of ['mcp-protocol-version', 'mcp-session-id', 'last-event-id'])
      assert.match(pre.headers.get('access-control-allow-headers'), new RegExp(`\\b${h}\\b`));
    assert.match(pre.headers.get('access-control-expose-headers'), /\bmcp-session-id\b/);
  } finally {
    t.close();
  }
});
