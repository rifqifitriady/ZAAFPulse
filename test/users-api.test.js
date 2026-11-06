// Dashboard users (AI Governance 4): the accounts router (lib/users/api.js) with a real store in a temp folder and a
// stand-in auth: each action's fields, the 400s, one governance entry per change (never a password), the sessions a
// change ends, the owner's names list, an account changing its own password, and no accounts without sign-in. Also
// the request entry of a refused read (lib/governance/events.js always).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUsersApi } = require('../lib/users/api');
const { createUserStore } = require('../lib/users/store');
const { requestEntry } = require('../lib/governance/events');

const PW = 'a long password 1';
function setup(t, { mode = 'password', who = { user: 'owner', role: 'owner' }, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'users.json');
  const store = createUserStore({ file });
  const st = { ended: [], changed: 0, entries: [], who };
  const auth = {
    mode,
    sessionOf: () => st.who,
    endSessions: (name, keep) => st.ended.push([name, keep ? 'kept one' : 'all']),
    passwordChanged: () => st.changed++,
  };
  const api = createUsersApi({
    store,
    auth,
    record: (e) => st.entries.push(e),
    ownerName: () => 'Rifqi',
    ...(now ? { now } : {}),
  });
  const call = (p, { method = 'GET', body, contentType = 'application/json' } = {}) =>
    api.route({
      method,
      path: p,
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      req: { id: 'this request' },
    });
  const post = (body) => call('/api/users', { method: 'POST', body });
  return { api, store, st, call, post, file };
}

test('create, list, update, reset and delete: one entry each, the sessions a change ends, never a password', async (t) => {
  const s = setup(t);
  const made = await s.post({ action: 'create', name: 'vera', display: 'Vera', role: 'viewer', password: PW });
  assert.equal(made.status, 200);
  assert.deepEqual([made.body.user.name, made.body.user.mustChange], ['vera', true]);
  await s.post({ action: 'create', name: 'rex', role: 'reviewer', password: PW });
  const list = await s.call('/api/users');
  assert.deepEqual([list.status, list.body.mode, list.body.state], [200, 'password', 'ok']);
  assert.deepEqual(
    list.body.users.map((u) => [u.name, u.role]),
    [
      ['rex', 'reviewer'],
      ['vera', 'viewer'],
    ],
  );
  assert.ok(!JSON.stringify(list.body).includes('hash') && !JSON.stringify(list.body).includes('salt'));
  assert.deepEqual((await s.call('/api/users/names')).body, { names: ['Rifqi', 'rex', 'Vera'] });
  // A display name alone ends no session; a new role or a disabled account ends them.
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', display: 'Vera K' })).body.changed, ['display']);
  assert.deepEqual(s.st.ended, []);
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', role: 'reviewer' })).body.changed, ['role']);
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', disabled: true })).body.changed, ['disabled']);
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', disabled: false })).body.changed, ['disabled']);
  assert.deepEqual((await s.post({ action: 'update', name: 'vera', disabled: false })).body.changed, []);
  assert.equal((await s.post({ action: 'reset', name: 'vera', password: 'another password 2' })).status, 200);
  assert.equal((await s.post({ action: 'delete', name: 'rex' })).status, 200);
  assert.deepEqual(s.st.ended, [
    ['vera', 'all'],
    ['vera', 'all'],
    ['vera', 'all'],
    ['rex', 'all'],
  ]);
  assert.deepEqual(s.st.entries, [
    { action: 'user.create', target: { type: 'user', id: 'vera' }, role: 'viewer' },
    { action: 'user.create', target: { type: 'user', id: 'rex' }, role: 'reviewer' },
    {
      action: 'user.update',
      target: { type: 'user', id: 'vera' },
      changes: [{ path: 'display', from: 'Vera', to: 'Vera K' }],
    },
    {
      action: 'user.update',
      target: { type: 'user', id: 'vera' },
      changes: [{ path: 'role', from: 'viewer', to: 'reviewer' }],
    },
    {
      action: 'user.update',
      target: { type: 'user', id: 'vera' },
      changes: [{ path: 'disabled', from: false, to: true }],
    },
    {
      action: 'user.update',
      target: { type: 'user', id: 'vera' },
      changes: [{ path: 'disabled', from: true, to: false }],
    },
    { action: 'user.password_reset', target: { type: 'user', id: 'vera' } },
    { action: 'user.delete', target: { type: 'user', id: 'rex' }, role: 'reviewer' },
  ]);
  assert.ok(!JSON.stringify(s.st.entries).includes(PW));
});

test('bad input: the action, unknown fields, each field, an unknown account, the method and the body', async (t) => {
  const s = setup(t);
  const err = async (body) => {
    const r = await s.post(body);
    return [r.status, r.body.error];
  };
  assert.deepEqual(await err({ action: 'promote', name: 'x' }), [400, 'action: create, update, reset or delete']);
  assert.deepEqual(await err({ name: 'x' }), [400, 'action: create, update, reset or delete']);
  assert.deepEqual(await err({ action: 'delete', name: 'x', password: PW }), [400, 'password: not a field of delete']);
  const bad = await s.post({ action: 'create', name: 'X', role: 'admin', password: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errors.length, 3);
  assert.deepEqual(await err({ action: 'update', name: 'nobody', role: 'viewer' }), [404, 'no such account']);
  assert.deepEqual(await err({ action: 'reset', name: 'nobody', password: PW }), [404, 'no such account']);
  assert.equal((await s.call('/api/users', { method: 'PUT', body: {} })).status, 405);
  assert.equal((await s.call('/api/users/names', { method: 'POST', body: {} })).status, 405);
  assert.equal((await s.call('/api/account/password')).status, 405);
  assert.equal((await s.call('/api/users', { method: 'POST', body: '{}', contentType: 'text/plain' })).status, 415);
  assert.deepEqual((await s.call('/api/users', { method: 'POST', body: '{ torn' })).body, {
    error: 'bad request body',
  });
  assert.deepEqual((await s.call('/api/users', { method: 'POST', body: '[1]' })).body, { error: 'bad request body' });
  assert.equal(await s.api.route({ method: 'GET', path: '/api/usersx' }), null);
  assert.deepEqual(s.st.entries, [], 'nothing refused is an entry here (the request entry records it)');
});

test('an account changes its own password: the current one first, then a new one; its other sessions end', async (t) => {
  const s = setup(t);
  s.store.create({ name: 'vera', role: 'viewer', password: PW });
  s.st.who = { user: 'vera', role: 'viewer', mustChange: true };
  const own = (body) => s.call('/api/account/password', { method: 'POST', body });
  assert.deepEqual((await own({ current: 'wrong password!', next: 'my new password 3' })).body, {
    error: 'current: not your password',
  });
  assert.deepEqual((await own({ current: PW, next: PW })).body, {
    error: 'next: must differ from the current password',
  });
  assert.deepEqual((await own({ current: PW, next: 'short' })).body.error, 'next: at least 12 characters');
  assert.deepEqual(
    (await own({ current: PW, next: 'my new password 3', name: 'rex' })).body.error,
    'name: not a field',
  );
  assert.deepEqual(s.st.ended, []);
  const ok = await own({ current: PW, next: 'my new password 3' });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
  assert.deepEqual(s.st.ended, [['vera', 'kept one']]);
  assert.equal(s.st.changed, 1);
  assert.equal(s.store.get('vera').mustChange, false);
  assert.deepEqual(s.st.entries, [{ action: 'account.password_change', target: { type: 'user', id: 'vera' } }]);
  // The owner's own password is not changed here.
  s.st.who = { user: 'owner', role: 'owner' };
  assert.deepEqual((await own({ current: 'x', next: 'y' })).body, {
    error: "the owner's password is set with `zaafpulse set-password` on the server",
  });
});

test('five wrong current passwords in 15 minutes hold a session for 15 minutes; another session is not held', async (t) => {
  let clock = Date.UTC(2026, 0, 1);
  const s = setup(t, { now: () => clock });
  s.store.create({ name: 'vera', role: 'viewer', password: PW });
  s.st.who = { user: 'vera', role: 'viewer', mustChange: true };
  const own = (body, token = 'one') =>
    s.api.route({
      method: 'POST',
      path: '/api/account/password',
      contentType: 'application/json',
      readBody: async () => JSON.stringify(body),
      req: { headers: { cookie: `zp_known=x; zp_session=${token}` } },
    });
  const wrong = { current: 'wrong password!', next: 'my new password 3' };
  // Four failures, then a quiet 15 minutes: they no longer count.
  for (let i = 0; i < 4; i++) assert.equal((await own(wrong)).status, 400);
  clock += 15 * 60e3 + 1;
  for (let i = 0; i < 4; i++) assert.equal((await own(wrong)).status, 400);
  // The fifth within 15 minutes: from here on the session is held, the right password too, and nothing is checked.
  assert.equal((await own(wrong)).status, 400);
  const held = await own({ current: PW, next: 'my new password 3' });
  assert.deepEqual([held.status, held.body], [429, { error: 'too many wrong passwords; try again in 15 min' }]);
  // Another session of the same account has its own count.
  assert.equal((await own(wrong, 'two')).status, 400);
  clock += 15 * 60e3 - 1000;
  assert.deepEqual((await own({ current: PW, next: 'my new password 3' })).body, {
    error: 'too many wrong passwords; try again in 1 min',
  });
  assert.equal(s.store.get('vera').mustChange, true);
  clock += 1000;
  assert.deepEqual((await own({ current: PW, next: 'my new password 3' })).body, { ok: true });
  assert.deepEqual(s.st.entries, [{ action: 'account.password_change', target: { type: 'user', id: 'vera' } }]);
});

test('parallel guesses on one session cannot pass the five: each counts before its check', async (t) => {
  const s = setup(t);
  s.store.create({ name: 'vera', role: 'viewer', password: PW });
  s.st.who = { user: 'vera', role: 'viewer', mustChange: false };
  const own = (current) =>
    s.call('/api/account/password', { method: 'POST', body: { current, next: 'my new password 3' } });
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => own(`wrong password ${i}`)));
  assert.deepEqual(all.map((r) => r.status).sort(), [400, 400, 400, 400, 400, 429, 429, 429]);
});

test("the accounts are the owner's: another role is refused here too, and nothing is written", async (t) => {
  const s = setup(t, { who: { user: 'rex', role: 'reviewer', mustChange: false } });
  const denied = [403, { error: 'your role cannot do this' }];
  const list = await s.call('/api/users');
  assert.deepEqual([list.status, list.body], denied);
  const made = await s.post({ action: 'create', name: 'vera', role: 'viewer', password: PW });
  assert.deepEqual([made.status, made.body], denied);
  assert.equal(fs.existsSync(s.file), false);
  assert.deepEqual([s.st.entries, s.st.ended], [[], []]);
});

test('without sign-in there are no accounts: the list says off and a change is refused', async (t) => {
  const s = setup(t, { mode: 'none' });
  assert.deepEqual((await s.call('/api/users')).body, { mode: 'none', state: 'off', users: [] });
  assert.deepEqual((await s.post({ action: 'create', name: 'vera', role: 'viewer', password: PW })).body, {
    error: 'accounts need sign-in: ZAAFPULSE_AUTH=none has no accounts',
  });
  assert.deepEqual((await s.call('/api/users/names')).body, { names: ['Rifqi'] });
});

test('an unreadable accounts file: the list says so and nothing is written', async (t) => {
  const s = setup(t);
  await s.post({ action: 'create', name: 'vera', role: 'viewer', password: PW });
  fs.writeFileSync(s.file, '{ torn');
  assert.deepEqual((await s.call('/api/users')).body, { mode: 'password', state: 'unreadable', users: [] });
  const r = await s.post({ action: 'delete', name: 'vera' });
  assert.deepEqual(
    [r.status, r.body.error],
    [409, 'users.json could not be read; nothing was written (fix or move .data/users.json)'],
  );
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{ torn');
});

test('a refused read is an entry when asked for (always), with no body field but the short ones', () => {
  const read = { method: 'GET', path: '/api/trace/content', status: 403 };
  assert.equal(requestEntry({ ...read, status: 200 }).action, 'GET /api/trace/content');
  assert.equal(
    requestEntry({ method: 'POST', path: '/api/gateway/knowledge', status: 403, body: '{"action":"get"}' }),
    null,
  );
  assert.deepEqual(
    requestEntry({
      method: 'POST',
      path: '/api/gateway/knowledge',
      status: 403,
      body: '{"action":"get","query":"x"}',
      always: true,
    }),
    { action: 'POST /api/gateway/knowledge', op: 'get', outcome: 'refused', status: 403 },
  );
  assert.deepEqual(requestEntry({ ...read, always: true }), {
    action: 'GET /api/trace/content',
    outcome: 'refused',
    status: 403,
  });
});

test('an empty or invalid password-change body counts against the session as a wrong password does', async (t) => {
  const s = setup(t);
  s.store.create({ name: 'vera', role: 'viewer', password: PW });
  s.st.who = { user: 'vera', role: 'viewer', mustChange: false };
  const own = (body) => s.call('/api/account/password', { method: 'POST', body });
  const bad = [{}, { current: 1 }, { current: PW, nope: 1 }, 'not json', '[]'];
  const got = [];
  for (const body of bad) got.push((await own(body)).status);
  assert.deepEqual(got, [400, 400, 400, 400, 400]);
  const held = await own({ current: PW, next: 'my new password 3' });
  assert.deepEqual([held.status, held.body], [429, { error: 'too many wrong passwords; try again in 15 min' }]);
  // The owner is not an account: its answer stays the same, never held.
  s.st.who = { user: 'owner', role: 'owner' };
  for (let i = 0; i < 6; i++) assert.equal((await own({})).status, 400);
});
