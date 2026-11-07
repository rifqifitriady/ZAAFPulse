// The Trace Explorer's metro map (public/tracemetro.js): the pure geometry the canvas is drawn from.
const test = require('node:test');
const assert = require('node:assert/strict');
const { traceDemo } = require('../lib/demo');
const { mapNodes } = require('../public/traceview.js');
const {
  METRO_GAP,
  METRO_BACK,
  metroSmooth,
  metroLayout,
  metroCamera,
  metroProject,
  metroLabelled,
  metroHit,
  metroBar,
  metroTour,
  metroRideAt,
} = require('../public/tracemetro.js');

const demoNodes = () => mapNodes(traceDemo(Date.UTC(2026, 9, 20, 12)).skeletons['demo-claude-1'].spans);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const VIEW = { w: 600, h: 400, f: 380, height: 110, horizon: 0.27 };

test('metroSmooth: clamps and eases', () => {
  assert.equal(metroSmooth(-1), 0);
  assert.equal(metroSmooth(0), 0);
  assert.equal(metroSmooth(0.5), 0.5);
  assert.equal(metroSmooth(1), 1);
  assert.equal(metroSmooth(2), 1);
});

test('metroLayout: stations 120 apart in order, swaying along the line', () => {
  const lay = metroLayout([{ kind: 'session' }, { kind: 'turn' }, { kind: 'chat' }]);
  assert.deepEqual(
    lay.map((p) => p.z),
    [0, METRO_GAP, 2 * METRO_GAP],
  );
  lay.forEach((p, i) => {
    near(p.x, Math.sin(i * 0.85) * 80);
    assert.equal(p.branch, 0);
  });
});

test('metroLayout: a subagent sits on a side branch; subagents alternate sides', () => {
  const lay = metroLayout([{ kind: 'turn' }, { kind: 'agent' }, { kind: 'agent' }, { kind: 'tool' }]);
  assert.equal(lay[1].branch, 1);
  assert.equal(lay[1].x, 160);
  assert.equal(lay[2].branch, -1);
  assert.equal(lay[2].x, -160);
  assert.equal(lay[3].branch, 0);
  assert.equal(lay[2].z, 2 * METRO_GAP);
});

test('metroLayout: an empty or missing list gives no stations', () => {
  assert.deepEqual(metroLayout([]), []);
  assert.deepEqual(metroLayout(undefined), []);
});

test('metroCamera: 190 behind the station, leaning 55% towards its x; clamped at both ends', () => {
  const lay = [
    { x: 0, z: 0, branch: 0 },
    { x: 100, z: 120, branch: 0 },
  ];
  assert.deepEqual(metroCamera(lay, 0), { x: 0, z: -METRO_BACK });
  const half = metroCamera(lay, 0.5);
  near(half.x, 50 * 0.55);
  near(half.z, 60 - METRO_BACK);
  const end = metroCamera(lay, 7);
  near(end.x, 55); // 100 × 0.55 is 55.00000000000001 in floating point
  near(end.z, 120 - METRO_BACK);
  assert.deepEqual(metroCamera(lay, -3), { x: 0, z: -METRO_BACK });
  assert.deepEqual(metroCamera([], 0), { x: 0, z: -METRO_BACK });
});

test('metroProject: ahead lands on the centre column, behind is null, k shrinks with distance', () => {
  const cam = { x: 0, z: 0 };
  const a = metroProject(cam, { x: 0, z: 190 }, VIEW);
  near(a[0], 300);
  near(a[2], 2);
  near(a[1], 400 * 0.27 + 110 * 2);
  near(a[3], 190);
  const far = metroProject(cam, { x: 0, z: 950 }, VIEW);
  assert.ok(far[2] < a[2]);
  const up = metroProject(cam, { x: 0, y: 56, z: 190 }, VIEW);
  assert.ok(up[1] < a[1], 'a raised point is higher on screen');
  assert.equal(metroProject(cam, { x: 0, z: 10 }, VIEW), null);
  assert.equal(metroProject(cam, { x: 0, z: -50 }, VIEW), null);
});

test('metroLabelled: focus − 1 … focus + 2 clamped to the line, plus the selection', () => {
  assert.deepEqual(
    [...metroLabelled(10, 0, -1)].sort((a, b) => a - b),
    [0, 1, 2],
  );
  assert.deepEqual(
    [...metroLabelled(10, 5, -1)].sort((a, b) => a - b),
    [4, 5, 6, 7],
  );
  assert.deepEqual(
    [...metroLabelled(10, 9, -1)].sort((a, b) => a - b),
    [8, 9],
  );
  assert.deepEqual(
    [...metroLabelled(10, 5, 1)].sort((a, b) => a - b),
    [1, 4, 5, 6, 7],
  );
  assert.deepEqual(
    [...metroLabelled(10, 4.6, 99)].sort((a, b) => a - b),
    [4, 5, 6, 7],
  );
  assert.equal(metroLabelled(0, 0, 0).size, 0);
});

test('metroHit: inside the radius hits, outside misses, the nearest of two overlapping wins', () => {
  const pts = [[100, 100, 1, 300], null, [300, 300, 1, 500]];
  assert.equal(metroHit(pts, 110, 105), 0);
  assert.equal(metroHit(pts, 140, 100), -1);
  assert.equal(metroHit(pts, 300, 321), 2);
  const overlap = [
    [200, 200, 1, 600],
    [205, 200, 1, 400],
  ];
  assert.equal(metroHit(overlap, 202, 200), 1);
  assert.equal(metroHit([], 0, 0), -1);
});

test('metroBar: the demo turn gives fractions inside 0..1, one per timed step', () => {
  const nodes = demoNodes();
  const bar = metroBar(nodes);
  assert.ok(bar.length > 0);
  for (const s of bar) {
    assert.ok(nodes[s.i].kind !== 'session' && nodes[s.i].kind !== 'turn');
    assert.ok(s.left >= 0 && s.width >= 0 && s.left + s.width <= 1 + 1e-9, JSON.stringify(s));
  }
  assert.equal(Math.min(...bar.map((s) => s.left)), 0);
  near(Math.max(...bar.map((s) => s.left + s.width)), 1);
});

test('metroBar: a node without times is left out; a zero-length turn gives no NaN', () => {
  const bar = metroBar([
    { kind: 'turn', start: 0, end: 10 },
    { kind: 'tool', start: 0, end: 4 },
    { kind: 'tool', start: null, end: null },
    { kind: 'chat', start: 4, end: 10 },
  ]);
  assert.deepEqual(
    bar.map((s) => s.i),
    [1, 3],
  );
  near(bar[1].left, 0.4);
  near(bar[1].width, 0.6);
  const flat = metroBar([{ kind: 'tool', start: 5, end: 5 }]);
  assert.deepEqual(flat, [{ i: 0, left: 0, width: 0 }]);
  assert.deepEqual(metroBar(undefined), []);
});

test('metroTour: moves 1100 ms, rests 900 ms, rests 2 s at the end, fades and wraps', () => {
  const n = 4; // 3 moves of 2000 ms, then 2000 ms rest, 250 ms fade out, 250 ms fade in: 8500 ms
  assert.deepEqual(metroTour(0, n), { p: 0, fade: 0 });
  near(metroTour(550, n).p, 0.5);
  assert.deepEqual(metroTour(1100, n), { p: 1, fade: 0 });
  assert.deepEqual(metroTour(1999, n), { p: 1, fade: 0 });
  near(metroTour(2550, n).p, 1.5);
  assert.deepEqual(metroTour(6000, n), { p: 3, fade: 0 });
  assert.deepEqual(metroTour(7999, n), { p: 3, fade: 0 });
  const out = metroTour(8125, n);
  assert.equal(out.p, 3);
  near(out.fade, 0.5);
  const back = metroTour(8375, n);
  assert.equal(back.p, 0);
  near(back.fade, 0.5);
  assert.deepEqual(metroTour(8500, n), { p: 0, fade: 0 });
  near(metroTour(8500 + 550, n).p, 0.5);
});

test('metroTour: one station or none rests at 0; bad times count as 0', () => {
  assert.deepEqual(metroTour(5000, 1), { p: 0, fade: 0 });
  assert.deepEqual(metroTour(5000, 0), { p: 0, fade: 0 });
  assert.deepEqual(metroTour(NaN, 4), { p: 0, fade: 0 });
  assert.deepEqual(metroTour(-20, 4), { p: 0, fade: 0 });
});

test('metroRideAt: the ride time at which the camera rests at station k', () => {
  assert.equal(metroRideAt(0), 0);
  assert.equal(metroRideAt(-2), 0);
  assert.equal(metroRideAt(1), 1100);
  assert.equal(metroRideAt(3), 5100);
  for (const k of [1, 2, 3]) assert.equal(metroTour(metroRideAt(k), 5).p, k);
});

// ---- the renderer, on a fake canvas: no browser, a hand-driven clock and frame queue ----
const { after } = require('node:test');
const { trMetro, metroProject: project, metroCamera: camera, metroLayout: layout } = require('../public/tracemetro.js');

function fakeCanvas({ ctx = true, width = 600 } = {}) {
  const calls = [];
  const store = {};
  const c2d = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return (...a) => {
        calls.push([k, ...a]);
      };
    },
    set(t, k, v) {
      t[k] = v;
      calls.push(['set', k, v]);
      return true;
    },
  });
  const listeners = {};
  const canvas = {
    clientWidth: width,
    clientHeight: 400,
    width: 0,
    height: 0,
    style: {},
    getContext: () => (ctx ? c2d : null),
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type) => {
      delete listeners[type];
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 400 }),
  };
  return { canvas, calls, listeners };
}

// The browser globals the renderer tests replace, put back when the file is done.
const realGlobals = ['requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia'].map((k) => [
  k,
  Object.prototype.hasOwnProperty.call(global, k),
  global[k],
]);
after(() => {
  for (const [k, had, v] of realGlobals) {
    if (had) global[k] = v;
    else delete global[k];
  }
});

function harness(opts = {}) {
  const queue = []; // { id, fn }
  let nextId = 1;
  global.requestAnimationFrame = (fn) => {
    const id = nextId++;
    queue.push({ id, fn });
    return id;
  };
  global.cancelAnimationFrame = (id) => {
    const at = queue.findIndex((q) => q.id === id);
    if (at >= 0) queue.splice(at, 1);
  };
  if (opts.reduced) global.matchMedia = () => ({ matches: true });
  else delete global.matchMedia;
  const clock = { t: 0 };
  const seen = { picks: [], frames: [], toggles: 0, enters: 0 };
  const fake = fakeCanvas(opts);
  const m = trMetro(fake.canvas, {
    clock: () => clock.t,
    onPick: (i) => seen.picks.push(i),
    onFrame: (p) => seen.frames.push(p),
    onToggle: () => seen.toggles++,
    onEnter: () => seen.enters++,
  });
  const step = (t) => {
    clock.t = t;
    const fns = queue.splice(0);
    fns.forEach((q) => q.fn());
  };
  const lastP = () => seen.frames[seen.frames.length - 1];
  return { m, step, seen, lastP, queue, clock, ...fake };
}

const part = (n) => ({
  color: '#4de8ff',
  title: `Step ${n.kind}`,
  meta: 'meta',
  dur: '1.0 s',
  cost: '',
  err: n.status === 'error',
  loop: n.count || 1,
  evalFail: false,
  preview: '',
});

test('trMetro: no 2D context gives null', () => {
  const { canvas } = fakeCanvas({ ctx: false });
  assert.equal(trMetro(canvas, {}), null);
});

test('trMetro: draws the demo turn and rides the line on its own', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  assert.equal(h.lastP(), 0);
  assert.ok(
    h.calls.some((c) => c[0] === 'fillText'),
    'labels are drawn with fillText',
  );
  h.step(3000);
  assert.ok(h.lastP() > 1 && h.lastP() < 2, `riding: ${h.lastP()}`);
  h.m.destroy();
});

test('trMetro: an empty turn says so', () => {
  const h = harness();
  h.m.setNodes([], [], -1, { restart: true });
  h.step(0);
  assert.ok(h.calls.some((c) => c[0] === 'fillText' && c[1] === 'No steps in this turn'));
  h.m.destroy();
});

test('trMetro: a selection flies the camera there, pauses the ride 10 s, then the ride resumes from it', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  h.m.select(3, { fly: true });
  h.step(300);
  assert.ok(h.lastP() > 0 && h.lastP() < 3, `in flight: ${h.lastP()}`);
  h.step(700);
  assert.equal(h.lastP(), 3);
  h.step(9000);
  assert.equal(h.lastP(), 3, 'still paused');
  h.step(10500);
  assert.equal(h.lastP(), 3, 'resumes resting at the selected station');
  h.step(12000);
  assert.ok(h.lastP() > 3, `riding on from it: ${h.lastP()}`);
  h.m.destroy();
});

test('trMetro: a selection without fly only marks it; the ride goes on', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  h.m.select(4, { fly: false });
  h.step(3000);
  assert.ok(h.lastP() > 1 && h.lastP() < 2);
  h.m.destroy();
});

test('trMetro: a stopped ride stays put and follows the selection', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), 2, { restart: true });
  h.m.tour(false);
  h.step(0);
  h.step(700);
  assert.equal(h.lastP(), 2, 'flies to the selection when stopped');
  h.step(30000);
  assert.equal(h.lastP(), 2);
  h.m.tour(true);
  h.step(30100);
  h.step(31600);
  assert.ok(h.lastP() > 2);
  h.m.destroy();
});

test('trMetro: a click on a station picks it; keys pick, toggle and enter', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), 1, { restart: true });
  h.m.tour(false);
  h.step(0);
  h.step(700); // the camera rests at station 1
  const lay = layout(nodes);
  const g = project(
    camera(lay, 1),
    { x: lay[1].x, y: 0, z: lay[1].z },
    { w: 600, h: 400, f: 380, height: 110, horizon: 0.27 },
  );
  h.listeners.click({ clientX: g[0], clientY: g[1] });
  assert.deepEqual(h.seen.picks, [1]);
  let prevented = 0;
  const key = (k) => h.listeners.keydown({ key: k, preventDefault: () => prevented++ });
  key('ArrowRight');
  key('ArrowLeft');
  key('Home');
  key('End');
  assert.deepEqual(h.seen.picks, [1, 2, 0, 0, nodes.length - 1]);
  key(' ');
  key('Enter');
  assert.equal(h.seen.toggles, 1);
  assert.equal(h.seen.enters, 1);
  assert.equal(prevented, 6);
  key('x');
  assert.equal(prevented, 6, 'other keys pass through');
  h.m.destroy();
});

test('trMetro: hidden or destroyed, no frame is asked for', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  h.m.show(false);
  h.step(100);
  assert.equal(h.queue.length, 0);
  h.m.show(true);
  assert.equal(h.queue.length, 1);
  h.m.destroy();
  h.step(200);
  assert.equal(h.queue.length, 0);
});

test('trMetro: the ▶ button resumes the ride at once, even inside the pause after a selection', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  h.m.select(3, { fly: true });
  h.step(700);
  assert.equal(h.lastP(), 3);
  h.m.tour(false);
  h.m.tour(true);
  h.step(800);
  h.step(1400);
  h.step(2500);
  assert.ok(h.lastP() > 3, `riding again: ${h.lastP()}`);
  h.m.destroy();
});

test('trMetro: the wheel moves the camera about one station per notch and holds it for 10 s', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  h.step(100);
  let prevented = 0;
  h.listeners.wheel({ deltaY: 300, deltaMode: 0, preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  h.step(200);
  const held = h.lastP();
  assert.ok(Math.abs(held - 1) < 0.1, `about one station on: ${held}`);
  h.step(5000);
  assert.equal(h.lastP(), held, 'held');
  h.step(10000);
  assert.equal(h.lastP(), held, 'still held before METRO_PAUSE has elapsed');
  h.step(10200);
  h.step(12000);
  assert.ok(h.lastP() > 1.5, `riding on: ${h.lastP()}`);
  h.m.destroy();
});

test('trMetro: the wheel reads lines and pages as well as pixels', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.m.tour(false);
  h.step(0);
  h.listeners.wheel({ deltaY: 3, deltaMode: 1, preventDefault() {} }); // 3 lines = 48 px
  h.step(10);
  assert.ok(Math.abs(h.lastP() - 0.16) < 0.01, `lines: ${h.lastP()}`);
  h.listeners.wheel({ deltaY: -1, deltaMode: 2, preventDefault() {} }); // a page up: 400 px back to the start
  h.step(20);
  assert.equal(h.lastP(), 0);
  h.m.destroy();
});

test('trMetro: the pointer over the map stops the ride, leaving lets it go on', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  h.step(500);
  h.listeners.pointerenter();
  h.step(1000);
  const held = h.lastP();
  h.step(1500);
  h.step(8000);
  assert.equal(h.lastP(), held, 'p stays put while the pointer is over the map');
  h.listeners.pointerleave();
  h.step(8100);
  h.step(9100);
  assert.ok(h.lastP() !== held, `riding again: ${h.lastP()}`);
  h.m.destroy();
});

test('trMetro: reduced motion shows a station added at the end at once, with no fade-in', () => {
  const h = harness({ reduced: true });
  const nodes = demoNodes();
  const parts = nodes.map(part);
  h.m.tour(false);
  h.m.setNodes(nodes, parts, -1, { restart: true });
  h.step(0);
  const more = nodes.concat([{ ...nodes[1] }]);
  h.clock.t = 10;
  h.m.setNodes(more, parts.concat([{ ...part(nodes[1]), title: 'Newcomer' }]), more.length - 1, { restart: false });
  h.step(10);
  assert.ok(
    h.calls.some((c) => c[0] === 'fillText' && String(c[1]).includes('Newcomer')),
    'the new station is drawn and labelled in the first frame',
  );
  h.m.destroy();
});

test('trMetro: reduced motion rides only by whole stations, and only when started', () => {
  const h = harness({ reduced: true });
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.m.tour(true);
  let top = 0;
  for (let t = 0; t <= 20000; t += 500) {
    h.m.show(true); // the 250 ms redraw timer is real; nudge a frame by hand
    h.step(t);
    assert.ok(Number.isInteger(h.lastP()), `whole station at ${t}: ${h.lastP()}`);
    top = Math.max(top, h.lastP());
  }
  assert.ok(top >= 2, `it did step along: ${top}`);
  h.m.destroy();
});

// ---- polish: labels stay inside the map and never overlap; sizes near the camera are capped ----
const labelBoxes = (calls) =>
  calls.filter((c) => c[0] === 'roundRect').map((c) => ({ X: c[1], Y: c[2], W: c[3], H: c[4] }));
const overlap = (a, b) => a.X < b.X + b.W && b.X < a.X + a.W && a.Y < b.Y + b.H && b.Y < a.Y + a.H;

// One frame at camera position p (a float station index), optionally with a selection; returns the label boxes.
function frameAt(p, { sel = -1, width = 360 } = {}) {
  const h = harness({ width });
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), sel, { restart: true });
  h.m.tour(false);
  h.step(0);
  h.listeners.wheel({ deltaY: p * 300, deltaMode: 0, preventDefault() {} });
  h.calls.length = 0;
  h.step(10);
  const out = { boxes: labelBoxes(h.calls), calls: h.calls.slice() };
  h.m.destroy();
  return out;
}

test('trMetro: every label lies fully inside a 360 px map', () => {
  const nodes = demoNodes();
  const spots = [];
  for (let p = 0; p <= nodes.length - 1; p += 0.5) spots.push([p, -1]);
  [0, nodes.length - 1, 2, nodes.length - 2].forEach((s) => spots.push([s, s]));
  for (const [p, sel] of spots) {
    const { boxes } = frameAt(p, { sel });
    assert.ok(boxes.length > 0, `labels at ${p}`);
    for (const b of boxes) assert.ok(b.X >= 0 && b.X + b.W <= 360, `p=${p} sel=${sel}: ${JSON.stringify(b)}`);
  }
});

test('trMetro: no two labels of one frame overlap', () => {
  const nodes = demoNodes();
  for (let p = 0; p <= nodes.length - 1; p += 0.5) {
    const { boxes } = frameAt(p);
    for (let a = 0; a < boxes.length; a++)
      for (let b = a + 1; b < boxes.length; b++)
        assert.ok(!overlap(boxes[a], boxes[b]), `p=${p}: ${JSON.stringify(boxes[a])} vs ${JSON.stringify(boxes[b])}`);
  }
});

test('trMetro: near the camera the track and the orbs keep a capped size', () => {
  const nodes = demoNodes();
  for (let p = 0; p <= nodes.length - 1; p++) {
    const { calls } = frameAt(p);
    for (const c of calls) {
      if (c[0] === 'set' && c[1] === 'lineWidth') assert.ok(c[2] <= 16, `p=${p} lineWidth ${c[2]}`);
      if (c[0] === 'arc') assert.ok(c[3] <= 9 * 3 * 1.15 + 1, `p=${p} arc radius ${c[3]}`);
    }
  }
});

// ---- final review fixes ----
const inFade = (calls) =>
  calls.some((c) => c[0] === 'set' && c[1] === 'fillStyle' && String(c[2]).startsWith('rgba(7,10,31'));

for (const grown of [true, false]) {
  test(`trMetro: a live repaint after the ride has looped keeps the camera in place (${grown ? 'one station added' : 'same count'})`, () => {
    const h = harness();
    const nodes = demoNodes().slice(0, 5);
    h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
    for (let t = 0; t <= 12000; t += 100) h.step(t);
    const before = h.lastP();
    const more = grown ? nodes.concat([{ ...nodes[1] }]) : nodes.slice();
    h.m.setNodes(more, more.map(part), -1, { restart: false });
    h.calls.length = 0;
    h.step(12100);
    assert.ok(Math.abs(h.lastP() - before) < 0.6, `camera jumped: ${before} -> ${h.lastP()}`);
    assert.ok(!inFade(h.calls), 'not in a fade');
    h.m.destroy();
  });
}

test('trMetro: a stopped ride keeps a wheeled camera on a live repaint, and follows a changed selection', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), 1, { restart: true });
  h.m.tour(false);
  h.step(0);
  h.step(700);
  h.listeners.wheel({ deltaY: 900, deltaMode: 0, preventDefault() {} });
  h.step(710);
  const wheeled = h.lastP();
  assert.ok(wheeled > 3, `wheeled on: ${wheeled}`);
  h.m.setNodes(nodes, nodes.map(part), 1, { restart: false });
  h.step(720);
  assert.equal(h.lastP(), wheeled, 'same selection: the camera stays');
  h.m.setNodes(nodes, nodes.map(part), 2, { restart: false });
  h.step(730);
  h.step(1500);
  assert.equal(h.lastP(), 2, 'a new selection pulls the camera');
  h.m.destroy();
});

test('trMetro: a stopped, wheeled camera stays on a live repaint with fly off, and flies to a new selection', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), 1, { restart: true });
  h.m.tour(false);
  h.step(0);
  h.step(700);
  h.listeners.wheel({ deltaY: 900, deltaMode: 0, preventDefault() {} });
  h.step(710);
  const wheeled = h.lastP();
  assert.ok(Math.abs(wheeled - 4) < 0.1, `wheeled to about 4: ${wheeled}`);
  h.m.setNodes(nodes, nodes.map(part), 1, { restart: false });
  h.m.select(1, { fly: false });
  h.step(720);
  h.step(1500);
  assert.equal(h.lastP(), wheeled, 'same selection: the camera stays');
  h.m.select(2, { fly: false });
  h.step(1510);
  h.step(2500);
  assert.equal(h.lastP(), 2, 'a changed selection flies');
  h.m.destroy();
});

test('trMetro: a sideways wheel (deltaY 0) is left to the page and does not pause the ride', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  h.step(500);
  let prevented = 0;
  h.listeners.wheel({ deltaX: 80, deltaY: 0, deltaMode: 0, preventDefault: () => prevented++ });
  assert.equal(prevented, 0);
  h.step(3000);
  h.step(6000);
  assert.ok(h.lastP() > 2, `the ride went on: ${h.lastP()}`);
  h.m.destroy();
});

test('trMetro: a label of lower priority never covers the focus orb', () => {
  const nodes = demoNodes();
  const { calls } = frameAt(nodes.length - 1, { sel: nodes.length - 1 });
  // The focus is the Answer station: its floor rings are the 34:24 pair, whose centre is the orb's floor point.
  const ell = calls.filter((c) => c[0] === 'ellipse');
  const wide = ell.find((x) =>
    ell.some((y) => y[1] === x[1] && y[2] === x[2] && Math.abs(x[3] / y[3] - 34 / 24) < 1e-6),
  );
  assert.ok(wide, 'the Answer rings are drawn');
  const kc = wide[3] / 34;
  const orb = { X: wide[1] - 34 * kc, W: 68 * kc, Y: wide[2] - 60 * kc, H: 74 * kc };
  const boxes = labelBoxes(calls);
  const others = boxes.filter((b) => !(b.Y + b.H <= wide[2] - 60 * kc)); // the focus label stands above the orb
  assert.ok(boxes.length > others.length, 'the focus label is drawn above the orb');
  assert.ok(
    others.length === 0 || others.every((b) => !overlap(b, orb)),
    `a label covers the orb: ${JSON.stringify(others)}`,
  );
});

test('trMetro: the pointer moving over the map pauses the ride even without an enter event', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.step(0);
  h.step(500);
  h.listeners.pointermove({ clientX: 1, clientY: 1 });
  h.step(1000);
  const held = h.lastP();
  h.step(6000);
  assert.equal(h.lastP(), held);
  h.m.destroy();
});

test('trMetro: the wheel at either end lets the page scroll; in the middle it is taken', () => {
  const h = harness();
  const nodes = demoNodes();
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.m.tour(false);
  h.step(0);
  let prevented = 0;
  const wheel = (dy) => h.listeners.wheel({ deltaY: dy, deltaMode: 0, preventDefault: () => prevented++ });
  wheel(-100);
  assert.equal(prevented, 0, 'first station, scrolling up');
  wheel(100);
  assert.equal(prevented, 1, 'first station, scrolling down moves the camera');
  wheel(-100);
  assert.equal(prevented, 2, 'in the middle');
  wheel(nodes.length * 300);
  h.step(10);
  assert.equal(h.lastP(), nodes.length - 1);
  const before = prevented;
  wheel(100);
  assert.equal(prevented, before, 'last station, scrolling down');
  wheel(-100);
  assert.equal(prevented, before + 1, 'last station, scrolling up moves the camera');
  h.m.destroy();
});

test('trMetro: the Answer station has a second, wider floor ring', () => {
  const h = harness();
  const nodes = demoNodes();
  const kinds = (c) => c[0] === 'ellipse';
  h.m.setNodes(nodes, nodes.map(part), -1, { restart: true });
  h.m.tour(false);
  h.step(0);
  h.listeners.wheel({ deltaY: (nodes.length - 1) * 300, deltaMode: 0, preventDefault() {} });
  h.calls.length = 0;
  h.step(10);
  const last = nodes[nodes.length - 1];
  assert.equal(last.kind, 'answer');
  // The floor disc is 24*k wide; the extra ring is 34*k, in the same flat ratio.
  const wide = h.calls.filter(kinds).filter((c) => c[3] > 0 && c[5] !== undefined);
  assert.ok(
    wide.some((x) => wide.some((y) => Math.abs(x[3] / y[3] - 34 / 24) < 1e-6)),
    'a 34:24 ring pair',
  );
  h.m.destroy();
});
