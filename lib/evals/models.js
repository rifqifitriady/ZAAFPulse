// Judge model resolution and call adapters. Local first: the settings model, then Ollama, then LM Studio, and an
// external provider only when the owner chose one. Nothing here falls back to external on its own.
// Calls carry no tools: the judge only reads untrusted text and answers with JSON.
const { maskPii } = require('./pii');

const RANK = ['qwen3', 'qwen2.5', 'llama3.3', 'llama3.2', 'llama3.1', 'mistral', 'gemma3', 'gemma2', 'phi4'];
const CACHE_MS = 30000;
// Ollama's default context (2048 or 4096 tokens) is smaller than the judge's input budget, and Ollama drops the
// start of the context, where the system prompt is, without saying so. The window is sized for the prompt at about
// 3 characters a token (on the generous side) plus room for the answer, rounded up to one of three sizes: a size
// that changes from call to call makes Ollama load the model again.
const CTX_BUCKETS = [8192, 16384, 32768];
const numCtx = (chars) => {
  const need = Math.ceil(chars / 3) + 1024;
  return CTX_BUCKETS.find((b) => b >= need) || CTX_BUCKETS[CTX_BUCKETS.length - 1];
};
const WAIT_REASON = 'Install or start Ollama, or choose a provider';
const NOT_SELECTED = 'model is not from the selected provider';
const UNAVAILABLE = 'selected provider unavailable';
const CLOUD = 'Ollama cloud models send text off this machine; choose an external provider in the gateway instead';
// Ollama 0.12+ lists its cloud models next to the local ones ("gpt-oss:120b-cloud", "glm-4.6:cloud"), and a request
// to one is forwarded to ollama.com. Such a model is never a local judge: remote_host / remote_model mark it in
// /api/tags, and so does a name ending in "cloud".
const CLOUD_NAME = /(^|[:-])cloud$/i;
const isCloud = (m) => !!(m.remote_host || m.remote_model) || CLOUD_NAME.test(String(m.name || ''));

// AbortSignal.timeout needs Node 17.3+, which is within our floor; the controller is for odd runtimes.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms).unref?.();
  return c.signal;
}

// Errors keep a status (0 when nothing answered) and a short message; credentials in a URL or query are dropped.
function fail(status, message) {
  const clean = String(message || '')
    .replace(/(https?:\/\/)[^\s/@]*@/g, '$1')
    .replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^\s&]+/gi, '$1***')
    .slice(0, 160);
  const err = new Error(clean);
  err.status = status;
  return err;
}

// Billions of parameters: Ollama's details.parameter_size ("8.2B", "494.03M"), else a size in the name
// ("llama3.3:70b", "llama-3.1-8b-instruct"); null when neither says.
function billions({ name, params }) {
  const m =
    String(params || '').match(/^\s*(\d+(?:\.\d+)?)\s*([KMBT])/i) ||
    String(name).match(/(?:^|[:_-])(\d+(?:\.\d+)?)([MB])(?=$|[:._-])/i);
  if (!m) return null;
  const scale = { K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[m[2].toUpperCase()];
  return Number(m[1]) * scale;
}

// Embedding and rerank models cannot judge, so names containing "embed" or "rerank" are ignored.
// A configured name wins when the server lists it, else the first model matching the ranked list. A light model
// (at most 14B parameters, or of unknown size) is preferred, since the first judging loads it: a larger one is
// taken only when no ranked family has a light one. Entries are names, or { name, params } from Ollama.
const LIGHT_B = 14;
function pick(list, want) {
  const usable = list
    .map((x) => (typeof x === 'string' ? { name: x } : x))
    .filter((x) => x && typeof x.name === 'string' && x.name && !/embed|rerank/i.test(x.name));
  if (want && usable.some((x) => x.name === want)) return want;
  const light = (x) => {
    const b = billions(x);
    return b === null || b <= LIGHT_B;
  };
  for (const fits of [light, () => true]) {
    for (const key of RANK) {
      // LM Studio ids read "llama-3.1-8b", Ollama's "llama3.1:8b"; compare without separators.
      const hit = usable.find((x) => fits(x) && x.name.toLowerCase().replace(/[-_\s]/g, '').includes(key));
      if (hit) return hit.name;
    }
  }
  return null;
}

// The system text an external provider is sent: the gateway cannot force a schema, so the prompt states it.
function externalSystem(system, schema) {
  return `${String(system || '')}\n\nAnswer with JSON only, matching this schema: ${JSON.stringify(schema)}`;
}
// Everything an external provider receives, and what the preview shows: the schema line added and personal data
// (emails, addresses, phone numbers, home-folder user names) masked. A local judge reads the full text.
function externalPayload(system, user, schema) {
  return { system: maskPii(externalSystem(system, schema)), user: maskPii(user) };
}

function createModels({
  settings,
  gateway,
  fetchImpl = (...a) => fetch(...a),
  ollamaUrl = process.env.ZAAFPULSE_OLLAMA_URL || 'http://127.0.0.1:11434',
  lmstudioUrl = process.env.ZAAFPULSE_LMSTUDIO_URL || 'http://127.0.0.1:1234',
  now = Date.now,
  probeMs = 1500,
  callMs = 60000,
} = {}) {
  const base = (u) => String(u).replace(/\/+$/, '');
  let cache = null; // { key, at, value }

  async function listOf(url, path, pluck) {
    try {
      const r = await fetchImpl(base(url) + path, { signal: timeoutSignal(probeMs) });
      if (!r.ok) {
        await r.body?.cancel?.().catch(() => {});
        return [];
      }
      return pluck(await r.json());
    } catch {
      return [];
    }
  }
  // Every listed model with whether it is a cloud model; pick() only ever sees the local ones.
  const ollamaModels = () =>
    listOf(ollamaUrl, '/api/tags', (j) =>
      (Array.isArray(j.models) ? j.models : [])
        .filter((m) => m && typeof m === 'object')
        .map((m) => {
          const name = m.name || m.model;
          const params = m.details && m.details.parameter_size;
          return { name, params, cloud: isCloud({ ...m, name }) };
        }),
    );
  const lmstudioNames = () => listOf(lmstudioUrl, '/v1/models', (j) => (j.data || []).map((m) => m && m.id));

  // The gateway name to send, always through the selected provider. Route names ("router/..."), aliases and names
  // that belong to another configured provider are refused: they could reach a provider the owner did not pick.
  // An id with its own slash (OpenRouter style, "meta-llama/llama-3.1-70b") is just a model of the selected provider.
  // The final name is refused when it is a configured route, which the gateway serves before a provider called
  // "router"; a gateway that cannot say which routes exist has every router/... name refused.
  function routeName(provider, model) {
    const j = (gateway && gateway.judge) || {};
    const route = (n) => (typeof j.routed === 'function' ? !!j.routed(n) : n.startsWith('router/'));
    if (model.startsWith(`${provider}/`)) return (j.aliased && j.aliased(model)) || route(model) ? null : model;
    const first = model.split('/')[0];
    if (model.startsWith('router/')) return null;
    if (model.includes('/') && (j.providers() || []).some((p) => p.id === first)) return null;
    if (j.aliased && (j.aliased(model) || j.aliased(`${provider}/${model}`))) return null;
    return route(`${provider}/${model}`) ? null : `${provider}/${model}`;
  }

  // Whether a judge's cost can be counted: local models are free, an external one needs a list price in the gateway.
  // A gateway that cannot say is treated as unpriced.
  function priceOf(resolved) {
    if (!resolved || resolved.kind !== 'external') return null;
    const j = (gateway && gateway.judge) || {};
    const name = routeName(resolved.provider, resolved.model);
    if (!name || typeof j.priceOf !== 'function') return null;
    try {
      return j.priceOf(name) || null;
    } catch {
      return null;
    }
  }
  function priced(resolved) {
    if (!resolved || !resolved.ok) return false;
    if (resolved.kind !== 'external') return true;
    const j = (gateway && gateway.judge) || {};
    const name = routeName(resolved.provider, resolved.model);
    if (!name || typeof j.hasPrice !== 'function') return false;
    try {
      return !!j.hasPrice(name);
    } catch {
      return false;
    }
  }

  async function resolveNow(s) {
    const provider = s.provider || 'auto';
    const model = String(s.model || '');
    const external = provider !== 'auto' && provider !== 'ollama' && provider !== 'lmstudio';
    const refused = { ok: false, waiting: true, reason: CLOUD };
    if ((provider === 'ollama' || provider === 'auto') && CLOUD_NAME.test(model)) return refused;
    // The owner's own choice wins, and a known gateway provider is used as chosen. A named Ollama model is looked up
    // only to refuse a cloud model under a local-looking name; one that is not listed is still used as given.
    if (provider === 'ollama' && model) {
      if ((await ollamaModels()).some((m) => m.name === model && m.cloud)) return refused;
      return { ok: true, kind: provider, model, provider };
    }
    if (provider === 'lmstudio' && model) return { ok: true, kind: provider, model, provider };
    // An external provider the owner chose is never swapped for a local model or another provider.
    if (external) {
      const known = ((gateway && gateway.judge && gateway.judge.providers()) || []).some((p) => p.id === provider);
      if (!known || !model) return { ok: false, waiting: true, reason: UNAVAILABLE };
      if (!routeName(provider, model)) return { ok: false, waiting: true, reason: NOT_SELECTED };
      return { ok: true, kind: 'external', model, provider };
    }
    if (provider !== 'lmstudio') {
      const listed = await ollamaModels();
      if (model && listed.some((m) => m.name === model && m.cloud)) return refused;
      const m = pick(listed.filter((x) => !x.cloud), model);
      if (m) return { ok: true, kind: 'ollama', model: m, provider: 'ollama' };
    }
    if (provider !== 'ollama') {
      const m = pick(await lmstudioNames(), model);
      if (m) return { ok: true, kind: 'lmstudio', model: m, provider: 'lmstudio' };
    }
    return { ok: false, waiting: true, reason: WAIT_REASON };
  }

  async function resolve() {
    const s = (settings && settings()) || {};
    const key = `${s.provider || 'auto'}|${s.model || ''}`;
    if (cache && cache.key === key && now() - cache.at < CACHE_MS) return cache.value;
    // The promise itself is cached, so overlapping callers share one probe.
    const entry = { key, at: now(), value: resolveNow(s) };
    cache = entry;
    entry.value.catch(() => {
      if (cache === entry) cache = null; // do not keep a failed probe for 30 s
    });
    return entry.value;
  }

  const noThink = new Set(); // Ollama models whose server refused the think field, for the life of the process

  async function post(label, url, path, body) {
    let r;
    try {
      r = await fetchImpl(base(url) + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutSignal(callMs),
      });
    } catch (err) {
      const slow = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw fail(0, slow ? `${label} timed out` : `${label} is not reachable`);
    }
    if (!r.ok) {
      // A 400 says why, which the caller may need (an Ollama that refuses "think"); it stays off the message.
      let detail = '';
      if (r.status === 400 && typeof r.text === 'function') {
        detail = String(await r.text().catch(() => '')).slice(0, 500);
      } else {
        await r.body?.cancel?.().catch(() => {}); // free the socket; the body is not needed
      }
      throw Object.assign(fail(r.status, `${label} returned ${r.status}`), { detail });
    }
    try {
      return await r.json();
    } catch {
      throw fail(502, `${label} sent an unreadable answer`);
    }
  }

  async function call(resolved, { system, user, schema }) {
    if (!resolved || !resolved.ok) throw fail(0, 'no judge model');
    const messages = [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: String(user || '') },
    ];
    if (resolved.kind === 'ollama') {
      if (CLOUD_NAME.test(String(resolved.model || ''))) throw fail(0, CLOUD); // a hand-built resolution, say
      const body = {
        model: resolved.model,
        messages,
        stream: false,
        format: schema,
        think: false, // a thinking model would spend the context and the time on reasoning the verdict never shows
        options: { temperature: 0, num_ctx: numCtx(messages[0].content.length + messages[1].content.length) },
      };
      if (noThink.has(resolved.model)) delete body.think;
      let j;
      try {
        j = await post('Ollama', ollamaUrl, '/api/chat', body);
      } catch (err) {
        // An Ollama version or model that refuses the field gets the call once more without it, and keeps that.
        if (!('think' in body) || err.status !== 400 || !/think/i.test(err.detail || '')) throw err;
        noThink.add(resolved.model);
        delete body.think;
        j = await post('Ollama', ollamaUrl, '/api/chat', body);
      }
      return {
        text: String((j.message && j.message.content) || ''),
        usage: { input: j.prompt_eval_count || 0, output: j.eval_count || 0, cost: 0 },
      };
    }
    if (resolved.kind === 'lmstudio') {
      const j = await post('LM Studio', lmstudioUrl, '/v1/chat/completions', {
        model: resolved.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema } },
      });
      const c = j.choices && j.choices[0] && j.choices[0].message;
      return {
        text: String((c && c.content) || ''),
        usage: {
          input: (j.usage && j.usage.prompt_tokens) || 0,
          output: (j.usage && j.usage.completion_tokens) || 0,
          cost: 0,
        },
      };
    }
    // External: the gateway cannot force a schema, so the prompt states it. Gateway models are "provider/model".
    const name = routeName(resolved.provider, resolved.model);
    if (!name) throw fail(0, NOT_SELECTED);
    const out = externalPayload(messages[0].content, messages[1].content, schema);
    const ext = [
      { role: 'system', content: out.system },
      { role: 'user', content: out.user },
    ];
    let timer;
    const ctl = new AbortController();
    try {
      const r = await Promise.race([
        gateway.judge.complete({ model: name, messages: ext, signal: ctl.signal }),
        new Promise((_, rej) => {
          timer = setTimeout(() => {
            rej(fail(0, 'external provider timed out')); // first, so the abort's own error cannot win the race
            ctl.abort(); // cancels the upstream request, not only our wait for it
          }, callMs);
          timer.unref?.();
        }),
      ]);
      const u = (r && r.usage) || {};
      return {
        text: String((r && r.text) || ''),
        // null when the call cannot be priced (the gateway reports an unpriced model as 0): never read as free.
        usage: {
          input: u.input || 0,
          output: u.output || 0,
          cost: priced(resolved) && Number.isFinite(u.cost) ? u.cost : null,
        },
      };
    } catch (err) {
      throw err && err.status !== undefined && err.message
        ? fail(err.status, err.message)
        : fail(0, 'external provider failed');
    } finally {
      clearTimeout(timer);
    }
  }

  return { resolve, call, priced, priceOf };
}

module.exports = { createModels, externalSystem, externalPayload, pick, RANK };
