const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway home with its own Claude Code and Codex folders, set before reqlogs reads where the logs are; the
// owner's ~/.claude and ~/.codex are never read.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-reqlogs-'));
const claudeDir = path.join(home, 'claude-cfg');
const codexDir = path.join(home, 'codex-home');
fs.mkdirSync(path.join(claudeDir, 'projects', '-work-app'), { recursive: true });
fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true });
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  ZAAFPULSE_CLAUDE_DIRS: claudeDir,
  CLAUDE_CONFIG_DIR: '',
  XDG_CONFIG_HOME: '',
  CODEX_HOME: codexDir,
});
const reqlogs = require('../lib/reqlogs');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('logs: an API error carries the tool it came from, and a normal turn is a request', () => {
  const now = Date.now();
  const at = (ago) => new Date(now - ago).toISOString();
  const lines = [
    {
      type: 'assistant',
      timestamp: at(60000),
      cwd: '/work/app',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'assistant',
      timestamp: at(30000),
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: 529 Overloaded' }],
      },
    },
  ];
  fs.writeFileSync(
    path.join(claudeDir, 'projects', '-work-app', 's1.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  const r = reqlogs.logs(now);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].source, 'claude');
  assert.equal(r.requests[0].model, 'claude-sonnet-5');
  const api = r.errors.filter((e) => e.kind === 'api');
  assert.equal(api.length, 1);
  assert.equal(api[0].tool, 'claude');
  assert.equal(api[0].source, 'API');
  assert.equal(api[0].label, 'API error');
});
