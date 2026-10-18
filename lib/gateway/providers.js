// LLM Gateway / Model Router. Every provider speaks the OpenAI chat-completions API; presets fill in
// the base URL. Providers are private (your own hardware: Ollama, LM Studio, vLLM or TGI on a GPU box)
// or external (hosted APIs), and an external provider serves traffic only once it is approved.
// Models are "<provider id>/<model>"; routes are virtual models ("router/fast") that try their targets
// in order and fall back on errors. Provider keys are secret references (Keychain or env).

const PRESETS = {
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyRequired: false, local: true, hint: 'Private LLM: Llama, Qwen, Mistral on this Mac' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', keyRequired: false, local: true, hint: 'Private LLM with a desktop app' },
  vllm: { label: 'vLLM (GPU)', baseUrl: 'http://localhost:8000/v1', keyRequired: false, local: true, hint: 'GPU model serving: vllm serve <model>' },
  tgi: { label: 'TGI (GPU)', baseUrl: 'http://localhost:8080/v1', keyRequired: false, local: true, hint: 'Hugging Face Text Generation Inference' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyRequired: true },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true },
  anthropic: { label: 'Anthropic (OpenAI-compatible)', baseUrl: 'https://api.anthropic.com/v1', keyRequired: true, streamUsage: false },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true },
  xai: { label: 'xAI', baseUrl: 'https://api.x.ai/v1', keyRequired: true },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true },
  custom: { label: 'Custom OpenAI-compatible', baseUrl: '', keyRequired: false, hint: 'Any OpenAI-compatible endpoint' },
};
const ID = /^[a-z0-9-]{1,32}$/;
const TIMEOUT_MS = 120000;
const MODELS_TTL = 10 * 60 * 1000;

function cleanProvider(input = {}, existing = null) {
  const errors = [];
  const id = String(input.id || '').trim();
  if (!ID.test(id)) errors.push('id: 1-32 lowercase letters, digits or dashes');
  const preset = PRESETS[input.preset] ? input.preset : 'custom';
  const baseUrl = String(input.baseUrl || PRESETS[preset].baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) errors.push('baseUrl: must start with http:// or https://');
  const models = (Array.isArray(input.models) ? input.models : String(input.models || '').split(',')).map((m) => String(m).trim()).filter(Boolean).slice(0, 200);
  const aliases = input.aliases && typeof input.aliases === 'object' && !Array.isArray(input.aliases) ? input.aliases : (existing && existing.aliases) || {};
  const tier = input.tier === 'private' || input.tier === 'external' ? input.tier : PRESETS[preset].local ? 'private' : 'external';
  return { errors, value: { id, preset, baseUrl, apiKey: input.apiKey !== undefined ? input.apiKey : existing ? existing.apiKey : undefined, models, aliases, enabled: input.enabled !== false,
    tier, approved: tier === 'private' ? true : input.approved === true } };
}
const tierOf = (p) => p.tier || ((PRESETS[p.preset] || {}).local ? 'private' : 'external');
// Private providers always serve; external ones only after approval (old configs without the flag count as approved).
const usable = (p) => p.enabled !== false && (tierOf(p) === 'private' || p.approved !== false);

const ROUTE_NAME = /^router\/[a-z0-9-]{1,40}$/;
function cleanRoute(input = {}) {
  const errors = [];
  const name = String(input.name || '').trim();
  if (!ROUTE_NAME.test(name)) errors.push('name: router/<1-40 lowercase letters, digits or dashes>');
  const targets = (Array.isArray(input.targets) ? input.targets : String(input.targets || '').split(/[,\n]/)).map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
  if (!targets.length) errors.push('targets: at least one provider/model');
  const strategy = ['fallback', 'round-robin'].includes(input.strategy) ? input.strategy : 'fallback';
  return { errors, value: { name, targets, strategy, description: String(input.description || '').slice(0, 200) } };
}

function createProviders({ getConfig, secrets, fetchImpl = fetch, now = Date.now }) {
  const modelCache = new Map();
  const list = () => (((getConfig() || {}).gateway || {}).providers || []);
  const routes = () => (((getConfig() || {}).gateway || {}).routes || []);
  const get = (id) => list().find((p) => p.id === id && usable(p));
  const rr = new Map();
  const keyOf = (p) => (p.apiKey ? secrets.resolve(p.apiKey, `${p.id} apiKey`) : null);
  const headers = (p, extra = {}) => { const k = keyOf(p); return { 'content-type': 'application/json', accept: 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}), ...extra }; };

  // "provider/model" (or an alias) → { provider, model }; null when nothing matches or the provider is not usable.
  function resolve(name) {
    if (typeof name !== 'string' || !name) return null;
    for (const p of list()) if (usable(p) && p.aliases && p.aliases[name]) return { provider: p, model: p.aliases[name], name };
    const i = name.indexOf('/');
    if (i > 0) { const p = get(name.slice(0, i)); if (p) return { provider: p, model: name.slice(i + 1), name }; }
    return null;
  }
  // Every target to try for a name, in order: a route's usable targets (rotated for round-robin), or the one model.
  function resolveAll(name, { privateOnly = false } = {}) {
    const route = routes().find((r) => r.name === name);
    let names = route ? [...route.targets] : [name];
    if (route && route.strategy === 'round-robin' && names.length > 1) { const n = (rr.get(name) || 0) % names.length; rr.set(name, n + 1); names = [...names.slice(n), ...names.slice(0, n)]; }
    return names.map(resolve).filter(Boolean).filter((t) => !privateOnly || tierOf(t.provider) === 'private');
  }
  // Why a name cannot be served, for a clear error.
  function whyNot(name, { privateOnly = false } = {}) {
    const route = routes().find((r) => r.name === name);
    const names = route ? route.targets : [name];
    for (const n of names) {
      const p = list().find((x) => x.id === n.split('/')[0]);
      if (!p) continue;
      if (p.enabled === false) return `provider "${p.id}" is disabled`;
      if (tierOf(p) === 'external' && p.approved === false) return `external provider "${p.id}" is not approved yet (Agent Gateway → Providers)`;
      if (privateOnly && tierOf(p) === 'external') return 'this key may use private models only';
    }
    return route ? `no usable target in ${name}` : `unknown model "${name}": use <provider id>/<model>, an alias or a router/<name> route`;
  }

  async function request(p, path, { method = 'POST', body, signal } = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
    try {
      return await fetchImpl(`${p.baseUrl}${path}`, { method, headers: headers(p), body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (err) {
      throw new Error(secrets.mask(err.name === 'AbortError' ? `${p.id}: timed out` : `${p.id}: ${err.cause?.code || err.message}`));
    } finally { clearTimeout(t); }
  }

  async function models(p, fresh = false) {
    const hit = modelCache.get(p.id);
    if (!fresh && hit && now() - hit.at < MODELS_TTL) return hit.models;
    let ids = [];
    try {
      const r = await request(p, '/models', { method: 'GET' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(); ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    } catch (err) { if (!p.models || !p.models.length) throw err; }
    const all = [...new Set([...(p.models || []), ...ids])].sort();
    modelCache.set(p.id, { at: now(), models: all });
    return all;
  }

  return {
    PRESETS, list, routes, get, resolve, resolveAll, whyNot, request, models, tierOf, usable,
    streamUsage: (p) => (PRESETS[p.preset] || {}).streamUsage !== false,
    async test(p) {
      const started = now();
      try { const m = await models(p, true); return { ok: true, latencyMs: now() - started, models: m.length }; } catch (err) { return { ok: false, latencyMs: now() - started, error: secrets.mask(err.message) }; }
    },
  };
}

module.exports = { createProviders, cleanProvider, cleanRoute, PRESETS };
