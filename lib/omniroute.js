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
