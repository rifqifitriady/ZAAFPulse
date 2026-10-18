// Keeps model prices current from OpenRouter's public model list (provider list prices per token).
// One GET without credentials or user data; the result is cached in .cache/prices.json and refreshed
// every 12 hours. Live prices win over the built-in defaults, and over your own prices unless you pin
// a model; models the list does not have keep your price or the default.
const fs = require('fs');
const path = require('path');

const SOURCE = 'https://openrouter.ai/api/v1/models';
const REFRESH_MS = 12 * 3600 * 1000;
// OpenRouter vendor prefix → our vendor id and display name (meta and meta-llama are both Meta).
const VENDORS = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', qwen: 'Alibaba', 'x-ai': 'xAI', meta: 'Meta', 'meta-llama': 'Meta', tencent: 'Tencent', 'z-ai': 'Z.ai' };
const VENDOR_ID = { 'x-ai': 'xai', 'meta-llama': 'meta', qwen: 'alibaba', 'z-ai': 'zai' };
// OpenRouter's "latest" aliases give the generic keys a live price too.
const ALIASES = { '~anthropic/claude-opus-latest': 'opus', '~anthropic/claude-sonnet-latest': 'sonnet', '~anthropic/claude-haiku-latest': 'haiku' };
const perM = (v) => Math.round(Number(v || 0) * 1e6 * 1e6) / 1e6; // per token → per 1M, no float noise

// Logs name Anthropic models with dashes (claude-opus-5-5) and OpenAI ones with dots (gpt-5.6-sol).
const keyFor = (vendor, slug) => (vendor === 'anthropic' ? slug.replace(/\./g, '-') : slug);

function parse(list) {
  const out = [];
  for (const m of list || []) {
    if (!m || typeof m.id !== 'string' || !m.pricing) continue;
    const alias = ALIASES[m.id];
    if (!alias && (m.id.includes(':') || m.id.startsWith('~'))) continue; // batch tiers, free tiers and aliases
    const [vendor, slug] = m.id.replace(/^~/, '').split('/');
    if (!VENDORS[vendor] || !slug) continue;
    const input = perM(m.pricing.prompt);
    const cacheWrite5m = perM(m.pricing.input_cache_write);
    const params = m.supported_parameters || [];
    const tags = [];
    if (params.includes('reasoning') || params.includes('include_reasoning')) tags.push('Reasoning');
    if (params.includes('tools')) tags.push('Tools');
    if ((m.architecture?.input_modalities || []).includes('image')) tags.push('Vision');
    if (params.includes('structured_outputs')) tags.push('Structured output');
    out.push({
      key: alias || keyFor(vendor, slug), id: m.id, vendor: VENDOR_ID[vendor] || vendor, vendorName: VENDORS[vendor], name: (m.name || slug).replace(/^[^:]+:\s*/, ''),
      description: typeof m.description === 'string' ? m.description.replace(/\s+/g, ' ').trim().slice(0, 280) : '',
      context: m.context_length || null, created: m.created ? m.created * 1000 : null, tags,
      // Anthropic charges 2× input for 1-hour cache writes; the list only carries the 5-minute rate.
      price: { input, output: perM(m.pricing.completion), cacheRead: perM(m.pricing.input_cache_read), cacheWrite5m, cacheWrite1h: vendor === 'anthropic' ? Math.round(input * 2 * 1e6) / 1e6 : cacheWrite5m },
    });
  }
  const seen = new Set();
  return out.filter((m) => !seen.has(m.key) && seen.add(m.key));
}

function createPriceSync({ cacheFile, fetchImpl = fetch, now = Date.now, onChange = () => {} }) {
  let data = null; let error = null; let busy = null;
  try { data = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first run */ }

  async function refresh() {
    if (busy) return busy;
    busy = (async () => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
      try {
        const r = await fetchImpl(SOURCE, { headers: { accept: 'application/json' }, signal: ctl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const models = parse((await r.json()).data);
        if (!models.length) throw new Error('the price list was empty');
        data = { source: 'OpenRouter', url: SOURCE, fetchedAt: now(), models };
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(data)); fs.renameSync(`${cacheFile}.tmp`, cacheFile);
        error = null; onChange();
      } catch (err) {
        error = err.name === 'AbortError' ? 'timed out' : err.message;
      } finally { clearTimeout(t); busy = null; }
    })();
    return busy;
  }

  return {
    refresh,
    stale: () => !data || now() - data.fetchedAt > REFRESH_MS,
    status: () => ({ source: 'OpenRouter', url: SOURCE, fetchedAt: data ? data.fetchedAt : null, models: data ? data.models.length : 0, error, refreshing: !!busy }),
    catalog: () => (data ? data.models : []),
    // defaults < your prices < live prices; a pinned key keeps your price. With sync off, live prices are ignored.
    effective(defaults, manual = {}, { enabled = true, pinned = [] } = {}) {
      const live = enabled && data ? Object.fromEntries(data.models.map((m) => [m.key, m.price])) : {};
      const out = { ...defaults, ...manual };
      const source = Object.fromEntries(Object.keys(out).map((k) => [k, k in manual ? 'manual' : 'default']));
      for (const [k, p] of Object.entries(live)) {
        if (pinned.includes(k) && k in manual) continue;
        out[k] = p; source[k] = 'live';
      }
      return { pricing: out, source };
    },
  };
}

module.exports = { createPriceSync, parse, keyFor, REFRESH_MS };
