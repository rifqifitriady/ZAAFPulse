// Shared plumbing for connectors: URL building, auth headers, timeouts, masked errors,
// and small helpers to declare tools and their JSON Schemas.
const TIMEOUT_MS = 15000;
const { fetchSameOrigin } = require('../net');
const RAW = Symbol.for('acc.rawContent'); // run() result already in MCP content form (MCP proxy)

function joinUrl(base, path, query) {
  const u = new URL(String(path).replace(/^\//, ''), base.endsWith('/') ? base : base + '/');
  for (const [k, v] of Object.entries(query || {}))
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

function makeClient({ baseUrl, headers = {}, mask = (s) => s, timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl))
    throw new Error('baseUrl must start with http:// or https://');
  return async function request(method, path, { query, body, headers: extra, url } = {}) {
    const target = url || joinUrl(baseUrl, path, query);
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

module.exports = { makeClient, authHeaders, tool, S, timedHealth, RAW, TIMEOUT_MS };
