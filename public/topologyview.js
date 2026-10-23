'use strict';
/* The Overview's provider topology: the coding tools, the routers, gateway and local runtimes they call, and the
   providers and models behind them (/api/topology), drawn as an SVG graph with the latest requests beside it.
   Everything from the server reaches the page as text: SVG nodes are made with createElementNS and filled with
   textContent (S1). The only innerHTML here is this app's own icon markup. topoLayout is pure, and topoPaint takes
   the document it builds with, so test/topology-ui.test.js runs both without a browser. */

const TOPO_NS = 'http://www.w3.org/2000/svg';
const TOPO_POLL_MS = 10000;
const TOPO_STATUSES = ['active', 'recent', 'error', 'idle'];
const TOPO_PAD = { x: 24, top: 44, bottom: 52 }; // around the drawing, in SVG units: room for the legend and zoom bar
const TOPO_GAP = 16; // between two nodes of a layer
const TOPO_NODE_H = 46;
const TOPO_ZOOM = { min: 0.5, max: 4, step: 1.25 };
const TOPO_ICONS = {
  tool: 'terminal',
  router: 'compass',
  gateway: 'endpoint',
  runtime: 'cube',
  provider: 'sparkle',
  model: 'cpu',
  more: 'grid',
};
const TOPO_KINDS = {
  tool: 'tool',
  router: 'router',
  gateway: 'gateway',
  runtime: 'local runtime',
  provider: 'provider',
  model: 'model',
  more: 'more',
};
const TOPO_LEGEND = [
  ['active', 'Active'],
  ['recent', 'Recent'],
  ['error', 'Error'],
];
const TOPO = { data: null, failed: false, ui: {} }; // the last answer and the view, kept across Overview re-renders

const topoOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// One line of text from the server: control characters out, spaces folded, clipped. Markup stays text.
const topoText = (v, max = 120) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const topoStatus = (s) => (TOPO_STATUSES.includes(s) ? s : 'idle');
const topoClip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
const topoLayerOf = (n) => (Number.isInteger(n.layer) && n.layer >= 0 ? n.layer : 0);
const topoR = (v) => Math.round(v * 10) / 10;

// How long ago, from milliseconds: "just now", "42 s ago", "5 min ago", "3 h ago".
function topoAgo(ms) {
  const s = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}
const topoNum = (n) => (n >= 1e6 ? `${topoR(n / 1e6)}M` : n >= 1000 ? `${topoR(n / 1000)}k` : String(Math.round(n)));
const topoMs = (ms) => (ms >= 1000 ? `${topoR(ms / 1000)} s` : `${Math.round(ms)} ms`);

// The section head's meta line: "— N active · M error".
function topoMetaText(data) {
  const nodes = data && Array.isArray(data.nodes) ? data.nodes.filter(Boolean) : [];
  const count = (s) => nodes.filter((n) => n.status === s).length;
  return `— ${count('active')} active · ${count('error')} error`;
}

// Where each node and edge goes, in SVG units: layers top to bottom (an empty layer takes no row), the nodes of a layer
// spread evenly across it, edges as cubic Bézier curves from the bottom of one node to the top of the next. A crowded
// layer makes the drawing wider than `width`, and taller by as much, so the view's fit scales it down to fill the
// pane. Pure.
function topoLayout(nodes, edges, width, height) {
  const seen = new Set();
  const list = (Array.isArray(nodes) ? nodes : []).filter(
    (n) => n && typeof n.id === 'string' && !seen.has(n.id) && seen.add(n.id),
  );
  const layers = [...new Set(list.map(topoLayerOf))].sort((a, b) => a - b);
  const rows = layers.map((l) => list.filter((n) => topoLayerOf(n) === l));
  const most = Math.max(1, ...rows.map((r) => r.length));
  const h = TOPO_NODE_H;
  const room = Math.max(Number(width) || 0, 320) - 2 * TOPO_PAD.x;
  const w = 2 * Math.floor(Math.min(176, Math.max(96, (room - TOPO_GAP * (most - 1)) / most)) / 2);
  const slot = 2 * Math.ceil(Math.max(w + TOPO_GAP, room / most) / 2);
  const W = Math.max(room, slot * most) + 2 * TOPO_PAD.x;
  const k = W / (room + 2 * TOPO_PAD.x); // the fit scales the drawing down by this much: keep the room in pixels
  const top = Math.round(TOPO_PAD.top * k);
  const padY = top + Math.round(TOPO_PAD.bottom * k);
  const aspect = Number(height) > 0 && Number(width) > 0 ? Number(height) / Number(width) : 0;
  const H = Math.max(Number(height) || 0, Math.round(W * aspect), 240, padY + rows.length * h + (rows.length - 1) * 56);
  const step = rows.length > 1 ? (H - padY - h) / (rows.length - 1) : 0;
  const out = [];
  rows.forEach((row, r) => {
    const start = Math.round((W - slot * row.length) / 2);
    const y = rows.length > 1 ? Math.round(top + step * r) : Math.round((H - h) / 2);
    row.forEach((n, i) => out.push({ id: n.id, x: start + slot * i + (slot - w) / 2, y, w, h }));
  });
  const at = new Map(out.map((p) => [p.id, p]));
  const paths = [];
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || !at.has(e.from) || !at.has(e.to)) continue;
    const a = at.get(e.from);
    const b = at.get(e.to);
    const x1 = a.x + a.w / 2;
    const x2 = b.x + b.w / 2;
    let y1, y2, c1, c2;
    if (b.y === a.y) {
      // the same layer: a loop below both
      y1 = a.y + a.h;
      y2 = b.y + b.h;
      c1 = c2 = y1 + 48;
    } else {
      const down = b.y > a.y;
      y1 = down ? a.y + a.h : a.y;
      y2 = down ? b.y : b.y + b.h;
      c1 = c2 = topoR((y1 + y2) / 2);
    }
    paths.push({
      id: typeof e.id === 'string' ? e.id : `${e.from}>${e.to}`,
      d: `M${x1} ${y1} C${x1} ${c1} ${x2} ${c2} ${x2} ${y2}`,
    });
  }
  return { width: W, height: H, nodes: out, edges: paths };
}

/* ---------- drawing ---------- */
function topoEl(doc, tag, cls, text) {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function topoSvg(doc, tag, attrs = {}) {
  const el = doc.createElementNS(TOPO_NS, tag);
  for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
  return el;
}

// The icon of a node: a tool's own icon from the app's list, else one per kind. Names only; the markup is the app's.
function topoIconName(n) {
  if (n.kind === 'tool' && typeof APPS === 'object' && APPS && topoOwn(APPS, n.id) && APPS[n.id].icon)
    return APPS[n.id].icon;
  return topoOwn(TOPO_ICONS, n.kind) ? TOPO_ICONS[n.kind] : 'cube';
}

// The card's parts, built once per card: the graph pane (SVG, legend, zoom, note) and the Recent requests list.
function topoBuild(doc, root, ui) {
  const pane = topoEl(doc, 'div', 'topo-graph');
  const svg = topoSvg(doc, 'svg', {
    class: 'topo-svg',
    role: 'group',
    'aria-label': 'Provider topology: tools, routers and runtimes, providers and models',
    preserveAspectRatio: 'xMidYMid meet',
  });
  const gEdges = svg.appendChild(topoSvg(doc, 'g', { class: 'topo-edges' }));
  const gNodes = svg.appendChild(topoSvg(doc, 'g', { class: 'topo-nodes' }));
  const blank = svg.appendChild(topoSvg(doc, 'text', { class: 'topo-blank', 'text-anchor': 'middle' }));
  blank.textContent = 'No tools, routers or providers found yet.';
  pane.appendChild(svg);

  const legend = topoEl(doc, 'div', 'topo-legend');
  for (const [s, label] of TOPO_LEGEND) {
    const item = legend.appendChild(topoEl(doc, 'span'));
    item.appendChild(topoEl(doc, 'i', `topo-key topo-${s}`));
    item.appendChild(doc.createTextNode(label));
  }
  pane.appendChild(legend);

  const zoom = topoEl(doc, 'div', 'topo-zoom');
  const btn = (act, label, text) => {
    const b = topoEl(doc, 'button', 'topo-zbtn', text);
    b.setAttribute('type', 'button');
    b.setAttribute('data-topo-zoom', act);
    b.setAttribute('aria-label', label);
    b.setAttribute('title', label);
    return zoom.appendChild(b);
  };
  btn('in', 'Zoom in', '+');
  btn('out', 'Zoom out', '−');
  const fit = btn('fit', 'Fit to view');
  const frame = fit.appendChild(
    topoSvg(doc, 'svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'topo-fit' }),
  );
  frame.appendChild(topoSvg(doc, 'path', { d: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' }));
  pane.appendChild(zoom);

  const note = topoEl(doc, 'p', 'topo-note');
  note.setAttribute('role', 'status');
  note.hidden = true;
  pane.appendChild(note);

  const side = topoEl(doc, 'div', 'topo-side');
  side.appendChild(topoEl(doc, 'div', 'topo-side-head', 'Recent requests'));
  const list = side.appendChild(topoEl(doc, 'ol', 'topo-reqs'));
  root.replaceChildren(pane, side);
  ui.els = { root, pane, svg, gEdges, gNodes, blank, note, list, nodes: new Map(), edges: new Map() };
  topoWire(ui);
}

// A node's parts: box, icon tile, label, kind and status dot, with its label and note as a tooltip.
function topoNodeEl(doc, n) {
  const g = topoSvg(doc, 'g', { 'data-topo-node': n.id, tabindex: 0, role: 'button' });
  const parts = {
    g,
    title: g.appendChild(topoSvg(doc, 'title')),
    base: g.appendChild(topoSvg(doc, 'rect', { class: 'topo-base', rx: 11 })), // opaque, so edges never show through
    box: g.appendChild(topoSvg(doc, 'rect', { class: 'topo-box', rx: 11 })),
    tile: g.appendChild(topoSvg(doc, 'rect', { class: 'topo-tile', x: 9, y: 9, width: 28, height: 28, rx: 8 })),
    ico: g.appendChild(topoSvg(doc, 'g', { class: 'topo-ico', transform: 'translate(16 16)' })),
    label: g.appendChild(topoSvg(doc, 'text', { class: 'topo-label', y: 21 })),
    kind: g.appendChild(topoSvg(doc, 'text', { class: 'topo-kind', y: 35 })),
    dot: g.appendChild(topoSvg(doc, 'circle', { class: 'topo-dot', r: 4 })),
  };
  const iconHtml = typeof icon === 'function' ? icon(topoIconName(n), 14) : '';
  if (iconHtml) parts.ico.innerHTML = iconHtml;
  return parts;
}

function topoNodeUpdate(parts, n, p) {
  const label = topoText(n.label, 80) || topoText(n.id, 80);
  const note = topoText(n.note);
  parts.status = topoStatus(n.status);
  parts.g.setAttribute('transform', `translate(${p.x} ${p.y})`);
  for (const r of [parts.base, parts.box]) {
    r.setAttribute('width', p.w);
    r.setAttribute('height', p.h);
  }
  const tile = p.w >= 120;
  parts.tile.setAttribute('visibility', tile ? 'visible' : 'hidden');
  parts.ico.setAttribute('visibility', tile ? 'visible' : 'hidden');
  const left = tile ? 46 : 12;
  parts.small = !tile; // a smaller label on narrow nodes
  const chars = Math.max(4, Math.floor((p.w - left - 22) / (tile ? 7.2 : 6.5)));
  parts.label.setAttribute('x', left);
  parts.label.textContent = topoClip(label, chars);
  parts.kind.setAttribute('x', left);
  parts.kind.textContent = topoClip(topoOwn(TOPO_KINDS, n.kind) ? TOPO_KINDS[n.kind] : '', chars + 2);
  parts.dot.setAttribute('cx', p.w - 13);
  parts.dot.setAttribute('cy', p.h / 2);
  const tip = `${label} · ${parts.status}${note ? ` · ${note}` : ''}`;
  parts.title.textContent = tip;
  parts.g.setAttribute('aria-label', tip);
  parts.text = { label, note };
}

// One row of Recent requests: a dot for ok or error, the path, the time ago, then client, model, tokens and time.
function topoReqRow(doc, r, i, labelOf, now) {
  const li = topoEl(doc, 'li');
  const b = li.appendChild(topoEl(doc, 'button', 'topo-req'));
  b.setAttribute('type', 'button');
  b.setAttribute('data-topo-req', i);
  const top = b.appendChild(topoEl(doc, 'span', 'topo-req-top'));
  top.appendChild(topoEl(doc, 'i', `topo-rdot ${r.ok === false ? 'topo-bad' : 'topo-ok'}`));
  const names = (Array.isArray(r.path) ? r.path : []).map(labelOf).filter(Boolean);
  top.appendChild(topoEl(doc, 'span', 'topo-req-path', names.join(' → ')));
  top.appendChild(topoEl(doc, 'span', 'topo-req-ago num', topoAgo(now - Number(r.ts))));
  const client = topoText(r.client, 80);
  const sub = [
    client && !names.includes(client) ? client : '',
    topoText(r.model, 80),
    Number.isFinite(r.tokens) && r.tokens > 0 ? `${topoNum(r.tokens)} tokens` : '',
    Number.isFinite(r.ms) && r.ms > 0 ? topoMs(r.ms) : '',
  ].filter(Boolean);
  b.appendChild(topoEl(doc, 'span', 'topo-req-sub', sub.join(' · ') || (r.ok === false ? 'failed' : 'ok')));
  return { li, button: b, names };
}

// A request row's key: what it is (time, source, path, client, model), then how many identical rows come before it, so
// two gateway retries in the same millisecond differ. It holds no index, so a newer request on top keeps it.
function topoReqKey(r, reqs, i) {
  const what = (q) =>
    JSON.stringify([
      Number(q.ts) || 0,
      topoText(q.source, 20),
      (Array.isArray(q.path) ? q.path : []).map((id) => (typeof id === 'string' ? id : '')),
      topoText(q.client, 80),
      topoText(q.model, 80),
    ]);
  const key = what(r);
  let n = 0;
  for (let j = 0; j < i; j++) if (what(reqs[j]) === key) n++;
  return `${key}#${n}`;
}

// Builds the card on first use and updates it in place after that: nodes and edges are kept by id, so the view and
// the highlight survive a refresh. `ui` holds the view (scale, centre, moved) and the selection.
function topoPaint(doc, root, data, ui = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const nodes = (Array.isArray(d.nodes) ? d.nodes : []).filter((n) => n && typeof n.id === 'string');
  const edges = (Array.isArray(d.edges) ? d.edges : []).filter(
    (e) => e && typeof e.from === 'string' && typeof e.to === 'string',
  );
  const reqs = (Array.isArray(d.requests) ? d.requests : []).filter((r) => r && typeof r === 'object').slice(0, 20);
  if (!(ui.scale > 0)) ui.scale = 1;
  if (!ui.els || ui.els.root !== root) topoBuild(doc, root, ui);
  const els = ui.els;
  const pw = els.pane.clientWidth || 880;
  const ph = els.pane.clientHeight || 400;
  const lay = topoLayout(nodes, edges, pw, ph);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const seen = new Set();
  for (const p of lay.nodes) {
    let parts = els.nodes.get(p.id);
    if (!parts) {
      parts = topoNodeEl(doc, byId.get(p.id));
      els.nodes.set(p.id, parts);
      els.gNodes.appendChild(parts.g);
    }
    topoNodeUpdate(parts, byId.get(p.id), p);
    seen.add(p.id);
  }
  for (const [id, parts] of els.nodes)
    if (!seen.has(id)) {
      els.gNodes.removeChild(parts.g);
      els.nodes.delete(id);
    }

  const edgeOf = new Map(edges.map((e) => [typeof e.id === 'string' ? e.id : `${e.from}>${e.to}`, e]));
  const kept = new Set();
  for (const p of lay.edges) {
    let parts = els.edges.get(p.id);
    if (!parts) {
      parts = { path: topoSvg(doc, 'path', { fill: 'none' }) };
      els.edges.set(p.id, parts);
      els.gEdges.appendChild(parts.path);
    }
    const e = edgeOf.get(p.id);
    Object.assign(parts, { from: e.from, to: e.to, status: topoStatus(e.status) });
    parts.path.setAttribute('d', p.d);
    kept.add(p.id);
  }
  for (const [id, parts] of els.edges)
    if (!kept.has(id)) {
      els.gEdges.removeChild(parts.path);
      els.edges.delete(id);
    }

  els.blank.setAttribute('visibility', lay.nodes.length ? 'hidden' : 'visible');
  els.blank.setAttribute('x', lay.width / 2);
  els.blank.setAttribute('y', lay.height / 2);

  const now = Number(d.ts) || Date.now();
  const labelOf = (id) => (byId.has(id) ? topoText(byId.get(id).label, 80) || topoText(id, 80) : topoText(id, 80));
  ui.rows = reqs.map((r, i) => ({ ...topoReqRow(doc, r, i, labelOf, now), r, key: topoReqKey(r, reqs, i) }));
  if (ui.rows.length) els.list.replaceChildren(...ui.rows.map((x) => x.li));
  else els.list.replaceChildren(topoEl(doc, 'li', 'topo-empty', 'No requests in the last 3 hours.'));

  ui.lay = lay;
  topoView(ui);
  topoHighlight(ui);
}

// The viewBox from the scale and centre. Until the view is dragged, the centre follows the drawing (fit).
function topoView(ui) {
  const lay = ui.lay;
  if (!lay || !ui.els) return;
  if (!ui.moved || ui.cx == null) {
    ui.cx = lay.width / 2;
    ui.cy = lay.height / 2;
  }
  const vw = lay.width / ui.scale;
  const vh = lay.height / ui.scale;
  ui.els.svg.setAttribute('viewBox', `${topoR(ui.cx - vw / 2)} ${topoR(ui.cy - vh / 2)} ${topoR(vw)} ${topoR(vh)}`);
}

// What is lit: a node with its edges and neighbours, or a request's path. Everything else is dimmed by CSS.
function topoHighlight(ui) {
  const els = ui.els;
  const sel = ui.sel;
  const nodes = new Set();
  const edges = new Set();
  let note = '';
  if (sel && sel.kind === 'node' && els.nodes.has(sel.id)) {
    nodes.add(sel.id);
    for (const [id, e] of els.edges)
      if (e.from === sel.id || e.to === sel.id) {
        edges.add(id);
        nodes.add(e.from);
        nodes.add(e.to);
      }
    const t = els.nodes.get(sel.id);
    note = `${t.text.label} · ${t.status}${t.text.note ? ` · ${t.text.note}` : ''}`;
  } else if (sel && sel.kind === 'req' && ui.rows.some((x) => x.key === sel.key)) {
    const row = ui.rows.find((x) => x.key === sel.key);
    const path = Array.isArray(row.r.path) ? row.r.path : [];
    for (const id of path) nodes.add(id);
    for (const [id, e] of els.edges)
      for (let i = 1; i < path.length; i++) if (e.from === path[i - 1] && e.to === path[i]) edges.add(id);
    note = row.names.join(' → ');
  } else ui.sel = null;
  const on = !!ui.sel;
  els.svg.setAttribute('class', `topo-svg${on ? ' topo-focus' : ''}`);
  for (const [id, p] of els.nodes)
    p.g.setAttribute(
      'class',
      `topo-node topo-${p.status}${p.small ? ' topo-sm' : ''}${on && nodes.has(id) ? ' topo-hi' : ''}`,
    );
  for (const [id, p] of els.edges)
    p.path.setAttribute('class', `topo-edge topo-${p.status}${on && edges.has(id) ? ' topo-hi' : ''}`);
  for (const x of ui.rows || [])
    x.button.className = `topo-req${on && sel.kind === 'req' && sel.key === x.key ? ' topo-hi' : ''}`;
  els.note.textContent = note;
  els.note.hidden = !note;
}

function topoZoom(ui, act) {
  if (act === 'fit') {
    ui.scale = 1;
    ui.moved = false;
  } else {
    const k = act === 'in' ? TOPO_ZOOM.step : 1 / TOPO_ZOOM.step;
    ui.scale = Math.min(TOPO_ZOOM.max, Math.max(TOPO_ZOOM.min, ui.scale * k));
  }
  topoView(ui);
}

// Clicks, keys and drag to pan. Browser only: the stand-in document of the tests has no events.
function topoWire(ui) {
  const { svg, pane, list } = ui.els;
  if (typeof svg.addEventListener !== 'function') return;
  const pick = (target) => {
    const g = target && target.closest && target.closest('[data-topo-node]');
    const id = g ? g.getAttribute('data-topo-node') : null;
    ui.sel = id && !(ui.sel && ui.sel.kind === 'node' && ui.sel.id === id) ? { kind: 'node', id } : null;
    topoHighlight(ui);
  };
  svg.addEventListener('click', (e) => {
    if (ui.dragged) return void (ui.dragged = false);
    pick(e.target);
  });
  svg.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('[data-topo-node]')) {
      e.preventDefault();
      pick(e.target);
    } else if (e.key === 'Escape' && ui.sel) {
      ui.sel = null;
      topoHighlight(ui);
    }
  });
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    ui.dragged = false; // a drag released off the graph has no click to clear it
    ui.drag = { x: e.clientX, y: e.clientY, cx: ui.cx, cy: ui.cy, moved: false, id: e.pointerId };
  });
  svg.addEventListener('pointermove', (e) => {
    const g = ui.drag;
    if (!g || !ui.lay) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      try {
        svg.setPointerCapture(g.id); // only once it is a drag, so a plain click still reaches its node
      } catch {
        /* the pointer is already gone */
      }
      pane.classList.add('topo-dragging');
    }
    const rect = svg.getBoundingClientRect();
    const k = Math.max(ui.lay.width / ui.scale / (rect.width || 1), ui.lay.height / ui.scale / (rect.height || 1));
    ui.cx = g.cx - dx * k;
    ui.cy = g.cy - dy * k;
    ui.moved = true;
    topoView(ui);
  });
  const end = () => {
    if (ui.drag && ui.drag.moved) ui.dragged = true;
    ui.drag = null;
    pane.classList.remove('topo-dragging');
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  pane.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-topo-zoom]');
    if (b) topoZoom(ui, b.getAttribute('data-topo-zoom'));
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-topo-req]');
    const row = b && (ui.rows || [])[Number(b.getAttribute('data-topo-req'))];
    if (!row) return;
    ui.sel = ui.sel && ui.sel.kind === 'req' && ui.sel.key === row.key ? null : { kind: 'req', key: row.key };
    topoHighlight(ui);
  });
}

// Called by the Overview when it is drawn: paints the last answer at once, then fetches /api/topology every 10 s
// while the card is on screen, and again when the card changes size.
function topoMount() {
  const root = document.querySelector('[data-topo]');
  if (!root) return;
  const meta = document.querySelector('[data-topo-meta]');
  // A fetch that failed, or an answer the card could not draw: the last drawing stays, and the meta line says so.
  const failed = () => {
    TOPO.failed = true;
    if (!root.isConnected) return;
    if (meta) meta.textContent = '— could not load the topology';
    root.removeAttribute('aria-busy');
  };
  const paint = () => {
    if (!root.isConnected) return;
    if (TOPO.data) topoPaint(document, root, TOPO.data, TOPO.ui);
    if (meta) meta.textContent = TOPO.data || !TOPO.failed ? topoMetaText(TOPO.data) : '— could not load the topology';
    root.removeAttribute('aria-busy');
  };
  const tryPaint = () => {
    try {
      paint();
    } catch {
      failed();
    }
  };
  const load = async () => {
    try {
      TOPO.data = await api('/api/topology');
      TOPO.failed = false;
      paint();
    } catch {
      failed();
    }
  };
  if (TOPO.data) tryPaint();
  load();
  const timer = setInterval(() => {
    if (root.isConnected) load();
  }, TOPO_POLL_MS);
  let frame = 0;
  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => TOPO.data && tryPaint());
        })
      : null;
  if (ro) ro.observe(root);
  onUnmount(() => {
    clearInterval(timer);
    if (ro) ro.disconnect();
    cancelAnimationFrame(frame);
  });
}

if (typeof module !== 'undefined') module.exports = { topoLayout, topoPaint, topoMetaText, topoAgo, topoMount };
