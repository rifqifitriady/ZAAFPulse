// Dashboard sign-in. Three modes:
//   none      127.0.0.1 on a single-user machine (the default): no sign-in
//   local     ZAAFPULSE_AUTH=local, or Linux with other login users: only this OS account can open the
//             dashboard. `zaafpulse open` writes a one-time code into the private data folder and opens
//             the browser with it; the server swaps it for a signed cookie (survives restarts).
//   password  server mode (any host but 127.0.0.1), a reverse proxy or public URL, or ZAAFPULSE_AUTH=1:
//             one admin password, ZAAFPULSE_ADMIN_PASSWORD (or ..._FILE) or a scrypt hash saved by
//             `zaafpulse set-password`. Sessions are random tokens in memory.
// The gateway (/v1, /mcp, /a2a) keeps its own API keys; this guards the dashboard and its /api.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const COOKIE = 'zp_session';
const LOCAL_COOKIE = 'zp_local';
const SESSION_MS = 12 * 3600e3; // idle limit, renewed while used
const SESSION_MAX_MS = 7 * 24 * 3600e3; // absolute limit
const LOCAL_MS = 30 * 24 * 3600e3;
const CODE_TTL_MS = 2 * 60e3;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60e3;
const GLOBAL_FAILS = 50; // across all addresses per lock window, against distributed guessing
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { algo: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), hash: hash.toString('base64') };
}
async function checkPassword(password, rec) {
  if (!rec || rec.algo !== 'scrypt') return false;
  const want = Buffer.from(rec.hash, 'base64');
  const got = await scryptAsync(String(password), Buffer.from(rec.salt, 'base64'), want.length, {
    N: rec.N,
    r: rec.r,
    p: rec.p,
  });
  return crypto.timingSafeEqual(got, want);
}

// Other people who can log in to this Linux machine (a real shell and a uid of 1000 or more).
function otherLoginUsers(passwd = '/etc/passwd', me = process.getuid && process.getuid()) {
  try {
    return fs
      .readFileSync(passwd, 'utf8')
      .split('\n')
      .map((l) => l.split(':'))
      .filter((f) => f.length >= 7 && Number(f[2]) >= 1000 && Number(f[2]) < 65534 && Number(f[2]) !== me)
      .filter((f) => !/(nologin|false|sync)$/.test(f[6])).length;
  } catch {
    return 0;
  }
}

// The client address for lockouts: behind a trusted proxy, the right-most X-Forwarded-For entry (the one
// our proxy added; anything to its left is client-supplied); IPv6 counted per /64.
function clientKey(req, trustProxy) {
  let ip = req.socket.remoteAddress || '?';
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (xff.length) ip = xff[xff.length - 1];
  }
  ip = ip.replace(/^::ffff:/i, '');
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip;
}

function pickMode({ host, env, platform = process.platform, users = otherLoginUsers }) {
  if (env.ZAAFPULSE_AUTH === '1' || env.ZAAFPULSE_AUTH === 'password') return 'password';
  // Behind a reverse proxy the socket is local even for internet clients, so a proxy setup needs sign-in.
  if (!isLoopback(host) || env.ZAAFPULSE_TRUST_PROXY === '1' || env.ZAAFPULSE_PUBLIC_URL || env.ZAAFPULSE_ALLOWED_HOSTS)
    return 'password';
  if (env.ZAAFPULSE_AUTH === 'local') return 'local';
  if (env.ZAAFPULSE_AUTH === 'none') return 'none';
  if (platform === 'linux' && users() > 0) return 'local';
  return 'none';
}

function createAuth({ dataDir, host = '127.0.0.1', env = process.env, now = Date.now, platform, users }) {
  const dir = path.join(dataDir, '.data');
  const file = path.join(dir, 'admin.json');
  const mode = pickMode({ host, env, platform, users });
  const trustProxy = env.ZAAFPULSE_TRUST_PROXY === '1';
  const sessions = new Map(); // token -> { exp, max }
  const fails = new Map(); // client -> { n, until }
  const inflight = new Set(); // clients with a sign-in being checked
  let global = { n: 0, since: now(), until: 0 };
  const envPassword =
    env.ZAAFPULSE_ADMIN_PASSWORD ||
    (env.ZAAFPULSE_ADMIN_PASSWORD_FILE ? fs.readFileSync(env.ZAAFPULSE_ADMIN_PASSWORD_FILE, 'utf8').trim() : '');
  const envRec = envPassword ? hashPassword(envPassword) : null;
  const record = () => {
    if (envRec) return envRec;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  // Local mode: an HMAC key in the private data folder signs the cookie, so it survives restarts.
  let localKey = null;
  const localSecret = () => {
    if (localKey) return localKey;
    const f = path.join(dir, 'local-auth.key');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      localKey = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
    } catch {
      localKey = crypto.randomBytes(32);
      fs.writeFileSync(f, localKey.toString('base64') + '\n', { mode: 0o600 });
    }
    return localKey;
  };
  const sign = (exp) => {
    const body = String(exp);
    return `${body}.${crypto.createHmac('sha256', localSecret()).update(body).digest('base64url')}`;
  };
  const validLocal = (v) => {
    const [body, mac] = String(v || '').split('.');
    if (!body || !mac || Number(body) < now()) return false;
    const want = Buffer.from(sign(Number(body)).split('.')[1]);
    const got = Buffer.from(mac);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  };

  const secure = (req) => !!req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const cookieOf = (req, name) =>
    (
      String(req.headers.cookie || '')
        .split(/;\s*/)
        .find((c) => c.startsWith(`${name}=`)) || ''
    ).slice(name.length + 1);
  const setCookie = (req, name, value, maxAgeMs) =>
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure(req) ? '; Secure' : ''}`;

  function check(req) {
    if (mode === 'none') return true;
    if (mode === 'local') return validLocal(cookieOf(req, LOCAL_COOKIE));
    const t = cookieOf(req, COOKIE);
    const s = t && sessions.get(t);
    if (!s || s.exp < now() || s.max < now()) {
      if (s) sessions.delete(t);
      return false;
    }
    s.exp = Math.min(s.max, now() + SESSION_MS);
    return true;
  }

  async function body(req) {
    let d = '';
    for await (const c of req) {
      d += c;
      if (d.length > 4096) break;
    }
    try {
      return JSON.parse(d);
    } catch {
      return {};
    }
  }
  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(obj));
  };

  // A one-time code from `zaafpulse open` (a file only this OS account can write) becomes a signed cookie.
  function redeemCode(code) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(code || ''))) return false;
    const f = path.join(dir, 'login-codes', crypto.createHash('sha256').update(code).digest('hex'));
    try {
      const st = fs.statSync(f);
      fs.rmSync(f, { force: true });
      return now() - st.mtimeMs < CODE_TTL_MS;
    } catch {
      return false;
    }
  }

  async function login(req, res) {
    if (!(req.headers['content-type'] || '').startsWith('application/json'))
      return json(res, 415, { error: 'json only' });
    const who = clientKey(req, trustProxy);
    const f = fails.get(who);
    const wait = Math.max(f && f.until > now() ? f.until : 0, global.until > now() ? global.until : 0);
    if (wait) {
      const s = Math.ceil((wait - now()) / 1000);
      return json(
        res,
        429,
        { error: `too many attempts; try again in ${Math.ceil(s / 60)} min` },
        { 'retry-after': String(s) },
      );
    }
    if (inflight.has(who)) return json(res, 429, { error: 'one sign-in at a time' }, { 'retry-after': '1' });
    const rec = record();
    if (!rec) return json(res, 503, { error: 'no admin password is set; run `zaafpulse set-password` on the server' });
    // Count the attempt as a failure before checking, so parallel guesses cannot all slip through.
    const n = (f && !(f.until && f.until <= now()) ? f.n : 0) + 1;
    fails.set(who, { n, until: n >= MAX_FAILS ? now() + LOCK_MS : 0 });
    if (now() - global.since > LOCK_MS) global = { n: 0, since: now(), until: 0 };
    if (++global.n >= GLOBAL_FAILS) global.until = now() + LOCK_MS;
    inflight.add(who);
    try {
      const { password } = await body(req);
      if (typeof password !== 'string' || !(await checkPassword(password, rec)))
        return json(res, 401, { error: 'wrong password' });
    } finally {
      inflight.delete(who);
    }
    fails.delete(who);
    global.n = Math.max(0, global.n - 1);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { exp: now() + SESSION_MS, max: now() + SESSION_MAX_MS });
    return json(res, 200, { ok: true }, { 'set-cookie': setCookie(req, COOKIE, token, SESSION_MS) });
  }

  // /api/session, /api/login, /api/logout and /auth/local. Returns true when it answered.
  async function handle(req, res, url) {
    if (url.pathname === '/api/session')
      return (
        json(res, 200, {
          required: mode !== 'none',
          mode,
          signedIn: check(req),
          configured: mode !== 'password' || !!record(),
        }),
        true
      );
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(cookieOf(req, COOKIE));
      json(
        res,
        200,
        { ok: true },
        { 'set-cookie': [setCookie(req, COOKIE, '', 0), setCookie(req, LOCAL_COOKIE, '', 0)] },
      );
      return true;
    }
    if (url.pathname === '/auth/local' && mode === 'local') {
      if (!redeemCode(url.searchParams.get('code'))) {
        res.writeHead(302, { location: '/login.html?expired=1' });
        return (res.end(), true);
      }
      res.writeHead(302, {
        location: '/',
        'set-cookie': setCookie(req, LOCAL_COOKIE, sign(now() + LOCAL_MS), LOCAL_MS),
      });
      return (res.end(), true);
    }
    if (url.pathname === '/api/login' && req.method === 'POST' && mode === 'password')
      return (await login(req, res), true);
    return false;
  }

  return { mode, required: mode !== 'none', check, handle, configured: () => mode !== 'password' || !!record() };
}

// Saves the admin password hash (used by `zaafpulse set-password`).
function setPassword(dataDir, password) {
  if (String(password).length < 10) throw new Error('use at least 10 characters');
  const file = path.join(dataDir, '.data', 'admin.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ ...hashPassword(password), updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  return file;
}

// Writes a one-time sign-in code for local mode (used by `zaafpulse open`); returns the code.
function localLoginCode(dataDir) {
  const code = crypto.randomBytes(24).toString('base64url');
  const dir = path.join(dataDir, '.data', 'login-codes');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const old of fs.readdirSync(dir)) {
    try {
      if (Date.now() - fs.statSync(path.join(dir, old)).mtimeMs > CODE_TTL_MS) fs.rmSync(path.join(dir, old));
    } catch {
      /* gone */
    }
  }
  fs.writeFileSync(path.join(dir, crypto.createHash('sha256').update(code).digest('hex')), '', { mode: 0o600 });
  return code;
}

module.exports = {
  createAuth,
  setPassword,
  localLoginCode,
  hashPassword,
  checkPassword,
  isLoopback,
  clientKey,
  pickMode,
  otherLoginUsers,
};
