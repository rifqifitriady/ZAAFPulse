const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const { chunkText, toText } = require('../lib/gateway/knowledge');

const reply = (content, extra = {}) => ({
  body: {
    choices: [{ message: { role: 'assistant', content, ...extra } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
});
// Toy embeddings: a 3-d vector of keyword counts, enough to test cosine ranking.
const vec = (t) =>
  [/refund/gi, /network|outage/gi, /holiday|leave/gi].map((r) => (String(t).match(r) || []).length + 0.01);

async function setup({ privateHandler, externalHandler, approved = true }) {
  const priv = await fakeServer({
    'POST /chat/completions': privateHandler || (() => reply('private')),
    'POST /embeddings': (r) => ({
      body: { data: [].concat(r.body.input).map((t, index) => ({ index, embedding: vec(t) })) },
    }),
    'GET /models': { body: { data: [{ id: 'qwen' }] } },
  });
  const ext = await fakeServer({
    'POST /chat/completions': externalHandler || (() => reply('external')),
    'GET /models': { body: { data: [{ id: 'big' }] } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gwx-'));
  let gw = {
    providers: [
      { id: 'local', preset: 'vllm', baseUrl: priv.url, tier: 'private', approved: true },
      { id: 'cloud', preset: 'custom', baseUrl: ext.url, tier: 'external', approved },
    ],
    routes: [{ name: 'router/smart', targets: ['cloud/big', 'local/qwen'], strategy: 'fallback' }],
    defaults: { model: 'local/qwen' },
  };
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: (g) => {
      gw = g;
    },
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({ result: { content: [] } }) }),
  });
  const server = http.createServer(async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, key, body, method = 'POST') => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return {
    gateway,
    priv,
    ext,
    call,
    setGw: (f) => {
      gw = f(gw);
    },
    close: async () => {
      server.close();
      await priv.close();
      await ext.close();
    },
  };
}

test('RAG: chunking, ingestion, hybrid search over embeddings, and the knowledge API', async () => {
  assert.ok(chunkText('word. '.repeat(600)).length > 2);
  assert.equal(toText('<html><style>x{}</style><p>Hello &amp; bye</p></html>'), 'Hello & bye');
  const t = await setup({});
  try {
    const kb = t.gateway.knowledge.create({ id: 'policies', name: 'Policies', embedModel: 'local/qwen' });
    assert.ok(kb.kb);
    const r1 = await t.gateway.knowledge.ingest('policies', {
      title: 'Refunds',
      content: 'Refund within 30 days. A refund needs the receipt.',
    });
    assert.equal(r1.embedded, 1);
    await t.gateway.knowledge.ingest('policies', {
      title: 'Leave',
      content: 'Annual leave is 12 days. Holiday requests need approval.',
    });
    const s = await t.gateway.knowledge.search('policies', 'how do refunds work', 2);
    assert.equal(s.method, 'hybrid');
    assert.equal(s.results[0].document, 'Refunds');
    const key = t.gateway.keys.create({ name: 'r', scopes: ['rag'] }).secret;
    const api = await t.call('/v1/knowledge/policies/search', key, { query: 'holiday leave' });
    assert.equal(api.status, 200);
    assert.equal(api.json.results[0].document, 'Leave');
    const add = await t.call('/v1/knowledge/policies/documents', key, {
      title: 'Outages',
      content: 'During a network outage, post status every 30 minutes.',
    });
    assert.equal(add.status, 200);
    assert.equal(t.gateway.knowledge.list()[0].documents, 3);
    assert.equal(
      (await t.call('/v1/knowledge', t.gateway.keys.create({ name: 'n', scopes: ['llm'] }).secret, null, 'GET')).status,
      403,
    );
  } finally {
    await t.close();
  }
});

test('model router: falls back past a failing external target; approval and private-only policies', async () => {
  const t = await setup({ externalHandler: () => ({ status: 503, body: { error: { message: 'overloaded' } } }) });
  try {
    const key = t.gateway.keys.create({ name: 'k', scopes: ['llm'] }).secret;
    const r = await t.call('/v1/chat/completions', key, {
      model: 'router/smart',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'private');
    const logged = t.gateway.usage.recent(2);
    assert.equal(logged[1].status, 503);
    assert.equal(logged[0].provider, 'local');
    const priv = t.gateway.keys.create({ name: 'p', scopes: ['llm'], privateOnly: true }).secret;
    const blocked = await t.call('/v1/chat/completions', priv, { model: 'cloud/big', messages: [] });
    assert.equal(blocked.status, 404);
    assert.match(blocked.json.error.message, /private models only/);
    t.setGw((g) => ({ ...g, providers: g.providers.map((p) => (p.id === 'cloud' ? { ...p, approved: false } : p)) }));
    const unapproved = await t.call('/v1/chat/completions', key, { model: 'cloud/big', messages: [] });
    assert.match(unapproved.json.error.message, /not approved/);
    const models = await t.call('/v1/models', key, null, 'GET');
    assert.ok(models.json.data.some((m) => m.id === 'router/smart'));
    assert.ok(!models.json.data.some((m) => m.id === 'cloud/big'));
  } finally {
    await t.close();
  }
});

test('agent-to-agent: an agent consults a specialist through zp_ask_agent', async () => {
  const t = await setup({
    privateHandler: (r) => {
      const sys = r.body.messages[0].content;
      if (/You are the Customer Service agent/.test(sys)) {
        if (r.body.messages.some((m) => m.role === 'tool'))
          return reply('Here is the reply, with the refund rule from Finance.');
        return reply(null, {
          tool_calls: [
            {
              id: 'a1',
              type: 'function',
              function: {
                name: 'zp_ask_agent',
                arguments: JSON.stringify({ agent: 'hr-finance', question: 'What is the refund limit?' }),
              },
            },
          ],
        });
      }
      return reply('Refunds up to $100 need no approval.');
    },
  });
  try {
    const out = await t.gateway.orchestrator.runAgent(
      t.gateway.agents.get('customer-service'),
      'Customer wants a $80 refund',
      {},
    );
    assert.equal(out.calls[0].tool, 'zp_ask_agent');
    assert.match(out.text, /Finance/);
    const finance = t.priv.requests.find((r) => /You are the HR & Finance agent/.test(r.body.messages[0].content));
    assert.ok(finance); // the consulted agent ran with its own prompt
  } finally {
    await t.close();
  }
});

test('workflows: steps run in order and pass {{stepN}} outputs along', async () => {
  const t = await setup({
    privateHandler: (r) =>
      reply(
        `out of ${r.body.messages[0].content.match(/You are the (.+?) agent/)[1]}: ${r.body.messages.at(-1).content.slice(0, 40)}`,
      ),
  });
  try {
    // The ready-to-use catalog is installed; a deleted built-in stays deleted until restored.
    const { CATALOG } = require('../lib/gateway/workflow-catalog');
    assert.equal(t.gateway.workflows.list().length, CATALOG.length);
    assert.ok(CATALOG.length >= 24);
    assert.ok(t.gateway.workflows.list().every((w) => w.builtin && w.category && w.tier && w.sampleInput));
    assert.ok(t.gateway.workflows.remove('release-notes'));
    assert.ok(!t.gateway.workflows.get('release-notes'));
    assert.equal(
      t.gateway.workflows.restore('release-notes').steps.length,
      CATALOG.find((c) => c.id === 'release-notes').steps.length,
    );
    const edited = t.gateway.workflows.save({ ...t.gateway.workflows.get('release-notes'), name: 'My notes' }).workflow;
    assert.equal(edited.edited, true);
    assert.equal(edited.builtin, true);
    t.gateway.workflows.save({
      id: 'expense-review',
      name: 'Expense review',
      steps: [
        { agent: 'hr-finance', prompt: 'Review this expense or purchase against typical policy: {{input}}' },
        {
          agent: 'legal-compliance',
          prompt: 'Check compliance risks in this review and list what needs approval:\n{{step1}}',
        },
      ],
    });
    const key = t.gateway.keys.create({ name: 'w', scopes: ['agents'] }).secret;
    const r = await t.call('/v1/workflows/expense-review/run', key, { input: 'Laptop for $2,400' });
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.json.steps.map((s) => s.agent),
      ['hr-finance', 'legal-compliance'],
    );
    assert.match(r.json.steps[1].prompt, /out of HR & Finance/);
    assert.match(r.json.answer, /^out of Legal & Compliance/);
  } finally {
    await t.close();
  }
});
