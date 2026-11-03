// Governance audit log (AI Governance 2): the field-level changes between two config.json values, pure (spec A5).
// A change is { path, from, to } with paths like gateway.guardrails.secrets; arrays of objects are compared by their
// id (or name), as gateway.providers[openai].baseUrl. A value under a key that looks secret, or a secret reference,
// is written as "‹changed›", numbers included (only a switch stays readable: it cannot hold one). Any other text is
// cut to 120 characters, after the credentials of a URL (scheme://user:pass@host, up to the last "@" before the
// host) and the values of its secret-looking query parameters (?api_key=…, &token=…) become "‹changed›".
// At most 50 changes, then `truncated` says how many more there were.
const { canonical } = require('./chain');

const MASK = '‹changed›';
const MAX_CHANGES = 50;
const MAX_TEXT = 120;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;
const URL_SECRET_QUERY =
  /([?&](?:api_key|apikey|key|token|access_token|secret|password|auth|signature|sig)=)[^&#\s]*/gi;
// Key names that hold secrets or point at them (apiKey, x-api-key, headers, oauth, credentials …).
const SECRET_WORD = /key|token|secret|password|auth|header|credential/i;
// Names that only look secret: a guardrails mode (any path ending in guardrails.secrets, as gateway.guardrails.secrets
// or a key's own guardrails.secrets: it only ever holds a mode word), and the cost centers' map of gateway key ids at
// cost.keyCenters (the map and its entries, whose names are key ids). The same names anywhere else are secret.
const NOT_SECRET = new Set(['cost.keyCenters']);
const join = (path, k) => (path ? `${path}.${k}` : k);
const guardMode = (k, path) => k === 'secrets' && (path === 'guardrails' || path.endsWith('.guardrails'));
const secretName = (k, path) =>
  SECRET_WORD.test(k) && !guardMode(k, path) && !NOT_SECRET.has(join(path, k)) && path !== 'cost.keyCenters';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// A secret reference, as lib/secrets.js isRef: { env: name } or { keychain: service }.
const isRef = (v) => isObj(v) && (typeof v.env === 'string' || typeof v.keychain === 'string');
// Anything under it that is a reference or sits under a secret-looking key.
const hasSecret = (v, path) =>
  isRef(v) ||
  (Array.isArray(v) && v.some((x) => hasSecret(x, path))) ||
  (isObj(v) && Object.entries(v).some(([k, x]) => secretName(k, path) || hasSecret(x, join(path, k))));
// Cut on code points, so a surrogate pair (an emoji) is never split.
const cut = (s) => {
  // Credentials inside a URL (scheme://user:pass@host, ?token=…) are replaced first, so no cut can leave half of one.
  const cps = Array.from(s.replace(URL_CREDENTIALS, `$1${MASK}@`).replace(URL_SECRET_QUERY, `$1${MASK}`));
  return cps.length > MAX_TEXT ? `${cps.slice(0, MAX_TEXT - 1).join('')}…` : cps.join('');
};

// How a value is written in a change: absent is null, text is cut, a list or an object is its JSON text, cut.
function shown(v, secret, path) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  if (secret || (typeof v !== 'number' && hasSecret(v, path))) return MASK;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return cut(v);
  return cut(JSON.stringify(v));
}

// An array as a map by id (or name), or null when an element has neither or two share one. An empty array is an empty
// map, so a first provider added to [] is still compared field by field.
function byId(arr) {
  if (!Array.isArray(arr)) return null;
  const m = new Map();
  for (const x of arr) {
    const id = isObj(x)
      ? typeof x.id === 'string' || typeof x.id === 'number'
        ? String(x.id)
        : typeof x.name === 'string'
          ? x.name
          : null
      : null;
    if (id === null || m.has(id)) return null;
    m.set(id, x);
  }
  return m;
}

function walk(a, b, path, secret, out) {
  if (canonical(a) === canonical(b)) return;
  const leaf = () => out.push({ path, from: shown(a, secret, path), to: shown(b, secret, path) });
  if (isRef(a) || isRef(b)) return leaf();
  const objA = isObj(a) || a === undefined;
  const objB = isObj(b) || b === undefined;
  if (objA && objB && (isObj(a) || isObj(b))) {
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
    if (!keys.length) return leaf();
    for (const k of keys) walk((a || {})[k], (b || {})[k], join(path, k), secret || secretName(k, path), out);
    return;
  }
  // Under a secret-looking key a list is one masked value: no id or name of an element reaches the path.
  if (secret) return leaf();
  const ma = a === undefined ? new Map() : byId(a);
  const mb = b === undefined ? new Map() : byId(b);
  if (ma && mb && (Array.isArray(a) || Array.isArray(b)) && (ma.size || mb.size)) {
    for (const id of [...new Set([...ma.keys(), ...mb.keys()])])
      walk(ma.get(id), mb.get(id), `${path}[${id}]`, secret, out);
    return;
  }
  leaf();
}

// diff(before, after) -> { changes: [{ path, from, to }], truncated?, sections }: sections are the top-level keys
// that changed, sorted.
function diff(before, after) {
  const out = [];
  walk(isObj(before) ? before : {}, isObj(after) ? after : {}, '', false, out);
  const sections = [...new Set(out.map((c) => c.path.split(/[.[]/)[0]))].sort();
  return {
    changes: out.slice(0, MAX_CHANGES),
    ...(out.length > MAX_CHANGES ? { truncated: out.length - MAX_CHANGES } : {}),
    sections,
  };
}

module.exports = { diff, MASK, MAX_CHANGES, MAX_TEXT };
