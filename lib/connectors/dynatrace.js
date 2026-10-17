// Dynatrace through the environment API v2, which SaaS and Managed share, plus DQL on Grail
// (SaaS only) when a platform token is configured. Read-only.
const { makeClient, tool, S, timedHealth } = require('./base');

const DQL_BUDGET_MS = 60000;

module.exports = {
  type: 'dynatrace',
  create(id, cfg, { secrets }) {
    const token = secrets.resolve(cfg.token, 'token');
    if (!token) throw new Error('token is required (an API token with problems.read, entities.read, metrics.read, logs.read, securityProblems.read)');
    const api = makeClient({ baseUrl: cfg.baseUrl, headers: { authorization: `Api-Token ${token}` }, mask: secrets.mask });
    const from = S.str('Start of the time frame, e.g. now-2h, now-7d or an ISO time (default now-2h)');

    const tools = [
      tool('list_problems', 'Problems detected by Davis AI, newest first.', {
        from, problemSelector: S.str('e.g. status("open"),severityLevel("ERROR")'),
        entitySelector: S.str('Only problems affecting these entities, e.g. type("SERVICE"),tag("prod")'),
        pageSize: S.int('Max problems (default 50)', 500),
      }, (a) => api('GET', '/api/v2/problems', { query: { from: a.from || 'now-2h', problemSelector: a.problemSelector, entitySelector: a.entitySelector, pageSize: a.pageSize || 50 } })),
      tool('get_problem', 'One problem in full: root cause, impacted entities and evidence.', {
        problemId: S.str('Problem id from list_problems (the UUID-like problemId, not the P-12345 display id)'),
      }, (a) => api('GET', `/api/v2/problems/${encodeURIComponent(a.problemId)}`), { required: ['problemId'] }),
      tool('list_entities', 'Monitored entities matching a selector.', {
        entitySelector: S.str('Exactly one entity type, e.g. type("SERVICE"),tag("prod")'), from,
        fields: S.str('Extra fields, e.g. +properties,+toRelationships'), pageSize: S.int('Max entities (default 50)', 500),
      }, (a) => api('GET', '/api/v2/entities', { query: { entitySelector: a.entitySelector, from: a.from || 'now-2h', fields: a.fields, pageSize: a.pageSize || 50 } }), { required: ['entitySelector'] }),
      tool('query_metrics', 'Metric data points over a time frame.', {
        metricSelector: S.str('e.g. builtin:service.response.time:avg:splitBy("dt.entity.service")'), from,
        resolution: S.str('e.g. 5m, 1h (default: automatic)'), entitySelector: S.str('Only these entities'),
      }, (a) => api('GET', '/api/v2/metrics/query', { query: { metricSelector: a.metricSelector, from: a.from || 'now-2h', resolution: a.resolution, entitySelector: a.entitySelector } }), { required: ['metricSelector'] }),
      tool('query_logs', 'Search log records.', {
        query: S.str('Log search query, e.g. status="ERROR" AND content="timeout"'), from, limit: S.int('Max records (default 100)', 1000),
      }, (a) => api('GET', '/api/v2/logs/search', { query: { query: a.query, from: a.from || 'now-2h', limit: a.limit || 100 } })),
      tool('list_security_problems', 'Vulnerabilities found by Application Security.', {
        securityProblemSelector: S.str('e.g. status("OPEN"),riskLevel("CRITICAL")'), pageSize: S.int('Max items (default 50)', 500),
      }, (a) => api('GET', '/api/v2/securityProblems', { query: { securityProblemSelector: a.securityProblemSelector, pageSize: a.pageSize || 50 } })),
    ];

    if (cfg.platformToken) {
      const platformToken = secrets.resolve(cfg.platformToken, 'platformToken');
      if (!cfg.platformUrl) throw new Error('platformUrl (https://<env>.apps.dynatrace.com) is required with platformToken');
      const platform = makeClient({ baseUrl: cfg.platformUrl, headers: { authorization: `Bearer ${platformToken}` }, mask: secrets.mask });
      tools.push(tool('dql', 'Run a DQL query on Grail (SaaS only), e.g. fetch logs | filter loglevel == "ERROR" | limit 20.', {
        query: S.str('DQL query'), maxResultRecords: S.int('Max records (default 200)', 10000),
      }, async (a) => {
        let r = await platform('POST', '/platform/storage/query/v1/query:execute', { body: { query: a.query, maxResultRecords: a.maxResultRecords || 200, requestTimeoutMilliseconds: 10000 } });
        const requestToken = r && r.requestToken;
        const deadline = Date.now() + DQL_BUDGET_MS;
        while (r && r.state === 'RUNNING' && requestToken && Date.now() < deadline) {
          r = await platform('GET', '/platform/storage/query/v1/query:poll', { query: { 'request-token': requestToken, 'request-timeout-milliseconds': 5000 } });
        }
        if (!r || r.state !== 'SUCCEEDED') throw new Error(`DQL query did not finish (state ${r ? r.state : 'unknown'})`);
        return r.result;
      }, { required: ['query'] }));
    }

    return { tools, health: () => timedHealth(async () => { await api('GET', '/api/v2/problems', { query: { pageSize: 1 } }); }) };
  },
};
