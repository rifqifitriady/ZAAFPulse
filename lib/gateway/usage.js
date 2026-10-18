// Gateway request log and per-key spend. Each entry has time, key, provider, model, status, tokens,
// cost, latency and time to first token; never prompt or completion text. Monthly spend per key is
// kept in memory (rebuilt from the log at start) so budgets are checked without rereading the file.
const { jsonlLog } = require('./store');

const monthOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}`; };

// Price key for a gateway model name: drop the provider id and any vendor prefix, and use dashes
// for Anthropic versions, the way the price table names models (claude-opus-5-5, gpt-6.1-sol).
function priceKey(model) {
  const parts = String(model).split('/'); const slug = parts[parts.length - 1].replace(/:.*$/, '');
  return /claude/.test(slug) ? slug.replace(/\./g, '-') : slug;
}

function createUsage({ file, getPricing, now = Date.now }) {
  const log = jsonlLog(file);
  const spend = new Map(); // `${keyId}|${month}` -> USD
  const recent = [];
  for (const e of log.read()) { add(e); recent.push(e); }
  if (recent.length > 2000) recent.splice(0, recent.length - 2000);

  function add(e) { if (e.keyId && e.cost) { const k = `${e.keyId}|${monthOf(e.ts)}`; spend.set(k, (spend.get(k) || 0) + e.cost); } }
  function cost(model, u = {}) {
    const pricing = getPricing() || {}; const key = priceKey(model);
    const match = Object.keys(pricing).sort((a, b) => b.length - a.length).find((k) => key.startsWith(k));
    if (!match) return 0;
    const p = pricing[match]; const cached = u.cached || 0;
    return ((Math.max(0, (u.input || 0) - cached)) * (p.input || 0) + cached * (p.cacheRead || p.input || 0) + (u.output || 0) * (p.output || 0)) / 1e6;
  }

  return {
    cost, priceKey,
    record(e) {
      const entry = { ts: now(), ...e, cost: e.cost ?? cost(e.model, { input: e.input, output: e.output, cached: e.cached }) };
      log.append(entry); add(entry); recent.push(entry); if (recent.length > 2000) recent.shift();
      return entry;
    },
    monthSpend: (keyId) => spend.get(`${keyId}|${monthOf(now())}`) || 0,
    recent: (n = 300) => recent.slice(-n).reverse(),
    // Totals for the dashboard: today, this month, per key and per model.
    summary() {
      const day = new Date(now()); day.setHours(0, 0, 0, 0);
      const m = monthOf(now()); const byKey = {}; const byModel = {}; const t = { requests: 0, errors: 0, input: 0, output: 0, cost: 0, today: 0, todayCost: 0 };
      for (const e of recent) {
        if (monthOf(e.ts) !== m) continue;
        t.requests++; if (e.status >= 400) t.errors++; t.input += e.input || 0; t.output += e.output || 0; t.cost += e.cost || 0;
        if (e.ts >= day.getTime()) { t.today++; t.todayCost += e.cost || 0; }
        const k = (byKey[e.keyId || 'dashboard'] ||= { requests: 0, cost: 0, tokens: 0 }); k.requests++; k.cost += e.cost || 0; k.tokens += (e.input || 0) + (e.output || 0);
        const mm = (byModel[e.model || '—'] ||= { requests: 0, cost: 0, tokens: 0, ms: [] }); mm.requests++; mm.cost += e.cost || 0; mm.tokens += (e.input || 0) + (e.output || 0); if (e.ms) mm.ms.push(e.ms);
      }
      for (const v of Object.values(byModel)) { v.ms.sort((a, b) => a - b); v.p50 = v.ms.length ? v.ms[Math.floor(v.ms.length / 2)] : null; delete v.ms; }
      return { month: m, totals: t, byKey, byModel };
    },
  };
}

module.exports = { createUsage, priceKey };
