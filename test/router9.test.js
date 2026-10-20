const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const tr = require('../lib/gateway/translate');
const { compressText, saveTokens } = require('../lib/gateway/rtk');
const { readQuota, resetIn } = require('../lib/gateway/providers');
const { createTools } = require('../lib/gateway/tools');

const oaReply = (
  content,
  extra = {},
  usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
) => ({
  body: {
    id: 'c1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, ...extra },
        finish_reason: extra.tool_calls ? 'tool_calls' : 'stop',
      },
    ],
    usage,
  },
});
const sseBody = (chunks) => `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
const events = (text) =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((b) => {
      const ev = (b.match(/^event: (.+)$/m) || [])[1];
      const d = (b.match(/^data: (.+)$/m) || [])[1];
      return { ev, data: d ? JSON.parse(d) : null };
    });

async function setup({ openai, anthropic, token, env = {}, extraProviders = [], gw: gwExtra = {} } = {}) {
  const up = await fakeServer({
    'POST /chat/completions': openai || (() => oaReply('hello')),
    'GET /models': { body: { data: [{ id: 'm1' }, { id: 'claude-sonnet-x' }] } },
    'POST /messages': anthropic || (() => ({ status: 404 })),
    'POST /token': token || (() => ({ status: 404 })),
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-r9-'));
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
      ...extraProviders.map((p) => ({ ...p, baseUrl: p.baseUrl || up.url })),
    ],
    defaults: { model: 'up/m1' },
    ...gwExtra,
  };
  const toolsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-r9-home-'));
  const gateway = createGateway({
    dataDir,
    toolsHome,
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: (g) => {
      gw = g;
    },
    secrets: secretsFor(Object.assign(env, { ANTH_KEY: 'sk-ant-test' })),
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
  const key = gateway.keys.create({ name: 'k', scopes: ['llm', 'agents'], rpm: 1000 }).secret;
  const call = async (p, body, headers = { authorization: `Bearer ${key}` }) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
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
    toolsHome,
    setGw: (f) => {
      gw = f(gw);
    },
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await up.close();
    },
  };
}

test('translate: Anthropic ⇄ OpenAI, Responses and Gemini requests and answers', () => {
  const o = tr.anthropicToOpenAI({
    model: 'claude-x',
    system: [{ type: 'text', text: 'be brief' }],
    max_tokens: 100,
    tools: [
      {
        name: 'Bash',
        description: 'run',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a.js' }] },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          { type: 'text', text: 'and this?' },
        ],
      },
    ],
  });
  assert.deepEqual(
    o.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'user'],
  );
  assert.equal(o.messages[2].tool_calls[0].function.arguments, '{"command":"ls"}');
  assert.equal(o.messages[3].content, 'a.js');
  assert.equal(o.messages[4].content[0].image_url.url, 'data:image/png;base64,AAA');
  assert.equal(o.tool_choice, 'required');
  assert.equal(o.tools[0].function.name, 'Bash');
  const a = tr.openAIToAnthropic(
    oaReply(null, {
      tool_calls: [{ id: 'c9', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }],
    }).body,
    'claude-x',
  );
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.content[0], { type: 'tool_use', id: 'c9', name: 'Bash', input: { command: 'pwd' } });
  assert.deepEqual(a.usage, {
    input_tokens: 60,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
  });
  const back = tr.openAIToAnthropicRequest(o);
  assert.equal(back.system, 'be brief');
  assert.equal(back.messages[2].content[0].type, 'tool_result');
  assert.equal(back.messages[2].content[1].type, 'image');
  assert.deepEqual(back.tool_choice, { type: 'any' });
  const { body: rb, custom } = tr.responsesToOpenAI({
    model: 'gpt-x',
    instructions: 'sys',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'fix it' }] },
      { type: 'function_call', call_id: 'f1', name: 'shell', arguments: '{"cmd":["ls"]}' },
      { type: 'function_call_output', call_id: 'f1', output: 'a.js' },
      { type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: '*** Begin Patch' },
    ],
    tools: [
      { type: 'function', name: 'shell', parameters: { type: 'object' } },
      { type: 'custom', name: 'apply_patch', description: 'patch' },
    ],
  });
  assert.deepEqual(
    rb.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'assistant'],
  );
  assert.ok(custom.has('apply_patch'));
  assert.equal(rb.messages[4].tool_calls[0].function.arguments, '{"input":"*** Begin Patch"}');
  assert.deepEqual(rb.tools[1].function.parameters.required, ['input']);
  const r = tr.openAIToResponses(
    oaReply(null, {
      tool_calls: [
        { id: 'p2', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n"}' } },
      ],
    }).body,
    'gpt-x',
    custom,
  );
  assert.equal(r.output[0].type, 'custom_tool_call');
  assert.equal(r.output[0].input, '*** Begin Patch\n');
  assert.equal(r.usage.input_tokens_details.cached_tokens, 40);
  const g = tr.geminiToOpenAI(
    {
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read', args: { p: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read', response: { ok: true } } }] },
      ],
      tools: [
        {
          functionDeclarations: [
            { name: 'read', parameters: { type: 'OBJECT', properties: { p: { type: 'NUMBER' } } } },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 50 },
    },
    'gem',
    false,
  );
  assert.equal(g.messages[3].tool_call_id, g.messages[2].tool_calls[0].id);
  assert.equal(g.tools[0].function.parameters.properties.p.type, 'number');
  assert.equal(g.max_tokens, 50);
  assert.equal(tr.openAIToGemini(oaReply('yo').body, 'gem').candidates[0].content.parts[0].text, 'yo');
});

test('Claude Code: /v1/messages translated to an OpenAI provider, whole and streamed (tool use, pings, usage)', async () => {
  const t = await setup({
    openai: (r) =>
      r.body.stream
        ? {
            headers: { 'content-type': 'text/event-stream' },
            body: sseBody([
              { choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' } }] },
              { choices: [{ index: 0, delta: { content: 'check.' } }] },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"comm' } },
                      ],
                    },
                  },
                ],
              },
              { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
              { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } },
            ]),
          }
        : oaReply('hi there'),
  });
  try {
    const msg = { model: 'up/m1', max_tokens: 200, messages: [{ role: 'user', content: 'hello' }] };
    const whole = await t.call('/v1/messages', msg, { 'x-api-key': t.key, 'anthropic-version': '2023-06-01' });
    assert.equal(whole.status, 200);
    assert.equal(whole.json.type, 'message');
    assert.equal(whole.json.content[0].text, 'hi there');
    assert.equal(whole.json.model, 'up/m1');
    assert.equal(t.up.requests.at(-1).body.messages[0].content, 'hello');
    const s = await t.call('/v1/messages', { ...msg, stream: true }, { 'x-api-key': t.key });
    const ev = events(s.text);
    assert.deepEqual(
      ev.map((e) => e.ev).filter((e) => e !== 'ping'),
      [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ],
    );
    assert.ok(ev.some((e) => e.ev === 'ping'));
    const tool = ev.find((e) => e.ev === 'content_block_start' && e.data.content_block.type === 'tool_use');
    assert.equal(tool.data.content_block.name, 'Bash');
    assert.equal(tool.data.index, 1);
    assert.equal(
      ev
        .filter((e) => e.data && e.data.delta && e.data.delta.type === 'input_json_delta')
        .map((e) => e.data.delta.partial_json)
        .join(''),
      '{"command":"ls"}',
    );
    const md = ev.find((e) => e.ev === 'message_delta').data;
    assert.equal(md.delta.stop_reason, 'tool_use');
    assert.equal(md.usage.output_tokens, 9);
    assert.equal(t.gateway.usage.recent(1)[0].format, 'anthropic');
    const ct = await t.call(
      '/v1/messages/count_tokens',
      { model: 'x', messages: [{ role: 'user', content: 'hello world' }] },
      { 'x-api-key': t.key },
    );
    assert.ok(ct.json.input_tokens > 0);
    const bad = await t.call('/v1/messages', msg, { 'x-api-key': 'zp_wrong' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.type, 'error');
    assert.equal(bad.json.error.type, 'authentication_error');
  } finally {
    await t.close();
  }
});

test('native Anthropic provider: /v1/messages passes through; chat completions are translated to Messages', async () => {
  const t = await setup({
    anthropic: (r) =>
      r.body.stream
        ? {
            headers: { 'content-type': 'text/event-stream' },
            body: [
              [
                'message_start',
                {
                  type: 'message_start',
                  message: { id: 'm', usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
                },
              ],
              [
                'content_block_start',
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              ],
              [
                'content_block_delta',
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
              ],
              ['content_block_stop', { type: 'content_block_stop', index: 0 }],
              [
                'message_delta',
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
              ],
              ['message_stop', { type: 'message_stop' }],
            ]
              .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
              .join(''),
          }
        : {
            body: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'text', text: 'native answer' },
                { type: 'tool_use', id: 'tu', name: 'Read', input: { f: 1 } },
              ],
              stop_reason: 'tool_use',
              usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
            },
          },
  });
  try {
    const pass = await t.call(
      '/v1/messages',
      {
        model: 'native/claude-sonnet-x',
        max_tokens: 50,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
      },
      { 'x-api-key': t.key },
    );
    assert.equal(pass.json.content[0].text, 'native answer');
    const sent = t.up.requests.at(-1);
    assert.equal(sent.path, '/messages');
    assert.equal(sent.body.model, 'claude-sonnet-x');
    assert.deepEqual(sent.body.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(sent.headers['x-api-key'], 'sk-ant-test');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(sent.headers.authorization, undefined);
    const chat = await t.call('/v1/chat/completions', {
      model: 'native/claude-sonnet-x',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.equal(chat.json.choices[0].message.content, 'native answer');
    assert.equal(chat.json.choices[0].finish_reason, 'tool_calls');
    assert.equal(chat.json.choices[0].message.tool_calls[0].function.arguments, '{"f":1}');
    assert.equal(chat.json.usage.prompt_tokens, 12);
    assert.equal(t.up.requests.at(-1).body.system, 'sys');
    assert.equal(t.up.requests.at(-1).body.max_tokens, 8192);
    const streamed = async (extra = {}) => {
      const st = await t.call('/v1/chat/completions', {
        model: 'native/claude-sonnet-x',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
      });
      return st.text
        .split('\n\n')
        .filter((l) => l.startsWith('data: {'))
        .map((l) => JSON.parse(l.slice(6)));
    };
    // The usage-only final chunk comes only when the client asks for it, as OpenAI streams it.
    const plain = await streamed();
    assert.equal(plain.map((c) => c.choices[0]?.delta?.content || '').join(''), 'Hi');
    assert.ok(plain.every((c) => c.choices.length && !('usage' in c)));
    assert.ok(plain.every((c) => c.model === 'native/claude-sonnet-x'));
    assert.equal(t.gateway.usage.recent(1)[0].output, 4); // still billed
    const chunks = await streamed({ stream_options: { include_usage: true } });
    assert.deepEqual(chunks.at(-1).choices, []);
    assert.equal(chunks.at(-1).usage.completion_tokens, 4);
  } finally {
    await t.close();
  }
});

test('Codex: /v1/responses translated, whole and streamed, with custom tools', async () => {
  const t = await setup({
    openai: (r) =>
      r.body.stream
        ? {
            headers: { 'content-type': 'text/event-stream' },
            body: sseBody([
              { choices: [{ index: 0, delta: { content: 'Patching.' } }] },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, id: 'c1', function: { name: 'apply_patch', arguments: '{"input":"*** Begin' } },
                      ],
                    },
                  },
                ],
              },
              { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' Patch"}' } }] } }] },
              {
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 30, completion_tokens: 6 },
              },
            ]),
          }
        : oaReply('done'),
  });
  try {
    const req = {
      model: 'up/m1',
      instructions: 'You are Codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] }],
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
    };
    const w = await t.call('/v1/responses', req);
    assert.equal(w.json.object, 'response');
    assert.equal(w.json.output[0].content[0].text, 'done');
    assert.equal(w.json.status, 'completed');
    assert.equal(t.up.requests.at(-1).body.messages[0].content, 'You are Codex');
    const s = await t.call('/v1/responses', { ...req, stream: true });
    const ev = events(s.text);
    assert.equal(ev[0].ev, 'response.created');
    assert.equal(ev.at(-1).ev, 'response.completed');
    assert.equal(
      ev
        .filter((e) => e.ev === 'response.output_text.delta')
        .map((e) => e.data.delta)
        .join(''),
      'Patching.',
    );
    const done = ev.filter((e) => e.ev === 'response.output_item.done').map((e) => e.data.item);
    assert.deepEqual(
      done.map((i) => i.type),
      ['message', 'custom_tool_call'],
    );
    assert.equal(done[1].input, '*** Begin Patch');
    assert.equal(done[1].call_id, 'c1');
    assert.equal(ev.at(-1).data.response.usage.output_tokens, 6);
    assert.ok(ev.every((e, i) => e.data.sequence_number === i));
  } finally {
    await t.close();
  }
});

test('Gemini CLI: generateContent and streamGenerateContent with x-goog-api-key; model map for tool model names', async () => {
  const t = await setup({
    openai: (r) =>
      r.body.stream
        ? {
            headers: { 'content-type': 'text/event-stream' },
            body: sseBody([
              { choices: [{ index: 0, delta: { content: 'Hel' } }] },
              {
                choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 2 },
              },
            ]),
          }
        : oaReply(`answer from ${r.body.model}`),
    gw: { modelMap: [{ match: 'claude-*', to: 'up/m1' }] },
  });
  try {
    const g = await t.call(
      '/v1beta/models/gemini-2.5-pro:generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      { 'x-goog-api-key': t.key },
    );
    assert.equal(g.status, 200);
    assert.equal(g.json.candidates[0].content.parts[0].text, 'answer from m1');
    assert.equal(g.json.usageMetadata.promptTokenCount, 100);
    const s = await t.call(
      '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      { 'x-goog-api-key': t.key },
    );
    const parts = s.text
      .split('\n\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice(6)));
    assert.equal(parts.map((p) => p.candidates[0].content.parts[0].text || '').join(''), 'Hello');
    assert.equal(parts.at(-1).candidates[0].finishReason, 'STOP');
    const c = await t.call(
      '/v1beta/models/x:countTokens',
      { contents: [{ parts: [{ text: 'hello' }] }] },
      { 'x-goog-api-key': t.key },
    );
    assert.ok(c.json.totalTokens > 0);
    // A Claude model name from Claude Code reaches the mapped provider model, and the log keeps both names.
    await t.call(
      '/v1/messages',
      { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': t.key },
    );
    assert.equal(t.up.requests.at(-1).body.model, 'm1');
    const e = t.gateway.usage.recent(1)[0];
    assert.equal(e.model, 'up/m1');
    assert.equal(e.requested, 'claude-sonnet-4-5');
  } finally {
    await t.close();
  }
});

test('token saver: long tool results are shortened before going upstream, savings are logged, and it can be turned off', async () => {
  const diff = [
    'diff --git a/x.js b/x.js',
    'index 1..2',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1,300 +1,300 @@',
    ...Array.from({ length: 300 }, (_, i) => `+line ${i} \x1b[32mgreen\x1b[0m`),
  ].join('\n');
  const r = compressText(diff, 'Bash git diff');
  assert.equal(r.filter, 'git-diff');
  assert.ok(r.text.length < diff.length / 3);
  assert.ok(!r.text.includes('\x1b['));
  assert.match(r.text, /rest of hunk omitted/);
  const npm = [
    '> app@1.0.0 test',
    ...Array.from({ length: 400 }, (_, i) => `Downloading package ${i}`),
    'npm ERR! code ELIFECYCLE',
    'npm ERR! Test failed',
    'more context',
    'tests 10 failed 1',
  ].join('\n');
  const b = compressText(npm, 'Bash npm test');
  assert.equal(b.filter, 'build');
  assert.match(b.text, /npm ERR! Test failed/);
  assert.match(b.text, /\(400 progress lines\)/);
  assert.equal(compressText('short output', 'Bash ls'), null);
  assert.equal(compressText(`[error] ${'x'.repeat(2000)}`, ''), null);
  const log = Array.from(
    { length: 900 },
    (_, i) => `2026-10-18T10:00:${String(i % 60).padStart(2, '0')} GET /health 200`,
  ).join('\n');
  assert.ok(compressText(log, '').text.length < 300);
  const t = await setup();
  try {
    const body = {
      model: 'up/m1',
      messages: [
        { role: 'user', content: 'diff?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'Bash', arguments: '{"command":"git diff"}' } }],
        },
        { role: 'tool', tool_call_id: 't1', content: diff },
      ],
    };
    await t.call('/v1/chat/completions', body);
    const sent = t.up.requests.at(-1).body.messages[2].content;
    assert.ok(sent.length < diff.length / 3);
    assert.ok(t.gateway.usage.recent(1)[0].savedTokens > 1000);
    assert.ok(t.gateway.usage.summary().totals.savedTokens > 1000);
    await t.call('/v1/chat/completions', body, { authorization: `Bearer ${t.key}`, 'x-zp-token-saver': 'off' });
    assert.equal(t.up.requests.at(-1).body.messages[2].content, diff);
    const anth = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'git diff' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: diff }] },
      ],
    };
    assert.equal(saveTokens(anth, 'anthropic').hits[0].filter, 'git-diff');
  } finally {
    await t.close();
  }
});

test('quota and cooldown: rate-limit headers are read; a 429 cools the target down and the route moves on', async () => {
  assert.equal(resetIn('6m0s', 0), 360000);
  assert.equal(resetIn('1.5s', 0), 1500);
  assert.equal(resetIn('20', 0), 20000);
  const q = readQuota(
    new Headers({
      'x-ratelimit-limit-requests': '500',
      'x-ratelimit-remaining-requests': '499',
      'x-ratelimit-reset-requests': '120ms',
      'anthropic-ratelimit-tokens-remaining': '9000',
      'anthropic-ratelimit-tokens-limit': '10000',
    }),
    1000,
  );
  assert.deepEqual(q.requests, { limit: 500, remaining: 499, resetAt: 1120 });
  assert.equal(q.tokens.remaining, 9000);
  let n = 0;
  const t = await setup({
    openai: (r) => {
      n++;
      return r.body.model === 'busy'
        ? {
            status: 429,
            headers: { 'retry-after': '30', 'x-ratelimit-remaining-requests': '0' },
            body: { error: { message: 'slow down' } },
          }
        : { headers: { 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '900' }, ...oaReply('ok') };
    },
    extraProviders: [{ id: 'second', preset: 'custom', tier: 'private', approved: true }],
    gw: { routes: [{ name: 'router/x', targets: ['up/busy', 'second/m1'], strategy: 'fallback' }] },
  });
  try {
    const a = await t.call('/v1/chat/completions', { model: 'router/x', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(a.status, 200);
    assert.equal(n, 2);
    const quota = t.gateway.providers.quota();
    const up = quota.find((x) => x.id === 'up');
    assert.equal(up.status, 429);
    assert.equal(up.retryAfterMs, 30000);
    assert.ok(up.cooldown.until > Date.now() + 20000);
    assert.equal(quota.find((x) => x.id === 'second').tokens.remaining, 900);
    // While "up" cools down, the route goes straight to the second target.
    await t.call('/v1/chat/completions', { model: 'router/x', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(n, 3);
    assert.equal(t.up.requests.at(-1).body.model, 'm1');
  } finally {
    await t.close();
  }
});

test('auto token refresh: OAuth2 client credentials and a Google service account, with replay after a 401', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let issued = 0;
  let rejectNext = false;
  const envMap = { CC_SECRET: 's3cret' };
  const t = await setup({
    token: (r) => {
      const f = new URLSearchParams(typeof r.body === 'string' ? r.body : '');
      if (f.get('grant_type') === 'client_credentials') {
        assert.equal(f.get('client_id'), 'app-1');
        assert.equal(f.get('client_secret'), 's3cret');
        return { body: { access_token: `cc-${++issued}`, expires_in: 3600 } };
      }
      const [h, p, sig] = f.get('assertion').split('.');
      assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')));
      assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, 'sa@proj.iam.gserviceaccount.com');
      return { body: { access_token: `sa-${++issued}`, expires_in: 3600 } };
    },
    openai: (r) => {
      if (rejectNext) {
        rejectNext = false;
        return { status: 401, body: { error: { message: 'expired' } } };
      }
      return oaReply(`auth ${r.headers.authorization}`);
    },
    env: envMap,
    extraProviders: [],
  });
  try {
    const saJson = JSON.stringify({
      client_email: 'sa@proj.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: `${t.up.url}/token`,
    });
    envMap.SA_JSON = saJson;
    t.setGw((g) => ({
      ...g,
      providers: [
        ...g.providers,
        {
          id: 'azure',
          preset: 'azure-openai',
          baseUrl: t.up.url,
          tier: 'external',
          approved: true,
          apiKey: { env: 'CC_SECRET' },
          auth: {
            type: 'oauth2',
            tokenUrl: `${t.up.url}/token`,
            clientId: 'app-1',
            scope: 'x/.default',
            grant: 'client_credentials',
          },
        },
        {
          id: 'vertex',
          preset: 'vertex',
          baseUrl: t.up.url,
          tier: 'external',
          approved: true,
          apiKey: { env: 'SA_JSON' },
          auth: { type: 'google-sa', scope: 'https://www.googleapis.com/auth/cloud-platform' },
        },
      ],
    }));
    const a = await t.call('/v1/chat/completions', { model: 'azure/gpt', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(a.json.choices?.[0]?.message?.content, 'auth Bearer cc-1', JSON.stringify(a.json));
    await t.call('/v1/chat/completions', { model: 'azure/gpt', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(issued, 1); // cached until close to expiry
    rejectNext = true;
    const b = await t.call('/v1/chat/completions', { model: 'azure/gpt', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(b.json.choices[0].message.content, 'auth Bearer cc-2'); // refreshed and replayed once
    const v = await t.call('/v1/chat/completions', {
      model: 'vertex/gemini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(v.json.choices[0].message.content, 'auth Bearer sa-3');
    assert.ok(t.gateway.providers.quota().find((x) => x.id === 'vertex').token.expiresAt > Date.now());
  } finally {
    await t.close();
  }
});

test('code tools: snippets for every tool, file-based tools written with a backup and reverted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-tools-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ theme: 'dark', env: { FOO: '1' } }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(
    path.join(home, '.codex/config.toml'),
    'model = "o3"\napproval_policy = "on-request"\n\n[mcp_servers.x]\ncommand = "y"\n',
  );
  const tools = createTools({ home });
  const B = 'http://127.0.0.1:4777';
  assert.ok(
    tools
      .list(B)
      .filter((x) => !x.unsupported)
      .every((x) => tools.snippet(x.id, B, 'zp_KEY', 'up/m1').includes('zp_KEY')),
  );
  assert.equal(tools.list(B).find((x) => x.id === 'cursor').state, 'unsupported');
  tools.apply('claude-code', B, 'zp_SECRETsecretSECRETsecret1234', 'up/m1');
  const cc = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(cc.theme, 'dark');
  assert.equal(cc.env.FOO, '1');
  assert.equal(cc.env.ANTHROPIC_BASE_URL, B);
  assert.equal(cc.env.ANTHROPIC_AUTH_TOKEN, 'zp_SECRETsecretSECRETsecret1234');
  assert.equal(fs.statSync(path.join(home, '.claude/settings.json')).mode & 0o777, 0o600);
  assert.equal(tools.list(B).find((x) => x.id === 'claude-code').state, 'connected');
  tools.apply('codex', B, 'zp_SECRETsecretSECRETsecret1234', 'up/m1');
  const toml = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.match(toml, /^model_provider = "zaafpulse"\nmodel = "up\/m1"\napproval_policy/);
  assert.match(toml, /\[mcp_servers\.x\]/);
  assert.match(toml, /wire_api = "responses"/);
  assert.ok(!/model = "o3"/.test(toml));
  tools.apply('codex', B, 'zp_SECRET2secretSECRETsecret123', 'up/m1'); // applying twice keeps one provider block
  assert.equal(
    (fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8').match(/\[model_providers\.zaafpulse\]/g) || [])
      .length,
    1,
  );
  tools.apply('gemini-cli', B, 'zp_GgeminiGEMINIgeminiGEMINI12', 'up/m1');
  assert.match(
    fs.readFileSync(path.join(home, '.gemini/.env'), 'utf8'),
    /GOOGLE_GEMINI_BASE_URL=http:\/\/127\.0\.0\.1:4777\nGEMINI_API_KEY=zp_GgeminiGEMINIgeminiGEMINI12/,
  );
  tools.revert('claude-code');
  tools.revert('codex');
  tools.revert('gemini-cli');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')), {
    theme: 'dark',
    env: { FOO: '1' },
  });
  assert.match(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), /^model = "o3"/);
  assert.ok(!fs.existsSync(path.join(home, '.gemini/.env')));
  // Through the admin API: a dedicated key per tool, revoked again on revert.
  const t = await setup();
  try {
    const r = await t.gateway.admin('tools', 'POST', { action: 'apply', id: 'opencode', model: 'up/m1' });
    assert.ok(r.ok);
    assert.equal(r.key.name, 'tool:opencode');
    const oc = JSON.parse(fs.readFileSync(path.join(t.toolsHome, '.config/opencode/opencode.json'), 'utf8'));
    const res = await fetch(`${t.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${oc.provider.zaafpulse.options.apiKey}` },
      body: JSON.stringify({ model: 'up/m1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    await t.gateway.admin('tools', 'POST', { action: 'revert', id: 'opencode' });
    assert.ok(t.gateway.keys.list().find((k) => k.name === 'tool:opencode').revokedAt);
    assert.match((await t.gateway.admin('tools', 'POST', { action: 'apply', id: 'cursor' })).errors[0], /127\.0\.0\.1/);
  } finally {
    await t.close();
  }
});
