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
const { makePricer, eventParts, DEFAULT_PRICING } = require('../pricing');

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
      if (rule.kind !== kind) continue;
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

  // The running session an open episode is about, or null when none runs now (nothing to pause, nothing used up).
  // daily_cost has no session of its own: the costliest session today that is still running.
  function targetOf(ruleId, p) {
    const sessions = live ? live.sessions : [];
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
    const target = targetOf(ruleId, p);
    if (!target) {
      // A live session that is not running now has nothing to pause; daily_cost says so, since it picks the session.
      if (ruleId === 'daily_cost')
        passing(null, 'none', 'could not pause: no candidate (no running session has a cost today)');
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
      // The episode is used up from here on, whatever the answer. False: it resolved or was taken meanwhile.
      if (!state.markActed(ruleId, p.instance)) return;
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
      if (!s.enabled) continue;
      if (rule.kind === 'live' || (AUTO_PAUSE.has(rule.id) && s.autoPause)) return true;
    }
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
      enabled: RULES.some((r) => settingsOf(r.id).enabled),
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

  return { tickAggregate, tickLive, status, snapshot };
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
