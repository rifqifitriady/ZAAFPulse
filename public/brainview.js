'use strict';
/* Second brain page: sources (Obsidian by default; Logseq, Notion, Tana, Roam, mem.ai, Reflect, Heybrain,
   PARA, RAG and vector databases), stats, the animated knowledge map with its layouts, and drill-downs. */

let brainGraph = null;
const groupMeta = (id) => BRAIN_GROUPS.find((g) => g.id === id) || BRAIN_GROUPS[BRAIN_GROUPS.length - 1];

const BRAIN_LAYOUTS = [['network', 'Network'], ['para', 'PARA'], ['semantic', 'Semantic map'], ['hierarchy', 'Hierarchy'], ['timeline', 'Timeline'], ['sources', 'Sources']];
const brainUi = { source: 'obsidian', layout: null, editing: null, sources: null, types: null };
function viewBrain() {
  return `<div class="holo-deck"><div class="hero"><div><div class="eyebrow">SECOND BRAIN</div><h1>Your second brain</h1><p id="brain-sub">Reading ${esc((brainUi.sources || []).find((x) => x.id === brainUi.source)?.name || 'your Obsidian vault')}…</p></div>
    <div class="hero-actions">
      <label class="search brain-search">${icon('search')}<input id="brain-search" type="search" placeholder="Find a note…" autocomplete="off" aria-label="Find a note"></label>
      <button class="btn ghost" id="brain-pulses" aria-pressed="true">${icon('wave', 14)}Pulses</button>
      <button class="btn" id="brain-replay-btn">${icon('play', 14)}Replay growth</button>
    </div></div>
    <section class="holo stage work-stage"><canvas id="brain-scene" aria-label="3D chart of notes created per week, stacked by note type"></canvas>
      <div class="stage-tl"><div class="holo-kicker">KNOWLEDGE GROWTH · NOTES PER WEEK</div><div class="stage-key">One tower per week, stacked by note type · back walls: notes over time and the biggest hubs · hover a tower</div></div>
      <div class="stage-legend" id="brain-stage-legend"></div></section>
    <div class="brain-bar"><div class="segmented wf-cats" role="group" aria-label="Source" id="brain-sources-bar"></div><div class="segmented" role="group" aria-label="Layout" id="brain-layouts"></div></div>
    <div class="grid kpis" id="brain-kpis">${'<div class="skeleton" style="height:128px"></div>'.repeat(4)}</div>
    <div class="live-metrics" id="brain-metrics"></div>
    <div class="card graph-card">
      <div class="graph-wrap">
        <canvas id="brain-canvas" aria-label="Graph of notes and the links between them"></canvas>
        <div class="graph-legend" id="brain-legend"></div>
        <div class="graph-ctrl"><button class="icon-btn" data-bz="in" aria-label="Zoom in">+</button><button class="icon-btn" data-bz="out" aria-label="Zoom out">−</button><button class="icon-btn" data-bz="fit" aria-label="Fit graph">${icon('target', 14)}</button></div>
        <div class="graph-replay" id="brain-replay" hidden><span>Growing your brain</span><b id="brain-replay-date"></b><div class="meter"><i id="brain-replay-bar" style="width:0"></i></div></div>
        <div class="graph-hint">Drag to move · scroll to zoom · click a note</div>
      </div>
    </div>
    <div class="grid two">
      <div class="card"><div class="card-head"><h3>Most connected notes</h3><span class="meta">links in + out</span></div><div id="brain-hubs"></div></div>
      <div class="card"><div class="card-head"><h3>Recently updated</h3><span class="meta">by change time</span></div><div id="brain-recent"></div></div>
    </div>
    <section class="holo panel" id="brain-sources-panel"><div class="skeleton" style="height:120px"></div></section></div>`;
}

// Sources panel: what is connected, and forms to connect more.
function brainSourcesPanel() {
  const S = brainUi.sources || []; const T = brainUi.types || {}; const e = brainUi.editing;
  const fam = {}; for (const [k, t] of Object.entries(T)) if (!t.builtin) (fam[t.family] ||= []).push([k, t]);
  const card = (src) => `<article class="pcard${src.enabled ? '' : ' off'}" style="--v:${src.cached && src.cached.error ? '#ff8aa3' : '#5cf0a8'}"><div class="pc-head"><span class="pc-logo">${esc(src.label[0])}</span><div class="pc-title"><b>${esc(src.name)}</b><small>${esc(src.label)} · ${esc(src.family)}${src.builtin ? ' · built in' : ''}</small></div>
      <span class="state-pill" style="--c:${!src.cached ? '#8f98cc' : src.cached.error ? '#ff8aa3' : src.cached.notes ? '#5cf0a8' : '#ffb547'}"><i></i>${!src.cached ? 'not loaded' : src.cached.error ? 'error' : src.cached.notes ? `${whole.format(src.cached.notes)} notes` : 'empty'}</span></div>
      ${src.cached && src.cached.error ? `<p class="pc-desc ie-err">${esc(src.cached.error)}</p>` : `<p class="pc-desc">${esc((src.cached && src.cached.notice) || src.path || src.url || (T[src.type] || {}).about || '')}</p>`}
      <div class="pc-foot"><button class="btn ghost" type="button" data-brainsrc="open" data-id="${esc(src.id)}">Map it</button><button class="btn ghost" type="button" data-brainsrc="test" data-id="${esc(src.id)}">Test</button>${src.builtin ? '' : `<button class="btn ghost" type="button" data-brainsrc="edit" data-id="${esc(src.id)}">Edit</button><button class="btn ghost danger" type="button" data-brainsrc="delete" data-id="${esc(src.id)}">Remove</button>`}</div></article>`;
  const form = e ? (() => { const t = T[e.type]; return `<form class="gw-form holo panel brain-form" id="brain-src-form"><div class="panel-head"><h3>${e.originalId ? `Edit ${esc(e.name)}` : `Connect ${esc(t.label)}`}</h3><span class="meta">${esc(t.about || '')}</span></div>
      <div class="gw-row"><label>ID<input class="input" name="id" value="${esc(e.id || e.type)}" ${e.originalId ? 'readonly' : ''}></label><label>Name<input class="input" name="name" value="${esc(e.name || t.label)}"></label></div>
      ${t.fields.map((f) => f.kind === 'secret' ? `<label>${esc(f.label)} ${e.hasSecret ? '<small>stored; leave empty to keep</small>' : `<small>saved to the ${storeLong()}</small>`}<input class="input" type="password" autocomplete="off" name="secret" placeholder="${esc(f.placeholder || '')}"></label>`
        : `<label>${esc(f.label)}<input class="input${f.kind === 'path' ? ' mono' : ''}" name="${f.key}" value="${esc(f.key === 'path' ? e.path || '' : f.key === 'url' ? e.url || '' : (e.options || {})[f.key] || '')}" placeholder="${esc(f.placeholder || '')}"></label>`).join('')}
      <div id="brain-src-errors"></div><div class="gw-row"><button class="btn" type="submit">Save &amp; map</button><button class="btn ghost" type="button" data-brainsrc="cancel">Cancel</button></div></form>`; })() : '';
  return `<div class="panel-head"><h3>Sources</h3><span class="meta">Obsidian is the default · tokens go to the ${storeName()} · note text never leaves this machine except to the source's own API</span></div>
    <div class="pc-grid">${S.map(card).join('')}</div>${form}
    <div class="brain-connect">${Object.entries(fam).map(([f, list]) => `<div><small class="muted">${esc(f)}</small><div class="tags">${list.map(([k, t]) => `<button class="tag brain-type" type="button" data-braintype="${k}" title="${esc(t.about || '')}">+ ${esc(t.label)}</button>`).join('')}</div></div>`).join('')}</div>`;
}
async function loadBrainSources() {
  try { const r = await api('/api/brain'); brainUi.sources = r.sources; brainUi.types = r.types; } catch { brainUi.sources = brainUi.sources || []; brainUi.types = brainUi.types || {}; }
  const el = $('#brain-sources-panel'); if (el) el.innerHTML = brainSourcesPanel();
  const bar = $('#brain-sources-bar');
  if (bar) bar.innerHTML = [...brainUi.sources.filter((x) => x.enabled), { id: 'all', name: 'All sources' }].map((x) => `<button type="button" data-brainsource="${esc(x.id)}" aria-pressed="${x.id === brainUi.source}">${esc(x.name)}${x.cached && !x.cached.error ? ` <small>${whole.format(x.cached.notes)}</small>` : ''}</button>`).join('');
}

function noteRow(n, i, right) {
  const g = groupMeta(n.group);
  return `<button class="note-row" data-note="${n.id}" style="--i:${i}"><span class="tool-dot" style="background:${g.color}"></span>
    <span class="note-name">${esc(n.name)}</span><span class="muted num">${right}</span></button>`;
}

async function mountBrain() {
  const canvas = $('#brain-canvas');
  if (!canvas) return;
  loadBrainSources();
  if (!state.vault || state.vault.sourceId !== brainUi.source || Date.now() - state.vault.fetched > 60000) {
    state.vault = await api(`/api/brain/graph?source=${encodeURIComponent(brainUi.source)}`).catch((err) => ({ notes: [], edges: [], unresolved: [], error: err.message }));
    state.vault.fetched = Date.now(); state.vault.sourceId = brainUi.source;
  }
  const v = state.vault;
  if (!$('#brain-canvas')) return; // navigated away while loading
  setBrainGroups(v);
  const avail = BRAIN_LAYOUTS.filter(([k]) => k === 'network' || k === 'timeline' || k === 'hierarchy' || (k === 'para') || (k === 'semantic' && v.notes.some((n) => n.xy)) || (k === 'sources' && brainUi.source === 'all'));
  if (!brainUi.layout || !avail.some(([k]) => k === brainUi.layout)) brainUi.layout = avail.some(([k]) => k === v.layout) ? v.layout : 'network';
  $('#brain-layouts').innerHTML = avail.map(([k, l]) => `<button type="button" data-brainlayout="${k}" aria-pressed="${k === brainUi.layout}">${l}</button>`).join('');
  $('#brain-stage-legend').innerHTML = BRAIN_GROUPS.filter((g) => g.id !== 'other').slice(0, 8).map((g) => `<span><i style="background:${brainNeon(g.id)}"></i>${esc(g.name)}</span>`).join('');
  if (!v.notes.length) {
    $('#brain-sub').textContent = v.error || v.notice || 'No notes found in this source.';
    $('#brain-kpis').innerHTML = ''; $('#brain-metrics').innerHTML = ''; unmountBrain();
    return;
  }
  const notes = v.notes; const edges = v.edges.length;
  const orphans = notes.filter((n) => !n.inLinks && !n.outLinks);
  const hubs = [...notes].sort((a, b) => b.inLinks + b.outLinks - (a.inLinks + a.outLinks));
  const words = notes.reduce((a, n) => a + n.words, 0);
  const unresolved = v.unresolved.reduce((a, u) => a + u.count, 0);
  const src = v.source || { label: 'Obsidian' };
  $('#brain-sub').textContent = `${src.label}${v.vault && v.vault !== src.label ? ` · ${v.vault}` : ''} · ${whole.format(notes.length)} ${v.kind === 'vector' ? 'records' : 'notes'} joined by ${whole.format(edges)} ${v.kind === 'vector' || v.kind === 'rag' ? 'nearest-neighbour links' : 'links'}${v.same ? ` (${v.same} across sources)` : ''}.${v.dimension ? ` ${v.dimension}-dimension vectors, placed by meaning.` : ' Each pulse travels from a note to a note it links to.'}`;
  const kp = $('#brain-kpis');
  kp.innerHTML = [
    kpiCard({ title: 'Notes', chip: 'blue', ic: 'brain', drill: 'brainNotes', value: notes.length, fmt: 'int',
      after: `<small class="muted">${new Set(notes.map((n) => n.folder)).size} folders</small>`, sub: `${fmtN(words)} words in total` }),
    kpiCard({ title: 'Links', chip: 'violet', ic: 'wave', drill: 'brainHubs', value: edges, fmt: 'int',
      after: `<small class="muted">${(edges / notes.length).toFixed(1)} per note</small>`, sub: `Biggest hub: ${esc(hubs[0].name)} (${hubs[0].inLinks + hubs[0].outLinks})` }),
    kpiCard({ title: 'Orphan notes', chip: 'amber', ic: 'ghost', drill: 'brainOrphans', value: orphans.length, fmt: 'int',
      after: `<small class="muted">${fmtPct(orphans.length / notes.length)} of notes</small>`, sub: 'No links in or out yet' }),
    kpiCard({ title: 'Unresolved links', chip: 'green', ic: 'sparkle', drill: 'brainUnresolved', value: unresolved, fmt: 'int',
      after: `<small class="muted">${v.unresolved.length} names</small>`, sub: 'Links to notes that do not exist yet' }),
  ].join('');
  kp.classList.add('animate'); countUp(kp); settle(kp);

  const counts = {};
  for (const n of notes) counts[n.group] = (counts[n.group] || 0) + 1;
  $('#brain-legend').innerHTML = BRAIN_GROUPS.filter((g) => counts[g.id]).map((g) =>
    `<button data-bgroup="${g.id}" aria-pressed="true"><i style="background:${g.color}"></i>${g.name}<span class="num">${counts[g.id]}</span></button>`).join('');
  $('#brain-hubs').innerHTML = `<div class="note-list">${hubs.slice(0, 8).map((n, i) => noteRow(n, i, `${n.inLinks} in · ${n.outLinks} out`)).join('')}</div>`;
  mountBrainExtras(v);
  $('#brain-recent').innerHTML = `<div class="note-list">${[...notes].sort((a, b) => b.modified - a.modified).slice(0, 8).map((n, i) => noteRow(n, i, ago(n.modified))).join('')}</div>`;

  unmountBrain();
  brainGraph = new BrainGraph(canvas, v, {
    onHover(n, e) {
      if (!n) return hideTip();
      const g = groupMeta(n.group);
      showTip(e, `<b>${esc(n.name)}</b><div class="row"><span><i style="background:${g.color}"></i>${g.name}</span></div><div class="row"><span>Links</span><span class="num">${n.inLinks} in · ${n.outLinks} out</span></div>`);
    },
    onSelect(n) { if (n) { state.brainSel = n.id; hideTip(); openDrill('note', canvas); } },
    onReplay(cut, p) {
      const box = $('#brain-replay');
      if (!box) return;
      box.hidden = cut == null;
      if (cut != null) {
        $('#brain-replay-date').textContent = new Date(cut).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
        $('#brain-replay-bar').style.width = `${p * 100}%`;
      }
    },
  });
  if (brainUi.layout !== 'network') brainGraph.setLayout(brainUi.layout);
}

function unmountBrain() {
  if (brainGraph) { brainGraph.destroy(); brainGraph = null; }
}

document.addEventListener('click', (e) => {
  const bs = e.target.closest('[data-brainsource]');
  if (bs) { brainUi.source = bs.dataset.brainsource; brainUi.layout = null; state.vault = null; $('#brain-sub').textContent = 'Loading…'; mountBrain(); return; }
  const bl = e.target.closest('[data-brainlayout]');
  if (bl && brainGraph) { brainUi.layout = bl.dataset.brainlayout; brainGraph.setLayout(brainUi.layout); for (const b of $$('[data-brainlayout]')) b.setAttribute('aria-pressed', String(b === bl)); return; }
  const bt = e.target.closest('[data-braintype]');
  if (bt) { brainUi.editing = { type: bt.dataset.braintype }; $('#brain-sources-panel').innerHTML = brainSourcesPanel(); $('#brain-src-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  const sa = e.target.closest('[data-brainsrc]');
  if (sa) {
    const act = sa.dataset.brainsrc; const id = sa.dataset.id; const src = (brainUi.sources || []).find((x) => x.id === id);
    if (act === 'cancel') { brainUi.editing = null; $('#brain-sources-panel').innerHTML = brainSourcesPanel(); return; }
    if (act === 'edit') { brainUi.editing = { ...src, originalId: src.id }; $('#brain-sources-panel').innerHTML = brainSourcesPanel(); return; }
    if (act === 'open') { brainUi.source = id; brainUi.layout = null; state.vault = null; mountBrain(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const post = (body) => api('/api/brain/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (act === 'test') { sa.textContent = 'Testing…'; post({ action: 'test', id }).then((r) => { sa.textContent = r.ok ? `${whole.format(r.notes)} notes` : 'Failed'; if (!r.ok) alert(r.error); loadBrainSources(); }); return; }
    if (act === 'delete' && confirm(`Remove the source "${src.name}"? Its ${storeName()} item stays.`)) post({ action: 'delete', id }).then(() => { if (brainUi.source === id) { brainUi.source = 'obsidian'; state.vault = null; mountBrain(); } else loadBrainSources(); });
    return;
  }
  const note = e.target.closest('[data-note]');
  if (note) {
    const id = Number(note.dataset.note);
    state.brainSel = id;
    if (brainGraph) brainGraph.focus(id);
    if (drawer.kind === 'note') paintDrawer(true); else openDrill('note', note);
    return;
  }
  const g = e.target.closest('[data-bgroup]');
  if (g && brainGraph) {
    brainGraph.toggleGroup(g.dataset.bgroup);
    g.setAttribute('aria-pressed', String(!brainGraph.hiddenGroups.has(g.dataset.bgroup)));
    return;
  }
  const z = e.target.closest('[data-bz]');
  if (z && brainGraph) { const a = z.dataset.bz; if (a === 'in') brainGraph.zoom(1.35); else if (a === 'out') brainGraph.zoom(1 / 1.35); else brainGraph.reset(); return; }
  if (e.target.closest('#brain-replay-btn') && brainGraph) { brainGraph.startReplay(); return; }
  const pb = e.target.closest('#brain-pulses');
  if (pb && brainGraph) { brainGraph.pulses = !brainGraph.pulses; brainGraph.particles = []; pb.setAttribute('aria-pressed', String(brainGraph.pulses)); }
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'brain-src-form') return;
  e.preventDefault(); const f = e.target; const ed = brainUi.editing; const t = brainUi.types[ed.type];
  const body = { action: 'save', type: ed.type, originalId: ed.originalId, id: f.id.value.trim(), name: f.name.value.trim(), options: {} };
  for (const fl of t.fields) { const el = f[fl.key === 'secret' ? 'secret' : fl.key]; if (!el) continue; if (fl.kind === 'secret') { if (el.value) body.secret = { mode: 'store', value: el.value }; } else if (fl.key === 'path' || fl.key === 'url') body[fl.key] = el.value; else body.options[fl.key] = el.value; }
  api('/api/brain/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => {
    if (r.errors) { $('#brain-src-errors').innerHTML = `<div class="ie-result bad"><b>Fix these first</b><ul>${r.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`; return; }
    brainUi.editing = null; brainUi.source = r.source.id; brainUi.layout = null; state.vault = null; mountBrain(); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'brain-search' || !brainGraph) return;
  const q = e.target.value.trim().toLowerCase();
  brainGraph.setMatches(q ? state.vault.notes.filter((n) => n.name.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q))).map((n) => n.id) : null);
});
document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'brain-search' || e.key !== 'Enter' || !brainGraph || !brainGraph.matches) return;
  const first = [...brainGraph.matches][0];
  if (first != null) { state.brainSel = first; brainGraph.focus(first); openDrill('note', e.target); }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => brainGraph && brainGraph.readTheme());

const BRAIN_DRILLS = {
  note() {
    const v = state.vault; const n = v.notes[state.brainSel];
    if (!n) return { eyebrow: 'NOTE', title: 'Note', body: '<div class="empty">Note not found.</div>' };
    const g = groupMeta(n.group);
    const back = v.edges.filter(([, t]) => t === n.id).map(([s]) => v.notes[s]);
    const out = v.edges.filter(([s]) => s === n.id).map(([, t]) => v.notes[t]);
    const uri = n.url || ((v.source || {}).type === 'obsidian' || !v.source ? `obsidian://open?vault=${encodeURIComponent(v.vault)}&file=${encodeURIComponent(n.path.replace(/\.md$/i, ''))}` : null);
    const srcLabel = n.source ? ((brainUi.sources || []).find((x) => x.id === n.source) || {}).label : (v.source || {}).label || 'Obsidian';
    const list = (items, empty) => (items.length ? `<div class="note-list">${items.map((x, i) => noteRow(x, i, `${x.inLinks + x.outLinks} links`)).join('')}</div>` : `<div class="empty">${empty}</div>`);
    return {
      eyebrow: `NOTE · ${g.name.toUpperCase()}`, title: n.name,
      body: tiles([
        ['Backlinks', counter(back.length, 'int'), 'notes that link here'],
        ['Links out', counter(out.length, 'int'), 'notes this one links to'],
        ['Words', counter(n.words, 'int'), esc(n.folder)],
        ['Last changed', ago(n.modified), `created ${new Date(n.created).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}`],
      ]) +
        (n.description ? dsec(1, 'Summary', `<p class="drawer-note" style="margin:0">${esc(n.description)}</p>`) : '') +
        (n.tags.length ? dsec(2, 'Tags', `<div class="tags">${n.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>`) : '') +
        dsec(3, 'Backlinks', list(back, 'Nothing links to this note yet.')) +
        dsec(4, 'Links out', list(out, 'This note does not link to other notes.')) +
        (n.xy ? dsec(5, 'Place on the map', `<p class="drawer-note" style="margin:0">Position from its embedding: ${n.xy.map((x) => x.toFixed(2)).join(', ')} on the first two principal components. Nearby records mean similar things.</p>`) : '') +
        `<div class="drawer-actions">${uri ? `<a class="btn" href="${esc(uri)}" target="_blank" rel="noopener">Open in ${esc(srcLabel || 'source')} →</a>` : ''}<span class="muted">${esc(n.path)}</span>${n.para ? `<span class="tag">PARA · ${esc(n.para)}</span>` : ''}</div>`,
    };
  },
  brainNotes() {
    const v = state.vault; const notes = v.notes;
    const byGroup = BRAIN_GROUPS.map((g) => ({ ...g, count: notes.filter((n) => n.group === g.id).length })).filter((g) => g.count);
    const byFolder = {};
    for (const n of notes) byFolder[n.folder] = (byFolder[n.folder] || 0) + 1;
    const months = {};
    for (const n of notes) { const k = new Date(n.created).toISOString().slice(0, 7); months[k] = (months[k] || 0) + 1; }
    return {
      eyebrow: 'SECOND BRAIN', title: 'Notes',
      body: tiles([
        ['Notes', counter(notes.length, 'int'), 'markdown files'],
        ['Words', counter(notes.reduce((a, n) => a + n.words, 0), 'n'), 'across all notes'],
        ['Average length', whole.format(Math.round(notes.reduce((a, n) => a + n.words, 0) / notes.length)), 'words per note'],
        ['Added in the last 30 days', counter(notes.filter((n) => Date.now() - n.created < 30 * 86400000).length, 'int'), 'by file creation date'],
      ]) +
        dsec(1, 'By kind', composition(byGroup.map((g) => ({ name: g.name, value: g.count, color: g.color })), (x) => whole.format(x))) +
        dsec(2, 'New notes per month', barList(Object.entries(months).sort().map(([name, count]) => ({ name, count })),
          { value: (x) => x.count, label: (x) => new Date(x.name + '-01T00:00:00').toLocaleDateString('en', { month: 'long', year: 'numeric' }), color: () => 'var(--accent)', fmt: (x) => whole.format(x) })) +
        dsec(3, 'By folder', barList(Object.entries(byFolder).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
          { value: (x) => x.count, label: (x) => esc(x.name), color: () => 'var(--accent)', fmt: (x) => whole.format(x) })),
    };
  },
  brainHubs() {
    const v = state.vault;
    const hubs = [...v.notes].sort((a, b) => b.inLinks + b.outLinks - (a.inLinks + a.outLinks)).slice(0, 15);
    const mostLinked = [...v.notes].sort((a, b) => b.inLinks - a.inLinks).slice(0, 10);
    return {
      eyebrow: 'SECOND BRAIN', title: 'Links & hubs',
      body: tiles([
        ['Links', counter(v.edges.length, 'int'), 'between notes'],
        ['Per note', (v.edges.length / v.notes.length).toFixed(1), 'average'],
        ['Most linked-to', esc(mostLinked[0].name), `${mostLinked[0].inLinks} backlinks`],
        ['Biggest hub', esc(hubs[0].name), `${hubs[0].outLinks} links out`],
      ]) +
        dsec(1, 'Hubs (links in + out)', `<div class="note-list">${hubs.map((n, i) => noteRow(n, i, `${n.inLinks} in · ${n.outLinks} out`)).join('')}</div>`) +
        dsec(2, 'Most referenced', `<div class="note-list">${mostLinked.map((n, i) => noteRow(n, i, `${n.inLinks} backlinks`)).join('')}</div>`),
    };
  },
  brainOrphans() {
    const v = state.vault;
    const orphans = v.notes.filter((n) => !n.inLinks && !n.outLinks).sort((a, b) => b.modified - a.modified);
    const deadEnds = v.notes.filter((n) => n.inLinks && !n.outLinks).sort((a, b) => b.inLinks - a.inLinks).slice(0, 10);
    return {
      eyebrow: 'SECOND BRAIN', title: 'Orphan notes',
      body: tiles([
        ['Orphans', counter(orphans.length, 'int'), 'no links in or out'],
        ['Dead ends', counter(v.notes.filter((n) => n.inLinks && !n.outLinks).length, 'int'), 'linked to, but link nowhere'],
      ]) +
        dsec(1, 'Orphans', `<p class="drawer-note" style="margin:0 0 8px">Linking these from a hub note makes them findable from the rest of your brain.</p><div class="note-list">${orphans.map((n, i) => noteRow(n, i, ago(n.modified))).join('')}</div>`) +
        dsec(2, 'Dead ends', `<div class="note-list">${deadEnds.map((n, i) => noteRow(n, i, `${n.inLinks} backlinks`)).join('')}</div>`),
    };
  },
  brainUnresolved() {
    const v = state.vault;
    return {
      eyebrow: 'SECOND BRAIN', title: 'Unresolved links',
      body: dsec(1, 'Links to notes that do not exist yet', `<p class="drawer-note" style="margin:0 0 8px">Obsidian shows these as empty nodes. Create the note, or fix the link if it is a typo or a template placeholder.</p>` +
        barList(v.unresolved, { value: (u) => u.count, label: (u) => esc(u.name), color: () => 'var(--tt-cwrite)', fmt: (x) => whole.format(x), empty: 'Every link resolves.' })),
    };
  },
};
