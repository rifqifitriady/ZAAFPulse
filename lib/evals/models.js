// Judge model resolution and call adapters. Local first: the settings model, then Ollama, then LM Studio, and an
// external provider only when the owner chose one. Nothing here falls back to external on its own.
// Calls carry no tools: the judge only reads untrusted text and answers with JSON.

const RANK = ['qwen3', 'qwen2.5', 'llama3.3', 'llama3.2', 'llama3.1', 'mistral', 'gemma3', 'gemma2', 'phi4'];
const CACHE_MS = 30000;
const WAIT_REASON = 'Install or start Ollama, or choose a provider';

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

// Names containing "embed" are embedding models and cannot judge. A configured name wins when the server lists it,
// else the first model matching the ranked list.
function pick(names, want) {
  const usable = names.filter((n) => typeof n === 'string' && n && !/embed/i.test(n));
  if (want && usable.includes(want)) return want;
  for (const key of RANK) {
    // LM Studio ids read "llama-3.1-8b", Ollama's "llama3.1:8b"; compare without separators.
    const hit = usable.find((n) => n.toLowerCase().replace(/[-_\s]/g, '').includes(key));
    if (hit) return hit;
  }
  return null;
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
      if (!r.ok) return [];
      return pluck(await r.json());
    } catch {
      return [];
    }
  }
  const ollamaNames = () =>
    listOf(ollamaUrl, '/api/tags', (j) => (j.models || []).map((m) => m && (m.name || m.model)));
  const lmstudioNames = () => listOf(lmstudioUrl, '/v1/models', (j) => (j.data || []).map((m) => m && m.id));

  async function resolveNow(s) {
    const provider = s.provider || 'auto';
    const model = String(s.model || '');
    const external = provider !== 'auto' && provider !== 'ollama' && provider !== 'lmstudio';
    // The owner's own choice wins: a named local model needs no probe, a known gateway provider is used as chosen.
    if ((provider === 'ollama' || provider === 'lmstudio') && model)
      return { ok: true, kind: provider, model, provider };
    if (external && model) {
      const known = ((gateway && gateway.judge && gateway.judge.providers()) || []).some((p) => p.id === provider);
      if (known) return { ok: true, kind: 'external', model, provider };
    }
    if (provider !== 'lmstudio') {
      const m = pick(await ollamaNames(), model);
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
    const value = await resolveNow(s);
    cache = { key, at: now(), value };
    return value;
  }

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
    if (!r.ok) throw fail(r.status, `${label} returned ${r.status}`);
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
      const j = await post('Ollama', ollamaUrl, '/api/chat', {
        model: resolved.model,
        messages,
        stream: false,
        format: schema,
        options: { temperature: 0 },
      });
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
    const name = resolved.model.includes('/') ? resolved.model : `${resolved.provider}/${resolved.model}`;
    const ext = [
      {
        role: 'system',
        content: `${messages[0].content}\n\nAnswer with JSON only, matching this schema: ${JSON.stringify(schema)}`,
      },
      messages[1],
    ];
    let timer;
    try {
      const r = await Promise.race([
        gateway.judge.complete({ model: name, messages: ext }),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(fail(0, 'external provider timed out')), callMs);
          timer.unref?.();
        }),
      ]);
      const u = (r && r.usage) || {};
      return {
        text: String((r && r.text) || ''),
        usage: { input: u.input || 0, output: u.output || 0, cost: u.cost || 0 },
      };
    } catch (err) {
      throw err && err.status !== undefined && err.message
        ? fail(err.status, err.message)
        : fail(0, 'external provider failed');
    } finally {
      clearTimeout(timer);
    }
  }

  return { resolve, call };
}

module.exports = { createModels, pick, RANK };
