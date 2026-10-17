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
        tool('usage_summary', 'AI usage and API-equivalent cost on this Mac (Claude Code and Codex): spend, tokens, sessions, month projection, top models, projects and costliest sessions.', { range: RANGE }, async ({ range }) => {
          const s = await local.summary(rangeOf(range));
          return {
            range: s.range, kpis: s.kpis,
            month: { projected: s.month.projected, daysElapsed: s.month.daysElapsed, daysInMonth: s.month.daysInMonth },
            tools: s.tools, topModels: s.models.slice(0, 8), topProjects: s.projects.slice(0, 8),
            topCostSessions: s.topCostSessions, unpriced: s.unpriced,
          };
        }),
        tool('quality', 'Quality and safety signals from local AI logs: tool-call accuracy, hallucination signals, prompt-injection detections, corrections, secrets and risky commands.', { range: RANGE }, async ({ range }) => {
          const { events, feed, daily, ...q } = (await local.summary(rangeOf(range))).quality;
          return q;
        }),
        tool('live_apps', 'AI apps running on this Mac right now, with CPU, memory and uptime.', {}, () => local.liveApps()),
        tool('integrations_status', 'Every configured integration with its state (ok, error, disabled, unchecked), latency, tool count and whether write tools are on. Call this first.', {}, () => local.integrationsStatus()),
      ],
    };
  },
};
