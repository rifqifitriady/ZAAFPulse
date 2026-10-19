// Generic HTTP integration: each endpoint declared in config becomes one tool. Used for AION
// and any other REST service that has no dedicated connector. Path placeholders such as
// {agentId} come from the arguments; the remaining arguments go to the query string (GET,
// DELETE) or the JSON body (POST, PUT, PATCH). Anything but GET counts as a write unless the
// endpoint says write: false.
const { makeClient, authHeaders, tool, timedHealth } = require('./base');

const NAME = /^[a-z0-9_]{1,48}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function plainHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (typeof v !== 'string') throw new Error(`headers.${k} must be a string; put secrets in auth`);
    out[k] = v;
  }
  return out;
}

module.exports = {
  type: 'http',
  create(id, cfg, { secrets }) {
    const api = makeClient({
      baseUrl: cfg.baseUrl,
      headers: { ...plainHeaders(cfg.headers), ...authHeaders(cfg.auth, secrets) },
      mask: secrets.mask,
    });
    if (!Array.isArray(cfg.endpoints) || !cfg.endpoints.length) throw new Error('endpoints must be a non-empty list');

    const tools = cfg.endpoints.map((ep, i) => {
      if (!ep || !NAME.test(ep.name || '')) throw new Error(`endpoints[${i}].name must match [a-z0-9_]{1,48}`);
      const method = String(ep.method || 'GET').toUpperCase();
      if (!METHODS.includes(method)) throw new Error(`endpoints[${i}].method must be one of ${METHODS.join(', ')}`);
      if (typeof ep.path !== 'string' || !ep.path.startsWith('/'))
        throw new Error(`endpoints[${i}].path must start with /`);
      const placeholders = [...ep.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const properties = {
        ...Object.fromEntries(placeholders.map((p) => [p, { type: 'string', description: `Path parameter ${p}` }])),
        ...(ep.params && typeof ep.params === 'object' ? ep.params : {}),
      };
      const inBody = ['POST', 'PUT', 'PATCH'].includes(method);
      return tool(
        ep.name,
        ep.description || `${method} ${ep.path}`,
        properties,
        (args) => {
          const rest = { ...args };
          const path = ep.path.replace(/\{(\w+)\}/g, (_, k) => {
            const v = rest[k];
            delete rest[k];
            return encodeURIComponent(String(v));
          });
          return api(method, path, inBody ? { body: { ...(ep.body || {}), ...rest } } : { query: rest });
        },
        {
          required: [...new Set([...placeholders, ...(Array.isArray(ep.required) ? ep.required : [])])],
          write: typeof ep.write === 'boolean' ? ep.write : method !== 'GET',
          annotations: { destructiveHint: method === 'DELETE', idempotentHint: method !== 'POST' },
        },
      );
    });

    const health = cfg.healthPath
      ? () =>
          timedHealth(async () => {
            await api('GET', cfg.healthPath);
          })
      : async () => ({ ok: null, latencyMs: null, detail: 'configured, not checked' });
    return { tools, health };
  },
};
