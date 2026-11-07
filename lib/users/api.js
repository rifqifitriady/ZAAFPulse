// The HTTP side of the dashboard accounts (AI Governance 4). server.js puts it behind the sign-in and the role policy
// (lib/users/policy.js): /api/users is the owner's, /api/users/names a reviewer's too, /api/account/password anyone's.
//   GET  /api/users                 { mode, state, users }  state: 'ok' | 'unreadable' | 'off' (no sign-in)
//   POST /api/users                 { action: 'create', name, display?, role, password }
//                                   { action: 'update', name, role?, display?, disabled? }
//                                   { action: 'reset', name, password }      a new password, to be changed at sign-in
//                                   { action: 'delete', name }
//   GET  /api/users/names           { names }  the owner's and the accounts' display names (review owner suggestions)
//   POST /api/account/password      { current, next }  the signed-in account changes its own password
// Every change is one governance entry (user.create, user.update, user.password_reset, user.delete,
// account.password_change) with the account as its target, never a password. A new role, a disabled or deleted account
// and a new password end the account's sessions at once. A wrong current password is throttled per session: after
// FAILS_PER_SESSION within FAIL_WINDOW_MS the session gets 429 for HOLD_MS (the request entry records it as refused).
const FIELDS = {
  create: ['name', 'display', 'role', 'password'],
  update: ['name', 'role', 'display', 'disabled'],
  reset: ['name', 'password'],
  delete: ['name'],
};
const OFF = 'accounts need sign-in: ZAAFPULSE_AUTH=none has no accounts';
const DENIED = 'your role cannot do this';
const FAILS_PER_SESSION = 5;
const FAIL_WINDOW_MS = 15 * 60e3;
const HOLD_MS = 15 * 60e3;
const MAX_HELD = 10000; // sessions remembered, so the map cannot grow without bound

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const failed = (e) => reply(e.status, { error: e.message, errors: e.errors || [e.message] });

// The session a request holds (its zp_session cookie), for the throttle; '' when it has none.
const sessionToken = (req) => {
  const m = /(?:^|;\s*)zp_session=([^;]*)/.exec(String((req && req.headers && req.headers.cookie) || ''));
  return m ? m[1] : '';
};

// store: lib/users/store.js; auth: lib/auth.js (sessionOf, endSessions, passwordChanged); record(entry): the governance
// audit log; ownerName(): the owner's display name; now(): the clock of the throttle.
function createUsersApi({ store, auth, record = () => {}, ownerName = () => 'Owner', now = Date.now }) {
  const off = () => auth.mode === 'none' || !store;
  // Per session: the times of its recent wrong current passwords, and until when it is held.
  const tries = new Map();
  const triesOf = (key) => {
    const t = now();
    // Sessions that are not held and had no recent wrong password are forgotten.
    for (const [k, v] of tries) if (v.until <= t && !v.fails.some((x) => t - x < FAIL_WINDOW_MS)) tries.delete(k);
    if (!tries.has(key)) {
      if (tries.size >= MAX_HELD) tries.delete(tries.keys().next().value);
      tries.set(key, { fails: [], until: 0 });
    }
    const v = tries.get(key);
    v.fails = v.fails.filter((x) => t - x < FAIL_WINDOW_MS);
    return v;
  };
  const target = (name) => ({ type: 'user', id: String(name).slice(0, 80) });
  const note = (entry) => {
    try {
      record(entry);
    } catch {
      /* the change stands (A6) */
    }
  };

  function list() {
    if (off()) return reply(200, { mode: auth.mode, state: 'off', users: [] });
    const r = store.list();
    return reply(200, { mode: auth.mode, state: r.state, users: r.users });
  }
  function names() {
    const own = String(ownerName() || 'Owner');
    const rest = off() ? [] : store.names();
    return reply(200, { names: [own, ...rest.filter((n) => n !== own)] });
  }

  function change(body) {
    if (off()) return reply(409, { error: OFF });
    const fields = FIELDS[body.action];
    if (!fields) return reply(400, { error: 'action: create, update, reset or delete' });
    const extra = Object.keys(body).filter((k) => k !== 'action' && !fields.includes(k));
    if (extra.length) return reply(400, { error: `${extra[0]}: not a field of ${body.action}` });
    const { name } = body;
    if (body.action === 'create') {
      const { user } = store.create(body);
      note({ action: 'user.create', target: target(user.name), role: user.role });
      return reply(200, { user });
    }
    if (body.action === 'update') {
      const before = store.get(name);
      const { user, changed } = store.update(name, { role: body.role, display: body.display, disabled: body.disabled });
      if (changed.length) {
        if (changed.includes('role') || (changed.includes('disabled') && user.disabled)) auth.endSessions(user.name);
        note({
          action: 'user.update',
          target: target(user.name),
          changes: changed.map((k) => ({ path: k, from: before[k], to: user[k] })),
        });
      }
      return reply(200, { user, changed });
    }
    if (body.action === 'reset') {
      const { user } = store.resetPassword(name, body.password);
      auth.endSessions(user.name);
      note({ action: 'user.password_reset', target: target(user.name) });
      return reply(200, { user });
    }
    const { user } = store.remove(name);
    auth.endSessions(user.name);
    note({ action: 'user.delete', target: target(user.name), role: user.role });
    return reply(200, { user });
  }

  // `body` is the parsed object, or null when the body was not one (`bad`: its status and message).
  async function ownPassword(body, req, bad = null) {
    const who = auth.sessionOf(req, false);
    if (!who || who.role === 'owner')
      return reply(400, { error: "the owner's password is set with `zaafpulse set-password` on the server" });
    if (off()) return reply(409, { error: OFF });
    const held = triesOf(`${who.user}\n${sessionToken(req)}`);
    const t = now();
    if (held.until > t || held.fails.length >= FAILS_PER_SESSION) {
      // Held, or five checks of this session still running: they would hold it from their own time.
      const end = held.until > t ? held.until : Math.max(...held.fails) + HOLD_MS;
      return reply(429, { error: `too many wrong passwords; try again in ${Math.ceil((end - t) / 60e3)} min` });
    }
    // Counted before the check, so parallel guesses on one session cannot all slip through; taken back when right. A
    // body that is not a password change counts the same, so empty posts cannot go on for ever either.
    held.fails.push(t);
    const miss = (status, error) => {
      if (held.fails.length >= FAILS_PER_SESSION) held.until = Math.max(...held.fails) + HOLD_MS;
      return reply(status, { error });
    };
    if (bad) return miss(bad.status, bad.error);
    const { current, next } = body;
    const extra = Object.keys(body).filter((k) => k !== 'current' && k !== 'next');
    if (extra.length) return miss(400, `${extra[0]}: not a field`);
    if (typeof current !== 'string') return miss(400, 'current: not your password');
    if (!(await store.verify(who.user, current))) return miss(400, 'current: not your password');
    const mine = held.fails.lastIndexOf(t);
    if (mine >= 0) held.fails.splice(mine, 1);
    if (next === current) return reply(400, { error: 'next: must differ from the current password' });
    store.changePassword(who.user, next);
    // Every other session of the account ends; this one goes on without the mustChange gate.
    auth.endSessions(who.user, req);
    auth.passwordChanged(req);
    note({ action: 'account.password_change', target: target(who.user) });
    return reply(200, { ok: true });
  }

  // `r` is { method, path, contentType, readBody, req }. Returns { status, body }, or null when the path is not ours.
  async function route(r) {
    const p = r.path;
    if (p !== '/api/users' && p !== '/api/users/names' && p !== '/api/account/password') return null;
    const post = p !== '/api/users/names' && r.method === 'POST';
    const get = p !== '/api/account/password' && r.method === 'GET';
    if (!post && !get) return reply(405, { error: 'method not allowed' });
    // The accounts are the owner's. The role policy in server.js refuses anyone else first; this holds without it too.
    if (p === '/api/users') {
      const who = auth.sessionOf(r.req, false);
      if (!who || who.role !== 'owner') return reply(403, { error: DENIED });
    }
    if (get) return p === '/api/users' ? list() : names();
    // A change needs JSON, so a simple cross-site form post cannot make one.
    if (!(r.contentType || '').startsWith('application/json')) return reply(415, { error: 'json only' });
    let body;
    let bad = null;
    try {
      body = JSON.parse(await r.readBody());
    } catch (e) {
      bad = { status: e && e.message === 'too large' ? 413 : 400, error: 'bad request body' };
    }
    if (!bad && !isObj(body)) bad = { status: 400, error: 'bad request body' };
    // An account's own bad body counts against its session (ownPassword); the owner's routes just refuse it.
    if (bad && p === '/api/account/password') return ownPassword(null, r.req, bad);
    if (bad) return reply(bad.status, { error: bad.error });
    try {
      return p === '/api/users' ? change(body) : await ownPassword(body, r.req);
    } catch (e) {
      // A store error has a status and a message without a path; anything else is a plain 500.
      if (e && Number.isInteger(e.status)) return failed(e);
      return reply(500, { error: 'accounts request failed' });
    }
  }

  return { route };
}

module.exports = { createUsersApi, FIELDS, OFF };
