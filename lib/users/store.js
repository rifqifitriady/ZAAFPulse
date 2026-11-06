// Dashboard accounts (AI Governance 4): the people the owner lets sign in, in .data/users.json (0600, written whole and
// atomically through lib/cost/files.js writePrivate). The owner is not in the file: the admin password (lib/auth.js)
// signs in as user "owner". A password is kept as a scrypt hash with the admin password's parameters; no password,
// salt or hash ever leaves this module (view()). A file that cannot be read is never written over: nobody in it can
// sign in until it is fixed, and the owner still can.
const crypto = require('crypto');
const fs = require('fs');
const { hashPassword, checkPassword, SCRYPT } = require('../auth');
const { writePrivate } = require('../cost/files');

const NAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const ROLES = ['reviewer', 'viewer'];
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const MAX_DISPLAY = 60;
const MAX_USERS = 200;
const UNREADABLE = 'users.json could not be read; nothing was written (fix or move .data/users.json)';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (status, message, errors) => Object.assign(new Error(message), { status, errors: errors || [message] });
const isTime = (v) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));

// The 400 messages, one per field; null when the value is fine.
function nameError(name) {
  if (typeof name !== 'string' || !NAME.test(name))
    return 'name: 2 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or a digit';
  if (name === 'owner') return 'name: owner is the admin password';
  return null;
}
const displayError = (v) =>
  typeof v === 'string' && v.trim().length <= MAX_DISPLAY ? null : `display: text of at most ${MAX_DISPLAY} characters`;
const roleError = (v) => (ROLES.includes(v) ? null : 'role: reviewer or viewer');
function passwordError(v, field = 'password') {
  if (typeof v !== 'string' || v.length < MIN_PASSWORD) return `${field}: at least ${MIN_PASSWORD} characters`;
  if (v.length > MAX_PASSWORD) return `${field}: at most ${MAX_PASSWORD} characters`;
  return null;
}

// A stored account as the file must hold it; one that does not makes the whole file unreadable.
const validStored = (u) =>
  isObj(u) &&
  typeof u.id === 'string' &&
  !nameError(u.name) &&
  typeof u.display === 'string' &&
  ROLES.includes(u.role) &&
  typeof u.salt === 'string' &&
  typeof u.hash === 'string' &&
  typeof u.disabled === 'boolean' &&
  typeof u.mustChange === 'boolean' &&
  [u.createdAt, u.updatedAt, u.lastLoginAt].every(isTime);

// What the rest of ZAAFPulse sees of an account: never the salt or the hash.
const view = (u) => ({
  id: u.id,
  name: u.name,
  display: u.display,
  role: u.role,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
  disabled: u.disabled,
  mustChange: u.mustChange,
  lastLoginAt: u.lastLoginAt,
});

function createUserStore({ file, now = Date.now, maxUsers = MAX_USERS }) {
  const iso = () => new Date(now()).toISOString();
  // A hash to check against when there is no such account, so a wrong name takes as long as a wrong password.
  let dummy = null;
  const dummyRec = () => (dummy ||= hashPassword(crypto.randomBytes(16).toString('hex')));
  const recOf = (u) => ({ algo: 'scrypt', ...SCRYPT, salt: u.salt, hash: u.hash });
  const secretOf = (password) => {
    const { salt, hash } = hashPassword(password);
    return { salt, hash };
  };

  // { state: 'ok' | 'unreadable', users }: a missing file is no account yet.
  function read() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return e && e.code === 'ENOENT' ? { state: 'ok', users: [] } : { state: 'unreadable', users: [] };
    }
    try {
      const d = JSON.parse(text);
      if (!isObj(d) || !Array.isArray(d.users) || !d.users.every(validStored)) throw new Error('bad shape');
      if (new Set(d.users.map((u) => u.name)).size !== d.users.length) throw new Error('a name twice');
      return { state: 'ok', users: d.users };
    } catch {
      return { state: 'unreadable', users: [] };
    }
  }
  // The accounts to change, or a 409 when the file cannot be read (it is never written over).
  function writable() {
    const r = read();
    if (r.state !== 'ok') throw fail(409, UNREADABLE);
    return r.users;
  }
  const save = (users) => writePrivate(file, `${JSON.stringify({ users }, null, 2)}\n`);
  function found(users, name) {
    const u = users.find((x) => x.name === name);
    if (!u) throw fail(404, 'no such account');
    return u;
  }
  const check = (errors) => {
    const list = errors.filter(Boolean);
    if (list.length) throw fail(400, list[0], list);
  };

  return {
    // { state, users: views sorted by name }.
    list() {
      const r = read();
      return { state: r.state, users: r.users.map(view).sort((a, b) => a.name.localeCompare(b.name, 'en')) };
    },
    // The view of one account, or null (none, or the file cannot be read).
    get(name) {
      const u = read().users.find((x) => x.name === name);
      return u ? view(u) : null;
    },
    // The display names of the accounts that may sign in, sorted.
    names() {
      return read()
        .users.filter((u) => !u.disabled)
        .map((u) => u.display || u.name)
        .sort((a, b) => a.localeCompare(b, 'en'));
    },
    create(input) {
      const b = isObj(input) ? input : {};
      const display = b.display === undefined ? '' : b.display;
      check([nameError(b.name), displayError(display), roleError(b.role), passwordError(b.password)]);
      const users = writable();
      if (users.some((u) => u.name === b.name)) throw fail(400, 'name: already taken');
      if (users.length >= maxUsers) throw fail(400, `users: at most ${maxUsers} accounts`);
      const t = iso();
      const u = {
        id: `usr_${crypto.randomBytes(6).toString('hex')}`,
        name: b.name,
        display: display.trim(),
        role: b.role,
        ...secretOf(b.password),
        createdAt: t,
        updatedAt: t,
        disabled: false,
        mustChange: true,
        lastLoginAt: null,
      };
      save([...users, u]);
      return { user: view(u) };
    },
    // Changes role, display and disabled (each optional); `changed` names the fields whose value changed.
    update(name, input) {
      const b = isObj(input) ? input : {};
      check([
        b.role === undefined ? null : roleError(b.role),
        b.display === undefined ? null : displayError(b.display),
        b.disabled === undefined || typeof b.disabled === 'boolean' ? null : 'disabled: true or false',
      ]);
      const users = writable();
      const u = found(users, name);
      const next = {
        role: b.role === undefined ? u.role : b.role,
        display: b.display === undefined ? u.display : b.display.trim(),
        disabled: b.disabled === undefined ? u.disabled : b.disabled,
      };
      const changed = ['role', 'display', 'disabled'].filter((k) => next[k] !== u[k]);
      if (!changed.length) return { user: view(u), changed };
      Object.assign(u, next, { updatedAt: iso() });
      save(users);
      return { user: view(u), changed };
    },
    // The owner sets a new password: the account must change it at its next sign-in.
    resetPassword(name, password) {
      check([passwordError(password)]);
      const users = writable();
      const u = found(users, name);
      Object.assign(u, secretOf(password), { mustChange: true, updatedAt: iso() });
      save(users);
      return { user: view(u) };
    },
    // The account changes its own password (checked by the caller): mustChange ends.
    changePassword(name, next) {
      check([passwordError(next, 'next')]);
      const users = writable();
      const u = found(users, name);
      Object.assign(u, secretOf(next), { mustChange: false, updatedAt: iso() });
      save(users);
      return { user: view(u) };
    },
    remove(name) {
      const users = writable();
      const u = found(users, name);
      save(users.filter((x) => x !== u));
      return { user: view(u) };
    },
    // The view of the account when the name and password match and it may sign in, else null. A missing account is
    // checked against a hash of its own, so the time does not tell whether the name exists.
    async verify(name, password) {
      if (typeof password !== 'string' || password.length > MAX_PASSWORD) return null;
      const u = read().users.find((x) => x.name === name);
      const ok = await checkPassword(password, u ? recOf(u) : dummyRec());
      return ok && u && !u.disabled ? view(u) : null;
    },
    // A sign-in: lastLoginAt. Never fails the sign-in.
    touch(name) {
      try {
        const users = writable();
        const u = users.find((x) => x.name === name);
        if (!u) return;
        u.lastLoginAt = iso();
        save(users);
      } catch {
        /* the sign-in stands */
      }
    },
    state: () => read().state,
  };
}

module.exports = {
  createUserStore,
  nameError,
  displayError,
  roleError,
  passwordError,
  NAME,
  ROLES,
  MIN_PASSWORD,
  MAX_DISPLAY,
  MAX_USERS,
  UNREADABLE,
};
