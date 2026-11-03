// The HTTP side of the governance audit log: /api/governance/*. server.js puts it behind the dashboard sign-in; no
// gateway key or MCP client reaches it (spec A9).
//   GET  /api/governance/audit?from&to&actor&action&outcome&limit&before  newest first, at most 500 per page
//   GET  /api/governance/audit/export?from&to&format=jsonl|csv          a download
//   GET  /api/governance/audit/verify                                    { ok, checked, from, to, brokenAt?, reason? }
//   GET  /api/governance/audit/status                                    retention, months, size, degraded, verify
//   POST /api/governance/settings   { audit: { retentionMonths } }       400 on a bad value, nothing written
//   GET  /api/governance/inventory                                       the AI inventory (AI Governance 3)
//   POST /api/governance/inventory  { id, owner, purpose, risk, decision, note } | { id, clear: true }
//   GET  /api/governance/controls                                        the controls with status, evidence, clauses
// It also holds the daily pass (dailyPass), which reads the retention set here, and builds the inventory from the
// sources server.js gathers (the reviews are config.json "governance.inventory", the seen dates a store of their own).
const { cleanRetention, RETENTION } = require('./audit');
const { buildInventory, cleanReview } = require('./inventory');
const { controls, CLAUSES, FRAMEWORKS, NOTICE } = require('./controls');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const KINDS = new Set(['dashboard', 'apikey', 'cli', 'system', 'rule']);
const KEY_ID = /^key_[A-Za-z0-9_-]{1,40}$/;
const OUTCOMES = new Set(['ok', 'refused', 'error']);
const MAX_REVIEWS = 2000;
const SOURCES_TTL_MS = 5000; // the sources are read again at most this often; the reviews on every build

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const fail = (status, message) => Object.assign(new Error(message), { status });

// A time from the query: YYYY-MM-DD (UTC; the end of that day for `to`) or an ISO time; null when absent.
function timeOf(name, v, end) {
  if (v == null || v === '') return null;
  if (DAY.test(v)) {
    const t = Date.parse(`${v}T00:00:00.000Z`);
    if (Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v) return end ? t + 864e5 - 1 : t;
  } else if (ISO.test(v) && Number.isFinite(Date.parse(v))) return Date.parse(v);
  throw fail(400, `${name}: a date (YYYY-MM-DD) or an ISO time`);
}
function rangeOf(q) {
  const from = timeOf('from', q.get('from'), false);
  const to = timeOf('to', q.get('to'), true);
  if (from !== null && to !== null && from > to) throw fail(400, 'from is after to');
  return { from, to };
}
// The list query, every value checked.
function listQuery(q) {
  const out = rangeOf(q);
  const actor = q.get('actor');
  if (actor) {
    if (!KINDS.has(actor) && !KEY_ID.test(actor))
      throw fail(400, 'actor: dashboard, apikey, cli, system, rule or a key id');
    out.actor = actor;
  }
  const action = q.get('action');
  if (action) {
    if (action.length > 80) throw fail(400, 'action: at most 80 characters');
    out.action = action;
  }
  const outcome = q.get('outcome');
  if (outcome) {
    if (!OUTCOMES.has(outcome)) throw fail(400, 'outcome: ok, refused or error');
    out.outcome = outcome;
  }
  const limit = q.get('limit');
  if (limit) {
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 500)
      throw fail(400, 'limit: a whole number from 1 to 500');
    out.limit = Number(limit);
  }
  const before = q.get('before');
  if (before) {
    if (!/^\d{1,15}$/.test(before) || Number(before) < 1) throw fail(400, 'before: a whole number from 1');
    out.before = Number(before);
  }
  return out;
}

// settings: { get() -> config.json "governance" (or undefined), save(value) } (server.js saveConfigSection).
// log(message): where the daily pass reports a step that failed.
// sources(): a Promise of the inventory sources (lib/governance/inventory.js buildInventory); seen: { read() ->
// { exists, baselineDone, map }, write({ baselineDone, map }) } (lib/governance/seen.js). controlState(): a Promise of
// the parts of lib/governance/controls.js state that server.js reads (everything but now, audit and inventory, which
// come from here).
function createGovernanceApi({
  audit,
  settings,
  sources = async () => ({}),
  seen = { read: () => ({ exists: false, baselineDone: false, map: {} }), write: () => false },
  controlState = async () => ({}),
  now = Date.now,
  log = console.error,
}) {
  const governance = () => {
    const g = settings.get();
    return isObj(g) ? g : {};
  };
  const retention = () => {
    const g = governance();
    return cleanRetention(isObj(g.audit) ? g.audit.retentionMonths : undefined);
  };
  const reviews = () => (isObj(governance().inventory) ? governance().inventory : {});
  function saveSettings(body) {
    const n = isObj(body) && isObj(body.audit) ? body.audit.retentionMonths : undefined;
    if (!Number.isInteger(n) || n < RETENTION.min || n > RETENTION.max)
      return reply(400, { error: `audit.retentionMonths: a whole number from ${RETENTION.min} to ${RETENTION.max}` });
    const cur = governance();
    settings.save({ ...cur, audit: { ...(isObj(cur.audit) ? cur.audit : {}), retentionMonths: n } });
    return reply(200, { audit: { retentionMonths: n } });
  }

  // The inventory: the sources at most every 5 s (one read at a time), the reviews and the seen dates on every build.
  // The seen dates are saved when they changed; a store that cannot be written never fails the page. The last counts
  // are kept for the Monitors rule inventory_unreviewed.
  let cache = { at: 0, value: null, pending: null };
  let lastCounts = null;
  let generation = 0;
  function readSources() {
    if (cache.value && now() - cache.at < SOURCES_TTL_MS) return Promise.resolve(cache.value);
    if (!cache.pending) {
      const gen = generation;
      cache.pending = Promise.resolve()
        .then(sources)
        .then((v) => {
          // A read that began before an invalidation is used once but not kept.
          if (gen === generation) cache = { at: now(), value: v, pending: null };
          return v;
        })
        .finally(() => {
          if (gen === generation) cache.pending = null;
        });
    }
    return cache.pending;
  }
  // The next inventory read goes to the sources again (after a change made through the dashboard).
  function invalidateInventory() {
    generation++;
    cache = { at: 0, value: null, pending: null };
  }
  async function inventory() {
    const src = await readSources();
    const t = now();
    let dates;
    try {
      dates = seen.read();
    } catch {
      // A store that cannot be read is treated like a damaged file: loud, every item counts as new.
      dates = { exists: true, baselineDone: true, map: {} };
    }
    const inv = buildInventory(src, reviews(), dates, t);
    lastCounts = inv.counts;
    const saveFailed = (e) =>
      log(`governance: the inventory dates could not be saved (${(e && (e.code || e.name)) || 'error'})`);
    try {
      if (seen.write(inv.nextSeen) === 'failed') saveFailed(null);
    } catch (e) {
      saveFailed(e);
    }
    return {
      generatedAt: new Date(t).toISOString(),
      items: inv.items,
      counts: inv.counts,
      failed: inv.failed,
      clients: inv.clients,
    };
  }
  // The controls: the state server.js reads, the audit log's state and retention, and the inventory's counts.
  async function controlsView() {
    const t = now();
    const [st, inv] = await Promise.all([controlState(), inventory()]);
    let auditState = null;
    try {
      auditState = { retentionMonths: retention(), ...audit.status() };
    } catch {
      auditState = null;
    }
    return {
      generatedAt: new Date(t).toISOString(),
      notice: NOTICE,
      frameworks: FRAMEWORKS,
      clauses: CLAUSES,
      controls: controls({ ...(st || {}), now: t, audit: auditState, inventory: inv.counts }),
    };
  }
  // A review saved into config.json governance.inventory (every save is a config.change entry), or cleared.
  function saveReview(body) {
    const r = cleanReview(body);
    if (r.errors.length) return reply(400, { error: r.errors[0], errors: r.errors });
    const cur = governance();
    const list = { ...reviews() };
    if (r.value === null) {
      if (!Object.hasOwn(list, r.id)) return reply(200, { id: r.id, review: null });
      delete list[r.id];
    } else {
      if (!Object.hasOwn(list, r.id) && Object.keys(list).length >= MAX_REVIEWS)
        return reply(400, { error: `inventory: at most ${MAX_REVIEWS} reviews` });
      list[r.id] = { ...r.value, reviewedAt: new Date(now()).toISOString() };
    }
    settings.save({ ...cur, inventory: list });
    return reply(200, { id: r.id, review: list[r.id] || null });
  }
  function exportOf(q) {
    const format = q.get('format') || 'csv';
    if (format !== 'csv' && format !== 'jsonl') throw fail(400, 'format: jsonl or csv');
    const x = audit.export({ ...rangeOf(q), format });
    return {
      status: 200,
      body: x.body,
      type: x.type,
      headers: { 'Content-Disposition': `attachment; filename="${x.name}"` },
    };
  }
  const GET = {
    '/api/governance/audit': (q) => reply(200, audit.list(listQuery(q))),
    '/api/governance/audit/export': exportOf,
    '/api/governance/audit/verify': () => reply(200, audit.verify()),
    '/api/governance/audit/status': () => reply(200, { retentionMonths: retention(), ...audit.status() }),
    '/api/governance/inventory': async () => reply(200, await inventory()),
    '/api/governance/controls': async () => reply(200, await controlsView()),
  };
  const POST = {
    '/api/governance/settings': saveSettings,
    '/api/governance/inventory': saveReview,
  };

  // `req` is { method, path, query, contentType, readBody }. Returns { status, body, type?, headers? }, or null when
  // the path is not ours.
  async function route(req) {
    const p = req.path;
    if (p !== '/api/governance' && !p.startsWith('/api/governance/')) return null;
    if (!Object.hasOwn(GET, p) && !Object.hasOwn(POST, p)) return reply(404, { error: 'unknown route' });
    const isPost = req.method === 'POST' && Object.hasOwn(POST, p);
    if (!isPost && !(req.method === 'GET' && Object.hasOwn(GET, p))) return reply(405, { error: 'method not allowed' });
    try {
      if (!isPost) return await GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody());
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      return POST[p](body);
    } catch (e) {
      const st = e && e.status;
      // A message with a status is ours or the config writer's and holds no path; anything else is a plain 500.
      if (Number.isInteger(st) && st >= 400 && st <= 599) return reply(st, { error: e.message });
      return reply(500, {
        error: p === '/api/governance/inventory' ? 'inventory request failed' : 'audit request failed',
      });
    }
  }

  // The daily pass (server.js runs it at start and every 24 hours, as the system): the CLI's events, the months past
  // the retention, then a check of the chain. Each step on its own, so one that fails never skips the verify the
  // Monitors read; a failure is logged by its code or kind only (a message may hold a path).
  function dailyPass() {
    const steps = [
      ['importPending', () => audit.importPending()],
      ['prune', () => audit.prune(retention())],
      ['verify', () => audit.verify()],
    ];
    for (const [name, run] of steps) {
      try {
        run();
      } catch (e) {
        try {
          log(`audit: the daily pass failed at ${name} (${(e && (e.code || e.name)) || 'error'})`);
        } catch {
          /* logging must not stop the pass */
        }
      }
    }
  }

  // The Monitors rule inventory_unreviewed: the counts of the last build (no names), or null before the first.
  const inventoryStatus = () =>
    lastCounts ? { newUnreviewed: lastCounts.newUnreviewed, newKinds: lastCounts.newKinds } : null;

  return { route, retention, dailyPass, inventory, inventoryStatus, invalidateInventory, controls: controlsView };
}

module.exports = { createGovernanceApi };
