// Domain agents: a system prompt, routing keywords, an optional model and the tools the agent may
// call (globs over MCP integration tool names, plus the built-in tools). An agent with remoteUrl is a remote
// A2A agent: calls go to that server, and its answers are treated as untrusted data. The 17 templates
// below are seeded on first run and can be edited, disabled, reset or extended from the dashboard.
const ID = /^[a-z0-9-]{1,40}$/;

const T = (id, name, domain, description, keywords, tools, focus) => ({
  id,
  name,
  domain,
  description,
  keywords,
  tools,
  model: '',
  enabled: true,
  template: true,
  knowledge: [],
  collaborate: true,
  systemPrompt: `You are the ${name} agent in ZAAFPulse, a ${domain} specialist. ${focus} Be concrete and brief. Use your tools when they give real data; never invent numbers. Save durable facts the user will need later with zp_memory_save. If the task is outside your domain, say which agent should handle it.`,
});

const TEMPLATES = [
  T(
    'customer-service',
    'Customer Service',
    'customer service',
    'Answers customer questions, drafts replies, handles complaints and refunds policy.',
    ['customer', 'complaint', 'refund', 'ticket', 'reply', 'pelanggan', 'keluhan'],
    [],
    'Reply with empathy, restate the issue, give the next step and a ready-to-send message.',
  ),
  T(
    'sales-marketing',
    'Sales & Marketing',
    'sales and marketing',
    'Prospecting, outreach copy, campaigns, positioning and pipeline questions.',
    ['sales', 'lead', 'prospect', 'campaign', 'marketing', 'pipeline', 'outreach', 'penjualan'],
    [],
    'Tie every recommendation to a buyer, a pain and a measurable outcome.',
  ),
  T(
    'network-ops',
    'Network Operations',
    'network and infrastructure operations',
    'Incidents, latency, connectivity, monitoring and capacity of networks and services.',
    ['network', 'latency', 'outage', 'incident', 'dns', 'bandwidth', 'connectivity', 'jaringan'],
    ['dynatrace*', 'acc_live_apps', 'acc_integrations_status'],
    'Start from symptoms and evidence, isolate the layer, and propose the smallest safe fix with rollback.',
  ),
  T(
    'hr-finance',
    'HR & Finance',
    'HR and finance',
    'Policies, payroll questions, budgets, expenses and financial summaries.',
    ['hr', 'payroll', 'leave', 'budget', 'expense', 'invoice', 'finance', 'cuti', 'gaji', 'anggaran'],
    ['acc_usage_summary'],
    'Be precise with numbers and policies; flag anything that needs a human approver.',
  ),
  T(
    'it-helpdesk',
    'IT Helpdesk',
    'IT support',
    'Laptop, accounts, access, software and device troubleshooting.',
    ['laptop', 'password', 'access', 'install', 'vpn', 'printer', 'wifi', 'error'],
    ['acc_live_apps'],
    'Give numbered steps a non-technical user can follow, from the most likely cause.',
  ),
  T(
    'sre-observability',
    'SRE & Observability',
    'site reliability and observability',
    'SLOs, alerts, traces, logs and root cause from monitoring data.',
    ['slo', 'alert', 'trace', 'log', 'error rate', 'root cause', 'observability', 'dynatrace'],
    ['dynatrace*', 'phoenix*', 'arize*'],
    'Correlate signals over time, name the probable root cause and the evidence for it.',
  ),
  T(
    'security',
    'Security',
    'security',
    'Threats, vulnerabilities, access reviews and safe configuration.',
    ['security', 'vulnerability', 'cve', 'threat', 'phishing', 'access review', 'keamanan'],
    ['dynatrace*_security*', 'acc_quality'],
    'Rate severity, explain exploitability and give the remediation order.',
  ),
  T(
    'data-analyst',
    'Data Analyst',
    'data analysis',
    'Metrics, trends, comparisons and explaining numbers.',
    ['data', 'metric', 'trend', 'analysis', 'report', 'dashboard', 'kpi', 'analisa'],
    ['acc_usage_summary', 'acc_quality'],
    'State the finding first, then the numbers and the caveats.',
  ),
  T(
    'devops',
    'DevOps',
    'DevOps and delivery',
    'CI/CD, deployments, containers, automation and workflows.',
    ['deploy', 'pipeline', 'ci', 'docker', 'kubernetes', 'workflow', 'automation', 'n8n'],
    ['n8n*'],
    'Prefer reversible changes and show the exact commands or workflow steps.',
  ),
  T(
    'code-reviewer',
    'Code Reviewer',
    'software engineering',
    'Reviews code and designs for bugs, clarity and risk.',
    ['code', 'bug', 'review', 'refactor', 'function', 'api', 'kode'],
    [],
    'List issues by severity with the fix; do not rewrite what is fine.',
  ),
  T(
    'research',
    'Research',
    'research',
    'Market, competitor and technology research with sources.',
    ['research', 'compare', 'competitor', 'market', 'study', 'riset'],
    ['openrouter_rankings', 'openrouter_list_models'],
    'Separate facts from assumptions and cite where each fact came from.',
  ),
  T(
    'legal-compliance',
    'Legal & Compliance',
    'legal and compliance',
    'Contracts, regulations (PDP, ISO, OJK), and policy checks.',
    ['contract', 'legal', 'compliance', 'regulation', 'gdpr', 'pdp', 'ojk', 'iso', 'kontrak'],
    [],
    'Point to the clause or rule, the risk and the change; note this is not legal advice.',
  ),
  T(
    'product-manager',
    'Product Manager',
    'product management',
    'Requirements, roadmaps, prioritization and user stories.',
    ['feature', 'roadmap', 'requirement', 'user story', 'prioritize', 'product', 'produk'],
    [],
    'Frame the problem, the user, the success metric and the smallest valuable slice.',
  ),
  T(
    'project-manager',
    'Project Manager',
    'project management',
    'Plans, timelines, risks, status updates and follow-ups.',
    ['plan', 'timeline', 'milestone', 'risk', 'status', 'deadline', 'jadwal'],
    [],
    'Give owners, dates and the critical path; flag blockers early.',
  ),
  T(
    'procurement',
    'Procurement',
    'procurement and vendors',
    'Vendor comparison, RFPs, pricing and contract terms.',
    ['vendor', 'rfp', 'quote', 'procurement', 'supplier', 'pricing', 'pengadaan'],
    ['openrouter_list_models'],
    'Compare on total cost, risk and fit, then recommend one.',
  ),
  T(
    'content-writer',
    'Content Writer',
    'writing and communication',
    'Emails, posts, docs and summaries in a clear voice.',
    ['write', 'email', 'post', 'summary', 'draft', 'article', 'tulis'],
    [],
    'Match the audience and length; give the finished text, not advice about it.',
  ),
  T(
    'ai-ops',
    'AI Ops',
    'AI usage, cost and model choice',
    'AI spend, model selection, provider reliability and agent quality.',
    ['model', 'llm', 'token', 'cost', 'ai', 'agent', 'prompt', 'openrouter'],
    ['acc_*', 'openrouter_*', 'omniroute_*'],
    'Use real usage and price data; recommend models by quality per dollar.',
  ),
];

const { originOf } = require('../secrets');
const REMOTE_TOKEN_ENV = /^ZP_SECRET_[A-Z0-9_]{1,60}$/;

function cleanAgent(input = {}, existing = null) {
  const errors = [];
  const id = String(input.id || '').trim();
  if (!ID.test(id)) errors.push('id: 1-40 lowercase letters, digits or dashes');
  const name = String(input.name || '')
    .trim()
    .slice(0, 60);
  if (!name) errors.push('name is required');
  // A remote agent is another A2A server (JSON-RPC endpoint); its prompt lives there, so none is needed here.
  const remoteUrl = String(input.remoteUrl || '').trim();
  if (remoteUrl && !/^https?:\/\/[^\s]+$/.test(remoteUrl))
    errors.push('remote URL: must start with http:// or https://');
  // The remote agent's token comes from an environment variable named for that purpose (ZP_SECRET_…), and
  // is bound to the address it was set for: it is never sent to a URL the agent was later moved to.
  const remoteTokenEnv = String(input.remoteTokenEnv || '').trim();
  if (remoteTokenEnv && !REMOTE_TOKEN_ENV.test(remoteTokenEnv))
    errors.push('remote token: the name of an environment variable that starts with ZP_SECRET_ (A-Z, 0-9, _)');
  const remoteTokenOrigin = remoteTokenEnv && remoteUrl ? originOf(remoteUrl) : undefined;
  if (
    remoteTokenEnv &&
    existing &&
    existing.remoteTokenEnv === remoteTokenEnv &&
    existing.remoteTokenOrigin &&
    existing.remoteTokenOrigin !== remoteTokenOrigin &&
    input.confirmTokenOrigin !== true
  )
    errors.push('remote token: the address changed; confirm that this token may be sent to the new address');
  const systemPrompt = String(input.systemPrompt || '')
    .trim()
    .slice(0, 8000);
  if (!systemPrompt && !remoteUrl) errors.push('system prompt is required');
  const list = (v) =>
    (Array.isArray(v) ? v : String(v || '').split(','))
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 40);
  return {
    errors,
    value: {
      id,
      name,
      domain: String(input.domain || '').slice(0, 60),
      description: String(input.description || '').slice(0, 300),
      keywords: list(input.keywords),
      tools: list(input.tools),
      model: String(input.model || '')
        .trim()
        .slice(0, 120),
      systemPrompt,
      enabled: input.enabled !== false,
      template: !!(existing && existing.template),
      knowledge: list(input.knowledge),
      collaborate: input.collaborate !== false,
      ...(remoteUrl ? { remoteUrl, remoteTokenEnv, ...(remoteTokenOrigin ? { remoteTokenOrigin } : {}) } : {}),
    },
  };
}

function createAgents(store) {
  const data = () => store.get();
  if (!data().agents.length) {
    data().agents = TEMPLATES.map((t) => ({ ...t }));
    store.save(true);
  }
  return {
    list: () => data().agents,
    get: (id) => data().agents.find((a) => a.id === id),
    enabled: () => data().agents.filter((a) => a.enabled),
    save(input) {
      const existing = data().agents.find((a) => a.id === (input.originalId || input.id));
      const { errors, value } = cleanAgent(input, existing);
      if (errors.length) return { errors };
      if (!existing && data().agents.some((a) => a.id === value.id))
        return { errors: [`an agent called "${value.id}" already exists`] };
      if (existing) Object.assign(existing, value);
      else data().agents.push(value);
      store.save(true);
      return { agent: existing || value };
    },
    remove(id) {
      const before = data().agents.length;
      data().agents = data().agents.filter((a) => a.id !== id);
      store.save(true);
      return before !== data().agents.length;
    },
    reset(id) {
      const t = TEMPLATES.find((x) => x.id === id);
      if (!t) return null;
      const i = data().agents.findIndex((a) => a.id === id);
      if (i >= 0) data().agents[i] = { ...t };
      else data().agents.push({ ...t });
      store.save(true);
      return t;
    },
  };
}

module.exports = { createAgents, cleanAgent, TEMPLATES };
