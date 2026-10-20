// Ecosystem compatibility of the LLM API layer: native Responses passthrough, per-provider chat fields,
// translation fidelity between OpenAI and Anthropic, streaming details and the model endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const tr = require('../lib/gateway/translate');
const { adaptChat, tokenParamOf } = require('../lib/gateway/providers');

const oaReply = (content, usage = { prompt_tokens: 10, completion_tokens: 2 }) => ({
  body: {
    id: 'c1',
    model: 'upstream-name',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  },
});
const sseBody = (chunks) => `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
const namedSse = (pairs) => pairs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
const events = (text) =>
  text
    .split('\n\n')
    .filter((b) => b.trim() && !b.startsWith(':'))
    .map((b) => {
      const ev = (b.match(/^event: (.+)$/m) || [])[1];
      const d = (b.match(/^data: (.+)$/m) || [])[1];
      return { ev, data: d && d !== '[DONE]' ? JSON.parse(d) : d };
    });

async function setup({
  routes = {},
  providers = [],
  gw: gwExtra = {},
  pricing = { m1: { input: 1, output: 2 } },
} = {}) {
  const up = await fakeServer({
    'POST /chat/completions': () => oaReply('hello'),
    'GET /models': { body: { data: [{ id: 'm1', created: 1700000000 }, { id: 'claude-x' }] } },
    'POST /messages': () => ({ status: 404 }),
    ...routes,
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-compat-'));
  let gw = {
    providers: [
      { id: 'up', preset: 'custom', baseUrl: up.url, tier: 'private', approved: true },
      {
        id: 'native',
        preset: 'anthropic',
        baseUrl: up.url,
        format: 'anthropic',
        tier: 'external',
        approved: true,
        apiKey: { env: 'ANTH_KEY' },
      },
      { id: 'oai', preset: 'openai', baseUrl: up.url, tier: 'external', approved: true, apiKey: { env: 'OAI_KEY' } },
      ...providers.map((p) => ({ ...p, baseUrl: p.baseUrl || up.url })),
    ],
    defaults: { model: 'up/m1' },
    ...gwExtra,
  };
  const gateway = createGateway({
    dataDir,
    toolsHome: fs.mkdtempSync(path.join(os.tmpdir(), 'acc-compat-home-')),
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: (g) => {
      gw = g;
    },
    secrets: secretsFor({ ANTH_KEY: 'sk-ant-test', OAI_KEY: 'sk-oai-test' }),
    resolveSecret: () => undefined,
    getPricing: () => pricing,
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
  const key = gateway.keys.create({ name: 'k', scopes: ['llm', 'agents'], rpm: 1000 }).secret;
  const call = async (p, body, headers = { authorization: `Bearer ${key}` }, method = 'POST') => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* sse */
    }
    return { status: r.status, json, text, headers: r.headers };
  };
  return {
    gateway,
    up,
    call,
    key,
    base,
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await up.close();
    },
  };
}

test('streams: parallel tool calls that share index 0 stay separate calls (Responses, Anthropic, Gemini)', () => {
  const chunks = [
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'f', arguments: '' } }] } },
      ],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] } }] },
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_b', function: { name: 'g', arguments: '' } }] } },
      ],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"y":2}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const rs = tr.responsesStream('m');
  const ev = events(chunks.map((c) => rs.push(c)).join('') + rs.finish());
  const done = ev.filter((e) => e.ev === 'response.output_item.done').map((e) => e.data.item);
  assert.deepEqual(
    done.map((i) => [i.call_id, i.name, i.arguments]),
    [
      ['call_a', 'f', '{"x":1}'],
      ['call_b', 'g', '{"y":2}'],
    ],
  );
  assert.deepEqual(
    ev.filter((e) => e.ev === 'response.output_item.added').map((e) => e.data.output_index),
    [0, 1],
  );
  assert.equal(ev.at(-1).data.response.output.length, 2);
  const as = tr.anthropicStream('m');
  const aev = events(chunks.map((c) => as.push(c)).join('') + as.finish());
  const starts = aev.filter((e) => e.ev === 'content_block_start').map((e) => e.data.content_block.id);
  assert.deepEqual(starts, ['call_a', 'call_b']);
  const gs = tr.geminiStream('m');
  chunks.forEach((c) => gs.push(c));
  const g = JSON.parse(gs.finish().slice(6));
  assert.deepEqual(
    g.candidates[0].content.parts.map((p) => [p.functionCall.name, p.functionCall.args]),
    [
      ['f', { x: 1 }],
      ['g', { y: 2 }],
    ],
  );
  // A call whose id only shows up after its first chunk is still one call.
  const late = tr.responsesStream('m');
  late.push({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '{"a"' } }] } }],
  });
  late.push({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_z', function: { arguments: ':1}' } }] } }],
  });
  const one = events(late.finish()).filter((e) => e.ev === 'response.output_item.done');
  assert.equal(one.length, 1);
  assert.equal(one[0].data.item.arguments, '{"a":1}');
});

test('max_tokens vs max_completion_tokens and reasoning_effort, decided per provider', () => {
  const openai = { preset: 'openai' };
  const azure = { preset: 'azure-openai' };
  const custom = { preset: 'custom' };
  assert.equal(tokenParamOf(openai, 'gpt-4o'), 'max_completion_tokens');
  assert.equal(tokenParamOf(azure, 'my-deployment'), 'max_completion_tokens');
  assert.equal(tokenParamOf(custom, 'llama3'), 'max_tokens');
  assert.equal(tokenParamOf({ preset: 'openrouter' }, 'openai/o3-mini'), 'max_completion_tokens');
  assert.equal(tokenParamOf({ preset: 'github-models' }, 'gpt-5-mini'), 'max_completion_tokens');
  assert.equal(tokenParamOf({ preset: 'openai', tokenParam: 'max_tokens' }, 'gpt-4o'), 'max_tokens');
  assert.equal(tokenParamOf({ preset: 'custom', tokenParam: 'max_completion_tokens' }, 'x'), 'max_completion_tokens');
  const a = adaptChat(openai, 'gpt-5', { model: 'gpt-5', max_tokens: 100 });
  assert.equal(a.max_completion_tokens, 100);
  assert.ok(!('max_tokens' in a));
  assert.equal(adaptChat(custom, 'llama3', { max_tokens: 100 }).max_tokens, 100);
  // A field the client set itself is never dropped; one the gateway derived goes only where it is taken.
  const derived = tr.anthropicToOpenAI({
    model: 'x',
    max_tokens: 4000,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(derived.reasoning_effort, 'medium');
  assert.ok(!('reasoning_effort' in adaptChat(custom, 'llama3', derived)));
  assert.deepEqual(derived[tr.DROPPED], ['reasoning']);
  assert.equal(adaptChat(openai, 'o4-mini', derived).reasoning_effort, 'medium');
  assert.equal(adaptChat({ preset: 'gemini' }, 'gemini-2.5-pro', derived).reasoning_effort, 'medium');
  assert.equal(adaptChat(custom, 'llama3', { reasoning_effort: 'high' }).reasoning_effort, 'high');
  assert.equal(adaptChat({ preset: 'custom', reasoning: true }, 'llama3', derived).reasoning_effort, 'medium');
});

test('OpenAI chat → Anthropic Messages: temperature, top_p, parallel tools, thinking, JSON schema, tool images', () => {
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
  const m = [{ role: 'user', content: 'hi' }];
  const a = tr.openAIToAnthropicRequest({ model: 'c', messages: m, temperature: 1.5, top_p: 0.9 });
  assert.equal(a.temperature, 1);
  assert.ok(!('top_p' in a));
  assert.equal(tr.openAIToAnthropicRequest({ model: 'c', messages: m, top_p: 0.9 }).top_p, 0.9);
  const p = tr.openAIToAnthropicRequest({ model: 'c', messages: m, tools, parallel_tool_calls: false });
  assert.deepEqual(p.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  const pr = tr.openAIToAnthropicRequest({
    model: 'c',
    messages: m,
    tools,
    tool_choice: 'required',
    parallel_tool_calls: false,
  });
  assert.deepEqual(pr.tool_choice, { type: 'any', disable_parallel_tool_use: true });
  const th = tr.openAIToAnthropicRequest({ model: 'c', messages: m, reasoning_effort: 'high', temperature: 0.2 });
  assert.deepEqual(th.thinking, { type: 'enabled', budget_tokens: 16384 });
  assert.ok(th.max_tokens > 16384);
  assert.ok(!('temperature' in th));
  const small = tr.openAIToAnthropicRequest({ model: 'c', messages: m, reasoning_effort: 'high', max_tokens: 4000 });
  assert.equal(small.max_tokens, 4000);
  assert.ok(small.thinking.budget_tokens < 4000 && small.thinking.budget_tokens >= 1024);
  assert.ok(
    !tr.openAIToAnthropicRequest({ model: 'c', messages: m, reasoning_effort: 'low', max_tokens: 1500 }).thinking,
  );
  assert.ok(
    !tr.openAIToAnthropicRequest({ model: 'c', messages: m, tools, tool_choice: 'required', reasoning_effort: 'low' })
      .thinking,
  );
  const loop = [
    { role: 'user', content: 'read it' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: 't1',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    },
  ];
  const l = tr.openAIToAnthropicRequest({ model: 'c', messages: loop, tools, reasoning_effort: 'medium' });
  assert.ok(!l.thinking); // a tool loop in progress: earlier thinking blocks cannot be replayed
  assert.deepEqual(l.messages[2].content[0].content, [
    { type: 'text', text: 'see' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
  ]);
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
    additionalProperties: false,
  };
  const js = tr.openAIToAnthropicRequest({
    model: 'c',
    messages: m,
    response_format: { type: 'json_schema', json_schema: { name: 'x', schema } },
  });
  assert.deepEqual(js.output_config, { format: { type: 'json_schema', schema } });
  assert.throws(
    () => tr.openAIToAnthropicRequest({ model: 'c', messages: m, response_format: { type: 'json_object' } }),
    (e) => e.status === 400 && /json_object/.test(e.message),
  );
  const back = tr.anthropicResponseToOpenAI(
    {
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: 'ok' },
      ],
      stop_reason: 'end_turn',
      usage: {},
    },
    'c',
  );
  assert.equal(back.choices[0].message.reasoning_content, 'hmm');
  assert.equal(back.choices[0].message.content, 'ok');
});

test('Anthropic Messages → OpenAI chat: thinking, tool images, Anthropic tools, server tools surfaced', () => {
  const o = tr.anthropicToOpenAI({
    model: 'x',
    max_tokens: 2000,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    tools: [
      { name: 'Read', input_schema: { type: 'object' } },
      { type: 'bash_20250124', name: 'bash' },
      { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
    ],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: 'look' },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'q' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { f: 'a.png' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [
              { type: 'text', text: 'the screenshot' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
            ],
          },
          { type: 'text', text: 'what is in it?' },
        ],
      },
    ],
  });
  assert.equal(o.reasoning_effort, 'low');
  assert.deepEqual(o[tr.SOFT], ['reasoning_effort']);
  assert.deepEqual(o.response_format.json_schema.schema, { type: 'object' });
  assert.equal(o.parallel_tool_calls, false);
  assert.deepEqual(
    o.tools.map((t) => t.function.name),
    ['Read', 'bash', 'str_replace_based_edit_tool'],
  );
  assert.equal(o.tools[1].function.parameters.properties.command.type, 'string');
  assert.deepEqual(o[tr.DROPPED], ['tool web_search']);
  const asst = o.messages.find((x) => x.role === 'assistant');
  assert.deepEqual(
    asst.tool_calls.map((c) => c.id),
    ['tu1'],
  );
  const tool = o.messages.find((x) => x.role === 'tool');
  assert.match(tool.content, /the screenshot/);
  const user = o.messages.at(-1);
  assert.equal(user.role, 'user');
  assert.equal(user.content[0].image_url.url, 'data:image/png;base64,QUJD');
  assert.equal(user.content[1].text, 'what is in it?');
  assert.throws(
    () =>
      tr.anthropicToOpenAI({
        model: 'x',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        tool_choice: { type: 'tool', name: 'web_search' },
        messages: [{ role: 'user', content: 'q' }],
      }),
    (e) => e.status === 400,
  );
  const r = tr.responsesToOpenAI({
    model: 'x',
    input: 'hi',
    reasoning: { effort: 'high', summary: 'auto' },
    text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } },
    tools: [{ type: 'web_search' }, { type: 'function', name: 'f', parameters: { type: 'object' } }],
  }).body;
  assert.equal(r.reasoning_effort, 'high');
  assert.deepEqual(r.response_format, {
    type: 'json_schema',
    json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
  });
  assert.deepEqual(r[tr.DROPPED], ['tool web_search']);
  assert.throws(
    () => tr.responsesToOpenAI({ model: 'x', previous_response_id: 'resp_1', input: 'hi' }),
    (e) => e.status === 400,
  );
});

test('translated requests: max_completion_tokens to OpenAI, max_tokens elsewhere, dropped features in x-zp-dropped', async () => {
  const t = await setup();
  try {
    const msg = {
      max_tokens: 3000,
      thinking: { type: 'enabled', budget_tokens: 2000 },
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const a = await t.call('/v1/messages', { ...msg, model: 'oai/gpt-5' }, { 'x-api-key': t.key });
    assert.equal(a.status, 200);
    let sent = t.up.requests.at(-1);
    assert.equal(sent.path, '/chat/completions');
    assert.equal(sent.body.max_completion_tokens, 3000);
    assert.ok(!('max_tokens' in sent.body));
    assert.equal(sent.body.reasoning_effort, 'low');
    assert.equal(a.headers.get('x-zp-dropped'), 'tool web_search');
    const b = await t.call('/v1/messages', { ...msg, model: 'up/m1' }, { 'x-api-key': t.key });
    sent = t.up.requests.at(-1);
    assert.equal(sent.body.max_tokens, 3000);
    assert.ok(!('reasoning_effort' in sent.body));
    assert.equal(b.headers.get('x-zp-dropped'), 'tool web_search, reasoning');
    // Responses → chat for a provider without the native API.
    await t.call('/v1/responses', { model: 'up/m1', input: 'hi', max_output_tokens: 77 });
    assert.equal(t.up.requests.at(-1).body.max_tokens, 77);
    const prev = await t.call('/v1/responses', { model: 'up/m1', input: 'hi', previous_response_id: 'resp_1' });
    assert.equal(prev.status, 400);
    assert.match(prev.json.error.message, /previous_response_id/);
    assert.equal(prev.json.error.type, 'invalid_request_error');
    // A chat request a native Anthropic provider cannot take as sent is a 400, not a 502 upstream error.
    const jo = await t.call('/v1/chat/completions', {
      model: 'native/claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    assert.equal(jo.status, 400);
    assert.match(jo.json.error.message, /json_object/);
  } finally {
    await t.close();
  }
});

test('native Responses passthrough: body unchanged, whole and streamed, model name and usage, route fallback', async () => {
  let fail = false;
  const stream = namedSse([
    [
      'response.created',
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5-codex', status: 'in_progress' } },
    ],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hi' }],
    [
      'response.completed',
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5-codex',
          status: 'completed',
          usage: { input_tokens: 40, output_tokens: 6, input_tokens_details: { cached_tokens: 8 } },
        },
      },
    ],
  ]);
  const t = await setup({
    routes: {
      'POST /responses': (r) => {
        if (fail && r.body.model === 'busy') return { status: 503, body: { error: { message: 'overloaded' } } };
        return r.body.stream
          ? { headers: { 'content-type': 'text/event-stream' }, body: stream }
          : {
              body: {
                id: 'resp_1',
                object: 'response',
                model: 'gpt-5-codex',
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native' }] }],
                usage: { input_tokens: 30, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
              },
            };
      },
    },
    providers: [{ id: 'oai2', preset: 'openai', tier: 'external', approved: true, apiKey: { env: 'OAI_KEY' } }],
    gw: { routes: [{ name: 'router/codex', targets: ['oai/busy', 'oai2/gpt-5-codex'], strategy: 'fallback' }] },
  });
  try {
    const req = {
      model: 'oai/gpt-5-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'fix it' }] }],
      previous_response_id: 'resp_0',
      store: true,
      reasoning: { effort: 'high', summary: 'auto' },
      text: { format: { type: 'json_schema', name: 'a', schema: { type: 'object' } } },
      tools: [{ type: 'web_search' }],
    };
    const w = await t.call('/v1/responses', req);
    assert.equal(w.status, 200);
    assert.equal(w.json.output[0].content[0].text, 'native');
    assert.equal(w.json.model, 'oai/gpt-5-codex');
    const sent = t.up.requests.at(-1);
    assert.equal(sent.path, '/responses');
    assert.equal(sent.headers.authorization, 'Bearer sk-oai-test');
    assert.deepEqual(sent.body, { ...req, model: 'gpt-5-codex' });
    let e = t.gateway.usage.recent(1)[0];
    assert.deepEqual([e.format, e.input, e.output, e.cached, e.provider], ['responses', 30, 5, 4, 'oai']);
    const s = await t.call('/v1/responses', { ...req, stream: true });
    assert.equal(s.headers.get('content-type'), 'text/event-stream');
    const ev = events(s.text);
    assert.deepEqual(
      ev.map((x) => x.ev),
      ['response.created', 'response.output_text.delta', 'response.completed'],
    );
    assert.equal(ev[0].data.response.model, 'oai/gpt-5-codex');
    assert.equal(ev[2].data.response.model, 'oai/gpt-5-codex');
    e = t.gateway.usage.recent(1)[0];
    assert.deepEqual([e.input, e.output, e.cached, e.stream], [40, 6, 8, true]);
    assert.ok(e.ttft != null);
    // A route of native targets falls back on a 503 before any byte is sent.
    fail = true;
    const r = await t.call('/v1/responses', { ...req, model: 'router/codex' });
    assert.equal(r.status, 200);
    assert.equal(t.up.requests.at(-1).body.model, 'gpt-5-codex');
    assert.equal(t.gateway.usage.recent(1)[0].provider, 'oai2');
    // A provider can turn the native API off, and then Responses is translated (and previous_response_id refused).
    t.gateway.providers.list().find((p) => p.id === 'oai').responses = false;
    const off = await t.call('/v1/responses', req);
    assert.equal(off.status, 400);
  } finally {
    await t.close();
  }
});

test('native Anthropic passthrough: anthropic-beta and anthropic-version forwarded, requested model name, count_tokens', async () => {
  const t = await setup({
    routes: {
      'POST /messages': (r) =>
        r.body.stream
          ? {
              headers: { 'content-type': 'text/event-stream' },
              body: namedSse([
                [
                  'message_start',
                  { type: 'message_start', message: { id: 'm', model: 'claude-x', usage: { input_tokens: 5 } } },
                ],
                [
                  'message_delta',
                  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
                ],
                ['message_stop', { type: 'message_stop' }],
              ]),
            }
          : {
              body: {
                id: 'msg_1',
                type: 'message',
                model: 'claude-x',
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 3, output_tokens: 1 },
              },
            },
      'POST /messages/count_tokens': (r) =>
        r.body.model === 'broken' ? { status: 500, body: {} } : { body: { input_tokens: 4242 } },
    },
    pricing: { m1: { input: 1, output: 2 }, 'claude-x': { input: 3, output: 15 } },
  });
  try {
    const h = { 'x-api-key': t.key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'context-1m-2025-08-07' };
    const body = { model: 'native/claude-x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
    const w = await t.call('/v1/messages', body, h);
    assert.equal(w.json.model, 'native/claude-x');
    let sent = t.up.requests.at(-1);
    assert.equal(sent.headers['anthropic-beta'], 'context-1m-2025-08-07');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(sent.headers['x-api-key'], 'sk-ant-test');
    const s = await t.call('/v1/messages', { ...body, stream: true }, h);
    const ev = events(s.text);
    assert.equal(ev[0].ev, 'message_start');
    assert.equal(ev[0].data.message.model, 'native/claude-x');
    assert.equal(t.gateway.usage.recent(1)[0].output, 2);
    // count_tokens: the provider's own count for a native model, an estimate otherwise or on failure.
    const ct = await t.call('/v1/messages/count_tokens', { model: 'native/claude-x', messages: body.messages }, h);
    assert.equal(ct.json.input_tokens, 4242);
    sent = t.up.requests.at(-1);
    assert.equal(sent.path, '/messages/count_tokens');
    assert.equal(sent.body.model, 'claude-x');
    assert.equal(sent.headers['anthropic-beta'], 'context-1m-2025-08-07');
    const est = await t.call('/v1/messages/count_tokens', { model: 'up/m1', messages: body.messages }, h);
    assert.ok(est.json.input_tokens > 0 && est.json.input_tokens < 100);
    t.gateway.providers.list().find((p) => p.id === 'native').aliases = { broken: 'broken' };
    const fb = await t.call('/v1/messages/count_tokens', { model: 'broken', messages: body.messages }, h);
    assert.ok(fb.json.input_tokens > 0 && fb.json.input_tokens < 100);
    // A key with a budget may not pass through to a model without a known price.
    const budget = t.gateway.keys.create({ name: 'b', scopes: ['llm'], budgetUSD: 5 }).secret;
    const ok = await t.call('/v1/messages', body, { 'x-api-key': budget });
    assert.equal(ok.status, 200);
    t.gateway.providers.list().find((p) => p.id === 'native').aliases = { cheap: 'claude-unpriced' };
    const no = await t.call('/v1/messages', { ...body, model: 'cheap' }, { 'x-api-key': budget });
    assert.equal(no.status, 402);
    assert.equal(no.json.type, 'error');
  } finally {
    await t.close();
  }
});

test('chat streaming: requested model name in every chunk; usage only when the client asks', async () => {
  const t = await setup({
    routes: {
      'POST /chat/completions': () => ({
        headers: { 'content-type': 'text/event-stream' },
        body:
          ': keep-alive\n\n' +
          sseBody([
            { id: 'x', model: 'm1-2026', choices: [{ index: 0, delta: { content: 'Hel' } }], usage: null },
            {
              id: 'x',
              model: 'm1-2026',
              choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
              usage: null,
            },
            { id: 'x', model: 'm1-2026', choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
          ]),
      }),
    },
  });
  try {
    const body = { model: 'up/m1', stream: true, messages: [{ role: 'user', content: 'x' }] };
    const parse = (text) =>
      text
        .split('\n\n')
        .filter((l) => l.startsWith('data: {'))
        .map((l) => JSON.parse(l.slice(6)));
    const a = await t.call('/v1/chat/completions', body);
    assert.ok(a.text.startsWith(': keep-alive\n\n'));
    assert.ok(a.text.endsWith('data: [DONE]\n\n'));
    const ca = parse(a.text);
    assert.equal(ca.length, 2);
    assert.ok(ca.every((c) => c.model === 'up/m1' && !('usage' in c)));
    assert.equal(t.up.requests.at(-1).body.stream_options.include_usage, true); // asked upstream for billing
    assert.equal(t.gateway.usage.recent(1)[0].input, 7);
    const b = await t.call('/v1/chat/completions', { ...body, stream_options: { include_usage: true } });
    const cb = parse(b.text);
    assert.equal(cb.length, 3);
    assert.deepEqual(cb.at(-1).choices, []);
    assert.equal(cb.at(-1).usage.prompt_tokens, 7);
    assert.equal(cb[0].usage, null);
  } finally {
    await t.close();
  }
});

test('/v1/messages translated stream starts with message_start; agent streams send headers and pings at once', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const t = await setup({
    routes: {
      'POST /chat/completions': async (r) => {
        if (!r.body.stream) {
          await gate;
          return oaReply('agent answer');
        }
        return {
          headers: { 'content-type': 'text/event-stream' },
          body: sseBody([{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
        };
      },
    },
  });
  try {
    const s = await t.call(
      '/v1/messages',
      { model: 'up/m1', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': t.key },
    );
    assert.equal(events(s.text)[0].ev, 'message_start');
    // An agent run that is still going: the response has started before the model has answered.
    const res = await fetch(`${t.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.key}` },
      body: JSON.stringify({
        model: 'agent/network-ops',
        stream: true,
        messages: [{ role: 'user', content: 'status?' }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.ok(res.headers.get('x-zp-session'));
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.equal(first, ': ping\n\n');
    release();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const chunks = rest
      .split('\n\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)));
    assert.equal(chunks[0].choices[0].delta.content, 'agent answer');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
    assert.ok(chunks.every((c) => !('usage' in c)));
    assert.ok(rest.endsWith('data: [DONE]\n\n'));
  } finally {
    release();
    await t.close();
  }
});

test('/v1/models: created on every entry; GET /v1/models/{id} for SDK models.retrieve', async () => {
  const t = await setup();
  try {
    const h = { authorization: `Bearer ${t.key}` };
    const list = await t.call('/v1/models', null, h, 'GET');
    assert.ok(list.json.data.length > 3);
    assert.ok(list.json.data.every((m) => Number.isInteger(m.created) && m.object === 'model' && m.owned_by));
    assert.equal(list.json.data.find((m) => m.id === 'up/m1').created, 1700000000);
    for (const p of ['/v1/models/up%2Fm1', '/v1/models/up/m1']) {
      const one = await t.call(p, null, h, 'GET');
      assert.equal(one.status, 200);
      assert.deepEqual(
        { id: one.json.id, object: one.json.object, owned_by: one.json.owned_by, created: one.json.created },
        { id: 'up/m1', object: 'model', owned_by: 'up', created: 1700000000 },
      );
    }
    assert.equal((await t.call('/v1/models/agent%2Fauto', null, h, 'GET')).json.owned_by, 'zaafpulse');
    const missing = await t.call('/v1/models/up%2Fnope', null, h, 'GET');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'model_not_found');
    assert.equal((await t.call('/v1/models/up%2Fm1', null, {}, 'GET')).status, 401);
  } finally {
    await t.close();
  }
});
