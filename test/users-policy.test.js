// Dashboard users (AI Governance 4): the role policy (lib/users/policy.js), pure. A table of every route class: what a
// viewer may read, what is never shown to anyone but the owner (content, secrets, previews), the writes, a reviewer's
// extra routes, the password route and the mustChange gate; every route a viewer may read exists; and the redacted
// gateway view keeps no system prompt, note text, session title, run task, key secret or secret reference.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  allowed,
  redactGateway,
  redactTraceSessions,
  redactSummary,
  redactLogs,
  redactGatewayLogs,
  redactConfig,
  redactOffice,
  redactTimeline,
  redactRuntimesConfig,
  redactIntegrations,
  redactRouterProxy,
  redactInventory,
  VIEWER_READS,
  ANYONE,
  OPENROUTER_SECTIONS,
  REVIEWER_EXTRA,
  GATEWAY_PARTS,
} = require('../lib/users/policy');

const ROOT = path.join(__dirname, '..');
const may = (role, method, p, action, mustChange = false) =>
  allowed({ role, method, path: p, action, mustChange, section: p === '/api/openrouter' ? 'models' : null });

test('a viewer reads the metadata routes, a reviewer too; the list is exactly these', () => {
  assert.deepEqual(VIEWER_READS, [
    '/api/platform',
    '/api/summary',
    '/api/live',
    '/api/insights',
    '/api/topology',
    '/api/timeline',
    '/api/office',
    '/api/logs',
    '/api/mcp-calls',
    '/api/router',
    '/api/openrouter',
    '/api/openrouter/endpoints',
    '/api/config',
    '/api/prices',
    '/api/trace/sources',
    '/api/trace/settings',
    '/api/trace/sessions',
    '/api/trace/deps',
    '/api/trace/find',
    '/api/evals/summary',
    '/api/evals/status',
    '/api/evals/evaluators',
    '/api/evals/settings',
    '/api/datasets',
    '/api/datasets/settings',
    '/api/experiments',
    '/api/monitors',
    '/api/monitors/status',
    '/api/alerts',
    '/api/runtimes',
    '/api/runtimes/config',
    '/api/cost/ledger',
    '/api/cost/export',
    '/api/cost/status',
    '/api/cost/settings',
    '/api/cost/restates',
    '/api/cost/prices/versions',
    '/api/cost/view',
    '/api/cost/report',
    '/api/cost/budgets',
    '/api/governance/audit',
    '/api/governance/audit/export',
    '/api/governance/audit/verify',
    '/api/governance/audit/status',
    '/api/governance/inventory',
    '/api/governance/controls',
    '/api/governance/evidence',
    '/api/integrations',
    '/api/gateway',
    '/api/gateway/logs',
  ]);
  for (const p of VIEWER_READS)
    for (const role of ['viewer', 'reviewer']) {
      assert.deepEqual(may(role, 'GET', p), { ok: true, reason: null }, `${role} GET ${p}`);
      // The same path written to is a change: refused (but a reviewer's inventory review, below).
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
        if (!(role === 'reviewer' && `${m} ${p}` === 'POST /api/governance/inventory'))
          assert.equal(may(role, m, p).ok, false, `${role} ${m} ${p}`);
    }
});

test('every route a viewer may read is a route the server answers', () => {
  const src = [
    'server.js',
    'lib/evals/api.js',
    'lib/datasets/api.js',
    'lib/monitors/api.js',
    'lib/runtimes/api.js',
    'lib/cost/api.js',
    'lib/governance/api.js',
  ]
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
  // Routes built from a word: the trace routes, the request log and the datasets' settings.
  const word = {
    '/api/trace/': (w) =>
      src.includes(`'sources', 'settings', 'sessions', 'session', 'title', 'content', 'reveal'`) &&
      src.includes(`'${w}'`),
    '/api/gateway/': (w) => src.includes(`gwAdmin[1] === '${w}'`),
    '/api/datasets/': (w) => src.includes(`a === '${w}'`),
  };
  for (const p of VIEWER_READS) {
    const prefix = Object.keys(word).find((x) => p.startsWith(x));
    assert.ok(prefix ? word[prefix](p.slice(prefix.length)) : src.includes(`'${p}'`), p);
  }
});

test('never for a non-owner: content, secrets and previews; every write; the owner is never refused', () => {
  const ownerOnly = [
    ['GET', '/api/trace/session'],
    ['GET', '/api/trace/title'],
    ['GET', '/api/trace/content'],
    ['GET', '/api/trace/live'],
    ['POST', '/api/trace/reveal'],
    ['GET', '/api/evals'],
    ['GET', '/api/feedback'],
    ['GET', '/api/feedback/sessions'],
    ['POST', '/api/feedback'],
    ['POST', '/api/evals/preview'],
    ['POST', '/api/evals/run'],
    ['POST', '/api/evals/settings'],
    ['GET', '/api/datasets/ds_1'],
    ['GET', '/api/datasets/ds_1/export'],
    ['POST', '/api/datasets'],
    ['POST', '/api/datasets/import'],
    ['PUT', '/api/datasets/ds_1'],
    ['DELETE', '/api/datasets/ds_1'],
    ['GET', '/api/experiments/exp_1'],
    ['POST', '/api/experiments'],
    ['GET', '/api/brain'],
    ['GET', '/api/brain/graph'],
    ['POST', '/api/brain/sources', 'test'],
    ['GET', '/api/vault'],
    ['GET', '/api/integrations/config'],
    ['POST', '/api/integrations/test'],
    ['POST', '/api/integrations/test-draft'],
    ['POST', '/api/integrations/save'],
    ['POST', '/api/integrations/delete'],
    ['POST', '/api/gateway/knowledge', 'get'],
    ['POST', '/api/gateway/knowledge', 'search'],
    ['POST', '/api/gateway/sessions', 'get'],
    ['POST', '/api/gateway/quota'],
    ['POST', '/api/gateway/providers', 'test'],
    ['POST', '/api/gateway/providers', 'models'],
    ['POST', '/api/gateway/logs'],
    ['POST', '/api/gateway/keys', 'create'],
    ['POST', '/api/gateway/settings'],
    ['POST', '/api/gateway/playground'],
    ['POST', '/api/gateway/collab', 'start'],
    ['POST', '/api/gateway/collab', 'cancel'],
    ['POST', '/api/cost/settings/preview'],
    ['POST', '/api/cost/restate/preview'],
    ['POST', '/api/cost/budgets'],
    ['POST', '/api/config'],
    ['POST', '/api/prices', 'refresh'],
    ['POST', '/api/governance/settings'],
    ['POST', '/api/monitors/tool_loop'],
    ['POST', '/api/monitors/channels'],
    ['POST', '/api/agents/pause'],
    ['POST', '/api/runtimes/start'],
    ['POST', '/api/rescan'],
    ['POST', '/api/mcp/register'],
    ['GET', '/api/users'],
    ['POST', '/api/users', 'create'],
    ['GET', '/api/agents/candidates'],
    ['GET', '/api/something-new'],
  ];
  for (const [m, p, action] of ownerOnly) {
    for (const role of ['viewer', 'reviewer'])
      assert.deepEqual(may(role, m, p, action), { ok: false, reason: 'your role cannot do this' }, `${role} ${m} ${p}`);
    assert.equal(may('owner', m, p, action).ok, true);
  }
  // A role that is not one of the three, or none, gets nothing from /api; the page itself is not /api.
  for (const role of [undefined, null, 'admin', 'OWNER'])
    assert.deepEqual(may(role, 'GET', '/api/summary'), { ok: false, reason: 'your role cannot do this' });
  assert.equal(may('viewer', 'GET', '/index.html').ok, true);
  assert.equal(may('viewer', 'GET', '/api').ok, true, '"/api" alone is a file path, not an /api route');
});

test("a reviewer's extras: inventory reviews and run approvals (get, list, resume); a viewer has none of them", () => {
  assert.deepEqual(REVIEWER_EXTRA, [
    'POST /api/governance/inventory',
    'GET /api/users/names',
    'POST /api/gateway/collab get',
    'POST /api/gateway/collab list',
    'POST /api/gateway/collab resume',
  ]);
  const extras = [
    ['POST', '/api/governance/inventory'],
    ['GET', '/api/users/names'],
    ['POST', '/api/gateway/collab', 'get'],
    ['POST', '/api/gateway/collab', 'list'],
    ['POST', '/api/gateway/collab', 'resume'],
  ];
  for (const [m, p, action] of extras) {
    assert.equal(may('reviewer', m, p, action).ok, true, `reviewer ${m} ${p} ${action || ''}`);
    assert.equal(may('viewer', m, p, action).ok, false, `viewer ${m} ${p} ${action || ''}`);
  }
  // The action must be the word itself: no other route, no other spelling.
  for (const action of [undefined, null, 'Resume', 'resume ', ['resume'], 'resume\nx'])
    assert.equal(may('reviewer', 'POST', '/api/gateway/collab', action).ok, false, JSON.stringify(action));
  assert.equal(may('reviewer', 'POST', '/api/gateway/keys', 'get').ok, false);
  assert.equal(may('reviewer', 'GET', '/api/gateway/collab', 'get').ok, false);
});

test('ANYONE is exactly the password route', () => assert.deepEqual(ANYONE, ['POST /api/account/password']));

test('the password route is for anyone signed in; until then every other route says "change your password first"', () => {
  for (const role of ['owner', 'reviewer', 'viewer']) {
    assert.equal(may(role, 'POST', '/api/account/password').ok, true);
    assert.equal(may(role, 'POST', '/api/account/password', null, true).ok, true);
    assert.equal(may(role, 'GET', '/api/account/password').ok, role === 'owner');
  }
  for (const role of ['reviewer', 'viewer']) {
    assert.deepEqual(may(role, 'GET', '/api/summary', null, true), { ok: false, reason: 'change your password first' });
    assert.deepEqual(may(role, 'POST', '/api/gateway/collab', 'get', true).reason, 'change your password first');
  }
  assert.equal(may('nobody', 'POST', '/api/account/password').ok, false);
});

test('the gateway view for a non-owner: no prompt, note text, title, task, key secret, secret reference or quota', () => {
  const g = {
    presets: { openai: {} },
    providers: [
      {
        id: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: { keychain: 'SECRET-REF-1' },
        auth: {
          type: 'oauth2',
          clientId: 'SECRET-CLIENT-2',
          tokenUrl: 'https://t',
          scope: 'SECRET-SCOPE',
          grant: 'SECRET-G',
        },
        models: ['gpt-5'],
        enabled: true,
        tier: 'external',
        extra: 'SECRET-PROV-EXTRA',
      },
      { id: 'local', apiKey: null },
    ],
    keys: [
      {
        id: 'key_1',
        name: 'ci',
        prefix: 'zp_ab…',
        scopes: ['llm'],
        budgetUSD: 5,
        createdAt: 1,
        expiresAt: null,
        lastUsedAt: 2,
        revokedAt: null,
        models: ['SECRET-MODEL-LIST-3'],
        guardrails: { secrets: 'off' },
        secret: 'zp_SECRET4',
      },
    ],
    agents: [
      {
        id: 'sre',
        name: 'SRE',
        domain: 'ops',
        description: 'd',
        keywords: ['k'],
        tools: ['t'],
        model: 'm',
        enabled: true,
        template: false,
        knowledge: ['kb'],
        collaborate: true,
        systemPrompt: 'SECRET-PROMPT-5',
        remoteUrl: 'https://SECRET-REMOTE',
        remoteTokenEnv: 'SECRET-ENV',
        remoteTokenOrigin: 'SECRET-ORIGIN',
        anything: 'SECRET-ANY',
      },
    ],
    workflows: [
      {
        id: 'wf',
        name: 'W',
        category: 'Custom',
        tier: 'R1',
        builtin: true,
        steps: [{ agent: 'sre', prompt: 'SECRET-STEP-PROMPT', approve: true }],
        sampleInput: 'SECRET-SAMPLE',
      },
    ],
    skillRoots: { claude: '/Users/me/SECRET-ROOT' },
    skills: [{ name: 'sk', description: 'ds', claude: 'installed', agents: 'missing', path: '/skills/sk/SKILL.md' }],
    defaults: { model: 'm', plannerModel: 'p', codeModel: 'c', hidden: 'SECRET-DEF' },
    settings: { tokenSaver: true, modelMap: [], guardrails: { scope: 'external' }, other: 'SECRET-SET' },
    knowledge: [{ id: 'kb', name: 'KB', documents: 2, path: '/Users/me/SECRET-KB' }],
    routes: [{ name: 'router/fast', targets: ['a/b'], apiKey: 'SECRET-ROUTE' }],
    sessions: [{ id: 'ses_1', title: 'SECRET-TITLE-6', messages: 2 }],
    memory: [{ id: 'mem_1', text: 'SECRET-NOTE-7', scope: 'global', tags: ['SECRET-TAG'] }],
    runs: [
      {
        id: 'run_1',
        title: 'SECRET-TASK-8',
        error: 'SECRET-ERROR-9',
        stop: 'SECRET-STOP',
        pending: { step: 2, question: 'SECRET-Q-10' },
      },
      { id: 'run_2', title: 'x', pending: null, state: 'done' },
    ],
    quota: [{ id: 'openai', token: 'SECRET-QUOTA-11' }],
    usage: { month: '2026-11' },
    somethingNew: 'SECRET-NEW-12',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactGateway(g, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.deepEqual(r.providers, [
      {
        id: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-5'],
        enabled: true,
        tier: 'external',
        auth: { type: 'oauth2' },
      },
      { id: 'local', auth: { type: 'key' } },
    ]);
    assert.deepEqual(Object.keys(r.keys[0]), [
      'id',
      'name',
      'prefix',
      'scopes',
      'budgetUSD',
      'createdAt',
      'expiresAt',
      'lastUsedAt',
      'revokedAt',
    ]);
    assert.deepEqual(Object.keys(r.agents[0]), [
      'id',
      'name',
      'domain',
      'description',
      'keywords',
      'tools',
      'model',
      'enabled',
      'template',
      'knowledge',
      'collaborate',
    ]);
    assert.deepEqual(r.workflows, [
      { id: 'wf', name: 'W', category: 'Custom', tier: 'R1', builtin: true, steps: [{ agent: 'sre', approve: true }] },
    ]);
    assert.ok(!('skillRoots' in r));
    assert.deepEqual(r.skills, [{ name: 'sk', description: 'ds', claude: 'installed', agents: 'missing' }]);
    assert.deepEqual(r.defaults, { model: 'm', plannerModel: 'p', codeModel: 'c' });
    assert.deepEqual(r.settings, { tokenSaver: true, modelMap: [], guardrails: { scope: 'external' } });
    assert.deepEqual(r.knowledge, [{ id: 'kb', name: 'KB', documents: 2 }]);
    assert.deepEqual(r.routes, [{ name: 'router/fast', targets: ['a/b'] }]);
    assert.deepEqual(r.sessions, [{ id: 'ses_1', messages: 2 }]);
    assert.deepEqual(r.memory, [{ id: 'mem_1', scope: 'global' }]);
    assert.deepEqual(r.runs, [
      { id: 'run_1', pending: { step: 2 } },
      { id: 'run_2', state: 'done', pending: null },
    ]);
    assert.deepEqual(r.quota, []);
    assert.deepEqual(r.usage, { month: '2026-11' });
    assert.ok(Object.keys(r).every((k) => GATEWAY_PARTS.includes(k)));
  }
  assert.equal(redactGateway(g, 'owner'), g, 'the owner sees it all');
  assert.equal(redactGateway(null, 'viewer'), null);
});

test('the trace session list for a non-owner: no title (the first prompt)', () => {
  const body = {
    sessions: [
      { key: 'claude.ab', title: 'SECRET-PROMPT-1', branch: 'SECRET-BRANCH', tokens: 9 },
      { key: 'codex.cd', title: null },
    ],
  };
  for (const role of ['viewer', 'reviewer'])
    assert.deepEqual(redactTraceSessions(body, role), {
      sessions: [{ key: 'claude.ab', tokens: 9 }, { key: 'codex.cd' }],
    });
  assert.equal(redactTraceSessions(body, 'owner'), body);
  assert.equal(redactTraceSessions(null, 'viewer'), null);
});

test("/api/openrouter: only the listed sections are viewer reads; account, a missing or odd section is the owner's", () => {
  assert.deepEqual(OPENROUTER_SECTIONS, ['models', 'providers', 'rankings']);
  const sec = (role, section) => allowed({ role, method: 'GET', path: '/api/openrouter', section });
  for (const role of ['viewer', 'reviewer']) {
    for (const s of OPENROUTER_SECTIONS) assert.equal(sec(role, s).ok, true, s);
    for (const s of ['account', 'Account', ' account ', 'usage', '', undefined, null, ['models'], { a: 1 }, 5])
      assert.deepEqual(sec(role, s), { ok: false, reason: 'your role cannot do this' }, JSON.stringify(s));
    assert.equal(allowed({ role, method: 'GET', path: '/api/summary', section: 'account' }).ok, true);
  }
  assert.equal(sec('owner', 'account').ok, true);
  assert.equal(sec('owner', undefined).ok, true);
});

test('the trace session list: a title search (q) is refused for a non-owner, the plain list is not', () => {
  const q = (role, v) => allowed({ role, method: 'GET', path: '/api/trace/sessions', q: v });
  for (const role of ['viewer', 'reviewer']) {
    for (const v of [undefined, null, '']) assert.equal(q(role, v).ok, true, JSON.stringify(v));
    for (const v of ['a', ' ', 'secret title', ['a'], { x: 1 }, 0])
      assert.deepEqual(q(role, v), { ok: false, reason: 'your role cannot do this' }, JSON.stringify(v));
  }
  assert.equal(q('owner', 'secret title').ok, true);
  assert.equal(allowed({ role: 'viewer', method: 'GET', path: '/api/summary', q: 'x' }).ok, true);
});

test('a path that is not canonical is refused for a non-owner; the owner is not asked', () => {
  const bad = [
    'http://localhost/api/summary',
    'https://x/api/summary',
    'api/summary',
    '/API/summary',
    '/Api/summary',
    '/api/summary/',
    '/api//summary',
    '//api/summary',
    '/api/summary?x=1',
    '/api/summary#x',
    '/api/summary ',
    ' /api/summary',
    '/api/gateway/collab get',
    '/api/summary\n',
    '/api\\summary',
    '/API',
    '',
    undefined,
    null,
    5,
    ['/api/summary'],
  ];
  for (const p of bad) {
    for (const role of ['viewer', 'reviewer'])
      assert.deepEqual(
        allowed({ role, method: 'GET', path: p }),
        { ok: false, reason: 'your role cannot do this' },
        `${role} ${JSON.stringify(p)}`,
      );
    assert.equal(allowed({ role: 'owner', method: 'GET', path: p }).ok, true);
  }
});

const SECRETS = /SECRET|\/Users\/|\/home\//;

test('the summary for a non-owner: counts, costs and names stay; no quality text, no path, no branch', () => {
  const ev = (o) => ({ ts: 5, sid: 'SECRET-SID', project: 'SECRET-PROJ', text: 'SECRET-TEXT /Users/me/x', ...o });
  const row = {
    id: 's1',
    tool: 'claude',
    project: 'app',
    projectPath: '/Users/me/app',
    branch: 'SECRET-BRANCH',
    entrypoint: 'cli',
    start: 1,
    end: 2,
    prompts: 3,
    calls: 4,
    subCalls: 0,
    tokens: 100,
    output: 10,
    cost: 1.5,
    model: 'claude-sonnet-5',
    models: ['claude-sonnet-5'],
    subagents: 0,
  };
  const s = {
    generatedAt: 1,
    range: { days: 30 },
    kpis: { cost: 9, tokens: 5 },
    month: { daily: [] },
    entrypoints: [{ name: 'cli', count: 1 }],
    topCostSessions: [row],
    daily: [],
    heatmap: [],
    tools: [{ id: 'claude', name: 'Claude Code', cost: 1 }],
    models: [{ model: 'claude-sonnet-5', tokens: 100 }],
    projects: [
      {
        path: '/Users/me/app',
        name: 'app',
        sessions: 1,
        calls: 4,
        tokens: 100,
        output: 10,
        cost: 1.5,
        tools: { claude: 1 },
        last: 2,
      },
    ],
    sessions: [row],
    totalSessions: 1,
    toolUse: [{ name: 'Bash', count: 3 }],
    skills: [],
    subagents: [],
    unpriced: [],
    estimated: [],
    quality: {
      accuracy: 0.9,
      calls: 4,
      somethingNew: 'SECRET-Q',
      tools: [{ tool: 'Bash', calls: 9 }],
      events: {
        correction: [ev({ kind: 'correction', label: 'Correction prompt' })],
        risky: [ev({ kind: 'risky', label: 'rm -rf rule', source: 'Bash', tool: 'claude' })],
        error: [ev({ kind: 'error', category: 'model', label: 'bad args', source: 'Bash' })],
      },
      feed: [ev({ kind: 'error', category: 'hallucination', label: 'x' })],
    },
    codexLimits: null,
    config: { userName: 'Ann', monthlyBudgetUSD: 50, host: 'mac', vaultPaths: ['/Users/me/SECRET-VAULT'] },
    index: { indexing: false, total: 3, done: 3, lastScan: 1, lastDurationMs: 5, errors: 0, workers: 0 },
    somethingNew: 'SECRET-NEW',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactSummary(s, role);
    assert.ok(!SECRETS.test(JSON.stringify(r)), JSON.stringify(r));
    assert.equal(r.kpis.cost, 9);
    assert.equal(r.quality.accuracy, 0.9);
    assert.deepEqual(r.quality.events.risky, [
      { ts: 5, kind: 'risky', label: 'rm -rf rule', source: 'Bash', tool: 'claude' },
    ]);
    assert.equal(r.quality.feed.length, 1);
    assert.deepEqual(r.projects, [
      { name: 'app', sessions: 1, calls: 4, tokens: 100, output: 10, cost: 1.5, tools: { claude: 1 }, last: 2 },
    ]);
    assert.equal(r.sessions[0].project, 'app');
    assert.equal(r.sessions[0].model, 'claude-sonnet-5');
    assert.equal(r.tools[0].name, 'Claude Code');
    assert.deepEqual(r.config, { userName: 'Ann', monthlyBudgetUSD: 50, host: 'mac' });
    assert.equal(r.index.total, 3);
    assert.ok(!('somethingNew' in r));
    assert.ok(!('somethingNew' in r.quality));
  }
  assert.equal(redactSummary(s, 'owner'), s);
  assert.equal(redactSummary(null, 'viewer'), null);
});

test('the request log for a non-owner: types, sizes, counts and times; no error text, no tool target', () => {
  const l = {
    ts: 9,
    windowMs: 1000,
    requests: [
      {
        id: 'a:1',
        ts: 1,
        source: 'claude',
        agentId: 'a',
        kind: 'cli',
        model: 'claude-sonnet-5',
        input: 5,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        ttftMs: 100,
        durationMs: 900,
        stop: 'end_turn',
        status: 'tool error',
        agent: 'app',
        toolErrors: 1,
        inputs: [
          { type: 'tool_result', tool: 'Bash', ok: false, size: 40, text: 'SECRET-OUT' },
          { type: 'prompt', size: 12 },
        ],
        blocks: [
          { ts: 1, type: 'tool_use', id: 't1', tool: 'Bash', target: 'cat /Users/me/SECRET-FILE', zone: 'shell' },
          { ts: 1, type: 'text', size: 80 },
        ],
      },
    ],
    errors: [
      {
        ts: 2,
        kind: 'tool',
        agent: 'app',
        source: 'Bash',
        label: 'Exit code',
        category: 'environment',
        text: 'SECRET-ERR /home/x',
      },
      {
        ts: 3,
        kind: 'interrupt',
        agent: 'app',
        source: 'You',
        label: 'Interrupted',
        text: 'You stopped the model mid-turn',
      },
    ],
    somethingNew: 'SECRET-NEW',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactLogs(l, role);
    assert.ok(!SECRETS.test(JSON.stringify(r)), JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('stopped the model'));
    assert.equal(r.requests[0].model, 'claude-sonnet-5');
    assert.equal(r.requests[0].status, 'tool error');
    assert.deepEqual(r.requests[0].inputs, [
      { type: 'tool_result', tool: 'Bash', ok: false, size: 40 },
      { type: 'prompt', size: 12 },
    ]);
    assert.deepEqual(r.requests[0].blocks, [
      { ts: 1, type: 'tool_use', id: 't1', tool: 'Bash', zone: 'shell' },
      { ts: 1, type: 'text', size: 80 },
    ]);
    assert.deepEqual(r.errors[0], {
      ts: 2,
      kind: 'tool',
      agent: 'app',
      source: 'Bash',
      label: 'Exit code',
      category: 'environment',
    });
    assert.equal(r.ts, 9);
  }
  assert.equal(redactLogs(l, 'owner'), l);
  assert.equal(redactLogs(null, 'viewer'), null);
});

test('the gateway request log for a non-owner: no error text, no run or session id; the guard keeps action and checks', () => {
  const body = {
    entries: [
      {
        ts: 1,
        keyId: 'key_1',
        provider: 'openai',
        model: 'gpt-5',
        status: 599,
        ms: 90,
        input: 5,
        output: 6,
        cost: 0.1,
        kind: 'chat',
        error: 'SECRET-UPSTREAM-ERROR /Users/me',
        sessionId: 'SECRET-SES',
        runId: 'SECRET-RUN',
        // The shape of lib/gateway/guardrails.js: a hit is { check, label, count } with a fixed label.
        guard: {
          action: 'redacted',
          hits: [
            { check: 'secrets', label: 'API key', count: 2, value: 'SECRET-VALUE' },
            { check: 'pii', label: 'Email', count: 1 },
            'SECRET-STRING',
          ],
          error: true,
          text: 'SECRET-GUARD',
        },
        somethingNew: 'SECRET-NEW',
      },
    ],
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactGatewayLogs(body, role);
    assert.ok(!/SECRET|\/Users\//.test(JSON.stringify(r)), JSON.stringify(r));
    assert.equal(r.entries[0].model, 'gpt-5');
    assert.equal(r.entries[0].status, 599);
    assert.equal(r.entries[0].guard.action, 'redacted');
    assert.deepEqual(r.entries[0].guard.hits, [
      { check: 'secrets', label: 'API key', count: 2 },
      { check: 'pii', label: 'Email', count: 1 },
    ]);
  }
  assert.equal(redactGatewayLogs(body, 'owner'), body);
  assert.equal(redactGatewayLogs(null, 'viewer'), null);
});

test('the config for a non-owner: user name, budget and pricing stay; no vault path, nothing unlisted', () => {
  const c = {
    userName: 'Ann',
    monthlyBudgetUSD: 50,
    pricing: { m: { input: 1 } },
    vaultPaths: ['/Users/me/SECRET-VAULT'],
    somethingNew: 'SECRET-NEW',
  };
  for (const role of ['viewer', 'reviewer'])
    assert.deepEqual(redactConfig(c, role), { userName: 'Ann', monthlyBudgetUSD: 50, pricing: { m: { input: 1 } } });
  assert.equal(redactConfig(c, 'owner'), c);
  assert.equal(redactConfig(null, 'viewer'), null);
});

test('the office for a non-owner: states, zones, tools and counts stay; no branch, no target, nothing unlisted', () => {
  // The shape of lib/office.js snapshot(): agents with their activity and feed, and the floor's feed.
  const agent = {
    id: 'claude:abc',
    kind: 'session',
    parent: null,
    project: 'shop',
    branch: 'SECRET-BRANCH',
    model: 'claude-x',
    agentType: '',
    lastTs: 2,
    startTs: 1,
    tool: 'claude',
    state: 'working',
    activity: { tool: 'Edit', target: 'SECRET-FILE.md' },
    zone: 'code',
    calls10m: 3,
    zones10m: { code: 3 },
    feed: [{ ts: 2, tool: 'Bash', target: 'SECRET-CMD', zone: 'terminal', extra: 'SECRET-NEW' }],
    somethingNew: 'SECRET-NEW',
  };
  const body = {
    ts: 9,
    agents: [agent, { ...agent, id: 'claude:abc:a1', kind: 'subagent', activity: null }],
    feed: [{ ts: 2, tool: 'WebFetch', target: 'SECRET-HOST', zone: 'web', agent: 'claude:abc' }],
    perMinute: [0, 1],
    somethingNew: 'SECRET-NEW',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactOffice(body, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.deepEqual(r.agents[0].activity, { tool: 'Edit', target: '' });
    assert.equal(r.agents[1].activity, null);
    assert.deepEqual(r.agents[0].feed, [{ ts: 2, tool: 'Bash', target: '', zone: 'terminal' }]);
    assert.deepEqual(r.feed, [{ ts: 2, tool: 'WebFetch', target: '', zone: 'web', agent: 'claude:abc' }]);
    assert.deepEqual(
      [r.ts, r.perMinute, r.agents[0].state, r.agents[0].zone, r.agents[0].project, r.agents[0].calls10m],
      [9, [0, 1], 'working', 'code', 'shop', 3],
    );
    assert.ok(!('branch' in r.agents[0]));
  }
  assert.equal(redactOffice(body, 'owner'), body);
  assert.equal(redactOffice(null, 'viewer'), null);
});

test('the timeline for a non-owner: lanes, times, zones and tools stay; every segment target is blank', () => {
  // The shape of lib/timeline.js: a tool segment is [from, to, 'tool', zone, tool, target, ok].
  const body = {
    ts: 9,
    start: 1,
    hours: 6,
    lanes: [
      {
        id: 'claude:abc',
        tool: 'claude',
        kind: 'session',
        parent: null,
        agentType: '',
        project: 'shop',
        model: 'claude-x',
        first: 1,
        last: 5,
        segments: [
          [1, 2, 'think'],
          [2, 3, 'tool', 'code', 'Edit', 'SECRET-FILE.md', 1],
          [3, 4, 'wait'],
        ],
        marks: [[4, 'error', 'Edit failed']],
        somethingNew: 'SECRET-NEW',
      },
    ],
    somethingNew: 'SECRET-NEW',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactTimeline(body, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.deepEqual(r.lanes[0].segments, [
      [1, 2, 'think'],
      [2, 3, 'tool', 'code', 'Edit', '', 1],
      [3, 4, 'wait'],
    ]);
    assert.deepEqual(r.lanes[0].marks, [[4, 'error', 'Edit failed']]);
    assert.deepEqual([r.ts, r.start, r.hours, r.lanes[0].project, r.lanes[0].first], [9, 1, 6, 'shop', 1]);
  }
  assert.equal(redactTimeline(body, 'owner'), body);
  assert.equal(redactTimeline(null, 'viewer'), null);
});

test('the local model entries for a non-owner: no command, no health URL, in every mode', () => {
  const body = {
    off: null,
    entries: [
      {
        id: 'qwen',
        name: 'Qwen',
        command: ['~/bin/SECRET-SERVER', '-m', '~/SECRET-MODEL.gguf'],
        port: 18082,
        health: 'http://127.0.0.1:18082/health?tok=SECRET',
        healthUsed: 'http://127.0.0.1:18082/health?tok=SECRET',
        approved: true,
        error: null,
      },
    ],
    demo: false,
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactRuntimesConfig(body, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.deepEqual(r.entries[0], {
      id: 'qwen',
      name: 'Qwen',
      command: null,
      port: 18082,
      health: null,
      healthUsed: null,
      approved: true,
      error: null,
    });
    assert.deepEqual([r.off, r.demo], [null, false]);
  }
  assert.equal(redactRuntimesConfig(body, 'owner'), body);
  assert.equal(redactRuntimesConfig(null, 'viewer'), null);
});

test('the integrations for a non-owner: states and counts stay; no MCP command line, no error text', () => {
  const body = {
    integrations: [
      {
        id: 'dt',
        type: 'dynatrace',
        enabled: true,
        allowWrite: false,
        tools: 4,
        writeTools: 0,
        state: 'ok',
        latencyMs: 9,
      },
      {
        id: 'n8n',
        type: 'n8n',
        enabled: true,
        allowWrite: true,
        tools: 0,
        writeTools: 0,
        state: 'error',
        latencyMs: 3,
        error: 'SECRET-ERROR https://n8n.internal/SECRET',
        somethingNew: 'SECRET-NEW',
      },
    ],
    clients: [{ id: 'claude', name: 'Claude Code', file: '~/.claude.json', registered: true, detected: true }],
    calls: [{ ts: 1, integration: 'dt', tool: 'query', args: ['q'], ok: true, ms: 5 }],
    mcpCommand: '/Users/me/SECRET/node /Users/me/SECRET/mcp.js',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactIntegrations(body, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.ok(!('mcpCommand' in r));
    assert.deepEqual(
      r.integrations.map((i) => [i.id, i.state, i.tools, 'error' in i]),
      [
        ['dt', 'ok', 4, false],
        ['n8n', 'error', 0, false],
      ],
    );
    assert.deepEqual([r.clients, r.calls], [body.clients, body.calls]);
  }
  assert.equal(redactIntegrations(body, 'owner'), body);
  assert.equal(redactIntegrations(null, 'viewer'), null);
});

test("the router's proxy log for a non-owner: status, provider and timings stay; no target URL, no error text", () => {
  const row = {
    id: 'p1',
    ts: 1,
    status: 'error',
    level: 'direct',
    proxy: 'configured',
    provider: 'openai',
    target: 'https://SECRET-HOST/v1?key=SECRET',
    latencyMs: 30,
    upstreamStatus: 502,
    attempt: 1,
    error: 'SECRET-ERROR',
    account: 'ab12',
    tls: false,
    somethingNew: 'SECRET-NEW',
  };
  const body = { configured: true, id: 'omniroute', data: [row] };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactRouterProxy(body, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.deepEqual(
      [r.configured, r.id, r.data[0].provider, r.data[0].status, r.data[0].latencyMs],
      [true, 'omniroute', 'openai', 'error', 30],
    );
    const failed = redactRouterProxy({ configured: true, id: 'omniroute', data: { error: 'SECRET-HOST down' } }, role);
    assert.deepEqual(failed, { configured: true, id: 'omniroute', data: { error: 'the router could not be read' } });
    assert.deepEqual(redactRouterProxy({ configured: false }, role), { configured: false });
  }
  assert.equal(redactRouterProxy(body, 'owner'), body);
  assert.equal(redactRouterProxy(null, 'viewer'), null);
});

test('the inventory for a non-owner: items, names and counts stay; no project folder, no client file', () => {
  const body = {
    generatedAt: '2026-11-07T00:00:00.000Z',
    items: [
      {
        id: 'mcp:github',
        kind: 'mcp',
        name: 'github',
        vendor: null,
        where: ['Claude Code config'],
        state: 'configured',
        transport: 'stdio',
        command: 'npx',
        clients: ['Claude Code'],
        projects: ['~/work/SECRET-PROJECT'],
        firstSeen: '2026-11-01',
        lastSeen: '2026-11-07',
        review: { owner: 'Ann', risk: 'limited' },
        status: 'reviewed',
        somethingNew: 'SECRET-NEW',
      },
    ],
    counts: { total: 1 },
    failed: [],
    clients: [{ client: 'claude', name: 'Claude Code', file: '~/SECRET/.claude.json', state: 'ok', servers: 1 }],
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactInventory(body, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.deepEqual(r.clients, [{ client: 'claude', name: 'Claude Code', state: 'ok', servers: 1 }]);
    const { projects, somethingNew, ...kept } = body.items[0];
    assert.deepEqual(r.items, [kept]);
    assert.deepEqual([r.generatedAt, r.counts, r.failed], [body.generatedAt, body.counts, body.failed]);
  }
  assert.equal(redactInventory(body, 'owner'), body);
  assert.equal(redactInventory(null, 'viewer'), null);
});
