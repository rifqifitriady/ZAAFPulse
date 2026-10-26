// test/budgets-engine.test.js
// The engine's budget pass with the real state store in a temp folder and spies for the channels and the agent
// control. Nothing here signals a process or shows a notification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMonitors } = require('../lib/monitors');
const { createMonitorState } = require('../lib/monitors/state');
const { createAgentControl } = require('../lib/agents/control');

const MIN = 60e3;
const T0 = new Date(2026, 9, 22, 12, 0, 0).getTime();
const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const ONE = { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }; // one input token is one dollar
const PRICING = { 'test-model': ONE, 'other-model': ONE };
let reqId = 0;
const usage = (ts, sid, usd, tool, model) => [ts, tool, sid, model, usd, 0, 0, 0, 0, false, `r${++reqId}`, null];
const session = (cwd, tool = 'claude') => ({
  tool,
  project: cwd,
  first: T0 - 60 * MIN,
  last: T0 - 5 * MIN,
  prompts: 1,
  promptTs: [T0 - 60 * MIN],
  tools: {},
  skills: {},
  agents: {},
  subagentFiles: 0,
});
// Today: s1 in ~/acme-web cost 9, s2 in ~/lab cost 5 on another model, the Codex session s3 in ~/acme-api cost 3.
const RESULTS = [
  {
    events: [
      usage(T0 - 30 * MIN, 's1', 9, 'claude', 'test-model'),
      usage(T0 - 20 * MIN, 's2', 5, 'claude', 'other-model'),
      usage(T0 - 10 * MIN, 's3', 3, 'codex', 'test-model'),
    ],
    sessions: {
      s1: session(path.join(HOME, 'acme-web')),
      s2: session(path.join(HOME, 'lab')),
      s3: session(path.join(HOME, 'acme-api'), 'codex'),
    },
  },
];
const AGENTS = ['claude:s1', 'claude:s2', 'codex:s3'].map((id) => ({
  id,
  kind: 'session',
  state: 'working',
  project: 'p',
  lastTs: T0 - 1000,
}));
const view = (over = {}) => ({
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  periodKey: 'month:2026-10-01',
  enforce: 'none',
  state: 'ok',
  projected: false,
  percent: 10,
  ...over,
});

// `results`, `home` and `billingMode` stand in for the index, the home folder and the ledger's billing; `makeControl`
// builds the agent control from the test clock (the real one with fakes, in the control test).
function setup({
  views = [],
  demo = false,
  retired = [],
  conf = {},
  pauseThrows = false,
  results = RESULTS,
  home = HOME,
  billingMode = null,
  makeControl = null,
  aggregate,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-budgets-engine-'));
  const clock = { t: T0 };
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
    config: () => ({ pricing: PRICING, ...conf }),
  });
  const data = { views, complete: true };
  const sent = [];
  const calls = { candidates: [], pause: [], resume: [], stop: [] };
  const spy = {
    async candidates(a) {
      calls.candidates.push(a);
      return [{ pid: 4242, startTime: T0 - 90 * MIN }];
    },
    async pause(target, meta) {
      calls.pause.push({ target, meta });
      if (pauseThrows) throw Object.assign(new Error('the process is gone'), { status: 409 });
      return { ok: true };
    },
    async resume(target, meta) {
      calls.resume.push({ target, meta });
    },
    async stop(target, meta) {
      calls.stop.push({ target, meta });
    },
    async paused() {
      return [];
    },
  };
  const control = makeControl ? makeControl(clock) : spy;
  const monitors = createMonitors({
    indexer: { results: () => results },
    office: {
      snapshot: () => ({ ts: clock.t, agents: AGENTS }),
      demoSnapshot: () => ({ ts: clock.t, agents: AGENTS }),
    },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({ pricing: PRICING, ...conf }),
    state,
    channels: {
      notify: async (alert, o) => {
        sent.push({ alert, title: o && o.title });
        return { desktop: true, webhook: false };
      },
    },
    control,
    now: () => clock.t,
    log: () => {},
    demo,
    platform: 'darwin',
    budgets: {
      evaluate: () => data.views.map((v) => ({ ...v })),
      complete: () => data.complete,
      centerOfProject: (p) => (p.startsWith('~/acme') ? 'acme' : 'unassigned'),
      ...(billingMode ? { billingMode } : {}),
    },
    retired,
    home,
    ...(aggregate ? { aggregate } : {}),
  });
  // The order of the server: the index refresh (aggregate), then the ledger pass (budgets), and the live pass.
  const cycle = async () => {
    await monitors.tickAggregate();
    await monitors.tickBudgets();
    await monitors.tickLive();
  };
  return { monitors, state, data, sent, calls, clock, cycle };
}
const budgetSent = (sent) => sent.filter((s) => s.alert.rule === 'budget' && s.alert.action === undefined);
const pauseNotes = (state) => state.alerts({ limit: 100 }).filter((a) => a.rule === 'budget' && a.action === 'pause');

test('engine: budget states alert on a change only, with the name as the title', async () => {
  const e = setup({ views: [view()] });
  await e.cycle();
  assert.equal(budgetSent(e.sent).length, 0);
  e.data.views = [view({ state: 'warn_50', percent: 55 })];
  await e.monitors.tickBudgets();
  const s = budgetSent(e.sent);
  assert.equal(s.length, 1);
  assert.deepEqual(
    [s[0].alert.state, s[0].alert.previous, s[0].alert.value, s[0].alert.threshold, s[0].alert.period, s[0].title],
    ['warn_50', 'ok', 55, 50, 'month', 'Team'],
  );
  await e.monitors.tickBudgets();
  assert.equal(budgetSent(e.sent).length, 1, 'no repeat');
  e.data.views = [];
  e.data.complete = false;
  await e.monitors.tickBudgets();
  assert.equal(
    e.state.states().filter((x) => x.rule === 'budget').length,
    1,
    'not retired while the list did not read',
  );
  e.data.complete = true;
  await e.monitors.tickBudgets();
  assert.equal(e.state.states().filter((x) => x.rule === 'budget').length, 0, 'retired with its budget');
});

test('engine: demo mode evaluates budgets but never notifies or pauses', async () => {
  const e = setup({ demo: true, views: [view({ state: 'exceeded', percent: 120, enforce: 'pause' })] });
  await e.cycle();
  await e.monitors.tickBudgets();
  assert.equal(e.sent.length, 0);
  assert.equal(e.calls.pause.length, 0);
  assert.equal(e.calls.candidates.length, 0);
});

test('engine: an exceeded pause budget pauses the costliest running session in scope, once per period', async () => {
  const e = setup({ views: [view({ state: 'exceeded', percent: 120, enforce: 'pause' })] });
  await e.cycle();
  assert.equal(e.calls.pause.length, 1);
  assert.deepEqual(e.calls.pause[0].meta, { by: 'rule', rule: 'budget', sessionId: 's1' });
  assert.deepEqual(e.calls.pause[0].target, { pid: 4242, startTime: T0 - 90 * MIN });
  assert.equal(e.calls.candidates[0].source, 'claude');
  assert.deepEqual(
    pauseNotes(e.state).map((n) => [n.ok, n.code]),
    [[true, 'paused']],
  );
  await e.cycle();
  await e.cycle();
  assert.equal(e.calls.pause.length, 1, 'once per period');
  assert.equal(e.calls.resume.length, 0, 'never resumed');
  e.data.views = [view({ state: 'exceeded', percent: 130, enforce: 'pause', periodKey: 'month:2026-11-01' })];
  await e.cycle();
  assert.equal(e.calls.pause.length, 2, 'a new period may pause again');
});

test('engine: the scope picks the session; a scope with no session in it reports once and pauses nothing', async () => {
  const pausedFor = async (scope) => {
    const e = setup({ views: [view({ state: 'exceeded', enforce: 'pause', scope })] });
    await e.cycle();
    return e.calls.pause.map((p) => p.meta.sessionId);
  };
  assert.deepEqual(await pausedFor({ dim: 'source', value: 'codex' }), ['s3']);
  assert.deepEqual(await pausedFor({ dim: 'project', value: '~/lab' }), ['s2']);
  assert.deepEqual(await pausedFor({ dim: 'center', value: 'acme' }), ['s1'], 'through the folder rules');
  assert.deepEqual(await pausedFor({ dim: 'model', value: 'other-model' }), ['s2']);
  assert.deepEqual(await pausedFor({ dim: 'key', value: 'key_a' }), [], 'a key has no local session');
  const e = setup({
    views: [view({ state: 'exceeded', enforce: 'pause', scope: { dim: 'project', value: '~/nowhere' } })],
  });
  await e.cycle();
  await e.cycle();
  assert.equal(e.calls.pause.length, 0);
  assert.deepEqual(
    pauseNotes(e.state).map((n) => [n.ok, n.code]),
    [[false, 'none']],
    'reported once',
  );
});

test('engine: notify-only and warning budgets never pause; a refused pause is reported', async () => {
  const quiet = setup({
    views: [view({ state: 'exceeded', enforce: 'none' }), view({ id: 'b', state: 'warn_80', enforce: 'pause' })],
  });
  await quiet.cycle();
  assert.equal(quiet.calls.pause.length, 0);
  const refused = setup({ pauseThrows: true, views: [view({ state: 'exceeded', enforce: 'pause' })] });
  await refused.cycle();
  assert.deepEqual(
    pauseNotes(refused.state).map((n) => [n.ok, n.code]),
    [[false, 'refused']],
  );
});

test('engine: retired rules are not evaluated', async () => {
  const conf = { monthlyBudgetUSD: 300 }; // daily_cost is on by default, with a limit of 10 a day; today cost 17
  const on = setup({ conf });
  await on.monitors.tickAggregate();
  assert.equal(on.sent.filter((s) => s.alert.rule === 'daily_cost').length, 1);
  const off = setup({ conf, retired: ['daily_cost', 'month_projection'] });
  await off.monitors.tickAggregate();
  assert.equal(off.sent.filter((s) => s.alert.rule === 'daily_cost' || s.alert.rule === 'month_projection').length, 0);
  assert.equal((await off.monitors.status()).counts.triggered, 0);
});

test('engine: the period spend is built only for an exceeded pause budget not acted on this period', async () => {
  // dedupeEvents runs once per aggregate pass for the recent usage; the period spend adds a call when it is built.
  const real = require('../lib/aggregate');
  const counted = () => {
    const n = { calls: 0 };
    const aggregate = { ...real, dedupeEvents: (...a) => (n.calls++, real.dedupeEvents(...a)) };
    return { n, aggregate };
  };
  const a = counted();
  const quiet = setup({
    aggregate: a.aggregate,
    views: [
      view({ state: 'exceeded', enforce: 'block' }),
      view({ id: 'w', state: 'warn_80', enforce: 'pause' }),
      view({ id: 'n', state: 'exceeded', enforce: 'none' }),
    ],
  });
  await quiet.cycle();
  await quiet.cycle();
  assert.equal(a.n.calls, 2, 'no budget pauses: the period spend is never built');
  const b = counted();
  const e = setup({ aggregate: b.aggregate, views: [view({ state: 'exceeded', percent: 120, enforce: 'pause' })] });
  await e.cycle();
  assert.equal(e.calls.pause.length, 1);
  assert.equal(b.n.calls, 2, 'built once, for the pause');
  await e.cycle();
  await e.cycle();
  assert.equal(b.n.calls, 4, 'acted on this period: not built again');
});

// ---- the target of a budget's pause: the running session that spent the most in the budget's scope and period ----
const pausedOf = async (opts) => {
  const e = setup(opts);
  await e.cycle();
  return e.calls.pause.map((p) => p.meta.sessionId);
};
const exceeded = (over) => [view({ state: 'exceeded', enforce: 'pause', ...over })];

test('engine: a model budget pauses the session that spent the most on that model, not the costliest overall', async () => {
  // s1 cost 9 on test-model and 0.01 on other-model; s2 cost 5 on other-model.
  const mixed = [
    {
      events: [
        usage(T0 - 30 * MIN, 's1', 9, 'claude', 'test-model'),
        usage(T0 - 25 * MIN, 's1', 0.01, 'claude', 'other-model'),
        usage(T0 - 20 * MIN, 's2', 5, 'claude', 'other-model'),
      ],
      sessions: { s1: session(path.join(HOME, 'acme-web')), s2: session(path.join(HOME, 'lab')) },
    },
  ];
  const scope = (value) => ({ dim: 'model', value });
  assert.deepEqual(await pausedOf({ results: mixed, views: exceeded({ scope: scope('other-model') }) }), ['s2']);
  assert.deepEqual(await pausedOf({ results: mixed, views: exceeded({ scope: scope('test-model') }) }), ['s1']);
});

test("engine: sessions rank by their cost in the budget's period, for a center and a project", async () => {
  // s3 (~/acme-api, Codex) cost 20 on 5 October and nothing today; s1 (~/acme-web) cost 9 today.
  const earlier = [
    {
      events: [
        usage(new Date(2026, 9, 5, 10, 0, 0).getTime(), 's3', 20, 'codex', 'test-model'),
        usage(T0 - 30 * MIN, 's1', 9, 'claude', 'test-model'),
      ],
      sessions: { s1: session(path.join(HOME, 'acme-web')), s3: session(path.join(HOME, 'acme-api'), 'codex') },
    },
  ];
  const acme = { dim: 'center', value: 'acme' };
  assert.deepEqual(await pausedOf({ results: earlier, views: exceeded({ scope: acme }) }), ['s3'], 'the month');
  const week = { period: 'week', periodKey: 'week:2026-10-19' };
  assert.deepEqual(await pausedOf({ results: earlier, views: exceeded({ scope: acme, ...week }) }), ['s1'], 'the week');
  const day = { period: 'day', periodKey: 'day:2026-10-22' };
  assert.deepEqual(await pausedOf({ results: earlier, views: exceeded({ scope: acme, ...day }) }), ['s1'], 'the day');
  // The view's own from and to win over its period name.
  const range = { from: '2026-10-01', to: '2026-10-10' };
  assert.deepEqual(await pausedOf({ results: earlier, views: exceeded({ scope: acme, ...day, ...range }) }), ['s3']);
  // A project scope: the costliest session overall (s1) is not in it.
  const project = { dim: 'project', value: '~/acme-api' };
  assert.deepEqual(await pausedOf({ views: exceeded({ scope: project }) }), ['s3']);
});

test('engine: a billed budget ranks by what was billed: nothing for a source on a plan', async () => {
  const billingMode = (source) => (source === 'claude' ? 'plan' : 'metered');
  assert.deepEqual(await pausedOf({ billingMode, views: exceeded({ measure: 'billed' }) }), ['s3']);
  assert.deepEqual(await pausedOf({ billingMode, views: exceeded({ measure: 'list' }) }), ['s1'], 'list ignores it');
  const throwing = () => {
    throw new Error('the billing history could not be read');
  };
  assert.deepEqual(await pausedOf({ billingMode: throwing, views: exceeded({ measure: 'billed' }) }), ['s1']);
});

test('engine: without the home folder a project or center pause says so and pauses nothing', async () => {
  for (const scope of [
    { dim: 'project', value: '~/lab' },
    { dim: 'center', value: 'acme' },
  ]) {
    const e = setup({ home: '', views: exceeded({ scope }) });
    await e.cycle();
    await e.cycle();
    assert.equal(e.calls.pause.length, 0);
    const notes = pauseNotes(e.state);
    assert.deepEqual(
      notes.map((n) => [n.ok, n.code]),
      [[false, 'none']],
    );
    assert.match(notes[0].reason, /home folder is not known/);
    assert.doesNotMatch(notes[0].reason, /[\\/]/, 'path-free');
  }
  assert.deepEqual(await pausedOf({ home: '', views: exceeded({ scope: { dim: 'source', value: 'codex' } }) }), ['s3']);
});

test('engine + the real agent control: a budget pause sends SIGSTOP once to the verified agent', async () => {
  const kills = [];
  const audit = [];
  let ctl = null;
  const makeControl = (clock) => {
    ctl = createAgentControl({
      platform: 'linux',
      inDocker: false,
      serverMode: false,
      now: () => clock.t,
      audit: { record: (e) => audit.push(e) },
      kill: (pid, signal) => {
        kills.push([pid, signal]); // a spy: nothing is signalled
        return true;
      },
      processes: {
        rows: async () => [
          {
            pid: 4242,
            cpu: 1,
            rssKB: 1024,
            upSec: 90 * 60,
            args: '/home/u/.local/bin/claude --resume',
            argv: ['/home/u/.local/bin/claude', '--resume'],
            cwd: path.join(HOME, 'acme-web'),
          },
          {
            pid: 5151,
            cpu: 1,
            rssKB: 1024,
            upSec: 90 * 60,
            args: '/usr/bin/vim notes',
            argv: ['/usr/bin/vim', 'notes'],
          },
        ],
      },
    });
    return ctl;
  };
  const e = setup({ makeControl, views: exceeded() });
  await e.cycle();
  await e.cycle();
  const signals = kills.filter(([, s]) => s !== 0);
  assert.deepEqual(signals, [[4242, 'SIGSTOP']], 'one SIGSTOP, never SIGKILL');
  assert.deepEqual(
    pauseNotes(e.state).map((n) => [n.ok, n.code]),
    [[true, 'paused']],
  );
  const ok = audit.filter((a) => a.ok === true);
  assert.deepEqual(
    ok.map((a) => [a.action, a.rule, a.by, a.sessionId, a.signal]),
    [['pause', 'budget', 'rule', 's1', 'SIGSTOP']],
  );
  // Every other check still holds for a budget: no resume or stop by a rule, no other rule id, no non-agent process.
  const target = { pid: 4242, startTime: e.clock.t - 90 * MIN };
  const refused = (p, status) => assert.rejects(p, (err) => err.status === status);
  await refused(ctl.resume(target, { by: 'rule', rule: 'budget', sessionId: 's1' }), 403);
  await refused(ctl.stop(target, { by: 'rule', rule: 'budget', sessionId: 's1' }), 403);
  await refused(ctl.pause(target, { by: 'rule', rule: 'accuracy_drop', sessionId: 's1' }), 403);
  await refused(ctl.pause(target, { by: 'rule', rule: 'month_projection', sessionId: 's1' }), 403);
  await refused(ctl.pause({ pid: 5151, startTime: e.clock.t - 90 * MIN }, { by: 'rule', rule: 'budget' }), 403);
  assert.deepEqual(
    kills.filter(([, s]) => s !== 0),
    [[4242, 'SIGSTOP']],
    'no signal for a refusal',
  );
});

// ---- a budget changed while the agent is being looked up: the pause chosen before it is dropped ----
// The lookup (control.candidates) is held open until the test releases it; the control is a spy that signals nothing.
function deferred() {
  const d = { pauses: [], waiting: null };
  d.control = () => ({
    async candidates() {
      let release;
      const gate = new Promise((r) => (release = r));
      d.waiting = release;
      await gate;
      return [{ pid: 4242, startTime: T0 - 90 * MIN }];
    },
    async pause(target, meta) {
      d.pauses.push(meta.sessionId);
      return { ok: true };
    },
    async paused() {
      return [];
    },
  });
  // Resolves once a lookup is waiting.
  d.entered = async () => {
    for (let i = 0; i < 200 && !d.waiting; i++) await new Promise((r) => setImmediate(r));
    assert.ok(d.waiting, 'a lookup started');
  };
  d.release = () => {
    const r = d.waiting;
    d.waiting = null;
    r();
  };
  return d;
}

test('engine: a pause turned off while its agent is looked up sends nothing; the budget is not used up', async () => {
  const d = deferred();
  const e = setup({ views: exceeded(), makeControl: d.control });
  await e.monitors.tickAggregate();
  await e.monitors.tickBudgets(); // no live pass yet: nothing to act on
  const live = e.monitors.tickLive();
  await d.entered();
  e.data.views = exceeded({ enforce: 'none' });
  await e.monitors.tickBudgets();
  d.release();
  await live;
  assert.deepEqual(d.pauses, [], 'no pause after the owner turned it off');
  assert.equal(pauseNotes(e.state).length, 0, 'nothing to report: the action was dropped');
  // The period was not used up: pause on again, the next pass acts.
  e.data.views = exceeded();
  const again = e.cycle();
  await d.entered();
  d.release();
  await again;
  assert.deepEqual(d.pauses, ['s1']);
});

test('engine: a scope or period changed while the agent is looked up drops the stale pause', async () => {
  // The scope: the global budget picked s1; now it covers Codex only, so s3 is the right target on the next pass.
  const d = deferred();
  const e = setup({ views: exceeded(), makeControl: d.control });
  await e.monitors.tickAggregate();
  await e.monitors.tickBudgets();
  const live = e.monitors.tickLive();
  await d.entered();
  e.data.views = exceeded({ scope: { dim: 'source', value: 'codex' } });
  await e.monitors.tickBudgets();
  d.release();
  await live;
  assert.deepEqual(d.pauses, [], 'not the session the old scope picked');
  const next = e.monitors.tickLive();
  await d.entered();
  d.release();
  await next;
  assert.deepEqual(d.pauses, ['s3'], 'the new scope picks its own session');
  // The period: a new period started while the agent was looked up.
  const p = deferred();
  const f = setup({ views: exceeded(), makeControl: p.control });
  await f.monitors.tickAggregate();
  await f.monitors.tickBudgets();
  const pending = f.monitors.tickLive();
  await p.entered();
  f.data.views = exceeded({ periodKey: 'month:2026-11-01' });
  p.release();
  await pending;
  assert.deepEqual(p.pauses, [], 'chosen in the old period');
});

test('engine: a change that arrives while the budget pass itself is looking up the agent wins', async () => {
  const d = deferred();
  const e = setup({ views: exceeded({ state: 'warn_80' }), makeControl: d.control });
  await e.cycle(); // the live sessions are known; nothing is exceeded yet
  e.data.views = exceeded();
  const pass = e.monitors.tickBudgets(); // the pause starts inside this pass
  await d.entered();
  e.data.views = exceeded({ enforce: 'none' });
  const change = e.monitors.tickBudgets(); // as server.js does after a budget save
  d.release();
  await Promise.all([pass, change]);
  assert.deepEqual(d.pauses, []);
  const st = e.state.states().find((x) => x.rule === 'budget');
  assert.equal(st.state, 'exceeded');
});

test('engine: a budget pass asked for while one runs runs again after it, with what changed', async () => {
  const d = deferred();
  const e = setup({ views: exceeded({ state: 'warn_80' }), makeControl: d.control });
  await e.cycle();
  e.data.views = exceeded();
  const pass = e.monitors.tickBudgets();
  await d.entered();
  e.data.views = exceeded({ state: 'warn_80', percent: 85 }); // the amount was raised meanwhile
  const change = e.monitors.tickBudgets();
  const third = e.monitors.tickBudgets();
  assert.equal(change, third, 'one more pass, however many ask');
  d.release();
  await Promise.all([pass, change]);
  assert.equal(e.state.states().find((x) => x.rule === 'budget').state, 'warn_80', 'the change was evaluated');
  assert.deepEqual(d.pauses, []);
});

test('engine: where agent control is off, a pause budget says so once per period and signals nothing', async () => {
  const offFor = async (opts) => {
    const kills = [];
    const makeControl = () =>
      createAgentControl({
        platform: 'linux',
        now: () => T0,
        audit: { record: () => {} },
        kill: (pid, signal) => (kills.push([pid, signal]), true), // a spy: nothing is signalled
        processes: { rows: async () => [] },
        ...opts,
      });
    const e = setup({ makeControl, views: exceeded() });
    await e.cycle();
    await e.cycle();
    const notes = pauseNotes(e.state);
    e.data.views = exceeded({ periodKey: 'month:2026-11-01' });
    await e.cycle();
    await e.cycle();
    return { kills, notes, after: pauseNotes(e.state) };
  };
  for (const [opts, reason] of [
    [{ serverMode: 'server', inDocker: false }, 'could not pause: agent control is off on this server'],
    [
      { serverMode: 'no-sign-in', inDocker: false },
      'could not pause: agent control is off without a dashboard sign-in',
    ],
    [{ serverMode: false, inDocker: true }, 'could not pause: agent control is off in Docker'],
  ]) {
    const r = await offFor(opts);
    assert.deepEqual(r.kills, [], 'no signal');
    assert.deepEqual(
      r.notes.map((n) => [n.ok, n.code, n.reason]),
      [[false, 'off', reason]],
      'once in the period, not "no candidate"',
    );
    assert.equal(r.after.length, 2, 'once again in the next period');
    assert.doesNotMatch(reason, /[\\/]/);
  }
});
