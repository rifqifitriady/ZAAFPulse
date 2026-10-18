// Dashboard sign-in, required whenever ZAAFPulse listens beyond this machine (server mode) or when
// ZAAFPULSE_AUTH=1. The gateway (/v1, /mcp, /a2a) keeps its own API keys; this guards the dashboard
// and its /api. One admin password: ZAAFPULSE_ADMIN_PASSWORD (or ..._FILE), or a scrypt hash saved by
// `zaafpulse set-password` in .data/admin.json. Sessions are random tokens in an HttpOnly,
// SameSite=Strict cookie, kept in memory (a restart signs everyone out). Failed sign-ins are rate-limited.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'zp_session';
const SESSION_MS = 12 * 3600e3;
const MAX_FAILS = 5; const LOCK_MS = 5 * 60e3;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { algo: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), hash: hash.toString('base64') };
}
function checkPassword(password, rec) {
  if (!rec || rec.algo !== 'scrypt') return false;
  const want = Buffer.from(rec.hash, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(rec.salt, 'base64'), want.length, { N: rec.N, r: rec.r, p: rec.p });
  return crypto.timingSafeEqual(got, want);
}

function createAuth({ dataDir, host = '127.0.0.1', env = process.env, now = Date.now }) {
  const file = path.join(dataDir, '.data', 'admin.json');
  const required = !isLoopback(host) || env.ZAAFPULSE_AUTH === '1';
  const trustProxy = env.ZAAFPULSE_TRUST_PROXY === '1';
  const sessions = new Map(); // token -> { exp }
  const fails = new Map(); // ip -> { n, until }
  const envPassword = env.ZAAFPULSE_ADMIN_PASSWORD || (env.ZAAFPULSE_ADMIN_PASSWORD_FILE ? fs.readFileSync(env.ZAAFPULSE_ADMIN_PASSWORD_FILE, 'utf8').trim() : '');
  const envRec = envPassword ? hashPassword(envPassword) : null;
  const record = () => { if (envRec) return envRec; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

  const ipOf = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const secure = (req) => !!req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const tokenOf = (req) => (String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`)) || '').slice(COOKIE.length + 1);
  const cookie = (req, value, maxAge) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

  function check(req) {
    if (!required) return true;
    const t = tokenOf(req); const s = t && sessions.get(t);
    if (!s || s.exp < now()) { if (s) sessions.delete(t); return false; }
    s.exp = now() + SESSION_MS; return true; // sliding expiry
  }

  async function body(req) { let d = ''; for await (const c of req) { d += c; if (d.length > 4096) break; } try { return JSON.parse(d); } catch { return {}; } }
  const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };

  // /api/session, /api/login, /api/logout. Returns true when it answered.
  async function handle(req, res, url) {
    if (url.pathname === '/api/session') return json(res, 200, { required, signedIn: check(req), configured: !!record() }), true;
    if (url.pathname === '/api/logout' && req.method === 'POST') { sessions.delete(tokenOf(req)); return json(res, 200, { ok: true }, { 'set-cookie': cookie(req, '', 0) }), true; }
    if (url.pathname !== '/api/login' || req.method !== 'POST') return false;
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' }), true;
    const ip = ipOf(req); const f = fails.get(ip);
    if (f && f.until > now()) return json(res, 429, { error: `too many attempts; try again in ${Math.ceil((f.until - now()) / 60000)} min` }, { 'retry-after': String(Math.ceil((f.until - now()) / 1000)) }), true;
    const rec = record(); if (!rec) return json(res, 503, { error: 'no admin password is set; run `zaafpulse set-password` on the server' }), true;
    const { password } = await body(req);
    if (typeof password !== 'string' || !checkPassword(password, rec)) {
      const n = (f && !(f.until && f.until <= now()) ? f.n : 0) + 1; // an expired lock starts the count again
      fails.set(ip, { n, until: n >= MAX_FAILS ? now() + LOCK_MS : 0 });
      return json(res, 401, { error: 'wrong password' }), true;
    }
    fails.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, { exp: now() + SESSION_MS });
    return json(res, 200, { ok: true }, { 'set-cookie': cookie(req, token, SESSION_MS / 1000) }), true;
  }

  return { required, check, handle, configured: () => !!record() };
}

// Saves the admin password hash (used by `zaafpulse set-password`).
function setPassword(dataDir, password) {
  if (String(password).length < 10) throw new Error('use at least 10 characters');
  const file = path.join(dataDir, '.data', 'admin.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...hashPassword(password), updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return file;
}

module.exports = { createAuth, setPassword, hashPassword, checkPassword, isLoopback };
