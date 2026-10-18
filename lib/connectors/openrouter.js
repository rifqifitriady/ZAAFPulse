// OpenRouter, read-only: the public model catalog with prices, which providers serve a model and
// their uptime, the provider directory, the usage rankings, and (with an API key) credits and limits.
// Chat completions are deliberately left out: they spend tokens.
const os = require('os');
const path = require('path');
const { tool, S, timedHealth } = require('./base');
const { createOpenRouter } = require('../openrouter');

const unwrap = (v) => { if (!v.data) throw new Error(v.error || 'no data'); return v.data; };

module.exports = {
  type: 'openrouter',
  create(id, cfg, { secrets }) {
    const key = cfg.apiKey ? secrets.resolve(cfg.apiKey, 'apiKey') : null;
    const or = createOpenRouter({ cacheDir: path.join(os.tmpdir(), `acc-openrouter-${id}`), getKey: () => key });
    const tools = [
      tool('list_models', 'Models on OpenRouter with prices per 1M tokens, context length and capabilities. Filter by text or vendor.', {
        query: S.str('Text in the id, name or description, e.g. "coding" or "flash"'), vendor: S.str('Vendor prefix, e.g. anthropic, openai, google, deepseek, qwen, x-ai, meta-llama, z-ai'),
        max_input_price: S.num('Only models with input price at or below this (USD per 1M)'), limit: S.int('Max models (default 25)', 200),
      }, async (a) => {
        const q = (a.query || '').toLowerCase();
        return unwrap(await or.models()).filter((m) => (!a.vendor || m.vendor === a.vendor) && (!q || `${m.id} ${m.name} ${m.description}`.toLowerCase().includes(q))
          && (a.max_input_price == null || (m.input != null && m.input <= a.max_input_price))).slice(0, a.limit || 25);
      }),
      tool('model_endpoints', 'Providers that serve one model, with their price, uptime (5 min, 30 min, 1 day), status, quantization and limits.', {
        model: S.str('OpenRouter model id, e.g. anthropic/claude-opus-5.5'),
      }, async (a) => unwrap(await or.endpoints(a.model)), { required: ['model'] }),
      tool('list_providers', 'Inference providers on OpenRouter with headquarters, datacenter countries and status page.', {}, async () => unwrap(await or.providers())),
      tool('rankings', 'Most-used models and apps on OpenRouter by tokens processed, plus benchmark leaderboards (intelligence, coding, agentic). Read from the public rankings page.', {
        section: S.enum(['models', 'apps', 'benchmarks', 'all'], 'What to return (default models)'), period: S.enum(['day', 'week', 'month'], 'For apps (default week)'),
      }, async (a) => {
        const r = unwrap(await or.rankings()); const s = a.section || 'models';
        if (s === 'models') return { period: r.period, date: r.date, models: r.models };
        if (s === 'apps') return { period: a.period || 'week', apps: r.apps[a.period || 'week'] };
        if (s === 'benchmarks') return Object.fromEntries(Object.entries(r.benchmarks).map(([k, v]) => [k, v.slice(0, 25)]));
        return r;
      }),
    ];
    if (key) tools.push(tool('account', 'Your OpenRouter credits, usage and key limits.', {}, async () => or.account()));
    return { tools, health: () => timedHealth(async () => `${unwrap(await or.models()).length} models${key ? ' · key set' : ''}`) };
  },
};
