const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const otel = require('../lib/otel');
const { createOrchestrator } = require('../lib/gateway/orchestrator');
const { createClient } = require('../lib/mcp/client');
const { createIntegrations } = require('../lib/integrations');
const { tool } = require('../lib/connectors/base');
const { secretsFor } = require('./helpers');

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
function recording() {
  const got = [];
  otel.init({ getConfig: () => ({}), env: {}, refreshMs: 0, log: () => {}, sink: { enabled: () => true, add: (r) => got.push(r) } });
  return got;
}

test('propagation: a remote A2A agent gets the traceparent of a client span under its agent span', async () => {
  const got = recording();
  let headers = null;
  try {
    const orch = createOrchestrator({
      agents: { enabled: () => [], get: () => null },
      memory: { recall: () => [] },
      integrations: null,
      llm: async () => {
        throw new Error('not used');
      },
      getDefaults: () => ({ model: 'x' }),
      fetchImpl: async (url, init) => {
        headers = init.headers;
        return { json: async () => ({ result: { message: { parts: [{ text: 'pong' }] } } }) };
      },
    });
    const r = await orch.runAgent({ id: 'far', name: 'Far', remoteUrl: 'http://127.0.0.1:9/a2a', tools: [] }, 'ping', {});
    assert.equal(r.text, 'pong');
    const client = got.find((s) => s.name === 'a2a far');
    const agent = got.find((s) => s.name === 'invoke_agent far');
    assert.equal(client.kind, 3);
    assert.equal(client.parentSpanId, agent.spanId);
    assert.equal(client.attributes['server.address'], '127.0.0.1:9');
    assert.equal(client.attributes['rpc.system'], 'a2a');
    assert.equal(headers.traceparent, `00-${client.traceId}-${client.spanId}-01`);
  } finally {
    await otel.reset();
  }
});

test('propagation: no recording, no header', async () => {
  let headers = null;
  const orch = createOrchestrator({
    agents: { enabled: () => [], get: () => null },
    memory: { recall: () => [] },
    integrations: null,
    llm: async () => ({}),
    getDefaults: () => ({ model: 'x' }),
    fetchImpl: async (url, init) => {
      headers = init.headers;
      return { json: async () => ({ result: { message: { parts: [{ text: 'pong' }] } } }) };
    },
  });
  await orch.runAgent({ id: 'far', name: 'Far', remoteUrl: 'http://127.0.0.1:9/a2a', tools: [] }, 'ping', {});
  assert.equal(headers.traceparent, undefined);
});

test('propagation: the MCP client sends traceparent as a header and in _meta, only when given', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, header: req.headers.traceparent, meta: msg.params && msg.params._meta });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'up', version: '1' } } }));
      }
      if (!('id' in msg)) {
        res.writeHead(202);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = createClient({ url: `http://127.0.0.1:${server.address().port}/mcp` });
    await client.callTool('echo', {}, { traceparent: TP });
    await client.callTool('echo', {});
    const calls = seen.filter((s) => s.method === 'tools/call');
    assert.deepEqual(calls[0], { method: 'tools/call', header: TP, meta: { traceparent: TP } });
    assert.deepEqual(calls[1], { method: 'tools/call', header: undefined, meta: undefined });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('propagation: an integration tool gets the traceparent of its own execute_tool span', async () => {
  const got = recording();
  try {
    let meta = null;
    const fake = {
      type: 'fake',
      create: () => ({
        tools: [
          tool('echo', 'Echo', {}, async (args, m) => {
            meta = m;
            return 'ok';
          }),
        ],
        health: async () => ({ ok: true, latencyMs: 0 }),
      }),
    };
    const accFake = { type: 'acc', create: () => ({ tools: [], health: async () => ({ ok: true, latencyMs: 0 }) }) };
    const reg = createIntegrations({ config: { integrations: { f: { type: 'fake' } } }, secrets: secretsFor(), connectors: { fake, acc: accFake } });
    await reg.callTool('f_echo', {});
    const span = got.find((s) => s.name === 'execute_tool f_echo');
    assert.equal(meta.traceparent, `00-${span.traceId}-${span.spanId}-01`);
  } finally {
    await otel.reset();
  }
});
