// Keeps model prices current from OpenRouter's public model list (provider list prices per token).
// One GET without credentials or user data; the result is cached in .cache/prices.json and refreshed
// every 12 hours. Precedence: built-in defaults < offline snapshot (lib/data/prices-snapshot.json) <
// your prices < live prices, unless you pin a model; models the list does not have keep your price,
// the snapshot's or the default.
const fs = require('fs');
const path = require('path');
const { SNAPSHOT_PRICING } = require('./pricing');

const SOURCE = 'https://openrouter.ai/api/v1/models';
const REFRESH_MS = 12 * 3600 * 1000;
// OpenRouter vendor prefix → our vendor id and display name (meta and meta-llama are both Meta).
const VENDORS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  qwen: 'Alibaba',
  'x-ai': 'xAI',
  meta: 'Meta',
  'meta-llama': 'Meta',
  tencent: 'Tencent',
  'z-ai': 'Z.ai',
};
const VENDOR_ID = { 'x-ai': 'xai', 'meta-llama': 'meta', qwen: 'alibaba', 'z-ai': 'zai' };
// OpenRouter's "latest" aliases give the generic keys a live price too.
const ALIASES = {
  '~anthropic/claude-opus-latest': 'opus',
  '~anthropic/claude-sonnet-latest': 'sonnet',
  '~anthropic/claude-haiku-latest': 'haiku',
};
const perM = (v) => Math.round(Number(v || 0) * 1e6 * 1e6) / 1e6; // per token → per 1M, no float noise

// Logs name Anthropic models with dashes (claude-opus-5-5) and OpenAI ones with dots (gpt-5.6-sol).
const keyFor = (vendor, slug) => (vendor === 'anthropic' ? slug.replace(/\./g, '-') : slug);

// One price entry from OpenRouter's per-token strings. Anthropic charges 2x input for 1-hour cache
// writes; older list entries only carry the 5-minute rate, so that is derived when it is missing.
function priceOf(pr, vendor, base = null) {
  const pick = (field, fallback) => (pr[field] != null ? perM(pr[field]) : fallback);
  const input = pick('prompt', base ? base.input : 0);
  const cacheWrite5m = pick('input_cache_write', base ? base.cacheWrite5m : 0);
  return {
    input,
    output: pick('completion', base ? base.output : 0),
    cacheRead: pick('input_cache_read', base ? base.cacheRead : 0),
    cacheWrite5m,
    cacheWrite1h: pick(
      'input_cache_write_1h',
      vendor === 'anthropic' ? Math.round(input * 2 * 1e6) / 1e6 : cacheWrite5m,
    ),
  };
}

// Prompt-length tiers (overrides with min_prompt_tokens). Time-of-day overrides are left out: a log
// line does not say which window the provider billed it in, so the base price stands.
function tiersOf(pr, vendor, base) {
  const out = [];
  for (const o of Array.isArray(pr.overrides) ? pr.overrides : []) {
    if (!o || !Number.isFinite(o.min_prompt_tokens) || o.utc_days || o.utc_start != null) continue;
    out.push({ above: o.min_prompt_tokens, ...priceOf(o, vendor, base) });
  }
  return out.sort((a, b) => a.above - b.above);
}

function parse(list) {
  const out = [];
  for (const m of list || []) {
    if (!m || typeof m.id !== 'string' || !m.pricing) continue;
    const alias = ALIASES[m.id];
    if (!alias && (m.id.includes(':') || m.id.startsWith('~'))) continue; // batch tiers, free tiers and aliases
    const [vendor, slug] = m.id.replace(/^~/, '').split('/');
    if (!VENDORS[vendor] || !slug) continue;
    const price = priceOf(m.pricing, vendor);
    const tiers = tiersOf(m.pricing, vendor, price);
    if (tiers.length) price.tiers = tiers;
    // web_search is USD per search request ($10 per 1,000 at Anthropic and OpenAI).
    if (Number(m.pricing.web_search) > 0) price.webSearch = Number(m.pricing.web_search);
    const params = m.supported_parameters || [];
    const tags = [];
    if (params.includes('reasoning') || params.includes('include_reasoning')) tags.push('Reasoning');
    if (params.includes('tools')) tags.push('Tools');
    if ((m.architecture?.input_modalities || []).includes('image')) tags.push('Vision');
    if (params.includes('structured_outputs')) tags.push('Structured output');
    out.push({
      key: alias || keyFor(vendor, slug),
      id: m.id,
      vendor: VENDOR_ID[vendor] || vendor,
      vendorName: VENDORS[vendor],
      name: (m.name || slug).replace(/^[^:]+:\s*/, ''),
      description: typeof m.description === 'string' ? m.description.replace(/\s+/g, ' ').trim().slice(0, 280) : '',
      context: m.context_length || null,
      created: m.created ? m.created * 1000 : null,
      tags,
      price,
    });
  }
  const seen = new Set();
  return out.filter((m) => !seen.has(m.key) && seen.add(m.key));
}

// The offline snapshot shipped in lib/data/prices-snapshot.json: prices only, keyed like the live list.
// Refresh it with one GET of the public list:
//   curl -s https://openrouter.ai/api/v1/models > /tmp/or.json && node -e "const ps=require('./lib/price-sync');
//   const s=ps.buildSnapshot(require('/tmp/or.json').data,new Date().toISOString().slice(0,10));
//   require('fs').writeFileSync('lib/data/prices-snapshot.json',JSON.stringify(s,null,1)+'\n')"
function buildSnapshot(list, fetchedAt) {
  const prices = {};
  for (const m of parse(list)) prices[m.key] = m.price;
  return { source: 'OpenRouter', url: SOURCE, fetchedAt, prices };
}

function createPriceSync({ cacheFile, fetchImpl = fetch, now = Date.now, onChange = () => {} }) {
  let data = null;
  let error = null;
  let busy = null;
  try {
    data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    /* first run */
  }

  async function refresh() {
    if (busy) return busy;
    busy = (async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      try {
        const r = await fetchImpl(SOURCE, { headers: { accept: 'application/json' }, signal: ctl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const models = parse((await r.json()).data);
        if (!models.length) throw new Error('the price list was empty');
        data = { source: 'OpenRouter', url: SOURCE, fetchedAt: now(), models };
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(data));
        fs.renameSync(`${cacheFile}.tmp`, cacheFile);
        error = null;
        onChange();
      } catch (err) {
        error = err.name === 'AbortError' ? 'timed out' : err.message;
      } finally {
        clearTimeout(t);
        busy = null;
      }
    })();
    return busy;
  }

  return {
    refresh,
    stale: () => !data || now() - data.fetchedAt > REFRESH_MS,
    status: () => ({
      source: 'OpenRouter',
      url: SOURCE,
      fetchedAt: data ? data.fetchedAt : null,
      models: data ? data.models.length : 0,
      error,
      refreshing: !!busy,
    }),
    catalog: () => (data ? data.models : []),
    // defaults < snapshot < your prices < live prices; a pinned key keeps your price. With sync off,
    // live prices are ignored. `defaults` already carries the snapshot (DEFAULT_PRICING).
    effective(defaults, manual = {}, { enabled = true, pinned = [] } = {}) {
      const live = enabled && data ? Object.fromEntries(data.models.map((m) => [m.key, m.price])) : {};
      const out = { ...defaults, ...manual };
      const source = Object.fromEntries(
        Object.keys(out).map((k) => [
          k,
          k in manual ? 'manual' : SNAPSHOT_PRICING[k] && defaults[k] === SNAPSHOT_PRICING[k] ? 'snapshot' : 'default',
        ]),
      );
      for (const [k, p] of Object.entries(live)) {
        if (pinned.includes(k) && k in manual) continue;
        out[k] = p;
        source[k] = 'live';
      }
      return { pricing: out, source };
    },
  };
}

module.exports = { createPriceSync, parse, buildSnapshot, keyFor, REFRESH_MS };
