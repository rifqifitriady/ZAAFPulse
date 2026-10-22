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
const ACTED_MAX = 5000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const startOfDay = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const keyOf = (rule, instance) => `${rule}|${instance}`;

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
  let agg = null; // { ts, budget, today, month, accuracy, evals, signals, usage, sessionInfo, costliest }
  let live = null; // { ts, sessions }
  let lastAggregate = null;
  let lastLive = null;
  const running = { aggregate: null, live: null };
  // Rule instances already acted on while their alert stays open (rule|instance -> ts): an automatic pause is tried
  // once per trigger, not on every reminder, and never again after the owner resumed the agent.
  const acted = new Map();

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
      costliest: null,
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
      const top = Array.isArray(sum.topCostSessions) ? sum.topCostSessions[0] : null;
      if (top && top.cost > 0) out.costliest = { key: `${top.tool}:${top.id}`, sid: top.id };
    });
    part('the accuracy', () => {
      const start = startOfDay(t);
      const q = quality.summarizeQuality(res, sessions, { start, end: t, prevStart: start - 7 * DAY });
      out.accuracy = { today: q.accuracy, prev7: q.prevAccuracy };
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
  const ruleSnap = () => ({
    budget: agg ? agg.budget : { monthlyUSD: cfg().monthlyBudgetUSD },
    today: agg && agg.today,
    month: agg && agg.month,
    accuracy: agg && agg.accuracy,
    evals: agg && agg.evals,
    signals: agg && agg.signals,
    sessions: live ? live.sessions : undefined,
  });

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
      for (const alert of alerts) {
        send(alert);
        const k = keyOf(alert.rule, alert.instance);
        if (alert.state === 'ok') acted.delete(k); // resolved: the next trigger may act again
        if (alert.state !== 'triggered' || demo || !s.autoPause || !AUTO_PAUSE.has(rule.id) || acted.has(k)) continue;
        acted.set(k, t);
        if (acted.size > ACTED_MAX) acted.delete(acted.keys().next().value);
        await autoPause(alert);
      }
    }
  }

  // Not awaited: a webhook may take a while to give up, and channels bound a burst themselves.
  function send(alert) {
    if (demo || !channels) return;
    try {
      Promise.resolve(channels.notify(alert, { title: alert.title })).catch((err) =>
        safeLog(`monitors: an alert could not be sent: ${err && err.message}`),
      );
    } catch (err) {
      safeLog(`monitors: an alert could not be sent: ${err && err.message}`);
    }
  }

  function noteResult(alert, ok, reason, sessionId) {
    try {
      state.note({
        rule: alert.rule,
        instance: alert.instance,
        sessionId: sessionId || alert.sessionId,
        value: alert.value,
        threshold: alert.threshold,
        title: alert.title,
        action: 'pause',
        ok,
        reason,
      });
    } catch (err) {
      safeLog(`monitors: could not record a pause: ${err && err.message}`);
    }
  }

  // Pause the one agent process behind the alert's session. Several candidates, or none, are never guessed at: the
  // owner gets a note saying which. A failure is caught, logged and noted; it never stops the pass.
  async function autoPause(alert) {
    let key = null;
    let sid = alert.sessionId;
    if (alert.rule === 'daily_cost') {
      // Today's cost has no session of its own: the agent of the session that cost the most today.
      if (!agg || !agg.costliest) return noteResult(alert, false, 'could not pause: no session has a cost today');
      key = agg.costliest.key;
      sid = agg.costliest.sid;
    } else {
      const s = live && live.sessions.find((x) => x.sid === sid);
      key = s ? s.key : null;
    }
    const info = key && agg && agg.sessionInfo.get(key);
    if (!info || !info.cwd || !isNum(info.first))
      return noteResult(alert, false, 'could not pause: the session is not in the index yet', sid);
    let list;
    try {
      list = await control.candidates({ cwd: info.cwd, firstTs: info.first });
    } catch (err) {
      safeLog(`monitors: could not look for the agent of a session: ${err && err.message}`);
      return noteResult(alert, false, 'could not pause: the agent processes could not be read', sid);
    }
    if (!Array.isArray(list) || list.length === 0) {
      // Windows lists no working folder for a process (and has no pause), so there is never a candidate there.
      const why = platform === 'win32' ? 'no candidate (pausing is not available on Windows)' : 'no candidate';
      return noteResult(alert, false, `could not pause: ${why}`, sid);
    }
    if (list.length > 1) return noteResult(alert, false, 'could not pause: several candidates', sid);
    const [c] = list;
    try {
      await control.pause({ pid: c.pid, startTime: c.startTime }, { by: 'rule', rule: alert.rule, sessionId: sid });
      noteResult(alert, true, 'paused', sid);
    } catch (err) {
      const msg = (err && err.message) || 'unknown error';
      safeLog(`monitors: ${alert.rule} could not pause an agent: ${msg}`);
      noteResult(alert, false, `could not pause: ${msg}`, sid);
    }
  }

  // ---- the passes ----
  // A pass that is still running is joined, not started twice. A failure is logged; it never rejects.
  function pass(kind, build) {
    if (running[kind]) return running[kind];
    const p = (async () => {
      // Yield first, so `running` is set before anything below can finish (or fail) synchronously.
      await null;
      try {
        const t = now();
        if (kind === 'aggregate') agg = isNum(t) ? build(t) : null;
        else live = isNum(t) ? build(t) : null;
        await run(kind, t);
        if (!isNum(t)) return;
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
    for (const s of states) if (Object.prototype.hasOwnProperty.call(counts, s.state)) counts[s.state]++;
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

module.exports = { createMonitors };
