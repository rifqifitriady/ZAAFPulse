// LLM Gateway / Model Router. Providers speak the OpenAI chat-completions API, or the Anthropic Messages
// API natively (format "anthropic"; the gateway translates). Presets fill in the base URL for 50+ local,
// lab, cloud, regional and enterprise endpoints; models come from each provider's own /models list.
// Providers are private (your own hardware) or external, and an external provider serves traffic only
// once it is approved. Models are "<provider id>/<model>"; routes are virtual models ("router/fast")
// that try their targets in order and fall back on errors, skipping targets cooling down after a 429.
// Auth is an API key, or a short-lived token that refreshes itself before it expires: OAuth2 (refresh
// token or client credentials, e.g. Azure Entra ID) or a Google service account (Vertex AI). Secrets
// are references (Keychain or env); tokens live only in memory. Rate-limit headers from every answer
// become a per-provider quota reading.
const crypto = require('crypto');

const P = (label, baseUrl, category, extra = {}) => ({ label, baseUrl, category, keyRequired: !extra.local, ...extra });
const PRESETS = {
  ollama: P('Ollama', 'http://localhost:11434/v1', 'Private', { local: true, hint: 'Llama, Qwen, Mistral, Gemma on this Mac' }),
  lmstudio: P('LM Studio', 'http://localhost:1234/v1', 'Private', { local: true, hint: 'Local models with a desktop app' }),
  vllm: P('vLLM (GPU)', 'http://localhost:8000/v1', 'Private', { local: true, hint: 'GPU serving: vllm serve <model>' }),
  tgi: P('TGI (GPU)', 'http://localhost:8080/v1', 'Private', { local: true, hint: 'Hugging Face Text Generation Inference' }),
  llamacpp: P('llama.cpp server', 'http://localhost:8081/v1', 'Private', { local: true, hint: 'llama-server --port 8081' }),
  jan: P('Jan', 'http://localhost:1337/v1', 'Private', { local: true, hint: 'Jan desktop local API server' }),
  localai: P('LocalAI', 'http://localhost:8082/v1', 'Private', { local: true, hint: 'OpenAI-compatible local inference' }),
  litellm: P('LiteLLM proxy', 'http://localhost:4000/v1', 'Private', { local: true, keyRequired: false, hint: 'Your own LiteLLM proxy' }),
  openai: P('OpenAI', 'https://api.openai.com/v1', 'Labs'),
  anthropic: P('Anthropic (native Messages)', 'https://api.anthropic.com/v1', 'Labs', { format: 'anthropic', hint: 'Claude via the Messages API; prompt caching and tools kept' }),
  'anthropic-openai': P('Anthropic (OpenAI-compatible)', 'https://api.anthropic.com/v1', 'Labs', { streamUsage: false }),
  gemini: P('Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'Labs'),
  mistral: P('Mistral AI', 'https://api.mistral.ai/v1', 'Labs'),
  cohere: P('Cohere', 'https://api.cohere.ai/compatibility/v1', 'Labs'),
  xai: P('xAI', 'https://api.x.ai/v1', 'Labs'),
  deepseek: P('DeepSeek', 'https://api.deepseek.com/v1', 'Labs', { balance: 'deepseek' }),
  perplexity: P('Perplexity', 'https://api.perplexity.ai', 'Labs'),
  ai21: P('AI21 Labs', 'https://api.ai21.com/studio/v1', 'Labs'),
  groq: P('Groq', 'https://api.groq.com/openai/v1', 'Inference clouds'),
  together: P('Together AI', 'https://api.together.xyz/v1', 'Inference clouds'),
  fireworks: P('Fireworks AI', 'https://api.fireworks.ai/inference/v1', 'Inference clouds'),
  cerebras: P('Cerebras', 'https://api.cerebras.ai/v1', 'Inference clouds'),
  sambanova: P('SambaNova', 'https://api.sambanova.ai/v1', 'Inference clouds'),
  deepinfra: P('DeepInfra', 'https://api.deepinfra.com/v1/openai', 'Inference clouds'),
  nebius: P('Nebius AI Studio', 'https://api.studio.nebius.com/v1', 'Inference clouds'),
  hyperbolic: P('Hyperbolic', 'https://api.hyperbolic.xyz/v1', 'Inference clouds'),
  novita: P('Novita AI', 'https://api.novita.ai/v3/openai', 'Inference clouds'),
  nvidia: P('NVIDIA NIM', 'https://integrate.api.nvidia.com/v1', 'Inference clouds'),
  huggingface: P('Hugging Face router', 'https://router.huggingface.co/v1', 'Inference clouds'),
  'github-models': P('GitHub Models', 'https://models.github.ai/inference', 'Inference clouds', { hint: 'A GitHub token with models:read' }),
  cloudflare: P('Cloudflare Workers AI', 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1', 'Inference clouds', { hint: 'Replace ACCOUNT_ID in the URL' }),
  'ollama-cloud': P('Ollama Cloud', 'https://ollama.com/v1', 'Inference clouds'),
  baseten: P('Baseten', 'https://inference.baseten.co/v1', 'Inference clouds'),
  featherless: P('Featherless', 'https://api.featherless.ai/v1', 'Inference clouds'),
  chutes: P('Chutes', 'https://llm.chutes.ai/v1', 'Inference clouds'),
  lambda: P('Lambda Inference', 'https://api.lambda.ai/v1', 'Inference clouds'),
  scaleway: P('Scaleway Generative APIs', 'https://api.scaleway.ai/v1', 'Inference clouds'),
  openrouter: P('OpenRouter', 'https://openrouter.ai/api/v1', 'Routers', { balance: 'openrouter', hint: '400+ models behind one key' }),
  requesty: P('Requesty', 'https://router.requesty.ai/v1', 'Routers'),
  'vercel-ai': P('Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', 'Routers'),
  portkey: P('Portkey', 'https://api.portkey.ai/v1', 'Routers'),
  '9router': P('9router (local)', 'http://localhost:20128/v1', 'Routers', { local: true, keyRequired: false, hint: 'Another local router on this Mac' }),
  moonshot: P('Moonshot (Kimi)', 'https://api.moonshot.ai/v1', 'Asia', { balance: 'moonshot' }),
  zai: P('Z.ai (GLM)', 'https://api.z.ai/api/paas/v4', 'Asia'),
  dashscope: P('Alibaba DashScope (Qwen)', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'Asia'),
  minimax: P('MiniMax', 'https://api.minimax.io/v1', 'Asia'),
  siliconflow: P('SiliconFlow', 'https://api.siliconflow.com/v1', 'Asia', { balance: 'siliconflow' }),
  stepfun: P('StepFun', 'https://api.stepfun.com/v1', 'Asia'),
  byteplus: P('BytePlus ModelArk', 'https://ark.ap-southeast.bytepluses.com/api/v3', 'Asia'),
  'azure-openai': P('Azure OpenAI', 'https://RESOURCE.openai.azure.com/openai/v1', 'Enterprise', { hint: 'API key, or Entra ID (OAuth2 client credentials)', auths: ['key', 'oauth2'],
    oauth: { tokenUrl: 'https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/token', scope: 'https://cognitiveservices.azure.com/.default', grant: 'client_credentials' } }),
  vertex: P('Google Vertex AI', 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/endpoints/openapi', 'Enterprise', { hint: 'Service account JSON; tokens refresh on their own', auth: 'google-sa', auths: ['google-sa', 'oauth2'] }),
  bedrock: P('Amazon Bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', 'Enterprise', { hint: 'A Bedrock API key (bearer)' }),
  custom: P('Custom OpenAI-compatible', '', 'Custom', { keyRequired: false, hint: 'Any OpenAI-compatible endpoint' }),
};
const ID = /^[a-z0-9-]{1,32}$/;
const TIMEOUT_MS = 120000;
const MODELS_TTL = 10 * 60 * 1000;
const TOKEN_LEAD_MS = 5 * 60 * 1000; // refresh a token that expires within five minutes
const COOLDOWN_MAX_MS = 5 * 60 * 1000;
const AUTH_TYPES = ['key', 'oauth2', 'google-sa'];

function cleanProvider(input = {}, existing = null) {
  const errors = [];
  const id = String(input.id || '').trim();
  if (!ID.test(id)) errors.push('id: 1-32 lowercase letters, digits or dashes');
  const preset = PRESETS[input.preset] ? input.preset : 'custom';
  const pre = PRESETS[preset];
  const baseUrl = String(input.baseUrl || pre.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) errors.push('baseUrl: must start with http:// or https://');
  if (/ACCOUNT_ID|RESOURCE|PROJECT_ID/.test(baseUrl)) errors.push('baseUrl: replace the placeholder (ACCOUNT_ID, RESOURCE or PROJECT_ID) with yours');
  const models = (Array.isArray(input.models) ? input.models : String(input.models || '').split(',')).map((m) => String(m).trim()).filter(Boolean).slice(0, 200);
  const aliases = input.aliases && typeof input.aliases === 'object' && !Array.isArray(input.aliases) ? input.aliases : (existing && existing.aliases) || {};
  const tier = input.tier === 'private' || input.tier === 'external' ? input.tier : pre.local ? 'private' : 'external';
  const format = input.format === 'anthropic' || input.format === 'openai' ? input.format : pre.format || 'openai';
  const authType = AUTH_TYPES.includes(input.authType) ? input.authType : (existing && existing.auth && existing.auth.type) || pre.auth || 'key';
  let auth;
  if (authType === 'oauth2') {
    const o = { ...(pre.oauth || {}), ...((existing && existing.auth) || {}), ...input.oauth };
    const tokenUrl = String(o.tokenUrl || '').trim();
    if (!/^https:\/\/[^\s]+$/.test(tokenUrl)) errors.push('OAuth2 token URL: must start with https://');
    if (/TENANT_ID/.test(tokenUrl)) errors.push('OAuth2 token URL: replace TENANT_ID with your tenant');
    auth = { type: 'oauth2', tokenUrl, clientId: String(o.clientId || '').trim().slice(0, 200), scope: String(o.scope || '').trim().slice(0, 300), grant: o.grant === 'refresh_token' ? 'refresh_token' : 'client_credentials' };
    if (!auth.clientId) errors.push('OAuth2 client id is required');
  } else if (authType === 'google-sa') auth = { type: 'google-sa', scope: 'https://www.googleapis.com/auth/cloud-platform' };
  return { errors, value: { id, preset, baseUrl, apiKey: input.apiKey !== undefined ? input.apiKey : existing ? existing.apiKey : undefined, models, aliases, enabled: input.enabled !== false,
    tier, approved: tier === 'private' ? true : input.approved === true, format, ...(auth ? { auth } : {}) } };
}
const tierOf = (p) => p.tier || ((PRESETS[p.preset] || {}).local ? 'private' : 'external');
const formatOf = (p) => p.format || (PRESETS[p.preset] || {}).format || 'openai';
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

// "6m0s", "1.5s", "250ms", an RFC 3339 time or seconds → milliseconds from now.
function resetIn(v, now) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s); if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}/.test(s)) return Math.max(0, t - now);
  let ms = 0; let any = false;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) { any = true; ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[u]; }
  return any ? ms : null;
}
// Rate-limit headers (OpenAI, Groq, Mistral and most compatible APIs; Anthropic) → { requests, tokens }.
function readQuota(h, now) {
  const get = (k) => h.get(k);
  const pick = (kind) => {
    const limit = get(`x-ratelimit-limit-${kind}`) ?? get(`anthropic-ratelimit-${kind}-limit`);
    const remaining = get(`x-ratelimit-remaining-${kind}`) ?? get(`anthropic-ratelimit-${kind}-remaining`);
    const reset = get(`x-ratelimit-reset-${kind}`) ?? get(`anthropic-ratelimit-${kind}-reset`);
    if (limit == null && remaining == null) return null;
    const r = resetIn(reset, now);
    return { limit: limit != null ? Number(limit) : null, remaining: remaining != null ? Number(remaining) : null, resetAt: r != null ? now + r : null };
  };
  const requests = pick('requests'); const tokens = pick('tokens');
  return requests || tokens ? { requests, tokens } : null;
}

function createProviders({ getConfig, secrets, fetchImpl = fetch, now = Date.now }) {
  const modelCache = new Map();
  const tokens = new Map(); // provider id -> { access, exp } (memory only)
  const refreshing = new Map(); // provider id -> in-flight refresh promise (one refresh at a time)
  const quotas = new Map(); // provider id -> { at, requests, tokens, status, retryAfterMs }
  const cooldown = new Map(); // provider id -> { until, strikes, reason }
  const balances = new Map(); // provider id -> { at, ... }
  const list = () => (((getConfig() || {}).gateway || {}).providers || []);
  const routes = () => (((getConfig() || {}).gateway || {}).routes || []);
  const get = (id) => list().find((p) => p.id === id && usable(p));
  const rr = new Map();
  const secretOf = (p) => (p.apiKey ? secrets.resolve(p.apiKey, `${p.id} credential`) : null);

  // Short-lived tokens: fetched when missing or expiring within TOKEN_LEAD_MS, one refresh at a time.
  async function refreshToken(p) {
    const raw = secretOf(p); if (!raw) throw new Error(`${p.id}: no credential stored for ${p.auth.type}`);
    let form;
    if (p.auth.type === 'google-sa') {
      let sa; try { sa = JSON.parse(raw); } catch { throw new Error(`${p.id}: the credential is not a service account JSON`); }
      const t = Math.floor(now() / 1000); const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: p.auth.scope, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3600 })}`;
      const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
      form = { url: sa.token_uri || 'https://oauth2.googleapis.com/token', body: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` } };
    } else {
      // The stored secret is the client secret, or JSON { "client_secret", "refresh_token" } for the refresh-token grant.
      let s = {}; try { s = JSON.parse(raw); } catch { s = { client_secret: raw }; }
      const cached = tokens.get(p.id);
      form = { url: p.auth.tokenUrl, body: { grant_type: p.auth.grant, client_id: p.auth.clientId, ...(s.client_secret ? { client_secret: s.client_secret } : {}), ...(p.auth.scope ? { scope: p.auth.scope } : {}),
        ...(p.auth.grant === 'refresh_token' ? { refresh_token: (cached && cached.refresh) || s.refresh_token } : {}) } };
      if (p.auth.grant === 'refresh_token' && !form.body.refresh_token) throw new Error(`${p.id}: no refresh_token in the stored credential`);
    }
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetchImpl(form.url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form.body).toString() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new Error(`${p.id}: token refresh failed (${r.status}${j.error ? ` ${j.error}` : ''})`);
      const prev = tokens.get(p.id);
      const tok = { access: j.access_token, exp: now() + (Number(j.expires_in) || 3600) * 1000, refresh: j.refresh_token || (prev && prev.refresh) || null, refreshedAt: now() };
      tokens.set(p.id, tok); return tok;
    } catch (err) { throw new Error(secrets.mask(err.name === 'AbortError' ? `${p.id}: token endpoint timed out` : err.message)); } finally { clearTimeout(timer); }
  }
  async function accessToken(p, force = false) {
    const t = tokens.get(p.id);
    if (!force && t && t.exp - now() > TOKEN_LEAD_MS) return t.access;
    if (!refreshing.has(p.id)) refreshing.set(p.id, refreshToken(p).finally(() => refreshing.delete(p.id)));
    return (await refreshing.get(p.id)).access;
  }
  async function headers(p, force = false) {
    const h = { 'content-type': 'application/json', accept: 'application/json' };
    const cred = p.auth && p.auth.type !== 'key' ? await accessToken(p, force) : secretOf(p);
    if (formatOf(p) === 'anthropic') { if (cred) h['x-api-key'] = cred; h['anthropic-version'] = '2023-06-01'; } else if (cred) h.authorization = `Bearer ${cred}`;
    return h;
  }

  function noteResponse(p, r) {
    const q = readQuota(r.headers, now());
    const retry = resetIn(r.headers.get('retry-after'), now());
    if (q || r.status === 429) quotas.set(p.id, { ...(quotas.get(p.id) || {}), ...(q || {}), at: now(), status: r.status, ...(retry != null ? { retryAfterMs: retry } : {}) });
    if (r.status === 429 || r.status === 503 || r.status === 529) {
      // Cool down: the provider's own reset time when it gives one, else exponential back-off up to 5 minutes.
      const c = cooldown.get(p.id) || { strikes: 0 };
      const resetAt = q && [q.requests, q.tokens].filter((x) => x && x.remaining === 0 && x.resetAt).map((x) => x.resetAt)[0];
      const wait = Math.min(COOLDOWN_MAX_MS, retry ?? (resetAt ? resetAt - now() : 1000 * 2 ** c.strikes));
      cooldown.set(p.id, { until: now() + Math.max(1000, wait), strikes: c.strikes + 1, reason: `HTTP ${r.status}` });
    } else if (r.ok && cooldown.has(p.id)) cooldown.delete(p.id);
  }
  const coolingDown = (id) => { const c = cooldown.get(id); return c && c.until > now() ? c : null; };

  // "provider/model" (or an alias) → { provider, model }; null when nothing matches or the provider is not usable.
  function resolve(name) {
    if (typeof name !== 'string' || !name) return null;
    for (const p of list()) if (usable(p) && p.aliases && p.aliases[name]) return { provider: p, model: p.aliases[name], name };
    const i = name.indexOf('/');
    if (i > 0) { const p = get(name.slice(0, i)); if (p) return { provider: p, model: name.slice(i + 1), name }; }
    return null;
  }
  // Every target to try for a name, in order: a route's usable targets (rotated for round-robin), or the one
  // model; targets cooling down after a rate limit move to the back.
  function resolveAll(name, { privateOnly = false } = {}) {
    const route = routes().find((r) => r.name === name);
    let names = route ? [...route.targets] : [name];
    if (route && route.strategy === 'round-robin' && names.length > 1) { const n = (rr.get(name) || 0) % names.length; rr.set(name, n + 1); names = [...names.slice(n), ...names.slice(0, n)]; }
    const ts = names.map(resolve).filter(Boolean).filter((t) => !privateOnly || tierOf(t.provider) === 'private');
    return [...ts.filter((t) => !coolingDown(t.provider.id)), ...ts.filter((t) => coolingDown(t.provider.id))];
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
    const send = async (force) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
      try {
        const r = await fetchImpl(`${p.baseUrl}${path}`, { method, headers: await headers(p, force), body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
        noteResponse(p, r); return r;
      } catch (err) {
        throw new Error(secrets.mask(err.name === 'AbortError' ? `${p.id}: timed out` : `${p.id}: ${err.cause?.code || err.message}`));
      } finally { clearTimeout(t); }
    };
    const r = await send(false);
    // An expired or revoked short-lived token: refresh once and replay.
    if (r.status === 401 && p.auth && p.auth.type !== 'key') { await r.body?.cancel?.().catch(() => {}); return send(true); }
    return r;
  }

  async function models(p, fresh = false) {
    const hit = modelCache.get(p.id);
    if (!fresh && hit && now() - hit.at < MODELS_TTL) return hit.models;
    let ids = [];
    try {
      const r = await request(p, '/models', { method: 'GET' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(); ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).map((m) => String(m).replace(/^models\//, ''));
    } catch (err) { if (!p.models || !p.models.length) throw err; }
    const all = [...new Set([...(p.models || []), ...ids])].sort();
    modelCache.set(p.id, { at: now(), models: all });
    return all;
  }

  // Account balance where the provider publishes it (OpenRouter credits, DeepSeek, Moonshot, SiliconFlow).
  async function balance(p) {
    const kind = (PRESETS[p.preset] || {}).balance; if (!kind) return null;
    const hit = balances.get(p.id); if (hit && now() - hit.at < 5 * 60000) return hit;
    const path = { openrouter: '/key', deepseek: '/user/balance', moonshot: '/users/me/balance', siliconflow: '/user/info' }[kind];
    const base = kind === 'deepseek' ? { ...p, baseUrl: p.baseUrl.replace(/\/v1$/, '') } : p; // DeepSeek's balance lives outside /v1
    try {
      const r = await request(base, path, { method: 'GET' });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = j.data || j;
      const out = kind === 'openrouter' ? { used: d.usage, limit: d.limit, remaining: d.limit_remaining ?? (d.limit != null ? d.limit - d.usage : null), currency: 'USD' }
        : kind === 'deepseek' ? { remaining: Number((d.balance_infos || [])[0]?.total_balance), currency: (d.balance_infos || [])[0]?.currency, available: d.is_available }
          : kind === 'moonshot' ? { remaining: d.available_balance, currency: 'CNY' } : { remaining: Number(d.totalBalance ?? d.balance), currency: 'CNY' };
      const v = { at: now(), ...out }; balances.set(p.id, v); return v;
    } catch (err) { return { at: now(), error: secrets.mask(err.message) }; }
  }

  // Background refresh: tokens close to expiry are renewed before a request has to wait for them.
  const timer = setInterval(() => {
    for (const p of list()) if (usable(p) && p.auth && p.auth.type !== 'key' && tokens.has(p.id) && tokens.get(p.id).exp - now() < TOKEN_LEAD_MS * 2) accessToken(p, true).catch(() => {});
  }, 60000); timer.unref?.();

  return {
    PRESETS, list, routes, get, resolve, resolveAll, whyNot, request, models, tierOf, formatOf, usable, balance, accessToken,
    cachedModels: (p) => (modelCache.get(p.id) || {}).models || p.models || [],
    streamUsage: (p) => (PRESETS[p.preset] || {}).streamUsage !== false && formatOf(p) !== 'anthropic',
    quota: () => list().map((p) => ({ id: p.id, ...(quotas.get(p.id) || {}), cooldown: coolingDown(p.id), token: tokens.has(p.id) ? { expiresAt: tokens.get(p.id).exp, refreshedAt: tokens.get(p.id).refreshedAt } : null, balance: balances.get(p.id) || null })),
    async test(p) {
      const started = now();
      try {
        if (p.auth && p.auth.type !== 'key') await accessToken(p, true);
        const m = await models(p, true); return { ok: true, latencyMs: now() - started, models: m.length };
      } catch (err) { return { ok: false, latencyMs: now() - started, error: secrets.mask(err.message) }; }
    },
  };
}

module.exports = { createProviders, cleanProvider, cleanRoute, PRESETS, readQuota, resetIn };
