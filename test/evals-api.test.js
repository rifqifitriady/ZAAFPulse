// The eval and feedback routes over HTTP: /api/evals/*, /api/feedback on a spawned server.js. Demo data for the
// shapes, and a real server (temp HOME and data folder, a Claude log with a secret in it, two fake external
// providers) for the sign-in gate, the settings file and the preview. Nothing reads the machine's own logs and
// nothing contacts a provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { createEvalApi } = require('../lib/evals/api');
const { destinationOf } = require('../lib/evals/claude-cli');
const { fakeServer, secretsFor, NO_JUDGE_PORTS, fakeClaude } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // Above the trace tests' range (5100-5899), below the gateway tests', so parallel files rarely meet.
    const port = 5900 + Math.floor(Math.random() * 500);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
// Starts server.js on a free port of the range; tries again when another test took the port first.
async function startServer(env, { data = tmp('zp-evals-api-') } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
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
        if (!exited) return { port, data, base, child, stop };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}

// A client that keeps every body it receives, so one scan at the end covers all of them.
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
// No response may carry a file path of the machine (S3).
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const noPaths = (bodies) => {
  for (const b of bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
};
const keyOf = async (c, source) =>
  (await c.call('/api/trace/sessions?range=30')).json.sessions.find((r) => r.source === source).key;

test('evals api: demo results, summary, status and the shape of a result', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const claude = await keyOf(c, 'claude');
    const res = await c.call(`/api/evals?key=${claude}`);
    assert.equal(res.status, 200);
    const list = res.json.results;
    assert.ok(list.length >= 8, 'code and judge results for the session');
    const shape = 'evaluator kind scope turn label score pass explanation judge trimmed evidence ts'.split(' ');
    for (const r of list) {
      for (const k of shape) assert.ok(Object.hasOwn(r, k), `${r.evaluator} has ${k}`);
      assert.ok(['code', 'judge'].includes(r.kind));
      assert.equal(typeof r.pass, 'boolean');
      assert.equal(Object.hasOwn(r, 'target'), false, 'no raw session id in a result');
      assert.equal(Object.hasOwn(r, 'key'), false);
      if (r.judge) assert.deepEqual(Object.keys(r.judge), ['kind', 'model', 'provider', 'used']);
    }
    assert.ok(list.some((r) => r.pass) && list.some((r) => !r.pass), 'a mix of pass and fail');
    const codexList = (await c.call(`/api/evals?key=${await keyOf(c, 'codex')}`)).json.results;
    const bad = codexList.find((r) => r.label === 'unfaithful');
    assert.ok(bad, 'one unfaithful verdict');
    assert.ok(bad.explanation.length > 0 && bad.explanation.length <= 300);
    assert.equal(bad.kind, 'judge');
    assert.equal(bad.pass, false);

    assert.ok((await c.call(`/api/evals?key=${claude}&turn=0`)).json.results.length > 0);
    assert.deepEqual((await c.call(`/api/evals?key=${claude}&turn=7`)).json.results, []);
    assert.equal((await c.call(`/api/evals?key=${claude}&turn=abc`)).status, 400);
    assert.equal((await c.call('/api/evals')).status, 400, 'a key is required');
    assert.equal((await c.call('/api/evals?key=not-a-key')).status, 404);
    assert.equal((await c.call(`/api/evals?key=claude.${'0'.repeat(32)}`)).status, 404, 'a forged key');
    assert.equal((await c.call(`/api/evals?key=${'x'.repeat(513)}`)).status, 400);
    for (const source of ['codex', 'kiro']) {
      assert.ok((await c.call(`/api/evals?key=${await keyOf(c, source)}`)).json.results.length > 0, source);
    }

    const sum = await c.call('/api/evals/summary?range=7');
    assert.equal(sum.status, 200);
    assert.ok(Object.keys(sum.json.evaluators).length >= 10);
    const days = Object.keys(sum.json.evaluators.faithfulness.days);
    assert.ok(days.length >= 5, 'a week of daily trends');
    assert.ok(Math.abs(sum.json.agreement.rate - 0.8) < 0.05, 'agreement is about 0.8');
    assert.equal((await c.call('/api/evals/summary?range=0')).status, 200, 'a range is clamped to 1..30');
    assert.equal((await c.call('/api/evals/summary?range=999')).status, 200);
    assert.equal((await c.call('/api/evals/summary')).status, 200, 'and defaults to 7');
    for (const bad of ['abc', '1.5', '7x', '-3', '1e1']) {
      assert.equal((await c.call(`/api/evals/summary?range=${bad}`)).status, 400, `range=${bad}`);
    }

    const st = (await c.call('/api/evals/status')).json;
    assert.equal(st.judge.kind, 'ollama');
    assert.equal(st.judge.model, 'qwen3:8b');
    assert.equal(st.judge.ok, true);

    assert.equal((await c.post('/api/evals/status', {})).status, 405);
    assert.equal((await c.call('/api/evals/nope')).status, 404);
    assert.equal((await c.post('/api/evals', {})).status, 405);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('evals api: with ZAAFPULSE_CONTENT=off explanations are null and labels stay', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none', ZAAFPULSE_CONTENT: 'off' });
  const c = client(s.base);
  try {
    const list = (await c.call(`/api/evals?key=${await keyOf(c, 'codex')}`)).json.results;
    const bad = list.find((r) => r.label === 'unfaithful');
    assert.ok(bad, 'the verdict is still there');
    assert.equal(bad.explanation, null);
    assert.equal(bad.score, 0);
    for (const r of list) assert.equal(r.explanation, null, r.evaluator);
    // Feedback notes are the owner's own text: they stay.
    const k = await keyOf(c, 'codex');
    const saved = await c.post('/api/feedback', { key: k, turn: 0, rating: 'bad', note: 'wrong page size' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.note, 'wrong page size');
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('evals api: feedback round trip, limits and JSON-only writes', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const claude = await keyOf(c, 'claude');
    const kiro = await keyOf(c, 'kiro');
    // The demo already holds a good and a bad record.
    const seeded = (await c.call('/api/feedback?key=' + claude)).json.feedback;
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].rating, 'good');
    assert.equal((await c.call(`/api/feedback?key=${await keyOf(c, 'codex')}`)).json.feedback[0].rating, 'bad');

    assert.deepEqual((await c.call(`/api/feedback?key=${kiro}`)).json.feedback, []);
    const saved = await c.post('/api/feedback', { key: kiro, turn: 0, rating: 'good', note: 'tidy spec' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.rating, 'good');
    assert.equal(saved.json.note, 'tidy spec');
    assert.equal(saved.json.turn, 0);
    assert.equal(Object.hasOwn(saved.json, 'target'), false, 'no raw session id back');
    const back = (await c.call(`/api/feedback?key=${kiro}`)).json.feedback;
    assert.equal(back.length, 1);
    assert.equal(back[0].note, 'tidy spec');
    assert.equal((await c.call(`/api/feedback?key=${kiro}&turn=0`)).json.feedback.length, 1);
    assert.deepEqual((await c.call(`/api/feedback?key=${kiro}&turn=1`)).json.feedback, []);

    // A new rating replaces the old one; an omitted note keeps the text.
    const again = await c.post('/api/feedback', { key: kiro, turn: 0, rating: 'bad' });
    assert.equal(again.json.rating, 'bad');
    assert.equal(again.json.note, 'tidy spec');
    // Clearing the rating and the note removes the record.
    const gone = await c.post('/api/feedback', { key: kiro, turn: 0, rating: null, note: '' });
    assert.equal(gone.status, 200);
    assert.deepEqual((await c.call(`/api/feedback?key=${kiro}`)).json.feedback, []);

    // A whole-session note (no turn).
    const whole = await c.post('/api/feedback', { key: kiro, rating: 'good' });
    assert.equal(whole.status, 200);
    assert.equal(whole.json.turn, null);

    assert.equal((await c.post('/api/feedback', { key: kiro, turn: 0, note: 'x'.repeat(2000) })).status, 200);
    assert.equal((await c.post('/api/feedback', { key: kiro, turn: 0, note: 'x'.repeat(2001) })).status, 400);
    assert.equal((await c.post('/api/feedback', { key: kiro, turn: 0, rating: 'meh' })).status, 400);
    assert.equal((await c.post('/api/feedback', { key: kiro, turn: -1, rating: 'good' })).status, 400);
    // The session has one turn: a record for turn 7 would belong to nothing.
    assert.equal((await c.post('/api/feedback', { key: kiro, turn: 7, rating: 'good' })).status, 400);
    assert.equal((await c.post('/api/feedback', { key: kiro, turn: 1, rating: 'good' })).status, 400);
    assert.deepEqual((await c.call(`/api/feedback?key=${kiro}&turn=7`)).json.feedback, []);
    assert.equal((await c.post('/api/feedback', { key: kiro, turn: 'x', rating: 'good' })).status, 400);
    assert.equal((await c.post('/api/feedback', { key: kiro, turn: 0, note: 5 })).status, 400);
    assert.equal((await c.post('/api/feedback', { turn: 0, rating: 'good' })).status, 400, 'a key is required');
    assert.equal((await c.post('/api/feedback', { key: 'claude.' + '0'.repeat(32), rating: 'good' })).status, 404);
    // A raw session id is not a key.
    assert.equal((await c.post('/api/feedback', { key: 'demo-kiro-1', rating: 'good' })).status, 404);
    assert.equal((await c.post('/api/feedback', [1])).status, 400);
    assert.equal((await c.call('/api/feedback?turn=abc&key=' + kiro)).status, 400);

    const plain = { method: 'POST', raw: '{}', extra: { 'content-type': 'text/plain' } };
    assert.equal((await c.call('/api/feedback', plain)).status, 415);
    assert.equal((await c.call('/api/feedback', { method: 'POST', raw: '{}' })).status, 415);
    assert.equal((await c.call('/api/feedback', { method: 'POST', raw: '{nope', extra: JSON_HEADERS })).status, 400);
    assert.equal((await c.call('/api/feedback', { method: 'DELETE' })).status, 405);
    assert.equal((await c.call('/api/evals/run')).status, 405, 'run is a POST');
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('evals api: the evaluator list for the page, and feedback markers for many sessions at once', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const ev = await c.call('/api/evals/evaluators');
    assert.equal(ev.status, 200);
    const list = ev.json.evaluators;
    const R = require('../lib/evals/registry');
    assert.deepEqual(
      list.map((e) => e.id),
      R.EVALUATORS.map((e) => e.id),
    );
    for (const e of list) {
      assert.deepEqual(Object.keys(e).sort(), ['id', 'kind', 'labels', 'pass', 'scope', 'title']);
      assert.equal(e.pass, e.labels[0]);
    }
    assert.equal(list.find((e) => e.id === 'user_frustration').scope, 'session');
    assert.doesNotMatch(ev.text, /describe|template|system/i, 'titles and labels only, no judge text');
    assert.equal((await c.post('/api/evals/evaluators', {})).status, 405);

    // The demo has a good turn on Claude and a bad one on Codex; Kiro has none.
    const claude = await keyOf(c, 'claude');
    const codex = await keyOf(c, 'codex');
    const kiro = await keyOf(c, 'kiro');
    const marks = await c.call(`/api/feedback/sessions?keys=${[claude, codex, kiro].join(',')}`);
    assert.equal(marks.status, 200);
    assert.deepEqual(marks.json.sessions, { [claude]: { good: 1, bad: 0 }, [codex]: { good: 0, bad: 1 } });
    // A note without a rating is no marker; a rating is.
    await c.post('/api/feedback', { key: kiro, turn: 0, note: 'just a note' });
    assert.equal(Object.hasOwn((await c.call(`/api/feedback/sessions?keys=${kiro}`)).json.sessions, kiro), false);
    await c.post('/api/feedback', { key: kiro, turn: 0, rating: 'good' });
    const rated = (await c.call(`/api/feedback/sessions?keys=${kiro}`)).json.sessions;
    assert.deepEqual(rated, { [kiro]: { good: 1, bad: 0 } });
    // A key that is not (or no longer) listed is left out, not an error: the list may be older than the index.
    const forged = `claude.${'0'.repeat(32)}`;
    const mixed = await c.call(`/api/feedback/sessions?keys=${claude},${forged},not-a-key`);
    assert.equal(mixed.status, 200);
    assert.deepEqual(Object.keys(mixed.json.sessions), [claude]);
    assert.deepEqual((await c.call('/api/feedback/sessions?keys=')).json.sessions, {});
    // At most 50 keys, each one bounded.
    const many = Array.from({ length: 51 }, (_, i) => `k${i}`).join(',');
    assert.equal((await c.call(`/api/feedback/sessions?keys=${many}`)).status, 400);
    assert.equal((await c.call(`/api/feedback/sessions?keys=${Array(50).fill(claude).join(',')}`)).status, 200);
    assert.equal((await c.call(`/api/feedback/sessions?keys=${'x'.repeat(513)}`)).status, 400);
    assert.equal((await c.call('/api/feedback/sessions')).status, 400, 'keys are required');
    assert.equal((await c.post('/api/feedback/sessions', {})).status, 405);
    assert.equal((await c.call('/api/feedback/nope')).status, 404);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('evals api: demo settings are validated, kept in memory and never reach a file', async () => {
  const data = tmp('zp-evals-api-demo-');
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const first = (await c.call('/api/evals/settings')).json;
    assert.equal(first.judge, true);
    assert.equal(first.provider, 'auto');
    assert.equal(first.dailyCap, 500);
    assert.equal(first.costCapUSD, 1);
    assert.equal(first.externalConfirmed, null);
    assert.equal(first.evaluators.faithfulness, true);
    const ids = first.providers.map((p) => p.id);
    for (const id of ['auto', 'ollama', 'lmstudio', 'openai', 'anthropic']) assert.ok(ids.includes(id), id);
    assert.equal(new Set(ids).size, ids.length, 'no id twice');
    assert.equal(first.providers.find((p) => p.id === 'openai').kind, 'external');
    assert.equal(first.providers.find((p) => p.id === 'ollama').kind, 'local');
    assert.doesNotMatch(JSON.stringify(first), /apiKey|baseUrl|secret|http/i, 'no URL or key in the providers');

    const set = (b) => c.post('/api/evals/settings', b);
    for (const bad of [
      { dailyCap: 0 },
      { dailyCap: 10001 },
      { dailyCap: 1.5 },
      { dailyCap: '5' },
      { costCapUSD: -1 },
      { costCapUSD: 100.5 },
      { costCapUSD: 'x' },
      { provider: 'nope' },
      { provider: 5 },
      { provider: 'x'.repeat(513) },
      { model: 'm'.repeat(201) },
      { model: 5 },
      { judge: 'yes' },
      { evaluators: { nonsense: true } },
      { evaluators: { secret_leak: false } }, // a code evaluator always runs: only a judge can be switched
      { evaluators: { faithfulness: 'on' } },
      { evaluators: [] },
      { externalConfirmed: 'openai' },
      { surprise: 1 },
    ]) {
      assert.equal((await set(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await c.call('/api/evals/settings')).json.dailyCap, 500, 'nothing was kept from a bad request');
    assert.equal((await set([1])).status, 400);
    assert.equal((await c.call('/api/evals/settings', { method: 'POST', raw: '{}' })).status, 415);
    assert.equal((await c.call('/api/evals/settings', { method: 'PUT', extra: JSON_HEADERS })).status, 405);

    const ok = await set({
      dailyCap: 10000,
      costCapUSD: 0,
      model: 'm'.repeat(200),
      evaluators: { faithfulness: false },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.dailyCap, 10000);
    assert.equal(ok.json.costCapUSD, 0);
    assert.equal(ok.json.evaluators.faithfulness, false);
    assert.equal(ok.json.evaluators.relevance, true);
    assert.equal((await set({ dailyCap: 1, provider: 'openai' })).json.provider, 'openai');
    assert.equal((await c.call('/api/evals/settings')).json.provider, 'openai', 'kept in memory');
    assert.equal(fs.existsSync(path.join(data, 'config.json')), false, 'demo never writes config.json');
    assert.equal(fs.existsSync(path.join(data, '.data', 'feedback.jsonl')), false, 'nor a feedback file');
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

// A Claude log with a key in the last prompt and in each answer; the key is built here from parts, so no
// secret-shaped literal sits in the source.
const FIXTURE_DAY = '2026-10-20';
const recentDay = () => new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
const FAKE_KEY = 'sk-' + 'ant-api03-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL';
function writeClaudeLog(home, { key = FAKE_KEY, turns = 2, idle = false } = {}) {
  const dir = path.join(home, '.claude', 'projects', '-w-p');
  fs.mkdirSync(dir, { recursive: true });
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj', 's1.jsonl'), 'utf8');
  // The fixture is dated; the sessions list keeps the last days only, so its day becomes yesterday.
  const withKey = raw
    .replaceAll(FIXTURE_DAY, recentDay())
    .replace('now run the tests', `now run the tests with ${key}`)
    .replace('Changed the redirect.', `Changed the redirect. The key was ${key}`)
    .replace('Done.', `Done. The key was ${key}`);
  // The fixture's first turn is its first four lines. An idle session was last written long ago.
  const text = turns === 1 ? withKey.split('\n').slice(0, 4).join('\n') + '\n' : withKey;
  const file = path.join(dir, 's1.jsonl');
  fs.writeFileSync(file, text);
  if (idle) fs.utimesSync(file, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  return file;
}
const extoneConfig = () =>
  JSON.stringify({ evals: { provider: 'extone' }, gateway: { providers: [external('extone')] } });
const external = (id) => ({
  id,
  preset: 'custom',
  baseUrl: 'http://127.0.0.1:9',
  models: ['m1'],
  enabled: true,
  tier: 'external',
  approved: true,
});

test('evals api: sign-in gate, settings file, and the preview that confirms an external provider', async () => {
  const data = tmp('zp-evals-api-real-');
  writeClaudeLog(data);
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({ userName: 'Kept', gateway: { providers: [external('extone'), external('exttwo')] } }),
  );
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'evals', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 }).secret;
  gw.flush();
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  const anon = client(s.base);
  try {
    // No cookie: every route is refused, and a gateway API key is not a dashboard sign-in.
    const bearer = client(s.base, { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey });
    for (const who of [anon, bearer]) {
      const reads = ['/api/evals?key=x', '/api/evals/summary', '/api/evals/status', '/api/evals/settings'];
      for (const p of [...reads, '/api/feedback?key=x']) assert.equal((await who.call(p)).status, 401, p);
      for (const p of ['/api/evals/run', '/api/feedback', '/api/evals/settings', '/api/evals/preview']) {
        assert.equal((await who.post(p, { key: 'x', provider: 'extone' })).status, 401, p);
      }
    }
    assert.deepEqual((await bearer.call('/api/evals/status')).json, { error: 'sign in first' });

    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
    const c = client(s.base, { cookie });

    let key;
    for (let i = 0; i < 60 && !key; i++) {
      const row = (await c.call('/api/trace/sessions')).json.sessions.find((r) => r.source === 'claude');
      if (row) key = row.key;
      else await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(key, 'the Claude log is listed');

    // Real code results come from the index; no judge ran, so every row is a code evaluator.
    const res = (await c.call(`/api/evals?key=${key}`)).json.results;
    assert.ok(res.length > 0);
    assert.ok(res.every((r) => r.kind === 'code' && r.explanation === null && r.judge === null));
    assert.equal((await c.call('/api/evals/summary?range=30')).status, 200);
    const status = (await c.call('/api/evals/status')).json;
    assert.equal(typeof status.queue, 'number');
    assert.equal(status.judge.waiting, true, 'no local model is reachable, so it waits');

    // Settings: stored under "evals" in config.json, the rest of the file untouched.
    const set = (b) => c.post('/api/evals/settings', b);
    assert.equal((await set({ provider: 'extone', model: 'm1', dailyCap: 50 })).status, 200);
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(stored.userName, 'Kept');
    assert.equal(stored.gateway.providers.length, 2);
    assert.deepEqual(stored.evals, { provider: 'extone', model: 'm1', dailyCap: 50 }, 'only what was set');
    assert.equal((await c.call('/api/evals/settings')).json.providers.find((p) => p.id === 'extone').kind, 'external');

    // Preview refusals.
    // The prompt text has colons and backslashes that look like a Windows path to the scan, so a preview is checked
    // for this machine's folders instead of by the general scan.
    const preview = async (b) => {
      const r = await c.post('/api/evals/preview', b);
      c.bodies.pop();
      assert.ok(!r.text.includes(data) && !/\.claude|\.data/.test(r.text), 'no folder of this machine in a preview');
      return r;
    };
    assert.equal((await preview({ key })).status, 400, 'provider required');
    assert.equal((await preview({ key, provider: 'auto' })).status, 400, 'local kinds need no preview');
    assert.equal((await preview({ key, provider: 'ollama' })).status, 400);
    assert.equal((await preview({ key, provider: 'unknown' })).status, 400, 'not a gateway provider');
    assert.equal((await preview({ provider: 'extone' })).status, 400, 'key required');
    assert.equal((await preview({ key: 'claude.' + '0'.repeat(32), provider: 'extone' })).status, 404);
    assert.equal((await c.call('/api/evals/preview')).status, 405);
    assert.equal((await c.call('/api/evals/preview', { method: 'POST', raw: '{}' })).status, 415);
    assert.equal((await c.call('/api/evals/settings')).json.externalConfirmed, null, 'a refusal confirms nothing');

    // The preview: the exact masked text, then the provider is confirmed.
    const p = await preview({ key, provider: 'extone' });
    assert.equal(p.status, 200);
    assert.equal(p.json.evaluator, 'faithfulness');
    assert.equal(p.json.turn, 0, 'the log was just written: the last turn may still be running, so the first is shown');
    assert.match(p.json.system, /Answer with JSON only, matching this schema: \{/, 'the system text an external gets');
    assert.match(p.json.user, /Changed the redirect\. The key was/);
    assert.doesNotMatch(p.text, /ant-api03|abcdefghijklmnop/, 'the key is masked');
    assert.equal((await c.call('/api/evals/settings')).json.externalConfirmed, 'extone');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).evals.externalConfirmed, 'extone');

    // The same provider again keeps it; another one clears it and asks for a new preview.
    assert.equal((await set({ provider: 'extone', dailyCap: 60 })).json.externalConfirmed, 'extone');
    assert.equal((await set({ dailyCap: 61 })).json.externalConfirmed, 'extone', 'no provider in the request');
    assert.equal((await preview({ key, provider: 'exttwo' })).status, 400, 'only the selected provider is previewed');
    assert.equal((await c.call('/api/evals/settings')).json.externalConfirmed, 'extone');
    assert.equal((await set({ provider: 'exttwo' })).json.externalConfirmed, null);
    assert.equal((await set({ provider: 'extone' })).json.externalConfirmed, null, 'going back needs a preview too');
    assert.equal((await set({ provider: 'exttwo' })).status, 200);
    assert.equal((await preview({ key, provider: 'exttwo' })).status, 200);
    assert.equal((await c.call('/api/evals/settings')).json.externalConfirmed, 'exttwo');
    assert.equal((await set({ provider: 'ollama' })).json.externalConfirmed, null, 'a local choice clears it too');
    assert.equal((await set({ provider: 'extone' })).status, 200);

    // The first enabled turn evaluator is the one shown.
    assert.equal((await set({ evaluators: { faithfulness: false } })).status, 200);
    assert.equal((await preview({ key, provider: 'extone' })).json.evaluator, 'task_completion');
    const turnJudges = ['faithfulness', 'task_completion', 'tool_selection', 'relevance'];
    const off = Object.fromEntries(turnJudges.map((id) => [id, false]));
    assert.equal((await set({ evaluators: off })).status, 200);
    assert.equal((await preview({ key, provider: 'extone' })).status, 400, 'no turn evaluator is on');

    // Run: queues the session (nothing judges here; there is no model), and a bad key is refused.
    assert.equal((await c.post('/api/evals/run', { key })).status, 200);
    assert.equal(typeof (await c.post('/api/evals/run', { key })).json.queued, 'number');
    assert.equal((await c.post('/api/evals/run', {})).status, 400);
    assert.equal((await c.post('/api/evals/run', { key: 'nope' })).status, 404);

    // Feedback is stored in the data folder, private.
    assert.equal((await c.post('/api/feedback', { key, turn: 1, rating: 'good', note: 'ok' })).status, 200);
    const fb = path.join(data, '.data', 'feedback.jsonl');
    assert.ok(fs.existsSync(fb));
    if (process.platform !== 'win32') assert.equal(fs.statSync(fb).mode & 0o077, 0, 'private file');
    assert.doesNotMatch(fs.readFileSync(fb, 'utf8'), /sk-ant|ant-api03/);

    for (const who of [c, anon, bearer]) noPaths(who.bodies);
  } finally {
    await s.stop();
  }
});

test('evals api: the preview is refused when content viewing is off, and when a session has no text', async () => {
  const data = tmp('zp-evals-api-off-');
  writeClaudeLog(data);
  const kiroFixture = path.join(__dirname, 'fixtures', 'trace', 'kiro');
  fs.cpSync(kiroFixture, path.join(data, '.kiro', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), extoneConfig());
  const s = await startServer({ ZAAFPULSE_AUTH: 'none', ZAAFPULSE_CONTENT: 'on' }, { data });
  const c = client(s.base);
  try {
    let kiro;
    let claude;
    for (let i = 0; i < 60 && !(kiro && claude); i++) {
      const rows = (await c.call('/api/trace/sessions?range=30')).json.sessions;
      kiro = rows.find((r) => r.source === 'kiro');
      claude = rows.find((r) => r.source === 'claude');
      if (!(kiro && claude)) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(kiro && claude);
    // Kiro keeps no text: nothing to show, nothing confirmed.
    const none = await c.post('/api/evals/preview', { key: kiro.key, provider: 'extone' });
    assert.equal(none.status, 400);
    assert.equal((await c.call('/api/evals/settings')).json.externalConfirmed, null);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }

  const data2 = tmp('zp-evals-api-off2-');
  writeClaudeLog(data2);
  fs.writeFileSync(path.join(data2, 'config.json'), extoneConfig());
  const s2 = await startServer({ ZAAFPULSE_AUTH: 'none', ZAAFPULSE_CONTENT: 'off' }, { data: data2 });
  const c2 = client(s2.base);
  try {
    let key;
    for (let i = 0; i < 60 && !key; i++) {
      const row = (await c2.call('/api/trace/sessions')).json.sessions.find((r) => r.source === 'claude');
      if (row) key = row.key;
      else await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(key);
    const refused = await c2.post('/api/evals/preview', { key, provider: 'extone' });
    assert.equal(refused.status, 403, 'transcript text stays hidden while content viewing is off');
    assert.doesNotMatch(refused.text, /Done\./);
    assert.equal((await c2.call('/api/evals/settings')).json.externalConfirmed, null);
    noPaths(c2.bodies);
  } finally {
    await s2.stop();
  }
});

// A server on a data folder holding one Claude log, signed in to nothing (loopback, no password).
async function previewFor(log, expected) {
  const data = tmp('zp-evals-api-turn-');
  writeClaudeLog(data, log);
  fs.writeFileSync(
    path.join(data, 'config.json'),
    extoneConfig(),
  );
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    let key;
    for (let i = 0; i < 60 && !key; i++) {
      const row = (await c.call('/api/trace/sessions')).json.sessions.find((r) => r.source === 'claude');
      if (row) key = row.key;
      else await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(key, 'the Claude log is listed');
    const p = await c.post('/api/evals/preview', { key, provider: 'extone' });
    c.bodies.pop(); // the prompt text looks like a path to the general scan
    assert.equal(p.status, expected.status);
    if (expected.turn !== undefined) assert.equal(p.json.turn, expected.turn);
    const settings = (await c.call('/api/evals/settings')).json;
    assert.equal(settings.externalConfirmed, expected.status === 200 ? 'extone' : null);
    return p;
  } finally {
    await s.stop();
  }
}

test('evals api: the preview shows the latest finished turn, never one that may still be running', async () => {
  // One turn and just written: it is still running, there is nothing finished to show.
  const none = await previewFor({ turns: 1 }, { status: 400 });
  assert.match(none.json.error, /no finished turn/);
  // Two turns, just written: the first is done (a later one exists), the second may still run.
  await previewFor({ turns: 2 }, { status: 200, turn: 0 });
  // Quiet for an hour: the second is done too.
  await previewFor({ turns: 2, idle: true }, { status: 200, turn: 1 });
  await previewFor({ turns: 1, idle: true }, { status: 200, turn: 0 });
});

// Every non-demo server looks for a local judge model once it has indexed. The tests point that at a port of
// their own; this one proves the settings reach the server, so no test spawn can end up at the real Ollama.
test('evals api: a server probes the judge ports it was given, not the default ones', async () => {
  const seen = [];
  const ollama = await fakeServer({
    'GET /api/tags': (r) => (seen.push(r.path), { body: { models: [{ name: 'qwen3:8b' }] } }),
  });
  const lmstudio = await fakeServer({ 'GET /v1/models': (r) => (seen.push(r.path), { body: { data: [] } }) });
  const s = await startServer({
    ZAAFPULSE_AUTH: 'none',
    ZAAFPULSE_OLLAMA_URL: ollama.url,
    ZAAFPULSE_LMSTUDIO_URL: lmstudio.url,
  });
  const c = client(s.base);
  try {
    // The first index refresh runs a judging pass, which asks Ollama first.
    for (let i = 0; i < 60 && !seen.includes('/api/tags'); i++) await new Promise((r) => setTimeout(r, 200));
    assert.ok(seen.includes('/api/tags'), 'the fake Ollama was asked');
    const st = (await c.call('/api/evals/status')).json;
    assert.equal(st.judge.model, 'qwen3:8b', 'and its answer is what the server uses');
  } finally {
    await s.stop();
    await ollama.close();
    await lmstudio.close();
  }
});

test('evals api: Claude Code is a provider of its own, previewed like an external one', async () => {
  const data = tmp('zp-evals-api-claude-');
  writeClaudeLog(data);
  // A gateway provider that is also called claude-code: the built-in one wins and it is not listed twice.
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({ gateway: { providers: [external('claude-code'), external('extone')] } }),
  );
  const binDir = tmp('zp-evals-api-claude-bin-');
  const log = path.join(binDir, 'runs.jsonl');
  const s = await startServer(
    { ZAAFPULSE_AUTH: 'none', ZAAFPULSE_CONTENT: 'on', ZAAFPULSE_CLAUDE_BIN: fakeClaude(binDir), FAKE_CLAUDE_LOG: log },
    { data },
  );
  const c = client(s.base);
  // The server's own environment decides where Claude Code sends the text.
  const dest = destinationOf({ ...process.env });
  try {
    // Not the selected provider: not looked for until the list is refreshed.
    const before = (await c.call('/api/evals/settings')).json.providers.find((p) => p.id === 'claude-code');
    assert.equal(before.available, null);
    assert.equal(before.checked, false);
    const cur = (await c.call('/api/evals/settings?refresh=1')).json;
    const cc = cur.providers.filter((p) => p.id === 'claude-code');
    assert.deepEqual(cc, [
      {
        id: 'claude-code',
        label: 'Claude Code (your Claude login)',
        kind: 'claude-cli',
        external: true,
        available: true,
        checked: true,
        destination: dest.text,
        confirm: dest.token,
        models: ['haiku', 'sonnet', 'opus'],
      },
    ]);
    assert.equal(cur.providers.find((p) => p.id === 'extone').external, true);

    const set = (b) => c.post('/api/evals/settings', b);
    assert.equal((await set({ provider: 'claude-code', model: 'haiku' })).status, 200);
    let now = (await c.call('/api/evals/settings')).json;
    assert.equal(now.provider, 'claude-code');
    assert.equal(now.externalConfirmed, null);
    const st = (await c.call('/api/evals/status')).json;
    assert.equal(st.judge.kind, 'claude-cli');
    assert.equal(st.judge.reason, 'Confirm the preview before sending to claude-code');

    let key;
    for (let i = 0; i < 60 && !key; i++) {
      const row = (await c.call('/api/trace/sessions')).json.sessions.find((r) => r.source === 'claude');
      if (row) key = row.key;
      else await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(key);
    assert.equal((await c.post('/api/evals/preview', { key, provider: 'extone' })).status, 400, 'not the selected one');
    const p = await c.post('/api/evals/preview', { key, provider: 'claude-code' });
    c.bodies.pop();
    assert.equal(p.status, 200);
    assert.match(p.json.system, /Answer with JSON only, matching this schema: \{/);
    assert.equal(p.json.destination, dest.text, 'the preview says where the text goes');
    assert.doesNotMatch(p.text, /ant-api03|abcdefghijklmnop/, 'the key is masked');
    now = (await c.call('/api/evals/settings')).json;
    assert.equal(now.externalConfirmed, dest.token, 'the confirmation names that destination');
    assert.equal((await c.call('/api/evals/status')).json.judge.destination, dest.text);
    // History is not judged on its own, so the preview alone starts nothing.
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [];
    assert.deepEqual(lines.filter((l) => l && !l.includes('"version"')), []);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }

  // Content off: the preview is refused, and without a claude binary it is listed as not available.
  const data2 = tmp('zp-evals-api-claude-off-');
  writeClaudeLog(data2);
  fs.writeFileSync(path.join(data2, 'config.json'), JSON.stringify({ evals: { provider: 'claude-code' } }));
  const s2 = await startServer({ ZAAFPULSE_AUTH: 'none', ZAAFPULSE_CONTENT: 'off' }, { data: data2 });
  const c2 = client(s2.base);
  try {
    const cur = (await c2.call('/api/evals/settings')).json;
    assert.equal(cur.providers.find((p) => p.id === 'claude-code').available, false);
    const st = (await c2.call('/api/evals/status')).json;
    assert.equal(st.judge.reason, 'Claude Code not found: install it, or set ZAAFPULSE_CLAUDE_BIN');
    let key;
    for (let i = 0; i < 60 && !key; i++) {
      const row = (await c2.call('/api/trace/sessions')).json.sessions.find((r) => r.source === 'claude');
      if (row) key = row.key;
      else await new Promise((r) => setTimeout(r, 250));
    }
    const refused = await c2.post('/api/evals/preview', { key, provider: 'claude-code' });
    assert.equal(refused.status, 403);
    assert.equal((await c2.call('/api/evals/settings')).json.externalConfirmed, null);
    noPaths(c2.bodies);
  } finally {
    await s2.stop();
  }
});

test('evals api: a slow Claude Code search answers "checking" instead of holding the settings', async () => {
  const api = createEvalApi({
    trace: {},
    engine: { kick() {} },
    feedback: {},
    gateway: null,
    settings: { get: () => ({}), save() {} },
    claude: { available: () => new Promise(() => {}), destination: () => destinationOf({}) },
    claudeWaitMs: 50,
  });
  const started = Date.now();
  const r = await api.route({ method: 'GET', path: '/api/evals/settings', query: new URLSearchParams('refresh=1') });
  assert.ok(Date.now() - started < 1000);
  assert.equal(r.status, 200);
  assert.equal(r.body.providers.find((p) => p.id === 'claude-code').available, null);
  // A broken finder is "not found", never an error page.
  const broken = createEvalApi({
    trace: {},
    engine: { kick() {} },
    feedback: {},
    settings: { get: () => ({}), save() {} },
    claude: { available: () => Promise.reject(new Error('boom')), destination: () => destinationOf({}) },
  });
  const b = await broken.route({ method: 'GET', path: '/api/evals/settings', query: new URLSearchParams('refresh=1') });
  assert.equal(b.body.providers.find((p) => p.id === 'claude-code').available, false);
});

test('evals api: Claude Code is looked for only when it is the provider, or when the list is refreshed', async () => {
  let looks = 0;
  let provider = 'auto';
  const api = createEvalApi({
    trace: {},
    engine: { kick() {} },
    feedback: {},
    gateway: null,
    settings: { get: () => ({ provider }), save() {} },
    claude: {
      available: async () => (looks++, true),
      destination: () => destinationOf({}),
    },
  });
  const get = async (q = '') => {
    const r = await api.route({ method: 'GET', path: '/api/evals/settings', query: new URLSearchParams(q) });
    return r.body.providers.find((p) => p.id === 'claude-code');
  };
  assert.deepEqual([(await get()).available, (await get()).checked, looks], [null, false, 0], 'not checked');
  assert.deepEqual([(await get('refresh=1')).available, looks], [true, 1], 'an explicit refresh looks');
  provider = 'claude-code';
  const picked = await get();
  assert.deepEqual([picked.available, picked.checked, looks], [true, true, 2], 'the selected provider is looked for');
});

test('server: SIGHUP (a closed terminal) shuts down the way SIGTERM does', {
  skip: process.platform === 'win32',
}, async () => {
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' });
  try {
    const gone = new Promise((resolve) => s.child.once('exit', (code, signal) => resolve({ code, signal })));
    s.child.kill('SIGHUP');
    assert.deepEqual(await gone, { code: 0, signal: null }, 'its own handler ran: the judge stopped, the log flushed');
  } finally {
    await s.stop();
  }
});

test('test helpers: every spawned server.js that is not a demo gets the closed judge ports', () => {
  // A spawn of server.js outside demo mode would otherwise probe 11434 and 1234 on the machine running the tests.
  for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const spawns = src.split("spawn(process.execPath, [path.join(").slice(1);
    for (const part of spawns) {
      if (!/^[^\]]*server\.js'\)\]/.test(part)) continue;
      const block = part.slice(0, part.indexOf('stdio'));
      assert.ok(/NO_JUDGE_PORTS|ZAAFPULSE_OLLAMA_URL/.test(block) || /DEMO: '1'/.test(block), `${f} spawns server.js`);
    }
  }
});
