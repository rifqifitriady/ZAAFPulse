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
  for (const n of ['acc_usage_summary', 'acc_quality', 'acc_live_apps', 'acc_integrations_status', 'extra_ping'])
    assert.ok(names.includes(n), n);
  const status = JSON.parse(byId[3].result.content[0].text);
  assert.equal(status.find((s) => s.id === 'extra').state, 'unchecked');
  const audit = fs.readFileSync(path.join(dir, 'cache', 'mcp-audit.jsonl'), 'utf8');
  assert.match(audit, /"tool":"acc_integrations_status"/);
});
