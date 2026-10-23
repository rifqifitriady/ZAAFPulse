// The provider topology on the Overview, with ZAAFPulse as its hub: AI tools (layer 0) → ZAAFPulse, which holds the
// Agent Gateway (layer 1) → routers and running local runtimes (layer 2) → providers and loaded models (layer 3), with
// the newest requests merged from the logs, the gateway and the routers. Every tool, router, runtime and provider is
// connected through the hub, and every request path passes it. Pure: buildTopology gets every source as plain data and
// returns { ts, nodes, edges, requests }. No URL, path, key, account or prompt is copied into the result; names and
// models are short text only.

const { maskSecrets } = require('./trace/model');
const { PATHLIKE } = require('./monitors/api');

const WINDOW_MS = 3 * 3600 * 1000; // the logs' window; requests older than this are left out
const ACTIVE_MS = 5 * 60 * 1000;
const RECENT_MS = 60 * 60 * 1000;
const MAX_PER_LAYER = 12;
const MAX_REQUESTS = 20;
const MAX_TEXT = 80;
const MAX_NOTE = 120;

const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  meta: 'Meta',
  openrouter: 'OpenRouter',
  other: 'Other',
};
// First match wins. "llama" not after an "o", so Ollama is not Meta; "o<digit>" only at a word start (o3, o4-mini).
const PROVIDER_RULES = [
  ['anthropic', /claude|anthropic/],
  ['openai', /gpt|(^|[^a-z0-9])o\d|codex|openai|chatgpt/],
  ['google', /gemini|google|vertex/],
  ['xai', /grok|xai/],
  ['mistral', /mistral|codestral/],
  ['deepseek', /deepseek/],
  ['qwen', /qwen/],
  ['meta', /(^|[^o])llama|meta/],
  ['openrouter', /openrouter/],
];
// The provider a model or provider name belongs to, as a PROVIDER_LABELS key.
function providerOf(name) {
  if (typeof name !== 'string') return 'other';
  const n = name.toLowerCase();
  const hit = PROVIDER_RULES.find(([, re]) => re.test(n));
  return hit ? hit[0] : 'other';
}

// A tool's own provider, for a direct tool with no requests or a turn without a model.
const DEFAULT_PROVIDER = { claude: 'anthropic', codex: 'openai' };
// The gateway makes one key per connected tool, named `tool:<lib/gateway/tools.js id>`. These ids differ from the
// tool node's (an APPS id); every other one is the same. Gemini CLI is part of the Antigravity app.
const KEY_TOOLS = { 'claude-code': 'claude', 'gemini-cli': 'antigravity' };
// The dashboard's own gateway calls (agents, collab, the evals judge, RAG embeddings) are logged under this key id.
const DASHBOARD_KEY = 'dashboard';
// The hub: ZAAFPulse itself, through which every tool, router, runtime and provider is connected.
const HUB = 'zaafpulse';
// The apps that are local runtimes: drawn in layer 2 when running, never as tools.
const RUNTIME_APPS = ['ollama', 'lmstudio'];
// A gateway provider without a baseUrl uses its preset's; for these presets that is a local runtime's port.
const PRESET_PORTS = { ollama: 11434, lmstudio: 1234 };
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];
// A connection test that did not pass.
const FAILED_TEST = /error|fail|invalid|expired|unauth|denied|unavailable|revoked|banned/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v) => (isObj(v) ? v : {});
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// A list as given, or the first list under one of keys when it came wrapped; anything else ({ error }…) is empty.
const listOf = (v, ...keys) => (Array.isArray(v) ? v : isObj(v) ? keys.map((k) => v[k]).find(Array.isArray) || [] : []);
const num = (v) => (Number.isFinite(v) ? v : 0);
const msOf = (v) => (Number.isFinite(v) ? v : null);
const tsOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);
const URLS = /[a-z][a-z0-9+.-]*:\/\/\S*/gi;
// An address has a domain with a dot and a TLD, so a Vertex model id (`claude-sonnet-4-5@20250929`) is not one. It is
// blanked whole: a masked account is still an account.
const EMAILS = /[^\s@]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\S*/g;
// host:port only for a real host (localhost, an IPv4 or IPv6 address, a dotted name with a TLD), so an Ollama or
// dated model tag (`qwen3:14b`, `gpt-4:2024`) stays.
const HOST_PORTS =
  /(?:\blocalhost|\b\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:]+\]|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}):\d{2,5}\b(?:\/\S*)?/g;
const TOKENS = /\b(?:sk|pk|rk)-[\w-]{6,}|\bBearer\s+\S+/gi; // maskSecrets does not know sk-ant / sk-live
// A path at the start of a word: /abs, ~, ~/x, ./x, ../x, C:\x. A vendor/model name has none of these.
const WORD_PATHS = /(^|[\s("'=,;])(?:[A-Za-z]:[\\/]|~(?:[\\/]|(?=\s|$))|\.{1,2}(?=[\\/])|\/)\S*/g;
// Everything that is not a name or a short message: URLs, emails, secrets, host:port, paths.
const scrub = (v) =>
  maskSecrets(v.replace(URLS, ' '))
    .replace(/\u2039[^\u203a]*\u203a/g, ' ')
    .replace(EMAILS, ' ')
    .replace(TOKENS, ' ')
    .replace(HOST_PORTS, ' ')
    .replace(WORD_PATHS, '$1 ')
    .replace(PATHLIKE, ' ');
// Text for the page: scrubbed, whitespace collapsed, clipped; null when nothing is left.
const text = (v, max = MAX_TEXT) => {
  if (typeof v !== 'string') return null;
  const t = scrub(v).replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t || null;
};
// A short failure reason (`timed out`, `HTTP 401`).
const reason = (v) => text(String(v), 60);
// An id as it may appear in a node id: scrubbed like text, then [A-Za-z0-9._-] only, at most 40 characters.
const safe = (v) =>
  scrub(String(v))
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 40) || '_';
// A status code as a number; a string such as "200" counts, an empty or missing one is NaN.
const code = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);
// Input and output tokens of an OmniRoute call: { in, out } as it reports them, or the usual other names.
function tokensOf(t) {
  if (Number.isFinite(t)) return t;
  const o = obj(t);
  const pick = (...ks) => ks.map((k) => o[k]).find(Number.isFinite);
  const input = pick('in', 'input', 'prompt', 'prompt_tokens');
  const output = pick('out', 'output', 'completion', 'completion_tokens');
  return input === undefined && output === undefined ? num(o.total) : num(input) + num(output);
}
// The port of a baseUrl on this machine, or null.
function localPort(url) {
  try {
    const u = new URL(url);
    if (!LOCAL_HOSTS.includes(u.hostname)) return null;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}

// active, recent, error or idle, from a request (or null).
function statusOf(req, now) {
  if (!req) return 'idle';
  const age = now - req.ts;
  if (!req.ok) return age <= RECENT_MS ? 'error' : 'idle';
  return age <= ACTIVE_MS ? 'active' : age <= RECENT_MS ? 'recent' : 'idle';
}

// input = { live, logs, gateway: { providers, usage, keys }, routers, runtimes, routes, appNames }: see the specs,
// docs/superpowers/specs/2026-10-23-provider-topology-design.md and its amendment 2026-10-23-topology-hub-design.md.
// Every part may be missing or an { error }.
function buildTopology(input, now = Date.now()) {
  const inp = obj(input);
  const live = obj(inp.live);
  const logs = obj(inp.logs);
  const gw = obj(inp.gateway);
  const routes = obj(inp.routes);
  const appNames = obj(inp.appNames);
  const windowMs = Number.isFinite(logs.windowMs) && logs.windowMs > 0 ? logs.windowMs : WINDOW_MS;
  const inWindow = (ts) => Number.isFinite(ts) && now - ts <= windowMs;
  const named = (r) => isObj(r) && typeof r.id === 'string' && r.id !== '';
  const runtimes = listOf(inp.runtimes, 'runtimes').filter(named);
  const routers = listOf(inp.routers).filter(named);
  // The gateway is part of the hub; it counts only with at least one enabled provider.
  const gwProviders = listOf(gw.providers, 'providers').filter(named);
  const enabled = gwProviders.filter((p) => p.enabled !== false);
  // The hop a tool is routed to: 'gateway', a router node id, or null when it goes direct or the hop is not drawn.
  const routeTo = (tool) => {
    const r = own(routes, tool) && typeof routes[tool] === 'string' && routes[tool];
    if (r === 'gateway') return enabled.length ? 'gateway' : null;
    const hop = r ? `router:${safe(r)}` : null;
    return hop && nodes.has(hop) ? hop : null;
  };

  const nodes = new Map();
  const edges = new Map();
  const add = (id, layer, kind, label) => {
    if (!nodes.has(id)) nodes.set(id, { id, layer, kind, label, status: 'idle', note: null });
    return id;
  };
  const link = (from, to) => {
    if (nodes.has(from) && nodes.has(to)) edges.set(`${from}>${to}`, { id: `${from}>${to}`, from, to });
  };
  const provider = (p) => add(`provider:${p}`, 3, 'provider', PROVIDER_LABELS[p]);

  /* ---------- layer 0: the tools ---------- */
  const runtimeIds = new Set([...RUNTIME_APPS, ...runtimes.map((r) => r.id)]);
  const running = new Set(
    listOf(live.apps)
      .filter(named)
      .map((a) => safe(a.id)),
  );
  const turns = listOf(logs.requests).filter(
    (r) => isObj(r) && own(DEFAULT_PROVIDER, r.source) && inWindow(tsOf(r.ts)),
  );
  // Real API failures (overloaded, 5xx, auth) of Claude Code and Codex; a failed tool call is not one.
  const apiErrors = listOf(logs.errors).filter(
    (e) => isObj(e) && e.kind === 'api' && own(DEFAULT_PROVIDER, e.tool) && inWindow(tsOf(e.ts)),
  );
  const toolIds = [
    ...listOf(live.installed).filter((id) => typeof id === 'string' && id),
    ...[...running],
    ...turns.map((r) => r.source),
    ...apiErrors.map((e) => e.tool),
  ]
    .filter((id) => !runtimeIds.has(id))
    .map((id) => ({ id: safe(id), raw: id }))
    .filter(({ id }) => id !== HUB); // ZAAFPulse is the hub, never one of its own tools
  for (const { id, raw } of toolIds) add(id, 0, 'tool', text(appNames[raw]) || text(raw) || id);
  const tools = [...nodes.keys()];
  const labelOf = (id) => nodes.get(id).label;
  // The provider a log turn or API error of a tool went to: its model's, else the tool's own.
  const logProvider = (tool, model) =>
    typeof model === 'string' && model ? providerOf(model) : DEFAULT_PROVIDER[tool];
  const turnProvider = (r) => logProvider(r.source, r.model);

  /* ---------- layer 1: the hub; layer 2: routers and running runtimes ---------- */
  add(HUB, 1, 'hub', 'ZAAFPulse');
  const routerIds = new Set();
  for (const r of routers)
    routerIds.add(
      add(`router:${safe(r.id)}`, 2, 'router', text(r.name) || (r.flavor === '9router' ? '9router' : 'OmniRoute')),
    );
  const up = runtimes.filter((r) => r.running === true);
  const runtimeNodes = new Set(up.map((r) => add(`runtime:${safe(r.id)}`, 2, 'runtime', text(r.name) || safe(r.id))));
  // What the hub connects, such as `gateway · 1 router · 1 runtime`; a part with nothing in it is left out.
  const count = (n, one) => (n ? `${n} ${one}${n === 1 ? '' : 's'}` : null);
  nodes.get(HUB).note =
    [enabled.length ? 'gateway' : null, count(routerIds.size, 'router'), count(runtimeNodes.size, 'runtime')]
      .filter(Boolean)
      .join(' · ') || null;
  // How a tool is connected, for the page: via the gateway, via a router (by its label), or monitored (null).
  for (const t of tools) {
    const route = routeTo(t);
    nodes.get(t).via = route === 'gateway' ? 'gateway' : route ? labelOf(route) : null;
  }

  /* ---------- edges, and layer 3 as the edges reach it ---------- */
  // Every tool connects to the hub, and the hub to every router and running runtime.
  for (const t of tools) link(t, HUB);
  for (const id of [...routerIds, ...runtimeNodes]) link(HUB, id);
  // A direct tool's providers hang off the hub: one per provider in its turns, else its own.
  for (const t of tools) {
    if (routeTo(t)) continue;
    const seen = new Set(turns.filter((r) => r.source === t).map(turnProvider));
    if (!seen.size && own(DEFAULT_PROVIDER, t)) seen.add(DEFAULT_PROVIDER[t]);
    for (const p of seen) link(HUB, provider(p));
  }

  // A router's provider connections; one that is inactive or failed its test marks that provider.
  const failing = new Map(); // provider node id -> Set of notes
  for (const r of routers) {
    for (const c of listOf(r.providers, 'connections', 'providers').filter(isObj)) {
      const id = provider(providerOf(c.provider || c.displayName || c.name));
      link(`router:${safe(r.id)}`, id);
      const note =
        c.isActive === false
          ? 'connection inactive'
          : typeof c.testStatus === 'string' && FAILED_TEST.test(c.testStatus)
            ? `connection test ${reason(c.testStatus) || 'failed'}`
            : null;
      if (note) failing.set(id, (failing.get(id) || new Set()).add(note));
    }
  }

  // Where the gateway sends a provider's calls: a running runtime on that local port, else the provider.
  const gwTarget = (p) => {
    const port = typeof p.baseUrl === 'string' && p.baseUrl ? localPort(p.baseUrl) : PRESET_PORTS[p.preset] || null;
    const rt = port && up.find((r) => r.port === port);
    return rt ? `runtime:${safe(rt.id)}` : provider(providerOf(p.preset || p.id));
  };
  // The gateway's providers hang off the hub too; one on a running runtime's port is that runtime's edge.
  for (const p of enabled) link(HUB, gwTarget(p));

  // A running runtime's models: what it has loaded now when that is known (the last read), else those a Start loaded
  // again, else the ones last remembered.
  const inUse = new Set(); // model node ids known to be loaded now
  for (const r of up) {
    const m = obj(r.models);
    const loadedNow = Array.isArray(m.current) ? m.current : null;
    const loaded = loadedNow || (listOf(m.loaded).length ? listOf(m.loaded) : listOf(m.remembered));
    if (loadedNow) for (const x of loadedNow) if (text(x)) inUse.add(`model:${safe(r.id)}:${text(x)}`);
    for (const name of new Set(loaded.map((x) => text(x)).filter(Boolean)))
      link(`runtime:${safe(r.id)}`, add(`model:${safe(r.id)}:${name}`, 3, 'model', name));
  }

  /* ---------- requests ---------- */
  let requests = [];
  // The one tool routed to a router, when exactly one is; it is then the call's client (a call log has none).
  const onlyTool = (hop) => {
    const via = tools.filter((t) => routeTo(t) === hop);
    return via.length === 1 ? via[0] : null;
  };

  // Log turns of direct tools; a routed tool's turns are reported by the hop it goes through. A turn whose tool
  // calls failed is still ok: the provider answered. Every path passes the hub.
  for (const r of turns) {
    if (routeTo(r.source)) continue;
    requests.push({
      ts: tsOf(r.ts),
      path: [r.source, HUB, provider(turnProvider(r))],
      client: labelOf(r.source),
      model: text(r.model),
      tokens: num(r.input) + num(r.output),
      ms: msOf(r.durationMs),
      ok: true,
      source: 'logs',
    });
  }
  // API errors of direct tools are the failed requests; their text is not copied.
  for (const e of apiErrors) {
    if (routeTo(e.tool)) continue;
    requests.push({
      ts: tsOf(e.ts),
      path: [e.tool, HUB, provider(logProvider(e.tool, e.model))],
      client: labelOf(e.tool),
      model: text(e.model),
      tokens: 0,
      ms: null,
      ok: false,
      source: 'logs',
    });
  }

  if (enabled.length) {
    const byId = new Map(gwProviders.map((p) => [p.id, p]));
    const keyNames = new Map(
      listOf(gw.keys, 'keys')
        .filter(named)
        .map((k) => [k.id, k.name]),
    );
    // Who sent a request: the tool its key was made for when that tool is drawn, ZAAFPulse for the dashboard's own
    // calls, else the key name or the agent.
    const sender = (u) => {
      if (u.keyId === DASHBOARD_KEY) return { tool: null, client: 'ZAAFPulse' };
      const name = keyNames.get(u.keyId);
      const m = typeof name === 'string' && /^tool:(.+)$/.exec(name);
      const id = m && safe(own(KEY_TOOLS, m[1]) ? KEY_TOOLS[m[1]] : m[1]);
      if (id && tools.includes(id)) return { tool: id, client: labelOf(id) };
      return { tool: null, client: text(name) || text(u.agent) };
    };
    for (const u of listOf(gw.usage, 'entries').filter(isObj)) {
      const ts = tsOf(u.ts);
      if (!inWindow(ts)) continue;
      const p = byId.get(u.provider);
      // A provider no longer configured: the first of the model that answered, the model and the id that names one.
      const guess = [u.routedTo, u.model, u.provider].map(providerOf).find((x) => x !== 'other') || 'other';
      const { tool, client } = sender(u);
      requests.push({
        ts,
        path: [...(tool ? [tool] : []), HUB, p ? gwTarget(p) : provider(guess)],
        client,
        model: text(u.routedTo || u.model),
        tokens: num(u.input) + num(u.output),
        ms: msOf(u.ms),
        ok: !(code(u.status) >= 400) && !u.error,
        source: 'gateway',
      });
    }
  }

  for (const r of routers) {
    const hop = `router:${safe(r.id)}`;
    const tool = onlyTool(hop);
    for (const c of listOf(r.calls, 'rows', 'logs', 'calls').filter(isObj)) {
      const id = provider(providerOf(c.provider || c.model || c.requestedModel));
      link(hop, id);
      const ts = tsOf(c.ts);
      if (!inWindow(ts)) continue;
      requests.push({
        ts,
        path: [...(tool ? [tool] : []), HUB, hop, id],
        client: tool ? labelOf(tool) : null,
        model: text(c.model || c.requestedModel),
        tokens: tokensOf(c.tokens),
        ms: msOf(c.durationMs),
        ok: !(code(c.status) >= 400), // a row with no status (in flight, an older OmniRoute) did not fail
        source: 'router',
      });
    }
  }

  // Every hop of a request is an edge, so its path can be highlighted.
  for (const q of requests) for (let i = 1; i < q.path.length; i++) link(q.path[i - 1], q.path[i]);
  requests.sort((a, b) => b.ts - a.ts);

  /* ---------- at most 12 nodes a layer: the 11 busiest and "+N more"; layer 1 holds only the hub ---------- */
  const busy = new Map();
  for (const q of requests) for (const id of q.path) busy.set(id, (busy.get(id) || 0) + 1);
  const fold = new Map(); // folded node id -> its "+N more" node id
  let list = [...nodes.values()];
  for (const layer of [0, 2, 3]) {
    const all = list.filter((n) => n.layer === layer);
    if (all.length <= MAX_PER_LAYER) continue;
    const keep = new Set(
      [...all]
        .sort((a, b) => (busy.get(b.id) || 0) - (busy.get(a.id) || 0))
        .slice(0, MAX_PER_LAYER - 1)
        .map((n) => n.id),
    );
    const hidden = all.filter((n) => !keep.has(n.id));
    const more = {
      id: `more:${layer}`,
      layer,
      kind: 'more',
      label: `+${hidden.length} more`,
      status: 'idle',
      note: text(hidden.map((n) => n.label).join(', '), MAX_NOTE),
    };
    for (const n of hidden) fold.set(n.id, more.id);
    list = [...list.filter((n) => n.layer !== layer || keep.has(n.id)), more];
  }
  list.sort((a, b) => a.layer - b.layer);
  const to = (id) => fold.get(id) || id;
  const edgeList = new Map();
  for (const e of edges.values()) {
    const id = `${to(e.from)}>${to(e.to)}`;
    edgeList.set(id, { id, from: to(e.from), to: to(e.to), status: 'idle' });
  }
  requests = requests.map((q) => ({ ...q, path: q.path.map(to).filter((id, i, p) => id !== p[i - 1]) }));

  /* ---------- status: the newest request through a node, or along an edge ---------- */
  // An edge takes only the requests that passed along it, hop to hop: every path holds the hub, so a router call to a
  // provider would otherwise also colour the hub's direct edge to that provider.
  const newest = new Map();
  for (const q of requests) {
    for (let i = 0; i < q.path.length; i++) {
      if (!newest.has(q.path[i])) newest.set(q.path[i], q);
      const k = `${q.path[i - 1]}>${q.path[i]}`;
      if (i && !newest.has(k)) newest.set(k, q);
    }
  }
  for (const n of list) if (n.kind !== 'more') n.status = statusOf(newest.get(n.id), now);
  for (const e of edgeList.values()) e.status = statusOf(newest.get(e.id), now);
  const byId = new Map(list.map((n) => [n.id, n]));
  // The hub is the dashboard itself: always active.
  byId.get(HUB).status = 'active';
  // A running tool is at least active.
  for (const n of list) if (n.kind === 'tool' && running.has(n.id) && n.status !== 'error') n.status = 'active';
  // A local runtime is also used from its own app, which no log sees: one that answers is at least active, and so are
  // the models it has loaded now and their edges; one that runs but does not answer is an error.
  const atLeastActive = (x) => x && x.status !== 'error' && (x.status = 'active');
  for (const r of up) {
    const rt = byId.get(`runtime:${safe(r.id)}`);
    if (!rt) continue;
    if (r.healthy === false) {
      rt.status = 'error';
      rt.note = 'not answering';
      continue;
    }
    atLeastActive(rt);
    for (const e of edgeList.values())
      if (e.from === rt.id && inUse.has(e.to)) {
        atLeastActive(e);
        atLeastActive(byId.get(e.to));
      }
  }
  // A router whose health check failed.
  for (const r of routers) {
    const h = r.health;
    if (!isObj(h) || !(h.error || h.ok === false)) continue;
    const n = byId.get(`router:${safe(r.id)}`);
    if (n) Object.assign(n, { status: 'error', note: (h.error && reason(h.error)) || 'health check failed' });
  }
  // A provider with a failing router connection (a folded one shows in "+N more" as idle).
  for (const [id, notes] of failing) {
    const n = byId.get(id);
    if (n) Object.assign(n, { status: 'error', note: text([...notes].join(', '), MAX_NOTE) });
  }

  return { ts: now, nodes: list, edges: [...edgeList.values()], requests: requests.slice(0, MAX_REQUESTS) };
}

// The gateway's part of the input, read from lib/gateway: its configured providers (only the fields the graph uses,
// never an apiKey ref), its 200 newest requests and its key names. providers.list() reads the config alone, where
// admin('', 'GET') would build the whole Gateway page (skills, tool configs, memory…) to give the same list.
async function readGateway(gateway) {
  const [providers, usage, keys] = await Promise.all([
    gateway.providers.list(),
    gateway.usage.recent(200),
    gateway.keys.list(),
  ]);
  return {
    providers: (Array.isArray(providers) ? providers : [])
      .filter(isObj)
      .map((p) => ({ id: p.id, preset: p.preset, baseUrl: p.baseUrl, enabled: p.enabled !== false })),
    usage: Array.isArray(usage) ? usage : [],
    keys: (Array.isArray(keys) ? keys : []).filter(isObj).map((k) => ({ id: k.id, name: k.name })),
  };
}

module.exports = { buildTopology, providerOf, readGateway, PROVIDER_LABELS };
