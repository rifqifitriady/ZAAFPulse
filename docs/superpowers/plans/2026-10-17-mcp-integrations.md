# MCP Integrations Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI Command Center a zero-dependency MCP server (`node mcp.js`) that exposes the dashboard's own data and connectors to Dynatrace, Arize, n8n, OmniRoute/9router, generic HTTP APIs (AION) and upstream MCP servers, plus an Integrations page in the dashboard.

**Architecture:** `mcp.js` speaks newline-delimited JSON-RPC 2.0 over stdio (`lib/mcp/protocol.js`). `lib/integrations.js` builds one connector per `config.integrations` entry (`lib/connectors/*.js`), prefixes their tools, enforces `allowWrite`, validates arguments, caps results and writes an audit line per call (`lib/audit.js`). `server.js` builds the same integrations to show status, client registration and the audit tail on a new Integrations page.

**Tech Stack:** Node 18+ standard library only (`fetch`, `http`, `readline`, `child_process`, `node:test`). Plain browser JS in `public/`.

Spec: `docs/superpowers/specs/2026-10-17-mcp-integrations-design.md`

## Global Constraints

- Runtime dependencies: **0**. Do not add anything to `package.json` `dependencies` or `devDependencies`.
- Node **>= 18**; CommonJS (`require`), `'use strict'` only in `public/*.js` (matching the existing files).
- Secrets are references only: `{ "env": "NAME" }` or `{ "keychain": "service" }`. A plain string in a secret field is an error.
- Integration id: `^[a-z0-9-]{1,32}$`. Full tool name: `^[a-zA-Z0-9_-]{1,64}$`. Separator `_`, except type `mcp` which uses `__`.
- Outbound timeout **15 s** (DQL total **60 s**, MCP proxy **30 s**). Result cap **50 KB**. Error bodies cut to **300** characters, masked.
- Health results cached **60 s** per integration. MCP proxy tool list cached **5 min**. Audit file rotates at **5 MB**.
- Write tools exist only with `allowWrite: true`, and carry `readOnlyHint: false`.
- `mcp.js` writes nothing but protocol messages to stdout; diagnostics go to stderr.
- Dashboard server keeps listening on `127.0.0.1` with the existing host-header check.
- Comment style: short `//` comments explaining why, like the existing `lib/*.js`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `package.json` | modify | add `test`, `mcp`, `mcp:register` scripts |
| `lib/secrets.js` | create | resolve secret references, mask resolved values |
| `lib/mcp/protocol.js` | create | stdio JSON-RPC server for MCP |
| `lib/connectors/base.js` | create | HTTP client, auth headers, tool/schema helpers, health timer |
| `lib/audit.js` | create | append and tail `.cache/mcp-audit.jsonl` |
| `lib/integrations.js` | create | build connectors, prefix, filter, validate, cap, audit, status |
| `lib/local.js` | create | dashboard data for the `acc` connector |
| `lib/connectors/acc.js` | create | `acc_*` tools |
| `mcp.js` | create | stdio entry point |
| `lib/connectors/dynatrace.js` | create | Dynatrace API v2 + DQL |
| `lib/connectors/arize.js` | create | Arize AX /v2 and Phoenix /v1 |
| `lib/connectors/n8n.js` | create | n8n REST + allowlisted webhooks |
| `lib/connectors/router.js` | create | OmniRoute and 9router |
| `lib/connectors/http.js` | create | generic endpoints from config |
| `lib/mcp/client.js` | create | Streamable HTTP MCP client |
| `lib/connectors/mcp-proxy.js` | create | upstream MCP tools under a prefix |
| `scripts/register-mcp.js` | create | register in Claude Code, Kiro, Antigravity |
| `lib/processes.js` | modify | detect Kiro |
| `server.js` | modify | keep `integrations` in config, `/api/integrations`, `/api/integrations/test` |
| `lib/demo.js` | modify | demo integrations payload |
| `public/integrations.js` | create | Integrations page |
| `public/app.js`, `public/index.html`, `public/styles.css` | modify | route, nav, icon, Kiro meta, styles |
| `config.example.json`, `docs/integrations.md`, `README.md` | create/modify | documentation |
| `test/helpers.js` and `test/*.test.js` | create | tests |

---

### Task 1: Test runner and secrets

**Files:**
- Modify: `package.json`
- Create: `lib/secrets.js`, `test/helpers.js`, `test/secrets.test.js`

**Interfaces:**
- Produces: `createSecrets({ env?, exec? }) → { resolve(ref, field?) → string|null, mask(text) → string }`; `isRef(v) → boolean`; test helpers `fakeServer(routes) → Promise<{ url, requests, close() }>` and `secretsFor(envMap) → secrets`.

- [ ] **Step 1: Add scripts to package.json**

Replace the `scripts` block with:

```json
  "scripts": {
    "start": "node server.js",
    "demo": "DEMO=1 PORT=4778 node server.js",
    "mcp": "node mcp.js",
    "mcp:register": "node scripts/register-mcp.js",
    "test": "node --test test/*.test.js"
  },
```

- [ ] **Step 2: Write test helpers** (`test/helpers.js`)

```js
// Shared test helpers: a fake HTTP server that records requests, and secrets without Keychain.
const http = require('http');
const { createSecrets } = require('../lib/secrets');

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

// routes: { 'GET /path': { status?, body?, headers? } | (req) => same | Promise<same> }
async function fakeServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const r = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body ? safeJson(body) : null };
      requests.push(r);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"no route"}'); }
      const out = (await (typeof handler === 'function' ? handler(r) : handler)) || {};
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

const secretsFor = (env = {}) => createSecrets({ env, exec: () => { throw new Error('no keychain in tests'); } });

module.exports = { fakeServer, secretsFor };
```

- [ ] **Step 3: Write the failing test** (`test/secrets.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecrets, isRef } = require('../lib/secrets');

test('resolves env references', () => {
  const s = createSecrets({ env: { DT: 'dt0c01.abcdef' } });
  assert.equal(s.resolve({ env: 'DT' }, 'token'), 'dt0c01.abcdef');
});

test('resolves keychain references through the security tool', () => {
  const calls = [];
  const s = createSecrets({ env: {}, exec: (cmd, args) => { calls.push([cmd, ...args]); return 'kc-secret-value\n'; } });
  assert.equal(s.resolve({ keychain: 'acc.x' }), 'kc-secret-value');
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'acc.x', '-w']);
});

test('rejects plain-text secrets', () => {
  assert.throws(() => createSecrets({ env: {} }).resolve('abc', 'apiKey'), /apiKey: plain-text secrets are not allowed/);
});

test('reports missing env variables and keychain items', () => {
  const s = createSecrets({ env: {}, exec: () => { throw new Error('exit 44'); } });
  assert.throws(() => s.resolve({ env: 'NOPE' }), /NOPE is not set/);
  assert.throws(() => s.resolve({ keychain: 'acc.none' }), /"acc.none" not found/);
});

test('an absent reference means not configured', () => {
  assert.equal(createSecrets({ env: {} }).resolve(undefined), null);
});

test('masks every resolved value', () => {
  const s = createSecrets({ env: { K: 'super-secret-123' } });
  s.resolve({ env: 'K' });
  assert.equal(s.mask('401: bad key super-secret-123 here'), '401: bad key *** here');
});

test('isRef recognises references only', () => {
  assert.equal(isRef({ env: 'A' }), true);
  assert.equal(isRef({ keychain: 'a' }), true);
  assert.equal(isRef('a'), false);
  assert.equal(isRef({ value: 'a' }), false);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/secrets'`

- [ ] **Step 5: Implement** (`lib/secrets.js`)

```js
// Resolves secret references from config.json. Secrets never live in the file itself: a field
// holds { env: 'NAME' } or { keychain: 'service' } and is looked up when a connector is built.
// Every resolved value is remembered so error messages can be masked before anyone sees them.
const { execFileSync } = require('child_process');

function isRef(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (typeof v.env === 'string' || typeof v.keychain === 'string');
}

function createSecrets({ env = process.env, exec = execFileSync } = {}) {
  const known = new Set();

  function resolve(ref, field = 'secret') {
    if (ref == null) return null;
    if (typeof ref === 'string') throw new Error(`${field}: plain-text secrets are not allowed in config.json; use { "env": "NAME" } or { "keychain": "service" } (see docs/integrations.md)`);
    if (!isRef(ref)) throw new Error(`${field}: expected { "env": "NAME" } or { "keychain": "service" }`);
    let value = '';
    if (ref.env) {
      value = env[ref.env] || '';
      if (!value) throw new Error(`${field}: environment variable ${ref.env} is not set`);
    } else {
      try { value = String(exec('security', ['find-generic-password', '-s', ref.keychain, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); } catch { value = ''; }
      if (!value) throw new Error(`${field}: Keychain item "${ref.keychain}" not found`);
    }
    if (value.length >= 6) known.add(value);
    return value;
  }

  function mask(text) {
    let s = String(text ?? '');
    for (const v of known) s = s.split(v).join('***');
    return s;
  }

  return { resolve, mask };
}

module.exports = { createSecrets, isRef };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 7 tests

- [ ] **Step 7: Commit**

```bash
git add package.json lib/secrets.js test/helpers.js test/secrets.test.js
git commit -m "Add secret references and test runner"
```

---

### Task 2: MCP stdio protocol

**Files:**
- Create: `lib/mcp/protocol.js`, `test/protocol.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createServer({ name, version, instructions?, listTools: async () => Tool[], callTool: async (name, args) => { result } | { error: { code, message } }, log? }) → { handle(msg), handleLine(line) → Promise<string|null>, serve(input?, output?) → Promise<void> }`; `SUPPORTED_VERSIONS`.

- [ ] **Step 1: Write the failing test** (`test/protocol.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { createServer } = require('../lib/mcp/protocol');

const server = () => createServer({
  name: 'acc', version: '1.0.0',
  listTools: async () => [{ name: 'acc_x', description: 'x', inputSchema: { type: 'object' } }],
  callTool: async (name, args) => (name === 'acc_x'
    ? { result: { content: [{ type: 'text', text: JSON.stringify(args) }] } }
    : { error: { code: -32602, message: `Unknown tool: ${name}` } }),
});
const ask = async (s, msg) => { const out = await s.handleLine(JSON.stringify(msg)); return out && JSON.parse(out); };
const init = (v) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '0' } } });

test('initialize echoes a supported protocol version', async () => {
  const r = await ask(server(), init('2025-03-26'));
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.serverInfo, { name: 'acc', version: '1.0.0' });
  assert.ok(r.result.capabilities.tools);
});

test('initialize offers the newest version for an unknown one', async () => {
  const r = await ask(server(), init('1999-01-01'));
  assert.equal(r.result.protocolVersion, '2025-06-18');
});

test('tools/list and tools/call', async () => {
  const s = server();
  const list = await ask(s, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools[0].name, 'acc_x');
  const call = await ask(s, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acc_x', arguments: { a: 1 } } });
  assert.equal(call.result.content[0].text, '{"a":1}');
});

test('unknown tool is a JSON-RPC error', async () => {
  const r = await ask(server(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(r.error.code, -32602);
});

test('unknown method', async () => {
  const r = await ask(server(), { jsonrpc: '2.0', id: 5, method: 'resources/list' });
  assert.equal(r.error.code, -32601);
});

test('notifications get no reply', async () => {
  assert.equal(await server().handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
});

test('malformed JSON is a parse error', async () => {
  const r = JSON.parse(await server().handleLine('{not json'));
  assert.deepEqual(r, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
});

test('serve answers every line before it resolves', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = '';
  output.on('data', (c) => { text += c; });
  const done = server().serve(input, output);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
  input.end();
  await done;
  assert.deepEqual(JSON.parse(text.trim()), { jsonrpc: '2.0', id: 7, result: {} });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/mcp/protocol'`

- [ ] **Step 3: Implement** (`lib/mcp/protocol.js`)

```js
// MCP over stdio: newline-delimited JSON-RPC 2.0. Only the server half this app needs:
// initialize, ping and tools. Diagnostics go to stderr; stdout carries protocol messages only.
const readline = require('readline');

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function createServer({ name, version, instructions, listTools, callTool, log = () => {} }) {
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return fail(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid request');
    }
    if (!('id' in msg)) return null; // notification: never answered
    const { id, method, params = {} } = msg;
    try {
      switch (method) {
        case 'initialize': {
          const asked = params.protocolVersion;
          return ok(id, {
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            ...(instructions ? { instructions } : {}),
          });
        }
        case 'ping': return ok(id, {});
        case 'tools/list': return ok(id, { tools: await listTools() });
        case 'tools/call': {
          if (typeof params.name !== 'string') return fail(id, -32602, 'params.name is required');
          const r = await callTool(params.name, params.arguments || {});
          return r.error ? fail(id, r.error.code, r.error.message) : ok(id, r.result);
        }
        default: return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      log(`error in ${method}: ${err.stack || err.message}`);
      return fail(id, -32603, 'Internal error');
    }
  }

  async function handleLine(line) {
    const text = line.trim();
    if (!text) return null;
    let msg;
    try { msg = JSON.parse(text); } catch { return JSON.stringify(fail(null, -32700, 'Parse error')); }
    const reply = await handle(msg);
    return reply ? JSON.stringify(reply) : null;
  }

  // Resolves once input ends and every pending reply has been written.
  function serve(input = process.stdin, output = process.stdout) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const pending = new Set();
    rl.on('line', (line) => {
      const p = handleLine(line).then((out) => { if (out) output.write(out + '\n'); });
      pending.add(p);
      p.finally(() => pending.delete(p));
    });
    return new Promise((resolve) => rl.on('close', () => Promise.allSettled([...pending]).then(() => resolve())));
  }

  return { handle, handleLine, serve };
}

module.exports = { createServer, SUPPORTED_VERSIONS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (secrets + 8 protocol tests)

- [ ] **Step 5: Commit**

```bash
git add lib/mcp/protocol.js test/protocol.test.js
git commit -m "Add MCP stdio protocol server"
```

---

### Task 3: Connector base helpers

**Files:**
- Create: `lib/connectors/base.js`, `test/base.test.js`

**Interfaces:**
- Produces:
  - `makeClient({ baseUrl, headers?, mask?, timeoutMs?, fetchImpl? }) → request(method, path, { query?, body?, headers?, url? }) → Promise<any>`; throws masked `Error` (`HTTP <status> from <METHOD> <path>: <body≤300>` or `timeout after <n>s: <METHOD> <path>`).
  - `authHeaders(auth, secrets) → object` for `{ header?, prefix?, secret }`.
  - `tool(name, description, properties, run, { required?, write?, annotations?, title? }) → Tool` where `Tool = { name, title?, description, inputSchema, write, annotations, run }`.
  - `S.str(d)`, `S.int(d, max?)`, `S.num(d)`, `S.bool(d)`, `S.enum(values, d)`, `S.obj(d)`.
  - `timedHealth(fn) → Promise<{ ok, latencyMs, detail?, error? }>`.
  - `RAW` symbol: a run result `{ [RAW]: true, content, isError }` is passed through as MCP content.
  - `TIMEOUT_MS = 15000`.

- [ ] **Step 1: Write the failing test** (`test/base.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const { makeClient, authHeaders, tool, S, timedHealth } = require('../lib/connectors/base');

test('joins base paths, sends headers and drops empty query values', async () => {
  const srv = await fakeServer({ 'GET /e/env1/api/v2/problems': { body: { ok: 1 } } });
  try {
    const api = makeClient({ baseUrl: `${srv.url}/e/env1`, headers: { authorization: 'Api-Token t' } });
    assert.deepEqual(await api('GET', '/api/v2/problems', { query: { from: 'now-2h', pageSize: 5, empty: '', none: undefined } }), { ok: 1 });
    assert.deepEqual(srv.requests[0].query, { from: 'now-2h', pageSize: '5' });
    assert.equal(srv.requests[0].headers.authorization, 'Api-Token t');
  } finally { await srv.close(); }
});

test('sends JSON bodies', async () => {
  const srv = await fakeServer({ 'POST /v2/spans': (r) => ({ body: { echo: r.body } }) });
  try {
    const api = makeClient({ baseUrl: srv.url });
    assert.deepEqual(await api('POST', '/v2/spans', { body: { project_id: 'p' } }), { echo: { project_id: 'p' } });
    assert.equal(srv.requests[0].headers['content-type'], 'application/json');
  } finally { await srv.close(); }
});

test('errors carry the status and a masked body', async () => {
  const srv = await fakeServer({ 'GET /x': { status: 401, body: { error: 'bad token tok-123456' } } });
  try {
    const api = makeClient({ baseUrl: srv.url, mask: (s) => s.split('tok-123456').join('***') });
    await assert.rejects(api('GET', '/x'), /HTTP 401 from GET \/x: .*\*\*\*/);
  } finally { await srv.close(); }
});

test('times out', async () => {
  const srv = await fakeServer({ 'GET /slow': () => new Promise((r) => setTimeout(() => r({ body: {} }), 500)) });
  try {
    const api = makeClient({ baseUrl: srv.url, timeoutMs: 50 });
    await assert.rejects(api('GET', '/slow'), /timeout after 0.05s: GET \/slow/);
  } finally { await srv.close(); }
});

test('rejects a base URL that is not http(s)', () => {
  assert.throws(() => makeClient({ baseUrl: 'ftp://x' }), /baseUrl must start with http/);
  assert.throws(() => makeClient({}), /baseUrl must start with http/);
});

test('authHeaders resolves the secret and validates the header name', () => {
  const secrets = secretsFor({ T: 'abc123456' });
  assert.deepEqual(authHeaders({ prefix: 'Bearer ', secret: { env: 'T' } }, secrets), { Authorization: 'Bearer abc123456' });
  assert.deepEqual(authHeaders({ header: 'X-Api-Key', secret: { env: 'T' } }, secrets), { 'X-Api-Key': 'abc123456' });
  assert.deepEqual(authHeaders(undefined, secrets), {});
  assert.throws(() => authHeaders({ header: 'bad header', secret: { env: 'T' } }, secrets), /not a valid header name/);
});

test('tool builds a closed object schema', () => {
  const t = tool('get', 'Get one', { id: S.str('Id'), n: S.int('N', 10) }, async () => 1, { required: ['id'], write: true });
  assert.deepEqual(t.inputSchema, { type: 'object', properties: { id: { type: 'string', description: 'Id' }, n: { type: 'integer', minimum: 1, maximum: 10, description: 'N' } }, required: ['id'], additionalProperties: false });
  assert.equal(t.write, true);
});

test('timedHealth reports ok and failures', async () => {
  const good = await timedHealth(async () => 'fine');
  assert.equal(good.ok, true); assert.equal(good.detail, 'fine'); assert.ok(good.latencyMs >= 0);
  const bad = await timedHealth(async () => { throw new Error('down'); });
  assert.equal(bad.ok, false); assert.equal(bad.error, 'down');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/connectors/base'`

- [ ] **Step 3: Implement** (`lib/connectors/base.js`)

```js
// Shared plumbing for connectors: URL building, auth headers, timeouts, masked errors,
// and small helpers to declare tools and their JSON Schemas.
const TIMEOUT_MS = 15000;
const RAW = Symbol.for('acc.rawContent'); // run() result already in MCP content form (MCP proxy)

function joinUrl(base, path, query) {
  const u = new URL(String(path).replace(/^\//, ''), base.endsWith('/') ? base : base + '/');
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

function makeClient({ baseUrl, headers = {}, mask = (s) => s, timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) throw new Error('baseUrl must start with http:// or https://');
  return async function request(method, path, { query, body, headers: extra, url } = {}) {
    const target = url || joinUrl(baseUrl, path, query);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(target, {
        method,
        signal: ctrl.signal,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers, ...extra },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${method} ${path}: ${text.slice(0, 300)}`);
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(mask(`timeout after ${timeoutMs / 1000}s: ${method} ${path}`));
      if (/^HTTP \d{3} from /.test(err.message)) throw new Error(mask(err.message));
      throw new Error(mask(`${method} ${path} failed: ${err.cause?.code || err.cause?.message || err.message}`));
    } finally {
      clearTimeout(timer);
    }
  };
}

function authHeaders(auth, secrets) {
  if (!auth) return {};
  const header = auth.header || 'Authorization';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new Error(`auth.header "${header}" is not a valid header name`);
  return { [header]: (auth.prefix || '') + secrets.resolve(auth.secret, 'auth.secret') };
}

const S = {
  str: (description) => ({ type: 'string', description }),
  int: (description, max) => ({ type: 'integer', minimum: 1, ...(max ? { maximum: max } : {}), description }),
  num: (description) => ({ type: 'number', description }),
  bool: (description) => ({ type: 'boolean', description }),
  enum: (values, description) => ({ type: 'string', enum: values, description }),
  obj: (description) => ({ type: 'object', description }),
};

function tool(name, description, properties, run, { required = [], write = false, annotations = {}, title } = {}) {
  return {
    name, title, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    write, annotations, run,
  };
}

async function timedHealth(fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { ok: true, latencyMs: Date.now() - started, ...(typeof detail === 'string' ? { detail } : {}) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err.message };
  }
}

module.exports = { makeClient, authHeaders, tool, S, timedHealth, RAW, TIMEOUT_MS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all base tests green)

- [ ] **Step 5: Commit**

```bash
git add lib/connectors/base.js test/base.test.js
git commit -m "Add shared connector HTTP and tool helpers"
```

---

### Task 4: Integrations registry and audit log

**Files:**
- Create: `lib/audit.js`, `lib/integrations.js`, `test/integrations.test.js`, `test/audit.test.js`

**Interfaces:**
- Consumes: `tool`, `S`, `RAW` from `lib/connectors/base.js`; `secrets` from Task 1.
- Produces:
  - `createAudit(file) → { record(entry), tail(n=100) → entry[] }` (newest first).
  - `createIntegrations({ config, secrets, audit?, local?, connectors?, now? }) → { listTools(), callTool(name, args), status({ fresh?, only? }) → Promise<Status[]> }`.
  - `Status = { id, type, flavor?, enabled, allowWrite, tools, writeTools, state: 'ok'|'error'|'disabled'|'unchecked', latencyMs?, detail?, error? }`.
  - Connector module contract: `{ type, create(id, cfg, { secrets, local }) → { tools: Tool[] | () => Promise<Tool[]>, health?: () => Promise<{ ok: boolean|null, latencyMs, detail?, error? }> } }`. `ok: null` means "not checked". A `Tool` may set `skipCheck: true` to bypass argument validation.
  - `DEFAULT_CONNECTORS` map (filled as connector files are added in later tasks).

- [ ] **Step 1: Write the failing audit test** (`test/audit.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAudit } = require('../lib/audit');

test('records and tails newest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-audit-'));
  const a = createAudit(path.join(dir, 'sub', 'mcp-audit.jsonl'));
  a.record({ tool: 'one' }); a.record({ tool: 'two' }); a.record({ tool: 'three' });
  assert.deepEqual(a.tail(2).map((e) => e.tool), ['three', 'two']);
});

test('tail of a missing file is empty', () => {
  assert.deepEqual(createAudit(path.join(os.tmpdir(), 'acc-none', 'x.jsonl')).tail(), []);
});
```

- [ ] **Step 2: Write the failing integrations test** (`test/integrations.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { secretsFor } = require('./helpers');
const { createIntegrations } = require('../lib/integrations');
const { tool, S } = require('../lib/connectors/base');

let healthCalls = 0;
const fake = {
  type: 'fake',
  create(id, cfg) {
    if (cfg.broken) throw new Error('bad config key-abcdef');
    return {
      tools: [
        tool('read', 'Read', { q: S.str('Query'), n: S.int('N') }, async (a) => ({ got: a.q ?? null }), { required: [] }),
        tool('need', 'Needs q', { q: S.str('Query') }, async (a) => a.q, { required: ['q'] }),
        tool('write', 'Write', {}, async () => 'done', { write: true, annotations: { destructiveHint: false } }),
        tool('boom', 'Fails', {}, async () => { throw new Error('upstream said key-abcdef'); }),
        tool('big', 'Large', {}, async () => 'x'.repeat(60000)),
      ],
      health: async () => { healthCalls++; return { ok: true, latencyMs: 3 }; },
    };
  },
};
const accFake = { type: 'acc', create: () => ({ tools: [], health: async () => ({ ok: true, latencyMs: 0 }) }) };
const build = (integrations, extra = {}) => {
  const secrets = secretsFor({ K: 'key-abcdef' });
  secrets.resolve({ env: 'K' });
  return createIntegrations({ config: { integrations }, secrets, connectors: { fake, acc: accFake }, ...extra });
};

test('prefixes tools and hides write tools without allowWrite', async () => {
  const names = (await build({ one: { type: 'fake' }, two: { type: 'fake', allowWrite: true } }).listTools()).map((t) => t.name);
  assert.ok(names.includes('one_read'));
  assert.ok(!names.includes('one_write'));
  assert.ok(names.includes('two_write'));
});

test('annotations mark read and write tools', async () => {
  const tools = await build({ two: { type: 'fake', allowWrite: true } }).listTools();
  assert.equal(tools.find((t) => t.name === 'two_read').annotations.readOnlyHint, true);
  assert.deepEqual(tools.find((t) => t.name === 'two_write').annotations, { readOnlyHint: false, destructiveHint: false });
});

test('a broken, unknown, disabled or badly named integration does not affect the others', async () => {
  const reg = build({ bad: { type: 'fake', broken: true }, odd: { type: 'nope' }, off: { type: 'fake', enabled: false }, 'Bad_Id': { type: 'fake' }, good: { type: 'fake' } });
  const st = Object.fromEntries((await reg.status()).map((s) => [s.id, s]));
  assert.equal(st.bad.state, 'error');
  assert.equal(st.bad.error, 'bad config ***');
  assert.match(st.odd.error, /unknown type "nope"/);
  assert.equal(st.off.state, 'disabled');
  assert.match(st.Bad_Id.error, /id must match/);
  assert.equal(st.good.state, 'ok');
  assert.equal(st.good.tools, 4);
  assert.equal(st.acc.state, 'ok');
});

test('validates arguments before running', async () => {
  const reg = build({ one: { type: 'fake' } });
  const text = async (name, args) => (await reg.callTool(name, args)).result.content[0].text;
  assert.match(await text('one_need', {}), /missing required argument "q"/);
  assert.match(await text('one_read', { zzz: 1 }), /unknown argument "zzz"/);
  assert.match(await text('one_read', { n: 1.5 }), /"n" must be integer/);
  assert.match(await text('one_read', { q: 7 }), /"q" must be string/);
  assert.equal((await reg.callTool('one_need', {})).result.isError, true);
});

test('returns JSON text, masks errors and audits argument names only', async () => {
  const entries = [];
  const reg = build({ one: { type: 'fake' } }, { audit: { record: (e) => entries.push(e) } });
  const ok = await reg.callTool('one_read', { q: 'secret question' });
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { got: 'secret question' });
  const bad = await reg.callTool('one_boom', {});
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.content[0].text, 'upstream said ***');
  assert.deepEqual(entries.map((e) => [e.integration, e.tool, e.ok, e.args]), [['one', 'one_read', true, ['q']], ['one', 'one_boom', false, []]]);
  assert.ok(!JSON.stringify(entries).includes('secret question'));
});

test('unknown tools are protocol errors', async () => {
  assert.equal((await build({}).callTool('nope_x', {})).error.code, -32602);
});

test('caps large results', async () => {
  const text = (await build({ one: { type: 'fake' } }).callTool('one_big', {})).result.content[0].text;
  assert.ok(Buffer.byteLength(text) < 52 * 1024);
  assert.match(text, /truncated: 59 KB result cut to 50 KB/);
});

test('caches health for a minute unless asked for a fresh check', async () => {
  let t = 1000;
  const reg = build({ one: { type: 'fake' } }, { now: () => t });
  healthCalls = 0;
  await reg.status({ only: 'one' }); await reg.status({ only: 'one' });
  assert.equal(healthCalls, 1);
  await reg.status({ only: 'one', fresh: true });
  assert.equal(healthCalls, 2);
  t += 61000;
  await reg.status({ only: 'one' });
  assert.equal(healthCalls, 3);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/audit'` and `'../lib/integrations'`

- [ ] **Step 4: Implement the audit log** (`lib/audit.js`)

```js
// Append-only log of MCP tool calls: time, integration, tool, ok, duration and argument names.
// Argument values are never written. Rotates at 5 MB, keeping one previous file.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;

function createAudit(file) {
  return {
    record(entry) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
        fs.appendFileSync(file, JSON.stringify(entry) + '\n');
      } catch { /* auditing must never break a tool call */ }
    },
    tail(n = 100) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
      const out = [];
      for (const line of text.trimEnd().split('\n').slice(-n).reverse()) {
        try { out.push(JSON.parse(line)); } catch { /* partial line while another process writes */ }
      }
      return out;
    },
  };
}

module.exports = { createAudit };
```

- [ ] **Step 5: Implement the registry** (`lib/integrations.js`)

```js
// Builds one connector per config.integrations entry and exposes them as a single tool list.
// Tool names are prefixed with the integration id, write tools need allowWrite, arguments are
// checked against each tool's schema, results are capped, and every call is audited.
// A broken integration is reported in status, never fatal: it simply contributes no tools.
const { RAW } = require('./connectors/base');

const ID = /^[a-z0-9-]{1,32}$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_RESULT = 50 * 1024;
const HEALTH_TTL = 60 * 1000;

// Filled in as connector modules are added; tests pass their own map.
const DEFAULT_CONNECTORS = {};
for (const file of ['acc', 'dynatrace', 'arize', 'n8n', 'router', 'http', 'mcp-proxy']) {
  try { const m = require(`./connectors/${file}`); DEFAULT_CONNECTORS[m.type] = m; } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; }
}

function cap(text) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_RESULT) return text;
  return Buffer.from(text).subarray(0, MAX_RESULT).toString('utf8') +
    `\n…[truncated: ${Math.round(bytes / 1024)} KB result cut to 50 KB; narrow the query]`;
}
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
function okResult(value) {
  if (value && value[RAW]) {
    return { content: (value.content || []).map((c) => (c.type === 'text' ? { ...c, text: cap(String(c.text)) } : c)), isError: !!value.isError };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: 'text', text: cap(text) }] };
}

function checkArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const props = (schema && schema.properties) || {};
  for (const r of (schema && schema.required) || []) if (args[r] === undefined) return `missing required argument "${r}"`;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) { if (schema.additionalProperties === false) return `unknown argument "${k}"`; continue; }
    const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const fits = !p.type || p.type === type || (p.type === 'integer' && Number.isInteger(v));
    if (!fits) return `argument "${k}" must be ${p.type}`;
    if (p.enum && !p.enum.includes(v)) return `argument "${k}" must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

function createIntegrations({ config = {}, secrets, audit = null, local = null, connectors = DEFAULT_CONNECTORS, now = Date.now }) {
  const entries = [];
  const healthCache = new Map();

  function add(id, cfg) {
    const e = { id, type: cfg.type, flavor: cfg.flavor, enabled: cfg.enabled !== false, allowWrite: cfg.allowWrite === true, error: null, connector: null };
    entries.push(e);
    if (!e.enabled) return;
    try {
      if (!ID.test(id)) throw new Error('id must match [a-z0-9-]{1,32}');
      const mod = connectors[cfg.type];
      if (!mod) throw new Error(`unknown type "${cfg.type}"`);
      e.connector = mod.create(id, cfg, { secrets, local });
    } catch (err) {
      e.error = secrets.mask(err.message);
    }
  }
  add('acc', { type: 'acc' });
  for (const [id, cfg] of Object.entries(config.integrations || {})) {
    if (id !== 'acc') add(id, cfg && typeof cfg === 'object' ? cfg : {});
  }

  async function toolsOf(e) {
    if (!e.connector) return [];
    let list;
    try { list = typeof e.connector.tools === 'function' ? await e.connector.tools() : e.connector.tools; } catch (err) { e.listError = secrets.mask(err.message); return []; }
    e.listError = null;
    const sep = e.type === 'mcp' ? '__' : '_';
    return (list || [])
      .filter((t) => e.allowWrite || !t.write)
      .map((t) => ({ ...t, fullName: `${e.id}${sep}${t.name}`, entry: e }))
      .filter((t) => TOOL_NAME.test(t.fullName));
  }
  const allTools = async () => (await Promise.all(entries.map(toolsOf))).flat();

  async function listTools() {
    return (await allTools()).map((t) => ({
      name: t.fullName,
      ...(t.title ? { title: t.title } : {}),
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object' },
      annotations: { readOnlyHint: !t.write, ...(t.annotations || {}) },
    }));
  }

  async function callTool(name, args = {}) {
    const t = (await allTools()).find((x) => x.fullName === name);
    if (!t) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    const problem = t.skipCheck ? null : checkArgs(t.inputSchema, args);
    if (problem) return { result: errorResult(problem) };
    const started = now();
    let ok = true;
    let result;
    try { result = okResult(await t.run(args)); } catch (err) { ok = false; result = errorResult(secrets.mask(err.message)); }
    if (result.isError) ok = false;
    if (audit) audit.record({ ts: started, integration: t.entry.id, tool: name, ok, ms: now() - started, args: Object.keys(args || {}) });
    return { result };
  }

  async function health(e, fresh) {
    if (!e.enabled) return { state: 'disabled' };
    if (!e.connector) return { state: 'error', error: e.error };
    const cached = healthCache.get(e.id);
    if (!fresh && cached && now() - cached.at < HEALTH_TTL) return cached.value;
    let value;
    if (!e.connector.health) value = { state: 'unchecked' };
    else {
      const h = await e.connector.health();
      if (h.ok === null) value = { state: 'unchecked', ...(h.detail ? { detail: h.detail } : {}) };
      else if (h.ok) value = { state: 'ok', latencyMs: h.latencyMs, ...(h.detail ? { detail: h.detail } : {}) };
      else value = { state: 'error', latencyMs: h.latencyMs, error: secrets.mask(h.error) };
    }
    healthCache.set(e.id, { at: now(), value });
    return value;
  }

  async function status({ fresh = false, only } = {}) {
    const list = only ? entries.filter((e) => e.id === only) : entries;
    return Promise.all(list.map(async (e) => {
      const tools = await toolsOf(e);
      const h = await health(e, fresh);
      const out = {
        id: e.id, type: e.type, ...(e.flavor ? { flavor: e.flavor } : {}), enabled: e.enabled, allowWrite: e.allowWrite,
        tools: tools.length, writeTools: tools.filter((t) => t.write).length, ...h,
      };
      if (h.state === 'ok' && e.listError) Object.assign(out, { state: 'error', error: e.listError });
      return out;
    }));
  }

  return { listTools, callTool, status };
}

module.exports = { createIntegrations, checkArgs, DEFAULT_CONNECTORS };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (audit 2, integrations 8, plus earlier suites)

- [ ] **Step 7: Commit**

```bash
git add lib/audit.js lib/integrations.js test/audit.test.js test/integrations.test.js
git commit -m "Add integrations registry and tool-call audit log"
```

---

### Task 5: Local data, acc connector and the mcp.js entry point

**Files:**
- Create: `lib/local.js`, `lib/connectors/acc.js`, `mcp.js`, `test/mcp.test.js`

**Interfaces:**
- Consumes: `Indexer` (`lib/indexer.js`), `summarize` (`lib/aggregate.js`), `DEFAULT_PRICING` (`lib/pricing.js`), `processes.snapshot()` (`lib/processes.js`), `createIntegrations`, `createSecrets`, `createAudit`, `createServer`.
- Produces: `createLocal({ cacheDir, config, indexer? }) → { summary(range), liveApps(), integrationsStatus() }` (`integrationsStatus` is replaced after the registry exists). Tools `acc_usage_summary`, `acc_quality`, `acc_live_apps`, `acc_integrations_status`. Env vars `ACC_CONFIG` (config path) and `ACC_CACHE_DIR` (cache dir) for tests.

- [ ] **Step 1: Write the failing end-to-end test** (`test/mcp.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runMcp(messages, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mcp-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], {
      env: { ...process.env, ACC_CONFIG: path.join(dir, 'config.json'), ACC_CACHE_DIR: path.join(dir, 'cache') },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', () => resolve({ replies: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), dir }));
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.end();
  });
}

test('mcp.js lists acc and configured tools and reports status', async () => {
  const config = { integrations: { extra: { type: 'http', baseUrl: 'http://127.0.0.1:9', endpoints: [{ name: 'ping', method: 'GET', path: '/ping', description: 'Ping' }] } } };
  const { replies, dir } = await runMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acc_integrations_status', arguments: {} } },
  ], config);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId[1].result.serverInfo.name, 'ai-command-center');
  const names = byId[2].result.tools.map((t) => t.name);
  for (const n of ['acc_usage_summary', 'acc_quality', 'acc_live_apps', 'acc_integrations_status', 'extra_ping']) assert.ok(names.includes(n), n);
  const status = JSON.parse(byId[3].result.content[0].text);
  assert.equal(status.find((s) => s.id === 'extra').state, 'unchecked');
  const audit = fs.readFileSync(path.join(dir, 'cache', 'mcp-audit.jsonl'), 'utf8');
  assert.match(audit, /"tool":"acc_integrations_status"/);
});
```

This test also needs the `http` connector. Until Task 9 exists, `extra` reports `unknown type "http"`. So write the test now, but expect only the `acc_*` assertions to pass until Task 9. Step 4 runs only this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mcp.test.js`
Expected: FAIL (`mcp.js` does not exist; spawn exits with "Cannot find module")

- [ ] **Step 3: Implement local data** (`lib/local.js`)

```js
// The dashboard's own data, packaged for the acc connector. The indexer is created lazily,
// so listing tools never touches the logs; each summary does an incremental rescan first.
const path = require('path');
const { Indexer } = require('./indexer');
const { summarize } = require('./aggregate');
const { DEFAULT_PRICING } = require('./pricing');
const processes = require('./processes');

function createLocal({ cacheDir, config = {}, indexer: shared = null }) {
  let indexer = shared;
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing || {}) };
  return {
    async summary(range) {
      if (!indexer) indexer = new Indexer([require('./claude'), require('./codex')], path.join(cacheDir, 'index.json'));
      if (!shared) await indexer.refresh();
      return summarize(indexer.results(), { rangeDays: range, pricing });
    },
    liveApps: () => processes.snapshot(),
    integrationsStatus: async () => [],
  };
}

module.exports = { createLocal };
```

- [ ] **Step 4: Implement the acc connector** (`lib/connectors/acc.js`)

```js
// The dashboard's own numbers as tools: spend, quality and the AI apps running right now.
const { tool } = require('./base');

const RANGE = { type: 'string', enum: ['7', '30', '90', 'all'], description: 'Days to cover, or all (default 30)' };
const rangeOf = (r) => (r === 'all' ? 'all' : Number(r || 30));

module.exports = {
  type: 'acc',
  create(id, cfg, { local }) {
    return {
      health: async () => ({ ok: true, latencyMs: 0, detail: 'local' }),
      tools: [
        tool('usage_summary', 'AI usage and API-equivalent cost on this Mac (Claude Code and Codex): spend, tokens, sessions, month projection, top models, projects and costliest sessions.', { range: RANGE }, async ({ range }) => {
          const s = await local.summary(rangeOf(range));
          return {
            range: s.range, kpis: s.kpis,
            month: { projected: s.month.projected, daysElapsed: s.month.daysElapsed, daysInMonth: s.month.daysInMonth },
            tools: s.tools, topModels: s.models.slice(0, 8), topProjects: s.projects.slice(0, 8),
            topCostSessions: s.topCostSessions, unpriced: s.unpriced,
          };
        }),
        tool('quality', 'Quality and safety signals from local AI logs: tool-call accuracy, hallucination signals, prompt-injection detections, corrections, secrets and risky commands.', { range: RANGE }, async ({ range }) => {
          const { events, feed, daily, ...q } = (await local.summary(rangeOf(range))).quality;
          return q;
        }),
        tool('live_apps', 'AI apps running on this Mac right now, with CPU, memory and uptime.', {}, () => local.liveApps()),
        tool('integrations_status', 'Every configured integration with its state (ok, error, disabled, unchecked), latency, tool count and whether write tools are on. Call this first.', {}, () => local.integrationsStatus()),
      ],
    };
  },
};
```

- [ ] **Step 5: Implement the entry point** (`mcp.js`)

```js
#!/usr/bin/env node
// MCP server for AI Command Center. AI clients (Claude Code, Kiro, Antigravity) start it over
// stdio with `node mcp.js`. It exposes the dashboard's own data plus every integration
// configured in config.json. stdout carries protocol messages only; logs go to stderr.
const fs = require('fs');
const path = require('path');
const { createServer } = require('./lib/mcp/protocol');
const { createIntegrations } = require('./lib/integrations');
const { createSecrets } = require('./lib/secrets');
const { createAudit } = require('./lib/audit');
const { createLocal } = require('./lib/local');
const { version } = require('./package.json');

const DIR = __dirname;
const CONFIG_FILE = process.env.ACC_CONFIG || path.join(DIR, 'config.json');
const CACHE_DIR = process.env.ACC_CACHE_DIR || path.join(DIR, '.cache');
const log = (m) => process.stderr.write(`[ai-command-center] ${m}\n`);

const INSTRUCTIONS = 'AI Command Center on this Mac. Tool names are prefixed with an integration id: acc_* reads local AI usage, cost, quality and running apps; other prefixes reach the platforms configured in config.json (Dynatrace, Arize, n8n, AI routers, HTTP APIs, upstream MCP servers). Call acc_integrations_status first to see what is connected. Write tools only appear for integrations with allowWrite enabled.';

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') log(`config.json is unreadable, starting with defaults: ${err.message}`); }

const secrets = createSecrets();
const local = createLocal({ cacheDir: CACHE_DIR, config });
const integrations = createIntegrations({ config, secrets, audit: createAudit(path.join(CACHE_DIR, 'mcp-audit.jsonl')), local });
local.integrationsStatus = () => integrations.status();

createServer({ name: 'ai-command-center', version, instructions: INSTRUCTIONS, listTools: integrations.listTools, callTool: integrations.callTool, log })
  .serve()
  .then(() => process.exit(0));
```

- [ ] **Step 6: Run the e2e test**

Run: `node --test test/mcp.test.js`
Expected: FAIL only on `extra_ping` (http connector arrives in Task 9). All `acc_*` names present.
To confirm the rest, temporarily run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | ACC_CONFIG=/nonexistent node mcp.js`
Expected: one JSON line listing the four `acc_*` tools.

- [ ] **Step 7: Commit**

```bash
git add lib/local.js lib/connectors/acc.js mcp.js test/mcp.test.js
git commit -m "Add mcp.js entry point with acc tools"
```

---

### Task 6: Dynatrace connector

**Files:**
- Create: `lib/connectors/dynatrace.js`, `test/dynatrace.test.js`

**Interfaces:**
- Consumes: `makeClient`, `tool`, `S`, `timedHealth` from base.
- Produces: type `dynatrace`. Tools `list_problems`, `get_problem`, `list_entities`, `query_metrics`, `query_logs`, `list_security_problems`, and `dql` (only with `platformToken`).

- [ ] **Step 1: Write the failing test** (`test/dynatrace.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const dynatrace = require('../lib/connectors/dynatrace');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));

test('list_problems sends the API token and defaults (Managed-style base path)', async () => {
  const srv = await fakeServer({ 'GET /e/abc/api/v2/problems': { body: { totalCount: 1, problems: [{ problemId: 'p1' }] } } });
  try {
    const c = dynatrace.create('dt', { baseUrl: `${srv.url}/e/abc`, token: { env: 'DT' } }, { secrets: secretsFor({ DT: 'dt0c01.token' }) });
    const r = await tools(c).list_problems.run({});
    assert.equal(r.problems[0].problemId, 'p1');
    assert.equal(srv.requests[0].headers.authorization, 'Api-Token dt0c01.token');
    assert.deepEqual(srv.requests[0].query, { from: 'now-2h', pageSize: '50' });
  } finally { await srv.close(); }
});

test('get_problem, entities, metrics, logs and security map to API v2', async () => {
  const srv = await fakeServer({
    'GET /api/v2/problems/abc-1': { body: { problemId: 'abc-1' } },
    'GET /api/v2/entities': { body: { entities: [] } },
    'GET /api/v2/metrics/query': { body: { result: [] } },
    'GET /api/v2/logs/search': { body: { results: [] } },
    'GET /api/v2/securityProblems': { body: { securityProblems: [] } },
  });
  try {
    const t = tools(dynatrace.create('dt', { baseUrl: srv.url, token: { env: 'DT' } }, { secrets: secretsFor({ DT: 'dt0c01.token' }) }));
    await t.get_problem.run({ problemId: 'abc-1' });
    await t.list_entities.run({ entitySelector: 'type("SERVICE")' });
    await t.query_metrics.run({ metricSelector: 'builtin:service.response.time:avg', resolution: '5m' });
    await t.query_logs.run({ query: 'status="ERROR"' });
    await t.list_security_problems.run({});
    assert.deepEqual(srv.requests.map((r) => r.path), ['/api/v2/problems/abc-1', '/api/v2/entities', '/api/v2/metrics/query', '/api/v2/logs/search', '/api/v2/securityProblems']);
    assert.equal(srv.requests[1].query.entitySelector, 'type("SERVICE")');
    assert.equal(srv.requests[2].query.resolution, '5m');
    assert.equal(srv.requests[3].query.limit, '100');
    assert.deepEqual(t.list_entities.inputSchema.required, ['entitySelector']);
  } finally { await srv.close(); }
});

test('no dql tool without a platform token', () => {
  const c = dynatrace.create('dt', { baseUrl: 'https://x.live.dynatrace.com', token: { env: 'DT' } }, { secrets: secretsFor({ DT: 'dt0c01.token' }) });
  assert.equal(tools(c).dql, undefined);
  assert.equal(c.tools.every((t) => !t.write), true);
});

test('dql polls until the query succeeds', async () => {
  let polls = 0;
  const srv = await fakeServer({
    'POST /platform/storage/query/v1/query:execute': { body: { state: 'RUNNING', requestToken: 'rt1' } },
    'GET /platform/storage/query/v1/query:poll': () => ({ body: ++polls < 2 ? { state: 'RUNNING' } : { state: 'SUCCEEDED', result: { records: [{ n: 1 }] } } }),
  });
  try {
    const c = dynatrace.create('dt', { baseUrl: 'https://x.live.dynatrace.com', token: { env: 'DT' }, platformUrl: srv.url, platformToken: { env: 'PT' } }, { secrets: secretsFor({ DT: 'dt0c01.token', PT: 'pt-token-1' }) });
    const r = await tools(c).dql.run({ query: 'fetch logs | limit 1' });
    assert.deepEqual(r.records, [{ n: 1 }]);
    assert.equal(srv.requests[0].headers.authorization, 'Bearer pt-token-1');
    assert.equal(srv.requests[0].body.query, 'fetch logs | limit 1');
    assert.equal(srv.requests[1].query['request-token'], 'rt1');
  } finally { await srv.close(); }
});

test('dql surfaces a failed query', async () => {
  const srv = await fakeServer({ 'POST /platform/storage/query/v1/query:execute': { body: { state: 'FAILED', error: 'syntax' } } });
  try {
    const c = dynatrace.create('dt', { baseUrl: 'https://x.live.dynatrace.com', token: { env: 'DT' }, platformUrl: srv.url, platformToken: { env: 'PT' } }, { secrets: secretsFor({ DT: 'dt0c01.token', PT: 'pt-token-1' }) });
    await assert.rejects(tools(c).dql.run({ query: 'bad' }), /DQL query did not finish \(state FAILED\)/);
  } finally { await srv.close(); }
});

test('health asks for one problem; a token is required', async () => {
  const srv = await fakeServer({ 'GET /api/v2/problems': { body: { problems: [] } } });
  try {
    const c = dynatrace.create('dt', { baseUrl: srv.url, token: { env: 'DT' } }, { secrets: secretsFor({ DT: 'dt0c01.token' }) });
    assert.equal((await c.health()).ok, true);
    assert.equal(srv.requests[0].query.pageSize, '1');
  } finally { await srv.close(); }
  assert.throws(() => dynatrace.create('dt', { baseUrl: 'https://x' }, { secrets: secretsFor({}) }), /token is required/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dynatrace.test.js`
Expected: FAIL with `Cannot find module '../lib/connectors/dynatrace'`

- [ ] **Step 3: Implement** (`lib/connectors/dynatrace.js`)

```js
// Dynatrace through the environment API v2, which SaaS and Managed share, plus DQL on Grail
// (SaaS only) when a platform token is configured. Read-only.
const { makeClient, tool, S, timedHealth } = require('./base');

const DQL_BUDGET_MS = 60000;

module.exports = {
  type: 'dynatrace',
  create(id, cfg, { secrets }) {
    const token = secrets.resolve(cfg.token, 'token');
    if (!token) throw new Error('token is required (an API token with problems.read, entities.read, metrics.read, logs.read, securityProblems.read)');
    const api = makeClient({ baseUrl: cfg.baseUrl, headers: { authorization: `Api-Token ${token}` }, mask: secrets.mask });
    const from = S.str('Start of the time frame, e.g. now-2h, now-7d or an ISO time (default now-2h)');

    const tools = [
      tool('list_problems', 'Problems detected by Davis AI, newest first.', {
        from, problemSelector: S.str('e.g. status("open"),severityLevel("ERROR")'),
        entitySelector: S.str('Only problems affecting these entities, e.g. type("SERVICE"),tag("prod")'),
        pageSize: S.int('Max problems (default 50)', 500),
      }, (a) => api('GET', '/api/v2/problems', { query: { from: a.from || 'now-2h', problemSelector: a.problemSelector, entitySelector: a.entitySelector, pageSize: a.pageSize || 50 } })),
      tool('get_problem', 'One problem in full: root cause, impacted entities and evidence.', {
        problemId: S.str('Problem id from list_problems (the UUID-like problemId, not the P-12345 display id)'),
      }, (a) => api('GET', `/api/v2/problems/${encodeURIComponent(a.problemId)}`), { required: ['problemId'] }),
      tool('list_entities', 'Monitored entities matching a selector.', {
        entitySelector: S.str('Exactly one entity type, e.g. type("SERVICE"),tag("prod")'), from,
        fields: S.str('Extra fields, e.g. +properties,+toRelationships'), pageSize: S.int('Max entities (default 50)', 500),
      }, (a) => api('GET', '/api/v2/entities', { query: { entitySelector: a.entitySelector, from: a.from || 'now-2h', fields: a.fields, pageSize: a.pageSize || 50 } }), { required: ['entitySelector'] }),
      tool('query_metrics', 'Metric data points over a time frame.', {
        metricSelector: S.str('e.g. builtin:service.response.time:avg:splitBy("dt.entity.service")'), from,
        resolution: S.str('e.g. 5m, 1h (default: automatic)'), entitySelector: S.str('Only these entities'),
      }, (a) => api('GET', '/api/v2/metrics/query', { query: { metricSelector: a.metricSelector, from: a.from || 'now-2h', resolution: a.resolution, entitySelector: a.entitySelector } }), { required: ['metricSelector'] }),
      tool('query_logs', 'Search log records.', {
        query: S.str('Log search query, e.g. status="ERROR" AND content="timeout"'), from, limit: S.int('Max records (default 100)', 1000),
      }, (a) => api('GET', '/api/v2/logs/search', { query: { query: a.query, from: a.from || 'now-2h', limit: a.limit || 100 } })),
      tool('list_security_problems', 'Vulnerabilities found by Application Security.', {
        securityProblemSelector: S.str('e.g. status("OPEN"),riskLevel("CRITICAL")'), pageSize: S.int('Max items (default 50)', 500),
      }, (a) => api('GET', '/api/v2/securityProblems', { query: { securityProblemSelector: a.securityProblemSelector, pageSize: a.pageSize || 50 } })),
    ];

    if (cfg.platformToken) {
      const platformToken = secrets.resolve(cfg.platformToken, 'platformToken');
      if (!cfg.platformUrl) throw new Error('platformUrl (https://<env>.apps.dynatrace.com) is required with platformToken');
      const platform = makeClient({ baseUrl: cfg.platformUrl, headers: { authorization: `Bearer ${platformToken}` }, mask: secrets.mask });
      tools.push(tool('dql', 'Run a DQL query on Grail (SaaS only), e.g. fetch logs | filter loglevel == "ERROR" | limit 20.', {
        query: S.str('DQL query'), maxResultRecords: S.int('Max records (default 200)', 10000),
      }, async (a) => {
        let r = await platform('POST', '/platform/storage/query/v1/query:execute', { body: { query: a.query, maxResultRecords: a.maxResultRecords || 200, requestTimeoutMilliseconds: 10000 } });
        const requestToken = r && r.requestToken;
        const deadline = Date.now() + DQL_BUDGET_MS;
        while (r && r.state === 'RUNNING' && requestToken && Date.now() < deadline) {
          r = await platform('GET', '/platform/storage/query/v1/query:poll', { query: { 'request-token': requestToken, 'request-timeout-milliseconds': 5000 } });
        }
        if (!r || r.state !== 'SUCCEEDED') throw new Error(`DQL query did not finish (state ${r ? r.state : 'unknown'})`);
        return r.result;
      }, { required: ['query'] }));
    }

    return { tools, health: () => timedHealth(async () => { await api('GET', '/api/v2/problems', { query: { pageSize: 1 } }); }) };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/dynatrace.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/connectors/dynatrace.js test/dynatrace.test.js
git commit -m "Add Dynatrace connector (API v2 and DQL)"
```

---

### Task 7: Arize connector (Phoenix and AX)

**Files:**
- Create: `lib/connectors/arize.js`, `test/arize.test.js`

**Interfaces:**
- Produces: type `arize`, `flavor` `phoenix` (default) or `ax`.
  - Phoenix tools: `list_projects`, `search_spans`, `list_traces`, `list_datasets`, `list_experiments`.
  - AX tools: the same five plus `list_monitors`.

- [ ] **Step 1: Write the failing test** (`test/arize.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const arize = require('../lib/connectors/arize');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));

test('phoenix maps tools to REST /v1 and works without a key', async () => {
  const srv = await fakeServer({
    'GET /v1/projects': { body: { data: [{ name: 'default' }] } },
    'GET /v1/projects/default/spans': { body: { data: [] } },
    'GET /v1/projects/default/traces': { body: { data: [] } },
    'GET /v1/datasets': { body: { data: [] } },
    'GET /v1/datasets/ds1/experiments': { body: { data: [] } },
  });
  try {
    const c = arize.create('phoenix', { flavor: 'phoenix', baseUrl: srv.url }, { secrets: secretsFor({}) });
    const t = tools(c);
    assert.deepEqual(Object.keys(t), ['list_projects', 'search_spans', 'list_traces', 'list_datasets', 'list_experiments']);
    await t.list_projects.run({ name_contains: 'def' });
    await t.search_spans.run({ project: 'default', span_kind: 'LLM', status_code: 'ERROR', limit: 20 });
    await t.list_traces.run({ project: 'default', error: true });
    await t.list_datasets.run({});
    await t.list_experiments.run({ dataset_id: 'ds1' });
    assert.equal(srv.requests[0].query.name_contains, 'def');
    assert.deepEqual(srv.requests[1].query, { span_kind: 'LLM', status_code: 'ERROR', limit: '20' });
    assert.equal(srv.requests[2].query.error, 'true');
    assert.equal(srv.requests[0].headers.authorization, undefined);
  } finally { await srv.close(); }
});

test('phoenix sends a bearer key when configured; health lists one project', async () => {
  const srv = await fakeServer({ 'GET /s/space/v1/projects': { body: { data: [] } } });
  try {
    const c = arize.create('phoenix', { flavor: 'phoenix', baseUrl: `${srv.url}/s/space`, apiKey: { env: 'PX' } }, { secrets: secretsFor({ PX: 'px-key-123' }) });
    assert.equal((await c.health()).ok, true);
    assert.equal(srv.requests[0].headers.authorization, 'Bearer px-key-123');
    assert.equal(srv.requests[0].query.limit, '1');
  } finally { await srv.close(); }
});

test('ax maps tools to REST /v2, spans and traces are POST searches', async () => {
  const srv = await fakeServer({
    'GET /v2/projects': { body: { projects: [] } },
    'POST /v2/spans': { body: { spans: [] } },
    'POST /v2/traces': { body: { traces: [] } },
    'GET /v2/datasets': { body: {} },
    'GET /v2/experiments': { body: {} },
    'GET /v2/monitors': { body: {} },
  });
  try {
    const c = arize.create('ax', { flavor: 'ax', baseUrl: srv.url, apiKey: { env: 'AX' } }, { secrets: secretsFor({ AX: 'ax-key-123' }) });
    const t = tools(c);
    assert.ok(t.list_monitors);
    await t.list_projects.run({ space_id: 'sp1', limit: 10 });
    await t.search_spans.run({ project_id: 'p1', filter: "status_code = 'ERROR'", limit: 100 });
    await t.list_traces.run({ project_id: 'p1' });
    await t.list_datasets.run({}); await t.list_experiments.run({ dataset_id: 'd1' }); await t.list_monitors.run({ project_id: 'p1' });
    assert.equal(srv.requests[0].headers.authorization, 'Bearer ax-key-123');
    assert.deepEqual(srv.requests[1].body, { project_id: 'p1', filter: "status_code = 'ERROR'" });
    assert.equal(srv.requests[1].query.limit, '100');
    assert.equal(srv.requests[2].method, 'POST');
    assert.deepEqual(t.search_spans.inputSchema.required, ['project_id']);
  } finally { await srv.close(); }
});

test('ax needs a key; unknown flavors are rejected', () => {
  assert.throws(() => arize.create('ax', { flavor: 'ax' }, { secrets: secretsFor({}) }), /apiKey is required/);
  assert.throws(() => arize.create('x', { flavor: 'cloud' }, { secrets: secretsFor({}) }), /flavor must be/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/arize.test.js`
Expected: FAIL with `Cannot find module '../lib/connectors/arize'`

- [ ] **Step 3: Implement** (`lib/connectors/arize.js`)

```js
// Arize AI observability, read-only. Two flavors:
//   phoenix: open-source Phoenix or Phoenix Cloud, REST /v1 (key optional for local instances)
//   ax:      Arize AX cloud, REST /v2 (Authorization: Bearer <api key>)
const { makeClient, tool, S, timedHealth } = require('./base');

const enc = encodeURIComponent;
const since = S.str('ISO 8601 start time, e.g. 2026-10-17T00:00:00Z');
const until = S.str('ISO 8601 end time');

function phoenixTools(api) {
  const project = S.str('Project name or id, e.g. default');
  return [
    tool('list_projects', 'Phoenix projects.', { name_contains: S.str('Only names containing this text'), limit: S.int('Max projects (default 50)', 1000) },
      (a) => api('GET', '/v1/projects', { query: { name_contains: a.name_contains, limit: a.limit || 50 } })),
    tool('search_spans', 'Spans of a project, newest first, filtered by time, name, kind or status.', {
      project, start_time: since, end_time: until, name: S.str('Span name'), span_kind: S.str('e.g. LLM, CHAIN, TOOL, RETRIEVER'),
      status_code: S.enum(['OK', 'ERROR', 'UNSET'], 'Span status'), trace_id: S.str('Only this trace'), limit: S.int('Max spans (default 50)', 1000),
    }, (a) => { const { project: p, ...q } = a; return api('GET', `/v1/projects/${enc(p)}/spans`, { query: { ...q, limit: q.limit || 50 } }); }, { required: ['project'] }),
    tool('list_traces', 'Traces of a project, newest first.', {
      project, start_time: since, end_time: until, error: S.bool('Only traces with an error'),
      min_latency_ms: S.num('Only traces slower than this'), filter: S.str('Phoenix filter expression'), limit: S.int('Max traces (default 20)', 1000),
    }, (a) => { const { project: p, ...q } = a; return api('GET', `/v1/projects/${enc(p)}/traces`, { query: { ...q, limit: q.limit || 20 } }); }, { required: ['project'] }),
    tool('list_datasets', 'Datasets.', { name: S.str('Filter by name'), limit: S.int('Max datasets (default 50)', 1000) },
      (a) => api('GET', '/v1/datasets', { query: { name: a.name, limit: a.limit || 50 } })),
    tool('list_experiments', 'Experiments run on a dataset.', { dataset_id: S.str('Dataset id from list_datasets'), limit: S.int('Max experiments (default 50)', 1000) },
      (a) => api('GET', `/v1/datasets/${enc(a.dataset_id)}/experiments`, { query: { limit: a.limit || 50 } }), { required: ['dataset_id'] }),
  ];
}

function axTools(api) {
  const space = S.str('Space id (default: every space the key can read)');
  const search = (path) => (a) => {
    const { limit, ...body } = a;
    return api('POST', path, { query: { limit: limit || 50 }, body });
  };
  const spanProps = { project_id: S.str('Project id from list_projects'), start_time: since, end_time: until, filter: S.str("Filter expression, e.g. status_code = 'ERROR' or span_kind = 'LLM'") };
  return [
    tool('list_projects', 'Arize AX projects (LLM applications being traced).', { space_id: space, name: S.str('Name search'), limit: S.int('Max projects (default 50)', 100) },
      (a) => api('GET', '/v2/projects', { query: { space_id: a.space_id, name: a.name, limit: a.limit || 50 } })),
    tool('search_spans', 'Spans of a project, newest first.', { ...spanProps, limit: S.int('Max spans (default 50)', 500) }, search('/v2/spans'), { required: ['project_id'] }),
    tool('list_traces', 'Traces that contain at least one span matching the filter.', { ...spanProps, limit: S.int('Max traces (default 20)', 50) }, search('/v2/traces'), { required: ['project_id'] }),
    tool('list_datasets', 'Datasets.', { space_id: space, name: S.str('Name search'), limit: S.int('Max datasets (default 50)', 100) },
      (a) => api('GET', '/v2/datasets', { query: { space_id: a.space_id, name: a.name, limit: a.limit || 50 } })),
    tool('list_experiments', 'Experiments.', { dataset_id: S.str('Only this dataset'), space_id: space, limit: S.int('Max experiments (default 50)', 100) },
      (a) => api('GET', '/v2/experiments', { query: { dataset_id: a.dataset_id, space_id: a.space_id, limit: a.limit || 50 } })),
    tool('list_monitors', 'Monitors and their status.', { space_id: space, project_id: S.str('Only this project'), name: S.str('Name search') },
      (a) => api('GET', '/v2/monitors', { query: a })),
  ];
}

module.exports = {
  type: 'arize',
  create(id, cfg, { secrets }) {
    const flavor = cfg.flavor || 'phoenix';
    if (!['phoenix', 'ax'].includes(flavor)) throw new Error('flavor must be "phoenix" or "ax"');
    const key = secrets.resolve(cfg.apiKey, 'apiKey');
    if (flavor === 'ax' && !key) throw new Error('apiKey is required for Arize AX');
    const api = makeClient({
      baseUrl: cfg.baseUrl || (flavor === 'ax' ? 'https://api.arize.com' : 'http://localhost:6006'),
      headers: key ? { authorization: `Bearer ${key}` } : {},
      mask: secrets.mask,
    });
    const healthPath = flavor === 'ax' ? '/v2/projects' : '/v1/projects';
    return {
      tools: flavor === 'ax' ? axTools(api) : phoenixTools(api),
      health: () => timedHealth(async () => { await api('GET', healthPath, { query: { limit: 1 } }); }),
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/arize.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/connectors/arize.js test/arize.test.js
git commit -m "Add Arize connector (Phoenix and AX)"
```

---

### Task 8: n8n and router connectors

**Files:**
- Create: `lib/connectors/n8n.js`, `lib/connectors/router.js`, `test/n8n.test.js`, `test/router.test.js`

**Interfaces:**
- Produces:
  - type `n8n`: `list_workflows`, `get_workflow`, `list_executions`, `get_execution`, `run_workflow` (write; only when `webhooks` is non-empty), `set_workflow_active` (write).
  - type `router`, `flavor` `omniroute` or `9router`. OmniRoute: `health`, `list_models` (with `managementToken` or `apiKey`), and with `managementToken` also `list_providers`, `list_combos`, `usage`, `telemetry`. 9router: `health`, `list_models`.

- [ ] **Step 1: Write the failing n8n test** (`test/n8n.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const n8n = require('../lib/connectors/n8n');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));
const make = (url, extra = {}) => n8n.create('n8n', { baseUrl: url, apiKey: { env: 'N8N' }, ...extra }, { secrets: secretsFor({ N8N: 'n8n-key-123' }) });

test('read tools use the public API with the key header', async () => {
  const srv = await fakeServer({
    'GET /api/v1/workflows': { body: { data: [{ id: 'w1', name: 'Daily', active: true, tags: [{ name: 'ops' }], nodes: [{ name: 'x' }], updatedAt: 't' }], nextCursor: null } },
    'GET /api/v1/workflows/w1': { body: { id: 'w1', name: 'Daily', active: true, nodes: [{ name: 'Cron', type: 'n8n-nodes-base.cron', credentials: { x: 1 } }], settings: {} } },
    'GET /api/v1/executions': { body: { data: [{ id: 'e1' }] } },
    'GET /api/v1/executions/e1': { body: { id: 'e1' } },
  });
  try {
    const t = tools(make(srv.url));
    const list = await t.list_workflows.run({ active: true });
    assert.deepEqual(list.workflows[0], { id: 'w1', name: 'Daily', active: true, tags: ['ops'], updatedAt: 't' });
    const w = await t.get_workflow.run({ id: 'w1' });
    assert.deepEqual(w.nodes, [{ name: 'Cron', type: 'n8n-nodes-base.cron', disabled: false }]);
    await t.list_executions.run({ workflowId: 'w1', status: 'error' });
    await t.get_execution.run({ id: 'e1' });
    assert.equal(srv.requests[0].headers['x-n8n-api-key'], 'n8n-key-123');
    assert.equal(srv.requests[0].query.active, 'true');
    assert.deepEqual(srv.requests[2].query, { workflowId: 'w1', status: 'error', limit: '20' });
    assert.equal(srv.requests[3].query.includeData, undefined);
  } finally { await srv.close(); }
});

test('run_workflow posts only to allowlisted webhooks, without the API key', async () => {
  const srv = await fakeServer({ 'POST /webhook/abc': (r) => ({ body: { received: r.body } }) });
  try {
    const t = tools(make(srv.url, { webhooks: { 'daily-report': `${srv.url}/webhook/abc` } }));
    assert.equal(t.run_workflow.write, true);
    assert.deepEqual(t.run_workflow.inputSchema.properties.name.enum, ['daily-report']);
    assert.deepEqual(await t.run_workflow.run({ name: 'daily-report', payload: { day: 'mon' } }), { received: { day: 'mon' } });
    assert.equal(srv.requests[0].headers['x-n8n-api-key'], undefined);
    await assert.rejects(t.run_workflow.run({ name: 'other' }), /not in the webhooks allowlist/);
  } finally { await srv.close(); }
});

test('no run_workflow without webhooks; set_workflow_active is a write tool', async () => {
  const srv = await fakeServer({ 'POST /api/v1/workflows/w1/deactivate': { body: { id: 'w1', name: 'Daily', active: false } } });
  try {
    const t = tools(make(srv.url));
    assert.equal(t.run_workflow, undefined);
    assert.equal(t.set_workflow_active.write, true);
    assert.equal((await t.set_workflow_active.run({ id: 'w1', active: false })).active, false);
  } finally { await srv.close(); }
});

test('rejects bad webhook URLs and a missing key', () => {
  assert.throws(() => make('http://x', { webhooks: { a: 'ftp://y' } }), /webhooks.a must be an http/);
  assert.throws(() => n8n.create('n8n', { baseUrl: 'http://x' }, { secrets: secretsFor({}) }), /apiKey is required/);
});
```

- [ ] **Step 2: Write the failing router test** (`test/router.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const router = require('../lib/connectors/router');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));

test('omniroute with a management token uses the management API', async () => {
  const srv = await fakeServer({
    'GET /api/health': { body: { status: 'ok' } },
    'GET /api/health/degradation': { body: { active: false } },
    'GET /api/models': { body: { models: [{ provider: 'p', model: 'm', fullModel: 'p/m', available: true }] } },
    'GET /api/providers': { body: { connections: [{ id: 'c1', provider: 'openai', name: 'work', email: 'me@x.com', providerSpecificData: { k: 1 }, isActive: true, testStatus: 'ok' }], total: 1 } },
    'GET /api/combos': { body: { combos: [], total: 0 } },
    'GET /api/usage/analytics': { body: { summary: { totalRequests: 3 }, byModel: [], byProvider: [], dailyTrend: [], errorBreakdown: [], activityMap: { a: 1 }, byApiKey: [{ k: 1 }] } },
    'GET /api/telemetry/summary': { body: { p95: 120 } },
  });
  try {
    const c = router.create('omniroute', { flavor: 'omniroute', baseUrl: srv.url, managementToken: { env: 'OM' } }, { secrets: secretsFor({ OM: 'oma_live_token1' }) });
    const t = tools(c);
    assert.deepEqual(Object.keys(t), ['health', 'list_models', 'list_providers', 'list_combos', 'usage', 'telemetry']);
    assert.deepEqual((await t.health.run({})).health, { status: 'ok' });
    assert.equal((await t.list_models.run({})).models[0].fullModel, 'p/m');
    assert.deepEqual((await t.list_providers.run({})).connections[0], { id: 'c1', provider: 'openai', name: 'work', isActive: true, testStatus: 'ok' });
    await t.list_combos.run({});
    const u = await t.usage.run({ period: 'week' });
    assert.deepEqual(Object.keys(u).sort(), ['byModel', 'byProvider', 'dailyTrend', 'errorBreakdown', 'period', 'summary']);
    await t.telemetry.run({});
    assert.equal(srv.requests.find((r) => r.path === '/api/models').headers.authorization, 'Bearer oma_live_token1');
    assert.equal(srv.requests.find((r) => r.path === '/api/usage/analytics').query.period, 'week');
    assert.equal(c.tools.every((x) => !x.write), true);
    assert.equal((await c.health()).ok, true);
  } finally { await srv.close(); }
});

test('omniroute with only an inference key lists models from /v1/models', async () => {
  const srv = await fakeServer({ 'GET /v1/models': { body: { data: [{ id: 'auto', owned_by: 'omniroute' }] } }, 'GET /api/health': { body: { status: 'ok' } } });
  try {
    const t = tools(router.create('om', { flavor: 'omniroute', baseUrl: srv.url, apiKey: { env: 'K' } }, { secrets: secretsFor({ K: 'sk-inference-1' }) }));
    assert.deepEqual(Object.keys(t), ['health', 'list_models']);
    assert.deepEqual(await t.list_models.run({}), { models: [{ id: 'auto', owned_by: 'omniroute' }] });
  } finally { await srv.close(); }
});

test('9router exposes the OpenAI-compatible tools only', async () => {
  const srv = await fakeServer({ 'GET /v1/models': { body: { data: [{ id: 'cc/claude', owned_by: '9router' }] } } });
  try {
    const c = router.create('9router', { flavor: '9router', baseUrl: srv.url }, { secrets: secretsFor({}) });
    const t = tools(c);
    assert.deepEqual(Object.keys(t), ['health', 'list_models']);
    assert.equal((await t.health.run({})).models, 1);
    assert.equal((await c.health()).ok, true);
  } finally { await srv.close(); }
});

test('rejects unknown flavors', () => {
  assert.throws(() => router.create('r', { flavor: 'litellm' }, { secrets: secretsFor({}) }), /flavor must be/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/n8n.test.js test/router.test.js`
Expected: FAIL with `Cannot find module`

- [ ] **Step 4: Implement n8n** (`lib/connectors/n8n.js`)

```js
// n8n through its public REST API (header X-N8N-API-KEY). The public API has no "run" endpoint,
// so running a workflow goes through a webhook that must be allowlisted in config.
const { makeClient, tool, S, timedHealth } = require('./base');

const enc = encodeURIComponent;
const summarize = (w) => ({ id: w.id, name: w.name, active: w.active, tags: (w.tags || []).map((t) => t.name), updatedAt: w.updatedAt });

module.exports = {
  type: 'n8n',
  create(id, cfg, { secrets }) {
    const key = secrets.resolve(cfg.apiKey, 'apiKey');
    if (!key) throw new Error('apiKey is required (n8n Settings → n8n API)');
    const api = makeClient({ baseUrl: cfg.baseUrl, headers: { 'x-n8n-api-key': key }, mask: secrets.mask });
    const hooks = cfg.webhooks && typeof cfg.webhooks === 'object' ? cfg.webhooks : {};
    for (const [name, url] of Object.entries(hooks)) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error(`webhooks.${name} must be an http(s) URL`);
    }
    const hookClient = makeClient({ baseUrl: cfg.baseUrl, mask: secrets.mask }); // webhooks never get the API key

    const tools = [
      tool('list_workflows', 'Workflows with their active state and tags.', {
        active: S.bool('Only active (true) or inactive (false) workflows'), tags: S.str('Comma-separated tag names'),
        name: S.str('Filter by name'), limit: S.int('Max workflows (default 50)', 250),
      }, async (a) => {
        const r = await api('GET', '/api/v1/workflows', { query: { active: a.active, tags: a.tags, name: a.name, limit: a.limit || 50 } });
        return { workflows: ((r && r.data) || []).map(summarize), nextCursor: (r && r.nextCursor) || null };
      }),
      tool('get_workflow', 'One workflow: its nodes (name and type, never credentials) and settings.', { id: S.str('Workflow id') }, async (a) => {
        const w = await api('GET', `/api/v1/workflows/${enc(a.id)}`);
        return { ...summarize(w), nodes: (w.nodes || []).map((n) => ({ name: n.name, type: n.type, disabled: !!n.disabled })), settings: w.settings || {} };
      }, { required: ['id'] }),
      tool('list_executions', 'Recent executions, newest first.', {
        workflowId: S.str('Only this workflow'), status: S.enum(['success', 'error', 'waiting', 'running', 'canceled'], 'Only this status'),
        limit: S.int('Max executions (default 20)', 250),
      }, async (a) => {
        const r = await api('GET', '/api/v1/executions', { query: { workflowId: a.workflowId, status: a.status, limit: a.limit || 20 } });
        return { executions: (r && r.data) || [], nextCursor: (r && r.nextCursor) || null };
      }),
      tool('get_execution', 'One execution. Node data is left out unless includeData is true.', {
        id: S.str('Execution id'), includeData: S.bool('Include node input and output data (can be large)'),
      }, (a) => api('GET', `/api/v1/executions/${enc(a.id)}`, { query: { includeData: a.includeData ? 'true' : undefined } }), { required: ['id'] }),
    ];

    const names = Object.keys(hooks);
    if (names.length) {
      tools.push(tool('run_workflow', `Trigger a workflow through an allowlisted webhook. Available: ${names.join(', ')}.`, {
        name: S.enum(names, 'Webhook name from config'), payload: S.obj('JSON body sent to the webhook'),
      }, (a) => {
        const url = hooks[a.name];
        if (!url) throw new Error(`"${a.name}" is not in the webhooks allowlist`);
        return hookClient('POST', `webhook ${a.name}`, { url, body: a.payload || {} });
      }, { required: ['name'], write: true, annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true } }));
    }
    tools.push(tool('set_workflow_active', 'Activate or deactivate a workflow.', {
      id: S.str('Workflow id'), active: S.bool('true to activate, false to deactivate'),
    }, async (a) => summarize(await api('POST', `/api/v1/workflows/${enc(a.id)}/${a.active ? 'activate' : 'deactivate'}`)),
    { required: ['id', 'active'], write: true, annotations: { destructiveHint: false, idempotentHint: true } }));

    return { tools, health: () => timedHealth(async () => { await api('GET', '/api/v1/workflows', { query: { limit: 1 } }); }) };
  },
};
```

- [ ] **Step 5: Implement router** (`lib/connectors/router.js`)

```js
// OpenAI-compatible AI routers. OmniRoute also has a management API (/api/*) reachable with an
// access token (`omniroute tokens create --scope read`); 9router is reached through /v1 only.
// Chat completions are deliberately left out: they spend tokens.
const { makeClient, tool, S, timedHealth } = require('./base');

const FLAVORS = ['omniroute', '9router'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const PROVIDER_FIELDS = ['id', 'provider', 'name', 'displayName', 'authType', 'isActive', 'testStatus', 'priority', 'backoffLevel', 'lastHealthCheckAt', 'expiresAt'];

module.exports = {
  type: 'router',
  create(id, cfg, { secrets }) {
    const flavor = cfg.flavor || 'omniroute';
    if (!FLAVORS.includes(flavor)) throw new Error(`flavor must be one of ${FLAVORS.join(', ')}`);
    const baseUrl = cfg.baseUrl || 'http://localhost:20128';
    const apiKey = secrets.resolve(cfg.apiKey, 'apiKey');
    const mgmt = secrets.resolve(cfg.managementToken, 'managementToken');
    const v1 = makeClient({ baseUrl, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, mask: secrets.mask });
    const manage = makeClient({ baseUrl, headers: mgmt ? { authorization: `Bearer ${mgmt}` } : {}, mask: secrets.mask });
    const listV1 = async () => (((await v1('GET', '/v1/models')) || {}).data || []).map((m) => ({ id: m.id, owned_by: m.owned_by }));

    if (flavor === '9router') {
      return {
        tools: [
          tool('health', 'Whether 9router answers, with its model count and latency.', {}, async () => {
            const started = Date.now();
            const models = await listV1();
            return { ok: true, models: models.length, latencyMs: Date.now() - started };
          }),
          tool('list_models', 'Models and combos 9router can serve.', {}, async () => ({ models: await listV1() })),
        ],
        health: () => timedHealth(async () => `${(await listV1()).length} models`),
      };
    }

    const tools = [
      tool('health', 'OmniRoute health, plus degraded features when a management token is set.', {}, async () => ({
        health: await manage('GET', '/api/health'),
        ...(mgmt ? { degradation: await manage('GET', '/api/health/degradation').catch((err) => ({ error: err.message })) } : {}),
      })),
    ];
    if (apiKey || mgmt) {
      tools.push(tool('list_models', 'Models and combos OmniRoute can serve.', {}, async () => (mgmt ? manage('GET', '/api/models') : { models: await listV1() })));
    }
    if (mgmt) {
      tools.push(
        tool('list_providers', 'Provider connections and their health (credentials and emails left out).', {}, async () => {
          const r = (await manage('GET', '/api/providers')) || {};
          return { total: r.total, connections: (r.connections || []).map((c) => pick(c, PROVIDER_FIELDS)) };
        }),
        tool('list_combos', 'Combos: model chains OmniRoute falls back across.', {}, () => manage('GET', '/api/combos')),
        tool('usage', 'Requests, tokens, cost, latency and errors through OmniRoute.', { period: S.enum(['day', 'week', 'month'], 'Window (default day)') }, async (a) => {
          const period = a.period || 'day';
          const r = (await manage('GET', '/api/usage/analytics', { query: { period } })) || {};
          return { period, summary: r.summary, byModel: r.byModel, byProvider: r.byProvider, dailyTrend: r.dailyTrend, errorBreakdown: r.errorBreakdown };
        }),
        tool('telemetry', 'Latency percentiles, error rate, active sessions and quota monitor state.', {}, () => manage('GET', '/api/telemetry/summary')),
      );
    }
    return { tools, health: () => timedHealth(async () => { await manage('GET', '/api/health'); }) };
  },
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/n8n.test.js test/router.test.js && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/connectors/n8n.js lib/connectors/router.js test/n8n.test.js test/router.test.js
git commit -m "Add n8n and AI router connectors"
```

---

### Task 9: Generic HTTP connector (AION and others)

**Files:**
- Create: `lib/connectors/http.js`, `test/http.test.js`

**Interfaces:**
- Produces: type `http`. One tool per `endpoints[]` entry. After this task, `test/mcp.test.js` passes fully.

- [ ] **Step 1: Write the failing test** (`test/http.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const http = require('../lib/connectors/http');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));
const cfg = (url, endpoints, extra = {}) => ({ baseUrl: url, auth: { header: 'Authorization', prefix: 'Bearer ', secret: { env: 'AION' } }, endpoints, ...extra });

test('GET endpoints fill path parameters and send the rest as query', async () => {
  const srv = await fakeServer({ 'GET /api/agents/a1/runs': { body: { runs: [] } } });
  try {
    const c = http.create('aion', cfg(srv.url, [{ name: 'list_runs', method: 'GET', path: '/api/agents/{agentId}/runs', description: 'Runs', params: { status: { type: 'string' } } }]), { secrets: secretsFor({ AION: 'aion-token-1' }) });
    const t = tools(c).list_runs;
    assert.deepEqual(t.inputSchema.required, ['agentId']);
    assert.equal(t.write, false);
    await t.run({ agentId: 'a1', status: 'failed' });
    assert.deepEqual(srv.requests[0].query, { status: 'failed' });
    assert.equal(srv.requests[0].headers.authorization, 'Bearer aion-token-1');
  } finally { await srv.close(); }
});

test('POST endpoints send a JSON body merged over the fixed body and are writes by default', async () => {
  const srv = await fakeServer({ 'POST /api/agents/a1/invoke': (r) => ({ body: { got: r.body } }) });
  try {
    const c = http.create('aion', cfg(srv.url, [
      { name: 'invoke', method: 'POST', path: '/api/agents/{agentId}/invoke', params: { input: { type: 'string' } }, body: { mode: 'async' } },
      { name: 'search', method: 'POST', path: '/api/search', write: false },
    ]), { secrets: secretsFor({ AION: 'aion-token-1' }) });
    const t = tools(c);
    assert.equal(t.invoke.write, true);
    assert.equal(t.search.write, false);
    assert.deepEqual(await t.invoke.run({ agentId: 'a1', input: 'hi' }), { got: { mode: 'async', input: 'hi' } });
  } finally { await srv.close(); }
});

test('health is unchecked without healthPath and checked with it', async () => {
  const srv = await fakeServer({ 'GET /health': { body: { ok: true } } });
  try {
    const s = secretsFor({ AION: 'aion-token-1' });
    assert.equal((await http.create('a', cfg(srv.url, [{ name: 'x', path: '/x' }]), { secrets: s }).health()).ok, null);
    assert.equal((await http.create('a', cfg(srv.url, [{ name: 'x', path: '/x' }], { healthPath: '/health' }), { secrets: s }).health()).ok, true);
  } finally { await srv.close(); }
});

test('validates endpoint definitions and plain headers', () => {
  const s = secretsFor({ AION: 'aion-token-1' });
  assert.throws(() => http.create('a', cfg('http://x', []), { secrets: s }), /endpoints must be a non-empty list/);
  assert.throws(() => http.create('a', cfg('http://x', [{ name: 'Bad-Name', path: '/x' }]), { secrets: s }), /endpoints\[0\].name/);
  assert.throws(() => http.create('a', cfg('http://x', [{ name: 'x', method: 'TRACE', path: '/x' }]), { secrets: s }), /method must be one of/);
  assert.throws(() => http.create('a', cfg('http://x', [{ name: 'x', path: 'x' }]), { secrets: s }), /path must start with \//);
  assert.throws(() => http.create('a', cfg('http://x', [{ name: 'x', path: '/x' }], { headers: { 'X-Key': { env: 'AION' } } }), { secrets: s }), /headers.X-Key must be a string/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/http.test.js`
Expected: FAIL with `Cannot find module '../lib/connectors/http'`

- [ ] **Step 3: Implement** (`lib/connectors/http.js`)

```js
// Generic HTTP integration: each endpoint declared in config becomes one tool. Used for AION
// and any other REST service that has no dedicated connector. Path placeholders such as
// {agentId} come from the arguments; the remaining arguments go to the query string (GET,
// DELETE) or the JSON body (POST, PUT, PATCH). Anything but GET counts as a write unless the
// endpoint says write: false.
const { makeClient, authHeaders, tool, timedHealth } = require('./base');

const NAME = /^[a-z0-9_]{1,48}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function plainHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (typeof v !== 'string') throw new Error(`headers.${k} must be a string; put secrets in auth`);
    out[k] = v;
  }
  return out;
}

module.exports = {
  type: 'http',
  create(id, cfg, { secrets }) {
    const api = makeClient({ baseUrl: cfg.baseUrl, headers: { ...plainHeaders(cfg.headers), ...authHeaders(cfg.auth, secrets) }, mask: secrets.mask });
    if (!Array.isArray(cfg.endpoints) || !cfg.endpoints.length) throw new Error('endpoints must be a non-empty list');

    const tools = cfg.endpoints.map((ep, i) => {
      if (!ep || !NAME.test(ep.name || '')) throw new Error(`endpoints[${i}].name must match [a-z0-9_]{1,48}`);
      const method = String(ep.method || 'GET').toUpperCase();
      if (!METHODS.includes(method)) throw new Error(`endpoints[${i}].method must be one of ${METHODS.join(', ')}`);
      if (typeof ep.path !== 'string' || !ep.path.startsWith('/')) throw new Error(`endpoints[${i}].path must start with /`);
      const placeholders = [...ep.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const properties = {
        ...Object.fromEntries(placeholders.map((p) => [p, { type: 'string', description: `Path parameter ${p}` }])),
        ...(ep.params && typeof ep.params === 'object' ? ep.params : {}),
      };
      const inBody = ['POST', 'PUT', 'PATCH'].includes(method);
      return tool(ep.name, ep.description || `${method} ${ep.path}`, properties, (args) => {
        const rest = { ...args };
        const path = ep.path.replace(/\{(\w+)\}/g, (_, k) => { const v = rest[k]; delete rest[k]; return encodeURIComponent(String(v)); });
        return api(method, path, inBody ? { body: { ...(ep.body || {}), ...rest } } : { query: rest });
      }, {
        required: [...new Set([...placeholders, ...(Array.isArray(ep.required) ? ep.required : [])])],
        write: typeof ep.write === 'boolean' ? ep.write : method !== 'GET',
        annotations: { destructiveHint: method === 'DELETE', idempotentHint: method !== 'POST' },
      });
    });

    const health = cfg.healthPath
      ? () => timedHealth(async () => { await api('GET', cfg.healthPath); })
      : async () => ({ ok: null, latencyMs: null, detail: 'configured, not checked' });
    return { tools, health };
  },
};
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS, including `test/mcp.test.js` (`extra_ping` now listed).

- [ ] **Step 5: Commit**

```bash
git add lib/connectors/http.js test/http.test.js
git commit -m "Add generic HTTP connector for AION and other APIs"
```

---

### Task 10: MCP client and upstream MCP proxy

**Files:**
- Create: `lib/mcp/client.js`, `lib/connectors/mcp-proxy.js`, `test/mcp-proxy.test.js`

**Interfaces:**
- Consumes: `authHeaders`, `timedHealth`, `RAW` from base.
- Produces:
  - `createClient({ url, headers?, mask?, timeoutMs?, fetchImpl?, clientInfo? }) → { initialize(), listTools() → Tool[], callTool(name, args) → { content, isError } }`.
  - type `mcp`: `tools()` returns the filtered upstream tools (each with `skipCheck: true`, `write` unless `readOnlyHint: true`), and `health()`.

- [ ] **Step 1: Write the failing test** (`test/mcp-proxy.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const httpm = require('http');
const { secretsFor } = require('./helpers');
const proxy = require('../lib/connectors/mcp-proxy');
const { RAW } = require('../lib/connectors/base');

// A fake Streamable HTTP MCP server: JSON for initialize and calls, SSE for tools/list.
async function fakeMcp() {
  const seen = [];
  const server = httpm.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'], auth: req.headers.authorization, version: req.headers['mcp-protocol-version'] });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'up', version: '1' } } }));
      }
      if (!('id' in msg)) { res.writeHead(202); return res.end(); }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const tools = [
          { name: 'health_check', description: 'h', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'usage_get', description: 'u', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'combo_delete', description: 'd', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
          { name: 'secret_dump', description: 's', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        ];
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } })}\n\n`);
      }
      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called ${msg.params.name}` }] } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('lists filtered upstream tools and forwards calls with the session', async () => {
  const up = await fakeMcp();
  try {
    const c = proxy.create('om', { url: up.url, auth: { prefix: 'Bearer ', secret: { env: 'T' } }, include: ['health_*', 'usage_*', 'combo_*'], exclude: ['*secret*'] }, { secrets: secretsFor({ T: 'oma_live_x1' }) });
    const tools = await c.tools();
    assert.deepEqual(tools.map((t) => [t.name, t.write]), [['health_check', false], ['usage_get', false], ['combo_delete', true]]);
    assert.equal(tools[0].skipCheck, true);
    const r = await tools[0].run({});
    assert.equal(r[RAW], true);
    assert.deepEqual(r.content, [{ type: 'text', text: 'called health_check' }]);
    assert.deepEqual(up.seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(up.seen[2].session, 'sess-1');
    assert.equal(up.seen[2].version, '2025-06-18');
    assert.equal(up.seen[0].auth, 'Bearer oma_live_x1');
    await c.tools();
    assert.equal(up.seen.filter((s) => s.method === 'tools/list').length, 1, 'tool list is cached');
    assert.equal((await c.health()).ok, true);
  } finally { await up.close(); }
});

test('reports an unreachable upstream as a failed health check', async () => {
  const c = proxy.create('x', { url: 'http://127.0.0.1:9/mcp' }, { secrets: secretsFor({}) });
  const h = await c.health();
  assert.equal(h.ok, false);
});

test('requires an http(s) url', () => {
  assert.throws(() => proxy.create('x', {}, { secrets: secretsFor({}) }), /url must start with http/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mcp-proxy.test.js`
Expected: FAIL with `Cannot find module '../lib/connectors/mcp-proxy'`

- [ ] **Step 3: Implement the client** (`lib/mcp/client.js`)

```js
// Minimal MCP client over Streamable HTTP: initialize, list tools, call tools. Replies may come
// back as JSON or as a server-sent event stream; the stream is read only until our reply arrives.
const PROTOCOL = '2025-06-18';

async function readSse(res, id) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let msg;
      try { msg = JSON.parse(data); } catch { continue; }
      if (msg && msg.id === id) return msg; // leaving the loop cancels the rest of the stream
    }
  }
  return null;
}

function createClient({ url, headers = {}, mask = (s) => s, timeoutMs = 30000, fetchImpl = fetch, clientInfo = { name: 'ai-command-center', version: '1.0.0' } }) {
  let session = null;
  let protocol = null;
  let nextId = 1;
  let ready = null;

  async function post(msg) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(session ? { 'mcp-session-id': session } : {}),
          ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
          ...headers,
        },
        body: JSON.stringify(msg),
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) session = sid;
      if (!res.ok) throw new Error(`HTTP ${res.status} from upstream MCP: ${(await res.text()).slice(0, 300)}`);
      if (!('id' in msg)) { await res.text(); return null; }
      const type = res.headers.get('content-type') || '';
      const reply = type.includes('text/event-stream') ? await readSse(res, msg.id) : JSON.parse(await res.text());
      if (!reply) throw new Error('upstream MCP sent no reply');
      if (reply.error) throw new Error(`upstream MCP error ${reply.error.code}: ${reply.error.message}`);
      return reply.result;
    } catch (err) {
      throw new Error(mask(err.name === 'AbortError' ? `upstream MCP timed out after ${timeoutMs / 1000}s` : err.message));
    } finally {
      clearTimeout(timer);
    }
  }

  async function init() {
    const r = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo } });
    protocol = (r && r.protocolVersion) || PROTOCOL;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }
  const initialize = () => (ready ||= init().catch((err) => { ready = null; session = null; throw err; }));

  async function request(method, params) {
    await initialize();
    try {
      return await post({ jsonrpc: '2.0', id: nextId++, method, params });
    } catch (err) {
      if (!/HTTP 404/.test(err.message) || !session) throw err;
      session = null; ready = null; // session expired upstream: start a new one once
      await initialize();
      return post({ jsonrpc: '2.0', id: nextId++, method, params });
    }
  }

  async function listTools() {
    const tools = [];
    let cursor;
    do {
      const r = await request('tools/list', cursor ? { cursor } : {});
      tools.push(...((r && r.tools) || []));
      cursor = r && r.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools;
  }

  return { initialize, listTools, callTool: (name, args) => request('tools/call', { name, arguments: args || {} }) };
}

module.exports = { createClient };
```

- [ ] **Step 4: Implement the proxy connector** (`lib/connectors/mcp-proxy.js`)

```js
// Re-exposes the tools of an upstream MCP server (Streamable HTTP) under this integration's
// prefix, filtered by include/exclude globs. A tool counts as a write unless the upstream marks
// it readOnlyHint: true, so it stays hidden without allowWrite.
const { createClient } = require('../mcp/client');
const { authHeaders, timedHealth, RAW } = require('./base');

const TTL = 5 * 60 * 1000;
const glob = (p) => new RegExp('^' + String(p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

module.exports = {
  type: 'mcp',
  create(id, cfg, { secrets }) {
    if (typeof cfg.url !== 'string' || !/^https?:\/\//.test(cfg.url)) throw new Error('url must start with http:// or https://');
    const client = createClient({ url: cfg.url, headers: authHeaders(cfg.auth, secrets), mask: secrets.mask });
    const include = (Array.isArray(cfg.include) && cfg.include.length ? cfg.include : ['*']).map(glob);
    const exclude = (Array.isArray(cfg.exclude) ? cfg.exclude : []).map(glob);
    let cache = null;

    async function tools() {
      if (cache && Date.now() - cache.at < TTL) return cache.list;
      const list = (await client.listTools())
        .filter((t) => include.some((r) => r.test(t.name)) && !exclude.some((r) => r.test(t.name)))
        .map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object' },
          write: !(t.annotations && t.annotations.readOnlyHint === true),
          annotations: t.annotations || {},
          skipCheck: true, // the upstream validates its own arguments
          run: async (args) => {
            const r = await client.callTool(t.name, args);
            return { [RAW]: true, content: (r && r.content) || [], isError: !!(r && r.isError) };
          },
        }));
      cache = { at: Date.now(), list };
      return list;
    }

    return { tools, health: () => timedHealth(async () => `${(await tools()).length} tools`) };
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/mcp-proxy.test.js && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/mcp/client.js lib/connectors/mcp-proxy.js test/mcp-proxy.test.js
git commit -m "Add Streamable HTTP MCP client and upstream proxy connector"
```

---

### Task 11: Client registration and Kiro detection

**Files:**
- Create: `scripts/register-mcp.js`, `test/register.test.js`
- Modify: `lib/processes.js` (the `APPS` list), `public/app.js` (the `APPS` meta object)

**Interfaces:**
- Produces: `run(target, { remove?, dryRun?, home?, exec?, log? })`, `clients(home?) → { claude, kiro, antigravity }` each `{ name, file, cli? }`, `isRegistered(file) → boolean`, `NAME = 'ai-command-center'`.

- [ ] **Step 1: Write the failing test** (`test/register.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, clients, isRegistered, NAME } = require('../scripts/register-mcp');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acc-home-'));
const quiet = () => {};

test('kiro: creates the settings file with our entry and no backup', () => {
  const home = tmpHome();
  run('kiro', { home, log: quiet });
  const file = clients(home).kiro.file;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.mcpServers[NAME].command, process.execPath);
  assert.match(data.mcpServers[NAME].args[0], /mcp\.js$/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp.json']);
});

test('antigravity: merges into an empty file, keeps other servers, backs up first', () => {
  const home = tmpHome();
  const file = clients(home).antigravity.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  run('antigravity', { home, log: quiet });
  const withOther = JSON.parse(fs.readFileSync(file, 'utf8'));
  withOther.mcpServers.other = { command: 'x' };
  fs.writeFileSync(file, JSON.stringify(withOther));
  run('antigravity', { home, log: quiet, remove: true });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['other']);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('mcp_config.json.bak-')));
});

test('a second registration changes nothing', () => {
  const home = tmpHome();
  const logs = [];
  run('kiro', { home, log: quiet });
  run('kiro', { home, log: (m) => logs.push(m) });
  assert.match(logs[0], /already registered/);
});

test('refuses to touch invalid JSON', () => {
  const home = tmpHome();
  const file = clients(home).kiro.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => run('kiro', { home, log: quiet }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('claude: uses the claude CLI, or prints the command when it is missing', () => {
  const home = tmpHome();
  const calls = [];
  run('claude', { home, log: quiet, exec: (cmd, args) => { calls.push([cmd, ...args]); } });
  assert.deepEqual(calls[0].slice(0, 5), ['claude', 'mcp', 'add', '--scope', 'user']);
  assert.equal(calls[0][5], NAME);
  const logs = [];
  run('claude', { home, log: (m) => logs.push(m), exec: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } });
  assert.match(logs[0], /claude CLI not found/);
});

test('claude dry run prints without running; isRegistered reads mcpServers', () => {
  const home = tmpHome();
  const logs = [];
  run('claude', { home, dryRun: true, log: (m) => logs.push(m), exec: () => { throw new Error('should not run'); } });
  assert.match(logs[0], /^\[dry-run\] claude mcp add --scope user ai-command-center -- /);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { [NAME]: {} } }));
  assert.equal(isRegistered(path.join(home, '.claude.json')), true);
  assert.equal(isRegistered(path.join(home, 'none.json')), false);
});

test('unknown client', () => {
  assert.throws(() => run('cursor', { home: tmpHome(), log: quiet }), /unknown client "cursor"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/register.test.js`
Expected: FAIL with `Cannot find module '../scripts/register-mcp'`

- [ ] **Step 3: Implement** (`scripts/register-mcp.js`)

```js
#!/usr/bin/env node
// Registers this MCP server in Claude Code, Kiro and Antigravity, or removes it again.
//   node scripts/register-mcp.js <claude|kiro|antigravity|all> [--remove] [--dry-run]
// Config files are backed up before every write and only our own entry is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'ai-command-center';
const MCP = path.resolve(__dirname, '..', 'mcp.js');

function clients(home = os.homedir()) {
  return {
    claude: { name: 'Claude Code', file: path.join(home, '.claude.json'), cli: true },
    kiro: { name: 'Kiro', file: path.join(home, '.kiro', 'settings', 'mcp.json') },
    antigravity: { name: 'Antigravity', file: path.join(home, '.gemini', 'config', 'mcp_config.json') },
  };
}
const entry = () => ({ command: process.execPath, args: [MCP] });

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON; fix or move it first, nothing was changed`); }
}

function isRegistered(file) {
  try { const s = readJson(file).mcpServers; return !!(s && s[NAME]); } catch { return false; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function claudeArgs(remove) {
  return remove ? ['mcp', 'remove', '--scope', 'user', NAME] : ['mcp', 'add', '--scope', 'user', NAME, '--', process.execPath, MCP];
}

function run(target, { remove = false, dryRun = false, home, exec = execFileSync, log = console.log } = {}) {
  const all = clients(home);
  const ids = target === 'all' ? Object.keys(all) : [target];
  for (const id of ids) {
    const c = all[id];
    if (!c) throw new Error(`unknown client "${id}" (use claude, kiro, antigravity or all)`);
    if (c.cli) {
      const args = claudeArgs(remove);
      if (dryRun) { log(`[dry-run] claude ${args.join(' ')}`); continue; }
      if (isRegistered(c.file) !== remove) { log(`${c.name}: already ${remove ? 'absent' : 'registered'}`); continue; }
      try { exec('claude', args, { stdio: 'inherit' }); log(`${c.name}: ${remove ? 'removed' : 'registered'} (user scope)`); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        log(`claude CLI not found. Run this yourself:\n  claude ${args.join(' ')}`);
      }
      continue;
    }
    const data = readJson(c.file);
    const servers = { ...(data.mcpServers || {}) };
    const before = JSON.stringify(servers[NAME]);
    if (remove) delete servers[NAME]; else servers[NAME] = entry();
    const next = { ...data, mcpServers: servers };
    if (dryRun) { log(`[dry-run] ${c.file}\n${JSON.stringify(next, null, 2)}`); continue; }
    if (before === JSON.stringify(servers[NAME])) { log(`${c.name}: already ${remove ? 'absent' : 'registered'} (${c.file})`); continue; }
    writeJson(c.file, next);
    log(`${c.name}: ${remove ? 'removed from' : 'registered in'} ${c.file}`);
  }
}

module.exports = { run, clients, isRegistered, NAME };

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: npm run mcp:register -- <claude|kiro|antigravity|all> [--remove] [--dry-run]'); process.exit(2); }
  try { run(target, { remove: args.includes('--remove'), dryRun: args.includes('--dry-run') }); } catch (err) { console.error(err.message); process.exit(1); }
}
```

- [ ] **Step 4: Add Kiro to process detection** (`lib/processes.js`)

In the `APPS` array, insert this line directly after the `cursor` entry:

```js
  { id: 'kiro', name: 'Kiro', re: /\/Kiro\.app\/|kiro-cli/i, paths: ['/Applications/Kiro.app', '~/.kiro'] },
```

- [ ] **Step 5: Add Kiro to the UI app meta** (`public/app.js`)

In the `APPS` object, insert after the `cursor:` line:

```js
  kiro: { name: 'KIRO', role: 'Spec-driven agentic IDE', icon: 'code', chip: 'amber', desc: 'Kiro IDE and CLI. Live presence and resource use only; it can use the AI Command Center MCP server.' },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/register.test.js && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add scripts/register-mcp.js test/register.test.js lib/processes.js public/app.js
git commit -m "Add MCP client registration for Claude Code, Kiro, Antigravity; detect Kiro"
```

---

### Task 12: Dashboard Integrations page

**Files:**
- Modify: `server.js`, `lib/demo.js`, `public/app.js`, `public/index.html`, `public/styles.css`
- Create: `public/integrations.js`

**Interfaces:**
- Consumes: `createIntegrations`, `createSecrets`, `createAudit`, `createLocal`, `register.clients/isRegistered`.
- Produces: `GET /api/integrations → { integrations: Status[], clients: [{ id, name, file, registered, command }], calls: AuditEntry[], mcpCommand }`; `POST /api/integrations/test` with `{ id }` returning `Status`; `demo.integrations()` with the same shape; `viewIntegrations()` in the browser.

- [ ] **Step 1: Keep `integrations` in config and add routes** (`server.js`)

Add the requires below the existing `const { getVault } = require('./lib/vault');`:

```js
const { createIntegrations } = require('./lib/integrations');
const { createSecrets } = require('./lib/secrets');
const { createAudit } = require('./lib/audit');
const { createLocal } = require('./lib/local');
const register = require('./scripts/register-mcp');
```

In `loadConfig()`, add this field to the returned object, after `vaultPaths`:

```js
    integrations: c.integrations && typeof c.integrations === 'object' && !Array.isArray(c.integrations) ? c.integrations : {},
```

After `const memo = new Map();`, add:

```js
// Integrations are rebuilt whenever config.json changes on disk (they are edited in the file).
const audit = createAudit(path.join(DIR, '.cache', 'mcp-audit.jsonl'));
let integ = { mtimeMs: -1, registry: null };
function getIntegrations() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(CONFIG_FILE).mtimeMs; } catch { /* no config yet */ }
  if (!integ.registry || integ.mtimeMs !== mtimeMs) {
    const local = createLocal({ cacheDir: path.join(DIR, '.cache'), config, indexer });
    const registry = createIntegrations({ config, secrets: createSecrets(), audit, local });
    local.integrationsStatus = () => registry.status();
    integ = { mtimeMs, registry };
  }
  return integ.registry;
}
function clientRows() {
  return Object.entries(register.clients()).map(([id, c]) => ({
    id, name: c.name, file: c.file.replace(os.homedir(), '~'), registered: register.isRegistered(c.file), command: `npm run mcp:register -- ${id}`,
  }));
}
```

Change the `GET /api/config` route so integrations (references and webhook URLs) are not sent to the page:

```js
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const { integrations, ...rest } = config;
      return send(res, 200, rest);
    }
```

Change the end of the `POST /api/config` route so that the response is filtered in the same way: replace `return send(res, 200, config);` (the one inside the POST branch) with:

```js
      const { integrations, ...rest } = config;
      return send(res, 200, rest);
```

The POST handler starts from `const next = { ...config };`, which now carries `integrations`, so saving Settings keeps them in `config.json`.

Add these routes before the `/api/rescan` route:

```js
    if (url.pathname === '/api/integrations' && req.method === 'GET') {
      if (DEMO) return send(res, 200, demo.integrations());
      return send(res, 200, { integrations: await getIntegrations().status(), clients: clientRows(), calls: audit.tail(100), mcpCommand: `${process.execPath} ${path.join(DIR, 'mcp.js')}` });
    }
    if (url.pathname === '/api/integrations/test' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const { id } = JSON.parse(await readBody(req));
      if (DEMO) { const s = demo.integrations().integrations.find((i) => i.id === id); return s ? send(res, 200, s) : send(res, 404, { error: 'unknown integration' }); }
      const [s] = await getIntegrations().status({ fresh: true, only: String(id || '') });
      return s ? send(res, 200, s) : send(res, 404, { error: 'unknown integration' });
    }
```

- [ ] **Step 2: Demo payload** (`lib/demo.js`)

Add above `module.exports`:

```js
function integrations(now = Date.now()) {
  const r = rng(7);
  const list = [
    { id: 'acc', type: 'acc', enabled: true, allowWrite: false, tools: 4, writeTools: 0, state: 'ok', latencyMs: 0, detail: 'local' },
    { id: 'dynatrace-saas', type: 'dynatrace', enabled: true, allowWrite: false, tools: 7, writeTools: 0, state: 'ok', latencyMs: 182 },
    { id: 'dynatrace-managed', type: 'dynatrace', enabled: true, allowWrite: false, tools: 6, writeTools: 0, state: 'error', latencyMs: 15003, error: 'timeout after 15s: GET /api/v2/problems' },
    { id: 'phoenix', type: 'arize', flavor: 'phoenix', enabled: true, allowWrite: false, tools: 5, writeTools: 0, state: 'ok', latencyMs: 41 },
    { id: 'n8n', type: 'n8n', enabled: true, allowWrite: true, tools: 6, writeTools: 2, state: 'ok', latencyMs: 96 },
    { id: 'omniroute', type: 'router', flavor: 'omniroute', enabled: true, allowWrite: false, tools: 6, writeTools: 0, state: 'ok', latencyMs: 12 },
    { id: '9router', type: 'router', flavor: '9router', enabled: false, allowWrite: false, tools: 0, writeTools: 0, state: 'disabled' },
    { id: 'aion', type: 'http', enabled: true, allowWrite: true, tools: 3, writeTools: 1, state: 'unchecked', detail: 'configured, not checked' },
  ];
  const tools = ['dynatrace-saas_list_problems', 'phoenix_search_spans', 'acc_usage_summary', 'n8n_list_executions', 'omniroute_usage', 'n8n_run_workflow', 'dynatrace-managed_list_problems', 'aion_list_agents'];
  const calls = Array.from({ length: 24 }, (_, i) => {
    const tool = pick(r, tools);
    const ok = !tool.startsWith('dynatrace-managed');
    return { ts: now - i * 37 * 60000 - Math.floor(r() * 600000), integration: tool.slice(0, tool.indexOf('_')), tool, ok, ms: ok ? 40 + Math.floor(r() * 900) : 15000, args: tool.includes('problems') ? ['from'] : tool.includes('spans') ? ['project', 'status_code'] : [] };
  });
  return {
    integrations: list,
    clients: [
      { id: 'claude', name: 'Claude Code', file: '~/.claude.json', registered: true, command: 'npm run mcp:register -- claude' },
      { id: 'kiro', name: 'Kiro', file: '~/.kiro/settings/mcp.json', registered: false, command: 'npm run mcp:register -- kiro' },
      { id: 'antigravity', name: 'Antigravity', file: '~/.gemini/config/mcp_config.json', registered: true, command: 'npm run mcp:register -- antigravity' },
    ],
    calls,
    mcpCommand: `/usr/local/bin/node ${HOME}/ai-command-center/mcp.js`,
  };
}
```

and change the export line to:

```js
module.exports = { buildResults, live, vault, integrations, config: { userName: 'Alex', host: 'MacBook Pro', monthlyBudgetUSD: 1000 } };
```

- [ ] **Step 3: The page** (`public/integrations.js`)

```js
'use strict';
/* Integrations: what the MCP server offers to AI clients, whether each connection is healthy,
   which clients have it registered, and the most recent tool calls (argument names only). */

const INTEG_TYPES = {
  acc: ['AI Command Center', 'pulse', 'blue'], dynatrace: ['Dynatrace', 'zap', 'violet'], arize: ['Arize', 'sparkle', 'green'],
  n8n: ['n8n', 'layers', 'amber'], router: ['AI router', 'cube', 'blue'], http: ['HTTP API', 'code', 'violet'], mcp: ['MCP proxy', 'plug', 'green'],
};
const INTEG_STATE = { ok: ['running', 'Connected'], error: ['error', 'Error'], disabled: ['off', 'Disabled'], unchecked: ['idle', 'Not checked'] };
const integ = { data: null, at: 0, loading: false, filter: 'all', testing: null };

async function loadIntegrations() {
  if (integ.loading) return;
  integ.loading = true;
  try { integ.data = await api('/api/integrations'); } catch (err) { integ.data = { error: err.message, integrations: [], clients: [], calls: [] }; }
  integ.at = Date.now();
  integ.loading = false;
  if (state.route === 'integrations') render(false);
}

function integCard(i) {
  const [label, ic, chip] = INTEG_TYPES[i.type] || [i.type || 'Unknown', 'plug', 'blue'];
  const [cls, text] = INTEG_STATE[i.state] || INTEG_STATE.unchecked;
  return `<div class="card integ-card">
    <div class="card-head"><span class="chip ${chip}">${icon(ic, 16)}</span>
      <div><h3>${esc(i.id)}</h3><div class="meta">${esc(label)}${i.flavor ? ` · ${esc(i.flavor)}` : ''}</div></div>
      <div class="right"><span class="status ${cls}" style="width:auto"><i></i>${text}</span></div></div>
    <div class="integ-stats"><span><b class="num">${i.tools || 0}</b> tools</span>
      ${i.latencyMs != null ? `<span><b class="num">${whole.format(i.latencyMs)}</b> ms</span>` : ''}
      ${i.writeTools ? `<span class="pill integ-write">write on · ${i.writeTools}</span>` : ''}</div>
    ${i.error ? `<p class="integ-error">${esc(i.error)}</p>` : i.detail ? `<p class="kpi-sub">${esc(i.detail)}</p>` : ''}
    <button class="btn ghost" type="button" data-integ-test="${esc(i.id)}" ${i.state === 'disabled' || integ.testing === i.id ? 'disabled' : ''}>${integ.testing === i.id ? 'Testing…' : 'Test'}</button>
  </div>`;
}

function viewIntegrations() {
  if (!integ.data || Date.now() - integ.at > 60000) loadIntegrations();
  if (!integ.data) return '<div class="skeleton" style="height:260px"></div>';
  const d = integ.data;
  const list = d.integrations || [];
  const okCount = list.filter((i) => i.state === 'ok').length;
  const calls = (d.calls || []).filter((c) => integ.filter === 'all' || c.integration === integ.filter);
  const ids = [...new Set((d.calls || []).map((c) => c.integration))];
  return `<div class="hero"><div><div class="eyebrow">INTEGRATIONS</div><h1>MCP connections</h1>
      <p>${okCount} of ${list.length} connected. AI clients reach these through <code>ai-command-center</code>; edit them in config.json.</p></div>
    <div class="hero-actions"><span class="pill">${icon('refresh', 14)}Checked ${ago(integ.at)}</span></div></div>
    ${d.error ? `<div class="card empty">Could not load integrations: ${esc(d.error)}</div>` : ''}
    <div class="grid integrations">${list.map(integCard).join('')}</div>
    <div class="section-head"><h2>Clients</h2><span class="meta">Where the MCP server is registered</span></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Client</th><th>Status</th><th>Config file</th><th>Register with</th></tr></thead><tbody>
      ${(d.clients || []).map((c) => `<tr><td><b>${esc(c.name)}</b></td>
        <td><span class="status ${c.registered ? 'running' : 'off'}" style="width:auto"><i></i>${c.registered ? 'Registered' : 'Not registered'}</span></td>
        <td class="muted">${esc(c.file)}</td><td><code>${esc(c.command)}</code></td></tr>`).join('')}
    </tbody></table></div>
    ${d.mcpCommand ? `<p class="kpi-sub">Server command: <code>${esc(d.mcpCommand)}</code></p>` : ''}</div>
    <div class="section-head"><h2>Recent tool calls</h2><span class="meta">Argument names only, never values</span>
      <label class="link"><select class="input" data-integ-filter><option value="all">All integrations</option>
        ${ids.map((id) => `<option ${id === integ.filter ? 'selected' : ''}>${esc(id)}</option>`).join('')}</select></label></div>
    <div class="card">${calls.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Tool</th><th>Result</th><th class="r">Duration</th><th>Arguments</th></tr></thead><tbody>
      ${calls.slice(0, 100).map((c) => `<tr><td class="num">${fmtDate(c.ts)}</td><td><code>${esc(c.tool)}</code></td>
        <td><span class="status ${c.ok ? 'running' : 'error'}" style="width:auto"><i></i>${c.ok ? 'OK' : 'Error'}</span></td>
        <td class="r num">${whole.format(c.ms)} ms</td><td class="muted">${esc((c.args || []).join(', ') || '–')}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No tool calls yet. Register a client, then ask it to use an ai-command-center tool.</div>'}</div>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-integ-test]');
  if (!b) return;
  const id = b.dataset.integTest;
  integ.testing = id;
  render(false);
  try {
    const s = await api('/api/integrations/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    integ.data.integrations = integ.data.integrations.map((i) => (i.id === id ? s : i));
  } catch (err) {
    integ.data.integrations = integ.data.integrations.map((i) => (i.id === id ? { ...i, state: 'error', error: err.message } : i));
  }
  integ.testing = null;
  render(false);
});
document.addEventListener('change', (e) => {
  const s = e.target.closest('[data-integ-filter]');
  if (!s) return;
  integ.filter = s.value;
  render(false);
});
```

- [ ] **Step 4: Wire the route, nav, icon and styles**

`public/app.js`:
- In `ICON_PATHS`, add after the `terminal:` entry:

```js
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>',
```

- In `TITLES`, add `integrations: 'INTEGRATIONS',` before `settings: 'SETTINGS'`.
- In `VIEWS`, add `integrations: viewIntegrations` after `live: viewLive`.
- In `render()`, change `if (!state.data && !['live', 'brain'].includes(state.route)) {` to `if (!state.data && !['live', 'brain', 'integrations'].includes(state.route)) {`.

`public/index.html`:
- After the Live monitor nav link, add:

```html
        <a href="#integrations" data-route="integrations"><span data-icon="plug"></span>Integrations</a>
```

- Add `<script src="integrations.js"></script>` directly before `<script src="app.js"></script>`.
- Change the workspace subtitle `Local only · 127.0.0.1` to `Local first · 127.0.0.1`.

`public/styles.css`: append:

```css
/* Integrations page */
.grid.integrations { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.integ-card { display: flex; flex-direction: column; gap: 10px; }
.integ-card .card-head { margin-bottom: 0; }
.integ-card .btn { align-self: flex-start; }
.integ-stats { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--text-2); }
.integ-write { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-ink); }
.integ-error { margin: 0; font-size: 12px; color: var(--bad); overflow-wrap: anywhere; }
.status.error { background: var(--bad-soft); color: var(--bad); }
```

- [ ] **Step 5: Check syntax and run the demo server**

Run:
```bash
node --check public/integrations.js && node --check public/app.js && node --check server.js
DEMO=1 PORT=4790 node server.js & sleep 1
curl -s http://127.0.0.1:4790/api/integrations | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.integrations.length, d.clients.length, d.calls.length)"
curl -s -X POST -H 'content-type: application/json' -d '{"id":"phoenix"}' http://127.0.0.1:4790/api/integrations/test
kill %1
```
Expected: `8 3 24`, then the phoenix status JSON.

- [ ] **Step 6: Run the real server against the live config**

Run:
```bash
PORT=4791 node server.js & sleep 2
curl -s http://127.0.0.1:4791/api/integrations | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.integrations.map(i=>i.id+':'+i.state).join(' '))"
curl -s http://127.0.0.1:4791/api/config | node -e "console.log('integrations' in JSON.parse(require('fs').readFileSync(0)))"
kill %1
```
Expected: `acc:ok` plus one item per configured integration; second line `false`.

- [ ] **Step 7: Visual check**

Open `http://localhost:4778/#integrations` with `npm run demo` in light and dark theme. Check that cards wrap at phone width, and that the Test button changes state.

- [ ] **Step 8: Commit**

```bash
npm test
git add server.js lib/demo.js public/integrations.js public/app.js public/index.html public/styles.css
git commit -m "Add Integrations page and API to the dashboard"
```

---

### Task 13: Documentation, example config, live setup on this Mac

**Files:**
- Create: `config.example.json`, `docs/integrations.md`
- Modify: `README.md`, `config.json` (local, git-ignored), client config files through `npm run mcp:register`

- [ ] **Step 1: Write `config.example.json`**

```json
{
  "userName": "",
  "monthlyBudgetUSD": 0,
  "integrations": {
    "dynatrace-saas": {
      "type": "dynatrace",
      "baseUrl": "https://abc12345.live.dynatrace.com",
      "token": { "keychain": "acc.dynatrace-saas" },
      "platformUrl": "https://abc12345.apps.dynatrace.com",
      "platformToken": { "keychain": "acc.dynatrace-saas-platform" }
    },
    "dynatrace-managed": {
      "type": "dynatrace",
      "baseUrl": "https://dynatrace.example.internal/e/1a2b3c4d-0000-0000-0000-000000000000",
      "token": { "keychain": "acc.dynatrace-managed" }
    },
    "phoenix": { "type": "arize", "flavor": "phoenix", "baseUrl": "http://localhost:6006", "apiKey": { "keychain": "acc.phoenix" } },
    "arize-ax": { "type": "arize", "flavor": "ax", "enabled": false, "apiKey": { "keychain": "acc.arize-ax" } },
    "n8n": {
      "type": "n8n",
      "baseUrl": "http://localhost:5678",
      "apiKey": { "keychain": "acc.n8n" },
      "allowWrite": true,
      "webhooks": { "daily-report": "http://localhost:5678/webhook/daily-report" }
    },
    "omniroute": { "type": "router", "flavor": "omniroute", "baseUrl": "http://localhost:20128", "managementToken": { "keychain": "acc.omniroute" } },
    "9router": { "type": "router", "flavor": "9router", "enabled": false, "baseUrl": "http://localhost:20128" },
    "aion": {
      "type": "http",
      "enabled": false,
      "baseUrl": "https://aion.example.com",
      "auth": { "header": "Authorization", "prefix": "Bearer ", "secret": { "keychain": "acc.aion" } },
      "healthPath": "/api/health",
      "endpoints": [
        { "name": "list_agents", "method": "GET", "path": "/api/agents", "description": "List AION agents" },
        { "name": "get_agent", "method": "GET", "path": "/api/agents/{agentId}", "description": "One AION agent" },
        { "name": "invoke_agent", "method": "POST", "path": "/api/agents/{agentId}/invoke", "description": "Run an AION agent", "params": { "input": { "type": "string", "description": "Task for the agent" } } }
      ]
    },
    "omniroute-mcp": {
      "type": "mcp",
      "enabled": false,
      "url": "http://localhost:20128/api/mcp/stream",
      "auth": { "prefix": "Bearer ", "secret": { "keychain": "acc.omniroute-admin" } },
      "include": ["*health*", "*usage*", "*quota*"]
    }
  }
}
```

- [ ] **Step 2: Write `docs/integrations.md`**

Write one section per platform, with these exact contents:

1. **Storing a secret.** `security add-generic-password -a "$USER" -s acc.<name> -w` (prompts for the value). Replace with `-U` to update. `{ "env": "NAME" }` also works, but GUI-launched clients often do not inherit shell variables, so Keychain is the default.
2. **Dynatrace SaaS.** Token: Access tokens → Generate, scopes `problems.read`, `entities.read`, `metrics.read`, `logs.read`, `securityProblems.read`. `baseUrl` is `https://<env-id>.live.dynatrace.com`. DQL needs a platform token with `storage:logs:read`, `storage:events:read`, `storage:metrics:read`, `storage:spans:read`, `storage:entities:read`, `storage:buckets:read`, and `platformUrl` `https://<env-id>.apps.dynatrace.com`.
3. **Dynatrace Managed.** Same API token scopes. `baseUrl` is `https://<cluster>/e/<environment-id>`. No DQL. Can run next to the existing `dynatrace-managed-mcp`.
4. **Arize Phoenix.** Local `http://localhost:6006`, with the key only if auth is enabled (Settings → API Keys). Phoenix Cloud: `https://app.phoenix.arize.com/s/<space>` with a key. Tools listed.
5. **Arize AX.** Key from Settings → API Keys, `flavor: "ax"`.
6. **n8n.** Settings → n8n API → Create an API key. `run_workflow` only targets names in `webhooks`. Use the production webhook URL of a workflow with a Webhook trigger. Writes need `allowWrite: true`.
7. **OmniRoute.** `omniroute tokens create --name ai-command-center --scope read`, stored as `acc.omniroute`, set as `managementToken`. `/v1/models` needs an inference key (`apiKey`, `sk-…`). The OmniRoute MCP proxy needs an `admin` token, so think twice before enabling it.
8. **9router.** `flavor: "9router"`, `baseUrl` (default port 20128, which clashes with OmniRoute; change one of them), optional `apiKey`.
9. **AION and other HTTP APIs.** Explain the endpoint fields (`name`, `method`, `path` with `{param}`, `params` JSON Schema properties, `body`, `write`, `required`), `healthPath`, `headers` (non-secret only) and `auth`.
10. **Upstream MCP servers.** `url`, `auth`, `include`/`exclude` globs, the `__` separator, write rules.
11. **Registering clients.** `npm run mcp:register -- claude|kiro|antigravity|all`, with `--remove` and `--dry-run`, file locations, backups.
12. **Troubleshooting.** Open the Integrations page; `acc_integrations_status`; the audit file `.cache/mcp-audit.jsonl`; restart the client after editing config.json (the MCP server reads config at start).

- [ ] **Step 3: Update `README.md`**

- Badge: change `<img alt="100% local" src="https://img.shields.io/badge/data-100%25%20local-6250d6?style=flat-square">` to `<img alt="Local first" src="https://img.shields.io/badge/data-local%20first-6250d6?style=flat-square">`. Add `<img alt="MCP server" src="https://img.shields.io/badge/MCP-server-0f1b2a?style=flat-square">` after the Codex badge.
- Under "Why ZAAFPulse", add a table row: `| **⇄** | *Can my agents reach the rest of my stack?* | An MCP server for Claude Code, Kiro and Antigravity with connectors to Dynatrace, Arize Phoenix and AX, n8n, OmniRoute, 9router and any HTTP or MCP service, plus a page that shows every connection's health. |`
- Add a section `## MCP server and integrations` after "Run it on login". It covers: what `node mcp.js` exposes; `npm run mcp:register -- all`; a table of connector types and their tools; that write tools need `allowWrite`; and a link to `docs/integrations.md`.
- In the "At a glance" table, change `Network exposure` to `**127.0.0.1 only**, host-header checked; outbound only to integrations you configure`.
- Privacy bullet `Nothing is sent anywhere. No telemetry, no accounts, no API keys.` becomes: `Nothing is sent anywhere unless you configure an integration, and then only to the URL you configured: when an AI client calls a tool, or when the Integrations page checks health (at most once a minute per integration, or when you press Test). No telemetry, no accounts. Integration secrets stay in the macOS Keychain or environment variables, never in config.json.`
- Project structure: add `mcp.js`, `lib/mcp/`, `lib/connectors/`, `lib/integrations.js`, `lib/secrets.js`, `lib/audit.js`, `lib/local.js`, `scripts/register-mcp.js`, `test/`, `config.example.json`, `docs/integrations.md`.
- HTTP API table: add `GET /api/integrations` and `POST /api/integrations/test`.
- Add `npm test` to Quick start.

- [ ] **Step 4: Live config on this Mac**

Merge an `integrations` block into the local `config.json` without touching the other keys:

```bash
node -e '
const fs=require("fs");const f="config.json";const c=JSON.parse(fs.readFileSync(f,"utf8"));
const ex=JSON.parse(fs.readFileSync("config.example.json","utf8")).integrations;
c.integrations={
  omniroute: ex.omniroute,
  "9router": ex["9router"],
  "dynatrace-saas": {...ex["dynatrace-saas"], enabled:false},
  "dynatrace-managed": {...ex["dynatrace-managed"], enabled:false},
  phoenix: {...ex.phoenix, enabled:false},
  n8n: {...ex.n8n, enabled:false, webhooks:{}},
  aion: ex.aion,
  "omniroute-mcp": ex["omniroute-mcp"],
  ...(c.integrations||{})};
fs.writeFileSync(f, JSON.stringify(c,null,2));'
```

Integrations without credentials stay `enabled: false` until their secrets are in the Keychain.

- [ ] **Step 5: Live check against OmniRoute**

Run:
```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"omniroute_health","arguments":{}}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"omniroute_usage","arguments":{"period":"week"}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"acc_integrations_status","arguments":{}}}' \
 | node mcp.js | node -e 'for (const l of require("fs").readFileSync(0,"utf8").trim().split("\n")) { const m=JSON.parse(l); console.log(m.id, m.error ? "ERR "+m.error.message : m.result.isError ? "TOOL-ERR "+m.result.content[0].text.slice(0,120) : "ok "+JSON.stringify(m.result).slice(0,160)); }'
```
Expected: `1 ok`, `2 ok … "status":"ok"`, `3 ok … summary`, `4 ok`, with omniroute `state: ok`.

- [ ] **Step 6: Register clients**

Run: `npm run mcp:register -- all --dry-run`, then `npm run mcp:register -- all`
Expected: Claude Code registered via CLI, Kiro file created at `~/.kiro/settings/mcp.json`, Antigravity merged into `~/.gemini/config/mcp_config.json` with a backup.

- [ ] **Step 7: Full test run and commit**

```bash
npm test
git add config.example.json docs/integrations.md README.md
git commit -m "Document MCP integrations and add example config"
```

---

## Self-review notes

- Spec coverage: protocol (T2), secrets (T1), connectors (T5–T10), registry, `allowWrite`, argument checks, cap and audit (T4), registration and Kiro (T11), dashboard and demo (T12), docs, README privacy and live setup (T13). Out-of-scope items are not planned.
- Truncation: the spec's `"truncated": true` flag is implemented as a trailing note in the text result, because a cut JSON string cannot carry a field. The spec is updated to match.
- Arize AX `list_traces` is `POST /v2/traces` (from the published spec). The spec table is updated to match.
