// The monitor rules, as data plus pure functions. The engine builds a snapshot (one read of the index, quality,
// evals and the live sessions) and passes it in, so nothing here does I/O or reads the clock: `now` is an argument.
// A missing input gives `no_data`, never `triggered`. Session titles are masked by the engine before they get here
// and are used only in notifications.
const MIN = 60e3;
const LIVE_WINDOW_MIN = 10;

// A parameter may arrive as text from a form; anything that is not a non-negative number falls back.
const num = (v, fallback) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasBudget = (config) => isNum(config && config.monthlyBudgetUSD) && config.monthlyBudgetUSD > 0;
// Points and rates come from float subtraction (0.85 - 0.80 is 0.04999...): round away the noise before comparing.
const clean = (x) => Math.round(x * 1e6) / 1e6;

const RULES = [
  {
    id: 'daily_cost',
    title: 'Daily cost',
    describe: "Today's spend passes the daily limit. The default limit is the monthly budget divided by 30.",
    kind: 'aggregate',
    params: { limitUSD: null },
    defaultOn: hasBudget,
    mayAutoPause: true,
  },
  {
    id: 'month_projection',
    title: 'Month projection',
    describe: "This month's projected cost passes the monthly budget.",
    kind: 'aggregate',
    params: {},
    defaultOn: hasBudget,
    mayAutoPause: false,
  },
  {
    id: 'cost_burn',
    title: 'Cost burn',
    describe: 'One session spent more than the limit in the last 10 minutes.',
    kind: 'live',
    params: { maxUSD: 5 },
    defaultOn: () => false,
    mayAutoPause: true,
  },
  {
    id: 'tool_loop',
    title: 'Tool loop',
    describe: 'A session shows a loop in the last 10 minutes, or made too many tool calls in one turn.',
    kind: 'live',
    params: { maxCalls: 50 },
    defaultOn: () => true,
    mayAutoPause: true,
  },
  {
    id: 'agent_stuck',
    title: 'Agent stuck',
    describe: 'An agent is working or thinking but wrote no new log line for a while.',
    kind: 'live',
    params: { stuckMin: 10 },
    defaultOn: () => false,
    mayAutoPause: false,
  },
  {
    id: 'accuracy_drop',
    title: 'Accuracy drop',
    describe: "Today's accuracy is more than the allowed points below the previous 7 days.",
    kind: 'aggregate',
    params: { dropPoints: 5 },
    defaultOn: () => true,
    mayAutoPause: false,
  },
  {
    id: 'eval_pass_rate',
    title: 'Evaluator pass rate',
    describe: 'An evaluator passed less than the minimum share of its checks in the last 24 hours.',
    kind: 'aggregate',
    params: { minPassRate: 0.8, minSamples: 20 },
    defaultOn: () => false,
    mayAutoPause: false,
  },
  {
    id: 'unsafe_content',
    title: 'Unsafe content',
    describe: 'A secret leak, or a prompt injection that came from outside, in the last hour.',
    kind: 'aggregate',
    params: { windowMin: 60 },
    defaultOn: () => true,
    mayAutoPause: false,
  },
];

const result = (instance, sessionId, state, value, threshold, title) => {
  const r = { instance, sessionId, state, value, threshold };
  if (title) r.title = title;
  return r;
};
const single = (state, value, threshold) => [result('all', null, state, value, threshold)];

// Live rules: one instance per session. Without a session list there is nothing to judge, which is one `no_data`.
function perSession(snap, fn) {
  if (!Array.isArray(snap.sessions)) return single('no_data', null, null);
  return snap.sessions.map((s) => fn(s));
}

const CHECKS = {
  daily_cost(p, snap) {
    const monthly = snap.budget && snap.budget.monthlyUSD;
    const cost = snap.today && snap.today.cost;
    if (!isNum(monthly) || monthly <= 0) return single('no_data', isNum(cost) ? cost : null, null);
    const limit = p.limitUSD > 0 ? p.limitUSD : monthly / 30;
    if (!isNum(cost)) return single('no_data', null, limit);
    return single(cost > limit ? 'triggered' : 'ok', cost, limit);
  },

  month_projection(p, snap) {
    const monthly = snap.budget && snap.budget.monthlyUSD;
    const projection = snap.month && snap.month.projection;
    if (!isNum(monthly) || monthly <= 0) return single('no_data', isNum(projection) ? projection : null, null);
    if (!isNum(projection)) return single('no_data', null, monthly);
    return single(projection > monthly ? 'triggered' : 'ok', projection, monthly);
  },

  cost_burn(p, snap) {
    return perSession(snap, (s) => {
      if (!isNum(s.cost10m)) return result(s.sid, s.sid, 'no_data', null, p.maxUSD, s.title);
      return result(s.sid, s.sid, s.cost10m > p.maxUSD ? 'triggered' : 'ok', s.cost10m, p.maxUSD, s.title);
    });
  },

  // Live and aggregate: the session's own call count, plus the loop signals the index found in the last 10 minutes.
  tool_loop(p, snap, now) {
    const signals = Array.isArray(snap.signals) ? snap.signals : null;
    const since = now - LIVE_WINDOW_MIN * MIN;
    return perSession(snap, (s) => {
      const calls = isNum(s.toolCallsTurn) ? s.toolCallsTurn : null;
      if (calls === null && !signals) return result(s.sid, s.sid, 'no_data', null, p.maxCalls, s.title);
      if (calls !== null && calls > p.maxCalls) return result(s.sid, s.sid, 'triggered', calls, p.maxCalls, s.title);
      const isLoop = (x) => x && x.sid === s.sid && x.kind === 'loop' && x.ts >= since;
      const loops = signals ? signals.filter(isLoop).length : 0;
      // A loop signal on its own has no call count to show, so the number is how many were seen.
      if (loops > 0) return result(s.sid, s.sid, 'triggered', loops, 1, s.title);
      return result(s.sid, s.sid, 'ok', calls === null ? 0 : calls, p.maxCalls, s.title);
    });
  },

  agent_stuck(p, snap, now) {
    return perSession(snap, (s) => {
      const busy = s.state === 'working' || s.state === 'thinking';
      if (busy && !isNum(s.lastTs)) return result(s.sid, s.sid, 'no_data', null, p.stuckMin, s.title);
      if (!isNum(s.lastTs)) return result(s.sid, s.sid, 'ok', null, p.stuckMin, s.title);
      const age = now - s.lastTs;
      const state = busy && age > p.stuckMin * MIN ? 'triggered' : 'ok';
      return result(s.sid, s.sid, state, Math.floor(Math.max(age, 0) / MIN), p.stuckMin, s.title);
    });
  },

  accuracy_drop(p, snap) {
    const a = snap.accuracy;
    if (!a || !isNum(a.today) || !isNum(a.prev7)) return single('no_data', null, p.dropPoints);
    const drop = clean((a.prev7 - a.today) * 100);
    return single(drop > p.dropPoints ? 'triggered' : 'ok', drop, p.dropPoints);
  },

  // One instance for all evaluators: the worst rate among those with enough samples decides.
  eval_pass_rate(p, snap) {
    if (!snap.evals || typeof snap.evals !== 'object') return single('no_data', null, p.minPassRate);
    let worst = null;
    for (const e of Object.values(snap.evals)) {
      if (!e || !isNum(e.pass) || !isNum(e.total) || e.total <= 0 || e.total < p.minSamples) continue;
      const rate = clean(e.pass / e.total);
      if (worst === null || rate < worst) worst = rate;
    }
    if (worst === null) return single('no_data', null, p.minPassRate);
    return single(worst < p.minPassRate ? 'triggered' : 'ok', worst, p.minPassRate);
  },

  // Aggregate with a single instance; the value is how many signals counted.
  unsafe_content(p, snap, now) {
    if (!Array.isArray(snap.signals)) return single('no_data', null, 1);
    const since = now - p.windowMin * MIN;
    const n = snap.signals.filter(
      (x) => x && x.ts >= since && (x.kind === 'secret' || (x.kind === 'injection' && x.external === true)),
    ).length;
    return single(n >= 1 ? 'triggered' : 'ok', n, 1);
  },
};

// Fill the rule's parameters from `params`; a missing or invalid value takes the rule's default.
function withDefaults(rule, params) {
  const out = {};
  for (const [k, d] of Object.entries(rule.params)) out[k] = num(params && params[k], d);
  return out;
}

function evaluate(rule, params, snap, now) {
  const check = rule && CHECKS[rule.id];
  if (!check) throw new Error(`Unknown rule: ${rule && rule.id}`);
  const def = RULES.find((r) => r.id === rule.id);
  return check(withDefaults(def, params), snap && typeof snap === 'object' ? snap : {}, now);
}

module.exports = { RULES, evaluate };
