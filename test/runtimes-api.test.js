const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeApi } = require('../lib/runtimes/api');

const HOME = '/Users/someone';
const QWEN = {
  id: 'qwen-local',
  name: 'Qwen (llama.cpp)',
  command: ['llama-server', '-m', `${HOME}/models/qwen.gguf`, '--port', '8081'],
  port: 8081,
};
const ROW = {
  id: 'ollama',
  name: 'Ollama',
  preset: true,
  installed: true,
  running: true,
  healthy: true,
  how: 'service',
  pid: 4242,
  startTime: 1_790_000_000_000,
  children: 1,
  port: 11434,
  canStart: false,
  canStop: true,
  reason: null,
  approved: true,
  error: null,
  models: null,
};
const err = (status, message, extra) => Object.assign(new Error(message), { status }, extra);

function setup({ list = [ROW], stored = [QWEN], demo = null, act = {}, off = null, approvedFn = null, forgetThrows = false } = {}) {
  const calls = [];
  const forgot = [];
  const approvedIds = new Set();
  const saved = { value: stored };
  const audits = [];
  const logs = [];
  const control = {
    list: async () => list,
    approved: (e) => (approvedFn ? approvedFn(e) : approvedIds.has(e.id)),
    forget: (id) => {
      forgot.push(id);
      if (forgetThrows) throw new Error(`boom ${HOME}/x`);
    },
    offReason: () => off,
    record: (action, id, extra) => audits.push({ action, id, ...extra }),
  };
  for (const a of ['start', 'stop', 'approve'])
    control[a] = async (target) => {
      calls.push([a, target]);
      if (act[a]) return act[a](target);
      return a === 'approve' ? { approved: true } : { state: a === 'start' ? 'running' : 'stopped' };
    };
  const api = createRuntimeApi({
    control,
    config: { list: () => saved.value, save: (v) => (saved.value = v) },
    demo,
    home: HOME,
    log: (m) => logs.push(m),
  });
  const call = (method, path, body, contentType = 'application/json') =>
    api.route({
      method,
      path,
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  return { api, call, calls, forgot, saved, approvedIds, audits, logs };
}
const noPath = (body) => assert.doesNotMatch(JSON.stringify(body), /\/Users\/|[A-Z]:\\\\/, JSON.stringify(body));

test('GET /api/runtimes lists the runtimes with the fields the page uses', async () => {
  const { call } = setup();
  const r = await call('GET', '/api/runtimes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [ROW]);
  assert.equal((await setup().api.route({ method: 'GET', path: '/api/other' })), null, 'not ours');
  assert.equal((await call('GET', '/api/runtimes/nope')).status, 404);
  assert.equal((await call('POST', '/api/runtimes')).status, 405);
  assert.equal((await call('GET', '/api/runtimes/start')).status, 405);
});

test('POST needs JSON, a JSON object and only known fields', async () => {
  const { call, calls } = setup();
  assert.equal((await call('POST', '/api/runtimes/start', { id: 'ollama' }, 'text/plain')).status, 415);
  assert.equal((await call('POST', '/api/runtimes/start', 'id=ollama', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await call('POST', '/api/runtimes/start', '{bad')).status, 400);
  assert.equal((await call('POST', '/api/runtimes/start', '[1]')).status, 400);
  const extra = await call('POST', '/api/runtimes/start', { id: 'ollama', command: ['sh', '-c', 'x'] });
  assert.equal(extra.status, 400);
  assert.match(extra.body.error, /unknown field: command/);
  assert.equal((await call('POST', '/api/runtimes/start', { id: 'Ollama!' })).status, 400);
  assert.equal((await call('POST', '/api/runtimes/start', {})).status, 400);
  assert.deepEqual(calls, [], 'nothing reached the control module');
});

test('start, stop and approve pass the id (and the process) to the control module', async () => {
  const { call, calls } = setup();
  assert.deepEqual((await call('POST', '/api/runtimes/start', { id: 'ollama' })).body, { state: 'running' });
  const target = { id: 'ollama', pid: 4242, startTime: 1_790_000_000_000 };
  assert.deepEqual((await call('POST', '/api/runtimes/stop', target)).body, { state: 'stopped' });
  assert.deepEqual((await call('POST', '/api/runtimes/approve', { id: 'qwen-local' })).body, { approved: true });
  assert.deepEqual(calls, [
    ['start', 'ollama'],
    ['stop', target],
    ['approve', 'qwen-local'],
  ]);
  assert.equal((await call('POST', '/api/runtimes/stop', { ...target, pid: 1 })).status, 400);
  assert.equal((await call('POST', '/api/runtimes/stop', { ...target, pid: '4242' })).status, 400);
  assert.equal((await call('POST', '/api/runtimes/stop', { id: 'ollama', pid: 4242 })).status, 400);
});

test('refusals keep their status; messages and log lines carry no path; anything else is a 500', async () => {
  const cases = [
    [404, 'unknown runtime'],
    [409, 'not installed'],
    [409, 'the process changed; refresh'],
    [403, 'approve it in Settings first'],
    [403, 'runtime control is off on this server'],
    [400, 'a stop needs the pid and start time shown'],
  ];
  for (const [status, message] of cases) {
    const { call } = setup({ act: { start: () => Promise.reject(err(status, message)) } });
    const r = await call('POST', '/api/runtimes/start', { id: 'ollama' });
    assert.equal(r.status, status);
    assert.deepEqual(r.body, { error: message });
  }
  const failing = setup({
    act: {
      start: () =>
        Promise.reject(
          err(502, `cannot open ${HOME}/models/qwen.gguf`, { log: [`error loading ${HOME}/models/qwen.gguf`, 'C:\\Users\\u\\m.gguf'] }),
        ),
    },
  });
  const r = await failing.call('POST', '/api/runtimes/start', { id: 'ollama' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'cannot open [path]');
  assert.deepEqual(r.body.log, ['error loading [path]', '[path]']);
  noPath(r.body);
  const starting = setup({ act: { start: async () => ({ state: 'starting', note: 'started, not answering yet', log: [`${HOME}/x/y.gguf`] }) } });
  const s = await starting.call('POST', '/api/runtimes/start', { id: 'ollama' });
  assert.equal(s.status, 200);
  noPath(s.body);
  const odd = setup({ act: { stop: () => Promise.reject(new Error(`EACCES ${HOME}/.data`)) } });
  const o = await odd.call('POST', '/api/runtimes/stop', { id: 'ollama', pid: 4242, startTime: 1 });
  assert.equal(o.status, 500);
  assert.deepEqual(o.body, { error: 'the runtime could not be stopped' });
  const listed = setup({ list: [{ ...ROW, reason: `cannot read ${HOME}/x`, error: '/etc/passwd is bad' }] });
  noPath((await listed.call('GET', '/api/runtimes')).body);
});

test('Settings: the health URL is stored only when given, so the default follows a port change', async () => {
  const { call, saved } = setup({ stored: [{ ...QWEN, health: 'http://127.0.0.1:8081/' }] });
  const before = (await call('GET', '/api/runtimes/config')).body.entries[0];
  assert.equal(before.health, null, 'a stored default is shown as not given, so the form leaves it empty');
  assert.equal(before.healthUsed, 'http://127.0.0.1:8081/');
  const command = [...QWEN.command.slice(0, -1), '8082'];
  const edit = await call('POST', '/api/runtimes/save', { was: 'qwen-local', entry: { ...QWEN, command, port: 8082 } });
  assert.equal(edit.status, 200);
  assert.deepEqual(saved.value, [{ ...QWEN, command, port: 8082 }], 'no health in config.json');
  assert.equal(edit.body.entries[0].health, null);
  assert.equal(edit.body.entries[0].healthUsed, 'http://127.0.0.1:8082/', 'the health URL followed the port');
  const own = await call('POST', '/api/runtimes/save', {
    was: 'qwen-local',
    entry: { ...QWEN, command, port: 8082, health: 'http://localhost:8082/health' },
  });
  assert.equal(saved.value[0].health, 'http://localhost:8082/health');
  assert.equal(own.body.entries[0].health, 'http://localhost:8082/health');
  assert.equal(own.body.entries[0].healthUsed, 'http://localhost:8082/health');
});

test('Settings: the entries with ~ for the home folder; save expands it, checks the entry and keeps the others', async () => {
  const { call, saved, forgot, approvedIds } = setup();
  approvedIds.add('qwen-local');
  const r = await call('GET', '/api/runtimes/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entries, [
    {
      id: 'qwen-local',
      name: 'Qwen (llama.cpp)',
      command: ['llama-server', '-m', '~/models/qwen.gguf', '--port', '8081'],
      port: 8081,
      health: null,
      healthUsed: 'http://127.0.0.1:8081/',
      approved: true,
      error: null,
    },
  ]);
  noPath(r.body);
  const add = await call('POST', '/api/runtimes/save', {
    entry: { id: 'mistral', name: 'Mistral', command: ['llama-server', '-m', '~/m/mistral.gguf', '--port', '8082'], port: 8082 },
  });
  assert.equal(add.status, 200);
  assert.deepEqual(saved.value[1], {
    id: 'mistral',
    name: 'Mistral',
    command: ['llama-server', '-m', `${HOME}/m/mistral.gguf`, '--port', '8082'],
    port: 8082,
  });
  assert.equal(add.body.entries.length, 2);
  const dup = await call('POST', '/api/runtimes/save', { entry: { ...QWEN } });
  assert.equal(dup.status, 409);
  const bad = await call('POST', '/api/runtimes/save', { entry: { ...QWEN, id: 'new-one', port: 0 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /port/);
  const preset = await call('POST', '/api/runtimes/save', { entry: { ...QWEN, id: 'ollama' } });
  assert.equal(preset.status, 400);
  const extra = await call('POST', '/api/runtimes/save', { entry: { ...QWEN, id: 'x2', shell: true } });
  assert.equal(extra.status, 400);
  // Edit: renaming moves the entry and drops the old approval.
  const edit = await call('POST', '/api/runtimes/save', { was: 'qwen-local', entry: { ...QWEN, id: 'qwen' } });
  assert.equal(edit.status, 200);
  assert.deepEqual(saved.value.map((x) => x.id), ['qwen', 'mistral']);
  assert.deepEqual(forgot, ['mistral', 'qwen-local']);
  assert.equal((await call('POST', '/api/runtimes/save', { was: 'gone', entry: { ...QWEN, id: 'gone' } })).status, 404);
  const del = await call('POST', '/api/runtimes/delete', { id: 'mistral' });
  assert.equal(del.status, 200);
  assert.deepEqual(saved.value.map((x) => x.id), ['qwen']);
  assert.deepEqual(forgot, ['mistral', 'qwen-local', 'mistral']);
  assert.equal((await call('POST', '/api/runtimes/delete', { id: 'mistral' })).status, 404);
  // A hand-written entry that is not valid is listed with its reason.
  const handmade = setup({ stored: [{ id: 'x', command: 'llama-server -m x', port: 1 }] });
  const [h] = (await handmade.call('GET', '/api/runtimes/config')).body.entries;
  assert.match(h.error, /command/);
});

test('demo mode: answers from the demo, changes nothing in config.json', async () => {
  const demo = {
    config: [QWEN],
    approved: (id) => id === 'qwen-local',
    list: () => [ROW],
    start: async (id) => ({ state: 'running', demo: true, id }),
    stop: async () => ({ state: 'stopped', demo: true }),
    approve: async () => ({ approved: true, demo: true }),
  };
  const { call, calls, saved } = setup({ demo });
  assert.deepEqual((await call('GET', '/api/runtimes')).body, [ROW]);
  assert.deepEqual((await call('POST', '/api/runtimes/start', { id: 'ollama' })).body, { state: 'running', demo: true, id: 'ollama' });
  assert.equal((await call('GET', '/api/runtimes/config')).body.entries[0].approved, true);
  assert.equal((await call('POST', '/api/runtimes/save', { entry: { ...QWEN, id: 'x' } })).status, 409);
  assert.equal((await call('POST', '/api/runtimes/delete', { id: 'qwen-local' })).status, 409);
  assert.deepEqual(calls, [], 'the real control module is never asked');
  assert.deepEqual(saved.value, [QWEN]);
});

test('a start still in progress answers 409; odd ids and paths are handled', async () => {
  const busy = setup({ act: { start: () => Promise.reject(err(409, 'a start is still in progress; try again shortly')) } });
  const b = await busy.call('POST', '/api/runtimes/start', { id: 'ollama' });
  assert.equal(b.status, 409);
  assert.deepEqual(b.body, { error: 'a start is still in progress; try again shortly' });
  const { call } = setup({ stored: [{ id: 'constructor', name: 'C', command: ['llama-server', '--port', '8083'], port: 8083 }] });
  assert.equal((await call('GET', '/api/runtimes/constructor')).status, 404);
  assert.equal((await call('GET', '/api/runtimes/config')).body.entries[0].id, 'constructor');
  assert.equal((await call('POST', '/api/runtimes/save', { entry: { id: 'constructor', name: 'x' } })).status, 409);
});

const { commandHash } = require('../lib/runtimes/registry');
const { OFF_TEXT } = require('../lib/runtimes/control');
// A GitHub-token-like secret built at run time, with varied characters.
const SECRET = 'ghp_' + Array.from({ length: 36 }, (_, i) => 'aZ3kQ9xLmN2pR7tVbW5yHc8DfG1jSe4uAiOl'[(i * 7) % 36]).join('');

test('while control is off, save and delete are refused 403 and the config view hides the commands', async () => {
  for (const why of ['server', 'no-sign-in', 'docker']) {
    const { call, saved, audits, forgot } = setup({ off: why });
    const evil = { id: 'evil', name: 'Ollama', command: ['sh', '-c', 'curl x|sh'], port: 9 };
    const s = await call('POST', '/api/runtimes/save', { entry: evil });
    assert.equal(s.status, 403);
    assert.equal(s.body.error, OFF_TEXT[why]);
    const d = await call('POST', '/api/runtimes/delete', { id: 'qwen-local' });
    assert.equal(d.status, 403);
    assert.deepEqual(saved.value, [QWEN], 'config unchanged');
    assert.deepEqual(forgot, []);
    assert.deepEqual(audits.map((a) => [a.action, a.status, a.ok]), [['save', 403, false], ['delete', 403, false]]);
    const v = (await call('GET', '/api/runtimes/config')).body;
    assert.equal(v.off, OFF_TEXT[why]);
    assert.equal(v.entries[0].id, 'qwen-local');
    assert.equal(v.entries[0].command, null);
    assert.doesNotMatch(JSON.stringify(v), /llama-server|qwen\.gguf/);
  }
  assert.equal((await setup().call('GET', '/api/runtimes/config')).body.off, null);
});

test('a rename onto a taken id (even an invalid entry) is refused 409', async () => {
  const bad = { id: 'b', name: 'B', command: ['llama-server'], port: 0 };
  const { call, saved } = setup({ stored: [QWEN, bad] });
  const r = await call('POST', '/api/runtimes/save', { was: 'qwen-local', entry: { ...QWEN, id: 'b' } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /an entry with this id exists/);
  assert.deepEqual(saved.value, [QWEN, bad]);
});

test('content-type follows the server rule', async () => {
  const { call } = setup();
  const ok = (ct) => call('POST', '/api/runtimes/start', { id: 'ollama' }, ct);
  assert.equal((await ok('application/json; charset=utf-8')).status, 200);
  assert.equal((await ok('Application/JSON')).status, 200);
  assert.equal((await ok('application/json ;x=1')).status, 200);
  assert.equal((await ok('application/jsonx')).status, 415);
  assert.equal((await ok('')).status, 415);
});

test('secrets in arguments are masked in the view and survive an unchanged round trip', async () => {
  const cmd = ['llama-server', '--api-key', SECRET, '--port', '8090'];
  const { call, saved } = setup({ stored: [{ id: 'k', name: 'K', command: cmd, port: 8090 }] });
  const v = (await call('GET', '/api/runtimes/config')).body.entries[0];
  assert.doesNotMatch(JSON.stringify(v), new RegExp(SECRET));
  assert.match(v.command[2], /hidden\u203a/);
  const r = await call('POST', '/api/runtimes/save', { was: 'k', entry: { id: 'k', name: 'K2', command: v.command, port: 8090 } });
  assert.equal(r.status, 200);
  assert.deepEqual(saved.value[0].command, cmd, 'the stored secret is kept');
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(SECRET));
  // A changed argument is saved as sent.
  const changed = await call('POST', '/api/runtimes/save', { was: 'k', entry: { id: 'k', name: 'K2', command: [...v.command.slice(0, 2), 'newsecret', '--port', '8090'], port: 8090 } });
  assert.equal(changed.status, 200);
  assert.equal(saved.value[0].command[2], 'newsecret');
  // The placeholder is never written for a new entry, nor for a changed argument.
  const before = JSON.stringify(saved.value);
  const fresh = await call('POST', '/api/runtimes/save', { entry: { id: 'n', name: 'N', command: ['llama-server', '--api-key', v.command[2], '--port', '8091'], port: 8091 } });
  assert.equal(fresh.status, 400);
  assert.equal(JSON.stringify(saved.value), before);
});

test('a new entry forgets a stale approval first; a failing forget does not undo a saved change', async () => {
  const { call, forgot, saved, logs, audits } = setup({ forgetThrows: true });
  const r = await call('POST', '/api/runtimes/save', { entry: { id: 'mistral', name: 'M', command: ['llama-server', '--port', '8082'], port: 8082 } });
  assert.equal(r.status, 200);
  assert.deepEqual(forgot, ['mistral']);
  assert.equal(saved.value.length, 2);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs.join(), /\/Users\//);
  const rename = await call('POST', '/api/runtimes/save', { was: 'mistral', entry: { id: 'm2', name: 'M', command: ['llama-server', '--port', '8082'], port: 8082 } });
  assert.equal(rename.status, 200);
  const del = await call('POST', '/api/runtimes/delete', { id: 'm2' });
  assert.equal(del.status, 200);
  assert.deepEqual(audits.map((a) => [a.action, a.id, a.status]), [['save', 'mistral', 200], ['save', 'm2', 200], ['delete', 'm2', 200]]);
});

test('save and delete are audited with id and status and never carry the command; save never approves', async () => {
  const { call, audits, calls } = setup();
  await call('POST', '/api/runtimes/save', { entry: { id: 'mistral', name: 'M', command: ['llama-server', '--api-key', 'topsecret', '--port', '8082'], port: 8082 } });
  await call('POST', '/api/runtimes/save', { entry: { ...QWEN } }); // 409
  await call('POST', '/api/runtimes/save', { entry: { id: 'x', command: 'nope' } }); // 400
  await call('POST', '/api/runtimes/delete', { id: 'gone' }); // 404
  await call('POST', '/api/runtimes/delete', { id: 'mistral' });
  assert.deepEqual(audits.map((a) => [a.action, a.id, a.status, a.ok]), [
    ['save', 'mistral', 200, true],
    ['save', 'qwen-local', 409, false],
    ['save', 'x', 400, false],
    ['delete', 'gone', 404, false],
    ['delete', 'mistral', 200, true],
  ]);
  assert.doesNotMatch(JSON.stringify(audits), /topsecret|llama-server/);
  assert.deepEqual(calls, [], 'save and edit never approve');
});

test('an edit drops the approval because the hash covers the whole entry; a bad was; ~ only at the start', async () => {
  const hashes = new Set([commandHash(QWEN.command)]);
  const { call, saved } = setup({ approvedFn: (e) => hashes.has(commandHash(e.command)) });
  const view = async () => (await call('GET', '/api/runtimes/config')).body.entries[0];
  assert.equal((await view()).approved, true);
  const edit = await call('POST', '/api/runtimes/save', {
    was: 'qwen-local',
    entry: { ...QWEN, command: ['llama-server', '-m', '~/models/qwen.gguf', '--port', '8081', '--ctx-size', '4096'] },
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.entries[0].approved, false, 'an edited command asks again');
  assert.equal((await call('POST', '/api/runtimes/save', { was: 'Bad Id!', entry: QWEN })).status, 400);
  assert.equal((await call('POST', '/api/runtimes/save', { was: 5, entry: QWEN })).status, 400);
  const tilde = await call('POST', '/api/runtimes/save', {
    was: 'qwen-local',
    entry: { ...QWEN, command: ['llama-server', '--root=~/x', 'a~b', '~', '~/m.gguf', '--port', '8081'] },
  });
  assert.equal(tilde.status, 200);
  assert.deepEqual(saved.value[0].command, ['llama-server', '--root=~/x', 'a~b', '~', `${HOME}/m.gguf`, '--port', '8081']);
});

test('a row passes on its models, filtered; a start answer passes on reloading, filtered', async () => {
  const models = {
    remembered: ['llama3.2:3b', '-rf', 7, 'qwen3:8b'],
    loading: 'yes',
    loaded: ['llama3.2:3b', `${HOME}/x`],
    failed: [{ name: 'qwen3:8b', error: `could not read ${HOME}/m.gguf`, extra: 1 }, { name: '-x', error: 'no' }, null],
    extra: true,
  };
  const { call } = setup({
    list: [{ ...ROW, models }, { ...ROW, id: 'jan', models: 'odd' }],
    act: { start: async () => ({ state: 'running', reloading: ['llama3.2:3b', '--yes', `${HOME}/q`] }) },
  });
  const [a, b] = (await call('GET', '/api/runtimes')).body;
  assert.deepEqual(a.models, {
    remembered: ['llama3.2:3b', 'qwen3:8b'],
    loading: false,
    loaded: ['llama3.2:3b'],
    failed: [{ name: 'qwen3:8b', error: 'could not read [path]' }],
  });
  assert.equal(b.models, null);
  assert.deepEqual((await call('POST', '/api/runtimes/start', { id: 'ollama' })).body, {
    state: 'running',
    reloading: ['llama3.2:3b'],
  });
});

test('demo mode: Ollama remembers a model, and a Start after a Stop answers reloading', async () => {
  const { runtimesDemo } = require('../lib/demo');
  const { call } = setup({ demo: runtimesDemo() });
  const rows = (await call('GET', '/api/runtimes')).body;
  const ollama = rows.find((r) => r.id === 'ollama');
  assert.deepEqual(ollama.models, { remembered: ['llama3.2:3b'], loading: false, loaded: [], failed: [] });
  assert.deepEqual(rows.find((r) => r.id === 'lmstudio').models, { remembered: [], loading: false, loaded: [], failed: [] });
  assert.equal(rows.find((r) => r.id === 'localai').models, null);
  assert.equal(rows.find((r) => r.id === 'qwen-local').models, null);
  const stop = await call('POST', '/api/runtimes/stop', { id: 'ollama', pid: ollama.pid, startTime: ollama.startTime });
  assert.equal(stop.body.state, 'stopped');
  const start = await call('POST', '/api/runtimes/start', { id: 'ollama' });
  assert.deepEqual(start.body, { state: 'running', demo: true, reloading: ['llama3.2:3b'] });
  const after = (await call('GET', '/api/runtimes')).body.find((r) => r.id === 'ollama');
  assert.deepEqual(after.models, { remembered: ['llama3.2:3b'], loading: false, loaded: ['llama3.2:3b'], failed: [] });
  const lms = await call('POST', '/api/runtimes/start', { id: 'lmstudio' });
  assert.deepEqual(lms.body, { state: 'running', demo: true }, 'nothing remembered: no reloading');
});
