#!/usr/bin/env node
// MCP server for ZAAFPulse (AI Command Center). AI clients (Claude Code, Cursor, VS Code, Codex and others) start it
// over stdio with `node mcp.js`. It is named "zaafpulse", like the gateway's HTTP endpoint /mcp, so a client that has
// one of the two never lists the same tools under a second name. It exposes the dashboard's own data plus every
// integration configured in config.json. stdout carries protocol messages only; logs go to stderr.
const fs = require('fs');
const path = require('path');
const { createServer } = require('./lib/mcp/protocol');
const { createIntegrations } = require('./lib/integrations');
const { createSecrets } = require('./lib/secrets');
const { createAudit } = require('./lib/audit');
const { createLocal } = require('./lib/local');
const { createCostReader } = require('./lib/cost/reader');
const otel = require('./lib/otel');
const { version } = require('./package.json');

process.umask(0o077); // caches and audit logs are private to this OS account
const DIR = require('./lib/platform').dataDir(); // the same data folder as the server
const CONFIG_FILE = process.env.ACC_CONFIG || path.join(DIR, 'config.json');
const CACHE_DIR = process.env.ACC_CACHE_DIR || path.join(DIR, '.cache');
const log = (m) => process.stderr.write(`[zaafpulse] ${m}\n`);

const INSTRUCTIONS =
  'ZAAFPulse (AI Command Center) on this machine. Tool names are prefixed with an integration id: acc_* reads local AI usage, cost, quality and running apps; other prefixes reach the platforms configured in config.json (Dynatrace, Arize, n8n, AI routers, HTTP APIs, upstream MCP servers). Call acc_integrations_status first to see what is connected. Write tools only appear for integrations with allowWrite enabled.';

let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') log(`config.json is unreadable, starting with defaults: ${err.message}`);
}

const secrets = createSecrets();
// Tool-call spans, as in server.js: off unless config.json has "otel": { "enabled": true }. Its log goes to stderr.
otel.init({ getConfig: () => config, secrets, version, log });
// The cost tools read the server's cost data read-only; they are on this stdio server only, never on gateway /mcp.
const cost = createCostReader({
  dir: path.join(DIR, '.data', 'cost'),
  configFile: CONFIG_FILE,
  keysFile: path.join(DIR, '.data', 'keys.json'),
  home: require('os').homedir(),
});
const local = createLocal({ cacheDir: CACHE_DIR, config, dataDir: DIR, cost });
const integrations = createIntegrations({
  config,
  secrets,
  audit: createAudit(path.join(CACHE_DIR, 'mcp-audit.jsonl')),
  local,
});
local.integrationsStatus = () => integrations.status();

createServer({
  name: 'zaafpulse',
  title: 'ZAAFPulse',
  version,
  instructions: INSTRUCTIONS,
  listTools: integrations.listTools,
  callTool: integrations.callTool,
  log,
})
  .serve()
  .then(() => otel.shutdown(2000)) // send the spans still queued before the client closes us
  .then(() => process.exit(0));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => otel.shutdown(2000).finally(() => process.exit(0)));
