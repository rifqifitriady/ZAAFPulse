// ZAAFPulse API keys (AuthN/AuthZ) and per-key rate limits. A key is shown once at creation;
// only its SHA-256 hash is stored. Each key carries scopes (llm, agents, mcp), allowed models and
// agents (globs), a monthly budget in USD, a requests-per-minute limit, an optional expiry, and
// privateOnly to keep a key on private models (your own hardware) only.
const crypto = require('crypto');

const SCOPES = ['llm', 'agents', 'mcp', 'rag'];
const hash = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
const glob = (pattern) =>
  new RegExp(
    `^${String(pattern)
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')}$`,
    'i',
  );
const allows = (patterns, value) => !patterns || !patterns.length || patterns.some((p) => glob(p).test(value));

function cleanKeyInput(input = {}) {
  const errors = [];
  const name = String(input.name || '')
    .trim()
    .slice(0, 60);
  if (!name) errors.push('name is required');
  const scopes = (Array.isArray(input.scopes) ? input.scopes : SCOPES).filter((s) => SCOPES.includes(s));
  if (!scopes.length) errors.push(`scopes: pick at least one of ${SCOPES.join(', ')}`);
  const list = (v) =>
    (Array.isArray(v) ? v : String(v || '').split(','))
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 50);
  const num = (v, min, max) => (v === '' || v == null ? null : Math.min(max, Math.max(min, Number(v) || 0)));
  const expiresAt = input.expiresInDays
    ? Date.now() + Math.min(3650, Math.max(1, Number(input.expiresInDays))) * 86400000
    : input.expiresAt || null;
  return {
    errors,
    value: {
      name,
      scopes,
      models: list(input.models),
      agents: list(input.agents),
      knowledge: list(input.knowledge), // knowledge-base ids or globs; empty = all
      budgetUSD: num(input.budgetUSD, 0, 1e6),
      rpm: num(input.rpm, 1, 10000) ?? 60,
      expiresAt,
      privateOnly: input.privateOnly === true || input.privateOnly === 'true',
      // Approving its own paused runs through the API or A2A; off by default (approvals happen in the dashboard).
      approveOwnRuns: input.approveOwnRuns === true || input.approveOwnRuns === 'true',
    },
  };
}

function createKeys(store, { now = Date.now } = {}) {
  const data = () => store.get();
  const windows = new Map(); // key id -> recent request times, for the rpm limit

  const pub = (k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    models: k.models,
    agents: k.agents,
    knowledge: k.knowledge || [],
    approveOwnRuns: !!k.approveOwnRuns,
    budgetUSD: k.budgetUSD,
    rpm: k.rpm,
    privateOnly: !!k.privateOnly,
    expiresAt: k.expiresAt,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || null,
    revokedAt: k.revokedAt || null,
  });

  return {
    list: () => data().keys.map(pub),
    // `id` is for seeding the demo with fixed ids; the routes never pass it.
    create(input, { id } = {}) {
      const { errors, value } = cleanKeyInput(input);
      if (errors.length) return { errors };
      const secret = `zp_${crypto.randomBytes(24).toString('base64url')}`;
      const k = {
        id: id || `key_${crypto.randomBytes(6).toString('hex')}`,
        prefix: `${secret.slice(0, 10)}…`,
        hash: hash(secret),
        createdAt: now(),
        ...value,
      };
      data().keys.push(k);
      store.save(true);
      return { key: pub(k), secret }; // the secret is returned once and never stored
    },
    update(id, input) {
      const k = data().keys.find((x) => x.id === id);
      if (!k) return { errors: ['no such key'] };
      const { errors, value } = cleanKeyInput({ ...pub(k), ...input });
      if (errors.length) return { errors };
      Object.assign(k, value);
      store.save(true);
      return { key: pub(k) };
    },
    revoke(id) {
      const k = data().keys.find((x) => x.id === id);
      if (!k) return { errors: ['no such key'] };
      k.revokedAt = now();
      store.save(true);
      return { key: pub(k) };
    },
    remove(id) {
      const before = data().keys.length;
      data().keys = data().keys.filter((x) => x.id !== id);
      store.save(true);
      return before === data().keys.length ? { errors: ['no such key'] } : { id };
    },

    // Bearer token or x-api-key → key record, or a reason for 401/403.
    authenticate(secret) {
      if (typeof secret !== 'string' || !secret.startsWith('zp_'))
        return { status: 401, error: 'missing or malformed API key (Authorization: Bearer zp_…)' };
      const h = Buffer.from(hash(secret), 'hex');
      const k = data().keys.find((x) => {
        const b = Buffer.from(x.hash, 'hex');
        return b.length === h.length && crypto.timingSafeEqual(b, h);
      });
      if (!k) return { status: 401, error: 'unknown API key' };
      if (k.revokedAt) return { status: 401, error: 'this API key was revoked' };
      if (k.expiresAt && now() > k.expiresAt) return { status: 401, error: 'this API key has expired' };
      if (!k.lastUsedAt || now() - k.lastUsedAt > 60000) {
        k.lastUsedAt = now();
        store.save();
      }
      return { key: k };
    },
    authorize(k, { scope, model, agent }) {
      if (scope && !k.scopes.includes(scope)) return `this key does not have the "${scope}" scope`;
      if (model && !allows(k.models, model)) return `this key may not use model "${model}"`;
      if (agent && !allows(k.agents, agent)) return `this key may not use agent "${agent}"`;
      return null;
    },
    // Sliding one-minute window. Returns seconds to wait, or 0 when the request may go ahead.
    rateLimit(k) {
      const t = now();
      const w = (windows.get(k.id) || []).filter((x) => t - x < 60000);
      if (w.length >= (k.rpm || 60)) {
        windows.set(k.id, w);
        return Math.ceil((60000 - (t - w[0])) / 1000);
      }
      w.push(t);
      windows.set(k.id, w);
      return 0;
    },
  };
}

module.exports = { createKeys, cleanKeyInput, allows, hash, SCOPES };
