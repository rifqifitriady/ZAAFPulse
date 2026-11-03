// Gateway guardrails (AI Governance 1) on every LLM path: the body that reaches the provider is the checked one, a
// private target is left alone under scope external, a block answers 400 in the caller's format and sends nothing, a
// check that throws fails closed, and the usage entry carries `guard` with labels and counts only. The providers are a
// local fake server (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fakeServer, secretsFor } = require('./helpers');
const signals = require('../lib/signals');
const { createGateway } = require('../lib/gateway');

const ANT = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';
const RED = '‹secret: Anthropic API key›';
const BLOCKED =
  'Blocked by ZAAFPulse guardrails: secret (Anthropic API key). Remove it, or ask the owner to change the policy.';
const oaReply = () => ({
  body: {
    id: 'c1',
    model: 'm1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  },
});

const embReply = () => ({ body: { data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } } });

async function setup({ guardrails, routes = [], chat = oaReply, embeddings = embReply, providers = [] } = {}) {
  const up = await fakeServer({
    'POST /chat/completions': chat,
    'POST /messages': () => ({
      body: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    }),
    'POST /messages/count_tokens': () => ({ body: { input_tokens: 42 } }),
    'POST /responses': () => ({
      body: { id: 'resp_1', object: 'response', model: 'm1', status: 'completed', output: [], usage: {} },
    }),
    'POST /embeddings': embeddings,
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-gw-'));
  const gw = {
    providers: [
      { id: 'up', preset: 'custom', baseUrl: up.url, tier: 'private', approved: true },
      { id: 'oai', preset: 'openai', baseUrl: up.url, tier: 'external', approved: true, apiKey: { env: 'OAI_KEY' } },
      {
        id: 'native',
        preset: 'anthropic',
        baseUrl: up.url,
        format: 'anthropic',
        tier: 'external',
        approved: true,
        apiKey: { env: 'ANTH_KEY' },
      },
      ...providers.map((p) => ({ baseUrl: up.url, approved: true, ...p })),
    ],
    routes,
    defaults: { model: 'oai/m1' },
    ...(guardrails ? { guardrails } : {}),
  };
  const gateway = createGateway({
    dataDir,
    toolsHome: dataDir,
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: () => {},
    secrets: secretsFor({ OAI_KEY: 'oai-test-key', ANTH_KEY: 'anth-test-key' }),
    resolveSecret: () => undefined,
    getPricing: () => ({ m1: { input: 1, output: 2 } }),
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
  const key = gateway.keys.create({ name: 'k', scopes: ['llm', 'agents', 'rag'], rpm: 1000 }).secret;
  const call = async (p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  };
  const sentTo = (p) => up.requests.filter((r) => r.path === p);
  const last = () => gateway.usage.recent(1)[0];
  return {
    gateway,
    up,
    base,
    key,
    call,
    sentTo,
    last,
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await up.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const userMsg = (content) => ({ messages: [{ role: 'user', content }] });

test('redact: chat, Anthropic, Responses, Gemini and embeddings reach an external provider redacted', async (t) => {
  const s = await setup();
  t.after(s.close);
  // OpenAI chat completions; a header cannot turn the guardrails off (D5).
  const c = await s.call(
    '/v1/chat/completions',
    { model: 'oai/m1', ...userMsg(`key ${ANT}`) },
    {
      'x-zp-token-saver': 'off',
      'x-zp-guardrails': 'off',
    },
  );
  assert.equal(c.status, 200);
  assert.equal(s.sentTo('/chat/completions').at(-1).body.messages[0].content, `key ${RED}`);
  assert.deepEqual(s.last().guard, {
    action: 'redacted',
    hits: [{ check: 'secrets', label: 'Anthropic API key', count: 1 }],
  });
  assert.doesNotMatch(JSON.stringify(s.gateway.usage.recent(50)), /sk-ant-api03/);
  // Anthropic Messages to a native Anthropic provider (passthrough), and to an OpenAI one (translated).
  await s.call('/v1/messages', { model: 'native/claude-x', max_tokens: 10, ...userMsg(`key ${ANT}`) });
  assert.equal(s.sentTo('/messages').at(-1).body.messages[0].content, `key ${RED}`);
  assert.equal(s.last().guard.action, 'redacted');
  await s.call('/v1/messages', { model: 'oai/m1', max_tokens: 10, ...userMsg(`key ${ANT}`) });
  assert.match(JSON.stringify(s.sentTo('/chat/completions').at(-1).body.messages), new RegExp(RED));
  // OpenAI Responses: passthrough to a provider that speaks it.
  await s.call('/v1/responses', { model: 'oai/m1', input: `key ${ANT}` });
  assert.equal(s.sentTo('/responses').at(-1).body.input, `key ${RED}`);
  assert.equal(s.last().guard.action, 'redacted');
  // Gemini generateContent: translated to chat.
  await s.call('/v1beta/models/oai%2Fm1:generateContent', { contents: [{ role: 'user', parts: [{ text: ANT }] }] });
  assert.match(JSON.stringify(s.sentTo('/chat/completions').at(-1).body.messages), new RegExp(RED));
  // Embeddings.
  const e = await s.call('/v1/embeddings', { model: 'oai/m1', input: [`doc ${ANT}`] });
  assert.equal(e.status, 200);
  assert.deepEqual(s.sentTo('/embeddings').at(-1).body.input, [`doc ${RED}`]);
  assert.equal(s.last().guard.action, 'redacted');
  // count_tokens sends the redacted body too.
  await s.call('/v1/messages/count_tokens', { model: 'native/claude-x', ...userMsg(`key ${ANT}`) });
  assert.equal(s.sentTo('/messages/count_tokens').at(-1).body.messages[0].content, `key ${RED}`);
});

test('redact: llm() (agents, the playground, the judge) checks the body it sends', async (t) => {
  const s = await setup();
  t.after(s.close);
  const r = await s.gateway.admin('playground', 'POST', { model: 'oai/m1', input: `use ${ANT}` });
  assert.equal(r.text, 'ok');
  assert.equal(s.sentTo('/chat/completions').at(-1).body.messages[0].content, `use ${RED}`);
  assert.deepEqual(s.last().guard, {
    action: 'redacted',
    hits: [{ check: 'secrets', label: 'Anthropic API key', count: 1 }],
  });
  await s.gateway.judge.complete({ model: 'oai/m1', messages: [{ role: 'user', content: ANT }] });
  assert.equal(s.sentTo('/chat/completions').at(-1).body.messages[0].content, RED);
  // embed(): the knowledge bases' embeddings.
  await s.gateway.embed('oai/m1', [`doc ${ANT}`]);
  assert.deepEqual(s.sentTo('/embeddings').at(-1).body.input, [`doc ${RED}`]);
});

test('scope: a private target is not checked under scope external, and is under scope all', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.call('/v1/chat/completions', { model: 'up/m1', ...userMsg(`key ${ANT}`) });
  assert.equal(s.sentTo('/chat/completions').at(-1).body.messages[0].content, `key ${ANT}`);
  assert.equal(s.last().guard, undefined);
  const all = await setup({ guardrails: { scope: 'all' } });
  t.after(all.close);
  await all.call('/v1/chat/completions', { model: 'up/m1', ...userMsg(`key ${ANT}`) });
  assert.equal(all.sentTo('/chat/completions').at(-1).body.messages[0].content, `key ${RED}`);
});

test('scope: each route target is checked for its own tier', async (t) => {
  // The private target fails first (no key header from it); the external fallback gets the redacted body.
  const s = await setup({
    routes: [{ name: 'router/mix', targets: ['up/m1', 'oai/m1'], strategy: 'fallback' }],
    chat: (r) => (r.headers.authorization ? oaReply() : { status: 503, body: { error: { message: 'busy' } } }),
  });
  t.after(s.close);
  const r = await s.call('/v1/chat/completions', { model: 'router/mix', ...userMsg(`key ${ANT}`) });
  assert.equal(r.status, 200);
  const [first, second] = s.sentTo('/chat/completions');
  assert.equal(first.body.messages[0].content, `key ${ANT}`, 'the private target got it as it was');
  assert.equal(second.body.messages[0].content, `key ${RED}`);
  assert.equal(s.last().guard.action, 'redacted');
});

test('block: 400 in each caller format, nothing sent, the request recorded without its text', async (t) => {
  const s = await setup({ guardrails: { secrets: 'block' } });
  t.after(s.close);
  const before = s.up.requests.length;
  const oai = await s.call('/v1/chat/completions', { model: 'oai/m1', ...userMsg(`key ${ANT}`) });
  assert.equal(oai.status, 400);
  assert.deepEqual(oai.json, { error: { message: BLOCKED, type: 'invalid_request_error', code: 'guardrail_blocked' } });
  const e = s.last();
  assert.deepEqual(
    [e.status, e.error, e.guard],
    [
      400,
      'blocked by guardrails',
      { action: 'blocked', hits: [{ check: 'secrets', label: 'Anthropic API key', count: 1 }] },
    ],
  );
  assert.equal(e.input, undefined, 'no tokens');
  const ant = await s.call('/v1/messages', { model: 'native/claude-x', max_tokens: 5, ...userMsg(ANT) });
  assert.equal(ant.status, 400);
  assert.deepEqual(ant.json, {
    type: 'error',
    error: { type: 'invalid_request_error', message: BLOCKED, code: 'guardrail_blocked' },
  });
  const antT = await s.call('/v1/messages', { model: 'oai/m1', max_tokens: 5, ...userMsg(ANT) });
  assert.deepEqual([antT.status, antT.json.error.code], [400, 'guardrail_blocked']);
  const resp = await s.call('/v1/responses', { model: 'oai/m1', input: ANT });
  assert.deepEqual(resp.json, {
    error: { message: BLOCKED, type: 'invalid_request_error', code: 'guardrail_blocked' },
  });
  const gem = await s.call('/v1beta/models/oai%2Fm1:generateContent', { contents: [{ parts: [{ text: ANT }] }] });
  assert.equal(gem.status, 400);
  assert.deepEqual(gem.json, {
    error: {
      code: 400,
      message: BLOCKED,
      status: 'INVALID_ARGUMENT',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'guardrail_blocked', domain: 'zaafpulse' },
      ],
    },
  });
  const emb = await s.call('/v1/embeddings', { model: 'oai/m1', input: ANT });
  assert.deepEqual([emb.status, emb.json.error.code], [400, 'guardrail_blocked']);
  // count_tokens falls back to its estimate and sends nothing.
  const ct = await s.call('/v1/messages/count_tokens', { model: 'native/claude-x', ...userMsg(ANT) });
  assert.equal(ct.status, 200);
  assert.ok(ct.json.input_tokens > 0);
  await assert.rejects(s.gateway.admin('playground', 'POST', { model: 'oai/m1', input: ANT }), {
    status: 400,
    code: 'guardrail_blocked',
    message: BLOCKED,
  });
  await assert.rejects(s.gateway.embed('oai/m1', [ANT]), { status: 400, code: 'guardrail_blocked' });
  assert.equal(s.up.requests.length, before, 'no request reached the provider');
  assert.doesNotMatch(JSON.stringify(s.gateway.usage.recent(50)), /sk-ant-api03/);
});

test('key override: a key may block what the global policy redacts', async (t) => {
  const s = await setup();
  t.after(s.close);
  const strict = s.gateway.keys.create({ name: 'strict', scopes: ['llm'], guardrails: { secrets: 'block' } }).secret;
  const r = await s.call(
    '/v1/chat/completions',
    { model: 'oai/m1', ...userMsg(ANT) },
    {
      authorization: `Bearer ${strict}`,
    },
  );
  assert.equal(r.status, 400);
  const ok = await s.call('/v1/chat/completions', { model: 'oai/m1', ...userMsg(ANT) });
  assert.equal(ok.status, 200);
  assert.equal(s.sentTo('/chat/completions').length, 1);
});

test('fail closed: a check that throws in redact mode is a 500, nothing sent; in log mode it goes on', async (t) => {
  const real = signals.secretSpans;
  t.after(() => {
    signals.secretSpans = real;
  });
  signals.secretSpans = () => {
    throw new Error('boom');
  };
  const s = await setup();
  t.after(s.close);
  const r = await s.call('/v1/chat/completions', { model: 'oai/m1', ...userMsg('hello') });
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: { message: 'guardrails failed', type: 'server_error' } });
  assert.equal(s.sentTo('/chat/completions').length, 0);
  assert.deepEqual([s.last().status, s.last().error], [500, 'guardrails failed']);
  const log = await setup({ guardrails: { secrets: 'log' } });
  t.after(log.close);
  const ok = await log.call('/v1/chat/completions', { model: 'oai/m1', ...userMsg('hello') });
  assert.equal(ok.status, 200);
  assert.deepEqual(log.last().guard, { action: 'logged', hits: [], error: true });
});

test('fail closed: a body nested too deep for the check is a 500 even with every check in log mode', async (t) => {
  // The walker recurses: a body nested deeper than the stack throws a RangeError out of checkBody, not a check's own
  // error. Whatever the modes, nothing unchecked is sent. The body is built as text: JSON.stringify would overflow too.
  const s = await setup({ guardrails: { secrets: 'log', pii: 'log', injection: 'log' } });
  t.after(s.close);
  const depth = 200000;
  const deep = `${'['.repeat(depth)}"x"${']'.repeat(depth)}`;
  const r = await fetch(`${s.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
    body: `{"model":"oai/m1","messages":[{"role":"user","content":${deep}}]}`,
  });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: { message: 'guardrails failed', type: 'server_error' } });
  assert.equal(s.up.requests.length, 0, 'nothing reached the provider');
  assert.deepEqual([s.last().status, s.last().error, s.last().guard], [500, 'guardrails failed', undefined]);
});

test('fail closed: any other error out of checkBody is a 500 on every path, nothing sent', async (t) => {
  const G = require('../lib/gateway/guardrails');
  const real = G.checkBody;
  t.after(() => {
    G.checkBody = real;
  });
  G.checkBody = () => {
    throw new TypeError('not a GuardrailBlock');
  };
  const s = await setup({ guardrails: { secrets: 'log', pii: 'log', injection: 'log' } });
  t.after(s.close);
  const FAILED = { error: { message: 'guardrails failed', type: 'server_error' } };
  const chat = await s.call('/v1/chat/completions', { model: 'oai/m1', ...userMsg('hello') });
  assert.deepEqual([chat.status, chat.json], [500, FAILED]);
  const ant = await s.call('/v1/messages', { model: 'native/claude-x', max_tokens: 5, ...userMsg('hello') });
  assert.deepEqual(
    [ant.status, ant.json],
    [500, { type: 'error', error: { type: 'api_error', message: 'guardrails failed' } }],
  );
  const resp = await s.call('/v1/responses', { model: 'oai/m1', input: 'hello' });
  assert.deepEqual([resp.status, resp.json], [500, FAILED]);
  const gem = await s.call('/v1beta/models/oai%2Fm1:generateContent', { contents: [{ parts: [{ text: 'hello' }] }] });
  assert.deepEqual([gem.status, gem.json.error.message], [500, 'guardrails failed']);
  const emb = await s.call('/v1/embeddings', { model: 'oai/m1', input: 'hello' });
  assert.deepEqual([emb.status, emb.json], [500, FAILED]);
  const ct = await s.call('/v1/messages/count_tokens', { model: 'native/claude-x', ...userMsg('hello') });
  assert.equal(ct.status, 200, 'count_tokens answers its estimate');
  await assert.rejects(s.gateway.admin('playground', 'POST', { model: 'oai/m1', input: 'hello' }), {
    status: 500,
    message: 'guardrails failed',
  });
  await assert.rejects(s.gateway.embed('oai/m1', ['hello']), { status: 500, message: 'guardrails failed' });
  assert.equal(s.up.requests.length, 0, 'nothing reached the provider');
});

test('fallback: in llm() and embed() only the entry of the target that answered carries guard', async (t) => {
  // m1 is busy (503), m2 answers: the fallback entry has no guard, so a redaction is counted once.
  const busy = (r) => r.body.model === 'm1';
  const s = await setup({
    routes: [{ name: 'router/two', targets: ['oai/m1', 'oai/m2'], strategy: 'fallback' }],
    chat: (r) => (busy(r) ? { status: 503, body: { error: { message: 'busy' } } } : oaReply()),
    embeddings: (r) => (busy(r) ? { status: 503, body: { error: { message: 'busy' } } } : embReply()),
  });
  t.after(s.close);
  const want = { action: 'redacted', hits: [{ check: 'secrets', label: 'Anthropic API key', count: 1 }] };
  const r = await s.gateway.admin('playground', 'POST', { model: 'router/two', input: `use ${ANT}` });
  assert.equal(r.text, 'ok');
  let [second, first] = s.gateway.usage.recent(2);
  assert.deepEqual([first.status, first.guard], [503, undefined]);
  assert.deepEqual([second.status, second.guard], [200, want]);
  await s.gateway.embed('router/two', [`doc ${ANT}`]);
  [second, first] = s.gateway.usage.recent(2);
  assert.deepEqual([first.status, first.guard], [503, undefined]);
  assert.deepEqual([second.status, second.guard], [200, want]);
});
