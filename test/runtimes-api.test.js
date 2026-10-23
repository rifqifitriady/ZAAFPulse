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
};
const err = (status, message, extra) => Object.assign(new Error(message), { status }, extra);

function setup({ list = [ROW], stored = [QWEN], demo = null, act = {} } = {}) {
  const calls = [];
  const forgot = [];
  const approvedIds = new Set();
  const saved = { value: stored };
  const control = {
    list: async () => list,
    approved: (e) => approvedIds.has(e.id),
    forget: (id) => forgot.push(id),
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
  });
  const call = (method, path, body, contentType = 'application/json') =>
    api.route({
      method,
      path,
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  return { api, call, calls, forgot, saved, approvedIds };
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
      health: 'http://127.0.0.1:8081/',
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
    health: 'http://127.0.0.1:8082/',
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
  assert.deepEqual(forgot, ['qwen-local']);
  assert.equal((await call('POST', '/api/runtimes/save', { was: 'gone', entry: { ...QWEN, id: 'gone' } })).status, 404);
  const del = await call('POST', '/api/runtimes/delete', { id: 'mistral' });
  assert.equal(del.status, 200);
  assert.deepEqual(saved.value.map((x) => x.id), ['qwen']);
  assert.deepEqual(forgot, ['qwen-local', 'mistral']);
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
