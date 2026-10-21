// The dashboard's own numbers as tools: spend, quality and the AI apps running right now.
const { tool } = require('./base');

const RANGE = { type: 'string', enum: ['7', '30', '90', 'all'], description: 'Days to cover, or all (default 30)' };
const rangeOf = (r) => (r === 'all' ? 'all' : Number(r || 30));

module.exports = {
  type: 'acc',
  create(id, cfg, { local }) {
    return {
      health: async () => ({ ok: true, latencyMs: 0, detail: 'local' }),
      tools: [
        tool(
          'usage_summary',
          'AI usage and API-equivalent cost on this machine (Claude Code and Codex): spend, tokens, sessions, month projection, top models, projects and costliest sessions.',
          { range: RANGE },
          async ({ range }) => {
            const s = await local.summary(rangeOf(range));
            return {
              range: s.range,
              kpis: s.kpis,
              month: {
                projected: s.month.projected,
                daysElapsed: s.month.daysElapsed,
                daysInMonth: s.month.daysInMonth,
              },
              tools: s.tools,
              topModels: s.models.slice(0, 8),
              topProjects: s.projects.slice(0, 8),
              topCostSessions: s.topCostSessions,
              unpriced: s.unpriced,
            };
          },
        ),
        tool(
          'quality',
          'Quality and safety signals from local AI logs: tool-call accuracy, hallucination signals, prompt-injection detections, corrections, secrets and risky commands.',
          { range: RANGE },
          async ({ range }) => {
            const { events, feed, daily, ...q } = (await local.summary(rangeOf(range))).quality;
            return q;
          },
        ),
        tool('live_apps', 'AI apps running on this machine right now, with CPU, memory and uptime.', {}, () =>
          local.liveApps(),
        ),
        tool(
          'trace_sessions',
          'The latest agent sessions (Claude Code, Codex, Kiro, Gemini CLI, Antigravity) as metadata only: key, source, title, project, start, end, turns, tools, errors, cost and flags. No transcript text, file paths or content ids. Keys are made per process and are valid only for this ZAAFPulse process, so do not keep them. Titles of Kiro, Gemini CLI and Antigravity sessions come from their logs and are null when ZAAFPULSE_CONTENT=off, always null over the gateway /mcp endpoint, and always null for Claude Code and Codex.',
          {
            range: RANGE,
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              description: 'How many sessions, newest first (default 50)',
            },
          },
          ({ range, limit }) => local.traceSessions({ range: rangeOf(range), limit }),
        ),
        tool(
          'evals',
          'Local eval results as ids and labels only: for each evaluator its kind (code or judge), pass rate and the number of results, and the latest 20 failures (session key, source, turn, evaluator, label, time). No explanations, no transcript text and no file paths. Read-only: it reads the results file and never starts a judge. Session keys are made per process and are valid only for this ZAAFPulse process, so do not keep them.',
          { range: RANGE },
          ({ range }) => local.evals({ range: rangeOf(range) }),
        ),
        tool(
          'integrations_status',
          'Every configured integration with its state (ok, error, disabled, unchecked), latency, tool count and whether write tools are on. Call this first.',
          {},
          () => local.integrationsStatus(),
        ),
      ],
    };
  },
};
