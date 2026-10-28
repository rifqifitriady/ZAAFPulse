'use strict';
/* Cost Control → Settings (#cost/settings, sub-project 3b): cost centers with gateway keys and folder rules (with a
   server preview of what moves), billing per source, the display currency with dated rates, and a restate of a past
   range. Each of the first three panels saves on its own: it reads GET /api/cost/settings again and sends it with only
   its own fields replaced. Drafts live in memory for the life of the tab. Loaded after costview.js, whose helpers it
   uses inside functions only; pure helpers are exported for Node tests, and nothing here touches the DOM at load time.
   Every server or owner string reaches the markup through esc(). */

/* ---------- the frame: constants, drafts, request bodies ---------- */

const COST_SET_PANELS = [
  ['rules', 'Cost centers & rules'],
  ['billing', 'Billing'],
  ['currency', 'Display currency'],
  ['restate', 'Restate'],
];
const COST_SET_FORMS = ['rules', 'billing', 'currency']; // the panels with a draft and a Save
const COST_SET_LIMITS = { centers: 50, folderRules: 100, rates: 1000 }; // lib/cost/rules.js LIMITS
const COST_SET_PREVIEW_MS = 400;
const COST_SET_APPLIES = 'Saved. New costs follow these rules from today. To apply them to past days, use Restate.';
// What each panel registers as it is built (the sections below): its body markup, its buttons, its field hooks.
const COST_SET_BODIES = {}; // panel -> (st) => markup
const COST_SET_ACTIONS = {}; // data-cost-set-act -> (button) => void
const COST_SET_ON_INPUT = []; // (field, panel, path) => void, after an input event (panel null outside a draft)
const COST_SET_ON_CHANGE = []; // (field) => void, after a change event
const COST_SET_ON_OPEN = []; // (panel) => void, when a panel is opened
const COST_SET_ON_LOAD = []; // () => void, after each load of the settings, before the page is drawn

/** A panel's form values from the saved settings: what the panel shows while it has no draft. */
function costSetFromSaved(panel, settings, sources) {
  const s = settings || {};
  if (panel === 'rules')
    return {
      centers: (s.centers || []).map((c) => ({ id: c.id, name: c.name, isNew: false, idEdited: false })),
      keyCenters: { ...(s.keyCenters || {}) },
      folderRules: (s.folderRules || []).map((r) => ({ glob: r.glob, center: r.center })),
    };
  if (panel === 'billing')
    return {
      billing: Object.fromEntries(
        (sources || []).map((src) => {
          const b = (s.billing || {})[src];
          return [
            src,
            b && b.mode === 'plan'
              ? { mode: 'plan', plan: b.plan, feeUSD: String(b.feeUSD), period: b.period }
              : { mode: 'metered', plan: '', feeUSD: '', period: 'month' },
          ];
        }),
      ),
    };
  const c = s.currency;
  return {
    currency: c
      ? { on: 'on', code: c.code, rates: (c.rates || []).map((r) => ({ from: r.from, perUSD: String(r.perUSD) })) }
      : { on: 'off', code: '', rates: [] },
  };
}

// A number typed as text: an empty field is null, which the server refuses with its own reason (as it does NaN).
const costSetNum = (v) => {
  const t = String(v ?? '').trim();
  return t === '' ? null : Number(t);
};

/** The POST body of a panel's Save (R4): the saved settings with only that panel's fields replaced. */
function costSetBody(panel, saved, draft, sources) {
  const s = saved || {};
  const base = {
    centers: s.centers || [],
    keyCenters: s.keyCenters || {},
    folderRules: s.folderRules || [],
    billing: s.billing || {},
    currency: s.currency ?? null,
  };
  if (panel === 'rules')
    return {
      ...base,
      centers: draft.centers.map((c) => ({ id: String(c.id ?? '').trim(), name: String(c.name ?? '').trim() })),
      keyCenters: { ...draft.keyCenters },
      folderRules: draft.folderRules.map((r) => ({ glob: String(r.glob ?? '').trim(), center: r.center })),
    };
  if (panel === 'billing')
    return {
      ...base,
      billing: Object.fromEntries(
        (sources || Object.keys(draft.billing)).map((src) => {
          const b = draft.billing[src] || { mode: 'metered' };
          return [
            src,
            b.mode === 'plan'
              ? { mode: 'plan', plan: String(b.plan ?? '').trim(), feeUSD: costSetNum(b.feeUSD), period: b.period }
              : { mode: 'metered' },
          ];
        }),
      ),
    };
  const c = draft.currency;
  return {
    ...base,
    currency:
      c.on === 'on'
        ? {
            code: String(c.code ?? '')
              .trim()
              .toUpperCase(),
            rates: c.rates
              .map((r) => ({ from: r.from, perUSD: costSetNum(r.perUSD) }))
              .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
          }
        : null,
  };
}

/** Whether a panel's draft would change the saved settings. */
function costSetDirty(panel, saved, draft, sources) {
  if (!draft) return false;
  const was = costSetFromSaved(panel, saved, sources);
  return (
    JSON.stringify(costSetBody(panel, saved, draft, sources)) !==
    JSON.stringify(costSetBody(panel, saved, was, sources))
  );
}

/** Sets one form value in a draft by its field path ("centers.2.name", "keyCenters.key_a", "billing.claude.plan").
 *  An empty key mapping is removed: "Folder rules decide". */
function costSetAssign(draft, path, value) {
  const parts = String(path).split('.');
  if (parts.some((p) => ['__proto__', 'constructor', 'prototype'].includes(p))) return draft;
  if (parts[0] === 'keyCenters' && parts.length === 2) {
    if (value === '') delete draft.keyCenters[parts[1]];
    else draft.keyCenters[parts[1]] = value;
    return draft;
  }
  let at = draft;
  for (const p of parts.slice(0, -1)) {
    at = at[/^\d+$/.test(p) ? Number(p) : p];
    if (at == null || typeof at !== 'object') return draft;
  }
  at[parts[parts.length - 1]] = value;
  return draft;
}

/** The field paths a server reason names ("folderRules[2].center: …" → "folderRules.2.center"), for the error mark. */
function costSetReasonPaths(reasons) {
  return (Array.isArray(reasons) ? reasons : [])
    .map((r) => /^([A-Za-z][\w-]*(?:\[\d+\]|\.[\w-]+)*):/.exec(String(r)))
    .filter(Boolean)
    .map((m) => m[1].replace(/\[(\d+)\]/g, '.$1'));
}

/** Saves and the restate are off while the settings do not read: the values shown are the defaults standing in for
 *  the invalid ones, and a Save would write them over the owner's other sections. */
const costSetLocked = (answer) => !answer || !!answer.error;

/* ---------- the page state ---------- */

const COST_SET = {
  answer: null, // GET /api/cost/settings
  budgets: [], // GET /api/cost/budgets → budgets, for "Used by"
  drafts: {}, // panel -> its draft, kept for the life of the tab
  msg: {}, // panel -> { tone, text, reasons, restate, budgets } after a Save
  marks: {}, // panel -> the field paths a 400's reasons name
  busy: {}, // panel -> a Save in flight
  open: { rules: true, billing: true, currency: true, restate: false },
  gen: 0, // +1 after each Save that went through: a restate preview made before it is stale
  preview: null, // the settings preview: { key, sent, answer } | { key, sent, reasons } | { key, error }
  previewReq: 0,
  previewTimer: null,
  testPath: '',
  restate: {
    from: null,
    to: null,
    reason: '',
    ack: false,
    preview: null,
    of: null,
    error: null,
    done: null,
    running: false,
  },
  restateReq: 0,
  history: null, // GET /api/cost/restates → restates
  historyError: null,
  historyReq: 0,
  mounted: false,
  hooked: false,
};

const COST_SET_EMPTY = Object.freeze({ centers: [], keyCenters: {}, folderRules: [], billing: {}, currency: null });
const costSetSaved = () => (COST_SET.answer && COST_SET.answer.settings) || COST_SET_EMPTY;
const costSetSources = () => (COST_SET.answer && COST_SET.answer.sources) || Object.keys(COST_SOURCES);
/** A panel's draft, or its saved values while it has none (a draft is stored only once the owner edits). */
const costSetDraftOf = (panel) => COST_SET.drafts[panel] || costSetFromSaved(panel, costSetSaved(), costSetSources());
const costSetAnyDirty = () =>
  !!COST_SET.answer &&
  COST_SET_FORMS.some((p) => costSetDirty(p, costSetSaved(), COST_SET.drafts[p], costSetSources()));
// The draft of a panel, made from the saved values on its first edit, changed by `fn`.
function costSetEdit(panel, fn) {
  if (!COST_SET.drafts[panel]) COST_SET.drafts[panel] = costSetFromSaved(panel, costSetSaved(), costSetSources());
  fn(COST_SET.drafts[panel]);
  return COST_SET.drafts[panel];
}

/* ---------- the frame's markup ---------- */

// A form field bound to a draft path, with the error mark when a reason names it.
function costSetField(panel, path, st) {
  const bad = ((st.marks && st.marks[panel]) || []).includes(path);
  return `data-cost-set-field="${esc(panel + ':' + path)}"${bad ? ' aria-invalid="true"' : ''}`;
}
function costSetDirtyHtml(panel, st) {
  const a = st.answer || {};
  return costSetDirty(panel, a.settings, st.drafts[panel], a.sources)
    ? `<p class="cost-set-dirty" role="status">Unsaved changes <button type="button" class="btn ghost" data-cost-set-act="discard" data-panel="${esc(panel)}">Discard</button></p>`
    : '';
}
function costSetMsgHtml(m) {
  if (!m) return '';
  const reasons = Array.isArray(m.reasons) && m.reasons.length ? costReasonsHtml(m.reasons) : '';
  const restate = m.restate
    ? '<button type="button" class="link-btn" data-cost-set-act="open-restate">Open Restate</button>'
    : '';
  const budgets = m.budgets ? '<a class="link-btn" href="#cost/budgets">Open Budgets</a>' : '';
  return `<p class="cost-note${m.tone === 'ok' ? '' : ' warn'}">${esc(m.text)}</p>${reasons}${restate}${budgets}`;
}
function costSetSaveHtml(panel, st) {
  const locked = costSetLocked(st.answer);
  return `<div class="cost-set-save"><button type="button" class="btn" data-cost-set-act="save" data-panel="${esc(panel)}" ${locked || (st.busy && st.busy[panel]) ? 'disabled' : ''}>Save</button>${locked ? '<span class="cost-note">Fix config.json first</span>' : ''}<div data-cost-set-msg="${esc(panel)}" role="status">${costSetMsgHtml(st.msg && st.msg[panel])}</div></div>`;
}
/** The banner while GET /api/cost/settings reports `error`: the error, its reasons, and why Saves are off. */
function costSetBannerHtml(answer) {
  if (!answer || !answer.error) return '';
  const reasons = (answer.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('');
  return `<div class="cost-banner warn" role="status"><b>${esc(answer.error)}</b>${reasons ? `<ul>${reasons}</ul>` : ''}<p>Saving and restating are off until config.json is fixed: the values shown are the defaults that stand in for the invalid ones. The previews still work on your drafts.</p></div>`;
}
// What a panel holds under its title: the unsaved-changes line, its own body, and the Save of a form panel.
function costSetPanelInner(panel, st) {
  const body = COST_SET_BODIES[panel] ? COST_SET_BODIES[panel](st) : '';
  if (!COST_SET_FORMS.includes(panel)) return body;
  return `<div data-cost-set-dirty="${esc(panel)}">${costSetDirtyHtml(panel, st)}</div>${body}${costSetSaveHtml(panel, st)}`;
}
function costSetPanelHtml(panel, title, st) {
  return `<details class="holo panel cost-set-panel" data-cost-set-panel="${esc(panel)}" ${st.open[panel] ? 'open' : ''}><summary><h3>${esc(title)}</h3></summary><div class="cost-set-body" data-cost-set-body="${esc(panel)}">${costSetPanelInner(panel, st)}</div></details>`;
}
/** The whole page from the state: the banner, then the four panels. */
function costSetPageHtml(st) {
  return costSetBannerHtml(st.answer) + COST_SET_PANELS.map(([p, title]) => costSetPanelHtml(p, title, st)).join('');
}

/* ---------- painting, keeping the keyboard where it was ---------- */

const COST_SET_FOCUS_ATTRS = [
  'data-cost-set-field',
  'data-cost-set-act',
  'data-cost-set-test',
  'data-cost-set-restate',
  'data-panel',
  'data-i',
  'data-src',
  'data-mode',
  'data-on',
];
// The focused control as attribute pairs (no selector is built from owner text), to find it again after a repaint.
function costSetFocusKey(el, root) {
  if (!el || !root || el === root || !root.contains(el) || !el.getAttribute) return null;
  const key = COST_SET_FOCUS_ATTRS.filter((a) => el.hasAttribute(a)).map((a) => [a, el.getAttribute(a)]);
  return key.length ? key : null;
}
function costSetRefocus(root, key) {
  if (!key) return;
  const el = [...root.querySelectorAll('input, select, button, textarea')].find(
    (x) => !x.disabled && key.every(([a, v]) => x.getAttribute(a) === v),
  );
  if (el) el.focus({ preventScroll: true });
}
function costSetPaint(focus) {
  const body = $('#cost-body');
  if (!body || costSub() !== 'settings' || !COST_SET.answer) return;
  const key = focus || costSetFocusKey(document.activeElement, body);
  body.innerHTML = costSetPageHtml(COST_SET);
  costSetRefocus(body, key);
}
// One panel's body, e.g. after a row was added; `focus` names the control to take the keyboard.
function costSetPaintPanel(panel, focus) {
  const host = [...document.querySelectorAll('#cost-app [data-cost-set-body]')].find(
    (el) => el.dataset.costSetBody === panel,
  );
  if (!host || !COST_SET.answer) return;
  const key = focus || costSetFocusKey(document.activeElement, host);
  host.innerHTML = costSetPanelInner(panel, COST_SET);
  costSetRefocus(host, key);
}
// After a change event the keyboard has moved on: repaint once it has landed.
const costSetPaintSoon = (panel) => setTimeout(() => costSetPaintPanel(panel), 0);
function costSetPaintDirty(panel) {
  const el = [...document.querySelectorAll('#cost-app [data-cost-set-dirty]')].find(
    (x) => x.dataset.costSetDirty === panel,
  );
  if (el) el.innerHTML = costSetDirtyHtml(panel, COST_SET);
}

/* ---------- load, save, discard ---------- */

async function costSetLoad(quiet) {
  const body = $('#cost-body');
  if (!body || costSub() !== 'settings') return;
  const my = ++COST.req;
  const live = () => my === COST.req && body.isConnected && costSub() === 'settings';
  try {
    const [answer, budgets, status] = await Promise.all([
      costGet('/api/cost/settings'),
      costGet('/api/cost/budgets').catch(() => null),
      costGet('/api/cost/status').catch(() => null),
    ]);
    if (!live()) return;
    COST.settings = answer; // the other cost pages read the same answer
    COST_SET.answer = answer;
    COST_SET.budgets = (budgets && budgets.budgets) || [];
    // No range, currency or measure here: the bar stays empty, the ribbon is the other pages' one.
    $('#cost-bar').innerHTML = '';
    $('#cost-ribbon').innerHTML = costRibbonHtml(status);
    for (const h of COST_SET_ON_LOAD) h();
    costSetPaint();
    const view = $('#view');
    if (!quiet && view && view.classList.contains('animate') && typeof settle === 'function') settle(view);
  } catch (e) {
    if (!live()) return;
    costShowError(body, e.message, false);
  }
}

// A Save: the saved settings are read again first, so a change made elsewhere since the page loaded is kept.
async function costSetSave(panel) {
  if (COST_SET.busy[panel] || costSetLocked(COST_SET.answer)) return;
  const draft = costSetDraftOf(panel);
  COST_SET.busy[panel] = true;
  costSetPaintPanel(panel);
  let saved = false;
  try {
    const fresh = await costGet('/api/cost/settings');
    if (fresh.error) {
      COST_SET.answer = fresh;
      COST.settings = fresh;
      COST_SET.msg[panel] = { tone: 'warn', text: fresh.error, reasons: fresh.reasons || [] };
      return;
    }
    const res = await costPost('/api/cost/settings', costSetBody(panel, fresh.settings, draft, fresh.sources));
    const j = res.json || {};
    if (res.status === 200) {
      saved = true;
      if (COST_SET.drafts[panel] === draft) delete COST_SET.drafts[panel];
      COST_SET.marks[panel] = [];
      COST_SET.gen++;
      COST_SET.msg[panel] =
        panel === 'currency' ? { tone: 'ok', text: 'Saved.' } : { tone: 'ok', text: COST_SET_APPLIES, restate: true };
      return;
    }
    COST_SET.marks[panel] = res.status === 400 ? costSetReasonPaths(j.reasons) : [];
    const reasons = Array.isArray(j.reasons) ? j.reasons : [];
    // 409 with reasons: budgets depend on the change. 409 without: config.json does not parse (CONFIG_BROKEN).
    COST_SET.msg[panel] = {
      tone: 'warn',
      text: j.error || `Could not save (${res.status})`,
      reasons,
      budgets: res.status === 409 && reasons.length > 0,
    };
  } catch (e) {
    COST_SET.msg[panel] = { tone: 'warn', text: e.message }; // the draft stays
  } finally {
    COST_SET.busy[panel] = false;
    if (saved) await costSetLoad(true);
    else costSetPaint();
  }
}

/* ---------- mount, unmount, events ---------- */

function costMountSettings() {
  costSetInstallEvents();
  if (!COST_SET.mounted) {
    COST_SET.mounted = true;
    onUnmount(costSetUnmount);
  }
  return costSetLoad(false);
}
// Leaving the page: answers in flight are dropped; the drafts stay for the next visit.
function costSetUnmount() {
  COST_SET.mounted = false;
  clearTimeout(COST_SET.previewTimer);
  COST_SET.previewTimer = null;
  COST_SET.previewReq++;
  COST_SET.restateReq++;
  COST_SET.historyReq++;
  COST_SET.restate.running = false;
  for (const p of COST_SET_FORMS) COST_SET.busy[p] = false;
}

Object.assign(COST_SET_ACTIONS, {
  save: (b) => void costSetSave(b.dataset.panel),
  discard: (b) => {
    const p = b.dataset.panel;
    delete COST_SET.drafts[p];
    COST_SET.marks[p] = [];
    COST_SET.msg[p] = null;
    costSetPaintPanel(p, [
      ['data-cost-set-act', 'save'],
      ['data-panel', p],
    ]);
    for (const h of COST_SET_ON_INPUT) h(b, p, null);
  },
});

function costSetInstallEvents() {
  if (COST_SET.hooked) return;
  COST_SET.hooked = true;
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('#cost-app [data-cost-set-act]');
    if (!t || t.disabled) return;
    const fn = COST_SET_ACTIONS[t.dataset.costSetAct];
    if (fn) fn(t);
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#cost-app')) return;
    const f = t.dataset.costSetField;
    if (!f) {
      for (const h of COST_SET_ON_INPUT) h(t, null, null);
      return;
    }
    const at = f.indexOf(':');
    const panel = f.slice(0, at);
    const path = f.slice(at + 1);
    costSetEdit(panel, (d) => costSetAssign(d, path, t.value));
    for (const h of COST_SET_ON_INPUT) h(t, panel, path);
    costSetPaintDirty(panel);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.closest || !t.closest('#cost-app')) return;
    // A select or a center name feeds other rows (Used by, the center choices): their panel is drawn again.
    if (t.hasAttribute('data-cost-set-repaint')) costSetPaintSoon(t.dataset.costSetField.split(':')[0]);
    for (const h of COST_SET_ON_CHANGE) h(t);
  });
  // A panel opened or closed (toggle does not bubble: caught on the way down).
  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!d.matches || !d.matches('#cost-app [data-cost-set-panel]')) return;
      COST_SET.open[d.dataset.costSetPanel] = d.open;
      if (d.open) for (const h of COST_SET_ON_OPEN) h(d.dataset.costSetPanel);
    },
    true,
  );
  // Drafts live as long as the tab: closing or reloading it with unsaved changes asks first.
  window.addEventListener('beforeunload', (e) => {
    if (!costSetAnyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_SET,
    COST_SET_PANELS,
    COST_SET_BODIES,
    COST_SET_ACTIONS,
    costSetFromSaved,
    costSetBody,
    costSetDirty,
    costSetAssign,
    costSetReasonPaths,
    costSetLocked,
    costSetMsgHtml,
    costSetSaveHtml,
    costSetBannerHtml,
    costSetPageHtml,
    costSetAnyDirty,
    costSetEdit,
    costSetDraftOf,
    costSetSave,
    costSetLoad,
    costSetUnmount,
    costMountSettings,
  };
