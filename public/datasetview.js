'use strict';
/* Datasets: the list (#datasets), one dataset's examples (#datasets?ds=<slug>), the Experiments tab
   (#datasets/experiments) and "Add to dataset" for the trace explorer (dsAddPicker, dsTraceMount). Names, tags,
   reasons and every example text are set with textContent through dsEl (S1); the only innerHTML here is static
   markup. With content viewing off the server sends no text, and adding turns and export are refused (R7). */

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

// The page and the dataset a Datasets hash names: #datasets, #datasets?ds=<slug>, #datasets/experiments.
function dsRoute(hash) {
  const [route, query = ''] = String(hash || '')
    .replace(/^#/, '')
    .split('?');
  const tab = route.split('/')[1] === 'experiments' ? 'experiments' : 'list';
  const slug = new URLSearchParams(query).get('ds');
  return { tab, slug: tab === 'list' && slug && DS_SLUG.test(slug) ? slug : null };
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

/* ---------- the view ---------- */
const dsState = { req: 0, content: true, evs: null };
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
  if (tab === 'experiments') return void dsPaintExperiments(body);
  try {
    const [list, evs] = await Promise.all([
      dsApi('/api/datasets'),
      dsState.evs ? Promise.resolve(null) : dsApi('/api/evals/evaluators').catch(() => null),
    ]);
    if (!live()) return;
    if (evs && Array.isArray(evs.evaluators)) dsState.evs = evs.evaluators;
    dsState.content = list.content !== false;
    $('#ds-off').hidden = dsState.content;
    if (slug) await dsMountExamples(body, slug, live);
    else dsPaintList(body, list);
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
function dsPaintList(body, list) {
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
      dsSay(msg, `Importing into ${slug}…`);
      try {
        const name =
          f.name
            .replace(/\.[^.]*$/, '')
            .trim()
            .slice(0, 80) || slug;
        const r = await dsSend('POST', '/api/datasets/import', { slug, name, jsonl: String(reader.result || '') });
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
  body.replaceChildren(dsPanel('Datasets', meta, tools, msg, table));
}

function dsListRow(r, msg, reload) {
  const nameCell = dsEl('td', { class: 'ds-name' });
  const showName = () =>
    nameCell.replaceChildren(
      dsEl('a', { href: `#datasets?ds=${encodeURIComponent(r.slug)}`, class: 'ds-a' }, dsEl('b', null, r.name)),
      dsEl('small', { class: 'block muted mono' }, r.slug),
    );
  showName();

  const exportBtn = dsEl('button', { type: 'button', class: 'btn ghost' }, 'Export');
  dsOn(exportBtn, `Download ${r.slug}.jsonl`);
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      await dsDownload(r.slug);
    } catch (err) {
      dsSay(msg, `Export failed: ${err.message}`, true);
    } finally {
      exportBtn.disabled = !dsState.content;
    }
  });

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
    res = await dsApi(dsPath(slug));
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
  const exportBtn = dsEl('button', { type: 'button', class: 'btn ghost' }, 'Export JSONL');
  dsOn(exportBtn, `Download ${slug}.jsonl`);
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      await dsDownload(slug);
    } catch (err) {
      dsSay(msg, `Export failed: ${err.message}`, true);
    } finally {
      exportBtn.disabled = !dsState.content;
    }
  });

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
            examples.map((ex) => dsExampleRow(slug, ex, msg, counter)),
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

function dsExampleRow(slug, ex, msg, counter) {
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
    const btn = dsEl('button', { type: 'button', class: `ds-ref${has ? '' : ' none'}` }, line);
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
    'aria-label': 'Tags, separated by spaces or commas (Enter saves)',
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
    { type: 'button', class: 'btn ghost danger', 'aria-label': 'Delete this example' },
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

/* ---- experiments ---- */
// The Playground's Dataset mode fills this tab; until a run is stored there is only the way there.
function dsPaintExperiments(body) {
  body.innerHTML = `<section class="holo panel ds-panel"><div class="panel-head"><h3>Experiments</h3><span class="meta">replays of a dataset, newest first</span></div>
    <div class="empty" id="ds-exp">Replay a dataset in the <a class="ds-a" href="#gateway/playground">Playground</a> to compare models on it; finished runs are listed here.</div></section>`;
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
// { slug, added, skipped } once the server has answered; the result line stays until the picker closes.
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
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dsClosePicker(true);
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
      if (typeof onAdded === 'function') onAdded({ slug, added: r.added || [], skipped: r.skipped || [] });
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

  const openAdd = (btn) => {
    const body = trAddBody(S.multi, S);
    if (!body) return;
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
      const body = trAddBody([], S);
      if (!body) return;
      const item = body.items[0];
      dsAddPicker(replayBtn, body.items, {
        verb: 'Add and replay',
        heading: 'Replay this turn: first it goes into a dataset',
        onAdded: async ({ slug, added }) => {
          let id = added[0] && added[0].id;
          if (!id) {
            const r = await dsApi(dsPath(slug)).catch(() => null);
            const ex =
              r && (r.examples || []).find((x) => x.link && x.link.key === item.key && x.link.turn === item.turn);
            id = ex && ex.id;
          }
          location.hash = `#gateway/playground?ds=${encodeURIComponent(slug)}${id ? `&ex=${encodeURIComponent(id)}` : ''}`;
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
  };
