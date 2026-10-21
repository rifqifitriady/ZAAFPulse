// The trace explorer over HTTP: /api/trace/* on a spawned server.js. Demo data for the shapes, a real (temp)
// Claude log for the live cursor, and password mode for the sign-in gate. HOME and ZAAFPULSE_DATA are temp
// folders, so the machine's own logs are never read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { secretsFor, NO_JUDGE_PORTS } = require('./helpers');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A wide range above the other server tests' (4800-4999), so parallel files rarely meet.
    const port = 5100 + Math.floor(Math.random() * 800);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
// Starts server.js on a free port of the range; tries again when another test took the port first.
async function startServer(env, { data = tmp('zp-trace-api-'), ports = freePort } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await ports();
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
    // Waits for the process to be gone before its folder is removed. A retry only kills: the folder holds what
    // the test seeded (a log, gateway keys), so it must outlive a lost port race.
    const stop = async () => {
      await kill();
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        // Still ours: a server that lost the port race exits at once.
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

// The retry after a lost port race must not delete what the test seeded in the data folder.
test('startServer: a retry after a taken port keeps the seeded data folder', async () => {
  const data = tmp('zp-trace-api-retry-');
  const seeded = path.join(data, 'seeded.txt');
  fs.writeFileSync(seeded, 'x');
  const taken = net.createServer();
  await new Promise((r) => taken.listen(0, '127.0.0.1', r));
  let calls = 0;
  const ports = async () => (calls++ === 0 ? taken.address().port : freePort());
  try {
    const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' }, { data, ports });
    try {
      assert.ok(calls >= 2, 'the first port was taken, so it tried again');
      assert.ok(fs.existsSync(seeded), 'the seeded file is still there');
    } finally {
      await s.stop();
    }
    assert.equal(fs.existsSync(data), false, 'stop removes the folder');
  } finally {
    taken.close();
  }
});

// A client that keeps every JSON body it receives, so one scan at the end covers all of them.
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
// The span ids of a skeleton that carry text, in order.
const contentIds = (sk) => sk.spans.flatMap((s) => [s.text, s.result]).filter(Boolean);

test('trace api: demo sessions, a session with spans, titles, filters and content', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    assert.deepEqual((await c.call('/api/trace/settings')).json, { content: true });
    const src = await c.call('/api/trace/sources');
    assert.equal(src.status, 200);
    assert.deepEqual(
      src.json.map((x) => x.id),
      ['claude', 'codex', 'gateway', 'kiro', 'gemini', 'antigravity'],
    );
    assert.equal(src.json.find((x) => x.id === 'claude').ok, true);

    const list = await c.call('/api/trace/sessions');
    assert.equal(list.status, 200);
    const rows = list.json.sessions;
    assert.ok(rows.length >= 3);
    for (const r of rows) assert.match(r.key, /^[a-z]+\.[0-9a-f]{32}$/);
    const claude = rows.find((r) => r.source === 'claude');
    assert.equal(claude.title, 'fix auth redirect');
    assert.equal(Object.hasOwn(claude, 'file'), false, 'no file in a row');

    // Filters: source, text, errors, and a range that is clamped to 1..30 days.
    const only = (qs) => c.call(`/api/trace/sessions?${qs}`).then((r) => r.json.sessions);
    assert.deepEqual((await only('source=codex')).map((r) => r.source), ['codex']);
    assert.deepEqual((await only('q=pagination')).map((r) => r.source), ['codex']);
    assert.deepEqual((await only('flags=errors')).map((r) => r.source), ['claude']);
    assert.equal((await only('range=30')).length, 3);
    assert.deepEqual((await only('range=0')).map((r) => r.source).sort(), ['claude', 'codex'], '0 is clamped to 1 day');
    assert.equal((await only('range=9999')).length, 3, 'and a big one to 30 days');

    const title = await c.call(`/api/trace/title?key=${claude.key}`);
    assert.deepEqual(title.json, { title: 'fix auth redirect' });

    const sk = await c.call(`/api/trace/session?key=${claude.key}`);
    assert.equal(sk.status, 200);
    assert.ok(sk.json.spans.length > 5);
    assert.ok(sk.json.turns.length >= 1);
    assert.equal((await c.call(`/api/trace/session?key=${claude.key}&turn=0`)).status, 200);
    assert.equal((await c.call(`/api/trace/session?key=${claude.key}&turn=abc`)).status, 400);
    assert.equal((await c.call(`/api/trace/session?key=${claude.key}&turn=-1`)).status, 400);

    // Content: text for a span, paged by offset, nothing but an opaque id going in.
    const prompt = sk.json.spans.find((x) => x.kind === 'turn');
    const body = await c.call(`/api/trace/content?id=${prompt.text}`);
    assert.equal(body.status, 200);
    assert.match(body.json.text, /fix auth redirect/);
    assert.equal((await c.call(`/api/trace/content?id=${prompt.text}&offset=5`)).json.offset, 5);
    assert.equal((await c.call(`/api/trace/content?id=${prompt.text}&offset=x`)).status, 400);
    assert.equal((await c.call('/api/trace/content')).status, 400);
    assert.equal((await c.call('/api/trace/content?id=ci_0123456789abcdef')).status, 404);
    assert.equal((await c.call('/api/trace/content?id=../../etc/passwd')).status, 404);

    // Live: demo sessions never grow.
    assert.deepEqual((await c.call(`/api/trace/live?key=${claude.key}`)).json, { changed: false });

    // Find: links from other pages know a session id, not its key.
    const found = await c.call('/api/trace/find?source=claude&sid=demo-claude-1');
    assert.equal(found.status, 200);
    assert.deepEqual(found.json, { key: claude.key });
    assert.equal((await c.call('/api/trace/find?source=codex&sid=demo-claude-1')).status, 404);
    assert.equal((await c.call('/api/trace/find?source=claude&sid=nope')).json.error, 'unknown session');
    assert.equal((await c.call('/api/trace/find?source=claude')).status, 400);
    assert.equal((await c.call('/api/trace/find?sid=demo-claude-1')).status, 400);
    assert.equal((await c.call(`/api/trace/find?source=claude&sid=${'x'.repeat(513)}`)).status, 400);
    assert.equal((await c.call(`/api/trace/find?source=${'x'.repeat(513)}&sid=a`)).status, 400);
    assert.equal((await c.call('/api/trace/find', { method: 'POST', body: {}, extra: JSON_HEADERS })).status, 405);

    // A long filter or cursor is refused, not passed on.
    const long = 'x'.repeat(513);
    for (const p of [`sessions?q=${long}`, `sessions?flags=${long}`, `live?key=${claude.key}&cursor=${long}`])
      assert.equal((await c.call(`/api/trace/${p}`)).status, 400, p.slice(0, 20));
    assert.equal((await c.call(`/api/trace/sessions?q=${'x'.repeat(512)}`)).status, 200);

    // Wrong method and unknown route.
    assert.equal((await c.call('/api/trace/sessions', { method: 'POST', body: {}, extra: JSON_HEADERS })).status, 405);
    assert.equal((await c.call('/api/trace/nope')).status, 404);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('trace api: a forged or missing key is refused', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const forged = `claude.${'0'.repeat(32)}`;
    for (const route of ['session', 'title', 'live']) {
      assert.equal((await c.call(`/api/trace/${route}?key=${forged}`)).status, 404, route);
      assert.equal((await c.call(`/api/trace/${route}?key=not-a-key`)).status, 404, route);
      assert.equal((await c.call(`/api/trace/${route}?key=${encodeURIComponent('/etc/passwd')}`)).status, 404, route);
      assert.equal((await c.call(`/api/trace/${route}`)).status, 400, route);
    }
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('trace api: reveal needs JSON, and returns the one masked value that was asked for', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    const claude = (await c.call('/api/trace/sessions')).json.sessions.find((r) => r.source === 'claude');
    const sk = (await c.call(`/api/trace/session?key=${claude.key}`)).json;
    // The failing test run printed an API key (built at runtime from parts in the demo data): masked.
    let hit;
    for (const id of contentIds(sk)) {
      const r = await c.call(`/api/trace/content?id=${id}`);
      if (r.json.masked.length) hit = { id, page: r.json };
    }
    assert.ok(hit, 'a demo item holds a masked secret');
    assert.doesNotMatch(hit.page.text, /api03/, 'the page shows the mark, not the value');

    const plain = await c.call('/api/trace/reveal', {
      method: 'POST',
      raw: JSON.stringify({ id: hit.id, index: 0 }),
      extra: { 'content-type': 'text/plain' },
    });
    assert.equal(plain.status, 415, 'a simple cross-site POST is refused');
    assert.equal((await c.call('/api/trace/reveal', { method: 'POST', raw: '{"id":"x"}' })).status, 415);

    const shown = await c.post('/api/trace/reveal', { id: hit.id, index: 0 });
    assert.equal(shown.status, 200);
    assert.match(shown.json.value, /^sk-ant-api03-[a-z0-9]{48}$/);
    assert.equal((await c.post('/api/trace/reveal', { id: hit.id, index: 9 })).status, 404);
    assert.equal((await c.post('/api/trace/reveal', { id: hit.id })).status, 400, 'no index');
    assert.equal((await c.post('/api/trace/reveal', { id: hit.id, index: 'x' })).status, 400);
    assert.equal((await c.post('/api/trace/reveal', { id: 'ci_0123456789abcdef', index: 0 })).status, 404);
    assert.equal((await c.post('/api/trace/reveal', {})).status, 400);
    const broken = await c.call('/api/trace/reveal', { method: 'POST', raw: '{nope', extra: JSON_HEADERS });
    assert.equal(broken.status, 400);
    assert.equal((await c.call('/api/trace/reveal')).status, 405, 'GET is not a reveal');
    // Only the revealed value may hold a path-free secret; scan the rest of what was received.
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

test('trace api: with ZAAFPULSE_CONTENT=off content is refused and titles are hidden', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none', ZAAFPULSE_CONTENT: 'off' });
  const c = client(s.base);
  try {
    // The page learns it up front (S10), before any text is asked for.
    assert.deepEqual((await c.call('/api/trace/settings')).json, { content: false });
    const rows = (await c.call('/api/trace/sessions')).json.sessions;
    for (const src of ['claude', 'codex', 'kiro']) {
      const row = rows.find((r) => r.source === src);
      assert.ok(row, src);
      assert.equal(row.title, null, `${src} title is content`);
    }
    assert.deepEqual((await c.call(`/api/trace/title?key=${rows[0].key}`)).json, { title: null });
    // The structure stays: spans, but no text can be opened.
    const sk = await c.call(`/api/trace/session?key=${rows.find((r) => r.source === 'claude').key}`);
    assert.equal(sk.status, 200);
    const id = contentIds(sk.json)[0];
    const content = await c.call(`/api/trace/content?id=${id}`);
    assert.equal(content.status, 403);
    assert.equal((await c.post('/api/trace/reveal', { id, index: 0 })).status, 403);
    // The search does not see titles either.
    assert.equal((await c.call('/api/trace/sessions?q=auth%20redirect')).json.sessions.length, 0);
    noPaths(c.bodies);
  } finally {
    await s.stop();
  }
});

// A Claude log on disk for the real (non-demo) path: the same file the adapter tests use.
function writeClaudeLog(home) {
  const dir = path.join(home, '.claude', 'projects', '-w-p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's1.jsonl');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj', 's1.jsonl'), file);
  return file;
}
const turnLine = (n) =>
  JSON.stringify({
    type: 'user',
    sessionId: 's1',
    uuid: `u-extra-${n}`,
    timestamp: '2026-10-20T10:10:00.000Z',
    message: { role: 'user', content: `one more thing ${n}` },
  }) + '\n';

test('trace api: sign-in gate, gateway keys refused, and the live cursor round-trips on a real log', async () => {
  const data = tmp('zp-trace-api-pw-');
  const file = writeClaudeLog(data);
  // A real gateway API key, made in the data folder the server is about to use.
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'trace', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 }).secret;
  gw.flush();
  // Password mode on loopback, so nothing listens beyond this machine; the sign-in gate is the same one
  // server mode uses.
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  const anon = client(s.base);
  try {
    for (const p of ['sources', 'sessions', 'session?key=x', 'title?key=x', 'content?id=x', 'live?key=x']) {
      assert.equal((await anon.call(`/api/trace/${p}`)).status, 401, p);
    }
    assert.equal((await anon.post('/api/trace/reveal', { id: 'x', index: 0 })).status, 401);
    const bearer = client(s.base, { authorization: `Bearer ${apiKey}` });
    const viaKey = await bearer.call('/api/trace/sessions');
    assert.equal(viaKey.status, 401, 'a gateway key is not a dashboard sign-in');
    assert.deepEqual(viaKey.json, { error: 'sign in first' });
    assert.equal((await bearer.call('/api/trace/sources', { extra: { 'x-api-key': apiKey } })).status, 401);

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

    // The indexer scans at start-up: wait for the session to be listed.
    let row;
    for (let i = 0; i < 60 && !row; i++) {
      row = (await c.call('/api/trace/sessions')).json.sessions.find((r) => r.source === 'claude');
      if (!row) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(row, 'the Claude log is listed');
    assert.equal(row.project, 'p', 'a folder name, not a path');
    assert.equal(row.turns, 2);

    const sk = await c.call(`/api/trace/session?key=${row.key}&turn=0`);
    assert.equal(sk.status, 200);
    const prompt = sk.json.spans.find((x) => x.kind === 'turn');
    assert.match((await c.call(`/api/trace/content?id=${prompt.text}`)).json.text, /fix the login redirect/);

    // Live: no cursor means "from the beginning"; the cursor it hands back says "nothing new" until the
    // file grows; another session's cursor means nothing.
    const first = await c.call(`/api/trace/live?key=${row.key}`);
    assert.equal(first.json.changed, true);
    assert.equal(typeof first.json.cursor, 'string');
    assert.ok(first.json.skeleton.spans.length > 0);
    const same = await c.call(`/api/trace/live?key=${row.key}&cursor=${encodeURIComponent(first.json.cursor)}`);
    assert.equal(same.json.changed, false);
    assert.equal(typeof same.json.cursor, 'string');
    fs.appendFileSync(file, turnLine(1));
    const grown = await c.call(`/api/trace/live?key=${row.key}&cursor=${encodeURIComponent(first.json.cursor)}`);
    assert.equal(grown.json.changed, true, 'the file grew');
    const after = await c.call(`/api/trace/live?key=${row.key}&cursor=${encodeURIComponent(grown.json.cursor)}`);
    assert.equal(after.json.changed, false);
    const junk = await c.call(`/api/trace/live?key=${row.key}&cursor=${'A'.repeat(40)}`);
    assert.equal(junk.json.changed, true, 'a damaged cursor reads from the beginning');
    noPaths(c.bodies);
    noPaths(anon.bodies);
    noPaths(bearer.bodies);
  } finally {
    await s.stop();
  }
});

// The gateway's /mcp answers any key with the mcp scope, so no transcript-derived title may come out of it, even
// where the dashboard itself shows one (loopback, content on).
test('gateway /mcp: acc_trace_sessions never returns a Kiro title, while the dashboard does', async () => {
  const data = tmp('zp-trace-api-mcp-');
  fs.cpSync(path.join(__dirname, 'fixtures', 'trace', 'kiro'), path.join(data, '.kiro', 'sessions'), { recursive: true });
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'mcp', scopes: ['mcp'], rpm: 60 }).secret;
  gw.flush();
  const s = await startServer({ ZAAFPULSE_AUTH: 'none', ZAAFPULSE_CONTENT: 'on' }, { data });
  try {
    const dash = (await client(s.base).call('/api/trace/sessions?range=30')).json.sessions;
    const kiro = dash.filter((r) => r.source === 'kiro');
    assert.deepEqual(kiro.map((r) => r.title).sort(), ['Add dark mode', 'Fix the login redirect'], 'the dashboard shows titles');

    const mcp = client(s.base, { authorization: `Bearer ${apiKey}` });
    const reply = await mcp.post('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'acc_trace_sessions', arguments: { range: 'all' } },
    });
    assert.equal(reply.status, 200);
    const rows = JSON.parse(reply.json.result.content[0].text);
    assert.equal(rows.filter((r) => r.source === 'kiro').length, 2, 'the Kiro sessions are listed');
    for (const r of rows) assert.equal(r.title, null, `${r.source} title`);
    assert.doesNotMatch(reply.text, /dark mode|login redirect/i);
    noPaths(mcp.bodies);
  } finally {
    await s.stop();
  }
});

// acc_evals holds ids and labels only, so the gateway's /mcp answers it as it does the stdio server: the rates and the
// failures, never the explanation a judge wrote about the transcript.
test('gateway /mcp: acc_evals returns labels and keys, never an explanation', async () => {
  const data = tmp('zp-trace-api-evals-');
  const proj = path.join(data, '.claude', 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj', 's1.jsonl'), path.join(proj, 's1.jsonl'));
  const { createEvalStore } = require('../lib/evals/store');
  createEvalStore({ file: path.join(data, '.data', 'evals.jsonl') }).put({
    target: { source: 'claude', session: 's1', turn: 0, span: null },
    evaluator: 'faithfulness',
    version: 1,
    kind: 'judge',
    label: 'unfaithful',
    score: 0,
    explanation: 'EXPLANATION-SENTINEL it claims a test that never ran',
    judge: { kind: 'ollama', model: 'qwen3:8b', provider: 'ollama' },
    ts: Date.now(),
  });
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const apiKey = gw.keys.create({ name: 'mcp', scopes: ['mcp'], rpm: 60 }).secret;
  gw.flush();
  const s = await startServer({ ZAAFPULSE_AUTH: 'none', ZAAFPULSE_CONTENT: 'on' }, { data });
  try {
    const mcp = client(s.base, { authorization: `Bearer ${apiKey}` });
    const reply = await mcp.post('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'acc_evals', arguments: { range: 'all' } },
    });
    assert.equal(reply.status, 200);
    const out = JSON.parse(reply.json.result.content[0].text);
    assert.deepEqual(
      out.failures.map((f) => [f.source, f.turn, f.evaluator, f.label]),
      [['claude', 0, 'faithfulness', 'unfaithful']],
    );
    assert.equal(out.evaluators.find((e) => e.id === 'faithfulness').total, 1);
    assert.doesNotMatch(reply.text, /EXPLANATION-SENTINEL|never ran|explanation|fix the login/i);
    noPaths(mcp.bodies);
  } finally {
    await s.stop();
  }
});
