// API-equivalent list prices in USD per 1M tokens. These estimate what the usage would
// cost on the pay-as-you-go API; a subscription plan is not billed per token.
// Edit them in Settings (stored in config.json) when prices change.
//
// Sources, checked 2026-10-20:
//  - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (docs.anthropic.com redirects
//    there) for base, cache, fast mode, long-context, data-residency and web search prices; model IDs from
//    https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions.
//  - OpenAI: https://developers.openai.com/api/docs/pricing (openai.com/api/pricing answers 403 to scripts).
//  - Everything else comes from the offline snapshot of https://openrouter.ai/api/v1/models in
//    lib/data/prices-snapshot.json (to refresh it, see buildSnapshot in lib/price-sync.js).
//
// Entry fields: input, output, cacheRead, cacheWrite5m, cacheWrite1h (per 1M tokens); optional
// tiers [{ above, ...same fields }] for requests whose prompt (input + cache reads + cache writes) is over
// `above` tokens; optional webSearch (USD per search); optional estimate (a stand-in, not a list price).
const fs = require('fs');
const path = require('path');

const WEB_SEARCH = 0.01; // Anthropic: $10 per 1,000 searches; web fetch has no extra charge.
const p = (input, output, cacheRead, cacheWrite5m, cacheWrite1h, more = {}) => ({
  input,
  output,
  cacheRead,
  cacheWrite5m,
  cacheWrite1h,
  webSearch: WEB_SEARCH,
  ...more,
});
// Haiku 5.5 is priced by prompt length: over 100,000 prompt tokens the whole request pays the higher rates.
const HAIKU_5_5 = p(0.1, 0.5, 0.01, 0.125, 0.2, { tiers: [{ above: 100000, ...p(0.5, 2.5, 0.05, 0.625, 1) }] });
const OPUS_5_5 = p(4, 20, 0.2, 5, 8);
const SONNET_5_5 = p(2, 10, 0.1, 2.5, 4);

// Longest key wins, so every model whose price differs from its family needs its own key
// (claude-opus-4-5 is $5/$25 while claude-opus-4 is $15/$75).
const BUILTIN_PRICING = {
  'claude-fable-5-1': p(10, 50, 0.25, 12.5, 20), // cache hits 0.025x input
  'claude-fable-5': p(10, 50, 1, 12.5, 20),
  'claude-mythos-5-1': p(10, 50, 0.25, 12.5, 20),
  'claude-mythos-5': p(10, 50, 1, 12.5, 20),
  'claude-opus-5-5': OPUS_5_5, // cache hits 0.05x input
  'claude-opus-5': p(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-8': p(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-7': p(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-6': p(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-5': p(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-1': p(15, 75, 1.5, 18.75, 30),
  'claude-opus-4': p(15, 75, 1.5, 18.75, 30),
  // Fast mode (usage.speed "fast"): premium input/output, cache multipliers apply on top.
  'claude-opus-5-5-fast': p(8, 40, 0.4, 10, 16),
  'claude-opus-5-fast': p(10, 50, 1, 12.5, 20),
  'claude-opus-4-8-fast': p(10, 50, 1, 12.5, 20),
  'claude-sonnet-5-5': SONNET_5_5, // cache hits 0.05x input
  'claude-sonnet-5': p(2, 10, 0.2, 2.5, 4),
  'claude-sonnet-4': p(3, 15, 0.3, 3.75, 6), // 4, 4.5 and 4.6
  'claude-haiku-5-5': HAIKU_5_5,
  'claude-haiku-4': p(1, 5, 0.1, 1.25, 2), // 4.5
  'claude-3-5-haiku': p(0.8, 4, 0.08, 1, 1.6),
  // Generic family names point at the newest model of each family.
  opus: OPUS_5_5,
  sonnet: SONNET_5_5,
  haiku: HAIKU_5_5,
  // Codex rollouts that never name a model (before turn_context existed) are priced as gpt-5, the
  // Codex CLI default when those logs were written. Marked as an estimate so the UI can say so.
  codex: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0, estimate: true },
};

// Offline snapshot of the public OpenRouter list, so Codex and other models have a price before
// (or without) the live sync. A missing or broken file just means no snapshot.
function loadSnapshot(file = path.join(__dirname, 'data', 'prices-snapshot.json')) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { meta: { source: s.source, url: s.url, fetchedAt: s.fetchedAt }, prices: s.prices || {} };
  } catch {
    return { meta: null, prices: {} };
  }
}
const SNAPSHOT = loadSnapshot();
const SNAPSHOT_PRICING = SNAPSHOT.prices;
const SNAPSHOT_META = SNAPSHOT.meta;
// Built-in defaults < snapshot. Your prices and the live list are layered on top in price-sync.
const DEFAULT_PRICING = { ...BUILTIN_PRICING, ...SNAPSHOT_PRICING };

// One spelling per model: vendor paths (anthropic/, openai/, publishers/anthropic/models/), Bedrock
// region and vendor prefixes (us.anthropic.) and version suffixes (-v1:0), Vertex dates (@20250514) and
// display suffixes ([1m]) are dropped; Claude versions use dashes (claude-opus-4.5 -> claude-opus-4-5).
function normalizeModel(model) {
  let m = String(model || '')
    .trim()
    .toLowerCase();
  m = m.slice(m.lastIndexOf('/') + 1);
  m = m.replace(/\[[^\]]*\]$/, '');
  m = m.replace(/^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?anthropic\./, '');
  m = m.replace(/@[\w.-]+$/, '');
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  if (m.startsWith('claude')) m = m.replace(/\./g, '-');
  return m;
}

// A key matches the model itself or a longer name that continues after a separator, so
// "claude-opus-5" prices claude-opus-5-20260101 but not claude-opus-50, and "gpt-5" does not
// price gpt-5.6 (a dot followed by a digit is a new version). A key that ends in a separator
// ("gpt-") is a plain prefix.
function keyMatches(model, key) {
  if (!model.startsWith(key)) return false;
  if (model.length === key.length || /[^a-z0-9]$/.test(key)) return true;
  const c = model[key.length];
  if (c === '-' || c === '@' || c === ':' || c === '_') return true;
  return c === '.' && !/[0-9]/.test(model[key.length + 1] || '');
}

function makePricer(pricing) {
  const keys = Object.keys(pricing)
    .map((k) => [normalizeModel(k), k])
    .sort((a, b) => b[0].length - a[0].length);
  const memo = new Map();
  const find = (model) => {
    if (!memo.has(model)) {
      const m = normalizeModel(model);
      const hit = keys.find(([nk]) => nk && keyMatches(m, nk));
      memo.set(model, hit ? hit[1] : null);
    }
    return memo.get(model);
  };
  // The rates one request pays: the highest tier its prompt is over, else the base entry.
  const rates = (entry, prompt) => {
    let r = entry;
    for (const t of Array.isArray(entry.tiers) ? entry.tiers : [])
      if (t && prompt > t.above && t.above >= (r.above || 0)) r = t;
    return r;
  };
  return {
    key: find,
    entry: (model) => {
      const k = find(model);
      return k ? pricing[k] : null;
    },
    priced: (model) => find(model) !== null,
    estimated: (model) => {
      const k = find(model);
      return !!(k && pricing[k].estimate);
    },
    // [input, output, cache read, cache write, server tools] cost in USD for one request.
    // extra is the event's 12th field: { ws: web searches, geo: 'us' }, or null.
    parts(model, input, output, cacheRead, cw5m, cw1h, extra) {
      const k = find(model);
      if (!k) return [0, 0, 0, 0, 0];
      const entry = pricing[k];
      const r = rates(entry, input + cacheRead + cw5m + cw1h);
      // US-only inference (inference_geo "us") costs 1.1x on every token category.
      const mul = extra && extra.geo === 'us' ? 1.1 : 1;
      return [
        (input * (r.input || 0) * mul) / 1e6,
        (output * (r.output || 0) * mul) / 1e6,
        (cacheRead * (r.cacheRead || 0) * mul) / 1e6,
        ((cw5m * (r.cacheWrite5m || 0) + cw1h * (r.cacheWrite1h || 0)) * mul) / 1e6,
        extra && extra.ws ? extra.ws * (entry.webSearch || 0) : 0,
      ];
    },
  };
}

// The cost parts of one usage event row.
const eventParts = (pricer, e) => pricer.parts(e[3], e[4], e[5], e[6], e[7], e[8], e[11]);

module.exports = {
  DEFAULT_PRICING,
  BUILTIN_PRICING,
  SNAPSHOT_PRICING,
  SNAPSHOT_META,
  loadSnapshot,
  makePricer,
  eventParts,
  normalizeModel,
  keyMatches,
};
