'use strict';
/* Datasets: the list (#datasets), one dataset's examples (#datasets?ds=<slug>), the Experiments tab
   (#datasets/experiments), the Playground's Dataset mode (dsPlayground, dsPlaygroundAct) and "Add to dataset" for
   the trace explorer (dsAddPicker, dsTraceMount). Names, tags, reasons, every example text, replayed output and
   preview message are set with textContent through dsEl (S1); the only HTML strings here are static markup. With
   content viewing off the server sends no text, and adding turns, export and the external preview are refused (R7). */

/* ---------- pure helpers (exported for the tests) ---------- */
const DS_TAG = /^[\p{L}\p{N}_.:-]{1,40}$/u; // R1, as lib/datasets/shape.js
const DS_MAX_TAGS = 20;
const DS_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Routes and Windows device names, which the store refuses as slugs.
const DS_RESERVED = new Set([
  'import',
  'settings',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);
const DS_HIDDEN = '(hidden while content viewing is off)';
const DS_OFF = 'Content viewing is off';
const DS_IMPORT_MAX = 16 * 1024 * 1024; // R1 importBytes
const DS_IMPORT_BIG = 'The file is too large to import: with its JSON wrapping it is over 16 MB.';

function dsAgo(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return 'never';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// The list rows, the most recently changed dataset first.
function dsListRows(datasets, now = Date.now()) {
  return (Array.isArray(datasets) ? datasets : [])
    .filter((d) => d && typeof d.slug === 'string' && d.slug)
    .map((d) => ({ d, t: Number.isFinite(d.updatedAt) ? d.updatedAt : 0 }))
    .sort((a, b) => b.t - a.t)
    .map(({ d, t }) => ({
      slug: d.slug,
      name: typeof d.name === 'string' && d.name ? d.name : d.slug,
      count: Number.isInteger(d.count) ? d.count : 0,
      when: dsAgo(t, now),
    }));
}

// One line of a text for a table cell; null is what the server sends while content viewing is off.
function dsPreview(text, n = 160) {
  if (text == null) return DS_HIDDEN;
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line;
}

// The tags field as a PATCH body: words split on commas and spaces, each by the R1 rule, at most 20.
function dsTagsPatch(input) {
  const words = String(input ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  const tags = [];
  for (const w of words) {
    if (!DS_TAG.test(w)) {
      return { error: `"${w.slice(0, 40)}" is not a tag (letters, numbers, _ . : -, at most 40)` };
    }
    if (!tags.includes(w)) tags.push(w);
  }
  if (tags.length > DS_MAX_TAGS) return { error: `at most ${DS_MAX_TAGS} tags` };
  return { tags };
}

// An import failure for the page: the store's line reasons (the first three), else its message.
function dsImportError(err) {
  const reasons = err && Array.isArray(err.reasons) ? err.reasons.filter((r) => typeof r === 'string' && r) : [];
  if (reasons.length) {
    const more = reasons.length - 3;
    return reasons.slice(0, 3).join(' · ') + (more > 0 ? ` · and ${more} more` : '');
  }
  const m = err && typeof err.message === 'string' ? err.message.trim() : '';
  return m ? m.slice(0, 300) : 'Could not import the file';
}

// The trace explorer link of an example, by its opaque session key; null when the session is not listed.
function dsLinkHref(link) {
  if (!link || typeof link.key !== 'string' || !link.key) return null;
  const turn = Number.isInteger(link.turn) && link.turn >= 0 ? `&turn=${link.turn}` : '';
  return `#trace?key=${encodeURIComponent(link.key)}${turn}`;
}

// "Added 2 · skipped 1: already in this dataset" from POST /api/datasets/:slug/examples.
function dsAddResult(r) {
  const added = r && Array.isArray(r.added) ? r.added.length : 0;
  const skipped = r && Array.isArray(r.skipped) ? r.skipped : [];
  if (!skipped.length) return `Added ${added}`;
  const by = new Map();
  for (const s of skipped) {
    const why = s && typeof s.reason === 'string' && s.reason ? s.reason : 'not added';
    by.set(why, (by.get(why) || 0) + 1);
  }
  const why = [...by].map(([k, n]) => (n > 1 ? `${k} (${n})` : k)).join(', ');
  return `Added ${added} · skipped ${skipped.length}: ${why}`;
}

// A file name as a dataset slug, the way the store makes one from a name; a reserved word gets "-1".
function dsSlugOf(fileName) {
  const base = String(fileName ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(jsonl|ndjson|json|txt)$/i, '');
  const s = base
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (!s || !DS_SLUG.test(s)) return 'imported';
  return DS_RESERVED.has(s) ? `${s}-1` : s;
}

// The import request body against the server's limit (D-T6-6): a file just under 16 MB grows past it once its
// quotes and newlines are escaped in JSON, and the server would answer 413. Counted in bytes, as sent.
const dsImportTooBig = (bodyText) => new Blob([String(bodyText ?? '')]).size > DS_IMPORT_MAX;

// Focus kept inside a small dialog: the control Tab (or Shift-Tab, `back`) should wrap to from `active`, or null
// when the browser's own move stays inside.
function dsWrapFocus(controls, active, back) {
  if (!controls.length) return null;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (back && active === first) return last;
  if (!back && active === last) return first;
  return null;
}

// The page and the dataset a Datasets hash names: #datasets, #datasets?ds=<slug>, #datasets/experiments.
function dsRoute(hash) {
  const [route, query = ''] = String(hash || '')
    .replace(/^#/, '')
    .split('?');
  const tab = route.split('/')[1] === 'experiments' ? 'experiments' : 'list';
  const slug = new URLSearchParams(query).get('ds');
  return { tab, slug: tab === 'list' && slug && DS_SLUG.test(slug) ? slug : null };
}

// The run a Datasets hash opens: #datasets/experiments?run=<id>, as the Value page's Recommendations link to it
// (Cost Control 4b). Null for any other hash or an id that is not an experiment id.
const DS_EXP_ID = /^exp_[0-9a-f]{16}$/;
function dsRunOf(hash) {
  const [route, query = ''] = String(hash || '')
    .replace(/^#/, '')
    .split('?');
  if (route.split('/')[1] !== 'experiments') return null;
  const id = new URLSearchParams(query).get('run');
  return id && DS_EXP_ID.test(id) ? id : null;
}

/* ---------- Playground Dataset mode and experiments: pure helpers ---------- */
const DS_MAX_MODELS = 3;
const DS_EVAL_DEFAULTS = ['reference_match', 'secret_leak', 'task_completion', 'relevance'];
const DS_EXAMPLE_ID = /^ex_[0-9a-f]{16}$/;
const DS_EXTERNAL_OFF = 'External models need content viewing on, because what is sent must be previewed first.';

// The model checkboxes: local models first (S4), in the gateway's order. An external model with no known price is
// left out, as the server refuses it (the cost cap could not count it); an external model is never preselected.
function dsModelOptions(models) {
  const local = [];
  const external = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m.name !== 'string' || !m.name) continue;
    if (m.tier === 'private') local.push({ value: m.name, label: m.name, external: false });
    else if (m.priced) external.push({ value: m.name, label: m.name, external: true });
  }
  return {
    groups: [
      { label: 'On this machine', options: local },
      { label: 'External (sends masked text)', options: external },
    ],
    defaults: local.length ? [local[0].value] : [],
  };
}

// The POST /api/experiments body from the form, or the first thing to fix. The caps follow R8.
function dsRunBody(state) {
  const s = state || {};
  if (typeof s.dataset !== 'string' || !s.dataset) return { error: 'Pick a dataset' };
  const models = [...new Set(Array.isArray(s.models) ? s.models : [])];
  if (models.length < 1 || models.length > DS_MAX_MODELS) return { error: 'Pick one to three models' };
  const evaluators = [...new Set(Array.isArray(s.evaluators) ? s.evaluators : [])];
  if (!evaluators.length) return { error: 'Pick at least one evaluator' };
  const num = (v) => (typeof v === 'number' ? v : String(v ?? '').trim() === '' ? NaN : Number(v));
  const maxCostUSD = num(s.maxCostUSD);
  if (!(Number.isFinite(maxCostUSD) && maxCostUSD > 0 && maxCostUSD <= 10))
    return { error: 'The cost cap must be more than $0 and at most $10' };
  const maxRequests = num(s.maxRequests);
  if (!(Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 1000))
    return { error: 'The request cap must be a whole number from 1 to 1,000' };
  return {
    dataset: s.dataset,
    ...(typeof s.example === 'string' && s.example ? { examples: [s.example] } : {}),
    models,
    evaluators,
    maxCostUSD,
    maxRequests,
  };
}

// Why the original output of a run's example is missing: the dataset is still on its way, could not be read, or
// was read and no longer holds the example. Only the last is a delete (D-T7-3).
const dsMissingOriginal = (examplesState) =>
  examplesState === 'loading'
    ? 'Loading the dataset…'
    : examplesState === 'ready'
      ? 'No longer in the dataset'
      : 'Could not read the dataset';

// One example of a run side by side: the original output (shown, never scored), then one cell per model in the
// record's order. With content viewing off the texts are null and an error's reason is gone (R7). `examplesState`
// ('loading', 'error' or 'ready') says what a missing example means.
function dsResultCells(record, example, examplesState) {
  const r = record || {};
  const id = example && example.id;
  const rows = (Array.isArray(r.perExample) ? r.perExample : []).filter((x) => x && x.exampleId === id);
  const evaluators = Array.isArray(r.evaluators) ? r.evaluators : [];
  const out = example && example.output;
  // `note` is a state, not a failure (D-T7-6): a model the run never reached, an original still loading or gone.
  const noted = (head, note) => ({ head, text: null, labels: [], proposal: null, error: null, note });
  const cells = [
    out
      ? { head: 'Original output', text: out.text ?? null, labels: [], proposal: null, error: null, note: null }
      : noted('Original output', dsMissingOriginal(examplesState)),
  ];
  for (const model of Array.isArray(r.models) ? r.models : []) {
    const row = rows.find((x) => x.model === model);
    if (!row) {
      cells.push(noted(model, 'Not run: the run stopped first'));
      continue;
    }
    if (row.error || !row.output) {
      const error = row.error || 'Failed (the reason is hidden while content viewing is off)';
      cells.push({ head: model, text: null, labels: [], proposal: null, error, note: null });
      continue;
    }
    // A missing verdict (the judge did not answer) shows as such; an evaluator the row lacks did not apply.
    const given = row.labels || {};
    const labels = evaluators
      .filter((ev) => Object.hasOwn(given, ev))
      .map((ev) => {
        const v = given[ev];
        return v && typeof v.label === 'string'
          ? { id: ev, label: v.label, pass: !!v.pass }
          : { id: ev, label: null, pass: false };
      });
    const p = row.output.proposal;
    cells.push({
      head: model,
      text: row.output.text ?? null,
      labels,
      proposal: p ? { name: String(p.name || ''), arguments: p.arguments ?? null } : null,
      error: null,
      note: null,
    });
  }
  return cells;
}

// Pass rates by model and evaluator from a run's summary; a rate is null when nothing counted (R9).
function dsPassTable(summary, evaluators) {
  const models = summary && summary.models && typeof summary.models === 'object' ? summary.models : null;
  if (!models) return [];
  return Object.entries(models).map(([model, s]) => ({
    model,
    cells: (evaluators || []).map((evaluator) => {
      const c = (s && s.evaluators && s.evaluators[evaluator]) || {};
      return {
        evaluator,
        rate: Number.isFinite(c.rate) ? c.rate : null,
        pass: Number.isInteger(c.pass) ? c.pass : 0,
        total: Number.isInteger(c.total) ? c.total : 0,
      };
    }),
  }));
}

// Two runs side by side: every evaluator and model both ran, in the first run's order; delta is b - a.
function dsCompare(a, b) {
  if (!a || !b) return [];
  const rate = (r, model, ev) => {
    const c = r.summary && r.summary.models && r.summary.models[model];
    const x = c && c.evaluators && c.evaluators[ev];
    return x && Number.isFinite(x.rate) ? x.rate : null;
  };
  const inB = (list, x) => Array.isArray(list) && list.includes(x);
  const out = [];
  for (const evaluator of (a.evaluators || []).filter((e) => inB(b.evaluators, e)))
    for (const model of (a.models || []).filter((m) => inB(b.models, m))) {
      const ra = rate(a, model, evaluator);
      const rb = rate(b, model, evaluator);
      const delta = ra === null || rb === null ? null : Math.round((rb - ra) * 1e6) / 1e6;
      out.push({ evaluator, model, a: ra, b: rb, delta });
    }
  return out;
}

// The change of a compared pass rate in whole points; under half a point reads as no change (D-T7-4).
function dsDeltaText(d) {
  if (d === null || !Number.isFinite(d)) return { text: '—', tone: '' };
  const p = Math.round(d * 100);
  if (p === 0) return { text: '±0', tone: '' };
  return p > 0 ? { text: `+${p} pts`, tone: 'up' } : { text: `−${Math.abs(p)} pts`, tone: 'down' };
}

const dsUSD = (c) => (c > 0 && c < 0.01 ? `$${c.toFixed(4)}` : `$${(c || 0).toFixed(2)}`);
// "12 / 40 · 15 requests · $0.03" for a run in progress.
function dsProgressLine(p) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const q = p || {};
  const requests = n(q.requests);
  return `${n(q.done)} / ${n(q.total)} · ${requests} request${requests === 1 ? '' : 's'} · ${dsUSD(n(q.cost))}`;
}
// Why a run ended early, or null for one that ran to the end.
function dsStopLine(record) {
  if (!record || record.status !== 'stopped') return null;
  const caps = record.caps || {};
  if (record.stopped === 'cost cap') return `Stopped at the cost cap (${dsUSD(caps.maxCostUSD)})`;
  if (record.stopped === 'request cap') return `Stopped at the request cap (${caps.maxRequests})`;
  if (record.stopped === 'error') return 'Stopped: the run failed';
  if (record.stopped === 'cancelled') return 'Stopped before the end, on request';
  return `Stopped: ${record.stopped || 'unknown reason'}`;
}

// A poll's progress over the one before: GET /api/experiments/:id has no `dataset`, so the started one stays.
const dsMergeProgress = (prev, next) => ({ ...(prev || {}), ...(next || {}) });
// The wait before the next poll: 2 s, doubled per failure in a row, at most 30 s (D-T7-2).
const dsPollDelay = (failures) => Math.min(30000, 2000 * 2 ** Math.max(0, Number.isInteger(failures) ? failures : 0));
const DS_STOPPING = ' · stopping after the current call';
// The progress line, with the stop asked for (the call in flight still finishes, R8).
const dsRunLine = (p) => dsProgressLine(p) + (p && p.cancelling ? DS_STOPPING : '');

// Where "Replay turn" goes once the add answered: the example's id from `added`, else the example already saved for
// this key and turn; with neither, why not, and the page stays (D-T6-4).
function dsReplayTarget({ slug, added, skipped, examples, item } = {}) {
  const first = Array.isArray(added) && added[0] && typeof added[0].id === 'string' ? added[0].id : '';
  const it = item || {};
  const found = first
    ? null
    : (Array.isArray(examples) ? examples : []).find(
        (x) => x && x.link && x.link.key === it.key && x.link.turn === it.turn && typeof x.id === 'string',
      );
  const id = first || (found && found.id);
  if (id) return { hash: `#gateway/playground?ds=${encodeURIComponent(slug)}&ex=${encodeURIComponent(id)}` };
  const why = (Array.isArray(skipped) ? skipped : []).find((x) => x && typeof x.reason === 'string' && x.reason);
  return { message: why ? `Not replayed: ${why.reason}` : 'Not replayed: the turn was not found in the dataset' };
}

// What "Add to dataset" or "Replay turn" sends, or why nothing yet: trAddBody (traceview.js) is null until the
// selected session's turn is on show (D-T6-5).
function dsAddOrWhy(sel, S) {
  const body = typeof trAddBody === 'function' ? trAddBody(sel, S) : null;
  return body ? { body } : { why: 'The session is still loading. Try again in a moment.' };
}

// The POST /api/datasets/settings body from the auto-add form, or what to fix first.
function dsAutoAddBody(form) {
  const f = form || {};
  const enabled = f.enabled === true;
  const dataset = typeof f.dataset === 'string' ? f.dataset : '';
  if (enabled && !dataset) return { error: 'Pick a dataset for auto-add' };
  return { autoAdd: { enabled, dataset, onFail: f.onFail === true, onBad: f.onBad === true } };
}

// The dataset and example a "Replay" link names: #gateway/playground?ds=<slug>&ex=<id>.
function dsPgParams(hash) {
  const [route, query = ''] = String(hash || '')
    .replace(/^#/, '')
    .split('?');
  if (route !== 'gateway/playground') return null;
  const q = new URLSearchParams(query);
  const slug = q.get('ds');
  if (!slug || !DS_SLUG.test(slug)) return null;
  const ex = q.get('ex');
  return { slug, ex: ex && DS_EXAMPLE_ID.test(ex) ? ex : '' };
}

/* ---------- DOM and API ---------- */
// An element from a tag, attributes and children; a string child is a text node, never markup (S1).
function dsEl(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// The server's { error } and status apart, plus an import's line `reasons`.
function dsErrorOf(status, body) {
  let msg = String(body || '').slice(0, 300) || `request failed (${status})`;
  let reasons;
  try {
    const j = JSON.parse(body);
    if (j && typeof j.error === 'string') msg = j.error;
    if (j && Array.isArray(j.reasons)) reasons = j.reasons.filter((r) => typeof r === 'string');
  } catch {
    /* not JSON */
  }
  return Object.assign(new Error(msg), { status, reasons });
}
// A copy of trApi (traceview.js) that also keeps the server's `reasons`, which an import needs to say which lines
// failed. The two read api()'s "<status> <body>" errors the same way, so a change to one must go into the other.
async function dsApi(path, opts) {
  try {
    return await api(path, opts);
  } catch (e) {
    const m = /^(\d{3}) ([\s\S]*)$/.exec(String((e && e.message) || ''));
    if (!m) throw e;
    throw dsErrorOf(Number(m[1]), m[2]);
  }
}
const dsSend = (method, path, body) =>
  dsApi(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const dsPath = (slug) => `/api/datasets/${encodeURIComponent(slug)}`;

// NDJSON through a Blob link named <slug>.jsonl; nothing is kept in the page.
async function dsDownload(slug) {
  const r = await fetch(`${dsPath(slug)}/export`);
  if (r.status === 401) {
    location.href = '/login.html';
    throw new Error('signed out');
  }
  if (!r.ok) throw dsErrorOf(r.status, await r.text());
  const url = URL.createObjectURL(await r.blob());
  const a = dsEl('a', { href: url, download: `${slug}.jsonl`, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// The Export button of a dataset row and of the examples view: off with content viewing, and a failure said in `msg`.
function dsExportButton(slug, label, msg) {
  const btn = dsEl('button', { type: 'button', class: 'btn ghost' }, label);
  dsOn(btn, `Download ${slug}.jsonl`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await dsDownload(slug);
    } catch (err) {
      dsSay(msg, `Export failed: ${err.message}`, true);
    } finally {
      btn.disabled = !dsState.content;
    }
  });
  return btn;
}

/* ---------- the view ---------- */
const dsState = { req: 0, content: true, evs: null, expEvs: null };
const dsOn = (b, title) => {
  b.disabled = !dsState.content;
  b.title = dsState.content ? title || '' : DS_OFF;
};

function viewDatasets() {
  const { tab } = dsRoute(location.hash);
  const exp = tab === 'experiments';
  const copy = exp
    ? 'Replays of a dataset against up to three models, scored by the same evaluators, side by side.'
    : 'Turns saved from the trace explorer, to replay against other models and score. Kept on this machine.';
  return `<div class="holo-deck ds-deck" id="ds-app">
    <nav class="subtabs" aria-label="Datasets pages"><a href="#datasets" class="${exp ? '' : 'on'}" ${exp ? '' : 'aria-current="page"'}>Datasets</a><a href="#datasets/experiments" class="${exp ? 'on' : ''}" ${exp ? 'aria-current="page"' : ''}>Experiments</a></nav>
    ${subHero(`AI OBSERVABILITY · ${exp ? 'EXPERIMENTS' : 'DATASETS'}`, exp ? 'Experiments' : 'Datasets', copy, `<span class="pill">${icon('shield', 14)}${esc(localOnlyLabel())}</span>`)}
    <div class="ds-off" id="ds-off" role="status" hidden><b>Text is hidden while content viewing is off</b><span>ZAAFPULSE_CONTENT=off: adding turns and export are off; import, tag edits and deletes still work.</span></div>
    <div id="ds-body"><div class="skeleton" style="height:180px"></div></div></div>`;
}

async function mountDatasets() {
  const body = $('#ds-body');
  if (!body) return;
  const { tab, slug } = dsRoute(location.hash);
  // The sidebar's Experiments link and the crumb: the router does not know this page's tabs (no SUBPAGES entry).
  const sub = document.querySelector('nav a.nav-sub[data-route="datasets/experiments"]');
  if (sub) sub.classList.toggle('active', tab === 'experiments');
  const crumb = $('#crumb');
  if (crumb && tab === 'experiments') crumb.textContent = 'DATASETS / EXPERIMENTS';
  const my = ++dsState.req;
  const live = () => my === dsState.req && body.isConnected;
  if (tab === 'experiments') return void dsPaintExperiments(body, live);
  try {
    const [list, evs, settings] = await Promise.all([
      dsApi('/api/datasets'),
      dsState.evs ? Promise.resolve(null) : dsApi('/api/evals/evaluators').catch(() => null),
      // The auto-add rule, under the list; its own failure says so there and leaves the list alone.
      slug ? null : dsApi('/api/datasets/settings').catch((e) => ({ error: e.message })),
    ]);
    if (!live()) return;
    if (evs && Array.isArray(evs.evaluators)) dsState.evs = evs.evaluators;
    dsState.content = list.content !== false;
    $('#ds-off').hidden = dsState.content;
    if (slug) await dsMountExamples(body, slug, live);
    else dsPaintList(body, list, settings);
  } catch (e) {
    if (!live()) return;
    body.replaceChildren(dsEl('div', { class: 'holo panel empty' }, `Could not read the datasets: ${e.message}`));
  }
}

const dsPanel = (title, meta, ...kids) =>
  dsEl(
    'section',
    { class: 'holo panel ds-panel' },
    dsEl('div', { class: 'panel-head' }, dsEl('h3', null, title), meta ? dsEl('span', { class: 'meta' }, meta) : null),
    ...kids,
  );
// A line under a form for results and errors, read out as it changes.
function dsSay(el, msg, bad = false) {
  el.textContent = msg || '';
  el.classList.toggle('bad', !!bad);
}

/* ---- the list ---- */
function dsPaintList(body, list, settings) {
  const rows = dsListRows(list.datasets);
  const limits = list.limits || {};
  const msg = dsEl('p', { class: 'ds-msg', role: 'status' });
  const reload = () => mountDatasets();

  // New dataset: a name; the server makes the slug.
  const nameIn = dsEl('input', {
    class: 'input',
    id: 'ds-new-name',
    maxlength: 80,
    placeholder: 'e.g. Auth regressions',
    autocomplete: 'off',
    required: true,
  });
  const create = dsEl(
    'form',
    { class: 'ds-new', 'aria-label': 'New dataset' },
    dsEl('label', { for: 'ds-new-name' }, 'New dataset'),
    dsEl('div', { class: 'ds-inline' }, nameIn, dsEl('button', { class: 'btn', type: 'submit' }, 'Create')),
  );
  create.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = nameIn.value.trim();
    if (!v) return dsSay(msg, 'Give the dataset a name', true);
    try {
      const r = await dsSend('POST', '/api/datasets', { name: v });
      location.hash = `#datasets?ds=${encodeURIComponent(r.dataset.slug)}`;
    } catch (err) {
      dsSay(msg, err.message, true);
    }
  });

  // Import JSONL: read as text here, sent as one JSON body; the slug comes from the file name.
  const file = dsEl('input', {
    type: 'file',
    id: 'ds-import',
    class: 'ds-file',
    accept: '.jsonl,.ndjson,application/x-ndjson,text/plain',
    tabindex: -1, // the label is the control
  });
  const importBtn = dsEl(
    'label',
    { class: 'btn ghost', for: 'ds-import', tabindex: 0, role: 'button' },
    '⤒ Import JSONL',
  );
  importBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file.click();
    }
  });
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    if (f.size > DS_IMPORT_MAX) return dsSay(msg, 'The file is over 16 MB, the most one import takes', true);
    const reader = new FileReader();
    reader.onerror = () => dsSay(msg, 'Could not read the file', true);
    reader.onload = async () => {
      const slug = dsSlugOf(f.name);
      const name =
        f.name
          .replace(/\.[^.]*$/, '')
          .trim()
          .slice(0, 80) || slug;
      // The size check above is on the file; what the server limits is the request, escaped in JSON.
      const body = JSON.stringify({ slug, name, jsonl: String(reader.result || '') });
      if (dsImportTooBig(body)) return dsSay(msg, DS_IMPORT_BIG, true);
      dsSay(msg, `Importing into ${slug}…`);
      try {
        const r = await dsApi('/api/datasets/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        await reload();
        const after = $('.ds-msg');
        if (after) dsSay(after, `Imported ${r.added} example${r.added === 1 ? '' : 's'} into ${r.dataset.name}`);
      } catch (err) {
        dsSay(msg, dsImportError(err), true);
      }
    };
    reader.readAsText(f);
  });

  const tools = dsEl(
    'div',
    { class: 'ds-tools' },
    create,
    dsEl('div', { class: 'ds-import' }, file, importBtn, dsEl('small', null, 'One example per line, as exported')),
  );

  const table = rows.length
    ? dsEl(
        'div',
        { class: 'table-wrap' },
        dsEl(
          'table',
          { class: 'holo-table ds-list' },
          dsEl(
            'thead',
            null,
            dsEl(
              'tr',
              null,
              dsEl('th', null, 'Name'),
              dsEl('th', { class: 'r' }, 'Examples'),
              dsEl('th', { class: 'r' }, 'Last change'),
              dsEl('th', null, dsEl('span', { class: 'ds-sr' }, 'Actions')),
            ),
          ),
          dsEl(
            'tbody',
            null,
            rows.map((r) => dsListRow(r, msg, reload)),
          ),
        ),
      )
    : dsEl(
        'div',
        { class: 'empty' },
        'No datasets yet. Create one above, or pick turns in the ',
        dsEl('a', { href: '#trace', class: 'ds-a' }, 'Trace explorer'),
        ' and use ⤓ Add to dataset.',
      );

  const meta = `${rows.length} of ${limits.datasets || 100} · up to ${fmtN(limits.examples || 1000)} examples each`;
  const auto =
    settings && settings.autoAdd
      ? dsAutoAddEl(settings, rows, dsState.content)
      : dsPanel(
          'Auto-add',
          null,
          dsEl(
            'p',
            { class: 'ds-msg bad' },
            `Could not read the auto-add settings: ${(settings && settings.error) || 'no reply'}`,
          ),
        );
  body.replaceChildren(dsPanel('Datasets', meta, tools, msg, table), auto);
}

// Auto-add (D-T9-3): turns that went wrong go into one dataset as they happen. `cfg` is GET /api/datasets/settings,
// `rows` the list's rows. Names are option text, never markup (S1). With content off the server pauses the rule.
function dsAutoAddEl(cfg, rows, content) {
  const a = (cfg && cfg.autoAdd) || {};
  const list = Array.isArray(rows) ? rows : [];
  const on = dsEl('input', {
    type: 'checkbox',
    role: 'switch',
    id: 'ds-auto-on',
    class: 'ds-switch',
    checked: !!a.enabled,
  });
  // No dataset picked (or the picked one is gone): an empty choice, so Save asks for one instead of guessing.
  const known = list.some((d) => d.slug === a.dataset);
  const sel = dsEl(
    'select',
    { class: 'input', id: 'ds-auto-ds', disabled: !list.length },
    list.length
      ? [
          known ? null : dsEl('option', { value: '', selected: true }, 'Pick a dataset'),
          ...list.map((d) => dsEl('option', { value: d.slug, selected: d.slug === a.dataset }, d.name)),
        ]
      : dsEl('option', { value: '' }, 'Create a dataset first'),
  );
  const failIn = dsEl('input', { type: 'checkbox', id: 'ds-auto-fail', checked: !!a.onFail });
  const badIn = dsEl('input', { type: 'checkbox', id: 'ds-auto-bad', checked: !!a.onBad });
  const box = (input, id, label) =>
    dsEl('label', { class: 'gw-check ds-check', for: id }, input, dsEl('span', null, label));
  const say = dsEl('p', { class: 'ds-msg', role: 'status' });
  const save = dsEl('button', { type: 'submit', class: 'btn' }, 'Save');
  const form = dsEl(
    'form',
    { class: 'ds-auto', 'aria-label': 'Auto-add' },
    dsEl(
      'label',
      { class: 'ds-auto-switch', for: 'ds-auto-on' },
      on,
      dsEl('span', null, 'Add turns that went wrong automatically'),
    ),
    dsEl('label', { class: 'ds-auto-ds', for: 'ds-auto-ds' }, 'Dataset', sel),
    dsEl(
      'fieldset',
      { class: 'ds-auto-when' },
      dsEl('legend', null, 'Add a turn'),
      box(failIn, 'ds-auto-fail', 'When a judge evaluator fails a turn'),
      box(badIn, 'ds-auto-bad', 'When you rate a turn 👎'),
    ),
    dsEl('div', { class: 'ds-inline' }, save, say),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = dsAutoAddBody({
      enabled: on.checked,
      dataset: sel.disabled ? '' : sel.value,
      onFail: failIn.checked,
      onBad: badIn.checked,
    });
    if (b.error) return dsSay(say, b.error, true);
    save.disabled = true;
    try {
      await dsSend('POST', '/api/datasets/settings', b);
      dsSay(say, b.autoAdd.enabled ? 'Saved: auto-add is on' : 'Saved: auto-add is off');
    } catch (err) {
      dsSay(say, err.message, true); // the server's own words on a 400, e.g. "choose an existing dataset"
    } finally {
      save.disabled = false;
    }
  });
  return dsPanel(
    'Auto-add',
    'turns that went wrong, saved as they happen',
    content
      ? null
      : dsEl('p', { class: 'ds-off', role: 'note' }, 'Auto-add does nothing while content viewing is off.'),
    form,
  );
}

function dsListRow(r, msg, reload) {
  const nameCell = dsEl('td', { class: 'ds-name' });
  const showName = () =>
    nameCell.replaceChildren(
      dsEl('a', { href: `#datasets?ds=${encodeURIComponent(r.slug)}`, class: 'ds-a' }, dsEl('b', null, r.name)),
      dsEl('small', { class: 'block muted mono' }, r.slug),
    );
  showName();

  const exportBtn = dsExportButton(r.slug, 'Export', msg);

  // Rename in place: Enter saves, Escape puts the name back.
  const renameBtn = dsEl('button', { type: 'button', class: 'btn ghost' }, 'Rename');
  renameBtn.addEventListener('click', () => {
    const field = dsEl('input', {
      class: 'input',
      maxlength: 80,
      value: r.name,
      'aria-label': `New name for ${r.name}`,
    });
    const form = dsEl(
      'form',
      { class: 'ds-inline' },
      field,
      dsEl('button', { type: 'submit', class: 'btn' }, 'Save'),
      dsEl('button', { type: 'button', class: 'btn ghost', onclick: () => (showName(), renameBtn.focus()) }, 'Cancel'),
    );
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        showName();
        renameBtn.focus();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = field.value.trim();
      if (!v || v === r.name) return void (showName(), renameBtn.focus());
      try {
        await dsSend('PUT', dsPath(r.slug), { name: v });
        reload();
      } catch (err) {
        dsSay(msg, err.message, true);
      }
    });
    nameCell.replaceChildren(form);
    field.focus();
    field.select();
  });

  const delBtn = dsEl('button', { type: 'button', class: 'btn ghost danger' }, 'Delete');
  delBtn.addEventListener('click', async () => {
    const n = `${r.count} example${r.count === 1 ? '' : 's'}`;
    if (!confirm(`Delete the dataset "${r.name}" and its ${n}? This cannot be undone.`)) return;
    try {
      await dsApi(dsPath(r.slug), { method: 'DELETE' });
      reload();
    } catch (err) {
      dsSay(msg, err.message, true);
    }
  });

  return dsEl(
    'tr',
    null,
    nameCell,
    dsEl('td', { class: 'r num' }, fmtN(r.count)),
    dsEl('td', { class: 'r muted' }, r.when),
    dsEl('td', { class: 'nowrap ds-acts' }, exportBtn, renameBtn, delBtn),
  );
}

/* ---- one dataset's examples ---- */
async function dsMountExamples(body, slug, live) {
  let res;
  try {
    // The light view (D-F-2): the table shows previews, and a reference is kept whole for its editor.
    res = await dsApi(`${dsPath(slug)}?view=preview`);
  } catch (e) {
    if (!live()) return;
    const back = dsEl('a', { href: '#datasets', class: 'ds-a' }, 'All datasets');
    const why = e.status === 404 ? 'There is no dataset with this name.' : `Could not read the dataset: ${e.message}`;
    return void body.replaceChildren(dsEl('div', { class: 'holo panel empty' }, why, ' ', back));
  }
  if (!live()) return;
  const meta = res.dataset || {};
  const examples = Array.isArray(res.examples) ? res.examples : [];
  const msg = dsEl('p', { class: 'ds-msg', role: 'status' });
  const exportBtn = dsExportButton(slug, 'Export JSONL', msg);

  const head = dsEl(
    'div',
    { class: 'ds-head' },
    dsEl('a', { href: '#datasets', class: 'ds-back' }, '← All datasets'),
    dsEl('h2', null, typeof meta.name === 'string' ? meta.name : slug),
    dsEl(
      'span',
      { class: 'meta' },
      `${examples.length} example${examples.length === 1 ? '' : 's'} · changed ${dsAgo(meta.updatedAt)}`,
    ),
    dsEl('span', { class: 'ds-spacer' }),
    exportBtn,
  );

  const counter = { n: examples.length };
  const table = examples.length
    ? dsEl(
        'div',
        { class: 'table-wrap' },
        dsEl(
          'table',
          { class: 'holo-table ds-examples' },
          dsEl(
            'thead',
            null,
            dsEl(
              'tr',
              null,
              ['Input', 'Output', 'Reference', 'Evals', 'Rating', 'Tags', 'Trace'].map((h, i) =>
                dsEl('th', { class: `ds-c${i}` }, h),
              ),
              dsEl('th', { class: 'ds-c7' }, dsEl('span', { class: 'ds-sr' }, 'Actions')),
            ),
          ),
          dsEl(
            'tbody',
            null,
            examples.map((ex, i) => dsExampleRow(slug, ex, msg, counter, i + 1)),
          ),
        ),
      )
    : dsEl(
        'div',
        { class: 'empty' },
        'No examples yet. Pick turns in the ',
        dsEl('a', { href: '#trace', class: 'ds-a' }, 'Trace explorer'),
        ' (Ctrl/⌘-click or Space) and use ⤓ Add to dataset.',
      );
  body.replaceChildren(dsEl('section', { class: 'holo panel ds-panel' }, head, msg, table));
}

const dsUserText = (ex) => {
  const m = ((ex.input && ex.input.messages) || []).find((x) => x && x.role === 'user');
  return m ? m.text : '';
};
// The pass label of an evaluator is green, its last label red, one in between amber; unknown ones stay plain.
function dsEvalTone(id, label) {
  const ev = (dsState.evs || []).find((e) => e && e.id === id);
  const labels = ev && Array.isArray(ev.labels) ? ev.labels : null;
  if (!labels || !labels.includes(label)) return { tone: '', title: `${id}: ${label}` };
  const tone = label === ev.pass ? 'pass' : label === labels[labels.length - 1] ? 'fail' : 'mid';
  return { tone, title: `${ev.title || id}: ${label}` };
}

// `n` is the row's number in the table, which names its tags field and Delete button for a screen reader.
function dsExampleRow(slug, ex, msg, counter, n) {
  const path = `${dsPath(slug)}/examples/${encodeURIComponent(ex.id)}`;
  const tip = (t) => (t == null ? DS_HIDDEN : String(t).slice(0, 600));
  const msgs = (ex.input && ex.input.messages) || [];
  const tools = msgs.filter((m) => m && m.role === 'tool').length;

  // Input: the first user message; the tool results it carries as a count.
  const userText = dsUserText(ex);
  const inLine = dsEl('span', { class: 'ds-text' });
  inLine.textContent = dsPreview(userText);
  inLine.title = tip(userText);
  const inCell = dsEl(
    'td',
    { class: 'ds-c0' },
    inLine,
    tools ? dsEl('small', { class: 'block muted' }, `+ ${tools} tool result${tools === 1 ? '' : 's'}`) : null,
  );

  const out = ex.output || {};
  const outLine = dsEl('span', { class: 'ds-text' });
  outLine.textContent = dsPreview(out.text);
  outLine.title = tip(out.text);
  const outCell = dsEl(
    'td',
    { class: 'ds-c1' },
    outLine,
    out.model ? dsEl('small', { class: 'block muted mono' }, out.model) : null,
  );

  const refCell = dsEl('td', { class: 'ds-c2' });
  let ref = ex.reference;
  const showRef = () => {
    const has = ref && ref.text != null;
    const hidden = ref && ref.text == null;
    const line = dsEl('span', { class: 'ds-text' });
    // With content off there is nothing to show or add: an empty cell, not an offer the page cannot keep.
    line.textContent = hidden ? DS_HIDDEN : has ? dsPreview(ref.text) : dsState.content ? '+ Add reference' : '—';
    const btn = dsEl(
      'button',
      { type: 'button', class: `ds-ref${has ? '' : ' none'}`, 'aria-label': 'Edit reference' },
      line,
    );
    if (has) btn.title = `${tip(ref.text)}\n\nClick to edit`;
    // With content off the stored text is not on the page, so an edit would overwrite what it cannot show.
    if (!dsState.content) {
      btn.disabled = true;
      btn.title = DS_OFF;
    }
    btn.addEventListener('click', editRef);
    refCell.replaceChildren(btn);
    return btn;
  };
  function editRef() {
    const area = dsEl('textarea', {
      class: 'input ds-area',
      rows: 3,
      maxlength: 65536,
      'aria-label': 'Reference answer (Ctrl/⌘+Enter saves, Escape cancels)',
    });
    area.value = ref && ref.text != null ? ref.text : '';
    const note = dsEl('small', { class: 'ds-note', role: 'status' });
    const cancel = () => showRef().focus();
    const save = async () => {
      const v = area.value.trim();
      try {
        const r = await dsSend('PATCH', path, { reference: v ? area.value : null });
        ref = r.example.reference;
        showRef().focus();
      } catch (err) {
        dsSay(note, err.message, true);
      }
    };
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      }
    });
    refCell.replaceChildren(
      area,
      dsEl(
        'div',
        { class: 'ds-inline' },
        dsEl('button', { type: 'button', class: 'btn', onclick: save }, 'Save'),
        dsEl('button', { type: 'button', class: 'btn ghost', onclick: cancel }, 'Cancel'),
      ),
      note,
    );
    area.focus();
  }
  showRef();

  const evals = Object.entries(ex.evals || {}).filter(([, l]) => typeof l === 'string');
  const evCell = dsEl(
    'td',
    { class: 'ds-c3' },
    evals.length
      ? dsEl(
          'div',
          { class: 'ds-pills' },
          evals.map(([id, label]) => {
            const { tone, title } = dsEvalTone(id, label);
            return dsEl('span', { class: `ds-pill ${tone}`, title }, label);
          }),
        )
      : dsEl('span', { class: 'muted' }, '—'),
  );

  const fb = ex.feedback;
  const fbCell = dsEl(
    'td',
    { class: 'ds-c4' },
    fb === 'good' || fb === 'bad'
      ? dsEl(
          'span',
          {
            class: `ds-fb ${fb}`,
            role: 'img',
            'aria-label': `Rated ${fb}`,
            title: `Rated ${fb} in the trace explorer`,
          },
          fb === 'good' ? '👍' : '👎',
        )
      : dsEl('span', { class: 'muted' }, '—'),
  );

  // Tags: Enter saves through dsTagsPatch, Escape puts the saved ones back.
  let saved = Array.isArray(ex.tags) ? ex.tags : [];
  const tagIn = dsEl('input', {
    class: 'input ds-tags',
    value: saved.join(' '),
    placeholder: 'add tags',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': `Tags of example ${n}`,
    title: 'Tags, separated by spaces or commas (Enter saves)',
  });
  const tagNote = dsEl('small', { class: 'ds-note', role: 'status' });
  tagIn.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      tagIn.value = saved.join(' ');
      return dsSay(tagNote, '');
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const p = dsTagsPatch(tagIn.value);
    if (p.error) return dsSay(tagNote, p.error, true);
    try {
      const r = await dsSend('PATCH', path, { tags: p.tags });
      saved = r.example.tags || [];
      tagIn.value = saved.join(' ');
      dsSay(tagNote, 'Saved');
    } catch (err) {
      dsSay(tagNote, err.message, true);
    }
  });
  const tagCell = dsEl('td', { class: 'ds-c5' }, tagIn, tagNote);

  const href = dsLinkHref(ex.link);
  const linkCell = dsEl(
    'td',
    { class: 'ds-c6' },
    href
      ? dsEl('a', { href, class: 'ds-a', title: 'Open this turn in the trace explorer' }, 'Open ↗')
      : dsEl('span', { class: 'muted', title: 'Imported, or its session is no longer listed' }, '—'),
  );

  const row = dsEl('tr', null, inCell, outCell, refCell, evCell, fbCell, tagCell, linkCell);
  const del = dsEl(
    'button',
    { type: 'button', class: 'btn ghost danger', 'aria-label': `Delete example ${n}` },
    'Delete',
  );
  del.addEventListener('click', async () => {
    if (!confirm('Delete this example from the dataset?')) return;
    try {
      await dsApi(path, { method: 'DELETE' });
      row.remove();
      counter.n -= 1;
      const meta = $('.ds-head .meta');
      if (meta) meta.textContent = `${counter.n} example${counter.n === 1 ? '' : 's'} · changed just now`;
      dsSay(msg, 'Example deleted');
    } catch (err) {
      dsSay(msg, err.message, true);
    }
  });
  row.append(dsEl('td', { class: 'ds-c7' }, del));
  return row;
}

/* ---- experiments: shared pieces ---- */
// Short column heads for the pass-rate tables; the full title is the cell's tooltip.
const DS_EV_SHORT = {
  reference_match: 'Reference',
  secret_leak: 'Secrets',
  risky_command: 'Risky cmd',
  faithfulness: 'Faithful',
  task_completion: 'Task done',
  tool_selection: 'Tool choice',
  relevance: 'Relevance',
};
const DS_EV_TINY = {
  reference_match: 'ref',
  secret_leak: 'secrets',
  risky_command: 'risky',
  faithfulness: 'faithful',
  task_completion: 'task',
  tool_selection: 'tools',
  relevance: 'relevant',
};
const dsEvMeta = (id) => (dsState.expEvs || []).find((e) => e && e.id === id) || null;
const dsEvTitle = (id) => (dsEvMeta(id) && dsEvMeta(id).title) || id;
const dsPct = (r) => (r === null ? '—' : `${Math.round(r * 100)}%`);
const dsRateTone = (r) => (r === null ? '' : r >= 0.8 ? 'pass' : r < 0.5 ? 'fail' : 'mid');
// A verdict pill: the pass label green, the evaluator's last label red, one in between amber.
function dsVerdictPill(l) {
  if (l.label === null)
    return dsEl('span', { class: 'ds-pill', title: `${dsEvTitle(l.id)}: the judge gave no verdict` }, 'no verdict');
  const ev = dsEvMeta(l.id);
  const labels = ev && Array.isArray(ev.labels) ? ev.labels : [];
  const tone = l.pass ? 'pass' : !labels.length || l.label === labels[labels.length - 1] ? 'fail' : 'mid';
  return dsEl('span', { class: `ds-pill ${tone}`, title: `${dsEvTitle(l.id)}: ${l.label}` }, l.label);
}
// Moves focus to a new panel's heading, so a keyboard or screen reader user lands on what just opened.
function dsFocusHead(panel) {
  const h = panel.querySelector('h3');
  if (!h) return;
  h.tabIndex = -1;
  h.focus();
  panel.scrollIntoView({ block: 'nearest' });
}
const dsWhen = (ts) => (Number.isFinite(ts) ? new Date(ts).toLocaleString() : '');
const dsStatusText = (r) =>
  r.status === 'running' ? 'running' : r.status === 'done' ? 'done' : `stopped · ${r.stopped || 'unknown'}`;

// Pass rates as a table: one row per model, one column per evaluator.
function dsPassTableEl(record, { compact = false } = {}) {
  const evaluators = Array.isArray(record.evaluators) ? record.evaluators : [];
  const rows = dsPassTable(record.summary, evaluators);
  if (!rows.length) return dsEl('span', { class: 'muted' }, '—');
  return dsEl(
    'table',
    { class: compact ? 'ds-mini' : 'holo-table ds-pass' },
    dsEl(
      'thead',
      null,
      dsEl(
        'tr',
        null,
        dsEl('th', { scope: 'col' }, compact ? dsEl('span', { class: 'ds-sr' }, 'Model') : 'Model'),
        evaluators.map((id) =>
          dsEl(
            'th',
            { scope: 'col', class: 'r', title: dsEvTitle(id) },
            (compact ? DS_EV_TINY[id] : DS_EV_SHORT[id]) || id,
          ),
        ),
      ),
    ),
    dsEl(
      'tbody',
      null,
      rows.map((row) =>
        dsEl(
          'tr',
          null,
          dsEl('th', { scope: 'row', class: 'mono' }, row.model),
          row.cells.map((c) =>
            dsEl(
              'td',
              {
                class: `r num ds-rate ${dsRateTone(c.rate)}`,
                title:
                  c.rate === null
                    ? `${dsEvTitle(c.evaluator)}: nothing to count`
                    : `${dsEvTitle(c.evaluator)}: ${c.pass} of ${c.total} passed`,
              },
              dsPct(c.rate),
              compact || c.rate === null ? null : dsEl('small', null, ` ${c.pass}/${c.total}`),
            ),
          ),
        ),
      ),
    ),
  );
}

// One cell of the side-by-side grid. Every text is set with textContent (S1).
function dsCellEl(cell, content) {
  const box = dsEl('div', { class: `ds-cell${cell.error ? ' bad' : ''}` });
  box.append(dsEl('b', { class: 'ds-cell-head mono' }, cell.head));
  if (cell.error) {
    const err = dsEl('p', { class: 'ds-cell-err' });
    err.textContent = cell.error;
    box.append(err);
    return box;
  }
  if (cell.note) {
    const note = dsEl('p', { class: 'ds-cell-note' });
    note.textContent = cell.note;
    box.append(note);
    return box;
  }
  if (cell.text !== '' || !cell.proposal) {
    const pre = dsEl('pre', { class: 'ds-cell-text', tabindex: 0 });
    if (cell.text === null) {
      pre.classList.add('muted');
      pre.textContent = content ? '(not kept: the record was trimmed)' : DS_HIDDEN;
    } else pre.textContent = cell.text || '(no text)';
    box.append(pre);
  }
  if (cell.proposal) {
    // A tool call the model proposed: shown, never run (S8).
    const p = dsEl('div', { class: 'ds-proposal' });
    const head = dsEl('b');
    head.textContent = `Proposed tool call: ${cell.proposal.name}`;
    const args = dsEl('pre', { class: 'ds-cell-text', tabindex: 0 });
    args.textContent = cell.proposal.arguments === null ? DS_HIDDEN : cell.proposal.arguments || '{}';
    p.append(head, args);
    box.append(p);
  }
  if (cell.labels.length) box.append(dsEl('div', { class: 'ds-pills' }, cell.labels.map(dsVerdictPill)));
  return box;
}

const DS_RESULT_PAGE = 25; // examples drawn at a time: a run can hold 1,000 examples × 3 models
// A finished run: the head, the pass-rate table, then each example side by side. `examplesState` says whether
// `examples` is the dataset as read ('ready'), still on its way ('loading') or unreadable ('error').
function dsResultsEl(record, examples, content, examplesState) {
  const r = record || {};
  const byId = new Map((Array.isArray(examples) ? examples : []).map((e) => [e.id, e]));
  const ids = [...new Set((r.perExample || []).map((x) => x && x.exampleId).filter(Boolean))];
  const models = Array.isArray(r.models) ? r.models : [];
  const usage = r.usage || {};
  const stop = dsStopLine(r);
  const wrap = dsEl('div', { class: 'ds-results' });
  wrap.append(
    dsEl(
      'p',
      { class: 'ds-run-meta' },
      dsEl('b', null, r.datasetName || r.dataset || 'Dataset'),
      ` · ${ids.length} example${ids.length === 1 ? '' : 's'} · ${usage.requests || 0} request${usage.requests === 1 ? '' : 's'} · ${dsUSD(usage.cost || 0)} · ${dsWhen(r.startedAt)}`,
    ),
  );
  if (stop) wrap.append(dsEl('p', { class: 'ds-stop', role: 'note' }, stop));
  if (r.trimmed) wrap.append(dsEl('p', { class: 'muted' }, 'This record was trimmed to fit: some texts are shorter.'));
  wrap.append(dsEl('div', { class: 'table-wrap' }, dsPassTableEl(r)));
  if (!content)
    wrap.append(
      dsEl(
        'div',
        { class: 'ds-off', role: 'note' },
        dsEl('b', null, 'Text is hidden while content viewing is off'),
        dsEl('span', null, 'Labels and pass rates are shown; outputs, proposal arguments and errors are not.'),
      ),
    );
  if (!ids.length) {
    wrap.append(dsEl('div', { class: 'empty' }, 'No example ran before the run stopped.'));
    return wrap;
  }
  const list = dsEl('div', { class: 'ds-rlist' });
  const more = dsEl('button', { type: 'button', class: 'btn ghost ds-more' });
  let shown = 0;
  const draw = () => {
    for (const id of ids.slice(shown, shown + DS_RESULT_PAGE)) {
      shown++;
      const ex = byId.get(id) || { id };
      const input = dsEl('span', { class: 'ds-text' });
      // A deleted example, or text hidden while content viewing is off: its id instead.
      const said = byId.has(id) ? dsUserText(ex) : null;
      input.textContent = said == null ? id : dsPreview(said, 200);
      const grid = dsEl('div', { class: 'ds-rgrid', style: `--ds-cols:${models.length + 1}` });
      for (const cell of dsResultCells(r, ex, examplesState)) grid.append(dsCellEl(cell, content));
      list.append(
        dsEl(
          'article',
          { class: 'ds-rx', 'aria-label': `Example ${shown}` },
          dsEl('div', { class: 'ds-rx-head' }, dsEl('span', { class: 'ds-rx-n' }, `#${shown}`), input),
          dsEl('div', { class: 'ds-rgrid-wrap' }, grid),
        ),
      );
    }
    more.hidden = shown >= ids.length;
    more.textContent = `Show ${Math.min(DS_RESULT_PAGE, ids.length - shown)} more of ${ids.length - shown}`;
  };
  more.addEventListener('click', draw);
  draw();
  wrap.append(list, more);
  return wrap;
}

/* ---- the Experiments tab ---- */
async function dsPaintExperiments(body, live) {
  let r;
  try {
    const [exp, list] = await Promise.all([dsApi('/api/experiments'), dsApi('/api/datasets')]);
    r = exp;
    dsState.content = list.content !== false;
  } catch (e) {
    if (!live()) return;
    return void body.replaceChildren(
      dsEl('div', { class: 'holo panel empty' }, `Could not read the experiments: ${e.message}`),
    );
  }
  if (!live()) return;
  $('#ds-off').hidden = dsState.content;
  dsState.expEvs = Array.isArray(r.evaluators) ? r.evaluators : [];
  const runs = Array.isArray(r.experiments) ? r.experiments.filter((x) => x && typeof x.id === 'string') : [];
  const detail = dsEl('div', { id: 'ds-exp-detail' });
  const picked = [];
  const compare = dsEl('button', { type: 'button', class: 'btn', disabled: true }, 'Compare');
  const hint = dsEl('small', { class: 'muted' }, 'Tick two runs to compare them');
  const syncPick = () => {
    compare.disabled = picked.length !== 2;
    hint.textContent = picked.length === 2 ? 'Ready to compare' : 'Tick two runs to compare them';
  };

  const running = r.running
    ? dsEl(
        'p',
        { class: 'ds-running', role: 'status' },
        dsEl('span', { class: 'ds-dot', 'aria-hidden': 'true' }),
        `Running now on ${r.running.dataset}: ${dsRunLine(r.running)} · `,
        dsEl('a', { href: '#gateway/playground', class: 'ds-a' }, 'follow it in the Playground'),
      )
    : null;

  // Opening a run: its record and the dataset's examples, for the original outputs (gone ones say so).
  let opened = 0;
  async function open(row) {
    const my = ++opened;
    // The open run's row stays marked, so the list says which results are below.
    for (const tr of body.querySelectorAll('.ds-exp-row')) tr.classList.toggle('on', tr.dataset.id === row.id);
    detail.replaceChildren(dsEl('div', { class: 'skeleton', style: 'height:160px' }));
    try {
      const [rec, ds] = await Promise.all([
        dsApi(`/api/experiments/${encodeURIComponent(row.id)}`),
        // The whole rows, for the original outputs. A deleted dataset holds none of its examples any more.
        dsApi(dsPath(row.dataset)).catch((e) => (e && e.status === 404 ? { examples: [] } : null)),
      ]);
      if (my !== opened || !detail.isConnected) return;
      const read = !!ds && Array.isArray(ds.examples);
      const panel = dsPanel(
        `Results · ${row.datasetName || row.dataset}`,
        dsStatusText(rec),
        dsResultsEl(rec, read ? ds.examples : [], dsState.content, read ? 'ready' : 'error'),
      );
      detail.replaceChildren(panel);
      dsFocusHead(panel);
    } catch (e) {
      if (my !== opened || !detail.isConnected) return;
      detail.replaceChildren(dsEl('div', { class: 'holo panel empty' }, `Could not read the run: ${e.message}`));
    }
  }

  compare.addEventListener('click', () => {
    // The older run is A, so the change reads forward in time.
    const [a, b] = picked
      .map((id) => runs.find((x) => x.id === id))
      .sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
    const rows = dsCompare(a, b);
    const label = (x) => `${x.datasetName || x.dataset} · ${dsAgo(x.startedAt)}`;
    const table = rows.length
      ? dsEl(
          'div',
          { class: 'table-wrap' },
          dsEl(
            'table',
            { class: 'holo-table ds-cmp' },
            dsEl(
              'thead',
              null,
              dsEl(
                'tr',
                null,
                dsEl('th', { scope: 'col' }, 'Evaluator'),
                dsEl('th', { scope: 'col' }, 'Model'),
                dsEl('th', { scope: 'col', class: 'r', title: dsWhen(a.startedAt) }, `A · ${label(a)}`),
                dsEl('th', { scope: 'col', class: 'r', title: dsWhen(b.startedAt) }, `B · ${label(b)}`),
                dsEl('th', { scope: 'col', class: 'r' }, 'Change'),
              ),
            ),
            dsEl(
              'tbody',
              null,
              rows.map((x) => {
                const { text: pts, tone } = dsDeltaText(x.delta);
                return dsEl(
                  'tr',
                  null,
                  dsEl('td', { title: x.evaluator }, dsEvTitle(x.evaluator)),
                  dsEl('td', { class: 'mono' }, x.model),
                  dsEl('td', { class: 'r num' }, dsPct(x.a)),
                  dsEl('td', { class: 'r num' }, dsPct(x.b)),
                  dsEl(
                    'td',
                    { class: `r num ds-delta ${tone}` },
                    tone ? dsEl('span', { class: 'ds-sr' }, `${tone} `) : null,
                    pts,
                  ),
                );
              }),
            ),
          ),
        )
      : dsEl('div', { class: 'empty' }, 'These two runs share no evaluator and model, so there is nothing to compare.');
    const other =
      a.dataset !== b.dataset
        ? dsEl(
            'p',
            { class: 'ds-stop', role: 'note' },
            'These runs replay different datasets: the rates are not like for like.',
          )
        : null;
    const panel = dsPanel('Compare', 'pass rates of the pairs both runs have; B minus A', other, table);
    detail.replaceChildren(panel);
    dsFocusHead(panel);
  });

  const table = runs.length
    ? dsEl(
        'div',
        { class: 'table-wrap' },
        dsEl(
          'table',
          { class: 'holo-table ds-exps' },
          dsEl(
            'thead',
            null,
            dsEl(
              'tr',
              null,
              dsEl('th', { scope: 'col' }, dsEl('span', { class: 'ds-sr' }, 'Pick to compare')),
              ['Dataset', 'Started', 'Status', 'Models · pass rate'].map((h) => dsEl('th', { scope: 'col' }, h)),
            ),
          ),
          dsEl(
            'tbody',
            null,
            runs.map((row) => {
              const box = dsEl('input', {
                type: 'checkbox',
                class: 'ds-pick',
                'aria-label': `Compare the run on ${row.datasetName || row.dataset} from ${dsAgo(row.startedAt)}`,
              });
              box.addEventListener('change', () => {
                const i = picked.indexOf(row.id);
                if (box.checked && i < 0) {
                  // Two at most: the earlier pick gives way.
                  if (picked.length === 2) {
                    const drop = picked.shift();
                    const other = tbody.querySelector(`input[data-id="${drop}"]`);
                    if (other) other.checked = false;
                  }
                  picked.push(row.id);
                } else if (!box.checked && i >= 0) picked.splice(i, 1);
                syncPick();
              });
              box.dataset.id = row.id;
              const name = dsEl(
                'button',
                { type: 'button', class: 'ds-open', title: 'Open the results' },
                dsEl('b', null, row.datasetName || row.dataset),
                dsEl('small', { class: 'block muted' }, `${row.examples || 0} example${row.examples === 1 ? '' : 's'}`),
              );
              name.addEventListener('click', () => open(row));
              const tr = dsEl(
                'tr',
                { class: 'ds-exp-row' },
                dsEl('td', { class: 'ds-pickc' }, box),
                dsEl('td', null, name),
                dsEl('td', { class: 'nowrap muted', title: dsWhen(row.startedAt) }, dsAgo(row.startedAt)),
                dsEl(
                  'td',
                  { class: 'nowrap' },
                  dsEl('span', { class: `ds-status ${row.status === 'done' ? 'ok' : 'warn'}` }, dsStatusText(row)),
                ),
                dsEl('td', null, dsPassTableEl(row, { compact: true })),
              );
              // The whole row opens the run; the checkbox and the button keep their own clicks.
              tr.dataset.id = row.id;
              tr.addEventListener('click', (e) => {
                if (e.target.closest('input, button, a')) return;
                open(row);
              });
              return tr;
            }),
          ),
        ),
      )
    : dsEl(
        'div',
        { class: 'empty' },
        'No experiments yet. Replay a dataset in the ',
        dsEl('a', { class: 'ds-a', href: '#gateway/playground' }, 'Playground'),
        ' (Dataset mode) to compare models on it; finished runs are listed here.',
      );
  const tbody = table.querySelector ? table.querySelector('tbody') : null;
  const tools = runs.length > 1 ? dsEl('div', { class: 'ds-inline ds-cmp-bar' }, compare, hint) : null;
  body.replaceChildren(
    dsPanel('Experiments', `${runs.length} run${runs.length === 1 ? '' : 's'} · newest first`, running, tools, table),
    detail,
  );
  // A link that names a run (the Value page's Recommendations) opens it, as a click on its row does.
  const wanted = dsRunOf(location.hash);
  const named = wanted && runs.find((x) => x.id === wanted);
  if (named) open(named);
}

/* ---------- the Playground's Dataset mode (public/gatewayview.js) ---------- */
// The state lives on the Playground's own object (gw.pg.ds), so it outlives repaints and mode switches. The
// gateway page paints dsPlayground's static shell, then dsPlaygroundMount builds the form with dsEl; clicks,
// changes and the submit come back through dsPlaygroundAct.
function dsPg(pg) {
  if (!pg.ds)
    pg.ds = {
      loaded: false,
      loading: false,
      loadError: '',
      content: true,
      datasets: [],
      models: [],
      unpriced: 0,
      examples: {}, // slug → rows, 'loading' or { error }
      slug: '',
      ex: '',
      picked: null, // model names; null until the defaults are known
      evs: [...DS_EVAL_DEFAULTS],
      maxCostUSD: '0.5',
      maxRequests: '100',
      hashSeen: '',
      preview: null, // { items, confirm, body, providers }
      busy: false,
      msg: '',
      bad: false,
      runId: null,
      progress: null,
      record: null,
      timer: null,
      pollFails: 0, // failed polls in a row, for the backoff
      hooked: false,
      focus: '',
      repaint: () => {},
    };
  return pg.ds;
}

// A "Replay" link (#gateway/playground?ds=&ex=) opens Dataset mode on that dataset and example, once per visit:
// a repaint or the background refresh keeps the mode the user picked since; following a link again applies it.
let dsHashVisits = 0;
if (typeof addEventListener === 'function') addEventListener('hashchange', () => dsHashVisits++);
function dsPlaygroundHash(pg, hash = location.hash) {
  const q = dsPgParams(hash);
  const s = dsPg(pg);
  const seen = `${dsHashVisits}|${hash}`;
  if (!q || seen === s.hashSeen) return;
  s.hashSeen = seen;
  pg.mode = 'dataset';
  pg.result = null;
  if (s.runId) return; // a run in progress keeps the page
  s.slug = q.slug;
  s.ex = q.ex;
  s.preview = null;
  s.record = null;
  s.msg = '';
}

// Static markup only: everything with a name or a text in it is built by dsPlaygroundMount (S1).
function dsPlayground(pg) {
  dsPg(pg);
  return `<div class="ds-pg" id="ds-pg"><div class="skeleton" style="height:180px"></div></div>`;
}

const dsPgExternal = (s, name) => {
  const m = s.models.find((x) => x.name === name);
  return !!m && m.tier !== 'private';
};
const dsPgProviders = (s, names) => [
  ...new Set(
    names
      .filter((n) => dsPgExternal(s, n))
      .map((n) => (s.models.find((x) => x.name === n) || {}).label || n.split('/')[0]),
  ),
];

async function dsPgLoad(pg) {
  const s = dsPg(pg);
  s.loading = true;
  s.loadError = '';
  try {
    const [list, exp] = await Promise.all([dsApi('/api/datasets'), dsApi('/api/experiments')]);
    s.content = list.content !== false;
    s.datasets = dsListRows(list.datasets);
    s.models = Array.isArray(exp.models) ? exp.models.filter((m) => m && typeof m.name === 'string') : [];
    s.unpriced = s.models.filter((m) => m.tier !== 'private' && !m.priced).length;
    dsState.expEvs = Array.isArray(exp.evaluators) ? exp.evaluators : [];
    const opts = dsModelOptions(s.models);
    const usable = new Set(
      opts.groups.flatMap((g) => g.options.filter((o) => s.content || !o.external).map((o) => o.value)),
    );
    s.picked = s.picked === null ? opts.defaults : s.picked.filter((n) => usable.has(n));
    const known = new Set(dsState.expEvs.map((e) => e.id));
    if (known.size) s.evs = s.evs.filter((id) => known.has(id));
    if (s.slug && !s.datasets.some((d) => d.slug === s.slug)) {
      s.msg = `There is no dataset "${s.slug}" any more`;
      s.bad = true;
      s.slug = '';
      s.ex = '';
    }
    if (!s.slug && s.datasets.length) s.slug = s.datasets[0].slug;
    // A run in progress (this page's, or one started elsewhere) is followed here.
    if (exp.running && !s.runId) {
      s.runId = exp.running.id;
      s.progress = exp.running;
      s.record = null;
    }
  } catch (e) {
    s.loadError = e.message;
  } finally {
    s.loaded = true;
    s.loading = false;
    s.repaint();
  }
}

// One dataset's examples: for the example picker and the original outputs. Cached for the page's life.
function dsPgExamples(s, slug) {
  if (!slug) return null;
  const have = s.examples[slug];
  if (have !== undefined) return have;
  s.examples[slug] = 'loading';
  dsApi(dsPath(slug))
    .then((r) => {
      s.examples[slug] = Array.isArray(r.examples) ? r.examples : [];
    })
    .catch((e) => {
      s.examples[slug] = { error: e.message };
    })
    .finally(() => s.repaint());
  return 'loading';
}

const DS_POLL_RETRY = 'Could not refresh the progress. Retrying…';
// The progress block's moving parts, set in place between repaints so focus and the Stop button stay put.
function dsPgPaintProgress(s) {
  const p = s.progress || {};
  const line = document.getElementById('ds-pg-progress');
  if (line) line.textContent = dsRunLine(p);
  const bar = document.getElementById('ds-pg-bar');
  if (bar) {
    bar.max = Math.max(1, p.total || 1);
    bar.value = p.done || 0;
  }
  const stop = document.getElementById('ds-pg-stop');
  if (stop && p.cancelling) {
    stop.disabled = true;
    stop.textContent = 'Stopping…';
  }
}
function dsPgPaintMsg(s) {
  const m = document.getElementById('ds-pg-msg');
  if (!m) return;
  m.textContent = s.msg;
  m.classList.toggle('bad', !!s.bad);
  m.classList.toggle('ds-wait', !s.bad && s.msg === DS_POLL_RETRY); // neither good news nor an error
}

// Polls the run every 2 s, backing off while polls fail (D-T7-2). It stops when the page or the mode changes (no
// #ds-pg); the next mount resumes it.
function dsPgPoll(s) {
  if (s.timer || !s.runId) return;
  const id = s.runId;
  s.timer = setTimeout(async () => {
    let r = null;
    let err = null;
    try {
      r = await dsApi(`/api/experiments/${encodeURIComponent(id)}`);
    } catch (e) {
      err = e;
    }
    if (!s.timer || s.runId !== id) return; // stopped meanwhile
    s.timer = null;
    const here = !!document.getElementById('ds-pg');
    if (err) {
      if (err.status === 404) {
        s.runId = null;
        s.progress = null;
        s.msg = 'The run is no longer listed';
        s.bad = true;
        return void (here && s.repaint());
      }
      // The run goes on at the server; the page says it is behind and tries again, later each time.
      s.pollFails += 1;
      dsPgSay(s, DS_POLL_RETRY);
      if (here) dsPgPaintMsg(s);
    } else if (r && r.status === 'running') {
      s.pollFails = 0;
      if (s.msg === DS_POLL_RETRY) {
        dsPgSay(s, '');
        if (here) dsPgPaintMsg(s);
      }
      s.progress = dsMergeProgress(s.progress, r.progress);
      if (here) dsPgPaintProgress(s);
    } else if (r) {
      s.pollFails = 0;
      s.runId = null;
      s.progress = null;
      s.record = r;
      s.msg = '';
      s.focus = 'results';
      dsPgExamples(s, r.dataset);
      return void (here && s.repaint());
    }
    if (here) dsPgPoll(s);
  }, dsPollDelay(s.pollFails));
}

// Stop after the current call (D-T5-6): the call in flight finishes and is recorded, then the run ends as
// "cancelled". The poll brings the record; a 409 means the run ended first, which the poll shows as well.
async function dsPgCancel(pg) {
  const s = dsPg(pg);
  const id = s.runId;
  if (!id || (s.progress && s.progress.cancelling)) return;
  s.progress = dsMergeProgress(s.progress, { cancelling: true });
  dsPgPaintProgress(s);
  try {
    await dsSend('POST', `/api/experiments/${encodeURIComponent(id)}/cancel`, {});
  } catch (e) {
    if (e.status === 409 || s.runId !== id) return;
    s.progress = dsMergeProgress(s.progress, { cancelling: false });
    dsPgSay(s, `Could not stop the run: ${e.message}`, true);
    s.focus = 'stop';
    s.repaint();
  }
}
const dsPgStop = (s) => {
  clearTimeout(s.timer);
  s.timer = null;
};

function dsPlaygroundMount(pg, repaint) {
  const root = document.getElementById('ds-pg');
  if (!root) return;
  const s = dsPg(pg);
  s.repaint = repaint;
  if (!s.hooked && typeof onUnmount === 'function') {
    // Leaving the page stops the polling and drops the lists, so a return reads them fresh.
    s.hooked = true;
    onUnmount(() => {
      s.hooked = false;
      s.loaded = false;
      s.examples = {};
      dsPgStop(s);
    });
  }
  if (!s.loaded) {
    if (!s.loading) dsPgLoad(pg);
    return;
  }
  if (s.loadError) {
    return void root.replaceChildren(
      dsEl(
        'div',
        { class: 'empty' },
        `Could not read the datasets and models: ${s.loadError} `,
        dsEl('button', { type: 'button', class: 'btn ghost', 'data-dspg': 'retry', 'data-dsfocus': 'retry' }, 'Retry'),
      ),
    );
  }
  if (!s.datasets.length) {
    return void root.replaceChildren(
      dsEl(
        'div',
        { class: 'empty' },
        'No dataset to replay yet. Save turns from the ',
        dsEl('a', { class: 'ds-a', href: '#trace' }, 'Trace explorer'),
        ' (⤓ Add to dataset), or import one under ',
        dsEl('a', { class: 'ds-a', href: '#datasets' }, 'Datasets'),
        '.',
      ),
    );
  }
  const running = !!s.runId;
  const locked = running || s.busy;
  const opts = dsModelOptions(s.models);
  const allOpts = opts.groups.flatMap((g) => g.options);
  const full = s.picked.length >= DS_MAX_MODELS;

  // What to replay: a dataset, then the whole of it or one example.
  const dsSel = dsEl(
    'select',
    { class: 'input', id: 'ds-pg-ds', 'data-dspg': 'ds', 'data-dsfocus': 'ds' },
    s.datasets.map((d) =>
      dsEl(
        'option',
        { value: d.slug, selected: d.slug === s.slug },
        `${d.name} · ${d.count} example${d.count === 1 ? '' : 's'}`,
      ),
    ),
  );
  const exs = dsPgExamples(s, s.slug);
  const exSel = dsEl('select', { class: 'input', id: 'ds-pg-ex', 'data-dspg': 'ex', 'data-dsfocus': 'ex' });
  if (exs === 'loading') exSel.append(dsEl('option', { value: '' }, 'Loading…'));
  else if (exs && exs.error) exSel.append(dsEl('option', { value: '' }, `Could not read the examples: ${exs.error}`));
  else {
    const list = Array.isArray(exs) ? exs : [];
    if (s.ex && !list.some((e) => e.id === s.ex)) s.ex = '';
    exSel.append(
      dsEl('option', { value: '' }, `Whole dataset (${list.length} example${list.length === 1 ? '' : 's'})`),
    );
    list.forEach((e, i) => {
      const o = dsEl('option', { value: e.id, selected: e.id === s.ex });
      // With content off there is no text to show: the example's place and id instead.
      const t = dsUserText(e);
      o.textContent = `${i + 1}. ${t == null ? e.id : dsPreview(t, 90)}`;
      exSel.append(o);
    });
  }
  const what = dsEl(
    'div',
    { class: 'ds-pg-what' },
    dsEl('label', { for: 'ds-pg-ds' }, 'Dataset', dsSel),
    dsEl('label', { for: 'ds-pg-ex' }, 'Examples', exSel),
  );

  // Models: up to three, local first; external ones only with content viewing on (their preview needs it).
  const modelSet = dsEl(
    'fieldset',
    { class: 'ds-pg-models' },
    dsEl('legend', null, `Models · ${s.picked.length} of up to ${DS_MAX_MODELS}`),
  );
  for (const g of opts.groups) {
    const ext = g.label.startsWith('External');
    const box = dsEl('div', { class: 'ds-pg-group', role: 'group', 'aria-label': g.label }, dsEl('b', null, g.label));
    if (!g.options.length)
      box.append(
        dsEl(
          'small',
          { class: 'muted' },
          ext ? 'None with a known price.' : 'None. Add Ollama or LM Studio under ',
          ext ? null : dsEl('a', { class: 'ds-a', href: '#gateway/providers' }, 'Providers'),
          ext ? null : '.',
        ),
      );
    if (ext && g.options.length && !s.content) box.append(dsEl('small', { class: 'ds-pg-warn' }, DS_EXTERNAL_OFF));
    for (const o of g.options) {
      const on = s.picked.includes(o.value);
      const off = (ext && !s.content) || (!on && full);
      box.append(
        dsEl(
          'label',
          {
            class: 'gw-check ds-check',
            title: ext && !s.content ? DS_EXTERNAL_OFF : !on && full ? 'Three models at most' : null,
          },
          dsEl('input', {
            type: 'checkbox',
            value: o.value,
            checked: on,
            disabled: off,
            'data-dspg': 'model',
            'data-dsfocus': `model:${o.value}`,
          }),
          dsEl('span', { class: 'mono' }, o.label),
        ),
      );
    }
    if (ext && s.unpriced)
      box.append(
        dsEl(
          'small',
          { class: 'muted' },
          `${s.unpriced} more without a known price are not offered: the cost cap could not count them.`,
        ),
      );
    modelSet.append(box);
  }
  if (!allOpts.length)
    modelSet.append(dsEl('small', { class: 'ds-pg-warn' }, 'No gateway model can replay: add a provider first.'));

  const evSet = dsEl('fieldset', { class: 'ds-pg-evs' }, dsEl('legend', null, 'Evaluators'));
  for (const e of dsState.expEvs || []) {
    evSet.append(
      dsEl(
        'label',
        { class: 'gw-check ds-check' },
        dsEl('input', {
          type: 'checkbox',
          value: e.id,
          checked: s.evs.includes(e.id),
          'data-dspg': 'ev',
          'data-dsfocus': `ev:${e.id}`,
        }),
        dsEl('span', null, e.title || e.id),
        dsEl('small', { class: 'ds-kind' }, e.kind === 'judge' ? 'judge' : 'code'),
      ),
    );
  }

  const caps = dsEl(
    'div',
    { class: 'ds-pg-caps' },
    dsEl(
      'label',
      { for: 'ds-pg-cost' },
      'Cost cap (USD)',
      dsEl('input', {
        class: 'input',
        id: 'ds-pg-cost',
        type: 'number',
        // R8 takes any amount over $0 up to $10 (a cap of $0.005 is fine); dsRunBody checks the low end.
        max: 10,
        step: 'any',
        inputmode: 'decimal',
        value: s.maxCostUSD,
        'data-dspg': 'cost',
        'data-dsfocus': 'cost',
      }),
    ),
    dsEl(
      'label',
      { for: 'ds-pg-req' },
      'Request cap',
      dsEl('input', {
        class: 'input',
        id: 'ds-pg-req',
        type: 'number',
        min: 1,
        max: 1000,
        step: 1,
        inputmode: 'numeric',
        value: s.maxRequests,
        'data-dspg': 'req',
        'data-dsfocus': 'req',
      }),
    ),
    dsEl(
      'small',
      { class: 'muted' },
      'The run stops before the next call once a cap is reached. Tools are declared, never run.',
    ),
  );

  const external = s.picked.some((n) => dsPgExternal(s, n));
  const runBtn = dsEl(
    'button',
    { class: 'btn', type: 'submit', 'data-dspg': 'run', 'data-dsfocus': 'run', disabled: locked || !!s.preview },
    s.busy && !s.preview ? 'Working…' : external ? 'Preview what will be sent' : 'Run',
  );
  const say = dsEl('p', {
    class: `ds-msg${s.bad ? ' bad' : s.msg === DS_POLL_RETRY ? ' ds-wait' : ''}`,
    role: 'status',
    id: 'ds-pg-msg',
  });
  say.textContent = s.msg;
  const set = dsEl(
    'fieldset',
    { class: 'ds-pg-set', disabled: locked },
    dsEl('legend', { class: 'ds-sr' }, 'Replay a dataset'),
    dsEl('div', { class: 'ds-pg-grid' }, dsEl('div', { class: 'ds-pg-col' }, what, caps), modelSet, evSet),
  );
  const actions = dsEl(
    'div',
    { class: 'gw-row ds-pg-actions' },
    runBtn,
    external && !s.preview && !locked
      ? dsEl('small', { class: 'muted' }, 'External models get masked text, and you see it before anything is sent.')
      : null,
  );
  const parts = [set, actions, say];

  // The masked messages each external model would get for the first example, then an explicit send (S4).
  if (s.preview) {
    const n = s.preview.body.examples ? 1 : (Array.isArray(exs) ? exs.length : 0) || 1;
    const pv = dsEl(
      'section',
      { class: 'ds-pv', 'aria-labelledby': 'ds-pv-title' },
      dsEl('h4', { id: 'ds-pv-title', tabindex: -1 }, 'What will be sent'),
      dsEl(
        'p',
        { class: 'muted' },
        n > 1
          ? `The first example as each external model receives it, with secrets and personal data masked; the other ${n - 1} are masked the same way. Nothing is sent until you press Send.`
          : 'This example as each external model receives it, with secrets and personal data masked. Nothing is sent until you press Send.',
      ),
    );
    for (const item of s.preview.items) pv.append(dsPvModel(item));
    pv.append(
      dsEl(
        'div',
        { class: 'gw-row' },
        dsEl(
          'button',
          { type: 'button', class: 'btn', 'data-dspg': 'send', 'data-dsfocus': 'send', disabled: s.busy },
          s.busy ? 'Sending…' : `Send to ${s.preview.providers.join(', ')}`,
        ),
        dsEl('button', { type: 'button', class: 'btn ghost', 'data-dspg': 'back', 'data-dsfocus': 'back' }, 'Back'),
      ),
    );
    parts.push(pv);
  }

  // A run in progress: it ends at its caps, when every example has run, or after the current call on Stop (R8).
  if (running) {
    parts.push(dsPgRunBlock(s));
    dsPgPoll(s);
  }

  if (s.record) {
    const rec = s.record;
    const exRows = dsPgExamples(s, rec.dataset);
    const exState = exRows === 'loading' ? 'loading' : Array.isArray(exRows) ? 'ready' : 'error';
    const head = dsEl('div', { class: 'ds-pg-rhead' });
    const h = dsEl('h4', { id: 'ds-pg-results', tabindex: -1, 'data-dsfocus': 'results' }, 'Results');
    head.append(
      h,
      dsEl('span', { class: `ds-status ${rec.status === 'done' ? 'ok' : 'warn'}` }, dsStatusText(rec)),
      dsEl('span', { class: 'ds-spacer' }),
      dsEl('a', { class: 'ds-a', href: '#datasets/experiments' }, 'All experiments →'),
    );
    parts.push(
      dsEl(
        'section',
        { class: 'ds-pg-out', 'aria-labelledby': 'ds-pg-results' },
        head,
        dsResultsEl(rec, Array.isArray(exRows) ? exRows : [], s.content, exState),
      ),
    );
  }

  root.replaceChildren(...parts);
  // Focus goes back to the control that caused the repaint (or to what it opened).
  if (s.focus) {
    const want = s.focus;
    s.focus = '';
    const el = [...root.querySelectorAll('[data-dsfocus]')].find((x) => x.dataset.dsfocus === want);
    if (el && !el.disabled) el.focus();
    else if (want === 'send' || want === 'preview') root.querySelector('#ds-pv-title')?.focus();
  }
}

// The progress block of a run in progress (this page's or one followed), with its Stop button. Built with dsEl
// only; the dataset name is text (S1).
function dsPgRunBlock(s) {
  const p = s.progress || {};
  const stopping = !!p.cancelling;
  const line = dsEl('span', { id: 'ds-pg-progress' });
  line.textContent = dsRunLine(p);
  const named = (Array.isArray(s.datasets) ? s.datasets : []).find((d) => d.slug === p.dataset);
  return dsEl(
    'div',
    { class: 'ds-pg-run', role: 'status', 'aria-live': 'polite' },
    dsEl('span', { class: 'ds-dot', 'aria-hidden': 'true' }),
    dsEl('b', null, p.dataset && p.dataset !== s.slug ? `Running on ${named ? named.name : p.dataset}` : 'Running'),
    line,
    dsEl('progress', {
      id: 'ds-pg-bar',
      max: Math.max(1, p.total || 1),
      value: p.done || 0,
      'aria-label': 'Replay progress',
    }),
    dsEl(
      'button',
      {
        type: 'button',
        class: 'btn ghost ds-pg-stop',
        id: 'ds-pg-stop',
        'data-dspg': 'stop',
        'data-dsfocus': 'stop',
        disabled: stopping,
        title: 'The call in flight finishes and is counted; nothing after it is sent.',
      },
      stopping ? 'Stopping…' : 'Stop after the current call',
    ),
    dsEl('small', { class: 'muted' }, 'It ends at its caps, when every example has run, or when you stop it.'),
  );
}

// One external model's part of the preview: the messages, then the tools declared with them (never run), all as
// text. The descriptions are the server's masked ones, so the page shows exactly what is sent.
function dsPvModel(item) {
  const block = dsEl('div', { class: 'ds-pv-model' }, dsEl('b', { class: 'mono' }, String(item.model || '')));
  for (const m of Array.isArray(item.messages) ? item.messages : []) {
    const box = dsEl('pre', { class: 'ev-pre ds-pv-box', tabindex: 0, 'aria-label': `${m.role} message` });
    box.textContent = typeof m.content === 'string' ? m.content : '';
    block.append(dsEl('div', { class: 'ev-pre-head' }, m.role), box);
  }
  const tools = (Array.isArray(item.tools) ? item.tools : []).filter((t) => t && t.function);
  if (tools.length) {
    block.append(dsEl('div', { class: 'ev-pre-head' }, `Tools declared, never run (${tools.length})`));
    for (const t of tools) {
      const fn = t.function;
      const name = dsEl('b', { class: 'mono' });
      name.textContent = typeof fn.name === 'string' ? fn.name : '';
      const box = dsEl('pre', { class: 'ev-pre ds-pv-box', tabindex: 0, 'aria-label': 'tool description' });
      box.textContent = typeof fn.description === 'string' && fn.description ? fn.description : '(no description)';
      block.append(dsEl('div', { class: 'ds-pv-tool' }, name, box));
    }
  }
  return block;
}

function dsPgSay(s, msg, bad = false) {
  s.msg = msg;
  s.bad = bad;
}

// The run body the form holds now. Evaluators go in the server's order, so the pass-rate columns line up across runs.
function dsPgFormBody(s) {
  const order = (dsState.expEvs || []).map((e) => e.id);
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  return dsRunBody({
    dataset: s.slug,
    example: s.ex,
    models: s.picked,
    evaluators: [...(s.evs || [])].sort((a, b) => rank(a) - rank(b)),
    maxCostUSD: s.maxCostUSD,
    maxRequests: s.maxRequests,
  });
}
// What Send posts: the previewed body, and only while the form still matches it. The confirm token covers the
// dataset, examples and models only, so a cap or evaluator changed after the preview would otherwise go unseen.
function dsPgSendBody(s) {
  if (!s.preview || !s.preview.body) return null;
  return JSON.stringify(dsPgFormBody(s)) === JSON.stringify(s.preview.body) ? s.preview.body : null;
}
// What pressing Run or Send does with the form as it is (D-T7-8): `error` (the form is not a run), `refuse` (an
// external model with content viewing off), `preview` (an external model and no preview of this form yet) or `send`,
// which carries the preview's `confirm` only while the preview matches the form.
function dsPgSendPlan(s) {
  const body = dsPgFormBody(s);
  if (body.error) return { kind: 'error', message: body.error };
  const external = body.models.some((n) => dsPgExternal(s, n));
  if (external && !s.content) return { kind: 'refuse', message: DS_EXTERNAL_OFF };
  const previewed = dsPgSendBody(s);
  if (previewed) return { kind: 'send', body: previewed, confirm: s.preview.confirm };
  if (external) return { kind: 'preview', body };
  return { kind: 'send', body };
}
// What a refused start means for the page: `message` to say, `dropPreview`, `reload` (the model list changed under
// the page) and `follow` (another run holds the one slot: follow it, so the page shows when this one can start).
function dsPgOnError(s, err) {
  const status = err && err.status;
  if (status === 409)
    return {
      follow: !s.runId,
      message: 'Another experiment is running. One runs at a time: start this one when it ends.',
    };
  if (status === 428)
    return {
      dropPreview: true,
      reload: true,
      message: 'Preview what will be sent first: an external model is in this run.',
    };
  // The server refuses the preview only while content viewing is off, whatever the page last read.
  if (status === 403) return { dropPreview: true, message: DS_EXTERNAL_OFF };
  return { message: (err && err.message) || 'Could not start the run' };
}
// One edit to the form. Any edit drops an open preview, so what is sent is always what was previewed last.
function dsPgEdit(s, act, value, checked) {
  if (act === 'model' || act === 'ev') {
    const list = act === 'model' ? s.picked : s.evs;
    const i = list.indexOf(value);
    if (checked && i < 0) {
      if (act === 'model' && list.length >= DS_MAX_MODELS) return { error: 'Three models at most' };
      list.push(value);
    } else if (!checked && i >= 0) list.splice(i, 1);
  } else if (act === 'cost') s.maxCostUSD = value;
  else if (act === 'req') s.maxRequests = value;
  else if (act === 'ds') {
    s.slug = value;
    s.ex = '';
  } else if (act === 'ex') s.ex = value;
  else return {};
  s.preview = null;
  return {};
}

// Carries out a plan from dsPgSendPlan (dsPlaygroundAct makes it): builds the preview, or starts the run with the
// preview's confirm token when it has one. A refusal from the server is read by dsPgOnError.
async function dsPgRun(pg, plan) {
  const s = dsPg(pg);
  if (s.busy || s.runId) return;
  if (plan.kind !== 'preview' && plan.kind !== 'send') {
    dsPgSay(s, plan.message, true);
    return s.repaint();
  }
  const { body } = plan;
  const previewing = plan.kind === 'preview';
  s.busy = true;
  dsPgSay(s, previewing ? 'Building the preview…' : 'Starting…');
  s.repaint();
  try {
    if (previewing) {
      const r = await dsSend('POST', '/api/experiments', { ...body, preview: true });
      s.preview = {
        items: Array.isArray(r.preview) ? r.preview : [],
        confirm: String(r.confirm || ''),
        body,
        providers: dsPgProviders(s, body.models),
      };
      dsPgSay(s, '');
      s.focus = 'preview';
    } else {
      const r = await dsSend('POST', '/api/experiments', plan.confirm ? { ...body, confirm: plan.confirm } : body);
      s.preview = null;
      s.record = null;
      s.runId = r.id;
      s.pollFails = 0;
      const exs = s.examples[body.dataset];
      const n = body.examples ? body.examples.length : Array.isArray(exs) ? exs.length : 0;
      s.progress = { dataset: body.dataset, done: 0, total: n * body.models.length, requests: 0, cost: 0 };
      dsPgSay(s, '');
    }
  } catch (e) {
    const next = dsPgOnError(s, e);
    if (next.dropPreview) s.preview = null;
    if (next.reload) s.loaded = false;
    dsPgSay(s, next.message, true);
    if (next.follow) {
      const r = await dsApi('/api/experiments').catch(() => null);
      if (r && r.running && !s.runId) {
        s.runId = r.running.id;
        s.progress = r.running;
      }
    }
  } finally {
    s.busy = false;
    s.repaint();
  }
}

// Clicks, changes and the submit of the Playground form in Dataset mode.
function dsPlaygroundAct(event, pg, repaint) {
  const s = dsPg(pg);
  s.repaint = repaint;
  if (event.type === 'submit') {
    event.preventDefault();
    // Enter in a cap field submits before its change event: read the fields as they are now.
    const cost = document.getElementById('ds-pg-cost');
    const req = document.getElementById('ds-pg-req');
    if (cost && cost.value !== s.maxCostUSD) dsPgEdit(s, 'cost', cost.value);
    if (req && req.value !== s.maxRequests) dsPgEdit(s, 'req', req.value);
    s.focus = 'run';
    // Run starts over, so an external run is previewed again (the button is off while a preview is open).
    return void dsPgRun(pg, dsPgSendPlan({ ...s, preview: null }));
  }
  const el = event.target && event.target.closest ? event.target.closest('[data-dspg]') : null;
  if (!el) return;
  const act = el.dataset.dspg;
  if (event.type === 'change') {
    if (!['cost', 'req', 'ds', 'ex'].includes(act)) return;
    const had = !!s.preview;
    dsPgEdit(s, act, el.value);
    // A cap edit repaints only when it dropped a preview (Send must go); a dataset or example edit always does.
    if (act === 'ds' || act === 'ex' || had) {
      dsPgSay(s, had ? 'The form changed: preview what will be sent again' : '');
      s.focus = act;
      repaint();
    }
    return;
  }
  if (event.type !== 'click') return;
  if (act === 'model' || act === 'ev') {
    const r = dsPgEdit(s, act, el.value, el.checked);
    if (r.error) {
      event.preventDefault();
      dsPgSay(s, r.error, true);
    } else dsPgSay(s, '');
    s.focus = el.dataset.dsfocus;
    return void repaint();
  }
  if (act === 'send') {
    // Send goes only with a preview that still matches the form; otherwise the preview goes and is asked for again.
    const plan = dsPgSendPlan(s);
    if (plan.kind === 'send' && plan.confirm) return void dsPgRun(pg, plan);
    s.preview = null;
    dsPgSay(s, plan.message || 'The form changed since the preview: preview again', true);
    return void repaint();
  }
  if (act === 'stop') return void dsPgCancel(pg);
  if (act === 'back') {
    s.preview = null;
    s.focus = 'run';
    return void repaint();
  }
  if (act === 'retry') {
    s.loaded = false;
    return void repaint();
  }
}

/* ---------- "Add to dataset" (trace explorer) ---------- */
let dsPop = null; // the open picker: { el, anchor, off }

function dsClosePicker(refocus = false) {
  if (!dsPop) return;
  const { el, anchor, off } = dsPop;
  dsPop = null;
  off();
  el.remove();
  if (refocus && anchor && anchor.isConnected) anchor.focus();
}

// A small form by the button: a dataset (or "New dataset…" with a name), then POST the items. `onAdded` gets
// { slug, added, skipped, say } once the server has answered; the result line stays until the picker closes, and
// `say(msg, bad)` replaces it.
function dsAddPicker(anchorEl, items, { onAdded, verb = 'Add', heading } = {}) {
  dsClosePicker();
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const NEW = '__new'; // never a slug (slugs have no underscore)
  const sel = dsEl('select', { class: 'input', id: 'ds-pick-sel' }, dsEl('option', { value: '' }, 'Loading…'));
  const nameIn = dsEl('input', {
    class: 'input',
    id: 'ds-pick-name',
    maxlength: 80,
    autocomplete: 'off',
    placeholder: 'e.g. Auth regressions',
  });
  const nameRow = dsEl('label', { class: 'ds-pop-field', hidden: true }, 'Name', nameIn);
  const go = dsEl('button', { type: 'submit', class: 'btn' }, verb);
  const close = dsEl('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
  const out = dsEl('p', { class: 'ds-msg', role: 'status' });
  const what = list.length === 1 ? 'this turn' : `${list.length} turns`;
  const title = heading || `Add ${what} to a dataset`;
  const el = dsEl(
    'form',
    { class: 'holo-deck ds-pop', role: 'dialog', 'aria-label': title },
    dsEl('b', { class: 'ds-pop-title' }, title),
    dsEl('label', { class: 'ds-pop-field' }, 'Dataset', sel),
    nameRow,
    dsEl('div', { class: 'ds-inline' }, go, close),
    out,
  );
  document.body.append(el);

  // Below the button, or above it when the window has no room; kept inside the window.
  const place = () => {
    const r = anchorEl.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w));
    const below = r.bottom + 6 + h <= innerHeight - 8;
    el.style.left = `${left}px`;
    el.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
  };
  place();

  const onDown = (e) => {
    if (!el.contains(e.target) && !anchorEl.contains(e.target)) dsClosePicker();
  };
  // Escape closes and gives focus back to the opener; Tab stays inside the picker, wrapping at either end (D-T6-7).
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dsClosePicker(true);
    } else if (e.key === 'Tab') {
      const controls = [...el.querySelectorAll('select, input, button')].filter(
        (c) => !c.disabled && !c.closest('[hidden]'),
      );
      const to = dsWrapFocus(controls, document.activeElement, e.shiftKey);
      if (to) {
        e.preventDefault();
        to.focus();
      }
    }
  };
  document.addEventListener('pointerdown', onDown, true);
  el.addEventListener('keydown', onKey);
  addEventListener('resize', place);
  dsPop = {
    el,
    anchor: anchorEl,
    off: () => {
      document.removeEventListener('pointerdown', onDown, true);
      removeEventListener('resize', place);
    },
  };
  if (typeof onUnmount === 'function') onUnmount(() => dsClosePicker());

  let ready = false; // the list is in and content viewing is on
  const showName = () => {
    nameRow.hidden = sel.value !== NEW;
    go.disabled = !ready; // after an add, another dataset may be picked
    place();
  };
  sel.addEventListener('change', showName);
  close.addEventListener('click', () => dsClosePicker(true));

  go.disabled = true;
  dsApi('/api/datasets')
    .then((r) => {
      if (dsPop === null || dsPop.el !== el) return;
      const rows = dsListRows(r.datasets);
      const last = typeof store !== 'undefined' ? store.get('datasets.last', '') : '';
      sel.replaceChildren(
        ...rows.map((d) => dsEl('option', { value: d.slug }, `${d.name} · ${d.count}`)),
        dsEl('option', { value: NEW }, 'New dataset…'),
      );
      sel.value = rows.some((d) => d.slug === last) ? last : rows.length ? rows[0].slug : NEW;
      ready = r.content !== false;
      showName();
      if (r.content === false) dsSay(out, `${DS_OFF}: turns cannot be added`, true);
      (sel.value === NEW ? nameIn : sel).focus();
    })
    .catch((e) => dsSay(out, `Could not read the datasets: ${e.message}`, true));
  sel.focus();

  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    dsSay(out, 'Adding…');
    try {
      let slug = sel.value;
      if (slug === NEW) {
        const name = nameIn.value.trim();
        if (!name) {
          go.disabled = false;
          nameIn.focus();
          return dsSay(out, 'Give the new dataset a name', true);
        }
        slug = (await dsSend('POST', '/api/datasets', { name })).dataset.slug;
      }
      const r = await dsSend('POST', `${dsPath(slug)}/examples`, { items: list });
      if (typeof store !== 'undefined') store.set('datasets.last', slug);
      dsSay(out, dsAddResult(r));
      close.textContent = 'Close';
      if (typeof onAdded === 'function')
        onAdded({ slug, added: r.added || [], skipped: r.skipped || [], say: (m, bad) => dsSay(out, m, bad) });
    } catch (err) {
      go.disabled = false;
      dsSay(out, err.status === 403 ? `${DS_OFF}: turns cannot be added` : err.message, true);
    }
  });
  return el;
}

// The explorer's dataset controls, wired by mountTrace: the picked turns (S.multi), the bar over the tree, the
// "⤓ Add to dataset" and "↻ Replay turn" buttons. Plain clicks keep their meaning; Ctrl/Cmd-click (or Space in
// the tree) toggles a turn.
function dsTraceMount(app, S, rowsBox) {
  S.multi = [];
  const [addBtn, replayBtn] = $$('[data-sub="4"]', app);
  const count = dsEl('b');
  const barAdd = dsEl('button', { type: 'button', class: 'tr-btn ghost' }, '⤓ Add to dataset');
  const clear = dsEl('button', { type: 'button', class: 'tr-btn ghost' }, 'Clear');
  const bar = dsEl(
    'div',
    { class: 'tr-notice ds-selbar', role: 'status', hidden: true },
    count,
    dsEl('span', { class: 'tr-muted ds-hint' }, 'Ctrl/⌘-click or Space toggles a turn'),
    barAdd,
    clear,
  );
  const cols = $('.tr-cols', app);
  if (cols) cols.before(bar);
  const buttons = [addBtn, replayBtn, barAdd].filter(Boolean);
  // Shown, with the label in a .tr-bl span so a narrow detail keeps only the icon (the aria-label names it).
  for (const b of [addBtn, replayBtn]) {
    if (!b) continue;
    const [glyph, ...words] = b.textContent.trim().split(' ');
    b.replaceChildren(`${glyph} `, dsEl('span', { class: 'tr-bl' }, words.join(' ')));
    b.setAttribute('aria-label', words.join(' '));
    b.classList.add('ds-act');
    b.hidden = false;
  }
  if (addBtn) addBtn.title = 'Add this turn (or the picked turns) to a dataset';
  if (replayBtn) replayBtn.title = 'Add this turn to a dataset and replay it in the Playground';
  // R7: with content viewing off the server refuses to add turns, so the buttons say so up front.
  dsApi('/api/datasets')
    .then((r) => {
      if (!r || r.content !== false) return;
      for (const b of buttons) {
        b.disabled = true;
        b.title = DS_OFF;
      }
    })
    .catch(() => {
      /* an older server: a click shows the error */
    });

  // The turn a tree row stands for: a dimmed row names its turn, the turn span of the turn on show is S.turn.
  const turnOf = (row) => {
    if (row.dataset.tturn !== undefined) return Number(row.dataset.tturn);
    const s = row.dataset.tspan && S.spans && S.spans.get(row.dataset.tspan);
    return s && s.kind === 'turn' ? S.turn : null;
  };
  const paint = () => {
    const n = S.multi.length;
    bar.hidden = !n;
    count.textContent = `${n} turn${n === 1 ? '' : 's'} selected${n >= 50 ? ' (the most one add takes)' : ''}`;
    for (const row of $$('.tr-row', rowsBox)) {
      const t = turnOf(row);
      row.classList.toggle('ds-picked', t !== null && S.multi.some((x) => x.key === S.key && x.turn === t));
    }
  };
  const toggle = (turn) => {
    S.multi = trSelToggle(S.multi, { key: S.key, turn });
    paint();
  };

  // Capture, so the explorer's own click (open the turn, select the span) does not run for a toggle.
  app.addEventListener(
    'click',
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || !trCanAct(S)) return;
      const row = e.target.closest && e.target.closest('.tr-row');
      if (!row || !rowsBox.contains(row)) return;
      const t = turnOf(row);
      if (t === null || !Number.isInteger(t)) return;
      e.preventDefault();
      e.stopPropagation();
      toggle(t);
    },
    true,
  );
  rowsBox.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey || e.target !== rowsBox || !trCanAct(S)) return;
    e.preventDefault();
    toggle(S.turn);
  });
  clear.addEventListener('click', () => {
    S.multi = [];
    paint();
    rowsBox.focus();
  });

  // Why a click did nothing yet, in the explorer's notice line (traceview.js owns it; the next refresh clears it).
  const tell = (msg) => {
    const n = $('#tr-notice');
    const m = $('#tr-notice-msg');
    if (!n || !m) return;
    m.textContent = msg;
    const r = $('#tr-refresh');
    if (r) r.hidden = true;
    n.hidden = false;
  };
  const openAdd = (btn) => {
    const { body, why } = dsAddOrWhy(S.multi, S);
    if (!body) return void tell(why);
    const picked = S.multi.length > 0;
    dsAddPicker(btn, body.items, {
      onAdded: () => {
        if (!picked) return;
        S.multi = [];
        paint();
      },
    });
  };
  if (addBtn) addBtn.addEventListener('click', () => openAdd(addBtn));
  barAdd.addEventListener('click', () => openAdd(barAdd));

  // Replay: the turn on show goes into a dataset (or is found there), then the Playground opens on it.
  if (replayBtn)
    replayBtn.addEventListener('click', () => {
      const { body, why } = dsAddOrWhy([], S);
      if (!body) return void tell(why);
      const item = body.items[0];
      dsAddPicker(replayBtn, body.items, {
        verb: 'Add and replay',
        heading: 'Replay this turn: first it goes into a dataset',
        // Only an example in the dataset is replayed; a skipped turn says why in the picker and nothing opens.
        onAdded: async ({ slug, added, skipped, say }) => {
          let t = dsReplayTarget({ slug, added, skipped, examples: null, item });
          if (!t.hash) {
            // Skipped as already saved: find that example by key and turn (the light view is enough).
            const r = await dsApi(`${dsPath(slug)}?view=preview`).catch(() => null);
            t = dsReplayTarget({ slug, added, skipped, examples: r && r.examples, item });
          }
          if (t.hash) location.hash = t.hash;
          else say(t.message, true);
        },
      });
    });

  return { paint };
}

if (typeof module !== 'undefined')
  module.exports = {
    dsListRows,
    dsPreview,
    dsTagsPatch,
    dsImportError,
    dsLinkHref,
    dsAddResult,
    dsSlugOf,
    dsRoute,
    dsRunOf,
    dsModelOptions,
    dsRunBody,
    dsResultCells,
    dsPassTable,
    dsCompare,
    dsProgressLine,
    dsStopLine,
    dsPgParams,
    dsPg,
    dsPgEdit,
    dsPgFormBody,
    dsPgSendBody,
    dsPvModel,
    dsAutoAddBody,
    dsAutoAddEl,
    dsPgRunBlock,
    dsReplayTarget,
    dsAddOrWhy,
    dsMergeProgress,
    dsPollDelay,
    dsDeltaText,
    dsResultsEl,
    dsImportTooBig,
    dsMountExamples,
    dsWrapFocus,
    dsPgSendPlan,
    dsPgOnError,
  };
