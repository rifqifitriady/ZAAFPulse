// The monitor engine (lib/monitors/index.js) with fakes for the index, the office, the evals, the channels and the
// agent control, and the real state store in a temp folder. Nothing here sends a signal, shows a notification or
// calls a webhook: the channels and the control are spies. The last test starts a demo server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createMonitors } = require('../lib/monitors');
const { createMonitorState } = require('../lib/monitors/state');
const { NO_JUDGE_PORTS } = require('./helpers');

const MIN = 60e3;
const T0 = new Date(2026, 9, 22, 12, 0, 0).getTime();
// One input token costs one dollar, so a row's cost is its input count.
const PRICING = { 'test-model': { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
let reqId = 0;
const usage = (ts, sid, usd, tool = 'claude') => [
  ts,
  tool,
  sid,
  'test-model',
  usd,
  0,
  0,
  0,
  0,
  false,
  `r${++reqId}`,
  null,
];
const session = (cwd, first, last, tool = 'claude') => ({
  tool,
  project: cwd,
  first,
  last,
  prompts: 1,
  promptTs: [first],
  tools: {},
  skills: {},
  agents: {},
  subagentFiles: 0,
});
const agent = (id, state, project = 'proj', kind = 'session') => ({ id, kind, state, project, lastTs: T0 - 1000 });

function setup({ results = [], agents = [], settings = {}, candidates = [], budget = 0, demo = false, ...opts } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-mon-engine-'));
  const clock = { t: T0 };
  const conf = { monthlyBudgetUSD: budget, pricing: PRICING };
  const newState = () =>
    createMonitorState({
      file: path.join(dir, 'monitors.json'),
      alertsFile: path.join(dir, 'alerts.jsonl'),
      now: () => clock.t,
      config: () => conf,
    });
  const first = newState();
  for (const [id, s] of Object.entries(settings)) first.setSettings(id, s);
  const sent = [];
  const calls = { candidates: [], pause: [], resume: [], stop: [], paused: 0 };
  const logs = [];
  const data = { results, agents, candidates };
  const control = {
    async candidates(a) {
      calls.candidates.push(a);
      if (opts.candidatesThrow) throw new Error('ps failed');
      return typeof data.candidates === 'function' ? data.candidates(a) : data.candidates;
    },
    async pause(target, meta) {
      calls.pause.push({ target, meta });
      if (opts.pauseThrows) throw Object.assign(new Error('the process is gone'), { status: 409 });
      return { ok: true };
    },
    async resume(target, meta) {
      calls.resume.push({ target, meta });
    },
    async stop(target, meta) {
      calls.stop.push({ target, meta });
    },
    async paused() {
      calls.paused++;
      return [{ pid: 4242, startTime: T0 - MIN, app: 'claude', sessionId: 's1', by: 'rule', since: T0 }];
    },
  };
  const office = {
    snapshot: () => ({ ts: clock.t, agents: data.agents }),
    demoSnapshot: () => ({ ts: clock.t, agents: data.agents }),
  };
  const boot = (state) =>
    createMonitors({
      indexer: { results: () => data.results },
      office,
      evals: { summary: () => ({ evaluators: opts.evaluators || {} }) },
      config: () => conf,
      state,
      channels: {
        notify: async (alert, o) => {
          sent.push({ alert, title: o && o.title });
          return { desktop: true, webhook: false };
        },
      },
      control,
      now: () => clock.t,
      log: (m) => logs.push(m),
      demo,
      platform: opts.platform || 'darwin',
    });
  const e = {
    sent,
    calls,
    logs,
    clock,
    data,
    conf,
    stateFile: path.join(dir, 'monitors.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true }),
  };
  e.state = first;
  e.monitors = boot(first);
  // A server restart: a new state store read from the same files, and a new engine (nothing kept in memory).
  e.restart = () => {
    e.state = newState();
    e.monitors = boot(e.state);
  };
  return e;
}

const notes = (state) => state.alerts({ limit: 100 }).filter((a) => a.action === 'pause');
// State-change alerts sent for a rule; pause outcomes (action rows) are counted apart.
const ruleAlerts = (sent, rule) => sent.filter((s) => s.alert.rule === rule && s.alert.action === undefined);
const outcomes = (sent) => sent.filter((s) => s.alert.action === 'pause');

test('engine: aggregate rules alert on a change only, and the snapshot keeps no signal text', async () => {
  const sid = 's1';
  const results = [
    {
      sessions: { [sid]: session('/work/a', T0 - 60 * MIN, T0 - MIN) },
      events: [usage(T0 - 30 * MIN, sid, 5)],
      signals: { days: {}, events: [] },
    },
  ];
  const e = setup({ results, budget: 300 }); // a daily limit of $10
  try {
    await e.monitors.tickAggregate();
    assert.equal(ruleAlerts(e.sent, 'daily_cost').length, 0, 'ok from the start raises nothing');
    const daily = () => e.state.states().find((s) => s.rule === 'daily_cost');
    assert.equal(daily().state, 'ok');
    assert.equal(daily().value, 5);
    assert.equal(daily().threshold, 10);

    e.data.results = [
      {
        ...results[0],
        events: [usage(T0 - 30 * MIN, sid, 5), usage(T0 - 20 * MIN, sid, 10)],
        signals: {
          days: {},
          events: [{ ts: T0 - 5 * MIN, sid, tool: 'claude', kind: 'secret', label: 'API key', text: 'sk-live-SECRET' }],
        },
      },
    ];
    e.clock.t += MIN;
    await e.monitors.tickAggregate();
    const d = ruleAlerts(e.sent, 'daily_cost');
    assert.equal(d.length, 1);
    assert.equal(d[0].alert.state, 'triggered');
    assert.equal(d[0].alert.previous, 'ok');
    assert.equal(d[0].alert.value, 15);
    const u = ruleAlerts(e.sent, 'unsafe_content');
    assert.equal(u.length, 1, 'the secret signal triggers unsafe_content');
    assert.equal(u[0].alert.value, 1);

    // The same data again: no new alert.
    const before = e.sent.length;
    e.clock.t += MIN;
    await e.monitors.tickAggregate();
    assert.equal(e.sent.length, before);

    const snap = e.monitors.snapshot();
    assert.equal(snap.today.cost, 15);
    assert.equal(snap.signals, 1);
    assert.doesNotMatch(JSON.stringify(snap), /SECRET|\/work\/a/, 'no signal text or folder in the snapshot');
    assert.doesNotMatch(JSON.stringify(e.sent), /SECRET/);
  } finally {
    e.cleanup();
  }
});

test('engine: accuracy today against the previous 7 days, and the eval pass rate over 24 h', async () => {
  const day = (results, faults) => ({ calls: results, results, failures: faults, cats: { hallucination: faults } });
  const key = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const days = { [key(T0)]: day(100, 20) };
  for (let i = 1; i <= 7; i++) days[key(T0 - i * 24 * 60 * MIN)] = day(100, 2);
  const e = setup({
    results: [{ sessions: {}, events: [], signals: { days, events: [] } }],
    settings: { eval_pass_rate: { enabled: true } },
    evaluators: { relevance: { pass: 10, total: 40 } },
  });
  try {
    await e.monitors.tickAggregate();
    const acc = ruleAlerts(e.sent, 'accuracy_drop');
    assert.equal(acc.length, 1);
    assert.equal(acc[0].alert.value, 18); // 98% before, 80% today
    const ev = ruleAlerts(e.sent, 'eval_pass_rate');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].alert.value, 0.25);
  } finally {
    e.cleanup();
  }
});

// A session that spent $6 in the last 10 minutes, with cost_burn on (limit $5).
function burning(extra = {}) {
  const sid = 's1';
  return setup({
    results: [
      {
        sessions: { [sid]: session('/work/a', T0 - 60 * MIN, T0 - MIN) },
        events: [usage(T0 - 4 * MIN, sid, 2), usage(T0 - 2 * MIN, sid, 4), usage(T0 - 30 * MIN, sid, 50)],
        signals: { days: {}, events: [] },
      },
    ],
    agents: [agent('claude:s1', 'working', 'acme-web')],
    candidates: [{ pid: 4242, startTime: T0 - 2 * 60 * MIN, app: 'claude', cwd: '/work/a', command: 'claude' }],
    ...extra,
    settings: { cost_burn: { enabled: true, autoPause: true }, ...(extra.settings || {}) },
  });
}

test('engine: a live cost_burn with auto-pause and one candidate pauses it once, by the rule', async () => {
  const e = burning();
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    const burn = ruleAlerts(e.sent, 'cost_burn');
    assert.equal(burn.length, 1);
    assert.equal(burn[0].alert.state, 'triggered');
    assert.equal(burn[0].alert.value, 6, 'only the last 10 minutes count');
    assert.equal(burn[0].title, 'acme-web', 'the notification title is the masked project name');
    assert.deepEqual(e.calls.candidates, [{ cwd: '/work/a', firstTs: T0 - 60 * MIN }]);
    assert.equal(e.calls.pause.length, 1);
    assert.deepEqual(e.calls.pause[0], {
      target: { pid: 4242, startTime: T0 - 2 * 60 * MIN },
      meta: { by: 'rule', rule: 'cost_burn', sessionId: 's1' },
    });
    const [n] = notes(e.state);
    assert.equal(n.ok, true);
    assert.equal(n.reason, 'paused');
    assert.equal(n.rule, 'cost_burn');
    assert.equal(n.state, undefined, 'a note is not a change of state');

    // Still triggered on the next ticks, and on the reminder 30 minutes later: no second pause.
    e.clock.t += 5000;
    await e.monitors.tickLive();
    e.clock.t = T0 + 31 * MIN;
    e.data.results[0].events.push(usage(e.clock.t - MIN, 's1', 7));
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    const reminders = ruleAlerts(e.sent, 'cost_burn');
    assert.equal(reminders.length, 2, 'the reminder was sent');
    assert.equal(reminders[1].alert.previous, 'triggered');
    assert.equal(e.calls.pause.length, 1, 'paused once while the alert stays triggered');
    assert.equal(e.calls.resume.length, 0, 'never resumed');
    assert.equal(e.calls.stop.length, 0, 'never stopped');
  } finally {
    e.cleanup();
  }
});

test('engine: several candidates means no pause and a note that says so', async () => {
  const two = [
    { pid: 11, startTime: T0 - 3 * 60 * MIN, app: 'claude' },
    { pid: 12, startTime: T0 - 2 * 60 * MIN, app: 'claude' },
  ];
  const e = burning({ candidates: two });
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 0);
    const [n] = notes(e.state);
    assert.equal(n.ok, false);
    assert.equal(n.reason, 'could not pause: several candidates');
    assert.equal(n.sessionId, 's1');
  } finally {
    e.cleanup();
  }
});

test('engine: no candidate says why, and on Windows that pausing is not available', async () => {
  for (const platform of ['linux', 'win32']) {
    const e = burning({ candidates: [], platform });
    try {
      await e.monitors.tickAggregate();
      await e.monitors.tickLive();
      assert.equal(e.calls.pause.length, 0);
      const [n] = notes(e.state);
      assert.match(n.reason, /^could not pause: no candidate/);
      if (platform === 'win32') assert.match(n.reason, /Windows/);
      else assert.doesNotMatch(n.reason, /Windows/);
    } finally {
      e.cleanup();
    }
  }
});

test('engine: auto-pause off means no pause and no process lookup, but the alert is sent', async () => {
  const e = burning({ settings: { cost_burn: { enabled: true, autoPause: false } } });
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    assert.equal(ruleAlerts(e.sent, 'cost_burn').length, 1);
    assert.equal(e.calls.candidates.length, 0);
    assert.equal(e.calls.pause.length, 0);
    assert.equal(notes(e.state).length, 0);
  } finally {
    e.cleanup();
  }
});

test('engine: a pause that fails is logged and noted, and the pass goes on', async () => {
  const e = burning({ pauseThrows: true });
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive(); // resolves: the failure is not thrown
    assert.equal(e.calls.pause.length, 1);
    const [n] = notes(e.state);
    assert.equal(n.ok, false);
    assert.equal(n.reason, 'could not pause: the process is gone');
    assert.ok(e.logs.some((m) => /could not pause/.test(m)));
    assert.ok((await e.monitors.status()).lastLive, 'the pass finished');
  } finally {
    e.cleanup();
  }
  const f = burning({ candidatesThrow: true });
  try {
    await f.monitors.tickAggregate();
    await f.monitors.tickLive();
    assert.equal(notes(f.state)[0].reason, 'could not pause: the agent processes could not be read');
  } finally {
    f.cleanup();
  }
});

test('engine: daily_cost auto-pause goes to the costliest running session today', async () => {
  const e = setup({
    budget: 300,
    results: [
      {
        sessions: {
          cheap: session('/work/cheap', T0 - 90 * MIN, T0 - MIN),
          dear: session('/work/dear', T0 - 80 * MIN, T0 - MIN),
        },
        events: [usage(T0 - 60 * MIN, 'cheap', 3), usage(T0 - 50 * MIN, 'dear', 9)],
        signals: { days: {}, events: [] },
      },
    ],
    agents: [agent('claude:cheap', 'working', 'cheap'), agent('claude:dear', 'working', 'dear')],
    candidates: [{ pid: 77, startTime: T0 - 100 * MIN, app: 'claude' }],
    settings: { daily_cost: { enabled: true, autoPause: true } },
  });
  try {
    await e.monitors.tickLive();
    await e.monitors.tickAggregate();
    assert.equal(ruleAlerts(e.sent, 'daily_cost')[0].alert.state, 'triggered');
    assert.deepEqual(e.calls.candidates, [{ cwd: '/work/dear', firstTs: T0 - 80 * MIN }]);
    assert.deepEqual(e.calls.pause[0].meta, { by: 'rule', rule: 'daily_cost', sessionId: 'dear' });
    e.clock.t += MIN;
    await e.monitors.tickAggregate();
    assert.equal(e.calls.pause.length, 1);
  } finally {
    e.cleanup();
  }
});

test('engine: daily_cost skips a finished session and pauses the costliest one still running', async () => {
  const e = setup({
    budget: 300,
    results: [
      {
        sessions: {
          cheap: session('/work/cheap', T0 - 90 * MIN, T0 - MIN),
          dear: session('/work/dear', T0 - 80 * MIN, T0 - 40 * MIN),
        },
        events: [usage(T0 - 60 * MIN, 'cheap', 3), usage(T0 - 50 * MIN, 'dear', 9)],
        signals: { days: {}, events: [] },
      },
    ],
    agents: [agent('claude:cheap', 'working', 'cheap')], // dear has finished
    candidates: [{ pid: 78, startTime: T0 - 100 * MIN, app: 'claude' }],
    settings: { daily_cost: { enabled: true, autoPause: true } },
  });
  try {
    await e.monitors.tickLive();
    await e.monitors.tickAggregate();
    assert.deepEqual(e.calls.candidates, [{ cwd: '/work/cheap', firstTs: T0 - 90 * MIN }]);
    assert.deepEqual(e.calls.pause[0].meta, { by: 'rule', rule: 'daily_cost', sessionId: 'cheap' });
  } finally {
    e.cleanup();
  }
});

test('engine: daily_cost with no running session reports it once and pauses one that starts later', async () => {
  const e = setup({
    budget: 300,
    results: [
      {
        sessions: { dear: session('/work/dear', T0 - 80 * MIN, T0 - 40 * MIN) },
        events: [usage(T0 - 50 * MIN, 'dear', 12)],
        signals: { days: {}, events: [] },
      },
    ],
    agents: [],
    candidates: [{ pid: 79, startTime: T0 - 100 * MIN, app: 'claude' }],
    settings: { daily_cost: { enabled: true, autoPause: true } },
  });
  try {
    await e.monitors.tickLive();
    await e.monitors.tickAggregate();
    for (let i = 0; i < 3; i++) {
      e.clock.t += 5000;
      await e.monitors.tickLive();
    }
    assert.equal(e.calls.candidates.length, 0, 'nothing to look for');
    const n = notes(e.state);
    assert.equal(n.length, 1, 'reported once, not on every pass');
    assert.equal(n[0].code, 'none');
    assert.match(n[0].reason, /no running session/);
    // The session runs again: the episode was not used up, so it is paused now.
    e.data.agents = [agent('claude:dear', 'working', 'dear')];
    e.clock.t += 5000;
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 1);
    assert.equal(e.calls.pause[0].meta.sessionId, 'dear');
  } finally {
    e.cleanup();
  }
});

test('engine: the outcome of an automatic pause is notified too, with its code and the session title', async () => {
  const e = burning();
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    const out = outcomes(e.sent);
    assert.equal(out.length, 1);
    assert.equal(out[0].alert.ok, true);
    assert.equal(out[0].alert.code, 'paused');
    assert.equal(out[0].alert.value, 6);
    assert.equal(out[0].title, 'acme-web');
  } finally {
    e.cleanup();
  }
  const f = burning({ candidates: [{ pid: 1 }, { pid: 2 }] });
  try {
    await f.monitors.tickAggregate();
    await f.monitors.tickLive();
    const [o] = outcomes(f.sent);
    assert.equal(o.alert.ok, false);
    assert.equal(o.alert.code, 'several');
  } finally {
    f.cleanup();
  }
});

test('engine: after a restart a reminder does not pause again, so an owner resume sticks', async () => {
  const e = burning();
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 1);
    // The owner resumes the agent (outside the engine), then the server restarts.
    e.restart();
    e.clock.t = T0 + 31 * MIN;
    e.data.results[0].events.push(usage(e.clock.t - MIN, 's1', 7));
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    const burn = ruleAlerts(e.sent, 'cost_burn');
    assert.equal(burn.length, 2, 'the reminder came after the restart');
    assert.equal(burn[1].alert.previous, 'triggered');
    assert.equal(e.calls.pause.length, 1, 'not paused again');
    assert.equal(e.calls.resume.length + e.calls.stop.length, 0);
  } finally {
    e.cleanup();
  }
});

test('engine: the episode mark is saved in the state file, private to the owner', async () => {
  const e = burning();
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    const file = e.stateFile;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = saved.states.find((x) => x.rule === 'cost_burn' && x.instance === 's1');
    assert.equal(entry.actedAt, T0);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    e.cleanup();
  }
});

test('engine: turning auto-pause on while the rule is triggered pauses on the next tick', async () => {
  const e = burning({ settings: { cost_burn: { enabled: true, autoPause: false } } });
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 0);
    e.state.setSettings('cost_burn', { autoPause: true });
    e.clock.t += 5000;
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 1, 'no wait for a reminder');
    e.clock.t += 5000;
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 1);
  } finally {
    e.cleanup();
  }
});

test('engine: a resolved episode clears the mark, so the next trigger pauses again', async () => {
  const e = burning();
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 1);
    // No spend for a while: ok, held for 5 minutes, then resolved.
    e.clock.t = T0 + 11 * MIN;
    await e.monitors.tickLive();
    e.clock.t = T0 + 17 * MIN;
    await e.monitors.tickLive();
    assert.ok(
      ruleAlerts(e.sent, 'cost_burn').some((s) => s.alert.state === 'ok'),
      'resolved',
    );
    // A new burn: a new episode.
    e.clock.t = T0 + 20 * MIN;
    e.data.results[0].events.push(usage(e.clock.t - MIN, 's1', 9));
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 2);
  } finally {
    e.cleanup();
  }
});

// Ticks both passes at T0 + each minute in `mins`, with the session spending $9 just before when `burn` is set.
async function tickAt(e, mins, burn) {
  for (const m of mins) {
    e.clock.t = T0 + m * MIN;
    if (burn) e.data.results[0].events.push(usage(e.clock.t - 30e3, 's1', 9));
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
  }
}

test('engine: a trigger that lasts through a snooze is the same episode; an agent the owner resumed stays running', async () => {
  const e = burning();
  try {
    await tickAt(e, [0], false);
    assert.equal(e.calls.pause.length, 1);
    // The owner resumes the agent (outside the engine) and snoozes the rule; the session keeps spending.
    e.state.snooze('cost_burn', null, 60 * MIN);
    await tickAt(e, [5, 30, 59], true);
    assert.equal(e.calls.pause.length, 1, 'nothing while snoozed');
    // The snooze ends with the session still burning: the alert comes back, the agent is not paused again.
    await tickAt(e, [61, 62], true);
    assert.ok(ruleAlerts(e.sent, 'cost_burn').length >= 2, 'alerted again after the snooze');
    assert.equal(e.calls.pause.length, 1, 'no re-pause');
    // Also after a restart.
    e.restart();
    await tickAt(e, [95], true);
    assert.equal(e.calls.pause.length, 1);
  } finally {
    e.cleanup();
  }
});

test('engine: a rule that resolved during a snooze pauses again on its next trigger', async () => {
  const e = burning();
  try {
    await tickAt(e, [0], false);
    assert.equal(e.calls.pause.length, 1);
    e.state.snooze('cost_burn', null, 60 * MIN);
    // No spend: ok from minute 15, held past the 5-minute resolution hold while snoozed.
    await tickAt(e, [15, 21], false);
    // After the snooze, a new burn: a new episode.
    await tickAt(e, [61], true);
    assert.equal(e.calls.pause.length, 2);
  } finally {
    e.cleanup();
  }
});

test('engine: a rule that resolves after a snooze ended (no alert open) also ends the episode', async () => {
  const e = burning();
  try {
    await tickAt(e, [0], false);
    e.state.snooze('cost_burn', null, 30 * MIN);
    await tickAt(e, [10, 29], true); // still burning while snoozed
    // The snooze ends while the session is quiet (ok, so no alert opens), and stays quiet past the hold.
    await tickAt(e, [45, 51], false);
    assert.equal(e.calls.pause.length, 1);
    await tickAt(e, [60], true);
    assert.equal(e.calls.pause.length, 2, 'the trigger after a real resolution is a new episode');
  } finally {
    e.cleanup();
  }
});

test('engine: an unreadable process list is reported once and tried again; the retry pauses', async () => {
  let n = 0;
  const one = [{ pid: 4242, startTime: T0 - 2 * 60 * MIN, app: 'claude' }];
  const e = burning({
    candidates: () => {
      n++;
      if (n <= 2) throw new Error('ps failed');
      return one;
    },
  });
  try {
    await tickAt(e, [0], false);
    e.clock.t += 5000;
    await e.monitors.tickLive();
    assert.equal(e.calls.pause.length, 0);
    const failed = outcomes(e.sent);
    assert.equal(failed.length, 1, 'reported once over two failed tries');
    assert.equal(failed[0].alert.code, 'unreadable');
    e.clock.t += 5000;
    await e.monitors.tickLive();
    assert.equal(e.calls.candidates.length, 3);
    assert.equal(e.calls.pause.length, 1, 'paused on the retry');
    assert.deepEqual(
      outcomes(e.sent).map((o) => o.alert.code),
      ['unreadable', 'paused'],
    );
  } finally {
    e.cleanup();
  }
});

test('engine: a session not indexed yet is reported once and paused once it is indexed', async () => {
  const e = burning();
  const sessions = e.data.results[0].sessions;
  e.data.results[0].sessions = {};
  try {
    await tickAt(e, [0], false);
    e.clock.t += 5000;
    await e.monitors.tickLive();
    assert.equal(e.calls.candidates.length, 0);
    assert.deepEqual(
      outcomes(e.sent).map((o) => o.alert.code),
      ['not-indexed'],
    );
    e.data.results[0].sessions = sessions;
    await tickAt(e, [1], true);
    assert.equal(e.calls.pause.length, 1);
  } finally {
    e.cleanup();
  }
});

test('engine: a bad clock on the aggregate pass keeps what the previous pass built', async () => {
  const e = burning();
  try {
    await e.monitors.tickAggregate();
    const before = e.monitors.snapshot();
    const t = e.clock.t;
    e.clock.t = NaN;
    await e.monitors.tickAggregate();
    assert.deepEqual(e.monitors.snapshot().today, before.today);
    assert.equal((await e.monitors.status()).lastAggregate, t);
    e.clock.t = t + 5000;
    await e.monitors.tickLive();
    assert.equal(e.monitors.snapshot().sessions[0].cost10m, 6, 'the usage rows were kept');
  } finally {
    e.cleanup();
  }
});

test('engine: before an aggregate pass the budget is checked the same way', () => {
  const e = setup();
  try {
    e.conf.monthlyBudgetUSD = 'lots';
    assert.deepEqual(e.monitors.snapshot().budget, { monthlyUSD: null });
    e.conf.monthlyBudgetUSD = 90;
    assert.deepEqual(e.monitors.snapshot().budget, { monthlyUSD: 90 });
  } finally {
    e.cleanup();
  }
});

test('engine: rules that may not pause never pause, even with a candidate', async () => {
  const e = setup({
    results: [
      {
        sessions: { s1: session('/work/a', T0 - 60 * MIN, T0 - MIN) },
        events: [],
        signals: { days: {}, events: [{ ts: T0 - MIN, sid: 's1', tool: 'claude', kind: 'secret' }] },
      },
    ],
    agents: [agent('claude:s1', 'working')],
    candidates: [{ pid: 4242, startTime: T0 - 2 * 60 * MIN, app: 'claude' }],
  });
  try {
    // unsafe_content has no auto-pause setting; setSettings refuses it.
    assert.throws(() => e.state.setSettings('unsafe_content', { autoPause: true }), /cannot pause/);
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    assert.equal(ruleAlerts(e.sent, 'unsafe_content').length, 1);
    assert.equal(e.calls.pause.length, 0);
    assert.equal(e.calls.candidates.length, 0);
  } finally {
    e.cleanup();
  }
});

test('engine: only running sessions are judged; subagents, idle and done ones are not', async () => {
  const e = burning({
    agents: [
      agent('claude:s1', 'idle'),
      agent('claude:s2', 'done'),
      agent('claude:s1:a1', 'working', 'proj', 'subagent'),
      agent('claude:s3', 'waiting'),
    ],
  });
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    const burn = e.state.states().filter((s) => s.rule === 'cost_burn');
    assert.deepEqual(
      burn.map((s) => [s.instance, s.state, s.value]),
      [['s3', 'ok', 0]],
    );
    assert.deepEqual(
      e.monitors.snapshot().sessions.map((s) => s.sid),
      ['s3'],
    );
  } finally {
    e.cleanup();
  }
});

test('engine: before the first aggregate pass a live cost is unknown, and a bad clock touches nothing', async () => {
  const e = burning();
  try {
    await e.monitors.tickLive();
    assert.equal(e.state.states().find((s) => s.rule === 'cost_burn').state, 'no_data');
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    const before = JSON.stringify(e.state.states());
    const sent = e.sent.length;
    e.clock.t = NaN;
    await e.monitors.tickLive();
    assert.equal(JSON.stringify(e.state.states()), before, 'sessions are not resolved or forgotten');
    assert.equal(e.sent.length, sent);
  } finally {
    e.cleanup();
  }
});

test('engine: a Codex office id is matched to the session id the index uses', async () => {
  const uuid = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
  const e = setup({
    results: [
      {
        sessions: { [uuid]: session('/work/c', T0 - 60 * MIN, T0 - MIN, 'codex') },
        events: [usage(T0 - 3 * MIN, uuid, 8, 'codex')],
        signals: { days: {}, events: [] },
      },
    ],
    agents: [agent(`codex:rollout-2026-10-22T11-00-00-${uuid}`, 'working')],
    candidates: [{ pid: 99, startTime: T0 - 2 * 60 * MIN, app: 'codex' }],
    settings: { cost_burn: { enabled: true, autoPause: true } },
  });
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    const [a] = ruleAlerts(e.sent, 'cost_burn');
    assert.equal(a.alert.sessionId, uuid);
    assert.equal(a.alert.value, 8);
    assert.equal(e.calls.pause[0].meta.sessionId, uuid);
  } finally {
    e.cleanup();
  }
});

test('engine: demo mode evaluates but never notifies, pauses or reads the process table', async () => {
  const e = burning({ demo: true });
  try {
    await e.monitors.tickAggregate();
    await e.monitors.tickLive();
    assert.equal(e.state.states().find((s) => s.rule === 'cost_burn').state, 'triggered', 'evaluated');
    assert.equal(e.sent.length, 0, 'nothing notified (so no webhook either)');
    assert.equal(e.calls.candidates.length + e.calls.pause.length + e.calls.resume.length + e.calls.stop.length, 0);
    const st = await e.monitors.status();
    assert.deepEqual(st.paused, []);
    assert.equal(e.calls.paused, 0);
  } finally {
    e.cleanup();
  }
});

test('engine: status reports the passes, the counts and the paused agents', async () => {
  const e = burning();
  try {
    let st = await e.monitors.status();
    assert.equal(st.lastAggregate, null);
    assert.equal(st.lastLive, null);
    assert.equal(st.enabled, true);
    await e.monitors.tickAggregate();
    e.clock.t += 1000;
    await e.monitors.tickLive();
    st = await e.monitors.status();
    assert.equal(st.lastAggregate, T0);
    assert.equal(st.lastLive, T0 + 1000);
    assert.equal(st.counts.triggered >= 1, true);
    assert.equal(st.paused.length, 1, 'control.paused() was awaited');
    assert.equal(st.paused[0].pid, 4242);
  } finally {
    e.cleanup();
  }
});

test('engine: a failing source or rule is logged and the other rules still run', async () => {
  const e = burning();
  try {
    e.conf.monthlyBudgetUSD = 300; // daily_cost on, with a $10 limit
    const broken = { results: () => e.data.results };
    // An office that throws: the live pass logs and resolves.
    const m = createMonitors({
      indexer: broken,
      office: {
        snapshot: () => {
          throw new Error('office broke');
        },
      },
      state: e.state,
      channels: { notify: async () => ({}) },
      control: { candidates: async () => [], pause: async () => ({}), paused: async () => [] },
      now: () => e.clock.t,
      log: (msg) => e.logs.push(msg),
      config: () => ({ monthlyBudgetUSD: 300, pricing: PRICING }),
    });
    await m.tickLive();
    assert.ok(e.logs.some((x) => /live pass failed: office broke/.test(x)));
    // The failed pass is over: the next one runs (and fails) again rather than returning the old promise.
    await m.tickLive();
    assert.equal(e.logs.filter((x) => /live pass failed/.test(x)).length, 2);
    // An evals summary that throws: the eval rule has no data, the cost rules still run.
    const n = createMonitors({
      indexer: broken,
      office: { snapshot: () => ({ agents: [] }) },
      evals: {
        summary: () => {
          throw new Error('evals broke');
        },
      },
      state: e.state,
      channels: { notify: async () => ({}) },
      control: { candidates: async () => [], pause: async () => ({}), paused: async () => [] },
      now: () => e.clock.t,
      log: (msg) => e.logs.push(msg),
      config: () => ({ monthlyBudgetUSD: 300, pricing: PRICING }),
    });
    await n.tickAggregate();
    assert.ok(e.logs.some((x) => /could not read the evals: evals broke/.test(x)));
    assert.ok(e.state.states().some((s) => s.rule === 'daily_cost' && s.state === 'triggered'));
  } finally {
    e.cleanup();
  }
});

test('engine: a pass still running is joined, not run twice', async () => {
  const e = burning();
  try {
    let reads = 0;
    const slow = e.data.results;
    const m = createMonitors({
      indexer: {
        results: () => {
          reads++;
          return slow;
        },
      },
      office: { snapshot: () => ({ agents: [] }) },
      state: e.state,
      channels: { notify: async () => ({}) },
      control: { candidates: async () => [], pause: async () => ({}), paused: async () => [] },
      now: () => e.clock.t,
      config: () => ({ pricing: PRICING }),
    });
    const [a, b] = [m.tickAggregate(), m.tickAggregate()];
    assert.equal(a, b);
    await a;
    assert.equal(reads, 1);
  } finally {
    e.cleanup();
  }
});

// ---- server wiring ----
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 7000 + Math.floor(Math.random() * 500);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

test('server: a demo server runs the monitors and answers their status', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-mon-server-'));
  let child = null;
  try {
    let base = null;
    for (let attempt = 0; attempt < 6 && !base; attempt++) {
      const port = await freePort();
      child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
          ...process.env,
          ...NO_JUDGE_PORTS,
          DEMO: '1',
          ZAAFPULSE_AUTH: 'none',
          ZAAFPULSE_PORT: String(port),
          ZAAFPULSE_DATA: data,
          HOME: data,
          USERPROFILE: data,
        },
        stdio: 'ignore',
      });
      let exited = false;
      child.once('exit', () => (exited = true));
      for (let i = 0; i < 80 && !exited && !base; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/monitors/status`, { signal: AbortSignal.timeout(2000) });
          if (r.status === 200) base = `http://127.0.0.1:${port}`;
        } catch {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (!base && !exited) child.kill();
    }
    assert.ok(base, 'the demo server started');
    let st = null;
    for (let i = 0; i < 60; i++) {
      st = await (await fetch(`${base}/api/monitors/status`)).json();
      if (st.lastAggregate && st.lastLive) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(typeof st.lastAggregate, 'number', 'the aggregate pass ran after the index refresh');
    assert.equal(typeof st.lastLive, 'number', 'the live pass ran');
    // Only the seeded demo pause is listed: demo mode never pauses a real agent.
    assert.deepEqual(
      st.paused.map((p) => [p.pid, p.app, p.by]),
      [[48213, 'claude', 'rule']],
    );
    assert.deepEqual(Object.keys(st.counts).sort(), ['no_data', 'ok', 'snoozed', 'triggered']);
    assert.equal(typeof st.enabled, 'boolean');
    // Demo mode keeps its monitor files in the throwaway folder, never in the data folder.
    assert.equal(fs.existsSync(path.join(data, '.data', 'monitors.json')), false);
    assert.equal(fs.existsSync(path.join(data, '.data', 'agent-audit.jsonl')), false);
  } finally {
    if (child && child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
});
