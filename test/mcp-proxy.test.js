const test = require('node:test');
const assert = require('node:assert/strict');
const httpm = require('http');
const { secretsFor } = require('./helpers');
const proxy = require('../lib/connectors/mcp-proxy');
const { RAW } = require('../lib/connectors/base');

// A fake Streamable HTTP MCP server: JSON for initialize and calls, SSE for tools/list.
async function fakeMcp() {
  const seen = [];
  const server = httpm.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({
        method: msg.method,
        session: req.headers['mcp-session-id'],
        auth: req.headers.authorization,
        version: req.headers['mcp-protocol-version'],
      });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'up', version: '1' },
            },
          }),
        );
      }
      if (!('id' in msg)) {
        res.writeHead(202);
        return res.end();
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const tools = [
          {
            name: 'health_check',
            description: 'h',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
          { name: 'usage_get', description: 'u', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          {
            name: 'combo_delete',
            description: 'd',
            inputSchema: { type: 'object' },
            annotations: { destructiveHint: true },
          },
          {
            name: 'secret_dump',
            description: 's',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
        ];
        return res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } })}\n\n`,
        );
      }
      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: `called ${msg.params.name}` }] },
          }),
        );
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

test('lists filtered upstream tools and forwards calls with the session', async () => {
  const up = await fakeMcp();
  try {
    const c = proxy.create(
      'om',
      {
        url: up.url,
        auth: { prefix: 'Bearer ', secret: { env: 'T' } },
        include: ['health_*', 'usage_*', 'combo_*'],
        exclude: ['*secret*'],
      },
      { secrets: secretsFor({ T: 'oma_live_x1' }) },
    );
    const tools = await c.tools();
    assert.deepEqual(
      tools.map((t) => [t.name, t.write]),
      [
        ['health_check', false],
        ['usage_get', false],
        ['combo_delete', true],
      ],
    );
    assert.equal(tools[0].skipCheck, true);
    const r = await tools[0].run({});
    assert.equal(r[RAW], true);
    assert.deepEqual(r.content, [{ type: 'text', text: 'called health_check' }]);
    assert.deepEqual(
      up.seen.map((s) => s.method),
      ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
    );
    assert.equal(up.seen[2].session, 'sess-1');
    assert.equal(up.seen[2].version, '2025-06-18');
    assert.equal(up.seen[0].auth, 'Bearer oma_live_x1');
    await c.tools();
    assert.equal(up.seen.filter((s) => s.method === 'tools/list').length, 1, 'tool list is cached');
    assert.equal((await c.health()).ok, true);
  } finally {
    await up.close();
  }
});

test('reports an unreachable upstream as a failed health check', async () => {
  const c = proxy.create('x', { url: 'http://127.0.0.1:9/mcp' }, { secrets: secretsFor({}) });
  const h = await c.health();
  assert.equal(h.ok, false);
});

test('requires an http(s) url', () => {
  assert.throws(() => proxy.create('x', {}, { secrets: secretsFor({}) }), /url must start with http/);
});
