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
const office = require('./lib/office');
const { insights } = require('./lib/insights');
const reqlogs = require('./lib/reqlogs');
const timeline = require('./lib/timeline');
const { createOmniRoute } = require('./lib/omniroute');
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

function loadConfig() {
  let c = {};
  if (DEMO) c = { userName: demo.config.userName, monthlyBudgetUSD: demo.config.monthlyBudgetUSD };
  else try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* defaults */ }
  return {
    userName: c.userName || fullName(),
    monthlyBudgetUSD: Number.isFinite(c.monthlyBudgetUSD) ? c.monthlyBudgetUSD : 0,
    pricing: { ...DEFAULT_PRICING, ...(c.pricing || {}) },
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
    if (integ.registry) config = loadConfig();
    const local = createLocal({ cacheDir: path.join(DIR, '.cache'), config, indexer });
    const registry = createIntegrations({ config, secrets: createSecrets(), audit, local });
    local.integrationsStatus = () => registry.status();
    integ = { mtimeMs, registry };
  }
  return integ.registry;
}
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
      return send(res, 200, { calls: DEMO ? [] : require('./lib/audit').createAudit(path.join(DIR, '.cache', 'mcp-audit.jsonl')).tail(300) });
    }
    if (url.pathname === '/api/office') {
      return send(res, 200, DEMO ? office.demoSnapshot() : office.snapshot());
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
      else { fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2)); config = loadConfig(); }
      memo.clear();
      const { integrations, ...rest } = config;
      return send(res, 200, rest);
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
});
