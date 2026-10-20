// Shared plumbing for connectors: URL building, auth headers, timeouts, masked errors,
// and small helpers to declare tools and their JSON Schemas.
const TIMEOUT_MS = 15000;
const { fetchSameOrigin } = require('../net');
const RAW = Symbol.for('acc.rawContent'); // run() result already in MCP content form (MCP proxy)

// A request path stays under the base URL: no "//host" start, no backslash, no scheme,
// no "." or ".." segment (also percent-encoded). URL parsing would otherwise send it to another host
// or another part of the API, with the client's credentials.
function checkPath(path) {
  const p = String(path);
  // URL parsing drops tabs and line breaks, so ".\t." would become "..": refuse control characters too.
  if (p.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(p))
    throw new Error(`path "${p}" must not start with // or hold a backslash or control character`);
  const rest = p.replace(/^\//, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) throw new Error(`path "${p}" must be a path, not a URL`);
  const segments = rest.split(/[?#]/)[0].split('/');
  if (segments.some((x) => /^\.{1,2}$/.test(x.replace(/%2e/gi, '.'))))
    throw new Error(`path "${p}" must not contain . or .. segments`);
  return rest;
}

function joinUrl(base, path, query) {
  const root = new URL(base.endsWith('/') ? base : base + '/');
  const u = new URL(`./${checkPath(path)}`, root);
  if (u.origin !== root.origin || !u.pathname.startsWith(root.pathname))
    throw new Error(`path "${path}" leaves the base URL`);
  for (const [k, v] of Object.entries(query || {}))
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

// One path parameter: percent-encoded, and never empty, "." or "..", which would change the path.
function pathParam(v) {
  const s = String(v ?? '');
  if (!s || s === '.' || s === '..') throw new Error(`"${s}" is not a valid id`);
  return encodeURIComponent(s);
}

// Every request goes to the base URL's origin. The explicit `url` option (n8n's allowlisted webhooks)
// may point elsewhere only for a client without headers, so a credential never leaves its origin.
function makeClient({ baseUrl, headers = {}, mask = (s) => s, timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl))
    throw new Error('baseUrl must start with http:// or https://');
  const origin = new URL(baseUrl).origin;
  const bare = !Object.keys(headers).length;
  return async function request(method, path, { query, body, headers: extra, url } = {}) {
    const target = url || joinUrl(baseUrl, path, query);
    if (new URL(target).origin !== origin && (!bare || (extra && Object.keys(extra).length)))
      throw new Error(mask(`${method} ${path} refused: a client with credentials only calls ${origin}`));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchSameOrigin(fetchImpl, target, {
        method,
        signal: ctrl.signal,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
          ...extra,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${method} ${path}: ${text.slice(0, 300)}`);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(mask(`timeout after ${timeoutMs / 1000}s: ${method} ${path}`));
      if (/^HTTP \d{3} from /.test(err.message)) throw new Error(mask(err.message));
      throw new Error(mask(`${method} ${path} failed: ${err.cause?.code || err.cause?.message || err.message}`));
    } finally {
      clearTimeout(timer);
    }
  };
}

function authHeaders(auth, secrets) {
  if (!auth) return {};
  const header = auth.header || 'Authorization';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new Error(`auth.header "${header}" is not a valid header name`);
  return { [header]: (auth.prefix || '') + secrets.resolve(auth.secret, 'auth.secret') };
}

const S = {
  str: (description) => ({ type: 'string', description }),
  int: (description, max) => ({ type: 'integer', minimum: 1, ...(max ? { maximum: max } : {}), description }),
  num: (description) => ({ type: 'number', description }),
  bool: (description) => ({ type: 'boolean', description }),
  enum: (values, description) => ({ type: 'string', enum: values, description }),
  obj: (description) => ({ type: 'object', description }),
};

function tool(name, description, properties, run, { required = [], write = false, annotations = {}, title } = {}) {
  return {
    name,
    title,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    write,
    annotations,
    run,
  };
}

async function timedHealth(fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { ok: true, latencyMs: Date.now() - started, ...(typeof detail === 'string' ? { detail } : {}) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err.message };
  }
}

module.exports = { makeClient, joinUrl, checkPath, pathParam, authHeaders, tool, S, timedHealth, RAW, TIMEOUT_MS };
