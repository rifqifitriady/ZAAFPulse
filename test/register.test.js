const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, clients, isRegistered, findOnPath, quoteArg, isOurs, NAME } = require('../scripts/register-mcp');

// Every test runs against a temp HOME with an empty environment, so no real client config is ever read or written.
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acc-home-'));
const quiet = () => {};
const noCli = () => null;
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\ufeff/, ''));
const put = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const backups = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(`${path.basename(f)}.bak-`));
const MCP_JS = path.join(__dirname, '..', 'mcp.js');

test('the server is registered as zaafpulse', () => {
  assert.equal(NAME, 'zaafpulse');
});

test('kiro: creates the settings file with our entry and no backup', () => {
  const home = tmpHome();
  run('kiro', { home, log: quiet });
  const file = clients(home).kiro.file;
  const data = readJ(file);
  assert.equal(data.mcpServers[NAME].command, process.execPath);
  assert.match(data.mcpServers[NAME].args[0], /mcp\.js$/);
  assert.equal(data.mcpServers[NAME].env, undefined, 'no env when nothing differs from the defaults');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp.json']);
});

test('antigravity: merges into an empty file, keeps other servers, backs up first', () => {
  const home = tmpHome();
  const file = clients(home).antigravity.file;
  put(file, '');
  run('antigravity', { home, log: quiet });
  const withOther = readJ(file);
  withOther.mcpServers.other = { command: 'x' };
  fs.writeFileSync(file, JSON.stringify(withOther));
  run('antigravity', { home, log: quiet, remove: true });
  assert.deepEqual(Object.keys(readJ(file).mcpServers), ['other']);
  assert.ok(backups(file).length >= 1);
});

test('a second registration changes nothing', () => {
  const home = tmpHome();
  const logs = [];
  run('kiro', { home, log: quiet });
  run('kiro', { home, log: (m) => logs.push(m) });
  assert.match(logs[0], /already registered/);
});

test('refuses to touch invalid JSON or a file that is not an object', () => {
  const home = tmpHome();
  const file = clients(home).kiro.file;
  put(file, '{ broken');
  assert.throws(() => run('kiro', { home, log: quiet }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  put(file, '[1]');
  assert.throws(() => run('kiro', { home, log: quiet }), /not hold a JSON object/);
  assert.equal(fs.readFileSync(file, 'utf8'), '[1]');
});

test('a BOM is accepted and kept; a "null" file counts as empty', () => {
  const home = tmpHome();
  const file = clients(home).kiro.file;
  put(file, '\ufeff{"mcpServers":{"other":{"command":"x"}}}');
  run('kiro', { home, log: quiet });
  assert.equal(fs.readFileSync(file, 'utf8').charCodeAt(0), 0xfeff);
  assert.deepEqual(Object.keys(readJ(file).mcpServers).sort(), ['other', NAME]);
  put(file, 'null\n');
  run('kiro', { home, log: quiet });
  assert.ok(readJ(file).mcpServers[NAME]);
});

test('a stale entry (other node, other install path) is replaced; settings the user added survive', () => {
  const home = tmpHome();
  const file = clients(home).kiro.file;
  put(
    file,
    JSON.stringify({ mcpServers: { [NAME]: { command: '/old/node', args: ['/old/ai/mcp.js'], autoApprove: ['x'] } } }),
  );
  const logs = [];
  run('kiro', { home, log: (m) => logs.push(m) });
  const e = readJ(file).mcpServers[NAME];
  assert.equal(e.command, process.execPath);
  assert.deepEqual(e.args, [MCP_JS]);
  assert.deepEqual(e.autoApprove, ['x']);
  assert.match(logs[0], /updated/);
});

test('the data folder travels in env: from --data, ZAAFPULSE_DATA and ACC_CONFIG', () => {
  const home = tmpHome();
  const data = path.join(home, 'zp data');
  run('kiro', { home, log: quiet, data });
  const file = clients(home).kiro.file;
  assert.deepEqual(readJ(file).mcpServers[NAME].env, { ZAAFPULSE_DATA: data });
  run('kiro', { home, log: quiet, env: { ZAAFPULSE_DATA: data, ACC_CONFIG: path.join(home, 'c.json') } });
  assert.deepEqual(readJ(file).mcpServers[NAME].env, { ZAAFPULSE_DATA: data, ACC_CONFIG: path.join(home, 'c.json') });
  // Back to the defaults: env is dropped again.
  run('kiro', { home, log: quiet });
  assert.equal(readJ(file).mcpServers[NAME].env, undefined);
});

test('migration: an old ai-command-center entry of ours is removed; a foreign one is kept', () => {
  const home = tmpHome();
  const file = clients(home).antigravity.file;
  put(
    file,
    JSON.stringify({ mcpServers: { 'ai-command-center': { command: '/n', args: ['/x/ai-command-center/mcp.js'] } } }),
  );
  const logs = [];
  run('antigravity', { home, log: (m) => logs.push(m) });
  assert.deepEqual(Object.keys(readJ(file).mcpServers), [NAME]);
  assert.ok(logs.some((l) => /removed the old "ai-command-center"/.test(l)));
  assert.equal(backups(file).length, 1);
  put(file, JSON.stringify({ mcpServers: { 'ai-command-center': { command: 'other-tool', args: ['serve'] } } }));
  run('antigravity', { home, log: quiet });
  assert.deepEqual(Object.keys(readJ(file).mcpServers).sort(), ['ai-command-center', NAME]);
});

test('--remove removes both the new and the old name', () => {
  const home = tmpHome();
  const file = clients(home).kiro.file;
  put(
    file,
    JSON.stringify({
      mcpServers: {
        [NAME]: { command: process.execPath, args: [MCP_JS] },
        'ai-command-center': { command: 'node', args: ['C:\\zp\\mcp.js'] },
        other: { command: 'x' },
      },
    }),
  );
  run('kiro', { home, log: quiet, remove: true });
  assert.deepEqual(Object.keys(readJ(file).mcpServers), ['other']);
});

test('isOurs: mcp.js on any OS, or the zaafpulse binary with "mcp"', () => {
  assert.ok(isOurs({ command: 'node', args: ['/a/mcp.js'] }));
  assert.ok(isOurs({ command: 'node', args: ['C:\\a\\mcp.js'] }));
  assert.ok(isOurs({ command: '/usr/local/bin/zaafpulse', args: ['mcp'] }));
  assert.ok(!isOurs({ command: 'npx', args: ['some-mcp'] }));
  assert.ok(!isOurs({ url: 'http://x' }));
});

test(
  'backups: a symlinked config is written through, its mode kept, and only 3 backups remain',
  { skip: process.platform === 'win32' },
  () => {
    const home = tmpHome();
    const file = clients(home).kiro.file;
    const real = path.join(home, 'dotfiles', 'kiro-mcp.json');
    put(real, '{}');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(real, file);
    for (let i = 0; i < 5; i++) {
      put(real, JSON.stringify({ mcpServers: { [`s${i}`]: { command: 'x' } } }));
      fs.chmodSync(real, 0o600);
      run('kiro', { home, log: quiet });
    }
    assert.ok(fs.lstatSync(file).isSymbolicLink(), 'the link stays a link');
    assert.equal(fs.statSync(real).mode & 0o777, 0o600);
    assert.ok(readJ(real).mcpServers[NAME]);
    assert.equal(backups(file).length, 3);
    for (const b of backups(file)) assert.equal(fs.statSync(path.join(path.dirname(file), b)).mode & 0o777, 0o600);
    assert.ok(!fs.readdirSync(path.dirname(real)).some((n) => n.includes('.bak-')), 'backups sit beside the link');
  },
);

test('dry run of a file client prints only our change, never other servers', () => {
  const home = tmpHome();
  const file = clients(home).kiro.file;
  put(file, JSON.stringify({ mcpServers: { other: { command: 'x', env: { TOKEN: 'secret-value' } } } }));
  const logs = [];
  run('kiro', { home, dryRun: true, log: (m) => logs.push(m) });
  assert.match(logs[0], /^\[dry-run\] .*mcp\.json: set "zaafpulse"/);
  assert.ok(!logs.join('\n').includes('secret-value'));
  assert.ok(!readJ(file).mcpServers[NAME], 'nothing written');
});

test('claude: uses the claude CLI, or prints the command when it is missing', () => {
  const home = tmpHome();
  const calls = [];
  run('claude', { home, log: quiet, which: () => '/bin/claude', exec: (cmd, args) => calls.push([cmd, ...args]) });
  assert.deepEqual(calls[0].slice(0, 5), ['claude', 'mcp', 'add', '--scope', 'user']);
  assert.equal(calls[0][5], NAME);
  const logs = [];
  run('claude', {
    home,
    log: (m) => logs.push(m),
    which: () => '/bin/claude',
    exec: () => {
      const e = new Error('missing');
      e.code = 'ENOENT';
      throw e;
    },
  });
  assert.match(logs[0], /claude CLI not found/);
});

test('claude on Windows: a missing CLI prints the command instead of failing with exit status 1', () => {
  const home = tmpHome();
  const logs = [];
  run('claude', {
    home,
    platform: 'win32',
    which: noCli,
    log: (m) => logs.push(m),
    exec: () => {
      const e = new Error('Command failed: claude mcp add ...');
      e.status = 1;
      throw e;
    },
  });
  assert.match(logs[0], /claude CLI not found\. Run this yourself:\n {2}claude mcp add --scope user zaafpulse -- /);
});

test('claude: a stale entry is removed and added again; the old name is removed; env is passed with -e', () => {
  const home = tmpHome();
  const file = clients(home).claude.file;
  put(
    file,
    JSON.stringify({
      mcpServers: {
        [NAME]: { type: 'stdio', command: '/old/node', args: ['/old/mcp.js'], env: {} },
        'ai-command-center': { type: 'stdio', command: '/old/node', args: ['/old/mcp.js'], env: {} },
      },
    }),
  );
  fs.chmodSync(file, 0o600);
  const calls = [];
  const data = path.join(home, 'd');
  run('claude', { home, data, log: quiet, which: () => '/bin/claude', exec: (cmd, args) => calls.push(args) });
  assert.deepEqual(calls[0], ['mcp', 'remove', '--scope', 'user', 'ai-command-center']);
  assert.deepEqual(calls[1], ['mcp', 'remove', '--scope', 'user', NAME]);
  assert.deepEqual(calls[2].slice(0, 9), [
    'mcp',
    'add',
    '--scope',
    'user',
    '-e',
    `ZAAFPULSE_DATA=${data}`,
    '--transport',
    'stdio',
    NAME,
  ]);
  assert.deepEqual(calls[2].slice(9), ['--', process.execPath, MCP_JS]);
  assert.equal(backups(file).length, 1, '~/.claude.json is backed up before the CLI changes it');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, backups(file)[0])).mode & 0o777, 0o600);
  // Up to date: nothing runs.
  put(
    file,
    JSON.stringify({ mcpServers: { [NAME]: { type: 'stdio', command: process.execPath, args: [MCP_JS], env: {} } } }),
  );
  const logs = [];
  run('claude', { home, log: (m) => logs.push(m), which: () => '/bin/claude', exec: () => assert.fail('ran') });
  assert.match(logs[0], /already registered/);
});

test('claude honours CLAUDE_CONFIG_DIR for its state file', () => {
  const home = tmpHome();
  const dir = path.join(home, 'claude-work');
  assert.equal(clients(home, { env: { CLAUDE_CONFIG_DIR: dir } }).claude.file, path.join(dir, '.claude.json'));
});

test('claude dry run prints quoted commands without running; isRegistered reads mcpServers', () => {
  const home = tmpHome();
  const logs = [];
  run('claude', {
    home,
    dryRun: true,
    data: path.join(home, 'my data'),
    platform: 'linux',
    log: (m) => logs.push(m),
    exec: () => {
      throw new Error('should not run');
    },
  });
  assert.match(
    logs[0],
    /^\[dry-run\] claude mcp add --scope user -e 'ZAAFPULSE_DATA=.*my data' --transport stdio zaafpulse -- /,
  );
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { [NAME]: {} } }));
  assert.equal(isRegistered(path.join(home, '.claude.json')), true);
  assert.equal(isRegistered(path.join(home, 'none.json')), false);
});

test('quoteArg: POSIX and Windows quoting for paths with spaces', () => {
  assert.equal(quoteArg('/usr/bin/node', 'linux'), '/usr/bin/node');
  assert.equal(quoteArg('/Users/a b/mcp.js', 'darwin'), "'/Users/a b/mcp.js'");
  assert.equal(quoteArg("it's", 'linux'), "'it'\\''s'");
  assert.equal(quoteArg('C:\\Program Files\\nodejs\\node.exe', 'win32'), '"C:\\Program Files\\nodejs\\node.exe"');
});

test('findOnPath finds executables without a shell', { skip: process.platform === 'win32' }, () => {
  const dir = tmpHome();
  const f = path.join(dir, 'claude');
  fs.writeFileSync(f, '#!/bin/sh\n');
  assert.equal(findOnPath('claude', { PATH: dir }, 'linux'), null, 'not executable');
  fs.chmodSync(f, 0o755);
  assert.equal(findOnPath('claude', { PATH: `/nope:${dir}` }, 'linux'), f);
  fs.writeFileSync(path.join(dir, 'codex.CMD'), '');
  assert.equal(findOnPath('codex', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32'), path.join(dir, 'codex.CMD'));
});

test('all: registers only the clients found here and says which were skipped', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.kiro'));
  const logs = [];
  run('all', { home, which: noCli, log: (m) => logs.push(m) });
  assert.ok(fs.existsSync(clients(home).kiro.file));
  assert.ok(!fs.existsSync(clients(home).antigravity.file));
  assert.match(logs.at(-1), /Skipped \(not found on this machine\): .*Claude Code.*Antigravity/);
});

test('unknown client', () => {
  assert.throws(() => run('nope', { home: tmpHome(), log: quiet }), /unknown client "nope"/);
});
