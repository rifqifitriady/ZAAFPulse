// Governance audit log (AI Governance 2): what a dashboard request and an agent or runtime control line become as audit
// entries (spec A4), pure. Of a request body only the short fields named here are kept: the action word (action or
// op) and the target's id and name. Reads that travel as POST are not entries.
const WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_PATH = 120;

// Routes with ids in their path: the action names the route with each id as :id.
const ID_ROUTES = [
  [/^\/api\/monitors\/(?!channels$|test$|status$)([a-z_]{1,40})$/, '/api/monitors/:id'],
  [/^\/api\/datasets\/(?!settings$|import$)([^/]+)$/, '/api/datasets/:id'],
  [/^\/api\/datasets\/([^/]+)\/examples$/, '/api/datasets/:id/examples'],
  [/^\/api\/datasets\/([^/]+)\/examples\/([^/]+)$/, '/api/datasets/:id/examples/:id'],
  [/^\/api\/experiments\/([^/]+)\/cancel$/, '/api/experiments/:id/cancel'],
  [/^\/api\/cost\/budgets\/([^/]+)\/delete$/, '/api/cost/budgets/:id/delete'],
];
// Reads sent as POST: polling a run (every 1.2 s while it works), testing a connection, previews. They change
// nothing, so they are not entries.
const READ_ONLY = new Set([
  'POST /api/gateway/logs',
  'POST /api/gateway/quota',
  'POST /api/gateway/providers test',
  'POST /api/gateway/providers models',
  'POST /api/gateway/knowledge get',
  'POST /api/gateway/knowledge search',
  'POST /api/gateway/collab get',
  'POST /api/gateway/collab list',
  'POST /api/gateway/sessions get',
  'POST /api/integrations/test',
  'POST /api/integrations/test-draft',
  'POST /api/evals/preview',
  'POST /api/cost/settings/preview',
  'POST /api/cost/restate/preview',
  'POST /api/brain/sources test',
]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const outcomeOf = (status) => (status < 400 ? 'ok' : status < 500 ? 'refused' : 'error');

// '/api/datasets/abc/examples/7' -> { route: '/api/datasets/:id/examples/:id', ids: ['abc', '7'] }
function routeOf(p) {
  const path = String(p || '').slice(0, MAX_PATH);
  for (const [re, route] of ID_ROUTES) {
    const m = path.match(re);
    if (m) return { route, ids: m.slice(1).map((x) => x.slice(0, 80)) };
  }
  return { route: path, ids: [] };
}

// requestEntry({ method, path, status, body, reply }) -> the entry of one dashboard request, or null for a read.
// body is the request's text (as read), reply the answer sent: an admin answer of { errors } with 200 is a refusal.
function requestEntry({ method, path, status, body, reply }) {
  const { route, ids } = routeOf(path);
  let b = null;
  try {
    b = typeof body === 'string' && body ? JSON.parse(body) : null;
  } catch {
    b = null;
  }
  if (!isObj(b)) b = {};
  const op = [b.action, b.op].find((v) => typeof v === 'string' && WORD.test(v)) || null;
  if (READ_ONLY.has(`${method} ${route}`) || (op && READ_ONLY.has(`${method} ${route} ${op}`))) return null;
  const id = ids[0] || (typeof b.id === 'string' && ID.test(b.id) ? b.id : null);
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : null;
  const seg = route.split('/');
  const type = seg[2] === 'gateway' && seg[3] ? `gateway.${seg[3]}` : seg[2] || 'api';
  const refused = status < 400 && isObj(reply) && Array.isArray(reply.errors) && reply.errors.length > 0;
  return {
    action: `${method} ${route}`,
    ...(op ? { op } : {}),
    ...(id || name ? { target: { type, ...(id ? { id } : {}), ...(name ? { name } : {}) } } : {}),
    outcome: refused ? 'refused' : outcomeOf(status),
    status,
  };
}

// controlEntry(line) -> the entry of one agent-audit.jsonl line (lib/agents/control.js, lib/runtimes/control.js), or
// null. A rule's own pause names the rule as its actor; the rest take the request's actor.
function controlEntry(e) {
  if (!isObj(e) || typeof e.action !== 'string' || !WORD.test(e.action)) return null;
  const runtime = e.kind === 'runtime';
  const id = runtime
    ? typeof e.id === 'string' && e.id
      ? e.id.slice(0, 40)
      : null
    : Number.isInteger(e.pid)
      ? String(e.pid)
      : null;
  const name = !runtime && typeof e.app === 'string' && e.app ? e.app.slice(0, 40) : null;
  const status = Number.isInteger(e.status) ? e.status : null;
  return {
    action: `${runtime ? 'runtime' : 'agent'}.${e.action}`,
    ...(e.by === 'rule' && typeof e.rule === 'string' ? { actor: { via: 'rule', rule: e.rule.slice(0, 40) } } : {}),
    ...(id || name
      ? { target: { type: runtime ? 'runtime' : 'agent', ...(id ? { id } : {}), ...(name ? { name } : {}) } }
      : {}),
    outcome: e.ok === false ? (status && status >= 500 ? 'error' : 'refused') : 'ok',
    ...(status ? { status } : {}),
  };
}

module.exports = { requestEntry, controlEntry, routeOf, outcomeOf, READ_ONLY };
