// Dashboard users (AI Governance 4): sign-in with a name and a password (lib/auth.js with lib/users/store.js). The
// admin password still signs in alone ({ password }) as the owner; a session carries { user, role }; one message for a
// wrong name and a wrong password; a disabled account is refused like a wrong password; an account's sessions can be
// ended; each account name has a lockout budget of its own; in local mode accounts sign in beside `zaafpulse open`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { createAuth, localLoginCode, ACCOUNT_NAME } = require('../lib/auth');
const { createUserStore, NAME } = require('../lib/users/store');

const ADMIN = 'correct-horse-battery';
const PW = 'viewer password 1';

// Drives auth.handle() without sockets: any client address, any time, any cookie.
function harness(t, { env = { ZAAFPULSE_ADMIN_PASSWORD: ADMIN }, host = '0.0.0.0', users = true } = {}) {
  let at = Date.UTC(2026, 10, 4, 9);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createUserStore({ file: path.join(dataDir, '.data', 'users.json'), now: () => at });
  const events = [];
  const auth = createAuth({
    dataDir,
    host,
    env,
    now: () => at,
    accounts: users ? store : null,
    ownerName: () => 'Rifqi',
    onEvent: (e) => events.push(e),
  });
  const reqOf = (method, p, { body, ip = '127.0.0.1', cookie } = {}) => {
    const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    return Object.assign(r, {
      method,
      url: p,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: ip },
    });
  };
  const call = async (method, p, opts = {}) => {
    const req = reqOf(method, p, opts);
    const res = {
      status: 0,
      headers: {},
      text: '',
      writeHead: (s, h) => ((res.status = s), (res.headers = h || {})),
      end: (x) => (res.text = String(x || '')),
    };
    const handled = await auth.handle(req, res, new URL(`http://x${p}`));
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      /* not JSON */
    }
    return { ...res, handled, json };
  };
  const login = (body, ip, cookie) => call('POST', '/api/login', { body, ip, cookie });
  return { auth, store, events, call, login, reqOf, dataDir, advance: (ms) => (at += ms) };
}
const cookiesOf = (res) =>
  []
    .concat(res.headers['set-cookie'] || [])
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ');
const asReq = (cookie) => ({ headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } });

test('password mode: the admin password alone, or as "owner", is the owner; an account signs in with its name', async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', display: 'Bo', role: 'viewer', password: PW });
  for (const body of [{ password: ADMIN }, { name: 'owner', password: ADMIN }, { name: ' Owner ', password: ADMIN }]) {
    const r = await h.login(body);
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.deepEqual(r.json, { ok: true, user: 'owner', role: 'owner', display: 'Rifqi', mustChange: false });
    assert.deepEqual(h.auth.sessionOf(asReq(cookiesOf(r))), {
      user: 'owner',
      role: 'owner',
      display: 'Rifqi',
      mustChange: false,
    });
  }
  const r = await h.login({ name: 'Bo', password: PW });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, user: 'bo', role: 'viewer', display: 'Bo', mustChange: true });
  const req = asReq(cookiesOf(r));
  assert.equal(h.auth.check(req), true);
  assert.deepEqual(h.auth.sessionOf(req), { user: 'bo', role: 'viewer', display: 'Bo', mustChange: true });
  assert.equal(h.store.get('bo').lastLoginAt, '2026-11-04T09:00:00.000Z');
  const session = await h.call('GET', '/api/session', { cookie: cookiesOf(r) });
  assert.deepEqual(session.json, {
    required: true,
    mode: 'password',
    signedIn: true,
    configured: true,
    accounts: true,
    user: 'bo',
    role: 'viewer',
    display: 'Bo',
    mustChange: true,
  });
  const out = await h.call('GET', '/api/session');
  assert.deepEqual([out.json.signedIn, out.json.user, out.json.role, out.json.mustChange], [false, null, null, false]);
});

test('one message for a wrong name, a wrong password and a disabled account; events name an account that exists', async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  h.store.create({ name: 'cy', role: 'reviewer', password: PW });
  h.store.update('cy', { disabled: true });
  const tries = [
    [{ name: 'bo', password: 'not the password' }, '10.0.0.1'],
    [{ name: 'nobody', password: PW }, '10.0.0.2'],
    [{ name: 'cy', password: PW }, '10.0.0.3'],
    [{ password: 'not the admin password' }, '10.0.0.4'],
    [{ name: 'bo' }, '10.0.0.5'],
  ];
  for (const [body, ip] of tries) {
    const r = await h.login(body, ip);
    assert.deepEqual([r.status, r.json], [401, { error: 'wrong name or password' }], JSON.stringify(body));
  }
  assert.deepEqual(
    h.events.map((e) => [e.action, e.target || null, e.actor.user, e.actor.role]),
    [
      ['auth.login_failed', { type: 'user', id: 'bo' }, null, null],
      ['auth.login_failed', null, null, null],
      ['auth.login_failed', { type: 'user', id: 'cy' }, null, null],
      ['auth.login_failed', { type: 'user', id: 'owner' }, null, null],
      ['auth.login_failed', { type: 'user', id: 'bo' }, null, null],
    ],
  );
  const ok = await h.login({ name: 'bo', password: PW }, '10.0.0.9');
  assert.equal(ok.status, 200);
  const login = h.events[h.events.length - 1];
  assert.deepEqual(
    [login.action, login.actor.user, login.actor.role, login.actor.mode],
    ['auth.login', 'bo', 'viewer', 'password'],
  );
  assert.match(login.actor.device, /^[A-Za-z0-9_-]{16}$/);
  const text = JSON.stringify(h.events);
  assert.ok(!text.includes(PW) && !text.includes('not the password') && !text.includes('zp_session'));
  // Without accounts only the owner signs in; a name is a wrong name.
  const solo = harness(t, { users: false });
  assert.equal((await solo.login({ name: 'bo', password: PW })).status, 401);
  assert.equal((await solo.login({ password: ADMIN })).status, 200);
});

test("ending an account's sessions: all of them, or all but the one changing its password", async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  h.store.create({ name: 'cy', role: 'viewer', password: PW });
  const a = asReq(cookiesOf(await h.login({ name: 'bo', password: PW }, '10.0.0.1')));
  const b = asReq(cookiesOf(await h.login({ name: 'bo', password: PW }, '10.0.0.2')));
  const c = asReq(cookiesOf(await h.login({ name: 'cy', password: PW }, '10.0.0.3')));
  const o = asReq(cookiesOf(await h.login({ password: ADMIN }, '10.0.0.4')));
  assert.equal(h.auth.endSessions('bo', a), 1);
  assert.deepEqual([h.auth.check(a), h.auth.check(b), h.auth.check(c), h.auth.check(o)], [true, false, true, true]);
  h.auth.passwordChanged(a);
  assert.equal(h.auth.sessionOf(a).mustChange, false);
  assert.equal(h.auth.endSessions('bo'), 1);
  assert.equal(h.auth.sessionOf(a), null);
  assert.equal(h.auth.endSessions('owner'), 1);
  assert.equal(h.auth.check(o), false);
  // A session still ends when idle, as before.
  h.advance(12 * 3600e3 + 1);
  assert.equal(h.auth.check(c), false);
});

test('each account has its own lockout budget across addresses; the owner and a known browser are not locked out', async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  const first = await h.login({ name: 'bo', password: PW }, '198.51.100.7');
  const known = cookiesOf(first)
    .split('; ')
    .find((c) => c.startsWith('zp_known='));
  // Ten addresses, one wrong guess each: no address is locked, the account is.
  for (let a = 1; a <= 10; a++)
    assert.equal((await h.login({ name: 'bo', password: 'x' }, `203.0.113.${a}`)).status, 401);
  assert.equal((await h.login({ name: 'bo', password: PW }, '192.0.2.50')).status, 429, 'a fresh address must wait');
  assert.equal((await h.login({ name: 'bo', password: PW }, '192.0.2.51', known)).status, 200, 'the known browser');
  assert.equal((await h.login({ password: ADMIN }, '192.0.2.52')).status, 200, 'the owner');
  h.advance(31e3);
  assert.equal((await h.login({ name: 'bo', password: PW }, '192.0.2.53')).status, 200, 'after the wait');
});

test("a known browser is exempt only for the account that signed in there, not for guessing another's password", async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  h.store.create({ name: 'cy', role: 'viewer', password: PW });
  // bo signs in twice from fresh browsers: two known-device cookies of bo's.
  const knownOf = async (ip) =>
    cookiesOf(await h.login({ name: 'bo', password: PW }, ip))
      .split('; ')
      .find((c) => c.startsWith('zp_known='));
  const k1 = await knownOf('198.51.100.1');
  const k2 = await knownOf('198.51.100.2');
  // With them, ten guesses at cy's password still spend cy's budget.
  for (let a = 1; a <= 10; a++)
    assert.equal((await h.login({ name: 'cy', password: 'x' }, `203.0.113.${a}`, a <= 5 ? k1 : k2)).status, 401);
  assert.equal((await h.login({ name: 'cy', password: PW }, '192.0.2.60')).status, 429, "cy's budget is spent");
  // Guesses at the owner's password with bo's cookie spend the address's budget, as without a cookie.
  for (let i = 0; i < 5; i++) assert.equal((await h.login({ password: `wrong ${i}` }, '192.0.2.70', k1)).status, 401);
  assert.equal((await h.login({ password: ADMIN }, '192.0.2.70')).status, 429, 'the address must wait');
  // bo's own browser is still bo's: exempt for bo.
  assert.equal((await h.login({ name: 'bo', password: PW }, '192.0.2.70', k1)).status, 200);
  // The browser keeps its device id for the audit log, whoever signed in there.
  const id = h.events[h.events.length - 1].actor.device;
  assert.ok(k1.includes(id));
  assert.equal(h.auth.actorOf(asReq(k1)).device, id);
});

test("an account's sign-in takes back only its own attempt: it never gives an address more guesses at the owner", async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  const ip = '198.51.100.9';
  for (let i = 0; i < 4; i++) assert.equal((await h.login({ password: `guess ${i}` }, ip)).status, 401);
  assert.equal((await h.login({ name: 'bo', password: PW }, ip)).status, 200);
  assert.equal((await h.login({ password: 'guess 4' }, ip)).status, 401, "the address's fifth and last free guess");
  assert.equal((await h.login({ password: ADMIN }, ip)).status, 429, "bo's sign-in did not reset the address");
  assert.equal((await h.login({ name: 'bo', password: PW }, ip)).status, 429);
  // The owner's own sign-in still starts the address over, as before.
  h.advance(31e3);
  assert.equal((await h.login({ password: ADMIN }, ip)).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await h.login({ password: `again ${i}` }, ip)).status, 401);
});

test("pressure mode: an account's cookie exempts no one else, and account sign-ins never lower it", async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  h.store.create({ name: 'cy', role: 'viewer', password: PW });
  const k = cookiesOf(await h.login({ name: 'bo', password: PW }, '198.51.100.1'))
    .split('; ')
    .find((c) => c.startsWith('zp_known='));
  // Fifty failures from fifty addresses: distributed guessing, one free try per fresh address.
  for (let a = 1; a <= 50; a++) assert.equal((await h.login({ password: 5 }, `203.0.113.${a}`)).status, 401);
  for (const [name, ip] of [
    [undefined, '192.0.2.80'],
    ['cy', '192.0.2.81'],
  ]) {
    assert.equal((await h.login({ name, password: 'wrong' }, ip, k)).status, 401);
    assert.equal(
      (await h.login({ name, password: 'wrong' }, ip, k)).status,
      429,
      `${name || 'owner'} with bo's cookie`,
    );
  }
  // bo's own browser is exempt; bo's sign-ins from fresh addresses do not end the pressure.
  assert.equal((await h.login({ name: 'bo', password: 'wrong' }, '192.0.2.82', k)).status, 401);
  assert.equal((await h.login({ name: 'bo', password: PW }, '192.0.2.82', k)).status, 200);
  for (let a = 1; a <= 5; a++)
    assert.equal((await h.login({ name: 'bo', password: PW }, `192.0.2.${100 + a}`)).status, 200);
  assert.equal((await h.login({ password: 'wrong' }, '192.0.2.90')).status, 401);
  assert.equal((await h.login({ password: 'wrong' }, '192.0.2.90')).status, 429, 'still one free try');
});

test("an owner's known-device cookie of the old format (before accounts) still exempts the owner", async (t) => {
  const h = harness(t);
  await h.login({ password: ADMIN }, '198.51.100.1'); // makes the signing key
  const key = Buffer.from(fs.readFileSync(path.join(h.dataDir, '.data', 'local-auth.key'), 'utf8').trim(), 'base64');
  const id = 'AbCdEfGhIjKlMnOp';
  const body = `${id}.${Date.UTC(2027, 0, 1)}`;
  const old = `zp_known=${body}.${crypto.createHmac('sha256', key).update(`known:${body}`).digest('base64url')}`;
  const ip = '198.51.100.20';
  for (let i = 0; i < 5; i++) assert.equal((await h.login({ password: `wrong ${i}` }, ip)).status, 401);
  assert.equal((await h.login({ password: ADMIN }, ip)).status, 429);
  const r = await h.login({ password: ADMIN }, ip, old);
  assert.equal(r.status, 200, 'the old cookie gets the owner in');
  assert.equal(h.events[h.events.length - 1].actor.device, id);
  assert.ok(cookiesOf(r).includes(`zp_known=${id}.`), 'the browser keeps its id');
});

test('a sign-in ends the session the browser held before; a body that is not an object is a wrong password', async (t) => {
  const h = harness(t);
  h.store.create({ name: 'bo', role: 'viewer', password: PW });
  h.store.create({ name: 'cy', role: 'viewer', password: PW });
  const bo = cookiesOf(await h.login({ name: 'bo', password: PW }, '10.0.0.1'));
  const cy = await h.login({ name: 'cy', password: PW }, '10.0.0.1', bo);
  assert.equal(cy.status, 200);
  assert.equal(h.auth.check(asReq(bo)), false, "bo's token is gone from the server");
  assert.equal(h.auth.sessionOf(asReq(cookiesOf(cy))).user, 'cy');
  let n = 0;
  for (const body of [null, [], 'x', 5, true]) {
    const r = await h.login(body, `10.0.1.${++n}`);
    assert.deepEqual([r.status, r.json], [401, { error: 'wrong name or password' }], JSON.stringify(body));
  }
});

test('a name that can never be an account has no lockout budget of its own; one that could has', async (t) => {
  assert.equal(ACCOUNT_NAME.source, NAME.source, 'the same name rule as lib/users/store.js');
  const h = harness(t);
  for (let a = 1; a <= 10; a++) await h.login({ name: 'not a name!', password: PW }, `203.0.113.${a}`);
  for (let a = 1; a <= 10; a++) await h.login({ name: 'x'.repeat(40), password: PW }, `203.0.114.${a}`);
  assert.deepEqual(
    h.events.filter((e) => e.action === 'auth.lockout'),
    [],
  );
  for (let a = 1; a <= 10; a++) await h.login({ name: 'nobody', password: PW }, `203.0.115.${a}`);
  assert.deepEqual(
    h.events.filter((e) => e.action === 'auth.lockout').map((e) => [e.seconds, e.target || null]),
    [[30, null]],
  );
});

test('local mode: accounts sign in with a name, the owner with `zaafpulse open`; neither sign-out ends the other', async (t) => {
  const h = harness(t, { env: { ZAAFPULSE_AUTH: 'local' }, host: '127.0.0.1' });
  h.store.create({ name: 'bo', role: 'reviewer', password: PW });
  for (const body of [{ password: 'anything at all' }, { name: 'owner', password: 'anything at all' }]) {
    const r = await h.login(body);
    assert.deepEqual([r.status, r.json.error], [400, 'the owner signs in with `zaafpulse open` on this machine']);
  }
  const code = localLoginCode(h.dataDir);
  const opened = await h.call('GET', `/auth/local?code=${code}`);
  assert.equal(opened.status, 200);
  const local = cookiesOf(opened);
  assert.match(local, /^zp_local=/);
  assert.equal(h.auth.sessionOf(asReq(local)).role, 'owner');
  // An account signs in in this browser: the owner's local cookie is cleared there.
  const r = await h.login({ name: 'bo', password: PW }, '127.0.0.1', local);
  assert.equal(r.status, 200);
  assert.ok([].concat(r.headers['set-cookie']).some((c) => /^zp_local=;/.test(c)));
  const bo = cookiesOf(r);
  assert.deepEqual(h.auth.sessionOf(asReq(bo)), { user: 'bo', role: 'reviewer', display: 'bo', mustChange: true });
  // The account signs out: the owner's local cookies (in other browsers) stay valid.
  assert.equal((await h.call('POST', '/api/logout', { body: {}, cookie: bo })).status, 200);
  assert.equal(h.auth.check(asReq(bo)), false);
  assert.equal(h.auth.check(asReq(local)), true);
  // A local sign-in ends an account's session in that browser.
  const again = await h.login({ name: 'bo', password: PW });
  const both = `${cookiesOf(again)}; ${local}`;
  const code2 = localLoginCode(h.dataDir);
  const o = await h.call('GET', `/auth/local?code=${code2}`, { cookie: both });
  assert.ok([].concat(o.headers['set-cookie']).some((c) => /^zp_session=;/.test(c)));
  assert.equal(h.auth.check(asReq(cookiesOf(again))), false);
  // Without accounts, local mode has no sign-in route at all (as before).
  const solo = harness(t, { env: { ZAAFPULSE_AUTH: 'local' }, host: '127.0.0.1', users: false });
  assert.equal((await solo.login({ name: 'bo', password: PW })).handled, false);
});

test('none mode: everyone is the owner, and there is no sign-in', async (t) => {
  const h = harness(t, { env: { ZAAFPULSE_AUTH: 'none' }, host: '127.0.0.1' });
  assert.deepEqual(h.auth.sessionOf(asReq('')), { user: 'owner', role: 'owner', display: 'Rifqi', mustChange: false });
  assert.equal((await h.login({ name: 'bo', password: PW })).handled, false);
  const s = await h.call('GET', '/api/session');
  assert.deepEqual([s.json.required, s.json.accounts, s.json.user, s.json.role], [false, false, 'owner', 'owner']);
});
