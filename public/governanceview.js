'use strict';
/* Governance → Audit log (#governance, AI Governance 2): every change made to ZAAFPulse by a person or an API key,
   from GET /api/governance/audit (newest first, a page at a time). Filters: the range, the kind of actor, action text
   and the outcome. Each row's field changes open in a <details>. Verify checks the chain (GET …/audit/verify), the
   export links download CSV or JSON lines, and the retention is saved with POST /api/governance/settings. Events are
   delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here touches the
   DOM at load time. Every server or owner string reaches the markup through esc(). */

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
  filters: { range: '7', actor: '', action: '', outcome: '' },
  rows: [],
  next: null,
  hooked: false,
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
/** Who acted, in words: "Dashboard · password · 10.0.0.2", "API key key_ab12", "Monitors rule tool_loop" … */
function govActorLabel(a) {
  if (!a || typeof a !== 'object') return 'Unknown';
  if (a.via === 'dashboard')
    return ['Dashboard', a.mode, a.device ? `device ${a.device}` : '', a.ip].filter(Boolean).join(' · ');
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
    <label>${esc('Action')}<input class="input" name="action" maxlength="80" placeholder="config.change, keys…" value="${esc(f.action)}"></label>
    <label>${esc('Outcome')}${select('outcome', GOV_OUTCOMES)}</label>
    <button class="btn" type="submit">${esc('Apply')}</button>
  </form>`;
}

/* ---------- the page ---------- */

function govView() {
  return `<div class="holo-deck">${subHero('GOVERNANCE · AUDIT LOG', 'Audit log', esc('Changes made through the dashboard and by API keys: who, when, what and the outcome. Read requests are not recorded; see docs/governance.md for the full list.'))}<div id="gov-app">
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
function govMount() {
  govInstallEvents();
  govLoadStatus();
  govLoadRows();
}
function govInstallEvents() {
  if (GOV.hooked) return;
  GOV.hooked = true;
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form || !form.closest || !form.closest('#gov-app')) return;
    e.preventDefault();
    const data = new FormData(form);
    if (form.id === 'gov-filters') {
      GOV.filters = {
        range: String(data.get('range') || '7'),
        actor: String(data.get('actor') || ''),
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
  document.addEventListener('click', async (e) => {
    const t = e.target.closest && e.target.closest('#gov-app [data-gov-verify], #gov-app [data-gov-more]');
    if (!t) return;
    if (t.hasAttribute('data-gov-more')) return void govLoadRows(true);
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
  };
