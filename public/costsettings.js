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

// The order a Save sends rates in (stable): the draft is sorted the same way so the server's indices match its rows.
const costSetByFrom = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);

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
            rates: c.rates.map((r) => ({ from: r.from, perUSD: costSetNum(r.perUSD) })).sort(costSetByFrom),
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
    loading: false,
  },
  restateReq: 0,
  savesPending: 0, // Saves started and not yet answered: Run restate waits for them
  saving: null, // the chain of Saves in flight
  history: null, // GET /api/cost/restates → restates
  historyError: null,
  historyLoading: false,
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
// Saves run one after another: each one's read of the settings follows the previous one's write.
function costSetSave(panel) {
  if (COST_SET.busy[panel] || costSetLocked(COST_SET.answer)) return Promise.resolve();
  COST_SET.busy[panel] = true;
  COST_SET.savesPending++;
  costSetPaintPanel(panel);
  costSetPaintPanel('restate');
  const run = (COST_SET.saving || Promise.resolve()).then(() => costSetSaveRun(panel));
  COST_SET.saving = run.catch(() => {});
  return run;
}
async function costSetSaveRun(panel) {
  let saved = false;
  try {
    const fresh = await costGet('/api/cost/settings');
    if (fresh.error) {
      COST_SET.answer = fresh;
      COST.settings = fresh;
      COST_SET.msg[panel] = { tone: 'warn', text: fresh.error, reasons: fresh.reasons || [] };
      return;
    }
    // No draft: nothing was changed here, and the panel would be built from the page-load answer, not from `fresh`.
    if (!COST_SET.drafts[panel]) {
      COST_SET.msg[panel] = { tone: 'ok', text: 'Nothing to save.' };
      return;
    }
    const draft = COST_SET.drafts[panel];
    if (panel === 'currency' && COST_SET.drafts.currency && draft.currency.on === 'on') {
      draft.currency.rates.sort(costSetByFrom);
      costSetPaintPanel(panel);
    }
    const sent = JSON.stringify(costSetBody(panel, fresh.settings, draft, fresh.sources));
    const res = await costPost('/api/cost/settings', JSON.parse(sent));
    const j = res.json || {};
    if (res.status === 200) {
      saved = true;
      // Typing while the Save ran changes the draft in place: it goes only if it still says what was sent.
      const now = COST_SET.drafts[panel];
      if (!now || JSON.stringify(costSetBody(panel, fresh.settings, now, fresh.sources)) === sent)
        delete COST_SET.drafts[panel];
      else if (panel === 'rules') {
        // A kept draft: its centers that went out are saved now, so their ids are fixed.
        const sentIds = new Set(JSON.parse(sent).centers.map((c) => c.id));
        for (const c of now.centers) if (c.isNew && sentIds.has(String(c.id ?? '').trim())) c.isNew = false;
      }
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
    COST_SET.savesPending = Math.max(0, COST_SET.savesPending - 1);
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
  COST_SET.historyLoading = false;
  // A run in flight is dropped with its answer, but the correction may have been recorded: no second click, and the
  // held history reloads.
  if (COST_SET.restate.running) {
    Object.assign(COST_SET.restate, { preview: null, of: null, reason: '', ack: false });
    COST_SET.history = null;
  }
  COST_SET.restate.running = false;
  COST_SET.restate.loading = false;
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
      const was = COST_SET.open[d.dataset.costSetPanel];
      COST_SET.open[d.dataset.costSetPanel] = d.open;
      if (d.open && !was) for (const h of COST_SET_ON_OPEN) h(d.dataset.costSetPanel);
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

/* ---------- panel: cost centers & rules, with the server preview ---------- */

const COST_SET_RESERVED_IDS = ['unassigned', 'all', '__proto__', 'constructor', 'prototype'];

/** A new center's id from its name (R5): lowercase a-z0-9 and dashes, at most 40, with -2, -3, … when taken. */
function costSetCenterId(name, taken = []) {
  const base =
    String(name || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'center';
  const used = new Set([...taken, ...COST_SET_RESERVED_IDS]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const id = base.slice(0, 40 - tail.length).replace(/-+$/, '') + tail;
    if (!used.has(id)) return id;
  }
}
/** What points at each center: gateway keys (by name), folder rules (#k) and budgets (by name). */
function costSetCenterUse(draft, keys, budgets) {
  const out = {};
  const at = (id) => (out[id] = out[id] || { keys: [], rules: [], budgets: [] });
  const names = new Map((keys || []).map((k) => [k.id, k.name || k.id]));
  for (const [key, center] of Object.entries(draft.keyCenters || {})) at(center).keys.push(names.get(key) || key);
  (draft.folderRules || []).forEach((r, i) => {
    if (r.center) at(r.center).rules.push(i + 1);
  });
  for (const b of budgets || [])
    if (b && b.scope && b.scope.dim === 'center') at(String(b.scope.value)).budgets.push(b.name || b.id);
  return out;
}
/** Why a center cannot be deleted ("In use: key ci-bot, rule #2"), or '' when it can. Budgets do not block the form:
 *  the server refuses that Save (409) and names them. */
function costSetDeleteBlock(use) {
  if (!use || (!use.keys.length && !use.rules.length)) return '';
  return 'In use: ' + [...use.keys.map((k) => 'key ' + k), ...use.rules.map((k) => 'rule #' + k)].join(', ');
}
/** "Key ci-bot, Rule #2, Budget Team", or "—". */
function costSetUsedBy(use) {
  if (!use) return '—';
  const all = [
    ...use.keys.map((k) => 'Key ' + k),
    ...use.rules.map((k) => 'Rule #' + k),
    ...use.budgets.map((b) => 'Budget ' + b),
  ];
  return all.length ? all.join(', ') : '—';
}
/** The rule "Create rule" adds for an Unassigned project: the folder itself and everything below it. */
const costSetRuleGlob = (project) => `${String(project).replace(/\/+$/, '')}/**`;
/** A center as people read it: its name, Unassigned, or its id when the settings no longer name it. */
function costSetCenterName(id, centers) {
  if (id == null || id === 'unassigned') return 'Unassigned';
  const c = (centers || []).find((x) => x.id === id);
  return c ? c.name || c.id : String(id);
}
// The settings preview's answer is for the draft on screen when it was asked with the rules sent now.
function costSetPreviewCurrent(st) {
  const p = st.preview;
  if (!p || !p.sent || !st.answer) return false;
  const now = costSetBody(
    'rules',
    st.answer.settings,
    st.drafts.rules || costSetFromSaved('rules', st.answer.settings, st.answer.sources),
    st.answer.sources,
  );
  const pick = (x) => JSON.stringify([x.centers, x.keyCenters, x.folderRules]);
  return pick(now) === pick(p.sent);
}
/** The warning beside rule i: "Matches nothing in the last 30 days" or "Never used: rule #k above takes every path it
 *  matches", from a preview of the draft on screen. */
function costSetWarnText(st, i) {
  const a = st.preview && st.preview.answer;
  const r = a && costSetPreviewCurrent(st) && a.rules.find((x) => x.index === i);
  if (!r) return '';
  if (r.status === 'none') return 'Matches nothing in the last 30 days';
  if (r.status === 'shadowed') return `Never used: rule #${r.by + 1} above takes every path it matches`;
  return '';
}

function costSetRulesHtml(st) {
  const a = st.answer || {};
  const d = st.drafts.rules || costSetFromSaved('rules', a.settings, a.sources);
  const keys = a.keys || [];
  const use = costSetCenterUse(d, keys, st.budgets);
  const f = (path) => costSetField('rules', path, st);
  const opt = (v, text, on) => `<option value="${esc(v)}" ${v === on ? 'selected' : ''}>${esc(text)}</option>`;
  const centerOpts = (on) =>
    d.centers
      .filter((c) => c.id)
      .map((c) => opt(c.id, c.name || c.id, on))
      .join('');
  const centers = d.centers
    .map((c, i) => {
      const block = costSetDeleteBlock(use[c.id]);
      const budgets =
        use[c.id] && use[c.id].budgets.length && !block ? 'Budgets use it: the Save is refused until they change' : '';
      const id = c.isNew
        ? `<input class="input" ${f(`centers.${i}.id`)} data-cost-set-repaint maxlength="40" value="${esc(c.id)}" aria-label="Id of center ${i + 1}" autocomplete="off">`
        : `<code>${esc(c.id)}</code>`;
      return `<tr><td><input class="input" ${f(`centers.${i}.name`)} data-cost-set-repaint maxlength="60" value="${esc(c.name)}" aria-label="Name of center ${i + 1}" autocomplete="off"></td><td>${id}</td><td>${esc(costSetUsedBy(use[c.id]))}</td><td><button type="button" class="btn ghost danger" data-cost-set-act="del-center" data-i="${i}" ${block ? 'disabled' : ''} title="${esc(block || budgets)}">Delete</button></td></tr>`;
    })
    .join('');
  const fullCenters = d.centers.length >= COST_SET_LIMITS.centers;
  const keyRows = keys
    .map(
      (k) =>
        `<tr><td>${esc(k.name || k.id)} <small>${esc(k.id)}</small></td><td><select class="input" ${f('keyCenters.' + k.id)} data-cost-set-repaint aria-label="${esc('Center of key ' + (k.name || k.id))}">${opt('', 'Folder rules decide', d.keyCenters[k.id] || '')}${centerOpts(d.keyCenters[k.id] || '')}</select></td></tr>`,
    )
    .join('');
  const gone = Object.keys(d.keyCenters).filter((id) => !keys.some((k) => k.id === id));
  const goneHtml = gone.length
    ? `<p class="cost-note warn">Key no longer exists</p><ul class="cost-set-unassigned">${gone
        .map(
          (id, i) =>
            `<li><code>${esc(id)}</code><span>${esc('→ ' + costSetCenterName(d.keyCenters[id], d.centers))}</span><button type="button" class="btn ghost" data-cost-set-act="remove-key" data-i="${i}">Remove</button></li>`,
        )
        .join('')}</ul>`
    : '';
  const rules = d.folderRules
    .map((r, i) => {
      const k = i + 1;
      return `<li class="cost-set-rule"><span class="cost-set-num">#${k}</span><input class="input" ${f(`folderRules.${i}.glob`)} maxlength="300" value="${esc(r.glob)}" aria-label="Glob of rule #${k}" autocomplete="off" spellcheck="false"><select class="input" ${f(`folderRules.${i}.center`)} data-cost-set-repaint aria-label="Center of rule #${k}">${opt('', 'Choose a center', r.center || '')}${centerOpts(r.center || '')}</select><span class="cost-set-actions"><button type="button" class="btn ghost" data-cost-set-act="rule-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move rule #${k} up">Up</button><button type="button" class="btn ghost" data-cost-set-act="rule-down" data-i="${i}" ${i === d.folderRules.length - 1 ? 'disabled' : ''} aria-label="Move rule #${k} down">Down</button><button type="button" class="btn ghost danger" data-cost-set-act="del-rule" data-i="${i}" aria-label="Delete rule #${k}">Delete</button></span><span class="cost-set-warn" data-cost-set-warn="${i}">${esc(costSetWarnText(st, i))}</span></li>`;
    })
    .join('');
  const fullRules = d.folderRules.length >= COST_SET_LIMITS.folderRules;
  const noCenter = !d.centers.some((c) => c.id);
  return `<div class="cost-set-grid"><div class="cost-set-forms">
    <h4>Cost centers</h4>
    <table class="cost-table cost-set-table"><thead><tr><th>Name</th><th>Id</th><th>Used by</th><th></th></tr></thead><tbody>${centers || '<tr><td colspan="4">No cost centers yet.</td></tr>'}</tbody></table>
    <div><button type="button" class="btn ghost" data-cost-set-act="add-center" ${fullCenters ? `disabled title="At most ${COST_SET_LIMITS.centers} cost centers"` : ''}>Add</button></div>
    <h4>Gateway keys</h4>
    <p class="cost-note">A key's center always wins over folder rules.</p>
    ${keyRows ? `<table class="cost-table cost-set-table"><tbody>${keyRows}</tbody></table>` : '<p class="cost-note">No gateway keys. Keys are managed on the Gateway page.</p>'}
    ${goneHtml}
    <h4>Folder rules</h4>
    <p class="cost-note">The first matching rule wins; a path no rule matches is Unassigned.</p>
    <p class="cost-note">Globs: <code>*</code> stays in one folder, <code>**</code> crosses folders, a trailing <code>/**</code> also matches the folder itself; start with <code>~</code>, <code>/</code> or a drive letter.</p>
    ${rules ? `<ol class="cost-set-rules">${rules}</ol>` : '<p class="cost-note">No folder rules yet.</p>'}
    <div><button type="button" class="btn ghost" data-cost-set-act="add-rule" ${fullRules || noCenter ? `disabled title="${fullRules ? `At most ${COST_SET_LIMITS.folderRules} folder rules` : 'Add a cost center first'}"` : ''}>Add</button></div>
  </div><aside class="cost-set-preview" aria-label="Preview" aria-busy="false">
    <div data-cost-set-preview-body>${costSetPreviewHtml(st)}</div>
    <div class="cost-set-test"><label>Test a path<input class="input" data-cost-set-test value="${esc(st.testPath)}" maxlength="1000" placeholder="~/Github/acme/web" autocomplete="off" spellcheck="false"></label><div data-cost-set-test-out role="status">${costSetTestHtml(st)}</div></div>
  </aside></div>`;
}

/** The preview column: moves, Unassigned projects with Create rule, or the draft's reasons, or the error with Retry. */
function costSetPreviewHtml(st) {
  const p = st.preview;
  if (!p) return '<p class="cost-note">The preview is loading…</p>';
  if (p.error)
    return `<p class="cost-note warn">The preview could not load: ${esc(p.error)}</p><button type="button" class="btn ghost" data-cost-set-act="retry-preview">Retry</button>`;
  if (p.reasons)
    return `<p class="cost-note warn">This draft does not validate; Save would answer with the same reasons:</p>${costReasonsHtml(p.reasons)}`;
  const a = p.answer;
  const saved = (st.answer && st.answer.settings) || {};
  const drafted = (p.sent && p.sent.centers) || [];
  const moves = a.moves.length
    ? `<table class="cost-table cost-set-moves"><tbody>${a.moves
        .map(
          (m) =>
            `<tr><td>${esc(m.project != null ? m.project : 'Key: ' + (m.keyName || m.keyId))}</td><td class="num">${esc(costMoney(m.listUSD))}</td><td>${esc(costSetCenterName(m.from, saved.centers) + ' → ' + costSetCenterName(m.to, drafted))}</td></tr>`,
        )
        .join('')}</tbody></table>${a.more ? `<p class="cost-note">and ${Number(a.more)} more</p>` : ''}`
    : '<p class="cost-note">No project or key changes center.</p>';
  const full =
    ((st.drafts.rules && st.drafts.rules.folderRules) || saved.folderRules || []).length >= COST_SET_LIMITS.folderRules;
  const unassigned = a.unassigned.length
    ? `<ul class="cost-set-unassigned">${a.unassigned
        .map(
          (u, i) =>
            `<li><span>${esc(u.project)}</span><span class="num">${esc(costMoney(u.listUSD))}</span><button type="button" class="btn ghost" data-cost-set-act="create-rule" data-i="${i}" ${full ? 'disabled' : ''}>Create rule</button></li>`,
        )
        .join('')}</ul>`
    : '<p class="cost-note">No project of the last 30 days is Unassigned.</p>';
  const notes = (a.unread || []).map((u) => `<p class="cost-note warn">${esc(costUnreadText(u))}</p>`).join('');
  return `${notes}<h4>Moves</h4><p class="cost-note">The last 30 days in USD: center now → under this draft.</p>${moves}<h4>Unassigned</h4>${unassigned}`;
}
/** Where the typed test path goes: "Acme · rule #3 ~/Github/acme/**", or "Unassigned, no rule matches". */
function costSetTestHtml(st) {
  const p = st.preview;
  const t = p && p.answer && p.answer.test;
  const typed = String(st.testPath || '').trim();
  if (!typed || !t || p.path !== typed) return ''; // the result belongs to the path it was asked for
  if (t.rule == null) return '<p>Unassigned, no rule matches</p>';
  const r = (p.sent.folderRules || [])[t.rule] || {};
  return `<p>${esc(costSetCenterName(t.center, p.sent.centers))} · rule #${t.rule + 1} <code>${esc(r.glob)}</code></p>`;
}

// The preview follows the rules draft about 400 ms after its last edit; a newer request supersedes an older one.
function costSetSchedulePreview(ms = COST_SET_PREVIEW_MS) {
  clearTimeout(COST_SET.previewTimer);
  COST_SET.previewTimer = setTimeout(() => void costSetRunPreview(), ms);
}
async function costSetRunPreview() {
  const a = COST_SET.answer;
  if (!a) return;
  const body = { settings: costSetBody('rules', a.settings, costSetDraftOf('rules'), a.sources) };
  const path = String(COST_SET.testPath || '').trim();
  if (path) body.testPath = path;
  const my = ++COST_SET.previewReq;
  const aside = document.querySelector('#cost-app .cost-set-preview');
  if (aside) aside.setAttribute('aria-busy', 'true');
  let next;
  try {
    const r = await costPost('/api/cost/settings/preview', body);
    const j = r.json || {};
    next =
      r.status === 200
        ? { sent: body.settings, answer: j, path: body.testPath || '' }
        : r.status === 400 && Array.isArray(j.reasons)
          ? { sent: body.settings, reasons: j.reasons }
          : { error: j.error || `request failed (${r.status})` };
  } catch (e) {
    next = { error: e.message };
  }
  if (my !== COST_SET.previewReq) return; // a newer draft was sent meanwhile, or the page was left
  COST_SET.preview = next;
  costSetPaintPreview();
}
// The preview's parts on screen, without touching the forms (the owner may be typing in one).
function costSetPaintPreview() {
  const host = document.querySelector('#cost-app [data-cost-set-preview-body]');
  if (host) {
    host.innerHTML = costSetPreviewHtml(COST_SET);
  }
  const aside = document.querySelector('#cost-app .cost-set-preview');
  if (aside) aside.setAttribute('aria-busy', 'false');
  const out = document.querySelector('#cost-app [data-cost-set-test-out]');
  if (out) out.innerHTML = costSetTestHtml(COST_SET);
  for (const el of document.querySelectorAll('#cost-app [data-cost-set-warn]'))
    el.textContent = costSetWarnText(COST_SET, Number(el.dataset.costSetWarn));
}

// A structural edit of the rules: the draft changes, the panel is drawn again, and the preview follows.
function costSetRulesEdit(fn, focus) {
  costSetEdit('rules', fn);
  costSetPaintPanel('rules', focus);
  costSetSchedulePreview();
}
/** Where the keyboard goes after a rule moved to index `to` of `len`: its own button, or the other direction's when
 *  the move left that one disabled (first or last place). */
function costSetMoveFocus(act, to, len) {
  const end = act === 'rule-up' ? to === 0 : to === len - 1;
  const use = end ? (act === 'rule-up' ? 'rule-down' : 'rule-up') : act;
  return [
    ['data-cost-set-act', use],
    ['data-i', String(to)],
  ];
}
const costSetAt = (b) => Number(b.dataset.i);
Object.assign(COST_SET_ACTIONS, {
  'add-center': () => {
    const d = costSetDraftOf('rules');
    if (d.centers.length >= COST_SET_LIMITS.centers) return;
    const i = d.centers.length;
    costSetRulesEdit(
      (x) => x.centers.push({ id: '', name: '', isNew: true, idEdited: false, prevId: '' }),
      [['data-cost-set-field', `rules:centers.${i}.name`]],
    );
  },
  'del-center': (b) => costSetRulesEdit((x) => x.centers.splice(costSetAt(b), 1)),
  'remove-key': (b) =>
    costSetRulesEdit((x) => {
      const keys = (COST_SET.answer && COST_SET.answer.keys) || [];
      const gone = Object.keys(x.keyCenters).filter((id) => !keys.some((k) => k.id === id));
      delete x.keyCenters[gone[costSetAt(b)]];
    }),
  'add-rule': () => {
    const d = costSetDraftOf('rules');
    if (d.folderRules.length >= COST_SET_LIMITS.folderRules) return;
    const i = d.folderRules.length;
    costSetRulesEdit(
      (x) => x.folderRules.push({ glob: '', center: '' }),
      [['data-cost-set-field', `rules:folderRules.${i}.glob`]],
    );
  },
  'rule-up': (b) => {
    const i = costSetAt(b);
    if (i < 1) return;
    costSetRulesEdit(
      (x) => x.folderRules.splice(i - 1, 0, ...x.folderRules.splice(i, 1)),
      costSetMoveFocus('rule-up', i - 1, costSetDraftOf('rules').folderRules.length),
    );
  },
  'rule-down': (b) => {
    const i = costSetAt(b);
    if (i >= costSetDraftOf('rules').folderRules.length - 1) return;
    costSetRulesEdit(
      (x) => x.folderRules.splice(i + 1, 0, ...x.folderRules.splice(i, 1)),
      costSetMoveFocus('rule-down', i + 1, costSetDraftOf('rules').folderRules.length),
    );
  },
  'del-rule': (b) => costSetRulesEdit((x) => x.folderRules.splice(costSetAt(b), 1)),
  // An Unassigned project gets a rule for its folder; the keyboard goes to the new rule's center.
  'create-rule': (b) => {
    const u = COST_SET.preview && COST_SET.preview.answer && COST_SET.preview.answer.unassigned[costSetAt(b)];
    const d = costSetDraftOf('rules');
    if (!u || d.folderRules.length >= COST_SET_LIMITS.folderRules) return;
    const field = `rules:folderRules.${d.folderRules.length}.center`;
    costSetRulesEdit(
      (x) => x.folderRules.push({ glob: costSetRuleGlob(u.project), center: '' }),
      [['data-cost-set-field', field]],
    );
    const sel = [...document.querySelectorAll('#cost-app [data-cost-set-field]')].find(
      (el) => el.dataset.costSetField === field,
    );
    if (sel) sel.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  },
  'retry-preview': () => costSetSchedulePreview(0),
});
// A typed edit of the rules panel (or the test path). A new center's id follows its name until the owner types one,
// and the keys and rules that chose it follow its id; a saved center's id never changes.
function costSetRulesInput(t, panel, path) {
  if (t.hasAttribute && t.hasAttribute('data-cost-set-test')) {
    COST_SET.testPath = t.value;
    return costSetSchedulePreview();
  }
  if (panel !== 'rules') return;
  const m = path && /^centers\.(\d+)\.(name|id)$/.exec(path);
  const d = COST_SET.drafts.rules;
  const c = m && d.centers[Number(m[1])];
  if (c && c.isNew) {
    const was = c.prevId ?? '';
    if (m[2] === 'id') c.idEdited = true;
    else if (!c.idEdited) {
      c.id = costSetCenterId(
        c.name,
        d.centers.filter((x) => x !== c).map((x) => x.id),
      );
      const el = [...document.querySelectorAll('#cost-app [data-cost-set-field]')].find(
        (x) => x.dataset.costSetField === `rules:centers.${m[1]}.id`,
      );
      if (el) el.value = c.id;
    }
    // Follow only a reference this center made: not another center's id passed on the way, not an emptied field. While
    // the id equals another center's, the references stay where they were and follow once it is its own again.
    const other = (id) => d.centers.some((x) => x !== c && x.id === id);
    if (c.id && !other(c.id)) {
      if (was && was !== c.id && !other(was)) {
        for (const [k, v] of Object.entries(d.keyCenters)) if (v === was) d.keyCenters[k] = c.id;
        for (const r of d.folderRules) if (r.center === was) r.center = c.id;
      }
      c.prevId = c.id;
    }
  }
  costSetSchedulePreview();
}
COST_SET_ON_INPUT.push(costSetRulesInput);
COST_SET_BODIES.rules = costSetRulesHtml;
COST_SET_ON_LOAD.push(() => costSetSchedulePreview(0));

/* ---------- panels: billing and display currency ---------- */

const COST_SET_PLAN_NOTE =
  'The plan fee is spread over the days of its period and counted as paid. Usage on this source counts as usage value only.';
const COST_SET_RATE_NOTE =
  'Rates convert at read time: a change here also changes how past days read in this currency. USD amounts never change.';

function costSetBillingHtml(st) {
  const a = st.answer || {};
  const sources = a.sources || Object.keys(COST_SOURCES);
  const d = st.drafts.billing || costSetFromSaved('billing', a.settings, sources);
  const f = (path) => costSetField('billing', path, st);
  return sources
    .map((src) => {
      const b = d.billing[src] || { mode: 'metered', plan: '', feeUSD: '', period: 'month' };
      const label = COST_SOURCES[src] || src;
      const seg = ['metered', 'plan']
        .map(
          (m) =>
            `<button type="button" data-cost-set-act="mode" data-src="${esc(src)}" data-mode="${m}" aria-pressed="${b.mode === m}">${m === 'plan' ? 'Plan' : 'Metered'}</button>`,
        )
        .join('');
      const plan =
        b.mode === 'plan'
          ? `<div class="cost-row"><label>Plan name<input class="input" ${f(`billing.${src}.plan`)} maxlength="60" value="${esc(b.plan)}" autocomplete="off"></label><label>Fee in USD<input class="input" ${f(`billing.${src}.feeUSD`)} type="number" min="0" max="1000000" step="any" value="${esc(b.feeUSD)}"></label><label>Period<select class="input" ${f(`billing.${src}.period`)}><option value="month" ${b.period === 'month' ? 'selected' : ''}>Month</option><option value="year" ${b.period === 'year' ? 'selected' : ''}>Year</option></select></label></div><p class="cost-note">${esc(COST_SET_PLAN_NOTE)}</p>`
          : '';
      return `<div class="cost-set-source"><div class="cost-set-source-head"><b>${esc(label)}</b><div class="segmented" role="group" aria-label="${esc('Billing of ' + label)}">${seg}</div></div>${plan}</div>`;
    })
    .join('');
}

/** Today's rate (R8): the latest valid rate whose start is on or before `today`, as rateFor picks it, or null. */
function costSetRateToday(rates, today) {
  let hit = null;
  for (const r of rates || []) {
    const v = costSetNum(r.perUSD);
    if (!costIsDay(r.from) || !(Number.isFinite(v) && v > 0) || r.from > today) continue;
    if (!hit || r.from >= hit.from) hit = { from: r.from, perUSD: v };
  }
  return hit;
}
/** "Today: 1 USD = 16,250 IDR (rate from 2026-10-01)", or that no rate applies yet. */
function costSetRateLine(code, hit) {
  if (!hit) return 'Today: no rate starts on or before today.';
  const cur =
    String(code || '')
      .trim()
      .toUpperCase() || 'units';
  // Plain text, escaped where it is drawn.
  return (
    'Today: 1 USD = ' +
    hit.perUSD.toLocaleString('en', { maximumFractionDigits: 4 }) +
    ' ' +
    cur +
    ' (rate from ' +
    hit.from +
    ')'
  );
}

function costSetCurrencyHtml(st) {
  const a = st.answer || {};
  const c = (st.drafts.currency || costSetFromSaved('currency', a.settings, a.sources)).currency;
  const f = (path) => costSetField('currency', path, st);
  const today = st.today || costToday();
  const seg = [
    ['off', 'USD only'],
    ['on', 'USD + display currency'],
  ]
    .map(
      ([v, text]) =>
        `<button type="button" data-cost-set-act="cur-on" data-on="${v}" aria-pressed="${c.on === v}">${text}</button>`,
    )
    .join('');
  if (c.on !== 'on') return `<div class="segmented" role="group" aria-label="Currency">${seg}</div>`;
  const rows = c.rates
    .map(
      (r, i) =>
        `<tr><td><input class="input" type="date" ${f(`currency.rates.${i}.from`)} value="${esc(r.from)}" aria-label="Start date of rate ${i + 1}"></td><td><input class="input" type="number" min="0" step="any" ${f(`currency.rates.${i}.perUSD`)} value="${esc(r.perUSD)}" aria-label="Units per 1 USD of rate ${i + 1}"></td><td><button type="button" class="btn ghost danger" data-cost-set-act="del-rate" data-i="${i}">Delete</button></td></tr>`,
    )
    .join('');
  const full = c.rates.length >= COST_SET_LIMITS.rates;
  return `<div class="segmented" role="group" aria-label="Currency">${seg}</div>
    <label>Code<input class="input" ${f('currency.code')} maxlength="3" value="${esc(c.code)}" placeholder="IDR" autocomplete="off"></label>
    <table class="cost-table cost-set-table"><thead><tr><th>Start date</th><th>Units per 1 USD</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3">No rates yet.</td></tr>'}</tbody></table>
    <div><button type="button" class="btn ghost" data-cost-set-act="add-rate" ${full ? `disabled title="At most ${COST_SET_LIMITS.rates} rates"` : ''}>Add</button></div>
    <p class="cost-set-today" data-cost-set-rate>${esc(costSetRateLine(c.code, costSetRateToday(c.rates, today)))}</p>
    <p class="cost-note">${esc(COST_SET_RATE_NOTE)}</p>`;
}

Object.assign(COST_SET_ACTIONS, {
  mode: (b) => {
    const src = b.dataset.src;
    costSetEdit('billing', (d) => {
      d.billing[src] = { ...(d.billing[src] || { plan: '', feeUSD: '', period: 'month' }), mode: b.dataset.mode };
    });
    costSetPaintPanel('billing');
  },
  'cur-on': (b) => {
    costSetEdit('currency', (d) => (d.currency.on = b.dataset.on === 'on' ? 'on' : 'off'));
    costSetPaintPanel('currency');
  },
  'add-rate': () => {
    const d = costSetDraftOf('currency');
    if (d.currency.rates.length >= COST_SET_LIMITS.rates) return;
    const i = d.currency.rates.length;
    costSetEdit('currency', (x) => x.currency.rates.push({ from: costToday(), perUSD: '' }));
    costSetPaintPanel('currency', [['data-cost-set-field', `currency:currency.rates.${i}.perUSD`]]);
  },
  'del-rate': (b) => {
    costSetEdit('currency', (x) => x.currency.rates.splice(Number(b.dataset.i), 1));
    COST_SET.marks.currency = []; // the marks name rows by index: they would shift onto the next row
    costSetPaintPanel('currency');
  },
});
// Today's rate follows the rates and the code as they are typed.
COST_SET_ON_INPUT.push((t, panel) => {
  if (panel !== 'currency') return;
  const el = document.querySelector('#cost-app [data-cost-set-rate]');
  const c = costSetDraftOf('currency').currency;
  if (el) el.textContent = costSetRateLine(c.code, costSetRateToday(c.rates, costToday()));
});
COST_SET_BODIES.billing = costSetBillingHtml;
COST_SET_BODIES.currency = costSetCurrencyHtml;

/* ---------- panel: restate ---------- */

const COST_SET_MAX_REASON = 200; // lib/cost/api.js MAX_REASON
const COST_SET_RESTATE_TEXT =
  "Restate recomputes a past range with today's prices, rules and billing, and records the result as a correction. It cannot be undone. Today is never restated: it follows the current settings already.";

/** The default restate range (R6): the first of this month to yesterday; on the 1st, the whole previous month. */
function costSetRestateRange(today) {
  const to = costAddDays(today, -1);
  return { from: `${to.slice(0, 8)}01`, to };
}
/** The server's check of a restate range, in its words and order (R6), or null when it passes. */
function costSetRestateCheck(from, to, today) {
  if (!costIsDay(from) || !costIsDay(to)) return 'from and to are dates (YYYY-MM-DD)';
  if (from > to) return 'from must be on or before to';
  if (costAddDays(from, COST_MAX_DAYS) <= to) return `at most ${COST_MAX_DAYS} days at a time`;
  if (to >= today) return 'today follows the current prices and rules already; restate up to yesterday';
  return null;
}
/** A restate preview against the range on screen and the settings generation (R7). */
function costSetPreviewState(r, gen) {
  if (!r || !r.preview || !r.of) return 'none';
  if (r.of.from !== r.from || r.of.to !== r.to) return 'stale-range';
  if (r.of.gen !== gen) return 'stale-settings';
  return 'fresh';
}
/** Run restate: a fresh preview, a reason of 1-200 characters, the box checked, settings that read (R7). */
function costSetCanRun(r, gen, locked, pending = COST_SET.savesPending) {
  const why = String((r && r.reason) || '').trim();
  return (
    !locked &&
    !pending && // a Save in flight changes the settings the preview did not show
    !r.running &&
    !r.loading &&
    costSetPreviewState(r, gen) === 'fresh' &&
    why.length >= 1 &&
    why.length <= COST_SET_MAX_REASON &&
    r.ack === true
  );
}
// Plain text, escaped where it is drawn.
const costSetPlanText = (b) =>
  b.mode === 'plan'
    ? 'Plan ' + b.plan + ', ' + costMoney(b.feeUSD) + ' per ' + (b.period === 'year' ? 'year' : 'month')
    : 'Metered';

/** What a restate preview answers, as the panel lists it. */
function costSetRestateSummaryHtml(p, centers) {
  const billing = `<li>Billing set over the range: ${(p.billing || [])
    .map((b) => esc((COST_SOURCES[b.source] || b.source) + ': ' + costSetPlanText(b)))
    .join('; ')}</li>`;
  if (!p.changed)
    return `<ul class="cost-set-summary">${billing}</ul><p class="cost-note">No ledger row changes. The billing above is still set over the range.</p>`;
  const diff = p.afterUSD - p.beforeUSD;
  const moves = (p.moves || [])
    .map(
      (m) =>
        `<li>${esc(costSetCenterName(m.from, centers) + ' → ' + costSetCenterName(m.to, centers) + ': ' + costMoney(m.listUSD))}</li>`,
    )
    .join('');
  const before = (p.versionsBefore || []).map((v) => (v == null ? 'no version' : `version ${v}`)).join(', ');
  const after = p.newPrices ? "today's prices, not yet recorded as a version" : `version ${p.version}`;
  return `<ul class="cost-set-summary">
    <li>Rows: ${Number(p.changed)} ledger rows change, out of ${Number(p.total)} in the range.</li>
    <li>Usage value: ${esc(costMoney(p.beforeUSD))} → ${esc(costMoney(p.afterUSD))} (${diff > 0 ? '+' : ''}${esc(costMoney(diff))})</li>
    ${moves ? `<li>Center moves (usage value):<ul>${moves}</ul></li>` : ''}
    <li>${esc('Prices: ' + before + ' → ' + after)}</li>
    ${billing}</ul>`;
}

function costSetHistoryHtml(st) {
  if (st.historyError)
    return `<p class="cost-note warn">${esc(st.historyError)}</p><button type="button" class="btn ghost" data-cost-set-act="retry-history">Retry</button>`;
  if (!st.history) return '<p class="cost-note">Loading…</p>';
  if (!st.history.length) return '<p class="cost-note">No restate yet.</p>';
  return `<table class="cost-table"><thead><tr><th>When</th><th>Range</th><th>Reason</th><th class="num">Rows changed</th><th class="num">Price version</th></tr></thead><tbody>${st.history
    .map(
      (c) =>
        `<tr><td>${esc(new Date(c.ts).toLocaleString('en'))}</td><td>${esc(c.from + ' – ' + c.to)}</td><td>${esc(c.reason)}</td><td class="num">${Number(c.rows)}</td><td class="num">${esc(c.priceVersion ?? '—')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function costSetRestateHtml(st) {
  const r = st.restate;
  const today = st.today || costToday();
  const locked = costSetLocked(st.answer);
  const check = costSetRestateCheck(r.from, r.to, today);
  const state = costSetPreviewState(r, st.gen);
  const centers = (st.answer && st.answer.settings && st.answer.settings.centers) || [];
  const stale =
    state === 'stale-range'
      ? '<p class="cost-note warn">Range changed: preview again</p>'
      : state === 'stale-settings'
        ? '<p class="cost-note warn">Settings changed: preview again</p>'
        : '';
  const preview = r.preview
    ? `${stale}<div class="${state === 'fresh' ? '' : 'cost-set-stale'}">${costSetRestateSummaryHtml(r.preview, centers)}</div>
      <div class="cost-set-confirm"><label>Reason<input class="input" data-cost-set-restate="reason" maxlength="${COST_SET_MAX_REASON}" value="${esc(r.reason)}" autocomplete="off"></label>
      <label class="cost-check"><input type="checkbox" data-cost-set-restate="ack" ${r.ack ? 'checked' : ''}> I understand this correction cannot be undone</label>
      <div class="cost-set-save"><button type="button" class="btn danger" data-cost-set-act="restate-run" ${costSetCanRun(r, st.gen, locked, st.savesPending) ? '' : 'disabled'}>Run restate</button>${locked ? '<span class="cost-note">Fix config.json first</span>' : ''}</div></div>`
    : '';
  return `<p>${esc(COST_SET_RESTATE_TEXT)}</p>
    <div class="cost-row"><label>From<input class="input" type="date" data-cost-set-restate="from" value="${esc(r.from)}" max="${esc(costAddDays(today, -1))}"></label><label>To<input class="input" type="date" data-cost-set-restate="to" value="${esc(r.to)}" max="${esc(costAddDays(today, -1))}"></label></div>
    ${check ? `<p class="cost-note warn" role="alert">${esc(check)}</p>` : ''}
    <div><button type="button" class="btn" data-cost-set-act="restate-preview" ${check || r.loading || r.running ? 'disabled' : ''}>Preview</button></div>
    ${r.error ? `<p class="cost-note warn" role="alert">${esc(r.error)}</p>` : ''}
    ${r.done ? `<p class="cost-note" role="status">${esc(r.done)}</p>` : ''}
    ${preview}
    <h4>History</h4><div data-cost-set-history>${costSetHistoryHtml(st)}</div>`;
}

async function costSetRestatePreview() {
  const r = COST_SET.restate;
  const check = costSetRestateCheck(r.from, r.to, costToday());
  if (check || r.running) return; // a run in flight keeps its answer: a newer request would drop it
  const my = ++COST_SET.restateReq;
  const of = { from: r.from, to: r.to, gen: COST_SET.gen };
  Object.assign(r, { error: null, done: null, loading: true });
  costSetPaintPanel('restate');
  try {
    const res = await costPost('/api/cost/restate/preview', { from: of.from, to: of.to });
    if (my !== COST_SET.restateReq) return;
    if (res.status === 200) Object.assign(r, { preview: res.json, of });
    else
      Object.assign(r, {
        preview: null,
        of: null,
        error: (res.json && res.json.error) || `request failed (${res.status})`,
      });
  } catch (e) {
    if (my !== COST_SET.restateReq) return;
    Object.assign(r, { preview: null, of: null, error: e.message });
  }
  r.loading = false;
  costSetPaintPanel('restate', [['data-cost-set-act', 'restate-preview']]);
}
async function costSetRunRestate() {
  const r = COST_SET.restate;
  if (!costSetCanRun(r, COST_SET.gen, costSetLocked(COST_SET.answer))) return;
  const my = ++COST_SET.restateReq;
  Object.assign(r, { running: true, error: null });
  costSetPaintPanel('restate');
  try {
    const res = await costPost('/api/cost/restate', {
      from: r.of.from,
      to: r.of.to,
      reason: r.reason.trim(),
      confirm: true,
    });
    if (my !== COST_SET.restateReq) return;
    if (res.status === 200) {
      const n = res.json.correction.rows.length;
      Object.assign(r, {
        done: `Restated: ${n} row${n === 1 ? '' : 's'}`,
        preview: null,
        of: null,
        reason: '',
        ack: false,
      });
      costSetLoadHistory();
    } else r.error = (res.json && res.json.error) || `Could not restate (${res.status})`;
  } catch (e) {
    if (my !== COST_SET.restateReq) return;
    r.error = e.message;
  }
  r.running = false;
  costSetPaintPanel('restate', [['data-cost-set-act', 'restate-preview']]);
}
function costSetPaintHistory() {
  const el = document.querySelector('#cost-app [data-cost-set-history]');
  if (el) el.innerHTML = costSetHistoryHtml(COST_SET);
}
async function costSetLoadHistory() {
  const my = ++COST_SET.historyReq;
  COST_SET.historyError = null;
  COST_SET.historyLoading = true;
  costSetPaintHistory();
  try {
    const j = await costGet('/api/cost/restates');
    if (my !== COST_SET.historyReq) return;
    COST_SET.history = j.restates || [];
    COST_SET.historyLoading = false;
  } catch (e) {
    if (my !== COST_SET.historyReq) return;
    COST_SET.historyLoading = false;
    COST_SET.historyError = e.message; // path-free: "the ledger corrections could not be read"
  }
  costSetPaintHistory();
}
// "Open Restate" after a Save: the panel opens with this month so far (to yesterday), scrolled into view.
function costSetOpenRestate() {
  const r = COST_SET.restate;
  Object.assign(r, costSetRestateRange(costToday()), { error: null, done: null });
  COST_SET.open.restate = true;
  const d = [...document.querySelectorAll('#cost-app [data-cost-set-panel]')].find(
    (x) => x.dataset.costSetPanel === 'restate',
  );
  if (d) d.open = true; // first: a control in a closed <details> cannot take the focus
  costSetPaintPanel('restate', [['data-cost-set-act', 'restate-preview']]);
  if (costSetNeedHistory()) costSetLoadHistory();
  if (!d) return;
  d.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
}

Object.assign(COST_SET_ACTIONS, {
  'restate-preview': () => void costSetRestatePreview(),
  'restate-run': () => void costSetRunRestate(),
  'retry-history': () => void costSetLoadHistory(),
  'open-restate': () => costSetOpenRestate(),
});
// The reason and the box only enable Run restate; a date, once changed (not while typed), redraws the panel: its
// check line and the preview's staleness.
function costSetRestateInput(t, event) {
  const k = t.dataset && t.dataset.costSetRestate;
  if (!k) return;
  const r = COST_SET.restate;
  if (k === 'reason') r.reason = t.value;
  else if (k === 'ack') r.ack = !!t.checked;
  else {
    if (event !== 'change') return;
    r[k] = t.value;
    r.done = null;
    return costSetPaintSoon('restate');
  }
  const run = document.querySelector('#cost-app [data-cost-set-act="restate-run"]');
  if (run) run.disabled = !costSetCanRun(r, COST_SET.gen, costSetLocked(COST_SET.answer));
}
COST_SET_ON_INPUT.push((t) => costSetRestateInput(t, 'input'));
COST_SET_ON_CHANGE.push((t) => costSetRestateInput(t, 'change'));
// The history loads once: not again while a request is in flight, nor once it is held.
const costSetNeedHistory = () => !COST_SET.history && !COST_SET.historyLoading;
COST_SET_ON_OPEN.push((panel) => {
  if (panel === 'restate' && costSetNeedHistory()) costSetLoadHistory();
});
COST_SET_ON_LOAD.push(() => {
  const r = COST_SET.restate;
  if (!r.from || !r.to) Object.assign(r, costSetRestateRange(costToday()));
  if (COST_SET.open.restate && costSetNeedHistory()) costSetLoadHistory();
});
COST_SET_BODIES.restate = costSetRestateHtml;

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
    costSetCenterId,
    costSetCenterUse,
    costSetDeleteBlock,
    costSetUsedBy,
    costSetRuleGlob,
    costSetCenterName,
    costSetWarnText,
    costSetRulesHtml,
    costSetPreviewHtml,
    costSetTestHtml,
    costSetRunPreview,
    costSetRulesInput,
    costSetByFrom,
    costSetBillingHtml,
    costSetRateToday,
    costSetRateLine,
    costSetCurrencyHtml,
    costSetMoveFocus,
    costSetRestateRange,
    costSetRestateCheck,
    costSetPreviewState,
    costSetCanRun,
    costSetRestateSummaryHtml,
    costSetHistoryHtml,
    costSetRestateHtml,
    costSetRestatePreview,
    costSetRunRestate,
    costSetLoadHistory,
    costSetRestateInput,
  };
