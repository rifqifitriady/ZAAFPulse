const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEvalEngine } = require('../lib/evals/engine');
const { createEvalStore, createFeedbackStore } = require('../lib/evals/store');
const R = require('../lib/evals/registry');

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const T0 = new Date(2026, 9, 21, 10, 0, 0).getTime(); // local 10:00
const MIN = 60e3;
const LOCAL = { ok: true, kind: 'ollama', model: 'qwen3:8b', provider: 'ollama' };
const EXT = { ok: true, kind: 'external', model: 'gpt-x', provider: 'openrouter' };
const WAITING = { ok: false, waiting: true, reason: 'Install or start Ollama, or choose a provider' };
// Only these judge evaluators are on; the rest are explicitly off so call counts stay predictable.
const only = (...ids) =>
  Object.fromEntries(R.EVALUATORS.filter((e) => e.kind === 'judge').map((e) => [e.id, ids.includes(e.id)]));
const entry = (sid, times, mtimeMs, source = 'claude') => ({
  file: `/x/${source}/${sid}.jsonl`,
  source,
  size: 1,
  mtimeMs,
  result: { sessions: { [sid]: { turns: times.map((t) => [0, t]) } }, signals: { events: [] } },
});
const tick = () => new Promise((r) => setImmediate(r));

function rig({ settings = {}, resolved = LOCAL, entries = [], demo, demoData } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-engine-'));
  dirs.push(dir);
  const clock = { t: T0 };
  const st = {
    settings: {
      judge: true,
      provider: 'auto',
      model: '',
      dailyCap: 500,
      costCapUSD: 1,
      evaluators: only('faithfulness'),
      ...settings,
    },
    resolved,
    entries,
    cost: 0,
    text: null,
    gone: new Set(),
    none: new Set(),
    runs: [],
    failures: 0,
    failStatus: 0,
  };
  const calls = [];
  const mats = [];
  let inflight = 0;
  let maxInflight = 0;
  const models = {
    resolve: async () => st.resolved,
    call: async (resolved, { system, user, schema }) => {
      calls.push({ resolved, system, user });
      if (st.failures > 0) {
        st.failures--;
        throw Object.assign(new Error('Ollama is not reachable'), { status: st.failStatus });
      }
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await tick(); // yield, so an overlapping call would show
      inflight--;
      const label = schema.properties.label.enum[0];
      const text = st.text ? st.text() : JSON.stringify({ label, explanation: 'fine' });
      return { text, usage: { input: 10, output: 5, cost: st.cost } };
    },
  };
  const trace = {
    material: async (source, sid, turn) => {
      mats.push(`${source}|${sid}|${turn}`);
      if (st.gone.has(`${sid}|${turn}`)) throw Object.assign(new Error('unknown session'), { status: 404 });
      if (st.none.has(`${sid}|${turn}`)) return null;
      return {
        material: { prompt: 'SECRET-PROMPT-TEXT', answer: 'a', tools: [], available: [] },
        target: { source, session: sid, turn, span: null },
        finishedAt: clock.t,
      };
    },
    materialSession: async (source, sid) => ({
      material: { prompts: ['SECRET-PROMPT-TEXT'] },
      target: { source, session: sid, turn: null, span: null },
    }),
    sessions: () => st.runs,
    sourceOf: (key) => ({ source: 'gateway', sid: key }),
    keyFor: (source, sid) => sid,
    turnsOf: async () => [{ index: 0, ts: T0 }],
  };
  const store = createEvalStore({ file: path.join(dir, 'evals.jsonl') });
  const feedback = createFeedbackStore({ file: path.join(dir, 'feedback.jsonl') });
  const logs = [];
  const stateFile = path.join(dir, 'evals-state.json');
  const make = () =>
    createEvalEngine({
      trace,
      indexer: { entries: () => st.entries },
      models,
      store,
      feedback,
      settings: () => st.settings,
      stateFile,
      now: () => clock.t,
      log: (m) => logs.push(m),
      demo,
      demoData,
    });
  const engine = make();
  return {
    engine,
    make,
    st,
    clock,
    calls,
    mats,
    store,
    feedback,
    logs,
    stateFile,
    maxInflight: () => maxInflight,
    // The first tick with nothing to judge records "since"; then the clock moves on a little.
    async arm() {
      await engine.tick();
      clock.t += MIN;
    },
  };
}

test('since: history before the judge was available is never judged, later turns are', async () => {
  const r = rig({ entries: [entry('old', [T0 - 3600e3, T0 - 3000e3], T0 - 2400e3)] });
  assert.equal((await r.engine.tick()).queued, 0);
  assert.equal((await r.engine.status()).since, T0);

  r.clock.t = T0 + 15 * MIN;
  r.st.entries.push(entry('new', [T0 + MIN, T0 + 5 * MIN], T0 + 6 * MIN)); // idle for 9 minutes: both turns finished
  // Still running: its last turn is not finished, but its first turn is (a later turn exists).
  r.st.entries.push(entry('live', [r.clock.t - 100e3, r.clock.t - 30e3], r.clock.t - 10e3));
  assert.equal((await r.engine.tick()).queued, 3);
  await r.engine.drain();

  const judged = r.store.all().map((x) => `${x.target.session}|${x.target.turn}`).sort();
  assert.deepEqual(judged, ['live|0', 'new|0', 'new|1']);
  assert.ok(!r.mats.some((m) => m.includes('|old|')));
});

test('idempotency: a second tick adds nothing, before and after the queue ran', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', [T0 + 2 * MIN, T0 + 3 * MIN], T0 + 4 * MIN));
  r.clock.t = T0 + 10 * MIN;
  assert.equal((await r.engine.tick()).queued, 2);
  assert.equal((await r.engine.tick()).queued, 0); // already queued
  await r.engine.drain();
  assert.equal(r.calls.length, 2);
  assert.equal((await r.engine.tick()).queued, 0); // already in the store
  await r.engine.drain();
  assert.equal(r.calls.length, 2);
});

test('the queue runs one job at a time', async () => {
  const r = rig();
  await r.arm();
  const times = Array.from({ length: 6 }, (_, i) => T0 + (2 + i) * MIN);
  r.st.entries.push(entry('s', times, T0 + 9 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.engine.drain();
  assert.equal(r.calls.length, 6);
  assert.equal(r.maxInflight(), 1);
});

test('the daily cap pauses at N and resumes on the next local day', async () => {
  const r = rig({ settings: { dailyCap: 3 } });
  await r.arm();
  const times = Array.from({ length: 5 }, (_, i) => T0 + (2 + i) * MIN);
  r.st.entries.push(entry('s', times, T0 + 8 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.engine.drain();
  assert.equal(r.calls.length, 3);
  let s = await r.engine.status();
  assert.equal(s.paused, 'daily cap');
  assert.equal(s.queue, 2);
  assert.equal(s.today.count, 3);

  await r.engine.drain(); // same day: still paused
  assert.equal(r.calls.length, 3);

  r.clock.t = new Date(2026, 9, 22, 1, 0, 0).getTime();
  await r.engine.tick();
  await r.engine.drain();
  assert.equal(r.calls.length, 5);
  s = await r.engine.status();
  assert.equal(s.paused, null);
  assert.equal(s.queue, 0);
  assert.equal(s.today.count, 2);
});

test('the cost cap pauses an external judge only', async () => {
  const ext = rig({
    resolved: EXT,
    settings: { provider: 'openrouter', externalConfirmed: 'openrouter', costCapUSD: 0.05 },
  });
  ext.st.cost = 0.03;
  await ext.arm();
  const times = Array.from({ length: 4 }, (_, i) => T0 + (2 + i) * MIN);
  ext.st.entries.push(entry('s', times, T0 + 7 * MIN));
  ext.clock.t = T0 + 20 * MIN;
  await ext.engine.tick();
  await ext.engine.drain();
  assert.equal(ext.calls.length, 2); // 0.03, then 0.06 >= 0.05
  const s = await ext.engine.status();
  assert.equal(s.paused, 'cost cap');
  assert.ok(Math.abs(s.today.cost - 0.06) < 1e-9);
  assert.equal(s.queue, 2);

  const loc = rig({ settings: { costCapUSD: 0.05 } });
  loc.st.cost = 0.03; // a local model reporting a cost is not capped
  await loc.arm();
  loc.st.entries.push(entry('s', times, T0 + 7 * MIN));
  loc.clock.t = T0 + 20 * MIN;
  await loc.engine.tick();
  await loc.engine.drain();
  assert.equal(loc.calls.length, 4);
  assert.equal((await loc.engine.status()).paused, null);
});

test('the external preview gate refuses until the provider is confirmed', async () => {
  const r = rig({ resolved: EXT, settings: { provider: 'openrouter' } });
  await r.arm();
  r.st.entries.push(entry('s', [T0 + 2 * MIN, T0 + 3 * MIN], T0 + 4 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.engine.drain();
  assert.equal(r.calls.length, 0);
  assert.equal(r.mats.length, 0);
  let s = await r.engine.status();
  assert.equal(s.judge.ok, false);
  assert.equal(s.judge.reason, 'Confirm the preview before sending to openrouter');
  assert.equal(s.queue, 2);

  r.st.settings.externalConfirmed = 'another-provider'; // a different provider's confirmation does not count
  await r.engine.drain();
  assert.equal(r.calls.length, 0);

  r.st.settings.externalConfirmed = 'openrouter';
  await r.engine.drain();
  assert.equal(r.calls.length, 2);
  s = await r.engine.status();
  assert.equal(s.judge.ok, true);
  assert.equal(s.queue, 0);
});

test('an invalid verdict is dropped, counted and not retried', async () => {
  const r = rig();
  await r.arm();
  r.st.text = () => 'this is not json';
  r.st.entries.push(entry('s', [T0 + 2 * MIN, T0 + 3 * MIN], T0 + 4 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.engine.drain();
  assert.equal(r.engine.stats().invalid, 2);
  assert.equal(r.store.all().length, 0);
  assert.equal((await r.engine.tick()).queued, 0); // not re-enqueued every minute
  await r.engine.drain();
  assert.equal(r.calls.length, 2);
});

test('waiting: with no model nothing is read or called, and the status says why', async () => {
  const r = rig({ resolved: WAITING });
  assert.equal((await r.engine.tick()).queued, 0);
  r.st.entries.push(entry('s', [T0 - MIN, T0], T0));
  r.clock.t = T0 + 20 * MIN;
  assert.equal((await r.engine.tick()).queued, 0);
  assert.equal((await r.engine.enqueueSession('claude', 's')).queued, 2);
  await r.engine.drain();
  assert.equal(r.calls.length, 0);
  assert.equal(r.mats.length, 0);
  const s = await r.engine.status();
  assert.equal(s.judge.ok, false);
  assert.equal(s.judge.waiting, true);
  assert.equal(s.judge.reason, WAITING.reason);
  assert.equal(s.since, null); // "since" starts when a judge first exists, not before

  r.st.resolved = LOCAL;
  await r.engine.drain();
  assert.equal(r.calls.length, 2);
});

test('judge off: nothing is enqueued by tick and queued jobs wait', async () => {
  const r = rig();
  await r.arm();
  r.st.settings.judge = false;
  r.st.entries.push(entry('s', [T0 + 2 * MIN, T0 + 3 * MIN], T0 + 4 * MIN));
  r.clock.t = T0 + 20 * MIN;
  assert.equal((await r.engine.tick()).queued, 0);
  assert.equal((await r.engine.enqueueSession('claude', 's')).queued, 2);
  await r.engine.drain();
  assert.equal(r.calls.length, 0);
  assert.equal((await r.engine.status()).paused, 'judge off');
  r.st.settings.judge = true;
  await r.engine.drain();
  assert.equal(r.calls.length, 2);
});

test('summary: agreement counts pass/good and not-pass/bad (3 agree, 1 disagree gives 0.75)', async () => {
  const r = rig();
  const put = (turn, evaluator, label, model = 'qwen3:8b') =>
    r.store.put({
      target: { source: 'claude', session: 's1', turn, span: null },
      evaluator,
      version: 1,
      kind: 'judge',
      label,
      score: R.scoreOf(R.get(evaluator), label),
      explanation: 'x',
      judge: { model, provider: 'ollama' },
      finishedAt: T0 - 60 * MIN,
      ts: T0,
    });
  put(0, 'faithfulness', 'faithful'); // pass + good: agree
  put(1, 'faithfulness', 'unfaithful'); // not pass + bad: agree
  put(2, 'faithfulness', 'faithful'); // pass + bad: disagree
  put(3, 'faithfulness', 'faithful'); // all pass + good: agree
  put(3, 'relevance', 'relevant');
  put(4, 'faithfulness', 'faithful'); // judged, but no feedback: not a pair
  put(5, 'faithfulness', 'faithful', 'other-model'); // a second model, same turn: still one verdict
  put(5, 'faithfulness', 'faithful');
  r.store.put({
    target: { source: 'claude', session: 's1', turn: null, span: null },
    evaluator: 'user_frustration',
    version: 1,
    kind: 'judge',
    label: 'high',
    score: 0,
    judge: { model: 'qwen3:8b', provider: 'ollama' },
    finishedAt: T0 - 60 * MIN,
    ts: T0,
  });
  const fb = (turn, rating) =>
    r.feedback.set({ target: { source: 'claude', session: 's1', turn, span: null }, rating });
  fb(0, 'good');
  fb(1, 'bad');
  fb(2, 'bad');
  fb(3, 'good');
  fb(9, 'good'); // feedback with no judge result: not a pair

  const s = r.engine.summary({ from: 0, to: T0 + 1e9 });
  assert.deepEqual(s.agreement, { pairs: 4, agree: 3, rate: 0.75 });
  const f = s.evaluators.faithfulness;
  assert.deepEqual({ pass: f.pass, total: f.total, rate: f.rate }, { pass: 5, total: 6, rate: 5 / 6 });
  assert.equal(s.evaluators.faithfulness.kind, 'judge');
  assert.equal(s.evaluators.user_frustration.total, 1); // a session-scope verdict never joins an agreement pair
});

test('summary: judge and code counts are merged, by turn time and range', async () => {
  const r = rig({ entries: [entry('s1', [T0 - 60 * MIN, T0 - 50 * MIN], T0 - 40 * MIN)] });
  r.store.put({
    target: { source: 'claude', session: 's1', turn: 0, span: null },
    evaluator: 'relevance',
    version: 1,
    kind: 'judge',
    label: 'partly',
    judge: { model: 'm', provider: 'ollama' },
    finishedAt: T0 - 50 * MIN,
    ts: T0,
  });
  r.store.put({
    target: { source: 'claude', session: 's1', turn: 1, span: null },
    evaluator: 'relevance',
    version: 1,
    kind: 'judge',
    label: 'relevant',
    judge: { model: 'm', provider: 'ollama' },
    finishedAt: T0 - 40 * MIN,
    ts: T0,
  });
  const all = r.engine.summary({ from: T0 - 2 * 3600e3, to: T0 });
  assert.equal(all.evaluators.relevance.kind, 'judge');
  assert.equal(all.evaluators.relevance.total, 2);
  assert.equal(all.evaluators.relevance.pass, 1);
  assert.equal(all.evaluators.relevance.rate, 0.5);
  const day = Object.values(all.evaluators.relevance.days);
  assert.deepEqual(day, [{ pass: 1, total: 2 }]);
  assert.equal(all.evaluators.secret_leak.kind, 'code');
  assert.equal(all.evaluators.secret_leak.total, 2);
  assert.equal(all.evaluators.secret_leak.pass, 2);
  assert.equal(all.evaluators.secret_leak.rate, 1);
  assert.equal(all.evaluators.faithfulness.total, 0);
  assert.equal(all.evaluators.faithfulness.rate, null);

  const narrow = r.engine.summary({ from: T0 - 45 * MIN, to: T0 });
  assert.equal(narrow.evaluators.relevance.total, 1);
  assert.equal(narrow.evaluators.secret_leak.total, 0); // both turns started before the window
});

test('results: judge results and code results are merged for a session, and filtered by turn', async () => {
  const r = rig({ entries: [entry('s1', [T0 - 60 * MIN, T0 - 50 * MIN], T0 - 40 * MIN)] });
  const base = { version: 1, kind: 'judge', judge: { model: 'm', provider: 'ollama' }, ts: T0 };
  const at = (session, turn) => ({ source: 'claude', session, turn, span: null });
  r.store.put({ ...base, target: at('s1', 1), evaluator: 'relevance', label: 'relevant', explanation: 'ok' });
  r.store.put({ ...base, target: at('s1', null), evaluator: 'user_frustration', label: 'none' });
  r.store.put({ ...base, target: at('other', 1), evaluator: 'relevance', label: 'relevant' });

  const turn = r.engine.results({ source: 'claude', session: 's1', turn: 1 });
  assert.ok(turn.every((x) => x.target.session === 's1' && x.target.turn === 1));
  assert.equal(turn.filter((x) => x.kind === 'judge').length, 1);
  assert.equal(turn.filter((x) => x.kind === 'code').length, 6);
  assert.ok(turn.some((x) => x.evaluator === 'secret_leak' && x.label === 'clean'));

  const whole = r.engine.results({ source: 'claude', session: 's1' });
  assert.ok(whole.some((x) => x.evaluator === 'user_frustration' && x.target.turn === null));
  assert.equal(whole.filter((x) => x.kind === 'code').length, 12);
});

test('enqueueSession ignores since and judges every finished turn plus the session evaluator', async () => {
  const r = rig({ settings: { evaluators: only('faithfulness', 'user_frustration') } });
  await r.arm();
  r.st.entries.push(entry('old', [T0 - 3 * 3600e3, T0 - 2 * 3600e3, T0 - 3600e3], T0 - 1800e3));
  assert.equal((await r.engine.tick()).queued, 0);
  assert.deepEqual(await r.engine.enqueueSession('claude', 'old'), { queued: 4 });
  assert.deepEqual(await r.engine.enqueueSession('claude', 'old'), { queued: 0 }); // already queued
  await r.engine.drain();
  assert.equal(r.calls.length, 4);
  const got = r.store.all().map((x) => `${x.evaluator}|${x.target.turn}`).sort();
  assert.deepEqual(got, ['faithfulness|0', 'faithfulness|1', 'faithfulness|2', 'user_frustration|null']);
  assert.deepEqual(await r.engine.enqueueSession('claude', 'old'), { queued: 0 }); // already judged
});

test('enqueueSession: only named evaluators run, and a session the index lacks uses the registry turns', async () => {
  const r = rig({ settings: { evaluators: only('faithfulness', 'relevance') } });
  r.st.entries.push(entry('s', [T0 - 3600e3], T0 - 1800e3));
  assert.deepEqual(await r.engine.enqueueSession('claude', 's', ['relevance']), { queued: 1 });
  await r.engine.drain();
  assert.deepEqual(r.store.all().map((x) => x.evaluator), ['relevance']);
  assert.deepEqual(await r.engine.enqueueSession('gateway', 'run:1'), { queued: 1 });
  await r.engine.drain();
  assert.ok(r.store.all().some((x) => x.target.source === 'gateway' && x.target.turn === 0));
});

test('gateway runs that finished after since are judged by tick', async () => {
  const r = rig();
  await r.arm();
  r.st.runs = [
    { key: 'run:old', source: 'gateway', end: T0 - 3600e3, turns: 1 },
    { key: 'run:new', source: 'gateway', end: T0 + 2 * MIN, turns: 1 },
    { key: 'run:live', source: 'gateway', end: null, turns: 1 },
    { key: 'req:abc', source: 'gateway', end: T0 + 2 * MIN, turns: 1 }, // a request group: never judgeable
  ];
  r.clock.t = T0 + 10 * MIN;
  assert.equal((await r.engine.tick()).queued, 1);
  await r.engine.drain();
  assert.deepEqual(r.mats, ['gateway|run:new|0']);
});

test('a vanished or non-judgeable turn is skipped, counted and logged once, without any text', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 4 * MIN], T0 + 5 * MIN));
  r.st.gone.add('s|0');
  r.st.gone.add('s|1');
  r.st.none.add('s|2');
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.engine.drain();
  assert.equal(r.calls.length, 0);
  assert.equal(r.engine.stats().skipped, 3);
  assert.equal(r.logs.length, 2); // one line per reason, not per job
  assert.ok(r.logs.every((l) => typeof l === 'string' && !l.includes('SECRET')));
  assert.equal((await r.engine.tick()).queued, 0); // not retried every minute
});

test('a model call that fails is retried later, and given up on after three tries', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', [T0 + 2 * MIN], T0 + 4 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  r.st.failures = 1; // Ollama went away for a moment
  await r.engine.drain();
  assert.equal(r.calls.length, 1);
  assert.equal((await r.engine.status()).queue, 1); // kept for the next pass
  await r.engine.drain();
  assert.equal(r.calls.length, 2);
  assert.equal(r.store.all().length, 1);
  assert.equal((await r.engine.status()).today.count, 1); // a failed call is not a judgment

  const g = rig();
  await g.arm();
  g.st.entries.push(entry('s', [T0 + 2 * MIN], T0 + 4 * MIN));
  g.clock.t = T0 + 20 * MIN;
  await g.engine.tick();
  g.st.failures = 99;
  for (let i = 0; i < 4; i++) await g.engine.drain();
  assert.equal(g.calls.length, 3);
  assert.equal((await g.engine.status()).queue, 0);
  assert.equal(g.engine.stats().errors, 1);
  assert.equal(g.store.all().length, 0);

  const bad = rig();
  await bad.arm();
  bad.st.entries.push(entry('s', [T0 + 2 * MIN], T0 + 4 * MIN));
  bad.clock.t = T0 + 20 * MIN;
  await bad.engine.tick();
  bad.st.failures = 1;
  bad.st.failStatus = 400; // the provider refused this input: retrying cannot help
  await bad.engine.drain();
  assert.equal((await bad.engine.status()).queue, 0);
  assert.equal(bad.engine.stats().errors, 1);
});

test('state persists across a restart: since and today counters', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', [T0 + 2 * MIN, T0 + 3 * MIN], T0 + 4 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.engine.drain();
  const before = await r.engine.status();
  assert.equal(before.today.count, 2);

  const again = r.make();
  const after = await again.status();
  assert.equal(after.since, before.since);
  assert.equal(after.since, T0);
  assert.equal(after.today.count, 2);
  const onDisk = JSON.parse(fs.readFileSync(r.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['cost', 'count', 'day', 'since']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.stateFile).mode & 0o777, 0o600);

  // The next local day starts the counters again, but keeps since.
  r.clock.t = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const next = r.make();
  const s = await next.status();
  assert.equal(s.today.count, 0);
  assert.equal(s.since, T0);
});

test('a corrupt state file starts clean instead of throwing', async () => {
  const r = rig();
  fs.writeFileSync(r.stateFile, '{not json');
  const e = r.make();
  const s = await e.status();
  assert.equal(s.since, null);
  assert.equal(s.today.count, 0);
});

test('the queue holds at most 2000 jobs and drops the oldest', async () => {
  const r = rig();
  r.st.settings.judge = false; // keep the jobs queued
  const times = Array.from({ length: 2100 }, (_, i) => T0 - (3000 - i) * MIN);
  r.st.entries.push(entry('big', times, T0 - 10 * MIN));
  assert.deepEqual(await r.engine.enqueueSession('claude', 'big'), { queued: 2100 });
  assert.equal((await r.engine.status()).queue, 2000);
  assert.equal(r.engine.stats().dropped, 100);
});

test('subagent files are not judged on their own', async () => {
  const r = rig();
  await r.arm();
  const sub = entry('s', [T0 + 2 * MIN], T0 + 3 * MIN);
  sub.file = '/x/claude/s/subagents/agent-1.jsonl';
  r.st.entries.push(sub);
  r.clock.t = T0 + 20 * MIN;
  assert.equal((await r.engine.tick()).queued, 0);
});

test('demo mode serves the supplied data and never calls a model', async () => {
  const demoData = {
    summary: {
      evaluators: { faithfulness: { kind: 'judge', pass: 8, total: 10, rate: 0.8, days: {} } },
      agreement: { pairs: 0, agree: 0, rate: null },
    },
    results: [{ evaluator: 'faithfulness', label: 'faithful' }],
    status: { judge: { ok: true }, queue: 0, today: { count: 0, cost: 0 }, paused: null, since: null },
  };
  const r = rig({ demo: true, demoData });
  assert.deepEqual(r.engine.summary({ from: 0, to: 1 }), demoData.summary);
  assert.deepEqual(r.engine.results({ source: 'claude', session: 'x' }), demoData.results);
  assert.deepEqual(await r.engine.status(), demoData.status);
  assert.deepEqual(await r.engine.tick(), { queued: 0 });
  assert.deepEqual(await r.engine.enqueueSession('claude', 'x'), { queued: 0 });
  await r.engine.drain();
  assert.equal(r.calls.length, 0);
  assert.equal(r.mats.length, 0);
  assert.equal(fs.existsSync(r.stateFile), false);
});
