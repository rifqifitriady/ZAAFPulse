// Dashboard sign-in: local is the default everywhere, throttling that cannot lock the owner out, local
// cookies that sign-out revokes, one-time codes kept off command lines, and the Origin rule in every mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { Readable } = require('stream');
const { spawn, execFile } = require('child_process');
const {
  createAuth,
  pickMode,
  clientKey,
  prefixKey,
  originAllowed,
  localLoginCode,
  localLoginPage,
} = require('../lib/auth');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';

// Drives auth.handle() without sockets: any client address, any time.
function harness({ env = { ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, host = '0.0.0.0' } = {}) {
  let t = 1_700_000_000_000;
  const auth = createAuth({ dataDir: tmp('zp-signin-'), host, env, now: () => t });
  const login = async (ip, password, cookie) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ password }))]);
    Object.assign(req, {
      method: 'POST',
      url: '/api/login',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: ip },
    });
    const res = { status: 0, headers: {}, writeHead: (s, h) => ((res.status = s), (res.headers = h || {})), end() {} };
    await auth.handle(req, res, new URL('http://x/api/login'));
    return res;
  };
  return { auth, login, advance: (ms) => (t += ms) };
}
const cookieFrom = (res, name) =>
  []
    .concat(res.headers['set-cookie'] || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(`${name}=`));

test('sign-in mode: local is the default on every OS; none only when asked for (or demo data)', () => {
  for (const platform of ['darwin', 'win32', 'linux'])
    assert.equal(pickMode({ host: '127.0.0.1', env: {}, platform, users: () => 0 }), 'local', platform);
  assert.equal(
    pickMode({ host: 'localhost', env: { ZAAFPULSE_AUTH: '0' }, platform: 'darwin' }),
    'local',
    'fails closed',
  );
  assert.equal(pickMode({ host: '127.0.0.1', env: { ZAAFPULSE_AUTH: 'none' }, platform: 'darwin' }), 'none');
  assert.equal(pickMode({ host: '127.0.0.1', env: {}, platform: 'darwin', demo: true }), 'none', 'demo stays open');
  assert.equal(pickMode({ host: '127.0.0.1', env: {}, platform: 'linux', users: () => 2, demo: true }), 'local');
  assert.equal(pickMode({ host: '127.0.0.1', env: { ZAAFPULSE_AUTH: 'local' }, demo: true }), 'local');
  assert.equal(pickMode({ host: '0.0.0.0', env: { ZAAFPULSE_AUTH: 'none' } }), 'password', 'never none off-host');
  assert.equal(pickMode({ host: '0.0.0.0', env: {}, demo: true }), 'password');
});

test('sign-in: an admin password from the environment needs 10 characters, like set-password', () => {
  assert.throws(
    () => createAuth({ dataDir: tmp('zp-short-'), host: '0.0.0.0', env: { ZAAFPULSE_ADMIN_PASSWORD: 'short-pw' } }),
    /at least 10 characters/,
  );
  const f = path.join(tmp('zp-short-'), 'pw');
  fs.writeFileSync(f, 'abc\n');
  assert.throws(
    () => createAuth({ dataDir: tmp('zp-short-'), host: '0.0.0.0', env: { ZAAFPULSE_ADMIN_PASSWORD_FILE: f } }),
    /at least 10/,
  );
  assert.ok(createAuth({ dataDir: tmp('zp-short-'), host: '0.0.0.0', env: { ZAAFPULSE_ADMIN_PASSWORD: PASSWORD } }));
});

test('sign-in: a guessing address is locked out, for longer each time', async () => {
  const h = harness();
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await h.login('203.0.113.5', `wrong-${i}`)).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  const locked = await h.login('203.0.113.5', PASSWORD);
  assert.equal(locked.status, 429, 'the right password waits too, from the guessing address');
  assert.equal(locked.headers['retry-after'], '30');
  h.advance(31e3);
  assert.equal((await h.login('203.0.113.5', 'wrong-again')).status, 401);
  const longer = await h.login('203.0.113.5', PASSWORD);
  assert.equal(longer.status, 429);
  assert.equal(longer.headers['retry-after'], '60', 'the wait doubles');
  h.advance(61e3);
  assert.equal((await h.login('203.0.113.5', PASSWORD)).status, 200, 'and then the owner gets in');
  assert.equal((await h.login('203.0.113.5', 'wrong')).status, 401, 'a success starts the address over');
});

test('sign-in: guessing from many addresses slows everyone down but never locks the owner out', async () => {
  const h = harness();
  // The review's attack: 10 addresses x 5 wrong guesses = 50 failures.
  for (let a = 1; a <= 10; a++) for (let i = 0; i < 5; i++) await h.login(`203.0.113.${a}`, `wrong-${i}`);
  const owner = await h.login('198.51.100.7', PASSWORD);
  assert.equal(owner.status, 200, 'the right password from a fresh address');
  // Under pressure a new attacking address gets a single try before it has to wait.
  assert.equal((await h.login('192.0.2.50', 'guess-1')).status, 401);
  assert.equal((await h.login('192.0.2.50', 'guess-2')).status, 429);
  // The owner from another fresh address, even with a typo first, gets in after a short wait.
  assert.equal((await h.login('198.51.100.8', 'typo')).status, 401);
  assert.equal((await h.login('198.51.100.8', PASSWORD)).status, 429);
  h.advance(31e3);
  assert.equal((await h.login('198.51.100.8', PASSWORD)).status, 200);
});

test('sign-in: IPv6 counts per /64, and a /56 shares one budget', async () => {
  const k = (ip) => clientKey({ headers: {}, socket: { remoteAddress: ip } }, false);
  assert.equal(k('2001:db8:1:2:aaaa::1'), k('2001:0db8:0001:0002:bbbb:0:0:9'));
  assert.equal(k('2001:db8::1'), '2001:db8:0:0::/64', 'compressed forms are expanded');
  assert.notEqual(k('2001:db8:0:1::1'), k('2001:db8:0:2::1'));
  assert.equal(prefixKey(k('2001:db8:0:1::1')), prefixKey(k('2001:db8:0:ff::1')), 'one /56');
  assert.notEqual(prefixKey(k('2001:db8:0:1::1')), prefixKey(k('2001:db8:0:100::1')));
  assert.equal(k('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(prefixKey('203.0.113.9'), null, 'IPv4 has no shared prefix budget');
  const h = harness();
  // Four /64s of one /56, five guesses each: 20 in the /56, so a fifth /64 there must wait…
  for (let a = 0; a < 4; a++) for (let i = 0; i < 5; i++) await h.login(`2001:db8:0:${a}::1`, 'x');
  assert.equal((await h.login('2001:db8:0:9::1', PASSWORD)).status, 429);
  // …while the next /56 is not affected.
  assert.equal((await h.login('2001:db8:0:100::1', PASSWORD)).status, 200);
});

test('sign-in: a browser that signed in before is not locked out by guesses from its address', async () => {
  const h = harness();
  const first = await h.login('198.51.100.7', PASSWORD);
  const known = cookieFrom(first, 'zp_known');
  assert.match(known, /^zp_known=/);
  // Someone behind the same address (a shared NAT) guesses until it is locked.
  for (let i = 0; i < 6; i++) await h.login('198.51.100.7', 'wrong');
  assert.equal((await h.login('198.51.100.7', PASSWORD)).status, 429);
  assert.equal((await h.login('198.51.100.7', PASSWORD, known)).status, 200, 'the known browser gets in');
  // A forged or altered known-device cookie counts for nothing.
  assert.equal((await h.login('198.51.100.7', PASSWORD, `${known.slice(0, -2)}xx`)).status, 429);
  // The known browser has its own budget for wrong passwords.
  const s = [];
  for (let i = 0; i < 6; i++) s.push((await h.login('198.51.100.9', 'wrong', known)).status);
  assert.deepEqual(s, [401, 401, 401, 401, 401, 429]);
});

async function localServer(env = { ZAAFPULSE_AUTH: 'local' }) {
  const dir = tmp('zp-local-');
  const auth = createAuth({ dataDir: dir, host: '127.0.0.1', env });
  const server = require('http').createServer(async (req, res) => {
    if (await auth.handle(req, res, new URL(req.url, 'http://x'))) return;
    res.writeHead(auth.check(req) ? 200 : 401);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { dir, auth, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('local sign-in: a code works once even when redeemed in parallel; the page then opens the dashboard', async () => {
  const s = await localServer({});
  try {
    assert.equal(s.auth.mode, 'local', 'the default');
    const code = localLoginCode(s.dir);
    const all = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${s.base}/auth/local?code=${code}`, { redirect: 'manual' })),
    );
    const cookies = all.map((r) => r.headers.get('set-cookie')).filter(Boolean);
    assert.equal(cookies.length, 1, 'exactly one request got the cookie');
    const winner = all.find((r) => r.headers.get('set-cookie'));
    assert.equal(winner.status, 200);
    assert.match(await winner.text(), /http-equiv="refresh" content="0;url=\/"/);
    assert.ok(all.filter((r) => r !== winner).every((r) => r.status === 302));
    assert.deepEqual(
      fs.readdirSync(path.join(s.dir, '.data', 'login-codes')),
      [],
      'nothing left behind in the codes folder',
    );
  } finally {
    s.close();
  }
});

test('local sign-in: the code reaches the browser through a private file, never a URL on a command line', async () => {
  const s = await localServer();
  try {
    const file = localLoginPage(s.dir, 'http://localhost:4777');
    assert.ok(file.startsWith(path.join(s.dir, '.data', 'login-codes')));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const html = fs.readFileSync(file, 'utf8');
    const code = html.match(/auth\/local\?code=([A-Za-z0-9_-]+)/)[1];
    assert.ok(!file.includes(code), 'the path (what goes on a command line) does not contain the code');
    assert.match(html, /http-equiv="refresh" content="0;url=http:\/\/localhost:4777\/auth\/local\?code=/);
    const r = await fetch(`${s.base}/auth/local?code=${code}`, { redirect: 'manual' });
    assert.ok(r.headers.get('set-cookie'));
    assert.equal(fs.existsSync(file), false, 'the file is deleted once used');
  } finally {
    s.close();
  }
});

test('local sign-in: signing out revokes every local cookie; only a signed-in browser can do that', async () => {
  const s = await localServer();
  try {
    const signIn = async () =>
      (await fetch(`${s.base}/auth/local?code=${localLoginCode(s.dir)}`, { redirect: 'manual' })).headers
        .get('set-cookie')
        .split(';')[0];
    const a = await signIn();
    const b = await signIn();
    const status = (cookie) => fetch(`${s.base}/api/x`, { headers: { cookie } }).then((r) => r.status);
    assert.equal(await status(a), 200);
    const logout = (cookie) =>
      fetch(`${s.base}/api/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: '{}',
      });
    await logout(); // not signed in: changes nothing
    assert.equal(await status(a), 200);
    assert.equal((await logout(a)).status, 200);
    assert.equal(await status(a), 401, 'the cookie that signed out');
    assert.equal(await status(b), 401, 'and every other local cookie');
    // Revocation survives a restart (the generation lives in the data folder).
    const again = createAuth({ dataDir: s.dir, host: '127.0.0.1', env: { ZAAFPULSE_AUTH: 'local' } });
    assert.equal(again.check({ headers: { cookie: a } }), false);
    // An old-format cookie (no generation) is not accepted.
    assert.equal(again.check({ headers: { cookie: `zp_local=${Date.now() + 1e9}.abc` } }), false);
  } finally {
    s.close();
  }
});

test('origin rule: same site and allowed origins only, in every mode; file pages and other sites refused', () => {
  const req = (origin, host = 'localhost:4777', extra = {}) => ({
    headers: { host, ...(origin === undefined ? {} : { origin }), ...extra },
  });
  for (const mode of ['local', 'none']) {
    assert.ok(originAllowed(req(undefined), { mode }), 'no Origin: not a cross-site browser request');
    assert.ok(originAllowed(req('http://localhost:4777'), { mode }));
    assert.ok(originAllowed(req('http://127.0.0.1:3000'), { mode }), 'a local app on another port');
    assert.ok(!originAllowed(req('https://evil.example'), { mode }));
    assert.ok(!originAllowed(req('null'), { mode }), 'a file:// page or sandboxed frame');
  }
  const pw = { mode: 'password' };
  assert.ok(originAllowed(req('https://ai.example.com', 'ai.example.com'), pw), 'same host');
  assert.ok(!originAllowed(req('https://evil.example', 'ai.example.com'), pw));
  assert.ok(!originAllowed(req('http://localhost:3000', 'ai.example.com'), pw), 'loopback pages are not special');
  // A proxy that rewrites Host: its X-Forwarded-Host, the public URL or the allowed hosts name the site.
  const behind = req('https://ai.example.com', '127.0.0.1:4777', { 'x-forwarded-host': 'ai.example.com' });
  assert.ok(!originAllowed(behind, pw), 'X-Forwarded-Host only from a trusted proxy');
  assert.ok(originAllowed(behind, { ...pw, trustProxy: true }));
  assert.ok(
    originAllowed(req('https://ai.example.com', '127.0.0.1:4777'), { ...pw, publicUrl: 'https://ai.example.com/' }),
  );
  assert.ok(
    originAllowed(req('https://ai.example.com', '127.0.0.1:4777'), { ...pw, allowedHosts: ['ai.example.com'] }),
  );
  const allow = { ...pw, allowedOrigins: ['https://app.example.org'] };
  assert.ok(originAllowed(req('https://app.example.org', 'ai.example.com'), allow));
  assert.ok(!originAllowed(req('https://other.example.org', 'ai.example.com'), allow));
  assert.ok(originAllowed(req('https://anything.example', 'ai.example.com'), { ...pw, allowedOrigins: ['*'] }));
});

/* ---------- the running server and the CLI ---------- */

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // The range this project's server tests may use, so a stray server never lands on a real port.
    const port = 4800 + Math.floor(Math.random() * 20);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
// Starts server.js on a free port of the range; tries again when another test took the port first.
async function startServer(env) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const data = tmp('zp-signin-srv-');
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        DEMO: '',
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        // Still ours: a server that lost the port race exits at once.
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { port, data, base, child, stop: () => child.kill() };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    child.kill();
  }
  throw new Error('could not start server.js on a free port');
}
// Every request in these tests gives up after 10 s instead of hanging the run.
const get = (url, opts = {}) => fetch(url, { signal: AbortSignal.timeout(10000), ...opts });

test('server: local sign-in by default; sign-in page loads; foreign origins refused; zaafpulse open signs in', async () => {
  const s = await startServer({});
  try {
    const session = await (await get(`${s.base}/api/session`)).json();
    assert.equal(session.mode, 'local');
    assert.equal(session.signedIn, false);
    assert.equal((await get(`${s.base}/api/summary`)).status, 401);
    assert.equal((await get(`${s.base}/`, { redirect: 'manual' })).headers.get('location'), '/login.html');
    assert.equal((await get(`${s.base}/login.html`)).status, 200);
    assert.equal((await get(`${s.base}/login.js`)).status, 200);
    assert.equal(
      (
        await get(`${s.base}/api/logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
      'a foreign Origin is refused in local mode too',
    );
    assert.equal(
      (await get(`${s.base}/mcp`, { method: 'POST', headers: { origin: 'null' }, body: '{}' })).status,
      403,
      'and before the gateway: a file page cannot reach /mcp',
    );
    // `zaafpulse open` with stand-in browser openers that record their arguments.
    if (process.platform === 'win32') return;
    const bin = tmp('zp-fake-open-');
    const argv = path.join(bin, 'argv.txt');
    for (const name of ['open', 'xdg-open'])
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argv}"\n`, { mode: 0o755 });
    await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        [path.join(ROOT, 'bin', 'zaafpulse.js'), 'open'],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            ZAAFPULSE_PORT: String(s.port),
            ZAAFPULSE_DATA: s.data,
            HOME: s.data,
          },
          timeout: 20000,
        },
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    for (let i = 0; i < 40 && !fs.existsSync(argv); i++) await new Promise((r) => setTimeout(r, 50));
    const opened = fs.readFileSync(argv, 'utf8').trim();
    assert.ok(!/code=/.test(opened), `no code on the command line: ${opened}`);
    assert.ok(opened.startsWith(fs.realpathSync(s.data)) || opened.startsWith(s.data), opened);
    const target = fs
      .readFileSync(opened, 'utf8')
      .match(/url=([^"]+)"/)[1]
      .replace(/&amp;/g, '&');
    const r = await get(target.replace(`localhost:${s.port}`, `127.0.0.1:${s.port}`), { redirect: 'manual' });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await get(`${s.base}/api/summary`, { headers: { cookie } })).status, 200, 'signed in');
  } finally {
    s.stop();
  }
});

test('server: demo data opens without sign-in; a short admin password from the environment is refused', async () => {
  const demo = await startServer({ DEMO: '1' });
  try {
    // On Linux with other login users demo mode is local-only too; this checks the single-user case.
    const { mode } = await (await get(`${demo.base}/api/session`)).json();
    if (process.platform !== 'linux') assert.equal(mode, 'none');
    if (mode === 'none') assert.equal((await get(`${demo.base}/api/summary`)).status, 200);
  } finally {
    demo.stop();
  }
  const port = await freePort();
  const code = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      // Password mode on loopback (ZAAFPULSE_AUTH=1), so nothing ever listens beyond this machine.
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '1',
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: tmp('zp-shortpw-'),
        ZAAFPULSE_ADMIN_PASSWORD: 'tooshort',
      },
      stdio: 'ignore',
    });
    const t = setTimeout(() => c.kill(), 10000);
    c.on('exit', (code) => (clearTimeout(t), resolve(code)));
  });
  assert.equal(code, 78);
});
