#!/usr/bin/env node
// AI Command Center: a local dashboard of AI usage on this laptop.
// Listens on 127.0.0.1 only; nothing leaves the machine except calls to integrations you configure.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { Indexer } = require('./lib/indexer');
const { summarize } = require('./lib/aggregate');
const { DEFAULT_PRICING } = require('./lib/pricing');
const processes = require('./lib/processes');
const { getVault } = require('./lib/vault');
const { createBrain } = require('./lib/brain');
const office = require('./lib/office');
const { insights } = require('./lib/insights');
const reqlogs = require('./lib/reqlogs');
const timeline = require('./lib/timeline');
const { createOmniRoute } = require('./lib/omniroute');
const { createIntegrationConfig, describe: describeIntegrations, secretResolver, keychainStore } = require('./lib/integration-config');
const { createGateway } = require('./lib/gateway');
const { createPriceSync } = require('./lib/price-sync');
const { createOpenRouter } = require('./lib/openrouter');
const { createIntegrations } = require('./lib/integrations');
const { createSecrets } = require('./lib/secrets');
const { createAudit } = require('./lib/audit');
const { createLocal } = require('./lib/local');
const register = require('./scripts/register-mcp');

const PORT = Number(process.env.PORT) || 4777;
const HOST = '127.0.0.1';
const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, 'config.json');
const PUBLIC = path.join(DIR, 'public');
const RESCAN_MS = 60 * 1000;
// DEMO=1 serves seeded synthetic data (for screenshots) and never reads logs or writes config.
const DEMO = process.env.DEMO === '1';
const demo = DEMO ? require('./lib/demo') : null;

function fullName() {
  try { return execFileSync('id', ['-F'], { encoding: 'utf8' }).trim().split(/\s+/)[0]; } catch { return os.userInfo().username; }
}

function computerName() {
  try { return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(); } catch { return os.hostname().replace(/\.local$/, ''); }
}
const HOSTNAME = DEMO ? demo.config.host : computerName();

// Live model prices (OpenRouter's public list). onChange runs after a refresh, once the server is up.
const priceSync = createPriceSync({ cacheFile: path.join(DIR, '.cache', 'prices.json'), onChange: () => { config = loadConfig(); memo.clear(); insightMemo.clear(); } });

function loadConfig() {
  let c = {};
  if (DEMO) c = { userName: demo.config.userName, monthlyBudgetUSD: demo.config.monthlyBudgetUSD };
  else try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* defaults */ }
  return {
    userName: c.userName || fullName(),
    monthlyBudgetUSD: Number.isFinite(c.monthlyBudgetUSD) ? c.monthlyBudgetUSD : 0,
    ...(() => {
      // config.json keeps only your own prices; live and default prices are merged in at runtime.
      const manualPricing = c.pricing && typeof c.pricing === 'object' ? c.pricing : {};
      const pricingSync = { enabled: !(c.pricingSync && c.pricingSync.enabled === false), pinned: Array.isArray(c.pricingSync?.pinned) ? c.pricingSync.pinned.filter((k) => typeof k === 'string') : [] };
      const eff = priceSync.effective(DEFAULT_PRICING, manualPricing, pricingSync); // demo uses the cached public list too, but never fetches
      return { pricing: eff.pricing, pricingSource: eff.source, manualPricing, pricingSync };
    })(),
    vaultPaths: Array.isArray(c.vaultPaths) ? c.vaultPaths.filter((p) => typeof p === 'string') : [],
    integrations: c.integrations && typeof c.integrations === 'object' && !Array.isArray(c.integrations) ? c.integrations : {},
  };
}
let config = loadConfig();

const indexer = DEMO
  ? { version: 1, state: { indexing: false, total: 0, done: 0, lastScan: Date.now(), lastDurationMs: 0, errors: 0 }, results: () => demo.buildResults(), refresh: async () => {} }
  : new Indexer([require('./lib/claude'), require('./lib/codex')], path.join(DIR, '.cache', 'index.json'));
const memo = new Map();

// Integrations are rebuilt whenever config.json changes on disk (they are edited in the file).
const audit = createAudit(path.join(DIR, '.cache', 'mcp-audit.jsonl'));
let integ = { mtimeMs: -1, registry: null };
function getIntegrations() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(CONFIG_FILE).mtimeMs; } catch { /* no config yet */ }
  if (!integ.registry || integ.mtimeMs !== mtimeMs) {
    config = loadConfig(); // also on the first build: config.json may have been edited since startup
    const local = createLocal({ cacheDir: path.join(DIR, '.cache'), config, indexer });
    const registry = createIntegrations({ config, secrets: createSecrets(), audit, local });
    local.integrationsStatus = () => registry.status();
    integ = { mtimeMs, registry };
  }
  return integ.registry;
}
const integrationConfig = createIntegrationConfig({ file: CONFIG_FILE, secrets: createSecrets() });
// Agent Gateway: OpenAI-compatible /v1 API, agents, orchestrator and MCP over HTTP, behind ZAAFPulse
// API keys. Provider settings live in config.json under "gateway"; keys, agents, sessions and memory
// in .data/ (demo mode uses a throwaway folder so it never touches your data).
let rawCache = { mtime: -1, value: {} };
function rawConfig() {
  if (DEMO) return rawCache.value;
  let mtime = 0; try { mtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch { /* none yet */ }
  if (mtime !== rawCache.mtime) { try { rawCache = { mtime, value: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { rawCache = { mtime, value: {} }; } }
  return rawCache.value;
}
const gatewaySecret = secretResolver({ store: keychainStore });
const gateway = createGateway({
  dataDir: DEMO ? fs.mkdtempSync(path.join(os.tmpdir(), 'zp-demo-')) : path.join(DIR, '.data'),
  getConfig: rawConfig,
  writeGatewayConfig: (g) => {
    if (DEMO) { rawCache.value = { ...rawCache.value, gateway: g }; return; }
    const raw = { ...rawConfig(), gateway: g };
    fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2)); fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
  },
  secrets: createSecrets(),
  // Provider keys go to the Keychain as acc.gw-<provider id>, apart from integration keys.
  resolveSecret: (id, input, current) => gatewaySecret(`gw-${id}`, { key: 'apiKey', label: 'API key', required: false }, input, current),
  getPricing: () => config.pricing,
  getIntegrations: () => getIntegrations(),
  version: require('./package.json').version,
  baseUrl: `http://127.0.0.1:${PORT}`,
});

// Second brain sources: Obsidian by default, plus Logseq, Notion, Tana, Roam, mem.ai, Reflect, Heybrain,
// PARA folders, the RAG knowledge bases and vector databases. Settings in config.json under "brain";
// tokens in the Keychain as acc.brain-<id>.
const brain = createBrain({
  getConfig: rawConfig,
  writeBrainConfig: (b) => {
    if (DEMO) { rawCache.value = { ...rawCache.value, brain: b }; return; }
    const raw = { ...rawConfig(), brain: b };
    fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2)); fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
  },
  secrets: createSecrets(),
  resolveSecret: (id, input, current) => gatewaySecret(`brain-${id}`, { key: 'token', label: 'secret', required: false }, input, current),
  knowledge: gateway.knowledge,
  getVaultPaths: () => config.vaultPaths || [],
});
gateway.setBrain(brain);

// OpenRouter data for Models and Rankings. The key (for credits) comes from an enabled openrouter
// integration; demo mode serves whatever is cached and never fetches.
const openRouter = createOpenRouter({
  cacheDir: path.join(DIR, '.cache'), offline: DEMO,
  getKey: () => {
    const e = Object.values(config.integrations || {}).find((c) => c && c.type === 'openrouter' && c.enabled !== false && c.apiKey);
    if (!e) return null;
    try { return createSecrets().resolve(e.apiKey, 'apiKey'); } catch { return null; }
  },
});
function clientRows() {
  return Object.entries(register.clients()).map(([id, c]) => ({
    id, name: c.name, file: c.file.replace(os.homedir(), '~'), registered: register.isRegistered(c.file), command: `npm run mcp:register -- ${id}`,
  }));
}

// Raw config.json (with integrations) for the OmniRoute reader; DEMO never touches it.
const router = createOmniRoute(() => { if (DEMO) return {}; try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } });
const insightMemo = new Map();
function getInsights(range) {
  const key = `${range}|${indexer.version}|${new Date().getHours()}`;
  if (!insightMemo.has(key)) {
    insightMemo.clear();
    insightMemo.set(key, insights(indexer.results(), { rangeDays: range, pricing: config.pricing }));
  }
  return insightMemo.get(key);
}

function getSummary(range) {
  const key = `${range}|${indexer.version}|${new Date().getHours()}`;
  if (!memo.has(key)) {
    memo.clear();
    memo.set(key, summarize(indexer.results(), { rangeDays: range, pricing: config.pricing }));
  }
  return memo.get(key);
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(data));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  // Reject requests from other sites (DNS rebinding / cross-origin writes).
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'forbidden' });

  try {
    if (await gateway.handle(req, res, url)) return;
    if (url.pathname === '/api/gateway' && req.method === 'GET') return send(res, 200, await gateway.admin('', 'GET'));
    const gwAdmin = url.pathname.match(/^\/api\/gateway\/([a-z]+)$/);
    if (gwAdmin) {
      if (req.method === 'GET') return send(res, 200, await gateway.admin(gwAdmin[1], 'GET'));
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      try { return send(res, 200, await gateway.admin(gwAdmin[1], 'POST', JSON.parse(await readBody(req)))); } catch (err) { return send(res, 200, { errors: [err.message] }); }
    }
    if (url.pathname === '/api/summary') {
      const r = url.searchParams.get('range') || '30';
      const range = r === 'all' ? 'all' : Math.min(365, Math.max(1, parseInt(r, 10) || 30));
      return send(res, 200, { ...getSummary(range), config: { userName: config.userName, monthlyBudgetUSD: config.monthlyBudgetUSD, host: HOSTNAME }, index: indexer.state });
    }
    if (url.pathname === '/api/live') {
      return send(res, 200, { ...(DEMO ? demo.live() : await processes.snapshot()), index: indexer.state });
    }
    if (url.pathname === '/api/insights') {
      const r = url.searchParams.get('range') || '30';
      return send(res, 200, getInsights(r === 'all' ? 'all' : Math.min(365, Math.max(1, parseInt(r, 10) || 30))));
    }
    if (url.pathname === '/api/router' && DEMO) {
      const section = url.searchParams.get('section');
      return send(res, 200, { configured: true, id: 'omniroute (demo)', data: require('./lib/omniroute').demoRouter(section) });
    }
    if (url.pathname === '/api/router') {
      if (!router.configured()) return send(res, 200, { configured: false });
      const range = ['1h', '24h', '7d', '30d'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '24h';
      const fn = { utilization: () => router.utilization(range), cache: router.cache, compression: router.compression, providers: router.providerStats, calls: router.callLogs, proxy: router.proxyLogs }[url.searchParams.get('section')];
      if (!fn) return send(res, 404, { error: 'unknown section' });
      return send(res, 200, { configured: true, id: router.id(), data: await fn() });
    }
    if (url.pathname === '/api/logs') {
      return send(res, 200, DEMO ? reqlogs.demoLogs() : reqlogs.logs());
    }
    if (url.pathname === '/api/timeline') {
      const hours = Math.min(48, Math.max(1, parseInt(url.searchParams.get('hours'), 10) || 6));
      return send(res, 200, DEMO ? timeline.demoTimeline(hours) : await timeline.timeline(hours));
    }
    if (url.pathname === '/api/mcp-calls') {
      return send(res, 200, { calls: DEMO ? demo.integrations().calls : require('./lib/audit').createAudit(path.join(DIR, '.cache', 'mcp-audit.jsonl')).tail(300) });
    }
    if (url.pathname === '/api/office') {
      return send(res, 200, DEMO ? office.demoSnapshot() : office.snapshot());
    }
    if (url.pathname === '/api/brain' && req.method === 'GET') {
      if (DEMO) return send(res, 200, { types: brain.TYPES, sources: [{ id: 'obsidian', type: 'obsidian', name: 'Obsidian (demo)', enabled: true, builtin: true, label: 'Obsidian', family: 'Notes' }] });
      return send(res, 200, { types: brain.TYPES, sources: brain.sources() });
    }
    if (url.pathname === '/api/brain/graph') {
      const id = url.searchParams.get('source') || 'obsidian';
      if (DEMO) return send(res, 200, { ...demo.vault(), source: { id: 'obsidian', type: 'obsidian', name: 'Obsidian (demo)', label: 'Obsidian' }, layout: 'network' });
      return send(res, 200, await brain.graph(id, { fresh: url.searchParams.get('fresh') === '1' }));
    }
    if (url.pathname === '/api/brain/sources' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      if (body.action === 'save') return send(res, 200, brain.save(body));
      if (body.action === 'delete') return send(res, 200, brain.remove(body.id));
      if (body.action === 'test') return send(res, 200, await brain.test(body.id));
      return send(res, 200, { errors: ['unknown action'] });
    }
    if (url.pathname === '/api/vault') {
      return send(res, 200, DEMO ? demo.vault() : getVault(config.vaultPaths));
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const { integrations, ...rest } = config;
      return send(res, 200, rest);
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      const next = { ...config };
      if (typeof body.userName === 'string') next.userName = body.userName.slice(0, 60);
      if (Number.isFinite(body.monthlyBudgetUSD) && body.monthlyBudgetUSD >= 0) next.monthlyBudgetUSD = body.monthlyBudgetUSD;
      if (typeof body.vaultPath === 'string') next.vaultPaths = body.vaultPath.trim() ? [body.vaultPath.trim().replace(/^~(?=\/)/, os.homedir())] : [];
      if (body.pricing && typeof body.pricing === 'object') {
        const p = {};
        for (const [k, v] of Object.entries(body.pricing)) {
          if (!/^[\w.\-]{1,60}$/.test(k) || !v) continue;
          const clean = {};
          for (const f of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) clean[f] = Math.max(0, Number(v[f]) || 0);
          p[k] = clean;
        }
        next.pricing = p;
      }
      if (DEMO) config = next;
      else {
        // Write the stored settings only, never the merged runtime prices.
        let raw = {}; try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* new file */ }
        Object.assign(raw, { userName: next.userName, monthlyBudgetUSD: next.monthlyBudgetUSD, vaultPaths: next.vaultPaths });
        if (body.pricing && typeof body.pricing === 'object') raw.pricing = next.pricing;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2)); config = loadConfig();
      }
      memo.clear();
      const { integrations, ...rest } = config;
      return send(res, 200, rest);
    }
    if (url.pathname === '/api/openrouter') {
      const fn = { models: openRouter.models, providers: openRouter.providers, rankings: openRouter.rankings, account: openRouter.account }[url.searchParams.get('section')];
      if (!fn) return send(res, 404, { error: 'unknown section' });
      return send(res, 200, await fn());
    }
    if (url.pathname === '/api/openrouter/endpoints') {
      const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
      return send(res, 200, await openRouter.endpointsMany(ids));
    }
    if (url.pathname === '/api/prices' && req.method === 'GET') {
      return send(res, 200, { status: priceSync.status(), sync: config.pricingSync, catalog: priceSync.catalog(), manual: config.manualPricing, effective: config.pricing, source: config.pricingSource, demo: DEMO });
    }
    if (url.pathname === '/api/prices' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      if (DEMO) return send(res, 200, { error: 'Demo mode: prices are not saved.' });
      if (body.action === 'refresh') { await priceSync.refresh(); return send(res, 200, { status: priceSync.status() }); }
      let raw = {}; try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* new file */ }
      const manual = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : {};
      const sync = { enabled: !(raw.pricingSync && raw.pricingSync.enabled === false), pinned: Array.isArray(raw.pricingSync?.pinned) ? raw.pricingSync.pinned : [] };
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (body.action !== 'toggle' && !/^[\w.\-]{1,60}$/.test(key)) return send(res, 400, { error: 'model key: letters, digits, dots and dashes' });
      if (body.action === 'toggle') sync.enabled = body.enabled !== false;
      else if (body.action === 'set') {
        const clean = {}; for (const f of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) clean[f] = Math.max(0, Number(body.price && body.price[f]) || 0);
        manual[key] = clean; if (!sync.pinned.includes(key)) sync.pinned.push(key); // your price for this key wins over the live one
      } else if (body.action === 'unpin' || body.action === 'remove') { delete manual[key]; sync.pinned = sync.pinned.filter((k) => k !== key); }
      else return send(res, 400, { error: 'unknown action' });
      raw.pricing = manual; raw.pricingSync = sync;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
      config = loadConfig(); memo.clear(); insightMemo.clear();
      if (body.action === 'toggle' && sync.enabled && priceSync.stale()) priceSync.refresh();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/integrations/config' && req.method === 'GET') {
      if (DEMO) return send(res, 200, describeIntegrations(Object.fromEntries(demo.integrations().integrations.filter((i) => i.type !== 'acc')
        .map((i) => [i.id, { type: i.type, ...(i.flavor ? { flavor: i.flavor } : {}), enabled: i.enabled, allowWrite: i.allowWrite, baseUrl: 'http://localhost:8080' }]))));
      return send(res, 200, integrationConfig.describe());
    }
    if (['/api/integrations/save', '/api/integrations/delete', '/api/integrations/test-draft'].includes(url.pathname) && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      if (url.pathname === '/api/integrations/test-draft') {
        if (DEMO) return send(res, 200, { status: { id: body.id, type: body.type, state: 'ok', latencyMs: 87, tools: 5 }, tools: ['demo_tool_a', 'demo_tool_b'] });
        return send(res, 200, await integrationConfig.test(body));
      }
      if (DEMO) return send(res, 200, { errors: ['Demo mode: changes are not saved.'] });
      const r = url.pathname.endsWith('/save') ? integrationConfig.save(body) : integrationConfig.remove(body.id);
      if (r.errors) return send(res, 200, r);
      config = loadConfig(); // keep Settings saves from writing back a stale integrations list
      if (url.pathname.endsWith('/delete')) return send(res, 200, r);
      const [status] = await getIntegrations().status({ fresh: true, only: r.id });
      return send(res, 200, { id: r.id, status });
    }
    if (url.pathname === '/api/integrations' && req.method === 'GET') {
      if (DEMO) return send(res, 200, demo.integrations());
      return send(res, 200, { integrations: await getIntegrations().status(), clients: clientRows(), calls: audit.tail(100), mcpCommand: `${process.execPath} ${path.join(DIR, 'mcp.js')}` });
    }
    if (url.pathname === '/api/integrations/test' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const { id } = JSON.parse(await readBody(req));
      if (DEMO) { const s = demo.integrations().integrations.find((i) => i.id === id); return s ? send(res, 200, s) : send(res, 404, { error: 'unknown integration' }); }
      const [s] = await getIntegrations().status({ fresh: true, only: String(id || '') });
      return s ? send(res, 200, s) : send(res, 404, { error: 'unknown integration' });
    }
    if (url.pathname === '/api/rescan' && req.method === 'POST') {
      indexer.refresh().then(() => memo.clear());
      return send(res, 202, indexer.state);
    }

    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Command Center${DEMO ? ' (demo data)' : ''} → http://localhost:${PORT}`);
  const t = Date.now();
  indexer.refresh().then(() => console.log(`Indexed logs in ${((Date.now() - t) / 1000).toFixed(1)}s`));
  setInterval(() => indexer.refresh(), RESCAN_MS).unref();
  // Live prices: refresh now if the cached list is older than 12 hours, then check hourly. Never in demo mode.
  const syncPrices = () => { if (!DEMO && config.pricingSync.enabled && priceSync.stale()) priceSync.refresh(); };
  syncPrices();
  setInterval(syncPrices, 3600 * 1000).unref();
});

// Sessions are written within a second; flush them when launchd or Ctrl-C stops the server.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { gateway.flush(); } finally { process.exit(0); } });
