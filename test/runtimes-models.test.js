const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { jsonFile } = require('../lib/runtimes/state');
const {
  createModelMemory,
  getJson,
  postJson,
  NAME_RE,
  MAX_MODELS,
  LOAD_TIMEOUT_MS,
} = require('../lib/runtimes/models');

const tmpFile = () => jsonFile(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-rt-mdl-')), 'models.json'));
const ollama = (extra = {}) => ({
  entry: { id: 'ollama', port: 11434, preset: true },
  running: true,
  healthy: true,
  bin: '/x/ollama',
  ...extra,
});
const lms = (extra = {}) => ({
  entry: { id: 'lmstudio', port: 1234, preset: true },
  running: true,
  healthy: true,
  bin: '/x/lms',
  ...extra,
});
const ps =
  (...names) =>
  async () => ({ models: names.map((name) => ({ name })) });
const mem = (o = {}) => createModelMemory({ file: tmpFile(), now: () => 1000, ...o });
const tick = () => new Promise((r) => setImmediate(r));

test('constants', () => {
  assert.equal(LOAD_TIMEOUT_MS, 5 * 60 * 1000);
  assert.equal(MAX_MODELS, 8);
  assert.ok(NAME_RE.test('llama3.2:3b') && NAME_RE.test('lmstudio-community/Qwen3-8B@q4'));
});

test('supports only the ollama and lmstudio presets', () => {
  const m = mem();
  assert.equal(m.supports('ollama'), true);
  assert.equal(m.supports('lmstudio'), true);
  assert.equal(m.supports('jan'), false);
});

test('ollama: observe reads /api/ps on the entry port and saves the names', async () => {
  const urls = [];
  const m = mem({ getJson: async (u, t) => (urls.push([u, t]), { models: [{ name: 'llama3.2:3b' }] }) });
  assert.deepEqual(await m.observe(ollama({ entry: { id: 'ollama', port: 12345, preset: true } })), ['llama3.2:3b']);
  assert.deepEqual(urls, [['http://127.0.0.1:12345/api/ps', 3000]]);
  assert.deepEqual(m.remembered('ollama'), ['llama3.2:3b']);
});

test('lmstudio: observe runs lms ps --json (modelKey, else identifier)', async () => {
  const calls = [];
  const out = JSON.stringify([{ modelKey: 'qwen3-8b' }, { identifier: 'gemma-3' }]);
  const m = mem({ run: async (argv) => (calls.push(argv), { code: 0, stdout: out }) });
  assert.deepEqual(await m.observe(lms()), ['qwen3-8b', 'gemma-3']);
  assert.deepEqual(calls, [['/x/lms', 'ps', '--json']]);
  const m2 = mem({ run: async () => ({ code: 0, stdout: JSON.stringify({ models: [{ modelKey: 'a1' }] }) }) });
  assert.deepEqual(await m2.observe(lms()), ['a1']);
});

test('observe does not read a stopped, unhealthy or unsupported item', async () => {
  let n = 0;
  const m = mem({
    getJson: async () => (n++, { models: [{ name: 'a' }] }),
    run: async () => (n++, { code: 0, stdout: '[]' }),
  });
  assert.equal(await m.observe(ollama({ running: false })), null);
  assert.equal(await m.observe(ollama({ healthy: false })), null);
  assert.equal(
    await m.observe({ entry: { id: 'ollama', port: 1, preset: false }, running: true, healthy: true }),
    null,
  );
  assert.equal(await m.observe({ entry: { id: 'jan', port: 1, preset: true }, running: true, healthy: true }), null);
  assert.equal(n, 0);
});

test('an empty or unknown read keeps the saved list; a different non-empty one replaces it', async () => {
  let answer = { models: [{ name: 'a' }] };
  let lmsOut = { code: 0, stdout: '[{"modelKey":"q"}]' };
  const m = mem({ getJson: async () => answer, run: async () => lmsOut });
  await m.observe(ollama());
  await m.observe(lms());
  for (const [a, read] of [
    [{ models: [] }, []],
    [null, null],
  ]) {
    answer = a;
    assert.deepEqual(await m.observe(ollama()), read);
    assert.deepEqual(m.remembered('ollama'), ['a']);
  }
  for (const o of [
    { code: 0, stdout: '[]' },
    { code: 1, stdout: '[{"modelKey":"z"}]' },
    { code: 0, stdout: 'not json' },
  ]) {
    lmsOut = o;
    await m.observe(lms());
    assert.deepEqual(m.remembered('lmstudio'), ['q']);
  }
  answer = { models: [{ name: 'b' }, { name: 'c' }] };
  await m.observe(ollama());
  assert.deepEqual(m.remembered('ollama'), ['b', 'c']);
});

test('names are filtered and capped', async () => {
  const long = 'a'.repeat(201);
  const m = mem({
    getJson: async () => ({
      models: [{ name: '-rf' }, { name: 'a b' }, { name: long }, { name: 5 }, { name: 'ok' }, {}],
    }),
  });
  assert.deepEqual(await m.observe(ollama()), ['ok']);
  const nine = Array.from({ length: 9 }, (_, i) => ({ name: `m${i}` }));
  const m2 = mem({ getJson: async () => ({ models: nine }) });
  assert.equal((await m2.observe(ollama())).length, 8);
  assert.deepEqual(
    m2.remembered('ollama'),
    nine.slice(0, 8).map((x) => x.name),
  );
});

test('reload: ollama posts keep_alive -1 one name after another, and a 404 does not stop the rest', async () => {
  const log = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const done = [];
  const m = mem({
    getJson: ps('a', 'b', 'c'),
    postJson: async (url, body, t) => {
      log.push(['start', body.model, url, body.keep_alive, t]);
      if (body.model === 'a') await gate;
      log.push(['end', body.model]);
      return { status: body.model === 'b' ? 404 : 200, body: {} };
    },
    onDone: (id, r) => done.push([id, r]),
  });
  await m.observe(ollama());
  assert.equal(m.status('ollama'), null);
  assert.deepEqual(m.reload(ollama()), ['a', 'b', 'c']);
  assert.equal(m.status('ollama').loading, true);
  assert.deepEqual(m.reload(ollama()), []); // one at a time
  await tick();
  assert.deepEqual(log, [['start', 'a', 'http://127.0.0.1:11434/api/generate', -1, LOAD_TIMEOUT_MS]]);
  release();
  while (m.status('ollama').loading) await tick();
  assert.deepEqual(
    log.map((l) => l.slice(0, 2)),
    [
      ['start', 'a'],
      ['end', 'a'],
      ['start', 'b'],
      ['end', 'b'],
      ['start', 'c'],
      ['end', 'c'],
    ],
  );
  assert.deepEqual(m.status('ollama'), {
    loading: false,
    loaded: ['a', 'c'],
    failed: [{ name: 'b', error: 'not found' }],
  });
  assert.deepEqual(done, [['ollama', { loaded: ['a', 'c'], failed: [{ name: 'b', error: 'not found' }] }]]);
});

test('reload: timeouts and other failures give short errors with no path', async () => {
  const m = mem({
    getJson: ps('a', 'b', 'c'),
    postJson: async (u, body) =>
      body.model === 'a' ? null : { status: 500, body: { error: '/Users/x/.ollama/secret' } },
  });
  await m.observe(ollama());
  m.reload(ollama());
  while (m.status('ollama').loading) await tick();
  assert.deepEqual(m.status('ollama').failed, [
    { name: 'a', error: 'timed out' },
    { name: 'b', error: 'could not load' },
    { name: 'c', error: 'could not load' },
  ]);
});

test('reload: lmstudio runs lms load <name> --yes', async () => {
  const calls = [];
  const m = mem({
    run: async (argv, o) => {
      calls.push([argv, o]);
      if (argv[1] === 'ps') return { code: 0, stdout: '[{"modelKey":"qwen3-8b"},{"modelKey":"gemma-3"}]' };
      return { code: argv[2] === 'gemma-3' ? 1 : 0, stdout: '' };
    },
  });
  await m.observe(lms());
  assert.deepEqual(m.reload(lms()), ['qwen3-8b', 'gemma-3']);
  while (m.status('lmstudio').loading) await tick();
  assert.deepEqual(calls.slice(1), [
    [['/x/lms', 'load', 'qwen3-8b', '--yes'], { timeoutMs: LOAD_TIMEOUT_MS }],
    [['/x/lms', 'load', 'gemma-3', '--yes'], { timeoutMs: LOAD_TIMEOUT_MS }],
  ]);
  assert.deepEqual(m.status('lmstudio'), {
    loading: false,
    loaded: ['qwen3-8b'],
    failed: [{ name: 'gemma-3', error: 'could not load' }],
  });
});

test('reload with nothing remembered, or no lms path, calls nothing', async () => {
  let n = 0;
  const m = mem({
    postJson: async () => (n++, { status: 200 }),
    run: async () => (n++, { code: 0, stdout: '' }),
    onDone: () => n++,
  });
  assert.deepEqual(m.reload(ollama()), []);
  assert.deepEqual(m.reload(lms()), []);
  assert.equal(m.status('ollama'), null);
  assert.equal(n, 0);
  const file = tmpFile();
  file.write({ lmstudio: { models: ['q'], ts: 1 } });
  const m2 = createModelMemory({ file, run: async () => (n++, { code: 0, stdout: '' }) });
  assert.deepEqual(m2.reload(lms({ bin: null })), []);
  assert.equal(n, 0);
});

test('a throwing onDone or loader does not break the reload', async () => {
  const m = mem({
    getJson: ps('a'),
    postJson: async () => {
      throw new Error('boom');
    },
    onDone: () => {
      throw new Error('late');
    },
  });
  await m.observe(ollama());
  m.reload(ollama());
  while (m.status('ollama').loading) await tick();
  assert.deepEqual(m.status('ollama').failed, [{ name: 'a', error: 'could not load' }]);
});

test('owner entries and other presets are unsupported', async () => {
  const m = mem({ getJson: ps('a') });
  const owner = { entry: { id: 'ollama', port: 11434, preset: false }, running: true, healthy: true };
  assert.equal(await m.observe(owner), null);
  assert.deepEqual(m.reload(owner), []);
  assert.deepEqual(m.remembered('jan'), []);
  assert.deepEqual(m.reload({ entry: { id: 'jan', preset: true }, running: true, healthy: true }), []);
});

test('saved names are re-filtered when read from the file', () => {
  const file = tmpFile();
  file.write({ ollama: { models: ['ok', '-rf', 7], ts: 1 }, constructor: 5 });
  const m = createModelMemory({ file });
  assert.deepEqual(m.remembered('ollama'), ['ok']);
  assert.deepEqual(m.remembered('constructor'), []);
});

// The real HTTP helpers against a throwaway local server.
test('getJson and postJson never throw', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push([req.method, req.url, b, req.headers['content-type']]);
      if (req.url === '/slow') return;
      if (req.url === '/bad') return res.end('nope');
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.deepEqual(await getJson(`${base}/api/ps`, 1000), { ok: true });
    assert.equal(await getJson(`${base}/bad`, 1000), null);
    assert.equal(await getJson(`${base}/missing`, 1000), null);
    assert.equal(await getJson(`${base}/slow`, 100), null);
    assert.deepEqual(await postJson(`${base}/g`, { model: 'a', keep_alive: -1 }, 1000), {
      status: 200,
      body: { ok: true },
    });
    assert.equal((await postJson(`${base}/missing`, {}, 1000)).status, 404);
    assert.equal(await postJson(`${base}/slow`, {}, 100), null);
    assert.deepEqual(seen.find((s) => s[0] === 'POST' && s[1] === '/g').slice(2), [
      '{"model":"a","keep_alive":-1}',
      'application/json',
    ]);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
  assert.equal(await getJson('http://127.0.0.1:1/x', 500), null);
  assert.equal(await postJson('not a url', {}, 500), null);
});

test('observe does not shrink the saved list while a reload is loading', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let seen = ['a', 'b', 'c'];
  const m = mem({
    getJson: async () => ({ models: seen.map((name) => ({ name })) }),
    postJson: async () => (await gate, { status: 200, body: {} }),
  });
  await m.observe(ollama());
  m.reload(ollama());
  seen = ['a'];
  assert.deepEqual(await m.observe(ollama()), ['a']); // still returns what it read
  assert.deepEqual(m.remembered('ollama'), ['a', 'b', 'c']);
  release();
  while (m.status('ollama').loading) await tick();
  await m.observe(ollama());
  assert.deepEqual(m.remembered('ollama'), ['a']); // saves again once the reload is over
});

// getJson against a server that misbehaves: each must resolve null within the timeout.
async function misbehaving(t, handler) {
  const sockets = new Set();
  const srv = http.createServer(handler);
  srv.on('connection', (s) => (sockets.add(s), s.on('close', () => sockets.delete(s))));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const s of sockets) s.destroy();
    srv.close();
  });
  return `http://127.0.0.1:${srv.address().port}/x`;
}

test('getJson gives null for an endless body bigger than the limit', async (t) => {
  const u = await misbehaving(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 32);
    const timer = setInterval(() => res.write(chunk), 1);
    res.on('close', () => clearInterval(timer));
  });
  const t0 = Date.now();
  assert.equal(await getJson(u, 2000), null);
  assert.ok(Date.now() - t0 < 1900, 'ended by the size limit, not the timeout');
});

test('getJson gives null when the socket is destroyed mid-body', async (t) => {
  const u = await misbehaving(t, (req, res) => {
    res.writeHead(200, { 'content-length': '1000' });
    res.write('{"a":');
    setTimeout(() => req.socket.destroy(), 20);
  });
  assert.equal(await getJson(u, 2000), null);
});

test('getJson gives null when headers arrive and then nothing', async (t) => {
  const u = await misbehaving(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
  });
  const t0 = Date.now();
  assert.equal(await getJson(u, 300), null);
  assert.ok(Date.now() - t0 < 1500);
});
