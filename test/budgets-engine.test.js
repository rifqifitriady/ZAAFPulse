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

function setup({ views = [], demo = false, retired = [], conf = {}, pauseThrows = false } = {}) {
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
  const control = {
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
  const monitors = createMonitors({
    indexer: { results: () => RESULTS },
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
    },
    retired,
    home: HOME,
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
