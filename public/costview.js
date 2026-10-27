'use strict';
/* Cost Control (sub-project 3a): the menu's pages. Overview (#cost), Breakdown (#cost/breakdown) and Value
   (#cost/value) draw GET /api/cost/view with the charts of public/costcharts.js; Budgets (#cost/budgets) lists
   GET /api/cost/budgets as cards and edits them in a drawer form. One control bar (range, currency, measure) lives in
   the URL and in localStorage (zp.cost.controls). Pure helpers at the top are exported for Node tests; nothing here
   touches the DOM at load time. Every server or owner string reaches the markup through esc(). */

const COST_SUBS = [
  ['', 'Overview'],
  ['breakdown', 'Breakdown'],
  ['value', 'Value'],
];
const COST_RANGES = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  lastmonth: 'Last month',
  custom: 'Custom',
};
const COST_MEASURES = { list: 'Usage value', billed: 'Paid' };
const COST_STORE_KEY = 'zp.cost.controls';
const COST_MAX_DAYS = 400; // the API's range limit (lib/cost/api.js MAX_DAYS)
const COST_DEFAULT = Object.freeze({ range: '30d', from: null, to: null, cur: 'USD', measure: 'list' });
const COST_SOURCES = {
  claude: 'Claude Code',
  codex: 'Codex',
  gateway: 'Gateway',
  judge: 'Judge',
  replay: 'Replay',
  collab: 'Collaboration',
};
const COST_DIMS = ['day', 'source', 'provider', 'model', 'project', 'center', 'keyId', 'agent', 'kind'];
const COST_DIM_LABEL = {
  day: 'Day',
  source: 'Source',
  provider: 'Provider',
  model: 'Model',
  project: 'Project',
  center: 'Cost center',
  keyId: 'Key',
  agent: 'Agent',
  kind: 'Kind',
};
const COST_MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const COST_REFRESH_MS = 60000;

/* ---------- pure helpers (exported) ---------- */

const costPad = (n) => String(n).padStart(2, '0');
const costDayOf = (d) => `${d.getFullYear()}-${costPad(d.getMonth() + 1)}-${costPad(d.getDate())}`;
const costToday = (now = Date.now()) => costDayOf(new Date(now));
function costIsDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}
// Calendar arithmetic at local noon, as lib/cost/days.js does.
function costAddDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return costDayOf(new Date(y, m - 1, d + n, 12));
}

/** The controls from the hash's query, else the stored last choice; each invalid value falls back to its default. */
function costParseControls(query, stored, currencies = ['USD']) {
  const q = new URLSearchParams(query || '');
  const named = ['range', 'from', 'to', 'cur', 'measure'].some((k) => q.has(k));
  let src = q;
  if (!named && stored) {
    try {
      const o = JSON.parse(stored);
      if (o && typeof o === 'object' && !Array.isArray(o))
        src = new URLSearchParams(Object.entries(o).filter(([, v]) => typeof v === 'string'));
    } catch {
      /* a broken stored value: the defaults */
    }
  }
  const out = { ...COST_DEFAULT };
  const range = src.get('range');
  if (range && Object.hasOwn(COST_RANGES, range)) out.range = range;
  if (out.range === 'custom') {
    const from = src.get('from');
    const to = src.get('to');
    if (costIsDay(from) && costIsDay(to) && from <= to && costAddDays(from, COST_MAX_DAYS) > to) {
      out.from = from;
      out.to = to;
    } else out.range = COST_DEFAULT.range;
  }
  const cur = src.get('cur');
  if (cur && currencies.includes(cur)) out.cur = cur;
  const measure = src.get('measure');
  if (measure && Object.hasOwn(COST_MEASURES, measure)) out.measure = measure;
  return out;
}

/** The days a range covers, ending today (local time). */
function costRangeDays(c, today) {
  if (c.range === 'custom' && c.from && c.to) return { from: c.from, to: c.to };
  if (c.range === '7d') return { from: costAddDays(today, -6), to: today };
  if (c.range === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (c.range === 'lastmonth') {
    const last = costAddDays(`${today.slice(0, 8)}01`, -1);
    return { from: `${last.slice(0, 8)}01`, to: last };
  }
  return { from: costAddDays(today, -29), to: today };
}

/** The query that names the controls: defaults left out, except the range. */
function costControlsQuery(c) {
  const q = new URLSearchParams({ range: c.range });
  if (c.range === 'custom') {
    q.set('from', c.from);
    q.set('to', c.to);
  }
  if (c.cur && c.cur !== 'USD') q.set('cur', c.cur);
  if (c.measure && c.measure !== 'list') q.set('measure', c.measure);
  return q.toString();
}
const costHash = (sub, c) => `#cost${sub ? `/${sub}` : ''}?${costControlsQuery(c)}`;

// localStorage may be off (private mode, blocked site data): the page works without it.
function costStoreGet() {
  try {
    return localStorage.getItem(COST_STORE_KEY);
  } catch {
    return null;
  }
}
function costStoreSet(c) {
  try {
    localStorage.setItem(COST_STORE_KEY, JSON.stringify(c));
  } catch {
    /* not kept */
  }
}

/** Money in the chosen currency: USD to the cent (small amounts to two significant digits), others in whole units. */
function costMoney(v, cur = 'USD') {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  const small = a > 0 && a < (cur === 'USD' ? 0.1 : 1); // a per-request cost: two significant digits
  const body =
    a >= 1e6
      ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(a)
      : small
        ? a.toLocaleString('en', { maximumSignificantDigits: 2 })
        : cur === 'USD'
          ? a.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : Math.round(a).toLocaleString('en');
  return cur === 'USD' ? `${sign}$${body}` : `${sign}${cur} ${body}`;
}
const costPct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);

/** The ledger status ribbon: what /api/cost/status reports as a problem, in the server's path-free words. */
function costRibbonItems(st) {
  if (!st || typeof st !== 'object') return [];
  const out = [];
  if (st.settings && st.settings.error) out.push(String(st.settings.error));
  if (st.ledger && st.ledger.error) out.push(String(st.ledger.error));
  for (const u of (st.ledger && st.ledger.unread) || []) out.push(costUnreadText(u));
  // Plain text, escaped where it is drawn.
  if (st.billing && st.billing.error) out.push('The billing history: ' + st.billing.error);
  if (st.billing && st.billing.historyLost)
    out.push('The billing history was lost: past days are billed as metered until restated.');
  for (const p of (st.prices && st.prices.problems) || []) out.push(`Prices: ${p}`);
  return out;
}
/** "October could not be read: figures leave it out", for a month, the folder or the corrections. */
function costUnreadText(u) {
  if (u === 'folder') return 'The ledger folder could not be read: figures leave it out.';
  if (u === 'corrections') return 'The restate corrections could not be read: figures leave them out.';
  const m = /^(\d{4})-(\d{2})$/.exec(String(u));
  return m
    ? `${COST_MONTH_LONG[Number(m[2]) - 1] || m[0]} ${m[1]} could not be read: figures leave it out.`
    : `${String(u)} could not be read: figures leave it out.`;
}

/* ---------- the page ---------- */

const COST = {
  req: 0, // a newer load wins; an older answer is dropped
  settings: null,
  controls: { ...COST_DEFAULT },
  view: null,
  stage: null, // the treemap's isoStage, destroyed before a repaint
  ctx: null, // the page's context (currency, measure, names), set with `controls` by each page load
  table: { groupBy: ['model'], sort: { key: 'spend', dir: -1 }, filter: null, data: null },
  tableReq: 0, // as `req`, for the table's own ledger requests
  hooked: false,
};

const costSub = () => (typeof state !== 'undefined' && state.sub) || '';
const costQueryOfHash = () => {
  const h = location.hash;
  const i = h.indexOf('?');
  return i < 0 ? '' : h.slice(i + 1);
};
// Currencies the page can show: USD, and the display currency once it has a rate.
function costContext(settings) {
  const s = (settings && settings.settings) || {};
  const cur = s.currency && Array.isArray(s.currency.rates) && s.currency.rates.length ? s.currency.code : null;
  const centers = Object.fromEntries((s.centers || []).map((c) => [c.id, c.name]));
  const keys = Object.fromEntries(((settings && settings.keys) || []).map((k) => [k.id, k.name || k.id]));
  return {
    display: cur,
    currencies: cur ? ['USD', cur] : ['USD'],
    centers,
    keys,
    sources: (settings && settings.sources) || Object.keys(COST_SOURCES),
  };
}
// A flow node or table cell as people read it.
function costName(col, key, ctx) {
  if (key === '__other') return 'Other';
  if (key === '__plan') return 'Plan fee';
  if (key === '__none' || key == null || key === '') return 'Unknown';
  if (col === 'source') return COST_SOURCES[key] || key;
  if (col === 'center') return ctx.centers[key] || (key === 'unassigned' ? 'Unassigned' : key);
  if (col === 'keyId') return ctx.keys[key] || key;
  return String(key);
}

async function costCall(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) {
    location.href = '/login.html'; // server mode: the session ended
    throw new Error('signed out');
  }
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* not JSON */
  }
  return { status: r.status, json };
}
async function costGet(path) {
  const r = await costCall(path);
  if (r.status !== 200) throw new Error((r.json && r.json.error) || `request failed (${r.status})`);
  return r.json;
}
// Numbers count up on an animated load (render(true)), at once with reduced motion or on a quiet refresh.
function costCountUp(root, fmt) {
  for (const el of root.querySelectorAll('[data-cost-count]')) {
    const to = Number(el.dataset.costCount);
    if (reduceMotion.matches || !to) continue;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / 900);
      el.textContent = fmt(to * (1 - (1 - p) ** 3));
      if (p < 1 && el.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Frames stop in a hidden tab: the number still ends at its value.
    setTimeout(() => (el.textContent = fmt(to)), 1000);
  }
}
const costCount = (v, fmt) => `<span data-cost-count="${Number(v) || 0}">${esc(fmt(v))}</span>`;

function viewCost() {
  const sub = costSub();
  const copy = {
    '': 'This month so far, where it is heading, and the budgets it meets.',
    breakdown: 'Where the money goes: sources, providers, models, cost centers and projects.',
    value: 'What the money bought: plans against their fees, savings, and cost against quality.',
  }[sub];
  const title = (COST_SUBS.find(([s]) => s === sub) || COST_SUBS[0])[1];
  return `<div class="holo-deck cost-deck" id="cost-app">
    ${subTabs('cost')}
    ${subHero(`AI OBSERVABILITY · COST CONTROL`, esc(title), esc(copy || ''))}
    <div id="cost-ribbon"></div>
    <div id="cost-bar"></div>
    <div id="cost-body"><div class="skeleton" style="height:240px"></div></div></div>`;
}

function mountCost() {
  costInstallEvents();
  // The page refreshes itself (app.js leaves it out of the 60-second render).
  const timer = setInterval(() => costRefresh(true), COST_REFRESH_MS);
  onUnmount(() => {
    clearInterval(timer);
    costUnmount();
  });
  costRefresh(false);
}
// Leaving the page: answers still in flight are dropped.
function costUnmount() {
  COST.req++;
  COST.tableReq++;
  COST.stage = null; // unmountStages() destroys it
}

// A quiet refresh waits while the tab is hidden or the owner is in a form field of the page (a clicked button keeps
// the focus and does not count).
function costQuietWait(doc, app) {
  if (doc.hidden) return true;
  const f = doc.activeElement;
  return !!f && app.contains(f) && typeof f.matches === 'function' && f.matches('input, select, textarea');
}
function costRefresh(quiet) {
  const app = $('#cost-app');
  if (!app) return;
  if (quiet && costQuietWait(document, app)) return;
  return costMountPage(costSub(), quiet);
}

function costBarHtml(sub, c, ctx) {
  const seg = (attr, items, on, label) =>
    `<div class="segmented" role="group" aria-label="${label}">${items
      .map(([v, text]) => `<button type="button" ${attr}="${esc(v)}" aria-pressed="${v === on}">${esc(text)}</button>`)
      .join('')}</div>`;
  const today = costToday();
  const days = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const range =
    sub === ''
      ? `<span class="cost-month">This month · day ${Number(today.slice(8))} of ${days}</span>`
      : seg('data-cost-range', Object.entries(COST_RANGES), c.range, 'Range') +
        (c.range === 'custom'
          ? `<span class="cost-dates"><input class="input" type="date" data-cost-date="from" value="${esc(c.from)}" aria-label="From"> – <input class="input" type="date" data-cost-date="to" value="${esc(c.to)}" aria-label="To"></span>`
          : '');
  const cur =
    ctx.currencies.length > 1 ? seg('data-cost-cur', ctx.currencies.map((x) => [x, x]), c.cur, 'Currency') : '';
  const measure = sub === 'value' ? '' : seg('data-cost-measure', Object.entries(COST_MEASURES), c.measure, 'Measure');
  return `<div class="cost-bar">${range}<span class="cost-spacer"></span>${cur}${measure}</div>`;
}

function costRibbonHtml(st) {
  const items = costRibbonItems(st);
  return items.length
    ? `<div class="cost-ribbon" role="status">${items.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
    : '';
}
// What a view answer leaves out or estimates: unread months, days without a rate, billing that did not read.
function costNotesHtml(v) {
  const notes = [...(v.unread || []).map(costUnreadText)];
  if (v.missingRate && v.missingRate.length)
    notes.push(v.missingRate.length + ' day(s) had no ' + v.currency + ' rate and are counted in USD.');
  if (v.billing && v.billing.error) notes.push('What was paid: ' + v.billing.error + '; billed as metered.');
  if (v.billing && v.billing.historyLost)
    notes.push('Part of the billing history was lost: those days are billed as metered.');
  return notes.length
    ? `<div class="cost-notes">${notes.map((n) => `<p class="cost-note">${esc(n)}</p>`).join('')}</div>`
    : '';
}
const costErrorHtml = (msg) =>
  `<section class="holo panel cost-error" role="alert"><p>Could not load this page: ${esc(msg)}</p><button type="button" class="btn" data-cost-retry>Retry</button></section>`;

async function costMountPage(sub, quiet) {
  const body = $('#cost-body');
  if (!body) return;
  const my = ++COST.req;
  const live = () => my === COST.req && body.isConnected;
  try {
    const [settings, status] = await Promise.all([
      costGet('/api/cost/settings'),
      costGet('/api/cost/status').catch(() => null),
    ]);
    if (!live()) return;
    COST.settings = settings;
    const base = costContext(settings);
    const c = costParseControls(costQueryOfHash(), costStoreGet(), base.currencies);
    COST.controls = c;
    costStoreSet(c);
    const ctx = { ...base, cur: c.cur, measure: c.measure, fmt: (v) => costMoney(v, c.cur) };
    COST.ctx = ctx; // with COST.controls: the table's query and its labels always come from the same load
    $('#cost-bar').innerHTML = costBarHtml(sub, c, ctx);
    $('#cost-ribbon').innerHTML = costRibbonHtml(status);
    const page = sub || 'overview';
    const q = new URLSearchParams({ page, measure: c.measure });
    if (page !== 'overview') {
      const r = costRangeDays(c, costToday());
      q.set('from', r.from);
      q.set('to', r.to);
    }
    if (c.cur !== 'USD') q.set('currency', c.cur);
    const v = await costGet(`/api/cost/view?${q}`);
    if (!live()) return;
    COST.view = v;
    if (COST.stage) COST.stage.destroy();
    COST.stage = null;
    const view = $('#view');
    const animated = !quiet && view.classList.contains('animate');
    // A quiet refresh keeps the table on screen until its new answer comes: no skeleton, no jump in height.
    const kept = quiet && $('#cost-table') ? $('#cost-table').innerHTML : '';
    const html =
      page === 'overview'
        ? costOverviewHtml(v, ctx)
        : page === 'breakdown'
          ? costBreakdownHtml(v, ctx)
          : costValueHtml(v, ctx);
    body.innerHTML = costNotesHtml(v) + html;
    if (page === 'breakdown') {
      const canvas = $('#cost-treemap');
      if (canvas && v.treemap.length)
        COST.stage = costMountTreemap(canvas, costTreemapLayout(v.treemap), {
          fmt: ctx.fmt,
          label: (col, key) => costName(col, key, ctx),
          grow: animated,
        });
      if (kept && $('#cost-table')) $('#cost-table').innerHTML = kept;
      costLoadTable(live);
    }
    if (animated) {
      costCountUp(body, ctx.fmt);
      // The entrance plays from this paint, not from the route change before the answer came.
      if (typeof settle === 'function') settle(view);
    }
  } catch (e) {
    if (!live()) return;
    body.innerHTML = costErrorHtml(e.message);
  }
}

/* ---------- Overview ---------- */

function costOverviewHtml(o, ctx) {
  const fmt = ctx.fmt;
  const paid = ctx.measure === 'billed';
  const center = o.topCenter;
  // The budgets did not read: say so where they would be drawn, never "no budgets".
  const why = String(o.budgetsError || '');
  const noBudgets = why ? `<p class="cost-note warn">${esc(why.charAt(0).toUpperCase() + why.slice(1) + '.')}</p>` : '';
  const forecastSub = o.forecast.early
    ? 'early in the month: no band yet'
    : `${fmt(o.forecast.low)} – ${fmt(o.forecast.high)}`;
  const risk = o.budgetsError
    ? metricTile({ label: 'Budgets at risk', value: '—', sub: 'budgets could not be read', color: COST_C.muted })
    : metricTile({
        label: 'Budgets at risk',
        value: `${o.atRisk.count} of ${o.atRisk.total}`,
        sub: o.atRisk.total ? 'used up, projected over or past a level' : 'no budgets yet',
        color: o.atRisk.count ? COST_C.pink : COST_C.cyan,
        p: o.atRisk.total ? o.atRisk.count / o.atRisk.total : null,
      });
  const tiles = [
    metricTile({
      label: paid ? 'This month · paid' : 'This month · usage value',
      value: costCount(o.total, fmt),
      sub: esc(paid ? `Usage value ${fmt(o.spent.list)}` : `Paid ${fmt(o.spent.billed)}`),
      spark: o.daily.map((d) => d.spend),
      color: COST_C.cyan,
    }),
    metricTile({
      label: 'Forecast · month end',
      value: costCount(o.forecast.projected, fmt),
      sub: esc(forecastSub),
      color: COST_C.violet,
    }),
    `<a class="cost-tile-link" href="#cost/budgets">${risk}</a>`,
    metricTile({
      label: 'Top cost center',
      value: center ? esc(costName('center', center.center, ctx)) : '—',
      sub: center ? esc(`${costPct(center.share)} · ${fmt(center.spend)}`) : 'nothing spent yet',
      color: COST_C.orange,
      p: center ? center.share : null,
    }),
  ];
  const add =
    o.budgetsError || o.budgetLines.length
      ? ''
      : '<p class="cost-note"><a href="#cost/budgets">Add a monthly budget</a> to see it against the forecast.</p>';
  const rings =
    noBudgets ||
    costRingsHtml(o.rings, o.moreBudgets) ||
    holoEmpty('No budgets yet. <a href="#cost/budgets">Add one</a>.');
  const burnMeta = `day ${o.month.day} of ${o.month.days}${o.forecast.early ? ' · early in the month' : ' · band: 25th–75th percentile days'}`;
  return `<div class="live-metrics">${tiles.join('')}</div>
    ${panel('Burn-down', esc(burnMeta), costBurnSvg(o, fmt) + noBudgets + add)}
    <div class="live-grid">
      ${panel('Daily spend and spikes', 'each day against the 7 days before it', costSpikeSvg(o.spikes, fmt))}
      ${panel('Budgets', o.budgetsError ? '' : esc(`${o.atRisk.count} at risk`), rings)}
    </div>`;
}

/* ---------- Breakdown ---------- */

function costBreakdownHtml(b, ctx) {
  const fmt = ctx.fmt;
  const label = (col, key) => costName(col, key, ctx);
  const flow = b.flow.links.length ? costFlowSvg(b.flow, { fmt, label }) : holoEmpty('Nothing spent in this range.');
  // The legend follows the treemap's center order, so each center keeps its block color.
  const centers = b.treemap
    .map((c, i) => {
      const name = c.center === '__other' ? 'Other centers' : label('center', c.center);
      const color = COST_SERIES[i % COST_SERIES.length];
      return `<span><i style="background:${color}"></i>${esc(name)} · ${esc(fmt(c.spend))}</span>`;
    })
    .join('');
  const planNote = b.planFee ? esc(` · plan fees (${fmt(b.planFee)}) have no project`) : '';
  const stage = b.treemap.length
    ? `<section class="holo stage cost-stage"><canvas id="cost-treemap" aria-label="Projects by cost center: footprint by spend, height by spend per request"></canvas>
        <div class="stage-tl"><div class="holo-kicker">PROJECTS BY COST CENTER</div><div class="stage-key">Footprint = share of spend · height = spend per request · hover a block${planNote}</div></div>
        <div class="stage-legend cost-legend">${centers}</div></section>`
    : panel('Projects by cost center', '', holoEmpty('No project spend in this range.'));
  const flowMeta = `${fmt(b.total)} · source → provider → model → cost center · click a node to filter the table`;
  const calendar = `<div class="cost-scroll">${costCalendarSvg(b.calendar, fmt)}</div>`;
  return `${panel('Cost flow', esc(flowMeta), flow)}
    ${stage}
    ${panel('Calendar', 'weeks across, Monday to Sunday down', calendar)}
    ${panel('Table', 'from the ledger', '<div id="cost-table"><div class="skeleton" style="height:120px"></div></div>')}`;
}

// The table reads GET /api/cost/ledger with its own grouping, so it can be regrouped without a new view request.
// Its query and its labels come from the page's current controls and context; a newer table request, a newer page
// load (`live`) or leaving the page drops an older answer.
async function costLoadTable(live) {
  const host = $('#cost-table');
  const t = COST.table;
  const ctx = COST.ctx;
  const c = COST.controls;
  if (!host || !ctx) return;
  const my = ++COST.tableReq;
  const current = () => my === COST.tableReq && host.isConnected && (!live || live());
  const r = costRangeDays(c, costToday());
  const plan = costTablePlan(t.groupBy, t.filter);
  const q = new URLSearchParams({ from: r.from, to: r.to, groupBy: plan.query.join(',') });
  if (c.cur !== 'USD') q.set('currency', c.cur);
  try {
    const led = await costGet(`/api/cost/ledger?${q}`);
    if (!current()) return;
    t.data = { led, plan, ctx };
    costPaintTable();
  } catch (e) {
    if (!current()) return;
    host.innerHTML = `<p class="cost-note">${esc('The table did not load: ' + e.message)}</p>`;
  }
}
// What the ledger is asked to group by (`query`, at most 4) and the columns shown (`show`). A filter needs its
// dimension in the query; it is not shown as a column (every row has the same value). With 4 groupings checked, the
// last one is `left` out while the filter is on, and the table says so.
function costTablePlan(groupBy, filter) {
  const checked = groupBy.slice(0, 4);
  if (!filter || checked.includes(filter.dim)) return { query: checked, show: checked, left: null };
  if (checked.length < 4) return { query: [filter.dim, ...checked], show: checked, left: null };
  const show = checked.slice(0, 3);
  return { query: [filter.dim, ...show], show, left: checked[3] };
}
// A row's key in a dimension, as the flow names it: a row without a center is "unassigned".
const costRowKey = (x, dim) => (dim === 'center' ? x.center || 'unassigned' : String(x[dim] ?? ''));
function costTableRows(led, groupBy, { measure, cur, filter }) {
  const field = measure === 'billed' ? (cur === 'USD' ? 'billedUSD' : 'billed') : cur === 'USD' ? 'listUSD' : 'list';
  const rows = (led.rows || [])
    .filter((x) => !filter || costRowKey(x, filter.dim) === filter.key)
    .map((x) => {
      const spend = x[field] == null ? x[measure === 'billed' ? 'billedUSD' : 'listUSD'] : x[field];
      if (!spend && !x.requests) return null; // a plan row under usage value: nothing to show
      const tokens = Object.values(x.tokens || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      return {
        keys: groupBy.map((d) => x[d]),
        spend,
        requests: x.requests,
        tokens,
        perRequest: x.requests ? spend / x.requests : null,
      };
    })
    .filter(Boolean);
  const total = rows.reduce((a, x) => a + (x.spend || 0), 0);
  for (const x of rows) x.share = total > 0 ? x.spend / total : null;
  return { rows, total };
}
const COST_SORT_NUM = ['spend', 'share', 'requests', 'tokens', 'perRequest'];
function costPaintTable() {
  const host = $('#cost-table');
  const t = COST.table;
  if (!host || !t.data) return;
  const { led, plan, ctx } = t.data;
  const show = plan.show;
  const { rows } = costTableRows(led, show, { measure: ctx.measure, cur: ctx.cur, filter: t.filter });
  // A column sort follows its dimension; when that column is gone, the table sorts by spend again.
  const valid = (k) => COST_SORT_NUM.includes(k) || (k.startsWith('d:') && show.includes(k.slice(2)));
  if (!valid(t.sort.key)) t.sort = { key: 'spend', dir: -1 };
  const s = t.sort;
  const col = s.key.startsWith('d:') ? show.indexOf(s.key.slice(2)) : -1;
  const val = (x) => (col >= 0 ? String(x.keys[col] ?? '') : (x[s.key] ?? -Infinity));
  rows.sort((a, b) => {
    const A = val(a);
    const B = val(b);
    return (typeof A === 'string' ? A.localeCompare(B) : A - B) * s.dir;
  });
  const head = (key, text, num) => {
    const on = s.key === key;
    const sort = on ? (s.dir > 0 ? 'ascending' : 'descending') : 'none';
    const arrow = on ? (s.dir > 0 ? ' ↑' : ' ↓') : '';
    return `<th${num ? ' class="num"' : ''} aria-sort="${sort}"><button type="button" class="cost-sort" data-cost-sort="${esc(key)}">${esc(text + arrow)}</button></th>`;
  };
  const picks = COST_DIMS.map(
    (d) =>
      `<label class="cost-check"><input type="checkbox" data-cost-group="${d}" ${t.groupBy.includes(d) ? 'checked' : ''} ${!t.groupBy.includes(d) && t.groupBy.length >= 4 ? 'disabled' : ''}> ${COST_DIM_LABEL[d]}</label>`,
  ).join('');
  const chip = t.filter
    ? `<span class="cost-chip">${esc(`${COST_DIM_LABEL[t.filter.dim] || t.filter.dim}: ${costName(t.filter.dim, t.filter.key, ctx)}`)} <button type="button" data-cost-clear-filter aria-label="Clear the filter">×</button></span>`
    : '';
  const left = plan.left
    ? `<span class="cost-chip warn">${esc(`${COST_DIM_LABEL[plan.left]} is left out while filtering (4 groupings at most)`)}</span>`
    : '';
  const body = rows.length
    ? rows
        .slice(0, 500)
        .map(
          (x) =>
            `<tr>${x.keys.map((k, i) => `<td>${esc(costName(show[i], k, ctx))}</td>`).join('')}<td class="num">${esc(ctx.fmt(x.spend))}</td><td class="num">${esc(costPct(x.share))}</td><td class="num">${(x.requests || 0).toLocaleString('en')}</td><td class="num">${(x.tokens || 0).toLocaleString('en')}</td><td class="num">${esc(ctx.fmt(x.perRequest))}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="${show.length + 5}">${esc('Nothing in this range.')}</td></tr>`;
  const heads = show.map((d) => head(`d:${d}`, COST_DIM_LABEL[d] || d, false)).join('');
  host.innerHTML = `<div class="cost-table-bar"><span>Group by (up to 4):</span>${picks}${chip}${left}</div>
    <div class="table-wrap"><table class="cost-table"><thead><tr>${heads}${head('spend', 'Spend', true)}${head('share', 'Share', true)}${head('requests', 'Requests', true)}${head('tokens', 'Tokens', true)}${head('perRequest', 'Per request', true)}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- Value ---------- */

function costValueHtml(v, ctx) {
  const fmt = ctx.fmt;
  const source = (s) => COST_SOURCES[s] || s;
  const plans = v.plans.length
    ? costPlanBarsHtml(v.plans, fmt, source)
    : holoEmpty('No source was on a plan in this range.');
  // Without accuracy the scatter says so itself; it also lists the models with no tool calls to measure.
  const unmeasured = v.scatter.noToolCalls.length
    ? `<p class="cost-note">${esc('No tool calls to measure: ' + v.scatter.noToolCalls.map((m) => m.model).join(', '))}.</p>`
    : '';
  const scatter =
    v.accuracyError || v.scatter.dots.length
      ? costScatterSvg(v.scatter, fmt, { accuracyError: v.accuracyError })
      : holoEmpty('No model with measured tool calls in this range.') + unmeasured;
  const unit = (key, title, color, note) =>
    panel(
      esc(title),
      esc(note),
      key === 'perThousandToolCalls' && v.accuracyError
        ? '<p class="cost-note">Tool-call accuracy could not be read.</p>'
        : costUnitSvg(v.unit, key, fmt, color),
    );
  const quality = 'spend per request against tool-call accuracy · dot size = requests · hollow = little data';
  return `${panel('Plan value against plan fee', 'usage value of the plan days against what the plan cost', plans)}
    <div class="live-grid">
      ${panel('Savings', 'cache savings are an estimate at base rates', costWaterfallSvg(v.waterfall, fmt))}
      ${panel('Local models', 'requests and tokens, not priced', costLocalHtml(v.local, source))}
    </div>
    ${panel('Cost against quality', quality, scatter)}
    <div class="cost-units">
      ${unit('perRequest', 'Per request', COST_C.cyan, 'spend per request')}
      ${unit('perMillionTokens', 'Per million tokens', COST_C.violet, 'all token kinds')}
      ${unit('perThousandToolCalls', 'Per 1,000 successful tool calls', COST_C.pink, 'Claude Code and Codex only')}
    </div>`;
}

/* ---------- events (installed once) ---------- */

function costSetControls(next) {
  costStoreSet(next);
  location.hash = costHash(costSub(), next);
}
const COST_CLICKS = ['range', 'cur', 'measure', 'retry', 'node', 'clear-filter', 'sort']
  .map((k) => `#cost-app [data-cost-${k}]`)
  .join(', ');
function costInstallEvents() {
  if (COST.hooked) return;
  COST.hooked = true;
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest(COST_CLICKS);
    if (!t) return;
    const d = t.dataset;
    const c = COST.controls;
    if (d.costRange) {
      const next = { ...c, range: d.costRange };
      if (next.range === 'custom') Object.assign(next, costRangeDays(c, costToday()));
      return costSetControls(next);
    }
    if (d.costCur) return costSetControls({ ...c, cur: d.costCur });
    if (d.costMeasure) return costSetControls({ ...c, measure: d.costMeasure });
    if (t.hasAttribute('data-cost-retry')) return void costRefresh(false);
    if (d.costNode) return costFilterTo(d.costNode);
    if (t.hasAttribute('data-cost-clear-filter')) {
      COST.table.filter = null;
      return void costLoadTable();
    }
    if (d.costSort) {
      const s = COST.table.sort;
      COST.table.sort = { key: d.costSort, dir: s.key === d.costSort ? -s.dir : -1 };
      return costPaintTable();
    }
  });
  document.addEventListener('keydown', (e) => {
    const node = e.target.closest && e.target.closest('#cost-app [data-cost-node]');
    if (node && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      costFilterTo(node.dataset.costNode);
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#cost-app')) return;
    if (t.dataset.costDate) {
      const c = COST.controls;
      const r = costRangeDays(c, costToday());
      const next = { ...c, range: 'custom', from: r.from, to: r.to, [t.dataset.costDate]: t.value };
      // A broken or reversed pair, or more than 400 days, is not applied: the bar keeps the last good range.
      const ok = costParseControls(costControlsQuery(next), null, [c.cur]);
      if (ok.range === 'custom') costSetControls(ok);
      return;
    }
    if (t.dataset.costGroup) {
      const g = COST.table.groupBy.filter((x) => x !== t.dataset.costGroup);
      if (t.checked) g.push(t.dataset.costGroup);
      if (g.length) COST.table.groupBy = COST_DIMS.filter((x) => g.includes(x)).slice(0, 4);
      costLoadTable();
    }
  });
}
// A flow node filters the table to it (the ledger is asked for its dimension too: costTablePlan).
function costFilterTo(id) {
  const i = String(id).indexOf(':');
  if (i < 0) return;
  const dim = id.slice(0, i);
  if (!COST_DIMS.includes(dim)) return;
  COST.table.filter = { dim, key: id.slice(i + 1) };
  costLoadTable();
  const host = $('#cost-table');
  if (host) host.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_DEFAULT,
    COST_STORE_KEY,
    costIsDay,
    costAddDays,
    costParseControls,
    costRangeDays,
    costControlsQuery,
    costHash,
    costStoreGet,
    costStoreSet,
    costMoney,
    costRibbonItems,
    costUnreadText,
    costTableRows,
    costContext,
    costOverviewHtml,
    costValueHtml,
    COST,
    costUnmount,
    costQuietWait,
    costLoadTable,
    costTablePlan,
    costPaintTable,
  };
