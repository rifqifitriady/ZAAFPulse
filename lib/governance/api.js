// The HTTP side of the governance audit log: /api/governance/*. server.js puts it behind the dashboard sign-in; no
// gateway key or MCP client reaches it (spec A9).
//   GET  /api/governance/audit?from&to&actor&action&outcome&limit&before  newest first, at most 500 per page
//   GET  /api/governance/audit/export?from&to&format=jsonl|csv          a download
//   GET  /api/governance/audit/verify                                    { ok, checked, from, to, brokenAt?, reason? }
//   GET  /api/governance/audit/status                                    retention, months, size, degraded, verify
//   POST /api/governance/settings   { audit: { retentionMonths } }       400 on a bad value, nothing written
// It also holds the daily pass (dailyPass), which reads the retention set here.
const { cleanRetention, RETENTION } = require('./audit');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
const KINDS = new Set(['dashboard', 'apikey', 'cli', 'system', 'rule']);
const KEY_ID = /^key_[A-Za-z0-9_-]{1,40}$/;
const OUTCOMES = new Set(['ok', 'refused', 'error']);

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
function createGovernanceApi({ audit, settings, log = console.error }) {
  const retention = () => {
    const g = settings.get();
    return cleanRetention(isObj(g) && isObj(g.audit) ? g.audit.retentionMonths : undefined);
  };
  function saveSettings(body) {
    const n = isObj(body) && isObj(body.audit) ? body.audit.retentionMonths : undefined;
    if (!Number.isInteger(n) || n < RETENTION.min || n > RETENTION.max)
      return reply(400, { error: `audit.retentionMonths: a whole number from ${RETENTION.min} to ${RETENTION.max}` });
    const g = settings.get();
    const cur = isObj(g) ? g : {};
    settings.save({ ...cur, audit: { ...(isObj(cur.audit) ? cur.audit : {}), retentionMonths: n } });
    return reply(200, { audit: { retentionMonths: n } });
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
  };

  // `req` is { method, path, query, contentType, readBody }. Returns { status, body, type?, headers? }, or null when
  // the path is not ours.
  async function route(req) {
    const p = req.path;
    if (p !== '/api/governance' && !p.startsWith('/api/governance/')) return null;
    const isPost = p === '/api/governance/settings';
    if (!isPost && !Object.hasOwn(GET, p)) return reply(404, { error: 'unknown route' });
    if (req.method !== (isPost ? 'POST' : 'GET')) return reply(405, { error: 'method not allowed' });
    try {
      if (!isPost) return GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody());
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      return saveSettings(body);
    } catch (e) {
      const st = e && e.status;
      // A message with a status is ours or the config writer's and holds no path; anything else is a plain 500.
      if (Number.isInteger(st) && st >= 400 && st <= 599) return reply(st, { error: e.message });
      return reply(500, { error: 'audit request failed' });
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

  return { route, retention, dailyPass };
}

module.exports = { createGovernanceApi };
