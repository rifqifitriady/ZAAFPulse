const test = require('node:test');
const assert = require('node:assert/strict');
const { clientOf, isLoopback } = require('../lib/gateway/client');

test('clientOf: Claude Code and Codex are named from the User-Agent; anything else is null', () => {
  assert.equal(clientOf('claude-cli/2.1.304 (external, cli)'), 'claude-code');
  assert.equal(clientOf('codex_cli_rs/0.48.0 (Mac OS 26.6; arm64)'), 'codex');
  assert.equal(clientOf('codex/1.2'), 'codex');
  assert.equal(clientOf('Mozilla/5.0'), null);
  assert.equal(clientOf(''), null);
  assert.equal(clientOf(undefined), null);
  assert.equal(clientOf(['claude-cli/2.1.304']), null, 'not a string');
  assert.equal(clientOf('my-claude-cli/1.0'), null, 'only at the start');
});

test('isLoopback: 127.0.0.0/8, ::1 and IPv4-mapped 127.x are this machine; other addresses are not', () => {
  for (const a of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.9'])
    assert.equal(isLoopback(a), true, a);
  for (const a of ['192.168.1.2', '10.0.0.1', '::ffff:10.0.0.1', '1127.0.0.1', '127.0.0', '::2', '', undefined, null])
    assert.equal(isLoopback(a), false, String(a));
});
