#!/usr/bin/env node
// ZAAFPulse: AI command center and agentic workspace. Runs on macOS, Linux and Windows.
// Listens on 127.0.0.1 by default; nothing leaves the machine except calls to the providers and
// integrations you configure. Server mode (HOST=0.0.0.0 or another address) requires a dashboard
// password; TLS with ZAAFPULSE_TLS_CERT and ZAAFPULSE_TLS_KEY, or put it behind a reverse proxy.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Indexer } = require('./lib/indexer');
const { summarize } = require('./lib/aggregate');
const { responseHeaders } = require('./lib/response-headers');
const { DEFAULT_PRICING, SNAPSHOT_META } = require('./lib/pricing');
const processes = require('./lib/processes');
const { getVault } = require('./lib/vault');
const { createBrain } = require('./lib/brain');
const office = require('./lib/office');
const { insights } = require('./lib/insights');
const reqlogs = require('./lib/reqlogs');
const { buildTopology, readGateway } = require('./lib/topology');
const { readToolRoutes, routeOf } = require('./lib/toolroutes');
const timeline = require('./lib/timeline');
const { createOmniRoute } = require('./lib/omniroute');
const {
  createIntegrationConfig,
  describe: describeIntegrations,
  secretResolver,
  keychainStore,
} = require('./lib/integration-config');
const { createGateway } = require('./lib/gateway');
const { createTrace, contentDefaultOff } = require('./lib/trace');
const { createEvalEngine } = require('./lib/evals/engine');
const { createEvalStore, createFeedbackStore } = require('./lib/evals/store');
const { createModels } = require('./lib/evals/models');
const { createClaude } = require('./lib/evals/claude-cli');
const { createEvalApi } = require('./lib/evals/api');
const { createDatasetStore } = require('./lib/datasets/store');
const { createExperimentStore } = require('./lib/datasets/experiments');
const { createReplayRunner } = require('./lib/datasets/replay');
const { createDatasetApi } = require('./lib/datasets/api');
const { createAutoAdd } = require('./lib/datasets/auto');
const { createMonitorState } = require('./lib/monitors/state');
const { createChannels, checkWebhookUrl, parseHeaders } = require('./lib/monitors/channels');
const { createMonitorApi } = require('./lib/monitors/api');
const { createMonitors, createAfterRefresh } = require('./lib/monitors');
const { createAgentControl, detectDocker } = require('./lib/agents/control');
const runtimeRegistry = require('./lib/runtimes/registry');
const { createRuntimeState, jsonFile } = require('./lib/runtimes/state');
const { createRuntimeControl } = require('./lib/runtimes/control');
const { createModelMemory } = require('./lib/runtimes/models');
const { createRuntimeApi } = require('./lib/runtimes/api');
const { createCost } = require('./lib/cost');
const { createCostApi } = require('./lib/cost/api');
const { passRates: costPassRates } = require('./lib/cost/views');
const { accuracyByModel } = require('./lib/quality');
const { createBudgetService } = require('./lib/cost/budget-service');
const { createGuard } = require('./lib/cost/guard');
const { recentDays, HISTORY_DAYS: ANOMALY_HISTORY_DAYS } = require('./lib/cost/anomaly');
const { dayOf: costDayOf, addDays: costAddDays } = require('./lib/cost/days');
const { createDigest, digestSource } = require('./lib/cost/digest');
const { isRef } = require('./lib/secrets');
const { createPriceSync } = require('./lib/price-sync');
const { createOpenRouter } = require('./lib/openrouter');
const { createIntegrations } = require('./lib/integrations');
const { createSecrets } = require('./lib/secrets');
const { createAudit } = require('./lib/audit');
const { createLocal } = require('./lib/local');
const { describeRoots } = require('./lib/logroots');
const register = require('./scripts/register-mcp');
const platform = require('./lib/platform');
const { createAuth, isLoopback, originAllowed } = require('./lib/auth');
const otel = require('./lib/otel');
const { createTraceStore } = require('./lib/trace/store');
const { createRecorder } = require('./lib/trace/recorder');
const { createReceiver } = require('./lib/trace/otlp');
const govContext = require('./lib/governance/context');
const { requestEntry, controlEntry } = require('./lib/governance/events');
const { createGovernanceAudit, keySource } = require('./lib/governance/audit');
const { diff: govDiff } = require('./lib/governance/diff');
const { createGovernanceApi } = require('./lib/governance/api');
const mcpScan = require('./lib/governance/mcp-scan');
const { liveOrThrow, runtimesOrThrow, indexReadyOrThrow } = require('./lib/governance/sources');
const { createSeenStore } = require('./lib/governance/seen');
const { cleanPolicy: guardPolicy } = require('./lib/gateway/guardrails');
const { RULES: MONITOR_RULES } = require('./lib/monitors/rules');
const { createUserStore } = require('./lib/users/store');
const { createUsersApi } = require('./lib/users/api');
const {
  allowed: roleAllows,
  redactGateway,
  redactTraceSessions,
  redactSummary,
  redactLogs,
  redactGatewayLogs,
  redactConfig,
  redactOffice,
  redactTimeline,
  redactRuntimesConfig,
} = require('./lib/users/policy');

const PORT = Number(process.env.ZAAFPULSE_PORT || process.env.PORT) || 4777;
const HOST = process.env.ZAAFPULSE_HOST || process.env.HOST || '127.0.0.1';
const SERVER_MODE = !isLoopback(HOST);
// config.json, .data/ and .cache/: ZAAFPULSE_DATA when set (installers set it), else next to the code.
// Everything ZAAFPulse creates (config, keys, history, caches) is private to this OS account.
process.umask(0o077);
const DIR = platform.dataDir();
// Make what an older version created private too: folders 0700, files 0600, symlinks left alone.
function makePrivate(p, depth) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  try {
    fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
  } catch {
    return; // not ours (a git checkout keeps its own modes)
  }
  if (st.isDirectory() && depth > 0) for (const f of fs.readdirSync(p)) makePrivate(path.join(p, f), depth - 1);
}
try {
  fs.chmodSync(DIR, 0o700);
} catch {
  /* not ours */
}
for (const sub of ['.data', '.cache']) makePrivate(path.join(DIR, sub), 3);
const CONFIG_FILE = path.join(DIR, 'config.json');
const PUBLIC = path.join(platform.APP_DIR, 'public');
const TLS =
  process.env.ZAAFPULSE_TLS_CERT && process.env.ZAAFPULSE_TLS_KEY
    ? { cert: fs.readFileSync(process.env.ZAAFPULSE_TLS_CERT), key: fs.readFileSync(process.env.ZAAFPULSE_TLS_KEY) }
    : null;
// The address apps use to reach the gateway (shown in snippets): ZAAFPULSE_PUBLIC_URL behind a proxy.
const BASE_URL = (
  process.env.ZAAFPULSE_PUBLIC_URL ||
  `${TLS ? 'https' : 'http'}://${!SERVER_MODE ? '127.0.0.1' : ['0.0.0.0', '::'].includes(HOST) ? os.hostname() : HOST}:${PORT}`
).replace(/\/+$/, '');
// Hosts the dashboard answers to (DNS-rebinding guard). Server mode accepts any host, since sign-in is
// required, unless ZAAFPULSE_ALLOWED_HOSTS lists them.
const ALLOWED_HOSTS = (process.env.ZAAFPULSE_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const RESCAN_MS = 60 * 1000;
// DEMO=1 serves seeded synthetic data (for screenshots) and never reads logs or writes config.
const DEMO = process.env.DEMO === '1';
const demo = DEMO ? require('./lib/demo') : null;

const { fullName, computerName } = platform;
const HOSTNAME = DEMO ? demo.config.host : computerName();
// Dashboard accounts (AI Governance 4): the owner's other people, in .data/users.json. None in demo mode.
const userStore = DEMO ? null : createUserStore({ file: path.join(DIR, '.data', 'users.json') });
let auth;
try {
  auth = createAuth({
    dataDir: DIR,
    host: HOST,
    demo: DEMO,
    headers: () => SECURITY_HEADERS,
    onEvent: (e) => govRecord(e), // sign-ins and sign-outs for the governance audit log
    accounts: userStore,
    ownerName: () => config.userName,
  });
} catch (err) {
  console.error(err.message);
  process.exit(78);
}
// Browser pages from other sites the dashboard and gateway answer (comma list, or "*"); same-site always.
const ALLOWED_ORIGINS = (process.env.ZAAFPULSE_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().toLowerCase().replace(/\/+$/, ''))
  .filter(Boolean);
if (auth.required && !auth.configured() && !DEMO) {
  console.error(
    `ZAAFPulse listens on ${HOST}, so the dashboard needs a password first.\nRun \`zaafpulse set-password\` (or set ZAAFPULSE_ADMIN_PASSWORD), then start again.`,
  );
  process.exit(78);
}

// Live model prices (OpenRouter's public list). onChange runs after a refresh, once the server is up.
const priceSync = createPriceSync({
  cacheFile: path.join(DIR, '.cache', 'prices.json'),
  onChange: () => {
    config = loadConfig();
    memo.clear();
    insightMemo.clear();
  },
});

function loadConfig() {
  let c = {};
  if (DEMO) c = { userName: demo.config.userName, monthlyBudgetUSD: demo.config.monthlyBudgetUSD };
  else
    try {
      c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      /* defaults */
    }
  return {
    userName: c.userName || fullName(),
    monthlyBudgetUSD: Number.isFinite(c.monthlyBudgetUSD) ? c.monthlyBudgetUSD : 0,
    ...(() => {
      // config.json keeps only your own prices; live and default prices are merged in at runtime.
      const manualPricing = c.pricing && typeof c.pricing === 'object' ? c.pricing : {};
      const pricingSync = {
        enabled: !(c.pricingSync && c.pricingSync.enabled === false),
        pinned: Array.isArray(c.pricingSync?.pinned) ? c.pricingSync.pinned.filter((k) => typeof k === 'string') : [],
      };
      const eff = priceSync.effective(DEFAULT_PRICING, manualPricing, pricingSync); // demo uses the cached public list too, but never fetches
      return { pricing: eff.pricing, pricingSource: eff.source, manualPricing, pricingSync };
    })(),
    vaultPaths: Array.isArray(c.vaultPaths) ? c.vaultPaths.filter((p) => typeof p === 'string') : [],
    integrations:
      c.integrations && typeof c.integrations === 'object' && !Array.isArray(c.integrations) ? c.integrations : {},
  };
}
let config = loadConfig();

const indexer = DEMO
  ? {
      version: 1,
      state: { indexing: false, total: 0, done: 0, lastScan: Date.now(), lastDurationMs: 0, errors: 0 },
      results: () => demo.buildResults(),
      refresh: async () => {},
    }
  : new Indexer([require('./lib/claude'), require('./lib/codex')], path.join(DIR, '.cache', 'index.json'));
// The folders the logs are read from (also the only ones the trace explorer may read text from), as the owner's
// dashboard shows them: ~ paths, whether each exists, and how many files the indexer holds from it.
const LOG_ROOTS = { claude: require('./lib/claude').ROOTS, codex: require('./lib/codex').ROOTS };
const LOG_ROOT_INFO = { claude: require('./lib/claude').rootInfo(), codex: require('./lib/codex').rootInfo() };
const logRoots = () => describeRoots(LOG_ROOT_INFO, indexer.files, os.homedir());
const memo = new Map();

// Integrations are rebuilt whenever config.json changes on disk (they are edited in the file).
const audit = createAudit(path.join(DIR, '.cache', 'mcp-audit.jsonl'));
let integ = { mtimeMs: -1, registry: null };
function getIntegrations() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    /* no config yet */
  }
  if (!integ.registry || integ.mtimeMs !== mtimeMs) {
    config = loadConfig(); // also on the first build: config.json may have been edited since startup
    const local = createLocal({
      cacheDir: path.join(DIR, '.cache'),
      config,
      indexer,
      // These tools also answer gateway API keys on /mcp: no transcript-derived title may leave there.
      contentOff: true,
      dataDir: DIR,
      demo: DEMO, // the demo trace sessions only: the stand-in indexer has no entries, and HOME is not read
    });
    const registry = createIntegrations({ config, secrets: createSecrets(), audit, local });
    local.integrationsStatus = () => registry.status();
    integ = { mtimeMs, registry };
  }
  return integ.registry;
}
const integrationConfig = createIntegrationConfig({
  file: CONFIG_FILE,
  secrets: createSecrets(),
  onChange: (before, after) => configChanged(before, after),
});
// Agent Gateway: OpenAI-compatible /v1 API, agents, orchestrator and MCP over HTTP, behind ZAAFPulse
// API keys. Provider settings live in config.json under "gateway"; keys, agents, sessions and memory
// in .data/ (demo mode uses a throwaway folder so it never touches your data).
// DEMO=1 keeps everything in a throwaway folder: gateway data, second-brain files and the code-tool home.
const demoDir = DEMO ? fs.mkdtempSync(path.join(os.tmpdir(), 'zp-demo-')) : null;
const demoGw = DEMO ? require('./lib/demo-gateway') : null;
let demoReady = !DEMO;
// Governance audit log (AI Governance 2, lib/governance): every change a person or an API key makes, with its actor and
// outcome, in .data/audit (demo: the throwaway folder), chained with acc.audit-chain from the secret store (demo: a
// key file, so demo mode never touches the store).
const govDir = path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'audit');
const governance = createGovernanceAudit({
  dir: govDir,
  now: Date.now,
  getKey: keySource({ dir: govDir, store: DEMO ? null : require('./lib/secret-store').defaultStore(), now: Date.now }),
});
// An id from a request body as it may be kept in an entry (lib/governance/events.js keeps the same shape).
const GOV_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
// An entry's actor: the one it names, else the request's (lib/governance/context.js), else the server's own.
// Never throws (A6): whatever calls it goes ahead.
function govRecord(entry) {
  try {
    return governance.record({ ...entry, actor: entry.actor || govContext.actor() || { via: 'system' } });
  } catch {
    return null;
  }
}
// Every config.json write, from either writer (saveConfigSections below, lib/integration-config.js), is one
// config.change entry with its field-level changes, secrets masked (lib/governance/diff.js). A write that changed
// nothing is no entry.
function configChanged(before, after) {
  try {
    const d = govDiff(before, after);
    if (!d.changes.length) return;
    govRecord({
      action: 'config.change',
      target: { type: 'config', id: d.sections.join(',').slice(0, 80) },
      changes: d.changes,
      ...(d.truncated ? { truncated: d.truncated } : {}),
    });
  } catch {
    /* the save stands; an audit bug never fails it (A6) */
  }
}
// /api/governance/*: the entries, an export, verify, status, and the retention in config.json "governance.audit"; the
// AI inventory (AI Governance 3) from inventorySources() below, its reviews in "governance.inventory" and the days each
// item was first and last seen in .data/governance/seen.json (demo: the throwaway folder).
const governanceApi = createGovernanceApi({
  audit: governance,
  settings: { get: () => rawConfig().governance, save: (g) => saveConfigSection('governance', g) },
  sources: () => inventorySources(),
  controlState: () => controlState(),
  record: (e) => govRecord(e), // the evidence export (a GET), with the request's actor
  version: require('./package.json').version,
  seen: createSeenStore({ file: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'governance', 'seen.json') }),
});
// /api/users (the owner's), /api/users/names and /api/account/password (AI Governance 4); each change is a governance
// entry with the request's actor.
const usersApi = createUsersApi({
  store: userStore,
  auth,
  record: (e) => govRecord(e),
  ownerName: () => config.userName,
});
let rawCache = {
  mtime: -1,
  value: DEMO ? { gateway: demoGw.CONFIG, brain: { sources: demoGw.BRAIN_SOURCES(path.join(demoDir, 'brain')) } } : {},
};
function rawConfig() {
  if (DEMO) return rawCache.value;
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    /* none yet */
  }
  if (mtime !== rawCache.mtime) {
    try {
      rawCache = { mtime, value: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch {
      rawCache = { mtime, value: {} };
    }
  }
  return rawCache.value;
}
// The one writer of config.json for the settings pages (gateway, evals, datasets, monitors, brain, local runtimes):
// one top-level section is replaced and the cache is refreshed from what was written. Demo mode keeps it in memory.
// config.json is read again here, not from the cache: rawConfig() reads a file that does not parse as {}, and saving
// on top of that would drop every other section. Such a file (often a hand edit gone wrong) is refused and left as it
// is, with a status-409 error (CONFIG_BROKEN: fix the file first). The write goes through a temp file of its own (two
// saves never share one) at mode 0600, then a rename; a failure there throws a status-500 error. No message holds a
// path, so each API can pass it on. saveConfigSections(patch) replaces several top-level sections in one write.
const CONFIG_UNSAVED = 'the settings could not be saved';
const CONFIG_BROKEN = 'config.json could not be read; fix it first';
function saveConfigSections(patch) {
  if (DEMO) {
    const before = rawCache.value;
    rawCache.value = { ...rawCache.value, ...patch };
    configChanged(before, rawCache.value);
    return;
  }
  const refuse = (message, err, status = 500) => {
    console.error(`config: ${message}${err && err.code ? ` (${err.code})` : ''}`);
    return Object.assign(new Error(message), { status });
  };
  let text = '';
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw refuse(CONFIG_UNSAVED, e);
  }
  let base = {};
  try {
    base = text.trim() ? JSON.parse(text) : {};
  } catch {
    base = null;
  }
  if (!base || typeof base !== 'object' || Array.isArray(base))
    throw refuse(CONFIG_BROKEN, null, 409);
  const raw = { ...base, ...patch };
  const tmpFile = `${CONFIG_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpFile, CONFIG_FILE);
  } catch (e) {
    fs.rmSync(tmpFile, { force: true });
    throw refuse(CONFIG_UNSAVED, e);
  }
  configChanged(base, raw);
  try {
    rawCache = { mtime: fs.statSync(CONFIG_FILE).mtimeMs, value: raw };
  } catch {
    rawCache = { mtime: 0, value: raw }; // saved; the next read checks the file again
  }
}
// config.json is there but does not read as an object (often a hand edit gone wrong). A save over it would drop every
// other section (the budgets, the cost centers), so Settings and the price editor refuse with 409 until it is fixed.
function configBroken() {
  let text = '';
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    return e.code !== 'ENOENT';
  }
  if (!text.trim()) return false;
  try {
    const v = JSON.parse(text);
    return !v || typeof v !== 'object' || Array.isArray(v);
  } catch {
    return true;
  }
}
// One section, for every settings page. A budget save writes two top-level fields at once (budget-service.js).
function saveConfigSection(name, value) {
  return saveConfigSections({ [name]: value });
}
// The cost section for the ledger, or false when config.json is there but does not parse as an object. rawConfig()
// reads such a file as {} for every other caller; the ledger must not take that for "no cost settings", or it would
// date every plan source as metered and move today's rows to unassigned (settingsOf(false) makes the pass wait).
function costSettings() {
  const raw = rawConfig();
  if (DEMO) return raw.cost;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (Object.keys(raw).length) return raw.cost;
  // {} is also what a missing, empty or unparsable file reads as: the file itself tells them apart.
  let text = '';
  try {
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? undefined : false;
  }
  if (!text.trim()) return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v.cost : false;
  } catch {
    return false;
  }
}
// Local trace store: every gateway trace without content, under .data/traces (on unless "tracing": { "enabled":
// false }). Retention is read at start; the on/off switch whenever config.json changes.
const tracingCfg = () => (rawConfig() || {}).tracing || {};
// A store that cannot open (unwritable or corrupt folder) never takes the server down: tracing is just off. The
// retention in force is kept for the Compliance page (GET /api/governance/controls).
const TRACE_RETENTION = {
  days: Number(tracingCfg().retentionDays) > 0 ? Number(tracingCfg().retentionDays) : 14,
  maxBytes: Number(tracingCfg().maxBytes) > 0 ? Number(tracingCfg().maxBytes) : 500 * 1024 * 1024,
};
let traceStore = null;
try {
  traceStore = createTraceStore({
    dir: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'traces'),
    retentionDays: TRACE_RETENTION.days,
    maxBytes: TRACE_RETENTION.maxBytes,
  });
} catch (err) {
  console.error('traces: the local trace store is off:', err.message);
}
// The on/off answer is asked several times per span: re-read config.json at most every 2 seconds.
let tracingOnAt = 0;
let tracingOnValue = true;
const tracingOn = () => {
  const now = Date.now();
  if (now - tracingOnAt >= 2000) {
    tracingOnAt = now;
    // false or "false" (a hand-edited config.json) turns it off.
    tracingOnValue = String(tracingCfg().enabled) !== 'false';
  }
  return tracingOnValue;
};
const recorder = traceStore
  ? createRecorder({ store: traceStore, enabled: tracingOn })
  : createRecorder({ store: { writeSpans: () => 0 }, enabled: () => false });
// Our own OTLP export pointed back here is refused by its service name: the one export uses (otel.serviceName,
// OTEL_SERVICE_NAME), else the configured name, else zaafpulse.
const traceReceiver = createReceiver({
  recorder,
  serviceName: () => otel.status().serviceName || ((rawConfig() || {}).otel || {}).serviceName || 'zaafpulse',
});
// OpenTelemetry trace export: off unless config.json has "otel": { "enabled": true } (see docs/otel.md). The local
// store is its second sink.
otel.init({
  getConfig: rawConfig,
  secrets: createSecrets(),
  version: require('./package.json').version,
  sink: recorder,
});
const gatewaySecret = secretResolver({ store: DEMO ? () => {} : keychainStore });
// Cost Control budgets: the gateway asks the guard before each request and reports each call to the budget service.
// Both are made with the ledger below, after the gateway; until then (startup, before the server listens) nothing is
// refused.
let costBudgets = null;
let costGuard = null;
const budgetGuard = {
  check: (ctx) => (costGuard ? costGuard.check(ctx) : null),
  keyLimited: (keyId) => !!costGuard && costGuard.keyLimited(keyId),
  record: (entry) => costBudgets && costBudgets.record(entry),
  failed: () => costGuard && costGuard.failed(),
};
const gateway = createGateway({
  dataDir: DEMO ? demoDir : path.join(DIR, '.data'),
  ...(DEMO ? { fetchImpl: demoGw.createDemoFetch(), toolsHome: demoDir } : {}),
  getConfig: rawConfig,
  writeGatewayConfig: (g) => saveConfigSection('gateway', g),
  secrets: createSecrets(),
  // Provider keys go to the Keychain as acc.gw-<provider id>, apart from integration keys.
  resolveSecret: (id, input, current) =>
    gatewaySecret(`gw-${id}`, { key: 'apiKey', label: 'API key', required: false }, input, current),
  getPricing: () => config.pricing,
  getIntegrations: () => getIntegrations(),
  version: require('./package.json').version,
  baseUrl: BASE_URL,
  // Agent card and /skills advertise the address a client used, with the scheme it really has.
  publicUrl: process.env.ZAAFPULSE_PUBLIC_URL || '',
  trustProxy: process.env.ZAAFPULSE_TRUST_PROXY === '1',
  budgetGuard,
  audit: (e) => govRecord(e), // key changes, run approvals and cancels
});

// Trace explorer: every log source behind opaque keys and ids. Content (prompts, replies, tool output) is off
// when asked for, and by default in server mode, where other people may sign in. Demo reads no real files.
// Text is read only from the agent log folders; the data folder (keys, config) is never a root.
const contentOff = contentDefaultOff(process.env, SERVER_MODE);
const trace = createTrace({
  demo: DEMO,
  contentOff,
  pricing: () => config.pricing, // the owner's prices, as for the dashboard's totals (config reloads)
  ...(DEMO
    ? {}
    : {
        indexer,
        gateway,
        traceStore,
        roots: [...LOG_ROOTS.claude, ...LOG_ROOTS.codex],
      }),
});

// Cost ledger (Cost Control 1): daily cost rows from every source in .data/cost/, priced with the version of their day
// and attributed to cost centers (config.json "cost"). Demo: a synthetic ledger in memory; no files, no passes.
const costDemo = DEMO ? demo.costDemo() : null;
if (DEMO)
  rawCache.value = { ...rawCache.value, cost: costDemo.settings, monthlyBudgetUSD: demo.config.monthlyBudgetUSD };
const cost = createCost({
  dir: DEMO ? null : path.join(DIR, '.data', 'cost'),
  gatewayLog: DEMO ? null : path.join(DIR, '.data', 'gateway-usage.jsonl'),
  entries: () => (typeof indexer.entries === 'function' ? indexer.entries() : []),
  getPricing: () => config.pricing,
  getSettings: costSettings, // false while config.json does not parse
  // A model on the owner's own hardware costs nothing, as for the gateway's key budgets.
  isPrivate: (id) => {
    const p = gateway.providers.list().find((x) => x.id === id);
    return !!p && gateway.providers.tierOf(p) === 'private';
  },
  home: os.homedir(),
  demo: costDemo,
});
// Budgets (Cost Control 2): config.json "cost.budgets" plus the old monthlyBudgetUSD and key budgets read as budgets.
// The service reads the same settings as the ledger (costSettings), so both see one view of config.json.
costBudgets = createBudgetService({
  getSettings: costSettings,
  getLegacy: () => ({ monthlyBudgetUSD: rawConfig().monthlyBudgetUSD, keys: gateway.keys.list() }),
  cost,
  home: os.homedir(),
  demo: costDemo ? { noData: costDemo.budgetNoData } : null,
  // The last valid list, kept across restarts (the demo keeps nothing on disk).
  lastFile: DEMO ? null : path.join(DIR, '.data', 'cost', 'budgets.last.json'),
});
costGuard = createGuard({ service: costBudgets });
// A budget save: the list into config.json "cost", and the old setting it replaces cleared in the same write
// (monthlyBudgetUSD) or right after it (a key's budgetUSD, in keys.json). A saved budget wins over the old setting of
// its id, so a crash between the two writes never counts a budget twice.
function saveBudgets(list, { clearMonthly = false, clearKey = null } = {}) {
  const raw = rawConfig();
  const c = raw && raw.cost && typeof raw.cost === 'object' && !Array.isArray(raw.cost) ? raw.cost : {};
  saveConfigSections({ cost: { ...c, budgets: list }, ...(clearMonthly ? { monthlyBudgetUSD: 0 } : {}) });
  if (clearMonthly && !DEMO) config = loadConfig();
  if (clearKey) gateway.keys.update(clearKey, { budgetUSD: null });
}
// A pause budget needs agent control, as an auto-pause rule does (lib/monitors/api.js): off in server mode, with a
// password or no sign-in, and in Docker.
const budgetPauseOff = () =>
  AGENTS_OFF === 'no-sign-in'
    ? 'agent control is off without a dashboard sign-in'
    : AGENTS_OFF
      ? 'agent control is off on this server'
      : !DEMO && detectDocker()
        ? 'agent control is off in Docker'
        : null;
// After any change the budgets read: a fresh ledger read and a budget pass, so an alert or a lifted block is current.
const budgetsChanged = () => {
  costBudgets.invalidate();
  monitors.tickBudgets().catch(() => {});
};
// Tool-call accuracy per model for the Cost Control Value page: one scan of the signals per index version and range,
// so a refresh does not rescan them (a handful of ranges are in use at a time).
const accuracyMemo = { version: null, ranges: new Map() };
function costAccuracy({ from, to }) {
  if (accuracyMemo.version !== indexer.version) {
    accuracyMemo.version = indexer.version;
    accuracyMemo.ranges.clear();
  }
  const key = `${from}|${to}`;
  if (!accuracyMemo.ranges.has(key)) {
    if (accuracyMemo.ranges.size >= 8) accuracyMemo.ranges.clear();
    accuracyMemo.ranges.set(key, accuracyByModel(indexer.results(), { from, to }));
  }
  return accuracyMemo.ranges.get(key);
}
const costApi = createCostApi({
  cost,
  settings: { get: costSettings, save: (value) => saveConfigSection('cost', value) },
  listKeys: () => gateway.keys.list(),
  home: os.homedir(),
  budgets: costBudgets,
  budgetStore: { save: saveBudgets },
  pauseOff: budgetPauseOff,
  onChange: () => budgetsChanged(),
  accuracy: costAccuracy,
  // The experiment store is made below; this runs only on a request, after it is.
  passRates: (range) => costPassRates(experiments.list(), range),
  experiments: () => experiments.list(),
  // The cost_anomaly rule's saved parameters, from the store the Monitors page shows (the demo's own), made below.
  anomalyParams: () => monitorApiState.settings('cost_anomaly').params,
});

// Local evals: judge models read the masked text of finished turns, one queue, local first.
// Settings live in config.json under "evals" (stored values only; defaults are filled in when read), results and
// feedback in .data/. Demo keeps all of it in the throwaway folder and in memory.
const evalDir = DEMO ? demoDir : path.join(DIR, '.data');
const evalDemo = DEMO ? demo.evalsDemo() : null;
const evalFeedback = createFeedbackStore({ file: path.join(evalDir, 'feedback.jsonl') });
if (DEMO)
  for (const f of evalDemo.feedback)
    evalFeedback.set({
      target: { source: f.source, session: f.session, turn: f.turn, span: null },
      rating: f.rating,
      note: f.note,
    });
// Datasets and experiment records: before the engine, whose judge results can feed auto-add (wired below).
const datasets = createDatasetStore({ dir: path.join(evalDir, 'datasets') });
const experiments = createExperimentStore({ file: path.join(evalDir, 'experiments.jsonl') });
// One finder for the Claude Code CLI, shared by the judge and the settings page (which says whether it was found).
const claudeCli = createClaude(DEMO ? { env: { ZAAFPULSE_CLAUDE_BIN: path.join(demoDir, 'no-claude') } } : {});
const evalEngine = createEvalEngine({
  trace,
  indexer,
  models: createModels({
    settings: () => evalApi.settings(),
    gateway,
    claude: claudeCli,
    ...(DEMO ? { fetchImpl: () => Promise.reject(new Error('demo mode makes no calls')) } : {}),
  }),
  store: createEvalStore({ file: path.join(evalDir, 'evals.jsonl') }),
  feedback: evalFeedback,
  settings: () => evalApi.settings(),
  stateFile: path.join(evalDir, 'evals-state.json'),
  log: (m) => console.error(m),
  demo: DEMO,
  demoData: evalDemo || {},
  onResult: (r) => datasetAuto.onResult(r),
  onCall: (c) => cost.recordJudge(c), // judge calls that skip the gateway, for the cost ledger
});
const evalApi = createEvalApi({
  trace,
  engine: evalEngine,
  feedback: evalFeedback,
  gateway,
  contentOff,
  claude: claudeCli,
  settings: {
    get: () => rawConfig().evals,
    save: (evals) => saveConfigSection('evals', evals),
  },
  onFeedback: (f) => datasetAuto.onFeedback(f),
});
// A judging pass after each index refresh. It is only queued here: a failure must not break the refresh.
const evalTick = () =>
  Promise.resolve()
    .then(() => evalEngine.tick())
    .catch(() => console.error('evals: the judging pass failed'));

// Datasets of saved turns, text-only replay against gateway models, and experiments. Settings live in config.json
// under "datasets" (demo: in memory). Replay goes through the gateway; judge calls share the eval engine's lane.
const datasetApi = createDatasetApi({
  datasets,
  experiments,
  runner: createReplayRunner({
    replay: gateway.replay,
    judge: (id, m, o) => evalEngine.judgeMaterial(id, m, o),
  }),
  replay: gateway.replay,
  trace,
  contentOff,
  settings: {
    get: () => rawConfig().datasets,
    save: (next) => saveConfigSection('datasets', next),
  },
});
const datasetAuto = createAutoAdd({
  datasets,
  trace,
  settings: () => datasetApi.settings().autoAdd,
  contentOff,
  log: (m) => console.error(m),
});
// Demo: synthetic datasets and experiment records in the throwaway folder (the store masks the fake key).
if (DEMO) {
  const seed = demo.datasetsDemo();
  for (const d of seed.datasets) {
    datasets.create({ name: d.name, slug: d.slug });
    datasets.add(d.slug, d.examples, { strict: true });
  }
  for (const r of seed.experiments) experiments.append(r);
}

// Monitors: rules on the aggregate data after each index refresh and on the live office every 5 s, alerts to the
// desktop and an optional webhook, and an automatic pause where the owner turned it on. States, settings and alerts
// live in .data/ (demo: the throwaway folder). Channel settings are config.json "monitors.channels":
// { desktop, webhook: { url, headers? } }, where the URL and the headers are secret references only (lib/secrets.js);
// they are read on every send. ZAAFPULSE_NOTIFY=off sends nothing (the tests set it), and demo mode never notifies
// or signals.
const monitorDir = DEMO ? demoDir : path.join(DIR, '.data');
const monitorState = createMonitorState({
  file: path.join(monitorDir, 'monitors.json'),
  alertsFile: path.join(monitorDir, 'alerts.jsonl'),
  config: () => config,
});
const NOTIFY_OFF = process.env.ZAAFPULSE_NOTIFY === 'off';
const monitorDemo = DEMO ? demo.monitorsDemo() : null;
if (DEMO) rawCache.value = { ...rawCache.value, monitors: { channels: monitorDemo.channels } };
// The stored channel settings. A webhook whose URL or headers are not a secret reference (a plain URL typed into
// config.json) is not used, and the settings page says why.
function channelConfig() {
  const m = rawConfig().monitors;
  const ch = m && typeof m === 'object' && m.channels && typeof m.channels === 'object' ? m.channels : {};
  const w = ch.webhook && typeof ch.webhook === 'object' ? ch.webhook : null;
  const ok = !!w && isRef(w.url) && (w.headers == null || isRef(w.headers));
  return {
    desktop: ch.desktop !== false,
    webhook: ok ? { url: w.url, ...(w.headers != null ? { headers: w.headers } : {}) } : null,
    problem: w && !ok ? 'the webhook in config.json must use secret references' : null,
  };
}
const monitorChannels = createChannels({
  secrets: createSecrets(),
  settings: () => {
    if (DEMO || NOTIFY_OFF) return { desktop: false, webhook: null };
    const c = channelConfig();
    return { desktop: c.desktop, webhook: c.webhook };
  },
  log: (m) => console.error(m),
});
// Agent control is for the owner at this machine: off in server mode, and whenever the dashboard signs in with a
// password (a proxy, a public URL or ZAAFPULSE_AUTH=1), since other people may reach it then. So password mode counts
// as server mode here: the rules then never pause an agent (the settings refuse auto-pause, the listing hides it).
// Control also needs a dashboard sign-in, so ZAAFPULSE_AUTH=none turns it off too, except in demo (which never signals).
const AGENTS_OFF =
  SERVER_MODE || auth.mode === 'password' ? 'server' : auth.mode === 'none' && !DEMO ? 'no-sign-in' : false;
// Agent and runtime control keep their own log (agent-audit.jsonl); each line is also a governance entry (A4(5)).
function controlAudit(dir) {
  const log = createAudit(path.join(dir, 'agent-audit.jsonl'));
  return {
    record(line) {
      log.record(line);
      try {
        const e = controlEntry(line);
        if (e) govRecord(e);
      } catch {
        /* the control line is written; an audit bug never fails the action (A6) */
      }
    },
  };
}
const agentControl = createAgentControl({
  dataDir: monitorDir,
  serverMode: AGENTS_OFF,
  log: (m) => console.error(m),
  audit: controlAudit(monitorDir),
});
// daily_cost and month_projection became budgets (legacy-monthly): they are not evaluated, listed or changed, so
// nothing alerts twice.
const RETIRED_RULES = ['daily_cost', 'month_projection'];
const monitors = createMonitors({
  indexer,
  office,
  evals: evalEngine,
  config: () => config,
  state: monitorState,
  channels: monitorChannels,
  control: agentControl,
  log: (m) => console.error(m),
  demo: DEMO,
  budgets: costBudgets,
  retired: RETIRED_RULES,
  home: os.homedir(),
  // cost_anomaly: today so far and yesterday from the ledger as billed, each against the 4 weeks before it (the demo
  // ledger in demo mode, where nothing is sent), its known days from the ledger's first day as the budgets and the
  // Overview count them.
  costAnomaly: (t) => {
    const today = costDayOf(t);
    const r = cost.budgetRows({ from: costAddDays(today, -ANOMALY_HISTORY_DAYS), to: today });
    return recentDays(r.rows, { today, unread: r.unread, since: cost.firstDay() });
  },
  // guardrail_block: the gateway requests the guardrails blocked, as times and check names (no label, no text).
  guardBlocks: () =>
    gateway.usage
      .recent(2000)
      .filter((e) => e.guard && e.guard.action === 'blocked')
      .map((e) => ({ ts: e.ts, checks: [...new Set((e.guard.hits || []).map((h) => h.check))] })),
  // audit_degraded and audit_chain_broken: the governance audit log's state and its last verify (no entry content).
  auditStatus: () => governance.status(),
  // inventory_unreviewed: the AI inventory's last counts (new unreviewed items and their kinds; no names).
  inventoryStatus: () => governanceApi.inventoryStatus(),
});
// The routes: rules, channels, alerts and agent control. Demo serves a seeded store of its own (mixed states, five
// alerts) so the page always has something to show; the engine keeps evaluating into its own file.
let monitorApiState = monitorState;
if (DEMO) {
  const dir = path.join(demoDir, 'monitors-demo');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'monitors.json'), JSON.stringify(monitorDemo.file), { mode: 0o600 });
  const lines = monitorDemo.alerts.map((a) => `${JSON.stringify(a)}\n`).join('');
  fs.writeFileSync(path.join(dir, 'alerts.jsonl'), lines, { mode: 0o600 });
  monitorApiState = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    config: () => config,
  });
}
// A session's working folder and first line, from the index (what candidates() matches on), per index version.
let sessionMemo = { version: -1, map: new Map() };
function sessionInfo(source, sid) {
  if (sessionMemo.version !== indexer.version) {
    let map = new Map();
    try {
      map = require('./lib/aggregate').mergeSessions(indexer.results());
    } catch {
      /* no index yet */
    }
    sessionMemo = { version: indexer.version, map };
  }
  const s = sessionMemo.map.get(`${source}:${sid}`);
  return s && typeof s.project === 'string' ? { cwd: s.project, first: s.first } : null;
}
// Webhook secrets saved from the dashboard go to the secret store as acc.monitors-webhook-url and -headers.
const monitorSecret = secretResolver({
  store: DEMO
    ? () => {}
    : (service, value) => {
        try {
          keychainStore(service, value);
        } catch {
          throw Object.assign(new Error('the secret could not be saved in the secret store'), { status: 500 });
        }
      },
});
const monitorApi = createMonitorApi({
  state: monitorApiState,
  monitors,
  channels: monitorChannels,
  control: agentControl,
  trace,
  sessionInfo,
  channelSettings: {
    get: channelConfig,
    save: ({ desktop, webhook }) => {
      const m = rawConfig().monitors;
      saveConfigSection('monitors', {
        ...(m && typeof m === 'object' ? m : {}),
        channels: { desktop, ...(webhook ? { webhook } : {}) },
      });
    },
  },
  resolveSecret: (field, input, current) =>
    monitorSecret('monitors-webhook', { key: field, label: `webhook ${field}`, required: false }, input, current),
  checkUrl: checkWebhookUrl,
  checkHeaders: parseHeaders,
  demo: DEMO ? { candidates: monitorDemo.candidates, paused: monitorDemo.paused } : null,
  agentsOff: AGENTS_OFF,
  notifyOff: NOTIFY_OFF,
  home: os.homedir(),
  retired: RETIRED_RULES,
});
// Local model servers (lib/runtimes): Start and Stop on the AI Office cards, and the owner's own runtimes in
// config.json "localRuntimes" (Settings → Local models). Off wherever agent control is off (server mode, password
// sign-in, no sign-in outside demo) and in Docker. Demo mode answers from synthetic runtimes and starts nothing.
const runtimeDir = DEMO ? demoDir : path.join(DIR, '.data');
const runtimeEntries = () => runtimeRegistry.entries(rawConfig().localRuntimes);
const runtimeStarted = jsonFile(path.join(runtimeDir, 'runtimes', 'started.json'));
const runtimeState = createRuntimeState({ entries: runtimeEntries, started: runtimeStarted });
// The models Ollama and LM Studio last had loaded, loaded again after a Start. Its audit line is written by the
// control module (`reloaded`), which exists by the time a reload can end.
const runtimeModels = createModelMemory({
  file: jsonFile(path.join(runtimeDir, 'runtimes', 'models.json')),
  log: (m) => console.error(m),
  onDone: (id, r) => runtimeControl.reloaded(id, r),
});
const runtimeControl = createRuntimeControl({
  state: runtimeState,
  entries: runtimeEntries,
  dataDir: runtimeDir,
  audit: controlAudit(runtimeDir),
  started: runtimeStarted,
  // The agents' rule: a runtime start runs a command, so it needs a sign-in just as pausing an agent does.
  serverMode: AGENTS_OFF,
  models: runtimeModels,
  log: (m) => console.error(m),
});
// Every 30 s while runtime control is on, the models each running Ollama and LM Studio has loaded are read and
// remembered. It only reads: it starts, stops and loads nothing. One pass at a time; a pass never throws.
let runtimeObserving = false;
const observeRuntimeModels = async () => {
  if (runtimeObserving) return;
  runtimeObserving = true;
  try {
    for (const x of await runtimeState.list()) {
      if (!x.running || !runtimeModels.supports(x.entry.id)) continue;
      try {
        await runtimeModels.observe(x);
      } catch {
        console.error(`runtimes: the loaded models of ${x.entry.id} could not be read`);
      }
    }
  } catch {
    console.error('runtimes: the model pass failed');
  } finally {
    runtimeObserving = false;
  }
};
const runtimeApi = createRuntimeApi({
  control: runtimeControl,
  config: {
    list: () => rawConfig().localRuntimes,
    save: (list) => saveConfigSection('localRuntimes', list),
  },
  demo: DEMO ? demo.runtimesDemo() : null,
  home: os.homedir(),
});
// Each pass catches its own failures; this catch is the last line, so a pass can never break a refresh.
const monitorTick = () =>
  Promise.resolve()
    .then(() => monitors.tickAggregate())
    .catch(() => console.error('monitors: the aggregate pass failed'));
// The aggregate pass has to run on the refreshed index: each call waits for the refresh to end (lib/monitors).
const monitorTickAfterIndex = createAfterRefresh({ indexing: () => indexer.state.indexing, run: monitorTick });
// The weekly cost digest (Cost Control 5): after a ledger pass, last week's figures once, through the Monitors
// channels (never in demo mode; the channels are off with ZAAFPULSE_NOTIFY=off). Off unless config.json
// "cost.digest.enabled".
const costDigest = createDigest({
  file: DEMO ? null : path.join(DIR, '.data', 'cost', 'digest.json'),
  getSettings: costSettings,
  demo: DEMO,
  log: (m) => console.error(m),
  send: (d) => monitorChannels.digest(d),
  figures: digestSource({
    cost,
    getSettings: costSettings,
    budgets: () => costBudgets.evaluate(),
    anomalyParams: () => monitorApiState.settings('cost_anomaly').params,
    recommendations: () => costApi.recommendations(),
    home: os.homedir(),
  }),
});
// The cost ledger pass reads the refreshed index too; the budget service drops the gateway calls it read, then the
// budgets are evaluated (alerts, pause), then the digest is checked (not awaited: a webhook may take a while). A
// failure never breaks a refresh.
const costTick = () =>
  Promise.resolve()
    .then(() => costBudgets.pass(() => cost.update()))
    .then(() => monitors.tickBudgets())
    .then(() => void costDigest.check().catch(() => console.error('cost: the weekly digest check failed')))
    .catch(() => console.error('cost: the ledger pass failed'));
const costTickAfterIndex = createAfterRefresh({ indexing: () => indexer.state.indexing, run: costTick });

// Second brain sources: Obsidian by default, plus Logseq, Notion, Tana, Roam, mem.ai, Reflect, Heybrain,
// PARA folders, the RAG knowledge bases and vector databases. Settings in config.json under "brain";
// tokens in the Keychain as acc.brain-<id>.
const brain = createBrain({
  getConfig: rawConfig,
  writeBrainConfig: (b) => saveConfigSection('brain', b),
  secrets: createSecrets(),
  resolveSecret: (id, input, current) =>
    gatewaySecret(`brain-${id}`, { key: 'token', label: 'secret', required: false }, input, current),
  knowledge: gateway.knowledge,
  getVaultPaths: () => config.vaultPaths || [],
  ...(DEMO
    ? {
        demoGraph: (s) =>
          s.type === 'obsidian'
            ? demo.vault()
            : demoGw.VECTORS[s.id]
              ? require('./lib/brain/vectors').semanticGraph(s.name, demoGw.VECTORS[s.id]())
              : null,
      }
    : {}),
});
gateway.setBrain(brain);

// OpenRouter data for Models and Rankings. The key (for credits) comes from an enabled openrouter
// integration; demo mode serves whatever is cached and never fetches.
const openRouter = createOpenRouter({
  cacheDir: path.join(DIR, '.cache'),
  offline: DEMO,
  getKey: () => {
    const e = Object.values(config.integrations || {}).find(
      (c) => c && c.type === 'openrouter' && c.enabled !== false && c.apiKey,
    );
    if (!e) return null;
    try {
      return createSecrets().resolve(e.apiKey, 'apiKey');
    } catch {
      return null;
    }
  },
});
// MCP clients and whether our server is registered in each (demo mode never reads your client configs).
function clientRows() {
  return Object.entries(register.clients()).map(([id, c]) => ({
    id,
    name: c.name,
    file: c.file.replace(os.homedir(), '~'),
    registered: DEMO ? id !== 'kiro' : register.isRegistered(c.file),
    detected: DEMO || register.detected(c), // false: the app is not on this machine ("Not installed")
    command: `npm run mcp:register -- ${id}`,
  }));
}

// Raw config.json (with integrations) for the OmniRoute reader; DEMO never touches it.
const router = createOmniRoute(() => {
  if (DEMO) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
});
// GET /api/topology: the provider topology on the Overview, built from every source (lib/topology.js). Each source is
// capped at 2 s and a failure leaves it empty; the whole answer is reused for 5 s and the log read for 10 s.
const TOPO_TTL_MS = 5000;
const TOPO_SOURCE_MS = 2000;
const topoCache = { at: 0, value: null, pending: null };
const topoLogs = { at: 0, value: null };
async function topoSource(fn, empty = null) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), TOPO_SOURCE_MS))),
    ]);
  } catch (err) {
    return empty === null ? { error: err.message } : empty;
  } finally {
    clearTimeout(timer);
  }
}
async function buildTopologyNow() {
  const integrations = (rawConfig() || {}).integrations || {};
  const routerCfg = Object.entries(integrations).filter(([, c]) => c && c.type === 'router' && c.enabled !== false);
  const [live, logs, gw, runtimes] = await Promise.all([
    topoSource(() => processes.snapshot(), {}),
    topoSource(() => {
      if (!topoLogs.value || Date.now() - topoLogs.at > 10000) {
        topoLogs.value = reqlogs.logs();
        topoLogs.at = Date.now();
      }
      return topoLogs.value;
    }, {}),
    topoSource(() => readGateway(gateway), {}),
    topoSource(() => runtimeControl.list(), []),
  ]);
  // Only the connector OmniRoute's reader uses has a management API; other routers are drawn without health or calls.
  const active = router.id();
  const routers = await Promise.all(
    routerCfg.map(async ([id, c]) => {
      const flavor = c.flavor || 'omniroute';
      const base = { id, name: c.name || '', flavor };
      if (id !== active) return base;
      const [health, providers, calls] = await Promise.all([
        topoSource(() => router.health()),
        topoSource(() => router.providers()),
        topoSource(() => router.callLogs()),
      ]);
      return { ...base, health, providers, calls };
    }),
  );
  const routerOrigins = routerCfg.map(([id, c]) => ({ id, baseUrl: c.baseUrl || 'http://localhost:20128' }));
  const tools = readToolRoutes({ home: os.homedir(), env: process.env });
  const where = (origin) => routeOf(origin, { baseUrl: BASE_URL, routers: routerOrigins });
  return buildTopology({
    live,
    logs,
    gateway: gw,
    routers,
    runtimes,
    routes: { claude: where(tools.claude), codex: where(tools.codex) },
    appNames: Object.fromEntries(processes.APPS.map((a) => [a.id, a.name])),
  });
}
// One build at a time; callers inside the 5 s window get the last answer.
async function topology() {
  if (topoCache.value && Date.now() - topoCache.at < TOPO_TTL_MS) return topoCache.value;
  if (!topoCache.pending)
    topoCache.pending = buildTopologyNow()
      .then((v) => ((topoCache.value = v), (topoCache.at = Date.now()), v))
      .finally(() => (topoCache.pending = null));
  return topoCache.pending;
}
// The AI inventory's sources (lib/governance/inventory.js buildInventory): each one capped at 2 s, and null when it
// failed (the page names it). Only what an item shows is read: gateway agents by id, name, state and remote address,
// never a system prompt; keys by id, name and dates, never a secret. The MCP scan reads the AI clients' own config
// files (lib/governance/mcp-scan.js); demo mode never reads them.
const INV_FAILED = Symbol('failed');
const invSource = async (fn) => {
  const v = await topoSource(fn, INV_FAILED);
  return v === INV_FAILED ? null : v;
};
// An AI client's config file: its text, or null when it is not there. It is opened (without waiting on a pipe) and must
// be a regular file of at most 20 MB, so a FIFO or a huge file cannot hold up the page.
const CLIENT_FILE_MAX = 20 * 1024 * 1024;
function readClientFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > CLIENT_FILE_MAX) throw new Error('file too large');
    return fs.readFileSync(fd, 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
async function inventorySources() {
  const pick = (list, fields) =>
    (Array.isArray(list) ? list : []).map((x) => Object.fromEntries(fields.map((k) => [k, x && x[k]])));
  const [live, summary, traced, gw, runtimes, integrations, mcp] = await Promise.all([
    invSource(async () => {
      const s = DEMO ? demo.live() : await processes.snapshot();
      liveOrThrow(s);
      return {
        apps: pick(s.apps, ['id', 'name']),
        installed: s.installed,
        names: Object.fromEntries(processes.APPS.map((a) => [a.id, a.name])),
      };
    }),
    invSource(() => {
      indexReadyOrThrow(indexer.state);
      const s = getSummary(30);
      return {
        tools: pick(s.tools, ['id', 'name', 'lastActive']),
        toolUse: pick(s.toolUse, ['name']),
        models: pick(s.models, ['model']),
      };
    }),
    invSource(() => trace.sources()),
    invSource(() => {
      const g = (rawConfig() || {}).gateway || {};
      return {
        providers: pick(g.providers, ['id', 'preset', 'baseUrl', 'enabled']),
        models: Object.keys(gateway.usage.summary().byModel || {}),
        keys: pick(gateway.keys.list(), ['id', 'name', 'revokedAt', 'expiresAt', 'lastUsedAt']),
        agents: pick(gateway.agents.list(), ['id', 'name', 'enabled', 'remoteUrl']),
        skills: pick(gateway.skills.list(), ['name', 'claude', 'agents']),
        workflows: pick(gateway.workflows.list(), ['id', 'name']),
        knowledge: pick(gateway.knowledge.list(), ['id', 'name']),
      };
    }),
    invSource(async () => {
      return runtimesOrThrow(await runtimeApi.route({ method: 'GET', path: '/api/runtimes' }));
    }),
    invSource(() =>
      DEMO
        ? demo.integrations().integrations.filter((i) => i.type !== 'acc')
        : Object.entries((rawConfig() || {}).integrations || {}).map(([id, c]) => ({
            id,
            type: c && c.type,
            flavor: c && c.flavor,
            enabled: !(c && c.enabled === false),
            url: c && (c.url || c.baseUrl),
          })),
    ),
    invSource(() =>
      DEMO
        ? []
        : mcpScan.scanClients({
            home: os.homedir(),
            env: process.env,
            platform: process.platform,
            read: readClientFile,
          }),
    ),
  ]);
  return { live, summary, trace: traced, gateway: gw, runtimes, integrations, mcp };
}
// The state the controls of the Compliance page are worked out from (lib/governance/controls.js): settings, counts and
// dates only. Each part is capped at 2 s and null when it could not be read. The OpenTelemetry export is named by its
// endpoint's origin, never its headers.
async function controlState() {
  const gw = () => (rawConfig() || {}).gateway || {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const parts = {
    guardrails: () => guardPolicy(gw().guardrails),
    usage: () => {
      const o = gateway.usage.oldest();
      return { requests: gateway.usage.summary().totals.requests, oldest: o.ts, rotated: o.rotated };
    },
    providers: () =>
      list(gw().providers).map((p) => ({
        id: p.id,
        tier: gateway.providers.tierOf(p),
        approved: p.approved !== false,
        recorded: typeof p.approved === 'boolean',
        enabled: p.enabled !== false,
      })),
    keys: () =>
      gateway.keys.list().map((k) => ({
        revokedAt: k.revokedAt,
        expiresAt: k.expiresAt,
        budgetUSD: k.budgetUSD,
        scopes: k.scopes,
        // The mode words a key sets, nothing else.
        guardrails: Object.fromEntries(
          Object.entries(k.guardrails || {}).filter(
            ([c, m]) => ['secrets', 'pii', 'injection'].includes(c) && typeof m === 'string',
          ),
        ),
      })),
    workflows: () =>
      gateway.workflows.list().map((w) => ({ tier: w.tier, gated: list(w.steps).some((x) => x && x.approve) })),
    agentControl: () => ({ off: agentControl.off() }),
    monitors: () =>
      MONITOR_RULES.filter((r) => !RETIRED_RULES.includes(r.id)).map((r) => ({
        id: r.id,
        enabled: monitorApiState.settings(r.id).enabled,
      })),
    evals: async () => {
      const cfg = evalApi.settings();
      const st = await evalEngine.status();
      const on = Object.values(cfg.evaluators || {});
      return {
        judge: cfg.judge !== false,
        evaluators: on.filter(Boolean).length,
        total: on.length,
        ok: !!(st && st.judge && st.judge.ok),
        model: (st && st.judge && st.judge.model) || null,
        today: (st && st.today && st.today.count) || 0,
        paused: typeof (st && st.paused) === 'string' ? st.paused : null,
      };
    },
    datasets: () => ({
      count: datasets.list().length,
      experiments: experiments.list().map((x) => ({ status: x.status, endedAt: x.endedAt })),
    }),
    budgets: () => costBudgets.list().budgets.map((b) => ({ enforce: b.enforce })),
    secretStore: () => {
      const s = require('./lib/secret-store').defaultStore();
      return { id: s.id, label: s.label };
    },
    signIn: () => ({ mode: auth.mode, serverMode: SERVER_MODE, tls: !!TLS }),
    // AI Governance 4: the accounts' roles and last sign-ins (no name leaves the control).
    accounts: () => {
      if (auth.mode === 'none' || !userStore) return { mode: auth.mode, state: 'ok', users: [] };
      const r = userStore.list();
      return {
        mode: auth.mode,
        state: r.state,
        users: r.users.map((u) => ({
          role: u.role,
          disabled: u.disabled,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt,
        })),
      };
    },
    content: () => ({ otelCapture: otel.status().captureContent === true, traceContentOff: contentOff }),
    otel: () => {
      const o = otel.status();
      return {
        enabled: !!o.enabled,
        error: !!o.error,
        failed: Number((o.stats && o.stats.failed) || 0),
        origin: o.endpoint ? mcpScan.originOf(o.endpoint) : null,
        protocol: o.protocol || null,
      };
    },
    traces: () => ({
      store: !!traceStore,
      enabled: tracingOn(),
      retentionDays: TRACE_RETENTION.days,
      maxBytes: TRACE_RETENTION.maxBytes,
    }),
  };
  const names = Object.keys(parts);
  const values = await Promise.all(names.map((k) => invSource(parts[k])));
  return Object.fromEntries(names.map((k, i) => [k, values[i]]));
}
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

// Dashboard and /api responses only (the gateway sets its own headers, with CORS for other apps): no
// framing (clickjacking), scripts from this origin only, no referrer, isolated browsing context.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), payment=()',
};
// Dashboard changes waiting for their answer (A4(1)): the entry is written right before the answer, so whoever reads
// the log after the answer finds it. The request's body comes from readBody; only its short fields are kept.
const pendingAudit = new WeakMap();
// `headers` may add a download's Content-Disposition only (lib/response-headers.js).
function send(res, status, body, type = 'application/json', headers = {}) {
  const p = pendingAudit.get(res);
  if (p) {
    pendingAudit.delete(res);
    try {
      const e = requestEntry({ method: p.req.method, path: p.path, status, body: bodies.get(p.req), reply: body });
      if (e) govRecord(e);
    } catch {
      /* an audit bug never fails a response (A6) */
    }
    // A change the dashboard made (an agent, a key, a setting): the next inventory read sees it, not a kept copy. Not
    // covered: gateway calls with an API key, the auth routes and replies that bypass send(); the 5 s TTL bounds those.
    try {
      if (p.req.method !== 'GET' && status < 400) governanceApi.invalidateInventory();
    } catch {
      /* never fails a response */
    }
  }
  res.writeHead(status, responseHeaders(type, headers, SECURITY_HEADERS));
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// A trace error reaches the client with its status and path-free message; anything else is a plain 500.
function traceError(res, e) {
  const status = e && e.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return send(res, status, { error: e.message });
  return send(res, 500, { error: 'trace read failed' });
}
// A query value that must be a whole number >= 0 (an offset or turn): undefined when absent, NaN when bad.
const wholeParam = (v) => (v == null || v === '' ? undefined : /^\d{1,15}$/.test(v) ? Number(v) : NaN);

// The text each request sent, as read, for the audit entry of a dashboard change (send() keeps its short fields only).
const bodies = new WeakMap();
const AUDIT_BODY_MAX = 64 * 1024;
// A body is read once: the role check reads a gateway admin body for its action, and the route reads it again here.
const reads = new WeakMap();
function readBody(req, max = 1e6) {
  if (!reads.has(req)) reads.set(req, readOnce(req, max));
  return reads.get(req);
}
// The body parsed once, so the role check and the gateway admin route act on the same object (its action).
const parsed = new WeakMap();
function jsonBody(req) {
  if (!parsed.has(req)) parsed.set(req, readBody(req).then(JSON.parse));
  return parsed.get(req);
}
function readOnce(req, max) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > max) {
        req.destroy();
        reject(new Error('too large'));
      }
    });
    req.on('end', () => {
      if (data.length <= AUDIT_BODY_MAX) bodies.set(req, data); // a bigger body loses only op/target in its entry
      resolve(data);
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};

// Any of these on a request means it came through a proxy, even when the proxy runs on this machine.
const TRACE_PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'forwarded',
  'x-real-ip',
  'via',
];

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Reject requests addressed to other names (DNS rebinding / cross-origin writes).
  const host = String(req.headers.host || '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  // Names other than loopback are accepted only when sign-in is on (server mode or behind a proxy).
  if (!isLoopback(host) && !(auth.mode === 'password' && (!ALLOWED_HOSTS.length || ALLOWED_HOSTS.includes(host))))
    return send(res, 403, { error: 'forbidden' });
  // In every mode, a browser page from another site is refused (DNS rebinding, and MCP's Origin rule).
  if (
    !originAllowed(req, {
      mode: auth.mode,
      trustProxy: process.env.ZAAFPULSE_TRUST_PROXY === '1',
      publicUrl: process.env.ZAAFPULSE_PUBLIC_URL,
      allowedHosts: ALLOWED_HOSTS,
      allowedOrigins: ALLOWED_ORIGINS,
    })
  )
    return send(res, 403, { error: 'requests from this origin are not allowed (see ZAAFPULSE_ALLOWED_ORIGINS)' });
  // Without sign-in, a browser request must also come from a local page: an Origin or Referer naming
  // another host (a browser reaching us through a proxy that hides its own headers), or a cross-site
  // fetch, is refused. A non-browser client behind such a proxy cannot be told apart from a local one;
  // that setup needs sign-in (docs/install.md).
  if (auth.mode === 'none') {
    const fromElsewhere = ['origin', 'referer'].some((h) => {
      if (!req.headers[h]) return false;
      try {
        return !isLoopback(new URL(req.headers[h]).hostname.replace(/^\[|\]$/g, ''));
      } catch {
        return true;
      }
    });
    if (fromElsewhere || req.headers['sec-fetch-site'] === 'cross-site')
      return send(res, 403, {
        error: 'this dashboard only answers pages on this machine; sign-in is needed for anything else',
      });
  }
  // A proxy in front of a no-sign-in setup would expose the dashboard to everyone behind it: refuse.
  if (
    auth.mode === 'none' &&
    [
      'x-forwarded-for',
      'forwarded',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-forwarded-port',
      'x-real-ip',
      'via',
    ].some((h) => req.headers[h])
  )
    return send(res, 403, {
      error: 'ZAAFPulse is behind a proxy without sign-in. Set ZAAFPULSE_TRUST_PROXY=1 and an admin password.',
    });

  try {
    // OTLP/HTTP JSON return channel (lib/trace/otlp.js): spans back from remote agents and MCP servers for traces
    // this ZAAFPulse sent out. From this machine only; bodies over 1 MB are cut off by readBody. A reverse proxy on
    // this host connects from loopback too, so a forwarding header or a public Host name is refused as well.
    if (url.pathname === '/v1/traces' && req.method === 'POST') {
      if (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        !isLoopback(host) ||
        TRACE_PROXY_HEADERS.some((h) => req.headers[h] !== undefined)
      )
        return send(res, 403, { error: 'the trace return channel accepts calls from this machine only' });
      if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || ''))
        return send(res, 415, { error: 'send OTLP as JSON (content-type: application/json)' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return err.message === 'too large' ? undefined : send(res, 400, { error: 'invalid JSON' });
      }
      return send(res, 200, traceReceiver.receive(body));
    }
    // The gateway authenticates its own callers with ZAAFPulse API keys.
    if (await gateway.handle(req, res, url)) return;
    // Dashboard and /api: a signed-in session in server mode.
    if (await auth.handle(req, res, url)) return;
    const signedIn = auth.check(req);
    if (!signedIn && !['/login.html', '/login.js'].includes(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'sign in first' });
      res.writeHead(302, { location: '/login.html', ...SECURITY_HEADERS });
      return res.end();
    }
    // Who signed in, for the role check and the redacted views (a reviewer's or a viewer's; the owner sees it all).
    const signedAs = signedIn ? auth.sessionOf(req, false) : null;
    const role = signedAs ? signedAs.role : 'viewer';
    if (signedIn) {
      // The governance audit log: who this request acts as, and one entry for each change it makes (A4(1)).
      govContext.setActor(auth.actorOf(req));
      // Roles (AI Governance 4): a reviewer's or a viewer's request is checked against lib/users/policy.js before
      // anything runs, with the path, query values and body action the routes below use (a gateway admin route by its
      // body's action). A refusal is a 403 and one refused entry, a read included.
      if (role !== 'owner') {
        let action = null;
        if (req.method === 'POST' && /^\/api\/gateway\/[a-z]+$/.test(url.pathname))
          try {
            const b = await jsonBody(req);
            if (b && typeof b === 'object' && typeof b.action === 'string') action = b.action;
          } catch {
            /* no action: refused below */
          }
        const verdict = roleAllows({
          role,
          method: req.method,
          path: url.pathname,
          action,
          mustChange: !!(signedAs && signedAs.mustChange),
          section: url.searchParams.get('section'),
          q: url.searchParams.get('q'),
        });
        if (!verdict.ok) {
          try {
            const e = requestEntry({
              method: req.method,
              path: url.pathname,
              status: 403,
              body: bodies.get(req),
              always: true,
            });
            if (e) govRecord(e);
          } catch {
            /* an audit bug never changes the answer (A6) */
          }
          return send(res, 403, { error: verdict.reason });
        }
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/'))
        pendingAudit.set(res, { req, path: url.pathname });
    }
    if (url.pathname === '/api/platform') {
      return send(res, 200, {
        os: platform.OS,
        osLabel: platform.OS_LABEL,
        secretStore: {
          id: require('./lib/secret-store').defaultStore().id,
          label: require('./lib/secret-store').defaultStore().label,
        },
        serverMode: SERVER_MODE,
        host: HOST,
        port: PORT,
        tls: !!TLS,
        baseUrl: BASE_URL,
        auth: auth.required,
        authMode: auth.mode,
        single: platform.isSea(),
        version: require('./package.json').version,
      });
    }
    // A reviewer or a viewer gets the redacted view: no prompt, note, title, task or secret reference.
    if (url.pathname === '/api/gateway' && req.method === 'GET')
      return send(res, 200, redactGateway(await gateway.admin('', 'GET'), role));
    const gwAdmin = url.pathname.match(/^\/api\/gateway\/([a-z]+)$/);
    if (gwAdmin) {
      // Only the request log is read with GET. Every other admin route writes (defaults, settings), spends tokens
      // (playground) or calls providers (quota), so a GET there is 405 and changes nothing (A7); so is any method but
      // POST.
      if (req.method === 'GET')
        return gwAdmin[1] === 'logs'
          ? send(res, 200, redactGatewayLogs(await gateway.admin('logs', 'GET'), role))
          : send(res, 405, { error: 'method not allowed' });
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      try {
        // A refused guardrails setting (badRequest) is a 400; every other admin answer keeps its 200, errors included.
        const out = await gateway.admin(gwAdmin[1], 'POST', await jsonBody(req));
        return send(res, out && out.badRequest === true ? 400 : 200, out);
      } catch (err) {
        return send(res, 200, { errors: [err.message] });
      }
    }
    if (url.pathname === '/api/summary') {
      const r = url.searchParams.get('range') || '30';
      const range = r === 'all' ? 'all' : Math.min(365, Math.max(1, parseInt(r, 10) || 30));
      const summary = {
        ...getSummary(range),
        config: { userName: config.userName, monthlyBudgetUSD: costBudgets.monthly().monthlyBudgetUSD, host: HOSTNAME },
        index: indexer.state,
      };
      // A reviewer or a viewer: counts, costs, model and tool names, no event text or path.
      return send(res, 200, redactSummary(summary, role));
    }
    if (url.pathname === '/api/live') {
      return send(res, 200, {
        ...(DEMO ? { ...demo.live(), demoReady } : await processes.snapshot()),
        index: indexer.state,
        // Where the logs are read from, for the Overview's empty state. The owner's own dashboard only (~ paths).
        ...(DEMO ? {} : { logRoots: logRoots() }),
      });
    }
    if (url.pathname === '/api/insights') {
      const r = url.searchParams.get('range') || '30';
      return send(res, 200, getInsights(r === 'all' ? 'all' : Math.min(365, Math.max(1, parseInt(r, 10) || 30))));
    }
    if (url.pathname === '/api/topology') return send(res, 200, DEMO ? demo.topologyDemo() : await topology());
    if (url.pathname === '/api/router' && DEMO) {
      const section = url.searchParams.get('section');
      return send(res, 200, {
        configured: true,
        id: 'omniroute (demo)',
        data: require('./lib/omniroute').demoRouter(section),
      });
    }
    if (url.pathname === '/api/router') {
      if (!router.configured()) return send(res, 200, { configured: false });
      const range = ['1h', '24h', '7d', '30d'].includes(url.searchParams.get('range'))
        ? url.searchParams.get('range')
        : '24h';
      const fn = {
        utilization: () => router.utilization(range),
        cache: router.cache,
        compression: router.compression,
        providers: router.providerStats,
        calls: router.callLogs,
        proxy: router.proxyLogs,
      }[url.searchParams.get('section')];
      if (!fn) return send(res, 404, { error: 'unknown section' });
      return send(res, 200, { configured: true, id: router.id(), data: await fn() });
    }
    // Trace & Session Explorer: sessions of every source, one session as spans, and their text on request.
    // Behind the sign-in above, so a gateway API key never reaches it. Ids are opaque; no path leaves here.
    if (url.pathname.startsWith('/api/trace/')) {
      const route = url.pathname.slice('/api/trace/'.length);
      const q = url.searchParams;
      const post = route === 'reveal';
      if (
        !['sources', 'settings', 'sessions', 'session', 'title', 'content', 'reveal', 'live', 'find', 'deps'].includes(route)
      )
        return send(res, 404, { error: 'unknown route' });
      if (req.method !== (post ? 'POST' : 'GET')) return send(res, 405, { error: 'method not allowed' });
      // Nothing a client sends for a filter, a cursor or a session id is longer than this.
      if (['cursor', 'q', 'flags', 'source', 'sid'].some((k) => (q.get(k) || '').length > 512))
        return send(res, 400, { error: 'query value too long' });
      try {
        if (route === 'sources') return send(res, 200, trace.sources());
        if (route === 'settings') return send(res, 200, trace.settings());
        // A link from the Sessions or AI Office page: the session id it already holds, turned into a key.
        if (route === 'find') return send(res, 200, { key: trace.keyFor(q.get('source'), q.get('sid')) });
        if (route === 'sessions') {
          const days = parseInt(q.get('range'), 10);
          const range = Number.isNaN(days) ? 7 : Math.min(30, Math.max(1, days));
          const minMs = Number(q.get('minMs'));
          const minCost = Number(q.get('minCost'));
          const rows = trace.sessions({
            range,
            source: q.get('source') || undefined,
            q: q.get('q') || undefined,
            flags: q.get('flags') || undefined,
            minMs: Number.isFinite(minMs) && minMs > 0 ? minMs : undefined,
            minCost: Number.isFinite(minCost) && minCost > 0 ? minCost : undefined,
          });
          // A reviewer or a viewer gets the list without titles (the first prompt).
          return send(res, 200, redactTraceSessions({ sessions: rows }, role));
        }
        if (route === 'deps') {
          const days = parseInt(q.get('range'), 10);
          return send(res, 200, trace.deps({ range: Number.isNaN(days) ? 7 : Math.min(30, Math.max(1, days)) }));
        }
        if (route === 'session')
          return send(res, 200, await trace.session(q.get('key'), { turn: wholeParam(q.get('turn')) }));
        if (route === 'title') return send(res, 200, { title: await trace.title(q.get('key')) });
        if (route === 'content')
          return send(res, 200, await trace.content(q.get('id'), { offset: wholeParam(q.get('offset')) }));
        if (route === 'live') return send(res, 200, await trace.live(q.get('key'), q.get('cursor') || undefined));
        // reveal: the one place a secret leaves, one value per call, so it needs JSON like every state change.
        if (!(req.headers['content-type'] || '').startsWith('application/json'))
          return send(res, 415, { error: 'json only' });
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          return send(res, err.message === 'too large' ? 413 : 400, { error: 'bad request body' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return send(res, 400, { error: 'bad request body' });
        const { id, index, offset } = body;
        if (index !== undefined && !Number.isInteger(index)) return send(res, 400, { error: 'mask index required' });
        if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0))
          return send(res, 400, { error: 'bad offset' });
        // A secret was shown (A4(6)): which content and which mask, never the value. An id that is not id-shaped
        // (content ids are ci_<hex>) is not copied.
        const target = { type: 'content', ...(typeof id === 'string' && GOV_ID.test(id) ? { id } : {}) };
        let shown;
        try {
          shown = await trace.reveal(id, index, { offset });
        } catch (err) {
          const st = err && err.status;
          govRecord({
            action: 'trace.reveal',
            target,
            outcome: Number.isInteger(st) && st < 500 ? 'refused' : 'error',
            ...(Number.isInteger(st) ? { status: st } : {}),
          });
          throw err;
        }
        govRecord({ action: 'trace.reveal', target, ...(index !== undefined ? { index } : {}) });
        return send(res, 200, shown);
      } catch (err) {
        return traceError(res, err);
      }
    }
    // Local evals and feedback: results per session, trends, the judge model's status, settings and the preview.
    // Behind the same sign-in; a session is named by its trace key, and the only text out is the masked preview.
    {
      const hit = await evalApi.route({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body);
    }
    // Datasets and experiments: behind the same sign-in; trace turns are named by key, no path or session id out.
    {
      const hit = await datasetApi.route({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        contentType: req.headers['content-type'],
        readBody: (max) => readBody(req, max),
      });
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json');
    }
    // Monitors, alerts and agent control, behind the same sign-in. A session is named by its trace key; no raw session
    // id or path leaves here.
    {
      const hit = await monitorApi.route({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body);
    }
    // Local model servers: Start, Stop and the owner's entries, behind the same sign-in. Only ids reach the server.
    {
      const hit = await runtimeApi.route({
        method: req.method,
        path: url.pathname,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
      });
      // A reviewer or a viewer: the entries without their command lines or health URLs, in every mode.
      if (hit && url.pathname === '/api/runtimes/config' && hit.status === 200)
        return send(res, 200, redactRuntimesConfig(hit.body, role));
      if (hit) return send(res, hit.status, hit.body);
    }
    // The cost ledger: rows, status, settings, price versions and restate, behind the same sign-in. No path out. An
    // export is a download: its own type and Content-Disposition.
    {
      const hit = await costApi.route({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json', hit.headers);
    }
    // The governance audit log: entries, export (a download), verify, status and the retention setting. Behind the
    // same sign-in; no gateway key or MCP client reaches it.
    {
      const hit = await governanceApi.route({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
      });
      if (hit) return send(res, hit.status, hit.body, hit.type || 'application/json', hit.headers);
    }
    // The dashboard accounts (AI Governance 4).
    {
      const hit = await usersApi.route({
        method: req.method,
        path: url.pathname,
        contentType: req.headers['content-type'],
        readBody: () => readBody(req),
        req,
      });
      if (hit) return send(res, hit.status, hit.body);
    }
    if (url.pathname === '/api/logs') {
      // A reviewer or a viewer: types, sizes and counts, no error text or tool target.
      return send(res, 200, redactLogs(DEMO ? reqlogs.demoLogs() : reqlogs.logs(), role));
    }
    if (url.pathname === '/api/timeline') {
      const hours = Math.min(48, Math.max(1, parseInt(url.searchParams.get('hours'), 10) || 6));
      // A reviewer or a viewer: the tools and their times, no file name, command or host.
      return send(res, 200, redactTimeline(DEMO ? timeline.demoTimeline(hours) : await timeline.timeline(hours), role));
    }
    if (url.pathname === '/api/mcp-calls') {
      return send(res, 200, {
        calls: DEMO
          ? demo.integrations().calls
          : require('./lib/audit')
              .createAudit(path.join(DIR, '.cache', 'mcp-audit.jsonl'))
              .tail(300),
      });
    }
    if (url.pathname === '/api/office') {
      // A reviewer or a viewer: states and tools, no git branch, file name, command or host.
      return send(res, 200, redactOffice(DEMO ? office.demoSnapshot() : office.snapshot(), role));
    }
    // Endpoint → MCP server: register this MCP server in (or remove it from) Claude Code, Kiro or Antigravity.
    // Uses the same script as `npm run mcp:register`: backups first, only our own entry is touched.
    if (url.pathname === '/api/mcp/register' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      if (DEMO) return send(res, 200, { errors: ['not in demo mode'] });
      const body = JSON.parse(await readBody(req));
      const log = [];
      try {
        register.run(String(body.client || ''), {
          remove: body.remove === true,
          log: (m) => log.push(String(m)),
          exec: (cmd, args, opts) =>
            require('child_process').execFileSync(cmd, args, { ...opts, stdio: 'pipe', timeout: 30000 }),
        });
        return send(res, 200, { ok: true, log, clients: clientRows() });
      } catch (err) {
        return send(res, 200, { errors: [err.message], log, clients: clientRows() });
      }
    }
    if (url.pathname === '/api/brain' && req.method === 'GET') {
      return send(res, 200, { types: brain.TYPES, sources: brain.sources() });
    }
    if (url.pathname === '/api/brain/graph') {
      const id = url.searchParams.get('source') || 'obsidian';
      return send(res, 200, await brain.graph(id, { fresh: url.searchParams.get('fresh') === '1' }));
    }
    if (url.pathname === '/api/brain/sources' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
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
      // A reviewer or a viewer: the name, the monthly budget and the pricing only.
      return send(res, 200, redactConfig({ ...rest, ...costBudgets.monthly() }, role));
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      if (!DEMO && configBroken()) return send(res, 409, { error: CONFIG_BROKEN });
      // Once the legacy monthly budget is a saved budget, the Settings field is read-only: a posted value is ignored.
      const managed = costBudgets.monthly().monthlyBudgetManaged;
      const next = { ...config };
      if (typeof body.userName === 'string') next.userName = body.userName.slice(0, 60);
      if (!managed && Number.isFinite(body.monthlyBudgetUSD) && body.monthlyBudgetUSD >= 0)
        next.monthlyBudgetUSD = body.monthlyBudgetUSD;
      if (typeof body.vaultPath === 'string')
        next.vaultPaths = body.vaultPath.trim() ? [require('./lib/platform').expandHome(body.vaultPath)] : [];
      if (body.pricing && typeof body.pricing === 'object') {
        const p = {};
        for (const [k, v] of Object.entries(body.pricing)) {
          if (!/^[\w.\-]{1,60}$/.test(k) || !v) continue;
          const clean = {};
          for (const f of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'])
            clean[f] = Math.max(0, Number(v[f]) || 0);
          p[k] = clean;
        }
        next.pricing = p;
      }
      if (DEMO) {
        config = next;
        rawCache.value = { ...rawCache.value, monthlyBudgetUSD: next.monthlyBudgetUSD }; // the demo's legacy budget
      } else {
        // Write the stored settings only, never the merged runtime prices. saveConfigSections keeps every other section
        // and refuses a file that does not parse.
        saveConfigSections({
          userName: next.userName,
          monthlyBudgetUSD: next.monthlyBudgetUSD,
          vaultPaths: next.vaultPaths,
          ...(body.pricing && typeof body.pricing === 'object' ? { pricing: next.pricing } : {}),
        });
        config = loadConfig();
      }
      memo.clear();
      budgetsChanged();
      const { integrations, ...rest } = config;
      return send(res, 200, redactConfig({ ...rest, ...costBudgets.monthly() }, role));
    }
    if (url.pathname === '/api/openrouter') {
      const fn = {
        models: openRouter.models,
        providers: openRouter.providers,
        rankings: openRouter.rankings,
        account: openRouter.account,
      }[url.searchParams.get('section')];
      if (!fn) return send(res, 404, { error: 'unknown section' });
      return send(res, 200, await fn());
    }
    if (url.pathname === '/api/openrouter/endpoints') {
      const ids = (url.searchParams.get('ids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 40);
      return send(res, 200, await openRouter.endpointsMany(ids));
    }
    if (url.pathname === '/api/prices' && req.method === 'GET') {
      return send(res, 200, {
        status: priceSync.status(),
        sync: config.pricingSync,
        catalog: priceSync.catalog(),
        manual: config.manualPricing,
        effective: config.pricing,
        source: config.pricingSource,
        snapshot: SNAPSHOT_META, // where and when the offline list was taken, for "snapshot" prices
        demo: DEMO,
      });
    }
    if (url.pathname === '/api/prices' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      if (DEMO) return send(res, 200, { error: 'Demo mode: prices are not saved.' });
      if (body.action === 'refresh') {
        await priceSync.refresh();
        return send(res, 200, { status: priceSync.status() });
      }
      if (configBroken()) return send(res, 409, { error: CONFIG_BROKEN });
      let raw = {};
      try {
        raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch {
        /* new file */
      }
      const manual = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : {};
      const sync = {
        enabled: !(raw.pricingSync && raw.pricingSync.enabled === false),
        pinned: Array.isArray(raw.pricingSync?.pinned) ? raw.pricingSync.pinned : [],
      };
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (body.action !== 'toggle' && !/^[\w.\-]{1,60}$/.test(key))
        return send(res, 400, { error: 'model key: letters, digits, dots and dashes' });
      if (body.action === 'toggle') sync.enabled = body.enabled !== false;
      else if (body.action === 'set') {
        const clean = {};
        for (const f of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'])
          clean[f] = Math.max(0, Number(body.price && body.price[f]) || 0);
        manual[key] = clean;
        if (!sync.pinned.includes(key)) sync.pinned.push(key); // your price for this key wins over the live one
      } else if (body.action === 'unpin' || body.action === 'remove') {
        delete manual[key];
        sync.pinned = sync.pinned.filter((k) => k !== key);
      } else return send(res, 400, { error: 'unknown action' });
      saveConfigSections({ pricing: manual, pricingSync: sync });
      config = loadConfig();
      memo.clear();
      insightMemo.clear();
      if (body.action === 'toggle' && sync.enabled && priceSync.stale()) priceSync.refresh();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/integrations/config' && req.method === 'GET') {
      if (DEMO)
        return send(
          res,
          200,
          describeIntegrations(
            Object.fromEntries(
              demo
                .integrations()
                .integrations.filter((i) => i.type !== 'acc')
                .map((i) => [
                  i.id,
                  {
                    type: i.type,
                    ...(i.flavor ? { flavor: i.flavor } : {}),
                    enabled: i.enabled,
                    allowWrite: i.allowWrite,
                    baseUrl: 'http://localhost:8080',
                  },
                ]),
            ),
          ),
        );
      return send(res, 200, integrationConfig.describe());
    }
    if (
      ['/api/integrations/save', '/api/integrations/delete', '/api/integrations/test-draft'].includes(url.pathname) &&
      req.method === 'POST'
    ) {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      if (url.pathname === '/api/integrations/test-draft') {
        if (DEMO)
          return send(res, 200, {
            status: { id: body.id, type: body.type, state: 'ok', latencyMs: 87, tools: 5 },
            tools: ['demo_tool_a', 'demo_tool_b'],
          });
        return send(res, 200, await integrationConfig.test(body));
      }
      if (DEMO) return send(res, 200, { errors: ['Demo mode: changes are not saved.'] });
      let r;
      try {
        r = url.pathname.endsWith('/save') ? integrationConfig.save(body) : integrationConfig.remove(body.id);
      } catch (err) {
        // 409 while config.json does not parse (it is never written over), 500 when the write failed: path-free.
        if (err && (err.status === 409 || err.status === 500)) return send(res, err.status, { error: err.message });
        throw err;
      }
      if (r.errors) return send(res, 200, r);
      config = loadConfig(); // keep Settings saves from writing back a stale integrations list
      if (url.pathname.endsWith('/delete')) return send(res, 200, r);
      const [status] = await getIntegrations().status({ fresh: true, only: r.id });
      return send(res, 200, { id: r.id, status });
    }
    if (url.pathname === '/api/integrations' && req.method === 'GET') {
      if (DEMO) return send(res, 200, demo.integrations());
      return send(res, 200, {
        integrations: await getIntegrations().status(),
        clients: clientRows(),
        calls: audit.tail(100),
        mcpCommand: (({ command, args }) => [command, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '))(
          platform.mcpCommand(),
        ),
      });
    }
    if (url.pathname === '/api/integrations/test' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      const { id } = JSON.parse(await readBody(req));
      if (DEMO) {
        const s = demo.integrations().integrations.find((i) => i.id === id);
        return s ? send(res, 200, s) : send(res, 404, { error: 'unknown integration' });
      }
      const [s] = await getIntegrations().status({ fresh: true, only: String(id || '') });
      return s ? send(res, 200, s) : send(res, 404, { error: 'unknown integration' });
    }
    if (url.pathname === '/api/rescan' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      indexer.refresh().then(() => {
        memo.clear();
        // The passes are the system's, not the person who clicked Rescan.
        govContext.runAs({ via: 'system' }, () => {
          evalTick();
          monitorTick();
          costTick();
        });
      });
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
};
// Each request runs with its own actor slot for the governance audit log (filled after sign-in or the key check);
// otel continues an incoming traceparent on gateway requests.
const traced = otel.wrapHandler((req, res) => govContext.runAs(null, () => handler(req, res)));
const server = TLS ? https.createServer(TLS, traced) : http.createServer(traced);
server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use: is ZAAFPulse running? (zaafpulse status)`
      : err.message,
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(
    `ZAAFPulse${DEMO ? ' (demo data)' : ''} → ${TLS ? 'https' : 'http'}://${SERVER_MODE ? HOST : 'localhost'}:${PORT}${SERVER_MODE ? `  (server mode: sign-in required; apps use ${BASE_URL})` : ''}`,
  );
  if (auth.mode === 'local') console.log('Sign-in: only this OS account; open the dashboard with `zaafpulse open`');
  console.log(`Data: ${DIR}`);
  const t = Date.now();
  // The first scan of the logs. Kept: a second indexer.refresh() while it runs returns at once.
  const firstScan = indexer.refresh();
  firstScan.then(() => {
    console.log(`Indexed logs in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    evalTick();
    monitorTick();
    costTick();
  });
  setInterval(() => indexer.refresh().then(evalTick), RESCAN_MS).unref();
  setInterval(monitorTickAfterIndex, RESCAN_MS).unref();
  setInterval(costTickAfterIndex, RESCAN_MS).unref();
  // The live monitor pass. It reads the office snapshot itself: nothing else polls it (the AI Office page asks on
  // its own requests), so there is no call to share.
  setInterval(() => monitors.tickLive().catch(() => console.error('monitors: the live pass failed')), 5000).unref();
  // Live prices: refresh now if the cached list is older than 12 hours, then check hourly. Never in demo mode.
  const syncPrices = () => {
    if (!DEMO && config.pricingSync.enabled && priceSync.stale()) priceSync.refresh();
  };
  syncPrices();
  setInterval(syncPrices, 3600 * 1000).unref();
  // Trace store: snapshot the index and apply retention now and every 5 minutes.
  const keepTraces = () => {
    try {
      recorder.flush();
      if (traceStore) {
        traceStore.applyRetention();
        traceStore.snapshot();
      }
    } catch (err) {
      console.error('traces:', err.message);
    }
  };
  keepTraces();
  setInterval(keepTraces, 5 * 60 * 1000).unref();
  // The governance audit log, now and once a day: the CLI's events, the whole months past the retention, and a check
  // of the chain (the Monitors rules audit_degraded and audit_chain_broken read the result). The pass is the system's;
  // each step runs on its own (lib/governance/api.js dailyPass).
  const auditDaily = () => govContext.runAs({ via: 'system' }, () => governanceApi.dailyPass());
  auditDaily();
  setInterval(auditDaily, 24 * 3600 * 1000).unref();
  // The AI inventory, now and every 10 minutes, so inventory_unreviewed sees new systems without the page open (a
  // read of the page builds it too). The pass is the system's; a failure is logged and the next one tries again.
  const inventoryPass = () =>
    govContext.runAs({ via: 'system' }, () =>
      governanceApi.inventory().catch(() => console.error('governance: the inventory pass failed')),
    );
  // The first one waits for the first scan of the log index, so the baseline holds the tools and models in the logs.
  firstScan.then(inventoryPass, inventoryPass);
  setInterval(inventoryPass, 10 * 60 * 1000).unref();
  // Local model servers: remember what is loaded. Not in demo mode, server mode or Docker (control is off there), and
  // not with ZAAFPULSE_RUNTIME_WATCH=off (the tests' spawned servers, which must not read this machine's Ollama).
  if (!DEMO && !runtimeControl.offReason() && process.env.ZAAFPULSE_RUNTIME_WATCH !== 'off')
    setInterval(observeRuntimeModels, 30 * 1000).unref();
  // Demo: seed the workspace, then run chats, agents, collaboration patterns and workflows once.
  if (DEMO)
    demoGw
      .seed(gateway, { dataDir: demoDir })
      .then(() => demoGw.warm(`http://127.0.0.1:${PORT}`, gateway))
      .catch((err) => console.error('demo seed:', err.message))
      .finally(() => {
        demoReady = true;
      });
});

// Sessions are written within a second; flush them when launchd, Ctrl-C or a closed terminal stops the server.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(sig, () => {
    try {
      evalEngine.stop(); // a running judge call is cancelled, and its working folder removed
      gateway.flush();
      recorder.flush();
      if (traceStore) traceStore.snapshot();
    } finally {
      // Queued spans get up to 2 seconds to reach the OTLP endpoint.
      otel.shutdown(2000).finally(() => process.exit(0));
    }
  });
