'use strict';
/* Cost Control → Reports (#cost/reports, sub-project 5): one cost center's month for a client, drawn from
   GET /api/cost/report: the totals in both measures, the spend by source, model, key and project, the daily spend, the
   center's budgets and the notes. The month, the center and the currency live in the URL. Print calls window.print()
   from a delegated click (the CSP allows no inline handler) and the print CSS keeps the report only; Export CSV
   downloads the report's tables, built here, as one CSV in sections. Loaded after costview.js, whose helpers it uses
   inside functions only; pure helpers are exported for Node tests, and nothing here touches the DOM at load time.
   Every server or owner string reaches the markup through esc(). */

const COST_REP_TABLES = [
  ['source', 'By source'],
  ['model', 'By model'],
  ['key', 'By key'],
  ['project', 'By project'],
];
const COST_REP_STATE = { exceeded: 'Used up', ok: 'Under its levels', no_data: 'No data' };
const COST_REP = { report: null, last: null, ctx: null, choice: null, hooked: false };

/* ---------- pure helpers (exported) ---------- */

/** The choice in the hash: month, center and currency; a value of the wrong shape is left out (the server decides). */
function costRepParse(query) {
  const q = new URLSearchParams(query || '');
  const out = {};
  const month = q.get('month');
  if (month && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) out.month = month;
  const center = q.get('center');
  if (center && /^[a-z0-9][a-z0-9-]{0,39}$/.test(center)) out.center = center;
  const cur = q.get('cur');
  if (cur && /^[A-Z]{3}$/.test(cur)) out.cur = cur;
  return out;
}
/** The hash that names a choice: All centers and USD are left out. */
function costRepHash(c) {
  const q = new URLSearchParams();
  if (c.month) q.set('month', c.month);
  if (c.center && c.center !== '__all') q.set('center', c.center);
  if (c.cur && c.cur !== 'USD') q.set('cur', c.cur);
  const s = q.toString();
  return `#cost/reports${s ? `?${s}` : ''}`;
}
/** The query of GET /api/cost/report for a choice. */
function costRepQuery(c) {
  const q = new URLSearchParams();
  if (c.month) q.set('month', c.month);
  if (c.center) q.set('center', c.center);
  if (c.cur && c.cur !== 'USD') q.set('currency', c.cur);
  return q.toString();
}
/** "October 2026" from YYYY-MM. */
const costRepMonthName = (m) => `${COST_MONTH_LONG[Number(String(m).slice(5, 7)) - 1] || ''} ${String(m).slice(0, 4)}`;
/** "Cost report · Client: Acme · October 2026" */
const costRepTitle = (r) => `Cost report · ${r.center.name} · ${costRepMonthName(r.month)}`;
/** "1–31 October 2026 · generated 29 Oct 2026, 14:05" (the generated time in this browser's time zone). */
function costRepPeriod(r) {
  const d = (x) => Number(String(x).slice(8));
  const at = Number.isFinite(r.generatedAt) ? new Date(r.generatedAt) : null;
  const when = at
    ? `${at.getDate()} ${COST_MONTH[at.getMonth()]} ${at.getFullYear()}, ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : '';
  const span = r.from === r.to ? `${d(r.from)}` : `${d(r.from)}–${d(r.to)}`;
  return `${span} ${costRepMonthName(r.month)}${when ? ` · generated ${when}` : ''}`;
}
/** A table row's name: Other with how many it holds, a plan fee, Unknown, a source's label, a key's name. */
function costRepName(table, x) {
  if (x.key === '__other') return `Other (${x.count})`;
  if (x.key === '__plan') return 'Plan fee';
  if (x.key === '__none') return 'Unknown';
  if (table === 'source') return COST_SOURCES[x.key] || x.key;
  if (table === 'key') return x.name || x.key;
  return String(x.key);
}
/** An amount in the chosen currency: `field` is list or billed. */
const costRepAmount = (x, field, ctx) => ctx.fmt(ctx.cur === 'USD' ? x[`${field}USD`] : x[field]);
/** A budget's state as the Budgets page names it, and whether it is projected over. */
function costRepState(b) {
  const s = String(b.state);
  const word = COST_REP_STATE[s] || (/^warn_\d+$/.test(s) ? `Past ${s.slice(5)} %` : s);
  return b.projected ? `${word}, projected over` : word;
}

function costRepTableHtml(r, table, title, ctx) {
  const rows = (r.tables && r.tables[table]) || [];
  const body = rows.length
    ? rows
        .map(
          (x) =>
            `<tr><td>${esc(costRepName(table, x))}</td><td class="num">${esc(costRepAmount(x, 'list', ctx))}</td><td class="num">${esc(costRepAmount(x, 'billed', ctx))}</td><td class="num">${esc((x.requests || 0).toLocaleString('en'))}</td><td class="num">${esc((x.tokens || 0).toLocaleString('en'))}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="5">${esc('Nothing in this month.')}</td></tr>`;
  return `<section class="cost-rep-section"><h3>${esc(title)}</h3><table class="cost-table cost-rep-table"><thead><tr><th>Name</th><th class="num">Usage value</th><th class="num">Paid</th><th class="num">Requests</th><th class="num">Tokens</th></tr></thead><tbody>${body}</tbody></table></section>`;
}
function costRepBudgetsHtml(r, ctx) {
  if (!Array.isArray(r.budgets)) {
    // budgets is null for a past month, when the list did not read (budgetsError), or when no budget service runs.
    const current = !Array.isArray(r.months) || r.month === r.months[0];
    const why = r.budgetsError
      ? 'Budgets could not be read.'
      : current
        ? 'Budgets are not available.'
        : 'Budget states are shown for the current month only.';
    return `<p class="cost-note">${esc(why)}</p>`;
  }
  if (!r.budgets.length) return `<p class="cost-note">${esc('No budget for this center.')}</p>`;
  const rows = r.budgets
    .map(
      (b) =>
        `<tr><td>${esc(b.name)}</td><td>${esc(costScopeLabel(b.scope, ctx))}</td><td>${esc(costPeriodLabel(b))}</td><td>${esc(costRepState(b))}</td><td class="num">${esc(b.percent == null ? '—' : `${b.percent} %`)}</td><td class="num">${esc(b.state === 'no_data' ? b.reason || 'No data' : `${costMoney(b.spent, b.currency)} of ${costMoney(b.amount, b.currency)}`)}</td></tr>`,
    )
    .join('');
  return `<table class="cost-table cost-rep-table"><thead><tr><th>Budget</th><th>Scope</th><th>Period</th><th>State</th><th class="num">Used</th><th class="num">Spent</th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** The notes: months that did not read, days whose billing was assumed, and the restates of the period. */
function costRepNotes(r) {
  const n = r.notes || {};
  const out = (n.unread || []).map(costUnreadText);
  if (n.billingError) out.push('What was paid: ' + n.billingError + '; billed as metered.');
  if ((n.assumed || []).length)
    out.push(
      `Billing was assumed as metered on ${n.assumed.length} day(s): ${n.assumed.map((d) => `${Number(d.slice(8))} ${COST_MONTH[Number(d.slice(5, 7)) - 1]}`).join(', ')}.`,
    );
  if (n.corrections === null) out.push('The restates could not be read.');
  for (const c of n.corrections || []) out.push(`Restated ${c.from} to ${c.to}: ${c.reason}`);
  return out;
}

/** The report page's control bar: month, center, currency, Print and Export CSV. Hidden when printed. */
function costRepControlsHtml(r, ctx) {
  const known = r.months || [r.month];
  // A month or center the page cannot place (a stale bookmark) shows a choice with an empty value: the default.
  const latest = known.includes(r.month) ? '' : '<option value="" selected>Latest</option>';
  const months = known
    .map((m) => `<option value="${esc(m)}" ${m === r.month ? 'selected' : ''}>${esc(costRepMonthName(m))}</option>`)
    .join('');
  const ids = [['__all', 'All centers'], ...Object.entries(ctx.centers || {}), ['unassigned', 'Unassigned']];
  const none = ids.some(([id]) => id === r.center.id) ? '' : '<option value="" selected>Choose a center</option>';
  const centers = ids
    .map(([id, name]) => `<option value="${esc(id)}" ${id === r.center.id ? 'selected' : ''}>${esc(name)}</option>`)
    .join('');
  const cur =
    ctx.currencies.length > 1
      ? `<div class="segmented" role="group" aria-label="Currency">${ctx.currencies
          .map(
            (x) =>
              `<button type="button" data-cost-rep-cur="${esc(x)}" aria-pressed="${x === ctx.cur}">${esc(x)}</button>`,
          )
          .join('')}</div>`
      : '';
  return `<div class="cost-bar cost-rep-controls cost-noprint"><label>Month <select class="input" data-cost-rep-month>${latest}${months}</select></label><label>Center <select class="input" data-cost-rep-center>${none}${centers}</select></label>${cur}<span class="cost-spacer"></span><button type="button" class="btn ghost" data-cost-rep-print>Print</button><button type="button" class="btn" data-cost-rep-csv>Export CSV</button></div>`;
}

/** The report itself: what prints. */
function costRepHtml(r, ctx) {
  const t = r.totals || {};
  const tok = t.tokens || {};
  const tokens = (tok.input || 0) + (tok.output || 0) + (tok.cacheRead || 0) + (tok.cacheWrite || 0);
  const tiles = [
    metricTile({ label: 'Usage value', value: esc(costRepAmount(t, 'list', ctx)), sub: 'at list prices' }),
    metricTile({ label: 'Paid', value: esc(costRepAmount(t, 'billed', ctx)), sub: 'plan fees and metered use' }),
    metricTile({ label: 'Requests', value: esc((t.requests || 0).toLocaleString('en')), sub: '' }),
    metricTile({
      label: 'Tokens',
      value: esc(tokens.toLocaleString('en')),
      sub: esc(`${(tok.input || 0).toLocaleString('en')} in · ${(tok.output || 0).toLocaleString('en')} out`),
    }),
  ].join('');
  const tables = COST_REP_TABLES.map(([k, title]) => costRepTableHtml(r, k, title, ctx)).join('');
  const field = ctx.cur === 'USD' ? 'listUSD' : 'list';
  const days = (r.daily || []).map((d) => ({
    day: d.day,
    spend: d[field],
    baseline: null,
    spike: false,
    topModel: null,
  }));
  const notes = costRepNotes(r);
  return `<article class="cost-report" aria-label="${esc(costRepTitle(r))}">
    <header class="cost-rep-head"><h2>${esc(costRepTitle(r))}</h2><p>${esc(costRepPeriod(r))}</p></header>
    <div class="grid kpis cost-rep-tiles">${tiles}</div>
    <div class="cost-rep-tables">${tables}</div>
    <section class="cost-rep-section"><h3>Daily spend</h3>${costSpikeSvg(days, ctx.fmt)}</section>
    <section class="cost-rep-section"><h3>Budgets</h3>${costRepBudgetsHtml(r, ctx)}</section>
    ${notes.length ? `<section class="cost-rep-section"><h3>Notes</h3>${notes.map((x) => `<p class="cost-note">${esc(x)}</p>`).join('')}</section>` : ''}
  </article>`;
}

// A CSV cell as the server's export writes one (lib/cost/export.js): text that a spreadsheet would run as a formula
// gets a leading ', a cell with a comma, quote or line end is quoted, amounts have 8 decimals.
function costRepCsvCell(v, amount = false) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? (amount ? v.toFixed(8) : String(v)) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** The report's tables as one CSV in sections: a title line, then each table with its header row, a blank line
 *  between. Amounts in USD, and in the chosen currency too when it is not USD. */
function costRepCsv(r, ctx) {
  const cur = ctx.cur && ctx.cur !== 'USD' ? ctx.cur : null;
  const line = (cells) => cells.join(',') + '\r\n';
  const money = (x) => [
    costRepCsvCell(x.listUSD, true),
    costRepCsvCell(x.billedUSD, true),
    ...(cur ? [costRepCsvCell(x.list, true), costRepCsvCell(x.billed, true)] : []),
  ];
  const heads = ['Usage value (USD)', 'Paid (USD)', ...(cur ? [`Usage value (${cur})`, `Paid (${cur})`] : [])];
  let out = line([costRepCsvCell(costRepTitle(r))]) + line([costRepCsvCell(costRepPeriod(r))]);
  for (const [k, title] of COST_REP_TABLES) {
    out += '\r\n' + line([costRepCsvCell(title)]) + line(['Name', ...heads, 'Requests', 'Tokens']);
    for (const x of (r.tables && r.tables[k]) || [])
      out += line([
        costRepCsvCell(costRepName(k, x)),
        ...money(x),
        costRepCsvCell(x.requests),
        costRepCsvCell(x.tokens),
      ]);
  }
  out += '\r\n' + line(['Daily spend']) + line(['Day', ...heads]);
  for (const d of r.daily || []) out += line([d.day, ...money(d)]);
  const unread = (r.notes && r.notes.unread) || [];
  if (unread.length) out += `# unread: ${unread.join(', ')}\r\n`;
  return out;
}
/** "zaafpulse-report-client-acme-2026-10.csv": a center id and a month, so the name needs no escaping. */
const costRepCsvName = (r) =>
  `zaafpulse-report-${r.center.id === '__all' ? 'all_centers' : r.center.id}-${r.month}.csv`;

/* ---------- the page ---------- */

// A report is a document: it loads when the page opens or a control changes, never on the quiet refresh cycle.
async function costMountReports() {
  costRepInstallEvents();
  const body = $('#cost-body');
  if (!body) return;
  const my = ++COST.req;
  const live = () => my === COST.req && body.isConnected && costSub() === 'reports';
  try {
    const [settings, status] = await Promise.all([
      costGet('/api/cost/settings'),
      costGet('/api/cost/status').catch(() => null),
    ]);
    if (!live()) return;
    COST.settings = settings;
    const base = costContext(settings);
    const c = costRepParse(costQueryOfHash());
    // The hash names the currency, else the cost controls' stored choice (as the other pages), else USD.
    const cur = costParseControls(
      new URLSearchParams(c.cur ? { cur: c.cur } : {}).toString(),
      costStoreGet(),
      base.currencies,
    ).cur;
    const ctx = { ...base, cur, fmt: (v) => costMoney(v, cur) };
    COST_REP.choice = { month: c.month, center: c.center || '__all', cur };
    COST_REP.ctx = ctx;
    COST_REP.report = null;
    $('#cost-ribbon').innerHTML = costRibbonHtml(status);
    let r;
    try {
      r = await costGet(`/api/cost/report?${costRepQuery({ ...c, cur })}`);
    } catch (e) {
      if (!live()) return;
      // A stale bookmark (a deleted center, an old month) keeps its controls, so the choice can change here.
      const old = COST_REP.last;
      const stub = { month: c.month, months: old ? old.months : [], center: { id: c.center || '__all' } };
      $('#cost-bar').innerHTML = costRepControlsHtml(stub, ctx);
      // The stub shows "Latest" / "Choose a center" for what it cannot place: do not resend those stale values.
      if (!stub.months.includes(stub.month)) COST_REP.choice.month = undefined;
      const known = ['__all', 'unassigned', ...Object.keys(ctx.centers || {})];
      if (!known.includes(stub.center.id)) COST_REP.choice.center = '__all';
      return costShowError(body, e.message, false);
    }
    if (!live()) return;
    COST_REP.report = COST_REP.last = r;
    $('#cost-bar').innerHTML = costRepControlsHtml(r, ctx);
    body.innerHTML = costRepHtml(r, ctx);
  } catch (e) {
    if (!live()) return;
    costShowError(body, e.message, false);
  }
}

// The CSV through a Blob link; nothing is kept in the page.
function costRepDownload() {
  const r = COST_REP.report;
  if (!r) return;
  const url = URL.createObjectURL(new Blob([costRepCsv(r, COST_REP.ctx)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = costRepCsvName(r);
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// A changed control names the new choice in the hash; the router mounts the page again.
function costRepGo(next) {
  // The currency is also the cost pages' stored choice, so a fallback to it cannot undo this one.
  if (next.cur) {
    let o = {};
    try {
      const v = JSON.parse(costStoreGet());
      if (v && typeof v === 'object' && !Array.isArray(v)) o = v;
    } catch {
      /* a broken stored value: start again */
    }
    costStoreSet({ ...o, cur: next.cur });
  }
  const r = COST_REP.report;
  const k = COST_REP.choice || {};
  const c = {
    month: r ? r.month : k.month,
    center: r ? r.center.id : k.center || '__all',
    cur: COST_REP.ctx ? COST_REP.ctx.cur : 'USD',
  };
  location.hash = costRepHash({ ...c, ...next });
}
function costRepInstallEvents() {
  if (COST_REP.hooked) return;
  COST_REP.hooked = true;
  document.addEventListener('click', (e) => {
    const t =
      e.target.closest &&
      e.target.closest('#cost-app [data-cost-rep-print], #cost-app [data-cost-rep-csv], #cost-app [data-cost-rep-cur]');
    if (!t) return;
    if (t.hasAttribute('data-cost-rep-print')) return void window.print();
    if (t.hasAttribute('data-cost-rep-csv')) return void costRepDownload();
    costRepGo({ cur: t.dataset.costRepCur });
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#cost-app')) return;
    if (t.hasAttribute('data-cost-rep-month')) costRepGo({ month: t.value });
    else if (t.hasAttribute('data-cost-rep-center')) costRepGo({ center: t.value });
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_REP,
    COST_REP_TABLES,
    costRepParse,
    costRepHash,
    costRepQuery,
    costRepMonthName,
    costRepTitle,
    costRepPeriod,
    costRepName,
    costRepState,
    costRepNotes,
    costRepTableHtml,
    costRepBudgetsHtml,
    costRepControlsHtml,
    costRepHtml,
    costRepCsvCell,
    costRepCsv,
    costRepCsvName,
    costMountReports,
    costRepGo,
  };
