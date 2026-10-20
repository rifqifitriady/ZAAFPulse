// Dashboard sign-in. Three modes:
//   local     the default on 127.0.0.1, on every OS: only this OS account can open the dashboard.
//             `zaafpulse open` (also `start --open` and the autostart opener) writes a one-time code into
//             the private data folder and opens the browser on a private file that carries it, so the
//             code never appears on a command line. The server swaps it for a signed cookie that
//             survives restarts; signing out revokes every such cookie.
//   none      only when asked for (ZAAFPULSE_AUTH=none), or demo mode on a single-user machine.
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
const KNOWN_COOKIE = 'zp_known'; // "this browser signed in before": its own lockout, immune to global pressure
const SESSION_MS = 12 * 3600e3; // idle limit, renewed while used
const SESSION_MAX_MS = 7 * 24 * 3600e3; // absolute limit
const LOCAL_MS = 30 * 24 * 3600e3;
const KNOWN_MS = 180 * 24 * 3600e3;
const CODE_TTL_MS = 2 * 60e3;
const MIN_PASSWORD = 10;
// Sign-in throttling. Each address (IPv6: its /64) gets FREE_FAILS wrong passwords, then waits LOCK_BASE_MS,
// doubling with every further failure up to LOCK_MAX_MS. An IPv6 /56 shares a larger budget, so one
// network cannot rotate through its 256 /64s. When many addresses fail at once (distributed guessing),
// every address drops to one free try: that slows an attack down but never refuses a fresh address its
// first try, so the owner can still sign in with the right password.
const FREE_FAILS = 5;
const PREFIX_FREE_FAILS = 20;
const PRESSURE_FREE_FAILS = 1;
const PRESSURE_PREFIX_FREE_FAILS = 4;
const LOCK_BASE_MS = 30e3;
const LOCK_MAX_MS = 3600e3;
const FAIL_MEMORY_MS = 24 * 3600e3; // a quiet day forgets an address's failures
const PRESSURE_FAILS = 50; // failures across all addresses within PRESSURE_WINDOW_MS
const PRESSURE_WINDOW_MS = 15 * 60e3;
const MAX_TRACKED = 20000; // addresses remembered, so a flood of them cannot exhaust memory
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

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

// An IPv6 address as eight 16-bit groups (handles "::" and a dotted IPv4 tail), or null.
function ipv6Groups(ip) {
  let s = String(ip)
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, -v4[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}
const hex = (groups) => groups.map((g) => g.toString(16)).join(':');

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
  ip = ip.replace(/^::ffff:(?=\d+\.)/i, '');
  if (!ip.includes(':')) return ip;
  const g = ipv6Groups(ip);
  return g ? `${hex(g.slice(0, 4))}::/64` : ip;
}
// The wider network an address belongs to, for the shared budget: an IPv6 /56. IPv4 has none (a /24 is
// often a whole office or carrier NAT, so it would let an attacker lock out bystanders).
function prefixKey(key) {
  const m = String(key).match(/^(.*)::\/64$/);
  if (!m) return null;
  const g = ipv6Groups(`${m[1]}::`);
  return g ? `${hex([g[0], g[1], g[2], g[3] & 0xff00])}::/56` : null;
}

function pickMode({ host, env, platform = process.platform, users = otherLoginUsers, demo = false }) {
  if (env.ZAAFPULSE_AUTH === '1' || env.ZAAFPULSE_AUTH === 'password') return 'password';
  // Behind a reverse proxy the socket is local even for internet clients, so a proxy setup needs sign-in.
  if (!isLoopback(host) || env.ZAAFPULSE_TRUST_PROXY === '1' || env.ZAAFPULSE_PUBLIC_URL || env.ZAAFPULSE_ALLOWED_HOSTS)
    return 'password';
  if (env.ZAAFPULSE_AUTH === 'none') return 'none';
  if (env.ZAAFPULSE_AUTH === 'local') return 'local';
  // Demo data is synthetic and offline, so screenshots need no sign-in, unless other people log in here.
  if (demo && !(platform === 'linux' && users() > 0)) return 'none';
  // Without sign-in any program or other OS account on this machine is the admin: local is the default.
  return 'local';
}

// Browsers send Origin on every POST and every cross-origin request; anything that is not this site is
// refused (MCP's DNS-rebinding rule, and a second line behind SameSite cookies). This site is the Host the
// request was sent to, the proxy's X-Forwarded-Host when trusted, the public URL and the allowed hosts;
// on a local-only server also any loopback page. ZAAFPULSE_ALLOWED_ORIGINS adds origins ("*" allows all).
function originAllowed(req, { mode, trustProxy = false, publicUrl = '', allowedHosts = [], allowedOrigins = [] }) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // not a browser, or a plain same-site navigation
  const o = String(origin).toLowerCase();
  if (allowedOrigins.includes('*') || allowedOrigins.includes(o.replace(/\/+$/, ''))) return true;
  let u;
  try {
    u = new URL(o); // "null" (file pages, sandboxed frames) does not parse: refused
  } catch {
    return false;
  }
  if (mode !== 'password' && isLoopback(u.hostname.replace(/^\[|\]$/g, ''))) return true;
  const hosts = [String(req.headers.host || '').toLowerCase()];
  if (trustProxy && req.headers['x-forwarded-host'])
    hosts.push(String(req.headers['x-forwarded-host']).split(',').pop().trim().toLowerCase());
  try {
    if (publicUrl) hosts.push(new URL(publicUrl).host.toLowerCase());
  } catch {
    /* not a URL */
  }
  return hosts.includes(u.host) || allowedHosts.includes(u.hostname);
}

function createAuth({
  dataDir,
  host = '127.0.0.1',
  env = process.env,
  now = Date.now,
  platform,
  users,
  demo = false,
  headers = () => ({}),
}) {
  const dir = path.join(dataDir, '.data');
  const file = path.join(dir, 'admin.json');
  const mode = pickMode({ host, env, platform, users, demo });
  const trustProxy = env.ZAAFPULSE_TRUST_PROXY === '1';
  const sessions = new Map(); // token -> { exp, max }
  const fails = new Map(); // address, /56 or device -> { n, last }
  const inflight = new Set(); // clients with a sign-in being checked
  let recentFails = []; // times of recent failures from any address
  const envPassword =
    env.ZAAFPULSE_ADMIN_PASSWORD ||
    (env.ZAAFPULSE_ADMIN_PASSWORD_FILE ? fs.readFileSync(env.ZAAFPULSE_ADMIN_PASSWORD_FILE, 'utf8').trim() : '');
  if (mode === 'password' && envPassword && envPassword.length < MIN_PASSWORD)
    throw new Error(
      `ZAAFPULSE_ADMIN_PASSWORD needs at least ${MIN_PASSWORD} characters, the same rule as \`zaafpulse set-password\``,
    );
  const envRec = envPassword ? hashPassword(envPassword) : null;
  const record = () => {
    if (envRec) return envRec;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  // An HMAC key in the private data folder signs the local and known-device cookies, so both survive restarts.
  let secretKey = null;
  const secret = () => {
    if (secretKey) return secretKey;
    const f = path.join(dir, 'local-auth.key');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      secretKey = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
    } catch {
      secretKey = crypto.randomBytes(32);
      fs.writeFileSync(f, secretKey.toString('base64') + '\n', { mode: 0o600 });
    }
    return secretKey;
  };
  // Signed values are "part.part.mac"; the purpose is in the MAC, so one kind of cookie cannot pass as another.
  const mac = (purpose, body) => crypto.createHmac('sha256', secret()).update(`${purpose}:${body}`).digest('base64url');
  const sign = (purpose, ...parts) => `${parts.join('.')}.${mac(purpose, parts.join('.'))}`;
  const verify = (purpose, value, n) => {
    const parts = String(value || '').split('.');
    if (parts.length !== n + 1 || parts.some((p) => !p)) return null;
    const want = Buffer.from(mac(purpose, parts.slice(0, n).join('.')));
    const got = Buffer.from(parts[n]);
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? parts.slice(0, n) : null;
  };

  // Local cookies carry a generation number; signing out bumps it, which revokes every cookie handed out.
  const genFile = path.join(dir, 'local-auth.gen');
  let gen = null;
  const generation = () => {
    if (gen === null)
      try {
        gen = Number(fs.readFileSync(genFile, 'utf8').trim()) || 0;
      } catch {
        gen = 0;
      }
    return gen;
  };
  const revokeLocal = () => {
    gen = generation() + 1;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(genFile, `${gen}\n`, { mode: 0o600 });
  };
  const validLocal = (v) => {
    const p = verify('local', v, 2);
    return !!p && Number(p[0]) >= now() && Number(p[1]) === generation();
  };
  const knownDevice = (v) => {
    const p = verify('known', v, 2);
    return p && Number(p[1]) >= now() ? p[0] : null;
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
  const securityHeaders = () => headers() || {};
  const json = (res, status, obj, extra = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...securityHeaders(),
      ...extra,
    });
    res.end(JSON.stringify(obj));
  };

  // A one-time code from `zaafpulse open` (a file only this OS account can write) becomes a signed cookie.
  // Renaming the file claims it: of two requests racing with the same code, only one rename succeeds.
  function redeemCode(code) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(code || ''))) return false;
    const f = path.join(dir, 'login-codes', sha256(code));
    const claimed = `${f}.${crypto.randomBytes(6).toString('hex')}.used`;
    try {
      fs.renameSync(f, claimed);
    } catch {
      return false;
    }
    try {
      return now() - fs.statSync(claimed).mtimeMs < CODE_TTL_MS;
    } catch {
      return false;
    } finally {
      fs.rmSync(claimed, { force: true });
      fs.rmSync(`${f}.html`, { force: true });
    }
  }

  // Failure buckets: { n, last }, forgotten after a quiet day.
  const bucket = (k) => {
    const b = fails.get(k);
    if (b && now() - b.last > FAIL_MEMORY_MS) {
      fails.delete(k);
      return null;
    }
    return b || null;
  };
  const lockedUntil = (b, free) =>
    !b || b.n < free ? 0 : b.last + Math.min(LOCK_BASE_MS * 2 ** (b.n - free), LOCK_MAX_MS);
  const underPressure = () => {
    const t = now();
    recentFails = recentFails.filter((x) => t - x < PRESSURE_WINDOW_MS).slice(-PRESSURE_FAILS * 4);
    return recentFails.length >= PRESSURE_FAILS;
  };

  async function login(req, res) {
    if (!(req.headers['content-type'] || '').startsWith('application/json'))
      return json(res, 415, { error: 'json only' });
    const who = clientKey(req, trustProxy);
    // A browser that signed in before is throttled on its own, so guessing from its address (a shared
    // NAT, say) or from everywhere at once cannot lock its owner out.
    const device = knownDevice(cookieOf(req, KNOWN_COOKIE));
    const pressure = !device && underPressure();
    const limits = device
      ? [[`device:${device}`, FREE_FAILS]]
      : [
          [who, pressure ? PRESSURE_FREE_FAILS : FREE_FAILS],
          [prefixKey(who), pressure ? PRESSURE_PREFIX_FREE_FAILS : PREFIX_FREE_FAILS],
        ].filter(([k]) => k);
    const wait = Math.max(0, ...limits.map(([k, free]) => lockedUntil(bucket(k), free)));
    if (wait > now()) {
      const s = Math.ceil((wait - now()) / 1000);
      return json(
        res,
        429,
        { error: `too many attempts; try again in ${s < 90 ? `${s} s` : `${Math.ceil(s / 60)} min`}` },
        { 'retry-after': String(s) },
      );
    }
    const slot = limits[0][0];
    if (inflight.has(slot)) return json(res, 429, { error: 'one sign-in at a time' }, { 'retry-after': '1' });
    const rec = record();
    if (!rec) return json(res, 503, { error: 'no admin password is set; run `zaafpulse set-password` on the server' });
    // Count the attempt as a failure before checking, so parallel guesses cannot all slip through.
    for (const [k] of limits) fails.set(k, { n: (bucket(k) || { n: 0 }).n + 1, last: now() });
    recentFails.push(now());
    if (fails.size > MAX_TRACKED) for (const k of [...fails.keys()].slice(0, fails.size - MAX_TRACKED)) fails.delete(k);
    inflight.add(slot);
    try {
      const { password } = await body(req);
      if (typeof password !== 'string' || !(await checkPassword(password, rec)))
        return json(res, 401, { error: 'wrong password' });
    } finally {
      inflight.delete(slot);
    }
    // The right password: this address starts over, and its attempt no longer counts as a failure.
    fails.delete(slot);
    for (const [k] of limits.slice(1)) {
      const b = bucket(k);
      if (b && --b.n <= 0) fails.delete(k);
    }
    recentFails.pop();
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { exp: now() + SESSION_MS, max: now() + SESSION_MAX_MS });
    const id = device || crypto.randomBytes(12).toString('base64url');
    return json(
      res,
      200,
      { ok: true },
      {
        'set-cookie': [
          setCookie(req, COOKIE, token, SESSION_MS),
          setCookie(req, KNOWN_COOKIE, sign('known', id, now() + KNOWN_MS), KNOWN_MS),
        ],
      },
    );
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
      // JSON only, like every other change: another site cannot sign the owner out with a plain form.
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return (json(res, 415, { error: 'json only' }), true);
      // Signing out of local mode revokes every local cookie (only a signed-in browser may do that).
      if (mode === 'local' && check(req)) revokeLocal();
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
        res.writeHead(302, { location: '/login.html?expired=1', ...securityHeaders() });
        return (res.end(), true);
      }
      // A page that moves on to the dashboard, not a redirect: the browser came here from a local file,
      // and a SameSite=Strict cookie is not sent on a redirect that another origin started.
      res.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': setCookie(req, LOCAL_COOKIE, sign('local', now() + LOCAL_MS, generation()), LOCAL_MS),
      });
      res.end(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>ZAAFPulse</title><a href="/">Open ZAAFPulse</a>',
      );
      return true;
    }
    if (url.pathname === '/api/login' && req.method === 'POST' && mode === 'password')
      return (await login(req, res), true);
    return false;
  }

  return { mode, required: mode !== 'none', check, handle, configured: () => mode !== 'password' || !!record() };
}

// Saves the admin password hash (used by `zaafpulse set-password`).
function setPassword(dataDir, password) {
  if (String(password).length < MIN_PASSWORD) throw new Error(`use at least ${MIN_PASSWORD} characters`);
  const file = path.join(dataDir, '.data', 'admin.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ ...hashPassword(password), updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  return file;
}

// Writes a one-time sign-in code for local mode; returns the code.
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
  fs.writeFileSync(path.join(dir, sha256(code)), '', { mode: 0o600 });
  return code;
}

// A one-time code inside a private HTML file that forwards the browser to `${origin}/auth/local` (used by
// `zaafpulse open` and the openers). Opening the file's path keeps the code off every command line, where
// other accounts could read it (/proc/<pid>/cmdline). Returns the path; the server deletes the file on use.
function localLoginPage(dataDir, origin) {
  const code = localLoginCode(dataDir);
  const target = `${String(origin).replace(/\/+$/, '')}/auth/local?code=${code}`.replace(
    /[&"<>]/g,
    (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c],
  );
  const file = path.join(dataDir, '.data', 'login-codes', `${sha256(code)}.html`);
  fs.writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${target}"><title>ZAAFPulse</title><a href="${target}">Open ZAAFPulse</a>\n`,
    { mode: 0o600 },
  );
  return file;
}

module.exports = {
  createAuth,
  setPassword,
  localLoginCode,
  localLoginPage,
  hashPassword,
  checkPassword,
  isLoopback,
  clientKey,
  prefixKey,
  pickMode,
  originAllowed,
  otherLoginUsers,
};
