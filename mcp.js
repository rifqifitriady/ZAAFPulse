#!/usr/bin/env node
// MCP server for AI Command Center. AI clients (Claude Code, Kiro, Antigravity) start it over
// stdio with `node mcp.js`. It exposes the dashboard's own data plus every integration
// configured in config.json. stdout carries protocol messages only; logs go to stderr.
const fs = require('fs');
const path = require('path');
const { createServer } = require('./lib/mcp/protocol');
const { createIntegrations } = require('./lib/integrations');
const { createSecrets } = require('./lib/secrets');
const { createAudit } = require('./lib/audit');
const { createLocal } = require('./lib/local');
const { version } = require('./package.json');

const DIR = __dirname;
const CONFIG_FILE = process.env.ACC_CONFIG || path.join(DIR, 'config.json');
const CACHE_DIR = process.env.ACC_CACHE_DIR || path.join(DIR, '.cache');
const log = (m) => process.stderr.write(`[ai-command-center] ${m}\n`);

const INSTRUCTIONS = 'AI Command Center on this Mac. Tool names are prefixed with an integration id: acc_* reads local AI usage, cost, quality and running apps; other prefixes reach the platforms configured in config.json (Dynatrace, Arize, n8n, AI routers, HTTP APIs, upstream MCP servers). Call acc_integrations_status first to see what is connected. Write tools only appear for integrations with allowWrite enabled.';

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') log(`config.json is unreadable, starting with defaults: ${err.message}`); }

const secrets = createSecrets();
const local = createLocal({ cacheDir: CACHE_DIR, config });
const integrations = createIntegrations({ config, secrets, audit: createAudit(path.join(CACHE_DIR, 'mcp-audit.jsonl')), local });
local.integrationsStatus = () => integrations.status();

createServer({ name: 'ai-command-center', version, instructions: INSTRUCTIONS, listTools: integrations.listTools, callTool: integrations.callTool, log })
  .serve()
  .then(() => process.exit(0));
