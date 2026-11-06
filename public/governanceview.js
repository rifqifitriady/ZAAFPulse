'use strict';
/* The Governance menu's three pages (AI Governance 2 and 3).
   - Inventory (#governance): every AI system ZAAFPulse can see, from GET /api/governance/inventory, filtered by kind,
     state and review in the page; a drawer records an item's owner, purpose, risk and decision (POST
     /api/governance/inventory).
   - Compliance (#governance/compliance): the controls from GET /api/governance/controls, one table per framework, and
     the evidence export (GET /api/governance/evidence?format=md|json).
   - Audit log (#governance/audit): every change made to ZAAFPulse by a person or an API key, from GET
     /api/governance/audit (newest first, a page at a time). Filters: the range, the kind of actor, the account, action text
     and the outcome. Each row's field changes open in a <details>. Verify checks the chain (GET …/audit/verify), the export
     links download CSV or JSON lines, and the retention is saved with POST /api/governance/settings.
   Events are delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here
   touches the DOM at load time. Every server or owner string reaches the markup through esc(). */

const GOV_RANGES = [
  ['1', 'Last 24 hours'],
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['all', 'Everything kept'],
];
const GOV_ACTORS = [
  ['', 'Anyone'],
  ['dashboard', 'Dashboard'],
  ['apikey', 'API key'],
  ['cli', 'Command line'],
  ['system', 'ZAAFPulse'],
  ['rule', 'Monitors rule'],
];
const GOV_OUTCOMES = [
  ['', 'Any outcome'],
  ['ok', 'OK'],
  ['refused', 'Refused'],
  ['error', 'Error'],
];
const GOV = {
  filters: { range: '7', actor: '', user: '', action: '', outcome: '' },
  rows: [],
  next: null,
  hooked: false,
  inv: { filters: { kind: '', state: '', review: '' }, data: null, open: null },
};

/* ---------- pure helpers (exported) ---------- */

/** A failed api() call as one line: its 400 body's first error text, else the message as it is. */
function govErrorText(err) {
  const msg = String((err && err.message) || err || '');
  try {
    const body = JSON.parse(msg.replace(/^\d{3}\s+/, ''));
    const first = Array.isArray(body.errors) ? body.errors[0] : body.error;
    if (first) return String(first);
  } catch {
    /* not JSON: show it as it came */
  }
  return msg;
}
/** The ISO time a range starts at, or null for everything kept. */
function govFrom(range, now = Date.now()) {
  const days = Number(range);
  return Number.isFinite(days) && days > 0 ? new Date(now - days * 864e5).toISOString() : null;
}
/** The query of GET /api/governance/audit for the filters (and the page before a seq). */
function govQuery(f, { before = null, now = Date.now() } = {}) {
  const q = new URLSearchParams();
  const from = govFrom(f.range, now);
  if (from) q.set('from', from);
  if (f.actor) q.set('actor', f.actor);
  if (f.user) q.set('user', String(f.user).trim().toLowerCase().slice(0, 32));
  if (f.action) q.set('action', String(f.action).slice(0, 80));
  if (f.outcome) q.set('outcome', f.outcome);
  q.set('limit', '100');
  if (before) q.set('before', String(before));
  return q.toString();
}
/** The export link for the filters' range: format csv or jsonl. */
function govExportHref(f, format, now = Date.now()) {
  const q = new URLSearchParams();
  const from = govFrom(f.range, now);
  if (from) q.set('from', from);
  q.set('format', format);
  return `/api/governance/audit/export?${q}`;
}
/** "2026-11-03 14:05:09" in this browser's time zone. */
function govTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** Who acted, in words: "Dashboard · vera (viewer) · password · 10.0.0.2", "API key key_ab12", "Monitors rule
 * tool_loop" … */
function govActorLabel(a) {
  if (!a || typeof a !== 'object') return 'Unknown';
  if (a.via === 'dashboard')
    return [
      'Dashboard',
      a.user ? `${a.user}${a.role && a.role !== a.user ? ` (${a.role})` : ''}` : '',
      a.mode,
      a.device ? `device ${a.device}` : '',
      a.ip,
    ]
      .filter(Boolean)
      .join(' · ');
  if (a.via === 'apikey') return `API key ${a.keyId || ''}`.trim();
  if (a.via === 'rule') return `Monitors rule ${a.rule || ''}`.trim();
  if (a.via === 'cli') return 'Command line';
  if (a.via === 'system') return 'ZAAFPulse';
  return String(a.via || 'Unknown');
}
/** What was acted on: "gateway.keys ci (key_1)", or an em dash. */
function govTargetLabel(t) {
  if (!t || typeof t !== 'object') return '—';
  const name = t.name || '';
  const id = t.id && t.id !== t.name ? (name ? `(${t.id})` : t.id) : '';
  return [t.type, name, id].filter(Boolean).join(' ');
}
/** A change's value as text: absent is an empty set sign. */
const govValue = (v) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v));
/** The field changes of an entry in a <details>, or '' when it has none. */
function govChangesHtml(e) {
  const list = Array.isArray(e.changes) ? e.changes : [];
  if (!list.length) return '';
  const more = e.truncated > 0 ? `<li class="muted">${esc(`and ${e.truncated} more`)}</li>` : '';
  const n = list.length + (e.truncated > 0 ? e.truncated : 0);
  return `<details class="gov-changes"><summary>${esc(`${n} field${n === 1 ? '' : 's'} changed`)}</summary><ul>${list
    .map((c) => `<li><code>${esc(c.path)}</code>: ${esc(govValue(c.from))} → ${esc(govValue(c.to))}</li>`)
    .join('')}${more}</ul></details>`;
}
/** The outcome as a tag; a refusal or an error names its HTTP status. */
function govOutcomeHtml(e) {
  const word =
    e.outcome === 'ok'
      ? 'OK'
      : e.outcome === 'refused'
        ? 'Refused'
        : e.outcome === 'error'
          ? 'Error'
          : String(e.outcome || '');
  const status = e.status && e.outcome !== 'ok' ? ` ${e.status}` : '';
  return `<span class="tag${e.outcome === 'ok' ? '' : ' warn'}">${esc(word + status)}</span>`;
}
/** The table rows. */
function govRowsHtml(entries) {
  if (!entries.length) return `<tr><td colspan="5" class="muted">${esc('No entries for these filters.')}</td></tr>`;
  return entries
    .map(
      (e) =>
        `<tr><td class="mono">${esc(govTime(e.ts))}</td><td>${esc(govActorLabel(e.actor))}</td><td><b>${esc(e.action)}</b>${e.op ? ` <span class="muted">${esc(e.op)}</span>` : ''}${govChangesHtml(e)}</td><td>${esc(govTargetLabel(e.target))}</td><td>${govOutcomeHtml(e)}</td></tr>`,
    )
    .join('');
}
/** The verify result in words. */
function govVerifyText(v) {
  if (!v) return 'Not checked yet.';
  if (v.ok) {
    const base = v.checked ? `Chain intact: entries ${v.from}–${v.to} checked.` : 'Chain intact: no entries yet.';
    return v.unverified ? `${base} ${v.unverified} older entries were sealed with a key that is gone.` : base;
  }
  if (v.reason === 'key missing') return 'Cannot be checked: the audit key is missing.';
  return `Broken at entry ${v.brokenAt}: ${v.reason}.`;
}
/** The size of the kept months: "3 months · 1.2 MB". */
function govSize(st) {
  const n = (st.months || []).length;
  const b = st.bytes || 0;
  const size = b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  return `${n} month${n === 1 ? '' : 's'} · ${size}`;
}
/** The status panel: degraded banner, retention form, size, verify and the export links. The verify line is the
 * server's last result (st.lastVerify), which every verify updates: a Verify click and the daily one alike. */
function govStatusHtml(st, f) {
  const banner = st.degraded
    ? `<div class="gov-banner">${esc(`Degraded since ${govTime(st.degraded.since)}: ${st.degraded.missed} audit ${st.degraded.missed === 1 ? 'entry' : 'entries'} could not be written. Changes still go ahead.`)}</div>`
    : '';
  // A rekey in the chain always shows: whoever can write the files could seal one of their own.
  const v = st.lastVerify;
  const rekey =
    v && v.rekeyedAt != null
      ? `<div class="gov-banner">${esc(`The audit key was replaced at entry ${v.rekeyedAt} (${govTime(v.rekeyedTs)}). Entries before it are checked only when the old key can still be read.`)}</div>`
      : '';
  return `${banner}${rekey}<div class="gov-bar">
    <form id="gov-retention" class="gov-inline"><label>${esc('Keep months')}<input class="input" type="number" name="retentionMonths" min="6" max="120" step="1" value="${esc(st.retentionMonths)}"></label><button class="btn ghost" type="submit">${esc('Save')}</button></form>
    <span class="muted">${esc(govSize(st))}</span>
    <button class="btn ghost" type="button" data-gov-verify>${esc('Verify')}</button>
    <span class="muted" id="gov-verify">${esc(govVerifyText(st.lastVerify))}</span>
    <a class="btn ghost" href="${esc(govExportHref(f, 'csv'))}" download>${esc('Export CSV')}</a>
    <a class="btn ghost" href="${esc(govExportHref(f, 'jsonl'))}" download>${esc('Export JSONL')}</a>
    <p class="muted gov-note">${esc('A lowered retention takes effect at the next daily pass or restart, and never below 6 months.')}</p>
  </div>`;
}
/** The filter form. */
function govFiltersHtml(f) {
  const select = (name, list) =>
    `<select class="input" name="${name}">${list.map(([v, label]) => `<option value="${esc(v)}"${v === f[name] ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  return `<form id="gov-filters" class="gov-bar">
    <label>${esc('Range')}${select('range', GOV_RANGES)}</label>
    <label>${esc('Actor')}${select('actor', GOV_ACTORS)}</label>
    <label>${esc('User')}<input class="input" name="user" maxlength="32" placeholder="owner, an account…" value="${esc(f.user || '')}"></label>
    <label>${esc('Action')}<input class="input" name="action" maxlength="80" placeholder="config.change, keys…" value="${esc(f.action)}"></label>
    <label>${esc('Outcome')}${select('outcome', GOV_OUTCOMES)}</label>
    <button class="btn" type="submit">${esc('Apply')}</button>
  </form>`;
}

/* ---------- Inventory and Compliance (AI Governance 3): pure helpers (exported) ---------- */

const GOV_SUBS = [
  ['', 'Inventory'],
  ['compliance', 'Compliance'],
  ['audit', 'Audit log'],
];
const GOV_KINDS = [
  ['app', 'App'],
  ['mcp', 'MCP server'],
  ['provider', 'Provider'],
  ['model', 'Model'],
  ['agent', 'Agent'],
  ['skill', 'Skill'],
  ['workflow', 'Workflow'],
  ['knowledge', 'Knowledge base'],
  ['runtime', 'Local runtime'],
  ['integration', 'Integration'],
  ['key', 'API key'],
];
const GOV_STATES = [
  ['running', 'Running'],
  ['used', 'Used'],
  ['configured', 'Configured'],
  ['idle', 'Idle'],
  ['gone', 'Gone'],
];
const GOV_REVIEWS = [
  ['unreviewed', 'Unreviewed'],
  ['reviewed', 'Reviewed'],
  ['gone', 'Gone'],
];
const GOV_RISKS = [
  ['', '—'],
  ['minimal', 'Minimal'],
  ['limited', 'Limited'],
  ['high', 'High'],
  ['unacceptable', 'Unacceptable'],
];
const GOV_DECISIONS = [
  ['', '—'],
  ['approved', 'Approved'],
  ['restricted', 'Restricted'],
  ['blocked', 'Blocked'],
];
// The inventory's sources, in words, for "could not read …".
const GOV_SOURCES = {
  live: 'the running apps',
  summary: 'the indexed logs',
  trace: 'the trace sources',
  gateway: 'the gateway',
  runtimes: 'the local runtimes',
  integrations: 'the integrations',
  mcp: "the AI clients' MCP settings",
};
const GOV_STATUS_WORDS = { 'in place': 'In place', partial: 'Partial', off: 'Off', unknown: 'Unknown' };

/** The Governance sub-page of a hash: '' (Inventory), 'compliance' or 'audit'; anything else is ''. */
const govSub = (sub) => (GOV_SUBS.some(([s]) => s && s === sub) ? sub : '');
/** A value's label in one of the [value, label] lists; the value itself when it is not listed. */
const govLabel = (list, v) => (list.find(([k]) => k === v) || [v, String(v ?? '')])[1];
/** The items the filters keep: { kind, state, review } ('' keeps all). */
function govInvFilter(items, f) {
  return (Array.isArray(items) ? items : []).filter(
    (i) => (!f.kind || i.kind === f.kind) && (!f.state || i.state === f.state) && (!f.review || i.status === f.review),
  );
}
/** An item's review as a tag: Unreviewed, or its risk and decision (Gone in front when the item is no longer seen). */
function govReviewTag(i) {
  if (i.status === 'unreviewed') return `<span class="tag warn">${esc('Unreviewed')}</span>`;
  const r = i.review || {};
  const words = [r.risk ? govLabel(GOV_RISKS, r.risk) : '', r.decision ? govLabel(GOV_DECISIONS, r.decision) : '']
    .filter(Boolean)
    .join(' · ');
  const text = i.status === 'gone' ? ['Gone', words].filter(Boolean).join(' · ') : words || 'Reviewed';
  return `<span class="tag${i.status === 'gone' ? ' warn' : ''}">${esc(text)}</span>`;
}
/** The inventory's rows. */
function govInvRowsHtml(items) {
  if (!items.length) return `<tr><td colspan="7" class="muted">${esc('No items for these filters.')}</td></tr>`;
  return items
    .map((i) => {
      const detail = [i.vendor, i.package, i.origin, i.ours ? 'this ZAAFPulse' : ''].filter(Boolean).join(' · ');
      const owner = i.review && i.review.owner ? `<div class="muted">${esc(i.review.owner)}</div>` : '';
      // A source failed this build: the item is kept as it was last seen, not confirmed.
      const stale = i.stale ? `<div class="muted">${esc('not confirmed this build')}</div>` : '';
      return `<tr><td><b>${esc(i.name)}</b><div class="muted mono gov-id">${esc(i.id)}</div>${detail ? `<div class="muted">${esc(detail)}</div>` : ''}</td><td>${esc(govLabel(GOV_KINDS, i.kind))}</td><td>${esc((i.where || []).join(', ') || '—')}</td><td>${esc(govLabel(GOV_STATES, i.state))}</td><td class="mono">${esc(i.firstSeen || '—')}<br>${esc(i.lastSeen || '—')}</td><td>${govReviewTag(i)}${owner}${stale}</td><td><button class="btn ghost" type="button" data-gov-review="${esc(i.id)}">${esc(i.status === 'unreviewed' ? 'Review' : 'Edit')}</button></td></tr>`;
    })
    .join('');
}
/** The inventory's counts, the sources that failed and the client files that could not be read. */
function govInvSummaryHtml(d) {
  const c = d.counts || {};
  const parts = [
    `${c.total || 0} items`,
    `${c.reviewed || 0} reviewed`,
    `${c.unreviewed || 0} unreviewed`,
    `${c.newUnreviewed || 0} new this week and not reviewed`,
    ...(c.gone ? [`${c.gone} reviews of items no longer seen`] : []),
  ];
  const failed = (d.failed || []).map((s) => GOV_SOURCES[s] || s);
  const unreadable = (d.clients || []).filter((x) => x.state === 'unreadable');
  return `${failed.length ? `<div class="gov-banner">${esc(`Could not read ${failed.join(', ')}; the list is built from the rest.`)}</div>` : ''}${unreadable.length ? `<div class="gov-banner">${esc(`MCP settings that could not be read: ${unreadable.map((x) => `${x.name} (${x.file})`).join(', ')}.`)}</div>` : ''}<p class="gov-summary">${esc(parts.join(' · '))}</p>`;
}
/** The inventory's filters: kind, state and review. */
function govInvFiltersHtml(f) {
  const select = (name, any, list) =>
    `<select class="input" name="${name}"><option value="">${esc(any)}</option>${list.map(([v, label]) => `<option value="${esc(v)}"${v === f[name] ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  return `<form id="gov-inv-filters" class="gov-bar">
    <label>${esc('Kind')}${select('kind', 'Any kind', GOV_KINDS)}</label>
    <label>${esc('State')}${select('state', 'Any state', GOV_STATES)}</label>
    <label>${esc('Review')}${select('review', 'Any review', GOV_REVIEWS)}</label>
  </form>`;
}
/** The review drawer of one item: what is known of it, then owner, purpose, risk, decision and note. */
function govReviewFormHtml(i) {
  const r = i.review || {};
  const opt = (list, v) =>
    list
      .map(([k, label]) => `<option value="${esc(k)}"${k === (v || '') ? ' selected' : ''}>${esc(label)}</option>`)
      .join('');
  const facts = [
    ['Kind', govLabel(GOV_KINDS, i.kind)],
    ['Vendor', i.vendor],
    ['Where', (i.where || []).join(', ')],
    ['State', govLabel(GOV_STATES, i.state)],
    ['First seen', i.firstSeen],
    ['Last seen', i.lastSeen],
    ['Transport', i.transport],
    ['Command', i.command],
    ['Package', i.package],
    ['Address', i.origin],
    ['Clients', (i.clients || []).join(', ')],
    ['Projects', (i.projects || []).join(', ')],
    ['Reviewed', r.reviewedAt ? govTime(r.reviewedAt) : ''],
  ].filter(([, v]) => v);
  return `<div class="cost-drawer-backdrop" data-gov-close></div>
  <aside class="cost-drawer holo-deck" role="dialog" aria-modal="true" aria-labelledby="gov-review-title">
    <form id="gov-review" novalidate data-gov-id="${esc(i.id)}">
      <div class="cost-drawer-head"><h2 id="gov-review-title">${esc(i.name)}</h2><button type="button" class="btn ghost" data-gov-close aria-label="Close">×</button></div>
      <p class="muted mono">${esc(i.id)}</p>
      <dl class="gov-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <label>${esc('Owner')}<input class="input" name="owner" maxlength="200" value="${esc(r.owner || '')}" autocomplete="off"></label>
      <label>${esc('Purpose')}<input class="input" name="purpose" maxlength="200" value="${esc(r.purpose || '')}" autocomplete="off"></label>
      <div class="cost-row"><label>${esc('Risk (EU AI Act tier)')}<select class="input" name="risk">${opt(GOV_RISKS, r.risk)}</select></label><label>${esc('Decision')}<select class="input" name="decision">${opt(GOV_DECISIONS, r.decision)}</select></label></div>
      <label>${esc('Note')}<textarea class="input" name="note" maxlength="200" rows="3">${esc(r.note || '')}</textarea></label>
      <p class="muted">${esc('Notes are exported with the evidence; do not paste secrets.')}</p>
      <p class="muted">${esc('The decision is a record: blocking a system stays with API keys and the guardrails.')}</p>
      <div id="gov-review-msg" role="alert"></div>
      <div class="cost-drawer-foot"><button class="btn" type="submit">${esc('Save')}</button>${i.review ? `<button class="btn ghost" type="button" data-gov-clear>${esc('Clear review')}</button>` : ''}<button class="btn ghost" type="button" data-gov-close>${esc('Cancel')}</button></div>
    </form>
  </aside>`;
}
/** The body of POST /api/governance/inventory from the review form's fields. */
function govReviewBody(id, get) {
  const text = (k) => String(get(k) ?? '').trim();
  return {
    id,
    owner: text('owner'),
    purpose: text('purpose'),
    risk: text('risk'),
    decision: text('decision'),
    note: text('note'),
  };
}
/** A control's status as a tag. */
const govStatusTag = (s) =>
  `<span class="tag${s === 'in place' ? '' : ' warn'}">${esc(GOV_STATUS_WORDS[s] || s)}</span>`;
/** A control's page: a dashboard hash, else the Governance page. */
const govLink = (l) => (typeof l === 'string' && /^#[a-z0-9/-]+$/.test(l) ? l : '#governance');
/** The Compliance page's body: the counts, the export links, the notice, then one table per framework, its clauses in
 * order, each with the controls that show it. */
function govCompHtml(d) {
  const list = d.controls || [];
  const n = (s) => list.filter((c) => c.status === s).length;
  const head = `<div class="gov-bar"><span class="gov-summary">${esc(`${n('in place')} in place · ${n('partial')} partial · ${n('off')} off · ${n('unknown')} unknown`)}</span><a class="btn ghost" href="/api/governance/evidence?format=md" download>${esc('Export Markdown')}</a><a class="btn ghost" href="/api/governance/evidence?format=json" download>${esc('Export JSON')}</a><p class="muted gov-note">${esc(d.notice || '')}</p></div>`;
  const sections = (d.frameworks || []).map((f) => {
    const rows = [];
    for (const k of (d.clauses || []).filter((x) => x.framework === f.id))
      for (const c of list)
        if ((c.clauses || []).some((x) => x.id === k.id))
          rows.push(
            `<tr><td><b>${esc(k.ref)}</b> ${esc(k.title)}</td><td><a href="${esc(govLink(c.link))}">${esc(c.title)}</a></td><td>${govStatusTag(c.status)}</td><td>${esc((c.evidence || []).join(' · '))}</td></tr>`,
          );
    return `<section class="holo panel"><div class="panel-head"><h3>${esc(f.name)}</h3><span class="meta">${esc(f.version)}</span></div><div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Clause')}</th><th>${esc('Control')}</th><th>${esc('Status')}</th><th>${esc('Evidence')}</th></tr></thead><tbody>${rows.join('') || `<tr><td colspan="4" class="muted">${esc('No control maps here.')}</td></tr>`}</tbody></table></div></section>`;
  });
  return head + sections.join('');
}

/* ---------- the pages ---------- */

/** Governance → Audit log (#governance/audit). */
function govAuditView() {
  return `<div class="holo-deck">${subTabs('governance')}${subHero('GOVERNANCE · AUDIT LOG', 'Audit log', esc('Changes made through the dashboard and by API keys: who, when, what and the outcome. Read requests are not recorded; see docs/governance.md for the full list.'))}<div id="gov-app">
    <section class="holo panel"><div class="panel-head"><h3>${esc('Audit log')}</h3><span class="meta">${esc('kept by month, chained')}</span></div><div id="gov-status"><div class="skeleton" style="height:40px"></div></div>${govFiltersHtml(GOV.filters)}<div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Time')}</th><th>${esc('Actor')}</th><th>${esc('Action')}</th><th>${esc('Target')}</th><th>${esc('Outcome')}</th></tr></thead><tbody id="gov-rows"></tbody></table></div><div id="gov-more"></div></section>
  </div></div>`;
}
async function govLoadStatus() {
  const el = $('#gov-status');
  if (!el) return;
  try {
    el.innerHTML = govStatusHtml(await api('/api/governance/audit/status'), GOV.filters);
  } catch (e) {
    el.innerHTML = `<div class="gov-banner">${esc(`Could not read the audit log: ${e.message}`)}</div>`;
  }
}
// The first page for the filters, or the next one (more = true).
async function govLoadRows(more = false) {
  const body = $('#gov-rows');
  if (!body) return;
  try {
    const r = await api(`/api/governance/audit?${govQuery(GOV.filters, { before: more ? GOV.next : null })}`);
    GOV.rows = more ? [...GOV.rows, ...r.entries] : r.entries;
    GOV.next = r.next;
    body.innerHTML = govRowsHtml(GOV.rows);
    const m = $('#gov-more');
    if (m)
      m.innerHTML = `${r.next ? `<button class="btn ghost" type="button" data-gov-more>${esc('Older entries')}</button>` : ''}${r.skipped ? ` <span class="muted">${esc(`${r.skipped} unreadable line${r.skipped === 1 ? '' : 's'} skipped`)}</span>` : ''}`;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5">${esc(`Could not read the audit log: ${e.message}`)}</td></tr>`;
  }
}
/** Governance → Inventory (#governance). */
function govInvView() {
  return `<div class="holo-deck">${subTabs('governance')}${subHero('GOVERNANCE · INVENTORY', 'AI inventory', esc('Every AI system ZAAFPulse can see here: apps, the MCP servers in your AI clients, providers and models, agents, skills, workflows, knowledge bases, local runtimes, integrations and API keys. Record who owns each one, what it is for, its risk and your decision.'))}<div id="gov-app">
    <section class="holo panel"><div class="panel-head"><h3>${esc('Inventory')}</h3><span class="meta">${esc('built when you open it')}</span></div><div id="gov-inv-summary"><div class="skeleton" style="height:40px"></div></div>${govInvFiltersHtml(GOV.inv.filters)}<div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Item')}</th><th>${esc('Kind')}</th><th>${esc('Where')}</th><th>${esc('State')}</th><th>${esc('First / last seen')}</th><th>${esc('Review')}</th><th></th></tr></thead><tbody id="gov-inv-rows"></tbody></table></div></section>
    <div id="gov-review-host"></div>
  </div></div>`;
}
/** Governance → Compliance (#governance/compliance). */
function govCompView() {
  return `<div class="holo-deck">${subTabs('governance')}${subHero('GOVERNANCE · COMPLIANCE', 'Compliance', esc('Evidence for your assessment, not a certification: the controls ZAAFPulse provides, their status from your current settings, and the clauses of the EU AI Act, the NIST AI RMF and ISO/IEC 42001 they map to.'))}<div id="gov-app"><div id="gov-comp"><div class="skeleton" style="height:240px"></div></div></div></div>`;
}
/** The page of a Governance sub-page ('' Inventory, 'compliance', 'audit'). */
function govView(sub) {
  const s = govSub(sub);
  return s === 'audit' ? govAuditView() : s === 'compliance' ? govCompView() : govInvView();
}
async function govLoadInv() {
  const body = $('#gov-inv-rows');
  if (!body) return;
  try {
    GOV.inv.data = await api('/api/governance/inventory');
    govPaintInv();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7">${esc(`Could not read the inventory: ${e.message}`)}</td></tr>`;
  }
}
function govPaintInv() {
  const d = GOV.inv.data;
  if (!d) return;
  const sum = $('#gov-inv-summary');
  if (sum) sum.innerHTML = govInvSummaryHtml(d);
  const body = $('#gov-inv-rows');
  if (body) body.innerHTML = govInvRowsHtml(govInvFilter(d.items, GOV.inv.filters));
}
async function govLoadComp() {
  const el = $('#gov-comp');
  if (!el) return;
  try {
    el.innerHTML = govCompHtml(await api('/api/governance/controls'));
  } catch (e) {
    el.innerHTML = `<div class="gov-banner">${esc(`Could not read the controls: ${e.message}`)}</div>`;
  }
}
function govOpenReview(id) {
  const host = $('#gov-review-host');
  const item = GOV.inv.data && GOV.inv.data.items.find((i) => i.id === id);
  if (!host || !item) return;
  GOV.inv.open = id;
  host.innerHTML = govReviewFormHtml(item);
  const first = host.querySelector('input[name="owner"]');
  if (first) first.focus();
}
function govCloseReview() {
  GOV.inv.open = null;
  const host = $('#gov-review-host');
  if (host) host.replaceChildren();
}
async function govSaveReview(body) {
  try {
    await api('/api/governance/inventory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = $('#gov-review-msg');
    if (msg) msg.textContent = `Not saved: ${govErrorText(err)}`;
    return;
  }
  govCloseReview();
  govLoadInv();
}
function govMount(sub) {
  govInstallEvents();
  const s = govSub(sub);
  if (s === 'audit') {
    govLoadStatus();
    govLoadRows();
  } else if (s === 'compliance') govLoadComp();
  else govLoadInv();
}
function govInstallEvents() {
  if (GOV.hooked) return;
  GOV.hooked = true;
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form || !form.closest || !form.closest('#gov-app')) return;
    e.preventDefault();
    const data = new FormData(form);
    if (form.id === 'gov-review') {
      govSaveReview(govReviewBody(form.dataset.govId, (k) => data.get(k)));
    } else if (form.id === 'gov-filters') {
      GOV.filters = {
        range: String(data.get('range') || '7'),
        actor: String(data.get('actor') || ''),
        user: String(data.get('user') || '').trim(),
        action: String(data.get('action') || '').trim(),
        outcome: String(data.get('outcome') || ''),
      };
      govLoadStatus(); // the export links follow the range
      govLoadRows();
    } else if (form.id === 'gov-retention') {
      try {
        await api('/api/governance/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audit: { retentionMonths: Number(data.get('retentionMonths')) } }),
        });
      } catch (err) {
        alert(`Not saved: ${govErrorText(err)}`);
      }
      govLoadStatus();
      govLoadRows();
    }
  });
  // The inventory's filters apply as they change, on the list already loaded.
  document.addEventListener('change', (e) => {
    const form = e.target && e.target.closest && e.target.closest('#gov-inv-filters');
    if (!form) return;
    const data = new FormData(form);
    GOV.inv.filters = {
      kind: String(data.get('kind') || ''),
      state: String(data.get('state') || ''),
      review: String(data.get('review') || ''),
    };
    govPaintInv();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && GOV.inv.open) govCloseReview();
  });
  document.addEventListener('click', async (e) => {
    const t =
      e.target.closest &&
      e.target.closest(
        '#gov-app [data-gov-verify], #gov-app [data-gov-more], #gov-app [data-gov-review], #gov-app [data-gov-close], #gov-app [data-gov-clear]',
      );
    if (!t) return;
    if (t.hasAttribute('data-gov-more')) return void govLoadRows(true);
    if (t.hasAttribute('data-gov-review')) return void govOpenReview(t.getAttribute('data-gov-review'));
    if (t.hasAttribute('data-gov-close')) return void govCloseReview();
    if (t.hasAttribute('data-gov-clear')) return void govSaveReview({ id: GOV.inv.open, clear: true });
    const out = $('#gov-verify');
    if (out) out.textContent = 'Checking…';
    try {
      await api('/api/governance/audit/verify'); // the status read below shows its result
    } catch (err) {
      if (out) out.textContent = `Could not check: ${err.message}`;
      return;
    }
    govLoadStatus();
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    GOV,
    GOV_RANGES,
    GOV_ACTORS,
    govErrorText,
    govFrom,
    govQuery,
    govExportHref,
    govTime,
    govActorLabel,
    govTargetLabel,
    govChangesHtml,
    govOutcomeHtml,
    govRowsHtml,
    govVerifyText,
    govSize,
    govStatusHtml,
    govFiltersHtml,
    govView,
    govAuditView,
    GOV_SUBS,
    GOV_KINDS,
    govSub,
    govLabel,
    govInvFilter,
    govReviewTag,
    govInvRowsHtml,
    govInvSummaryHtml,
    govInvFiltersHtml,
    govReviewFormHtml,
    govReviewBody,
    govStatusTag,
    govLink,
    govCompHtml,
    govInvView,
    govCompView,
  };
