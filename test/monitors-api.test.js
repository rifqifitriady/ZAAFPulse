// The monitor, alert and agent routes: lib/monitors/api.js in process with fakes (validation, shapes, the mapping of
// control errors, no raw session id or path in a body), then a spawned server.js for the demo data, the sign-in gate,
// the settings file and server mode. No test sends a signal, a notification or a webhook: the control and channels
// here are fakes, and spawned servers run with NO_JUDGE_PORTS (which turns notifications off).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createMonitorApi } = require('../lib/monitors/api');
const { createAgentControl } = require('../lib/agents/control');
const { createMonitorState } = require('../lib/monitors/state');
const { checkWebhookUrl, parseHeaders } = require('../lib/monitors/channels');
const { secretResolver } = require('../lib/integration-config');
const { createGateway } = require('../lib/gateway');
const { secretsFor, NO_JUDGE_PORTS } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const HOME = '/Users/owner';
const SID = 'c0ffee00-1111-2222-3333-444455556666';
const SID2 = 'c0ffee00-9999-8888-7777-666655554444';
const KEY = 'claude.' + 'a'.repeat(32);
// No response may carry a file path of the machine (S3).
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const noPaths = (bodies) => {
  for (const b of bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
};

// ---- in process ----

function setup({
  agentsOff = false,
  inDocker = false, // never the machine's own answer, so a test run in a container behaves the same
  notifyOff = false,
  demo = null,
  platform = 'darwin',
  control = {},
  failStore = null,
} = {}) {
  const dir = tmp('zp-mon-api-');
  let t = 1_800_000_000_000;
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => t,
    config: () => ({ monthlyBudgetUSD: 300 }),
  });
  const keyCalls = []; // the third argument of every keyFor call
  const trace = {
    keyFor: (source, sid, opts) => {
      keyCalls.push(opts);
      if (source === 'claude' && sid === SID) return KEY;
      throw Object.assign(new Error('unknown session'), { status: 404 });
    },
    sourceOf: (key) => {
      if (typeof key !== 'string' || !key) throw Object.assign(new Error('session key required'), { status: 400 });
      if (key === KEY) return { source: 'claude', sid: SID };
      if (key === 'kiro.' + 'b'.repeat(32)) return { source: 'kiro', sid: 'k1' };
      throw Object.assign(new Error('unknown session'), { status: 404 });
    },
  };
  const calls = [];
  const fakeControl = {
    candidates: async (q) => {
      calls.push(['candidates', q]);
      return [
        {
          pid: 4242,
          startTime: 1000,
          app: 'claude',
          cwd: `${HOME}/code/shop`,
          command: `${HOME}/.local/bin/claude --flag ${'x'.repeat(300)}`,
        },
      ];
    },
    paused: async () => [{ pid: 4242, startTime: 1000, app: 'claude', by: 'owner', since: 1, sessionId: SID }],
    pause: async (target, meta) => {
      calls.push(['pause', target, meta]);
      return { ok: true, action: 'pause', pid: target.pid, startTime: target.startTime, app: 'claude' };
    },
    resume: async (target, meta) => {
      calls.push(['resume', target, meta]);
      return { ok: true, action: 'resume', pid: target.pid, startTime: target.startTime, app: 'claude' };
    },
    stop: async (target, meta) => {
      calls.push(['stop', target, meta]);
      return {
        ok: true,
        action: 'stop',
        pid: target.pid,
        startTime: target.startTime,
        app: 'claude',
        signal: 'SIGINT',
        exited: true,
      };
    },
    ...control,
  };
  let channelCfg = { desktop: true, webhook: null, problem: null };
  const stored = [];
  const resolve = secretResolver({
    store: (service, value) => {
      if (failStore && failStore(service))
        throw Object.assign(new Error('the secret could not be saved'), { status: 500 });
      stored.push([service, value]);
    },
  });
  const tests = [];
  const resolved = []; // the fields resolveSecret was asked for, in order
  const api = createMonitorApi({
    state,
    monitors: { status: async () => ({ lastAggregate: 5, lastLive: 6, paused: await fakeControl.paused() }) },
    channels: {
      test: async (kind) => {
        tests.push(kind);
        return { ok: false, error: `could not reach it, see ${HOME}/x.log and /private/var/tmp/y` };
      },
    },
    control: fakeControl,
    trace,
    sessionInfo: (source, sid) =>
      source === 'claude' && sid === SID ? { cwd: `${HOME}/code/shop`, first: 2000 } : null,
    channelSettings: {
      get: () => channelCfg,
      save: (c) => {
        channelCfg = { ...c, problem: null };
      },
    },
    resolveSecret: (field, input, current) => {
      resolved.push(field);
      return resolve('monitors-webhook', { key: field, label: field, required: false }, input, current);
    },
    checkUrl: checkWebhookUrl,
    checkHeaders: parseHeaders,
    demo,
    agentsOff,
    inDocker,
    notifyOff,
    home: HOME,
    platform,
    now: () => t,
  });
  const bodies = [];
  const call = async (p, { method = 'GET', body, raw, contentType = 'application/json' } = {}) => {
    const u = new URL(p, 'http://x');
    const r = await api.route({
      method,
      path: u.pathname,
      query: u.searchParams,
      contentType,
      readBody: async () => (raw !== undefined ? raw : JSON.stringify(body)),
    });
    if (r) bodies.push(JSON.stringify(r.body));
    return r;
  };
  const post = (p, body) => call(p, { method: 'POST', body });
  return {
    api,
    state,
    call,
    post,
    calls,
    stored,
    tests,
    bodies,
    keyCalls,
    resolved,
    channels: () => channelCfg,
    setChannels: (c) => (channelCfg = c),
    tick: (ms) => (t += ms),
    now: () => t,
    done: () => {
      // Nothing that left the api names the session id or a folder of the owner.
      for (const b of bodies) {
        assert.ok(!b.includes(SID) && !b.includes(SID2), 'no raw session id');
        assert.ok(!b.includes(HOME), 'no home folder');
      }
      noPaths(bodies);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('monitor api: rule list shape, opaque instances and rule states', async () => {
  const s = setup();
  s.state.setSettings('cost_burn', { enabled: true });
  s.state.apply('cost_burn', [
    { instance: SID, sessionId: SID, state: 'triggered', value: 7, threshold: 5, title: 'shop' },
    { instance: SID2, sessionId: SID2, state: 'ok', value: 1, threshold: 5 },
  ]);
  s.state.apply('daily_cost', [{ instance: 'all', sessionId: null, state: 'ok', value: 2, threshold: 10 }]);
  const r = await s.call('/api/monitors');
  assert.equal(r.status, 200);
  assert.equal(r.body.rules.length, 8);
  const keys = 'id title describe kind enabled params defaults autoPause mayAutoPause state snoozedUntil instances';
  for (const rule of r.body.rules) assert.deepEqual(Object.keys(rule).sort(), keys.split(' ').sort());
  const burn = r.body.rules.find((x) => x.id === 'cost_burn');
  assert.equal(burn.state, 'triggered');
  assert.equal(burn.instances.length, 2);
  const [a, b] = burn.instances;
  assert.match(a.instance, /^[0-9a-f]{20}$/);
  assert.notEqual(a.instance, b.instance);
  assert.equal(burn.instances.find((i) => i.state === 'triggered').sessionKey, KEY);
  assert.equal(burn.instances.find((i) => i.state === 'ok').sessionKey, null, 'not listed: no key');
  for (const i of burn.instances) {
    assert.deepEqual(
      Object.keys(i).sort(),
      'instance sessionKey title state value threshold since snoozedUntil'.split(' ').sort(),
    );
  }
  assert.equal(r.body.rules.find((x) => x.id === 'daily_cost').state, 'ok');
  assert.equal(r.body.rules.find((x) => x.id === 'agent_stuck').state, 'off', 'off by default');
  assert.deepEqual(r.body.rules.find((x) => x.id === 'agent_stuck').instances, []);
  assert.equal(r.body.rules.find((x) => x.id === 'tool_loop').state, 'no_data');
  assert.deepEqual(r.body.channels, {
    desktop: true,
    webhook: { configured: false, headers: false, problem: null },
    sending: true,
  });
  s.done();
});

test('monitor api: an ended live session leaves the rule row and the counts; an aggregate instance never does', async () => {
  const s = setup();
  // Two triggered tool_loop sessions: one last seen 61 s ago (ended), one 5 s ago.
  s.state.apply('tool_loop', [{ instance: SID2, sessionId: SID2, state: 'triggered', value: 60, threshold: 50 }]);
  s.state.apply('daily_cost', [{ instance: 'all', sessionId: null, state: 'ok', value: 2, threshold: 10 }]);
  s.tick(56_000);
  s.state.apply('tool_loop', [{ instance: SID, sessionId: SID, state: 'triggered', value: 70, threshold: 50 }]);
  s.tick(5_000);
  const r = await s.call('/api/monitors');
  const loop = r.body.rules.find((x) => x.id === 'tool_loop');
  assert.equal(loop.instances.length, 1, 'only the fresh session');
  assert.equal(loop.instances[0].sessionKey, KEY);
  assert.equal(loop.state, 'triggered');
  const daily = r.body.rules.find((x) => x.id === 'daily_cost');
  assert.equal(daily.instances.length, 1, 'an aggregate instance seen 61 s ago is still shown');
  assert.equal(daily.state, 'ok');
  const st = await s.call('/api/monitors/status');
  assert.equal(st.body.counts.triggered, 1);
  assert.equal(st.body.counts.ok, 1, 'the aggregate instance still counts');
  // The alert history keeps the ended session.
  assert.equal((await s.call('/api/alerts')).body.alerts.filter((a) => a.rule === 'tool_loop').length, 2);
  s.done();
});

test('monitor api: session keys are looked up without forcing a trace rebuild', async () => {
  const s = setup();
  s.state.setSettings('cost_burn', { enabled: true });
  s.state.apply('cost_burn', [
    { instance: SID, sessionId: SID, state: 'triggered', value: 7, threshold: 5 },
    { instance: SID2, sessionId: SID2, state: 'triggered', value: 8, threshold: 5 },
  ]);
  for (const p of ['/api/alerts', '/api/monitors', '/api/monitors/status']) {
    s.keyCalls.length = 0;
    assert.equal((await s.call(p)).status, 200, p);
    assert.ok(s.keyCalls.length > 0, `${p} looked up a key`);
    for (const opts of s.keyCalls) assert.deepEqual(opts, { rebuild: false }, p);
  }
  s.done();
});

test('monitor api: POST /api/monitors/:id validates every field before saving', async () => {
  const s = setup();
  const bad = async (body, status = 400, id = 'cost_burn') => {
    const r = await s.post(`/api/monitors/${id}`, body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(typeof r.body.error, 'string');
  };
  await bad({});
  await bad({ nope: 1 });
  await bad({ enabled: 'yes' });
  await bad({ params: [] });
  await bad({ params: { maxCalls: 3 } }, 400);
  await bad({ params: { maxUSD: -1 } });
  await bad({ params: { maxUSD: '5' } });
  await bad({ params: { maxUSD: 1e7 } });
  await bad({ params: { maxCalls: 2.5 } }, 400, 'tool_loop');
  await bad({ params: { stuckMin: 0 } }, 400, 'agent_stuck');
  await bad({ params: { minPassRate: 1.5 } }, 400, 'eval_pass_rate');
  await bad({ autoPause: 1 });
  await bad({ autoPause: true }, 400, 'accuracy_drop');
  await bad({ snooze: '2h' });
  await bad({ instance: 'all' }, 400, 'daily_cost');
  await bad({ snooze: '1h', instance: 'nope' }, 404);
  await bad({ snooze: '1h', instance: 5 }, 400);
  await bad({ enabled: true }, 404, 'no_such_rule');
  // A request with one bad field changes nothing, not even its good fields.
  await bad({ enabled: true, params: { maxUSD: -1 } });
  assert.equal(s.state.settings('cost_burn').enabled, false);

  const r = await s.post('/api/monitors/cost_burn', { enabled: true, params: { maxUSD: 8 }, autoPause: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.params.maxUSD, 8);
  assert.equal(r.body.autoPause, true);
  assert.deepEqual(s.state.settings('cost_burn'), { enabled: true, params: { maxUSD: 8 }, autoPause: true });
  // Parameters merge with the stored ones; null goes back to the default.
  await s.post('/api/monitors/eval_pass_rate', { params: { minPassRate: 0.9 } });
  await s.post('/api/monitors/eval_pass_rate', { params: { minSamples: 30 } });
  assert.deepEqual(s.state.settings('eval_pass_rate').params, { minPassRate: 0.9, minSamples: 30 });
  const reset = await s.post('/api/monitors/eval_pass_rate', { params: { minPassRate: null } });
  assert.deepEqual(reset.body.params, { minPassRate: 0.8, minSamples: 30 });

  // Snoozes: the whole rule, one instance, and clearing.
  s.state.apply('cost_burn', [{ instance: SID, sessionId: SID, state: 'triggered', value: 9, threshold: 8 }]);
  const inst = (await s.call('/api/monitors')).body.rules.find((x) => x.id === 'cost_burn').instances[0].instance;
  const one = await s.post('/api/monitors/cost_burn', { snooze: '1h', instance: inst });
  assert.equal(one.body.instances[0].state, 'snoozed');
  assert.equal(one.body.instances[0].snoozedUntil, s.now() + 3600e3);
  assert.equal(one.body.snoozedUntil, null, 'the rule itself is not snoozed');
  assert.equal(one.body.state, 'snoozed', 'every instance is');
  const cleared = await s.post('/api/monitors/cost_burn', { snooze: null, instance: inst });
  assert.equal(cleared.body.instances[0].state, 'triggered');
  const whole = await s.post('/api/monitors/daily_cost', { snooze: '1d' });
  assert.equal(whole.body.state, 'snoozed');
  assert.equal(whole.body.snoozedUntil, s.now() + 86400e3);
  assert.equal((await s.post('/api/monitors/daily_cost', { snooze: null })).body.snoozedUntil, null);
  s.done();
});

test('monitor api: routing, JSON only, bad bodies', async () => {
  const s = setup();
  assert.equal((await s.call('/api/monitors/nope/deeper')).status, 404);
  assert.equal((await s.call('/api/agents/kill', { method: 'POST', body: {} })).status, 404);
  assert.equal(await s.call('/api/other'), null, 'not ours');
  assert.equal((await s.call('/api/monitors', { method: 'POST', body: {} })).status, 405);
  assert.equal((await s.call('/api/agents/pause')).status, 405);
  assert.equal((await s.call('/api/monitors/cost_burn')).status, 405);
  for (const p of ['/api/monitors/cost_burn', '/api/monitors/channels', '/api/monitors/test', '/api/agents/pause']) {
    assert.equal((await s.call(p, { method: 'POST', body: {}, contentType: 'text/plain' })).status, 415, p);
    assert.equal((await s.call(p, { method: 'POST', raw: '{nope' })).status, 400, p);
    assert.equal((await s.call(p, { method: 'POST', raw: '[1]' })).status, 400, p);
  }
  s.done();
});

test('monitor api: channels keep the webhook as secret references only', async () => {
  const s = setup();
  const set = (b) => s.post('/api/monitors/channels', b);
  assert.equal((await set({})).status, 400);
  assert.equal((await set({ desktop: 'no' })).status, 400);
  assert.equal((await set({ webhookRef: 'https://hooks.example.com/x' })).status, 400, 'a plain URL is refused');
  assert.equal((await set({ webhookRef: { mode: 'paste', value: 'x' } })).status, 400);
  assert.equal((await set({ webhookRef: { mode: 'store', value: 'http://hooks.example.com/x' } })).status, 400);
  assert.equal((await set({ webhookRef: { mode: 'store', value: 'https://u:p@hooks.example.com/x' } })).status, 400);
  assert.equal(
    (await set({ webhookHeadersRef: { mode: 'store', value: 'Authorization: x' } })).status,
    400,
    'URL first',
  );
  // Pointing the webhook at a secret saved for something else is a hand edit of config.json, never a request.
  assert.equal((await set({ webhookRef: { keychain: 'acc.gw-openai' } })).status, 400);
  assert.equal((await set({ webhookRef: { env: 'HOME' } })).status, 400);
  assert.equal(s.stored.length, 0, 'nothing refused reached the secret store');

  const r = await set({ desktop: false, webhookRef: { mode: 'store', value: 'https://hooks.example.com/abc' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    desktop: false,
    webhook: { configured: true, headers: false, problem: null },
    sending: true,
  });
  assert.deepEqual(s.stored, [['acc.monitors-webhook-url', 'https://hooks.example.com/abc']]);
  assert.deepEqual(s.channels().webhook, { url: { keychain: 'acc.monitors-webhook-url' } });
  assert.equal((await set({ webhookHeadersRef: { mode: 'store', value: 'Content-Type: x' } })).status, 400);
  const h = await set({ webhookHeadersRef: { mode: 'store', value: 'Authorization: Bearer abc' } });
  assert.equal(h.body.webhook.headers, true);
  assert.deepEqual(s.channels().webhook, {
    url: { keychain: 'acc.monitors-webhook-url' },
    headers: { keychain: 'acc.monitors-webhook-headers' },
  });
  // The reference it already has may be sent back; keep leaves it; desktop alone leaves the webhook.
  assert.equal((await set({ webhookRef: { keychain: 'acc.monitors-webhook-url' } })).status, 200);
  assert.equal((await set({ webhookRef: { mode: 'keep' }, desktop: true })).body.desktop, true);
  assert.equal(s.channels().webhook.headers.keychain, 'acc.monitors-webhook-headers');
  assert.equal((await set({ webhookHeadersRef: null })).body.webhook.headers, false);
  assert.equal((await set({ webhookRef: null })).body.webhook.configured, false);
  assert.equal(s.channels().webhook, null);
  assert.ok(!JSON.stringify(s.bodies).includes('hooks.example.com'), 'the URL never comes back');
  // A stored plain URL is reported, not used.
  s.setChannels({ desktop: true, webhook: null, problem: 'the webhook in config.json must use secret references' });
  assert.match((await s.call('/api/monitors')).body.channels.webhook.problem, /secret references/);
  s.done();
});

test('monitor api: a failure part-way through the channel settings leaves them unchanged', async () => {
  const s = setup({ failStore: (service) => service.endsWith('-headers') });
  const before = JSON.stringify(s.channels());
  const r = await s.post('/api/monitors/channels', {
    desktop: false,
    webhookRef: { mode: 'store', value: 'https://hooks.example.com/abc' },
    webhookHeadersRef: { mode: 'store', value: 'Authorization: Bearer abc' },
  });
  assert.equal(r.status, 500);
  assert.equal(JSON.stringify(s.channels()), before, 'nothing was written to the settings');
  // A refusal that needs no secret store is decided before the URL is stored.
  const s2 = setup();
  const u = await s2.post('/api/monitors/channels', {
    webhookRef: { mode: 'none' },
    webhookHeadersRef: { mode: 'store', value: 'Authorization: Bearer abc' },
  });
  assert.equal(u.status, 400);
  assert.equal(s2.stored.length, 0);
  s.done();
  s2.done();
});

test('monitor api: webhook headers without a URL to come are refused before any secret is resolved', async () => {
  const s = setup();
  const headers = { mode: 'store', value: 'X-A: b' };
  for (const webhookRef of [{ mode: 'keep' }, { mode: 'store', value: '' }]) {
    const r = await s.post('/api/monitors/channels', { webhookRef, webhookHeadersRef: headers });
    assert.equal(r.status, 400, JSON.stringify(webhookRef));
    // An empty pasted URL is already refused by the URL check, which needs no secret store either.
    if (webhookRef.mode === 'keep') assert.equal(r.body.error, 'set the webhook URL first');
  }
  assert.deepEqual(s.resolved, [], 'resolveSecret was never called');
  assert.equal(s.stored.length, 0);
  s.done();
  // The headers are resolved first: when that fails, the URL is never resolved, so no new URL secret is left behind.
  const f = setup({ failStore: (service) => service.endsWith('-headers') });
  const r = await f.post('/api/monitors/channels', {
    webhookRef: { mode: 'store', value: 'https://hooks.example.com/abc' },
    webhookHeadersRef: { mode: 'store', value: 'Authorization: Bearer abc' },
  });
  assert.equal(r.status, 500);
  assert.deepEqual(f.resolved, ['headers']);
  assert.equal(f.stored.length, 0, 'no URL secret was stored');
  f.done();
});

test('monitor api: the test button', async () => {
  const s = setup();
  assert.equal((await s.post('/api/monitors/test', { kind: 'sms' })).status, 400);
  assert.equal((await s.post('/api/monitors/test', {})).status, 400);
  const r = await s.post('/api/monitors/test', { kind: 'webhook' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /could not reach it/);
  assert.deepEqual(s.tests, ['webhook']);
  s.done();
  const off = setup({ notifyOff: true });
  const o = await off.post('/api/monitors/test', { kind: 'desktop' });
  assert.equal(o.body.ok, false);
  assert.match(o.body.error, /off/);
  assert.deepEqual(off.tests, [], 'nothing sent');
  off.done();
  const demo = setup({ demo: { candidates: () => [], paused: [] } });
  assert.deepEqual((await demo.post('/api/monitors/test', { kind: 'desktop' })).body, { ok: true, demo: true });
  assert.deepEqual(demo.tests, []);
  demo.done();
});

test('monitor api: alerts map sessions to trace keys and keep no reason text', async () => {
  const s = setup();
  s.state.setSettings('cost_burn', { enabled: true });
  s.state.apply('cost_burn', [
    { instance: SID, sessionId: SID, state: 'triggered', value: 7, threshold: 5, title: 'shop' },
  ]);
  const t1 = s.now();
  s.tick(1000);
  s.state.note({
    rule: 'cost_burn',
    instance: SID,
    sessionId: SID,
    value: 7,
    threshold: 5,
    action: 'pause',
    ok: false,
    code: 'refused',
    reason: `could not pause: ${HOME}/x is gone`,
  });
  s.tick(1000);
  s.state.apply('cost_burn', [{ instance: SID2, sessionId: SID2, state: 'triggered', value: 9, threshold: 5 }]);
  for (const q of ['since=abc', 'since=-1', 'limit=0', 'limit=501', 'limit=x', `since=${'1'.repeat(600)}`]) {
    assert.equal((await s.call(`/api/alerts?${q}`)).status, 400, q);
  }
  const r = await s.call('/api/alerts');
  assert.equal(r.status, 200);
  const [third, pause, first] = r.body.alerts;
  assert.equal(r.body.alerts.length, 3);
  assert.equal(first.sessionKey, KEY);
  assert.equal(first.state, 'triggered');
  assert.equal(first.ruleTitle, 'Cost burn');
  assert.equal(first.title, 'shop');
  assert.equal(pause.action, 'pause');
  assert.equal(pause.ok, false);
  assert.equal(pause.code, 'refused');
  assert.equal(pause.instance, first.instance, 'the same instance id');
  assert.ok(!('reason' in pause) && !('state' in pause) && !('sessionId' in pause));
  assert.equal(third.sessionKey, null, 'a session the explorer does not list');
  assert.equal((await s.call(`/api/alerts?since=${t1}`)).body.alerts.length, 2, 'strictly newer');
  assert.equal((await s.call('/api/alerts?limit=1')).body.alerts.length, 1);
  s.done();
});

test('monitor api: candidates and agent actions', async () => {
  const s = setup();
  assert.equal((await s.call('/api/agents/candidates')).status, 400);
  assert.equal((await s.call(`/api/agents/candidates?key=${'k'.repeat(600)}`)).status, 400);
  assert.equal((await s.call('/api/agents/candidates?key=claude.nope')).status, 404);
  const kiro = await s.call(`/api/agents/candidates?key=kiro.${'b'.repeat(32)}`);
  assert.deepEqual(kiro.body, { candidates: [], canPause: true, reason: 'unsupported' });
  const r = await s.call(`/api/agents/candidates?key=${KEY}`);
  assert.equal(r.status, 200);
  assert.deepEqual(s.calls[0], ['candidates', { cwd: `${HOME}/code/shop`, firstTs: 2000, source: 'claude' }]);
  const [c] = r.body.candidates;
  assert.equal(c.cwd, '~/code/shop');
  assert.ok(c.command.startsWith('~/.local/bin/claude --flag'));
  assert.equal(c.command.length, 200, 'clipped');
  assert.equal(c.paused, true);
  assert.equal(r.body.canPause, true);

  const act = (a, b) => s.post(`/api/agents/${a}`, b);
  assert.equal((await act('pause', {})).status, 400);
  assert.equal((await act('pause', { key: KEY, pid: 1, startTime: 1000 })).status, 400, 'pid 1 is never a target');
  assert.equal((await act('pause', { key: KEY, pid: '42', startTime: 1000 })).status, 400);
  assert.equal((await act('pause', { key: KEY, pid: 4242 })).status, 400, 'start time required');
  assert.equal((await act('pause', { key: KEY, pid: 4242, startTime: 1000, by: 'rule' })).status, 400, 'no by');
  assert.equal((await act('pause', { key: 'claude.nope', pid: 4242, startTime: 1000 })).status, 404);
  assert.equal((await act('stop', { key: KEY, pid: 4242, startTime: 1000 })).status, 400, 'stop needs confirm');
  assert.equal((await act('stop', { key: KEY, pid: 4242, startTime: 1000, confirm: 'yes' })).status, 400);
  assert.equal(s.calls.length, 1, 'nothing refused reached the control module');

  const p = await act('pause', { key: KEY, pid: 4242, startTime: 1000 });
  assert.deepEqual(p.body, { ok: true, action: 'pause', pid: 4242, startTime: 1000, app: 'claude' });
  assert.deepEqual(s.calls[1], ['pause', { pid: 4242, startTime: 1000 }, { by: 'owner', sessionId: SID }]);
  await act('resume', { pid: 4242, startTime: 1000 });
  assert.deepEqual(s.calls[2], ['resume', { pid: 4242, startTime: 1000 }, { by: 'owner', sessionId: null }]);
  const st = await act('stop', { key: KEY, pid: 4242, startTime: 1000, confirm: true });
  assert.equal(st.body.signal, 'SIGINT');
  assert.equal(st.body.exited, true);
  assert.equal(s.calls[3][2].by, 'owner');

  const status = await s.call('/api/monitors/status');
  assert.deepEqual(status.body.paused, [
    { pid: 4242, startTime: 1000, app: 'claude', by: 'owner', since: 1, sessionKey: KEY },
  ]);
  assert.deepEqual(status.body.agents, { available: true, pause: true, reason: null });
  s.done();
});

// A start time comes from an age in whole seconds, so two reads of one process can be a second apart: the paused
// flag must still find it.
test('monitor api: a paused process read a second later is still paused', async () => {
  const later = [{ pid: 4242, startTime: 2000, app: 'claude', by: 'owner', since: 1, sessionId: SID }];
  const s = setup({ control: { paused: async () => later } });
  const r = await s.call(`/api/agents/candidates?key=${KEY}`);
  assert.equal(r.body.candidates[0].startTime, 1000);
  assert.equal(r.body.candidates[0].paused, true);
  later[0].startTime = 3001; // more than the 2 s tolerance: another process
  assert.equal((await s.call(`/api/agents/candidates?key=${KEY}`)).body.candidates[0].paused, false);
  s.done();
});

test('monitor api: with the real control, candidates and status name a paused process with one start time', async () => {
  // The clock's sub-second phase changes on every read of the process table: 600.4 s, then 600.6 s, with an age of
  // 599 s, which computes the start as 1 s, then 2 s.
  let reads = 0;
  const rows = async () => {
    reads++;
    return [
      {
        pid: 4242,
        cpu: 1,
        rssKB: 1,
        upSec: 599,
        args: '/Users/owner/.local/bin/claude',
        argv: ['/Users/owner/.local/bin/claude'],
        cwd: `${HOME}/code/shop`,
      },
    ];
  };
  const ctl = createAgentControl({
    processes: { rows },
    platform: 'linux',
    inDocker: false,
    now: () => 600_400 + 200 * (reads % 2),
    kill: () => true, // records nothing and signals nothing
    audit: { record() {} },
  });
  const s = setup({
    control: { candidates: ctl.candidates, paused: ctl.paused, pause: ctl.pause, resume: ctl.resume, stop: ctl.stop },
  });
  const first = await s.call(`/api/agents/candidates?key=${KEY}`);
  const [c] = first.body.candidates;
  assert.equal(c.paused, false);
  assert.equal((await s.post('/api/agents/pause', { key: KEY, pid: c.pid, startTime: c.startTime })).status, 200);
  for (let i = 0; i < 3; i++) {
    const again = (await s.call(`/api/agents/candidates?key=${KEY}`)).body.candidates[0];
    assert.equal(again.startTime, c.startTime);
    assert.equal(again.paused, true);
    const st = (await s.call('/api/monitors/status')).body;
    assert.deepEqual(
      st.paused.map((p) => [p.pid, p.startTime]),
      [[4242, c.startTime]],
    );
  }
  assert.ok(reads >= 8, 'the table was read on every call');
  s.done();
});

test('monitor api: control refusals keep their status, path-free; taskkill carries a hint', async () => {
  const refusal = (status, message) => async () => {
    throw Object.assign(new Error(message), { status });
  };
  for (const [status, message] of [
    [400, 'a target needs a pid and a start time'],
    [403, 'not an AI agent process'],
    [409, 'the pid now belongs to another process'],
    [501, 'pause is not supported on Windows'],
  ]) {
    const s = setup({ control: { pause: refusal(status, message) } });
    const r = await s.post('/api/agents/pause', { key: KEY, pid: 4242, startTime: 1000 });
    assert.equal(r.status, status);
    assert.deepEqual(r.body, { error: message });
    s.done();
  }
  const w = setup({ platform: 'win32', control: { stop: refusal(502, 'taskkill could not stop the process') } });
  const r = await w.post('/api/agents/stop', { key: KEY, pid: 4242, startTime: 1000, confirm: true });
  assert.equal(r.status, 502);
  assert.match(r.body.hint, /own window/);
  assert.equal((await w.call(`/api/agents/candidates?key=${KEY}`)).body.canPause, false);
  w.done();
  const odd = setup({ control: { pause: async () => Promise.reject(new Error(`EIO at ${HOME}/x`)) } });
  const o = await odd.post('/api/agents/pause', { key: KEY, pid: 4242, startTime: 1000 });
  assert.equal(o.status, 500);
  assert.deepEqual(o.body, { error: 'the agent could not be controlled' });
  odd.done();
});

test('monitor api: server mode refuses agent routes; demo answers without the control module', async () => {
  const off = setup({ agentsOff: true });
  assert.equal((await off.call(`/api/agents/candidates?key=${KEY}`)).status, 403);
  for (const a of ['pause', 'resume', 'stop']) {
    const r = await off.post(`/api/agents/${a}`, { key: KEY, pid: 4242, startTime: 1000, confirm: true });
    assert.equal(r.status, 403, a);
  }
  assert.equal(off.calls.length, 0);
  assert.equal((await off.call('/api/monitors')).status, 200, 'the rules still answer');
  // No rule may pause an agent while control is off: the listing says so and turning it on is refused (409).
  const listed = (await off.call('/api/monitors')).body.rules;
  assert.ok(listed.every((x) => x.mayAutoPause === false));
  const refused = await off.post('/api/monitors/cost_burn', { autoPause: true });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'agent control is off on this server' });
  assert.equal(off.state.settings('cost_burn').autoPause, false, 'nothing was saved');
  assert.equal((await off.post('/api/monitors/cost_burn', { autoPause: false })).status, 200);
  assert.equal((await off.post('/api/monitors/cost_burn', { enabled: true })).status, 200);
  assert.deepEqual((await off.call('/api/monitors/status')).body.agents, {
    available: false,
    pause: true,
    reason: 'server',
  });
  off.done();

  const demo = setup({
    demo: {
      candidates: () => [{ pid: 7, startTime: 1, app: 'claude', cwd: '~/x', command: 'claude', paused: false }],
      paused: [],
    },
  });
  assert.equal((await demo.call(`/api/agents/candidates?key=${KEY}`)).body.candidates.length, 1);
  for (const a of ['pause', 'resume', 'stop']) {
    const r = await demo.post(`/api/agents/${a}`, { key: KEY, pid: 4242, startTime: 1000, confirm: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.demo, true);
  }
  assert.equal(demo.calls.length, 0, 'no signal in demo mode');
  demo.done();
});

test('monitor api: in Docker agent control is off like server mode, with its own reason', async () => {
  const on = setup();
  assert.deepEqual((await on.call('/api/monitors/status')).body.agents, { available: true, pause: true, reason: null });
  on.done();

  let looks = 0;
  const box = setup({
    inDocker: () => {
      looks++;
      return true;
    },
  });
  assert.deepEqual((await box.call('/api/monitors/status')).body.agents, {
    available: false,
    pause: true,
    reason: 'docker',
  });
  assert.ok(looks > 0, 'the injected detector is asked');
  const listed = (await box.call('/api/monitors')).body.rules;
  assert.ok(
    listed.every((x) => x.mayAutoPause === false),
    'no rule may pause an agent in Docker',
  );
  const refused = await box.post('/api/monitors/cost_burn', { autoPause: true });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'agent control is off in Docker' });
  assert.equal(box.state.settings('cost_burn').autoPause, false, 'nothing was saved');
  const cands = await box.call(`/api/agents/candidates?key=${KEY}`);
  assert.equal(cands.status, 403);
  assert.deepEqual(cands.body, { error: 'agent control is off in Docker' });
  for (const a of ['pause', 'resume', 'stop']) {
    const r = await box.post(`/api/agents/${a}`, { key: KEY, pid: 4242, startTime: 1000, confirm: true });
    assert.equal(r.status, 403, a);
    assert.deepEqual(r.body, { error: 'agent control is off in Docker' });
  }
  assert.equal(box.calls.length, 0, 'the control module was never asked');
  box.done();

  // Server mode wins as the reason; a demo in a container still shows its seeded agent.
  const both = setup({ agentsOff: true, inDocker: true });
  assert.equal((await both.call('/api/monitors/status')).body.agents.reason, 'server');
  both.done();
  const demo = setup({ inDocker: true, demo: { candidates: () => [], paused: [] } });
  assert.equal((await demo.call('/api/monitors/status')).body.agents.available, true);
  demo.done();
});

test('monitor api: without a dashboard sign-in agent control is off, with its own reason', async () => {
  const off = setup({ agentsOff: 'no-sign-in' });
  assert.deepEqual((await off.call('/api/monitors/status')).body.agents, {
    available: false,
    pause: true,
    reason: 'no-sign-in',
  });
  const cands = await off.call(`/api/agents/candidates?key=${KEY}`);
  assert.equal(cands.status, 403);
  assert.match(cands.body.error, /without a dashboard sign-in/);
  for (const a of ['pause', 'resume', 'stop']) {
    const r = await off.post(`/api/agents/${a}`, { key: KEY, pid: 4242, startTime: 1000, confirm: true });
    assert.equal(r.status, 403, a);
    assert.deepEqual(r.body, { error: 'agent control is off without a dashboard sign-in' });
  }
  const refused = await off.post('/api/monitors/cost_burn', { autoPause: true });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'agent control is off without a dashboard sign-in' });
  assert.equal(off.state.settings('cost_burn').autoPause, false, 'nothing was saved');
  assert.ok((await off.call('/api/monitors')).body.rules.every((x) => x.mayAutoPause === false));
  assert.deepEqual(off.calls, [], 'the control module was never asked');
  off.done();

  // 'server' (and true, as before) keeps the server-mode wording.
  const server = setup({ agentsOff: 'server' });
  assert.equal((await server.call('/api/monitors/status')).body.agents.reason, 'server');
  const r = await server.post('/api/agents/pause', { key: KEY, pid: 4242, startTime: 1000 });
  assert.deepEqual([r.status, r.body.error], [403, 'agent control is off in server mode']);
  server.done();
});

// ---- a spawned server ----

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // Its own range (6400-6799), apart from the trace, evals and gateway tests.
    const port = 6400 + Math.floor(Math.random() * 400);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
async function startServer(env, { data = tmp('zp-mon-api-srv-') } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        // A secret saved from the settings goes to an encrypted file in the test folder, never the Keychain.
        ZAAFPULSE_SECRET_STORE: 'file',
        ZAAFPULSE_MASTER_KEY: 'a-master-key-for-the-tests-only',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const base = `http://127.0.0.1:${port}`;
    const kill = async () => {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
    };
    const stop = async () => {
      await kill();
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { port, data, base, stop };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}

function client(base, headers = {}) {
  const bodies = [];
  const call = async (p, { method = 'GET', body, raw, extra = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...extra },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  };
  const post = (p, body, extra = JSON_HEADERS) => call(p, { method: 'POST', body, extra });
  return { call, post, bodies };
}

test('monitors over HTTP: demo data, demo actions, validation', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const list = await c.call('/api/monitors');
    assert.equal(list.status, 200);
    const states = new Set(list.json.rules.map((r) => r.state));
    for (const st of ['ok', 'triggered', 'no_data', 'off']) assert.ok(states.has(st), `a rule is ${st}`);
    const snoozed = list.json.rules.flatMap((r) => r.instances).filter((i) => i.state === 'snoozed');
    assert.equal(snoozed.length, 1);
    assert.equal(list.json.channels.webhook.configured, true);
    assert.equal(list.json.channels.sending, false, 'demo sends nothing');

    const alerts = (await c.call('/api/alerts')).json.alerts;
    assert.equal(alerts.length, 5);
    const pause = alerts.find((a) => a.action === 'pause');
    assert.equal(pause.ok, true);
    assert.ok(pause.sessionKey, 'the demo session has a trace key');

    const key = (await c.call('/api/trace/sessions?range=30')).json.sessions.find((r) => r.source === 'claude').key;
    const cand = await c.call(`/api/agents/candidates?key=${key}`);
    assert.equal(cand.status, 200);
    assert.equal(cand.json.candidates.length, 1);
    const { pid, startTime } = cand.json.candidates[0];
    for (const a of ['pause', 'resume', 'stop']) {
      const r = await c.post(`/api/agents/${a}`, { key, pid, startTime, confirm: true });
      assert.equal(r.status, 200, a);
      assert.equal(r.json.demo, true);
    }
    assert.equal((await c.post('/api/monitors/test', { kind: 'desktop' })).json.demo, true);
    const status = await c.call('/api/monitors/status');
    // Demo signals nothing, so with no sign-in it keeps the controls shown.
    assert.equal(status.json.agents.available, true);
    assert.equal(status.json.agents.reason, null);
    assert.equal(status.json.paused.length, 1);
    assert.equal(status.json.paused[0].sessionKey, key);

    // Validation, JSON only.
    assert.equal((await c.post('/api/monitors/cost_burn', { enabled: 'yes' })).status, 400);
    assert.equal((await c.post('/api/agents/stop', { key, pid, startTime })).status, 400);
    assert.equal((await c.call('/api/monitors/cost_burn', { method: 'POST', raw: '{}' })).status, 415);
    assert.equal((await c.call('/api/agents/pause', { method: 'POST', raw: '{}' })).status, 415);
    // A change applies to the demo store.
    const on = await c.post('/api/monitors/agent_stuck', { enabled: true, params: { stuckMin: 20 } });
    assert.equal(on.json.params.stuckMin, 20);
    noPaths(c.bodies);
    for (const b of c.bodies) assert.doesNotMatch(b, /demo-claude-1|demo-codex-1/, 'no raw session id');
  } finally {
    await s.stop();
  }
});

test('monitors over HTTP: the webhook is saved as a secret reference, and a plain one is not used', async () => {
  const data = tmp('zp-mon-api-cfg-');
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({ userName: 'Kept', monitors: { channels: { webhook: { url: 'https://plain.example.com/x' } } } }),
  );
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const before = (await c.call('/api/monitors')).json.channels;
    assert.equal(before.webhook.configured, false);
    assert.match(before.webhook.problem, /secret references/);
    assert.equal(before.sending, false, 'the tests turn notifications off');
    const r = await c.post('/api/monitors/channels', {
      desktop: false,
      webhookRef: { mode: 'store', value: 'https://hooks.example.com/secret-path' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.webhook.configured, true);
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(cfg.userName, 'Kept');
    assert.deepEqual(cfg.monitors.channels, {
      desktop: false,
      webhook: { url: { keychain: 'acc.monitors-webhook-url' } },
    });
    assert.doesNotMatch(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), /hooks\.example\.com/);
    const t = await c.post('/api/monitors/test', { kind: 'webhook' });
    assert.equal(t.json.ok, false);
    assert.match(t.json.error, /off/);
    assert.equal((await c.post('/api/monitors/channels', { webhookRef: 'https://x.example.com' })).status, 400);
    for (const b of c.bodies) assert.doesNotMatch(b, /hooks\.example\.com|plain\.example\.com/);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('monitors over HTTP: with ZAAFPULSE_AUTH=none (no demo) agent control is off for want of a sign-in', async () => {
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const status = await c.call('/api/monitors/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.agents.available, false);
    assert.equal(status.json.agents.reason, 'no-sign-in');
    const r = await c.post('/api/monitors/cost_burn', { autoPause: true });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /without a dashboard sign-in/);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

test('monitors over HTTP: sign-in gate, gateway keys refused, agent routes off with password sign-in', async () => {
  const data = tmp('zp-mon-api-auth-');
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'mon', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 }).secret;
  gw.flush();
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  const anon = client(s.base);
  const bearer = client(s.base, { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey });
  try {
    const reads = ['/api/monitors', '/api/monitors/status', '/api/alerts', '/api/agents/candidates?key=x'];
    const writes = [
      '/api/monitors/cost_burn',
      '/api/monitors/channels',
      '/api/monitors/test',
      '/api/agents/pause',
      '/api/agents/resume',
      '/api/agents/stop',
    ];
    for (const who of [anon, bearer]) {
      for (const p of reads) assert.equal((await who.call(p)).status, 401, p);
      for (const p of writes)
        assert.equal((await who.post(p, { pid: 4242, startTime: 1, confirm: true })).status, 401, p);
    }
    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const c = client(s.base, { cookie });
    assert.equal((await c.call('/api/monitors')).status, 200);
    assert.equal((await c.call('/api/alerts')).status, 200);
    assert.equal((await c.call('/api/monitors/status')).json.agents.available, false);
    assert.equal((await c.call('/api/agents/candidates?key=x')).status, 403);
    // The pid is a child spawned here, never the test runner or any other live process.
    const child = sleeper();
    try {
      for (const a of ['pause', 'resume', 'stop']) {
        const r = await c.post(`/api/agents/${a}`, { pid: child.pid, startTime: 1, confirm: true });
        assert.equal(r.status, 403, a);
        assert.match(r.json.error, /server mode/, a);
      }
    } finally {
      child.kill('SIGKILL');
    }
    // The control module audits every refusal it makes: an empty log shows the API gate refused first.
    const auditFile = path.join(data, '.data', 'agent-audit.jsonl');
    const lines = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim() : '';
    assert.equal(lines, '', 'the control module was never reached');
    assert.equal((await c.post('/api/monitors/cost_burn', { autoPause: true })).status, 409);
    assert.ok((await c.call('/api/monitors')).json.rules.every((x) => x.mayAutoPause === false));
    for (const who of [c, anon, bearer]) noPaths(who.bodies);
  } finally {
    await s.stop();
  }
});
