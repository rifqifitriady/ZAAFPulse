// The Overview's provider topology: the pure layout of public/topologyview.js, its SVG and request list built against
// a stand-in document that refuses innerHTML, and an audit of the file (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { topoLayout, topoPaint, topoMetaText, topoAgo, topoMount } = require('../public/topologyview');

const SRC = path.join(__dirname, '..', 'public', 'topologyview.js');
const N = (id, layer, status = 'idle', over = {}) => ({
  id,
  layer,
  kind: 'provider',
  label: id,
  status,
  note: null,
  ...over,
});
const E = (from, to, status = 'idle') => ({ id: `${from}>${to}`, from, to, status });

test('topoLayout: three layers top to bottom, nodes spread evenly across each layer', () => {
  const nodes = [N('t1', 0), N('t2', 0), N('r', 1), N('p1', 2), N('p2', 2), N('p3', 2)];
  const out = topoLayout(nodes, [], 900, 400);
  const at = Object.fromEntries(out.nodes.map((n) => [n.id, n]));
  assert.equal(out.nodes.length, 6);
  assert.ok(at.t1.y < at.r.y && at.r.y < at.p1.y, 'layer 0 above layer 1 above layer 2');
  assert.equal(at.t1.y, at.t2.y);
  assert.equal(at.p1.y, at.p3.y);
  const xs = ['p1', 'p2', 'p3'].map((id) => at[id].x);
  assert.equal(xs[1] - xs[0], xs[2] - xs[1], 'even spacing');
  const mid = (n) => n.x + n.w / 2;
  assert.ok(Math.abs(mid(at.r) - out.width / 2) <= 1, 'a single node sits in the middle');
  for (const n of out.nodes) {
    assert.ok(n.w > 0 && n.h > 0);
    assert.ok(n.x >= 0 && n.x + n.w <= out.width, `${n.id} inside the width`);
    assert.ok(n.y >= 0 && n.y + n.h <= out.height, `${n.id} inside the height`);
  }
});

test('topoLayout: every edge is a cubic path starting with M; edges to missing nodes are left out', () => {
  const nodes = [N('a', 0), N('b', 1), N('c', 2)];
  const out = topoLayout(nodes, [E('a', 'b'), E('b', 'c'), E('a', 'c'), E('a', 'ghost'), null], 800, 360);
  assert.deepEqual(
    out.edges.map((e) => e.id),
    ['a>b', 'b>c', 'a>c'],
  );
  for (const e of out.edges) {
    assert.match(e.d, /^M/);
    assert.match(e.d, / C/);
    assert.doesNotMatch(e.d, /NaN|undefined/);
  }
  // From the bottom of the upper node to the top of the lower one.
  const a = out.nodes.find((n) => n.id === 'a');
  const b = out.nodes.find((n) => n.id === 'b');
  assert.ok(out.edges[0].d.startsWith(`M${a.x + a.w / 2} ${a.y + a.h}`));
  assert.ok(out.edges[0].d.endsWith(`${b.x + b.w / 2} ${b.y}`));
});

test('topoLayout: an empty layer is skipped, a crowded one widens the drawing, junk is ignored', () => {
  const two = topoLayout([N('a', 0), N('c', 2)], [], 800, 360);
  assert.ok(two.nodes[0].y < two.nodes[1].y);
  const many = Array.from({ length: 12 }, (_, i) => N(`p${i}`, 2));
  const wide = topoLayout(many, [], 390, 320);
  assert.ok(wide.width > 390, 'twelve nodes do not fit 390 px, so the drawing is wider and fit scales it');
  assert.ok(Math.abs(wide.height / wide.width - 320 / 390) < 0.01, 'and taller by as much, so fit fills the pane');
  const xs = wide.nodes.map((n) => n.x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] + wide.nodes[0].w, 'no overlap');
  assert.deepEqual(topoLayout(null, null, 0, 0).nodes, []);
  assert.deepEqual(
    topoLayout([null, { layer: 1 }, N('x', 'nope')], [], 600, 300).nodes.map((n) => n.id),
    ['x'],
  );
});

test('topoMetaText and topoAgo', () => {
  assert.equal(
    topoMetaText({ nodes: [N('a', 0, 'active'), N('b', 1, 'active'), N('c', 2, 'error')] }),
    '— 2 active · 1 error',
  );
  assert.equal(topoMetaText(null), '— 0 active · 0 error');
  assert.equal(topoAgo(4000), 'just now');
  assert.equal(topoAgo(42000), '42 s ago');
  assert.equal(topoAgo(5 * 60000), '5 min ago');
  assert.equal(topoAgo(3 * 3600000), '3 h ago');
});

// A tiny stand-in for `document` that records how nodes are filled and refuses innerHTML. With `icons`, a node's icon
// group (the one place the app's own icon markup goes) records it instead.
function fakeDoc({ icons = false } = {}) {
  const el = (tag, ns = null) => {
    const node = { tag, ns, children: [], className: '', attrs: {}, textContent: '' };
    node.appendChild = (c) => (node.children.push(c), (c.parent = node), c);
    node.removeChild = (c) => ((node.children = node.children.filter((x) => x !== c)), c);
    node.replaceChildren = (...cs) => {
      node.children = [];
      for (const c of cs) node.appendChild(c);
    };
    node.setAttribute = (k, v) => (node.attrs[k] = String(v));
    node.removeAttribute = (k) => delete node.attrs[k];
    Object.defineProperty(node, 'innerHTML', {
      get: () => node.html,
      set(v) {
        if (!(icons && node.attrs.class === 'topo-ico')) throw new Error('innerHTML used for content');
        node.html = v;
      },
    });
    return node;
  };
  return {
    createElement: (tag) => el(tag),
    createElementNS: (ns, tag) => el(tag, ns),
    createTextNode: (text) => ({ tag: '#text', text }),
  };
}
const flat = (n, out = []) => {
  out.push(n);
  for (const c of n.children || []) flat(c, out);
  return out;
};
const cls = (n) => (n.ns ? n.attrs.class || '' : n.className);
const isGraph = (n) => n.tag === 'svg' && /\btopo-svg\b/.test(cls(n));

const EVIL = '<img src=x onerror=alert(1)>';
const DATA = {
  ts: 1_000_000,
  nodes: [
    { id: 'claude', layer: 0, kind: 'tool', label: 'Claude Code', status: 'active', note: null },
    { id: 'router:omniroute', layer: 1, kind: 'router', label: 'OmniRoute', status: 'error', note: 'timed out' },
    { id: 'runtime:x', layer: 1, kind: 'runtime', label: EVIL, status: 'recent', note: EVIL },
    { id: 'provider:anthropic', layer: 2, kind: 'provider', label: 'Anthropic', status: 'idle', note: null },
    { id: 'provider:odd', layer: 2, kind: 'provider', label: 'Odd', status: '<b>', note: null },
  ],
  edges: [E('claude', 'router:omniroute', 'error'), E('router:omniroute', 'provider:anthropic', 'recent')],
  requests: [
    {
      ts: 1_000_000 - 120000,
      path: ['claude', 'router:omniroute', 'provider:anthropic'],
      client: 'Claude Code',
      model: EVIL,
      tokens: 5840,
      ms: 2900,
      ok: false,
      source: 'router',
    },
  ],
};

test('topoPaint: an SVG made with createElementNS, labels and request rows as text, status classes', () => {
  const doc = fakeDoc();
  const root = doc.createElement('div');
  const ui = {};
  topoPaint(doc, root, DATA, ui);
  const all = flat(root);
  const svg = all.find(isGraph);
  assert.ok(svg, 'an svg');
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.match(svg.attrs.viewBox, /^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/);
  const nodes = all.filter((n) => n.attrs && n.attrs['data-topo-node']);
  assert.equal(nodes.length, 5);
  const byId = Object.fromEntries(nodes.map((n) => [n.attrs['data-topo-node'], n]));
  assert.match(cls(byId.claude), /\btopo-active\b/);
  assert.match(cls(byId['router:omniroute']), /\btopo-error\b/);
  assert.match(cls(byId['runtime:x']), /\btopo-recent\b/);
  assert.match(cls(byId['provider:anthropic']), /\btopo-idle\b/);
  assert.match(cls(byId['provider:odd']), /\btopo-idle\b/, 'an unknown status is idle');
  const edges = all.filter((n) => n.tag === 'path' && /\btopo-edge\b/.test(cls(n)));
  assert.equal(edges.length, 2);
  assert.match(cls(edges[0]), /\btopo-error\b/);
  assert.match(cls(edges[1]), /\btopo-recent\b/);
  // The hostile label stays literal text, in the label and in the tooltip.
  const evilTexts = flat(byId['runtime:x']).filter(
    (n) => typeof n.textContent === 'string' && n.textContent.includes('<img'),
  );
  assert.ok(evilTexts.length >= 1);
  for (const t of evilTexts) assert.ok(t.tag === 'text' || t.tag === 'title' || t.tag === 'tspan');
  assert.ok(flat(byId['runtime:x']).some((n) => n.tag === 'title' && n.textContent.includes(EVIL)));
  // The request row: path labels joined by arrows, the model as text, an error dot.
  const rows = all.filter((n) => n.attrs && n.attrs['data-topo-req'] != null);
  assert.equal(rows.length, 1);
  const rowText = flat(rows[0])
    .map((n) => n.textContent)
    .filter(Boolean);
  assert.ok(rowText.includes('Claude Code → OmniRoute → Anthropic'));
  assert.ok(
    rowText.some((t) => t.includes(EVIL)),
    'the model is literal text',
  );
  assert.ok(rowText.includes('2 min ago'));
  assert.ok(flat(rows[0]).some((n) => /\btopo-bad\b/.test(cls(n))));
});

test('topoPaint updates in place: the same SVG and nodes, the view and highlight kept', () => {
  const doc = fakeDoc();
  const root = doc.createElement('div');
  const ui = {};
  topoPaint(doc, root, DATA, ui);
  const svg = flat(root).find(isGraph);
  const claude = flat(root).find((n) => n.attrs && n.attrs['data-topo-node'] === 'claude');
  ui.scale = 2;
  ui.moved = true;
  ui.sel = { kind: 'node', id: 'claude' };
  const view = svg.attrs.viewBox;
  const next = { ...DATA, nodes: DATA.nodes.map((n) => (n.id === 'claude' ? { ...n, status: 'error' } : n)) };
  topoPaint(doc, root, next, ui);
  const all = flat(root);
  assert.equal(all.filter(isGraph).length, 1);
  assert.equal(all.find(isGraph), svg);
  assert.equal(
    all.find((n) => n.attrs && n.attrs['data-topo-node'] === 'claude'),
    claude,
  );
  assert.match(cls(claude), /\btopo-error\b/);
  assert.match(cls(claude), /\btopo-hi\b/);
  assert.match(svg.attrs.class, /\btopo-focus\b/);
  assert.notEqual(svg.attrs.viewBox, view, 'zoomed in');
  // A node that is gone is removed; with no requests the list says so.
  topoPaint(doc, root, { ...DATA, nodes: DATA.nodes.slice(0, 2), requests: [] }, ui);
  assert.equal(flat(root).filter((n) => n.attrs && n.attrs['data-topo-node']).length, 2);
  assert.ok(flat(root).some((n) => n.textContent === 'No requests in the last 3 hours.'));
});

test('topoPaint: junk data never throws', () => {
  const doc = fakeDoc();
  const junk = [
    null,
    undefined,
    [],
    7,
    'x',
    { nodes: null, edges: 'x', requests: {} },
    {
      ts: 'soon',
      nodes: [
        { id: 'a', layer: 0, kind: 'tool', label: 42, status: 3, note: {} },
        { id: 'b', layer: 'x', kind: {}, label: { x: 1 }, note: ['n'] },
        { id: 'c', layer: -1, kind: null, label: null },
        { id: 'a', layer: 2, label: ['dup'] },
        { id: 9, label: 'no string id' },
        null,
        'node',
      ],
      edges: [
        { id: 'a>ghost', from: 'a', to: 'ghost', status: 'active' },
        { from: 'ghost', to: 'b' },
        { id: 5, from: 'a', to: 'b' },
        { from: 'a', to: 'a' },
        { from: 1, to: 2 },
        null,
      ],
      requests: [
        { ts: 'x', path: [1, null, {}, ['a'], 'a', 'ghost'], client: 5, model: {}, tokens: '9', ms: -1, ok: 'no' },
        { path: 'a>b' },
        { ts: 1, path: null },
        null,
        7,
      ],
    },
  ];
  const root = doc.createElement('div');
  const ui = {};
  for (const d of junk) {
    assert.doesNotThrow(() => topoPaint(doc, root, d, ui), JSON.stringify(d));
    assert.doesNotThrow(() => topoPaint(doc, doc.createElement('div'), d, {}), JSON.stringify(d));
  }
  // Drawn as text, with the junk labels falling back to the id.
  topoPaint(doc, root, junk[6], ui);
  const labels = flat(root)
    .filter((n) => n.tag === 'text' && /\btopo-label\b/.test(cls(n)))
    .map((n) => n.textContent);
  assert.deepEqual(labels.sort(), ['a', 'b', 'c']);
  for (const n of flat(root)) assert.doesNotMatch(String(n.textContent || ''), /undefined|NaN|\[object Object\]/);
});

// Fakes for the browser globals topoMount uses. setInterval and clearInterval are swapped in only around the calls
// that use them, so node's own timers are left alone.
function fakeBrowser(doc) {
  const root = doc.createElement('div');
  root.isConnected = true;
  root.setAttribute('aria-busy', 'true');
  const meta = doc.createElement('span');
  const calls = { api: [], intervals: [], cleared: [], hooks: [], observers: [], frames: [], icons: [] };
  const answers = [];
  const globals = {
    document: {
      ...doc,
      querySelector: (sel) => (sel === '[data-topo]' ? root : sel === '[data-topo-meta]' ? meta : null),
    },
    api: (url) => {
      calls.api.push(url);
      const next = answers.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    onUnmount: (fn) => calls.hooks.push(fn),
    ResizeObserver: class {
      constructor(fn) {
        this.fn = fn;
        this.on = false;
        calls.observers.push(this);
      }
      observe() {
        this.on = true;
      }
      disconnect() {
        this.on = false;
      }
    },
    requestAnimationFrame: (fn) => (calls.frames.push(fn), calls.frames.length),
    cancelAnimationFrame: () => {},
    icon: (name, size) => (calls.icons.push(name), `<svg class="i" data-i="${name}" width="${size}"></svg>`),
  };
  const timers = {
    setInterval: (fn, ms) => (calls.intervals.push({ fn, ms }), calls.intervals.length),
    clearInterval: (id) => calls.cleared.push(id),
  };
  const withTimers = (fn) => {
    const saved = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
    Object.assign(globalThis, timers);
    try {
      return fn();
    } finally {
      Object.assign(globalThis, saved);
    }
  };
  const install = () => Object.assign(globalThis, globals);
  const remove = () => {
    for (const k of Object.keys(globals)) delete globalThis[k];
  };
  return { root, meta, calls, answers, install, remove, withTimers };
}
const settle = () => new Promise((r) => setImmediate(r));

test('topoMount: a failed first load, a good load, a tick, a paint that throws, unmount and remount', async () => {
  const b = fakeBrowser(fakeDoc({ icons: true }));
  const unhandled = [];
  const onRejection = (e) => unhandled.push(e);
  process.on('unhandledRejection', onRejection);
  b.install();
  try {
    // Mount: the first fetch fails, and the meta line says so.
    b.answers.push(new Error('503 down'));
    b.withTimers(() => topoMount());
    await settle();
    assert.deepEqual(b.calls.api, ['/api/topology']);
    assert.equal(b.meta.textContent, '— could not load the topology');
    assert.equal(b.root.attrs['aria-busy'], undefined, 'no longer busy');
    assert.equal(b.calls.intervals.length, 1);
    assert.equal(b.calls.intervals[0].ms, 10000);
    assert.equal(flat(b.root).filter(isGraph).length, 0, 'nothing to draw yet');

    // A tick: a good load draws the graph, with the app's own icon markup in each node's icon group.
    b.answers.push(DATA);
    b.calls.intervals[0].fn();
    await settle();
    assert.equal(b.meta.textContent, '— 1 active · 1 error');
    const svg = flat(b.root).find(isGraph);
    assert.ok(svg);
    const icos = flat(b.root).filter((n) => n.attrs && n.attrs.class === 'topo-ico');
    assert.equal(icos.length, 5);
    for (const g of icos) assert.match(g.html, /^<svg class="i" data-i="[a-z]+" width="14"><\/svg>$/);
    assert.deepEqual(b.calls.icons.slice(0, 2), ['terminal', 'compass']);

    // Another tick updates in place.
    b.answers.push({ ...DATA, nodes: DATA.nodes.map((n) => ({ ...n, status: 'active' })) });
    b.calls.intervals[0].fn();
    await settle();
    assert.equal(b.meta.textContent, '— 5 active · 0 error');
    assert.equal(flat(b.root).find(isGraph), svg);

    // A resize repaints on the next frame.
    assert.equal(b.calls.observers.length, 1);
    assert.ok(b.calls.observers[0].on);
    b.calls.observers[0].fn();
    assert.equal(b.calls.frames.length, 1);
    assert.doesNotThrow(() => b.calls.frames[0]());

    // An answer the card cannot draw: the failure is caught and shown, not left as an unhandled rejection.
    const bad = {
      get nodes() {
        throw new Error('cannot draw');
      },
    };
    b.answers.push(bad);
    b.calls.intervals[0].fn();
    await settle();
    assert.equal(b.meta.textContent, '— could not load the topology');
    assert.deepEqual(unhandled, []);

    // Unmount: the interval is cleared and the observer let go.
    assert.equal(b.calls.hooks.length, 1);
    b.withTimers(() => b.calls.hooks.splice(0).forEach((fn) => fn()));
    assert.deepEqual(b.calls.cleared, [1]);
    assert.equal(b.calls.observers[0].on, false);

    // Remount: exactly one interval runs.
    b.answers.push(DATA);
    b.withTimers(() => topoMount());
    await settle();
    const running = b.calls.intervals.map((_, i) => i + 1).filter((id) => !b.calls.cleared.includes(id));
    assert.deepEqual(running, [2]);
    assert.equal(b.calls.hooks.length, 1);
    assert.equal(b.meta.textContent, '— 1 active · 1 error');
    assert.deepEqual(unhandled, []);
  } finally {
    b.remove();
    process.off('unhandledRejection', onRejection);
  }
});

test('topologyview.js builds no HTML from server text (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // The only innerHTML is the app's own icon markup.
  const sets = [...src.matchAll(/\binnerHTML\s*\+?=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(sets, ['iconHtml']);
  assert.match(src, /const iconHtml = typeof icon === 'function' \? icon\(/);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|DOMParser|createContextualFragment/);
  for (const t of [...src.matchAll(/`[^`]*`/g)].map((m) => m[0]).filter((x) => /<[a-z]/.test(x)))
    assert.doesNotMatch(t, /\$\{/, `a template with markup takes a value: ${t.slice(0, 60)}`);
  assert.match(src, /createElementNS\(TOPO_NS/);
});

test('the Overview holds the section above AI Office and the page loads the script before overviewview.js', () => {
  const ov = fs.readFileSync(path.join(__dirname, '..', 'public', 'overviewview.js'), 'utf8');
  const topo = ov.indexOf('<h2>Provider topology</h2>');
  assert.ok(topo > 0);
  assert.ok(topo < ov.indexOf('<h2>AI Office</h2>'));
  assert.match(ov, /data-topo-meta/);
  assert.match(ov, /topoMount\(\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const a = html.indexOf('<script src="topologyview.js"></script>');
  assert.ok(a > 0 && a < html.indexOf('<script src="overviewview.js"></script>'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // One colour token per status (idle is the default look); the other three each have a class.
  for (const s of ['active', 'recent', 'error', 'idle']) assert.match(css, new RegExp(`--topo-${s}: var\\(--`));
  for (const s of ['active', 'recent', 'error']) assert.match(css, new RegExp(`\\.topo-node\\.topo-${s} \\.topo-box`));
  assert.match(css, /@media \(max-width: 900px\)[^{]*\{[^}]*\.topo\b/);
});
