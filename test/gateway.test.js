const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const { routeByKeywords, firstJson } = require('../lib/gateway/orchestrator');
const { TEMPLATES } = require('../lib/gateway/agents');

const PRICING = { 'llama-9': { input: 1, output: 2 } };
const completion = (content, extra = {}) => ({
  id: 'c1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 500 },
});

async function setup(handler) {
  const upstream = await fakeServer({
    'POST /chat/completions': handler,
    'GET /models': { body: { data: [{ id: 'llama-9' }, { id: 'tiny' }] } },
    'POST /embeddings': { body: { data: [{ embedding: [0.1] }], usage: { prompt_tokens: 3 } } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gw-'));
  let gw = {
    providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, models: [], enabled: true }],
    defaults: { model: 'fake/llama-9', plannerModel: 'fake/llama-9' },
  };
  const tools = [
    { name: 'dynatrace_list_problems', description: 'Problems', inputSchema: { type: 'object', properties: {} } },
  ];
  const calls = [];
  const integrations = {
    // Like the real registry: every tool says whether it is read-only.
    listTools: async () => tools.map((t) => ({ annotations: { readOnlyHint: !t.write }, ...t })),
    callTool: async (name, args) => {
      calls.push([name, args]);
      return { result: { content: [{ type: 'text', text: '2 open problems' }] } };
    },
  };
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: (g) => {
      gw = g;
    },
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => PRICING,
    getIntegrations: () => integrations,
  });
  const server = http.createServer(async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { key, method = 'POST', body, headers = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
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
    upstream,
    call,
    calls,
    close: async () => {
      server.close();
      await upstream.close();
    },
  };
}

test('keys: auth, scopes, allowed models, rate limit and budget', async () => {
  const t = await setup(() => ({ body: completion('hi') }));
  try {
    assert.equal((await t.call('/v1/models', { method: 'GET' })).status, 401);
    const { secret, key } = t.gateway.keys.create({
      name: 'app',
      scopes: ['llm'],
      models: ['fake/llama-*'],
      rpm: 4,
      budgetUSD: 0.002,
    });
    assert.match(secret, /^zp_/);
    assert.ok(!JSON.stringify(t.gateway.keys.list()).includes(secret));
    const models = await t.call('/v1/models', { key: secret, method: 'GET' });
    assert.deepEqual(
      models.json.data.map((m) => m.id),
      ['fake/llama-9'],
    ); // tiny is not allowed, no agents scope
    assert.equal(
      (await t.call('/v1/chat/completions', { key: secret, body: { model: 'fake/tiny', messages: [] } })).status,
      403,
    );
    const ok = await t.call('/v1/chat/completions', {
      key: secret,
      body: { model: 'fake/llama-9', messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.model, 'fake/llama-9');
    assert.equal(t.upstream.requests.at(-1).body.model, 'llama-9');
    assert.ok(Math.abs(t.gateway.usage.monthSpend(key.id) - 0.002) < 1e-9); // 1000 in × $1 + 500 out × $2 per 1M
    const broke = await t.call('/v1/chat/completions', { key: secret, body: { model: 'fake/llama-9', messages: [] } });
    assert.equal(broke.status, 402);
    assert.equal((await t.call('/v1/agents', { key: secret, method: 'GET' })).status, 403); // no agents scope
    const limited = await t.call('/v1/models', { key: secret, method: 'GET' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    t.gateway.keys.revoke(key.id);
    assert.equal((await t.call('/v1/models', { key: secret, method: 'GET' })).status, 401);
  } finally {
    await t.close();
  }
});

test('streaming passes chunks through and records usage from the final chunk', async () => {
  const sse =
    [
      '{"choices":[{"delta":{"content":"Hel"}}]}',
      '{"choices":[{"delta":{"content":"lo"}}]}',
      '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    ]
      .map((d) => `data: ${d}\n\n`)
      .join('') + 'data: [DONE]\n\n';
  const t = await setup((r) =>
    r.body.stream ? { headers: { 'content-type': 'text/event-stream' }, body: sse } : { body: completion('x') },
  );
  try {
    const { secret } = t.gateway.keys.create({ name: 's', scopes: ['llm'] });
    const r = await t.call('/v1/chat/completions', {
      key: secret,
      body: { model: 'fake/llama-9', stream: true, messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('"Hel"') && r.text.includes('[DONE]'));
    assert.equal(t.upstream.requests.at(-1).body.stream_options.include_usage, true);
    const e = t.gateway.usage.recent(1)[0];
    assert.equal(e.input, 10);
    assert.equal(e.output, 2);
    assert.equal(e.stream, true);
    assert.ok(e.ttft != null);
  } finally {
    await t.close();
  }
});

test('judge: lists routable providers without secrets, completes with no tools and records agent judge', async () => {
  const t = await setup(() => ({ body: completion('{"label":"ok"}') }));
  try {
    const list = t.gateway.judge.providers();
    assert.deepEqual(list, [{ id: 'fake', label: 'fake', models: [] }]);
    assert.ok(!JSON.stringify(list).includes(t.upstream.url), 'no base URL in the list');
    const r = await t.gateway.judge.complete({
      model: 'fake/llama-9',
      messages: [{ role: 'user', content: 'judge this' }],
    });
    assert.equal(r.text, '{"label":"ok"}');
    assert.equal(r.usage.input, 1000);
    assert.equal(r.usage.output, 500);
    assert.ok(r.usage.cost > 0);
    assert.equal(t.gateway.judge.hasPrice('fake/llama-9'), true);
    assert.equal(t.gateway.judge.hasPrice('fake/no-such-model-xyz'), false);
    assert.ok(t.gateway.judge.priceOf('fake/llama-9').input > 0);
    assert.equal(t.gateway.judge.priceOf('fake/no-such-model-xyz'), null);
    const sent = t.upstream.requests.find((q) => q.path === '/chat/completions').body;
    assert.equal('tools' in sent, false);
    assert.equal('tool_choice' in sent, false);
    assert.equal(sent.temperature, 0);
    const e = t.gateway.usage.recent(1)[0];
    assert.equal(e.agent, 'judge');
    assert.equal(e.model, 'fake/llama-9');
  } finally {
    await t.close();
  }
});

// The cost ledger counts Claude Code and Codex on this machine from their own logs, so their gateway lines are tagged.
test('usage lines name a Claude Code or Codex client and a loopback caller, never the raw User-Agent', async () => {
  const t = await setup(() => ({ body: completion('hi') }));
  try {
    const { secret } = t.gateway.keys.create({ name: 'cli', scopes: ['llm'] });
    const body = { model: 'fake/llama-9', messages: [{ role: 'user', content: 'x' }] };
    const cc = await t.call('/v1/chat/completions', {
      key: secret,
      body,
      headers: { 'User-Agent': 'claude-cli/2.1.304' },
    });
    assert.equal(cc.status, 200);
    const e = t.gateway.usage.recent(1)[0];
    assert.equal(e.client, 'claude-code');
    assert.equal(e.local, true);
    assert.equal('userAgent' in e, false);
    assert.doesNotMatch(JSON.stringify(e), /claude-cli/);

    const codex = await t.call('/v1/responses', {
      key: secret,
      body: { model: 'fake/llama-9', input: 'x' },
      headers: { 'User-Agent': 'codex_cli_rs/0.48.0 (Mac OS 26.6; arm64)' },
    });
    assert.equal(codex.status, 200);
    assert.deepEqual([t.gateway.usage.recent(1)[0].client, t.gateway.usage.recent(1)[0].local], ['codex', true]);

    assert.equal((await t.call('/v1/chat/completions', { key: secret, body })).status, 200);
    const plain = t.gateway.usage.recent(1)[0];
    assert.equal('client' in plain, false, 'any other client is not named');

    await t.gateway.judge.complete({ model: 'fake/llama-9', messages: [{ role: 'user', content: 'judge this' }] });
    const judged = t.gateway.usage.recent(1)[0];
    assert.equal(judged.agent, 'judge');
    assert.equal('client' in judged || 'local' in judged, false, "the dashboard's own calls carry neither field");
  } finally {
    await t.close();
  }
});

test('judge: providers() leaves out disabled and unapproved providers and aliases are detectable', async () => {
  const base = { preset: 'custom', baseUrl: 'http://127.0.0.1:9', enabled: true, tier: 'external', approved: true };
  const gw = {
    providers: [
      { ...base, id: 'on', models: ['a'], aliases: { fast: 'on/a' } },
      { ...base, id: 'off', models: ['b'], enabled: false },
      { ...base, id: 'new', models: ['c'], approved: false },
      { ...base, id: 'mine', preset: 'vllm', models: ['d'], tier: 'private', approved: undefined },
    ],
    routes: [{ name: 'router/smart', targets: ['on/a'], strategy: 'fallback' }],
  };
  const gateway = createGateway({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gw-')),
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => PRICING,
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  assert.deepEqual(gateway.judge.providers().map((p) => p.id), ['on', 'mine']);
  assert.deepEqual(gateway.judge.providers()[0], { id: 'on', label: 'on', models: ['a'] });
  assert.equal(gateway.judge.aliased('fast'), true);
  assert.equal(gateway.judge.aliased('on/a'), false);
  // A route name is refused by the judge too: a provider id "router" would otherwise reach it.
  assert.equal(gateway.judge.routed('router/smart'), true);
  assert.equal(gateway.judge.routed('router/other'), false);
  assert.equal(gateway.judge.routed('on/a'), false);
});

test('judge: an aborted signal cancels the upstream request and no other target is tried', async () => {
  let hits = 0;
  const t = await setup(() => {
    hits++;
    return new Promise(() => {}); // never answers
  });
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const messages = [{ role: 'user', content: 'x' }];
    await assert.rejects(t.gateway.judge.complete({ model: 'fake/llama-9', messages, signal: ctl.signal }));
    assert.equal(hits, 1);
  } finally {
    await t.close();
  }
});

test('judge: list-of-parts content is reduced to its text, anything else to an empty string', async () => {
  let reply = [{ type: 'text', text: 'ab' }, { type: 'image' }, { type: 'text', text: 'cd' }];
  const t = await setup(() => ({ body: completion(reply) }));
  try {
    const ask = () => t.gateway.judge.complete({ model: 'fake/llama-9', messages: [{ role: 'user', content: 'x' }] });
    assert.equal((await ask()).text, 'abcd');
    reply = null;
    assert.equal((await ask()).text, '');
  } finally {
    await t.close();
  }
});

test('agents: tool loop over integration tools, sessions and agent models', async () => {
  let n = 0;
  const t = await setup((r) => {
    n++;
    if (r.body.messages.some((m) => m.role === 'tool')) return { body: completion('There are 2 open problems.') };
    return {
      body: completion(null, {
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'dynatrace_list_problems', arguments: '{}' } }],
      }),
    };
  });
  try {
    // Integration tools reach other systems: an agents-only key gets none of them.
    const agentsOnly = t.gateway.keys.create({ name: 'no-mcp', scopes: ['agents'], agents: ['network-ops'] }).secret;
    await t.call('/v1/agents/network-ops/run', { key: agentsOnly, body: { input: 'any outages?' } });
    assert.deepEqual(t.calls, []);
    const firstWithTools = t.upstream.requests.length;
    const { secret } = t.gateway.keys.create({ name: 'a', scopes: ['agents', 'mcp'], agents: ['network-ops'] });
    const r = await t.call('/v1/agents/network-ops/run', { key: secret, body: { input: 'any outages?' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.text, 'There are 2 open problems.');
    assert.deepEqual(t.calls, [['dynatrace_list_problems', {}]]);
    assert.equal(r.json.calls[0].tool, 'dynatrace_list_problems');
    assert.ok(!t.upstream.requests[0].body.tools.some((x) => x.function.name === 'dynatrace_list_problems'));
    const toolsSent = t.upstream.requests[firstWithTools].body.tools.map((x) => x.function.name);
    assert.ok(toolsSent.includes('dynatrace_list_problems') && toolsSent.includes('zp_memory_save'));
    assert.equal((await t.call('/v1/agents/hr-finance/run', { key: secret, body: { input: 'x' } })).status, 403);
    // The same agent through chat completions, continuing the session.
    const c = await t.call('/v1/chat/completions', {
      key: secret,
      headers: { 'x-zp-session': r.json.session_id },
      body: { model: 'agent/network-ops', messages: [{ role: 'user', content: 'and now?' }] },
    });
    assert.equal(c.status, 200);
    assert.equal(c.headers.get('x-zp-session'), r.json.session_id);
    const s = await t.call(`/v1/sessions/${r.json.session_id}`, { key: secret, method: 'GET' });
    assert.equal(s.json.messages.length, 4);
    const other = t.gateway.keys.create({ name: 'b', scopes: ['agents'] }).secret;
    assert.equal((await t.call(`/v1/sessions/${r.json.session_id}`, { key: other, method: 'GET' })).status, 404);
    assert.ok(n >= 4);
  } finally {
    await t.close();
  }
});

test('orchestrator: planner JSON picks agents; a bad plan falls back to keyword routing', async () => {
  let plannerReply =
    '{"steps":[{"agent":"network-ops","instruction":"check the outage"},{"agent":"content-writer","instruction":"write the status update"}],"reason":"two parts"}';
  const t = await setup((r) =>
    r.body.messages[0].content.startsWith('You are the ZAAFPulse planner')
      ? { body: completion(plannerReply) }
      : { body: completion(`done by ${r.body.messages[0].content.match(/You are the (.+?) agent/)[1]}`) },
  );
  try {
    const { secret } = t.gateway.keys.create({ name: 'o', scopes: ['agents'] });
    const r = await t.call('/v1/orchestrate', {
      key: secret,
      body: { task: 'There is a network outage, tell customers' },
    });
    assert.equal(r.json.plan.method, 'planner');
    assert.deepEqual(
      r.json.steps.map((s) => s.agent),
      ['network-ops', 'content-writer'],
    );
    // The writer builds on the network step (a chain), so its output is the answer, forwarded verbatim.
    assert.equal(r.json.answer, 'done by Content Writer');
    assert.equal(r.json.state, 'completed');
    const writer = t.upstream.requests.find((q) => /You are the Content Writer agent/.test(q.body.messages[0].content));
    assert.match(writer.body.messages[0].content, /<agent_output from="network-ops">\ndone by Network Operations/);
    assert.ok(
      r.json.trace.some((s) => s.name === 'invoke_agent network-ops') && r.json.trace.some((s) => s.name === 'plan'),
    );
    plannerReply = 'sorry, no JSON';
    const f = await t.call('/v1/orchestrate', { key: secret, body: { task: 'my payroll and leave balance' } });
    assert.match(f.json.plan.method, /^keywords/);
    assert.equal(f.json.steps[0].agent, 'hr-finance');
  } finally {
    await t.close();
  }
});

test('MCP over HTTP needs the mcp scope and lists integration tools', async () => {
  const t = await setup(() => ({ body: completion('x') }));
  try {
    const noMcp = t.gateway.keys.create({ name: 'n', scopes: ['llm'] }).secret;
    assert.equal(
      (await t.call('/mcp', { key: noMcp, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status,
      403,
    );
    const k = t.gateway.keys.create({ name: 'm', scopes: ['mcp'] }).secret;
    const init = await t.call('/mcp', {
      key: k,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    });
    assert.equal(init.json.result.serverInfo.name, 'zaafpulse-gateway');
    const list = await t.call('/mcp', { key: k, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.deepEqual(
      list.json.result.tools.map((x) => x.name),
      ['dynatrace_list_problems'],
    );
    const callR = await t.call('/mcp', {
      key: k,
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dynatrace_list_problems', arguments: {} } },
    });
    assert.equal(callR.json.result.content[0].text, '2 open problems');
  } finally {
    await t.close();
  }
});

test('helpers: keyword routing, JSON extraction and 17 agent templates', () => {
  assert.equal(TEMPLATES.length, 17);
  assert.equal(routeByKeywords('customer wants a refund', TEMPLATES).id, 'customer-service');
  assert.deepEqual(firstJson('Plan: {"steps":[1]} done'), { steps: [1] });
});
