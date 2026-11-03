// Governance inventory (AI Governance 3): one item per AI system, built at read time from the sources server.js gathers
// (spec I1, I2). Pure: the sources, the owner's reviews (config.json governance.inventory), the first and last day each
// item was seen and the time come in; the items, their counts and the next seen dates go out. An item's id is
// `<kind>:<name>`, the name being the system's own id where it has one (a key id, a provider id), lowercased.
const { providerOf, PROVIDER_LABELS } = require('../topology');

const KINDS = [
  'app',
  'mcp',
  'provider',
  'model',
  'agent',
  'skill',
  'workflow',
  'knowledge',
  'runtime',
  'integration',
  'key',
];
// The best state wins when several sources name one system.
const STATES = ['running', 'used', 'configured', 'idle'];
const RISKS = ['minimal', 'limited', 'high', 'unacceptable']; // the EU AI Act tiers
const DECISIONS = ['approved', 'restricted', 'blocked'];
const SOURCES = ['live', 'summary', 'trace', 'gateway', 'runtimes', 'integrations', 'mcp'];
const TEXT_MAX = 200;
const NAME_MAX = 120;
const NEW_DAYS = 7; // an item first seen this many days ago or less is new (inventory_unreviewed)
const USED_DAYS = 30; // a tool or a key active this recently counts as used
const DAY_MS = 864e5;
// The apps whose server is a local runtime (as the topology draws them): one item, kind runtime.
const RUNTIME_APPS = new Set(['ollama', 'lmstudio']);
// Trace sources that are an app under another id (Gemini CLI is part of the Antigravity app, lib/processes.js).
const TRACE_APPS = { gemini: 'antigravity' };
const VENDORS = {
  claude: 'Anthropic',
  'claude-desktop': 'Anthropic',
  codex: 'OpenAI',
  chatgpt: 'OpenAI',
  antigravity: 'Google',
  cursor: 'Anysphere',
  kiro: 'Amazon Web Services',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};
const INTEGRATION_VENDORS = { dynatrace: 'Dynatrace', arize: 'Arize', n8n: 'n8n', omniroute: 'OmniRoute' };
// The sources a kind is read from: when one failed, a reviewed item of that kind is not known to be gone.
const KIND_SOURCES = {
  app: ['live', 'summary', 'trace', 'runtimes'],
  mcp: ['summary', 'mcp'],
  provider: ['gateway'],
  model: ['summary', 'gateway'],
  agent: ['gateway'],
  skill: ['gateway'],
  workflow: ['gateway'],
  knowledge: ['gateway'],
  runtime: ['runtimes', 'live'],
  integration: ['integrations'],
  key: ['gateway'],
};
const SEEN_KEEP_DAYS = 400; // a seen entry not seen for this long is dropped
const ID = new RegExp(`^(${KINDS.join('|')}):(.{1,${NAME_MAX}})$`);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Control characters (line breaks, U+2028 and U+2029 included) never stay in an id, so it always matches ID below. The
// name is trimmed again after the cut, so an id never ends in a space (cleanReview trims the id it is given).
const idOf = (kind, name) => {
  const n = str(name)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '')
    .trim()
    .toLowerCase()
    .slice(0, NAME_MAX)
    .trim();
  return n ? `${kind}:${n}` : null;
};
const vendorOfModel = (name) => {
  const p = providerOf(str(name));
  return p === 'other' ? null : PROVIDER_LABELS[p];
};
function originOf(url) {
  try {
    const u = new URL(str(url));
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

// A stored review as config.json holds it, read leniently: a field that is not what it should be is left out.
function storedReview(v) {
  if (!isObj(v)) return null;
  const text = (x) => (typeof x === 'string' ? x.slice(0, TEXT_MAX) : '');
  return {
    owner: text(v.owner),
    purpose: text(v.purpose),
    risk: RISKS.includes(v.risk) ? v.risk : '',
    decision: DECISIONS.includes(v.decision) ? v.decision : '',
    note: text(v.note),
    reviewedAt: typeof v.reviewedAt === 'string' ? v.reviewedAt.slice(0, 40) : null,
  };
}

// A review from the dashboard: { id, owner, purpose, risk, decision, note } or { id, clear: true }. Returns
// { errors: [message naming the field], id, value } (value null to clear). Text is trimmed.
function cleanReview(input) {
  if (!isObj(input)) return { errors: ['body: an object'], id: null, value: null };
  const errors = [];
  const allowed = ['id', 'owner', 'purpose', 'risk', 'decision', 'note', 'clear'];
  for (const k of Object.keys(input)) if (!allowed.includes(k)) errors.push(`${k}: not a review field`);
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const parts = ID.exec(id);
  if (!parts || idOf(parts[1], parts[2]) !== id) errors.push('id: an inventory id (<kind>:<name>)');
  if (input.clear !== undefined && input.clear !== true) errors.push('clear: true or left out');
  const value = {};
  const given = (k) => (input[k] === undefined || input[k] === null ? '' : input[k]);
  const text = (k) => {
    const v = given(k);
    if (typeof v !== 'string' || v.trim().length > TEXT_MAX)
      errors.push(`${k}: text of at most ${TEXT_MAX} characters`);
    else value[k] = v.trim();
  };
  const oneOf = (k, list) => {
    const v = given(k);
    if (v !== '' && !list.includes(v)) errors.push(`${k}: ${list.join(', ')} or empty`);
    else value[k] = v;
  };
  text('owner');
  text('purpose');
  oneOf('risk', RISKS);
  oneOf('decision', DECISIONS);
  text('note');
  return { errors, id, value: input.clear === true ? null : value };
}

// buildInventory(sources, reviews, seen, now) -> { items, counts, failed, clients, nextSeen }.
// sources (server.js; null for a source that failed, absent for one not read):
//   live: { apps: [{ id, name }], installed: [id], names: { id: name } }
//   summary: { tools: [{ id, name, lastActive }], toolUse: [{ name }], models: [{ model }] }
//   trace: [{ id, ok, count }]
//   gateway: { providers: [{ id, preset, baseUrl, enabled }], models: [name], keys: [{ id, name, revokedAt,
//     expiresAt, lastUsedAt }], agents: [{ id, name, enabled, remoteUrl }], skills: [{ name, claude, agents }],
//     workflows: [{ id, name }], knowledge: [{ id, name }] }
//   runtimes: [{ id, name, kind, preset, installed, running }]
//   integrations: [{ id, type, flavor, enabled, url }]
//   mcp: lib/governance/mcp-scan.js scanClients()
// reviews: { id: review }; seen: { baselineDone, map: { id: { first, last, state?, baseline? } } } (days, UTC).
function buildInventory(sources, reviews, seen, now) {
  const src = isObj(sources) ? sources : {};
  const map = new Map();
  const failed = SOURCES.filter((s) => Object.hasOwn(src, s) && src[s] === null);
  const today = dayOf(now);

  function add(kind, key, { name, vendor = null, where, state, ...extra }) {
    const id = idOf(kind, key);
    if (!id) return;
    let it = map.get(id);
    if (!it) {
      it = { id, kind, name: str(name || key).slice(0, NAME_MAX), vendor: null, where: [], state };
      map.set(id, it);
    }
    if (!it.vendor && vendor) it.vendor = vendor;
    if (where && !it.where.includes(where)) it.where.push(where);
    if (STATES.indexOf(state) < STATES.indexOf(it.state)) it.state = state;
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined || v === false) continue;
      if (Array.isArray(v)) it[k] = [...new Set([...(it[k] || []), ...v])];
      else if (it[k] === undefined || it[k] === null || it[k] === false) it[k] = v;
    }
  }
  const appKind = (id) => (RUNTIME_APPS.has(id) ? 'runtime' : 'app');
  const app = (id, name, where, state) =>
    add(appKind(id), id, { name: name || id, vendor: VENDORS[id] || null, where, state });
  const recent = (t) => Number.isFinite(t) && now - t <= USED_DAYS * DAY_MS;

  // Running and installed apps (lib/processes.js snapshot).
  const live = isObj(src.live) ? src.live : null;
  if (live) {
    const names = isObj(live.names) ? live.names : {};
    for (const a of arr(live.apps)) app(str(a.id), str(a.name) || own(names, a.id), 'running', 'running');
    for (const id of Array.isArray(live.installed) ? live.installed : [])
      if (typeof id === 'string') app(id, own(names, id), 'installed', 'idle');
  }
  // The indexed logs: Claude Code and Codex, the MCP servers their tools came from, and the models they used.
  const sum = isObj(src.summary) ? src.summary : null;
  if (sum) {
    for (const t of arr(sum.tools))
      if (Number.isFinite(t.lastActive)) app(str(t.id), str(t.name), 'logs', recent(t.lastActive) ? 'used' : 'idle');
    for (const u of arr(sum.toolUse)) {
      const m = /^mcp__(.+?)__/.exec(str(u.name));
      if (m) add('mcp', m[1], { name: m[1], where: 'logs', state: 'used' });
    }
    for (const m of arr(sum.models))
      add('model', m.model, { name: str(m.model), vendor: vendorOfModel(m.model), where: 'logs', state: 'used' });
  }
  // The trace explorer's sources with sessions (the gateway's own requests are not an app).
  const names = live && isObj(live.names) ? live.names : {};
  for (const s of arr(src.trace)) {
    const id = TRACE_APPS[s.id] || str(s.id);
    if (!s.ok || !(s.count > 0) || id === 'gateway' || !id) continue;
    app(id, own(names, id), 'trace', 'used');
  }
  // The gateway: providers, the models it served, keys, agents, skills, workflows and knowledge bases.
  const gw = isObj(src.gateway) ? src.gateway : null;
  if (gw) {
    for (const p of arr(gw.providers)) {
      const v = providerOf(str(p.preset || p.id));
      add('provider', p.id, {
        name: str(p.id),
        vendor: v === 'other' ? null : PROVIDER_LABELS[v],
        where: 'gateway',
        state: p.enabled === false ? 'idle' : 'configured',
        origin: originOf(p.baseUrl),
      });
    }
    // A route (router/<name>) is not a model but a choice among them; the providers it routes to are items already.
    for (const m of Array.isArray(gw.models) ? gw.models : [])
      if (typeof m === 'string' && m !== '—' && !m.startsWith('router/'))
        add('model', m, { name: m, vendor: vendorOfModel(m), where: 'gateway usage', state: 'used' });
    for (const k of arr(gw.keys)) {
      const off = !!k.revokedAt || (Number.isFinite(k.expiresAt) && k.expiresAt <= now);
      const state = off ? 'idle' : recent(k.lastUsedAt) ? 'used' : 'configured';
      add('key', k.id, { name: str(k.name) || str(k.id), where: 'gateway', state });
    }
    for (const a of arr(gw.agents))
      add('agent', a.id, {
        name: str(a.name) || str(a.id),
        where: 'gateway',
        state: a.enabled === false ? 'idle' : 'configured',
        origin: originOf(a.remoteUrl),
      });
    for (const s of arr(gw.skills)) {
      const installed = [s.claude, s.agents].some((x) => x === 'installed' || x === 'outdated');
      add('skill', s.name, {
        name: str(s.name),
        vendor: 'ZAAFPulse',
        where: 'gateway',
        state: installed ? 'configured' : 'idle',
      });
    }
    for (const w of arr(gw.workflows))
      add('workflow', w.id, { name: str(w.name) || str(w.id), where: 'gateway', state: 'configured' });
    for (const k of arr(gw.knowledge))
      add('knowledge', k.id, { name: str(k.name) || str(k.id), where: 'gateway', state: 'configured' });
  }
  // Local runtimes and desktop apps (Settings → Local models, the AI Office cards).
  for (const r of arr(src.runtimes)) {
    const id = str(r.id);
    const own = r.preset !== true;
    if (!r.running && !r.installed && !own) continue; // a preset this machine does not have
    const state = r.running ? 'running' : own ? 'configured' : 'idle';
    if (r.kind === 'app') app(id, str(r.name), 'runtimes', state);
    else add('runtime', id, { name: str(r.name) || id, vendor: VENDORS[id] || null, where: 'runtimes', state });
  }
  // Integrations, upstream MCP servers included.
  for (const i of arr(src.integrations))
    add('integration', i.id, {
      name: str(i.id),
      vendor: INTEGRATION_VENDORS[i.type] || INTEGRATION_VENDORS[i.flavor] || null,
      where: 'integrations',
      state: i.enabled === false ? 'idle' : 'configured',
      type: str(i.type) || null,
      origin: originOf(i.url),
    });
  // MCP servers in the AI clients' own config files.
  const clientRows = [];
  for (const c of arr(src.mcp)) {
    const servers = arr(c.servers);
    clientRows.push({
      client: str(c.client),
      name: str(c.name),
      file: str(c.file),
      state: str(c.state),
      servers: servers.length,
    });
    for (const s of servers)
      add('mcp', s.name, {
        name: str(s.name),
        where: `${str(c.name)} config`,
        state: 'configured',
        transport: s.transport === 'http' || s.transport === 'stdio' ? s.transport : null,
        command: typeof s.command === 'string' ? s.command : null,
        package: typeof s.package === 'string' ? s.package : null,
        origin: typeof s.origin === 'string' ? s.origin : null,
        ours: s.ours === true,
        clients: [str(c.name)],
        projects: typeof s.project === 'string' ? [s.project] : [],
      });
  }

  // Reviews, gone items and the seen dates.
  const rv = isObj(reviews) ? reviews : {};
  // seen: what the store's read() returns, { baselineDone, map }; anything else is "no file yet".
  const old = isObj(seen) && isObj(seen.map) ? seen.map : {};
  const baselineActive = !(isObj(seen) && isObj(seen.map) && seen.baselineDone === true);
  const keepSince = dayOf(now - SEEN_KEEP_DAYS * DAY_MS);
  const nextMap = {};
  for (const [id, d] of Object.entries(old))
    if (ID.test(id) && isObj(d) && DAY.test(d.first) && DAY.test(d.last) && d.last >= keepSince)
      nextMap[id] = {
        first: d.first,
        last: d.last,
        ...(STATES.includes(d.state) ? { state: d.state } : {}),
        ...(d.baseline === true ? { baseline: true } : {}),
      };
  // While the baseline is not done (no seen file yet, or a first build that missed a source), what is found now is the
  // baseline: it keeps today as its first seen but is never counted as new (inventory_unreviewed).
  for (const it of map.values()) {
    const had = nextMap[it.id];
    nextMap[it.id] = had
      ? { ...had, last: today, state: it.state }
      : { first: today, last: today, state: it.state, ...(baselineActive ? { baseline: true } : {}) };
  }
  // The baseline also ends 24 h after the seen file's first write (baselineSince) even if a source keeps failing.
  const since = isObj(seen) && Number.isFinite(seen.baselineSince) ? seen.baselineSince : now;
  const baselineDone = !baselineActive || failed.length === 0 || now - since >= DAY_MS;
  const nextSeen = { baselineDone, map: nextMap, ...(baselineDone ? {} : { baselineSince: since }) };
  // An AI client's file that could not be read hides its MCP servers: while one is unreadable, a reviewed MCP server
  // that was not found is not known to be gone either.
  const unreadableClients = clientRows.filter((c) => c.state === 'unreadable').length;
  for (const id of Object.keys(rv)) {
    const m = ID.exec(id);
    if (!m || map.has(id)) continue;
    const stale = KIND_SOURCES[m[1]].some((x) => failed.includes(x)) || (m[1] === 'mcp' && unreadableClients > 0);
    const was = (nextMap[id] || {}).state;
    map.set(id, {
      id,
      kind: m[1],
      name: m[2],
      vendor: null,
      where: [],
      state: stale ? was || 'idle' : 'gone',
      ...(stale ? { stale: true } : {}),
    });
  }
  const newSince = dayOf(now - (NEW_DAYS - 1) * DAY_MS);
  const items = [...map.values()]
    .map((it) => {
      const review = storedReview(rv[it.id]);
      const d = nextMap[it.id] || null;
      return {
        ...it,
        firstSeen: d ? d.first : null,
        lastSeen: d ? d.last : null,
        ...(d && d.baseline === true ? { baseline: true } : {}),
        review,
        status: !review ? 'unreviewed' : it.state === 'gone' ? 'gone' : 'reviewed',
      };
    })
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name, 'en'));

  const present = items.filter((i) => i.state !== 'gone');
  const isNew = (i) => !!i.firstSeen && !i.baseline && i.firstSeen >= newSince;
  // ZAAFPulse's own entry, and a skill of its catalogue that is not installed, are never new.
  const catalogue = (i) => i.kind === 'skill' && i.vendor === 'ZAAFPulse' && i.state === 'idle';
  const fresh = present.filter((i) => i.status === 'unreviewed' && !i.ours && !catalogue(i) && isNew(i));
  const risky = (r) => present.filter((i) => i.review && i.review.risk === r);
  const counts = {
    total: present.length,
    byKind: Object.fromEntries(KINDS.map((k) => [k, present.filter((i) => i.kind === k).length])),
    byState: Object.fromEntries(STATES.map((s) => [s, present.filter((i) => i.state === s).length])),
    reviewed: present.filter((i) => i.status === 'reviewed').length,
    unreviewed: present.filter((i) => i.status === 'unreviewed').length,
    gone: items.filter((i) => i.status === 'gone').length,
    unreadableClients,
    newUnreviewed: fresh.length,
    newKinds: [...new Set(fresh.map((i) => i.kind))].sort(),
    high: risky('high').length,
    unacceptable: risky('unacceptable').length,
    riskUndecided: [...risky('high'), ...risky('unacceptable')].filter((i) => !i.review.decision).length,
    unacceptableNotBlocked: risky('unacceptable').filter((i) => i.review.decision !== 'blocked').length,
  };
  return { items, counts, failed, clients: clientRows, nextSeen };
}

module.exports = {
  buildInventory,
  cleanReview,
  storedReview,
  KINDS,
  STATES,
  RISKS,
  DECISIONS,
  SOURCES,
  TEXT_MAX,
  NEW_DAYS,
};
