'use strict';
/* Gateway page: ZAAFPulse as an Agent Gateway. Overview (3D architecture + usage), API keys,
   LLM providers, domain agents, sessions & memory, a playground and connection snippets. */

const GW_COPY = {
  '': [
    'Agent Gateway',
    'API keys, rate limits and sessions in front of every model, an orchestrator that plans and routes, and domain agents with your tools.',
  ],
  keys: ['API keys', 'Who may call the gateway: scopes, allowed models and agents, budgets, rate limits and expiry.'],
  providers: [
    'Providers',
    'OpenAI-compatible LLM providers behind the gateway: local Ollama and LM Studio, or any hosted API.',
  ],
  agents: [
    'Domain agents',
    'Specialists the orchestrator routes to, each with its prompt, model, tools and knowledge, and able to consult each other.',
  ],
  tools: [
    'Code tools',
    'Claude Code, Codex, Gemini CLI, OpenCode, Cline, Copilot and more on any provider: each in its own wire format, translated here.',
  ],
  router: [
    'Model router',
    'Private LLMs on your hardware, GPU serving, approved external models, and virtual models that fall back across targets.',
  ],
  knowledge: [
    'Knowledge (RAG)',
    'Knowledge bases with document ingestion and a local vector database; agents search them with zp_knowledge_search.',
  ],
  workflows: ['Workflows', 'Agent-to-agent pipelines: each step hands its output to the next specialist.'],
  sessions: ['Sessions & memory', 'Conversations kept per key, and the notes agents remember between them.'],
  playground: [
    'Playground',
    'Try the orchestrator, an agent or a model, or replay a dataset. Every run spends tokens on the provider you picked.',
  ],
  connect: ['Connect', 'Point any OpenAI SDK, script or MCP client at ZAAFPulse.'],
};
const gw = {
  data: null,
  logs: null,
  newSecret: null,
  editingAgent: null,
  editingProvider: null,
  viewSession: null,
  editingRoute: null,
  kbOpen: null,
  kbSearch: null,
  editingWf: null,
  wfRun: null,
  pg: {
    mode: 'orchestrate',
    agent: 'customer-service',
    model: '',
    input: '',
    sessionId: null,
    busy: false,
    result: null,
  },
};
const GW_BASE = `${location.origin}/v1`;
const gwPost = (route, body) =>
  api(`/api/gateway/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const errList = (errs) =>
  errs && errs.length
    ? `<div class="ie-result bad"><b>Fix these first</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
// zp_Q7m_kR2p…T4vX → zp_Q7m_k••••••••••••T4vX: enough to recognise, never enough to use.
const maskKey = (k) => `${k.slice(0, 7)}${'•'.repeat(12)}${k.slice(-4)}`;
let gwMaskTimer = null;
function forgetSecret() {
  if (!gw.newSecret) return;
  gw.maskedSecret = maskKey(gw.newSecret);
  gw.newSecret = null;
  clearTimeout(gwMaskTimer);
  const pre = $('#gw-new-secret');
  if (pre && GW_ROUTES.includes(state.route)) paintGateway();
}
const codeBlock = (text, id) =>
  `<div class="gw-code"><button class="btn ghost gw-copy" type="button" data-gwcopy="${id}">Copy</button><pre id="${id}">${esc(text)}</pre></div>`;

// Three menus share this module: Agent Gateway (#gateway), RAG Service (#rag) and Agent-to-Agent (#a2a).
const GW_ROUTES = ['gateway', 'rag', 'a2a', 'endpoint', 'skills'];
const SECTION = {
  gateway: {
    eyebrow: 'AGENT GATEWAY',
    copy: (sub) => GW_COPY[sub] || GW_COPY[''],
    pages: { '': gwOverview, providers: gwProviders, router: gwRouter, sessions: gwSessions, playground: gwPlayground },
  },
  endpoint: {
    eyebrow: 'ENDPOINT',
    copy: (sub) => ENDPOINT_COPY[sub] || ENDPOINT_COPY[''],
    pages: { '': endpointOverview, keys: gwKeys, mcp: endpointMcp, connect: gwConnect, tools: gwTools },
  },
  skills: {
    eyebrow: 'AGENT SKILLS',
    copy: () => [
      'ZAAFPulse skills',
      'Skills teach AI agents to use ZAAFPulse. They are served by this gateway and can be installed into Claude Code.',
    ],
    pages: { '': skillsPage },
  },
  rag: {
    eyebrow: 'RAG SERVICE',
    copy: (sub) => RAG_COPY[sub] || RAG_COPY[''],
    pages: { '': gwKnowledge, connect: ragConnect },
  },
  a2a: {
    eyebrow: 'AGENT-TO-AGENT',
    copy: (sub) => A2A_COPY[sub] || A2A_COPY[''],
    pages: {
      '': gwWorkflows,
      collaborate: a2aCollaborate,
      runs: a2aRuns,
      agents: gwAgents,
      collaboration: a2aCollaboration,
    },
  },
};
const RAG_COPY = {
  '': [
    'RAG Service',
    'Knowledge bases with document ingestion and a local vector database. Agents answer from them with zp_knowledge_search.',
  ],
  connect: [
    'API & usage',
    'Search knowledge bases and add documents from your own apps with a key that has the rag scope.',
  ],
};
const A2A_COPY = {
  '': ['Agent-to-Agent', 'Workflow automation: saved pipelines where each specialist hands its output to the next.'],
  collaborate: [
    'Collaborate',
    'Multi-agent runs: orchestrator, parallel specialists, sample & vote, debate, review loop, group chat and handoff, with budgets and a live trace.',
  ],
  runs: [
    'Runs',
    'Every collaboration run from the dashboard, the API and A2A clients: state, verdict, budget and trace.',
  ],
  agents: ['Specialist agents', 'The domain agents that workflows, the orchestrator and other agents call on.'],
  collaboration: [
    'Collaboration',
    'How agents work together: patterns, guards, who may consult whom, and the A2A protocol endpoint.',
  ],
};
const ENDPOINT_COPY = {
  '': [
    'Endpoint',
    'Everything that connects to ZAAFPulse: the API and its keys, the MCP server, connection snippets and AI coding tools.',
  ],
  keys: ['API keys', 'Who may call the gateway: scopes, allowed models and agents, budgets, rate limits and expiry.'],
  mcp: [
    'MCP server',
    'ZAAFPulse as an MCP server: registered in your AI clients (stdio) and reachable over HTTP with a key.',
  ],
  connect: ['Connect', 'Point any OpenAI SDK, script or MCP client at ZAAFPulse.'],
  tools: [
    'Code tools',
    'Claude Code, Codex, Gemini CLI, OpenCode, Cline, Copilot and more on any provider: each in its own wire format, translated here.',
  ],
};
// Old Agent Gateway tabs that moved to their own menus.
const MOVED = {
  knowledge: '#rag',
  workflows: '#a2a',
  agents: '#a2a/agents',
  keys: '#endpoint/keys',
  connect: '#endpoint/connect',
  tools: '#endpoint/tools',
};

function viewGatewaySection(route) {
  const sec = SECTION[route];
  const [title, copy] = sec.copy(state.sub || '');
  return `<div class="holo-deck">${subTabs(route)}${subHero(`${sec.eyebrow}${state.sub ? ' · ' + title.toUpperCase() : ''}`, title, copy, `<span class="pill">${icon('shield', 14)}${esc(localOnlyLabel())}</span>`)}<div id="gw-body">${'<div class="skeleton" style="height:140px"></div>'.repeat(2)}</div></div>`;
}
const viewGateway = () => viewGatewaySection('gateway');
const viewRag = () => viewGatewaySection('rag');
const viewA2a = () => viewGatewaySection('a2a');
const viewEndpoint = () => viewGatewaySection('endpoint');
// Agent Skills: ZAAFPulse's own skills, and (Usage) the subagents, skills and tools your AI tools use.
const viewSkillsPage = () =>
  state.sub === 'usage'
    ? viewAgents().replace('<div class="holo-deck">', `<div class="holo-deck">${subTabs('skills')}`)
    : viewGatewaySection('skills');

async function mountGateway() {
  if (state.route === 'gateway' && MOVED[location.hash.split('/')[1] || '']) {
    location.replace(MOVED[location.hash.split('/')[1]]);
    return;
  }
  try {
    gw.data = await api('/api/gateway');
  } catch (err) {
    $('#gw-body').innerHTML = holoEmpty(`Could not load the gateway: ${esc(err.message)}`);
    return;
  }
  if (state.route === 'gateway' && !state.sub)
    gw.logs = (await api('/api/gateway/logs').catch(() => ({ entries: [] }))).entries;
  if (state.route === 'endpoint' && (!state.sub || state.sub === 'mcp'))
    gw.mcp = await api('/api/integrations').catch(() => null);
  paintGateway();
}
async function refreshGateway() {
  gw.data = await api('/api/gateway');
  paintGateway();
}

function paintGateway() {
  const el = $('#gw-body');
  if (!el || !gw.data) return;
  const sec = SECTION[state.route] || SECTION.gateway;
  el.innerHTML = (sec.pages[state.sub || ''] || sec.pages[''])();
  if (state.route === 'gateway' && !state.sub) mountGatewayScene();
  if (state.route === 'gateway' && state.sub === 'playground' && gw.pg.mode === 'dataset')
    dsPlaygroundMount(gw.pg, paintGateway);
}

/* ---------- Overview ---------- */
function gwOverview() {
  const d = gw.data;
  const t = d.usage.totals;
  const logs = gw.logs || [];
  const activeKeys = d.keys.filter((k) => !k.revokedAt && !(k.expiresAt && Date.now() > k.expiresAt));
  const ms = logs.filter((e) => e.ms).map((e) => e.ms);
  const perHour = Array.from(
    { length: 24 },
    (_, i) =>
      logs.filter((e) => Date.now() - e.ts < (24 - i) * 3600e3 && Date.now() - e.ts >= (23 - i) * 3600e3).length,
  );
  const tiles = [
    metricTile({
      label: 'Requests · month',
      value: whole.format(t.requests),
      sub: `${whole.format(t.today)} today`,
      color: HOLO.cyan,
      spark: perHour,
    }),
    metricTile({
      label: 'Cost · month',
      value: fmtUSD(t.cost),
      sub: `${fmtUSD(t.todayCost)} today · live list prices`,
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Tokens · month',
      value: fmtN(t.input + t.output),
      sub: `${fmtN(t.output)} output`,
      color: HOLO.violet,
    }),
    metricTile({
      label: 'Error rate',
      value: pct(t.requests ? t.errors / t.requests : 0),
      sub: `${whole.format(t.errors)} failed requests`,
      color: t.errors ? '#ff4f6d' : '#5cf0a8',
      p: t.requests ? t.errors / t.requests : 0,
    }),
    metricTile({
      label: 'Latency p50',
      value: msFmt(quantile(ms, 0.5)),
      sub: `p95 ${msFmt(quantile(ms, 0.95))}`,
      color: HOLO.blue,
    }),
    metricTile({
      label: 'API keys',
      value: `${activeKeys.length} / ${d.keys.length}`,
      sub: 'active / total',
      color: HOLO.pink,
      p: d.keys.length ? activeKeys.length / d.keys.length : null,
    }),
    metricTile({
      label: 'Providers',
      value: whole.format(d.providers.filter((p) => p.enabled).length),
      sub: d.providers.map((p) => esc(p.id)).join(' · ') || 'add one under Providers',
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'Default model',
      value: d.defaults.model ? esc(d.defaults.model.split('/').slice(1).join('/') || d.defaults.model) : '—',
      sub: d.defaults.model ? esc(d.defaults.model.split('/')[0]) : 'not set',
      color: HOLO.violet,
    }),
    metricTile({
      label: 'Agents',
      value: `${d.agents.filter((a) => a.enabled).length}`,
      sub: `${d.agents.length} defined`,
      color: HOLO.pink,
    }),
    metricTile({
      label: 'Sessions',
      value: whole.format(d.sessions.length),
      sub: 'active in the last 24 h',
      color: HOLO.blue,
    }),
    metricTile({
      label: 'Memory notes',
      value: whole.format(d.memory.length),
      sub: 'saved by agents and you',
      color: HOLO.violet,
    }),
    metricTile({
      label: 'Agent calls',
      value: whole.format(logs.filter((e) => e.kind === 'agent').length),
      sub: 'model calls by agents (recent)',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Knowledge bases',
      value: whole.format(d.knowledge.length),
      sub: `${fmtN(d.knowledge.reduce((x, k) => x + k.chunks, 0))} chunks · ${fmtN(d.knowledge.reduce((x, k) => x + k.embedded, 0))} vectors`,
      color: '#3ee6b0',
    }),
    metricTile({
      label: 'Model routes',
      value: whole.format(d.routes.length),
      sub: `${d.providers.filter((p) => p.tier === 'private').length} private · ${d.providers.filter((p) => p.tier === 'external' && p.approved).length} approved external`,
      color: HOLO.violet,
    }),
    metricTile({
      label: 'Workflows',
      value: whole.format(d.workflows.length),
      sub: 'multi-agent pipelines',
      color: '#c45cf2',
    }),
  ];
  const keyName = (id) => (id === 'dashboard' ? 'Dashboard' : (d.keys.find((k) => k.id === id) || {}).name || id);
  const setup = !d.providers.length || !d.defaults.model || !d.keys.length;
  return `${
    setup
      ? `<div class="gw-steps">${[
          [d.providers.length > 0, 'Add a provider', 'Ollama, LM Studio or any OpenAI-compatible API', 'providers'],
          [!!d.defaults.model, 'Pick a default model', 'used by agents and the planner', 'providers'],
          [d.keys.length > 0, 'Create an API key', 'for your apps, scripts and MCP clients', 'keys'],
        ]
          .map(
            ([done, a, b, sub], i) =>
              `<a class="gw-step${done ? ' done' : ''}" href="${sub.startsWith('#') ? sub : `#gateway/${sub}`}"><span>${done ? '✓' : i + 1}</span><div><b>${a}</b><small>${b}</small></div></a>`,
          )
          .join('')}</div>`
      : ''
  }
    <section class="holo stage landscape-stage"><canvas id="gw-scene" aria-label="3D view of the gateway: clients, the agent gateway, the orchestrator and the domain agents"></canvas>
      <div class="stage-tl"><div class="holo-kicker">AGENT GATEWAY → ORCHESTRATOR → DOMAIN AGENTS</div><div class="stage-key">Left: API keys · gateway: auth, rate limit, sessions · orchestrator: planning, routing, memory · right: domain agents (height = recent calls) · pulses = recent requests</div></div></section>
    <div class="live-metrics">${tiles.join('')}</div>
    <div class="live-grid">
      ${panel(
        'Recent requests',
        'newest first · no prompt text is stored',
        logs.length
          ? `<div class="table-wrap logs-scroll"><table class="holo-table"><thead><tr><th>Time</th><th>Key</th><th>Model · agent</th><th class="r">In / out</th><th class="r">Cost</th><th class="r">Latency</th><th>Status</th></tr></thead><tbody>
        ${logs
          .slice(0, 60)
          .map(
            (
              e,
            ) => `<tr><td class="muted num">${fmtDate(e.ts)}</td><td>${esc(keyName(e.keyId))}</td><td><b>${esc(e.model || '—')}</b>${e.agent ? `<small class="block muted">${esc(e.agent)}${e.stream ? ' · stream' : ''}</small>` : e.stream ? '<small class="block muted">stream</small>' : ''}</td>
          <td class="r num">${fmtN(e.input || 0)} / ${fmtN(e.output || 0)}</td><td class="r num">${fmtUSD(e.cost || 0)}</td><td class="r num">${msFmt(e.ms)}</td>
          <td><span class="state-pill" style="--c:${e.status < 400 ? '#5cf0a8' : '#ff4f6d'}"><i></i>${e.status}</span></td></tr>`,
          )
          .join('')}</tbody></table></div>`
          : holoEmpty('No requests yet. Create a key and call the gateway, or try the Playground.'),
      )}
      ${panel(
        'By key · this month',
        '',
        Object.keys(d.usage.byKey).length
          ? meters(
              Object.entries(d.usage.byKey)
                .sort((a, b) => b[1].cost - a[1].cost)
                .map(([id, v]) => ({
                  label: esc(keyName(id)),
                  value: v.cost,
                  max: Math.max(...Object.values(d.usage.byKey).map((x) => x.cost), 1e-9),
                  color: HOLO.pink,
                  right: `${whole.format(v.requests)} req · ${fmtUSD(v.cost)}`,
                })),
            )
          : holoEmpty('No usage yet.'),
      )}
    </div>`;
}

function mountGatewayScene() {
  const canvas = $('#gw-scene');
  const d = gw.data;
  if (!canvas) return;
  const logs = gw.logs || [];
  const agentList = d.agents.filter((a) => a.enabled);
  const byAgent = {};
  for (const e of logs) if (e.agent) byAgent[e.agent] = (byAgent[e.agent] || 0) + 1;
  const maxA = Math.max(1, ...Object.values(byAgent));
  const keysShown = d.keys.filter((k) => !k.revokedAt).slice(0, 5);
  const recent = logs.filter((e) => Date.now() - e.ts < 3600e3).length;
  const heights = {};
  const hov = { tip: '' };
  isoStage(canvas, {
    fit: [13.4, 8.4],
    origin: [0.5, 0.6],
    draw(g) {
      const { P, ctx, t, still } = g;
      g.glow();
      g.platform(-6.2, 6.2, -3, 2.8);
      const items = [];
      const pts = [];
      const gwPos = [-2.6, -0.4];
      const orPos = [0.2, -0.4];
      // Agents fan out on the right.
      const ag = agentList.map((a, i) => {
        const ang = (i / Math.max(1, agentList.length - 1)) * Math.PI - Math.PI / 2;
        return { a, x: 3.2 + Math.cos(ang) * 1.9, z: -0.1 + Math.sin(ang) * 2.4 };
      });
      const beam = (p1, p2, color, n) => {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = hexA(color, 0.5);
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.stroke();
        for (let j = 0; j < n; j++) {
          const f = still ? (j + 1) / (n + 1) : (t * 0.45 + j / n) % 1;
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(p1[0] + (p2[0] - p1[0]) * f, p1[1] + (p2[1] - p1[1]) * f, 2.4, 0, 7);
          ctx.fill();
        }
        ctx.restore();
      };
      const gwTop = P(gwPos[0] + 0.45, 0.9, gwPos[1] + 0.45);
      const orTop = P(orPos[0] + 0.45, 0.9, orPos[1] + 0.45);
      keysShown.forEach((k, i) => {
        const z = -1.8 + i * (3.4 / Math.max(1, keysShown.length - 1 || 1));
        beam(P(-5.2, 0.4, z + 0.25), gwTop, HOLO.cyan, Math.min(3, recent ? 2 : 0));
      });
      beam(gwTop, orTop, HOLO.violet, recent ? 3 : 0);
      for (const n of ag)
        beam(
          orTop,
          P(n.x + 0.25, 0.3, n.z + 0.25),
          n.a.id in byAgent ? HOLO.pink : 'rgba(170,150,255,1)',
          byAgent[n.a.id] ? 2 : 0,
        );
      keysShown.forEach((k, i) => {
        const z = -1.8 + i * (3.4 / Math.max(1, keysShown.length - 1 || 1));
        items.push({
          depth: P(-5.4, 0, z)[2],
          draw: () => g.box(-5.4, z, 0.5, 0.5, 0.45, '#5b8cff', { slices: 0, glow: 10 }),
        });
        pts.push({
          at: P(-5.15, 0.45, z + 0.25),
          key: k.id,
          label: `${k.name} · ${k.scopes.join('+')}`,
          color: '#8fb4ff',
          html: () =>
            `<b>${esc(k.name)}</b><div class="row"><span>Scopes</span><span>${esc(k.scopes.join(', '))}</span></div><div class="row"><span>Limit</span><span>${k.rpm}/min${k.budgetUSD != null ? ` · $${k.budgetUSD}/mo` : ''}</span></div>`,
        });
      });
      items.push({
        depth: P(gwPos[0], 0, gwPos[1])[2],
        draw: () => {
          g.box(gwPos[0], gwPos[1], 0.9, 0.9, 0.9, '#ff4fd8', { glow: 22, slices: 0.3 });
        },
      });
      items.push({
        depth: P(orPos[0], 0, orPos[1])[2],
        draw: () => {
          g.box(orPos[0], orPos[1], 0.9, 0.9, 0.9, '#8b7bff', { glow: 22, slices: 0.3 });
          const c = P(orPos[0] + 0.45, 1.35 + Math.sin(t * 2) * 0.05, orPos[1] + 0.45);
          ctx.save();
          ctx.strokeStyle = '#8b7bff';
          ctx.lineWidth = 2;
          ctx.shadowColor = '#8b7bff';
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.ellipse(c[0], c[1], g.s * 0.55, g.s * 0.2, 0, 0, 7);
          ctx.stroke();
          ctx.restore();
        },
      });
      pts.push({
        at: gwTop,
        key: 'gw',
        label: 'Agent Gateway · auth · rate limit · sessions',
        color: '#ff9bd8',
        html: () =>
          `<b>Agent Gateway</b><div class="row"><span>Keys</span><span>${d.keys.length}</span></div><div class="row"><span>Sessions</span><span>${d.sessions.length}</span></div>`,
      });
      pts.push({
        at: orTop,
        key: 'or',
        label: 'Orchestrator · planning · routing · memory',
        color: '#b4a9ff',
        html: () =>
          `<b>Orchestrator / Planner</b><div class="row"><span>Planner model</span><span>${esc(d.defaults.plannerModel || d.defaults.model || 'not set')}</span></div><div class="row"><span>Memory notes</span><span>${d.memory.length}</span></div>`,
      });
      for (const n of ag) {
        const h = (heights[n.a.id] =
          (heights[n.a.id] ?? 0.1) +
          (0.25 + 1.6 * ((byAgent[n.a.id] || 0) / maxA) - (heights[n.a.id] ?? 0.1)) * (still ? 1 : 0.08));
        items.push({
          depth: P(n.x, 0, n.z)[2],
          draw: () =>
            g.box(n.x, n.z, 0.5, 0.5, h, byAgent[n.a.id] ? '#ff5ca8' : '#7b6cff', {
              slices: 0,
              glow: byAgent[n.a.id] ? 14 : 0,
            }),
        });
        pts.push({
          at: P(n.x + 0.25, h, n.z + 0.25),
          key: n.a.id,
          label: n.a.name,
          color: byAgent[n.a.id] ? '#ff9bd8' : '#b4a9ff',
          html: () =>
            `<b>${esc(n.a.name)}</b><div class="row"><span>Domain</span><span>${esc(n.a.domain)}</span></div><div class="row"><span>Recent calls</span><span class="num">${byAgent[n.a.id] || 0}</span></div>`,
        });
      }
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      g.labels(
        pts
          .filter((p) => ['gw', 'or'].includes(p.key) || byAgent[p.key] || p.key.startsWith('key_'))
          .slice(0, 9)
          .map((p) => ({ at: p.at, text: p.label, color: p.color })),
      );
      hoverTip(g, pts, hov);
    },
  });
}

/* ---------- Keys ---------- */
function gwKeys() {
  const d = gw.data;
  const secret = gw.newSecret
    ? `<div class="ie-result good gw-secret"><b>Copy your new key now. It will be masked after you copy it or in 60 seconds, and never shown again.</b>
      <div class="gw-code"><button class="btn ghost gw-copy" type="button" data-gwsecret>Copy</button><pre id="gw-new-secret">${esc(gw.newSecret)}</pre></div></div>`
    : gw.maskedSecret
      ? `<div class="ie-result gw-secret"><b>Key copied and hidden.</b><div class="gw-code"><pre class="gw-masked">${esc(gw.maskedSecret)}</pre></div><small class="muted">Store it in your app's secret store; ZAAFPulse only keeps its hash.</small></div>`
      : '';
  return `${secret}
      <section class="holo panel"><div class="panel-head"><h3>API keys</h3><span class="meta">${d.keys.length} keys · stored as SHA-256 hashes</span></div>
        ${
          d.keys.length
            ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Name</th><th>Scopes</th><th>Allowed</th><th>Spend · month</th><th class="r">Limit</th><th class="r">Last used</th><th>Status</th><th></th></tr></thead><tbody>
          ${d.keys
            .map((k) => {
              const spent = d.spend[k.id] || 0;
              const st = k.revokedAt
                ? ['revoked', '#ff4f6d']
                : k.expiresAt && Date.now() > k.expiresAt
                  ? ['expired', '#ffb547']
                  : ['active', '#5cf0a8'];
              return `<tr><td><b>${esc(k.name)}</b><small class="block muted mono">${esc(k.prefix)}</small></td><td>${k.scopes.map((s) => `<span class="tag">${s}</span>`).join(' ')}</td>
              <td class="muted"><small class="block">models: ${esc(k.models.join(', ') || 'all')}${k.privateOnly ? ' · <b class="good-text">private only</b>' : ''}</small><small class="block">agents: ${esc(k.agents.join(', ') || 'all')}</small><small class="block">knowledge: ${esc((k.knowledge || []).join(', ') || 'all')}${k.approveOwnRuns ? ' · <b class="warn-text">approves own runs</b>' : ''}</small></td>
              <td>${k.budgetUSD != null ? `<div class="cell-bar left"><span class="num">${fmtUSD(spent)} / ${fmtUSD(k.budgetUSD)}</span><i style="width:${Math.min(100, (spent / Math.max(k.budgetUSD, 1e-9)) * 100).toFixed(1)}%;background:${spent >= k.budgetUSD ? '#ff4f6d' : HOLO.orange}"></i></div>` : `<span class="num">${fmtUSD(spent)}</span> <small class="muted">no budget</small>`}</td>
              <td class="r num">${k.rpm}/min${k.expiresAt ? `<small class="block muted">until ${new Date(k.expiresAt).toLocaleDateString()}</small>` : ''}</td><td class="r muted">${k.lastUsedAt ? ago(k.lastUsedAt) : 'never'}</td>
              <td><span class="state-pill" style="--c:${st[1]}"><i></i>${st[0]}</span></td>
              <td class="nowrap">${k.revokedAt ? '' : `<button class="btn ghost" type="button" data-gwkey="revoke" data-id="${k.id}">Revoke</button> `}<button class="btn ghost danger" type="button" data-gwkey="delete" data-id="${k.id}">Delete</button></td></tr>`;
            })
            .join('')}
        </tbody></table></div>`
            : holoEmpty('No keys yet. Create one below.')
        }</section>
      <section class="holo panel"><div class="panel-head"><h3>New key</h3><span class="meta">shown once, then only its hash is kept</span></div>
        <form class="gw-form gw-key-form" id="gw-key-form">
          <div class="gw-row"><label>Name<input class="input" name="name" placeholder="e.g. my-app, n8n, laptop scripts" required></label>
          <label>Allowed models <small>globs, comma-separated; <b class="warn-text">empty = every model</b>, list them to limit spend</small><input class="input" name="models" placeholder="ollama/*, openrouter/deepseek/*"></label>
          <label>Allowed agents <small><b class="warn-text">empty = every agent</b>; list the ones this app needs</small><input class="input" name="agents" placeholder="customer-service, network-ops"></label>
          <label>Allowed knowledge bases <small>empty = every knowledge base</small><input class="input" name="knowledge" placeholder="support-handbook, runbooks"></label></div>
          <fieldset><legend>Scopes</legend>${[
            ['llm', 'LLM: /v1/chat/completions, /v1/embeddings'],
            ['agents', 'Agents: agent/*, /v1/orchestrate, workflows, sessions'],
            ['rag', 'RAG: /v1/knowledge search and ingestion, /v1/brain (second brain, read only)'],
            ['mcp', 'MCP: /mcp with every integration tool'],
          ]
            .map(
              ([v, l]) =>
                `<label class="gw-check"><input type="checkbox" name="scope" value="${v}" ${v === 'llm' || v === 'agents' ? 'checked' : ''}> ${l}</label>`,
            )
            .join('')}</fieldset>
          <label class="gw-check"><input type="checkbox" name="privateOnly"> Private models only (your own hardware: Ollama, LM Studio, vLLM, TGI)</label>
          <label class="gw-check"><input type="checkbox" name="approveOwnRuns"> May approve its own paused runs through the API or A2A (only for a pipeline that has its own human approval; otherwise approve in this dashboard)</label>
          <div class="gw-row"><label>Budget / month (USD)<input class="input" name="budgetUSD" type="number" min="0" step="0.01" placeholder="none"></label>
            <label>Requests / minute<input class="input" name="rpm" type="number" min="1" value="60"></label>
            <label>Expires in (days)<input class="input" name="expiresInDays" type="number" min="1" placeholder="never"></label>
            <button class="btn" type="submit">Create key</button></div>
          <div id="gw-key-errors"></div>
        </form></section>`;
}

/* ---------- Providers ---------- */
function gwProviders() {
  const d = gw.data;
  const e = gw.editingProvider;
  const allModels = d.providers.flatMap((p) => (p.models || []).map((m) => `${p.id}/${m}`));
  const form = e
    ? `<section class="holo panel"><div class="panel-head"><h3>${e.originalId ? `Edit ${esc(e.originalId)}` : `Add ${esc(d.presets[e.preset].label)}`}</h3></div>
      <form class="gw-form" id="gw-prov-form">
        <div class="gw-row"><label>ID <small>used in model names: id/model</small><input class="input" name="id" value="${esc(e.id || '')}" required></label>
          <label>Preset<select class="input" name="preset">${Object.entries(d.presets)
            .map(([k, v]) => `<option value="${k}" ${k === e.preset ? 'selected' : ''}>${esc(v.label)}</option>`)
            .join('')}</select></label></div>
        <label>Base URL<input class="input" name="baseUrl" value="${esc(e.baseUrl || d.presets[e.preset].baseUrl)}" placeholder="https://…/v1"></label>
        ${(() => {
          const pre = d.presets[e.preset];
          const auths = e.preset === 'custom' ? ['key', 'oauth2', 'google-sa'] : pre.auths || ['key'];
          const at = e.authType || (e.auth && e.auth.type) || pre.auth || 'key';
          const o = { ...(pre.oauth || {}), ...(e.auth || {}) };
          return `<div class="gw-row"><label>Wire format<select class="input" name="format"><option value="openai" ${(e.format || pre.format || 'openai') === 'openai' ? 'selected' : ''}>OpenAI chat completions</option><option value="anthropic" ${(e.format || pre.format) === 'anthropic' ? 'selected' : ''}>Anthropic Messages (native)</option></select></label>
            <label>Auth<select class="input" name="authType">${auths.map((a) => `<option value="${a}" ${a === at ? 'selected' : ''}>${{ key: 'API key', oauth2: 'OAuth2 token (refreshes itself)', 'google-sa': 'Google service account (refreshes itself)' }[a]}</option>`).join('')}</select></label></div>
            ${
              at === 'oauth2'
                ? `<div class="gw-row"><label>Token URL<input class="input" name="tokenUrl" value="${esc(o.tokenUrl || '')}" placeholder="https://login.example.com/oauth2/token"></label><label>Client id<input class="input" name="clientId" value="${esc(o.clientId || '')}"></label></div>
              <div class="gw-row"><label>Scope<input class="input" name="scope" value="${esc(o.scope || '')}"></label><label>Grant<select class="input" name="grant"><option value="client_credentials" ${o.grant !== 'refresh_token' ? 'selected' : ''}>Client credentials</option><option value="refresh_token" ${o.grant === 'refresh_token' ? 'selected' : ''}>Refresh token</option></select></label></div>`
                : ''
            }`;
        })()}
        <label>${(e.authType || (e.auth && e.auth.type) || d.presets[e.preset].auth) === 'google-sa' ? 'Service account JSON' : (e.authType || (e.auth && e.auth.type)) === 'oauth2' ? 'Client secret, or JSON {"client_secret", "refresh_token"}' : 'API key'} ${e.apiKey ? `<small>current: ${e.apiKey.keychain ? `${storeName()} · ${esc(e.apiKey.keychain)}` : `env · ${esc(e.apiKey.env)}`}</small>` : d.presets[e.preset].keyRequired ? '<small>required</small>' : '<small>not needed for local servers</small>'}
          <div class="ie-secret"><select class="input" name="secretMode">${[...(e.apiKey ? [['keep', 'Keep current']] : []), ['store', `Paste → save to ${storeName()}`], ['keychain', `${storeName()} item`], ['env', 'Environment variable'], ['none', 'None']].map(([v, l]) => `<option value="${v}" ${v === (e.apiKey ? 'keep' : d.presets[e.preset].keyRequired ? 'store' : 'none') ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input class="input" name="secretValue" type="password" autocomplete="off" placeholder="key, ${storeName()} item or env name"></div></label>
        <label>Extra models <small>comma-separated, added to what the provider lists</small><input class="input" name="models" value="${esc((e.models || []).join(', '))}"></label>
        <label>Aliases <small>JSON, e.g. {"fast": "llama3.2"}</small><input class="input mono" name="aliases" value="${esc(JSON.stringify(e.aliases || {}))}"></label>
        <div class="gw-row"><label>Tier<select class="input" name="tier"><option value="">Automatic (${d.presets[e.preset].local ? 'private' : 'external'})</option><option value="private" ${e.tier === 'private' ? 'selected' : ''}>Private: my own hardware</option><option value="external" ${e.tier === 'external' ? 'selected' : ''}>External: hosted API</option></select></label>
          <label class="ie-switch"><input type="checkbox" name="approved" ${e.approved !== false ? 'checked' : ''}><span></span>Approved for use (external)</label>
          <label class="ie-switch"><input type="checkbox" name="enabled" ${e.enabled !== false ? 'checked' : ''}><span></span>Enabled</label></div>
        <div id="gw-prov-errors"></div>
        <div class="gw-row"><button class="btn" type="submit">Save &amp; test</button><button class="btn ghost" type="button" data-gwprov="cancel">Cancel</button></div>
      </form></section>`
    : '';
  return `<section class="holo panel"><div class="panel-head"><h3>Defaults</h3><span class="meta">used by agents without their own model, and by the planner</span></div>
      <form class="gw-form gw-row" id="gw-defaults"><datalist id="gw-models">${allModels.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
        <label>Default model<input class="input" name="model" list="gw-models" value="${esc(d.defaults.model)}" placeholder="ollama/llama3.3"></label>
        <label>Planner model <small>optional</small><input class="input" name="plannerModel" list="gw-models" value="${esc(d.defaults.plannerModel)}" placeholder="same as default"></label>
        <button class="btn" type="submit">Save defaults</button></form></section>
    <section class="holo panel"><div class="panel-head"><h3>Add a provider</h3><span class="meta">${Object.keys(d.presets).length} presets · OpenAI-compatible or native Anthropic · models come from each provider's /models</span></div>
      ${(() => {
        const cats = [...new Set(Object.values(d.presets).map((v) => v.category || 'Custom'))];
        return `<div class="segmented wf-cats" role="group" aria-label="Provider category">${['', ...cats].map((c) => `<button type="button" data-gwpcat="${esc(c)}" aria-pressed="${(gw.presetCat || '') === c}">${c ? esc(c) : 'All'} <small>${c ? Object.values(d.presets).filter((v) => (v.category || 'Custom') === c).length : Object.keys(d.presets).length}</small></button>`).join('')}</div>`;
      })()}
      <div class="ie-types gw-presets">${Object.entries(d.presets)
        .filter(([, v]) => !gw.presetCat || (v.category || 'Custom') === gw.presetCat)
        .map(
          ([k, v]) =>
            `<button type="button" class="ie-type" data-gwpreset="${k}"><span class="chip ${v.local ? 'green' : 'blue'}">${icon(v.local ? 'cube' : 'external', 16)}</span><b>${esc(v.label)}</b><small>${esc(v.hint || v.baseUrl || 'your base URL')}</small></button>`,
        )
        .join('')}</div></section>
    ${form}
    ${
      d.providers.length
        ? `<div class="pc-grid">${d.providers
            .map(
              (p) => `<article class="pcard" style="--v:${d.presets[p.preset]?.local ? '#5cf0a8' : '#5b8cff'}">
      <div class="pc-head"><span class="pc-logo">${esc(p.id[0].toUpperCase())}</span><div class="pc-title"><b>${esc(p.id)}</b><small>${esc(d.presets[p.preset]?.label || p.preset)}</small></div>
        <span class="state-pill" style="--c:${p.enabled ? '#5cf0a8' : '#8f98cc'}"><i></i>${p.enabled ? 'enabled' : 'disabled'}</span></div>
      <div class="pc-kv"><span>Base URL</span><b class="mono">${esc(p.baseUrl)}</b></div>
      <div class="pc-kv"><span>Format · auth</span><b>${p.format === 'anthropic' ? 'Anthropic Messages' : 'OpenAI chat'} · ${{ key: 'API key', oauth2: 'OAuth2 (auto refresh)', 'google-sa': 'service account (auto refresh)' }[(p.auth && p.auth.type) || 'key']}</b></div>
      <div class="pc-kv"><span>Key</span><b>${p.apiKey ? (p.apiKey.keychain ? `${storeName()} · ${esc(p.apiKey.keychain)}` : `env · ${esc(p.apiKey.env)}`) : 'none'}</b></div>
      <div class="pc-kv"><span>Tier</span><b>${p.tier === 'private' ? '<span class="good-text">Private · your hardware</span>' : p.approved ? 'External · <span class="good-text">approved</span>' : 'External · <span style="color:#ffb547">waiting for approval</span>'}</b></div>
      <div class="pc-kv"><span>Aliases</span><b>${esc(Object.keys(p.aliases).join(', ') || '—')}</b></div>
      <div class="gw-test" id="gw-test-${esc(p.id)}"></div>
      <div class="pc-foot"><button class="btn ghost" type="button" data-gwprov="test" data-id="${esc(p.id)}">Test &amp; list models</button>${p.tier === 'external' ? `<button class="btn ${p.approved ? 'ghost' : ''}" type="button" data-gwapprove="${esc(p.id)}" data-on="${p.approved ? '0' : '1'}">${p.approved ? 'Revoke approval' : 'Approve'}</button>` : ''}<button class="btn ghost" type="button" data-gwprov="edit" data-id="${esc(p.id)}">Edit</button><button class="btn ghost danger" type="button" data-gwprov="delete" data-id="${esc(p.id)}">Remove</button></div>
    </article>`,
            )
            .join('')}</div>`
        : holoEmpty('No provider yet. Pick one above. Ollama and LM Studio need no key.')
    }`;
}

/* ---------- Model router ---------- */
function gwRouter() {
  const d = gw.data;
  const e = gw.editingRoute;
  const priv = d.providers.filter((p) => p.tier === 'private');
  const ext = d.providers.filter((p) => p.tier === 'external');
  const allModels = d.providers.flatMap((p) => (p.models || []).map((m) => `${p.id}/${m}`));
  const tierCard = (
    title,
    sub,
    list,
    color,
    empty,
  ) => `<section class="holo panel gw-tier" style="--v:${color}"><div class="panel-head"><h3>${title}</h3><span class="meta">${sub}</span></div>
    ${
      list.length
        ? list
            .map(
              (
                p,
              ) => `<div class="gw-tier-row"><span class="tool-dot" style="background:${color}"></span><b>${esc(p.id)}</b><small class="muted">${esc(d.presets[p.preset]?.label || p.preset)} · ${esc(p.baseUrl)}</small>
      ${p.tier === 'external' ? `<span class="state-pill" style="--c:${p.approved ? '#5cf0a8' : '#ffb547'}"><i></i>${p.approved ? 'approved' : 'pending'}</span>` : `<span class="state-pill" style="--c:#5cf0a8"><i></i>private</span>`}</div>`,
            )
            .join('')
        : holoEmpty(empty)
    }</section>`;
  const form = e
    ? `<section class="holo panel"><div class="panel-head"><h3>${e.originalName ? `Edit ${esc(e.originalName)}` : 'New route'}</h3></div>
    <form class="gw-form" id="gw-route-form"><datalist id="gw-models">${allModels.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      <div class="gw-row"><label>Name<input class="input" name="name" value="${esc(e.name || 'router/')}" placeholder="router/fast"></label>
        <label>Strategy<select class="input" name="strategy"><option value="fallback" ${e.strategy !== 'round-robin' ? 'selected' : ''}>Fallback: first target, then the next on errors</option><option value="round-robin" ${e.strategy === 'round-robin' ? 'selected' : ''}>Round-robin: spread load, fall back on errors</option></select></label></div>
      <label>Targets <small>one provider/model per line, in order; private first keeps data in-house</small><textarea class="input mono" name="targets" rows="4" placeholder="ollama/qwen2.5\nvllm/llama-3.3-70b\nopenrouter/deepseek/deepseek-v4.1-flash">${esc((e.targets || []).join('\n'))}</textarea></label>
      <label>Description<input class="input" name="description" value="${esc(e.description || '')}"></label>
      <div id="gw-route-errors"></div>
      <div class="gw-row"><button class="btn" type="submit">Save route</button><button class="btn ghost" type="button" data-gwroute="cancel">Cancel</button></div></form></section>`
    : '';
  return `<div class="live-grid even">
      ${tierCard('Private LLMs', 'your own hardware: Ollama, LM Studio, vLLM, TGI · always allowed', priv, '#5cf0a8', 'No private provider. Add Ollama, LM Studio or a vLLM GPU server under Providers.')}
      ${tierCard('External models', 'hosted APIs · serve traffic only once approved', ext, '#5b8cff', 'No external provider.')}
    </div>
    ${routerExtras()}
    <div class="gw-toolbar"><span class="meta">Routes are virtual models: use <code>router/&lt;name&gt;</code> anywhere a model is accepted. Keys marked "private models only" skip external targets.</span><button class="btn" type="button" data-gwroute="new">+ New route</button></div>
    ${form}
    ${
      d.routes.length
        ? `<div class="pc-grid">${d.routes
            .map(
              (
                r,
              ) => `<article class="pcard" style="--v:#8b7bff"><div class="pc-head"><span class="pc-logo">R</span><div class="pc-title"><b>${esc(r.name)}</b><small>${esc(r.strategy)} · ${r.targets.length} targets</small></div></div>
      ${r.description ? `<p class="pc-desc">${esc(r.description)}</p>` : ''}
      <ol class="gw-targets">${r.targets
        .map((t) => {
          const p = d.providers.find((x) => x.id === t.split('/')[0]);
          const st = !p
            ? ['missing provider', '#ff4f6d']
            : !p.enabled
              ? ['disabled', '#8f98cc']
              : p.tier === 'private'
                ? ['private', '#5cf0a8']
                : p.approved
                  ? ['external', '#5b8cff']
                  : ['not approved', '#ffb547'];
          return `<li><code>${esc(t)}</code> <span class="state-pill" style="--c:${st[1]}"><i></i>${st[0]}</span></li>`;
        })
        .join('')}</ol>
      <div class="pc-foot"><button class="btn ghost" type="button" data-gwroute="edit" data-name="${esc(r.name)}">Edit</button><button class="btn ghost danger" type="button" data-gwroute="delete" data-name="${esc(r.name)}">Delete</button></div></article>`,
            )
            .join('')}</div>`
        : holoEmpty(
            'No routes yet. Example: router/fast → ollama/qwen2.5 then openrouter/deepseek/deepseek-v4.1-flash.',
          )
    }`;
}

/* ---------- Knowledge (RAG) ---------- */
function gwKnowledge() {
  const d = gw.data;
  const open = gw.kbOpen;
  const allModels = d.providers.flatMap((p) => (p.models || []).map((m) => `${p.id}/${m}`));
  const detail = open
    ? `<section class="holo panel"><div class="panel-head"><h3>${esc(open.name)}</h3><span class="meta">${open.documents} documents · ${open.chunks} chunks · ${open.embedded}/${open.chunks} embedded${open.embedModel ? ` · ${esc(open.embedModel)}` : ' · keyword search only'}</span>
      <div class="right"><button class="btn ghost" type="button" data-gwkb="close">Close</button></div></div>
    <div class="live-grid even">
      <form class="gw-form" id="gw-kb-ingest"><b>Add a document</b>
        <label>Title<input class="input" name="title" placeholder="e.g. Refund policy 2026"></label>
        <label>Paste text, Markdown, HTML, CSV or JSON<textarea class="input" name="content" rows="6"></textarea></label>
        <label>…or a file <small>.txt .md .html .csv .json, read in your browser</small><input class="input" type="file" name="file" accept=".txt,.md,.markdown,.html,.htm,.csv,.json,.log,.yaml,.yml"></label>
        <label>…or a URL<input class="input" name="url" placeholder="https://…"></label>
        <div id="gw-kb-msg"></div><button class="btn" type="submit">Ingest</button></form>
      <div class="gw-form"><b>Search</b><form class="gw-row" id="gw-kb-search"><input class="input" name="q" placeholder="Ask the knowledge base…" value="${esc((gw.kbSearch && gw.kbSearch.q) || '')}"><button class="btn" type="submit">Search</button></form>
        ${gw.kbSearch && gw.kbSearch.results ? `<small class="muted">${esc(gw.kbSearch.method)} search</small><div class="feed gw-hits">${gw.kbSearch.results.map((r, i) => `<div class="gw-hit"><b>[${i + 1}] ${esc(r.document)}</b><small class="muted">score ${r.score}${r.semantic != null ? ` · semantic ${r.semantic}` : ''} · keyword ${r.keyword}</small><p>${esc(r.text.slice(0, 400))}${r.text.length > 400 ? '…' : ''}</p></div>`).join('') || holoEmpty('No matching passages.')}</div>` : ''}
        <div class="gw-row"><label>Embedding model <small>empty = keyword (BM25) only</small><input class="input" id="gw-kb-embed" list="gw-models" value="${esc(open.embedModel)}" placeholder="ollama/nomic-embed-text"></label><button class="btn ghost" type="button" data-gwkb="embed">Save &amp; re-embed</button></div>
        <datalist id="gw-models">${allModels.map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div>
    </div>
    ${
      open.docs.length
        ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Document</th><th>Source</th><th class="r">Chars</th><th class="r">Chunks</th><th class="r">Added</th><th></th></tr></thead><tbody>
      ${open.docs.map((doc) => `<tr><td><b>${esc(doc.title)}</b></td><td class="muted">${esc(doc.source || doc.kind)}</td><td class="r num">${fmtN(doc.chars)}</td><td class="r num">${doc.chunks}</td><td class="r muted">${ago(doc.addedAt)}</td><td><button class="btn ghost danger" type="button" data-gwkb="rmdoc" data-doc="${doc.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
        : holoEmpty('No documents yet.')
    }
  </section>`
    : '';
  return `<div class="live-grid">
    <section class="holo panel"><div class="panel-head"><h3>Knowledge bases</h3><span class="meta">local vector database in .data/kb · hybrid search (embeddings + BM25)</span></div>
      ${
        d.knowledge.length
          ? `<div class="pc-grid">${d.knowledge
              .map(
                (
                  k,
                ) => `<article class="pcard" style="--v:#3ee6b0"><div class="pc-head"><span class="pc-logo">K</span><div class="pc-title"><b>${esc(k.name)}</b><small>${esc(k.id)}</small></div></div>
        ${k.description ? `<p class="pc-desc">${esc(k.description)}</p>` : ''}
        <div class="pc-meta"><div class="pc-kv"><span>Documents</span><b>${k.documents}</b></div><div class="pc-kv"><span>Chunks</span><b>${k.chunks}</b></div></div>
        <div class="pc-kv"><span>Vectors</span><b>${k.embedModel ? `${k.embedded}/${k.chunks} · ${esc(k.embedModel)}` : 'keyword only'}</b></div>
        <div class="pc-foot"><button class="pc-details" type="button" data-gwkb="open" data-id="${esc(k.id)}">Open <span aria-hidden="true">›</span></button><button class="btn ghost danger" type="button" data-gwkb="delete" data-id="${esc(k.id)}">Delete</button></div></article>`,
              )
              .join('')}</div>`
          : holoEmpty('No knowledge base yet.')
      }</section>
    <section class="holo panel"><div class="panel-head"><h3>New knowledge base</h3></div>
      <form class="gw-form" id="gw-kb-form"><label>ID<input class="input" name="id" placeholder="company-policies" required></label><label>Name<input class="input" name="name" placeholder="Company policies"></label>
        <label>Description<input class="input" name="description"></label>
        <label>Embedding model <small>optional; any embedding model on a provider, e.g. ollama/nomic-embed-text</small><input class="input" name="embedModel" list="gw-models"></label>
        <div id="gw-kb-errors"></div><button class="btn" type="submit">Create</button></form>
      <p class="kpi-sub">Attach a knowledge base to an agent (Agent-to-Agent → Specialist agents → Knowledge bases) and it can answer from your documents. Apps can search and add documents through /v1/knowledge with a key that has the rag scope.</p></section>
  </div>${detail}`;
}

/* ---------- Workflows ---------- */
function gwWorkflows() {
  const d = gw.data;
  const e = gw.editingWf;
  const run = gw.wfRun;
  const agentOpts = (sel) =>
    d.agents
      .filter((a) => a.enabled)
      .map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`)
      .join('');
  const form = e
    ? `<section class="holo panel"><div class="panel-head"><h3>${e.originalId ? `Edit ${esc(e.name)}` : 'New workflow'}</h3></div>
    <form class="gw-form" id="gw-wf-form"><div class="gw-row"><label>ID<input class="input" name="id" value="${esc(e.id || '')}" ${e.originalId ? 'readonly' : ''}></label><label>Name<input class="input" name="name" value="${esc(e.name || '')}"></label></div>
      <label>Description<input class="input" name="description" value="${esc(e.description || '')}"></label>
      <div class="gw-row"><label>Category<input class="input" name="category" value="${esc(e.category || '')}" placeholder="Custom"></label><label>Risk tier<select class="input" name="tier">${Object.entries(
        WF_TIER,
      )
        .map(
          ([k, [, l]]) => `<option value="${k}" ${k === (e.tier || 'R1') ? 'selected' : ''}>${k} · ${esc(l)}</option>`,
        )
        .join(
          '',
        )}</select></label><label>Sample input<input class="input" name="sampleInput" value="${esc(e.sampleInput || '')}"></label></div>
      <div class="gw-wf-steps">${(e.steps || []).map((st, i) => `<div class="gw-wf-step"><span class="or-app-rank">${i + 1}</span><select class="input" name="agent-${i}">${agentOpts(st.agent)}</select><textarea class="input" name="prompt-${i}" rows="2" placeholder="Use {{input}} and {{step${i}}}">${esc(st.prompt || '')}</textarea><button class="icon-btn" type="button" data-gwwf="rmstep" data-i="${i}" aria-label="Remove step">×</button><label class="ie-switch gw-wf-gate"><input type="checkbox" name="approve-${i}" ${st.approve ? 'checked' : ''}><span></span>Ask for approval before this step</label></div>`).join('')}</div>
      <div class="gw-row"><button class="btn ghost" type="button" data-gwwf="addstep">+ Add step</button><span class="muted">{{input}} = what you run it with · {{step1}}, {{step2}}… = earlier outputs</span></div>
      <div id="gw-wf-errors"></div><div class="gw-row"><button class="btn" type="submit">Save workflow</button><button class="btn ghost" type="button" data-gwwf="cancel">Cancel</button></div></form></section>`
    : '';
  const cats = [...new Set(d.workflows.map((w) => w.category || 'Custom'))].sort();
  const cat = cats.includes(gw.wfCat) ? gw.wfCat : '';
  const shown = d.workflows.filter((w) => !cat || (w.category || 'Custom') === cat);
  const removed = (d.workflowCatalog || []).filter((c) => !c.installed);
  return `<div class="gw-toolbar"><span class="meta">${d.workflows.length} workflows · ${d.workflows.filter((w) => w.builtin).length} ready-to-use · run here, or POST /v1/workflows/&lt;id&gt;/run · A2A skill workflow:&lt;id&gt;</span><button class="btn" type="button" data-gwwf="new">+ New workflow</button></div>
    <div class="segmented wf-cats" role="group" aria-label="Category">${['', ...cats].map((c) => `<button type="button" data-gwwfcat="${esc(c)}" aria-pressed="${c === cat}">${c ? esc(c) : 'All'} <small>${c ? d.workflows.filter((w) => (w.category || 'Custom') === c).length : d.workflows.length}</small></button>`).join('')}</div>
    ${form}
    <div class="pc-grid">${shown
      .map(
        (
          w,
        ) => `<article class="pcard" style="--v:${WF_TIER[w.tier || 'R1'][0]}"><div class="pc-head"><span class="pc-logo">${esc((w.category || 'W')[0])}</span><div class="pc-title"><b>${esc(w.name)}</b><small>${esc(w.id)} · ${w.steps.length} steps${w.steps.some((st) => st.approve) ? ` · ${w.steps.filter((st) => st.approve).length} approval` : ''}</small></div>
        <span class="state-pill" style="--c:${WF_TIER[w.tier || 'R1'][0]}" title="${esc(WF_TIER[w.tier || 'R1'][1])}"><i></i>${esc(w.tier || 'R1')}</span></div>
      <div class="tags">${w.category ? `<span class="tag">${esc(w.category)}</span>` : ''}${w.builtin ? `<span class="tag">ready-to-use${w.status === 'beta' ? ' · beta' : ''}</span>` : '<span class="tag">custom</span>'}${w.edited ? '<span class="tag warn">edited</span>' : ''}</div>
      <p class="pc-desc">${esc(w.description || '')}</p>${w.kpi ? `<div class="pc-kv"><span>Measure</span><b>${esc(w.kpi)}</b></div>` : ''}
      <div class="gw-chain">${w.steps.map((st) => `${st.approve ? '<span class="tag warn" title="pauses for approval">approval</span><span class="gw-arrow">→</span>' : ''}<span class="tag">${esc((d.agents.find((a) => a.id === st.agent) || {}).name || st.agent)}</span>`).join('<span class="gw-arrow">→</span>')}</div>
      <form class="gw-row gw-wf-run" data-wfid="${esc(w.id)}"><input class="input" name="input" placeholder="${esc(w.sampleInput ? `e.g. ${w.sampleInput.slice(0, 90)}` : 'Input for this run…')}"><button class="btn" type="submit" ${run && run.busy === w.id ? 'disabled' : ''}>${run && run.busy === w.id ? 'Running…' : 'Run'}</button></form>
      <div class="pc-foot">${w.sampleInput ? `<button class="btn ghost" type="button" data-gwwf="sample" data-id="${esc(w.id)}">Use sample</button>` : ''}<button class="btn ghost" type="button" data-gwwf="edit" data-id="${esc(w.id)}">Edit</button>${w.builtin && w.edited ? `<button class="btn ghost" type="button" data-gwwf="restore" data-id="${esc(w.id)}">Restore</button>` : ''}<button class="btn ghost danger" type="button" data-gwwf="delete" data-id="${esc(w.id)}">Delete</button></div></article>`,
      )
      .join('')}</div>
    ${removed.length ? `<p class="kpi-sub">Removed ready-to-use workflows: ${removed.map((c) => `<button class="link" type="button" data-gwwf="restore" data-id="${esc(c.id)}">${esc(c.name)}</button>`).join(' · ')}</p>` : ''}
    ${
      run && run.result
        ? `<section class="holo panel"><div class="panel-head"><h3>Run · ${esc(run.result.workflow || '')}</h3>${run.result.usage ? `<span class="meta">${fmtN(run.result.usage.input)} in · ${fmtN(run.result.usage.output)} out · ${fmtUSD(run.result.usage.cost || 0)}</span>` : ''}</div>
      ${run.result.errors ? errList(run.result.errors) : `${run.result.state && run.result.state !== 'completed' ? `<div class="gw-row">${runPill(run.result.state)}${run.result.state === 'input-required' ? `<button class="btn" type="button" data-a2arun="approve" data-id="${esc(run.result.id)}" data-wf="1">Approve step ${run.result.pending.step}</button><button class="btn ghost danger" type="button" data-a2arun="reject" data-id="${esc(run.result.id)}" data-wf="1">Reject</button>` : ''}${run.result.error ? `<code class="ie-err">${esc(run.result.error)}</code>` : ''}${run.result.stop ? `<span class="muted">${esc(run.result.stop.reason)}</span>` : ''}</div>` : ''}${run.result.state === 'input-required' && run.result.pending ? approvalView(run.result.pending) : ''}<ol class="gw-run">${run.result.steps.map((st) => `<li><b>${esc(st.agent)}</b>${st.skipped ? ` <small class="muted">${esc(st.skipped)}</small>` : `<div class="gw-answer">${esc(st.text)}</div>`}</li>`).join('')}</ol>`}</section>`
        : ''
    }`;
}

// Risk tier of the step after an approval gate (workflow catalog convention).
const WF_TIER = {
  R0: ['#5cf0a8', 'read-only research and analysis'],
  R1: ['#4de8ff', 'internal drafts'],
  R2: ['#ffb547', 'sends or changes something'],
  R3: ['#ff5ca8', 'money, access or decisions about a person'],
};

/* ---------- Code tools: connect AI coding tools to the gateway ---------- */
const FORMAT_LABEL = {
  anthropic: ['Anthropic Messages', '/v1/messages', '#ff8a4c'],
  responses: ['OpenAI Responses', '/v1/responses', '#5cf0a8'],
  gemini: ['Gemini', '/v1beta/models', '#4de8ff'],
  openai: ['OpenAI Chat', '/v1/chat/completions', '#8b7bff'],
};
function gwTools() {
  const d = gw.data;
  const model = gw.toolModel ?? (d.defaults.codeModel || d.defaults.model || '');
  const allModels = d.providers
    .flatMap((p) => (p.models || []).map((m) => `${p.id}/${m}`))
    .concat(d.routes.map((r) => r.name));
  const ok = d.tools.filter((t) => !t.unsupported);
  const connected = d.tools.filter((t) => t.state === 'connected');
  const secret = gw.toolSecret;
  return `<div class="live-metrics">${[
    metricTile({
      label: 'Tools supported',
      value: whole.format(ok.length),
      sub: `${d.tools.length - ok.length} cannot reach localhost`,
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'Connected',
      value: whole.format(connected.length),
      sub: connected.map((t) => esc(t.name)).join(' · ') || 'none yet',
      color: '#5cf0a8',
    }),
    metricTile({ label: 'Wire formats', value: '4', sub: 'Messages · Responses · Gemini · Chat', color: HOLO.violet }),
    metricTile({
      label: 'Requests by format',
      value: whole.format(Object.values(d.usage.byFormat || {}).reduce((a, b) => a + b, 0)),
      sub:
        Object.entries(d.usage.byFormat || {})
          .map(([k, v]) => `${k} ${v}`)
          .join(' · ') || 'this month',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Tokens saved',
      value: fmtN(d.usage.totals.savedTokens || 0),
      sub: `${fmtUSD(d.usage.totals.savedCost || 0)} · token saver`,
      color: HOLO.pink,
    }),
  ].join('')}</div>
  <section class="holo panel"><div class="panel-head"><h3>Model for tools</h3><span class="meta">tools send their own model names (claude-…, gpt-…-codex, gemini-…); unknown names go to the model map, then this model</span></div>
    <form class="gw-form gw-row" id="gw-tool-model"><datalist id="gw-tool-models">${allModels.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      <label>Model written into tool configs<input class="input" name="model" list="gw-tool-models" value="${esc(model)}" placeholder="router/coding or provider/model"></label>
      <label>Default for unknown tool models (code model)<input class="input" name="codeModel" list="gw-tool-models" value="${esc(d.defaults.codeModel || '')}" placeholder="${esc(d.defaults.model || 'provider/model')}"></label>
      <button class="btn" type="submit">Save</button></form></section>
  ${
    secret
      ? `<div class="ie-result good gw-secret"><b>${esc(secret.name)}: copy this now. The key is masked after you copy it or in 60 seconds.</b>
    <div class="gw-code"><button class="btn ghost gw-copy" type="button" data-gwtoolsecret>Copy</button><pre id="gw-tool-secret">${esc(secret.snippet)}</pre></div></div>`
      : ''
  }
  ${gw.toolMasked ? `<div class="ie-result gw-secret"><b>Copied and hidden.</b> The key now lives only in that tool's config; ZAAFPulse keeps its hash (Endpoint → API keys).</div>` : ''}
  <div class="pc-grid">${d.tools
    .map((t) => {
      const [fl, ep, fc] = FORMAT_LABEL[t.format] || FORMAT_LABEL.openai;
      const st =
        t.state === 'connected'
          ? ['connected', '#5cf0a8']
          : t.state === 'unsupported'
            ? ['not possible', '#8f98cc']
            : t.state === 'manual'
              ? ['manual setup', '#4de8ff']
              : ['not connected', '#ffb547'];
      return `<article class="pcard${t.unsupported ? ' off' : ''}" style="--v:${fc}"><div class="pc-head"><span class="pc-logo">${esc(t.name[0])}</span><div class="pc-title"><b>${esc(t.name)}</b><small>${esc(t.vendor)}</small></div><span class="state-pill" style="--c:${st[1]}"><i></i>${st[0]}</span></div>
      <div class="tags"><span class="tag" style="color:${fc}">${fl}</span><span class="tag mono">${ep}</span>${t.path ? `<span class="tag mono">${esc(t.path)}</span>` : ''}</div>
      ${t.unsupported ? `<p class="pc-desc">${esc(t.unsupported)}</p>` : `${t.note ? `<p class="pc-desc">${esc(t.note)}</p>` : ''}<details><summary class="muted">Snippet</summary>${codeBlock(t.snippet || '', `tool-${t.id}`)}</details>`}
      ${t.unsupported ? '' : `<div class="pc-foot">${t.canApply ? `<button class="btn" type="button" data-gwtool="apply" data-id="${esc(t.id)}">${t.state === 'connected' ? 'Re-apply' : 'Set up'}</button>` : ''}<button class="btn ghost" type="button" data-gwtool="key" data-id="${esc(t.id)}">New key + snippet</button>${t.hasBackup ? `<button class="btn ghost danger" type="button" data-gwtool="revert" data-id="${esc(t.id)}">Revert</button>` : ''}</div>`}</article>`;
    })
    .join('')}</div>
  <p class="kpi-sub">Set up writes the tool's own config file (mode 0600) with a dedicated key, after saving a backup that Revert restores; Revert also revokes that key. Endpoints: <code>${esc(d.baseUrl)}/v1/messages</code> (Claude Code), <code>/v1/responses</code> (Codex), <code>/v1beta/models/…</code> (Gemini CLI), <code>/v1/chat/completions</code> (everything else). Keys work as <code>Authorization: Bearer</code>, <code>x-api-key</code> or <code>x-goog-api-key</code>.</p>`;
}

/* ---------- Agent Skills ---------- */
function skillsPage() {
  const d = gw.data;
  const list = d.skills || [];
  return `<div class="live-metrics">${[
    metricTile({
      label: 'Skills',
      value: whole.format(list.length),
      sub: 'SKILL.md files in this version',
      color: HOLO.pink,
    }),
    metricTile({
      label: 'In Claude Code',
      value: whole.format(list.filter((x) => x.claude === 'installed').length),
      sub: `${list.filter((x) => x.claude === 'outdated').length} outdated`,
      color: '#5cf0a8',
    }),
    metricTile({ label: 'Served at', value: '/skills', sub: esc(d.baseUrl), color: HOLO.cyan }),
    metricTile({
      label: 'Keys with all scopes',
      value: whole.format(
        d.keys.filter((k) => !k.revokedAt && ['llm', 'agents', 'rag', 'mcp'].every((x) => k.scopes.includes(x))).length,
      ),
      sub: 'what the skills need',
      color: HOLO.violet,
    }),
  ].join('')}</div>
  ${gwSkillsPanel()}
  <p class="kpi-sub">Looking for what your AI tools actually used? <a class="link" href="#skills/usage">Usage in your tools →</a> shows the subagents, skills and tools from Claude Code and Codex sessions.</p>`;
}

/* ---------- Endpoint ---------- */
function endpointOverview() {
  const d = gw.data;
  const m = gw.mcp || {};
  const clients = m.clients || [];
  const active = d.keys.filter((k) => !k.revokedAt && !(k.expiresAt && Date.now() > k.expiresAt));
  const tools = (m.integrations || []).filter((i) => i.state === 'ok').reduce((a, i) => a + (i.tools || 0), 0);
  const routes = [
    ['POST', '/v1/chat/completions', 'llm', 'OpenAI chat, streaming; models, routes, agent/*, collab/*'],
    ['POST', '/v1/messages', 'llm', 'Anthropic Messages (Claude Code)'],
    ['POST', '/v1/responses', 'llm', 'OpenAI Responses (Codex)'],
    ['POST', '/v1beta/models/<m>:generateContent', 'llm', 'Gemini (Gemini CLI)'],
    ['POST', '/v1/embeddings', 'llm', 'Embeddings'],
    ['GET', '/v1/models', 'any', 'Models, routes, agents and patterns the key may use'],
    ['POST', '/v1/agents/<id>/run · /v1/orchestrate', 'agents', 'One agent, or the orchestrator'],
    ['POST', '/v1/collaborate · /v1/runs', 'agents', 'Multi-agent runs, approvals'],
    ['POST', '/v1/workflows/<id>/run', 'agents', 'Ready-made workflows'],
    ['POST', '/v1/knowledge/<id>/search', 'rag', 'RAG search and ingestion'],
    ['GET', '/v1/brain/search', 'rag', 'Second brain, read only'],
    ['POST', '/mcp', 'mcp', 'MCP over HTTP: every integration tool'],
    ['POST', '/a2a', 'agents', 'Agent2Agent JSON-RPC + SSE (card at /.well-known/agent-card.json)'],
    ['GET', '/skills/<name>/SKILL.md', 'none', 'Agent skills (docs, no key)'],
  ];
  return `<div class="live-metrics">${[
    metricTile({
      label: 'Base URL',
      value: esc(d.baseUrl.replace(/^https?:\/\//, '')),
      sub: localOnlyLabel(),
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'API keys',
      value: `${active.length} / ${d.keys.length}`,
      sub: 'active / total',
      color: HOLO.violet,
    }),
    metricTile({
      label: 'MCP clients',
      value: `${clients.filter((c) => c.registered).length} / ${clients.length}`,
      sub: 'registered (stdio)',
      color: '#5cf0a8',
    }),
    metricTile({
      label: 'MCP tools',
      value: whole.format(tools),
      sub: 'from connected integrations',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Code tools',
      value: whole.format(d.tools.filter((t) => t.state === 'connected').length),
      sub: 'connected to the API',
      color: HOLO.pink,
    }),
    metricTile({
      label: 'Requests · month',
      value: fmtN(d.usage.totals.requests),
      sub: `${fmtUSD(d.usage.totals.cost)} · ${pct(d.usage.totals.requests ? d.usage.totals.errors / d.usage.totals.requests : 0)} errors`,
      color: HOLO.blue,
    }),
  ].join('')}</div>
  ${panel('Set up a client in three steps', '', `<ol class="gw-run"><li><b><a class="link" href="#endpoint/keys">Create an API key</a></b> with the scopes the client needs.</li><li><b><a class="link" href="#endpoint/mcp">Register the MCP server</a></b> in Claude Code, Kiro or Antigravity, or connect over HTTP.</li><li><b><a class="link" href="#endpoint/connect">Copy a snippet</a></b>, or let <a class="link" href="#endpoint/tools">Code tools</a> write a coding tool's config for you.</li></ol>`)}
  ${panel('Endpoints', `${esc(d.baseUrl)} · keys as Bearer, x-api-key or x-goog-api-key`, `<div class="table-wrap"><table class="holo-table"><thead><tr><th></th><th>Path</th><th>Scope</th><th>For</th></tr></thead><tbody>${routes.map(([m, p, sc, f]) => `<tr><td class="muted mono">${m}</td><td class="mono">${esc(p)}</td><td><span class="tag">${sc}</span></td><td class="muted wrap">${esc(f)}</td></tr>`).join('')}</tbody></table></div>`)}`;
}
function endpointMcp() {
  const d = gw.data;
  const m = gw.mcp || {};
  const key = 'zp_YOUR_KEY';
  const clients = m.clients || [];
  const integ = m.integrations || [];
  return `${panel(
    'Registered in your AI clients',
    'stdio · the MCP server runs on demand',
    clients.length
      ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Client</th><th>Status</th><th>Config file</th><th></th></tr></thead><tbody>
      ${clients
        .map(
          (
            c,
          ) => `<tr><td><b>${esc(c.name)}</b></td><td><span class="state-pill" style="--c:${c.registered ? '#5cf0a8' : '#8f98cc'}"><i></i>${c.registered ? 'registered' : 'not registered'}</span></td><td class="muted mono">${esc(c.file)}</td>
        <td class="nowrap"><button class="btn ghost${c.registered ? ' danger' : ''}" type="button" data-mcpreg="${esc(c.id)}" data-remove="${c.registered ? '1' : ''}">${c.registered ? 'Remove' : 'Register'}</button></td></tr>`,
        )
        .join('')}</tbody></table></div>
      <p class="kpi-sub">Register writes only ZAAFPulse's own entry, after a backup of the file. The same as <code>npm run mcp:register -- &lt;client&gt;</code>.</p>${m.mcpCommand ? codeBlock(m.mcpCommand, 'mcp-cmd') : ''}<div id="mcp-reg-log"></div>`
      : holoEmpty('Could not read the MCP client list.'),
  )}
    ${panel(
      'Over HTTP',
      'for clients that connect by URL · key with the mcp scope',
      `${codeBlock(
        `claude mcp add --transport http zaafpulse ${location.origin}/mcp \
  --header "Authorization: Bearer ${key}"`,
        'mcp-c1',
      )}
      ${codeBlock(JSON.stringify({ mcpServers: { zaafpulse: { type: 'http', url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2), 'mcp-c2')}
      <p class="kpi-sub">Keys with the mcp scope: ${d.keys.filter((k) => !k.revokedAt && k.scopes.includes('mcp')).length}. <a class="link" href="#endpoint/keys">Create one →</a></p>`,
    )}
  ${panel(
    'What the server exposes',
    `${integ.filter((i) => i.state === 'ok').length} of ${integ.length} integrations connected · configure them under Integrations`,
    integ.length
      ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Integration</th><th>Status</th><th class="r">Tools</th><th class="r">Write tools</th></tr></thead><tbody>
    ${integ.map((i) => `<tr><td><b>${esc(i.id)}</b></td><td><span class="state-pill" style="--c:${i.state === 'ok' ? '#5cf0a8' : i.state === 'error' ? '#ff8aa3' : '#8f98cc'}"><i></i>${esc(i.state)}</span></td><td class="r num">${i.tools || 0}</td><td class="r num">${i.writeTools || 0}</td></tr>`).join('')}</tbody></table></div>
    <div class="gw-row"><a class="btn ghost" href="#integrations">Configure integrations →</a></div>`
      : holoEmpty('No integrations.'),
  )}`;
}

// Agent skills: SKILL.md files that teach an AI to use ZAAFPulse, served here and installable into Claude Code.
function gwSkillsPanel() {
  const d = gw.data;
  const list = d.skills || [];
  const inst = list.filter((x) => x.claude === 'installed').length;
  const old = list.filter((x) => x.claude === 'outdated').length;
  const mine = (st) => st === 'installed' || st === 'outdated';
  const ours = list.some((x) => mine(x.claude) || mine(x.agents));
  const roots = d.skillRoots || { claude: '~/.claude/skills', agents: '~/.agents/skills' };
  const where = gw.skillTarget || 'claude';
  const places = [
    ['claude', `Claude Code (${roots.claude})`],
    ['agents', `Other agents (${roots.agents})`],
    ['all', 'Both'],
  ];
  const pill = (st) => {
    const [c, l] = {
      installed: ['#5cf0a8', 'installed'],
      outdated: ['#ffb547', 'outdated'],
      yours: ['#8f98cc', 'your own skill'],
      'not installed': ['#8f98cc', 'not installed'],
    }[st] || ['#8f98cc', st];
    return `<span class="state-pill" style="--c:${c}"><i></i>${l}</span>`;
  };
  return `<section class="holo panel"><div class="panel-head"><h3>Agent skills</h3><span class="meta">${list.length} skills · Claude Code: ${inst} installed${old ? `, ${old} outdated` : ''} · served from this version at ${esc(d.baseUrl)}/skills</span></div>
    <p class="kpi-sub">Skills teach an AI agent to use ZAAFPulse: chat on any provider, the 17 agents, collaboration, workflows with approval gates, RAG, the second brain, MCP and A2A. Install them into Claude Code, or paste the line below to any AI. They are read from this gateway, so they always match what is running.</p>
    <div class="table-wrap"><table class="holo-table"><thead><tr><th>Skill</th><th>What it teaches</th><th>Claude Code</th><th>Other agents</th><th></th></tr></thead><tbody>
      ${list.map((x) => `<tr><td><b class="mono">${esc(x.name)}</b></td><td class="muted wrap">${esc(((d) => (d.length > 140 ? `${d.slice(0, 140).replace(/\s+\S*$/, '')}…` : `${d}.`))(x.description.split('. ')[0]))}</td><td>${pill(x.claude)}</td><td>${pill(x.agents)}</td><td><a class="btn ghost" href="${esc(x.path)}" target="_blank" rel="noopener">View</a></td></tr>`).join('')}</tbody></table></div>
    <div class="gw-row"><label>Location<select class="input" data-gwskilltarget>${places.map(([v, l]) => `<option value="${v}" ${v === where ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label><button class="btn" type="button" data-gwskills="install">Install or update</button>${ours ? '<button class="btn ghost danger" type="button" data-gwskills="uninstall">Remove</button>' : ''}<button class="btn ghost" type="button" data-gwskills="key">New key for skills</button></div>
    ${codeBlock(`Read this skill and use it: ${d.baseUrl}/skills/zaafpulse/SKILL.md`, 'gw-skill-line')}
    <p class="kpi-sub">The skills read <code>ZAAFPULSE_URL</code> and <code>ZAAFPULSE_KEY</code> from the environment; "New key for skills" makes a key with all four scopes and shows the two exports once. Install writes <code>${esc(roots.claude)}/zaafpulse*</code> for Claude Code, <code>${esc(roots.agents)}/zaafpulse*</code> for other agents that read the shared Agent Skills folder, or both, and never overwrites a skill of your own with the same name.</p></section>`;
}

/* ---------- Model router: quota, token saver, model map ---------- */
function routerExtras() {
  const d = gw.data;
  const t = d.usage.totals;
  const s = d.settings || { tokenSaver: true, modelMap: [] };
  const left = (x) => (x && x.remaining != null ? `${fmtN(x.remaining)}${x.limit ? ` / ${fmtN(x.limit)}` : ''}` : '—');
  const reset = (x) =>
    x && x.resetAt ? (x.resetAt > Date.now() ? `in ${msFmt(x.resetAt - Date.now())}` : 'reset') : '—';
  const rows = (d.quota || []).filter((q) => q.at || q.cooldown || q.token || q.balance);
  const map = gw.editMap || s.modelMap.map((m) => ({ ...m }));
  const quota = rows.length
    ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Provider</th><th class="r">Requests left</th><th class="r">Tokens left</th><th class="r">Resets</th><th>Cooldown</th><th>Token</th><th class="r">Balance</th></tr></thead><tbody>
    ${rows
      .map(
        (
          q,
        ) => `<tr><td><b>${esc(q.id)}</b>${q.at ? `<small class="block muted">read ${ago(q.at)}${q.status ? ` · HTTP ${q.status}` : ''}</small>` : ''}</td><td class="r num">${left(q.requests)}</td><td class="r num">${left(q.tokens)}</td><td class="r muted">${reset(q.requests && q.requests.resetAt ? q.requests : q.tokens)}</td>
      <td>${q.cooldown ? `<span class="state-pill" style="--c:#ffb547"><i></i>${esc(q.cooldown.reason)} · ${msFmt(q.cooldown.until - Date.now())}</span>` : '<span class="muted">—</span>'}</td>
      <td class="muted">${q.token ? `refreshes itself · expires in ${msFmt(q.token.expiresAt - Date.now())}` : '—'}</td>
      <td class="r num">${q.balance ? (q.balance.error ? `<small class="ie-err">${esc(q.balance.error)}</small>` : `${q.balance.remaining != null ? Number(q.balance.remaining).toFixed(2) : '—'} ${esc(q.balance.currency || '')}`) : '—'}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
    : holoEmpty(
        'No readings yet. Every answer from a provider updates its rate-limit reading; balances load when you refresh.',
      );
  return `<div class="live-grid even">
    ${panel('Quota & cooldown', 'from rate-limit headers and balance APIs', `${quota}<div class="gw-row"><button class="btn ghost" type="button" data-gwquota>Refresh balances</button><span class="muted">After a 429 a provider cools down (its reset time, or 1 s doubling to 5 min) and routes try the next target.</span></div>`)}
    ${panel(
      'Token saver',
      'shortens long tool results before they go upstream',
      `<div class="live-metrics three">${[
        metricTile({ label: 'Tokens saved', value: fmtN(t.savedTokens || 0), sub: 'this month', color: HOLO.pink }),
        metricTile({
          label: 'Est. cost saved',
          value: fmtUSD(t.savedCost || 0),
          sub: 'at input price',
          color: '#5cf0a8',
        }),
        metricTile({
          label: 'Requests shortened',
          value: whole.format(t.saverHits || 0),
          sub: `of ${whole.format(t.requests || 0)}`,
          color: HOLO.cyan,
        }),
      ].join('')}</div>
      <label class="ie-switch"><input type="checkbox" data-gwsaver ${s.tokenSaver ? 'checked' : ''}><span></span>Token saver ${s.tokenSaver ? 'on' : 'off'} <small class="muted">(per request: header <code>x-zp-token-saver: off</code>)</small></label>
      <p class="kpi-sub">Results over 600 characters are cut by a filter picked from the tool call and the output: git diff (60 lines per hunk), git log, git status, build and test output (errors kept, progress counted), grep (10 matches per file), file listings (noise folders dropped), large JSON (arrays cut to 20), long reads (start and end) and logs (repeats collapsed). ANSI colours are removed. Error results are never touched.</p>`,
    )}
  </div>
  <section class="holo panel"><div class="panel-head"><h3>Model map</h3><span class="meta">tool model names → your models · first match wins · globs with *</span></div>
    <form class="gw-form" id="gw-map-form">${map.map((m, i) => `<div class="gw-row"><label>When the model is<input class="input mono" name="match-${i}" value="${esc(m.match)}" placeholder="claude-*opus*"></label><label>Use<input class="input mono" name="to-${i}" list="gw-models" value="${esc(m.to)}" placeholder="router/coding"></label><button class="icon-btn" type="button" data-gwmap="rm" data-i="${i}" aria-label="Remove">×</button></div>`).join('') || '<p class="muted">No rules: unknown names go to the code model, then the default model.</p>'}
      <div class="gw-row"><button class="btn ghost" type="button" data-gwmap="add">+ Add rule</button><button class="btn" type="submit">Save map</button><span class="muted">e.g. claude-*haiku* → ollama/qwen2.5-coder, claude-* → router/coding, gpt-*-codex → openrouter/…</span></div></form></section>`;
}

/* ---------- RAG: API & usage ---------- */
function ragConnect() {
  const d = gw.data;
  const key = 'zp_YOUR_KEY';
  const kb = (d.knowledge[0] || {}).id || 'company-policies';
  const logs = (gw.logs || []).filter((e) => e.kind === 'embeddings');
  const users = d.agents.filter((a) => (a.knowledge || []).length);
  return `<div class="live-metrics">${[
    metricTile({
      label: 'Knowledge bases',
      value: whole.format(d.knowledge.length),
      sub: `${fmtN(d.knowledge.reduce((x, k) => x + k.documents, 0))} documents`,
      color: '#3ee6b0',
    }),
    metricTile({
      label: 'Chunks',
      value: fmtN(d.knowledge.reduce((x, k) => x + k.chunks, 0)),
      sub: `${fmtN(d.knowledge.reduce((x, k) => x + k.chars, 0))} characters`,
      color: '#3ee6b0',
    }),
    metricTile({
      label: 'Vectors',
      value: fmtN(d.knowledge.reduce((x, k) => x + k.embedded, 0)),
      sub: `${d.knowledge.filter((k) => k.embedModel).length} bases with embeddings`,
      color: HOLO.violet,
      p: d.knowledge.reduce((x, k) => x + k.chunks, 0)
        ? d.knowledge.reduce((x, k) => x + k.embedded, 0) / d.knowledge.reduce((x, k) => x + k.chunks, 0)
        : null,
    }),
    metricTile({
      label: 'Agents using RAG',
      value: whole.format(users.length),
      sub:
        users
          .slice(0, 3)
          .map((a) => esc(a.name))
          .join(' · ') || 'attach one under Agent-to-Agent',
      color: HOLO.pink,
    }),
    metricTile({
      label: 'Keys with rag scope',
      value: whole.format(d.keys.filter((k) => k.scopes.includes('rag') && !k.revokedAt).length),
      sub: 'can search and ingest',
      color: HOLO.cyan,
    }),
    metricTile({ label: 'Embedding calls', value: whole.format(logs.length), sub: 'recent', color: HOLO.blue }),
  ].join('')}</div>
  <div class="live-grid even">
    ${panel('From your apps', 'key with the rag scope', `${codeBlock(`# Search (hybrid: embeddings + BM25)\ncurl ${GW_BASE}/knowledge/${kb}/search -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"query": "refund limit", "k": 3}'\n\n# Add a document (text, markdown, html, csv or json)\ncurl ${GW_BASE}/knowledge/${kb}/documents -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"title": "Refunds", "content": "Refunds up to $100 need no approval.", "kind": "text"}'\n\n# List knowledge bases\ncurl ${GW_BASE}/knowledge -H "Authorization: Bearer ${key}"`, 'rag-c1')}`)}
    ${panel(
      'How it works',
      '',
      `<ol class="gw-run"><li><b>Ingest.</b> Text is cleaned (HTML loses tags and scripts) and split into ~900-character chunks that overlap by 150.</li>
      <li><b>Embed.</b> With an embedding model set on the knowledge base (any provider, e.g. <code>ollama/nomic-embed-text</code>), each chunk gets a vector stored in <code>.data/kb/</code>.</li>
      <li><b>Search.</b> Queries are ranked by 0.65 × cosine similarity + 0.35 × BM25 keyword score, or BM25 alone without embeddings.</li>
      <li><b>Answer.</b> Agents with the knowledge base attached call <code>zp_knowledge_search</code> and cite the document titles they used.</li></ol>`,
    )}
  </div>`;
}

/* ---------- Agent-to-Agent: collaboration ---------- */
function a2aCollaboration() {
  const d = gw.data;
  const on = d.agents.filter((a) => a.enabled && a.collaborate !== false);
  const agentLogs = (gw.logs || []).filter((e) => e.agent && e.kind === 'agent');
  return `<div class="live-metrics">${[
    metricTile({
      label: 'Collaborating agents',
      value: `${on.length} / ${d.agents.filter((a) => a.enabled).length}`,
      sub: 'may call zp_ask_agent',
      color: HOLO.pink,
      p: d.agents.length ? on.length / d.agents.length : null,
    }),
    metricTile({
      label: 'Workflows',
      value: whole.format(d.workflows.length),
      sub: `${d.workflows.reduce((x, w) => x + w.steps.length, 0)} steps in total`,
      color: '#c45cf2',
    }),
    metricTile({
      label: 'Agent model calls',
      value: whole.format(agentLogs.length),
      sub: 'recent, across agents',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Consult depth',
      value: '2',
      sub: 'an agent may ask one, which may ask one more',
      color: HOLO.violet,
    }),
  ].join('')}</div>
  <section class="holo panel"><div class="panel-head"><h3>Who may consult whom</h3><span class="meta">click a toggle to change it · consulted agents keep their own prompt, tools and knowledge</span></div>
    <div class="table-wrap"><table class="holo-table"><thead><tr><th>Agent</th><th>Domain</th><th>Collaborates</th><th>Tools</th><th>Knowledge</th><th class="r">Recent calls</th></tr></thead><tbody>
      ${d.agents
        .map(
          (
            a,
          ) => `<tr class="${a.enabled ? '' : 'idle-row'}"><td><b>${esc(a.name)}</b><small class="block muted mono">agent/${esc(a.id)}</small></td><td class="muted">${esc(a.domain)}</td>
        <td><label class="ie-switch"><input type="checkbox" data-a2acollab="${esc(a.id)}" ${a.collaborate !== false ? 'checked' : ''} ${a.enabled ? '' : 'disabled'}><span></span>${a.collaborate !== false ? 'yes' : 'no'}</label></td>
        <td class="muted">${esc(a.tools.join(', ') || 'memory only')}</td><td class="muted">${esc((a.knowledge || []).join(', ') || '—')}</td>
        <td class="r num">${agentLogs.filter((e) => e.agent === a.id).length}</td></tr>`,
        )
        .join('')}</tbody></table></div></section>
  <div class="live-grid even">
    ${panel(
      'Patterns',
      'pick one under Collaborate, or call it by API',
      `<ol class="gw-run">${Object.entries(d.patterns)
        .map(
          ([id, p]) =>
            `<li><b>${esc(p.name)}</b> · <code>${esc(id)}</code><small class="muted" style="display:block">${esc(p.description)}</small></li>`,
        )
        .join('')}</ol>`,
    )}
    ${panel(
      'Guards in every run',
      'against the usual multi-agent failures',
      `<ol class="gw-run">
      <li><b>Budgets.</b> Tokens, model calls, time and an optional cost cap per run, scaled by effort (simple, standard, deep). Workers stop at 85% so judging and the final answer always fit; past 80% patterns stop adding rounds, samples and revisions.</li>
      <li><b>Termination.</b> Hard caps on agents (8), samples (15), debate rounds (3), review iterations (4) and group turns (30); runs stop early on agreement, a passed rubric, no improvement, a repeated critique or a stalled team.</li>
      <li><b>Loops.</b> Consult depth 2, no consulting an agent already on the request, a per-run answer cache for repeated questions, and a third identical tool call is refused.</li>
      <li><b>Trust.</b> One agent's output reaches another as quoted data (<code>&lt;agent_output&gt;</code>), never as instructions; remote A2A agents are external and blocked for private-only keys.</li>
      <li><b>Verification and people.</b> Voting with a quorum, an order-swapped judge for ties, flags when agreement is low, a critic pass on deep runs, and workflow approval gates that pause the run until someone decides.</li>
      <li><b>Tracing.</b> Spans with OpenTelemetry GenAI names (invoke_workflow, plan, invoke_agent, execute_tool, chat) carrying tokens, cost and timing, never prompt text.</li></ol>`,
    )}
  </div>
  ${panel(
    'Agent2Agent (A2A) protocol',
    'other agents and A2A clients can call ZAAFPulse',
    `<p class="kpi-sub">The agent card lists every pattern, agent and workflow as a skill. Calls are JSON-RPC 2.0 (v1.0 method names, v0.3 accepted) with a key that has the agents scope; streaming uses SSE. Pick a skill with <code>message.metadata.skill</code>.</p>
    ${codeBlock(`# Discover\ncurl ${location.origin}/.well-known/agent-card.json\n\n# Ask (blocking); skill: auto | vote | debate | review | group | handoff | agent:<id> | workflow:<id>\ncurl ${location.origin}/a2a -H "Authorization: Bearer zp_YOUR_KEY" -H "Content-Type: application/json" -d '{\n  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",\n  "params": { "message": { "messageId": "m1", "role": "ROLE_USER",\n    "parts": [{ "text": "Is checkout healthy?" }],\n    "metadata": { "skill": "vote", "options": { "samples": 5 } } } } }'\n\n# Then: GetTask, ListTasks, CancelTask, SendStreamingMessage (SSE), SubscribeToTask`, 'a2a-c1')}
    ${codeBlock(`# Same engine over REST\ncurl ${GW_BASE}/collaborate -H "Authorization: Bearer zp_YOUR_KEY" -H "Content-Type: application/json" \\\n  -d '{"pattern": "review", "task": "Draft the outage postmortem", "agent": "sre-observability", "effort": "deep"}'\n\n# From any OpenAI client: model "collab/vote", "collab/debate", "collab/group", ...\ncurl ${GW_BASE}/runs -H "Authorization: Bearer zp_YOUR_KEY"`, 'a2a-c2')}
    <p class="kpi-sub">A remote A2A agent can join the team too: give an agent a remote URL under Specialist agents and ZAAFPulse sends its part of the work to that server.</p>`,
  )}
  <p class="kpi-sub">The orchestrator (agent/auto) plans across agents; workflows chain them in a fixed order; and during a run any collaborating agent can ask another for its part with zp_ask_agent or hand the conversation on with zp_handoff.</p>`;
}

/* ---------- Agent-to-Agent: collaborate, runs and the run view ---------- */
// A gated step: the exact actions the agent proposed (tick the ones to run) and its plan. Only the ticked
// calls run after Approve, exactly as shown.
function approvalView(p) {
  const calls = p.proposals || [];
  return `<div class="gw-plan approval"><b>Waiting for approval · step ${esc(p.step)} (${esc(p.agent)})</b>
    ${
      calls.length
        ? `<small>These actions run only if you approve them, exactly as shown:</small><ul class="approval-calls">${calls
            .map(
              (c) =>
                `<li><label class="gw-check"><input type="checkbox" data-approve-call="${esc(c.id)}" checked> <b>#${esc(c.id)}</b> <code>${esc(c.tool)}</code></label><pre class="mono approval-args">${esc(JSON.stringify(c.args, null, 2).slice(0, 2000))}</pre></li>`,
            )
            .join('')}</ul>`
        : '<small>No action that changes anything was proposed; approving lets the workflow go on.</small>'
    }
    ${p.draft ? `<details><summary class="muted">The agent's plan</summary><div class="gw-answer">${esc(p.draft)}</div></details>` : ''}</div>`;
}

const RUN_STATE = {
  submitted: ['#8f98cc', 'queued'],
  working: ['#4de8ff', 'working'],
  'input-required': ['#ffb547', 'needs approval'],
  completed: ['#5cf0a8', 'completed'],
  failed: ['#ff4f6d', 'failed'],
  canceled: ['#8f98cc', 'canceled'],
  rejected: ['#ff8aa3', 'rejected'],
};
const runPill = (s) => {
  const [c, l] = RUN_STATE[s] || ['#8f98cc', s];
  return `<span class="state-pill" style="--c:${c}"><i></i>${esc(l)}</span>`;
};
const SPAN_COLOR = {
  invoke_workflow: '#c45cf2',
  plan: '#8b7bff',
  invoke_agent: '#ff5ca8',
  chat: '#5b8cff',
  execute_tool: '#ffb547',
  judge: '#4de8ff',
};
// Which options each pattern uses, so the form only shows what matters.
const PATTERN_OPTS = {
  auto: ['verify'],
  parallel: ['agents', 'size', 'aggregator'],
  vote: ['agents', 'samples'],
  debate: ['agents', 'size', 'rounds'],
  review: ['agent', 'critic', 'iterations', 'threshold'],
  group: ['agents', 'size', 'turns'],
  handoff: ['agent', 'maxHandoffs'],
  agent: ['agent'],
};
gw.collab = {
  pattern: 'auto',
  effort: 'standard',
  agents: [],
  task: '',
  opts: {},
  runId: null,
  run: null,
  timer: null,
  view: null,
};

function runView(run) {
  if (!run) return '';
  const total = Math.max(1, ...run.trace.map((s) => s.end ?? s.start));
  const byId = Object.fromEntries(run.trace.map((s) => [s.id, s]));
  const depth = (s) => {
    let d = 0;
    let p = s.parent;
    while (p && byId[p] && d < 6) {
      d++;
      p = byId[p].parent;
    }
    return d;
  };
  const spans = run.trace
    .slice(0, 160)
    .map((s) => {
      const kind = s.name.split(' ')[0];
      const end = s.end ?? total;
      const a = s.attrs || {};
      const tok = (a['gen_ai.usage.input_tokens'] || 0) + (a['gen_ai.usage.output_tokens'] || 0);
      return `<div class="a2a-span${s.status === 'error' ? ' err' : ''}" style="--d:${depth(s)}" title="${esc(s.name)}${s.error ? ` · ${esc(s.error)}` : ''}"><span class="a2a-span-name">${esc(s.name)}</span>
      <span class="a2a-span-track"><i style="left:${((s.start / total) * 100).toFixed(2)}%;width:${Math.max(0.6, ((end - s.start) / total) * 100).toFixed(2)}%;background:${SPAN_COLOR[kind] || '#8f98cc'}"></i></span>
      <span class="a2a-span-meta">${s.end == null ? '…' : msFmt(end - s.start)}${tok ? ` · ${fmtN(tok)} tok` : ''}</span></div>`;
    })
    .join('');
  const b = run.budget;
  const sp = run.spent;
  const meter = meters([
    {
      label: 'Tokens',
      value: sp.tokens,
      max: b.tokens,
      color: HOLO.cyan,
      right: `${fmtN(sp.tokens)} / ${fmtN(b.tokens)}`,
    },
    {
      label: 'Model calls',
      value: sp.requests,
      max: b.calls,
      color: HOLO.violet,
      right: `${sp.requests} / ${b.calls}`,
    },
    ...(b.costUSD != null
      ? [
          {
            label: 'Cost',
            value: sp.cost,
            max: b.costUSD,
            color: HOLO.orange,
            right: `${fmtUSD(sp.cost)} / ${fmtUSD(b.costUSD)}`,
          },
        ]
      : []),
  ]);
  const v = run.verdict;
  const verdict = !v
    ? ''
    : v.clusters
      ? `<div class="gw-plan"><b>Verdict · ${esc(v.method)} · ${pct(v.agreement)} agreement${v.needsReview ? ' · <span class="warn-text">needs a human look</span>' : ''}</b>
      ${meters(v.clusters.slice(0, 5).map((c, i) => ({ label: `${esc(c.answer)} <small class="muted">${esc([...new Set(c.agents)].join(', '))}</small>`, value: c.votes, max: v.valid || 1, color: i ? '#8f98cc' : '#5cf0a8', right: `${c.votes} vote${c.votes === 1 ? '' : 's'}` })))}
      ${v.judge ? `<small>Judge: ${esc(v.judge.reason)}${v.judge.agreed ? '' : ' (changed with the order)'}</small>` : ''}</div>`
      : `<div class="gw-plan"><b>Critic · score ${v.score == null ? '—' : v.score}${v.threshold ? ` (pass ${v.threshold})` : ''} · ${v.pass ? 'passed' : 'not passed'}</b>${v.scores ? `<small>${v.scores.map((s) => `#${s.iteration}: ${s.score}`).join(' → ')}${v.best ? ` · kept #${v.best}` : ''}</small>` : ''}${v.issues && v.issues.length ? `<ul>${v.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  const steps = run.steps.length
    ? `<ol class="gw-run">${run.steps
        .map(
          (
            s,
          ) => `<li><b>${esc(s.agent || '')}</b> ${s.role ? `<span class="tag">${esc(s.role)}${s.round ? ` · round ${s.round}` : ''}${s.iteration ? ` · #${s.iteration}` : ''}${s.turn ? ` · turn ${s.turn}` : ''}${s.sample ? ` · #${s.sample}` : ''}</span>` : ''}${s.final ? ` <span class="tag">${esc(s.final)} · ${s.confidence}</span>` : ''}${s.handoffTo ? ` <span class="tag">→ ${esc(s.handoffTo)}</span>` : ''}
      ${s.status === 'skipped' ? `<small class="block muted">${esc(s.skipped)}</small>` : s.error ? `<small class="block ie-err">${esc(s.error)}</small>` : `<details><summary class="muted">${esc(String(s.text).slice(0, 110))}${String(s.text).length > 110 ? '…' : ''}</summary><div class="gw-answer">${esc(s.text)}</div></details>`}
      ${s.calls && s.calls.length ? `<small class="block muted">tools: ${s.calls.map((c) => `${esc(c.tool)}${c.ok ? '' : ' ✕'}`).join(', ')}</small>` : ''}</li>`,
        )
        .join('')}</ol>`
    : holoEmpty('No steps yet.');
  const board = run.blackboard.length
    ? `<div class="feed">${run.blackboard
        .slice(-40)
        .map(
          (e) =>
            `<div class="gw-note"><span class="tag">${esc(e.kind)}</span><p><b>${esc(e.by)}</b>${e.to ? ` → ${esc(e.to)}` : ''}: ${esc(String(e.text).slice(0, 600))}</p></div>`,
        )
        .join('')}</div>`
    : holoEmpty('Nothing posted yet.');
  const live = run.state === 'working' || run.state === 'submitted';
  return `<section class="holo panel"><div class="panel-head"><h3>${esc(PATTERN_LABEL(run.pattern))} · ${esc(run.title)}</h3><span class="meta">${runPill(run.state)} ${esc(run.id)} · ${esc(run.effort)}${run.elapsedMs ? ` · ${msFmt(run.elapsedMs)}` : ''}</span></div>
      <div class="gw-row">${live ? `<button class="btn ghost danger" type="button" data-a2arun="cancel" data-id="${esc(run.id)}">Cancel</button>` : ''}
        ${run.state === 'input-required' ? `<button class="btn" type="button" data-a2arun="approve" data-id="${esc(run.id)}">Approve step ${run.pending ? run.pending.step : ''}</button><button class="btn ghost danger" type="button" data-a2arun="reject" data-id="${esc(run.id)}">Reject</button>` : ''}
        ${run.stop ? `<span class="muted">${esc(run.stop.reason)}</span>` : ''}${run.error ? `<code class="ie-err">${esc(run.error)}</code>` : ''}</div>
      ${run.state === 'input-required' && run.pending ? approvalView(run.pending) : ''}
      ${run.answer ? `<div class="gw-answer">${esc(run.answer)}</div>` : live ? '<div class="skeleton" style="height:70px"></div>' : ''}
      ${verdict}
      <div class="live-grid even">${panel('Budget', `${pct(Math.max(sp.tokens / b.tokens, sp.requests / b.calls))} used · degrade at 80%, reserve 15%`, meter)}${panel('Plan', run.plan ? esc(run.plan.method) : 'pattern', run.plan ? `<ol class="gw-run">${run.plan.steps.map((s) => `<li><span class="tag">${esc(s.id)}</span> <b>${esc(s.agent)}</b> ${esc(s.instruction)}${s.dependsOn.length ? ` <small class="muted">after ${esc(s.dependsOn.join(', '))}</small>` : ''}</li>`).join('')}</ol>` : `<p class="kpi-sub">${esc((gw.data.patterns[run.pattern] || {}).description || '')}</p>`)}</div>
      ${panel('Trace', `${run.trace.length} spans · OpenTelemetry GenAI names · no prompt text`, `<div class="a2a-trace">${spans}</div>`)}
      <div class="live-grid even">${panel('Steps', `${run.steps.length}`, steps)}${panel('Blackboard', `${run.blackboard.length} entries`, board)}</div></section>`;
}
const PATTERN_LABEL = (id) => ((gw.data && gw.data.patterns && gw.data.patterns[id]) || {}).name || id;

function a2aCollaborate() {
  const d = gw.data;
  const c = gw.collab;
  const opts = PATTERN_OPTS[c.pattern] || [];
  const on = d.agents.filter((a) => a.enabled);
  const agentSel = (name, label, sel) =>
    `<label>${label}<select class="input" name="${name}"><option value="">${name === 'agent' ? 'best match' : 'judge model'}</option>${on.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`;
  const num = (name, label, min, max) =>
    `<label>${label}<input class="input" type="number" name="${name}" min="${min}" max="${max}" value="${esc(c.opts[name] ?? '')}" placeholder="${esc(String((d.effort[c.effort] || {})[name] ?? ''))}"></label>`;
  const fields = [
    opts.includes('agent') ? agentSel('agent', c.pattern === 'review' ? 'Worker' : 'Agent', c.opts.agent) : '',
    opts.includes('critic') ? agentSel('critic', 'Critic', c.opts.critic) : '',
    opts.includes('aggregator') ? agentSel('aggregator', 'Synthesizer', c.opts.aggregator) : '',
    opts.includes('samples') ? num('samples', 'Samples', 1, 15) : '',
    opts.includes('rounds') ? num('rounds', 'Rounds', 1, 3) : '',
    opts.includes('iterations') ? num('iterations', 'Iterations', 1, 4) : '',
    opts.includes('turns') ? num('turns', 'Turns', 1, 30) : '',
    opts.includes('size') ? num('size', 'Team size', 2, 8) : '',
    opts.includes('maxHandoffs')
      ? `<label>Max handoffs<input class="input" type="number" name="maxHandoffs" min="0" max="5" value="${esc(c.opts.maxHandoffs ?? '')}" placeholder="3"></label>`
      : '',
    opts.includes('threshold')
      ? `<label>Pass score<input class="input" type="number" step="0.05" name="threshold" min="0.1" max="1" value="${esc(c.opts.threshold ?? '')}" placeholder="0.8"></label>`
      : '',
    opts.includes('verify')
      ? `<label class="ie-switch"><input type="checkbox" name="verify" ${(c.opts.verify ?? c.effort === 'deep') ? 'checked' : ''}><span></span>Verify with a critic</label>`
      : '',
  ]
    .filter(Boolean)
    .join('');
  const cards = Object.entries(d.patterns)
    .filter(([id]) => id !== 'workflow')
    .map(
      ([id, p]) =>
        `<button type="button" class="a2a-pattern${id === c.pattern ? ' on' : ''}" data-a2apattern="${id}"><b>${esc(p.name)}</b><small>${esc(p.description)}</small></button>`,
    )
    .join('');
  return `<div class="a2a-patterns">${cards}</div>
    <section class="holo panel"><div class="panel-head"><h3>Run ${esc(PATTERN_LABEL(c.pattern))}</h3><span class="meta">runs as the dashboard · spends tokens on ${esc(d.defaults.model || 'no default model')}</span></div>
      <form class="gw-form" id="a2a-form">
        <div class="gw-row"><label>Effort<select class="input" name="effort">${Object.entries(d.effort)
          .map(
            ([k, e]) =>
              `<option value="${k}" ${k === c.effort ? 'selected' : ''}>${k} · ${fmtN(e.tokens)} tokens · ${e.calls} calls</option>`,
          )
          .join('')}</select></label>
          <label>Token budget<input class="input" type="number" name="tokens" min="1000" value="${esc(c.opts.tokens ?? '')}" placeholder="${esc(String(d.effort[c.effort].tokens))}"></label><label>Cost cap (USD)<input class="input" type="number" step="0.01" name="costUSD" min="0" value="${esc(c.opts.costUSD ?? '')}" placeholder="none"></label>${fields}</div>
        ${opts.includes('agents') ? `<div><small class="muted">Agents (none picked = best keyword matches)</small><div class="tags a2a-agents">${on.map((a) => `<label class="tag a2a-chip"><input type="checkbox" name="agents" value="${a.id}" ${c.agents.includes(a.id) ? 'checked' : ''}>${esc(a.name)}</label>`).join('')}</div></div>` : ''}
        <textarea class="input" name="task" rows="4" placeholder="e.g. Checkout latency doubled since 10:00. Find the cause and draft a customer update.">${esc(c.task)}</textarea>
        <div id="a2a-errors"></div>
        <div class="gw-row"><button class="btn" type="submit" ${!d.defaults.model ? 'disabled' : ''}>Run</button>${!d.defaults.model ? '<span class="muted">Set a default model under Agent Gateway → Providers first.</span>' : '<span class="muted">Vote is the default way to buy accuracy; debate rarely beats it at the same cost.</span>'}</div>
      </form></section>
    <div id="a2a-run">${runView(c.run)}</div>`;
}

function a2aRuns() {
  const d = gw.data;
  const v = gw.collab.view;
  const rows = d.runs
    .map(
      (
        r,
      ) => `<tr><td><b>${esc(r.title)}</b><small class="block muted mono">${esc(r.id)}</small></td><td>${esc(PATTERN_LABEL(r.pattern))}</td><td>${runPill(r.state)}${r.needsReview ? ' <span class="tag warn">review</span>' : ''}</td>
    <td class="muted">${esc(r.agents.slice(0, 4).join(', '))}${r.agents.length > 4 ? ` +${r.agents.length - 4}` : ''}</td><td class="r num">${fmtN(r.spent.tokens)}</td><td class="r num">${fmtUSD(r.spent.cost)}</td><td class="r muted">${ago(r.updatedAt)}</td>
    <td><button class="btn ghost" type="button" data-a2arun="view" data-id="${esc(r.id)}">Open</button></td></tr>`,
    )
    .join('');
  const st = (s) => d.runs.filter((r) => r.state === s).length;
  return `<div class="live-metrics">${[
    metricTile({
      label: 'Runs',
      value: whole.format(d.runs.length),
      sub: 'last 40 kept on screen, 200 on disk',
      color: HOLO.cyan,
    }),
    metricTile({
      label: 'Completed',
      value: whole.format(st('completed')),
      sub: `${st('failed')} failed · ${st('canceled')} canceled`,
      color: '#5cf0a8',
      p: d.runs.length ? st('completed') / d.runs.length : null,
    }),
    metricTile({
      label: 'Waiting for approval',
      value: whole.format(st('input-required')),
      sub: 'workflow approval gates',
      color: HOLO.orange,
    }),
    metricTile({
      label: 'Need a human look',
      value: whole.format(d.runs.filter((r) => r.needsReview).length),
      sub: 'low agreement or an unsure judge',
      color: HOLO.pink,
    }),
    metricTile({
      label: 'Tokens',
      value: fmtN(d.runs.reduce((x, r) => x + r.spent.tokens, 0)),
      sub: fmtUSD(d.runs.reduce((x, r) => x + r.spent.cost, 0)),
      color: HOLO.violet,
    }),
  ].join('')}</div>
  ${panel('Runs', 'dashboard, API and A2A', d.runs.length ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Task</th><th>Pattern</th><th>State</th><th>Agents</th><th class="r">Tokens</th><th class="r">Cost</th><th class="r">Updated</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : holoEmpty('No collaboration runs yet. Start one under Collaborate.'))}
  <div id="a2a-run">${runView(v)}</div>`;
}

// Polls a run while it works and repaints only its panel, so the form keeps what was typed.
function watchRun(id, into = 'run') {
  clearTimeout(gw.collab.timer);
  const tick = async () => {
    let r;
    try {
      r = await gwPost('collab', { action: 'get', id });
    } catch {
      return;
    }
    if (!r.run) return;
    gw.collab[into] = r.run;
    const el = $('#a2a-run');
    if (el && state.route === 'a2a') el.innerHTML = runView(r.run);
    if (['working', 'submitted'].includes(r.run.state) && state.route === 'a2a')
      gw.collab.timer = setTimeout(tick, 1200);
    else
      gwPost('collab', { action: 'list' })
        .then((l) => {
          if (gw.data && l.runs) gw.data.runs = l.runs.slice(0, 40);
        })
        .catch(() => {});
  };
  tick();
}

/* ---------- Agents ---------- */
function gwAgents() {
  const d = gw.data;
  const e = gw.editingAgent;
  const form = e
    ? `<section class="holo panel"><div class="panel-head"><h3>${e.originalId ? `Edit ${esc(e.name)}` : 'New agent'}</h3>${e.template ? '<span class="meta">template</span>' : ''}</div>
    <form class="gw-form" id="gw-agent-form">
      <div class="gw-row"><label>ID<input class="input" name="id" value="${esc(e.id || '')}" ${e.originalId ? 'readonly' : ''} required></label><label>Name<input class="input" name="name" value="${esc(e.name || '')}" required></label><label>Domain<input class="input" name="domain" value="${esc(e.domain || '')}"></label></div>
      <label>Description <small>the planner routes on this</small><input class="input" name="description" value="${esc(e.description || '')}"></label>
      <label>Routing keywords <small>comma-separated</small><input class="input" name="keywords" value="${esc((e.keywords || []).join(', '))}"></label>
      <label>Tools <small>globs over integration tool names, e.g. dynatrace*, n8n_list_*; memory tools are always on</small><input class="input" name="tools" value="${esc((e.tools || []).join(', '))}"></label>
      <label>Model <small>empty = default (${esc(d.defaults.model || 'not set')})</small><input class="input" name="model" list="gw-models" value="${esc(e.model || '')}"></label>
      <label>Knowledge bases <small>ids or globs; the agent gets zp_knowledge_search over them (${esc(d.knowledge.map((k) => k.id).join(', ') || 'none yet')})</small><input class="input" name="knowledge" value="${esc((e.knowledge || []).join(', '))}"></label>
      <label class="ie-switch"><input type="checkbox" name="collaborate" ${e.collaborate !== false ? 'checked' : ''}><span></span>May consult other agents (zp_ask_agent) and take handoffs</label>
      <div class="gw-row"><label>Remote A2A URL <small>optional: this agent runs on another A2A server (JSON-RPC endpoint); the prompt below is then not used</small><input class="input" name="remoteUrl" value="${esc(e.remoteUrl || '')}" placeholder="https://agents.example.com/a2a"></label>
        <label>Token env var <small>name of an environment variable holding its bearer token</small><input class="input" name="remoteTokenEnv" value="${esc(e.remoteTokenEnv || '')}" placeholder="PARTNER_AGENT_TOKEN"></label></div>
      <label>System prompt<textarea class="input" name="systemPrompt" rows="6">${esc(e.systemPrompt || '')}</textarea></label>
      <label class="ie-switch"><input type="checkbox" name="enabled" ${e.enabled !== false ? 'checked' : ''}><span></span>Enabled</label>
      <div id="gw-agent-errors"></div>
      <div class="gw-row"><button class="btn" type="submit">Save agent</button>${e.template ? `<button class="btn ghost" type="button" data-gwagent="reset" data-id="${esc(e.id)}">Reset to template</button>` : ''}${e.originalId ? `<button class="btn ghost danger" type="button" data-gwagent="delete" data-id="${esc(e.id)}">Delete</button>` : ''}<button class="btn ghost" type="button" data-gwagent="cancel">Cancel</button></div>
    </form></section>`
    : '';
  return `<div class="gw-toolbar"><span class="meta">${d.agents.filter((a) => a.enabled).length} enabled of ${d.agents.length} · the orchestrator plans across enabled agents</span><button class="btn" type="button" data-gwagent="new">+ New agent</button></div>
    ${form}
    <div class="pc-grid">${d.agents
      .map(
        (
          a,
          i,
        ) => `<article class="pcard gw-agent${a.enabled ? '' : ' off'}" style="--v:${APP_RAMP[i % APP_RAMP.length]}">
      <div class="pc-head"><span class="pc-logo">${esc(a.name[0])}</span><div class="pc-title"><b>${esc(a.name)}</b><small>${esc(a.domain)} · agent/${esc(a.id)}</small></div><span class="state-pill" style="--c:${a.enabled ? '#5cf0a8' : '#8f98cc'}"><i></i>${a.enabled ? 'on' : 'off'}</span></div>
      <p class="pc-desc">${esc(a.description)}</p>
      <div class="pc-kv"><span>Model</span><b>${esc(a.model || `default · ${d.defaults.model || 'not set'}`)}</b></div>
      <div class="pc-kv"><span>Tools</span><b>${esc(a.tools.join(', ') || 'memory only')}</b></div>
      <div class="pc-kv"><span>Knowledge</span><b>${esc((a.knowledge || []).join(', ') || '—')}</b></div>${a.remoteUrl ? `<div class="pc-kv"><span>Remote A2A</span><b>${esc(a.remoteUrl)}</b></div>` : ''}
      <div class="pc-kv"><span>Keywords</span><b>${esc(a.keywords.slice(0, 5).join(', '))}</b></div>
      <div class="pc-foot"><button class="pc-details" type="button" data-gwagent="edit" data-id="${esc(a.id)}">Edit <span aria-hidden="true">›</span></button></div></article>`,
      )
      .join('')}</div>`;
}

/* ---------- Sessions & memory ---------- */
function gwSessions() {
  const d = gw.data;
  const keyName = (id) => (id === 'dashboard' ? 'Dashboard' : (d.keys.find((k) => k.id === id) || {}).name || id);
  const v = gw.viewSession;
  return `<div class="live-grid">
    <section class="holo panel"><div class="panel-head"><h3>Sessions</h3><span class="meta">${d.sessions.length} active · expire 24 h after the last message</span></div>
      ${
        d.sessions.length
          ? `<div class="table-wrap"><table class="holo-table"><thead><tr><th>Session</th><th>Key</th><th>Agent</th><th class="r">Messages</th><th class="r">Last active</th><th></th></tr></thead><tbody>
        ${d.sessions
          .map(
            (
              s,
            ) => `<tr><td><b>${esc(s.title || '(untitled)')}</b><small class="block muted mono">${esc(s.id)}</small></td><td>${esc(keyName(s.keyId))}</td><td class="muted">${esc(s.agent || '—')}</td><td class="r num">${s.messages}</td><td class="r muted">${ago(s.lastActive)}</td>
          <td class="nowrap"><button class="btn ghost" type="button" data-gwses="view" data-id="${s.id}">View</button> <button class="btn ghost danger" type="button" data-gwses="delete" data-id="${s.id}">End</button></td></tr>`,
          )
          .join('')}</tbody></table></div>`
          : holoEmpty('No active sessions.')
      }
      ${v ? `<div class="gw-transcript"><div class="panel-head"><h3>${esc(v.title || v.id)}</h3><button class="btn ghost" type="button" data-gwses="close">Close</button></div>${v.messages.map((m) => `<div class="gw-msg ${m.role}"><span>${m.role === 'user' ? 'User' : esc(m.agent || 'assistant')}</span><p>${esc(m.content)}</p></div>`).join('')}</div>` : ''}</section>
    <section class="holo panel"><div class="panel-head"><h3>Memory</h3><span class="meta">${d.memory.length} notes · agents save with zp_memory_save</span></div>
      <form class="gw-form gw-row" id="gw-mem-form"><input class="input" name="text" placeholder="A fact agents should remember, e.g. 'Our SLA is 99.9%'" required><select class="input" name="scope"><option value="global">global</option>${d.agents.map((a) => `<option value="agent:${esc(a.id)}">agent: ${esc(a.name)}</option>`).join('')}</select><button class="btn" type="submit">Save</button></form>
      <div class="feed gw-mem">${d.memory.length ? d.memory.map((m) => `<div class="gw-note"><span class="tag">${esc(m.scope)}</span><p>${esc(m.text)}</p><small class="muted">${esc(m.source)} · ${ago(m.ts)}</small><button class="icon-btn" type="button" data-gwmem="${m.id}" aria-label="Delete note">×</button></div>`).join('') : holoEmpty('No notes yet.')}</div></section>
  </div>`;
}

/* ---------- Playground ---------- */
function gwPlayground() {
  const d = gw.data;
  const p = gw.pg;
  // A dataset "Replay" link (?ds=&ex=) opens Dataset mode on that example (public/datasetview.js).
  if (typeof dsPlaygroundHash === 'function') dsPlaygroundHash(p);
  const r = p.result;
  return `<section class="holo panel"><div class="panel-head"><h3>Run</h3><span class="meta">runs as the dashboard (no key, no budget) · spends tokens</span></div>
    <form class="gw-form" id="gw-pg-form">
      <div class="gw-row"><div class="segmented" role="group" aria-label="Mode">${[
        ['orchestrate', 'Orchestrator'],
        ['agent', 'One agent'],
        ['model', 'Model only'],
        ['dataset', 'Dataset'],
      ]
        .map(([v, l]) => `<button type="button" data-gwpg="${v}" aria-pressed="${p.mode === v}">${l}</button>`)
        .join('')}</div>
        ${
          p.mode === 'agent'
            ? `<select class="input" name="agent">${d.agents
                .filter((a) => a.enabled)
                .map((a) => `<option value="${a.id}" ${a.id === p.agent ? 'selected' : ''}>${esc(a.name)}</option>`)
                .join('')}</select>`
            : ''
        }
        ${p.mode === 'model' ? `<input class="input" name="model" list="gw-models" value="${esc(p.model || d.defaults.model)}" placeholder="provider/model"><datalist id="gw-models">${d.providers.flatMap((pr) => (pr.models || []).map((m) => `<option value="${esc(pr.id)}/${esc(m)}">`)).join('')}</datalist>` : ''}
        ${p.sessionId && p.mode !== 'dataset' ? `<span class="pill">session ${esc(p.sessionId.slice(0, 12))}… <button class="link" type="button" data-gwpg="new">new</button></span>` : ''}</div>
      ${
        p.mode === 'dataset'
          ? dsPlayground(p)
          : `<textarea class="input" name="input" rows="4" placeholder="${p.mode === 'orchestrate' ? 'e.g. Customers report slow checkout. Check for network problems and draft a status update.' : 'Ask something…'}">${esc(p.input)}</textarea>
      <div class="gw-row"><button class="btn" type="submit" ${p.busy || (!d.defaults.model && p.mode !== 'model') ? 'disabled' : ''}>${p.busy ? 'Running…' : 'Run'}</button>${!d.defaults.model && p.mode !== 'model' ? '<span class="muted">Set a default model under Providers first.</span>' : ''}</div>`
      }
    </form>
    ${
      r
        ? r.errors
          ? errList(r.errors)
          : `<div class="gw-result">
      ${r.plan ? `<div class="gw-plan"><b>Plan · ${esc(r.plan.method)}</b>${r.plan.reason ? `<small>${esc(r.plan.reason)}</small>` : ''}<ol>${r.steps.map((s) => `<li><span class="tag">${esc(s.agent)}</span> ${esc(s.instruction)}${s.calls && s.calls.length ? `<small class="block muted">tools: ${s.calls.map((c) => esc(c.tool)).join(', ')}</small>` : ''}${s.skipped ? `<small class="block muted">${esc(s.skipped)}</small>` : ''}</li>`).join('')}</ol></div>` : ''}
      ${r.calls && r.calls.length ? `<div class="gw-plan"><b>Tool calls</b><div class="tags">${r.calls.map((c) => `<span class="tag">${esc(c.tool)} · ${msFmt(c.ms)}${c.ok ? '' : ' · error'}</span>`).join('')}</div></div>` : ''}
      <div class="gw-answer">${esc(r.answer || r.text || '(no answer)')}</div>
      ${r.usage ? `<p class="kpi-sub">${fmtN(r.usage.input)} in · ${fmtN(r.usage.output)} out · ${fmtUSD(r.usage.cost || 0)}${r.usage.requests ? ` · ${r.usage.requests} model calls` : ''}</p>` : ''}</div>`
        : ''
    }
  </section>`;
}

/* ---------- Connect ---------- */
function gwConnect() {
  const key = 'zp_YOUR_KEY'; // keys are never echoed into snippets
  const model = gw.data.defaults.model || 'ollama/llama3.3';
  return `<div class="live-grid even">
    ${panel(
      'OpenAI-compatible API',
      `base URL ${esc(GW_BASE)}`,
      `<p class="kpi-sub">Any OpenAI SDK or tool works: set the base URL and use a ZAAFPulse key. Models are <code>provider/model</code>, a domain agent is <code>agent/&lt;id&gt;</code>, and <code>agent/auto</code> lets the orchestrator plan and route.</p>
      ${codeBlock(`curl ${GW_BASE}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}'`, 'gw-c1')}
      ${codeBlock(`from openai import OpenAI\nclient = OpenAI(base_url="${GW_BASE}", api_key="${key}")\nr = client.chat.completions.create(\n    model="agent/auto",  # or "${model}", or "agent/network-ops"\n    messages=[{"role": "user", "content": "Is the network healthy? Draft a status update."}],\n    extra_headers={"x-zp-session": "ses_..."},  # optional: continue a session\n)\nprint(r.choices[0].message.content)`, 'gw-c2')}
      ${codeBlock(`import OpenAI from 'openai';\nconst client = new OpenAI({ baseURL: '${GW_BASE}', apiKey: '${key}' });\nconst stream = await client.chat.completions.create({ model: '${model}', stream: true, messages: [{ role: 'user', content: 'Hi' }] });\nfor await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || '');`, 'gw-c3')}`,
    )}
    ${panel(
      'Agents, sessions and MCP',
      'needs the agents or mcp scope',
      `${codeBlock(`curl ${GW_BASE}/orchestrate -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"task": "Customers report slow checkout. Investigate and tell support what to say."}'\n\ncurl ${GW_BASE}/agents/customer-service/run -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"input": "Draft a reply to a refund request", "session_id": "ses_..."}'\n\ncurl ${GW_BASE}/sessions -H "Authorization: Bearer ${key}"`, 'gw-c4')}
      <p class="kpi-sub">MCP over HTTP: every integration tool in ZAAFPulse, for clients that connect by URL.</p>
      ${codeBlock(`claude mcp add --transport http zaafpulse ${location.origin}/mcp \\\n  --header "Authorization: Bearer ${key}"`, 'gw-c5')}
      ${codeBlock(JSON.stringify({ mcpServers: { zaafpulse: { type: 'http', url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2), 'gw-c6')}
      <p class="kpi-sub">${ZP.serverMode ? `Server mode: apps on other machines reach the gateway at ${esc(ZP.baseUrl)} with an API key; the dashboard needs a sign-in.` : 'The gateway listens on 127.0.0.1 only: apps on this machine can use it, other devices cannot.'}</p>`,
    )}
    ${panel('RAG, routes and workflows', 'rag and agents scopes', `${codeBlock(`# Search a knowledge base (rag scope)\ncurl ${GW_BASE}/knowledge/company-policies/search -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"query": "refund limit", "k": 3}'\n\n# Add a document\ncurl ${GW_BASE}/knowledge/company-policies/documents -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"title": "Refunds", "content": "Refunds up to $100 need no approval."}'\n\n# A virtual model that falls back across targets\ncurl ${GW_BASE}/chat/completions -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"model": "router/fast", "messages": [{"role": "user", "content": "Hi"}]}'\n\n# Run a multi-agent workflow\ncurl ${GW_BASE}/workflows/incident-response/run -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"input": "Checkout latency doubled since 10:00"}'`, 'gw-c7')}`)}
  </div>`;
}

/* ---------- events ---------- */
async function gwAct(fn) {
  try {
    await fn();
  } catch (err) {
    alert(err.message);
  }
}
// Keep what was typed in the Collaborate form across repaints (pattern switches).
function a2aSync() {
  const f = $('#a2a-form');
  if (!f) return;
  const c = gw.collab;
  c.task = f.task.value;
  c.effort = f.effort.value;
  if (f.querySelector('[name=agents]')) c.agents = [...f.querySelectorAll('[name=agents]:checked')].map((x) => x.value);
  for (const k of [
    'agent',
    'critic',
    'aggregator',
    'samples',
    'rounds',
    'iterations',
    'turns',
    'size',
    'maxHandoffs',
    'threshold',
    'tokens',
    'costUSD',
  ])
    if (f[k]) c.opts[k] = f[k].value;
  if (f.verify) c.opts.verify = f.verify.checked;
}
document.addEventListener('click', (e) => {
  if (!GW_ROUTES.includes(state.route)) return;
  const t = (s) => e.target.closest(s);
  if (t('[data-gwsecret]')) {
    const v = gw.newSecret;
    if (!v) return;
    // Mask only after a successful copy; if the browser blocks the clipboard, select the key for a manual copy.
    Promise.resolve(navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject(new Error('no clipboard')))
      .then(forgetSecret)
      .catch(() => {
        const pre = $('#gw-new-secret');
        if (!pre) return;
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const btn = t('[data-gwsecret]');
        if (btn) btn.textContent = 'Press ⌘C';
      });
    return;
  }
  const cp = t('[data-gwcopy]');
  if (cp) {
    navigator.clipboard?.writeText($(`#${cp.dataset.gwcopy}`).textContent);
    cp.textContent = 'Copied';
    setTimeout(() => {
      cp.textContent = 'Copy';
    }, 1000);
    return;
  }
  const k = t('[data-gwkey]');
  if (k) {
    const act = k.dataset.gwkey;
    if (act === 'delete' && !confirm('Delete this key? Apps using it stop working.')) return;
    gwAct(async () => {
      await gwPost('keys', { action: act, id: k.dataset.id });
      await refreshGateway();
    });
    return;
  }
  const pr = t('[data-gwpreset]');
  if (pr) {
    gw.editingProvider = {
      preset: pr.dataset.gwpreset,
      id: pr.dataset.gwpreset === 'custom' ? '' : pr.dataset.gwpreset,
    };
    paintGateway();
    return;
  }
  const pv = t('[data-gwprov]');
  if (pv) {
    const act = pv.dataset.gwprov;
    const id = pv.dataset.id;
    if (act === 'cancel') {
      gw.editingProvider = null;
      paintGateway();
      return;
    }
    if (act === 'edit') {
      const p = gw.data.providers.find((x) => x.id === id);
      gw.editingProvider = { ...p, originalId: p.id };
      paintGateway();
      return;
    }
    if (act === 'delete') {
      if (confirm(`Remove provider "${id}"? Its ${storeName()} item stays.`))
        gwAct(async () => {
          await gwPost('providers', { action: 'delete', id });
          await refreshGateway();
        });
      return;
    }
    if (act === 'test') {
      const box = $(`#gw-test-${CSS.escape(id)}`);
      box.innerHTML = '<span class="muted">Testing…</span>';
      gwAct(async () => {
        const r = await gwPost('providers', { action: 'models', id });
        box.innerHTML = r.errors
          ? `<code class="ie-err">${esc(r.errors[0])}</code>`
          : `<b class="good-text">${r.models.length} models</b><div class="ie-tools">${r.models
              .slice(0, 24)
              .map((m) => `<code>${esc(m)}</code>`)
              .join('')}${r.models.length > 24 ? `<span>+${r.models.length - 24}</span>` : ''}</div>`;
        gw.data.providers.find((x) => x.id === id).models = r.models || [];
      });
      return;
    }
  }
  const ag = t('[data-gwagent]');
  if (ag) {
    const act = ag.dataset.gwagent;
    const id = ag.dataset.id;
    if (act === 'new') {
      gw.editingAgent = { enabled: true, keywords: [], tools: [] };
      paintGateway();
      return;
    }
    if (act === 'edit') {
      const a = gw.data.agents.find((x) => x.id === id);
      gw.editingAgent = { ...a, originalId: a.id };
      paintGateway();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (act === 'cancel') {
      gw.editingAgent = null;
      paintGateway();
      return;
    }
    if (act === 'reset')
      gwAct(async () => {
        await gwPost('agents', { action: 'reset', id });
        gw.editingAgent = null;
        await refreshGateway();
      });
    if (act === 'delete' && confirm('Delete this agent?'))
      gwAct(async () => {
        await gwPost('agents', { action: 'delete', id });
        gw.editingAgent = null;
        await refreshGateway();
      });
    return;
  }
  const ss = t('[data-gwses]');
  if (ss) {
    const act = ss.dataset.gwses;
    if (act === 'close') {
      gw.viewSession = null;
      paintGateway();
      return;
    }
    if (act === 'view')
      gwAct(async () => {
        const r = await gwPost('sessions', { action: 'get', id: ss.dataset.id });
        gw.viewSession = r.session;
        paintGateway();
      });
    if (act === 'delete')
      gwAct(async () => {
        await gwPost('sessions', { action: 'delete', id: ss.dataset.id });
        gw.viewSession = null;
        await refreshGateway();
      });
    return;
  }
  const ap = t('[data-gwapprove]');
  if (ap) {
    gwAct(async () => {
      await gwPost('approve', { id: ap.dataset.gwapprove, approved: ap.dataset.on === '1' });
      await refreshGateway();
    });
    return;
  }
  const ro = t('[data-gwroute]');
  if (ro) {
    const act = ro.dataset.gwroute;
    if (act === 'new') {
      gw.editingRoute = { strategy: 'fallback', targets: [] };
      paintGateway();
      return;
    }
    if (act === 'cancel') {
      gw.editingRoute = null;
      paintGateway();
      return;
    }
    if (act === 'edit') {
      const r = gw.data.routes.find((x) => x.name === ro.dataset.name);
      gw.editingRoute = { ...r, originalName: r.name };
      paintGateway();
      return;
    }
    if (act === 'delete' && confirm(`Delete route ${ro.dataset.name}?`))
      gwAct(async () => {
        await gwPost('routes', { action: 'delete', name: ro.dataset.name });
        await refreshGateway();
      });
    return;
  }
  const kbb = t('[data-gwkb]');
  if (kbb) {
    const act = kbb.dataset.gwkb;
    if (act === 'open')
      gwAct(async () => {
        gw.kbOpen = await gwPost('knowledge', { action: 'get', id: kbb.dataset.id });
        gw.kbSearch = null;
        paintGateway();
      });
    if (act === 'close') {
      gw.kbOpen = null;
      gw.kbSearch = null;
      paintGateway();
    }
    if (act === 'delete' && confirm('Delete this knowledge base and all its documents?'))
      gwAct(async () => {
        await gwPost('knowledge', { action: 'delete', id: kbb.dataset.id });
        gw.kbOpen = null;
        await refreshGateway();
      });
    if (act === 'rmdoc')
      gwAct(async () => {
        await gwPost('knowledge', { action: 'remove-doc', id: gw.kbOpen.id, docId: kbb.dataset.doc });
        gw.kbOpen = await gwPost('knowledge', { action: 'get', id: gw.kbOpen.id });
        await refreshGateway();
      });
    if (act === 'embed')
      gwAct(async () => {
        const m = $('#gw-kb-embed').value.trim();
        await gwPost('knowledge', { action: 'update', id: gw.kbOpen.id, embedModel: m });
        const r = m ? await gwPost('knowledge', { action: 'reindex', id: gw.kbOpen.id }) : {};
        if (r.errors) alert(r.errors[0]);
        gw.kbOpen = await gwPost('knowledge', { action: 'get', id: gw.kbOpen.id });
        await refreshGateway();
      });
    return;
  }
  const wf = t('[data-gwwf]');
  if (wf) {
    const act = wf.dataset.gwwf;
    const f = $('#gw-wf-form');
    const sync = () => {
      if (!f || !gw.editingWf) return;
      gw.editingWf.id = f.id.value;
      gw.editingWf.name = f.name.value;
      gw.editingWf.description = f.description.value;
      gw.editingWf.steps = gw.editingWf.steps.map((st, i) => ({
        agent: f[`agent-${i}`].value,
        prompt: f[`prompt-${i}`].value,
        approve: f[`approve-${i}`].checked,
      }));
    };
    if (act === 'new') {
      gw.editingWf = { steps: [{ agent: 'research', prompt: '{{input}}' }] };
      paintGateway();
      return;
    }
    if (act === 'edit') {
      const w = gw.data.workflows.find((x) => x.id === wf.dataset.id);
      gw.editingWf = { ...w, steps: w.steps.map((st) => ({ ...st })), originalId: w.id };
      paintGateway();
      return;
    }
    if (act === 'cancel') {
      gw.editingWf = null;
      paintGateway();
      return;
    }
    if (act === 'addstep') {
      sync();
      gw.editingWf.steps.push({ agent: 'content-writer', prompt: `{{step${gw.editingWf.steps.length}}}` });
      paintGateway();
      return;
    }
    if (act === 'rmstep') {
      sync();
      gw.editingWf.steps.splice(Number(wf.dataset.i), 1);
      paintGateway();
      return;
    }
    if (act === 'delete' && confirm('Delete this workflow?'))
      gwAct(async () => {
        await gwPost('workflows', { action: 'delete', id: wf.dataset.id });
        await refreshGateway();
      });
    if (act === 'restore')
      gwAct(async () => {
        const r = await gwPost('workflows', { action: 'restore', id: wf.dataset.id });
        if (r.errors) alert(r.errors[0]);
        await refreshGateway();
      });
    if (act === 'sample') {
      const w = gw.data.workflows.find((x) => x.id === wf.dataset.id);
      const inp = document.querySelector(`.gw-wf-run[data-wfid="${CSS.escape(w.id)}"] [name=input]`);
      if (inp) {
        inp.value = w.sampleInput;
        inp.focus();
      }
    }
    return;
  }
  const wc = t('[data-gwwfcat]');
  if (wc) {
    gw.wfCat = wc.dataset.gwwfcat;
    paintGateway();
    return;
  }
  if (t('[data-gwtoolsecret]')) {
    const v = gw.toolSecret && gw.toolSecret.snippet;
    if (!v) return;
    Promise.resolve(navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject(new Error('no clipboard')))
      .then(() => {
        gw.toolSecret = null;
        gw.toolMasked = true;
        paintGateway();
      })
      .catch(() => {
        const pre = $('#gw-tool-secret');
        if (!pre) return;
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const btn = t('[data-gwtoolsecret]');
        if (btn) btn.textContent = 'Press ⌘C';
      });
    return;
  }
  const tl = t('[data-gwtool]');
  if (tl) {
    const act = tl.dataset.gwtool;
    const tool = gw.data.tools.find((x) => x.id === tl.dataset.id);
    const model = gw.toolModel ?? (gw.data.defaults.codeModel || gw.data.defaults.model || '');
    if (act === 'apply') {
      const warn =
        tool.id === 'claude-code'
          ? '\n\nEvery Claude Code session on this machine, including one you are using right now, will then send its requests through ZAAFPulse to the model you chose. Use Revert to undo.'
          : '';
      if (
        !confirm(
          `Write ${tool.path} for ${tool.name} with a new key (llm scope) and model "${model || 'tool default'}"? The current file is backed up first.${warn}`,
        )
      )
        return;
    }
    if (act === 'revert' && !confirm(`Restore ${tool.path} from the backup and revoke ${tool.name}'s key?`)) return;
    gwAct(async () => {
      const r = await gwPost('tools', { action: act, id: tool.id, model });
      if (r.errors) {
        alert(r.errors[0]);
        return;
      }
      if (act === 'key') {
        gw.toolSecret = { name: tool.name, snippet: r.snippet };
        gw.toolMasked = false;
        clearTimeout(gw.toolTimer);
        gw.toolTimer = setTimeout(() => {
          if (gw.toolSecret) {
            gw.toolSecret = null;
            gw.toolMasked = true;
            paintGateway();
          }
        }, 60000);
      }
      await refreshGateway();
    });
    return;
  }
  const sk = t('[data-gwskills]');
  if (sk) {
    const act = sk.dataset.gwskills;
    const sel = document.querySelector('[data-gwskilltarget]');
    const where = (gw.skillTarget = sel ? sel.value : 'claude');
    const roots = gw.data.skillRoots || { claude: '~/.claude/skills', agents: '~/.agents/skills' };
    const place = where === 'all' ? `${roots.claude} and ${roots.agents}` : roots[where];
    if (act === 'uninstall' && !confirm(`Remove the ZAAFPulse skills from ${place}?`)) return;
    gwAct(async () => {
      const r = await gwPost('skills', act === 'key' ? { action: act } : { action: act, target: where });
      if (r.errors) {
        alert(r.errors[0]);
        return;
      }
      if (act === 'key') {
        gw.toolSecret = { name: 'Agent skills key', snippet: r.snippet };
        gw.toolMasked = false;
        clearTimeout(gw.toolTimer);
        gw.toolTimer = setTimeout(() => {
          if (gw.toolSecret) {
            gw.toolSecret = null;
            gw.toolMasked = true;
            paintGateway();
          }
        }, 60000);
      }
      if (act === 'install' && r.skipped && r.skipped.length)
        alert(`Skipped (you already have skills with these names): ${r.skipped.join(', ')}`);
      await refreshGateway();
    });
    return;
  }
  const mr = t('[data-mcpreg]');
  if (mr) {
    const remove = mr.dataset.remove === '1';
    if (
      !confirm(
        `${remove ? 'Remove' : 'Register'} the ZAAFPulse MCP server ${remove ? 'from' : 'in'} ${mr.closest('tr').querySelector('b').textContent}? The config file is backed up first.`,
      )
    )
      return;
    gwAct(async () => {
      const r = await api('/api/mcp/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: mr.dataset.mcpreg, remove }),
      });
      if (gw.mcp && r.clients) gw.mcp.clients = r.clients;
      paintGateway();
      const box = $('#mcp-reg-log');
      if (box)
        box.innerHTML = `<div class="ie-result ${r.errors ? 'bad' : 'good'}"><b>${r.errors ? esc(r.errors[0]) : 'Done'}</b>${(r.log || []).map((l) => `<small class="block muted">${esc(l)}</small>`).join('')}</div>`;
    });
    return;
  }
  if (t('[data-gwquota]')) {
    gwAct(async () => {
      const r = await gwPost('quota', {});
      gw.data.quota = r.quota;
      paintGateway();
    });
    return;
  }
  const gm = t('[data-gwmap]');
  if (gm) {
    const f = $('#gw-map-form');
    const cur = (gw.editMap || (gw.data.settings.modelMap || []).map((m) => ({ ...m }))).map((m, i) => ({
      match: f ? f[`match-${i}`].value : m.match,
      to: f ? f[`to-${i}`].value : m.to,
    }));
    if (gm.dataset.gwmap === 'add') cur.push({ match: '', to: '' });
    else cur.splice(Number(gm.dataset.i), 1);
    gw.editMap = cur;
    paintGateway();
    return;
  }
  const pc = t('[data-gwpcat]');
  if (pc) {
    gw.presetCat = pc.dataset.gwpcat;
    paintGateway();
    return;
  }
  const pat = t('[data-a2apattern]');
  if (pat) {
    a2aSync();
    gw.collab.pattern = pat.dataset.a2apattern;
    paintGateway();
    return;
  }
  const ar = t('[data-a2arun]');
  if (ar) {
    const act = ar.dataset.a2arun;
    const id = ar.dataset.id;
    if (act === 'view')
      gwAct(async () => {
        const r = await gwPost('collab', { action: 'get', id });
        gw.collab.view = r.run;
        paintGateway();
        if (r.run && ['working', 'submitted'].includes(r.run.state)) watchRun(id, 'view');
        $('#a2a-run')?.scrollIntoView({ behavior: 'smooth' });
      });
    if (act === 'cancel')
      gwAct(async () => {
        await gwPost('collab', { action: 'cancel', id });
        watchRun(id, state.sub === 'runs' ? 'view' : 'run');
      });
    if (act === 'approve' || act === 'reject')
      gwAct(async () => {
        // Approve runs only the ticked actions of the gated step.
        const boxes = [...document.querySelectorAll('[data-approve-call]')];
        const calls = boxes.length
          ? boxes.filter((b) => b.checked).map((b) => Number(b.dataset.approveCall))
          : undefined;
        const r = await gwPost('collab', {
          action: 'resume',
          id,
          approve: act === 'approve',
          ...(act === 'approve' && calls ? { calls } : {}),
        });
        if (r.errors) {
          alert(r.errors[0]);
          return;
        }
        if (ar.dataset.wf) {
          gw.wfRun = { busy: r.run.options.workflow };
          paintGateway();
          const poll = async () => {
            const g = await gwPost('collab', { action: 'get', id });
            if (['working', 'submitted'].includes(g.run.state)) {
              setTimeout(poll, 1200);
              return;
            }
            gw.wfRun = { result: { ...g.run, workflow: g.run.options.workflow } };
            paintGateway();
          };
          poll();
          return;
        }
        watchRun(id, state.sub === 'runs' ? 'view' : 'run');
      });
    return;
  }
  const mm = t('[data-gwmem]');
  if (mm) {
    gwAct(async () => {
      await gwPost('memory', { action: 'delete', id: mm.dataset.gwmem });
      await refreshGateway();
    });
    return;
  }
  if (gw.pg.mode === 'dataset' && t('#ds-pg')) return void dsPlaygroundAct(e, gw.pg, paintGateway);
  const pg = t('[data-gwpg]');
  if (pg) {
    const f = $('#gw-pg-form');
    if (f && f.input) gw.pg.input = f.input.value;
    if (pg.dataset.gwpg === 'new') gw.pg.sessionId = null;
    else {
      gw.pg.mode = pg.dataset.gwpg;
      gw.pg.result = null;
    }
    paintGateway();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.closest && e.target.closest('#ds-pg')) return void dsPlaygroundAct(e, gw.pg, paintGateway);
  if (e.target.name === 'effort' && e.target.closest('#a2a-form')) {
    a2aSync();
    paintGateway();
    return;
  }
  if (e.target.matches && e.target.matches('[data-gwsaver]')) {
    gwAct(async () => {
      await gwPost('settings', { tokenSaver: e.target.checked });
      await refreshGateway();
    });
    return;
  }
  if (e.target.name === 'authType' && e.target.closest('#gw-prov-form')) {
    const f = e.target.form;
    gw.editingProvider = { ...gw.editingProvider, authType: e.target.value, id: f.id.value, baseUrl: f.baseUrl.value };
    paintGateway();
    return;
  }
  const c = e.target.closest && e.target.closest('[data-a2acollab]');
  if (!c) return;
  const a = gw.data.agents.find((x) => x.id === c.dataset.a2acollab);
  if (!a) return;
  gwAct(async () => {
    const r = await gwPost('agents', { action: 'save', ...a, originalId: a.id, collaborate: c.checked });
    if (r.errors) alert(r.errors[0]);
    await refreshGateway();
  });
});
document.addEventListener('submit', (e) => {
  if (!GW_ROUTES.includes(state.route)) return;
  const f = e.target;
  e.preventDefault();
  const v = (n) => (f[n] ? f[n].value : '');
  if (f.id === 'gw-key-form')
    gwAct(async () => {
      const r = await gwPost('keys', {
        action: 'create',
        name: v('name'),
        scopes: [...f.querySelectorAll('[name=scope]:checked')].map((x) => x.value),
        models: v('models'),
        agents: v('agents'),
        knowledge: v('knowledge'),
        approveOwnRuns: f.approveOwnRuns.checked,
        budgetUSD: v('budgetUSD'),
        rpm: v('rpm'),
        expiresInDays: v('expiresInDays'),
        privateOnly: f.privateOnly.checked,
      });
      if (r.errors) {
        $('#gw-key-errors').innerHTML = errList(r.errors);
        return;
      }
      gw.newSecret = r.secret;
      gw.maskedSecret = null;
      clearTimeout(gwMaskTimer);
      gwMaskTimer = setTimeout(forgetSecret, 60000);
      await refreshGateway();
    });
  if (f.id === 'gw-prov-form')
    gwAct(async () => {
      let aliases = {};
      try {
        aliases = JSON.parse(v('aliases') || '{}');
      } catch {
        $('#gw-prov-errors').innerHTML = errList(['Aliases: not valid JSON']);
        return;
      }
      const mode = v('secretMode');
      const val = v('secretValue');
      const secret =
        mode === 'keep'
          ? { mode }
          : mode === 'none'
            ? { mode }
            : mode === 'store'
              ? { mode, value: val }
              : mode === 'keychain'
                ? { mode, service: val.trim() }
                : { mode, name: val.trim() };
      const r = await gwPost('providers', {
        action: 'save',
        originalId: gw.editingProvider.originalId,
        id: v('id'),
        preset: v('preset'),
        baseUrl: v('baseUrl'),
        models: v('models'),
        aliases,
        enabled: f.enabled.checked,
        tier: v('tier'),
        approved: f.approved.checked,
        secret,
        format: v('format'),
        authType: v('authType'),
        oauth: f.tokenUrl
          ? { tokenUrl: v('tokenUrl'), clientId: v('clientId'), scope: v('scope'), grant: v('grant') }
          : undefined,
      });
      if (r.errors) {
        $('#gw-prov-errors').innerHTML = errList(r.errors);
        return;
      }
      gw.editingProvider = null;
      await refreshGateway();
      const box = $(`#gw-test-${CSS.escape(r.provider.id)}`);
      if (box)
        box.innerHTML = r.test.ok
          ? `<b class="good-text">Connected · ${r.test.models} models · ${msFmt(r.test.latencyMs)}</b>`
          : `<code class="ie-err">${esc(r.test.error)}</code>`;
    });
  if (f.id === 'gw-defaults')
    gwAct(async () => {
      await gwPost('defaults', { model: v('model'), plannerModel: v('plannerModel') });
      await refreshGateway();
    });
  if (f.id === 'gw-agent-form')
    gwAct(async () => {
      const r = await gwPost('agents', {
        action: 'save',
        originalId: gw.editingAgent.originalId,
        id: v('id'),
        name: v('name'),
        domain: v('domain'),
        description: v('description'),
        keywords: v('keywords'),
        tools: v('tools'),
        model: v('model'),
        knowledge: v('knowledge'),
        collaborate: f.collaborate.checked,
        remoteUrl: v('remoteUrl'),
        remoteTokenEnv: v('remoteTokenEnv'),
        systemPrompt: v('systemPrompt'),
        enabled: f.enabled.checked,
      });
      if (r.errors) {
        $('#gw-agent-errors').innerHTML = errList(r.errors);
        return;
      }
      gw.editingAgent = null;
      await refreshGateway();
    });
  if (f.id === 'gw-route-form')
    gwAct(async () => {
      const r = await gwPost('routes', {
        action: 'save',
        originalName: gw.editingRoute.originalName,
        name: v('name'),
        strategy: v('strategy'),
        targets: v('targets'),
        description: v('description'),
      });
      if (r.errors) {
        $('#gw-route-errors').innerHTML = errList(r.errors);
        return;
      }
      gw.editingRoute = null;
      await refreshGateway();
    });
  if (f.id === 'gw-kb-form')
    gwAct(async () => {
      const r = await gwPost('knowledge', {
        action: 'create',
        id: v('id'),
        name: v('name') || v('id'),
        description: v('description'),
        embedModel: v('embedModel'),
      });
      if (r.errors) {
        $('#gw-kb-errors').innerHTML = errList(r.errors);
        return;
      }
      await refreshGateway();
    });
  if (f.id === 'gw-kb-ingest')
    gwAct(async () => {
      const msg = $('#gw-kb-msg');
      msg.innerHTML = '<span class="muted">Ingesting…</span>';
      const file = f.file.files[0];
      let r;
      if (v('url').trim())
        r = await gwPost('knowledge', {
          action: 'ingest-url',
          id: gw.kbOpen.id,
          url: v('url').trim(),
          title: v('title'),
        });
      else if (file) {
        const text = await file.text();
        const ext = file.name.split('.').pop().toLowerCase();
        r = await gwPost('knowledge', {
          action: 'ingest',
          id: gw.kbOpen.id,
          title: v('title') || file.name,
          content: text,
          kind: /html?/.test(ext) ? 'html' : ext === 'json' ? 'json' : 'text',
          source: file.name,
        });
      } else if (v('content').trim())
        r = await gwPost('knowledge', {
          action: 'ingest',
          id: gw.kbOpen.id,
          title: v('title') || 'Pasted text',
          content: v('content'),
          source: 'pasted',
        });
      else {
        msg.innerHTML = errList(['Paste text, pick a file or enter a URL.']);
        return;
      }
      if (r.errors) {
        msg.innerHTML = errList(r.errors);
        return;
      }
      gw.kbOpen = await gwPost('knowledge', { action: 'get', id: gw.kbOpen.id });
      await refreshGateway();
      const m2 = $('#gw-kb-msg');
      if (m2)
        m2.innerHTML = `<b class="good-text">Added "${esc(r.doc.title)}": ${r.doc.chunks} chunks, ${r.embedded} embedded.</b>${r.warning ? `<small class="block muted">${esc(r.warning)}</small>` : ''}`;
    });
  if (f.id === 'gw-kb-search')
    gwAct(async () => {
      const q = v('q');
      const r = await gwPost('knowledge', { action: 'search', id: gw.kbOpen.id, query: q, k: 6 });
      gw.kbSearch = { q, ...r };
      paintGateway();
    });
  if (f.id === 'gw-wf-form')
    gwAct(async () => {
      const steps = gw.editingWf.steps.map((st, i) => ({
        agent: f[`agent-${i}`].value,
        prompt: f[`prompt-${i}`].value,
        approve: f[`approve-${i}`].checked,
      }));
      const r = await gwPost('workflows', {
        action: 'save',
        originalId: gw.editingWf.originalId,
        id: v('id'),
        name: v('name'),
        description: v('description'),
        category: v('category'),
        tier: v('tier'),
        sampleInput: v('sampleInput'),
        kpi: gw.editingWf.kpi,
        steps,
      });
      if (r.errors) {
        $('#gw-wf-errors').innerHTML = errList(r.errors);
        return;
      }
      gw.editingWf = null;
      await refreshGateway();
    });
  if (f.classList.contains('gw-wf-run')) {
    const id = f.dataset.wfid;
    const input = f.input.value.trim();
    if (!input) return;
    gw.wfRun = { busy: id };
    paintGateway();
    gwPost('workflows', { action: 'run', id, input })
      .then((r) => {
        gw.wfRun = { result: r };
      })
      .catch((err) => {
        gw.wfRun = { result: { errors: [err.message] } };
      })
      .finally(() => paintGateway());
  }
  if (f.id === 'a2a-form') {
    a2aSync();
    const c = gw.collab;
    if (!c.task.trim()) return;
    const n = (k) => (c.opts[k] === '' || c.opts[k] == null ? undefined : Number(c.opts[k]));
    const body = {
      action: 'start',
      pattern: c.pattern,
      task: c.task,
      effort: c.effort,
      agents: c.agents,
      agent: c.opts.agent || undefined,
      critic: c.opts.critic || undefined,
      aggregator: c.opts.aggregator || undefined,
      samples: n('samples'),
      rounds: n('rounds'),
      iterations: n('iterations'),
      turns: n('turns'),
      size: n('size'),
      maxHandoffs: n('maxHandoffs'),
      threshold: n('threshold'),
      verify: c.opts.verify,
      budget: { tokens: n('tokens'), costUSD: n('costUSD') },
    };
    gwAct(async () => {
      const r = await gwPost('collab', body);
      if (r.errors) {
        $('#a2a-errors').innerHTML = errList(r.errors);
        return;
      }
      $('#a2a-errors').innerHTML = '';
      c.run = r.run;
      $('#a2a-run').innerHTML = runView(r.run);
      watchRun(r.run.id);
    });
  }
  if (f.id === 'gw-tool-model')
    gwAct(async () => {
      gw.toolModel = v('model').trim();
      await gwPost('defaults', {
        model: gw.data.defaults.model,
        plannerModel: gw.data.defaults.plannerModel,
        codeModel: v('codeModel').trim(),
      });
      await refreshGateway();
    });
  if (f.id === 'gw-map-form')
    gwAct(async () => {
      const n = (gw.editMap || gw.data.settings.modelMap || []).length;
      const modelMap = [];
      for (let i = 0; i < n; i++)
        if (f[`match-${i}`]) modelMap.push({ match: f[`match-${i}`].value.trim(), to: f[`to-${i}`].value.trim() });
      const r = await gwPost('settings', { modelMap });
      if (r.errors) {
        alert(r.errors[0]);
        return;
      }
      gw.editMap = null;
      await refreshGateway();
    });
  if (f.id === 'gw-mem-form')
    gwAct(async () => {
      await gwPost('memory', { action: 'save', text: v('text'), scope: v('scope') });
      await refreshGateway();
    });
  if (f.id === 'gw-pg-form' && gw.pg.mode === 'dataset') return void dsPlaygroundAct(e, gw.pg, paintGateway);
  if (f.id === 'gw-pg-form') {
    gw.pg.input = v('input');
    if (f.agent) gw.pg.agent = f.agent.value;
    if (f.model) gw.pg.model = f.model.value;
    if (!gw.pg.input.trim()) return;
    gw.pg.busy = true;
    gw.pg.result = null;
    paintGateway();
    gwPost('playground', {
      mode: gw.pg.mode,
      agent: gw.pg.agent,
      model: gw.pg.model || gw.data.defaults.model,
      input: gw.pg.input,
      sessionId: gw.pg.sessionId,
    })
      .then((r) => {
        gw.pg.result = r;
        if (r.sessionId) gw.pg.sessionId = r.sessionId;
      })
      .catch((err) => {
        gw.pg.result = { errors: [err.message] };
      })
      .finally(() => {
        gw.pg.busy = false;
        paintGateway();
      });
  }
});
