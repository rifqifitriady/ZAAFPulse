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
const { DEFAULT_PRICING, SNAPSHOT_META } = require('./lib/pricing');
const processes = require('./lib/processes');
const { getVault } = require('./lib/vault');
const { createBrain } = require('./lib/brain');
const office = require('./lib/office');
const { insights } = require('./lib/insights');
const reqlogs = require('./lib/reqlogs');
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
const { createMonitors } = require('./lib/monitors');
const { createAgentControl } = require('./lib/agents/control');
const runtimeRegistry = require('./lib/runtimes/registry');
const { createRuntimeState, jsonFile } = require('./lib/runtimes/state');
const { createRuntimeControl } = require('./lib/runtimes/control');
const { createModelMemory } = require('./lib/runtimes/models');
const { createRuntimeApi } = require('./lib/runtimes/api');
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
let auth;
try {
  auth = createAuth({ dataDir: DIR, host: HOST, demo: DEMO, headers: () => SECURITY_HEADERS });
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
const integrationConfig = createIntegrationConfig({ file: CONFIG_FILE, secrets: createSecrets() });
// Agent Gateway: OpenAI-compatible /v1 API, agents, orchestrator and MCP over HTTP, behind ZAAFPulse
// API keys. Provider settings live in config.json under "gateway"; keys, agents, sessions and memory
// in .data/ (demo mode uses a throwaway folder so it never touches your data).
// DEMO=1 keeps everything in a throwaway folder: gateway data, second-brain files and the code-tool home.
const demoDir = DEMO ? fs.mkdtempSync(path.join(os.tmpdir(), 'zp-demo-')) : null;
const demoGw = DEMO ? require('./lib/demo-gateway') : null;
let demoReady = !DEMO;
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
// Local trace store: every gateway trace without content, under .data/traces (on unless "tracing": { "enabled":
// false }). Retention is read at start; the on/off switch whenever config.json changes.
const tracingCfg = () => (rawConfig() || {}).tracing || {};
// A store that cannot open (unwritable or corrupt folder) never takes the server down: tracing is just off.
let traceStore = null;
try {
  traceStore = createTraceStore({
    dir: path.join(DEMO ? demoDir : path.join(DIR, '.data'), 'traces'),
    retentionDays: Number(tracingCfg().retentionDays) > 0 ? Number(tracingCfg().retentionDays) : 14,
    maxBytes: Number(tracingCfg().maxBytes) > 0 ? Number(tracingCfg().maxBytes) : 500 * 1024 * 1024,
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
const gateway = createGateway({
  dataDir: DEMO ? demoDir : path.join(DIR, '.data'),
  ...(DEMO ? { fetchImpl: demoGw.createDemoFetch(), toolsHome: demoDir } : {}),
  getConfig: rawConfig,
  writeGatewayConfig: (g) => {
    if (DEMO) {
      rawCache.value = { ...rawCache.value, gateway: g };
      return;
    }
    const raw = { ...rawConfig(), gateway: g };
    fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2));
    fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
  },
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
    save: (evals) => {
      if (DEMO) {
        rawCache.value = { ...rawCache.value, evals };
        return;
      }
      const raw = { ...rawConfig(), evals };
      fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2));
      fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
      rawCache = { mtime: fs.statSync(CONFIG_FILE).mtimeMs, value: raw };
    },
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
    save: (next) => {
      if (DEMO) {
        rawCache.value = { ...rawCache.value, datasets: next };
        return;
      }
      const raw = { ...rawConfig(), datasets: next };
      fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2));
      fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
      rawCache = { mtime: fs.statSync(CONFIG_FILE).mtimeMs, value: raw };
    },
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
const AGENTS_OFF = SERVER_MODE || auth.mode === 'password';
const agentControl = createAgentControl({ dataDir: monitorDir, serverMode: AGENTS_OFF, log: (m) => console.error(m) });
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
      const monitorsCfg = {
        ...(m && typeof m === 'object' ? m : {}),
        channels: { desktop, ...(webhook ? { webhook } : {}) },
      };
      if (DEMO) {
        rawCache.value = { ...rawCache.value, monitors: monitorsCfg };
        return;
      }
      const raw = { ...rawConfig(), monitors: monitorsCfg };
      fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2));
      fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
      rawCache = { mtime: fs.statSync(CONFIG_FILE).mtimeMs, value: raw };
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
});
// Local model servers (lib/runtimes): Start and Stop on the AI Office cards, and the owner's own runtimes in
// config.json "localRuntimes" (Settings → Local models). Off wherever agent control is off (server mode, password
// sign-in) and in Docker. Demo mode answers from synthetic runtimes and starts nothing.
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
  started: runtimeStarted,
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
    // config.json is read again here, not from the cache: rawConfig() reads a file that does not parse as {}, and
    // saving on top of that would drop everything else in it. Such a file (often a hand edit gone wrong) is refused
    // and left as it is; the API answers 500 "the settings could not be saved", which holds no path.
    save: (list) => {
      let text = '';
      try {
        text = fs.readFileSync(CONFIG_FILE, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const base = text.trim() ? JSON.parse(text) : {};
      if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('config.json is not an object');
      const raw = { ...base, localRuntimes: list };
      const tmpFile = `${CONFIG_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmpFile, CONFIG_FILE);
      } catch (e) {
        fs.rmSync(tmpFile, { force: true });
        throw e;
      }
      rawCache = { mtime: fs.statSync(CONFIG_FILE).mtimeMs, value: raw };
    },
  },
  demo: DEMO ? demo.runtimesDemo() : null,
  home: os.homedir(),
});
// Each pass catches its own failures; this catch is the last line, so a pass can never break a refresh.
const monitorTick = () =>
  Promise.resolve()
    .then(() => monitors.tickAggregate())
    .catch(() => console.error('monitors: the aggregate pass failed'));
// The aggregate pass has to run on the refreshed index. The refresh timer is not changed: this waits for it to end.
// One waiting poller at a time: a refresh that outlasts RESCAN_MS must not stack a poller per interval.
let monitorTickWaiting = false;
const monitorTickAfterIndex = () => {
  if (monitorTickWaiting) return;
  monitorTickWaiting = true;
  const t = setInterval(() => {
    if (indexer.state.indexing) return;
    clearInterval(t);
    monitorTickWaiting = false;
    monitorTick();
  }, 250);
  t.unref();
};

// Second brain sources: Obsidian by default, plus Logseq, Notion, Tana, Roam, mem.ai, Reflect, Heybrain,
// PARA folders, the RAG knowledge bases and vector databases. Settings in config.json under "brain";
// tokens in the Keychain as acc.brain-<id>.
const brain = createBrain({
  getConfig: rawConfig,
  writeBrainConfig: (b) => {
    if (DEMO) {
      rawCache.value = { ...rawCache.value, brain: b };
      return;
    }
    const raw = { ...rawConfig(), brain: b };
    fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2));
    fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
  },
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
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
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

function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > max) {
        req.destroy();
        reject(new Error('too large'));
      }
    });
    req.on('end', () => resolve(data));
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
    if (!auth.check(req) && !['/login.html', '/login.js'].includes(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'sign in first' });
      res.writeHead(302, { location: '/login.html', ...SECURITY_HEADERS });
      return res.end();
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
    if (url.pathname === '/api/gateway' && req.method === 'GET') return send(res, 200, await gateway.admin('', 'GET'));
    const gwAdmin = url.pathname.match(/^\/api\/gateway\/([a-z]+)$/);
    if (gwAdmin) {
      if (req.method === 'GET') return send(res, 200, await gateway.admin(gwAdmin[1], 'GET'));
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      try {
        return send(res, 200, await gateway.admin(gwAdmin[1], 'POST', JSON.parse(await readBody(req))));
      } catch (err) {
        return send(res, 200, { errors: [err.message] });
      }
    }
    if (url.pathname === '/api/summary') {
      const r = url.searchParams.get('range') || '30';
      const range = r === 'all' ? 'all' : Math.min(365, Math.max(1, parseInt(r, 10) || 30));
      return send(res, 200, {
        ...getSummary(range),
        config: { userName: config.userName, monthlyBudgetUSD: config.monthlyBudgetUSD, host: HOSTNAME },
        index: indexer.state,
      });
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
          return send(res, 200, { sessions: rows });
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
        return send(res, 200, await trace.reveal(id, index, { offset }));
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
      if (hit) return send(res, hit.status, hit.body);
    }
    if (url.pathname === '/api/logs') {
      return send(res, 200, DEMO ? reqlogs.demoLogs() : reqlogs.logs());
    }
    if (url.pathname === '/api/timeline') {
      const hours = Math.min(48, Math.max(1, parseInt(url.searchParams.get('hours'), 10) || 6));
      return send(res, 200, DEMO ? timeline.demoTimeline(hours) : await timeline.timeline(hours));
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
      return send(res, 200, DEMO ? office.demoSnapshot() : office.snapshot());
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
      return send(res, 200, rest);
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/json'))
        return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      const next = { ...config };
      if (typeof body.userName === 'string') next.userName = body.userName.slice(0, 60);
      if (Number.isFinite(body.monthlyBudgetUSD) && body.monthlyBudgetUSD >= 0)
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
      if (DEMO) config = next;
      else {
        // Write the stored settings only, never the merged runtime prices.
        let raw = {};
        try {
          raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch {
          /* new file */
        }
        Object.assign(raw, {
          userName: next.userName,
          monthlyBudgetUSD: next.monthlyBudgetUSD,
          vaultPaths: next.vaultPaths,
        });
        if (body.pricing && typeof body.pricing === 'object') raw.pricing = next.pricing;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
        config = loadConfig();
      }
      memo.clear();
      const { integrations, ...rest } = config;
      return send(res, 200, rest);
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
      raw.pricing = manual;
      raw.pricingSync = sync;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
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
      const r = url.pathname.endsWith('/save') ? integrationConfig.save(body) : integrationConfig.remove(body.id);
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
        evalTick();
        monitorTick();
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
const traced = otel.wrapHandler(handler); // continues an incoming traceparent on gateway requests
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
  indexer.refresh().then(() => {
    console.log(`Indexed logs in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    evalTick();
    monitorTick();
  });
  setInterval(() => indexer.refresh().then(evalTick), RESCAN_MS).unref();
  setInterval(monitorTickAfterIndex, RESCAN_MS).unref();
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
  // Local model servers: remember what is loaded. Not in demo mode, server mode or Docker (control is off there).
  if (!DEMO && !runtimeControl.offReason()) setInterval(observeRuntimeModels, 30 * 1000).unref();
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
