'use strict';
/* Second brain page: vault stats, the animated note graph, and note drill-downs. */

let brainGraph = null;
const groupMeta = (id) => BRAIN_GROUPS.find((g) => g.id === id) || BRAIN_GROUPS[BRAIN_GROUPS.length - 1];

function viewBrain() {
  return `<div class="hero"><div><div class="eyebrow">SECOND BRAIN</div><h1>Your second brain</h1><p id="brain-sub">Reading your Obsidian vault…</p></div>
    <div class="hero-actions">
      <label class="search brain-search">${icon('search')}<input id="brain-search" type="search" placeholder="Find a note…" autocomplete="off" aria-label="Find a note"></label>
      <button class="btn ghost" id="brain-pulses" aria-pressed="true">${icon('wave', 14)}Pulses</button>
      <button class="btn" id="brain-replay-btn">${icon('play', 14)}Replay growth</button>
    </div></div>
    <div class="grid kpis" id="brain-kpis">${'<div class="skeleton" style="height:128px"></div>'.repeat(4)}</div>
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
      <div class="card"><div class="card-head"><h3>Recently updated</h3><span class="meta">by file change</span></div><div id="brain-recent"></div></div>
    </div>`;
}

function noteRow(n, i, right) {
  const g = groupMeta(n.group);
  return `<button class="note-row" data-note="${n.id}" style="--i:${i}"><span class="tool-dot" style="background:${g.color}"></span>
    <span class="note-name">${esc(n.name)}</span><span class="muted num">${right}</span></button>`;
}

async function mountBrain() {
  const canvas = $('#brain-canvas');
  if (!canvas) return;
  if (!state.vault || Date.now() - state.vault.fetched > 60000) {
    state.vault = await api('/api/vault');
    state.vault.fetched = Date.now();
  }
  const v = state.vault;
  if (!$('#brain-canvas')) return; // navigated away while loading
  if (!v.notes.length) {
    $('#brain-sub').textContent = v.error || 'No notes found in the vault.';
    $('#brain-kpis').innerHTML = '';
    return;
  }
  const notes = v.notes; const edges = v.edges.length;
  const orphans = notes.filter((n) => !n.inLinks && !n.outLinks);
  const hubs = [...notes].sort((a, b) => b.inLinks + b.outLinks - (a.inLinks + a.outLinks));
  const words = notes.reduce((a, n) => a + n.words, 0);
  const unresolved = v.unresolved.reduce((a, u) => a + u.count, 0);
  $('#brain-sub').textContent = `${v.vault} · ${whole.format(notes.length)} notes joined by ${whole.format(edges)} links. Each pulse travels from a note to a note it links to.`;
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
}

function unmountBrain() {
  if (brainGraph) { brainGraph.destroy(); brainGraph = null; }
}

document.addEventListener('click', (e) => {
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
    const uri = `obsidian://open?vault=${encodeURIComponent(v.vault)}&file=${encodeURIComponent(n.path.replace(/\.md$/i, ''))}`;
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
        `<div class="drawer-actions"><a class="btn" href="${uri}">Open in Obsidian →</a><span class="muted">${esc(n.path)}</span></div>`,
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
