// The HTTP side of the cost ledger: /api/cost/*. server.js puts this behind the dashboard sign-in (never a gateway API
// key, MCP or A2A) and sends what `route` returns; nothing here touches the socket. Answers hold numbers, dimension
// names and ~ folders only: no file path, no transcript text. A state change needs JSON (415 otherwise).
const { PATHLIKE } = require('../monitors/api');
const { isDay, addDays, dayOf } = require('./days');
const { validate, settingsOf, normalizeGlob, SOURCES, UNASSIGNED, rateFor } = require('./rules');
const { DIMS } = require('./ledger');
const B = require('./budgets');
const views = require('./views');
const preview = require('./preview');
const { HISTORY_DAYS } = require('./anomaly');
const { recommend, spendByModel } = require('./recommend');
const X = require('./export');

const MAX_DAYS = 400;
const MAX_GROUP = 4;
const MAX_REASON = 200;
const RESTATE_FIELDS = ['from', 'to', 'reason', 'confirm'];
const RESTATE_PREVIEW_FIELDS = ['from', 'to'];
const SETTINGS_PREVIEW_FIELDS = ['settings', 'testPath'];
const PREVIEW_DAYS = 30; // the settings preview reads the last 30 days
const MAX_TEST_PATH = 1000;
const VIEW_PAGES = ['overview', 'breakdown', 'value'];
const VIEW_DAYS = 30; // a Breakdown or Value view without dates: the last 30 days
const REC_DAYS = 30; // the recommendations' spend: the last 30 days, whatever the page's range
// What the store or the billing history could not read (or set up): the data is there, just not available now.
const UNAVAILABLE = ['LEDGER_MONTH_UNREAD', 'LEDGER_CORRECTIONS_UNREAD', 'BILLING_UNREAD', 'BILLING_NOT_READY'];

const fail = (status, message) => Object.assign(new Error(message), { status });
const reply = (status, body) => ({ status, body });
// A file to download: server.js sends `type` and `headers` (Cache-Control: no-store is on every answer already).
const download = (body, type, name) => ({
  status: 200,
  body,
  type,
  headers: { 'Content-Disposition': `attachment; filename="${name}"` },
});
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
  // The Cost Control pages (sub-project 3a): tool-call accuracy per model over a range (lib/quality.js
  // accuracyByModel, memoized by server.js) and the Datasets pass rates per model (lib/cost/views.js passRates).
  accuracy = () => ({}),
  passRates = () => ({}),
  // The experiment store's list (lib/datasets/experiments.js), for the Value page's cheaper-model recommendations
  // (Cost Control 4b).
  experiments = () => [],
  // The cost_anomaly rule's saved parameters (Cost Control 4a; server.js reads the monitor state), so the Overview's
  // spike line and Anomalies card mark what the rule would. A reader that fails gives the defaults.
  anomalyParams = () => null,
  // Folder case rule of the settings preview, as the cost object's (tests pass false); the platform's otherwise.
  nocase,
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
  // Why the saved cost section does not validate, for the Settings page's banner: at most 50, scrubbed; none while
  // config.json does not parse (that is the error itself) or the section reads.
  function reasonsOf(raw, s) {
    if (!s.error || s.unreadable || raw === undefined || raw === null) return [];
    const r = validate(raw, { home });
    return r.ok ? [] : r.errors.slice(0, 50).map(scrub);
  }
  const unknownFields = (body, allowed) => {
    for (const k of Object.keys(body)) if (!allowed.includes(k)) throw fail(400, `unknown field: ${k.slice(0, 40)}`);
  };
  // The range a restate or its preview may cover: the ledger's range rules, and past days only.
  function checkRestateRange(body) {
    checkRange(body.from, body.to);
    // Today's rows follow the current prices and rules already; a correction over them would count twice.
    if (body.to >= dayOf(now()))
      throw fail(400, 'today follows the current prices and rules already; restate up to yesterday');
  }

  // POST /api/cost/settings/preview (Cost Control 3b): what an unsaved draft would move over the last 30 days, with
  // the server's own validation and glob matcher. Nothing is saved; a draft that does not validate is a 400 with its
  // reasons, as a save would be.
  function settingsPreview(body) {
    unknownFields(body, SETTINGS_PREVIEW_FIELDS);
    const raw = body.testPath;
    if (raw !== undefined && (typeof raw !== 'string' || raw.length > MAX_TEST_PATH))
      throw fail(400, `testPath: a string of at most ${MAX_TEST_PATH} characters`);
    const r = validate(body.settings, { home });
    if (!r.ok) return reply(400, { error: 'invalid cost settings', reasons: r.errors.map(scrub) });
    const to = dayOf(now());
    const from = addDays(to, -(PREVIEW_DAYS - 1));
    const led = cost.ledger({ from, to, groupBy: ['project', 'keyId'] });
    const testPath = raw && raw.trim() ? normalizeGlob(raw.trim(), home) : null;
    const out = preview.settingsPreview({
      saved: current().value,
      draft: r.value,
      rows: led.rows,
      testPath,
      keys: keys(),
      compileOpts: typeof nocase === 'boolean' ? { nocase } : undefined,
    });
    return reply(200, { from, to, unread: [...(led.unread || [])], ...out });
  }

  // The ?currency= code, null for USD; a code without rates in the cost settings is a 400.
  function checkCurrency(q) {
    const currency = q.get('currency') || null;
    if (!currency || currency === 'USD') return null;
    const c = current().value.currency;
    if (!c || c.code !== currency) throw fail(400, 'no rates for that currency; set it in the cost settings');
    return currency;
  }

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
    return { from, to, groupBy, currency: checkCurrency(q) };
  }

  // GET /api/cost/export (Cost Control 5): the ledger grouping as CSV or JSON. The range, groupBy and currency rules are
  // the ledger's and `measure` the view's; at most 100,000 rows (413 beyond).
  function exportOf(q) {
    const format = q.get('format') || 'csv';
    if (format !== 'csv' && format !== 'json') throw fail(400, 'format: csv or json');
    const measure = q.get('measure') || 'list';
    if (measure !== 'list' && measure !== 'billed') throw fail(400, 'measure: list or billed');
    const lq = ledgerQuery(q);
    const led = cost.ledger(lq);
    const rows = X.exportRows(led, { measure });
    X.checkSize(rows);
    const out = { ...lq, currency: lq.currency || 'USD', measure, rows, unread: [...(led.unread || [])] };
    if (format === 'json') return download(X.toJson(out), 'application/json', X.fileName(lq.from, lq.to, 'json'));
    return download(X.toCsv(out), 'text/csv; charset=utf-8', X.fileName(lq.from, lq.to, 'csv'));
  }

  // GET /api/cost/view: what one Cost Control page draws (lib/cost/views.js). The range rules are the ledger's;
  // Overview is always the current month. Quality inputs that fail to read leave the scatter empty, never the page.
  function viewQuery(q) {
    const page = q.get('page');
    if (!VIEW_PAGES.includes(page)) throw fail(400, `page: ${VIEW_PAGES.join(', ')}`);
    const measure = q.get('measure') || 'list';
    if (measure !== 'list' && measure !== 'billed') throw fail(400, 'measure: list or billed');
    const today = dayOf(now());
    let from = `${today.slice(0, 8)}01`;
    let to = today;
    if (page !== 'overview') {
      to = q.get('to') || today;
      if (!isDay(to)) throw fail(400, 'from and to are dates (YYYY-MM-DD)');
      from = q.get('from') || addDays(to, -(VIEW_DAYS - 1));
      checkRange(from, to);
    }
    const currency = checkCurrency(q);
    return { page, measure, from, to, today, currency, settings: current().value };
  }
  // [value, failed]: a reader that throws or answers nothing gives the fallback.
  const quietly = (fn, fallback) => {
    try {
      return [fn() || fallback, false];
    } catch {
      return [fallback, true];
    }
  };
  // The Value page's recommendations (lib/cost/recommend.js): the experiments against the usage value per model of
  // the last 30 days, a read of its own, so the page's range never changes them.
  function recommendationsFor(today) {
    const from = addDays(today, -(REC_DAYS - 1));
    const read = cost.budgetRows({ from, to: today });
    // A month that did not read would understate the spend while the card looks complete: no card then.
    if (read.unread && read.unread.length) throw new Error('ledger unread');
    const { spend, onPlan } = spendByModel(read.rows);
    return recommend({ experiments: experiments() || [], spend, onPlan, from, to: today, now: now() });
  }
  function view(q) {
    const { page, measure, from, to, today, currency, settings: s } = viewQuery(q);
    const rateOf = currency ? (day) => rateFor(s.currency, day) : null;
    const read = cost.budgetRows({ from, to });
    const unread = new Set(read.unread || []);
    let data;
    const flags = {};
    if (page === 'overview') {
      // The forecast's and the anomalies' history: the 29 days before the 1st (lib/cost/anomaly.js). A read that fails
      // leaves both out (forecastMethod and anomalies null), never the page.
      const [history] = quietly(
        () => cost.budgetRows({ from: addDays(from, -HISTORY_DAYS), to: addDays(from, -1) }),
        null,
      );
      for (const u of (history && history.unread) || []) unread.add(u);
      const [evaluated, budgetsFailed] = budgets ? quietly(() => budgets.evaluate(), []) : [[], false];
      flags.budgetsError = budgetsFailed ? 'budgets could not be read' : null;
      const [params] = quietly(() => anomalyParams(), null);
      data = views.overview({
        rows: read.rows,
        history: history ? history.rows : null,
        unread: [...unread],
        today,
        budgets: evaluated,
        rateOf,
        measure,
        currency: currency || 'USD',
        display: s.currency ? { code: s.currency.code, rate: rateFor(s.currency, today) } : null,
        planFee: typeof cost.planFeeFor === 'function' ? cost.planFeeFor : null,
        since: typeof cost.firstDay === 'function' ? cost.firstDay() : null,
        anomalyParams: params,
        keyNames: new Map(keys().map((k) => [k.id, k.name || k.id])),
      });
    } else if (page === 'breakdown') data = views.breakdown({ rows: read.rows, from, to, rateOf, measure });
    else {
      const [acc, accFailed] = quietly(() => accuracy({ from, to }), {});
      const [pass] = quietly(() => passRates({ from, to }), {});
      // A read that fails (the experiments or the 30 days of spend) gives null; the page still renders.
      const [recs] = quietly(() => recommendationsFor(today), null);
      flags.accuracyError = accFailed ? 'tool-call accuracy could not be read' : null;
      data = views.value({
        rows: read.rows,
        from,
        to,
        rateOf,
        cacheSaved: cost.cacheSaved,
        accuracy: acc,
        passRates: pass,
        recommendations: recs,
      });
    }
    return reply(200, {
      page,
      from,
      to,
      currency: currency || 'USD',
      measure: page === 'value' ? null : measure, // Value shows both measures and ignores the switch
      unread: [...unread],
      billing: { error: read.billingError ? scrub(read.billingError) : null, historyLost: !!read.historyLost },
      ...flags,
      ...data,
    });
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
    '/api/cost/export': (q) => exportOf(q),
    '/api/cost/status': () => reply(200, scrubAll(cost.status())),
    '/api/cost/settings': () => {
      const raw = settings.get();
      const s = settingsOf(raw, { home });
      return reply(200, {
        settings: s.value,
        error: s.error,
        reasons: reasonsOf(raw, s),
        sources: SOURCES,
        unassigned: UNASSIGNED,
        keys: keys(),
      });
    },
    // The restates recorded, newest first: the reasons as the owner wrote them: a reason is the owner's own text and is returned as written.
    '/api/cost/restates': () => reply(200, { restates: cost.corrections() }),
    '/api/cost/prices/versions': () => reply(200, cost.versions()),
    '/api/cost/view': (q) => view(q),
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
    '/api/cost/settings/preview': (body) => settingsPreview(body),
    // What a restate of the range would do, written nowhere: the restate's own 400, 409 and 503, without a reason.
    '/api/cost/restate/preview': (body) => {
      unknownFields(body, RESTATE_PREVIEW_FIELDS);
      checkRestateRange(body);
      const p = cost.restatePreview({ from: body.from, to: body.to });
      return reply(200, { from: p.from, to: p.to, ...preview.restateSummary(p) });
    },
    '/api/cost/restate': (body) => {
      unknownFields(body, RESTATE_FIELDS);
      checkRestateRange(body);
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
