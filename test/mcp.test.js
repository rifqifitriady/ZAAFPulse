const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runMcp(messages, config, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mcp-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], {
      env: { ...process.env, ACC_CONFIG: path.join(dir, 'config.json'), ACC_CACHE_DIR: path.join(dir, 'cache'), ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('error', reject);
    child.on('close', () =>
      resolve({
        replies: out
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
        dir,
      }),
    );
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.end();
  });
}

test('mcp.js lists acc and configured tools and reports status', async () => {
  const config = {
    integrations: {
      extra: {
        type: 'http',
        baseUrl: 'http://127.0.0.1:9',
        endpoints: [{ name: 'ping', method: 'GET', path: '/ping', description: 'Ping' }],
      },
    },
  };
  const { replies, dir } = await runMcp(
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acc_integrations_status', arguments: {} } },
    ],
    config,
  );
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId[1].result.serverInfo.name, 'zaafpulse');
  assert.equal(byId[1].result.serverInfo.title, 'ZAAFPulse');
  const names = byId[2].result.tools.map((t) => t.name);
  for (const n of [
    'acc_usage_summary',
    'acc_quality',
    'acc_live_apps',
    'acc_integrations_status',
    'acc_trace_sessions',
    'extra_ping',
  ])
    assert.ok(names.includes(n), n);
  const status = JSON.parse(byId[3].result.content[0].text);
  assert.equal(status.find((s) => s.id === 'extra').state, 'unchecked');
  const audit = fs.readFileSync(path.join(dir, 'cache', 'mcp-audit.jsonl'), 'utf8');
  assert.match(audit, /"tool":"acc_integrations_status"/);
});

test('mcp.js exports tool-call spans when otel is on, keeps stdout to protocol, and is silent when off', async () => {
  const { fakeServer } = require('./helpers');
  const collector = await fakeServer({ 'POST /v1/traces': { body: {} } });
  const call = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'acc_integrations_status', arguments: {} } },
  ];
  const otel = (enabled) => ({
    otel: { enabled, tracesEndpoint: `${collector.url}/v1/traces`, protocol: 'http/json' },
  });
  try {
    const off = await runMcp(call, otel(false));
    assert.equal(off.replies.length, 2);
    assert.equal(collector.requests.length, 0, 'no export unless otel.enabled is true');
    // The span is queued and sent when stdin closes, before the process exits.
    const on = await runMcp(call, otel(true));
    assert.deepEqual(
      on.replies.map((r) => r.id),
      [1, 2],
      'stdout carries only the JSON-RPC replies',
    );
    assert.equal(collector.requests.length, 1);
    const spans = collector.requests[0].body.resourceSpans[0].scopeSpans.flatMap((s) => s.spans);
    assert.ok(spans.some((s) => s.name === 'execute_tool acc_integrations_status'));
  } finally {
    await collector.close();
  }
});

const KIRO = path.join(__dirname, 'fixtures', 'trace', 'kiro');

// A temp HOME with one Claude Code session and two Kiro sessions, so the tool reads fixtures and never this
// machine's logs. Kiro is there because its titles are the ones that can carry text.
function traceHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mcp-home-'));
  const proj = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj', 's1.jsonl'), path.join(proj, 's1.jsonl'));
  fs.cpSync(KIRO, path.join(home, '.kiro', 'sessions'), { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

async function traceSessions(env, args = { range: 'all' }) {
  const { replies } = await runMcp(
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'acc_trace_sessions', arguments: args } },
    ],
    {},
    env,
  );
  const reply = replies.find((r) => r.id === 2);
  assert.ok(!reply.error && !reply.result.isError, JSON.stringify(reply));
  return JSON.parse(reply.result.content[0].text);
}

test('acc_trace_sessions lists session metadata and nothing from the transcript', async () => {
  const rows = await traceSessions({ ...traceHome(), ZAAFPULSE_CONTENT: 'on' });
  assert.deepEqual(rows.map((r) => r.source).sort(), ['claude', 'kiro', 'kiro']);
  const r = rows.find((x) => x.source === 'claude');
  assert.match(r.key, /^claude\.[0-9a-f]+$/);
  assert.equal(r.turns, 2);
  assert.ok(r.tools >= 1 && r.cost > 0);
  assert.equal(r.title, null, 'a Claude Code title is a prompt: never read here');
  for (const row of rows)
    assert.deepEqual(Object.keys(row).sort(), [
      'cost',
      'end',
      'errors',
      'flags',
      'key',
      'project',
      'source',
      'start',
      'title',
      'tools',
      'turns',
    ]);
  // No text, content id, file path or size, in any field but the Kiro titles.
  const json = JSON.stringify(rows.map((x) => ({ ...x, title: null })));
  for (const bad of ['fix the login redirect', 'Changed the redirect', '"text"', '.jsonl', '.claude', '.kiro', '"size"', '"file"', 'ci_'])
    assert.equal(json.includes(bad), false, bad);
});

test('acc_trace_sessions hides a Kiro title when ZAAFPULSE_CONTENT=off', async () => {
  const env = traceHome();
  const kiroTitles = async (extra) =>
    (await traceSessions({ ...env, ...extra })).filter((r) => r.source === 'kiro').map((r) => r.title);
  const on = await kiroTitles({ ZAAFPULSE_CONTENT: 'on' });
  assert.deepEqual(on.sort(), ['Add dark mode', 'Fix the login redirect']);
  assert.deepEqual(await kiroTitles({ ZAAFPULSE_CONTENT: 'off' }), [null, null]);
});

test('acc_trace_sessions: a bad limit falls back to the default and a small one applies', async () => {
  const env = traceHome();
  assert.equal((await traceSessions(env, { range: 'all', limit: 0 })).length, 3);
  assert.equal((await traceSessions(env, { range: 'all', limit: 2 })).length, 2);
  assert.equal((await traceSessions(env, { range: 'all', limit: 500 })).length, 3);
});

test('local.traceSessions: titles follow contentOff, and limit is clamped to 200', async () => {
  const { createLocal } = require('../lib/local');
  const { createKiro } = require('../lib/trace/kiro');
  const light = [createKiro({ root: KIRO })];
  const indexer = { entries: () => [] }; // shared, so nothing is refreshed and no log of this machine is read
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-local-'));
  const titles = async (contentOff) =>
    (await createLocal({ cacheDir, indexer, contentOff, light }).traceSessions({})).map((r) => r.title).sort();
  assert.deepEqual(await titles(false), ['Add dark mode', 'Fix the login redirect']);
  assert.deepEqual(await titles(true), [null, null]);
  const local = createLocal({ cacheDir, indexer, contentOff: false, light });
  assert.equal((await local.traceSessions({ limit: 1 })).length, 1);

  // Enough sessions to see the caps: 50 by default, 200 at most.
  const many = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-local-many-'));
  const t0 = Date.parse('2026-10-19T09:00:00Z');
  for (let i = 0; i < 210; i++) {
    const dir = path.join(many, 'ws', `sess_${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const at = (ms) => new Date(t0 + i * 60000 + ms).toISOString();
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: `sess_${i}`, title: `t${i}`, createdAt: at(0) }));
    const call = { type: 'tool_call', toolCallId: 'c', toolName: 'readFile', args: {}, status: 'completed', executionId: 'e' };
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify({ id: 'm', timestamp: at(1000), payload: call }) + '\n');
  }
  const big = createLocal({ cacheDir, indexer, contentOff: false, light: [createKiro({ root: many })] });
  assert.equal((await big.traceSessions({})).length, 50);
  assert.equal((await big.traceSessions({ limit: 500 })).length, 200);
  assert.equal((await big.traceSessions({ limit: 120 })).length, 120);
});
