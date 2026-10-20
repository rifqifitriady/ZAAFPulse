// Builds one connector per config.integrations entry and exposes them as a single tool list.
// Tool names are prefixed with the integration id, write tools need allowWrite, arguments are
// checked against each tool's schema, results are capped, and every call is audited.
// A broken integration is reported in status, never fatal: it simply contributes no tools.
const { RAW } = require('./connectors/base');
const otel = require('./otel');

const ID = /^[a-z0-9-]{1,32}$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_RESULT = 50 * 1024;
const HEALTH_TTL = 60 * 1000;

// Filled in as connector modules are added; tests pass their own map.
const DEFAULT_CONNECTORS = {};
for (const file of ['acc', 'dynatrace', 'arize', 'n8n', 'router', 'http', 'mcp-proxy', 'openrouter']) {
  try {
    const m = require(`./connectors/${file}`);
    DEFAULT_CONNECTORS[m.type] = m;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
  }
}

function cap(text) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_RESULT) return text;
  return (
    Buffer.from(text).subarray(0, MAX_RESULT).toString('utf8') +
    `\n…[truncated: ${Math.round(bytes / 1024)} KB result cut to 50 KB; narrow the query]`
  );
}
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
function okResult(value) {
  if (value && value[RAW]) {
    return {
      content: (value.content || []).map((c) => (c.type === 'text' ? { ...c, text: cap(String(c.text)) } : c)),
      isError: !!value.isError,
    };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: 'text', text: cap(text) }] };
}

function checkArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const props = (schema && schema.properties) || {};
  for (const r of (schema && schema.required) || [])
    if (args[r] === undefined) return `missing required argument "${r}"`;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) {
      if (schema.additionalProperties === false) return `unknown argument "${k}"`;
      continue;
    }
    const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const fits = !p.type || p.type === type || (p.type === 'integer' && Number.isInteger(v));
    if (!fits) return `argument "${k}" must be ${p.type}`;
    if (p.enum && !p.enum.includes(v)) return `argument "${k}" must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

function createIntegrations({
  config = {},
  secrets,
  audit = null,
  local = null,
  connectors = DEFAULT_CONNECTORS,
  now = Date.now,
}) {
  const entries = [];
  const healthCache = new Map();

  function add(id, cfg) {
    const e = {
      id,
      type: cfg.type,
      flavor: cfg.flavor,
      enabled: cfg.enabled !== false,
      allowWrite: cfg.allowWrite === true,
      error: null,
      connector: null,
    };
    entries.push(e);
    if (!e.enabled) return;
    try {
      if (!ID.test(id)) throw new Error('id must match [a-z0-9-]{1,32}');
      const mod = connectors[cfg.type];
      if (!mod) throw new Error(`unknown type "${cfg.type}"`);
      e.connector = mod.create(id, cfg, { secrets, local });
    } catch (err) {
      e.error = secrets.mask(err.message);
    }
  }
  add('acc', { type: 'acc' });
  for (const [id, cfg] of Object.entries(config.integrations || {})) {
    if (id !== 'acc') add(id, cfg && typeof cfg === 'object' ? cfg : {});
  }

  async function toolsOf(e) {
    if (!e.connector) return [];
    let list;
    try {
      list = typeof e.connector.tools === 'function' ? await e.connector.tools() : e.connector.tools;
    } catch (err) {
      e.listError = secrets.mask(err.message);
      return [];
    }
    e.listError = null;
    const sep = e.type === 'mcp' ? '__' : '_';
    return (list || [])
      .filter((t) => e.allowWrite || !t.write)
      .map((t) => ({ ...t, fullName: `${e.id}${sep}${t.name}`, entry: e }))
      .filter((t) => TOOL_NAME.test(t.fullName));
  }
  const allTools = async () => (await Promise.all(entries.map(toolsOf))).flat();

  async function listTools() {
    return (await allTools()).map((t) => ({
      name: t.fullName,
      ...(t.title ? { title: t.title } : {}),
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object' },
      // Our own read/write flag wins over whatever an upstream MCP server says about its tool.
      annotations: { ...(t.annotations || {}), readOnlyHint: !t.write },
    }));
  }

  async function callTool(name, args = {}) {
    const t = (await allTools()).find((x) => x.fullName === name);
    if (!t) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    const problem = t.skipCheck ? null : checkArgs(t.inputSchema, args);
    if (problem) return { result: errorResult(problem) };
    const started = now();
    const span = otel.toolCall(name, t.entry, args);
    let ok = true;
    let result;
    try {
      result = okResult(await t.run(args));
    } catch (err) {
      ok = false;
      result = errorResult(secrets.mask(err.message));
    }
    if (result.isError) ok = false;
    span.end(ok, result);
    if (audit)
      audit.record({
        ts: started,
        integration: t.entry.id,
        tool: name,
        ok,
        ms: now() - started,
        args: Object.keys(args || {}),
      });
    return { result };
  }

  async function health(e, fresh) {
    if (!e.enabled) return { state: 'disabled' };
    if (!e.connector) return { state: 'error', error: e.error };
    const cached = healthCache.get(e.id);
    if (!fresh && cached && now() - cached.at < HEALTH_TTL) return cached.value;
    let value;
    if (!e.connector.health) value = { state: 'unchecked' };
    else {
      const h = await e.connector.health();
      if (h.ok === null) value = { state: 'unchecked', ...(h.detail ? { detail: h.detail } : {}) };
      else if (h.ok) value = { state: 'ok', latencyMs: h.latencyMs, ...(h.detail ? { detail: h.detail } : {}) };
      else value = { state: 'error', latencyMs: h.latencyMs, error: secrets.mask(h.error) };
    }
    healthCache.set(e.id, { at: now(), value });
    return value;
  }

  async function status({ fresh = false, only } = {}) {
    const list = only ? entries.filter((e) => e.id === only) : entries;
    return Promise.all(
      list.map(async (e) => {
        const tools = await toolsOf(e);
        const h = await health(e, fresh);
        const out = {
          id: e.id,
          type: e.type,
          ...(e.flavor ? { flavor: e.flavor } : {}),
          enabled: e.enabled,
          allowWrite: e.allowWrite,
          tools: tools.length,
          writeTools: tools.filter((t) => t.write).length,
          ...h,
        };
        if (h.state === 'ok' && e.listError) Object.assign(out, { state: 'error', error: e.listError });
        return out;
      }),
    );
  }

  return { listTools, callTool, status };
}

module.exports = { createIntegrations, checkArgs, DEFAULT_CONNECTORS };
