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
