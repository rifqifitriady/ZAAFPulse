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
  ['budgets', 'Budgets'],
  ['reports', 'Reports'],
  ['settings', 'Settings'],
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
const COST_SCOPE_DIMS = ['center', 'key', 'project', 'model', 'provider', 'source'];
const COST_SCOPE_LABEL = {
  center: 'Center',
  key: 'Key',
  project: 'Project',
  model: 'Model',
  provider: 'Provider',
  source: 'Source',
};
const COST_RESERVED_IDS = ['__proto__', 'constructor', 'prototype'];
const COST_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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

/** "Global", "Center · Platform", "Key · ci-bot", "Source · Claude Code", … */
function costScopeLabel(scope, ctx = {}) {
  if (!scope || scope === 'global') return 'Global';
  const v = String(scope.value ?? '');
  const shown =
    scope.dim === 'center'
      ? (ctx.centers && ctx.centers[v]) || (v === 'unassigned' ? 'Unassigned' : v)
      : scope.dim === 'key'
        ? (ctx.keys && ctx.keys[v]) || v
        : scope.dim === 'source'
          ? COST_SOURCES[v] || v
          : v;
  return `${COST_SCOPE_LABEL[scope.dim] || 'Scope'} · ${shown}`;
}

/** "Month · 1–31 Oct", "Week · 27 Oct – 2 Nov", "Day · 22 Oct" from a budget view's period and dates. */
function costPeriodLabel(b) {
  const name = { day: 'Day', week: 'Week', month: 'Month' }[b.period] || 'Period';
  if (!costIsDay(b.from) || !costIsDay(b.to)) return name;
  const d = (x) => Number(x.slice(8));
  const mon = (x) => COST_MONTH[Number(x.slice(5, 7)) - 1];
  if (b.from === b.to) return `${name} · ${d(b.from)} ${mon(b.from)}`;
  if (b.from.slice(0, 7) === b.to.slice(0, 7)) return `${name} · ${d(b.from)}–${d(b.to)} ${mon(b.to)}`;
  return `${name} · ${d(b.from)} ${mon(b.from)} – ${d(b.to)} ${mon(b.to)}`;
}

// As lib/cost/views.js: used up, then projected over, then by percent; without data last. Ties in plain code-unit
// order of the name, then the id (unique), so the order does not depend on the machine's locale.
const costRank = (b) => (b.state === 'exceeded' ? 0 : b.projected ? 1 : b.state === 'no_data' ? 3 : 2);
const costCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function costBudgetOrder(list) {
  return [...(list || [])].sort(
    (a, b) =>
      costRank(a) - costRank(b) ||
      (Number(b.percent) || 0) - (Number(a.percent) || 0) ||
      costCmp(String(a.name), String(b.name)) ||
      costCmp(String(a.id), String(b.id)),
  );
}
const costTone = (state) =>
  state === 'exceeded' ? 'exceeded' : state === 'no_data' ? 'none' : /^warn_/.test(String(state)) ? 'warn' : 'ok';
// The sidebar badge: budgets used up or projected over.
const costBadgeCount = (list) =>
  (Array.isArray(list) ? list : []).filter((b) => b && (b.state === 'exceeded' || b.projected === true)).length;

/** A new budget's id from its name: lowercase a-z0-9 and dashes, with -2, -3, … when taken. Accents are dropped
 *  first, so "Ácme" keeps its letter: "acme". */
function costIdFrom(name, taken = []) {
  const base =
    String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'budget';
  const used = new Set([...taken, ...COST_RESERVED_IDS]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The enforcement choices for a scope, mirroring lib/cost/budgets.js mayBlock and mayPause. */
function costEnforceOptions(scope) {
  const g = !scope || scope === 'global';
  const dim = g ? 'global' : scope.dim;
  const value = g ? '' : scope.value;
  const block = g || ['key', 'center', 'model', 'provider'].includes(dim) || (dim === 'source' && value === 'gateway');
  const pause =
    g ||
    ['project', 'center', 'model'].includes(dim) ||
    (dim === 'source' && (value === 'claude' || value === 'codex'));
  return [
    { value: 'none', label: 'None: alerts only', ok: true, why: '' },
    {
      value: 'block',
      label: 'Block gateway requests (402)',
      ok: block,
      why: block ? '' : 'block reaches gateway requests only: not a project or a local source',
    },
    {
      value: 'pause',
      label: 'Pause the costliest local agent',
      ok: pause,
      why: pause ? '' : 'pause reaches a local agent only: not a key, a provider or the gateway',
    },
  ];
}

/** The form's fields (strings, as FormData gives them, and projection as a boolean) to the POST body. */
function costFormBody(f, { id }) {
  const errors = [];
  const name = String(f.name ?? '').trim();
  if (!name || name.length > 60) errors.push('Name: 1 to 60 characters');
  const dim = COST_SCOPE_DIMS.includes(f.dim) ? f.dim : 'global';
  const scope = dim === 'global' ? 'global' : { dim, value: String(f.value ?? '').trim() };
  if (scope !== 'global' && !scope.value) errors.push(`${COST_SCOPE_LABEL[dim]}: name one`);
  const period = ['day', 'week', 'month'].includes(f.period) ? f.period : null;
  if (!period) errors.push('Period: day, week or month');
  const amount = Number(String(f.amount ?? '').trim() || NaN);
  if (!(Number.isFinite(amount) && amount > 0)) errors.push('Amount: a number above 0');
  const thresholds = [f.warn1, f.warn2]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .map(Number);
  if (
    !thresholds.every((t) => Number.isInteger(t) && t >= 1 && t <= 99) ||
    (thresholds.length === 2 && thresholds[1] <= thresholds[0])
  )
    errors.push('Warning levels: whole numbers from 1 to 99, the second above the first');
  const enforce = f.enforce || 'none';
  const opt = costEnforceOptions(scope).find((o) => o.value === enforce);
  if (!opt) errors.push('Enforcement: none, block or pause');
  else if (!opt.ok) errors.push(`Enforcement: ${opt.why}`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      id,
      name,
      scope,
      period,
      amount,
      currency: f.currency || 'USD',
      measure: f.measure === 'billed' ? 'billed' : 'list',
      thresholds,
      projection: f.projection === true || f.projection === 'on',
      enforce,
    },
  };
}

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

/** The status lines of GET /api/cost/budgets: the hand edit that does not validate, the kept list, the guard. */
function costBudgetBanners(a, ctx = {}) {
  const out = [];
  if (!a) return out;
  if (a.error)
    out.push({ tone: 'warn', title: a.error, lines: (a.reasons || []).map(String), note: 'Fix config.json first' });
  if (a.kept && a.kept.error) out.push({ tone: 'muted', title: String(a.kept.error), lines: [] });
  const g = a.guard || {};
  const problems = Array.isArray(g.problems) ? g.problems : [];
  if (g.error || problems.length) {
    const names = new Map((ctx.budgets || []).map((b) => [b.id, b.name]));
    out.push({
      tone: 'warn',
      title: 'The gateway is letting requests through for these budgets',
      lines: [
        ...(g.error ? [String(g.error)] : []),
        ...problems.map((p) =>
          [
            p.budget == null ? 'All budgets' : names.get(p.budget) || p.budget,
            p.reason,
            Number.isFinite(p.since) ? `since ${new Date(p.since).toLocaleString('en')}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ],
    });
  }
  return out;
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
  budgets: null,
  confirm: null, // the budget id whose delete is being confirmed
  cardMsg: {}, // budget id -> a delete error
  form: null, // { id, isNew, opener } while the drawer is open
  suggest: new Map(), // scope dim -> values seen in the ledger (last 90 days)
  focusTimer: null, // the ?focus= highlight's end, released on unmount
  hooked: false,
  budgetHooked: false,
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
const costPost = (path, body) =>
  costCall(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
    budgets: 'Limits by day, week or month, with alerts and, where you choose, a block or a pause.',
    reports: "One cost center's month for a client: totals, tables and budgets, to print or export.",
    settings: 'Cost centers and their rules, billing per source, the display currency, and restating past days.',
  }[sub];
  const title = (COST_SUBS.find(([s]) => s === sub) || COST_SUBS[0])[1];
  return `<div class="holo-deck cost-deck" id="cost-app">
    ${subTabs('cost')}
    ${subHero(`AI OBSERVABILITY · COST CONTROL`, esc(title), esc(copy || ''))}
    <div id="cost-ribbon"></div>
    <div id="cost-bar"></div>
    <div id="cost-body"><div class="skeleton" style="height:240px"></div></div>
    <div id="cost-form-host"></div></div>`;
}

function mountCost() {
  costInstallEvents();
  costInstallBudgetEvents();
  COST.form = null;
  COST.confirm = null;
  COST.cardMsg = {};
  // The page refreshes itself (app.js leaves it out of the 60-second render): a render would close an open form.
  const timer = setInterval(() => costRefresh(true), COST_REFRESH_MS);
  onUnmount(() => {
    clearInterval(timer);
    costUnmount();
  });
  costRefresh(false);
}
// Leaving the page: answers still in flight are dropped, an open form is closed with its page.
function costUnmount() {
  COST.req++;
  COST.tableReq++;
  COST.stage = null; // unmountStages() destroys it
  clearTimeout(COST.focusTimer);
  COST.focusTimer = null;
  COST.confirm = null;
  if (COST.form) {
    COST.form = null;
    if (typeof document !== 'undefined') document.body.classList.remove('drawer-locked');
  }
}

// A quiet refresh waits while the tab is hidden or the owner is in a form field of the page (a clicked button keeps
// the focus and does not count).
function costQuietWait(doc, app) {
  if (doc.hidden) return true;
  const f = doc.activeElement;
  return !!f && app.contains(f) && typeof f.matches === 'function' && f.matches('input, select, textarea');
}
// The Budgets page also waits while its form drawer or a delete confirmation is open: typed values are never lost.
function costRefresh(quiet) {
  const app = $('#cost-app');
  if (!app) return;
  // Settings is all forms (public/costsettings.js): it reloads after each Save, never on the quiet cycle.
  if (costSub() === 'settings') return quiet ? undefined : costMountSettings();
  // Reports is a document (public/costreports.js): it loads on a visit or a changed control, never on the quiet cycle.
  if (costSub() === 'reports') return quiet ? undefined : costMountReports();
  if (quiet && (costQuietWait(document, app) || COST.form || COST.confirm)) return;
  if (costSub() === 'budgets') return costMountBudgets(quiet);
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
    ctx.currencies.length > 1
      ? seg(
          'data-cost-cur',
          ctx.currencies.map((x) => [x, x]),
          c.cur,
          'Currency',
        )
      : '';
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
// A load that failed: the error panel with Retry, except on a quiet refresh over figures already on screen, which
// stay with a small note in front of them (as text, never markup). The next good answer repaints the page without it.
function costShowError(body, msg, quiet) {
  // The page's own skeleton or error panel only: the table's skeleton deeper down does not count.
  if (!quiet || body.querySelector(':scope > .skeleton, :scope > .cost-error')) {
    body.innerHTML = costErrorHtml(msg);
    return;
  }
  let note = body.querySelector(':scope > .cost-stale');
  if (!note) {
    note = document.createElement('p');
    note.className = 'cost-note warn cost-stale';
    note.setAttribute('role', 'status');
    body.prepend(note);
  }
  note.textContent = 'Could not refresh: ' + msg + '. Showing the last figures.';
}

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
    costShowError(body, e.message, quiet);
  }
}

/* ---------- Overview ---------- */

// The burn-down's caption names how the forecast was made (lib/cost/forecast.js).
const COST_FORECAST_CAPTION = {
  weekday: 'Forecast: weekday pattern of the last 4 weeks',
  mean: 'Forecast: daily mean (little history yet)',
};
const costForecastCaption = (method) =>
  Object.hasOwn(COST_FORECAST_CAPTION, method || '') ? COST_FORECAST_CAPTION[method] : 'No forecast yet';

// A day's spend against its usual amount, in USD as the rule measures it: "$18.40, usually $6.10 (3.0×)".
function costAnomalyFigures(m) {
  const times = m.expectedUSD > 0 ? ` (${(m.spentUSD / m.expectedUSD).toFixed(1)}×)` : '';
  return `${costMoney(m.spentUSD, 'USD')}, usually ${costMoney(m.expectedUSD, 'USD')}${times}`;
}
// One driver as text: "claude-opus-5-5 · +$9.20 (75 %)", "Key: Acme client · +$5.10 (41 %)".
function costDriverText(d, ctx) {
  const name =
    d.dim === 'keyId'
      ? `Key: ${d.label || costName('keyId', d.value, ctx)}`
      : d.dim === 'center'
        ? costName('center', d.value, ctx)
        : String(d.label || d.value);
  const share = Number.isFinite(d.share) ? ` (${Math.round(d.share * 100)} %)` : '';
  return `${name} · +${costMoney(d.extraUSD, 'USD')}${share}`;
}
// The Anomalies card: today so far and yesterday, each with its figures, its state and, when it is an anomaly, up to 3
// drivers. Every figure and name is text (esc).
const COST_ANOMALY_DAYS = [
  ['today', 'Today (so far)'],
  ['yesterday', 'Yesterday'],
];
function costAnomalyRow(label, m, ctx) {
  if (!m)
    return `<div class="cost-anom tone-none"><div class="cost-anom-head"><b>${esc(label)}</b><span class="cost-chip">Not enough history</span></div></div>`;
  const drivers =
    m.anomaly && m.drivers.length
      ? `<ul class="cost-anom-drivers">${m.drivers.map((d) => `<li>${esc(costDriverText(d, ctx))}</li>`).join('')}</ul>`
      : '';
  return `<div class="cost-anom tone-${m.anomaly ? 'bad' : 'ok'}"><div class="cost-anom-head"><b>${esc(label)}</b><span class="cost-chip${m.anomaly ? ' warn' : ''}">${m.anomaly ? 'Anomaly' : 'Normal'}</span></div>
    <p class="cost-anom-fig">${esc(costAnomalyFigures(m))}</p>${drivers}</div>`;
}
function costAnomaliesHtml(o, ctx) {
  const link = '<p class="cost-note"><a href="#settings/monitors">Change the sensitivity in Monitors</a></p>';
  if (!o.anomalies)
    return `<p class="cost-note warn">The ledger history could not be read: no anomalies for now.</p>${link}`;
  const rows = COST_ANOMALY_DAYS.map(([k, label]) => costAnomalyRow(label, o.anomalies[k], ctx)).join('');
  return `<div class="cost-anoms">${rows}</div>${link}`;
}
// The card's meta line: the rule's parameters, as the server applied them (the ratio to 2 decimals).
function costAnomalyMeta(p) {
  const ratio = p && Number.isFinite(p.ratio) ? Math.round(p.ratio * 100) / 100 : 2;
  const min = p && Number.isFinite(p.minUSD) ? p.minUSD : 1;
  return `over ${ratio}× the usual amount and at least ${costMoney(min, 'USD')} more · usage value in USD`;
}

// Whether the forecast has a band to speak of: none without a model (early), and none when it is the line itself (fewer
// than 3 usable days, or every day as expected), so the burn-down never claims a percentile band it does not draw.
const costBandShown = (f) =>
  !!f && !f.early && Array.isArray(f.line) && f.line.some((p) => p && Number(p.high) > Number(p.low));

function costOverviewHtml(o, ctx) {
  const fmt = ctx.fmt;
  const paid = ctx.measure === 'billed';
  const center = o.topCenter;
  // The budgets did not read: say so where they would be drawn, never "no budgets".
  const why = String(o.budgetsError || '');
  const noBudgets = why ? `<p class="cost-note warn">${esc(why.charAt(0).toUpperCase() + why.slice(1) + '.')}</p>` : '';
  const forecastSub = o.forecast.early
    ? 'no forecast yet: the mean so far'
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
  const burnMeta = `day ${o.month.day} of ${o.month.days} · ${costForecastCaption(o.forecastMethod)}${costBandShown(o.forecast) ? ' · band: 25th–75th percentile days' : ''}`;
  return `<div class="live-metrics">${tiles.join('')}</div>
    ${panel('Burn-down', esc(burnMeta), costBurnSvg(o, fmt) + noBudgets + add)}
    <div class="live-grid">
      ${panel('Daily spend and spikes', 'usage value, each day against the same weekday of the 4 weeks before it', costSpikeSvg(o.spikes, fmt))}
      ${panel('Budgets', o.budgetsError ? '' : esc(`${o.atRisk.count} at risk`), rings)}
    </div>
    ${panel('Anomalies', esc(costAnomalyMeta(o.anomalyParams)), costAnomaliesHtml(o, ctx))}`;
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
// A row's key in a dimension, as the flow names it. The ledger gives a usage row without a rule the center
// "unassigned"; only a plan fee has no center, and it reads "Plan fee" (it never matches center:unassigned).
const costRowKey = (x, dim) => (dim === 'center' ? (x.center == null ? '__plan' : x.center) : String(x[dim] ?? ''));
function costTableRows(led, groupBy, { measure, cur, filter }) {
  const field = measure === 'billed' ? (cur === 'USD' ? 'billedUSD' : 'billed') : cur === 'USD' ? 'listUSD' : 'list';
  const rows = (led.rows || [])
    .filter((x) => !filter || costRowKey(x, filter.dim) === filter.key)
    .map((x) => {
      const spend = x[field] == null ? x[measure === 'billed' ? 'billedUSD' : 'listUSD'] : x[field];
      if (!spend && !x.requests) return null; // a plan row under usage value: nothing to show
      const tokens = Object.values(x.tokens || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      return {
        keys: groupBy.map((d) => (d === 'center' ? costRowKey(x, d) : x[d])),
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
    </div>
    ${panel('Recommendations', 'cheaper models that did about as well in your experiments · usage value in USD', costRecommendationsHtml(v.recommendations))}`;
}

/* ---------- Value: cheaper-model recommendations (Cost Control 4b) ---------- */

const COST_REC_COPY = {
  failed: 'Recommendations could not be computed right now',
  noSpend: 'No model spend in the last 30 days',
  noExperiments: 'Run an experiment in Datasets to compare models on your own examples',
  gapsTitle: 'No evidence yet',
  runOne: 'Run an experiment in Datasets',
  foot: "Estimates from your own experiments and the last 30 days' use. Nothing is switched for you.",
  plan: 'Some of this use was covered by a plan: switching there saves usage value, not money paid.',
};
const COST_GAP_REASON = { no_experiment: 'No experiment yet', no_cheaper_match: 'No cheaper model did as well' };
// A share as "31 %", the way the card writes it.
const costPercent = (x) => `${Math.round((Number(x) || 0) * 100)} %`;
// An estimate in USD: whole dollars from $10 ("about $42"), cents below.
const costAbout = (v) => (Math.abs(v) >= 10 ? `$${Math.round(v).toLocaleString('en')}` : costMoney(v, 'USD'));
// Where a recommendation's experiment opens: its run on the Datasets Experiments tab (public/datasetview.js dsRunOf).
const costExperimentHref = (id) =>
  typeof id === 'string' && id ? `#datasets/experiments?run=${encodeURIComponent(id)}` : '#datasets/experiments';
// A recommendation's lines as plain text: the saving, the evidence and the experiments that agree.
function costRecTexts(r) {
  const n = Number(r.alsoBackedBy) || 0;
  const x = r.experiment || {};
  const rows = r.rowsA === r.rowsB ? `${r.rowsB} rows each` : `${r.rowsB} and ${r.rowsA} rows`;
  const day = Number.isFinite(x.endedAt) ? `, ${costShortDay(costDayOf(new Date(x.endedAt)))}` : '';
  return {
    saving: `about ${costAbout(r.savingUSD)} a month at the last 30 days' use (cost per example ${costPercent(r.costRatio)} of today's)`,
    rates: `Pass rate ${costPercent(r.rateB)} vs ${costPercent(r.rateA)}`,
    dataset: String(x.datasetName || x.dataset || 'an experiment'),
    detail: `${rows}${day}`,
    more: n > 0 ? `+${n} more experiment${n === 1 ? ' agrees' : 's agree'}` : '',
  };
}
function costRecHtml(r) {
  const t = costRecTexts(r);
  const local = r.local ? ' <span class="cost-chip">local</span>' : '';
  const more = t.more ? ` <small class="muted">${esc(t.more)}</small>` : '';
  return `<li class="cost-rec"><p class="cost-rec-main"><b>${esc(r.model)} → ${esc(r.candidate)}</b>: ${esc(t.saving)}${local}</p>
    <p class="cost-rec-ev"><a href="${esc(costExperimentHref(r.experiment && r.experiment.id))}">${esc(t.rates)} on <i>${esc(t.dataset)}</i> (${esc(t.detail)})</a>${more}</p></li>`;
}
function costGapHtml(g) {
  const reason = Object.hasOwn(COST_GAP_REASON, g.reason || '')
    ? COST_GAP_REASON[g.reason]
    : COST_GAP_REASON.no_experiment;
  return `<li class="cost-gap"><b>${esc(g.model)}</b> · ${esc(costMoney(g.spendUSD, 'USD'))} in the last 30 days · ${esc(reason)} · <a href="#datasets">${esc(COST_REC_COPY.runOne)}</a></li>`;
}
// The Recommendations card: a row per recommendation, the models with no evidence yet, and the footnote. The answer's
// `recommendations` is null when it could not be computed.
function costRecommendationsHtml(rec) {
  if (!rec || !Array.isArray(rec.items) || !Array.isArray(rec.gaps))
    return `<p class="cost-note warn">${esc(COST_REC_COPY.failed)}</p>`;
  if (!rec.items.length && !rec.gaps.length) return holoEmpty(esc(COST_REC_COPY.noSpend));
  const none =
    rec.basis && rec.basis.experiments === 0 ? `<p class="cost-note">${esc(COST_REC_COPY.noExperiments)}</p>` : '';
  const items = rec.items.length ? `<ul class="cost-recs">${rec.items.map(costRecHtml).join('')}</ul>` : '';
  const gaps = rec.gaps.length
    ? `<h4 class="cost-rec-sub">${esc(COST_REC_COPY.gapsTitle)}</h4><ul class="cost-gaps">${rec.gaps.map(costGapHtml).join('')}</ul>`
    : '';
  const plan = rec.items.some((r) => r.onPlan) ? ` ${esc(COST_REC_COPY.plan)}` : '';
  return `${none}${items}${gaps}<p class="cost-note">${esc(COST_REC_COPY.foot)}${plan}</p>`;
}

/* ---------- Budgets ---------- */

async function costMountBudgets(quiet) {
  const body = $('#cost-body');
  // The reload after a save or a delete can come after the owner moved to another sub-page: it never paints there.
  if (!body || costSub() !== 'budgets') return;
  const my = ++COST.req;
  const live = () => my === COST.req && body.isConnected && costSub() === 'budgets';
  try {
    const [list, settings] = await Promise.all([costGet('/api/cost/budgets'), costGet('/api/cost/settings')]);
    if (!live()) return;
    COST.settings = settings;
    COST.budgets = list;
    // Budgets has no range, currency or measure (V7), and its own status lines in place of the ledger ribbon.
    $('#cost-bar').innerHTML = '';
    $('#cost-ribbon').innerHTML = '';
    costPaintBudgets();
    costBadgePaint(list.budgets);
    const view = $('#view');
    // The entrance plays from this paint, not from the route change before the answer came.
    if (!quiet && view.classList.contains('animate') && typeof settle === 'function') settle(view);
    if (!quiet) costFocus();
  } catch (e) {
    if (!live()) return;
    costShowError(body, e.message, quiet);
  }
}
// A repaint keeps the keyboard where it was: the same card's button (or `focus()`, the button to take it). It paints
// only into the Budgets page: a delete's error can come after the owner moved to another sub-page.
function costPaintBudgets(focus) {
  const body = $('#cost-body');
  const list = COST.budgets;
  if (!body || !list || costSub() !== 'budgets') return;
  const was = document.activeElement;
  const mark =
    was && was !== body && body.contains(was) && was.tagName === 'BUTTON'
      ? [...was.attributes].find((a) => a.name.startsWith('data-cost-'))
      : null;
  const ctx = costContext(COST.settings);
  const banners = costBudgetBanners(list, { budgets: list.budgets })
    .map(
      (b) =>
        `<div class="cost-banner ${esc(b.tone)}" role="status"><b>${esc(b.title)}</b>${b.lines.length ? `<ul>${b.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}${b.note ? `<p>${esc(b.note)}</p>` : ''}</div>`,
    )
    .join('');
  const locked = !!list.error;
  const cards = costBudgetOrder(list.budgets)
    .map((b) => costBudgetCardHtml(b, ctx, locked))
    .join('');
  body.innerHTML = `${banners}<div class="cost-toolbar"><button type="button" class="btn" data-cost-add ${locked ? 'disabled title="Fix config.json first"' : ''}>${icon('dollar', 14)} Add a budget</button>${locked ? '<span class="cost-note">Fix config.json first</span>' : ''}</div>
    ${cards ? `<div class="cost-cards">${cards}</div>` : holoEmpty('No budgets yet. Add one to get alerts at your levels, and a block or a pause where you choose.')}`;
  const buttons = [...body.querySelectorAll('button')];
  const next = focus ? focus() : mark && buttons.find((b) => b.getAttribute(mark.name) === mark.value);
  if (next) next.focus({ preventScroll: true });
}
// A card's button, found by the card's id (no selector built from the id).
const costCardButton = (id, attr) => () => {
  const card = [...document.querySelectorAll('#cost-app [data-cost-card]')].find((el) => el.dataset.costCard === id);
  return card ? card.querySelector(`[${attr}]`) : null;
};
// A budget's forecast line (lib/cost/budgets.js forecastUSD and runsOut): the day it runs out at this pace, or that it
// stays under its amount, with the forecast in the budget's currency; nothing without a forecast or once used up.
const costShortDay = (day) => `${Number(day.slice(8))} ${COST_MONTH[Number(day.slice(5, 7)) - 1]}`;
function costForecastLine(b) {
  if (!b || b.state === 'no_data' || b.state === 'exceeded') return '';
  if (costIsDay(b.runsOut)) return `Runs out ~${costShortDay(b.runsOut)} at this pace`;
  if (typeof b.forecastUSD !== 'number' || !Number.isFinite(b.forecastUSD)) return '';
  const rate = b.amountUSD > 0 ? b.amount / b.amountUSD : 1;
  return `Stays under the amount this period (forecast ${costMoney(b.forecastUSD * rate, b.currency)})`;
}
function costBudgetCardHtml(b, ctx, locked) {
  const tone = costTone(b.state);
  const chips = [
    COST_MEASURES[b.measure] || 'Usage value',
    b.projected ? 'Projected over' : '',
    b.enforce === 'block' ? 'Blocks gateway' : b.enforce === 'pause' ? 'Pauses agent' : '',
    b.legacy ? 'From old settings' : '',
  ]
    .filter(Boolean)
    .map((c) => `<span class="cost-chip${c === 'Projected over' ? ' warn' : ''}">${esc(c)}</span>`)
    .join('');
  const figures =
    b.state === 'no_data'
      ? `<p class="cost-card-reason">${esc(b.reason || 'No data')}</p>`
      : `<p class="cost-card-spent"><b>${esc(costMoney(b.spent, b.currency))}</b> of ${esc(costMoney(b.amount, b.currency))}</p>`;
  const line = costForecastLine(b);
  const forecast = line ? `<p class="cost-card-forecast">${esc(line)}</p>` : '';
  const msg = COST.cardMsg[b.id] ? `<p class="cost-card-reason" role="alert">${esc(COST.cardMsg[b.id])}</p>` : '';
  const actions =
    COST.confirm === b.id
      ? `<p class="cost-confirm">${esc('Delete budget "' + b.name + '"?' + (b.legacy ? ' A budget from old settings also clears that setting.' : ''))}</p><button type="button" class="btn danger" data-cost-confirm-delete="${esc(b.id)}">Delete</button><button type="button" class="btn ghost" data-cost-cancel-delete>Cancel</button>`
      : `<button type="button" class="btn ghost" data-cost-edit="${esc(b.id)}" ${locked ? 'disabled' : ''}>Edit</button><button type="button" class="btn ghost danger" data-cost-delete="${esc(b.id)}" ${locked ? 'disabled' : ''}>Delete</button>`;
  return `<article class="holo cost-card tone-${tone}" data-cost-card="${esc(b.id)}">
    <div class="cost-card-ring">${costRingSvg(b.percent, tone, 84)}</div>
    <div class="cost-card-main"><h3>${esc(b.name)}</h3><p>${esc(costScopeLabel(b.scope, ctx))}</p><p>${esc(costPeriodLabel(b))}</p>${figures}${forecast}<div class="cost-chips">${chips}</div>${msg}</div>
    <div class="cost-card-actions">${actions}</div></article>`;
}

// #cost/budgets?focus=<id> (the bell, an Overview ring): scroll to the card and highlight it for a moment.
function costFocus() {
  const id = new URLSearchParams(costQueryOfHash()).get('focus');
  if (!id) return;
  const card = [...document.querySelectorAll('[data-cost-card]')].find((el) => el.dataset.costCard === id);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  card.classList.add('cost-focus');
  clearTimeout(COST.focusTimer);
  COST.focusTimer = setTimeout(() => card.classList.remove('cost-focus'), 2400);
}

async function costBadge() {
  try {
    const r = await costCall('/api/cost/budgets');
    if (r.status === 200 && r.json) costBadgePaint(r.json.budgets);
  } catch {
    /* the badge waits for the next cycle */
  }
}
function costBadgePaint(list) {
  const el = document.getElementById('b-cost');
  if (!el) return;
  const n = costBadgeCount(list);
  el.textContent = n ? String(n) : '';
  el.title = n ? `${n} budget${n === 1 ? '' : 's'} used up or projected over` : '';
}

/* ---------- the budget form ---------- */

function costFormHtml(b, ctx, taken) {
  const isNew = !b;
  const v = b || {
    name: '',
    scope: 'global',
    period: 'month',
    amount: '',
    currency: 'USD',
    measure: 'list',
    thresholds: [50, 80],
    projection: true,
    enforce: 'none',
  };
  const dim = v.scope === 'global' ? 'global' : v.scope.dim;
  const value = v.scope === 'global' ? '' : v.scope.value;
  const opt = (val, text, on) => `<option value="${esc(val)}" ${val === on ? 'selected' : ''}>${esc(text)}</option>`;
  const currencies = ctx.display ? ['USD', ctx.display] : ['USD'];
  if (!currencies.includes(v.currency)) currencies.push(v.currency);
  return `<div class="cost-drawer-backdrop" data-cost-close-form></div>
  <aside class="cost-drawer holo-deck" role="dialog" aria-modal="true" aria-labelledby="cost-form-title">
    <form id="cost-form" novalidate data-cost-id="${esc(isNew ? '' : b.id)}">
      <div class="cost-drawer-head"><h2 id="cost-form-title">${isNew ? 'Add a budget' : 'Edit budget'}</h2><button type="button" class="btn ghost" data-cost-close-form aria-label="Close">×</button></div>
      ${b && b.legacy ? '<p class="cost-note warn">Saving moves this budget out of the old setting (monthly budget / key budget), which is cleared.</p>' : ''}
      <label>Name<input class="input" name="name" maxlength="60" required value="${esc(v.name)}" autocomplete="off"></label>
      <p class="cost-id">Id <code id="cost-form-id">${esc(isNew ? costIdFrom(v.name, taken) : b.id)}</code>${isNew ? ' · made from the name' : ''}</p>
      <div class="cost-row">
        <label>Scope<select class="input" name="dim">${opt('global', 'Global', dim)}${COST_SCOPE_DIMS.map((d) => opt(d, COST_SCOPE_LABEL[d], dim)).join('')}</select></label>
        <label>Value<input class="input" name="value" list="cost-scope-values" value="${esc(value)}" ${dim === 'global' ? 'disabled' : ''} autocomplete="off"><datalist id="cost-scope-values">${costSuggestOptions(dim, ctx)}</datalist></label>
      </div>
      <div class="cost-row">
        <label>Period<select class="input" name="period">${opt('day', 'Day', v.period)}${opt('week', 'Week (from Monday)', v.period)}${opt('month', 'Month', v.period)}</select></label>
        <label>Amount<input class="input" name="amount" type="number" min="0" step="any" required value="${esc(v.amount)}"></label>
        <label>Currency<select class="input" name="currency">${currencies.map((c) => opt(c, c, v.currency)).join('')}</select></label>
      </div>
      <label>Measure<select class="input" name="measure">${opt('list', 'Usage value', v.measure)}${opt('billed', 'Paid', v.measure)}</select></label>
      <fieldset class="cost-row"><legend>Warning levels (%), up to two</legend><input class="input" name="warn1" type="number" min="1" max="99" step="1" value="${esc(v.thresholds[0] ?? '')}" aria-label="First warning level"><input class="input" name="warn2" type="number" min="1" max="99" step="1" value="${esc(v.thresholds[1] ?? '')}" aria-label="Second warning level"></fieldset>
      <label class="cost-check"><input type="checkbox" name="projection" ${v.projection ? 'checked' : ''}> Alert when the projection passes the amount</label>
      <fieldset id="cost-enforce"><legend>Enforcement</legend>${costEnforceHtml(v.scope, v.enforce)}</fieldset>
      <div id="cost-form-msg" role="alert"></div>
      <div class="cost-drawer-foot"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-cost-close-form>Cancel</button></div>
    </form>
  </aside>`;
}
function costEnforceHtml(scope, current) {
  const opts = costEnforceOptions(scope);
  const pick = opts.some((o) => o.value === current && o.ok) ? current : 'none';
  return opts
    .map(
      (o) =>
        `<label class="cost-radio${o.ok ? '' : ' off'}"><input type="radio" name="enforce" value="${esc(o.value)}" ${o.value === pick ? 'checked' : ''} ${o.ok ? '' : 'disabled'}> ${esc(o.label)}${o.ok ? '' : ` <small>${esc(o.why)}</small>`}</label>`,
    )
    .join('');
}
// Known values for a scope dimension; free entry stays allowed.
function costSuggestOptions(dim, ctx) {
  let vals = [];
  if (dim === 'center') vals = [...Object.entries(ctx.centers), ['unassigned', 'Unassigned']];
  else if (dim === 'key') vals = Object.entries(ctx.keys);
  else if (dim === 'source') vals = ctx.sources.map((s) => [s, COST_SOURCES[s] || s]);
  else if (COST.suggest.has(dim)) vals = COST.suggest.get(dim).map((v) => [v, v]);
  return vals.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
}
// Projects, models and providers with spend in the last 90 days, read once per dimension.
async function costLoadSuggest(dim) {
  if (!['project', 'model', 'provider'].includes(dim) || COST.suggest.has(dim)) return;
  const to = costToday();
  try {
    const led = await costGet(`/api/cost/ledger?from=${costAddDays(to, -89)}&to=${to}&groupBy=${dim}`);
    COST.suggest.set(
      dim,
      (led.rows || [])
        .map((r) => r[dim])
        .filter((v) => typeof v === 'string' && v)
        .slice(0, 200),
    );
    const list = document.getElementById('cost-scope-values');
    const form = document.getElementById('cost-form');
    if (list && form && form.elements.dim.value === dim)
      list.innerHTML = costSuggestOptions(dim, costContext(COST.settings));
  } catch {
    /* free entry still works */
  }
}
function costOpenForm(id, opener) {
  const host = $('#cost-form-host');
  if (!host || !COST.budgets || COST.budgets.error) return; // the API answers 409 until config.json is fixed
  const list = COST.budgets.budgets || [];
  const b = id ? list.find((x) => x.id === id) : null;
  if (id && !b) return;
  const ctx = costContext(COST.settings);
  COST.form = { id: b ? b.id : null, isNew: !b, opener };
  host.innerHTML = costFormHtml(
    b,
    ctx,
    list.map((x) => x.id),
  );
  document.body.classList.add('drawer-locked');
  const dim = b && b.scope !== 'global' ? b.scope.dim : 'global';
  costLoadSuggest(dim);
  const first = host.querySelector('input[name="name"]');
  if (first) first.focus();
}
function costCloseForm() {
  const host = $('#cost-form-host');
  if (host) host.innerHTML = '';
  document.body.classList.remove('drawer-locked');
  const opener = COST.form && COST.form.opener;
  COST.form = null;
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
}
function costFormFields(form) {
  const f = Object.fromEntries(new FormData(form));
  f.projection = form.elements.projection.checked;
  if (form.elements.value.disabled) f.value = '';
  return f;
}
const costReasonsHtml = (list) => `<ul class="cost-reasons">${list.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
async function costSubmitForm(form) {
  const msg = $('#cost-form-msg');
  const taken = ((COST.budgets && COST.budgets.budgets) || []).map((b) => b.id);
  const id = form.dataset.costId || costIdFrom(form.elements.name.value, taken);
  const r = costFormBody(costFormFields(form), { id });
  if (!r.ok) {
    msg.innerHTML = costReasonsHtml(r.errors);
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await costPost('/api/cost/budgets', r.body);
    if (res.status === 200) {
      costCloseForm();
      await costMountBudgets(true);
      return;
    }
    const j = res.json || {};
    msg.innerHTML =
      res.status === 400 && Array.isArray(j.reasons)
        ? costReasonsHtml(j.reasons)
        : `<p>${esc(j.error || `Could not save (${res.status})`)}</p>`;
  } catch (e) {
    msg.innerHTML = `<p>${esc(e.message)}</p>`;
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}
async function costDelete(id) {
  try {
    const res = await costPost(`/api/cost/budgets/${encodeURIComponent(id)}/delete`, {});
    // Another card's confirmation, asked for while this request was out, stays open.
    if (COST.confirm === id) COST.confirm = null;
    if (res.status !== 200) COST.cardMsg[id] = (res.json && res.json.error) || `Could not delete (${res.status})`;
    else delete COST.cardMsg[id];
    await costMountBudgets(true);
    // The keyboard stays on the card that failed, or moves to Add once the card is gone.
    const to = res.status === 200 ? $('#cost-app [data-cost-add]') : costCardButton(id, 'data-cost-delete')();
    if (to) to.focus({ preventScroll: true });
  } catch (e) {
    if (COST.confirm === id) COST.confirm = null;
    COST.cardMsg[id] = e.message;
    costPaintBudgets(costCardButton(id, 'data-cost-delete'));
  }
}

// The Budgets page's own listeners: the cards' buttons, the drawer form and its fields.
const COST_BUDGET_CLICKS = ['add', 'edit', 'delete', 'confirm-delete', 'cancel-delete', 'close-form']
  .map((k) => `#cost-app [data-cost-${k}]`)
  .join(', ');
function costInstallBudgetEvents() {
  if (COST.budgetHooked) return;
  COST.budgetHooked = true;
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest(COST_BUDGET_CLICKS);
    if (!t) return;
    const d = t.dataset;
    if (t.hasAttribute('data-cost-add')) return costOpenForm(null, t);
    if (d.costEdit) return costOpenForm(d.costEdit, t);
    if (d.costDelete) {
      COST.confirm = d.costDelete;
      return costPaintBudgets(costCardButton(d.costDelete, 'data-cost-cancel-delete'));
    }
    if (d.costConfirmDelete) {
      t.disabled = true; // one request per confirmation
      return void costDelete(d.costConfirmDelete);
    }
    if (t.hasAttribute('data-cost-cancel-delete')) {
      const id = COST.confirm;
      COST.confirm = null;
      return costPaintBudgets(id ? costCardButton(id, 'data-cost-delete') : null);
    }
    if (t.hasAttribute('data-cost-close-form')) return costCloseForm();
  });
  document.addEventListener('keydown', (e) => {
    if (!COST.form) return;
    if (e.key === 'Escape') return costCloseForm();
    // A modal drawer: Tab cycles inside it.
    const drawer = document.querySelector('#cost-form-host .cost-drawer');
    if (e.key !== 'Tab' || !drawer) return;
    const items = [...drawer.querySelectorAll('input, select, button, textarea')].filter(
      (el) => !el.disabled && el.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!drawer.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.form || t.form.id !== 'cost-form') return;
    if (t.name === 'dim') {
      const form = t.form;
      form.elements.value.disabled = t.value === 'global';
      if (t.value === 'global') form.elements.value.value = '';
      $('#cost-scope-values').innerHTML = costSuggestOptions(t.value, costContext(COST.settings));
      costLoadSuggest(t.value);
      costPaintEnforce(form);
    }
    if (t.name === 'value') costPaintEnforce(t.form);
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.name === 'name' && t.form && t.form.id === 'cost-form' && !t.form.dataset.costId) {
      const taken = ((COST.budgets && COST.budgets.budgets) || []).map((b) => b.id);
      $('#cost-form-id').textContent = costIdFrom(t.value, taken);
    }
    // The enforcement choices follow the scope value as it is typed (a source of gateway allows block).
    if (t.name === 'value' && t.form && t.form.id === 'cost-form') costPaintEnforce(t.form);
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'cost-form') return;
    e.preventDefault();
    costSubmitForm(e.target);
  });
}
function costPaintEnforce(form) {
  const dim = form.elements.dim.value;
  const scope = dim === 'global' ? 'global' : { dim, value: form.elements.value.value.trim() };
  const current = (form.querySelector('input[name="enforce"]:checked') || {}).value || 'none';
  $('#cost-enforce').innerHTML = `<legend>Enforcement</legend>${costEnforceHtml(scope, current)}`;
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
// Only a real ledger value filters: Other, Unknown and Plan fee are groupings the flow made, not values of a row.
const COST_NOT_FILTERS = ['__other', '__none', '__plan'];
function costFilterTo(id) {
  const i = String(id).indexOf(':');
  if (i < 0) return;
  const dim = id.slice(0, i);
  if (!COST_DIMS.includes(dim) || COST_NOT_FILTERS.includes(id.slice(i + 1))) return;
  COST.table.filter = { dim, key: id.slice(i + 1) };
  costLoadTable();
  const host = $('#cost-table');
  if (host) host.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_SUBS,
    COST_SOURCES,
    COST_MONTH,
    COST_MONTH_LONG,
    COST_MAX_DAYS,
    costToday,
    costGet,
    costPost,
    costSub,
    costQueryOfHash,
    costReasonsHtml,
    costRibbonHtml,
    costErrorHtml,
    costShowError,
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
    costScopeLabel,
    costPeriodLabel,
    costBudgetOrder,
    costTone,
    costBadgeCount,
    costIdFrom,
    costEnforceOptions,
    costFormBody,
    costRibbonItems,
    costUnreadText,
    costBudgetBanners,
    costTableRows,
    costBudgetCardHtml,
    costForecastLine,
    costFormHtml,
    costMountBudgets,
    costRefresh,
    costDelete,
    costPaintBudgets,
    costContext,
    costOverviewHtml,
    costForecastCaption,
    costAnomalyFigures,
    costDriverText,
    costAnomaliesHtml,
    costAnomalyMeta,
    costBandShown,
    costValueHtml,
    costPercent,
    costAbout,
    costExperimentHref,
    costRecTexts,
    costRecommendationsHtml,
    COST,
    costUnmount,
    costQuietWait,
    costLoadTable,
    costTablePlan,
    costPaintTable,
    costFilterTo,
  };
