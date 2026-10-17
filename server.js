#!/usr/bin/env node
// AI Command Center: a local dashboard of AI usage on this laptop.
// Listens on 127.0.0.1 only; nothing is sent off the machine.
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
  };
}
let config = loadConfig();

const indexer = DEMO
  ? { version: 1, state: { indexing: false, total: 0, done: 0, lastScan: Date.now(), lastDurationMs: 0, errors: 0 }, results: () => demo.buildResults(), refresh: async () => {} }
  : new Indexer([require('./lib/claude'), require('./lib/codex')], path.join(DIR, '.cache', 'index.json'));
const memo = new Map();

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
    if (url.pathname === '/api/office') {
      return send(res, 200, DEMO ? office.demoSnapshot() : office.snapshot());
    }
    if (url.pathname === '/api/vault') {
      return send(res, 200, DEMO ? demo.vault() : getVault(config.vaultPaths));
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return send(res, 200, config);
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
      return send(res, 200, config);
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
