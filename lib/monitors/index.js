// The monitor engine. Two passes build a snapshot, run the rules on it (rules.js), hand the results to the state
// machine (state.js), send its alerts through the channels (channels.js) and, for the rules where the owner turned it
// on, pause the agent behind the session (lib/agents/control.js).
//  - The aggregate pass runs after every index refresh: today's and this month's cost, accuracy, eval pass rates and
//    the safety and loop signals. It also keeps what the live pass needs from the index: the usage rows of the last
//    10 minutes, and each recent session's working folder and first line.
//  - The live pass runs every 5 s on the AI Office snapshot, for the sessions that are running. Its cost per session
//    comes from those index rows, so it is as fresh as the last refresh (about a minute), not truly live.
// Nothing here sends text from a log: the snapshot keeps numbers, states, ids and the masked project name, which is
// the session title in a notification. Demo mode evaluates the synthetic data but never notifies, pauses or reads
// the process table.
const { RULES, evaluate } = require('./rules');
const { maskTitle } = require('../trace/model');
const realAggregate = require('../aggregate');
const realQuality = require('../quality');
const { makePricer, eventParts, DEFAULT_PRICING, normalizeModel } = require('../pricing');
const { projectOf } = require('../cost/collect');
const { periodBounds } = require('../cost/budgets');
const { dayOf, isDay } = require('../cost/days');

const MIN = 60e3;
const DAY = 24 * 60 * MIN;
const LIVE_WINDOW_MS = 10 * MIN;
const SIGNAL_MIN = 60; // signals kept for the rules: an hour, or the unsafe_content window when that is longer
const SIGNAL_KINDS = new Set(['loop', 'secret', 'injection']);
const IDLE = new Set(['idle', 'done']);
const AUTO_PAUSE = new Set(['daily_cost', 'cost_burn', 'tool_loop']);
// A live session not seen for this long (12 live passes) has ended: it leaves the rule cards and the counts. Its
// state and alert history stay as they are (no resolution is sent; the state store prunes it after a day).
const LIVE_STALE_MS = 60_000;
const LIVE_RULES = new Set(RULES.filter((r) => r.kind === 'live').map((r) => r.id));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const startOfDay = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const keyOf = (rule, instance) => `${rule}|${instance}`;
// A state row (state.states()) of a live session that ended. An aggregate instance ('all') never ends.
const ended = (s, t) =>
  LIVE_RULES.has(s.rule) && s.instance !== 'all' && isNum(t) && !(isNum(s.lastSeen) && s.lastSeen >= t - LIVE_STALE_MS);

function createMonitors({
  indexer,
  office,
  evals,
  quality = realQuality,
  aggregate = realAggregate,
  config = () => ({}),
  state,
  channels,
  control,
  now = Date.now,
  log = () => {},
  demo = false,
  platform = process.platform,
  // Cost budgets (lib/cost/budget-service.js): { evaluate(), complete(), centerOfProject(project) } and, for a billed
  // budget's pause, the optional billingMode(source, day) ('plan' | 'metered' | null); or null.
  budgets = null,
  // Rule ids replaced by budgets (server.js passes daily_cost and month_projection): never evaluated or acted on.
  retired = [],
  // The home folder, to write a session's folder as the ledger does (~/…) for project and center budgets.
  home = '',
} = {}) {
  const safeLog = (message) => {
    try {
      log(message);
    } catch {
      /* logging must not break a pass */
    }
  };
  const cfg = () => {
    try {
      return config() || {};
    } catch {
      return {};
    }
  };
  const RETIRED = new Set(retired);

  // What the aggregate pass learned; the live pass reads it. `usage` and `sessionInfo` stay inside the engine.
  let agg = null; // { ts, budget, today, month, accuracy, evals, signals, usage, sessionInfo, costly }
  let live = null; // { ts, sessions }
  let lastAggregate = null;
  let lastLive = null;
  const running = { aggregate: null, live: null };
  // Which trigger episodes were acted on is kept by the state store (saved with the states). These two are memory only:
  // - the episodes (rule|instance) whose passing problem was already reported: no running session for daily_cost,
  //   a session not indexed yet, or a process list that could not be read. Such a problem does not use up the
  //   episode, so a later pass tries again; it is reported once per episode, not on every pass.
  // - the episodes being looked up right now, so the live and aggregate passes never look up one twice at once.
  const reported = new Set();
  const busy = new Set();
  let budgetViews = []; // the budgets as last evaluated: their scope and enforce, for the pause
  let budgetRunning = null;
  let budgetAgain = null; // one more budget pass, asked for while one ran

  const results = () => {
    const r = indexer && typeof indexer.results === 'function' ? indexer.results() : [];
    return Array.isArray(r) ? r.filter((x) => x && typeof x === 'object') : [];
  };

  function settingsOf(ruleId) {
    try {
      return state.settings(ruleId);
    } catch {
      return { enabled: false, params: {}, autoPause: false };
    }
  }

  // ---- the aggregate snapshot ----
  function buildAggregate(t) {
    const c = cfg();
    const pricing = c.pricing && typeof c.pricing === 'object' ? c.pricing : DEFAULT_PRICING;
    const res = results();
    const out = {
      ts: t,
      budget: { monthlyUSD: isNum(c.monthlyBudgetUSD) ? c.monthlyBudgetUSD : null },
      today: null,
      month: null,
      accuracy: null,
      evals: null,
      signals: null,
      usage: null,
      sessionInfo: new Map(),
      costly: [],
      spend: null, // key -> { tool, project, cells: Map('day|model' -> list cost) }, for a budget's pause (spendOf)
      buildSpend: null,
    };
    // Each part on its own: one that fails is missing (no_data for its rules), the others still count.
    const part = (name, fn) => {
      try {
        fn();
      } catch (err) {
        safeLog(`monitors: could not read ${name}: ${err && err.message}`);
      }
    };
    let sessions = new Map();
    part('the sessions', () => {
      sessions = aggregate.mergeSessions(res);
      for (const [k, s] of sessions) {
        // The working folder and first line of each session seen in the last day: what candidates() matches on.
        if (!(s.last >= t - DAY)) continue;
        out.sessionInfo.set(k, { cwd: typeof s.project === 'string' ? s.project : null, first: s.first });
      }
    });
    part('the cost', () => {
      const sum = aggregate.summarize(res, { rangeDays: 1, pricing, now: t });
      out.today = { cost: sum.kpis.cost };
      out.month = { cost: sum.kpis.monthCost, projection: sum.month.projected };
      // Today's sessions by cost, for the daily_cost pause, which goes to the costliest one still running. The 300
      // most recent sessions are enough: a running session is among the most recent.
      out.costly = (Array.isArray(sum.sessions) ? sum.sessions : [])
        .filter((s) => s && s.cost > 0)
        .sort((a, b) => b.cost - a.cost)
        .map((s) => ({ key: `${s.tool}:${s.id}`, sid: s.id }));
    });
    // Each session's list cost by day and model since the earliest current budget period (this month's or this
    // week's start): a budget's pause ranks the running sessions by their cost in its own scope and period. Pricing
    // every event of the month is costly, so it is built on first use (spendOf), only when a budget has to pause.
    if (budgets)
      out.buildSpend = () => {
        const spend = new Map();
        const since = Math.min(periodBounds('month', t).start, periodBounds('week', t).start);
        const recent = [];
        for (const r of res) for (const e of r.events || []) if (Array.isArray(e) && e[0] >= since) recent.push(e);
        const pricer = makePricer(pricing);
        for (const e of aggregate.dedupeEvents([{ events: recent }], sessions)) {
          const p = eventParts(pricer, e);
          const cost = p[0] + p[1] + p[2] + p[3] + p[4];
          if (!(cost > 0)) continue;
          const key = `${e[1]}:${e[2]}`;
          let x = spend.get(key);
          if (!x) {
            const info = sessions.get(key);
            const project = info && typeof info.project === 'string' ? info.project : null;
            x = { tool: e[1], project, cells: new Map() };
            spend.set(key, x);
          }
          const cell = `${dayOf(e[0])}|${normalizeModel(e[3])}`;
          x.cells.set(cell, (x.cells.get(cell) || 0) + cost);
        }
        return spend;
      };
    part('the accuracy', () => {
      const start = startOfDay(t);
      const q = quality.summarizeQuality(res, sessions, { start, end: t, prevStart: start - 7 * DAY });
      // The result counts let accuracy_drop ignore a rate that rests on a handful of results.
      out.accuracy = {
        today: q.accuracy,
        prev7: q.prevAccuracy,
        todayResults: q.results,
        prev7Results: q.prevResults,
      };
    });
    part('the evals', () => {
      if (!evals || typeof evals.summary !== 'function') return;
      const s = evals.summary({ from: t - DAY });
      const ev = {};
      for (const [id, e] of Object.entries((s && s.evaluators) || {})) ev[id] = { pass: e.pass, total: e.total };
      out.evals = ev;
    });
    part('the signals', () => {
      const w = Number(settingsOf('unsafe_content').params.windowMin);
      const since = t - Math.max(SIGNAL_MIN, isNum(w) && w > 0 ? w : 0) * MIN;
      const list = [];
      for (const r of res) {
        const events = r.signals && Array.isArray(r.signals.events) ? r.signals.events : [];
        for (const e of events) {
          if (!e || !SIGNAL_KINDS.has(e.kind) || !isNum(e.ts) || e.ts < since) continue;
          // Only what the rules read: the text and label of a signal stay in the index.
          list.push({ ts: e.ts, sid: e.sid, tool: e.tool, kind: e.kind, external: e.external === true });
        }
      }
      out.signals = list;
    });
    part('the recent usage', () => {
      // Rows older than 10 minutes now are older than 10 minutes at every later live pass too, so this is all the
      // live pass needs until the next refresh. Copies of the same response are counted once, as on the dashboard.
      const since = t - LIVE_WINDOW_MS;
      const recent = [];
      for (const r of res) for (const e of r.events || []) if (Array.isArray(e) && e[0] > since) recent.push(e);
      const pricer = makePricer(pricing);
      out.usage = aggregate.dedupeEvents([{ events: recent }], sessions).map((e) => {
        const p = eventParts(pricer, e);
        return { ts: e[0], key: `${e[1]}:${e[2]}`, cost: p[0] + p[1] + p[2] + p[3] + p[4] };
      });
    });
    return out;
  }

  // ---- the live snapshot ----
  // The office names a Claude Code session claude:<sid> and a Codex one codex:<file name>, which ends with the
  // session id the index uses.
  function sidOf(agent) {
    const id = typeof agent.id === 'string' ? agent.id : '';
    const at = id.indexOf(':');
    if (at < 1) return null;
    const tool = id.slice(0, at);
    let sid = id.slice(at + 1);
    if (!sid) return null;
    if (tool === 'codex' && agg && !agg.sessionInfo.has(`codex:${sid}`)) {
      for (const k of agg.sessionInfo.keys()) {
        if (k.startsWith('codex:') && k.length > 6 && sid.endsWith(k.slice(6))) {
          sid = k.slice(6);
          break;
        }
      }
    }
    return { tool, sid };
  }

  function buildLive(t) {
    const snap = demo ? office.demoSnapshot(t) : office.snapshot(t);
    const agents = snap && Array.isArray(snap.agents) ? snap.agents : [];
    const sessions = [];
    for (const a of agents) {
      // Sessions only (a subagent's usage is in its parent's session), and only the running ones.
      if (!a || a.kind === 'subagent' || IDLE.has(a.state)) continue;
      const id = sidOf(a);
      if (!id) continue;
      const key = `${id.tool}:${id.sid}`;
      let cost10m = null;
      if (agg && agg.usage) {
        cost10m = 0;
        for (const u of agg.usage) if (u.key === key && u.ts > t - LIVE_WINDOW_MS) cost10m += u.cost;
      }
      sessions.push({
        sid: id.sid,
        tool: id.tool,
        key,
        state: a.state,
        lastTs: a.lastTs,
        title: maskTitle(a.project) || undefined,
        cost10m,
        toolCallsTurn: null, // neither the office nor the index counts tool calls per turn
      });
    }
    return { ts: t, sessions };
  }

  // The snapshot the rules see: the aggregate part, the live sessions and the signals both use.
  const ruleSnap = () => {
    const monthly = cfg().monthlyBudgetUSD;
    return {
      budget: agg ? agg.budget : { monthlyUSD: isNum(monthly) ? monthly : null },
      today: agg && agg.today,
      month: agg && agg.month,
      accuracy: agg && agg.accuracy,
      evals: agg && agg.evals,
      signals: agg && agg.signals,
      sessions: live ? live.sessions : undefined,
    };
  };

  // ---- after a pass ----
  async function run(kind, t) {
    const snap = ruleSnap();
    for (const rule of RULES) {
      if (rule.kind !== kind || RETIRED.has(rule.id)) continue;
      const s = settingsOf(rule.id);
      if (!s.enabled) continue;
      let alerts = [];
      try {
        alerts = state.apply(rule.id, evaluate(rule, s.params, snap, t)) || [];
      } catch (err) {
        safeLog(`monitors: ${rule.id} could not be evaluated: ${err && err.message}`);
        continue;
      }
      for (const alert of alerts) send(alert);
    }
    await autoPauseDue();
    await autoPauseBudgets(); // a budget waiting for a live pass acts on it
  }

  // Not awaited: a webhook may take a while to give up, and channels bound a burst themselves. A pause outcome goes
  // the same way; channels.js gives it fixed words and keeps it off the webhook.
  function send(alert) {
    if (demo || !channels || !alert) return;
    try {
      Promise.resolve(channels.notify(alert, { title: alert.title })).catch((err) =>
        safeLog(`monitors: an alert could not be sent: ${err && err.message}`),
      );
    } catch (err) {
      safeLog(`monitors: an alert could not be sent: ${err && err.message}`);
    }
  }

  // Record the outcome next to the alerts and notify it. `code` picks the fixed desktop words (channels.js).
  function outcome(ruleId, p, target, ok, code, reason) {
    let row = null;
    try {
      row = state.note({
        rule: ruleId,
        instance: p.instance,
        sessionId: target ? target.sid : p.sessionId,
        value: p.value,
        threshold: p.threshold,
        title: (target && target.title) || p.title,
        action: 'pause',
        ok,
        code,
        reason,
      });
    } catch (err) {
      safeLog(`monitors: could not record a pause: ${err && err.message}`);
    }
    send(row);
  }

  // Whether a session is in a budget's scope as a whole (a model scope is checked per model, in scopedCost). A project
  // or a center needs the home folder, to write the session's folder as the ledger does; without it those scopes
  // match nothing (nothing is paused, and actOn says why).
  function inBudgetScope(scope, c) {
    if (scope === 'global') return true;
    if (!scope || typeof scope !== 'object') return false;
    const project = home && c.project ? projectOf(c.project, home) : null;
    if (scope.dim === 'source') return c.tool === scope.value;
    if (scope.dim === 'project') return project !== null && project === scope.value;
    if (scope.dim === 'model') return true;
    if (scope.dim === 'center') {
      if (project === null || !budgets) return false;
      try {
        return budgets.centerOfProject(project) === scope.value;
      } catch {
        return false;
      }
    }
    return false; // key, provider: no local session behind them
  }

  // A budget's period as days: the view's own, else from its period name.
  function periodOf(b) {
    if (isDay(b.from) && isDay(b.to)) return { from: b.from, to: b.to };
    const t = now();
    return isNum(t) && ['day', 'week', 'month'].includes(b.period) ? periodBounds(b.period, t) : null;
  }

  // What a session spent in a budget's scope and period, in the budget's measure: billed counts nothing on a day its
  // source was on a plan. A billing the ledger cannot tell counts as metered (a budget without it is no_data anyway).
  function scopedCost(b, x, range) {
    if (!inBudgetScope(b.scope, x)) return 0;
    const model = b.scope && typeof b.scope === 'object' && b.scope.dim === 'model' ? b.scope.value : null;
    const plans = new Map();
    const billed = (day) => {
      if (b.measure !== 'billed' || typeof budgets.billingMode !== 'function') return 1;
      if (!plans.has(day)) {
        let mode = null;
        try {
          mode = budgets.billingMode(x.tool, day);
        } catch {
          mode = null;
        }
        plans.set(day, mode === 'plan' ? 0 : 1);
      }
      return plans.get(day);
    };
    let sum = 0;
    for (const [cell, cost] of x.cells) {
      const at = cell.indexOf('|');
      const day = cell.slice(0, at);
      if (day < range.from || day > range.to) continue;
      if (model !== null && cell.slice(at + 1) !== model) continue;
      sum += cost * billed(day);
    }
    return sum;
  }

  // The period spend of the last aggregate pass, built once on first use; null without one (or when it fails).
  function spendOf() {
    if (!agg) return null;
    if (!agg.spend && typeof agg.buildSpend === 'function') {
      try {
        agg.spend = agg.buildSpend();
      } catch (err) {
        safeLog(`monitors: could not read the period spend: ${err && err.message}`);
      }
      agg.buildSpend = null;
    }
    return agg.spend;
  }

  // The running session an open episode is about, or null when none runs now (nothing to pause, nothing used up).
  // daily_cost has no session of its own: the costliest session today that is still running. A budget: the running
  // session that spent the most in its scope and period.
  function budgetTarget(b) {
    const sessions = live ? live.sessions : [];
    const range = b ? periodOf(b) : null;
    const spend = range ? spendOf() : null;
    if (!spend) return null;
    let best = null;
    let most = 0;
    for (const s of sessions) {
      const x = spend.get(s.key);
      const cost = x ? scopedCost(b, x, range) : 0;
      if (cost > most) {
        best = s;
        most = cost;
      }
    }
    return best;
  }
  function targetOf(ruleId, p) {
    const sessions = live ? live.sessions : [];
    if (ruleId === 'budget') return budgetTarget(budgetViews.find((v) => v.id === p.instance));
    if (ruleId === 'daily_cost') {
      for (const c of (agg && agg.costly) || []) {
        const s = sessions.find((x) => x.key === c.key);
        if (s) return s;
      }
      return null;
    }
    return sessions.find((x) => x.sid === p.sessionId) || null;
  }

  // After every pass: each open trigger episode of a rule the owner set to pause, not acted on yet, is acted on once.
  // This reads the saved states rather than the alerts, so an episode acted on before a restart is not acted on
  // again (an agent the owner resumed stays running), and turning the setting on during a trigger acts at once.
  async function autoPauseDue() {
    if (demo || !control) return;
    for (const ruleId of AUTO_PAUSE) {
      if (RETIRED.has(ruleId)) continue;
      const s = settingsOf(ruleId);
      if (!s.enabled || !s.autoPause) continue;
      let due = [];
      try {
        due = state.pending(ruleId);
      } catch (err) {
        safeLog(`monitors: could not read the open ${ruleId} alerts: ${err && err.message}`);
        continue;
      }
      const open = new Set(due.map((p) => keyOf(ruleId, p.instance)));
      for (const k of reported) if (k.startsWith(`${ruleId}|`) && !open.has(k)) reported.delete(k);
      for (const p of due) await actOn(ruleId, p);
    }
  }

  // An exceeded budget set to pause, not acted on this period: the running local session that spent the most in its
  // scope and period.
  async function autoPauseBudgets() {
    if (demo || !control || !budgets) return;
    const pausing = new Set(
      budgetViews.filter((v) => v.enforce === 'pause' && v.state === 'exceeded').map((v) => v.id),
    );
    let due = [];
    try {
      due = state.pendingBudgets().filter((p) => pausing.has(p.instance));
    } catch (err) {
      safeLog(`monitors: could not read the exceeded budgets: ${err && err.message}`);
      return;
    }
    const open = new Set(due.map((p) => keyOf('budget', p.instance)));
    for (const k of reported) if (k.startsWith('budget|') && !open.has(k)) reported.delete(k);
    for (const p of due) await actOn('budget', p);
  }

  // After each ledger pass (server.js): every budget's state goes to the state store, which returns the alerts of a
  // change; then the pause. Asked for while a pass runs (a budget saved meanwhile), it runs once more after that pass,
  // however many ask, so the change is evaluated. It never rejects.
  const levelOf = (st) => (st === 'exceeded' ? 100 : /^warn_\d{1,2}$/.test(st) ? Number(st.slice(5)) : null);
  function tickBudgets() {
    if (!budgets) return Promise.resolve();
    if (budgetRunning) {
      if (!budgetAgain)
        budgetAgain = budgetRunning.then(() => {
          budgetAgain = null;
          return tickBudgets();
        });
      return budgetAgain;
    }
    const p = (async () => {
      await null;
      try {
        if (!isNum(now())) return;
        let views;
        try {
          views = budgets.evaluate();
        } catch (err) {
          safeLog(`monitors: the budgets could not be evaluated: ${err && err.message}`);
          return;
        }
        budgetViews = Array.isArray(views) ? views : [];
        let complete = false;
        try {
          complete = budgets.complete() === true;
        } catch {
          complete = false;
        }
        const results = budgetViews.map((v) => ({
          instance: v.id,
          state: v.state,
          projected: v.projected === true,
          periodKey: v.periodKey,
          period: v.period,
          value: isNum(v.percent) ? v.percent : null,
          threshold: levelOf(v.state),
          title: typeof v.name === 'string' ? v.name : null,
        }));
        let alerts = [];
        try {
          alerts = state.applyBudgets(results, { retire: complete }) || [];
        } catch (err) {
          safeLog(`monitors: the budget states could not be kept: ${err && err.message}`);
        }
        for (const a of alerts) send(a);
        await autoPauseBudgets();
      } catch (err) {
        safeLog(`monitors: the budget pass failed: ${err && err.message}`);
      } finally {
        budgetRunning = null;
      }
    })();
    budgetRunning = p;
    return p;
  }

  // A budget's pause is chosen before the agent is looked up, which takes time. Before anything is used up or
  // signalled, the budget is read again as it is now (the owner may have saved a change meanwhile, even during this
  // very pass): it must still pause, still be exceeded in the same period with the same scope and measure, and still
  // pick the same session. Otherwise the action is dropped without using up the period; a later pass decides anew.
  function budgetStillDue(chosen, target) {
    if (!chosen) return false;
    let views;
    try {
      views = budgets.evaluate();
    } catch (err) {
      safeLog(`monitors: the budgets could not be evaluated: ${err && err.message}`);
      return false;
    }
    const cur = Array.isArray(views) ? views.find((v) => v && v.id === chosen.id) : null;
    if (!cur || cur.enforce !== 'pause' || cur.state !== 'exceeded' || cur.periodKey !== chosen.periodKey) return false;
    if (JSON.stringify(cur.scope) !== JSON.stringify(chosen.scope) || cur.measure !== chosen.measure) return false;
    const again = budgetTarget(cur);
    return !!again && again.key === target.key;
  }

  // Pause the one agent process behind the session. Several candidates, or none, are never guessed at: the owner is
  // told which, and that uses up the episode. A passing problem is reported once and tried again on a later pass.
  // A failure is caught, logged and reported; it never stops the pass.
  async function actOn(ruleId, p) {
    const k = keyOf(ruleId, p.instance);
    if (busy.has(k)) return;
    // No live pass has read the running sessions yet (it was skipped, or the server just started): there is nothing
    // to decide on. The episode stays open, so the first live pass acts on it; "no candidate" now would be false.
    if (!live) return;
    const passing = (target, code, reason) => {
      if (reported.has(k)) return;
      reported.add(k);
      outcome(ruleId, p, target, false, code, reason);
    };
    const chosen = ruleId === 'budget' ? budgetViews.find((v) => v.id === p.instance) || null : null;
    // Agent control is off here (server mode, password or no sign-in, Docker): a budget says so, once per period
    // (the period is used up, as a lookup that found nothing would use it), rather than "no candidate".
    if (ruleId === 'budget' && chosen && typeof control.off === 'function') {
      let why = null;
      try {
        why = control.off();
      } catch {
        why = null;
      }
      if (why) {
        if (state.markActed(ruleId, p.instance, { period: chosen.periodKey }))
          outcome(ruleId, p, null, false, 'off', `could not pause: ${why}`);
        return;
      }
    }
    const target = targetOf(ruleId, p);
    if (!target) {
      // A live session that is not running now has nothing to pause. daily_cost and a budget pick the session
      // themselves, so they say when none was running.
      if (ruleId === 'daily_cost')
        passing(null, 'none', 'could not pause: no candidate (no running session has a cost today)');
      else if (ruleId === 'budget') {
        const b = budgetViews.find((v) => v.id === p.instance);
        const dim = b && b.scope && typeof b.scope === 'object' ? b.scope.dim : null;
        if (!home && (dim === 'project' || dim === 'center'))
          passing(
            null,
            'none',
            "could not pause: the home folder is not known, so no session matches the budget's scope",
          );
        else
          passing(
            null,
            'none',
            "could not pause: no candidate (no running session in the budget's scope has a cost this period)",
          );
      }
      return;
    }
    const info = agg && agg.sessionInfo.get(target.key);
    if (!info || !info.cwd || !isNum(info.first))
      return passing(target, 'not-indexed', 'could not pause: the session is not in the index yet');
    busy.add(k);
    try {
      let list;
      try {
        list = await control.candidates({ cwd: info.cwd, firstTs: info.first, source: target.tool });
      } catch (err) {
        safeLog(`monitors: could not look for the agent of a session: ${err && err.message}`);
        return passing(target, 'unreadable', 'could not pause: the agent processes could not be read');
      }
      if (ruleId === 'budget' && !budgetStillDue(chosen, target)) return;
      // The episode is used up from here on, whatever the answer. False: it resolved or was taken meanwhile (a budget:
      // or its period changed).
      const expect = ruleId === 'budget' ? { period: chosen.periodKey } : undefined;
      if (!state.markActed(ruleId, p.instance, expect)) return;
      reported.delete(k);
      if (!Array.isArray(list) || list.length === 0) {
        // Windows lists no working folder for a process (and has no pause), so there is never a candidate there.
        if (platform === 'win32')
          return outcome(
            ruleId,
            p,
            target,
            false,
            'windows',
            'could not pause: no candidate (not available on Windows)',
          );
        return outcome(ruleId, p, target, false, 'none', 'could not pause: no candidate');
      }
      if (list.length > 1) return outcome(ruleId, p, target, false, 'several', 'could not pause: several candidates');
      const [c] = list;
      try {
        await control.pause(
          { pid: c.pid, startTime: c.startTime },
          { by: 'rule', rule: ruleId, sessionId: target.sid },
        );
        outcome(ruleId, p, target, true, 'paused', 'paused');
      } catch (err) {
        const msg = (err && err.message) || 'unknown error';
        safeLog(`monitors: ${ruleId} could not pause an agent: ${msg}`);
        outcome(ruleId, p, target, false, 'refused', `could not pause: ${msg}`);
      }
    } finally {
      busy.delete(k);
    }
  }

  // ---- the passes ----
  // A pass that is still running is joined, not started twice. A failure is logged; it never rejects. Without a
  // usable clock a pass does nothing and keeps what the previous one built.
  function pass(kind, build) {
    if (running[kind]) return running[kind];
    const p = (async () => {
      // Yield first, so `running` is set before anything below can finish (or fail) synchronously.
      await null;
      try {
        const t = now();
        if (!isNum(t)) return;
        // Nothing needs the live sessions: no live rule is on and no auto-pause has to find its session (daily_cost
        // finds the costliest running one here). The office snapshot is not read and the old sessions are dropped.
        if (kind === 'live' && !liveNeeded()) {
          live = null;
          return;
        }
        if (kind === 'aggregate') agg = build(t);
        else live = build(t);
        await run(kind, t);
        if (kind === 'aggregate') lastAggregate = t;
        else lastLive = t;
      } catch (err) {
        safeLog(`monitors: the ${kind} pass failed: ${err && err.message}`);
      } finally {
        running[kind] = null;
      }
    })();
    running[kind] = p;
    return p;
  }

  function liveNeeded() {
    for (const rule of RULES) {
      const s = settingsOf(rule.id);
      if (!s.enabled || RETIRED.has(rule.id)) continue;
      if (rule.kind === 'live' || (AUTO_PAUSE.has(rule.id) && s.autoPause)) return true;
    }
    if (budgetViews.some((v) => v.enforce === 'pause')) return true; // a budget's pause looks for the running sessions
    return false;
  }

  const tickAggregate = () => pass('aggregate', buildAggregate);
  const tickLive = () => pass('live', buildLive);

  async function status() {
    const counts = { ok: 0, triggered: 0, no_data: 0, snoozed: 0 };
    let states = [];
    try {
      states = state.states();
    } catch (err) {
      safeLog(`monitors: could not read the states: ${err && err.message}`);
    }
    const t = now();
    for (const s of states) {
      if (s.rule === 'budget' || RETIRED.has(s.rule)) continue;
      if (Object.prototype.hasOwnProperty.call(counts, s.state) && !ended(s, t)) counts[s.state]++;
    }
    let paused = [];
    if (!demo && control) {
      try {
        paused = await control.paused();
      } catch (err) {
        safeLog(`monitors: could not list the paused agents: ${err && err.message}`);
      }
    }
    return {
      enabled: RULES.some((r) => !RETIRED.has(r.id) && settingsOf(r.id).enabled),
      lastAggregate,
      lastLive,
      paused,
      counts,
    };
  }

  // What the rules last saw, without the index rows and folders the engine keeps for itself.
  function snapshot() {
    const s = ruleSnap();
    return {
      aggregateTs: agg ? agg.ts : null,
      liveTs: live ? live.ts : null,
      budget: s.budget,
      today: s.today || null,
      month: s.month || null,
      accuracy: s.accuracy || null,
      evals: s.evals || null,
      signals: s.signals ? s.signals.length : null,
      sessions: (s.sessions || []).map((x) => ({
        sid: x.sid,
        tool: x.tool,
        state: x.state,
        lastTs: x.lastTs,
        title: x.title || null,
        cost10m: x.cost10m,
        toolCallsTurn: x.toolCallsTurn,
      })),
    };
  }

  return { tickAggregate, tickLive, tickBudgets, status, snapshot };
}

// The aggregate pass has to run on the refreshed index, and the refresh timer is not changed: each call waits for
// the refresh to end, then runs the pass once. One waiting poller at a time, so a refresh that outlasts the refresh
// interval does not stack a poller per interval. A failing pass is caught here: it must never break a refresh.
function createAfterRefresh({ indexing, run, pollMs = 250, timers = { setInterval, clearInterval } } = {}) {
  let waiting = false;
  return function afterRefresh() {
    if (waiting) return;
    waiting = true;
    const timer = timers.setInterval(() => {
      if (indexing()) return;
      timers.clearInterval(timer);
      waiting = false;
      Promise.resolve()
        .then(run)
        .catch(() => {});
    }, pollMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
}

module.exports = { createMonitors, createAfterRefresh, isEndedSession: ended, LIVE_STALE_MS };
