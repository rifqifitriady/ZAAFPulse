// Dashboard roles (AI Governance 4): what a signed-in person who is not the owner may do. Pure: no I/O. Deny by default:
// every /api request of a reviewer or a viewer is checked against the explicit lists below, by method and path and, for
// a gateway admin route, the body's action. Anything not listed is refused. The owner is never restricted.
//   owner     everything
//   reviewer  what a viewer may, plus inventory reviews and collaboration run approvals
//   viewer    read-only, metadata only: no trace or dataset content, no secret, no setting
const ROLES = ['owner', 'reviewer', 'viewer'];
const DENIED = 'your role cannot do this';
const MUST_CHANGE = 'change your password first';

// GET routes that show metadata: counts, costs, statuses, settings and lists, never a transcript, a prompt, a note, a
// dataset's examples or a secret. Not /api/evals (the results, with the judge's explanations of a session) and the
// trace session list only without its titles (redactTraceSessions).
const VIEWER_READS = [
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
  '/api/trace/sessions', // without titles (redactTraceSessions)
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
  '/api/gateway', // the redacted view (redactGateway)
  '/api/gateway/logs',
];
// A reviewer's extra routes: "METHOD path", or "METHOD path action" for a gateway admin route.
const REVIEWER_EXTRA = [
  'POST /api/governance/inventory',
  'GET /api/users/names',
  'POST /api/gateway/collab get',
  'POST /api/gateway/collab list',
  'POST /api/gateway/collab resume',
];
// Any signed-in person, also one who must change their password first.
const ANYONE = ['POST /api/account/password'];

const viewerReads = new Set(VIEWER_READS);
const reviewerExtra = new Set(REVIEWER_EXTRA);
const anyone = new Set(ANYONE);
const GATEWAY_ADMIN = /^\/api\/gateway\/[a-z]+$/;
const WORD = /^[a-z][a-z0-9_-]{0,31}$/;

// The sections of /api/openrouter a viewer may read: the public model catalog. Its account section (the owner's key and
// balance) and a missing or unknown section are the owner's.
const OPENROUTER_SECTIONS = ['models', 'providers', 'rankings'];
// A path that is /api/ and nothing else odd: no space or control character, "?", "#", backslash or "//" inside.
const ODD_PATH = /[\s\\?#\u0000-\u001f\u007f]|\/\//;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// allowed({ role, method, path, action, mustChange, section, q }) -> { ok, reason }: reason is the 403 message when ok
// is false. `path` is the request path as parsed (no query). `section` is the query's section (read for /api/openrouter)
// and `q` its title search (read for /api/trace/sessions): the owner's account section and a title search are not for
// anyone else. A path that is not in canonical form is refused (fail closed): an absolute URL, another case, a space.
function allowed({ role, method, path, action = null, mustChange = false, section = null, q = null } = {}) {
  const yes = { ok: true, reason: null };
  const no = (reason) => ({ ok: false, reason });
  if (role === 'owner') return yes;
  if (typeof path !== 'string' || !path.startsWith('/') || SCHEME.test(path)) return no(DENIED);
  const p = path;
  if (/^\/api(\/|$)/i.test(p) && p !== '/api' && !p.startsWith('/api/')) return no(DENIED);
  if (ODD_PATH.test(p)) return no(DENIED);
  if (!p.startsWith('/api/')) return yes; // the page and its files; /api is what holds data
  const m = String(method || '').toUpperCase();
  if (anyone.has(`${m} ${p}`)) return ROLES.includes(role) ? yes : no(DENIED);
  if (!ROLES.includes(role)) return no(DENIED);
  if (mustChange) return no(MUST_CHANGE);
  if (p === '/api/openrouter' && !OPENROUTER_SECTIONS.includes(section)) return no(DENIED);
  if (p === '/api/trace/sessions' && q !== null && q !== undefined && q !== '') return no(DENIED);
  if (m === 'GET' && viewerReads.has(p)) return yes;
  if (role === 'reviewer') {
    if (reviewerExtra.has(`${m} ${p}`)) return yes;
    if (m === 'POST' && GATEWAY_ADMIN.test(p) && typeof action === 'string' && WORD.test(action))
      if (reviewerExtra.has(`${m} ${p} ${action}`)) return yes;
  }
  return no(DENIED);
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
// What GET /api/gateway keeps for a non-owner: these parts, each item redacted below. A part added later stays out
// until it is listed here.
const GATEWAY_PARTS = [
  'presets',
  'providers',
  'defaults',
  'keys',
  'agents',
  'sessions',
  'memory',
  'usage',
  'spend',
  'builtinTools',
  'routes',
  'knowledge',
  'workflows',
  'workflowCatalog',
  'patterns',
  'effort',
  'runs',
  'skills',
  'quota',
  'tools',
  'baseUrl',
  'settings',
];
const KEY_FIELDS = ['id', 'name', 'prefix', 'scopes', 'budgetUSD', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt'];

const AGENT_FIELDS = [
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
];
const WORKFLOW_FIELDS = [
  'id',
  'name',
  'description',
  'category',
  'tier',
  'kpi',
  'builtin',
  'status',
  'catalogVersion',
  'edited',
];
const PROVIDER_FIELDS = [
  'id',
  'preset',
  'baseUrl',
  'models',
  'aliases',
  'enabled',
  'tier',
  'tierAuto',
  'approved',
  'format',
];
const SESSION_META = ['id', 'keyId', 'agent', 'createdAt', 'lastActive', 'messages', 'expiresAt'];
const MEMORY_META = ['id', 'scope', 'source', 'createdAt', 'updatedAt'];
const RUN_FIELDS = [
  'id',
  'pattern',
  'effort',
  'state',
  'keyId',
  'contextId',
  'createdAt',
  'updatedAt',
  'agents',
  'steps',
  'spent',
  'budget',
  'needsReview',
];
const KNOWLEDGE_FIELDS = [
  'id',
  'name',
  'description',
  'embedModel',
  'documents',
  'chunks',
  'chars',
  'embedded',
  'updatedAt',
  'createdAt',
];
const SKILL_FIELDS = ['name', 'description', 'claude', 'agents'];
const TOOL_FIELDS = ['id', 'name', 'vendor', 'format', 'unsupported', 'note', 'canApply'];
const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);

// redactGateway(payload, role) -> GET /api/gateway as a reviewer or a viewer sees it. Every part has its own allow-list
// of fields (a field added later stays out until listed): agents without their system prompt or remote address and
// token name, workflows without their step prompts, notes without text, sessions and runs without title, task, error or
// approval question, keys with name, prefix, scopes, budget and dates, providers without a secret reference (and only
// their sign-in type), settings without anything unlisted, no skill folders, no quota read. The owner gets the payload.
function redactGateway(g, role) {
  if (role === 'owner' || !isObj(g)) return g;
  const out = pick(g, GATEWAY_PARTS);
  const parts = {
    agents: (a) => list(a).map((x) => pick(x, AGENT_FIELDS)),
    workflows: (a) =>
      list(a).map((w) => ({
        ...pick(w, WORKFLOW_FIELDS),
        steps: list(w.steps).map((st) => pick(st, ['agent', 'approve'])),
      })),
    workflowCatalog: (a) => list(a).map((x) => pick(x, ['id', 'name', 'category', 'status', 'installed'])),
    memory: (a) => list(a).map((x) => pick(x, MEMORY_META)),
    sessions: (a) => list(a).map((x) => pick(x, SESSION_META)),
    runs: (a) =>
      list(a).map((r) => ({
        ...pick(r, RUN_FIELDS),
        pending: isObj(r.pending) && Number.isInteger(r.pending.step) ? { step: r.pending.step } : null,
      })),
    keys: (a) => list(a).map((k) => pick(k, KEY_FIELDS)),
    providers: (a) =>
      list(a).map((x) => ({
        ...pick(x, PROVIDER_FIELDS),
        auth: { type: (isObj(x.auth) && typeof x.auth.type === 'string' && x.auth.type) || 'key' },
      })),
    defaults: (d) => (isObj(d) ? pick(d, ['model', 'plannerModel', 'codeModel']) : {}),
    usage: (u) => (isObj(u) ? pick(u, ['month', 'totals', 'byKey', 'byModel', 'byFormat']) : {}),
    routes: (a) =>
      list(a).map((x) => ({
        ...pick(x, ['name', 'strategy', 'privateOnly']),
        ...(Array.isArray(x.targets) ? { targets: strings(x.targets) } : {}),
      })),
    knowledge: (a) => list(a).map((x) => pick(x, KNOWLEDGE_FIELDS)),
    skills: (a) => list(a).map((x) => pick(x, SKILL_FIELDS)),
    tools: (a) => list(a).map((x) => pick(x, TOOL_FIELDS)),
    builtinTools: strings,
    settings: (x) => (isObj(x) ? pick(x, ['tokenSaver', 'modelMap', 'guardrails']) : {}),
    quota: () => [],
  };
  for (const k of Object.keys(out)) {
    if (k === 'skillRoots') delete out[k];
    else if (Object.hasOwn(parts, k)) out[k] = parts[k](out[k]);
  }
  return out;
}

// redactTraceSessions(body, role) -> GET /api/trace/sessions as a reviewer or a viewer sees it: each session without its
// title (the first prompt) and its git branch. The owner gets the body as it is.
function redactTraceSessions(body, role) {
  if (role === 'owner' || !isObj(body) || !Array.isArray(body.sessions)) return body;
  return { ...body, sessions: list(body.sessions).map(({ title, branch, ...x }) => x) };
}

const SUMMARY_PARTS = [
  'generatedAt',
  'range',
  'kpis',
  'month',
  'entrypoints',
  'daily',
  'heatmap',
  'tools',
  'models',
  'totalSessions',
  'toolUse',
  'skills',
  'subagents',
  'unpriced',
  'estimated',
  'codexLimits',
  'index',
];
const SESSION_FIELDS = [
  'id',
  'tool',
  'project',
  'entrypoint',
  'start',
  'end',
  'prompts',
  'calls',
  'subCalls',
  'tokens',
  'output',
  'cost',
  'model',
  'models',
  'subagents',
];
const PROJECT_FIELDS = ['name', 'sessions', 'calls', 'tokens', 'output', 'cost', 'tools', 'last'];
// Quality parts that are counts, scores, rates, labels of categories and names of tools (no event, no text).
const QUALITY_PARTS = [
  'accuracy',
  'prevAccuracy',
  'prevResults',
  'relevance',
  'faithfulness',
  'calls',
  'results',
  'failures',
  'modelFailures',
  'categories',
  'kinds',
  'hallucinations',
  'prevHallucinations',
  'hallucinationRate',
  'injection',
  'corrections',
  'safety',
  'reliability',
  'daily',
  'tools',
];
const EVENT_FIELDS = ['ts', 'kind', 'category', 'label', 'source', 'tool'];

// redactSummary(payload, role) -> GET /api/summary as a reviewer or a viewer sees it: counts, costs, model and tool
// names stay; the quality events lose their text (typed corrections, risky commands, error snippets) and their session
// id, and no project or session carries a path or a branch. Allow-list: a field added later stays out until listed.
// The owner gets the payload as it is.
function redactSummary(s, role) {
  if (role === 'owner' || !isObj(s)) return s;
  const out = pick(s, SUMMARY_PARTS);
  const session = (x) => pick(x, SESSION_FIELDS);
  const event = (x) => pick(x, EVENT_FIELDS);
  if (isObj(s.config)) out.config = pick(s.config, ['userName', 'monthlyBudgetUSD', 'host']);
  out.projects = list(s.projects).map((x) => pick(x, PROJECT_FIELDS));
  out.sessions = list(s.sessions).map(session);
  out.topCostSessions = list(s.topCostSessions).map(session);
  if (isObj(s.quality)) {
    const ev = isObj(s.quality.events) ? s.quality.events : {};
    out.quality = {
      ...pick(s.quality, QUALITY_PARTS),
      events: Object.fromEntries(Object.entries(ev).map(([k, a]) => [k, list(a).map(event)])),
      feed: list(s.quality.feed).map(event),
    };
  }
  return out;
}

const REQUEST_FIELDS = [
  'id',
  'ts',
  'source',
  'agentId',
  'kind',
  'model',
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'ttftMs',
  'durationMs',
  'stop',
  'status',
  'agent',
  'toolErrors',
];
const LOG_ERROR_FIELDS = ['ts', 'kind', 'agent', 'tool', 'source', 'label', 'category'];

// redactLogs(payload, role) -> GET /api/logs as a reviewer or a viewer sees it: requests keep their model, tokens,
// timings and status, their inputs by type, tool and size, and their blocks by type, tool and size, but not a tool's
// target (a path or a command); errors keep type, label and time, never the text. The owner gets the payload as is.
function redactLogs(l, role) {
  if (role === 'owner' || !isObj(l)) return l;
  const out = pick(l, ['ts', 'windowMs']);
  out.requests = list(l.requests).map((r) => ({
    ...pick(r, REQUEST_FIELDS),
    inputs: list(r.inputs).map((i) => pick(i, ['type', 'tool', 'ok', 'size'])),
    blocks: list(r.blocks).map((b) => pick(b, ['ts', 'type', 'id', 'tool', 'zone', 'size'])),
  }));
  out.errors = list(l.errors).map((e) => pick(e, LOG_ERROR_FIELDS));
  return out;
}

// redactGatewayLogs(body, role) -> GET /api/gateway/logs as a reviewer or a viewer sees it: each entry keeps its model,
// provider, status, tokens, cost and timings and the guard's action and checks, never the error text or an id of a run
// or session. The owner gets the body as it is.
const LOG_ENTRY = [
  'ts',
  'keyId',
  'provider',
  'model',
  'routedTo',
  'agent',
  'kind',
  'format',
  'stream',
  'status',
  'ms',
  'ttftMs',
  'input',
  'output',
  'cached',
  'cost',
  'savedTokens',
];
function redactGatewayLogs(body, role) {
  if (role === 'owner' || !isObj(body)) return body;
  return {
    entries: list(body.entries).map((e) => ({
      ...pick(e, LOG_ENTRY),
      ...(isObj(e.guard)
        ? { guard: { action: e.guard.action, hits: Array.isArray(e.guard.hits) ? strings(e.guard.hits) : [] } }
        : {}),
    })),
  };
}

// redactConfig(config, role) -> GET /api/config as a reviewer or a viewer sees it: the name, the monthly budget and the
// pricing; not the vault folders or anything else. The owner gets the config as it is.
function redactConfig(c, role) {
  if (role === 'owner' || !isObj(c)) return c;
  return pick(c, ['userName', 'monthlyBudgetUSD', 'pricing']);
}

const OFFICE_AGENT = [
  'id',
  'kind',
  'parent',
  'project',
  'model',
  'agentType',
  'lastTs',
  'startTs',
  'tool',
  'state',
  'zone',
  'calls10m',
  'zones10m',
];
// A tool call as the office and the timeline show it to a non-owner: the tool and its zone, never its target (a file
// name, a command or a host).
const call = (e, extra = []) => ({ ...pick(e, ['ts', 'tool', 'zone', ...extra]), target: '' });

// redactOffice(payload, role) -> GET /api/office as a reviewer or a viewer sees it: each agent's state, zone, tool,
// project name, model and counts, its activity and feed by tool only (no target), no git branch. Allow-lists: a field
// added later stays out until listed. The owner gets the payload as it is.
function redactOffice(o, role) {
  if (role === 'owner' || !isObj(o)) return o;
  const out = pick(o, ['ts', 'perMinute']);
  out.agents = list(o.agents).map((a) => ({
    ...pick(a, OFFICE_AGENT),
    activity: isObj(a.activity) ? call(a.activity) : null,
    feed: list(a.feed).map((e) => call(e)),
  }));
  out.feed = list(o.feed).map((e) => call(e, ['agent']));
  return out;
}

const LANE_FIELDS = ['id', 'tool', 'kind', 'parent', 'agentType', 'project', 'model', 'first', 'last'];
// redactTimeline(payload, role) -> GET /api/timeline as a reviewer or a viewer sees it: the lanes with their times,
// zones and tools; a tool segment's target (segment[5]: a file name, a command or a host) is blank; the marks keep
// their fixed labels. The owner gets the payload as it is.
function redactTimeline(t, role) {
  if (role === 'owner' || !isObj(t)) return t;
  const out = pick(t, ['ts', 'start', 'hours']);
  out.lanes = list(t.lanes).map((l) => ({
    ...pick(l, LANE_FIELDS),
    segments: (Array.isArray(l.segments) ? l.segments : [])
      .filter(Array.isArray)
      .map((s) => (s.length > 5 ? [...s.slice(0, 5), '', ...s.slice(6)] : [...s])),
    marks: (Array.isArray(l.marks) ? l.marks : []).filter(Array.isArray).map((m) => m.slice(0, 3)),
  }));
  return out;
}

const RUNTIME_ENTRY = ['id', 'name', 'port', 'approved', 'error'];
// redactRuntimesConfig(payload, role) -> GET /api/runtimes/config as a reviewer or a viewer sees it: each entry's name,
// port and state, never its command line or its health URL (either may hold a path or a token), in every mode. The
// owner gets the payload as it is.
function redactRuntimesConfig(c, role) {
  if (role === 'owner' || !isObj(c)) return c;
  return {
    ...pick(c, ['off', 'demo']),
    entries: list(c.entries).map((e) => ({ ...pick(e, RUNTIME_ENTRY), command: null, health: null, healthUsed: null })),
  };
}

const INTEGRATION_FIELDS = [
  'id',
  'type',
  'flavor',
  'enabled',
  'allowWrite',
  'tools',
  'writeTools',
  'state',
  'ok',
  'latencyMs',
  'detail',
];
// redactIntegrations(payload, role) -> GET /api/integrations as a reviewer or a viewer sees it: each integration's
// state, counts and latency, never its error text (it may name a host or a path); no MCP command line (the folder
// ZAAFPulse runs from). The AI clients and the MCP calls stay. The owner gets the payload as it is.
function redactIntegrations(x, role) {
  if (role === 'owner' || !isObj(x)) return x;
  const out = pick(x, ['clients', 'calls']);
  out.integrations = list(x.integrations).map((i) => pick(i, INTEGRATION_FIELDS));
  return out;
}

const PROXY_FIELDS = [
  'id',
  'ts',
  'status',
  'level',
  'proxy',
  'provider',
  'latencyMs',
  'headersMs',
  'firstChunkMs',
  'upstreamStatus',
  'attempt',
  'issue',
  'account',
  'tls',
];
// redactRouterProxy(payload, role) -> GET /api/router?section=proxy as a reviewer or a viewer sees it: each upstream
// call's status, provider and timings, never its target URL or error text; a router that could not be read says so in
// fixed words. The owner gets the payload as it is.
function redactRouterProxy(r, role) {
  if (role === 'owner' || !isObj(r)) return r;
  const out = pick(r, ['configured', 'id']);
  if (Object.hasOwn(r, 'data'))
    out.data = Array.isArray(r.data)
      ? list(r.data).map((x) => pick(x, PROXY_FIELDS))
      : { error: 'the router could not be read' };
  return out;
}

const INVENTORY_ITEM = [
  'id',
  'kind',
  'name',
  'vendor',
  'where',
  'state',
  'stale',
  'type',
  'origin',
  'transport',
  'command',
  'package',
  'ours',
  'clients',
  'firstSeen',
  'lastSeen',
  'baseline',
  'review',
  'status',
];
// redactInventory(payload, role) -> GET /api/governance/inventory as a reviewer or a viewer sees it: the items, their
// names, reviews and counts, without the project folders an MCP server is set up in or the AI clients' file paths. The
// owner gets the payload as it is.
function redactInventory(inv, role) {
  if (role === 'owner' || !isObj(inv)) return inv;
  return {
    ...pick(inv, ['generatedAt', 'counts', 'failed']),
    items: list(inv.items).map((i) => pick(i, INVENTORY_ITEM)),
    clients: list(inv.clients).map((c) => pick(c, ['client', 'name', 'state', 'servers'])),
  };
}

module.exports = {
  allowed,
  redactIntegrations,
  redactRouterProxy,
  redactInventory,
  redactOffice,
  redactTimeline,
  redactRuntimesConfig,
  redactGateway,
  redactTraceSessions,
  redactSummary,
  redactLogs,
  redactGatewayLogs,
  redactConfig,
  OPENROUTER_SECTIONS,
  ROLES,
  VIEWER_READS,
  REVIEWER_EXTRA,
  ANYONE,
  GATEWAY_PARTS,
  KEY_FIELDS,
  DENIED,
  MUST_CHANGE,
};
