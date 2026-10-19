// n8n through its public REST API (header X-N8N-API-KEY). The public API has no "run" endpoint,
// so running a workflow goes through a webhook that must be allowlisted in config.
const { makeClient, tool, S, timedHealth } = require('./base');

const enc = encodeURIComponent;
const summarize = (w) => ({
  id: w.id,
  name: w.name,
  active: w.active,
  tags: (w.tags || []).map((t) => t.name),
  updatedAt: w.updatedAt,
});

module.exports = {
  type: 'n8n',
  create(id, cfg, { secrets }) {
    const key = secrets.resolve(cfg.apiKey, 'apiKey');
    if (!key) throw new Error('apiKey is required (n8n Settings → n8n API)');
    const api = makeClient({ baseUrl: cfg.baseUrl, headers: { 'x-n8n-api-key': key }, mask: secrets.mask });
    const hooks = cfg.webhooks && typeof cfg.webhooks === 'object' ? cfg.webhooks : {};
    for (const [name, url] of Object.entries(hooks)) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url))
        throw new Error(`webhooks.${name} must be an http(s) URL`);
    }
    const hookClient = makeClient({ baseUrl: cfg.baseUrl, mask: secrets.mask }); // webhooks never get the API key

    const tools = [
      tool(
        'list_workflows',
        'Workflows with their active state and tags.',
        {
          active: S.bool('Only active (true) or inactive (false) workflows'),
          tags: S.str('Comma-separated tag names'),
          name: S.str('Filter by name'),
          limit: S.int('Max workflows (default 50)', 250),
        },
        async (a) => {
          const r = await api('GET', '/api/v1/workflows', {
            query: { active: a.active, tags: a.tags, name: a.name, limit: a.limit || 50 },
          });
          return { workflows: ((r && r.data) || []).map(summarize), nextCursor: (r && r.nextCursor) || null };
        },
      ),
      tool(
        'get_workflow',
        'One workflow: its nodes (name and type, never credentials) and settings.',
        { id: S.str('Workflow id') },
        async (a) => {
          const w = await api('GET', `/api/v1/workflows/${enc(a.id)}`);
          return {
            ...summarize(w),
            nodes: (w.nodes || []).map((n) => ({ name: n.name, type: n.type, disabled: !!n.disabled })),
            settings: w.settings || {},
          };
        },
        { required: ['id'] },
      ),
      tool(
        'list_executions',
        'Recent executions, newest first.',
        {
          workflowId: S.str('Only this workflow'),
          status: S.enum(['success', 'error', 'waiting', 'running', 'canceled'], 'Only this status'),
          limit: S.int('Max executions (default 20)', 250),
        },
        async (a) => {
          const r = await api('GET', '/api/v1/executions', {
            query: { workflowId: a.workflowId, status: a.status, limit: a.limit || 20 },
          });
          return { executions: (r && r.data) || [], nextCursor: (r && r.nextCursor) || null };
        },
      ),
      tool(
        'get_execution',
        'One execution. Node data is left out unless includeData is true.',
        {
          id: S.str('Execution id'),
          includeData: S.bool('Include node input and output data (can be large)'),
        },
        (a) =>
          api('GET', `/api/v1/executions/${enc(a.id)}`, { query: { includeData: a.includeData ? 'true' : undefined } }),
        { required: ['id'] },
      ),
    ];

    const names = Object.keys(hooks);
    if (names.length) {
      tools.push(
        tool(
          'run_workflow',
          `Trigger a workflow through an allowlisted webhook. Available: ${names.join(', ')}.`,
          {
            name: S.enum(names, 'Webhook name from config'),
            payload: S.obj('JSON body sent to the webhook'),
          },
          async (a) => {
            const url = hooks[a.name];
            if (!url) throw new Error(`"${a.name}" is not in the webhooks allowlist`);
            return hookClient('POST', `webhook ${a.name}`, { url, body: a.payload || {} });
          },
          {
            required: ['name'],
            write: true,
            annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
          },
        ),
      );
    }
    tools.push(
      tool(
        'set_workflow_active',
        'Activate or deactivate a workflow.',
        {
          id: S.str('Workflow id'),
          active: S.bool('true to activate, false to deactivate'),
        },
        async (a) =>
          summarize(await api('POST', `/api/v1/workflows/${enc(a.id)}/${a.active ? 'activate' : 'deactivate'}`)),
        { required: ['id', 'active'], write: true, annotations: { destructiveHint: false, idempotentHint: true } },
      ),
    );

    return {
      tools,
      health: () =>
        timedHealth(async () => {
          await api('GET', '/api/v1/workflows', { query: { limit: 1 } });
        }),
    };
  },
};
