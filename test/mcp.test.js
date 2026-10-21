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

// A temp HOME with one Claude Code session, so the tool reads a real fixture and never this machine's logs.
function traceHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mcp-home-'));
  const proj = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj', 's1.jsonl'), path.join(proj, 's1.jsonl'));
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
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.source, 'claude');
  assert.match(r.key, /^claude\.[0-9a-f]+$/);
  assert.equal(r.turns, 2);
  assert.ok(r.tools >= 1 && r.cost > 0);
  assert.deepEqual(Object.keys(r).sort(), [
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
  // No text, content id, file path or size, in any field.
  const json = JSON.stringify(rows);
  for (const bad of ['fix the login redirect', 'Changed the redirect', '"text"', '.jsonl', '.claude', '"size"', '"file"'])
    assert.equal(json.includes(bad), false, bad);
});

test('acc_trace_sessions falls back from a bad limit and hides titles when ZAAFPULSE_CONTENT=off', async () => {
  const env = traceHome();
  assert.equal((await traceSessions(env, { range: 'all', limit: 0 })).length, 1, 'a bad limit falls back to the default');
  const off = await traceSessions({ ...env, ZAAFPULSE_CONTENT: 'off' });
  assert.equal(off.length, 1);
  assert.equal(off[0].title, null);
});
