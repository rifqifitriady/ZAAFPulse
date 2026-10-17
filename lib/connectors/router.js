// OpenAI-compatible AI routers. OmniRoute also has a management API (/api/*) reachable with an
// access token (`omniroute tokens create --scope read`); 9router is reached through /v1 only.
// Chat completions are deliberately left out: they spend tokens.
const { makeClient, tool, S, timedHealth } = require('./base');

const FLAVORS = ['omniroute', '9router'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const PROVIDER_FIELDS = ['id', 'provider', 'name', 'displayName', 'authType', 'isActive', 'testStatus', 'priority', 'backoffLevel', 'lastHealthCheckAt', 'expiresAt'];
// OAuth connections are often named after the account's email address; keep only a hint of it.
const maskEmail = (v) => (typeof v === 'string' ? v.replace(/([^\s@]{1,2})[^\s@]*@([^\s@]+)/g, '$1***@$2') : v);
const provider = (c) => {
  const p = pick(c, PROVIDER_FIELDS);
  for (const k of ['name', 'displayName']) if (k in p) p[k] = maskEmail(p[k]);
  return p;
};

module.exports = {
  type: 'router',
  create(id, cfg, { secrets }) {
    const flavor = cfg.flavor || 'omniroute';
    if (!FLAVORS.includes(flavor)) throw new Error(`flavor must be one of ${FLAVORS.join(', ')}`);
    const baseUrl = cfg.baseUrl || 'http://localhost:20128';
    const apiKey = secrets.resolve(cfg.apiKey, 'apiKey');
    const mgmt = secrets.resolve(cfg.managementToken, 'managementToken');
    const v1 = makeClient({ baseUrl, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, mask: secrets.mask });
    const manage = makeClient({ baseUrl, headers: mgmt ? { authorization: `Bearer ${mgmt}` } : {}, mask: secrets.mask });
    const listV1 = async () => (((await v1('GET', '/v1/models')) || {}).data || []).map((m) => ({ id: m.id, owned_by: m.owned_by }));

    if (flavor === '9router') {
      return {
        tools: [
          tool('health', 'Whether 9router answers, with its model count and latency.', {}, async () => {
            const started = Date.now();
            const models = await listV1();
            return { ok: true, models: models.length, latencyMs: Date.now() - started };
          }),
          tool('list_models', 'Models and combos 9router can serve.', {}, async () => ({ models: await listV1() })),
        ],
        health: () => timedHealth(async () => `${(await listV1()).length} models`),
      };
    }

    const tools = [
      tool('health', 'OmniRoute health, plus degraded features when a management token is set.', {}, async () => ({
        health: await manage('GET', '/api/health'),
        ...(mgmt ? { degradation: await manage('GET', '/api/health/degradation').catch((err) => ({ error: err.message })) } : {}),
      })),
    ];
    if (apiKey || mgmt) {
      tools.push(tool('list_models', 'Models and combos OmniRoute can serve.', {}, async () => (mgmt ? manage('GET', '/api/models') : { models: await listV1() })));
    }
    if (mgmt) {
      tools.push(
        tool('list_providers', 'Provider connections and their health (credentials and emails left out).', {}, async () => {
          const r = (await manage('GET', '/api/providers')) || {};
          return { total: r.total, connections: (r.connections || []).map(provider) };
        }),
        tool('list_combos', 'Combos: model chains OmniRoute falls back across.', {}, () => manage('GET', '/api/combos')),
        tool('usage', 'Requests, tokens, cost, latency and errors through OmniRoute.', { period: S.enum(['day', 'week', 'month'], 'Window (default day)') }, async (a) => {
          const period = a.period || 'day';
          const r = (await manage('GET', '/api/usage/analytics', { query: { period } })) || {};
          return { period, summary: r.summary, byModel: r.byModel, byProvider: r.byProvider, dailyTrend: r.dailyTrend, errorBreakdown: r.errorBreakdown };
        }),
        tool('telemetry', 'Latency percentiles, error rate, active sessions and quota monitor state.', {}, () => manage('GET', '/api/telemetry/summary')),
      );
    }
    return { tools, health: () => timedHealth(async () => { await manage('GET', '/api/health'); }) };
  },
};
