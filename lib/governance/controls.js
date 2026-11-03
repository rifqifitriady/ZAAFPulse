// Governance compliance (AI Governance 3): the fixed catalogue of controls ZAAFPulse provides (spec I6, I7), each one
// mapped to clauses of the EU AI Act, the NIST AI RMF and ISO/IEC 42001, with a live status ('in place', 'partial',
// 'off', 'unknown') and its evidence (a setting's value, a count, a date) worked out from the state server.js reads.
// Pure: no I/O, no clock (the time comes in the state). Evidence for the owner's assessment, not a certification:
// nothing here says "compliant".
const FRAMEWORKS = [
  {
    id: 'eu-ai-act',
    name: 'EU AI Act',
    version: 'Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744',
  },
  { id: 'nist-ai-rmf', name: 'NIST AI RMF', version: 'NIST AI RMF 1.0' },
  { id: 'iso-42001', name: 'ISO/IEC 42001', version: 'ISO/IEC 42001:2023' },
];
const CLAUSES = [
  { id: 'eu-12', framework: 'eu-ai-act', ref: 'Art. 12', title: 'Record-keeping' },
  { id: 'eu-14', framework: 'eu-ai-act', ref: 'Art. 14', title: 'Human oversight' },
  {
    id: 'eu-26',
    framework: 'eu-ai-act',
    ref: 'Art. 26',
    title: 'Deployer obligations: logs kept at least 6 months, oversight assigned, monitoring',
  },
  { id: 'eu-50', framework: 'eu-ai-act', ref: 'Art. 50', title: "Transparency, where the owner's use applies" },
  {
    id: 'nist-gv-1.4',
    framework: 'nist-ai-rmf',
    ref: 'GOVERN 1.4',
    title: 'Risk management through policies, procedures and controls',
  },
  { id: 'nist-gv-1.6', framework: 'nist-ai-rmf', ref: 'GOVERN 1.6', title: 'An inventory of AI systems' },
  { id: 'nist-mp-1.1', framework: 'nist-ai-rmf', ref: 'MAP 1.1', title: 'Intended purposes and context documented' },
  { id: 'nist-ms-2.1', framework: 'nist-ai-rmf', ref: 'MEASURE 2.1', title: 'Test sets, metrics and tools documented' },
  {
    id: 'nist-ms-2.3',
    framework: 'nist-ai-rmf',
    ref: 'MEASURE 2.3',
    title: 'Performance measured in deployment-like conditions',
  },
  { id: 'nist-ms-2.4', framework: 'nist-ai-rmf', ref: 'MEASURE 2.4', title: 'Behaviour monitored in production' },
  { id: 'nist-ms-2.7', framework: 'nist-ai-rmf', ref: 'MEASURE 2.7', title: 'Security and resilience evaluated' },
  { id: 'nist-ms-2.10', framework: 'nist-ai-rmf', ref: 'MEASURE 2.10', title: 'Privacy risk examined' },
  { id: 'nist-mg-2.4', framework: 'nist-ai-rmf', ref: 'MANAGE 2.4', title: 'Mechanisms to disengage or deactivate' },
  {
    id: 'nist-mg-4.1',
    framework: 'nist-ai-rmf',
    ref: 'MANAGE 4.1',
    title: 'Post-deployment monitoring, override and change management',
  },
  { id: 'iso-a2', framework: 'iso-42001', ref: 'A.2', title: 'Policies related to AI' },
  { id: 'iso-a4', framework: 'iso-42001', ref: 'A.4', title: 'Resources for AI systems' },
  { id: 'iso-a5', framework: 'iso-42001', ref: 'A.5', title: 'Assessing impacts of AI systems' },
  { id: 'iso-a6', framework: 'iso-42001', ref: 'A.6', title: 'AI system life cycle' },
  { id: 'iso-a7', framework: 'iso-42001', ref: 'A.7', title: 'Data for AI systems' },
  { id: 'iso-a8', framework: 'iso-42001', ref: 'A.8', title: 'Information for interested parties' },
  { id: 'iso-a9', framework: 'iso-42001', ref: 'A.9', title: 'Use of AI systems' },
  { id: 'iso-a10', framework: 'iso-42001', ref: 'A.10', title: 'Third-party and customer relationships' },
];
const NOTICE = 'Evidence for your assessment, not a certification. Statuses follow the current settings and state.';
const STATUSES = ['in place', 'partial', 'off', 'unknown'];
const KEY_RULES = ['guardrail_block', 'audit_chain_broken', 'inventory_unreviewed'];
const SIX_MONTHS_DAYS = 183;
const RECENT_DAYS = 90; // an experiment finished this recently counts as testing that happens
const DAY_MS = 864e5;
const RANK = { off: 0, log: 1, redact: 2, block: 3 };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const n = (v) => (Number.isFinite(v) ? v : 0);
const plural = (k, word, many = `${word}s`) => `${k} ${k === 1 ? word : many}`;
const dayOf = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null);
// Unknown, with the reason, when a part of the state could not be read (not off: nothing says it is switched off).
const unread = () => ({ status: 'unknown', evidence: ['could not be read'] });
// in place when every one counts, off when none does, partial between; in place when there is nothing to count.
const share = (good, all) => (all === 0 || good === all ? 'in place' : good === 0 ? 'off' : 'partial');

// Each control: id, title, the clauses it maps to, the page that shows it, and how its status and evidence follow
// from the state. check(part, state) gets state[part], an object or an array; a part that is missing, null or of any
// other shape is 'unknown' without check being called, and a check that throws is 'unknown' too.
const CATALOGUE = [
  {
    id: 'guardrails',
    title: 'Gateway guardrails',
    clauses: ['nist-ms-2.7', 'nist-ms-2.10', 'iso-a9', 'iso-a7'],
    link: '#gateway/router',
    part: 'guardrails',
    check(g, s) {
      const modes = [
        ['secrets', g.secrets],
        ['personal data', g.pii],
        ['prompt injection', g.injection],
      ];
      // in place: every check redacts or blocks (injection blocks); partial: secrets are stopped but another check only
      // logs or is off; off: secrets are only logged or not checked.
      const strong = (k, m) => (k === 'injection' ? m === 'block' : m === 'redact' || m === 'block');
      const all = ['secrets', 'pii', 'injection'].every((k) => strong(k, g[k]));
      const secretsStopped = g.secrets === 'redact' || g.secrets === 'block';
      // A key that sets a check weaker than the global setting.
      const weak = arr(s.keys).filter(
        (k) =>
          !k.revokedAt &&
          !(Number.isFinite(k.expiresAt) && k.expiresAt <= s.now) &&
          isObj(k.guardrails) &&
          ['secrets', 'pii', 'injection'].some(
            (c) => k.guardrails[c] !== undefined && RANK[k.guardrails[c]] < RANK[g[c] || 'off'],
          ),
      ).length;
      const base = all ? 'in place' : secretsStopped ? 'partial' : 'off';
      return {
        status: weak && base === 'in place' ? 'partial' : base,
        evidence: [
          ...modes.map(([w, m]) => `${w}: ${m || 'off'}`),
          `scope: ${g.scope || 'external'}`,
          ...(weak ? [`${plural(weak, 'key')} weaken${weak === 1 ? 's' : ''} a check`] : []),
        ],
      };
    },
  },
  {
    id: 'audit_log',
    title: 'Governance audit log',
    clauses: ['eu-12', 'eu-26', 'nist-gv-1.4', 'nist-mg-4.1', 'iso-a6'],
    link: '#governance/audit',
    part: 'audit',
    check(a) {
      const kept = `kept ${a.retentionMonths} months (at least 6)`;
      const v = a.lastVerify;
      if (a.degraded)
        return {
          status: 'off',
          evidence: [
            kept,
            `degraded since ${a.degraded.since}: ${plural(n(a.degraded.missed), 'entry', 'entries')} not written`,
          ],
        };
      if (!v) return { status: 'partial', evidence: [kept, 'not verified yet'] };
      const when = v.at ? ` (${dayOf(Date.parse(v.at))})` : '';
      if (!v.ok)
        return {
          status: 'off',
          evidence: [
            kept,
            v.reason === 'key missing'
              ? `last verify${when}: the audit key is missing`
              : `last verify${when}: broken at entry ${v.brokenAt} (${v.reason})`,
          ],
        };
      return {
        status: 'in place',
        evidence: [kept, `last verify${when}: chain intact, ${plural(n(v.checked), 'entry', 'entries')} checked`],
      };
    },
  },
  {
    id: 'usage_log',
    title: 'Gateway request log',
    clauses: ['eu-12', 'eu-26', 'nist-ms-2.4', 'iso-a6'],
    link: '#gateway',
    part: 'usage',
    check(u, s) {
      // The log keeps one rotated file past its size cap: a log that rotated and still reaches back less than 6 months
      // cannot show 6 months of records. A young install that never rotated is fine.
      const young = Number.isFinite(u.oldest) && s.now - u.oldest < SIX_MONTHS_DAYS * DAY_MS;
      const short = !!u.rotated && young;
      return {
        status: short ? 'partial' : 'in place',
        evidence: [
          `${plural(n(u.requests), 'gateway request')} recorded this month`,
          Number.isFinite(u.oldest) ? `oldest entry ${dayOf(u.oldest)}` : 'no entry yet',
          ...(short ? [`the log is at its size cap and reaches back under ${SIX_MONTHS_DAYS} days`] : []),
        ],
      };
    },
  },
  {
    id: 'provider_approval',
    title: 'External providers need approval',
    clauses: ['eu-26', 'nist-gv-1.4', 'iso-a2', 'iso-a10'],
    link: '#gateway/providers',
    part: 'providers',
    check(list) {
      const ext = arr(list).filter((p) => p.tier === 'external' && p.enabled !== false);
      const waiting = ext.filter((p) => p.approved === false).length;
      const legacy = ext.filter((p) => p.approved !== false && !p.recorded).length;
      return {
        status: legacy ? 'partial' : 'in place',
        evidence: [
          plural(ext.length, 'external provider'),
          `${ext.length - waiting} approved`,
          `${waiting} waiting for approval`,
          ...(legacy ? [`${legacy} served without a recorded approval (set up before approvals existed)`] : []),
        ],
      };
    },
  },
  {
    id: 'api_keys',
    title: 'API keys with scopes, budgets and expiry',
    clauses: ['eu-26', 'nist-gv-1.4', 'nist-mg-2.4', 'iso-a9'],
    link: '#endpoint/keys',
    part: 'keys',
    check(list, s) {
      const active = arr(list).filter((k) => !k.revokedAt && !(Number.isFinite(k.expiresAt) && k.expiresAt <= s.now));
      const budget = active.filter((k) => n(k.budgetUSD) > 0).length;
      const expiry = active.filter((k) => Number.isFinite(k.expiresAt)).length;
      const limited = active.filter((k) => n(k.budgetUSD) > 0 || Number.isFinite(k.expiresAt)).length;
      const narrow = active.filter((k) => Array.isArray(k.scopes) && k.scopes.length < 4).length;
      return {
        status: share(limited, active.length),
        evidence: [
          plural(active.length, 'active key'),
          `${budget} with a budget`,
          `${expiry} with an expiry`,
          `${narrow} limited to some scopes`,
        ],
      };
    },
  },
  {
    id: 'approval_gates',
    title: 'Human approval in workflows',
    clauses: ['eu-14', 'eu-26', 'nist-mg-4.1', 'iso-a9'],
    link: '#a2a',
    part: 'workflows',
    check(list) {
      const all = arr(list);
      const acting = all.filter((w) => w.tier === 'R2' || w.tier === 'R3');
      const gated = acting.filter((w) => w.gated).length;
      return {
        status: share(gated, acting.length),
        evidence: [
          `workflows that send, change or decide: ${gated} of ${acting.length} wait for a person`,
          `workflows with an approval step: ${all.filter((w) => w.gated).length} of ${all.length}`,
        ],
      };
    },
  },
  {
    id: 'agent_control',
    title: 'Pause and stop an agent',
    clauses: ['eu-14', 'nist-mg-2.4', 'iso-a9'],
    link: '#settings/monitors',
    part: 'agentControl',
    check: (c) =>
      c.off
        ? { status: 'off', evidence: [String(c.off)] }
        : {
            status: 'in place',
            evidence: ['pause, resume and stop are available from the dashboard and the Monitors'],
          },
  },
  {
    id: 'monitors',
    title: 'Monitors rules',
    clauses: ['eu-26', 'nist-ms-2.4', 'nist-mg-4.1', 'iso-a6'],
    link: '#settings/monitors',
    part: 'monitors',
    check(list) {
      const rules = arr(list);
      const on = new Set(rules.filter((r) => r.enabled).map((r) => r.id));
      const keyOff = KEY_RULES.filter((id) => !on.has(id));
      return {
        status: keyOff.length === 0 ? 'in place' : keyOff.length === KEY_RULES.length ? 'off' : 'partial',
        evidence: [
          `${on.size} of ${plural(rules.length, 'rule')} on`,
          keyOff.length ? `off: ${keyOff.join(', ')}` : `${KEY_RULES.join(', ')} on`,
        ],
      };
    },
  },
  {
    id: 'evals',
    title: 'Evals running',
    clauses: ['nist-ms-2.3', 'nist-ms-2.4', 'iso-a6'],
    link: '#quality',
    part: 'evals',
    check(e) {
      const judging = e.judge && n(e.evaluators) > 0 && e.ok && !e.paused;
      return {
        status: judging ? 'in place' : 'partial',
        evidence: [
          'code evaluators run on every session',
          !e.judge
            ? 'judge off'
            : !e.ok
              ? 'judge waiting for a model'
              : e.paused
                ? `judge paused: ${e.paused}`
                : `judge model: ${e.model || 'chosen automatically'}`,
          `${n(e.evaluators)} of ${n(e.total)} judge evaluators on`,
          `${n(e.today)} judged today`,
        ],
      };
    },
  },
  {
    id: 'experiments',
    title: 'Dataset experiments',
    clauses: ['nist-ms-2.1', 'nist-ms-2.3', 'iso-a6', 'iso-a7'],
    link: '#datasets/experiments',
    part: 'datasets',
    check(d, s) {
      const done = arr(d.experiments).filter((x) => x.status === 'done' && Number.isFinite(x.endedAt));
      const last = done.reduce((m, x) => Math.max(m, x.endedAt), -Infinity);
      const recent = done.some((x) => s.now - x.endedAt <= RECENT_DAYS * DAY_MS);
      return {
        status: n(d.count) === 0 ? 'off' : recent ? 'in place' : 'partial',
        evidence: [
          plural(n(d.count), 'dataset'),
          `${plural(done.length, 'finished experiment')}`,
          done.length ? `last finished ${dayOf(last)}` : 'no experiment finished yet',
        ],
      };
    },
  },
  {
    id: 'cost_budgets',
    title: 'Budgets that block or pause',
    clauses: ['nist-mg-2.4', 'iso-a9'],
    link: '#cost/budgets',
    part: 'budgets',
    check(list, s) {
      const all = arr(list);
      const block = all.filter((b) => b.enforce === 'block').length;
      const pause = all.filter((b) => b.enforce === 'pause').length;
      // A pause budget acts through agent control: with that off it stops nothing.
      const idle = pause > 0 && isObj(s.agentControl) && !!s.agentControl.off;
      return {
        status: !all.length ? 'off' : block + (idle ? 0 : pause) ? 'in place' : 'partial',
        evidence: [
          plural(all.length, 'budget'),
          `${block} block`,
          `${pause} pause`,
          ...(idle ? ['pause budgets do nothing while agent control is off'] : []),
        ],
      };
    },
  },
  {
    id: 'secret_store',
    title: 'Secrets in the OS store',
    clauses: ['nist-ms-2.7', 'iso-a4'],
    link: '#settings',
    part: 'secretStore',
    check: (st) => ({
      status: st.id === 'keychain' || st.id === 'libsecret' ? 'in place' : 'partial',
      evidence: [`secrets saved from the dashboard are kept in the ${st.label || st.id}`],
    }),
  },
  {
    id: 'sign_in',
    title: 'Dashboard sign-in',
    clauses: ['eu-26', 'nist-ms-2.7', 'iso-a9'],
    link: '#settings',
    part: 'signIn',
    check(si) {
      const words = { local: 'only this OS account', password: 'a password', none: 'no sign-in' };
      return {
        status: si.mode === 'local' || si.mode === 'password' ? 'in place' : 'off',
        evidence: [
          `sign-in: ${words[si.mode] || si.mode}`,
          si.serverMode ? 'server mode' : 'this machine only',
          ...(si.serverMode ? [si.tls ? 'TLS on' : 'TLS at a proxy, or off'] : []),
        ],
      };
    },
  },
  {
    id: 'content_capture',
    title: 'Content capture off',
    clauses: ['nist-ms-2.10', 'iso-a7'],
    link: '#trace',
    part: 'content',
    check: (c) => ({
      status: c.otelCapture ? 'off' : 'in place',
      evidence: [
        c.otelCapture ? 'the OpenTelemetry export sends prompts and replies' : 'no prompt or reply is exported',
        'the local trace store keeps no content',
        c.traceContentOff
          ? 'the trace explorer shows no text'
          : 'the trace explorer shows the owner the text of local logs',
      ],
    }),
  },
  {
    id: 'otel_export',
    title: 'OpenTelemetry export',
    clauses: ['eu-12', 'nist-ms-2.4', 'nist-mg-4.1', 'iso-a6'],
    link: '#settings',
    part: 'otel',
    check(o) {
      if (!o.enabled)
        return o.error
          ? { status: 'unknown', evidence: ['the OpenTelemetry settings could not be used'] }
          : { status: 'off', evidence: ['not set up (see docs/otel.md)'] };
      const failed = n(o.failed);
      return {
        status: failed > 0 ? 'partial' : 'in place',
        evidence: [
          `to ${o.origin || 'the configured endpoint'}${o.protocol ? ` over ${o.protocol}` : ''}`,
          ...(failed > 0 ? [`${plural(failed, 'span')} failed to export since start`] : []),
        ],
      };
    },
  },
  {
    id: 'trace_retention',
    title: 'Trace retention',
    clauses: ['eu-12', 'eu-26', 'nist-ms-2.4', 'iso-a6'],
    link: '#trace',
    part: 'traces',
    check(tr) {
      if (!tr.store || !tr.enabled)
        return { status: 'off', evidence: [tr.store ? 'tracing is off' : 'the local trace store is not available'] };
      const days = n(tr.retentionDays);
      return {
        status: days >= SIX_MONTHS_DAYS ? 'in place' : 'partial',
        evidence: [
          `kept ${plural(days, 'day')}, up to ${Math.round(n(tr.maxBytes) / 1048576)} MB`,
          ...(days < SIX_MONTHS_DAYS ? [`under ${SIX_MONTHS_DAYS} days (6 months)`] : []),
        ],
      };
    },
  },
  {
    id: 'inventory_coverage',
    title: 'AI inventory reviewed',
    clauses: ['eu-26', 'eu-50', 'nist-gv-1.6', 'nist-mp-1.1', 'iso-a5', 'iso-a8'],
    link: '#governance',
    part: 'inventory',
    check(c) {
      const total = n(c.total);
      const reviewed = n(c.reviewed);
      const open = n(c.riskUndecided) + n(c.unacceptableNotBlocked);
      const pct = total ? Math.round((reviewed / total) * 100) : 100;
      const failed = n(c.failed);
      if (failed > 0 && failed >= n(c.sources)) return unread();
      const base = total === 0 || (reviewed === total && open === 0) ? 'in place' : reviewed === 0 ? 'off' : 'partial';
      return {
        status: failed > 0 && base === 'in place' ? 'partial' : base,
        evidence: [
          `${reviewed} of ${plural(total, 'item')} reviewed (${pct}%)`,
          `${n(c.high)} high risk, ${n(c.unacceptable)} unacceptable`,
          `${n(c.riskUndecided)} high or unacceptable without a decision`,
          `${n(c.unacceptableNotBlocked)} unacceptable not blocked`,
          ...(failed > 0 ? [`${plural(failed, 'inventory source')} could not be read`] : []),
        ],
      };
    },
  },
];

// controls(state) -> [{ id, title, status, evidence: [text], link, clauses: [{ id, framework, ref, title }] }].
// state: { now, guardrails, audit, usage, providers, keys, workflows, agentControl, monitors, evals, datasets, budgets,
// secretStore, signIn, content, otel, traces, inventory }; a part that is null or missing could not be read.
function controls(state) {
  const s = isObj(state) ? state : {};
  const byId = new Map(CLAUSES.map((c) => [c.id, c]));
  return CATALOGUE.map((c) => {
    let r;
    try {
      const part = s[c.part];
      r = part !== null && typeof part === 'object' ? c.check(part, s) : unread();
    } catch {
      r = unread();
    }
    return {
      id: c.id,
      title: c.title,
      status: r.status,
      evidence: r.evidence,
      link: c.link,
      clauses: c.clauses.map((id) => byId.get(id)),
    };
  });
}

module.exports = { controls, CATALOGUE, CLAUSES, FRAMEWORKS, NOTICE, STATUSES, KEY_RULES, SIX_MONTHS_DAYS };
