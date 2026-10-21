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
const SESSION_IDLE_MS = 30 * 60e3; // ...and this long, its whole-session verdict can be given
const QUEUE_MAX = 2000;
const MAX_TRIES = 3;
const SEEN_MAX = 5000;
const DEFAULT_CAP = 500;
const DEFAULT_COST_CAP = 1;
const OUTPUT_TOKENS = 200; // allowance for the answer when an external call is estimated
const BACKOFF_MIN = 60e3;
const BACKOFF_MAX = 30 * 60e3;
const FILE_SOURCES = new Set(['claude', 'codex']);
const JUDGES = R.EVALUATORS.filter((e) => e.kind === 'judge');
const isSub = (file) => /[\\/]subagents[\\/]/.test(file || '');
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const p2 = (x) => String(x).padStart(2, '0');
const dayOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
// A setting may arrive as text from a form; anything that is not a non-negative number falls back.
const num = (v, fallback) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

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

// A stored day is trusted only if it is a real YYYY-MM-DD date and not more than a day ahead of today: a day far in
// the future (a clock that was wrong once) would otherwise hold the counters, and the cap, until that date.
const dayStart = (d) => {
  const [y, m, n] = d.split('-').map(Number);
  return new Date(y, m - 1, n).getTime();
};
const validDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && dayOf(dayStart(d)) === d;
const daysAhead = (d, today) => Math.round((dayStart(d) - dayStart(today)) / 86400e3);

function readState(file, today) {
  const fresh = { since: null, day: null, count: 0, cost: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return fresh;
    return {
      since: Number.isFinite(j.since) ? j.since : null,
      day: validDay(j.day) && daysAhead(j.day, today) <= 1 ? j.day : null,
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
  const state = demo || !stateFile ? { since: null, day: null, count: 0, cost: 0 } : readState(stateFile, dayOf(now()));
  const queue = [];
  const pending = new Map(); // job id -> job, for a job that is queued or running
  const dead = boundedSet(); // job ids that cannot be judged (vanished, failing): tick skips them
  const refused = boundedSet(); // result keys whose verdict was invalid or whose call was refused: tick skips them
  const visited = new Map(); // session -> stamp of what the last tick saw, so an unchanged session costs nothing
  const counters = { judged: 0, invalid: 0, skipped: 0, errors: 0, dropped: 0 };
  const logged = new Set();
  let runner = null;
  let again = false; // a kick that arrived while the runner was finishing
  let saveFailed = false;
  let held = false; // the next external call would pass the cost budget, so the queue waits for the next day
  const backoff = new Map(); // provider -> { fails, until }: a provider that keeps failing is left alone for a while

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

  // Counters belong to a local day; the first look on a new day starts them again. A clock that goes back by less
  // than a day does not move the day back (that would hand out a second budget for the same day); a stored day
  // further ahead than that is a wrong clock and is replaced.
  function rollover() {
    const today = dayOf(now());
    if (state.day === today) return;
    if (state.day && state.day > today) {
      if (daysAhead(state.day, today) <= 1) return;
      logOnce('clock', 'evals: the clock moved back, starting the day counters again');
    }
    held = false;
    state.day = today;
    state.count = 0;
    state.cost = 0;
    save();
  }
  const caps = (s) => ({ count: num(s.dailyCap, DEFAULT_CAP), cost: num(s.costCapUSD, DEFAULT_COST_CAP) });
  const isExternal = (r) => !!r && r.ok && r.kind === 'external';
  // Why a resolved judge may not run yet: an external model must have a known price (else the cost cap counts
  // nothing) and the owner must have confirmed the preview for its provider.
  function blocked(s, r) {
    if (!isExternal(r)) return null;
    if (typeof models.priced !== 'function' || !models.priced(r)) {
      return { reason: `No price known for ${r.model}, so the cost cap cannot apply` };
    }
    if (s.externalConfirmed !== r.provider) {
      return { reason: `Confirm the preview before sending to ${r.provider}`, confirm: r.provider };
    }
    return null;
  }
  // The caps are checked before each call, so the call that crosses one finishes: the cost can overshoot the cap
  // by one call. For an external judge the call is also estimated from its input size (see runJob).
  const capped = (s, r) => {
    const c = caps(s);
    if (state.count >= c.count) return 'daily cap';
    if (isExternal(r) && state.cost >= c.cost) return 'cost cap';
    return null;
  };

  const waitingOut = (r) => {
    const b = backoff.get(r.provider);
    return !!b && now() < b.until;
  };

  // Which judge evaluators run: an explicit list, else the ones the owner has not switched off.
  function evaluatorsFor(scope, s, only) {
    const on = (s.evaluators && typeof s.evaluators === 'object' && s.evaluators) || {};
    return JUDGES.filter((e) => e.scope === scope && (only ? only.includes(e.id) : on[e.id] !== false));
  }
  const targetOf = (source, sid, turn) => ({ source, session: sid, turn, span: null });
  const jobId = (source, sid, turn) => `${source}|${sid}|${turn === null ? 's' : turn}`;
  const stored = (target, e, model) => (model ? store.get(R.resultKey(target, e.id, e.version, model)) : null);
  // What the automatic pass asks: a verdict by any model at this evaluator version. Another model judges a turn
  // again only when the owner asks for the session (a forced job, which asks `stored` for its own model).
  const judged = (target, e) => store.latest(target, e.id, e.version);
  // A session verdict is refreshed when the session has grown by max(5, half of what it covered).
  const refreshDue = (x, n) => Number.isInteger(x.turns) && n >= x.turns + Math.max(5, Math.ceil(x.turns / 2));
  const refusal = (key, refreshing, count) => (refreshing ? `${key}|r${count}` : key);

  function push(job) {
    queue.push(job);
    pending.set(job.id, job);
    while (queue.length > QUEUE_MAX) {
      const old = queue.shift();
      if (pending.get(old.id) === old) pending.delete(old.id);
      counters.dropped++;
      visited.clear(); // what was dropped must be seen again by the next tick
    }
  }

  // Queue one turn (turn index) or one session (turn null) unless it is already queued, known to be unjudgeable
  // (tick only) or already judged: by any model for tick, by this model when forced. Evaluators named for a job
  // that is already queued are merged into it, and so is a force. Returns 1 when work was added.
  function offer(s, { source, sid, turn, only, model, force, count }) {
    const id = jobId(source, sid, turn);
    if (!force && dead.has(id)) return 0;
    const session = turn === null;
    const evs = evaluatorsFor(session ? 'session' : 'turn', s, only);
    const target = targetOf(source, sid, turn);
    const keyOf = (e) => R.resultKey(target, e.id, e.version, model);
    const done = (e) => (force ? stored(target, e, model) : judged(target, e));
    const refresh = (e) => {
      const x = done(e);
      return !!x && !force && session && refreshDue(x, count) && !refused.has(refusal(keyOf(e), true, count));
    };
    const wanted = (e) => (done(e) ? refresh(e) : force || !refused.has(keyOf(e)));
    const want = evs.filter(wanted);
    if (!want.length) return 0;
    const refreshing = want.some(refresh);
    const have = pending.get(id);
    if (have && have.running) {
      // Already being judged; only evaluators it does not cover need a second job.
      if (want.every((e) => have.ids.includes(e.id))) return 0;
    } else if (have) {
      if (force) have.force = true;
      if (refreshing) {
        have.refresh = true;
        have.count = count;
      }
      if (have.only === null) {
        if (!only) return 0;
        const enabled = evaluatorsFor(session ? 'session' : 'turn', s, null).map((e) => e.id);
        const extra = want.map((e) => e.id).filter((x) => !enabled.includes(x));
        if (!extra.length) return 0;
        have.only = [...enabled, ...extra];
        return 1;
      }
      if (!only) {
        have.only = null;
        return 1;
      }
      const extra = want.map((e) => e.id).filter((x) => !have.only.includes(x));
      have.only.push(...extra);
      return extra.length ? 1 : 0;
    }
    const job = { id, source, sid, turn, only: only || null, force: !!force, tries: 0, refresh: refreshing, count };
    push({ ...job, running: false, ids: [] });
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
    const s = settings() || {}; // read once: the whole pass sees one set of settings
    if (s.judge === false) return { queued: 0 };
    const resolved = await resolveQuiet();
    if (!resolved.ok) return { queued: 0 };
    // History is never judged on its own: only turns that started after the judge first existed. A file touched
    // later (a new mtime) does not make its old turns new.
    if (state.since === null) {
      state.since = now();
      save();
    }
    const since = state.since;
    const t = now();
    const sig = evaluatorsFor('turn', s).concat(evaluatorsFor('session', s)).map((e) => e.id).join(',');
    let queued = 0;
    for (const sess of indexed().values()) {
      if (!(sess.mtimeMs >= since)) continue;
      const idle = t - sess.mtimeMs > IDLE_MS;
      const quiet = t - sess.mtimeMs >= SESSION_IDLE_MS;
      // No model in the stamp: a model change alone offers nothing new (see `judged`).
      const stamp = [sess.turns.length, sess.mtimeMs, sig, idle, quiet].join('|');
      const vkey = `${sess.source}|${sess.sid}`;
      if (visited.get(vkey) === stamp) continue;
      const last = sess.turns.length - 1;
      for (let i = 0; i <= last; i++) {
        if (i === last && !idle) continue; // still running
        const start = sess.turns[i][1];
        if (!Number.isFinite(start) || start < since) continue;
        queued += offer(s, { source: sess.source, sid: sess.sid, turn: i, model: resolved.model });
      }
      // The whole-session verdict waits for the session to go quiet, and is refreshed as it grows.
      if (quiet && sess.turns.some((tr) => tr[1] >= since)) {
        queued += offer(s, {
          source: sess.source,
          sid: sess.sid,
          turn: null,
          model: resolved.model,
          count: sess.turns.length,
        });
      }
      visited.set(vkey, stamp);
      if (visited.size > SEEN_MAX * 4) visited.delete(visited.keys().next().value);
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
      if (typeof sid !== 'string' || !sid.startsWith('run:') || !Number.isFinite(row.end)) continue;
      if (t - row.end <= IDLE_MS || row.end < since) continue;
      if (Number.isFinite(row.start) && row.start < since) continue;
      queued += offer(s, { source: 'gateway', sid, turn: 0, model: resolved.model });
    }
    // Always give a stopped queue another go: the runner re-checks the caps, the gate and the model itself.
    if (queue.length) kick();
    return { queued };
  }

  async function enqueueSession(source, sid, evaluators) {
    if (demo) return { queued: 0 };
    if (typeof source !== 'string' || !source || typeof sid !== 'string' || !sid) {
      throw badRequest('source and session required');
    }
    const s = settings() || {};
    const named = Array.isArray(evaluators) ? evaluators.filter((id) => typeof id === 'string') : [];
    const only = named.length ? named : null;
    const resolved = await resolveQuiet();
    const model = resolved.ok ? resolved.model : null;
    const t = now();
    const sess = indexed().get(`${source}|${sid}`);
    let turns;
    let live = false;
    if (sess) {
      const idle = t - sess.mtimeMs > IDLE_MS;
      live = t - sess.mtimeMs < SESSION_IDLE_MS; // a session verdict on a running session would be stale at once
      turns = sess.turns.map((_, i) => i).filter((i) => i < sess.turns.length - 1 || idle);
    } else {
      // Not in the index (a gateway run, say): the registry knows its turns, and the owner asked for it.
      turns = (await trace.turnsOf(trace.keyFor(source, sid))).map((x) => x.index);
    }
    let queued = 0;
    for (const turn of turns) queued += offer(s, { source, sid, turn, only, model, force: true });
    let deferred = false;
    if (sess || turns.length) {
      if (live) {
        const target = targetOf(source, sid, null);
        deferred = evaluatorsFor('session', s, only).some((e) => !stored(target, e, model));
      } else {
        const count = sess ? sess.turns.length : null;
        queued += offer(s, { source, sid, turn: null, only, model, force: true, count });
      }
    }
    if (queue.length) kick();
    return deferred ? { queued, sessionDeferred: true } : { queued };
  }

  // The newest turn of a session that has finished, by the rule tick uses: a later turn exists, or the session has
  // been quiet for IDLE_MS. null when none has. A session the index does not hold (a gateway run) has its turns
  // from the registry and counts its last one as finished: the owner is asking for it by name.
  async function latestFinishedTurn(source, sid) {
    if (typeof source !== 'string' || !source || typeof sid !== 'string' || !sid) {
      throw badRequest('source and session required');
    }
    const sess = demo ? null : indexed().get(`${source}|${sid}`); // the demo index holds no entries
    if (sess) {
      const idle = now() - sess.mtimeMs > IDLE_MS;
      const last = idle ? sess.turns.length - 1 : sess.turns.length - 2;
      return last >= 0 ? last : null;
    }
    const turns = await trace.turnsOf(trace.keyFor(source, sid));
    return turns.length ? turns[turns.length - 1].index : null;
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
      if (!resolved.ok || blocked(s, resolved) || capped(s, resolved)) return;
      if (waitingOut(resolved)) return;
      const job = queue.shift();
      job.running = true;
      let outcome = 'done';
      try {
        outcome = await runJob(job, resolved, s);
      } catch {
        // Anything unexpected is a failure of this job, not of the queue; the job must not stay "pending".
        counters.errors++;
        dead.add(job.id);
        logOnce('job', 'evals: a judge job failed unexpectedly');
      }
      job.running = false;
      if (outcome === 'requeue') {
        queue.unshift(job);
        return;
      }
      if (pending.get(job.id) === job) pending.delete(job.id);
    }
  }

  // 'done' (finished or skipped) or 'requeue' (put it back and stop: a cap or a transient error).
  async function runJob(job, resolved, s) {
    const session = job.turn === null;
    const evs = evaluatorsFor(session ? 'session' : 'turn', s, job.only);
    job.ids = evs.map((e) => e.id);
    const first = targetOf(job.source, job.sid, job.turn);
    // A refresh judges again even though a result exists. A tick job skips what any model judged; a forced one
    // (the owner asked) judges again with this model.
    const done = (target, e) => (job.force ? stored(target, e, resolved.model) : judged(target, e));
    const needs = (target, e) => !done(target, e) || (job.refresh && session);
    if (!evs.some((e) => needs(first, e))) return 'done';
    let m;
    try {
      m = session
        ? await trace.materialSession(job.source, job.sid)
        : await trace.material(job.source, job.sid, job.turn);
    } catch (e) {
      const status = e && e.status;
      if (status === 404) {
        dead.add(job.id);
        counters.skipped++;
        logOnce('vanished', 'evals: a session file is gone, skipping its judgments');
        return 'done';
      }
      // A file that is busy or locked right now (EBUSY, EPERM) may read fine later.
      if (++job.tries < MAX_TRIES) {
        logOnce('material-retry', `evals: could not read a session (status ${status || 'unknown'}), will retry`);
        return 'requeue';
      }
      dead.add(job.id);
      counters.errors++;
      logOnce('material', `evals: gave up reading a session to judge (status ${status || 'unknown'})`);
      return 'done';
    }
    if (!m) {
      dead.add(job.id);
      counters.skipped++;
      logOnce('unjudgeable', 'evals: a session cannot be judged, skipping it');
      return 'done';
    }
    const target = m.target || first;
    const external = isExternal(resolved);
    const price = external && typeof models.priceOf === 'function' ? models.priceOf(resolved) : null;
    for (const e of evs) {
      if (!needs(target, e)) continue;
      // Re-check between evaluators: one turn can reach a cap part-way, and then it resumes where it stopped.
      if (capped(s, resolved)) return 'requeue';
      const refreshing = !!job.refresh && session;
      const key = refusal(R.resultKey(target, e.id, e.version, resolved.model), refreshing, job.count);
      let reply;
      let built;
      let estimate = 0;
      let inputOnly = 0;
      try {
        built = buildPrompt(e, m.material);
        // An external call is estimated from its input (about 4 characters a token) plus a short answer, and held
        // when that would go past the day's budget; a call that could never fit is dropped rather than left to
        // block the queue.
        if (price) {
          const tokensIn = (built.system.length + built.user.length) / 4;
          inputOnly = (tokensIn * (price.input || 0)) / 1e6;
          estimate = inputOnly + (OUTPUT_TOKENS * (price.output || 0)) / 1e6;
        }
        if (external && estimate > caps(s).cost) {
          refused.add(key);
          counters.errors++;
          logOnce('estimate', 'evals: a judge call is estimated to cost more than the whole daily cost cap');
          continue;
        }
        if (external && state.cost + estimate > caps(s).cost) {
          held = true; // shown as "cost cap" until the next day, so the stall has a reason
          return 'requeue';
        }
        held = false;
        reply = await models.call(resolved, { system: built.system, user: built.user, schema: built.schema });
      } catch (err) {
        const status = err && err.status;
        // The masked text may have reached the provider, so an external attempt counts against the daily cap.
        const transient = status === 0 || status === 429 || status >= 500;
        if (external && built) {
          state.count++;
          // Nothing came back or the provider failed: the call may still have been billed, so count its estimate.
          if (status === 0 || status >= 500) state.cost += estimate;
          save();
        }
        // Nothing answered, the provider is busy or failing: try again on a later pass, a few times at most.
        if (transient) {
          if (++job.tries < MAX_TRIES) {
            logOnce('retry', 'evals: the judge model did not answer, will retry');
            return 'requeue';
          }
          // The provider is down: leave the whole queue alone for 1, 2, 4 ... 30 minutes rather than lose jobs one by
          // one. The job stays, and each later attempt is a single probe.
          const b = backoff.get(resolved.provider) || { fails: 0, until: 0 };
          b.fails++;
          b.until = now() + Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (b.fails - 1));
          backoff.set(resolved.provider, b);
          job.tries = MAX_TRIES - 1;
          counters.errors++;
          logOnce('call', `evals: the judge provider is not answering (status ${status}), backing off`);
          return 'requeue';
        }
        refused.add(key);
        counters.errors++;
        logOnce('call', `evals: a judge call failed (status ${status === undefined ? 'unknown' : status})`);
        continue;
      }
      backoff.delete(resolved.provider);
      state.count++;
      // A cost is never negative, and one that is missing or not a number is unknown: count the estimate then.
      let c = reply.usage && Number.isFinite(reply.usage.cost) ? Math.max(0, reply.usage.cost) : null;
      // A provider that sent no usage is reported at cost 0, and a cost below what the input alone costs cannot be
      // the whole bill: an external call then counts at least its estimate, so the cost cap still holds.
      if (external && c !== null && (!(reply.usage.input > 0) || c < inputOnly)) c = Math.max(c, estimate);
      state.cost += c === null ? estimate : c;
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
          // How many turns a session verdict covered, so it can be refreshed once the session has grown.
          ...(session ? { turns: Number.isInteger(job.count) ? job.count : (m.material.prompts || []).length } : {}),
          finishedAt: Number.isFinite(m.finishedAt) ? m.finishedAt : null,
          ts: now(),
        });
        counters.judged++;
      } catch {
        counters.errors++;
        visited.delete(`${job.source}|${job.sid}`); // the next tick offers the session again
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
    let gate = r.ok ? blocked(s, r) : null;
    const b = r.ok && !gate ? backoff.get(r.provider) : null;
    if (b && now() < b.until) {
      gate = { reason: `Judge provider unavailable, retrying in ${Math.ceil((b.until - now()) / 60e3)} min` };
    }
    const judge = {
      ok: !!r.ok && !gate,
      kind: r.ok ? r.kind : null,
      model: r.ok ? r.model : null,
      provider: r.ok ? r.provider : null,
      waiting: !r.ok || !!gate,
      reason: r.ok ? (gate ? gate.reason : null) : r.reason || null,
    };
    if (gate && gate.confirm) judge.confirm = gate.confirm;
    const holding = held && queue.length > 0 && isExternal(r);
    const paused = s.judge === false ? 'judge off' : capped(s, r) || (holding ? 'cost cap' : null);
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
    latestFinishedTurn,
    drain,
    // Start the queue again now (after a setting changed or a preview was confirmed) instead of at the next tick.
    kick: () => kick(),
    results,
    summary,
    stats: () => ({ ...counters, queue: queue.length }),
  };
}

module.exports = { createEvalEngine };
