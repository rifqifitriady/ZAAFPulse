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
  '/api/agents/candidates',
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

// allowed({ role, method, path, action, mustChange, section }) -> { ok, reason }: reason is the 403 message when ok is false.
// `section` is the query's section, read for /api/openrouter only: its account section is the owner's.
function allowed({ role, method, path, action = null, mustChange = false, section = null } = {}) {
  const yes = { ok: true, reason: null };
  const no = (reason) => ({ ok: false, reason });
  if (role === 'owner') return yes;
  const p = String(path || '');
  if (!p.startsWith('/api/')) return yes; // the page and its files; /api is what holds data
  const m = String(method || '').toUpperCase();
  if (anyone.has(`${m} ${p}`)) return ROLES.includes(role) ? yes : no(DENIED);
  if (!ROLES.includes(role)) return no(DENIED);
  if (mustChange) return no(MUST_CHANGE);
  if (
    p === '/api/openrouter' &&
    section !== null &&
    section !== undefined &&
    (typeof section !== 'string' || section.trim().toLowerCase() === 'account')
  )
    return no(DENIED);
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
  'skillRoots',
  'quota',
  'tools',
  'baseUrl',
  'settings',
];
const KEY_FIELDS = ['id', 'name', 'prefix', 'scopes', 'budgetUSD', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt'];

// redactGateway(payload, role) -> GET /api/gateway as a reviewer or a viewer sees it: agents without their system
// prompt, notes without their text, sessions without their title, runs without their task, error or approval question,
// keys with nothing but name, prefix, scopes, budget and dates (and their id), providers without a secret reference
// (and only their sign-in type), no quota read. The owner gets the payload as it is.
function redactGateway(g, role) {
  if (role === 'owner' || !isObj(g)) return g;
  const out = pick(g, GATEWAY_PARTS);
  const parts = {
    agents: (a) => list(a).map(({ systemPrompt, ...x }) => x),
    memory: (a) => list(a).map(({ text, ...x }) => x),
    sessions: (a) => list(a).map(({ title, ...x }) => x),
    runs: (a) =>
      list(a).map(({ title, error, pending, ...x }) => ({
        ...x,
        pending: isObj(pending) && Number.isInteger(pending.step) ? { step: pending.step } : null,
      })),
    keys: (a) => list(a).map((k) => pick(k, KEY_FIELDS)),
    providers: (a) =>
      list(a).map(({ apiKey, auth, ...x }) => ({ ...x, auth: { type: (isObj(auth) && auth.type) || 'key' } })),
    quota: () => [],
  };
  for (const [k, fn] of Object.entries(parts)) if (Object.hasOwn(out, k)) out[k] = fn(out[k]);
  return out;
}

// redactTraceSessions(body, role) -> GET /api/trace/sessions as a reviewer or a viewer sees it: each session without its
// title (the first prompt). The owner gets the body as it is.
function redactTraceSessions(body, role) {
  if (role === 'owner' || !isObj(body) || !Array.isArray(body.sessions)) return body;
  return { ...body, sessions: list(body.sessions).map(({ title, ...x }) => x) };
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
  out.projects = list(s.projects).map((x) => pick(x, PROJECT_FIELDS));
  out.sessions = list(s.sessions).map(session);
  out.topCostSessions = list(s.topCostSessions).map(session);
  if (isObj(s.quality)) {
    const { events, feed, ...rest } = s.quality;
    out.quality = {
      ...rest,
      events: Object.fromEntries(Object.entries(isObj(events) ? events : {}).map(([k, a]) => [k, list(a).map(event)])),
      feed: list(feed).map(event),
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

module.exports = {
  allowed,
  redactGateway,
  redactTraceSessions,
  redactSummary,
  redactLogs,
  ROLES,
  VIEWER_READS,
  REVIEWER_EXTRA,
  ANYONE,
  GATEWAY_PARTS,
  KEY_FIELDS,
  DENIED,
  MUST_CHANGE,
};
