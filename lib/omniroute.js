// Read-only view of the OmniRoute router configured under integrations in config.json:
// quota utilization, cache, compression, provider stats, call logs and upstream proxy logs.
// Only GET requests; account emails and connection ids are masked before they leave this module.
const { createSecrets } = require('./secrets');

const TTL_MS = 10 * 1000;
const TIMEOUT_MS = 4000;
const maskEmail = (v) => (typeof v === 'string' ? v.replace(/([^\s@]{1,2})[^\s@]*@([^\s@]+)/g, '$1***@$2') : v);
const shortId = (v) => (typeof v === 'string' && v.length > 8 ? `${v.slice(0, 4)}…` : v);

function createOmniRoute(getConfig, { secrets = createSecrets(), fetchImpl = fetch } = {}) {
  const cache = new Map();

  function target() {
    const all = (getConfig() || {}).integrations || {};
    const entry = Object.entries(all).find(([, c]) => c && c.type === 'router' && (c.flavor || 'omniroute') === 'omniroute' && c.enabled !== false);
    if (!entry) return null;
    const [id, c] = entry;
    return { id, baseUrl: (c.baseUrl || 'http://localhost:20128').replace(/\/$/, ''), tokenRef: c.managementToken };
  }

  async function get(path) {
    const t = target();
    if (!t) throw new Error('not configured');
    const key = t.baseUrl + path;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const token = t.tokenRef ? secrets.resolve(t.tokenRef, 'managementToken') : null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(t.baseUrl + path, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const value = await r.json();
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      throw new Error(secrets.mask(err.name === 'AbortError' ? 'timed out' : err.message));
    } finally { clearTimeout(timer); }
  }

  // Each section degrades on its own: one failing endpoint never hides the others.
  const safe = async (fn) => { try { return await fn(); } catch (err) { return { error: err.message }; } };

  return {
    configured: () => !!target(),
    id: () => (target() || {}).id || null,
    utilization: (range = '24h') => safe(() => get(`/api/usage/utilization?range=${encodeURIComponent(range)}`)),
    cache: () => safe(async () => {
      const [metrics, health, memo] = await Promise.all([get('/api/settings/cache-metrics'), get('/api/usage/cache-health'), get('/api/monitoring/compression').catch(() => null)]);
      return { metrics, health, memo: memo && memo.compression ? memo.compression.memo : null };
    }),
    compression: () => safe(() => get('/api/analytics/compression')),
    providerStats: () => safe(() => get('/api/provider-stats')),
    callLogs: () => safe(async () => (await get('/api/usage/call-logs')).map((l) => ({
      id: l.id, ts: Date.parse(l.timestamp), method: l.method, path: l.path, status: l.status, model: l.model, requestedModel: l.requestedModel,
      provider: l.providerDisplay || l.provider, account: maskEmail(l.account), durationMs: l.duration, ttftMs: l.ttft, tokens: l.tokens || {},
      cacheSource: l.cacheSource, combo: l.comboName, sourceFormat: l.sourceFormat, targetFormat: l.targetFormat, requestType: l.requestType,
    }))),
    proxyLogs: () => safe(async () => (await get('/api/usage/proxy-logs')).map((l) => ({
      id: l.id, ts: Date.parse(l.timestamp), status: l.status, level: l.level, proxy: l.proxy ? 'configured' : null, provider: l.provider, target: l.targetUrl,
      latencyMs: l.latencyMs, headersMs: l.headersMs, firstChunkMs: l.firstChunkMs, upstreamStatus: l.upstreamStatus, attempt: l.attemptNumber,
      issue: l.attemptIssue, error: l.error ? maskEmail(String(l.error)).slice(0, 200) : null, account: shortId(l.account), tls: !!l.tlsFingerprint,
    }))),
  };
}

module.exports = { createOmniRoute, maskEmail };

// Synthetic router data for DEMO=1, shaped like the live sections above.
function demoRouter(section, now = Date.now()) {
  let seed = 11; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const iso = (ms) => new Date(ms).toISOString();
  const providers = ['claude', 'openai', 'gemini'];
  if (section === 'utilization') {
    const data = []; for (let i = 0; i < 30; i++) for (const p of ['claude', 'openai']) data.push({ timestamp: iso(now - (29 - i) * 600000).replace('T', ' ').slice(0, 19), provider: p, remainingPct: Math.max(4, Math.round((p === 'claude' ? 92 : 70) - i * (p === 'claude' ? 2.6 : 1.4) + r() * 6)), isExhausted: false });
    return { timeRange: '24h', bucketSizeMinutes: 10, providers: ['claude', 'openai'], data };
  }
  if (section === 'cache') return { metrics: { totalRequests: 1840, requestsWithCacheControl: 1312, totalInputTokens: 9.1e6, totalCachedTokens: 7.4e6, totalCacheCreationTokens: 0.6e6, tokensSaved: 6.6e6, estimatedCostSaved: 19.84 }, health: { totalCalls: 1840, warmCalls: 1493, coldCalls: 214, verdict: 'healthy' }, memo: { size: 1280, capacity: 5000, hits: 412, misses: 1428, hitRate: 0.224 } };
  if (section === 'compression') return { totalRequests: 386, totalTokensSaved: 2.1e6, avgSavingsPct: 31.4, avgDurationMs: 42, totalSkipped: 57, byEngine: { rtk: { count: 214 }, caveman: { count: 172 } }, last24h: Array.from({ length: 24 }, (_, i) => ({ hour: iso(now - (23 - i) * 3600000), count: Math.round(4 + r() * 20), tokensSaved: Math.round(r() * 1e5) })), realUsage: { estimatedUsdSaved: 6.3 }, mcpDescriptionCompression: { estimatedTokensSaved: 18400 } };
  if (section === 'providers') return { providers: [{ provider: 'Claude', totalRequests: 1240, successfulRequests: 1228, avgLatencyMs: 1180, totalTokensIn: 5.2e6, totalTokensOut: 410000 }, { provider: 'OpenAI', totalRequests: 486, successfulRequests: 479, avgLatencyMs: 940, totalTokensIn: 1.9e6, totalTokensOut: 160000 }, { provider: 'Gemini', totalRequests: 114, successfulRequests: 109, avgLatencyMs: 760, totalTokensIn: 0.4e6, totalTokensOut: 52000 }],
    models: [{ provider: 'Claude', model: 'claude-sonnet-5', requests: 820, successfulRequests: 815, avgLatencyMs: 1040 }, { provider: 'Claude', model: 'claude-haiku-5', requests: 420, successfulRequests: 413, avgLatencyMs: 520 }, { provider: 'OpenAI', model: 'gpt-5.6-sol', requests: 486, successfulRequests: 479, avgLatencyMs: 940 }, { provider: 'Gemini', model: 'gemini-3-flash', requests: 114, successfulRequests: 109, avgLatencyMs: 760 }],
    telemetry: { count: 1840, p50: 880, p95: 2650, p99: 4200 } };
  if (section === 'calls') return Array.from({ length: 30 }, (_, i) => { const p = providers[i % 3]; const ok = r() > 0.06; return { id: `demo-call-${i}`, ts: now - i * 95000 - Math.round(r() * 30000), method: 'POST', path: '/v1/chat/completions', status: ok ? 200 : 429, model: p === 'claude' ? 'claude-sonnet-5' : p === 'openai' ? 'gpt-5.6-sol' : 'gemini-3-flash', provider: p, account: 'al***@example.com', durationMs: 400 + Math.round(r() * 2400), ttftMs: 200 + Math.round(r() * 900), tokens: { in: Math.round(r() * 4000), out: Math.round(r() * 900), cacheRead: Math.round(r() * 30000), cacheWrite: 0 }, combo: i % 4 ? null : 'fast-fallback', sourceFormat: 'openai', targetFormat: p === 'claude' ? 'claude' : 'openai' }; });
  if (section === 'proxy') return Array.from({ length: 40 }, (_, i) => { const p = providers[i % 3]; const ok = r() > 0.08; const lat = 300 + Math.round(r() * 2600); return { id: `demo-up-${i}`, ts: now - i * 180000 - Math.round(r() * 60000), status: ok ? 'success' : 'error', level: i % 5 ? 'direct' : 'proxy', proxy: i % 5 ? null : 'configured', provider: p, target: `${p}/${p === 'claude' ? 'claude-sonnet-5' : p === 'openai' ? 'gpt-5.6-sol' : 'gemini-3-flash'}`, latencyMs: lat, headersMs: Math.round(lat * 0.8), firstChunkMs: Math.round(lat * 0.9), upstreamStatus: ok ? 200 : 503, attempt: ok || i % 2 ? 1 : 2, issue: ok ? 'served' : 'upstream_error', error: ok ? null : 'upstream 503 Service Unavailable', account: 'b66e…', tls: false }; });
  return { error: 'unknown section' };
}

module.exports.demoRouter = demoRouter;
