const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTopology, providerOf, PROVIDER_LABELS } = require('../lib/topology');

const NOW = Date.parse('2026-10-23T12:00:00Z');
const MIN = 60 * 1000;
const APP_NAMES = {
  'claude-desktop': 'Claude Desktop',
  claude: 'Claude Code',
  codex: 'Codex',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

// Everything empty unless given: no apps, no logs, no gateway, no routers, no runtimes, every tool direct.
const input = (o = {}) => ({
  live: { apps: [], installed: [] },
  logs: { requests: [], errors: [] },
  gateway: { providers: [], usage: [], keys: [] },
  routers: [],
  runtimes: [],
  routes: { claude: null, codex: null },
  appNames: APP_NAMES,
  ...o,
});
const turn = (source, model, ago, extra = {}) => ({
  id: `${source}-${ago}-${model}`,
  ts: NOW - ago,
  source,
  model,
  input: 100,
  output: 20,
  durationMs: 900,
  toolErrors: 0,
  ...extra,
});
const omni = (o = {}) => ({
  id: 'omniroute',
  name: 'OmniRoute',
  flavor: 'omniroute',
  health: { ok: true },
  providers: [],
  calls: [],
  ...o,
});
const node = (t, id) => t.nodes.find((n) => n.id === id);
const edgeIds = (t) => t.edges.map((e) => e.id).sort();

test('providerOf maps model and provider names to a provider', () => {
  const cases = {
    'claude-opus-5-5': 'anthropic',
    Anthropic: 'anthropic',
    'gpt-5.6-sol': 'openai',
    o3: 'openai',
    'o4-mini': 'openai',
    'gpt-5-codex': 'openai',
    codex: 'openai',
    OpenAI: 'openai',
    chatgpt: 'openai',
    'gemini-3-flash': 'google',
    google: 'google',
    'vertex-ai': 'google',
    'grok-4': 'xai',
    xai: 'xai',
    'mistral-large': 'mistral',
    'codestral-2501': 'mistral',
    'deepseek-v3': 'deepseek',
    'qwen3-coder': 'qwen',
    'llama3.2:3b': 'meta',
    'meta-llama/llama-4': 'meta',
    openrouter: 'openrouter',
    ollama: 'other',
    'phi-4': 'other',
    '': 'other',
    null: 'other',
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(providerOf(name === 'null' ? null : name), want, name);
  assert.equal(providerOf(undefined), 'other');
  assert.equal(providerOf(42), 'other');
  assert.deepEqual(Object.keys(PROVIDER_LABELS).sort(), [
    'anthropic',
    'deepseek',
    'google',
    'meta',
    'mistral',
    'openai',
    'openrouter',
    'other',
    'qwen',
    'xai',
  ]);
  assert.equal(PROVIDER_LABELS.xai, 'xAI');
  assert.equal(PROVIDER_LABELS.openrouter, 'OpenRouter');
});

test('a direct Claude Code with only claude-* turns goes to Anthropic, with its turns in the requests', () => {
  const t = buildTopology(
    input({
      live: { apps: [{ id: 'claude', name: 'Claude Code' }], installed: ['claude'] },
      logs: { requests: [turn('claude', 'claude-opus-5-5', 2 * MIN), turn('claude', 'claude-haiku-5', 3 * MIN)] },
    }),
    NOW,
  );
  assert.equal(t.ts, NOW);
  assert.deepEqual(node(t, 'claude'), {
    id: 'claude',
    layer: 0,
    kind: 'tool',
    label: 'Claude Code',
    status: 'active',
    note: null,
  });
  assert.deepEqual(node(t, 'provider:anthropic'), {
    id: 'provider:anthropic',
    layer: 2,
    kind: 'provider',
    label: 'Anthropic',
    status: 'active',
    note: null,
  });
  assert.deepEqual(t.edges, [
    { id: 'claude>provider:anthropic', from: 'claude', to: 'provider:anthropic', status: 'active' },
  ]);
  assert.deepEqual(t.requests[0], {
    ts: NOW - 2 * MIN,
    path: ['claude', 'provider:anthropic'],
    client: 'Claude Code',
    model: 'claude-opus-5-5',
    tokens: 120,
    ms: 900,
    ok: true,
    source: 'logs',
  });
  assert.equal(t.requests.length, 2);
});

test('a direct tool gets one edge per provider in its turns; with none, Claude Code goes to Anthropic, Codex to OpenAI', () => {
  const t = buildTopology(
    input({
      live: { apps: [], installed: ['claude', 'codex', 'cursor'] },
      logs: { requests: [turn('codex', 'gpt-5.6', MIN), turn('codex', 'qwen3-coder', MIN)] },
    }),
    NOW,
  );
  assert.deepEqual(edgeIds(t), ['claude>provider:anthropic', 'codex>provider:openai', 'codex>provider:qwen']);
  assert.equal(node(t, 'cursor').label, 'Cursor');
  assert.equal(node(t, 'claude').status, 'idle');
  // An app without a name in appNames is labelled with its id.
  const u = buildTopology(input({ live: { apps: [], installed: ['zed'] }, appNames: undefined }), NOW);
  assert.equal(node(u, 'zed').label, 'zed');
});

test('Claude Code and Codex are tools when the logs hold their turns, even if not installed or running', () => {
  const t = buildTopology(input({ logs: { requests: [turn('codex', 'gpt-5', MIN)] } }), NOW);
  assert.deepEqual(
    t.nodes.filter((n) => n.layer === 0).map((n) => n.id),
    ['codex'],
  );
});

test('the local runtimes are drawn as runtimes, not as tools', () => {
  const t = buildTopology(
    input({
      live: { apps: [{ id: 'ollama' }], installed: ['ollama', 'lmstudio', 'claude'] },
      runtimes: [
        { id: 'ollama', name: 'Ollama', running: true, healthy: true, port: 11434, models: null },
        { id: 'lmstudio', name: 'LM Studio', running: false, healthy: false, port: 1234, models: null },
      ],
    }),
    NOW,
  );
  assert.deepEqual(
    t.nodes.filter((n) => n.layer === 0).map((n) => n.id),
    ['claude'],
  );
  assert.deepEqual(node(t, 'runtime:ollama'), {
    id: 'runtime:ollama',
    layer: 1,
    kind: 'runtime',
    label: 'Ollama',
    status: 'idle',
    note: null,
  });
  assert.equal(node(t, 'runtime:lmstudio'), undefined);
});

test('Codex pointed at OmniRoute goes to the router, and its log turns are left out of the requests', () => {
  const t = buildTopology(
    input({
      live: { apps: [{ id: 'codex' }], installed: ['claude', 'codex'] },
      logs: { requests: [turn('codex', 'gpt-5.6', MIN), turn('claude', 'claude-opus-5-5', 4 * MIN)] },
      routes: { claude: null, codex: 'omniroute' },
      routers: [
        omni({
          providers: [{ provider: 'openai', name: 'work', isActive: true, testStatus: 'active' }],
          calls: [
            {
              id: 'c1',
              ts: NOW - 30 * 1000,
              method: 'POST',
              path: '/v1/responses',
              status: 200,
              model: 'gpt-5.6',
              provider: 'openai',
              account: 'me***@x.com',
              durationMs: 1200,
              tokens: { in: 300, out: 50, cacheRead: 9000 },
            },
            { id: 'c2', ts: NOW - 2 * MIN, status: 200, model: 'claude-sonnet-5', provider: 'Claude', tokens: {} },
          ],
        }),
      ],
    }),
    NOW,
  );
  assert.deepEqual(node(t, 'router:omniroute'), {
    id: 'router:omniroute',
    layer: 1,
    kind: 'router',
    label: 'OmniRoute',
    status: 'active',
    note: null,
  });
  assert.deepEqual(edgeIds(t), [
    'claude>provider:anthropic',
    'codex>router:omniroute',
    'router:omniroute>provider:anthropic',
    'router:omniroute>provider:openai',
  ]);
  assert.ok(!t.edges.some((e) => e.id === 'codex>provider:openai'));
  assert.equal(
    t.requests.filter((r) => r.source === 'logs').length,
    1,
    'only the direct Claude Code turn comes from the logs',
  );
  assert.equal(t.requests[0].source, 'router');
  assert.deepEqual(t.requests[0], {
    ts: NOW - 30 * 1000,
    path: ['codex', 'router:omniroute', 'provider:openai'],
    client: 'Codex',
    model: 'gpt-5.6',
    tokens: 350,
    ms: 1200,
    ok: true,
    source: 'router',
  });
  assert.deepEqual(t.requests[1].path, ['codex', 'router:omniroute', 'provider:anthropic']);
});

test('a router is labelled with its connector name, and a 9router without one with "9router"', () => {
  const t = buildTopology(
    input({ routers: [omni({ id: 'mine', name: 'Home router' }), omni({ id: 'n', name: '', flavor: '9router' })] }),
    NOW,
  );
  assert.equal(node(t, 'router:mine').label, 'Home router');
  assert.equal(node(t, 'router:n').label, '9router');
  assert.equal(buildTopology(input({ routers: [omni({ name: undefined })] }), NOW).nodes[0].label, 'OmniRoute');
});

test('the gateway goes to a running runtime by port, and to the provider otherwise', () => {
  const gateway = {
    providers: [
      { id: 'local', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', enabled: true },
      { id: 'lms', preset: 'lmstudio', enabled: true }, // no baseUrl: the preset's port (1234)
      { id: 'anth', preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', enabled: true },
      { id: 'off', preset: 'gemini', enabled: false },
    ],
    usage: [],
    keys: [],
  };
  const runtimes = [
    {
      id: 'ollama',
      name: 'Ollama',
      running: true,
      healthy: true,
      port: 11434,
      models: { loaded: ['llama3.2:3b'], remembered: ['llama3.2:3b', 'qwen3:8b'] },
    },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      running: false,
      healthy: false,
      port: 1234,
      models: { loaded: [], remembered: ['x'] },
    },
  ];
  const t = buildTopology(input({ gateway, runtimes }), NOW);
  assert.deepEqual(node(t, 'gateway'), {
    id: 'gateway',
    layer: 1,
    kind: 'gateway',
    label: 'Agent Gateway',
    status: 'idle',
    note: null,
  });
  assert.deepEqual(edgeIds(t), [
    'gateway>provider:anthropic',
    'gateway>provider:other', // LM Studio is not running
    'gateway>runtime:ollama',
    'runtime:ollama>model:ollama:llama3.2:3b', // what a Start loaded; qwen3:8b is only remembered
  ]);
  assert.deepEqual(node(t, 'model:ollama:llama3.2:3b'), {
    id: 'model:ollama:llama3.2:3b',
    layer: 2,
    kind: 'model',
    label: 'llama3.2:3b',
    status: 'idle',
    note: null,
  });
  assert.equal(node(t, 'provider:google'), undefined, 'a disabled provider has no edge');
  // Nothing loaded by a Start: the models last read from the running server are the loaded ones.
  const r = buildTopology(
    input({
      runtimes: [{ ...runtimes[0], models: { loaded: [], remembered: ['qwen3:8b', 'qwen3:8b', 7] } }],
    }),
    NOW,
  );
  assert.deepEqual(edgeIds(r), ['runtime:ollama>model:ollama:qwen3:8b']);
  // With no enabled provider there is no gateway.
  const u = buildTopology(input({ gateway: { providers: [{ id: 'off', preset: 'openai', enabled: false }] } }), NOW);
  assert.equal(node(u, 'gateway'), undefined);
});

test('gateway usage: path, ok, and the key name or agent as the client', () => {
  const gateway = {
    providers: [
      { id: 'anth', preset: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', enabled: true },
      { id: 'local', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true },
    ],
    usage: [
      {
        ts: NOW - MIN,
        keyId: 'k1',
        provider: 'anth',
        model: 'claude-sonnet-5',
        status: 200,
        ms: 800,
        input: 10,
        output: 5,
      },
      {
        ts: NOW - 2 * MIN,
        keyId: 'k2',
        agent: 'researcher',
        provider: 'local',
        model: 'llama3.2:3b',
        status: 200,
        ms: 50,
      },
      { ts: NOW - 3 * MIN, keyId: 'k1', provider: 'anth', model: 'claude-x', status: 200, error: 'boom', ms: 5 },
      { ts: NOW - 4 * MIN, keyId: 'k1', provider: 'anth', model: 'claude-x', status: 429, ms: 5 },
      { ts: NOW - 5 * MIN, keyId: 'zz', provider: 'gone', model: 'gpt-5', routedTo: 'gpt-5-mini', status: 200 },
    ],
    keys: [
      { id: 'k1', name: 'laptop' },
      { id: 'k2', name: '' },
    ],
  };
  const runtimes = [{ id: 'ollama', name: 'Ollama', running: true, healthy: true, port: 11434, models: null }];
  const base = { live: { apps: [], installed: ['claude', 'codex'] }, gateway, runtimes };

  const t = buildTopology(input(base), NOW);
  const g = t.requests.filter((r) => r.source === 'gateway');
  assert.deepEqual(g[0], {
    ts: NOW - MIN,
    path: ['gateway', 'provider:anthropic'],
    client: 'laptop',
    model: 'claude-sonnet-5',
    tokens: 15,
    ms: 800,
    ok: true,
    source: 'gateway',
  });
  assert.deepEqual(g[1].path, ['gateway', 'runtime:ollama']);
  assert.equal(g[1].client, 'researcher');
  assert.equal(g[2].ok, false, 'an error makes it fail');
  assert.equal(g[3].ok, false, 'a status of 400 or more makes it fail');
  // A provider no longer configured: the model names the provider, and the model is what answered.
  assert.deepEqual(g[4].path, ['gateway', 'provider:openai']);
  assert.equal(g[4].model, 'gpt-5-mini');
  assert.equal(g[4].client, null);
  assert.ok(node(t, 'provider:openai'), 'a provider seen in a request is drawn');
  assert.ok(t.edges.some((e) => e.id === 'gateway>provider:openai'));

  // One tool routed to the gateway does not make it the client of every request: the key says who sent it.
  const one = buildTopology(input({ ...base, routes: { claude: 'gateway', codex: null } }), NOW);
  const r = one.requests.find((x) => x.source === 'gateway');
  assert.deepEqual(r.path, ['gateway', 'provider:anthropic']);
  assert.equal(r.client, 'laptop');
  assert.ok(one.edges.some((e) => e.id === 'claude>gateway'));
});

test('gateway usage: a tool key names its tool, the dashboard is ZAAFPulse, any other key or agent is the client', () => {
  const use = (ago, keyId, extra = {}) => ({
    ts: NOW - ago * MIN,
    keyId,
    provider: 'anth',
    model: 'claude-sonnet-5',
    status: 200,
    ...extra,
  });
  const gateway = {
    providers: [{ id: 'anth', preset: 'anthropic', enabled: true }],
    usage: [
      use(1, 'kc'),
      use(2, 'kx', { model: 'gpt-5' }),
      use(3, 'kcur'),
      use(4, 'kg'),
      use(5, 'dashboard', { agent: 'judge' }),
      use(6, 'k1'),
      use(7, 'kp'),
      use(8, 'gone', { agent: 'researcher' }),
    ],
    keys: [
      { id: 'kc', name: 'tool:claude-code' },
      { id: 'kx', name: 'tool:codex' },
      { id: 'kcur', name: 'tool:cursor' },
      { id: 'kg', name: 'tool:gemini-cli' },
      { id: 'k1', name: 'laptop' },
      { id: 'kp', name: 'tool:__proto__' },
    ],
  };
  const live = { apps: [], installed: ['claude', 'codex', 'cursor'] };
  const t = buildTopology(input({ live, gateway, routes: { claude: 'gateway', codex: 'gateway' } }), NOW);
  const g = t.requests.filter((q) => q.source === 'gateway');
  assert.deepEqual(
    g.map((q) => [q.path.join(' '), q.client]),
    [
      ['claude gateway provider:anthropic', 'Claude Code'],
      ['codex gateway provider:anthropic', 'Codex'],
      ['cursor gateway provider:anthropic', 'Cursor'],
      ['gateway provider:anthropic', 'tool:gemini-cli'], // its app (Antigravity) is not drawn
      ['gateway provider:anthropic', 'ZAAFPulse'], // the dashboard's own calls: agents, collab, evals, RAG
      ['gateway provider:anthropic', 'laptop'],
      ['gateway provider:anthropic', 'tool:__proto__'],
      ['gateway provider:anthropic', 'researcher'],
    ],
  );
  for (const e of ['claude>gateway', 'codex>gateway', 'cursor>gateway'])
    assert.ok(
      t.edges.some((x) => x.id === e),
      e,
    );
  assert.equal(t.edges.find((x) => x.id === 'claude>gateway').status, 'active', 'its edge takes the request status');
  // Gemini CLI is part of the Antigravity app; with that drawn, its key names it.
  const u = buildTopology(
    input({ live: { apps: [], installed: ['antigravity'] }, gateway: { ...gateway, usage: [use(1, 'kg')] } }),
    NOW,
  );
  assert.deepEqual(u.requests[0].path, ['antigravity', 'gateway', 'provider:anthropic']);
  // A tool key is the client even when that tool is not routed to the gateway (it was pointed there by hand).
  const v = buildTopology(input({ live, gateway: { ...gateway, usage: [use(1, 'kx')] } }), NOW);
  assert.deepEqual(v.requests[0].path, ['codex', 'gateway', 'provider:anthropic']);
});

test('requests from every source are merged newest first and capped at 20', () => {
  const logs = { requests: Array.from({ length: 15 }, (_, i) => turn('claude', 'claude-opus-5-5', (2 * i + 1) * MIN)) };
  const gateway = {
    providers: [{ id: 'oa', preset: 'openai', enabled: true }],
    usage: Array.from({ length: 15 }, (_, i) => ({
      ts: NOW - 2 * i * MIN,
      provider: 'oa',
      model: 'gpt-5',
      status: 200,
    })),
    keys: [],
  };
  const t = buildTopology(input({ logs, gateway }), NOW);
  assert.equal(t.requests.length, 20);
  for (let i = 1; i < t.requests.length; i++) assert.ok(t.requests[i - 1].ts >= t.requests[i].ts);
  assert.equal(t.requests[0].ts, NOW);
  assert.deepEqual(
    t.requests.slice(0, 4).map((r) => r.source),
    ['gateway', 'logs', 'gateway', 'logs'],
  );
});

test('requests older than the 3-hour window, or without a time, are left out', () => {
  const t = buildTopology(
    input({
      logs: { requests: [turn('claude', 'claude-x', 4 * 60 * MIN), turn('claude', 'claude-x', MIN, { ts: 'x' })] },
    }),
    NOW,
  );
  assert.deepEqual(t.requests, []);
});

// A real API failure in the logs (overloaded, 5xx, auth), as lib/reqlogs.js records it.
const apiError = (tool, ago, extra = {}) => ({
  ts: NOW - ago,
  kind: 'api',
  agent: 'app',
  tool,
  source: 'API',
  label: 'API error',
  text: 'API Error: 529 Overloaded · see https://status.anthropic.com',
  ...extra,
});

test('status from the newest request: error, active, recent, idle', () => {
  const at = (ago, ok = true) =>
    buildTopology(
      input({
        live: { apps: [], installed: ['claude'] },
        logs: ok
          ? { requests: [turn('claude', 'claude-x', ago)] }
          : { requests: [], errors: [apiError('claude', ago)] },
      }),
      NOW,
    );
  const err = at(30 * MIN, false);
  assert.equal(node(err, 'claude').status, 'error');
  assert.equal(err.edges[0].status, 'error');
  assert.equal(err.requests[0].ok, false);
  assert.equal(node(at(2 * MIN), 'claude').status, 'active');
  assert.equal(node(at(40 * MIN), 'claude').status, 'recent');
  assert.equal(node(at(120 * MIN), 'claude').status, 'idle');
  assert.equal(node(at(90 * MIN, false), 'claude').status, 'idle', 'an error over 60 minutes old is idle');
  // The newest request decides: an ok turn after an error.
  const t = buildTopology(
    input({
      logs: { requests: [turn('claude', 'claude-y', 3 * MIN)], errors: [apiError('claude', 10 * MIN)] },
    }),
    NOW,
  );
  assert.equal(node(t, 'claude').status, 'active');
});

test('a turn with failed tool calls is ok: the provider answered', () => {
  const t = buildTopology(
    input({
      live: { apps: [], installed: ['claude'] },
      logs: { requests: [turn('claude', 'claude-x', MIN, { toolErrors: 3 })] },
    }),
    NOW,
  );
  assert.equal(t.requests[0].ok, true);
  assert.equal(node(t, 'provider:anthropic').status, 'active');
  assert.equal(node(t, 'claude').status, 'active');
  assert.equal(t.edges.find((e) => e.id === 'claude>provider:anthropic').status, 'active');
});

test('an API error in the logs is a failed request to the tool’s provider', () => {
  const t = buildTopology(
    input({
      live: { apps: [], installed: ['codex'] },
      logs: {
        requests: [],
        errors: [
          apiError('claude', 2 * MIN),
          apiError('codex', 3 * MIN, { model: 'claude-sonnet-5' }), // a known model names the provider
          apiError('claude', 4 * MIN, { kind: 'tool' }), // a failed tool call is not one
          apiError(undefined, 5 * MIN), // no tool
          apiError('cursor', 6 * MIN), // not a tool with logs
          apiError('claude', 4 * 60 * MIN), // outside the window
          null,
        ],
      },
    }),
    NOW,
  );
  assert.deepEqual(t.requests, [
    {
      ts: NOW - 2 * MIN,
      path: ['claude', 'provider:anthropic'],
      client: 'Claude Code',
      model: null,
      tokens: 0,
      ms: null,
      ok: false,
      source: 'logs',
    },
    {
      ts: NOW - 3 * MIN,
      path: ['codex', 'provider:anthropic'],
      client: 'Codex',
      model: 'claude-sonnet-5',
      tokens: 0,
      ms: null,
      ok: false,
      source: 'logs',
    },
  ]);
  assert.ok(node(t, 'claude'), 'a tool with only an API error is drawn');
  assert.equal(node(t, 'provider:anthropic').status, 'error');
  assert.equal(t.edges.find((e) => e.id === 'claude>provider:anthropic').status, 'error');
  assert.doesNotMatch(JSON.stringify(t), /Overloaded|status\.anthropic|https?:/, 'the error text is not copied');
  // A tool routed through a hop: that hop reports its failures, so the log error is left out.
  const u = buildTopology(
    input({
      routers: [omni()],
      routes: { claude: 'omniroute', codex: null },
      logs: { requests: [], errors: [apiError('claude', MIN)] },
    }),
    NOW,
  );
  assert.deepEqual(u.requests, []);
});

test('a running tool with no requests is active', () => {
  const t = buildTopology(input({ live: { apps: [{ id: 'codex' }, { id: 'cursor' }], installed: ['codex'] } }), NOW);
  assert.equal(node(t, 'codex').status, 'active');
  assert.equal(node(t, 'cursor').status, 'active');
  assert.equal(t.edges.find((e) => e.id === 'codex>provider:openai').status, 'idle');
});

test('a router whose health failed is error, with the short reason as its note', () => {
  const t = buildTopology(input({ routers: [omni({ health: { error: 'timed out' } })] }), NOW);
  assert.equal(node(t, 'router:omniroute').status, 'error');
  assert.equal(node(t, 'router:omniroute').note, 'timed out');
  const u = buildTopology(
    input({ routers: [omni({ health: { error: 'connect ECONNREFUSED http://127.0.0.1:20128/api/health' } })] }),
    NOW,
  );
  assert.equal(node(u, 'router:omniroute').status, 'error');
  assert.doesNotMatch(node(u, 'router:omniroute').note, /https?:\/\/|20128/);
  assert.equal(
    node(buildTopology(input({ routers: [omni({ health: { ok: false } })] }), NOW), 'router:omniroute').status,
    'error',
  );
});

test('an OmniRoute connection that is inactive or fails its test makes that provider node error, with a note', () => {
  const t = buildTopology(
    input({
      routers: [
        omni({
          providers: [
            { provider: 'anthropic', name: 'a', isActive: false },
            { provider: 'openai', name: 'b', isActive: true, testStatus: 'failed' },
            { provider: 'gemini', name: 'c', isActive: true, testStatus: 'active' },
          ],
        }),
      ],
    }),
    NOW,
  );
  assert.equal(node(t, 'provider:anthropic').status, 'error');
  assert.ok(node(t, 'provider:anthropic').note);
  assert.equal(node(t, 'provider:openai').status, 'error');
  assert.match(node(t, 'provider:openai').note, /failed/);
  assert.equal(node(t, 'provider:google').status, 'idle');
  assert.equal(node(t, 'provider:google').note, null);
  // Providers may also come wrapped, as OmniRoute's /api/providers answers them.
  const u = buildTopology(
    input({ routers: [omni({ providers: { connections: [{ provider: 'xai', isActive: false }] } })] }),
    NOW,
  );
  assert.equal(node(u, 'provider:xai').status, 'error');
});

test('a layer of more than 12 nodes keeps the 11 busiest and adds "+N more"', () => {
  const ids = Array.from({ length: 15 }, (_, i) => `tool${i}`);
  const t = buildTopology(
    input({
      live: { apps: [], installed: [...ids.slice(0, 13), 'claude'] },
      logs: { requests: [turn('claude', 'claude-x', MIN), turn('claude', 'claude-x', 2 * MIN)] },
    }),
    NOW,
  );
  const tools = t.nodes.filter((n) => n.layer === 0);
  assert.equal(tools.length, 12);
  assert.deepEqual(tools[11], {
    id: 'more:0',
    layer: 0,
    kind: 'more',
    label: '+3 more',
    status: 'idle',
    note: 'tool10, tool11, tool12',
  });
  assert.ok(
    tools.some((n) => n.id === 'claude'),
    'the busiest tool is kept',
  );

  const u = buildTopology(input({ live: { apps: [], installed: ids } }), NOW);
  const v = u.nodes.filter((n) => n.layer === 0);
  assert.equal(v.length, 12);
  assert.equal(v.filter((n) => n.kind === 'tool').length, 11);
  assert.equal(v[11].label, '+4 more');
  assert.equal(v[11].status, 'idle');
});

test('edges and requests of a node folded into "+N more" point at the "+N more" node', () => {
  const ids = Array.from({ length: 14 }, (_, i) => `tool${i}`);
  const t = buildTopology(
    input({ live: { apps: [], installed: [...ids, 'codex'] }, appNames: {}, logs: { requests: [] } }),
    NOW,
  );
  // codex is last and not busier than the others, so it is folded; its default edge then leaves from "+N more".
  assert.equal(node(t, 'codex'), undefined);
  assert.ok(t.edges.some((e) => e.id === 'more:0>provider:openai'));
  for (const e of t.edges) {
    assert.ok(node(t, e.from), e.id);
    assert.ok(node(t, e.to), e.id);
  }
});

test('no URL, path, account or prompt reaches the output', () => {
  const t = buildTopology(
    input({
      live: { apps: [{ id: 'claude' }], installed: ['claude', 'codex'] },
      logs: {
        requests: [turn('claude', 'claude-opus-5-5 see https://evil.example.com/x', MIN, { prompt: 'secret prompt' })],
        errors: [{ ts: NOW, kind: 'tool', source: 'claude', text: 'failed at https://x.example.com' }],
      },
      routes: { claude: null, codex: 'omniroute' },
      gateway: {
        providers: [
          { id: 'p', preset: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: true, apiKey: { env: 'K' } },
        ],
        usage: [
          { ts: NOW, keyId: 'k', provider: 'p', model: 'gpt-5', status: 500, error: 'https://api.openai.com/v1 down' },
        ],
        keys: [{ id: 'k', name: 'http://name.example.com' }],
      },
      routers: [
        omni({
          health: { error: 'fetch failed https://localhost:20128/api/health' },
          providers: [{ provider: 'openai', name: 'me***@x.com', isActive: false, testStatus: 'error http://a.b' }],
          calls: [
            {
              ts: NOW,
              path: '/v1/chat/completions',
              status: 500,
              model: 'http://model.example.com',
              provider: 'openai',
              account: 'me***@x.com',
            },
          ],
        }),
      ],
      runtimes: [
        { id: 'ollama', name: 'Ollama', running: true, port: 11434, models: { loaded: ['https://m.example.com'] } },
      ],
    }),
    NOW,
  );
  const s = JSON.stringify(t);
  assert.doesNotMatch(s, /https?:\/\//);
  assert.doesNotMatch(s, /secret prompt|@x\.com|\/v1\/chat/);
});

test('model names are clipped to 80 characters', () => {
  const long = `claude-${'x'.repeat(200)}`;
  const t = buildTopology(input({ logs: { requests: [turn('claude', long, MIN)] } }), NOW);
  assert.equal(t.requests[0].model.length, 80);
});

test('wrong types, missing fields and { error } objects in place of lists give an empty graph', () => {
  assert.deepEqual(buildTopology({}, NOW), { ts: NOW, nodes: [], edges: [], requests: [] });
  assert.deepEqual(buildTopology(undefined, NOW), { ts: NOW, nodes: [], edges: [], requests: [] });
  const t = buildTopology(
    {
      live: { error: 'ps failed' },
      logs: { error: 'unreadable' },
      gateway: { providers: { error: 'x' }, usage: 'nope', keys: null },
      routers: [
        null,
        7,
        { id: '' },
        omni({ providers: { error: 'HTTP 401' }, calls: { error: 'HTTP 401' }, health: null }),
      ],
      runtimes: { error: 'x' },
      routes: null,
    },
    NOW,
  );
  assert.deepEqual(
    t.nodes.map((n) => n.id),
    ['router:omniroute'],
  );
  assert.deepEqual(t.requests, []);
  // Rows with junk inside are skipped one by one.
  const u = buildTopology(
    input({
      live: { apps: [null, { id: 3 }, { id: 'claude' }], installed: 'claude' },
      logs: { requests: [null, { ts: NOW - MIN }, turn('codex', null, MIN, { input: 'x', output: null })] },
      routers: [omni({ calls: [null, { ts: NaN }, { ts: NOW - MIN, status: 'x' }] })],
    }),
    NOW,
  );
  assert.ok(node(u, 'claude'));
  const codex = u.requests.find((r) => r.source === 'logs');
  assert.deepEqual(codex.path, ['codex', 'provider:openai'], 'a turn without a model goes to the tool’s own provider');
  assert.equal(codex.tokens, 0);
  assert.equal(codex.model, null);
  const call = u.requests.find((r) => r.source === 'router');
  assert.deepEqual(call.path, ['router:omniroute', 'provider:other']);
  assert.equal(call.ok, false, 'a status that is not a number is not ok');
});

const HOSTILE = [
  '/Users/bob/x/claude user@host.com sk-ant-abcdef123456 localhost:11434/v1',
  'HTTP 401 for bob@corp.com key sk-live-1234567890 ~/.config/x ./a/b C:\\Users\\bob\\x',
];
const LEAKS = ['@corp.com', '@host.com', '/Users/', 'Users\\', '~/', 'sk-live', 'sk-ant', 'localhost:11434/', './a/b'];
const noLeak = (t) => {
  const s = JSON.stringify(t);
  for (const l of LEAKS) assert.ok(!s.includes(l), `${l} leaked in ${s}`);
};

test('emails, paths, host:port and tokens are scrubbed from every text field', () => {
  for (const bad of HOSTILE) {
    const t = buildTopology(
      input({
        logs: { requests: [turn('claude', `${bad} claude-3`, 1 * MIN)], errors: [] },
        gateway: {
          providers: [{ id: 'a', preset: 'anthropic', enabled: true }],
          usage: [
            { ts: NOW - MIN, keyId: 'k1', provider: 'a', model: 'claude-3', status: 200 },
            { ts: NOW - 2 * MIN, keyId: 'zz', agent: bad, provider: 'a', model: 'claude-3', status: 200 },
          ],
          keys: [{ id: 'k1', name: bad }],
        },
        routers: [
          omni({
            name: bad,
            health: { error: bad },
            providers: [{ provider: 'openai', testStatus: bad }],
          }),
        ],
      }),
      NOW,
    );
    noLeak(t);
    assert.ok(
      t.requests.some((q) => q.client),
      'client kept as scrubbed text',
    );
  }
});

test('plain vendor/model names survive the scrub', () => {
  const t = buildTopology(
    input({
      logs: { requests: [turn('claude', 'meta-llama/Llama-3', MIN), turn('codex', 'anthropic/claude-3', MIN)] },
    }),
    NOW,
  );
  assert.deepEqual(t.requests.map((q) => q.model).sort(), ['anthropic/claude-3', 'meta-llama/Llama-3']);
});

test('a tool label that falls back to the raw id is scrubbed', () => {
  const t = buildTopology(input({ live: { apps: [], installed: ['/Users/bob/x/tool'] } }), NOW);
  noLeak(t);
});

test('router ids in node ids keep only safe characters and 40 characters', () => {
  const t = buildTopology(input({ routers: [omni({ id: 'a@corp.com/../~x sk-live-1234567890' })] }), NOW);
  noLeak(t);
  for (const n of t.nodes) assert.match(n.id, /^[A-Za-z0-9._:-]+$/);
  const id = 'x'.repeat(60);
  const u = buildTopology(input({ routers: [omni({ id })] }), NOW);
  assert.ok(u.nodes.some((n) => n.id === `router:${'x'.repeat(40)}`));
});

test('a string status counts as a number', () => {
  const t = buildTopology(
    input({
      gateway: {
        providers: [{ id: 'a', preset: 'anthropic', enabled: true }],
        usage: [{ ts: NOW - MIN, provider: 'a', model: 'claude-3', status: '200' }],
      },
      routers: [omni({ calls: [{ ts: NOW - MIN, status: '200', model: 'gpt-5', provider: 'openai' }] })],
    }),
    NOW,
  );
  assert.ok(t.requests.length === 2 && t.requests.every((q) => q.ok));
});

test('a tool routed to a hop that is not a node falls back to direct', () => {
  for (const route of ['nosuchrouter', 'gateway']) {
    const t = buildTopology(
      input({
        live: { apps: [], installed: ['claude'] },
        logs: { requests: [turn('claude', 'claude-3', MIN)], errors: [] },
        routes: { claude: route, codex: null },
      }),
      NOW,
    );
    assert.ok(edgeIds(t).includes('claude>provider:anthropic'));
    assert.equal(t.requests.length, 1);
    assert.deepEqual(t.requests[0].path, ['claude', 'provider:anthropic']);
  }
});

test('a tool named like an Object.prototype key has no default provider', () => {
  const t = buildTopology(input({ live: { apps: [], installed: ['constructor', 'toString'] } }), NOW);
  assert.deepEqual(edgeIds(t), []);
});

test('real model names survive the scrub: Ollama tags, Vertex @versions, dated tags', () => {
  const names = [
    'llama3.2:3b',
    'qwen3:14b',
    'deepseek-r1:70b',
    'gpt-4:2024',
    'claude-sonnet-4-5@20250929',
    'nomic-embed-text:latest',
  ];
  const now = Date.now();
  const out = buildTopology(
    {
      logs: {
        requests: names.map((model, i) => ({ ts: now - i * 1000, source: 'claude', model, input: 1, output: 1 })),
      },
    },
    now,
  );
  assert.deepEqual(out.requests.map((r) => r.model).sort(), [...names].sort());
  const hostile = buildTopology(
    {
      logs: { requests: [{ ts: now, source: 'claude', model: 'm bob@corp.com 10.0.0.5:8080/x api.example.com:443' }] },
    },
    now,
  );
  assert.equal(hostile.requests[0].model, 'm');
});
