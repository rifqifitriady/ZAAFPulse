// The HTTP side of the cost ledger: /api/cost/*. server.js puts this behind the dashboard sign-in (never a gateway API
// key, MCP or A2A) and sends what `route` returns; nothing here touches the socket. Answers hold numbers, dimension
// names and ~ folders only: no file path, no transcript text. A state change needs JSON (415 otherwise).
const { PATHLIKE } = require('../monitors/api');
const { isDay, addDays, dayOf } = require('./days');
const { validate, settingsOf, SOURCES, UNASSIGNED } = require('./rules');
const { DIMS } = require('./ledger');

const MAX_DAYS = 400;
const MAX_GROUP = 4;
const MAX_REASON = 200;
const RESTATE_FIELDS = ['from', 'to', 'reason', 'confirm'];
// What the store or the billing history could not read (or set up): the data is there, just not available now.
const UNAVAILABLE = ['LEDGER_MONTH_UNREAD', 'LEDGER_CORRECTIONS_UNREAD', 'BILLING_UNREAD', 'BILLING_NOT_READY'];

const fail = (status, message) => Object.assign(new Error(message), { status });
const reply = (status, body) => ({ status, body });
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function checkRange(from, to) {
  if (!isDay(from) || !isDay(to)) throw fail(400, 'from and to are dates (YYYY-MM-DD)');
  if (from > to) throw fail(400, 'from must be on or before to');
  if (addDays(from, MAX_DAYS) <= to) throw fail(400, `at most ${MAX_DAYS} days at a time`);
}

function createCostApi({ cost, settings, listKeys = () => [], home = '', now = Date.now }) {
  const scrub = (m) => {
    let s = String(m == null ? '' : m);
    if (home && home.length > 1) s = s.split(home).join('~');
    // A home-relative path keeps its separators after ~: backslashes on Windows, which PATHLIKE does not see.
    s = s.replace(/~[\\/][^\s"'`]*/g, '[path]');
    return s.replace(PATHLIKE, '[path]').slice(0, 300);
  };
  // The status holds fixed phrases and names only; every string still goes through the scrub, so no path can slip out.
  const scrubAll = (v) =>
    typeof v === 'string'
      ? scrub(v)
      : Array.isArray(v)
        ? v.map(scrubAll)
        : isObject(v)
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubAll(x)]))
          : v;
  const current = () => settingsOf(settings.get(), { home });

  function ledgerQuery(q) {
    const to = q.get('to') || dayOf(now());
    if (!isDay(to)) throw fail(400, 'from and to are dates (YYYY-MM-DD)');
    const from = q.get('from') || `${to.slice(0, 8)}01`;
    checkRange(from, to);
    const raw = q.get('groupBy');
    const groupBy = (raw ? raw : 'day')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!groupBy.length || groupBy.length > MAX_GROUP)
      throw fail(400, `groupBy: 1 to ${MAX_GROUP} of ${DIMS.join(', ')}`);
    for (const d of groupBy) if (!DIMS.includes(d)) throw fail(400, `groupBy: unknown dimension ${d.slice(0, 40)}`);
    if (new Set(groupBy).size !== groupBy.length) throw fail(400, 'groupBy: a dimension is named twice');
    let currency = q.get('currency') || null;
    if (currency === 'USD') currency = null;
    if (currency) {
      const c = current().value.currency;
      if (!c || c.code !== currency) throw fail(400, 'no rates for that currency; set it in the cost settings');
    }
    return { from, to, groupBy, currency };
  }

  function keys() {
    try {
      return (listKeys() || []).map((k) => ({ id: String(k.id), name: String(k.name || '').slice(0, 60) }));
    } catch {
      return [];
    }
  }

  const GET = {
    '/api/cost/ledger': (q) => {
      const r = cost.ledger(ledgerQuery(q));
      // Named explicitly: what the range read skipped must reach the page, and a non-enumerable property would not.
      return reply(200, {
        ...r,
        unread: [...(r.unread || [])],
        billing: r.billing ? scrubAll(r.billing) : { error: null, historyLost: false },
      });
    },
    '/api/cost/status': () => reply(200, scrubAll(cost.status())),
    '/api/cost/settings': () => {
      const s = current();
      return reply(200, { settings: s.value, error: s.error, sources: SOURCES, unassigned: UNASSIGNED, keys: keys() });
    },
    '/api/cost/prices/versions': () => reply(200, cost.versions()),
  };
  const POST = {
    '/api/cost/settings': (body) => {
      const r = validate(body, { home });
      if (!r.ok) return reply(400, { error: 'invalid cost settings', reasons: r.errors });
      settings.save(r.value);
      cost.retag(); // today's rows take the new centers and billing now, not at the next pass
      return reply(200, { settings: r.value });
    },
    '/api/cost/restate': (body) => {
      for (const k of Object.keys(body))
        if (!RESTATE_FIELDS.includes(k)) throw fail(400, `unknown field: ${k.slice(0, 40)}`);
      checkRange(body.from, body.to);
      // Today's rows follow the current prices and rules already; a correction over them would count twice.
      if (body.to >= dayOf(now()))
        throw fail(400, 'today follows the current prices and rules already; restate up to yesterday');
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason || reason.length > MAX_REASON) throw fail(400, `reason: 1 to ${MAX_REASON} characters`);
      // The cost object does not ask: a restate rewrites how a past range reads, so the route makes the caller say so.
      if (body.confirm !== true) throw fail(400, 'a restate needs confirm: true');
      const correction = cost.restate({ from: body.from, to: body.to, reason });
      // The overrides this restate wrote: an earlier one of the same range was covered by them and dropped.
      const history = typeof cost.billingHistory === 'function' ? cost.billingHistory() : null;
      const overrides = ((history && history.overrides) || []).filter((o) => o.from === body.from && o.to === body.to);
      return reply(200, { correction, overrides });
    },
  };

  async function route(req) {
    const p = req.path;
    if (p !== '/api/cost' && !p.startsWith('/api/cost/')) return null;
    const get = Object.hasOwn(GET, p);
    const post = Object.hasOwn(POST, p);
    if (!get && !post) return reply(404, { error: 'unknown route' });
    if (!((get && req.method === 'GET') || (post && req.method === 'POST')))
      return reply(405, { error: 'method not allowed' });
    try {
      if (req.method === 'GET') return GET[p](req.query);
      // A state change needs JSON, so a simple cross-site form post cannot make one.
      if (!(req.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
      let body;
      try {
        body = JSON.parse(await req.readBody());
      } catch (e) {
        return reply(e && e.message === 'too large' ? 413 : 400, { error: 'bad request body' });
      }
      if (!isObject(body)) return reply(400, { error: 'bad request body' });
      return POST[p](body);
    } catch (e) {
      if (e && UNAVAILABLE.includes(e.code)) return reply(503, { error: scrub(e.message), code: e.code });
      const st = e && e.status;
      if (Number.isInteger(st) && st >= 400 && st <= 599) return reply(st, { error: scrub(e.message) });
      return reply(500, { error: 'cost request failed' });
    }
  }

  return { route };
}

module.exports = { createCostApi };
