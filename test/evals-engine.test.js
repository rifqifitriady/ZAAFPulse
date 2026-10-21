const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEvalEngine } = require('../lib/evals/engine');
const { createEvalStore, createFeedbackStore } = require('../lib/evals/store');
const R = require('../lib/evals/registry');
const { buildPrompt } = require('../lib/evals/judge');
const { createModels, externalPayload } = require('../lib/evals/models');
const { createClaude } = require('../lib/evals/claude-cli');
const { fakeClaude } = require('./helpers');

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
const nextLoop = () => new Promise((r) => setImmediate(r)); // yield to the event loop

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
    priced: true,
    price: { input: 0, output: 0 },
    costs: null,
    busy: 0,
    settingsCalls: 0,
    priceThrows: false,
    usageIn: 10, // the input tokens a reply reports; 0 is a provider that sent no usage block
  };
  const calls = [];
  const mats = [];
  let inflight = 0;
  let maxInflight = 0;
  const models = {
    stop: () => (st.stopped = (st.stopped || 0) + 1),
    resolve: async () => st.resolved,
    priced: (resolved) => resolved.kind !== 'external' || st.priced,
    priceOf: (resolved) => {
      if (st.priceThrows) throw new Error('price table broke');
      return (resolved.kind === 'external' || resolved.kind === 'claude-cli') && st.priced ? st.price : null;
    },
    call: async (resolved, { system, user, schema, signal }) => {
      calls.push({ resolved, system, user, signal });
      if (st.failures > 0) {
        st.failures--;
        if (st.failErr) throw st.failErr();
        throw Object.assign(new Error('Ollama is not reachable'), { status: st.failStatus });
      }
      if (st.hang) {
        st.hang = false;
        await new Promise((_, rej) =>
          signal.addEventListener('abort', () => rej(Object.assign(new Error('cancelled'), { status: 0 }))),
        );
      }
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await nextLoop(); // yield, so an overlapping call would show
      inflight--;
      const label = schema.properties.label.enum[0];
      const text = st.text ? st.text() : JSON.stringify({ label, explanation: 'fine' });
      const cost = st.costs ? st.costs.shift() : st.cost;
      const usage = { input: st.usageIn, output: st.usageIn ? 5 : 0, cost };
      return { text, usage, ...(st.model ? { model: st.model } : {}) };
    },
  };
  const trace = {
    material: async (source, sid, turn) => {
      mats.push(`${source}|${sid}|${turn}`);
      if (st.busy > 0) {
        st.busy--;
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      }
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
      settings: () => {
        st.settingsCalls++;
        return st.settings;
      },
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
    // Let a runner that tick() or kick() started finish, without draining: the tests below never call drain().
    async settle() {
      for (let i = 0; i < 30; i++) await nextLoop();
    },
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
  assert.equal((await g.engine.status()).queue, 1); // kept: the provider is backed off, not the job dropped
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

// ---- review fixes ----
const turnsAfter = (n, from = T0 + 2 * MIN) => Array.from({ length: n }, (_, i) => from + i * MIN);
const extRig = (over = {}) =>
  rig({
    resolved: EXT,
    settings: { provider: 'openrouter', externalConfirmed: 'openrouter', costCapUSD: 0.05, ...over },
  });

test('an external model with no known price is refused, so a cost cap can never be bypassed', async () => {
  const r = extRig();
  r.st.priced = false;
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 0);
  assert.equal(r.mats.length, 0);
  const s = await r.engine.status();
  assert.equal(s.judge.ok, false);
  assert.equal(s.judge.reason, 'No price known for gpt-x, so the cost cap cannot apply');
  assert.equal(s.queue, 2);

  r.st.priced = true; // the price table learned the model
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2);
});

test('a negative cost cannot lower the total and an unknown one is counted by its estimate', async () => {
  const r = extRig({ costCapUSD: 10 });
  r.st.price = { input: 100, output: 0 }; // USD per million input tokens
  r.st.costs = [-5];
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 1);
  // Below what the input alone costs, so the estimate is counted: never less, never negative.
  const neg = (await r.engine.status()).today.cost;
  assert.ok(neg > 0 && neg < 1, `estimated cost counted, got ${neg}`);

  const n = extRig({ costCapUSD: 10 });
  n.st.price = { input: 100, output: 0 };
  n.st.costs = [NaN, null];
  await n.arm();
  n.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  n.clock.t = T0 + 20 * MIN;
  await n.engine.tick();
  await n.settle();
  const { cost } = (await n.engine.status()).today;
  assert.ok(cost > 0 && cost < 1, `estimated cost counted, got ${cost}`);
});

test('an external call is estimated from its input and refused when it would pass the budget', async () => {
  const material = { prompt: 'SECRET-PROMPT-TEXT', answer: 'a', tools: [], available: [] };
  const built = buildPrompt(R.get('faithfulness'), material);
  const tokens = (built.system.length + built.user.length) / 4;
  const perCall = 0.03; // USD
  const r = extRig({ costCapUSD: 0.05 });
  r.st.price = { input: (perCall * 1e6) / tokens, output: 0 };
  r.st.cost = perCall;
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 1); // 0.03 spent, a second 0.03 would pass 0.05
  assert.equal((await r.engine.status()).queue, 1);

  const big = extRig({ costCapUSD: 0.05 });
  big.st.price = { input: (1 * 1e6) / tokens, output: 0 }; // one call alone costs 1 USD
  await big.arm();
  big.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  big.clock.t = T0 + 20 * MIN;
  await big.engine.tick();
  await big.settle();
  assert.equal(big.calls.length, 0);
  assert.equal((await big.engine.status()).queue, 0); // dropped, not left to block the queue
  assert.equal(big.engine.stats().errors, 2);
});

test('tick alone restarts a stopped queue: the daily cap on the next day', async () => {
  const r = rig({ settings: { dailyCap: 3 } });
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(5), T0 + 8 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 3);
  r.clock.t = new Date(2026, 9, 22, 1, 0, 0).getTime();
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 5);
});

test('tick alone restarts a stopped queue: a transient failure, the gate, and a model that appears', async () => {
  const t = rig();
  await t.arm();
  t.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  t.clock.t = T0 + 20 * MIN;
  t.st.failures = 1;
  await t.engine.tick();
  await t.settle();
  assert.equal(t.calls.length, 1);
  assert.equal(t.store.all().length, 0);
  await t.engine.tick(); // the next minute
  await t.settle();
  assert.equal(t.calls.length, 2);
  assert.equal(t.store.all().length, 1);

  const g = extRig({ externalConfirmed: undefined });
  await g.arm();
  g.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  g.clock.t = T0 + 20 * MIN;
  await g.engine.tick();
  await g.settle();
  assert.equal(g.calls.length, 0);
  g.st.settings.externalConfirmed = 'openrouter';
  await g.engine.tick();
  await g.settle();
  assert.equal(g.calls.length, 2);

  const k = extRig({ externalConfirmed: undefined }); // a route can resume it at once through kick()
  await k.arm();
  k.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  k.clock.t = T0 + 20 * MIN;
  await k.engine.tick();
  await k.settle();
  k.st.settings.externalConfirmed = 'openrouter';
  k.engine.kick();
  await k.settle();
  assert.equal(k.calls.length, 2);

  const w = rig({ resolved: WAITING });
  w.st.entries.push(entry('s', [T0 - MIN, T0], T0));
  w.clock.t = T0 + 20 * MIN;
  assert.equal((await w.engine.enqueueSession('claude', 's')).queued, 2);
  await w.engine.tick();
  await w.settle();
  assert.equal(w.calls.length, 0);
  w.st.resolved = LOCAL;
  await w.engine.tick();
  await w.settle();
  assert.equal(w.calls.length, 2);
});

test('a call refused for good is tried once; ticks do not repeat it, a forced enqueue does', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  r.st.failures = 99;
  r.st.failStatus = 400;
  for (let i = 0; i < 4; i++) {
    await r.engine.tick();
    await r.settle();
  }
  assert.equal(r.calls.length, 1);
  assert.equal(r.engine.stats().errors, 1);
  r.st.failures = 0;
  assert.deepEqual(await r.engine.enqueueSession('claude', 's'), { queued: 1 }); // the owner asked
  await r.settle();
  assert.equal(r.store.all().length, 1);
});

test('a provider that keeps failing is backed off with growing pauses, and recovery judges every turn', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(4), T0 + 8 * MIN));
  r.clock.t = T0 + 20 * MIN;
  r.st.failures = 9999;
  r.st.failStatus = 503;
  await r.engine.tick();
  await r.settle();
  for (let i = 0; i < 3; i++) {
    await r.engine.tick(); // the same minute: left alone
    await r.settle();
  }
  assert.equal(r.calls.length, 3); // three tries, then the provider is backed off
  const s = await r.engine.status();
  assert.equal(s.judge.ok, false);
  assert.equal(s.judge.reason, 'Judge provider unavailable, retrying in 1 min');
  assert.equal(s.queue, 4); // no job was lost

  const gaps = [];
  let last = r.calls.length;
  for (let minute = 1; minute <= 40; minute++) {
    r.clock.t += MIN;
    await r.engine.tick();
    await r.settle();
    if (r.calls.length > last) {
      gaps.push(minute);
      last = r.calls.length;
    }
  }
  // One probe after 1, then 2, 4, 8, 16 minutes, and 30 at most.
  assert.deepEqual(
    gaps.slice(1).map((m, i) => m - gaps[i]),
    [2, 4, 8, 16],
  );
  assert.equal((await r.engine.status()).queue, 4);

  r.st.failures = 0; // the provider is back
  r.clock.t += 31 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.store.all().length, 4);
  assert.equal((await r.engine.status()).judge.ok, true);
  assert.equal((await r.engine.status()).queue, 0);
});

test('an external call that fails still counts against the daily cap', async () => {
  const r = extRig();
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  r.st.failures = 1;
  r.st.failStatus = 400;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal((await r.engine.status()).today.count, 1);

  const l = rig(); // a local failure sent nothing anywhere
  await l.arm();
  l.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  l.clock.t = T0 + 20 * MIN;
  l.st.failures = 1;
  l.st.failStatus = 400;
  await l.engine.tick();
  await l.settle();
  assert.equal((await l.engine.status()).today.count, 0);
});

test('history is not judged because its file was touched after since', async () => {
  const r = rig();
  await r.arm();
  r.clock.t = T0 + 20 * MIN;
  r.st.entries.push(entry('old', [T0 - 3 * 3600e3, T0 - 2 * 3600e3], T0 + 2 * MIN)); // mtime after since
  assert.equal((await r.engine.tick()).queued, 0);
  // The same session resumed: only the turn that started after since is new.
  r.st.entries.push(entry('res', [T0 - 3 * 3600e3, T0 - 2 * 3600e3, T0 + 5 * MIN], T0 + 6 * MIN));
  assert.equal((await r.engine.tick()).queued, 1);
  await r.settle();
  assert.deepEqual(r.store.all().map((x) => `${x.target.session}|${x.target.turn}`), ['res|2']);
});

test('the whole-session verdict waits for a quiet session and is refreshed when it has grown enough', async () => {
  const r = rig({ settings: { evaluators: only('user_frustration') } });
  await r.arm();
  const key = { source: 'claude', session: 's', turn: null, span: null };
  const verdict = () => r.store.all().find((x) => x.evaluator === 'user_frustration');

  r.st.entries.push(entry('s', turnsAfter(10), T0 + 12 * MIN));
  r.clock.t = T0 + 30 * MIN; // quiet for 18 minutes: still live
  assert.equal((await r.engine.tick()).queued, 0);
  r.clock.t = T0 + 50 * MIN; // quiet for 38 minutes
  assert.equal((await r.engine.tick()).queued, 1);
  await r.settle();
  assert.equal(verdict().turns, 10);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(verdict().target, key);

  r.st.entries[0] = entry('s', turnsAfter(14), T0 + 60 * MIN); // 14 < 10 + 5
  r.clock.t = T0 + 100 * MIN;
  assert.equal((await r.engine.tick()).queued, 0);
  r.st.entries[0] = entry('s', turnsAfter(15), T0 + 61 * MIN); // 15 = 10 + max(5, 5)
  assert.equal((await r.engine.tick()).queued, 1);
  await r.settle();
  assert.equal(r.calls.length, 2);
  assert.equal(r.store.all().length, 1); // the newest replaced the old under one key
  assert.equal(verdict().turns, 15);
  r.clock.t = T0 + 200 * MIN;
  assert.equal((await r.engine.tick()).queued, 0);

  // Nothing is refreshed while the session is live, even when it has doubled.
  r.st.entries[0] = entry('s', turnsAfter(40), r.clock.t - 5 * MIN);
  assert.equal((await r.engine.tick()).queued, 0);
});

test('enqueueSession leaves out the session verdict while the session is live', async () => {
  const r = rig({ settings: { evaluators: only('faithfulness', 'user_frustration') } });
  r.st.entries.push(entry('s', [T0 - 20 * MIN, T0 - 10 * MIN], T0 - 5 * MIN));
  // two turns, and the session verdict is held back because the session is still live
  assert.deepEqual(await r.engine.enqueueSession('claude', 's'), { queued: 2, sessionDeferred: true });
  await r.settle();
  assert.deepEqual(r.store.all().map((x) => x.evaluator), ['faithfulness', 'faithfulness']);
  r.clock.t = T0 + 40 * MIN; // quiet now
  assert.deepEqual(await r.engine.enqueueSession('claude', 's'), { queued: 1 });
});

test('a gateway row whose id is not a string is ignored', async () => {
  const r = rig();
  await r.arm();
  r.st.runs = [{ key: 42, source: 'gateway', end: T0 + 2 * MIN, turns: 1 }];
  r.clock.t = T0 + 20 * MIN;
  assert.deepEqual(await r.engine.tick(), { queued: 0 });
});

test('a job that throws unexpectedly leaves the queue and can be queued again', async () => {
  const r = extRig();
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  r.st.priceThrows = true;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.engine.stats().errors, 1);
  assert.equal((await r.engine.status()).queue, 0);
  r.st.priceThrows = false;
  assert.deepEqual(await r.engine.enqueueSession('claude', 's'), { queued: 1 }); // not stuck as "pending"
  await r.settle();
  assert.equal(r.calls.length, 1);
});

test('a file that is busy is read again later; a vanished one is not', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  r.st.busy = 1;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.mats.length, 1);
  assert.equal(r.store.all().length, 0);
  await r.engine.tick();
  await r.settle();
  assert.equal(r.mats.length, 2);
  assert.equal(r.store.all().length, 1);

  const g = rig();
  await g.arm();
  g.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  g.clock.t = T0 + 20 * MIN;
  g.st.busy = 99;
  for (let i = 0; i < 5; i++) {
    await g.engine.tick();
    await g.settle();
  }
  assert.equal(g.mats.length, 3); // three tries, then given up
  assert.equal(g.engine.stats().errors, 1);
});

test('the day never moves back when the clock does', async () => {
  const r = rig({ settings: { dailyCap: 2 } });
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(3), T0 + 8 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2);
  r.clock.t = new Date(2026, 9, 20, 10, 0, 0).getTime(); // yesterday
  await r.engine.tick();
  await r.settle();
  const s = await r.engine.status();
  assert.equal(s.today.count, 2);
  assert.equal(s.paused, 'daily cap');
  assert.equal(r.calls.length, 2);
});

test('an unchanged session is not looked at again, and one not touched since "since" is never looked at', async () => {
  const reads = { n: 0 };
  const counted = (times) =>
    times.map((ts) => {
      const a = [0, 0];
      Object.defineProperty(a, 1, {
        get() {
          reads.n++;
          return ts;
        },
      });
      return a;
    });
  const r = rig();
  await r.arm();
  const e = entry('s', [], T0 + 5 * MIN);
  e.result.sessions.s.turns = counted(turnsAfter(2));
  const old = entry('old', [], T0 - 3600e3);
  old.result.sessions.old.turns = counted([T0 - 7200e3]);
  r.st.entries.push(e, old);
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.ok(reads.n > 0);
  const first = reads.n;
  await r.engine.tick();
  await r.settle();
  assert.equal(reads.n, first, 'the second tick read nothing');
  assert.equal(r.calls.length, 2);
});

test('settings are read once per tick', async () => {
  const r = rig();
  await r.arm();
  r.st.settingsCalls = 0;
  await r.engine.tick();
  assert.equal(r.st.settingsCalls, 1);
});

test('evaluators named for a job that is already queued are merged into it', async () => {
  const r = rig({ settings: { judge: false, evaluators: only('relevance', 'faithfulness') } });
  r.st.entries.push(entry('s', [T0 - 20 * MIN], T0 - 10 * MIN));
  assert.deepEqual(await r.engine.enqueueSession('claude', 's', ['relevance']), { queued: 1 });
  assert.deepEqual(await r.engine.enqueueSession('claude', 's', ['faithfulness']), { queued: 1 });
  assert.deepEqual(await r.engine.enqueueSession('claude', 's', ['faithfulness']), { queued: 0 });
  assert.equal((await r.engine.status()).queue, 1);
  r.st.settings.judge = true;
  r.engine.kick();
  await r.settle();
  assert.equal(r.mats.length, 1);
  assert.deepEqual(r.store.all().map((x) => x.evaluator).sort(), ['faithfulness', 'relevance']);
});

test('numeric settings given as text are understood; nonsense falls back to the defaults', async () => {
  const r = rig({ settings: { dailyCap: '2', costCapUSD: 'lots' } });
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(4), T0 + 8 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2);
  assert.equal((await r.engine.status()).paused, 'daily cap');

  const d = rig({ settings: { dailyCap: 'many' } }); // falls back to 500
  await d.arm();
  d.st.entries.push(entry('s', turnsAfter(4), T0 + 8 * MIN));
  d.clock.t = T0 + 20 * MIN;
  await d.engine.tick();
  await d.settle();
  assert.equal(d.calls.length, 4);
});

// ---- second review ----
const writeState = (r, state) => fs.writeFileSync(r.stateFile, JSON.stringify(state));

test('a stored day far in the future is dropped on load, so judging is not held until that date', async () => {
  const r = rig({ settings: { dailyCap: 2 } });
  writeState(r, { since: T0 - 1, day: '2030-01-01', count: 2, cost: 0.5 });
  const e = r.make();
  const s = await e.status();
  assert.equal(s.today.count, 0);
  assert.equal(s.today.cost, 0);
  assert.equal(s.since, T0 - 1);
  for (const bad of ['yesterday', '2026-13-45', 20261021, null]) {
    writeState(r, { since: null, day: bad, count: 2, cost: 0 });
    assert.equal((await r.make().status()).today.count, 0, String(bad));
  }
  // Tomorrow is within a day of today: kept (a clock a few hours off), and so are today's counters.
  writeState(r, { since: null, day: '2026-10-22', count: 2, cost: 0 });
  assert.equal((await r.make().status()).today.count, 2);
});

test('a stored day far in the future is replaced at runtime, with one log line', async () => {
  const r = rig({ settings: { dailyCap: 2 } });
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(3), T0 + 8 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2);
  assert.equal((await r.engine.status()).paused, 'daily cap');
  // The clock had been wrong: it is now three days before the stored day.
  r.clock.t = new Date(2026, 9, 18, 10, 0, 0).getTime();
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 3);
  assert.equal((await r.engine.status()).today.count, 1);
  assert.equal(r.logs.filter((l) => l.includes('clock moved back')).length, 1);
});

test('a small step back in the clock does not hand out a new budget', async () => {
  const r = rig({ settings: { dailyCap: 2 } });
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(3), T0 + 8 * MIN));
  r.clock.t = new Date(2026, 9, 21, 23, 59, 0).getTime();
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2);
  r.clock.t = new Date(2026, 9, 21, 23, 50, 0).getTime(); // 23:59 -> 23:50, the same date
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2);
  r.clock.t = new Date(2026, 9, 22, 0, 5, 0).getTime(); // past midnight, then back across it
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 3);
  r.clock.t = new Date(2026, 9, 21, 23, 55, 0).getTime(); // one day behind the stored day: kept
  assert.equal((await r.engine.status()).today.count, 1);
  assert.equal(r.logs.filter((l) => l.includes('clock moved back')).length, 0);
});

test('a held external call shows "cost cap" as the reason until the next day', async () => {
  const material = { prompt: 'SECRET-PROMPT-TEXT', answer: 'a', tools: [], available: [] };
  const built = buildPrompt(R.get('faithfulness'), material);
  const tokens = (built.system.length + built.user.length) / 4;
  const r = extRig({ costCapUSD: 0.05 });
  r.st.price = { input: (0.03 * 1e6) / tokens, output: 0 };
  r.st.cost = 0.03;
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal((await r.engine.status()).paused, 'cost cap');
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 1);
  r.clock.t = new Date(2026, 9, 22, 1, 0, 0).getTime();
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2);
  assert.equal((await r.engine.status()).paused, null);
});

test('the estimate includes an answer allowance, and a failed external attempt is charged its estimate', async () => {
  const r = extRig({ costCapUSD: 10 });
  r.st.price = { input: 0, output: 1000 }; // 200 output tokens x 1000 USD per million = 0.2
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  r.st.failures = 1;
  r.st.failStatus = 503;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 1);
  const { cost } = (await r.engine.status()).today;
  assert.ok(Math.abs(cost - 0.2) < 1e-9, `charged ${cost}`);

  const q = extRig({ costCapUSD: 10 }); // a refusal (400) never reached the model: no charge
  q.st.price = { input: 0, output: 1000 };
  await q.arm();
  q.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  q.clock.t = T0 + 20 * MIN;
  q.st.failures = 1;
  q.st.failStatus = 400;
  await q.engine.tick();
  await q.settle();
  assert.equal((await q.engine.status()).today.cost, 0);
});

test('a result that could not be stored is offered again by the next tick', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  const put = r.store.put;
  r.store.put = () => {
    throw new Error('disk full');
  };
  await r.engine.tick();
  await r.settle();
  assert.equal(r.engine.stats().errors, 1);
  assert.equal(r.store.all().length, 0);
  r.store.put = put;
  assert.equal((await r.engine.tick()).queued, 1);
  await r.settle();
  assert.equal(r.store.all().length, 1);
});

test('a refresh merged into a queued session job updates the turn count it will record', async () => {
  const r = rig({ settings: { evaluators: only('user_frustration') } });
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(10), T0 + 12 * MIN));
  r.clock.t = T0 + 50 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.store.all()[0].turns, 10);

  r.st.settings.dailyCap = 0; // the queue cannot run, so the refresh waits
  r.st.entries[0] = entry('s', turnsAfter(15), T0 + 60 * MIN);
  r.clock.t = T0 + 100 * MIN;
  assert.equal((await r.engine.tick()).queued, 1);
  await r.settle();
  r.st.entries[0] = entry('s', turnsAfter(20), T0 + 110 * MIN);
  r.clock.t = T0 + 150 * MIN;
  await r.engine.tick();
  r.st.settings.dailyCap = 500;
  r.engine.kick();
  await r.settle();
  assert.equal(r.calls.length, 2);
  assert.equal(r.store.all()[0].turns, 20);
});

test('latestFinishedTurn: a later turn finishes the one before; the last one needs the session to be quiet', async () => {
  const r = rig();
  r.clock.t = T0 + 30 * MIN;
  const now = r.clock.t;
  r.st.entries.push(entry('one-live', [now - 60e3], now - 10e3)); // one turn, just written
  r.st.entries.push(entry('two-live', [now - 90e3, now - 60e3], now - 10e3)); // the first is done
  r.st.entries.push(entry('two-idle', [now - 900e3, now - 800e3], now - 600e3)); // quiet for 10 minutes
  r.st.entries.push(entry('one-idle', [now - 900e3], now - 600e3));
  r.st.entries.push(entry('empty', [], now - 600e3));
  assert.equal(await r.engine.latestFinishedTurn('claude', 'one-live'), null);
  assert.equal(await r.engine.latestFinishedTurn('claude', 'two-live'), 0);
  assert.equal(await r.engine.latestFinishedTurn('claude', 'two-idle'), 1);
  assert.equal(await r.engine.latestFinishedTurn('claude', 'one-idle'), 0);
  assert.equal(await r.engine.latestFinishedTurn('claude', 'empty'), null);
  // The same session becomes finished when it goes quiet.
  r.clock.t += 5 * MIN;
  assert.equal(await r.engine.latestFinishedTurn('claude', 'one-live'), 0);
  assert.equal(await r.engine.latestFinishedTurn('claude', 'two-live'), 1);
  // Not in the index (a gateway run): the registry's last turn.
  assert.equal(await r.engine.latestFinishedTurn('gateway', 'run:1'), 0);
  await assert.rejects(r.engine.latestFinishedTurn('', 'x'), { status: 400 });
});

// Final review: a provider that sends no usage block is reported as cost 0 by the gateway; the cap must still count.
test('an external reply with no usage, or a cost below its input estimate, is charged the estimate', async () => {
  const material = { prompt: 'SECRET-PROMPT-TEXT', answer: 'a', tools: [], available: [] };
  const built = buildPrompt(R.get('faithfulness'), material);
  const tokens = (built.system.length + built.user.length) / 4;
  const perCall = 0.03; // USD, from the input alone
  for (const usageIn of [0, 10]) {
    const r = extRig({ costCapUSD: 0.05 });
    r.st.price = { input: (perCall * 1e6) / tokens, output: 0 };
    r.st.cost = 0; // what the gateway reports when the upstream sent no usage
    r.st.usageIn = usageIn;
    await r.arm();
    r.st.entries.push(entry('s', turnsAfter(4), T0 + 7 * MIN));
    r.clock.t = T0 + 20 * MIN;
    await r.engine.tick();
    await r.settle();
    assert.equal(r.calls.length, 1, `input ${usageIn}: the second call would pass the cap`);
    const s = await r.engine.status();
    assert.ok(Math.abs(s.today.cost - perCall) < 1e-9, `charged ${s.today.cost}`);
    assert.equal(s.paused, 'cost cap');
  }
  // A reported cost above the estimate is what counts.
  const hi = extRig({ costCapUSD: 10 });
  hi.st.price = { input: (perCall * 1e6) / tokens, output: 0 };
  hi.st.cost = 0.5;
  await hi.arm();
  hi.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  hi.clock.t = T0 + 20 * MIN;
  await hi.engine.tick();
  await hi.settle();
  assert.ok(Math.abs((await hi.engine.status()).today.cost - 0.5) < 1e-9);
});

// Final review: a model change is not a reason to judge every turn since "since" again; the owner asks for that.
test('a model change does not re-judge what any model judged; a new turn and an explicit request do', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(2), T0 + 4 * MIN));
  r.clock.t = T0 + 10 * MIN;
  assert.equal((await r.engine.tick()).queued, 2);
  await r.settle();
  assert.equal(r.calls.length, 2);

  r.st.resolved = { ...LOCAL, model: 'llama3.1:8b' };
  assert.equal((await r.engine.tick()).queued, 0, 'the same turns, another model: nothing new');
  r.clock.t += MIN; // the session is looked at again, still nothing to do
  r.st.entries[0] = entry('s', turnsAfter(2), T0 + 4 * MIN + 1);
  assert.equal((await r.engine.tick()).queued, 0);
  await r.settle();
  assert.equal(r.calls.length, 2);

  // A turn that is genuinely new is judged by the new model.
  r.st.entries[0] = entry('s', turnsAfter(3), T0 + 11 * MIN);
  r.clock.t = T0 + 20 * MIN;
  assert.equal((await r.engine.tick()).queued, 1);
  await r.settle();
  assert.equal(r.calls.length, 3);
  assert.equal(r.calls.at(-1).resolved.model, 'llama3.1:8b');

  // "Judge this session" re-judges the older turns with the new model; the one it judged already is kept.
  assert.equal((await r.engine.enqueueSession('claude', 's')).queued, 2);
  await r.settle();
  assert.equal(r.calls.length, 5);
  assert.deepEqual(
    r.store.all().filter((x) => x.judge.model === 'llama3.1:8b').map((x) => x.target.turn).sort(),
    [0, 1, 2],
  );
});

test('a tick job for a newly enabled evaluator leaves the verdicts another model gave alone', async () => {
  const r = rig();
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(2), T0 + 4 * MIN));
  r.clock.t = T0 + 10 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2);
  r.st.resolved = { ...LOCAL, model: 'llama3.1:8b' };
  r.st.settings.evaluators = only('faithfulness', 'relevance');
  assert.equal((await r.engine.tick()).queued, 2);
  await r.settle();
  assert.equal(r.calls.length, 4, 'relevance for two turns, no second faithfulness');
  const fresh = r.store.all().filter((x) => x.judge.model === 'llama3.1:8b');
  assert.deepEqual([...new Set(fresh.map((x) => x.evaluator))], ['relevance']);

  // A tick job still queued when the owner asks for the session becomes his request: judged per model.
  const q = rig();
  await q.arm();
  q.st.entries.push(entry('s', turnsAfter(2), T0 + 4 * MIN));
  q.clock.t = T0 + 10 * MIN;
  await q.engine.tick();
  await q.settle();
  q.st.resolved = { ...LOCAL, model: 'llama3.1:8b' };
  q.st.settings.evaluators = only('faithfulness', 'relevance');
  q.st.settings.dailyCap = 2; // reached: the jobs stay queued
  assert.equal((await q.engine.tick()).queued, 2);
  await q.engine.enqueueSession('claude', 's');
  q.st.settings.dailyCap = 500;
  q.engine.kick();
  await q.settle();
  const asked = q.store.all().filter((x) => x.judge.model === 'llama3.1:8b');
  assert.equal(asked.length, 4, 'both evaluators for both turns');
});

// ---- the Claude Code judge: external, so the preview gate, the masking and both caps apply ----
const CLI = {
  ok: true,
  kind: 'claude-cli',
  model: 'haiku',
  provider: 'claude-code',
  destination: 'Anthropic, through your Claude login',
  confirm: 'claude-code@0123456789',
};
const cliRig = (over = {}) =>
  rig({
    resolved: CLI,
    settings: { provider: 'claude-code', externalConfirmed: CLI.confirm, costCapUSD: 1, ...over },
  });

test('claude-code: nothing is sent before its own preview is confirmed', async () => {
  const r = cliRig({ externalConfirmed: null });
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 0);
  assert.equal(r.mats.length, 0, 'not even read');
  let s = await r.engine.status();
  assert.equal(s.judge.reason, 'Confirm the preview before sending to claude-code');
  assert.equal(s.judge.confirm, 'claude-code');
  r.st.settings.externalConfirmed = 'openrouter';
  await r.engine.drain();
  assert.equal(r.calls.length, 0, "another provider's confirmation does not count");
  r.st.settings.externalConfirmed = 'claude-code';
  await r.engine.drain();
  assert.equal(r.calls.length, 0, 'the bare provider id confirms no destination');
  // A preview of another destination (an API key added, a base URL set since) asks for a new one.
  r.st.settings.externalConfirmed = 'claude-code@ffffffffff';
  await r.engine.drain();
  assert.equal(r.calls.length, 0);
  s = await r.engine.status();
  assert.equal(s.judge.reason, 'The Claude Code destination changed; preview again');
  assert.equal(s.judge.confirm, 'claude-code');
  r.st.settings.externalConfirmed = CLI.confirm;
  await r.engine.drain();
  assert.equal(r.calls.length, 2);
  const st = await r.engine.status();
  assert.equal(st.judge.kind, 'claude-cli');
  assert.equal(st.judge.ok, true);
  assert.equal(st.judge.destination, 'Anthropic, through your Claude login');
});

test('claude-code: the cost cap counts the reported total_cost_usd, and the estimate when there is none', async () => {
  const r = cliRig({ costCapUSD: 0.05 });
  r.st.costs = [0.03, 0.03, 0.03];
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(3), T0 + 6 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 2, '0.03, then 0.06 reaches the cap');
  let s = await r.engine.status();
  assert.ok(Math.abs(s.today.cost - 0.06) < 1e-9);
  assert.equal(s.paused, 'cost cap');

  // A reported cost below the input estimate is what the CLI worked out (cache reads are cheap): it is kept.
  const material = { prompt: 'SECRET-PROMPT-TEXT', answer: 'a', tools: [], available: [] };
  const built = buildPrompt(R.get('faithfulness'), material);
  const tokens = (built.system.length + built.user.length) / 4;
  const low = cliRig();
  low.st.price = { input: (0.02 * 1e6) / tokens, output: 0 };
  low.st.costs = [0.001];
  await low.arm();
  low.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  low.clock.t = T0 + 20 * MIN;
  await low.engine.tick();
  await low.settle();
  assert.ok(Math.abs((await low.engine.status()).today.cost - 0.001) < 1e-9);

  // No cost (or a zero one, which no real call has) counts the estimate.
  for (const missing of [null, 0, NaN]) {
    const n = cliRig();
    n.st.price = { input: (0.02 * 1e6) / tokens, output: 0 };
    n.st.costs = [missing];
    await n.arm();
    n.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
    n.clock.t = T0 + 20 * MIN;
    await n.engine.tick();
    await n.settle();
    s = await n.engine.status();
    assert.ok(Math.abs(s.today.cost - 0.02) < 1e-9, `${missing}: charged ${s.today.cost}`);
  }
});

test('claude-code: the daily count applies, and the model that answered is kept with the result', async () => {
  const r = cliRig({ dailyCap: 1 });
  r.st.model = 'claude-haiku-5-5';
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(2), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal((await r.engine.status()).paused, 'daily cap');
  const [res] = r.store.all();
  assert.deepEqual(res.judge, {
    kind: 'claude-cli',
    model: 'haiku',
    provider: 'claude-code',
    used: 'claude-haiku-5-5',
  });
});

test('claude-code: a CLI that keeps failing is backed off like any external provider', async () => {
  const r = cliRig();
  r.st.failures = 99;
  r.st.failStatus = 502;
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  for (let i = 0; i < 4; i++) {
    await r.engine.tick();
    await r.settle();
  }
  const s = await r.engine.status();
  assert.match(s.judge.reason, /Judge provider unavailable, retrying in/);
  assert.equal(r.calls.length, 3);
  assert.equal(s.today.count, 3, 'each attempt may have reached Anthropic, so it counts');
});

// The real models module and a fake claude: the gate holds every call, and once the preview is confirmed the CLI
// receives exactly the masked text the preview shows.
test('claude-code end to end: no call before the preview, then exactly the preview text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-engine-claude-'));
  dirs.push(dir);
  const log = path.join(dir, 'runs.jsonl');
  const env = { ZAAFPULSE_CLAUDE_BIN: fakeClaude(path.join(dir, 'bin')), FAKE_CLAUDE_LOG: log };
  const runs = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((x) => !x.version)
      : [];
  const settings = {
    judge: true,
    provider: 'claude-code',
    model: 'haiku',
    evaluators: only('relevance'),
    costCapUSD: 1,
  };
  const claude = createClaude({ env, home: dir, systemDirs: [] });
  const models = createModels({ settings: () => settings, claude });
  const material = {
    prompt: 'Mail ana@example.com about /Users/ana/notes.txt',
    answer: 'Sent to ana@example.com from 10.1.2.3',
    tools: [],
    available: [],
  };
  const clock = { t: T0 };
  const entries = [];
  const engine = createEvalEngine({
    trace: {
      material: async (source, sid, turn) => ({ material, target: { source, session: sid, turn, span: null } }),
      materialSession: async () => null,
      sessions: () => [],
      sourceOf: (k) => ({ source: 'claude', sid: k }),
      keyFor: (s, sid) => sid,
      turnsOf: async () => [],
    },
    indexer: { entries: () => entries },
    models,
    store: createEvalStore({ file: path.join(dir, 'evals.jsonl') }),
    feedback: createFeedbackStore({ file: path.join(dir, 'feedback.jsonl') }),
    settings: () => settings,
    stateFile: path.join(dir, 'state.json'),
    now: () => clock.t,
  });
  await engine.tick();
  clock.t += MIN;
  entries.push(entry('s', [T0 + 2 * MIN, T0 + 3 * MIN], T0 + 4 * MIN));
  clock.t = T0 + 20 * MIN;
  await engine.tick();
  await engine.drain();
  assert.equal(runs().length, 0, 'not confirmed: the CLI was never started');
  assert.equal((await engine.status()).judge.confirm, 'claude-code');

  settings.externalConfirmed = claude.destination().token;
  await engine.drain();
  const sent = runs();
  assert.equal(sent.length, 2);
  const built = buildPrompt(R.get('relevance'), material);
  const preview = externalPayload(built.system, built.user, built.schema);
  for (const run of sent) {
    assert.deepEqual({ system: run.argv[run.argv.indexOf('--system-prompt') + 1], user: run.stdin }, preview);
    assert.doesNotMatch(JSON.stringify(run), /ana@example|\/Users\/ana|10\.1\.2\.3/);
  }
  const s = await engine.status();
  assert.equal(s.today.count, 2);
  assert.ok(Math.abs(s.today.cost - 0.001) < 1e-9, 'the fake reports 0.0005 a call');
  const stored = createEvalStore({ file: path.join(dir, 'evals.jsonl') }).all();
  assert.equal(stored.length, 2);
  assert.ok(stored.every((x) => x.label === 'relevant' && x.judge.used === 'claude-haiku-5-5'));
});

test('claude-code: a login that is gone backs the judge off with its own reason', async () => {
  const r = cliRig();
  r.st.failures = 99;
  r.st.failErr = () =>
    Object.assign(new Error('Claude Code is not signed in'), {
      status: 401,
      backoff: true,
      reason: 'Claude Code is not signed in',
    });
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  for (let i = 0; i < 4; i++) {
    await r.engine.tick();
    await r.settle();
  }
  assert.equal(r.calls.length, 3, 'tried, then left alone rather than refused job by job');
  const s = await r.engine.status();
  assert.match(s.judge.reason, /^Claude Code is not signed in, retrying in \d+ min$/);
  assert.equal(s.queue, 1, 'the job waits; it is not dropped');
});

test('a running call is cancelled when the provider is switched, and by stop()', async () => {
  const r = cliRig();
  r.st.hang = true;
  await r.arm();
  r.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  r.clock.t = T0 + 20 * MIN;
  await r.engine.tick();
  await r.settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].signal.aborted, false);
  // The owner picks a local model: the call to Claude Code stops, and the job is judged by the new one.
  r.st.settings.provider = 'auto';
  r.st.resolved = LOCAL;
  r.engine.kick();
  await r.engine.drain();
  assert.equal(r.calls[0].signal.aborted, true);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].resolved.kind, 'ollama');
  assert.equal(r.store.all().length, 1);

  const q = cliRig();
  q.st.hang = true;
  await q.arm();
  q.st.entries.push(entry('s', turnsAfter(1), T0 + 5 * MIN));
  q.clock.t = T0 + 20 * MIN;
  await q.engine.tick();
  await q.settle();
  q.engine.stop();
  await q.settle();
  assert.equal(q.calls[0].signal.aborted, true);
  assert.equal(q.st.stopped, 1, 'and the models were told to stop their running calls at once');
  await q.engine.tick();
  await q.settle();
  assert.equal(q.calls.length, 1, 'a stopped engine starts nothing new');
});

test("the judge's own Claude Code sessions (run in its temp folder) are never judged", async () => {
  const r = rig();
  await r.arm();
  const times = turnsAfter(2);
  const own = entry('own', times, T0 + 5 * MIN);
  own.result.sessions.own.project = path.join(os.tmpdir(), 'zaafpulse-judge-Ab12Cd');
  const encoded = entry('enc', times, T0 + 5 * MIN);
  encoded.result.sessions.enc.project = '-private-var-folders-x-T-zaafpulse-judge-Zz9';
  const mine = entry('mine', times, T0 + 5 * MIN);
  mine.result.sessions.mine.project = '/Users/me/work/zaafpulse-judge-notes-app/sub';
  r.st.entries.push(own, encoded, mine);
  r.clock.t = T0 + 20 * MIN;
  const { queued } = await r.engine.tick();
  assert.equal(queued, 2, 'only the session that is not the judge');
});
