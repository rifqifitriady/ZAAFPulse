// The HTTP side of the cost ledger: /api/cost/*. server.js puts this behind the dashboard sign-in (never a gateway API
// key, MCP or A2A) and sends what `route` returns; nothing here touches the socket. Answers hold numbers, dimension
// names and ~ folders only: no file path, no transcript text. A state change needs JSON (415 otherwise).
const { PATHLIKE } = require('../monitors/api');
const { isDay, addDays, dayOf } = require('./days');
const { validate, settingsOf, SOURCES, UNASSIGNED } = require('./rules');
const { DIMS } = require('./ledger');
const B = require('./budgets');

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

function createCostApi({
  cost,
  settings,
  listKeys = () => [],
  home = '',
  now = Date.now,
  // The budgets (Cost Control 2): the service (lib/cost/budget-service.js), where a change is written (server.js),
  // why agent control is off here (a pause budget is refused then), and what to run after any change they read.
  budgets = null,
  budgetStore = null,
  pauseOff = () => null,
  onChange = () => {},
}) {
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

  const BUDGET_DELETE = /^\/api\/cost\/budgets\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/delete$/;
  // A view keeps its ~ project folder (as the ledger rows do); only its reason, a message, is scrubbed.
  const viewOut = (v) => (v && v.reason ? { ...v, reason: scrub(v.reason) } : v);
  // Each budget the guard lets requests through for, and why (budget null: the list did not read).
  const problemsOut = (ps) =>
    (Array.isArray(ps) ? ps : []).map((p) => ({
      budget: p.budget == null ? null : String(p.budget),
      reason: scrub(p.reason),
      since: Number.isFinite(p.since) ? p.since : null,
    }));
  const changed = () => {
    try {
      onChange();
    } catch {
      /* a refresh of the budgets never fails the request */
    }
  };
  // The saved list as it is now. A change is refused while it does not validate (or config.json does not parse), so a
  // save never replaces the owner's hand edit with the last valid list.
  function savedList() {
    if (!budgets || !budgetStore) throw fail(404, 'unknown route');
    const l = budgets.list();
    if (!l.complete) throw fail(409, `${l.error}; fix config.json first`);
    return l;
  }
  // The old setting a legacy budget of this id came from: cleared in the same save (monthlyBudgetUSD) or right after
  // it (a key's budgetUSD). The saved budget wins over the old setting, so a crash in between counts it once.
  function clearsFor(l, id) {
    const old = l.legacy.find((b) => b.id === id);
    return {
      clearMonthly: !!old && old.legacy === 'monthlyBudgetUSD',
      clearKey: old && old.legacy === 'keyBudget' ? old.scope.value : null,
    };
  }
  function saveBudget(body) {
    const l = savedList();
    const s = current().value;
    const r = B.validateBudget(body, {
      currency: s.currency ? s.currency.code : null,
      centers: s.centers.map((c) => c.id),
      home,
    });
    if (!r.ok) return reply(400, { error: 'invalid budget', reasons: r.errors.map(scrub) });
    const why = r.value.enforce === 'pause' ? pauseOff() : null;
    if (why) throw fail(409, why);
    const next = [...l.saved];
    const at = next.findIndex((b) => b.id === r.value.id);
    if (at >= 0) next[at] = r.value;
    else next.push(r.value);
    if (next.length > B.LIMITS.budgets) {
      const too = `at most ${B.LIMITS.budgets} budgets`;
      return reply(400, { error: 'invalid budget', reasons: [too] });
    }
    budgetStore.save(next, clearsFor(l, r.value.id));
    changed();
    return reply(200, { budget: viewOut(budgets.evaluate().find((v) => v.id === r.value.id) || null) });
  }
  // The saved budgets that new cost settings would make invalid (a center removed, the display currency removed or
  // changed): each reason names the budget. Checked only while the list in force is the saved one; a list that does
  // not validate already is a hand edit, refused by the budget routes until it is fixed.
  function brokenBy(v) {
    if (!budgets) return [];
    const l = budgets.list();
    if (!l.complete) return [];
    const ctx = { currency: v.currency ? v.currency.code : null, centers: v.centers.map((c) => c.id), home };
    const out = [];
    for (const b of l.saved) {
      const r = B.validateBudget(b, ctx);
      if (!r.ok) for (const e of r.errors) out.push(scrub(`budget ${b.id}: ${e}`));
    }
    return out.slice(0, 50);
  }
  function deleteBudget(id) {
    const l = savedList();
    const clears = clearsFor(l, id);
    if (!l.saved.some((b) => b.id === id) && !clears.clearMonthly && !clears.clearKey)
      throw fail(404, 'unknown budget');
    budgetStore.save(
      l.saved.filter((b) => b.id !== id),
      clears,
    );
    changed();
    return reply(200, { deleted: id });
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
    '/api/cost/budgets': () => {
      if (!budgets) throw fail(404, 'unknown route');
      const st = budgets.status();
      return reply(200, {
        budgets: budgets.evaluate().map(viewOut),
        error: st.error && scrub(st.error),
        reasons: st.reasons.map(scrub),
        guard: { error: st.guard && scrub(st.guard), problems: problemsOut(st.guardProblems) },
        kept: { error: st.kept && scrub(st.kept) },
      });
    },
  };
  const POST = {
    '/api/cost/settings': (body) => {
      const r = validate(body, { home });
      if (!r.ok) return reply(400, { error: 'invalid cost settings', reasons: r.errors.map(scrub) });
      // A settings save never leaves the saved budgets invalid: the budget routes could not change them then.
      const broken = brokenBy(r.value);
      if (broken.length)
        return reply(409, { error: 'budgets depend on these settings; edit or delete them first', reasons: broken });
      // Budgets are saved through their own routes: a settings save keeps the list as it is.
      const raw = settings.get();
      settings.save(isObject(raw) && raw.budgets !== undefined ? { ...r.value, budgets: raw.budgets } : r.value);
      cost.retag(); // today's rows take the new centers and billing now, not at the next pass
      changed();
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
      changed();
      return reply(200, { correction, overrides });
    },
    '/api/cost/budgets': (body) => saveBudget(body),
  };

  async function route(req) {
    const p = req.path;
    if (p !== '/api/cost' && !p.startsWith('/api/cost/')) return null;
    const del = p.match(BUDGET_DELETE);
    const get = Object.hasOwn(GET, p);
    const post = Object.hasOwn(POST, p) || !!del;
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
      if (del) return deleteBudget(del[1]);
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
