// Arize AI observability, read-only. Two flavors:
//   phoenix: open-source Phoenix or Phoenix Cloud, REST /v1 (key optional for local instances)
//   ax:      Arize AX cloud, REST /v2 (Authorization: Bearer <api key>)
const { makeClient, tool, S, timedHealth } = require('./base');

const enc = encodeURIComponent;
const since = S.str('ISO 8601 start time, e.g. 2026-10-17T00:00:00Z');
const until = S.str('ISO 8601 end time');

function phoenixTools(api) {
  const project = S.str('Project name or id, e.g. default');
  return [
    tool(
      'list_projects',
      'Phoenix projects.',
      { name_contains: S.str('Only names containing this text'), limit: S.int('Max projects (default 50)', 1000) },
      (a) => api('GET', '/v1/projects', { query: { name_contains: a.name_contains, limit: a.limit || 50 } }),
    ),
    tool(
      'search_spans',
      'Spans of a project, newest first, filtered by time, name, kind or status.',
      {
        project,
        start_time: since,
        end_time: until,
        name: S.str('Span name'),
        span_kind: S.str('e.g. LLM, CHAIN, TOOL, RETRIEVER'),
        status_code: S.enum(['OK', 'ERROR', 'UNSET'], 'Span status'),
        trace_id: S.str('Only this trace'),
        limit: S.int('Max spans (default 50)', 1000),
      },
      (a) => {
        const { project: p, ...q } = a;
        return api('GET', `/v1/projects/${enc(p)}/spans`, { query: { ...q, limit: q.limit || 50 } });
      },
      { required: ['project'] },
    ),
    tool(
      'list_traces',
      'Traces of a project, newest first.',
      {
        project,
        start_time: since,
        end_time: until,
        error: S.bool('Only traces with an error'),
        min_latency_ms: S.num('Only traces slower than this'),
        filter: S.str('Phoenix filter expression'),
        limit: S.int('Max traces (default 20)', 1000),
      },
      (a) => {
        const { project: p, ...q } = a;
        return api('GET', `/v1/projects/${enc(p)}/traces`, { query: { ...q, limit: q.limit || 20 } });
      },
      { required: ['project'] },
    ),
    tool(
      'list_datasets',
      'Datasets.',
      { name: S.str('Filter by name'), limit: S.int('Max datasets (default 50)', 1000) },
      (a) => api('GET', '/v1/datasets', { query: { name: a.name, limit: a.limit || 50 } }),
    ),
    tool(
      'list_experiments',
      'Experiments run on a dataset.',
      { dataset_id: S.str('Dataset id from list_datasets'), limit: S.int('Max experiments (default 50)', 1000) },
      (a) => api('GET', `/v1/datasets/${enc(a.dataset_id)}/experiments`, { query: { limit: a.limit || 50 } }),
      { required: ['dataset_id'] },
    ),
  ];
}

function axTools(api) {
  const space = S.str('Space id (default: every space the key can read)');
  const search = (path) => (a) => {
    const { limit, ...body } = a;
    return api('POST', path, { query: { limit: limit || 50 }, body });
  };
  const spanProps = {
    project_id: S.str('Project id from list_projects'),
    start_time: since,
    end_time: until,
    filter: S.str("Filter expression, e.g. status_code = 'ERROR' or span_kind = 'LLM'"),
  };
  return [
    tool(
      'list_projects',
      'Arize AX projects (LLM applications being traced).',
      { space_id: space, name: S.str('Name search'), limit: S.int('Max projects (default 50)', 100) },
      (a) => api('GET', '/v2/projects', { query: { space_id: a.space_id, name: a.name, limit: a.limit || 50 } }),
    ),
    tool(
      'search_spans',
      'Spans of a project, newest first.',
      { ...spanProps, limit: S.int('Max spans (default 50)', 500) },
      search('/v2/spans'),
      { required: ['project_id'] },
    ),
    tool(
      'list_traces',
      'Traces that contain at least one span matching the filter.',
      { ...spanProps, limit: S.int('Max traces (default 20)', 50) },
      search('/v2/traces'),
      { required: ['project_id'] },
    ),
    tool(
      'list_datasets',
      'Datasets.',
      { space_id: space, name: S.str('Name search'), limit: S.int('Max datasets (default 50)', 100) },
      (a) => api('GET', '/v2/datasets', { query: { space_id: a.space_id, name: a.name, limit: a.limit || 50 } }),
    ),
    tool(
      'list_experiments',
      'Experiments.',
      { dataset_id: S.str('Only this dataset'), space_id: space, limit: S.int('Max experiments (default 50)', 100) },
      (a) =>
        api('GET', '/v2/experiments', {
          query: { dataset_id: a.dataset_id, space_id: a.space_id, limit: a.limit || 50 },
        }),
    ),
    tool(
      'list_monitors',
      'Monitors and their status.',
      { space_id: space, project_id: S.str('Only this project'), name: S.str('Name search') },
      (a) => api('GET', '/v2/monitors', { query: a }),
    ),
  ];
}

module.exports = {
  type: 'arize',
  create(id, cfg, { secrets }) {
    const flavor = cfg.flavor || 'phoenix';
    if (!['phoenix', 'ax'].includes(flavor)) throw new Error('flavor must be "phoenix" or "ax"');
    const key = secrets.resolve(cfg.apiKey, 'apiKey');
    if (flavor === 'ax' && !key) throw new Error('apiKey is required for Arize AX');
    const api = makeClient({
      baseUrl: cfg.baseUrl || (flavor === 'ax' ? 'https://api.arize.com' : 'http://localhost:6006'),
      headers: key ? { authorization: `Bearer ${key}` } : {},
      mask: secrets.mask,
    });
    const healthPath = flavor === 'ax' ? '/v2/projects' : '/v1/projects';
    return {
      tools: flavor === 'ax' ? axTools(api) : phoenixTools(api),
      health: () =>
        timedHealth(async () => {
          await api('GET', healthPath, { query: { limit: 1 } });
        }),
    };
  },
};
