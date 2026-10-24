const test = require('node:test');
const assert = require('node:assert/strict');
const { clientOf, isLoopback, clientTag } = require('../lib/gateway/client');

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

// A proxy or tunnel on this host (nginx, Caddy, tailscale serve, cloudflared, ngrok) connects from loopback too: a
// remote client behind it must not look local, or its cost would be dropped from the ledger.
const req = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });
const CC = { 'user-agent': 'claude-cli/2.1.304' };

test('clientTag: a plain loopback request is local; a remote socket is not', () => {
  assert.deepEqual(clientTag(req(CC)), { client: 'claude-code', local: true });
  assert.deepEqual(clientTag(req(CC, '::ffff:127.0.0.1')), { client: 'claude-code', local: true });
  assert.deepEqual(clientTag(req(CC, '203.0.113.7')), { client: 'claude-code' });
  assert.deepEqual(clientTag(req({})), { local: true });
  assert.deepEqual(clientTag(null), {});
});

test('clientTag: any forwarding header makes a loopback request not local without trust proxy', () => {
  for (const [h, v] of [
    ['x-forwarded-for', '203.0.113.7'],
    ['x-forwarded-for', '127.0.0.1'],
    ['cf-connecting-ip', '203.0.113.7'],
    ['true-client-ip', '203.0.113.7'],
    ['x-real-ip', '203.0.113.7'],
    ['forwarded', 'for=203.0.113.7'],
    ['x-forwarded-host', 'gw.example.com'],
    ['x-forwarded-proto', 'https'],
    ['via', '1.1 caddy'],
  ])
    assert.deepEqual(clientTag(req({ ...CC, [h]: v })), { client: 'claude-code' }, `${h}: ${v}`);
});

test('clientTag with trust proxy: local only when the socket and every forwarded address are loopback', () => {
  const t = (headers, addr) => clientTag(req({ ...CC, ...headers }, addr), { trustProxy: true });
  assert.deepEqual(t({ 'x-forwarded-for': '127.0.0.1' }), { client: 'claude-code', local: true });
  assert.deepEqual(t({ 'x-forwarded-for': '::1', 'x-forwarded-proto': 'https', via: '1.1 caddy' }), {
    client: 'claude-code',
    local: true,
  });
  assert.deepEqual(t({ 'x-forwarded-for': '203.0.113.7' }), { client: 'claude-code' });
  // A tunnel in front of a local proxy: the remote address on the left, the tunnel's loopback hop on the right.
  assert.deepEqual(t({ 'x-forwarded-for': '203.0.113.7, 127.0.0.1' }), { client: 'claude-code' });
  assert.deepEqual(t({ 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '203.0.113.7' }), {
    client: 'claude-code',
  });
  assert.deepEqual(t({ 'x-forwarded-for': '127.0.0.1', forwarded: 'for="[2001:db8::1]:443"' }), {
    client: 'claude-code',
  });
  assert.deepEqual(t({ 'x-forwarded-for': '127.0.0.1', forwarded: 'for="[::1]:443";proto=https' }), {
    client: 'claude-code',
    local: true,
  });
  assert.deepEqual(t({ 'x-forwarded-host': 'gw.example.com' }), { client: 'claude-code' }, 'no X-Forwarded-For');
  assert.deepEqual(t({ 'x-forwarded-for': '127.0.0.1' }, '10.0.0.5'), { client: 'claude-code' }, 'remote socket');
  assert.deepEqual(t({}), { client: 'claude-code', local: true }, 'no proxy headers at all');
});
