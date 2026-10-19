// Demo data for the agentic workspace (DEMO=1, used for the README screenshots): fictional providers,
// routes, keys, a week of request history, knowledge bases, second-brain sources, and an in-process model
// that answers every provider call. Nothing leaves the machine and no real account or key is involved.
const fs = require('fs');
const path = require('path');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

const provider = (id, preset, baseUrl, models, extra = {}) => ({
  id,
  preset,
  baseUrl,
  models,
  aliases: {},
  enabled: true,
  tier: extra.tier || 'external',
  approved: true,
  format: extra.format || 'openai',
});
const CONFIG = {
  providers: [
    provider(
      'ollama',
      'ollama',
      'http://localhost:11434/v1',
      ['qwen3-coder:30b', 'llama4-scout', 'gemma-3-27b', 'nomic-embed-text'],
      { tier: 'private' },
    ),
    provider('lmstudio', 'lmstudio', 'http://localhost:1234/v1', ['mistral-small-3.2', 'phi-5-mini'], {
      tier: 'private',
    }),
    provider(
      'anthropic',
      'anthropic',
      'https://api.anthropic.com/v1',
      ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
      { format: 'anthropic' },
    ),
    provider('openai', 'openai', 'https://api.openai.com/v1', ['gpt-6.1-mini', 'gpt-6.1', 'text-embedding-4-small']),
    provider('gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', [
      'gemini-3-flash',
      'gemini-3-pro',
    ]),
    provider('groq', 'groq', 'https://api.groq.com/openai/v1', ['llama-4-maverick', 'qwen3-32b']),
    provider('openrouter', 'openrouter', 'https://openrouter.ai/api/v1', [
      'deepseek/deepseek-v4.1-flash',
      'moonshotai/kimi-k2.5',
      'z-ai/glm-5',
    ]),
  ],
  routes: [
    {
      name: 'router/fast',
      targets: ['groq/llama-4-maverick', 'gemini/gemini-3-flash', 'openrouter/deepseek/deepseek-v4.1-flash'],
      strategy: 'fallback',
      description: 'Cheap and quick first, two fallbacks',
    },
    {
      name: 'router/smart',
      targets: ['anthropic/claude-sonnet-5-5', 'openai/gpt-6.1'],
      strategy: 'fallback',
      description: 'Best answers for agents and reviews',
    },
    {
      name: 'router/code',
      targets: ['ollama/qwen3-coder:30b', 'anthropic/claude-sonnet-5-5'],
      strategy: 'fallback',
      description: 'Local coder, cloud when the laptop is busy',
    },
    {
      name: 'router/private',
      targets: ['ollama/llama4-scout', 'lmstudio/mistral-small-3.2'],
      strategy: 'round-robin',
      description: 'Never leaves this machine',
    },
  ],
  defaults: { model: 'router/fast', plannerModel: 'router/smart', codeModel: 'router/code' },
  modelMap: [
    { match: 'claude-*', to: 'router/smart' },
    { match: 'gpt-*', to: 'router/fast' },
  ],
  tokenSaver: true,
};

// ---------- the in-process model ----------
const AGENT_TEXT = {
  'sre-observability':
    'SUMMARY: checkout p95 rose from 1.1 s to 4.8 s at 10:02, three minutes after payment-api v2.14 went out. AFFECTED_SERVICES: checkout-web, payment-api, orders-db. SEVERITY: SEV2, customer-facing slowness, no data loss. HYPOTHESES: (1) v2.14 opens a DB connection per retry, pool at 95% (high); (2) noisy neighbour on orders-db (low).',
  'network-ops':
    'EVIDENCE_FOR: none. EVIDENCE_AGAINST: packet loss 0.0%, LB 5xx flat, DNS p99 18 ms, same latency from both zones. CHECKS_NEEDED: none. The network layer does not explain this incident.',
  devops:
    'CHANGE: payment-api v2.14 (retry policy), TIME: 09:55, OWNER: payments team, CORRELATION: high, latency starts 7 min later. CHANGE: feature flag new-tax-calc 30%, TIME: 08:10, CORRELATION: low.',
  'project-manager':
    'INTERNAL: checkout is slow for about 30% of users; payments on-call is rolling back payment-api to v2.13; next update 11:10. CUSTOMER: Some payments are taking longer than usual. We have found the cause and are fixing it now.',
  'customer-service':
    'Hi Dana, thanks for your patience. Your refund of $42.10 for order #58213 was approved today and will reach your card in 3 to 5 business days. I have also added a 10% voucher to your account.',
  security:
    'VERDICT: phishing (high). Sender domain registered 2 days ago, display name spoofs the CFO, link points to a look-alike login page. ACTIONS: block the domain, purge 14 copies from mailboxes, reset the one user who clicked.',
  research:
    'Three sources agree that hybrid search (BM25 + embeddings) beats either alone on enterprise documents, by 8 to 15 points of recall@10. Re-ranking adds 3 to 5 points at about 40 ms per query. Sources: [1] BEIR 2025 refresh, [2] vendor benchmark, [3] internal eval, set 4.',
  'code-reviewer':
    'BLOCKER: the retry loop in charge.ts opens a new DB connection on every attempt (line 88). MAJOR: no jitter on back-off. MINOR: magic number 5 for max retries. Suggest reusing the pooled client and adding full jitter.',
  'data-analyst':
    'Trial-to-paid conversion is 14.2% this month (+1.8 pts). The lift comes from the new onboarding checklist: users who finish it convert at 22% vs 9%. Sample: 3,412 trials, p < 0.01.',
  'legal-compliance':
    'Clause 7.2 caps liability at 1x fees; propose 2x for data breaches. Clause 11 allows transfer of personal data abroad without safeguards; under UU PDP add standard contractual clauses and a DPIA reference.',
  'content-writer':
    'Release 2.14 makes checkout faster and adds saved payment methods. If you use the API, the /charges endpoint now returns a retry_after field. Thanks to everyone who reported the slow refunds last month.',
  'product-manager':
    'PROBLEM: users cannot find past invoices (37 tickets this month). GOAL: self-serve invoice download, cut tickets by 60%. SCOPE: list, filter by month, PDF download. NOT NOW: custom invoice templates.',
  'it-helpdesk':
    'Resolved without a ticket: VPN failed because the certificate expired yesterday. I pushed the renewed profile; ask the user to reconnect. If it fails again, open a P3 ticket for the network team.',
  'hr-finance':
    'Month-end: revenue $1.84M (+6% MoM), gross margin 71%. Variance: cloud spend +$38k over plan from the incident load test; expected one-off.',
  'sales-marketing':
    'Lead score 82/100: series B fintech, 120 engineers, hiring SREs, uses two of our integrations. Opening line: congratulate them on the launch of instant payouts and ask how they monitor payout latency.',
  procurement:
    'Recommend vendor B: 14% cheaper over 3 years, meets SOC 2 and data residency, 99.95% SLA. Vendor A is faster to onboard but lacks an Indonesian region.',
  'ai-ops':
    'Agent quality this week: faithfulness 0.91, relevance 0.94, 3 runs over budget (all group chats with 4+ agents). Suggest a 6-turn cap for group chats.',
};
const NAMES = {
  'Customer Service': 'customer-service',
  'Sales & Marketing': 'sales-marketing',
  'Network Operations': 'network-ops',
  'HR & Finance': 'hr-finance',
  'IT Helpdesk': 'it-helpdesk',
  'SRE & Observability': 'sre-observability',
  Security: 'security',
  'Data Analyst': 'data-analyst',
  DevOps: 'devops',
  'Code Reviewer': 'code-reviewer',
  Research: 'research',
  'Legal & Compliance': 'legal-compliance',
  'Product Manager': 'product-manager',
  'Project Manager': 'project-manager',
  Procurement: 'procurement',
  'Content Writer': 'content-writer',
  'AI Ops': 'ai-ops',
};
function demoReply(body, n) {
  const msgs = body.messages || [];
  const sys = String(msgs[0] && msgs[0].role === 'system' ? msgs[0].content : '');
  const userMsg = [...msgs].reverse().find((m) => m.role === 'user');
  const user = String(
    (userMsg && (typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content))) || '',
  );
  const agent = (sys.match(/You are the (.+?) agent in ZAAFPulse/) || [])[1];
  const id = agent && NAMES[agent];
  if (sys.startsWith('You are the ZAAFPulse planner'))
    return JSON.stringify({
      steps: [
        {
          id: 's1',
          agent: 'sre-observability',
          instruction: 'Triage the latency alert and rank hypotheses',
          output: 'summary and ranked hypotheses',
          dependsOn: [],
        },
        {
          id: 's2',
          agent: 'network-ops',
          instruction: 'Rule the network in or out for checkout',
          output: 'evidence for and against',
          dependsOn: [],
        },
        {
          id: 's3',
          agent: 'devops',
          instruction: 'List changes in the incident window',
          output: 'changes with correlation',
          dependsOn: [],
        },
        {
          id: 's4',
          agent: 'project-manager',
          instruction: 'Draft internal and customer updates',
          output: 'two short updates',
          dependsOn: ['s1', 's2', 's3'],
        },
      ],
      reason: 'three independent checks, then one update that needs all of them',
    });
  if (/impartial judge/.test(sys)) return '{"best": 1, "reason": "names the change, the mechanism and the evidence"}';
  if (/strict reviewer/.test(sys))
    return JSON.stringify(
      /\(revised\)|Your previous answer/.test(user) && n % 3
        ? { score: 0.92, issues: [], summary: 'specific, owned and time-boxed' }
        : {
            score: 0.64,
            issues: ['name the owner of each action', 'give the time of the next update'],
            summary: 'right direction, too vague',
          },
    );
  if (/group orchestrator/.test(sys)) {
    const turns = (user.match(/\n\[(?!plan)[a-z-]+\]\n/g) || []).length;
    if (/Write FACTS/.test(user))
      return 'FACTS: checkout p95 4.8 s since 10:02; payment-api v2.14 at 09:55; DB pool 95%. TO LOOK UP: network health, change log. PLAN: sre-observability triages, network-ops rules the network out, devops lists changes, project-manager writes the update.';
    if (/Write the final answer/.test(user))
      return 'Root cause: payment-api v2.14 opens a DB connection per retry and exhausted the pool. The network is healthy. Mitigation: roll back to v2.13 (owner: payments on-call). Next update 11:10.';
    const order = ['sre-observability', 'network-ops', 'devops', 'project-manager'];
    return JSON.stringify({
      is_request_satisfied: { reason: '', answer: turns >= 4 },
      is_in_loop: { reason: '', answer: false },
      is_progress_being_made: { reason: 'new evidence each turn', answer: true },
      next_speaker: { reason: '', answer: order[turns % 4] },
      instruction_or_question: { reason: '', answer: 'Add what your domain shows for the checkout slowdown.' },
    });
  }
  if (/ZAAFPulse synthesizer/.test(sys))
    return 'Checkout slowed because payment-api v2.14 opens a database connection on every retry, which filled the pool at 10:02. The network and other changes are ruled out. Roll back to v2.13 now (payments on-call), add jitter and pooled connections before re-releasing, and send the next update at 11:10.';
  if (/FINAL ANSWER/.test(user)) {
    const ans = /Other agents answered|previous answer/.test(user)
      ? 'the payment-api v2.14 deploy'
      : pick(rng(n), ['the payment-api v2.14 deploy', 'the payment-api v2.14 deploy', 'DB pool exhaustion']);
    return `${(id && AGENT_TEXT[id].split('. ')[0]) || 'The evidence points to one change'}.\nFINAL ANSWER: ${ans}\nCONFIDENCE: ${(0.62 + (n % 4) * 0.09).toFixed(2)}`;
  }
  if (/APPROVAL_PACKET/.test(user))
    return 'APPROVAL_PACKET: roll back payment-api from v2.14 to v2.13 in all zones. Expected: p95 back under 1.5 s within 10 minutes. Risk: low, v2.13 ran for 3 weeks. Rollback of the rollback: redeploy v2.14 from the release pipeline.\n\nDETAIL: the canary shows the fix; no schema change between versions.';
  if (/Give the full corrected answer|reviewer scored it/.test(user))
    return `${id ? AGENT_TEXT[id] : 'Updated answer.'} Owner: payments on-call. Next update 11:10. (revised)`;
  if (id) return AGENT_TEXT[id];
  if (/code|function|bug|refactor/i.test(user))
    return 'The bug is an off-by-one in the pagination cursor: `items.slice(0, limit)` should use the cursor offset. Fixed version:\n\n```ts\nconst page = items.slice(cursor, cursor + limit);\n```';
  return `Here is a short answer to "${user.slice(0, 70)}": the main driver is the 09:55 payment-api deploy; roll back first, then add pooled connections and jitter before releasing again.`;
}
// Word-hashing embeddings: texts on the same topic land close together, so the semantic maps look real.
function embedText(text, dim = 48) {
  const v = new Array(dim).fill(0);
  for (const w of String(text)
    .toLowerCase()
    .match(/[a-z]{4,}/g) || []) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    v[(h >>> 0) % dim] += 1;
    v[((h >>> 7) >>> 0) % dim] += 0.5;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => +(x / n).toFixed(5));
}

function createDemoFetch() {
  let n = 0;
  const limits = (url) => ({
    'x-ratelimit-limit-requests': '5000',
    'x-ratelimit-remaining-requests': String(4200 + ((url.length * 37) % 700)),
    'x-ratelimit-reset-requests': '42s',
    'x-ratelimit-limit-tokens': '2000000',
    'x-ratelimit-remaining-tokens': String(1500000 + ((url.length * 9173) % 400000)),
    'x-ratelimit-reset-tokens': '12s',
  });
  const json = (url, obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...limits(url) } });
  return async function demoFetch(url, init = {}) {
    await new Promise((r) => setTimeout(r, 120 + (n % 5) * 60));
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : {};
    n++;
    const p = CONFIG.providers.find((x) => u.startsWith(x.baseUrl));
    if (/\/models$/.test(u)) return json(u, { data: (p ? p.models : []).map((id) => ({ id })) });
    if (/\/credits$/.test(u)) return json(u, { data: { total_credits: 50, total_usage: 18.42 } });
    if (/\/embeddings$/.test(u)) {
      const input = [].concat(body.input || []);
      return json(u, {
        data: input.map((t, i) => ({ index: i, embedding: embedText(t) })),
        usage: { prompt_tokens: input.join(' ').split(/\s+/).length },
      });
    }
    const anthropic = /\/messages$/.test(u);
    const messages = anthropic
      ? [
          ...(body.system
            ? [
                {
                  role: 'system',
                  content: typeof body.system === 'string' ? body.system : body.system.map((b) => b.text).join(''),
                },
              ]
            : []),
          ...(body.messages || []).map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : m.content.map((b) => b.text || '').join(''),
          })),
        ]
      : body.messages;
    const text = demoReply({ messages }, n);
    const prompt = Math.round(JSON.stringify(messages || []).length / 4);
    const completion = Math.round(text.length / 4);
    if (body.stream) {
      const parts = text.match(/.{1,24}(\s|$)|.+/g) || [text];
      const enc = new TextEncoder();
      const frames = anthropic
        ? [
            `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: `msg_demo${n}`, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: prompt, output_tokens: 0 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
            ...parts.map(
              (t) =>
                `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`,
            ),
            `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: completion } })}\n\n`,
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]
        : [
            ...parts.map(
              (t) =>
                `data: ${JSON.stringify({ id: `chatcmpl-demo${n}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: t } }] })}\n\n`,
            ),
            `data: ${JSON.stringify({ id: `chatcmpl-demo${n}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\n`,
            'data: [DONE]\n\n',
          ];
      const stream = new ReadableStream({
        async pull(c) {
          const f = frames.shift();
          if (!f) return c.close();
          await new Promise((r) => setTimeout(r, 25));
          c.enqueue(enc.encode(f));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...limits(u) } });
    }
    if (anthropic)
      return json(u, {
        id: `msg_demo${n}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: prompt, output_tokens: completion },
      });
    return json(u, {
      id: `chatcmpl-demo${n}`,
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: prompt, completion_tokens: completion },
    });
  };
}

// ---------- seeded state ----------
const KEYS = [
  { name: 'Claude Code (MacBook)', scopes: ['llm'], budgetUSD: 150, rpm: 120 },
  { name: 'n8n automations', scopes: ['llm', 'agents'], budgetUSD: 60, rpm: 60 },
  {
    name: 'Support copilot',
    scopes: ['agents', 'rag'],
    agents: ['customer-service', 'it-helpdesk'],
    budgetUSD: 40,
    rpm: 30,
  },
  { name: 'Research notebook', scopes: ['llm', 'rag', 'mcp'], privateOnly: true, rpm: 60 },
  { name: 'Old CI runner', scopes: ['llm'], rpm: 20, revoke: true },
];
const DOCS = {
  runbooks: [
    'Ops runbooks',
    'How the on-call team responds',
    [
      [
        'Checkout latency runbook',
        'When checkout latency rises check payment service deploys, database connection pool saturation and retry storms. Roll back the payment deploy first.',
      ],
      [
        'Database connection pool',
        'Connection pool exhaustion shows as rising latency and timeouts. Check pool size, retries opening new connections and long transactions.',
      ],
      [
        'Incident severity levels',
        'SEV1 full outage, SEV2 customer facing degradation, SEV3 internal impact, SEV4 cosmetic. Severity decides paging and update cadence.',
      ],
      [
        'Status page updates',
        'Customer updates use plain language, no hostnames, and promise the time of the next update. Internal updates name an owner.',
      ],
      [
        'Rollback procedure',
        'Roll back a service deploy from the release pipeline. Verify latency and error rate recover within ten minutes, then announce.',
      ],
      [
        'DNS troubleshooting',
        'Check resolver latency, record TTLs and recent zone changes. Compare both zones before blaming the network.',
      ],
    ],
  ],
  support: [
    'Support handbook',
    'Policies the support copilot cites',
    [
      [
        'Refund policy',
        'Refunds are approved within thirty days of purchase. Card refunds arrive in three to five business days. Vouchers need team lead approval above fifty dollars.',
      ],
      [
        'Escalation matrix',
        'Escalate billing disputes to finance, security reports to the security team and outages to the on-call engineer.',
      ],
      ['Tone guide', 'Thank the customer, answer the question first, avoid jargon and close with a clear next step.'],
      [
        'Saved payment methods',
        'Customers can save cards and wallets at checkout. Saved payment methods are tokenised and never stored in full.',
      ],
      ['Invoice download', 'Invoices can be downloaded as PDF from billing settings, filtered by month.'],
    ],
  ],
  research: [
    'AI research notes',
    'Papers and evaluations',
    [
      [
        'Hybrid search evaluation',
        'Hybrid search combining keyword ranking and embeddings improves recall on enterprise documents. Re-ranking adds a few points.',
      ],
      [
        'Multi-agent failure modes',
        'Multi agent systems fail through specification problems, inter agent misalignment and weak verification. Budgets and termination rules help.',
      ],
      [
        'Token saver results',
        'Compressing long tool results before they reach the model cuts input tokens by forty percent on coding sessions without losing accuracy.',
      ],
      [
        'Faithfulness metrics',
        'Faithfulness checks whether each claim in an answer is supported by retrieved context or the conversation. Relevance checks the answer addresses the question.',
      ],
      [
        'Embedding model comparison',
        'Small local embedding models reach most of the retrieval quality of hosted models for English technical documents.',
      ],
    ],
  ],
};

// Second-brain sources written as small files in the demo folder, plus synthetic vector stores.
const PARA = {
  '1 Projects': ['Checkout latency fix', 'Pricing page tests', 'Mobile offline sync', 'SSO rollout'],
  '2 Areas': ['On-call', 'Hiring', 'Team rituals', 'Cloud costs'],
  '3 Resources': ['Postgres tuning', 'Prompting guide', 'Vector DB compare', 'SLO math', 'Writing style'],
  '4 Archives': ['Q2 planning', 'Old CI pipeline', 'Datacenter exit'],
};
const LOGSEQ = [
  'Daily 2026-10-14',
  'Daily 2026-10-15',
  'Daily 2026-10-16',
  'Daily 2026-10-17',
  'Agent tooling',
  'RAG chunking',
  'Prompt caching',
  'Eval harness',
  'Checkout latency fix',
  'Reading list',
  'Meeting notes',
  'Ideas',
];
function writeBrainFiles(dir, now) {
  const write = (rel, text, t) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    fs.utimesSync(f, new Date(t), new Date(t));
  };
  const r = rng(11);
  const all = Object.values(PARA).flat();
  Object.entries(PARA).forEach(([folder, names], fi) =>
    names.forEach((n) =>
      write(
        `para/${folder}/${n}.md`,
        `# ${n}\n\nSee [[${pick(r, all)}]] and [[${pick(r, all)}]].\n#${folder.split(' ')[1].toLowerCase()}\n`,
        now - (fi * 20 + r() * 30) * DAY,
      ),
    ),
  );
  LOGSEQ.forEach((n, i) =>
    write(
      `logseq/pages/${n}.md`,
      `- ${n}\n  - related [[${LOGSEQ[(i + 3) % LOGSEQ.length]}]]\n  - see [[${pick(r, LOGSEQ)}]] #notes\n`,
      now - (LOGSEQ.length - i) * 2 * DAY,
    ),
  );
  const items = (names, type) =>
    names.map((n, i) => ({
      id: `${type}-${i}`,
      title: n,
      type,
      tags: [type],
      created_at: new Date(now - (names.length - i) * 3 * DAY).toISOString(),
      content: `About ${n}. Links to [[${names[(i + 2) % names.length]}]] and [[${names[(i + 5) % names.length]}]].`,
    }));
  // Tana's JSON export: named nodes with bullet children, references between them and supertags.
  const tana = [
    'Weekly review',
    'OKR Q4',
    'Checkout latency fix',
    'Customer interviews',
    'Pricing experiment',
    'Hiring plan',
    'Agent tooling',
    'Board update',
    'Roadmap 2027',
    'Team offsite',
    'Q4 launch',
    'Design review',
  ];
  const docs = [
    { id: 'tag-project', props: { name: 'project', _docType: 'tagDef' } },
    { id: 'tag-meeting', props: { name: 'meeting', _docType: 'tagDef' } },
    { id: 'root', props: { name: 'Workspace' }, children: tana.map((_, i) => `n${i}`) },
  ];
  tana.forEach((n, i) => {
    const t = now - (tana.length - i) * 4 * DAY;
    docs.push(
      {
        id: `n${i}`,
        props: { name: n, created: t, modified: t },
        supertags: [i % 3 ? 'tag-project' : 'tag-meeting'],
        children: [`n${i}a`, `n${i}b`],
      },
      { id: `n${i}a`, props: { name: `Notes on ${n}`, created: t }, refs: [`n${(i + 3) % tana.length}`] },
      { id: `n${i}b`, props: { name: 'Next step', created: t }, refs: [`n${(i + 7) % tana.length}`] },
    );
  });
  fs.writeFileSync(path.join(dir, 'tana.json'), JSON.stringify({ docs }));
  fs.writeFileSync(
    path.join(dir, 'heybrain.json'),
    JSON.stringify(
      items(
        [
          'Voice memo: pricing',
          'Article: hybrid search',
          'Video: agent evals',
          'Voice memo: hiring',
          'Article: SLO math',
          'Podcast: AI infra',
          'Article: prompt caching',
          'Voice memo: offsite',
        ],
        'capture',
      ),
    ),
  );
}
// Clusters of points in embedding space with a little noise, like samples from a real collection.
function demoVectors(name, topics, perTopic, seed) {
  const r = rng(seed);
  const out = [];
  topics.forEach((t, ti) => {
    const base = embedText(t.repeat(3) + ti);
    for (let i = 0; i < perTopic; i++)
      out.push({
        id: `${name}-${ti}-${i}`,
        vector: base.map((x) => x + (r() - 0.5) * 0.18),
        meta: { title: `${t} · ${i + 1}` },
        collection: t.split(' ')[0],
        text: `${t} chunk ${i + 1}`,
      });
  });
  return out;
}
const BRAIN_SOURCES = (dir) => [
  { id: 'logseq', type: 'logseq', name: 'Logseq journal', enabled: true, path: path.join(dir, 'logseq') },
  { id: 'para', type: 'para', name: 'PARA workspace', enabled: true, path: path.join(dir, 'para') },
  { id: 'tana', type: 'tana', name: 'Tana workspace', enabled: true, path: path.join(dir, 'tana.json') },
  { id: 'heybrain', type: 'heybrain', name: 'Heybrain captures', enabled: true, path: path.join(dir, 'heybrain.json') },
  {
    id: 'qdrant',
    type: 'qdrant',
    name: 'Qdrant · docs',
    enabled: true,
    url: 'http://localhost:6333',
    options: { collection: 'docs' },
  },
  {
    id: 'pgvector',
    type: 'pgvector',
    name: 'pgvector · tickets',
    enabled: true,
    url: 'postgres://localhost:5432/app',
    options: { table: 'tickets' },
  },
];
const VECTORS = {
  qdrant: () =>
    demoVectors(
      'qdrant',
      [
        'billing invoices refunds',
        'deploy rollback pipeline',
        'database latency pool',
        'onboarding checklist trial',
        'security phishing access',
      ],
      18,
      3,
    ),
  pgvector: () =>
    demoVectors(
      'pgvector',
      ['refund request card', 'login password reset', 'slow checkout payment', 'invoice download pdf'],
      22,
      5,
    ),
};

// Requests over the last week: office hours busier, a few rate limits and fallbacks, some token-saver hits.
function seedUsage(usage, keyIds, now) {
  const r = rng(42);
  const models = [
    ['anthropic/claude-sonnet-5-5', 'anthropic', 'anthropic'],
    ['router/fast', 'groq', 'openai'],
    ['router/code', 'ollama', 'openai'],
    ['openai/gpt-6.1-mini', 'openai', 'responses'],
    ['gemini/gemini-3-flash', 'gemini', 'gemini'],
    ['router/smart', 'anthropic', 'openai'],
    ['openrouter/deepseek/deepseek-v4.1-flash', 'openrouter', 'openai'],
    ['ollama/llama4-scout', 'ollama', 'openai'],
  ];
  const agents = Object.keys(AGENT_TEXT);
  for (let t = now - 7 * DAY; t < now - 10 * 60e3; t += 4 * 60e3) {
    const h = new Date(t).getHours();
    const busy = h >= 8 && h <= 19 ? 1 : 0.15;
    if (r() > busy * 0.75) continue;
    const [model, prov, format] = pick(r, models);
    const agent = r() < 0.3 ? pick(r, agents) : undefined;
    const input = Math.round(400 + r() ** 2 * 9000);
    const status = r() < 0.02 ? 429 : r() < 0.01 ? 502 : 200;
    usage.record({
      ts: t + Math.round(r() * 2e5),
      keyId: agent ? keyIds[1] : pick(r, [keyIds[0], keyIds[0], keyIds[1], keyIds[3], 'dashboard']),
      provider: prov,
      model,
      routedTo: model.startsWith('router/')
        ? `${prov}/${CONFIG.providers.find((p) => p.id === prov).models[0]}`
        : undefined,
      kind: agent ? 'agent' : 'chat',
      format: agent ? undefined : format,
      stream: !agent && r() < 0.7,
      agent,
      status,
      ms: Math.round(prov === 'ollama' ? 1800 + r() * 4000 : 500 + r() * 2600),
      ttft: Math.round(180 + r() * 700),
      input: status === 200 ? input : 0,
      output: status === 200 ? Math.round(80 + r() * 900) : 0,
      cached: status === 200 && r() < 0.4 ? Math.round(input * 0.6) : 0,
      savedTokens: format === 'anthropic' && r() < 0.35 ? Math.round(800 + r() * 6000) : undefined,
      error:
        status === 200
          ? undefined
          : status === 429
            ? 'rate limited, fell back to the next route target'
            : 'upstream error',
    });
  }
}

async function seed(gateway, { dataDir, now = Date.now() }) {
  const ids = [];
  for (const k of KEYS) {
    const { key } = gateway.keys.create(k);
    ids.push(key.id);
    if (k.revoke) gateway.keys.revoke(key.id);
  }
  seedUsage(gateway.usage, ids, now);
  for (const [id, [name, description, docs]] of Object.entries(DOCS)) {
    gateway.knowledge.create({ id, name, description, embedModel: 'ollama/nomic-embed-text' });
    for (const [title, content] of docs)
      await gateway.knowledge.ingest(id, { title, content, source: `${title.toLowerCase().replace(/ /g, '-')}.md` });
  }
  for (const text of [
    'The payments team owns payment-api; on-call rotates weekly.',
    'Customer updates promise the time of the next update.',
    'Prefer router/private for anything with customer data.',
  ])
    gateway.memory.save({ text, source: 'agent' });
  writeBrainFiles(path.join(dataDir, 'brain'), now);
  return { keyIds: ids };
}

// Drives the running demo server once: chats in every format, agents with sessions, each collaboration
// pattern and a workflow that waits at its approval gate, so runs, traces and sessions are real.
async function warm(baseUrl, gateway) {
  const { secret } = gateway.keys.create({ name: 'Demo playground', scopes: ['llm', 'agents', 'rag', 'mcp'] });
  const post = (p, body, extra = {}) =>
    fetch(baseUrl + p, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    })
      .then((r) => r.text())
      .catch(() => '');
  const task =
    'SEV2: checkout p95 4.8 s since 10:02 (normal 1.1 s). payment-api errors 6%, DB pool 95%. payment-api v2.14 deployed 09:55. What happened and what do we do?';
  await post('/v1/chat/completions', {
    model: 'router/fast',
    messages: [{ role: 'user', content: 'Summarise the checkout incident in one line.' }],
  });
  await post('/v1/messages', {
    model: 'claude-sonnet-5-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: 'Fix the pagination bug in this function.' }],
  });
  await post('/v1/responses', { model: 'openai/gpt-6.1-mini', input: 'Write a release note for v2.14.' });
  await post(
    '/v1/chat/completions',
    {
      model: 'agent/customer-service',
      messages: [{ role: 'user', content: 'Customer asks about refund for order #58213.' }],
    },
    { 'x-zp-session': 'demo-support' },
  );
  await post('/v1/chat/completions', {
    model: 'agent/security',
    messages: [{ role: 'user', content: 'Is this email from "the CFO" phishing?' }],
  });
  for (const pattern of ['auto', 'vote', 'debate', 'review', 'group'])
    await post('/v1/chat/completions', { model: `collab/${pattern}`, messages: [{ role: 'user', content: task }] });
  await post('/v1/workflows/incident-triage-rca/run', { input: task });
  await post('/v1/workflows/cs-refund-complaint/run', {
    input: 'Order #58213 arrived damaged; customer wants a refund of $42.10 and is upset about the wait.',
  });
}

module.exports = { CONFIG, createDemoFetch, seed, warm, BRAIN_SOURCES, VECTORS, embedText };
