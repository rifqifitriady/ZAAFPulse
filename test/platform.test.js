const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createSecretStore, pickBackend } = require('../lib/secret-store');
const { createAuth, setPassword } = require('../lib/auth');
const processes = require('../lib/processes');
const service = require('../lib/service');
const platform = require('../lib/platform');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('secret store: picks the OS backend and can be forced', () => {
  assert.equal(pickBackend({}, 'darwin'), 'keychain');
  assert.equal(pickBackend({}, 'linux'), 'file'); // headless server: no desktop session
  assert.equal(pickBackend({}, 'win32'), 'file');
  assert.equal(pickBackend({ ZAAFPULSE_SECRET_STORE: 'file' }, 'darwin'), 'file');
});

test('secret store: the encrypted file round-trips, never holds plain text, and binds each value to its name', () => {
  const dir = tmp('zp-store-');
  const s = createSecretStore({ backend: 'file', dir, env: {}, platform: 'linux' });
  s.set('acc.openai', 'sk-test-value-123456');
  assert.equal(s.get('acc.openai'), 'sk-test-value-123456');
  assert.equal(s.get('missing'), null);
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('sk-test-value'));
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(path.join(dir, 'secret.key')).mode & 0o077, 0, 'the key file is private');
  // A value copied under another name does not decrypt (the name is authenticated).
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
  all.items.other = all.items['acc.openai'];
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(all));
  assert.throws(() => s.get('other'), /cannot be decrypted/);
  // A fresh store with the same key file reads it; a different master key cannot.
  assert.equal(
    createSecretStore({ backend: 'file', dir, env: {}, platform: 'linux' }).get('acc.openai'),
    'sk-test-value-123456',
  );
  assert.throws(
    () =>
      createSecretStore({
        backend: 'file',
        dir,
        env: { ZAAFPULSE_MASTER_KEY: 'another-master-key-0123' },
        platform: 'linux',
      }).get('acc.openai'),
    /cannot be decrypted/,
  );
});

test('secret store: on Windows the key file is sealed with DPAPI', () => {
  const dir = tmp('zp-store-win-');
  const s = createSecretStore({ backend: 'file', dir, env: {}, platform: 'win32' });
  // Without PowerShell here, sealing fails loudly instead of writing a plain key.
  if (process.platform !== 'win32') {
    assert.throws(() => s.set('x', 'y'), /DPAPI Protect failed|ENOENT|spawn/);
    assert.ok(!fs.existsSync(path.join(dir, 'secret.key')));
  }
});

async function authServer(auth) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (await auth.handle(req, res, url)) return;
    if (!auth.check(req)) {
      res.writeHead(401);
      return res.end('no');
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('auth: localhost is local-only by default; server mode needs the password and rate-limits guesses', async () => {
  // Localhost is limited to this OS account on every OS, single-user or not; no sign-in only when asked for.
  for (const platform of ['linux', 'darwin', 'win32'])
    assert.equal(
      createAuth({ dataDir: tmp('zp-a-'), host: '127.0.0.1', env: {}, platform, users: () => 0 }).mode,
      'local',
      platform,
    );
  assert.equal(
    createAuth({ dataDir: tmp('zp-a-'), host: '127.0.0.1', env: { ZAAFPULSE_AUTH: 'none' } }).required,
    false,
  );
  const dir = tmp('zp-auth-');
  assert.throws(() => setPassword(dir, 'short'), /at least 10/);
  setPassword(dir, 'correct horse battery');
  assert.ok(!fs.readFileSync(path.join(dir, '.data', 'admin.json'), 'utf8').includes('correct horse'));
  const auth = createAuth({ dataDir: dir, host: '0.0.0.0', env: {} });
  assert.equal(auth.required, true);
  const { base, close } = await authServer(auth);
  try {
    assert.equal((await fetch(`${base}/api/data`)).status, 401);
    const login = (password) =>
      fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    assert.equal(
      (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))
        .status,
      415,
    );
    const ok = await login('correct horse battery');
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${base}/api/data`, { headers: { cookie: cookie.split(';')[0] } })).status, 200);
    assert.equal((await fetch(`${base}/api/data`, { headers: { cookie: 'zp_session=forged' } })).status, 401);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await login('wrong')).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    assert.equal((await login('correct horse battery')).status, 429, 'locked out even with the right password');
  } finally {
    close();
  }
});

test('processes: Linux /proc, meminfo and Windows CIM rows become the same app list', () => {
  const root = tmp('zp-proc-');
  fs.writeFileSync(path.join(root, 'uptime'), '1000.00 900.00');
  const mk = (pid, cmd, utime, start, rssKB) => {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'cmdline'), cmd.split(' ').join('\0'));
    fs.writeFileSync(
      path.join(root, String(pid), 'stat'),
      `${pid} (x y) S ${'0 '.repeat(10)}${utime} 0 0 0 0 0 0 0 ${start} 0`,
    );
    fs.writeFileSync(path.join(root, String(pid), 'status'), `Name: x\nVmRSS:\t${rssKB} kB\n`);
  };
  mk(11, '/usr/local/bin/ollama serve', 5000, 50000, 204800); // 50 s of CPU over 500 s → 10 %
  mk(12, '/home/u/.local/bin/claude --resume', 1000, 90000, 102400);
  fs.mkdirSync(path.join(root, '13'));
  fs.writeFileSync(path.join(root, '13', 'cmdline'), ''); // kernel thread
  const rows = processes.procRows(root, 100);
  assert.equal(rows.length, 2);
  const apps = processes.groupApps(rows);
  const ollama = apps.find((a) => a.id === 'ollama');
  assert.equal(ollama.cpu, 10);
  assert.equal(ollama.memMB, 200);
  assert.ok(apps.find((a) => a.id === 'claude'));
  assert.equal(
    processes.parseMeminfo('MemTotal:       16000000 kB\nMemFree: 1 kB\nMemAvailable:    6000000 kB\n'),
    Math.round(10000000 / 1024),
  );
  const win = processes.parseWinRows(
    '4242\t50000000\t104857600\t100\t"C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\app-1.0\\claude.exe"\r\n77\t1\t1\t1\tC:\\Windows\\explorer.exe\r\n',
  );
  const wa = processes.groupApps(win);
  assert.equal(wa.length, 1);
  assert.equal(wa[0].id, 'claude-desktop');
  assert.equal(wa[0].cpu, 5);
  assert.equal(wa[0].memMB, 100);
  assert.equal(
    processes.groupApps(
      processes.parseWinRows('9\t1\t1048576\t10\tC:\\Users\\u\\.local\\bin\\claude.exe --continue\r\n'),
    )[0].id,
    'claude',
  );
});

test('service: the log folder variables are carried into the unit, plist and Windows launcher', () => {
  const env = service.settings({
    CLAUDE_CONFIG_DIR: '/home/me/work-claude',
    ZAAFPULSE_CLAUDE_DIRS: '/home/me/work-claude,/home/me/other',
    CODEX_HOME: '/home/me/cx',
    XDG_CONFIG_HOME: '/home/me/.cfg',
    HOME: '/home/me',
  });
  assert.deepEqual(env, {
    CLAUDE_CONFIG_DIR: '/home/me/work-claude',
    ZAAFPULSE_CLAUDE_DIRS: '/home/me/work-claude,/home/me/other',
    CODEX_HOME: '/home/me/cx',
    XDG_CONFIG_HOME: '/home/me/.cfg',
  });
  assert.deepEqual(service.settings({ CLAUDE_CONFIG_DIR: '' }), {}, 'an empty value is not carried');
  // The Claude Code judge's binary, named by hand: a service has no shell PATH to find it on.
  assert.deepEqual(service.settings({ ZAAFPULSE_CLAUDE_BIN: '/opt/claude' }), { ZAAFPULSE_CLAUDE_BIN: '/opt/claude' });
  const cmd = ['/usr/bin/node', '/app/bin/zaafpulse.js', 'start'];
  const unit = service.unitText(cmd, env, { system: false });
  assert.match(unit, /Environment=CLAUDE_CONFIG_DIR=\/home\/me\/work-claude\n/);
  assert.match(unit, /Environment=ZAAFPULSE_CLAUDE_DIRS=\/home\/me\/work-claude,\/home\/me\/other/);
  assert.match(unit, /Environment=CODEX_HOME=\/home\/me\/cx/);
  assert.match(unit, /Environment=XDG_CONFIG_HOME=\/home\/me\/.cfg/);
  const pl = service.plist(cmd, env, '/tmp/l.log');
  assert.match(pl, /<key>ZAAFPULSE_CLAUDE_DIRS<\/key><string>\/home\/me\/work-claude,\/home\/me\/other<\/string>/);
  assert.match(pl, /<key>CODEX_HOME<\/key><string>\/home\/me\/cx<\/string>/);
  const vbs = service.vbsText(cmd, env, 'C:\\Z\\logs\\server.log');
  assert.match(vbs, /e\("ZAAFPULSE_CLAUDE_DIRS"\) = "\/home\/me\/work-claude,\/home\/me\/other"/);
  assert.match(vbs, /e\("CODEX_HOME"\) = "\/home\/me\/cx"/);
});

test('service: unit, plist and Windows launcher carry settings but never secrets', () => {
  const env = service.settings({
    ZAAFPULSE_HOST: '0.0.0.0',
    ZAAFPULSE_PORT: '4777',
    ZAAFPULSE_ADMIN_PASSWORD: 'secret-pass',
    ZAAFPULSE_MASTER_KEY: 'secret-key',
    PATH: '/x',
  });
  assert.deepEqual(env, { ZAAFPULSE_HOST: '0.0.0.0', ZAAFPULSE_PORT: '4777' });
  const cmd = ['/opt/zaafpulse/node/bin/node', '/opt/zaafpulse/app/bin/zaafpulse.js', 'start'];
  const unit = service.unitText(cmd, { ...env, ZAAFPULSE_DATA: '/var/lib/zaafpulse' }, { system: true });
  assert.match(unit, /ExecStart=\/opt\/zaafpulse\/node\/bin\/node \/opt\/zaafpulse\/app\/bin\/zaafpulse.js start/);
  assert.match(unit, /User=zaafpulse/);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/zaafpulse/);
  assert.match(unit, /WantedBy=multi-user.target/);
  assert.match(service.unitText(cmd, env, { system: false }), /WantedBy=default.target/);
  const pl = service.plist(['/usr/bin/node', '/a b/zaafpulse.js', 'start'], { ZAAFPULSE_PORT: '1&2' }, '/tmp/l.log');
  assert.match(pl, /<string>\/a b\/zaafpulse.js<\/string>/);
  assert.match(pl, /1&amp;2/);
  const vbs = service.vbsText(
    ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Z\\app\\bin\\zaafpulse.js', 'start'],
    env,
    'C:\\Z\\logs\\server.log',
  );
  assert.match(vbs, /e\("ZAAFPULSE_HOST"\) = "0.0.0.0"/);
  assert.match(vbs, /""C:\\Program Files\\nodejs\\node.exe""/);
  assert.match(vbs, /Do\r?\n/);
  for (const t of [unit, pl, vbs]) {
    assert.ok(!t.includes('secret-pass'));
    assert.ok(!t.includes('secret-key'));
  }
});

test('platform: home expansion, data folder rules and the MCP command', () => {
  // Separators are kept as typed; Windows accepts both, so compare normalized paths.
  assert.equal(path.normalize(platform.expandHome('~/x')), path.join(os.homedir(), 'x'));
  assert.equal(platform.expandHome('~\\x'), `${os.homedir()}\\x`);
  const d = tmp('zp-data-');
  assert.equal(platform.dataDir({ ZAAFPULSE_DATA: d }), d);
  // A git checkout (or a folder that already has config.json or .data) keeps its data next to the code;
  // anything else, such as an unpacked release tarball, uses the OS's data folder.
  const inApp = ['.git', 'config.json', '.data'].some((f) => fs.existsSync(path.join(platform.APP_DIR, f)));
  const system = platform.OS === 'linux' && process.getuid && process.getuid() === 0;
  assert.equal(platform.dataDir({}), inApp ? platform.APP_DIR : platform.defaultDataDir({ system }));
  const plain = { command: process.execPath, args: [path.join(platform.APP_DIR, 'mcp.js')] };
  assert.deepEqual(platform.mcpCommand({ env: {} }), plain);
  // A chosen data folder or config file travels with the command; the folder mcp.js finds by itself does not.
  assert.deepEqual(platform.mcpCommand({ env: { ZAAFPULSE_DATA: platform.APP_DIR } }), plain);
  assert.deepEqual(platform.mcpCommand({ env: { ZAAFPULSE_DATA: d, ACC_CONFIG: 'rel/config.json' } }).env, {
    ZAAFPULSE_DATA: d,
    ACC_CONFIG: path.resolve('rel/config.json'),
  });
  assert.equal(
    platform.mcpCommand({ env: { ZAAFPULSE_DATA: d }, data: '~/zp' }).env.ZAAFPULSE_DATA,
    path.join(os.homedir(), 'zp'),
  );
  assert.ok(platform.obsidianConfigFiles().length >= 1);
});
