// Re-exposes the tools of an upstream MCP server (Streamable HTTP) under this integration's
// prefix, filtered by include/exclude globs. A tool counts as a write unless the upstream marks
// it readOnlyHint: true, so it stays hidden without allowWrite.
const { createClient } = require('../mcp/client');
const { authHeaders, timedHealth, RAW } = require('./base');

const TTL = 5 * 60 * 1000;
const glob = (p) =>
  new RegExp(
    '^' +
      String(p)
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );

module.exports = {
  type: 'mcp',
  create(id, cfg, { secrets }) {
    if (typeof cfg.url !== 'string' || !/^https?:\/\//.test(cfg.url))
      throw new Error('url must start with http:// or https://');
    const client = createClient({ url: cfg.url, headers: authHeaders(cfg.auth, secrets), mask: secrets.mask });
    const include = (Array.isArray(cfg.include) && cfg.include.length ? cfg.include : ['*']).map(glob);
    const exclude = (Array.isArray(cfg.exclude) ? cfg.exclude : []).map(glob);
    let cache = null;

    async function tools() {
      if (cache && Date.now() - cache.at < TTL) return cache.list;
      const list = (await client.listTools())
        .filter((t) => include.some((r) => r.test(t.name)) && !exclude.some((r) => r.test(t.name)))
        .map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object' },
          write: !(t.annotations && t.annotations.readOnlyHint === true),
          annotations: t.annotations || {},
          skipCheck: true, // the upstream validates its own arguments
          run: async (args) => {
            const r = await client.callTool(t.name, args);
            return { [RAW]: true, content: (r && r.content) || [], isError: !!(r && r.isError) };
          },
        }));
      cache = { at: Date.now(), list };
      return list;
    }

    return { tools, health: () => timedHealth(async () => `${(await tools()).length} tools`) };
  },
};
