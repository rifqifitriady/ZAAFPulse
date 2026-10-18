const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const demoGw = require('../lib/demo-gateway');

test('demo gateway: the in-process model answers every wire format without the network', async () => {
  const f = demoGw.createDemoFetch();
  const models = await (await f('https://api.groq.com/openai/v1/models')).json();
  assert.ok(models.data.some((m) => m.id === 'llama-4-maverick'));
  const chat = await (await f('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-6.1-mini', messages: [{ role: 'user', content: 'hi' }] }) })).json();
  assert.ok(chat.choices[0].message.content.length > 10); assert.ok(chat.usage.prompt_tokens > 0);
  const msg = await (await f('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', system: 'You are the ZAAFPulse planner.', messages: [{ role: 'user', content: 'plan' }] }) })).json();
  assert.equal(JSON.parse(msg.content[0].text).steps.length, 4);
  const sse = await (await f('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: 'hi' }] }) })).text();
  assert.match(sse, /data: \[DONE\]/);
  const emb = await (await f('http://localhost:11434/v1/embeddings', { method: 'POST', body: JSON.stringify({ input: ['refund policy', 'refund request'] }) })).json();
  const [a, b] = emb.data.map((d) => d.embedding); assert.ok(a.reduce((s, x, i) => s + x * b[i], 0) > 0.3, 'texts on one topic land close together');
});

test('demo gateway: seeding fills keys, history, knowledge and brain files in a temporary folder', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-demo-gw-'));
  const realFetch = global.fetch; global.fetch = () => { throw new Error('no network in demo'); };
  try {
    const gateway = createGateway({ dataDir, toolsHome: dataDir, fetchImpl: demoGw.createDemoFetch(), getConfig: () => ({ gateway: demoGw.CONFIG }), writeGatewayConfig: () => {}, secrets: secretsFor(), resolveSecret: () => undefined, getPricing: () => ({}), getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }) });
    await demoGw.seed(gateway, { dataDir });
    assert.equal(gateway.keys.list().filter((k) => k.revokedAt).length, 1);
    assert.ok(gateway.usage.recent(2000).length > 500);
    assert.equal(gateway.knowledge.list().length, 3); assert.ok(gateway.knowledge.graph().every((d) => d.vector), 'demo documents are embedded');
    for (const s of demoGw.BRAIN_SOURCES(path.join(dataDir, 'brain')).filter((x) => x.path)) assert.ok(fs.existsSync(s.path), s.id);
  } finally { global.fetch = realFetch; }
});
