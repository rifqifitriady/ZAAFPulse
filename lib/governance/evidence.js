// Governance compliance (AI Governance 3): the evidence export (spec I9), pure. evidenceReport() puts together the
// inventory with its reviews, the controls with their status, evidence and clauses, the audit log's verify result and
// retention, the time and the ZAAFPulse version; toJson() and toMarkdown() write it out. No path leaves here: an
// item's project folders are dropped, the AI clients whose files could not be read are named by their display name
// only, and no other field holds one.
const { CLAUSES, FRAMEWORKS, NOTICE, STATUSES } = require('./controls');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
// The fields of an item the report keeps (its project folders, ~ paths for the dashboard, are not one of them).
const ITEM_FIELDS = [
  'id',
  'kind',
  'name',
  'vendor',
  'where',
  'state',
  'firstSeen',
  'lastSeen',
  'status',
  'review',
  'transport',
  'command',
  'package',
  'origin',
  'type',
  'ours',
  'clients',
];

// evidenceReport({ inventory: GET /api/governance/inventory, controls: GET /api/governance/controls, audit:
// { retentionMonths, degraded, lastVerify }, version, generatedAt }) -> the report (the JSON export as it is).
function evidenceReport({ inventory, controls, audit, version, generatedAt }) {
  const inv = isObj(inventory) ? inventory : {};
  const ctl = isObj(controls) ? controls : {};
  const a = isObj(audit) ? audit : {};
  return {
    title: 'ZAAFPulse governance evidence',
    notice: NOTICE,
    generatedAt,
    version: typeof version === 'string' ? version : null,
    frameworks: FRAMEWORKS,
    controls: arr(ctl.controls).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      evidence: Array.isArray(c.evidence) ? c.evidence : [],
      link: c.link,
      clauses: arr(c.clauses).map((x) => ({ framework: x.framework, ref: x.ref, title: x.title })),
    })),
    audit: {
      retentionMonths: a.retentionMonths,
      degraded: a.degraded || null,
      lastVerify: a.lastVerify || null,
    },
    inventory: {
      counts: isObj(inv.counts) ? inv.counts : {},
      failed: Array.isArray(inv.failed) ? inv.failed : [],
      unreadableClients: arr(inv.clients)
        .filter((c) => c.state === 'unreadable' && typeof c.name === 'string')
        .map((c) => c.name),
      items: arr(inv.items).map((it) =>
        Object.fromEntries(ITEM_FIELDS.filter((k) => it[k] !== undefined).map((k) => [k, it[k]])),
      ),
    },
  };
}

const toJson = (report) => `${JSON.stringify(report, null, 2)}\n`;

// Text in a table cell or a line: one line (U+2028, U+2029 and U+0085 are line breaks too), its pipes escaped, no
// markup: no HTML, and no inline Markdown (a link, an image that a viewer would fetch, code or emphasis), since an
// owner's note or a server's name may hold anything.
const inline = (v) =>
  String(v)
    .replace(/[\r\n\u2028\u2029\u0085]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/[|`[\]!*_]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const cell = (v) => inline(v === null || v === undefined || v === '' ? '—' : v);
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const table = (head, rows) => [row(head), `|${head.map(() => '---').join('|')}|`, ...rows.map(row)].join('\n');

function verifyLine(v) {
  if (!v) return 'not verified yet';
  const at = v.at ? ` (${v.at})` : '';
  if (v.ok)
    return v.checked ? `chain intact, entries ${v.from}–${v.to} checked${at}` : `chain intact, no entries yet${at}`;
  if (v.reason === 'key missing') return `cannot be checked: the audit key is missing${at}`;
  return `broken at entry ${v.brokenAt}: ${v.reason}${at}`;
}

// The report as a readable Markdown document: the notice, the controls, the clauses by framework, the audit log and
// the inventory.
function toMarkdown(report) {
  const r = isObj(report) ? report : {};
  const controls = arr(r.controls);
  const items = arr(r.inventory && r.inventory.items);
  const counts = (r.inventory && r.inventory.counts) || {};
  const out = [
    `# ${r.title || 'ZAAFPulse governance evidence'}`,
    '',
    `Generated ${r.generatedAt} by ZAAFPulse ${r.version || ''}`.trim() + '.',
    '',
    `> ${r.notice || NOTICE}`,
    '',
    `Frameworks: ${arr(r.frameworks)
      .map((f) => `${f.name} (${f.version})`)
      .join('; ')}.`,
    '',
    '## Controls',
    '',
    STATUSES.map((s) => `${controls.filter((c) => c.status === s).length} ${s}`).join(' · '),
    '',
    table(
      ['Control', 'Status', 'Evidence', 'Clauses', 'Page'],
      controls.map((c) => [c.title, c.status, c.evidence.join('; '), c.clauses.map((x) => x.ref).join(', '), c.link]),
    ),
  ];
  // Each framework's clauses in their order, with the controls that show them.
  for (const f of arr(r.frameworks)) {
    const rows = [];
    for (const k of CLAUSES.filter((x) => x.framework === f.id))
      for (const c of controls)
        if (c.clauses.some((x) => x.framework === f.id && x.ref === k.ref))
          rows.push([`${k.ref} ${k.title}`, c.title, c.status]);
    out.push('', `## ${f.name} (${f.version})`, '', table(['Clause', 'Control', 'Status'], rows));
  }
  const a = r.audit || {};
  const writing = a.degraded
    ? `degraded since ${a.degraded.since}, ${a.degraded.missed} entries not written`
    : 'working';
  const gone = `${counts.gone || 0} reviews of items no longer seen`;
  out.push(
    '',
    '## Audit log',
    '',
    `- Kept: ${a.retentionMonths} months`,
    `- Last verify: ${verifyLine(a.lastVerify)}`,
    `- Writing: ${writing}`,
    '',
    '## AI inventory',
    '',
    `${counts.total || 0} items: ${counts.reviewed || 0} reviewed, ${counts.unreviewed || 0} unreviewed, ${gone}.`,
  );
  const failed = (r.inventory && r.inventory.failed) || [];
  if (failed.length) out.push('', `Sources that could not be read: ${failed.join(', ')}.`);
  const clients = (r.inventory && r.inventory.unreadableClients) || [];
  if (clients.length) out.push('', `AI client files that could not be read: ${clients.map(inline).join(', ')}.`);
  out.push(
    '',
    table(
      [
        'Item',
        'Kind',
        'Vendor',
        'Where',
        'State',
        'First seen',
        'Last seen',
        'Owner',
        'Purpose',
        'Risk',
        'Decision',
        'Note',
      ],
      items.map((i) => {
        const v = i.review || {};
        return [
          `${i.name} (${i.id})`,
          i.kind,
          i.vendor,
          (i.where || []).join(', '),
          i.state,
          i.firstSeen,
          i.lastSeen,
          v.owner,
          v.purpose,
          v.risk,
          v.decision,
          v.note,
        ];
      }),
    ),
    '',
  );
  return out.join('\n');
}

module.exports = { evidenceReport, toJson, toMarkdown, ITEM_FIELDS };
