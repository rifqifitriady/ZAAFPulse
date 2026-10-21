// The eval engine: one queue (concurrency 1) that runs the judge evaluators on finished agent turns.
// Local first: it uses the model `models` resolves and waits when there is none. It never sends text to an
// external provider before the owner confirmed the preview, and it stops at the daily count and cost caps.
// Text never passes through here except to the judge: results keep labels and a capped explanation, and logs
// carry reasons and counts only.
const fs = require('fs');
const path = require('path');
const R = require('./registry');
const { buildPrompt, parseVerdict } = require('./judge');
const { codeResults, codeSummary } = require('./code');

const IDLE_MS = 2 * 60e3; // a session quiet this long has finished its last turn
const QUEUE_MAX = 2000;
const MAX_TRIES = 3;
const SEEN_MAX = 5000;
const DEFAULT_CAP = 500;
const DEFAULT_COST_CAP = 1;
const FILE_SOURCES = new Set(['claude', 'codex']);
const JUDGES = R.EVALUATORS.filter((e) => e.kind === 'judge');
const isSub = (file) => /[\\/]subagents[\\/]/.test(file || '');
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const p2 = (x) => String(x).padStart(2, '0');
const dayOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const num = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback);

// A bounded set: the oldest entry goes when it is full.
function boundedSet() {
  const set = new Set();
  return {
    has: (k) => set.has(k),
    add(k) {
      set.add(k);
      if (set.size > SEEN_MAX) set.delete(set.values().next().value);
    },
  };
}

function readState(file) {
  const fresh = { since: null, day: null, count: 0, cost: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return fresh;
    return {
      since: Number.isFinite(j.since) ? j.since : null,
      day: typeof j.day === 'string' ? j.day : null,
      count: num(j.count, 0),
      cost: num(j.cost, 0),
    };
  } catch {
    return fresh;
  }
}

// Temp file + rename, mode 0600, like the stores: a crash leaves the old state intact.
function writeState(file, state) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  try {
    fs.unlinkSync(tmp); // writeFileSync keeps the mode of a file that already exists
  } catch {
    /* nothing there */
  }
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
}

function createEvalEngine({
  trace,
  indexer,
  models,
  store,
  feedback,
  settings = () => ({}),
  stateFile,
  now = Date.now,
  log = () => {},
  demo = false,
  demoData = {},
} = {}) {
  const state = demo || !stateFile ? { since: null, day: null, count: 0, cost: 0 } : readState(stateFile);
  const queue = [];
  const pending = new Map(); // job id -> job, for a job that is queued or running
  const dead = boundedSet(); // job ids that cannot be judged (vanished, not judgeable): tick skips them
  const refused = boundedSet(); // result keys whose verdict was invalid: tick does not ask again
  const counters = { judged: 0, invalid: 0, skipped: 0, errors: 0, dropped: 0 };
  const logged = new Set();
  let runner = null;
  let again = false; // a kick that arrived while the runner was finishing
  let saveFailed = false;

  const logOnce = (reason, message) => {
    if (logged.has(reason)) return;
    logged.add(reason);
    try {
      log(message);
    } catch {
      /* logging must not break the queue */
    }
  };
  const save = () => {
    if (demo || !stateFile) return;
    try {
      writeState(stateFile, { since: state.since, day: state.day, count: state.count, cost: state.cost });
    } catch {
      if (!saveFailed) logOnce('state', 'evals: could not write the engine state');
      saveFailed = true;
    }
  };

  // Counters belong to a local day; the first look on a new day starts them again.
  function rollover() {
    const today = dayOf(now());
    if (state.day === today) return;
    state.day = today;
    state.count = 0;
    state.cost = 0;
    save();
  }
  const caps = (s) => ({ count: num(s.dailyCap, DEFAULT_CAP), cost: num(s.costCapUSD, DEFAULT_COST_CAP) });
  const isExternal = (r) => !!r && r.ok && r.kind === 'external';
  const gateOpen = (s, r) => !isExternal(r) || s.externalConfirmed === r.provider;
  const gateReason = (r) => `Confirm the preview before sending to ${r.provider}`;
  const capped = (s, r) => {
    const c = caps(s);
    if (state.count >= c.count) return 'daily cap';
    if (isExternal(r) && state.cost >= c.cost) return 'cost cap';
    return null;
  };

  // Which judge evaluators run: an explicit list, else the ones the owner has not switched off.
  function evaluatorsFor(scope, s, only) {
    const on = (s.evaluators && typeof s.evaluators === 'object' && s.evaluators) || {};
    return JUDGES.filter((e) => e.scope === scope && (only ? only.includes(e.id) : on[e.id] !== false));
  }
  const targetOf = (source, sid, turn) => ({ source, session: sid, turn, span: null });
  const jobId = (source, sid, turn) => `${source}|${sid}|${turn === null ? 's' : turn}`;
  const stored = (target, e, model) => !!model && !!store.get(R.resultKey(target, e.id, e.version, model));

  function push(job) {
    queue.push(job);
    pending.set(job.id, job);
    while (queue.length > QUEUE_MAX) {
      pending.delete(queue.shift().id);
      counters.dropped++;
    }
  }

  // Queue one turn (turn index) or one session (turn null) unless it is already queued, known to be
  // unjudgeable (tick only) or fully judged by this model. Returns 1 when a job was added.
  function offer({ source, sid, turn, only, model, force }) {
    const id = jobId(source, sid, turn);
    if (pending.has(id)) return 0;
    if (!force && dead.has(id)) return 0;
    const s = settings() || {};
    const evs = evaluatorsFor(turn === null ? 'session' : 'turn', s, only);
    const target = targetOf(source, sid, turn);
    const wanted = (e) =>
      !stored(target, e, model) && (force || !refused.has(R.resultKey(target, e.id, e.version, model)));
    if (!evs.some(wanted)) return 0;
    push({ id, source, sid, turn, only: only || null, tries: 0 });
    return 1;
  }

  // The sessions of the log files the indexer holds (the main file of each, not its subagents).
  function indexed() {
    const out = new Map();
    for (const en of (indexer && indexer.entries()) || []) {
      if (!FILE_SOURCES.has(en.source) || isSub(en.file)) continue;
      for (const [sid, sess] of Object.entries((en.result && en.result.sessions) || {})) {
        const turns = (sess && sess.turns) || [];
        const key = `${en.source}|${sid}`;
        const have = out.get(key);
        if (!have || turns.length > have.turns.length) {
          out.set(key, { source: en.source, sid, turns, mtimeMs: en.mtimeMs });
        }
      }
    }
    return out;
  }

  // When turn i was done: the next turn started, or the session went quiet at its last activity.
  function finishedAt(sess, i) {
    const next = sess.turns[i + 1];
    if (!next) return sess.mtimeMs;
    if (Number.isFinite(next[1])) return next[1];
    return Number.isFinite(sess.turns[i][1]) ? sess.turns[i][1] : sess.mtimeMs;
  }

  async function resolveQuiet() {
    try {
      return await models.resolve();
    } catch {
      return { ok: false, waiting: true, reason: 'Could not check for a judge model' };
    }
  }

  async function tick() {
    if (demo) return { queued: 0 };
    rollover();
    const s = settings() || {};
    if (s.judge === false) return { queued: 0 };
    const resolved = await resolveQuiet();
    if (!resolved.ok) return { queued: 0 };
    // History is never judged on its own: only what finishes after the judge first existed.
    if (state.since === null) {
      state.since = now();
      save();
    }
    const t = now();
    let queued = 0;
    for (const sess of indexed().values()) {
      const idle = t - sess.mtimeMs > IDLE_MS;
      const last = sess.turns.length - 1;
      for (let i = 0; i <= last; i++) {
        if (i === last && !idle) continue; // still running
        if (finishedAt(sess, i) < state.since) continue;
        queued += offer({ source: sess.source, sid: sess.sid, turn: i, model: resolved.model });
      }
      if (idle && last >= 0 && sess.mtimeMs >= state.since) {
        queued += offer({ source: sess.source, sid: sess.sid, turn: null, model: resolved.model });
      }
    }
    // Agent Gateway runs: one turn each, judged once they have ended and gone quiet.
    let rows = [];
    try {
      rows = (trace && trace.sessions && trace.sessions({ source: 'gateway' })) || [];
    } catch {
      rows = [];
    }
    for (const row of rows) {
      let sid;
      try {
        sid = trace.sourceOf(row.key).sid;
      } catch {
        continue;
      }
      if (!sid.startsWith('run:') || !Number.isFinite(row.end)) continue;
      if (t - row.end <= IDLE_MS || row.end < state.since) continue;
      queued += offer({ source: 'gateway', sid, turn: 0, model: resolved.model });
    }
    if (queued) kick();
    return { queued };
  }

  async function enqueueSession(source, sid, evaluators) {
    if (demo) return { queued: 0 };
    if (typeof source !== 'string' || !source || typeof sid !== 'string' || !sid) {
      throw badRequest('source and session required');
    }
    const named = Array.isArray(evaluators) ? evaluators.filter((id) => typeof id === 'string') : [];
    const only = named.length ? named : null;
    const resolved = await resolveQuiet();
    const model = resolved.ok ? resolved.model : null;
    const t = now();
    const sess = indexed().get(`${source}|${sid}`);
    let turns;
    if (sess) {
      const idle = t - sess.mtimeMs > IDLE_MS;
      turns = sess.turns.map((_, i) => i).filter((i) => i < sess.turns.length - 1 || idle);
    } else {
      // Not in the index (a gateway run, say): the registry knows its turns, and the owner asked for it.
      turns = (await trace.turnsOf(trace.keyFor(source, sid))).map((x) => x.index);
    }
    let queued = 0;
    for (const turn of turns) queued += offer({ source, sid, turn, only, model, force: true });
    if (sess || turns.length) queued += offer({ source, sid, turn: null, only, model, force: true });
    if (queued) kick();
    return { queued };
  }

  // ---- the runner ----
  function kick(fresh = true) {
    if (demo) return;
    if (runner) {
      again = again || fresh;
      return;
    }
    runner = run()
      .catch(() => logOnce('runner', 'evals: the judge queue stopped on an unexpected error'))
      .finally(() => {
        runner = null;
        if (again) {
          again = false;
          if (queue.length) kick();
        }
      });
  }
  // Resolves when the queue is empty or cannot go on (paused, waiting, unconfirmed); jobs stay queued then.
  async function drain() {
    if (demo) return;
    kick(false); // a pass that stopped (an error, a cap) is not run again by waiting on it
    while (runner) await runner;
  }

  async function run() {
    while (queue.length) {
      rollover();
      const s = settings() || {};
      if (s.judge === false) return;
      const resolved = await resolveQuiet();
      if (!resolved.ok || !gateOpen(s, resolved) || capped(s, resolved)) return;
      const job = queue.shift();
      const outcome = await runJob(job, resolved, s);
      if (outcome === 'requeue') {
        queue.unshift(job);
        return;
      }
      pending.delete(job.id);
      if (outcome === 'stop') return;
    }
  }

  // 'done' (finished or skipped), 'requeue' (put it back and stop: a cap or a transient error), 'stop'.
  async function runJob(job, resolved, s) {
    const session = job.turn === null;
    const evs = evaluatorsFor(session ? 'session' : 'turn', s, job.only);
    const first = targetOf(job.source, job.sid, job.turn);
    if (!evs.some((e) => !stored(first, e, resolved.model))) return 'done';
    let m;
    try {
      m = session
        ? await trace.materialSession(job.source, job.sid)
        : await trace.material(job.source, job.sid, job.turn);
    } catch (e) {
      dead.add(job.id);
      if (e && e.status === 404) {
        counters.skipped++;
        logOnce('vanished', 'evals: a session file is gone, skipping its judgments');
      } else {
        counters.errors++;
        logOnce('material', `evals: could not read a session to judge (status ${(e && e.status) || 'unknown'})`);
      }
      return 'done';
    }
    if (!m) {
      dead.add(job.id);
      counters.skipped++;
      logOnce('unjudgeable', 'evals: a session cannot be judged, skipping it');
      return 'done';
    }
    const target = m.target || first;
    for (const e of evs) {
      if (stored(target, e, resolved.model)) continue;
      // Re-check between evaluators: one turn can reach a cap part-way, and then it resumes where it stopped.
      if (capped(s, resolved)) return 'requeue';
      const key = R.resultKey(target, e.id, e.version, resolved.model);
      let reply;
      let built;
      try {
        built = buildPrompt(e, m.material);
        reply = await models.call(resolved, { system: built.system, user: built.user, schema: built.schema });
      } catch (err) {
        const status = err && err.status;
        // Nothing answered, the provider is busy or failing: try again on a later pass, a few times at most.
        if (status === 0 || status === 429 || status >= 500) {
          if (++job.tries < MAX_TRIES) {
            logOnce('retry', 'evals: the judge model did not answer, will retry');
            return 'requeue';
          }
          counters.errors++;
          logOnce('call', `evals: gave up on a judge call (status ${status})`);
          return 'done'; // the model is down; its other evaluators would fail the same way
        }
        counters.errors++;
        logOnce('call', `evals: a judge call failed (status ${status === undefined ? 'unknown' : status})`);
        continue;
      }
      state.count++;
      state.cost += (reply.usage && Number.isFinite(reply.usage.cost) && reply.usage.cost) || 0;
      save();
      const verdict = parseVerdict(e, reply.text);
      if (!verdict) {
        counters.invalid++;
        refused.add(key);
        continue;
      }
      try {
        store.put({
          target,
          evaluator: e.id,
          version: e.version,
          kind: 'judge',
          label: verdict.label,
          score: R.scoreOf(e, verdict.label),
          direction: e.direction,
          explanation: verdict.explanation,
          judge: { kind: resolved.kind, model: resolved.model, provider: resolved.provider },
          trimmed: !!built.trimmed,
          finishedAt: Number.isFinite(m.finishedAt) ? m.finishedAt : null,
          ts: now(),
        });
        counters.judged++;
      } catch {
        counters.errors++;
        logOnce('store', 'evals: could not store a result');
      }
    }
    return 'done';
  }

  // ---- reading ----
  async function status() {
    if (demo) return val(demoData.status);
    rollover();
    const s = settings() || {};
    const r = await resolveQuiet();
    const gated = r.ok && !gateOpen(s, r);
    const judge = {
      ok: !!r.ok && !gated,
      kind: r.ok ? r.kind : null,
      model: r.ok ? r.model : null,
      provider: r.ok ? r.provider : null,
      waiting: !r.ok || gated,
      reason: r.ok ? (gated ? gateReason(r) : null) : r.reason || null,
    };
    if (gated) judge.confirm = r.provider;
    const paused = s.judge === false ? 'judge off' : capped(s, r);
    return {
      judge,
      queue: queue.length,
      today: { count: state.count, cost: Math.round(state.cost * 1e6) / 1e6 },
      paused,
      since: state.since,
    };
  }
  const val = (v, ...args) => (typeof v === 'function' ? v(...args) : v);

  // The latest verdict per target and evaluator (a re-judge by another model replaces, not adds).
  function latestJudge() {
    const best = new Map();
    for (const r of store.all()) {
      if (!r.target || !R.get(r.evaluator) || R.get(r.evaluator).kind !== 'judge') continue;
      const k = `${R.targetKey(r.target)}|${r.evaluator}`;
      const have = best.get(k);
      if (!have || (r.ts || 0) >= (have.ts || 0)) best.set(k, r);
    }
    return [...best.values()];
  }
  const timeOf = (r) => (Number.isFinite(r.finishedAt) ? r.finishedAt : r.ts);
  const entries = () => (indexer && indexer.entries()) || [];

  function results({ source, session, turn } = {}) {
    if (demo) return val(demoData.results, { source, session, turn }) || [];
    const wantTurn = turn !== undefined;
    const match = (r) => !wantTurn || (r.target.turn ?? null) === (turn ?? null);
    const judged = latestJudge().filter((r) => r.target.source === source && r.target.session === session && match(r));
    const code = codeResults(entries(), { source, session })
      .filter(match)
      .map((r) => ({ ...r, kind: 'code', version: R.get(r.evaluator).version }));
    const order = new Map(R.EVALUATORS.map((e, i) => [e.id, i]));
    const turnOf = (r) => (r.target.turn === null || r.target.turn === undefined ? Infinity : r.target.turn);
    const rank = (r) => order.get(r.evaluator);
    return [...code, ...judged].sort((a, b) => turnOf(a) - turnOf(b) || rank(a) - rank(b));
  }

  function summary({ from = 0, to = Infinity } = {}) {
    if (demo) return val(demoData.summary, { from, to });
    const evaluators = {};
    const code = codeSummary(entries(), { from, to });
    for (const e of R.EVALUATORS) {
      const c = e.kind === 'code' ? code[e.id] || { pass: 0, total: 0, days: {} } : { pass: 0, total: 0, days: {} };
      evaluators[e.id] = { kind: e.kind, pass: c.pass, total: c.total, rate: null, days: c.days };
    }
    const turns = new Map(); // target key -> { target, results, at } for the agreement pairs
    for (const r of latestJudge()) {
      const at = timeOf(r);
      if (!(at >= from && at < to)) continue;
      const e = R.get(r.evaluator);
      const sum = evaluators[e.id];
      const day = sum.days[dayOf(at)] || (sum.days[dayOf(at)] = { pass: 0, total: 0 });
      const pass = r.label === e.pass ? 1 : 0;
      sum.total++;
      day.total++;
      sum.pass += pass;
      day.pass += pass;
      if (e.scope === 'turn' && Number.isInteger(r.target.turn) && !r.target.span) {
        const k = R.targetKey(r.target);
        if (!turns.has(k)) turns.set(k, { target: r.target, passAll: true });
        if (!pass) turns.get(k).passAll = false;
      }
    }
    for (const sum of Object.values(evaluators)) sum.rate = sum.total ? sum.pass / sum.total : null;
    let pairs = 0;
    let agree = 0;
    for (const [k, t] of turns) {
      const f = feedback.get(k);
      if (!f || (f.rating !== 'good' && f.rating !== 'bad')) continue;
      pairs++;
      if (t.passAll === (f.rating === 'good')) agree++;
    }
    return { evaluators, agreement: { pairs, agree, rate: pairs ? agree / pairs : null } };
  }

  return {
    status,
    enqueueSession,
    tick,
    drain,
    results,
    summary,
    stats: () => ({ ...counters, queue: queue.length }),
  };
}

module.exports = { createEvalEngine };
