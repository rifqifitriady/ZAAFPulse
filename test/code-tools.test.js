const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTools } = require('../lib/gateway/tools');

const KEY = 'zp_SECRETsecretSECRETsecret1234';
const B = 'http://127.0.0.1:4777';

test('code tools: CLAUDE_CONFIG_DIR and CODEX_HOME decide where the settings are written', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-tools-'));
  const env = { CLAUDE_CONFIG_DIR: path.join(home, 'claude-work'), CODEX_HOME: '~/codex-home' };
  const tools = createTools({ home, env });
  assert.deepEqual(tools.apply('claude-code', B, KEY, 'up/m1'), { ok: true, path: '~/claude-work/settings.json' });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(home, 'claude-work', 'settings.json'), 'utf8')).env.ANTHROPIC_BASE_URL,
    B,
  );
  assert.deepEqual(tools.apply('codex', B, KEY, 'up/m1'), { ok: true, path: '~/codex-home/config.toml' });
  assert.match(fs.readFileSync(path.join(home, 'codex-home', 'config.toml'), 'utf8'), /\[model_providers\.zaafpulse\]/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')) && !fs.existsSync(path.join(home, '.codex')));
  const list = tools.list(B);
  assert.equal(list.find((t) => t.id === 'claude-code').state, 'connected');
  assert.equal(list.find((t) => t.id === 'codex').path, '~/codex-home/config.toml');
  tools.revert('claude-code');
  tools.revert('codex');
  assert.ok(!fs.existsSync(path.join(home, 'codex-home', 'config.toml')));
  // A home without env (tests, demo mode) never follows this machine's variables.
  assert.equal(
    createTools({ home })
      .list(B)
      .find((t) => t.id === 'codex').path,
    '~/.codex/config.toml',
  );
});
