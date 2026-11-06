// Dashboard users (AI Governance 4): the accounts file (lib/users/store.js). Names, display names, roles and passwords
// are checked field by field; a password is a scrypt hash with the admin password's parameters and never comes out; the
// file is private and written whole; a file that cannot be read is never written over and lets nobody in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserStore, nameError, MIN_PASSWORD } = require('../lib/users/store');
const { SCRYPT } = require('../lib/auth');

const NOW = Date.UTC(2026, 10, 4, 9);
function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.data', 'users.json');
  let at = NOW;
  const store = createUserStore({ file, now: () => at, ...opts });
  return { store, file, dir, tick: (ms) => (at += ms) };
}
const PW = 'a long password 1';
const FIELDS = ['id', 'name', 'display', 'role', 'createdAt', 'updatedAt', 'disabled', 'mustChange', 'lastLoginAt'];

test('create: the view has no secret, the file holds a scrypt hash, is private, and the new account must change', async (t) => {
  const s = setup(t);
  assert.deepEqual(s.store.list(), { state: 'ok', users: [] }, 'no file yet is no account');
  const { user } = s.store.create({ name: 'ana.k', display: '  Ana K ', role: 'viewer', password: PW });
  assert.deepEqual(Object.keys(user), FIELDS);
  assert.match(user.id, /^usr_[0-9a-f]{12}$/);
  assert.deepEqual(
    [user.name, user.display, user.role, user.disabled, user.mustChange, user.lastLoginAt],
    ['ana.k', 'Ana K', 'viewer', false, true, null],
  );
  assert.equal(user.createdAt, '2026-11-04T09:00:00.000Z');
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['users']);
  assert.equal(saved.users.length, 1);
  assert.ok(saved.users[0].salt && saved.users[0].hash);
  assert.ok(!fs.readFileSync(s.file, 'utf8').includes(PW));
  if (process.platform !== 'win32') assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(Buffer.from(saved.users[0].hash, 'base64').length, SCRYPT.keylen);
  assert.ok(!JSON.stringify(s.store.list()).includes(saved.users[0].hash));
  assert.deepEqual((await s.store.verify('ana.k', PW)).name, 'ana.k');
  assert.equal(await s.store.verify('ana.k', 'a long password 2'), null);
  assert.equal(await s.store.verify('nobody', PW), null);
  assert.equal(await s.store.verify('ana.k', 7), null);
  assert.deepEqual(s.store.names(), ['Ana K']);
});

test('create: each field is checked, the first problem is the error and all are listed; nothing is written', (t) => {
  const s = setup(t);
  const err = (input) => {
    try {
      s.store.create(input);
    } catch (e) {
      return [e.status, e.message, e.errors];
    }
    return null;
  };
  assert.deepEqual(err({ name: 'A', display: 'x'.repeat(61), role: 'owner', password: 'short' }), [
    400,
    'name: 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or a digit',
    [
      'name: 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or a digit',
      'display: text of at most 60 characters',
      'role: reviewer or viewer',
      `password: at least ${MIN_PASSWORD} characters`,
    ],
  ]);
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(err({ name: 'owner', role: 'viewer', password: PW })[1], 'name: owner is the admin password');
  assert.equal(err({ name: 'bo', role: 'viewer', password: 'x'.repeat(1025) })[1], 'password: at most 1024 characters');
  for (const ok of ['bo', 'a1', 'ana.k_2-x', 'z'.repeat(32)]) assert.equal(nameError(ok), null, ok);
  for (const bad of ['b', '.ana', '-ana', 'Ana', 'ana k', 'z'.repeat(33), 'ana/x', 7, null])
    assert.ok(nameError(bad), String(bad));
  s.store.create({ name: 'bo', role: 'reviewer', password: PW });
  assert.deepEqual(err({ name: 'bo', role: 'viewer', password: PW }), [
    400,
    'name: already taken',
    ['name: already taken'],
  ]);
  const small = setup(t, { maxUsers: 1 });
  small.store.create({ name: 'bo', role: 'reviewer', password: PW });
  assert.throws(() => small.store.create({ name: 'cy', role: 'viewer', password: PW }), /users: at most 1 accounts/);
});

test('update, reset, change and remove: what changed is named; a disabled account cannot sign in', async (t) => {
  const s = setup(t);
  s.store.create({ name: 'bo', display: 'Bo', role: 'viewer', password: PW });
  s.tick(60e3);
  assert.deepEqual(s.store.update('bo', { role: 'viewer' }).changed, []);
  const up = s.store.update('bo', { role: 'reviewer', display: 'Bo R', disabled: true });
  assert.deepEqual(up.changed, ['role', 'display', 'disabled']);
  assert.deepEqual([up.user.role, up.user.display, up.user.disabled], ['reviewer', 'Bo R', true]);
  assert.equal(up.user.updatedAt, '2026-11-04T09:01:00.000Z');
  assert.equal(await s.store.verify('bo', PW), null, 'disabled');
  assert.deepEqual(s.store.names(), []);
  assert.throws(() => s.store.update('bo', { disabled: 'yes' }), /disabled: true or false/);
  assert.throws(
    () => s.store.update('cy', { role: 'viewer' }),
    (e) => e.status === 404 && e.message === 'no such account',
  );
  s.store.update('bo', { disabled: false });
  const reset = s.store.resetPassword('bo', 'another password 3');
  assert.equal(reset.user.mustChange, true);
  assert.equal(await s.store.verify('bo', PW), null);
  assert.equal((await s.store.verify('bo', 'another password 3')).name, 'bo');
  assert.throws(() => s.store.changePassword('bo', 'short'), /next: at least 12 characters/);
  assert.equal(s.store.changePassword('bo', 'my own password 4').user.mustChange, false);
  assert.equal((await s.store.verify('bo', 'my own password 4')).mustChange, false);
  s.tick(1000);
  s.store.touch('bo');
  assert.equal(s.store.get('bo').lastLoginAt, '2026-11-04T09:01:01.000Z');
  assert.equal(s.store.remove('bo').user.name, 'bo');
  assert.equal(s.store.get('bo'), null);
  assert.throws(() => s.store.remove('bo'), /no such account/);
});

test('an unreadable file: nobody in it signs in, it is never written over, and the store says so', async (t) => {
  const s = setup(t);
  s.store.create({ name: 'bo', role: 'viewer', password: PW });
  for (const text of ['{ torn', '[]', '{"users":{}}', '{"users":[{"name":"bo"}]}']) {
    fs.writeFileSync(s.file, text);
    assert.deepEqual(s.store.list(), { state: 'unreadable', users: [] }, text);
    assert.equal(s.store.state(), 'unreadable');
    assert.equal(await s.store.verify('bo', PW), null);
    assert.throws(
      () => s.store.create({ name: 'cy', role: 'viewer', password: PW }),
      (e) => e.status === 409 && /users\.json could not be read; nothing was written/.test(e.message),
    );
    assert.throws(
      () => s.store.remove('bo'),
      (e) => e.status === 409,
    );
    s.store.touch('bo');
    assert.equal(fs.readFileSync(s.file, 'utf8'), text, 'never written over');
  }
  // The same name twice is a file someone edited by hand: unreadable too.
  const saved = setup(t);
  saved.store.create({ name: 'bo', role: 'viewer', password: PW });
  const d = JSON.parse(fs.readFileSync(saved.file, 'utf8'));
  fs.writeFileSync(saved.file, JSON.stringify({ users: [d.users[0], d.users[0]] }));
  assert.equal(saved.store.state(), 'unreadable');
});
