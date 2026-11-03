// Governance audit log (AI Governance 2): the sign-in events lib/auth.js reports (onEvent), each with its actor. The
// failure that starts a lockout is one auth.lockout event; the refusals during the lockout are none. No password or
// cookie value is ever in an event.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createAuth, localLoginCode } = require('../lib/auth');

const PASSWORD = 'correct horse battery';
async function setup(t, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-auth-'));
  const events = [];
  const auth = createAuth({ dataDir, env, onEvent: (e) => events.push(e) });
  const server = http.createServer(async (req, res) => {
    if (!(await auth.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  return { events, base, post, dataDir, auth };
}

test('password sign-in: login, logout, failures and the one lockout event, each with the actor', async (t) => {
  const s = await setup(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD });
  const ok = await s.post('/api/login', { password: PASSWORD });
  assert.equal(ok.status, 200);
  const cookies = ok.headers.getSetCookie().map((c) => c.split(';')[0]);
  const known = cookies.find((c) => c.startsWith('zp_known='));
  assert.equal((await s.post('/api/logout', {}, { cookie: cookies.join('; ') })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await s.post('/api/login', { password: `wrong ${i}` })).status, 401);
  assert.equal((await s.post('/api/login', { password: 'wrong again' })).status, 429);
  assert.deepEqual(
    s.events.map((e) => [e.action, e.outcome, e.status]),
    [
      ['auth.login', 'ok', 200],
      ['auth.logout', 'ok', 200],
      ['auth.login_failed', 'refused', 401],
      ['auth.login_failed', 'refused', 401],
      ['auth.login_failed', 'refused', 401],
      ['auth.login_failed', 'refused', 401],
      ['auth.login_failed', 'refused', 401],
      ['auth.lockout', 'refused', 429],
    ],
  );
  const device = s.events[0].actor.device;
  assert.match(device, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(known.includes(device), 'the device is the id the known-device cookie carries');
  assert.deepEqual(s.events[1].actor, { via: 'dashboard', mode: 'password', device, ip: '127.0.0.1' });
  assert.deepEqual(s.events[2].actor, { via: 'dashboard', mode: 'password', device: null, ip: '127.0.0.1' });
  assert.equal(s.events[7].seconds, 30);
  const text = JSON.stringify(s.events);
  assert.ok(!text.includes('wrong') && !text.includes(PASSWORD) && !text.includes('zp_session'));
  // A logout that is not JSON is refused before anything happens: no event.
  const before = s.events.length;
  assert.equal((await fetch(`${s.base}/api/logout`, { method: 'POST', body: 'x' })).status, 415);
  assert.equal(s.events.length, before);
});

test('logout: only a request that held a session is an event, not one without or with a made-up cookie', async (t) => {
  const s = await setup(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD });
  for (let i = 0; i < 3; i++) assert.equal((await s.post('/api/logout', {})).status, 200);
  assert.equal((await s.post('/api/logout', {}, { cookie: 'zp_session=made-up' })).status, 200);
  assert.deepEqual(s.events, []);
  const ok = await s.post('/api/login', { password: PASSWORD });
  const cookie = ok.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  await s.post('/api/logout', {}, { cookie });
  await s.post('/api/logout', {}, { cookie }); // the session is gone now
  assert.deepEqual(
    s.events.map((e) => e.action),
    ['auth.login', 'auth.logout'],
  );
});

test('events: an actor that cannot be worked out never changes the answer', async (t) => {
  const events = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const auth = createAuth({ dataDir, env: { ZAAFPULSE_AUTH: 'local' }, onEvent: (e) => events.push(e) });
  const code = localLoginCode(dataDir);
  // A request whose address throws when it is read: the sign-in still answers, without an event.
  const req = {
    method: 'GET',
    headers: {},
    socket: {
      encrypted: false,
      get remoteAddress() {
        throw new Error('gone');
      },
    },
  };
  const res = { writeHead: () => {}, end: () => {}, setHeader: () => {} };
  assert.equal(await auth.handle(req, res, new URL(`http://x/auth/local?code=${code}`)), true);
  assert.deepEqual(events, []);
});

test('local sign-in: a code that works is an event; an expired or unknown one is not', async (t) => {
  const s = await setup(t, { ZAAFPULSE_AUTH: 'local' });
  const code = localLoginCode(s.dataDir);
  assert.equal((await fetch(`${s.base}/auth/local?code=${code}`, { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${s.base}/auth/local?code=${code}`, { redirect: 'manual' })).status, 302);
  assert.deepEqual(s.events, [
    {
      action: 'auth.local_code',
      outcome: 'ok',
      status: 200,
      actor: { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' },
    },
  ]);
  const req = { headers: { cookie: 'zp_known=x.y.z' }, socket: { remoteAddress: '::ffff:10.1.2.3' } };
  assert.deepEqual(s.auth.actorOf(req), { via: 'dashboard', mode: 'local', device: null, ip: '10.1.2.3' });
});
