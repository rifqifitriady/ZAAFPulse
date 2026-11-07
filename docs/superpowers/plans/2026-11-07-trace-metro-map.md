# Trace Explorer Metro Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Trace Explorer's card-and-wire session map with a 3D metro line on a canvas. The camera rides
the line on its own, and a selection takes over the ride for 10 s.

**Architecture:** A new browser script, `public/tracemetro.js`, has two parts:

- Pure geometry helpers: layout, camera, projection, label window, hit test, time bar and ride clock. They are
  exported for node tests.
- A canvas renderer, `trMetro()`, that owns the frame loop, the ride clock and the pointer, wheel and key handlers.

`public/traceview.js` keeps building nodes with `mapNodes()`. It hands the nodes to the renderer, and it draws the
HUD, the time bar and the screen-reader line in the DOM. The old SVG wire map and its CSS are removed.

**Tech Stack:** Plain browser JS (globals, no modules, no bundler), Canvas 2D, Node ≥18 `node:test`. There are no
runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-07-trace-metro-map-design.md`. The visual reference is
`docs/superpowers/specs/mockups/trace-metro.html`.

## Global Constraints

- Zero runtime dependencies, with no WebGL and no third-party library. The CSP is `script-src 'self'`, so there are
  no CDN scripts and no inline scripts.
- Browser files are plain scripts that share globals. A file's own top-level names use its prefix: `metro…` /
  `METRO_…` / `trMetro` in `tracemetro.js`, and `tr…` in `traceview.js`. A file ends with
  `if (typeof module !== 'undefined') module.exports = {…}` for tests.
- S1: span text never becomes markup. The canvas draws text with `fillText`, and DOM text is set with `textContent`.
  `tracemetro.js` never uses `innerHTML`.
- Prettier printWidth is 120 (`.prettierrc.json`).
  - Run `prettier --write` only on the two new files, `public/tracemetro.js` and `test/trace-metro.test.js`.
  - `public/traceview.js`, `test/trace-ui.test.js` and `public/styles.css` are already not prettier-clean, so
    `--write` would reformat unrelated lines. Never run it on them; hand-format your changes to match the code
    around them.
- Holo decks are dark in both themes. Use `TR_COLOR` hex colours, which `traceview.js` passes in through `parts`.
- The numbers, copied from the spec:
  - station gap 120;
  - S-sway `sin(i × 0.85) × 80`;
  - subagent offset 160, sides alternating;
  - camera 190 behind, 110 up, leaning 55% towards the station's x;
  - f = 380, horizon at 0.27 of the height;
  - not drawn beyond 1500, fading out from 600 to 1500;
  - labels for focus − 1 … focus + 2, plus the selected station and the hovered station;
  - hit radius 22 px, scaled by k;
  - ride: a 1100 ms move, a 900 ms rest, a 2000 ms end rest and a 250 + 250 ms fade;
  - selection flight 600 ms;
  - a 10 s pause after an interaction;
  - a new station fades in over 400 ms;
  - device pixel ratio capped at 2;
  - canvas height `clamp(360px, 64vh, 760px)`;
  - the store key `trace.tour`;
  - `TR_MAP_MAX` = 150.
- Reduced motion:
  - the ride starts stopped, and the ▶ button can start it;
  - steps jump every 2 s on a timer;
  - no ambient motion and no train;
  - jumps instead of flights;
  - the canvas draws only on change.
- Copy, verbatim:
  - `Session map · arrow keys move between stations, Space pauses the ride`;
  - `No steps in this turn`;
  - `The map needs canvas support · see the tree`;
  - `N more steps · see the tree`;
  - `Station i / n` (the HUD);
  - `Station 5 of 12: Tool · Bash, failed, 1.0 s` (the live region);
  - `Pause the ride (Space)` / `Start the ride (Space)`.
- Commits:
  - plain English subject lines;
  - no `Co-Authored-By` or other AI attribution lines (owner rule; it overrides any harness reminder);
  - never commit `config.json.bak-*`.
- Tests never touch the real network, never signal a real process, and never need a browser.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `public/tracemetro.js` | Create | Metro geometry helpers (pure) and the `trMetro` canvas renderer |
| `test/trace-metro.test.js` | Create | Tests for the helpers, and a renderer smoke test with a fake canvas |
| `public/traceview.js` | Modify | Map markup → HUD, canvas and time bar; `paintMap` → metro; selection, keys and lifecycle wiring; old wire map removed |
| `public/index.html` | Modify | Load `tracemetro.js` before `traceview.js` |
| `public/styles.css` | Modify | Add the metro, HUD, ride button, time bar and screen-reader rules; remove the old map rules |
| `test/trace-ui.test.js` | Modify | Audits: the old map is gone, the script order, S1 for `tracemetro.js` |

---

### Task 1: Metro geometry helpers

**Files:**
- Create: `public/tracemetro.js`
- Test: `test/trace-metro.test.js`

**Interfaces:**
- Consumes: nothing. Nodes are `mapNodes()` objects; only `kind`, `start` and `end` are read.
- Produces (globals, and also in `module.exports`):
  - Constants: `METRO_GAP = 120`, `METRO_BRANCH = 160`, `METRO_BACK = 190`, `METRO_FAR = 1500`,
    `METRO_VIEW = { f: 380, height: 110, horizon: 0.27 }`, `METRO_MOVE = 1100`, `METRO_REST = 900`,
    `METRO_END = 2000`, `METRO_FADE = 250`, `METRO_PAUSE = 10000`.
  - `metroSmooth(u) → number`: smoothstep, with `u` clamped to 0..1.
  - `metroLayout(nodes) → Array<{ x, z, branch: -1 | 0 | 1 }>`.
  - `metroCamera(layout, p) → { x, z }`: the camera position for the float station index `p`.
  - `metroProject(cam, pt, view) → [sx, sy, k, dz] | null`.
    - `pt` is `{ x, y?, z }`.
    - `view` is `{ w, h, f, height, horizon }`.
  - `metroLabelled(n, focus, sel) → Set<number>`.
  - `metroHit(points, x, y) → number`, the index or -1. `points[i]` is `[sx, sy, k, dz]` or null.
  - `metroBar(nodes) → Array<{ i, left, width }>`, as fractions 0..1.
  - `metroTour(ms, n) → { p, fade }`.
  - `metroRideAt(k) → number`: the ride time (ms) at which the ride rests at station k.

- [ ] **Step 1: Write the failing tests**

Create `test/trace-metro.test.js`:

```js
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
  assert.deepEqual([...metroLabelled(10, 0, -1)].sort((a, b) => a - b), [0, 1, 2]);
  assert.deepEqual([...metroLabelled(10, 5, -1)].sort((a, b) => a - b), [4, 5, 6, 7]);
  assert.deepEqual([...metroLabelled(10, 9, -1)].sort((a, b) => a - b), [8, 9]);
  assert.deepEqual([...metroLabelled(10, 5, 1)].sort((a, b) => a - b), [1, 4, 5, 6, 7]);
  assert.deepEqual([...metroLabelled(10, 4.6, 99)].sort((a, b) => a - b), [4, 5, 6, 7]);
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/trace-metro.test.js`

Expected: FAIL with `Cannot find module '../public/tracemetro.js'`.

- [ ] **Step 3: Write the helpers**

Create `public/tracemetro.js`:

```js
'use strict';
/* The Trace Explorer's session map as a 3D metro line (spec 2026-11-07-trace-metro-map-design.md): the turn is one
   track running away from the viewer, every map node a station on it, and a camera that rides the line on its own.
   The pure geometry comes first (tested in node); the canvas renderer, trMetro, follows. */

const METRO_GAP = 120; // world units between stations
const METRO_BRANCH = 160; // how far a subagent station sits beside the line
const METRO_BACK = 190; // the camera stands this far behind its focus station
const METRO_FAR = 1500; // stations further away are not drawn
const METRO_VIEW = { f: 380, height: 110, horizon: 0.27 }; // focal length, camera height, horizon (share of height)
// The ride: each move takes 1.1 s and rests 0.9 s; the end rests 2 s, then fades out and in over 0.25 s each.
const METRO_MOVE = 1100;
const METRO_REST = 900;
const METRO_END = 2000;
const METRO_FADE = 250;
const METRO_PAUSE = 10000; // the ride waits this long after a selection, a wheel or a click

const metroSmooth = (u) => {
  const v = Math.max(0, Math.min(1, Number.isFinite(u) ? u : 0));
  return v * v * (3 - 2 * v);
};

// Where each station stands: along the depth axis in node order, swaying gently; a subagent on a side branch,
// alternating sides so two subagents never share one.
function metroLayout(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let side = 1;
  return list.map((n, i) => {
    if (n && n.kind === 'agent') {
      const b = side;
      side = -side;
      return { x: b * METRO_BRANCH, z: i * METRO_GAP, branch: b };
    }
    return { x: Math.sin(i * 0.85) * 80, z: i * METRO_GAP, branch: 0 };
  });
}

// The camera for a float station index: between two stations it moves straight in depth and eases sideways.
function metroCamera(layout, p) {
  if (!Array.isArray(layout) || !layout.length) return { x: 0, z: -METRO_BACK };
  const q = Math.max(0, Math.min(layout.length - 1, Number.isFinite(p) ? p : 0));
  const i = Math.floor(q);
  const j = Math.min(layout.length - 1, i + 1);
  const f = q - i;
  const a = layout[i];
  const b = layout[j];
  return { x: (a.x + (b.x - a.x) * metroSmooth(f)) * 0.55, z: a.z + (b.z - a.z) * f - METRO_BACK };
}

// A world point on screen: [x, y, scale k, depth dz], or null when it is behind the near plane.
function metroProject(cam, pt, view) {
  const dz = pt.z - cam.z;
  if (!(dz >= 25)) return null;
  const k = view.f / dz;
  return [view.w / 2 + (pt.x - cam.x) * k, view.h * view.horizon + (view.height - (pt.y || 0)) * k, k, dz];
}

// The stations that carry a label: the one before the focus, the focus and the two after it, and the selection.
function metroLabelled(n, focus, sel) {
  const out = new Set();
  if (!(n > 0)) return out;
  const f = Math.round(Number.isFinite(focus) ? focus : 0);
  for (let i = f - 1; i <= f + 2; i++) if (i >= 0 && i < n) out.add(i);
  if (Number.isInteger(sel) && sel >= 0 && sel < n) out.add(sel);
  return out;
}

// The station under (x, y): within 22 px scaled by its size; of two overlapping, the one nearer the camera.
function metroHit(points, x, y) {
  let best = -1;
  let bestDz = Infinity;
  (Array.isArray(points) ? points : []).forEach((p, i) => {
    if (!p) return;
    const r = Math.max(10, 22 * Math.min(1.5, p[2]));
    if (Math.hypot(p[0] - x, p[1] - y) <= r && p[3] < bestDz) {
      best = i;
      bestDz = p[3];
    }
  });
  return best;
}

// The time bar: each timed step's place and length as fractions of the steps' time. Session and Turn span it all.
function metroBar(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const steps = [];
  list.forEach((n, i) => {
    if (!n || n.kind === 'session' || n.kind === 'turn') return;
    if (!Number.isFinite(n.start) || !Number.isFinite(n.end) || n.end < n.start) return;
    steps.push({ i, start: n.start, end: n.end });
  });
  if (!steps.length) return [];
  const t0 = Math.min(...steps.map((s) => s.start));
  const span = Math.max(...steps.map((s) => s.end)) - t0;
  return steps.map((s) =>
    span > 0 ? { i: s.i, left: (s.start - t0) / span, width: (s.end - s.start) / span } : { i: s.i, left: 0, width: 0 },
  );
}

// The ride as a pure function of its elapsed time: the camera's float station index and the restart fade (0..1).
function metroTour(ms, n) {
  if (!(n > 1)) return { p: 0, fade: 0 };
  const step = METRO_MOVE + METRO_REST;
  const run = (n - 1) * step;
  const total = run + METRO_END + 2 * METRO_FADE;
  const t = (Number.isFinite(ms) && ms > 0 ? ms : 0) % total;
  if (t < run) {
    const k = Math.floor(t / step);
    const u = t - k * step;
    return { p: u < METRO_MOVE ? k + metroSmooth(u / METRO_MOVE) : k + 1, fade: 0 };
  }
  const e = t - run;
  if (e < METRO_END) return { p: n - 1, fade: 0 };
  if (e < METRO_END + METRO_FADE) return { p: n - 1, fade: (e - METRO_END) / METRO_FADE };
  return { p: 0, fade: 1 - (e - METRO_END - METRO_FADE) / METRO_FADE };
}

// The ride time at which the camera has just arrived at station k: the ride resumes from there.
const metroRideAt = (k) => (k > 0 ? (k - 1) * (METRO_MOVE + METRO_REST) + METRO_MOVE : 0);

if (typeof module !== 'undefined')
  module.exports = {
    METRO_GAP,
    METRO_BRANCH,
    METRO_BACK,
    METRO_FAR,
    METRO_VIEW,
    METRO_MOVE,
    METRO_REST,
    METRO_END,
    METRO_FADE,
    METRO_PAUSE,
    metroSmooth,
    metroLayout,
    metroCamera,
    metroProject,
    metroLabelled,
    metroHit,
    metroBar,
    metroTour,
    metroRideAt,
  };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/trace-metro.test.js`

Expected: PASS, with all 13 tests green.

Then run the whole suite: `npm test`. Expected: PASS, 0 failures.

- [ ] **Step 5: Format and commit**

```bash
npx --yes prettier@3 --check public/tracemetro.js test/trace-metro.test.js || npx --yes prettier@3 --write public/tracemetro.js test/trace-metro.test.js
git add public/tracemetro.js test/trace-metro.test.js
git commit -m "Trace map: metro geometry helpers (layout, camera, projection, labels, hit test, time bar, ride clock)"
```

---

### Task 2: The `trMetro` canvas renderer

**Files:**
- Modify: `public/tracemetro.js`. Insert the renderer above the `if (typeof module !== 'undefined')` line, and add
  `trMetro` to `module.exports`.
- Test: `test/trace-metro.test.js` (append).

**Interfaces:**
- Consumes: every helper and constant from Task 1.
- Produces: `trMetro(canvas, opts) → api | null`, which is null when `canvas.getContext('2d')` gives nothing.
  - `opts`:
    - `onPick(i)`: a station was clicked, or picked with ←/→/Home/End.
    - `onFrame(p)`: called after every frame with the camera's float station index.
    - `onToggle()`: Space was pressed on the canvas.
    - `onEnter()`: Enter was pressed on the canvas.
    - `clock()`: returns ms. It defaults to `performance.now()` and is injected by the tests.
  - `api`:
    - `setNodes(nodes, parts, sel, { restart })`. `parts[i]` is
      `{ color, title, meta, dur, cost, err, loop, evalFail, preview }`, where `color` is a hex string, `dur` and
      `cost` are display strings (possibly `''`) and `loop` is the node's `count`.
    - `setPreview(text)`.
    - `select(i, { fly })`.
    - `tour(on)`.
    - `show(on)`.
    - `destroy()`.

- [ ] **Step 1: Write the failing renderer tests**

Append to `test/trace-metro.test.js`:

```js
// ---- the renderer, on a fake canvas: no browser, a hand-driven clock and frame queue ----
const { trMetro, metroProject: project, metroCamera: camera, metroLayout: layout } = require('../public/tracemetro.js');

function fakeCanvas({ ctx = true } = {}) {
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
      return true;
    },
  });
  const listeners = {};
  const canvas = {
    clientWidth: 600,
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
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
  };
  return { canvas, calls, listeners };
}

function harness(opts = {}) {
  const queue = [];
  global.requestAnimationFrame = (fn) => queue.push(fn);
  global.cancelAnimationFrame = () => {};
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
    fns.forEach((f) => f());
  };
  const lastP = () => seen.frames[seen.frames.length - 1];
  return { m, step, seen, lastP, queue, ...fake };
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
  assert.ok(h.calls.some((c) => c[0] === 'fillText'), 'labels are drawn with fillText');
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
  const g = project(camera(lay, 1), { x: lay[1].x, y: 0, z: lay[1].z }, { w: 600, h: 400, f: 380, height: 110, horizon: 0.27 });
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/trace-metro.test.js`

Expected: FAIL. `trMetro` is not a function: the destructured `trMetro` is `undefined`.

- [ ] **Step 3: Write the renderer**

In `public/tracemetro.js`, insert this block directly above `if (typeof module !== 'undefined')`:

```js
// The renderer: draws the line on `canvas` and rides it. Null without a 2D context.
// opts.onPick(i): a station was clicked, or picked with ←/→/Home/End. opts.onFrame(p): the camera's float station
// index after each frame. opts.onToggle(): Space on the canvas. opts.onEnter(): Enter on the canvas.
// opts.clock(): milliseconds (performance.now by default; the tests drive it by hand).
function trMetro(canvas, opts = {}) {
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) return null;
  const noop = () => {};
  const onPick = opts.onPick || noop;
  const onFrame = opts.onFrame || noop;
  const onToggle = opts.onToggle || noop;
  const onEnter = opts.onEnter || noop;
  const now = opts.clock || (() => performance.now());
  const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const still = () => !!(motion && motion.matches);
  const hidden = () => typeof document !== 'undefined' && document.hidden;
  const PINK = '#ff4fd8';
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const st = {
    alive: true,
    shown: true,
    ride: true,
    nodes: [],
    parts: [],
    lay: [],
    born: [],
    sel: -1,
    hover: -1,
    inside: false,
    hold: 0, // where the camera stands while the ride does not move it
    fly: null, // { from, to, t0, ms }
    until: 0, // the ride waits until this time
    riding: false,
    t0: now(), // the ride clock's origin
    raf: 0,
    tick: 0,
    W: 0,
    H: 0,
    last: '',
    pts: [],
    boxes: [],
  };
  const offs = [];

  const rgba = (hex, a) => {
    const n = parseInt(String(hex).slice(1, 7), 16) || 0;
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  };
  const fit = (s, max) => {
    let t = String(s || '');
    if (ctx.measureText(t).width <= max) return t;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
    return `${t}…`;
  };
  const rrect = (X, Y, W, H, r) => {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(X, Y, W, H, r);
    else ctx.rect(X, Y, W, H);
  };

  function kick() {
    if (!st.alive || !st.shown || st.raf || hidden()) return;
    st.raf = requestAnimationFrame(frame);
  }

  // Where the camera is now: a flight, the ride, or a rest at `hold`.
  function cameraAt(t) {
    const n = st.nodes.length;
    if (st.fly) {
      const u = still() ? 1 : (t - st.fly.t0) / st.fly.ms;
      if (u < 1) return { p: st.fly.from + (st.fly.to - st.fly.from) * metroSmooth(u), fade: 0, moving: true };
      st.hold = st.fly.to;
      st.fly = null;
    }
    const free = st.ride && n > 1 && t >= st.until && !st.inside;
    if (free && !st.riding) st.t0 = t - metroRideAt(Math.round(st.hold)); // resume from where the camera stands
    st.riding = free;
    if (!free) return { p: st.hold, fade: 0, moving: false };
    const r = metroTour(t - st.t0, n);
    const p = still() ? Math.round(r.p) : r.p;
    st.hold = p;
    return { p, fade: still() ? 0 : r.fade, moving: p !== Math.round(p) };
  }

  function size() {
    const w = canvas.clientWidth || 0;
    const h = canvas.clientHeight || 0;
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    if (w !== st.W || h !== st.H || canvas.width !== Math.round(w * dpr)) {
      st.W = w;
      st.H = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame() {
    st.raf = 0;
    if (!st.alive || !st.shown) return;
    const t = now();
    size();
    const cam = cameraAt(t);
    const calm = still();
    const key = `${cam.p}|${st.sel}|${st.hover}|${st.W}x${st.H}`;
    if (!calm || key !== st.last) {
      draw(t, cam);
      st.last = key;
    }
    onFrame(cam.p);
    if (!calm) kick();
    else if (st.ride && st.nodes.length > 1) {
      clearTimeout(st.tick);
      st.tick = setTimeout(kick, 250);
    }
  }

  function label(i, at, sc, side, alpha, isF) {
    const part = st.parts[i] || {};
    const col = part.color || '#8f98cc';
    const W = 212 * sc;
    const H = 50 * sc;
    const X = side === 0 ? at[0] - W / 2 : side > 0 ? at[0] - 12 * sc : at[0] - W + 12 * sc;
    const Y = at[1] - H;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = isF ? 'rgba(26,30,76,.97)' : 'rgba(20,24,60,.9)';
    ctx.strokeStyle = i === st.sel ? 'rgba(255,255,255,.95)' : rgba(col, isF ? 0.95 : 0.5);
    ctx.lineWidth = i === st.sel || isF ? 1.6 : 1;
    rrect(X, Y, W, H, 9 * sc);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillRect(X + 1, Y + 6 * sc, 3 * sc, H - 12 * sc);
    const pad = 13 * sc;
    ctx.font = `${(11 * sc).toFixed(1)}px ${FONT}`;
    const rw = Math.max(ctx.measureText(part.dur || '').width, ctx.measureText(part.cost || '').width);
    ctx.textAlign = 'right';
    ctx.fillStyle = rgba(col, 0.95);
    if (part.dur) ctx.fillText(part.dur, X + W - 11 * sc, Y + 21 * sc);
    if (part.cost) ctx.fillText(part.cost, X + W - 11 * sc, Y + 38 * sc);
    ctx.textAlign = 'left';
    const room = W - pad - rw - 22 * sc;
    const pv = String(part.preview || '');
    const line2 = pv ? (pv.length > 48 ? `${pv.slice(0, 47)}…` : pv) : part.meta || ''; // the prompt: 48 characters
    ctx.fillStyle = '#a9aee0';
    ctx.fillText(fit(line2, room), X + pad, Y + 38 * sc);
    ctx.font = `600 ${(13.5 * sc).toFixed(1)}px ${FONT}`;
    ctx.fillStyle = '#eef0ff';
    const mark = part.err ? '✕ ' : part.loop > 1 ? '↻ ' : '';
    ctx.fillText(fit(mark + (part.title || ''), room), X + pad, Y + 21 * sc);
    if (part.evalFail) {
      ctx.fillStyle = '#ff5a6e';
      ctx.beginPath();
      ctx.arc(X + W - 6 * sc, Y + 6 * sc, 3.5 * sc, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    st.boxes.push([X, Y, W, H, i]);
  }

  function draw(t, cam) {
    const w = st.W;
    const h = st.H;
    const s = t / 1000;
    const calm = still();
    ctx.clearRect(0, 0, w, h);
    st.pts = [];
    st.boxes = [];
    if (!w || !h) return;
    const n = st.nodes.length;
    if (!n) {
      ctx.fillStyle = '#8f98cc';
      ctx.font = `13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('No steps in this turn', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const c = metroCamera(st.lay, cam.p);
    const view = { w, h, f: METRO_VIEW.f, height: METRO_VIEW.height, horizon: METRO_VIEW.horizon };
    const pr = (px, py, pz) => metroProject(c, { x: px, y: py, z: pz }, view);
    const hor = h * view.horizon;

    // The haze at the horizon and the floor grid, fading with distance.
    const hz = ctx.createLinearGradient(0, hor - 40, 0, hor + 60);
    hz.addColorStop(0, 'rgba(120,110,255,0)');
    hz.addColorStop(0.5, 'rgba(120,110,255,.10)');
    hz.addColorStop(1, 'rgba(120,110,255,0)');
    ctx.fillStyle = hz;
    ctx.fillRect(0, hor - 40, w, 100);
    ctx.lineWidth = 1;
    for (let gx = -560; gx <= 560; gx += 80) {
      const a = pr(gx, 0, c.z + 30);
      const b = pr(gx, 0, c.z + METRO_FAR);
      if (!a || !b) continue;
      const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
      g.addColorStop(0, 'rgba(130,140,255,.16)');
      g.addColorStop(1, 'rgba(130,140,255,0)');
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    for (let gz = Math.ceil((c.z + 30) / METRO_GAP) * METRO_GAP; gz < c.z + METRO_FAR; gz += METRO_GAP) {
      const a = pr(-560, 0, gz);
      const b = pr(560, 0, gz);
      if (!a || !b) continue;
      ctx.strokeStyle = `rgba(130,140,255,${(0.13 * Math.min(1, a[2] * 1.4)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }

    // The track: travelled bright with a slow light wave, ahead dim; a subagent's branch and the bypass in pink.
    const seen = (z) => z - c.z > -METRO_GAP && z - c.z < METRO_FAR + METRO_GAP;
    const track = (A0, B0, color, alpha, dash, glow) => {
      if (!seen(A0.z) && !seen(B0.z)) return;
      ctx.setLineDash(dash || []);
      ctx.shadowColor = glow ? color : 'transparent';
      ctx.shadowBlur = glow ? 10 : 0;
      for (let k = 0; k < 16; k++) {
        const u0 = k / 16;
        const u1 = (k + 1) / 16;
        const A = pr(A0.x + (B0.x - A0.x) * metroSmooth(u0), 0, A0.z + (B0.z - A0.z) * u0);
        const B = pr(A0.x + (B0.x - A0.x) * metroSmooth(u1), 0, A0.z + (B0.z - A0.z) * u1);
        if (!A || !B) continue;
        const wave = glow && !calm ? 0.8 + 0.2 * Math.sin(s * 3 - A[3] / 90) : 1;
        ctx.strokeStyle = rgba(color, alpha * wave * Math.min(1, A[2] * 1.5));
        ctx.lineWidth = Math.max(1.2, 7 * A[2]);
        ctx.beginPath();
        ctx.moveTo(A[0], A[1]);
        ctx.lineTo(B[0], B[1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    };
    for (let i = 1; i < n - 1; i++)
      if (st.lay[i].branch) track(st.lay[i - 1], st.lay[i + 1], PINK, 0.3, [6, 9], false);
    for (let i = 0; i < n - 1; i++) {
      const done = i + 1 <= cam.p + 1e-6;
      const branch = st.lay[i].branch || st.lay[i + 1].branch;
      track(st.lay[i], st.lay[i + 1], branch ? PINK : done ? '#c7c2ff' : '#7c83ff', done ? 0.9 : 0.35, null, done);
    }

    // The stations, far to near, each with its floor disc, rings, pillar, orb and (near the camera) its label.
    const focus = Math.round(cam.p);
    const labelled = metroLabelled(n, focus, st.sel);
    if (st.hover >= 0) labelled.add(st.hover);
    const order = st.nodes.map((_, i) => i).sort((a, b) => st.lay[b].z - st.lay[a].z);
    for (const i of order) {
      const L = st.lay[i];
      const part = st.parts[i] || {};
      const col = part.color || '#8f98cc';
      const kind = st.nodes[i] && st.nodes[i].kind;
      const g = pr(L.x, 0, L.z);
      if (!g) continue;
      const k = g[2];
      const born = st.born[i] ? Math.min(1, (t - st.born[i]) / 400) : 1;
      const fade = Math.max(0, Math.min(1, (METRO_FAR - g[3]) / 900)) * born;
      if (fade <= 0) continue;
      st.pts[i] = g;
      const isF = i === focus;
      ctx.globalAlpha = fade;
      const rx = (kind === 'session' ? 40 : 24) * k;
      ctx.fillStyle = rgba(col, isF ? 0.5 : 0.25);
      ctx.beginPath();
      ctx.ellipse(g[0], g[1], rx, rx * 0.31, 0, 0, Math.PI * 2);
      ctx.fill();
      if (i === st.sel) {
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(g[0], g[1], rx + 8 * k, (rx + 8 * k) * 0.31, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (part.err) {
        const ph = calm ? 0.35 : (s % 1.3) / 1.3;
        ctx.strokeStyle = rgba(col, (1 - ph) * 0.9);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(g[0], g[1], (24 + ph * 70) * k, (7.5 + ph * 22) * k, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (part.loop > 1) {
        ctx.strokeStyle = rgba(col, 0.95);
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = calm ? 0 : -s * 30;
        ctx.beginPath();
        ctx.ellipse(g[0], g[1], 36 * k, 11 * k, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
      if (kind === 'turn') {
        // The gate the track passes under.
        const a = pr(L.x - 44, 0, L.z);
        const b = pr(L.x + 44, 0, L.z);
        const ta = pr(L.x - 44, 76, L.z);
        const tb = pr(L.x + 44, 76, L.z);
        if (a && b && ta && tb) {
          ctx.strokeStyle = rgba(col, 0.8);
          ctx.lineWidth = Math.max(1.5, 3 * k);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(ta[0], ta[1]);
          ctx.quadraticCurveTo((ta[0] + tb[0]) / 2, ta[1] - 26 * k, tb[0], tb[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        }
      }
      const top = pr(L.x, 56, L.z);
      if (top) {
        const pg = ctx.createLinearGradient(g[0], g[1], top[0], top[1]);
        pg.addColorStop(0, rgba(col, 0.9));
        pg.addColorStop(1, rgba(col, 0));
        ctx.strokeStyle = pg;
        ctx.lineWidth = Math.max(1.5, 3 * k);
        ctx.beginPath();
        ctx.moveTo(g[0], g[1]);
        ctx.lineTo(top[0], top[1]);
        ctx.stroke();
      }
      const pulse = part.err && !calm ? 1 + 0.15 * Math.sin(s * 6) : 1;
      ctx.shadowColor = col;
      ctx.shadowBlur = calm ? 0 : isF ? 26 : 12;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(g[0], g[1] - 4 * k, (isF ? 9 : 6) * k * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      if (labelled.has(i)) {
        const at = pr(L.x, 64, L.z);
        if (at) {
          const sc = Math.max(0.55, Math.min(1.1, k * 0.95)) * (isF ? 1.1 : 1);
          const side = isF ? 0 : L.x >= c.x ? 1 : -1;
          label(i, at, sc, side, fade * (isF ? 1 : i === focus - 1 ? 0.5 : 0.8), isF);
        }
      }
    }

    // The train between two stations, and the fade of the ride's restart.
    if (cam.moving && !calm) {
      const i0 = Math.max(0, Math.min(n - 1, Math.floor(cam.p)));
      const i1 = Math.min(n - 1, i0 + 1);
      const f = cam.p - i0;
      const A = st.lay[i0];
      const B = st.lay[i1];
      const g = pr(A.x + (B.x - A.x) * metroSmooth(f), 6, A.z + (B.z - A.z) * f);
      if (g) {
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 22;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(g[0], g[1], 5 * g[2], 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    if (cam.fade > 0) {
      ctx.fillStyle = `rgba(7,10,31,${cam.fade.toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // Pointer, wheel and keys.
  const on = (target, type, fn, opt) => {
    target.addEventListener(type, fn, opt);
    offs.push(() => target.removeEventListener(type, fn, opt));
  };
  const pointAt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const hitAt = ([px, py]) => {
    for (let j = st.boxes.length - 1; j >= 0; j--) {
      const [X, Y, W, H, i] = st.boxes[j];
      if (px >= X && px <= X + W && py >= Y && py <= Y + H) return i;
    }
    return metroHit(st.pts, px, py);
  };
  on(canvas, 'pointerenter', () => {
    st.inside = true;
  });
  on(canvas, 'pointerleave', () => {
    st.inside = false;
    st.hover = -1;
    canvas.style.cursor = '';
    kick();
  });
  on(canvas, 'pointermove', (e) => {
    const i = hitAt(pointAt(e));
    if (i === st.hover) return;
    st.hover = i;
    canvas.style.cursor = i >= 0 ? 'pointer' : '';
    kick();
  });
  on(canvas, 'click', (e) => {
    const i = hitAt(pointAt(e));
    if (i >= 0) onPick(i);
  });
  on(
    canvas,
    'wheel',
    (e) => {
      if (!st.nodes.length) return;
      e.preventDefault();
      const t = now();
      st.hold = Math.max(0, Math.min(st.nodes.length - 1, cameraAt(t).p + e.deltaY / 300));
      st.fly = null;
      st.riding = false;
      st.until = t + METRO_PAUSE;
      kick();
    },
    { passive: false },
  );
  on(canvas, 'keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = st.nodes.length;
    const cur = st.sel >= 0 ? st.sel : Math.round(st.hold);
    let to = -1;
    if (e.key === 'ArrowLeft') to = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') to = Math.min(n - 1, cur + 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.key === ' ') onToggle();
      else onEnter();
      return;
    } else return;
    e.preventDefault(); // also keeps ←/→ from stepping the turn
    if (n && to >= 0) onPick(to);
  });
  if (typeof document !== 'undefined')
    on(document, 'visibilitychange', () => {
      st.last = '';
      kick();
    });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      st.last = '';
      kick();
    });
    ro.observe(canvas);
    offs.push(() => ro.disconnect());
  }

  return {
    // A new node list. restart: a new turn or session, so the ride starts again at the first station; otherwise the
    // camera and the ride keep their place and stations added at the end fade in.
    setNodes(nodes, parts, sel, { restart = false } = {}) {
      const t = now();
      const prev = st.nodes.length;
      st.nodes = Array.isArray(nodes) ? nodes : [];
      st.parts = Array.isArray(parts) ? parts : [];
      st.lay = metroLayout(st.nodes);
      st.born = st.nodes.map((_, i) => (restart || i < prev ? 0 : t));
      st.sel = Number.isInteger(sel) && sel >= 0 && sel < st.nodes.length ? sel : -1;
      st.hover = -1;
      if (restart) {
        st.fly = null;
        st.hold = 0;
        st.until = 0;
        st.riding = false;
      } else st.hold = Math.min(st.hold, Math.max(0, st.nodes.length - 1));
      if (!st.ride && st.sel >= 0) st.hold = st.sel;
      st.last = '';
      kick();
    },
    // The turn's prompt preview, which arrives after the nodes.
    setPreview(text) {
      const i = st.nodes.findIndex((n) => n && n.kind === 'turn');
      if (i < 0 || !st.parts[i]) return;
      st.parts[i] = { ...st.parts[i], preview: String(text || '') };
      st.last = '';
      kick();
    },
    // The selection. fly: the camera flies there and the ride waits 10 s; without it the station is only marked.
    select(i, { fly = false } = {}) {
      st.sel = Number.isInteger(i) && i >= 0 && i < st.nodes.length ? i : -1;
      if ((fly || !st.ride) && st.sel >= 0) {
        const t = now();
        st.fly = { from: cameraAt(t).p, to: st.sel, t0: t, ms: 600 };
        st.riding = false;
        if (fly) st.until = t + METRO_PAUSE;
      }
      st.last = '';
      kick();
    },
    // The ride on or off. Off, the camera goes to the selection and follows it only.
    tour(on) {
      st.ride = !!on;
      st.riding = false;
      if (!st.ride && st.sel >= 0) {
        const t = now();
        st.fly = { from: cameraAt(t).p, to: st.sel, t0: t, ms: 600 };
      }
      st.last = '';
      kick();
    },
    show(on) {
      st.shown = !!on;
      st.last = '';
      if (!st.shown && st.raf) {
        cancelAnimationFrame(st.raf);
        st.raf = 0;
      }
      kick();
    },
    destroy() {
      st.alive = false;
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
      clearTimeout(st.tick);
      offs.forEach((f) => f());
    },
  };
}
```

Then add `trMetro,` as the last entry of the `module.exports` object.

**Notes for the implementer:**

- `tour(false)` while a selection exists starts a 600 ms flight to it. The test "a stopped ride stays put" relies
  on that: it calls `tour(false)` before the first frame, with `sel = 2` from `setNodes`.
- In that test the flight goes from 0 to 2 between clock 0 and 600, so `p` is 2 at 700 ms.
- In `cameraAt`, `st.inside` pauses the ride while the pointer is over the canvas. When it clears, `riding` flips
  and the ride resumes from `round(hold)`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/trace-metro.test.js`

Expected: PASS, with all 21 tests green.

If "a click on a station picks it" fails, a nearer label box probably covers the floor point. Print `h.seen.picks` to
check. Labels stand above the pillar (y = 64), so the floor point should be clear; fix the geometry, not the test.

Run the whole suite with `npm test`. Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx --yes prettier@3 --check public/tracemetro.js test/trace-metro.test.js || npx --yes prettier@3 --write public/tracemetro.js test/trace-metro.test.js
node --test test/trace-metro.test.js
git add public/tracemetro.js test/trace-metro.test.js
git commit -m "Trace map: the metro canvas renderer that rides the line on its own"
```

---

### Task 3: Wire the metro into the Trace Explorer and remove the old map

**Files:**
- Modify: `public/traceview.js`. Line numbers are as of commit `fe034ae`.
  - `viewTrace()`: map markup at line 629.
  - `mountTrace()`: state at about line 702.
  - `txt` at line 746.
  - `clearTurn` at about line 1034.
  - `fillPreviews` at about line 1091.
  - `showView` at about line 1177.
  - `paintMap` / `drawWires` / `queueWires` at about lines 1347–1437.
  - `pickSelection` / `select` / `scrollNode` at about lines 1450–1507.
  - The click delegate at about line 2135.
  - `onKey` at about line 2197.
  - The ResizeObserver and `onUnmount` at about lines 2265–2289.
- Modify: `public/index.html`, line 150.
- Modify: `public/styles.css`. The map rules sit at about lines 6159–6170 and 6259–6452, plus the narrow media
  block at about lines 6578–6589.
- Test: `test/trace-ui.test.js` (append).

**Interfaces:**
- Consumes: `trMetro`, `metroBar` (globals from `tracemetro.js`), and `mapNodes`, `nodeParts`, `spanEvalBadges`,
  `trNodeIndex`, `TR_COLOR`, `trOwn`, `fmtDur`, `trUsd`, `trReduce` and `store` (existing).
- Produces: in `mountTrace` scope, `metro`, `paintBar()`, `markBar(ni)`, `paintHud(p)`, `stationLine(i)`,
  `announce(ni)`, `pickNode(i)`, `setRide(on)`, `paintRide()` and `metroPart(n, i)`. `select(id, { scroll, force, auto })`
  gains `auto`.

- [ ] **Step 1: Write the failing audit tests**

Append to `test/trace-ui.test.js`:

```js
test('the session map is the metro line: no cards, notes or SVG wires remain', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  for (const gone of ['drawWires', 'queueWires', 'scrollNode', 'tr-wires', "'.tr-node'", 'tr-note ', 'tr-gap']) {
    assert.ok(!src.includes(gone), `traceview.js still has ${gone}`);
  }
  assert.match(src, /trMetro\(\$\('#tr-metro'\)/);
  assert.match(src, /role="group" aria-label="Session map · arrow keys move between stations, Space pauses the ride"/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  for (const gone of ['.tr-node', '.tr-note.l', '.tr-gap', 'svg.tr-wires', '.tr-packet', '@keyframes tr-flow', '.tr-nev'])
    assert.ok(!css.includes(gone), `styles.css still has ${gone}`);
  for (const added of ['.tr-metro', '.tr-hud', '.tr-bar', '.tr-ride', '.tr-sr']) assert.ok(css.includes(added), added);
});

test('index.html loads tracemetro.js before traceview.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const a = html.indexOf('<script src="tracemetro.js"></script>');
  const b = html.indexOf('<script src="traceview.js"></script>');
  assert.ok(a > 0 && b > a, 'tracemetro.js comes first');
});

test('tracemetro.js builds no HTML at all (S1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'tracemetro.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/trace-ui.test.js`

Expected: FAIL on the first two new tests: `traceview.js still has drawWires`, and `tracemetro.js comes first`. The
third passes already.

- [ ] **Step 3: Load the script**

In `public/index.html`, change line 150 from

```html
  <script src="traceview.js"></script>
```

to

```html
  <script src="tracemetro.js"></script>
  <script src="traceview.js"></script>
```

- [ ] **Step 4: Replace the map markup**

In `viewTrace()` in `public/traceview.js`, replace this line:

```js
    <div class="tr-map" id="tr-map"><svg class="tr-wires" id="tr-wires" aria-hidden="true"></svg></div>
```

with:

```js
    <div class="tr-map" id="tr-map">
      <div class="tr-metro">
        <canvas id="tr-metro" tabindex="0" role="group" aria-label="Session map · arrow keys move between stations, Space pauses the ride"></canvas>
        <div class="tr-hud" aria-hidden="true"><div class="tr-hud-t" id="tr-hud-t"></div><div class="tr-hud-s" id="tr-hud-s"></div><div class="tr-hud-more" id="tr-hud-more" hidden></div></div>
        <button type="button" class="tr-icon-btn tr-ride" id="tr-ride" aria-label="Pause the ride" title="Pause the ride (Space)">⏸</button>
      </div>
      <div class="tr-bar" id="tr-bar" aria-hidden="true"></div>
      <div class="tr-sr" id="tr-live" aria-live="polite"></div>
    </div>
```

- [ ] **Step 5: State, the `metro` handle and `clearTurn`**

In the `const S = {` object in `mountTrace()`, directly after `nodeOf: new Map(),`, add:

```js
    metroKey: null, // the session and turn the metro shows: a new one restarts the ride
    ride: false, // whether the camera rides the line on its own
    hudAt: -1, // the station the HUD shows
    barAt: [], // each station's place on the time bar, 0..1
```

Directly after `const txt = $('#tr-txt');`, add:

```js
  let metro = null; // the session map's renderer (tracemetro.js); null without canvas support
```

In `clearTurn`, replace

```js
    $('#tr-map').replaceChildren($('#tr-wires') || document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
```

with

```js
    if (metro) metro.setNodes([], [], -1, { restart: true });
    S.metroKey = null;
    S.barAt = [];
    S.hudAt = -1;
    $('#tr-bar').replaceChildren();
    $('#tr-hud-t').textContent = '';
    $('#tr-hud-s').textContent = '';
    $('#tr-hud-more').hidden = true;
```

- [ ] **Step 6: The turn preview reaches the metro**

Replace the body of `fillPreviews`:

```js
  const fillPreviews = () => {
    for (const el of $$('[data-tpreview]', app)) {
      el.textContent = S.preview ? `${el.dataset.tpreview === 'row' ? ' · ' : ''}${S.preview}` : '';
      if (S.preview && el.dataset.tpreview === 'node') el.classList.add('has');
    }
  };
```

with:

```js
  const fillPreviews = () => {
    for (const el of $$('[data-tpreview]', app))
      el.textContent = S.preview ? `${el.dataset.tpreview === 'row' ? ' · ' : ''}${S.preview}` : '';
    if (metro) metro.setPreview(S.preview || '');
    S.hudAt = -1; // the HUD's turn line carries the preview
  };
```

- [ ] **Step 7: `showView` tells the metro**

In `showView`, directly after `$('#tr-deps').hidden = S.view !== 'deps';`, add:

```js
    if (metro) metro.show(S.view === 'map');
```

- [ ] **Step 8: Replace `paintMap`, `drawWires` and `queueWires`**

Delete everything from `  function paintMap() {` through the end of `queueWires`, which is the line `  };` after
`if (!S.frame) S.frame = requestAnimationFrame(drawWires);`. That includes the comment above `drawWires`. Put this
in its place:

```js
  // The session map: the turn's nodes as stations on the metro line (tracemetro.js), the time bar under it, and
  // the HUD. A new session or turn restarts the ride; a live repaint keeps the camera where it is.
  function paintMap() {
    const all = mapNodes(S.sk.spans);
    const nodes = all.slice(0, TR_MAP_MAX);
    S.nodes = nodes;
    S.nodeOf = new Map();
    nodes.forEach((n, i) => n.ids.forEach((id) => S.nodeOf.set(id, i)));
    const more = $('#tr-hud-more');
    more.hidden = all.length <= nodes.length;
    more.textContent = more.hidden ? '' : `${all.length - nodes.length} more steps · see the tree`;
    paintBar();
    S.hudAt = -1;
    if (!metro) return;
    const key = `${S.skKey}|${S.turn}`;
    metro.setNodes(nodes, nodes.map(metroPart), trNodeIndex(S.sel), { restart: key !== S.metroKey });
    S.metroKey = key;
  }
  // What a station's label says, from the same facts the old map node showed.
  function metroPart(n, i) {
    const p = nodeParts(n, i);
    const err = n.status === 'error';
    return {
      color: err ? TR_COLOR.error : trOwn(TR_COLOR, n.kind, TR_COLOR.unknown),
      title: p.title,
      meta: p.meta || '',
      dur: Number.isFinite(n.start) && Number.isFinite(n.end) ? fmtDur(n.end - n.start) : '',
      cost: Number.isFinite(n.cost) && n.cost > 0 ? trUsd(n.cost) : '',
      err,
      loop: n.count,
      evalFail: spanEvalBadges(n, S.turnEv, S.evs).some((b) => b.tone === 'bad'),
      preview: n.kind === 'turn' ? S.preview || '' : '',
    };
  }
  // The time bar: one segment per timed step, a marker that moves with the camera, the selection outlined.
  function paintBar() {
    const bar = $('#tr-bar');
    const segs = metroBar(S.nodes);
    const frag = document.createDocumentFragment();
    const at = new Array(S.nodes.length).fill(null);
    for (const s of segs) {
      const n = S.nodes[s.i];
      at[s.i] = s.left;
      const el = document.createElement('span');
      el.dataset.tbar = String(s.i);
      el.style.left = `${(s.left * 100).toFixed(3)}%`;
      el.style.width = `${(s.width * 100).toFixed(3)}%`;
      el.style.background = n.status === 'error' ? TR_COLOR.error : trOwn(TR_COLOR, n.kind, TR_COLOR.unknown);
      frag.appendChild(el);
    }
    let last = 0;
    S.barAt = at.map((v) => (v == null ? last : (last = v)));
    const mark = document.createElement('i');
    mark.id = 'tr-bar-mark';
    frag.appendChild(mark);
    bar.replaceChildren(frag);
    markBar(trNodeIndex(S.sel));
  }
  function markBar(ni) {
    for (const el of $$('[data-tbar]', $('#tr-bar'))) el.classList.toggle('on', Number(el.dataset.tbar) === ni);
  }
  // After each metro frame: the time bar's marker follows the camera; the HUD names the station it stands at.
  function paintHud(p) {
    const at = S.barAt;
    if (at.length) {
      const i0 = Math.max(0, Math.min(at.length - 1, Math.floor(p)));
      const i1 = Math.min(at.length - 1, i0 + 1);
      const mark = $('#tr-bar-mark');
      if (mark) mark.style.left = `${((at[i0] + (at[i1] - at[i0]) * (p - i0)) * 100).toFixed(2)}%`;
    }
    const i = Math.round(p);
    if (i === S.hudAt) return;
    S.hudAt = i;
    $('#tr-hud-t').textContent = `Turn ${S.turn + 1}${S.preview ? ` · ${S.preview}` : ''}`;
    $('#tr-hud-s').textContent = S.nodes[i] ? stationLine(i) : '';
  }
  // "Station 4 / 12 · 9.2 s · $0.10": the time since the turn began and the cost of the steps so far.
  function stationLine(i) {
    const nodes = S.nodes;
    const out = [`Station ${i + 1} / ${nodes.length}`];
    const n = nodes[i];
    if (n.kind === 'session' || n.kind === 'turn') return out.join(' · ');
    const turn = nodes.find((x) => x.kind === 'turn');
    const t0 = turn && Number.isFinite(turn.start) ? turn.start : null;
    const end = Number.isFinite(n.end) ? n.end : n.start;
    if (t0 != null && Number.isFinite(end) && end >= t0) out.push(fmtDur(end - t0));
    let cost = 0;
    for (let k = 0; k <= i; k++) {
      const x = nodes[k];
      if (x.kind !== 'session' && x.kind !== 'turn' && Number.isFinite(x.cost)) cost += x.cost;
    }
    if (cost > 0) out.push(trUsd(cost));
    return out.join(' · ');
  }
  // The screen-reader line: selections only, never the ride's steps.
  function announce(ni) {
    const n = S.nodes[ni];
    if (!n) return;
    const p = nodeParts(n, ni);
    const d = Number.isFinite(n.start) && Number.isFinite(n.end) ? fmtDur(n.end - n.start) : '';
    const facts = [p.title, n.status === 'error' ? 'failed' : '', d].filter(Boolean).join(', ');
    $('#tr-live').textContent = `Station ${ni + 1} of ${S.nodes.length}: ${facts}`;
  }
  // A station picked on the map (click, ←/→, Home/End) or on the time bar selects its span.
  function pickNode(i) {
    const n = S.nodes[i];
    if (n) select(n.id, { scroll: 'tree' });
  }
  function setRide(on) {
    S.ride = !!on;
    if (metro) metro.tour(S.ride);
    if (!trReduce()) store.set('trace.tour', S.ride ? '1' : '0');
    paintRide();
  }
  function paintRide() {
    const b = $('#tr-ride');
    const what = S.ride ? 'Pause the ride' : 'Start the ride';
    b.textContent = S.ride ? '⏸' : '▶';
    b.setAttribute('aria-label', what);
    b.title = `${what} (Space)`;
  }
```

- [ ] **Step 9: Selection drives the metro**

In `pickSelection`, change

```js
    select(pick || null, { scroll: keep ? 'none' : 'tree', force: true });
```

to

```js
    select(pick || null, { scroll: keep ? 'none' : 'tree', force: true, auto: true });
```

Replace the whole `select` function and the `scrollNode` function after `scrollRow`. Delete `scrollNode` entirely
and keep `scrollRow` unchanged. The new `select` is:

```js
  // auto: the page chose the span (a new turn's first pick), so the metro marks it and keeps riding.
  function select(id, { scroll = 'both', force = false, auto = false } = {}) {
    if (!S.sk) return;
    const same = id === S.sel;
    S.sel = id;
    for (const el of $$('.tr-row[data-tspan]', rowsBox)) {
      const on = el.dataset.tspan === id;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', String(on));
    }
    const ni = trNodeIndex(id);
    if (metro) metro.select(ni, { fly: !auto && scroll !== 'none' });
    markBar(ni);
    if (!same && !auto) announce(ni);
    if (scroll === 'both' || scroll === 'tree') scrollRow(id);
    if (!same || force) paintDetail();
  }
```

- [ ] **Step 10: Clicks, keys, lifecycle**

In the click delegate, replace

```js
    if ((el = q('[data-tspan]')))
      return void select(el.dataset.tspan, { scroll: el.classList.contains('tr-node') ? 'tree' : 'map' });
```

with

```js
    if ((el = q('[data-tspan]'))) return void select(el.dataset.tspan, { scroll: 'map' });
    if ((el = q('[data-tbar]'))) return void pickNode(Number(el.dataset.tbar));
    if (q('#tr-ride')) return void setRide(!S.ride);
```

In `onKey`, replace

```js
      const el = t.closest('[data-tkey], .tr-node, [data-tturn]');
      if (el) {
        e.preventDefault();
        el.click();
        if (el.classList.contains('tr-node') && e.key === 'Enter') txt.focus();
        return;
      }
```

with

```js
      const el = t.closest('[data-tkey], [data-tturn]');
      if (el) {
        e.preventDefault();
        el.click();
        return;
      }
```

Replace the block

```js
  // Wires follow the map's size: the splitter, the collapsed list and the window all change it.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => S.alive && queueWires()) : null;
  if (ro) ro.observe($('#tr-map'));
  const onResize = () => {
    fit();
    queueWires();
    if (S.rows.length > TR_WINDOW_AT) paintRows();
  };
```

with

```js
  // The session map: a 3D metro line the camera rides on its own (tracemetro.js). Reduced motion starts it still.
  S.ride = !trReduce() && store.get('trace.tour', '1') !== '0';
  metro =
    typeof trMetro === 'function'
      ? trMetro($('#tr-metro'), {
          onPick: pickNode,
          onFrame: paintHud,
          onToggle: () => setRide(!S.ride),
          onEnter: () => txt.focus(),
        })
      : null;
  if (metro) metro.tour(S.ride);
  else {
    const m = document.createElement('div');
    m.className = 'tr-empty';
    m.textContent = 'The map needs canvas support · see the tree';
    $('#tr-metro').replaceWith(m);
    $('#tr-ride').hidden = true;
  }
  paintRide();
  const onResize = () => {
    fit();
    if (S.rows.length > TR_WINDOW_AT) paintRows();
  };
```

In `onUnmount`, replace the two lines

```js
    if (S.frame) cancelAnimationFrame(S.frame);
```

and

```js
    if (ro) ro.disconnect();
```

with one line, put where the first one was:

```js
    if (metro) metro.destroy();
```

Search for `S.frame` and `frame: 0,`. If `frame: 0,` in `S` is now unused (`grep -n "S\.frame" public/traceview.js`
prints nothing), delete that property line.

Also check `S.preview` usage in `nodeParts`: the turn node kept `preview: true` for the old DOM preview. It is now
unused but harmless. Leave `nodeParts` unchanged.

- [ ] **Step 11: CSS — add the metro rules and remove the old map rules**

Edit `public/styles.css` by hand. Never run prettier on this file.

(a) Delete these rule blocks completely. Search for each selector:

- `/* A map node's eval badges hang on its top edge, so the node keeps its size. */`, the `.tr-nev { … }` block
  under it, and the `.tr-nev .tr-ev { … }` block.
- `.tr-map { … }`, the grid rule. Keep nothing of it.
- `.tr-node { … }`, `.tr-node:hover { … }`, `.tr-node.on { … }`, `.tr-node.err { … }` and `.tr-node.err.on { … }`.
- `.tr-ring { … }`, `.tr-ring.g { … }`, `.tr-ntext { … }`, `.tr-node b { … }`, `.tr-node .m { … }` and
  `.tr-pvn.has + .tr-pvd { … }`.
- `.tr-gap { … }`, `.tr-note { … }`, `.tr-note.l { … }`, `.tr-note.r { … }` and `.tr-note .n { … }`. Do not touch
  `.tr-notes`, `.tr-notes textarea`, `.tr-notebar` or `.tr-notebar .tr-btn`.
- `.tr-more-steps { … }`, `svg.tr-wires { … }`, `.tr-wire { … }` and `.tr-flow { … }`.
- `@keyframes tr-flow { … }`, `@keyframes tr-pulse { … }` and `@keyframes tr-flicker { … }`.
- The `@media (prefers-reduced-motion: reduce) { .tr-flow, .tr-ring, .tr-node.err { … } .tr-packet { … } … }` block
  that follows them.
- The comment `/* A narrow map: the nodes give a little, then the side notes go (the node line keeps the facts). */`
  and both `@container trmap (max-width: 600px)` and `@container trmap (max-width: 400px)` blocks.
- Inside the narrow-layout media block that also holds `.tr-right { padding: 0 16px 24px; }`, delete only these
  three rules: `.tr-map { grid-template-columns: … }`, `.tr-node, .tr-gap, .tr-more-steps { grid-column: 1; }` and
  `.tr-note { display: none; }`.

(b) Where `.tr-map { … }` was, right after the `.tr-legend i { … }` block, insert:

```css
/* The session map: a 3D metro line on a canvas (tracemetro.js), its HUD, the ride button and the time bar. */
.tr-metro {
  position: relative;
  height: clamp(360px, 64vh, 760px);
  border: 1px solid var(--h-edge);
  border-radius: 16px;
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 22%, #1e2356 0%, #0a0c20 72%);
}
.tr-metro canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.tr-metro canvas:focus-visible {
  outline: 2px solid var(--h-cyan);
  outline-offset: -2px;
}
.tr-metro .tr-empty {
  padding: 24px;
}
.tr-hud {
  position: absolute;
  left: 16px;
  top: 12px;
  right: 64px;
  pointer-events: none;
  line-height: 1.5;
}
.tr-hud-t {
  color: #c4b5fd;
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tr-hud-s {
  color: var(--h-text);
  font-size: 13px;
}
.tr-hud-more {
  color: var(--h-muted);
  font-size: 11.5px;
}
.tr-ride {
  position: absolute;
  right: 12px;
  top: 10px;
  width: 30px;
  height: 30px;
}
.tr-bar {
  position: relative;
  height: 8px;
  margin: 14px 4px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
}
.tr-bar span {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 2px;
  border-radius: 3px;
  opacity: 0.45;
  cursor: pointer;
}
.tr-bar span:hover {
  opacity: 0.8;
}
.tr-bar span.on {
  opacity: 1;
  outline: 1.5px solid #fff;
  outline-offset: 1px;
}
.tr-bar i {
  position: absolute;
  top: -6px;
  width: 2px;
  height: 20px;
  margin-left: -1px;
  background: #fff;
  box-shadow: 0 0 8px #fff;
  pointer-events: none;
}
.tr-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
```

(c) Check that nothing references removed classes:
`grep -n "tr-node\|tr-note \|tr-gap\|tr-wire\|tr-packet\|tr-ring\|tr-ntext\|tr-pvn\|tr-nev\|tr-more-steps" public/*.js public/*.css`
must print nothing. The `.tr-notes` and `.tr-notebar` lines do not match `tr-note ` because of the trailing space.

- [ ] **Step 12: Run the tests**

Run: `node --test test/trace-ui.test.js test/trace-metro.test.js`

Expected: PASS, including the three new audit tests and the existing S1 audits.

Then run `npm test`. Expected: PASS, 0 failures.

- [ ] **Step 13: Browser check on a demo server**

Start a demo server in the background on a free port with a temporary data dir:

```bash
T=$(mktemp -d) && DEMO=1 ZAAFPULSE_PORT=10451 ZAAFPULSE_DATA=$T ZAAFPULSE_NOTIFY=off ZAAFPULSE_RUNTIME_WATCH=off \
  ZAAFPULSE_OLLAMA_URL=http://127.0.0.1:9 ZAAFPULSE_LMSTUDIO_URL=http://127.0.0.1:9 node server.js &
```

Write `/tmp/metro-check.js` (Playwright from the global npm root, Chrome from `/Applications`):

```js
const { chromium } = require(process.env.PW);
(async () => {
  const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const [w, h] of [
    [1600, 1000],
    [1280, 860],
  ]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await p.goto('http://127.0.0.1:10451/#trace', { waitUntil: 'networkidle' });
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `/tmp/metro-${w}-a.png` });
    await p.waitForTimeout(3000);
    await p.screenshot({ path: `/tmp/metro-${w}-b.png` }); // the camera has moved on
    const row = await p.$('.tr-row[data-tspan]:nth-of-type(5)');
    if (row) await row.click();
    await p.waitForTimeout(900);
    await p.screenshot({ path: `/tmp/metro-${w}-c.png` }); // flown to the clicked span
    const hud = await p.textContent('#tr-hud-s');
    console.log(w, 'hud:', hud, 'errors:', errs.join(' | ') || 'none');
    await p.close();
  }
  await b.close();
})();
```

Run: `PW="$(npm root -g)/playwright" node /tmp/metro-check.js`

Expected:
- Each width prints `hud: Station …` and `errors: none`. Only a 404 for the favicon may appear.
- Screenshot a shows the track, the stations and up to four labels.
- Screenshot b shows the camera further down the line.
- Screenshot c shows the clicked span's station centred, with a white ring.

Look at the six screenshots. Fix any label that overlaps the HUD, or any canvas that is not drawn.

Stop the server afterwards with `kill %1`, or kill its pid.

- [ ] **Step 14: Commit**

Do not run prettier on these files; see Global Constraints. Check by eye that your new lines stay within 120
columns.

```bash
npm test
git add public/traceview.js public/index.html public/styles.css test/trace-ui.test.js
git commit -m "Trace map: the session map is a 3D metro line the camera rides; the card and wire map is gone"
```

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | Scene (track, sway, branch, bypass, travelled/future, station kinds, error, loop, grid, haze, distance fade) | Task 2 `draw` |
  | Labels (window, selected, hover, sides, contents, preview 48, fillText) | Task 1 `metroLabelled`; Task 2 `label` |
  | Camera and motion (position, ride timings, train, restart, selection flight, 10 s pause, hover pause, wheel, pause button and `trace.tour`, ambient, reduced motion) | Task 1 `metroTour` / `metroRideAt`; Task 2 `cameraAt` / `frame` / handlers; Task 3 `setRide` |
  | Panel layout (HUD, canvas height, time bar, more steps) | Task 3 Steps 4, 8 and 11 |
  | Keyboard and accessibility (canvas group label, keys, live region selections only) | Task 2 keydown; Task 3 `announce`, Steps 4 and 10 |
  | Live repaint (same turn keeps the camera; new stations fade in over 400 ms) | Task 2 `setNodes`; Task 3 `paintMap` key |
  | Lifecycle (view, page visibility, reduced-motion timer, destroy, DPR cap) | Task 2; Task 3 Steps 7 and 10 |
  | Error handling (no canvas, empty turn, untimed node, no NaN) | Task 3 Step 10; Task 2 `draw`; Task 1 `metroBar`; Task 3 `metroPart` |
  | Testing | Tasks 1–3 |

- **Types:**
  - `parts[i]` is `{ color, title, meta, dur, cost, err, loop, evalFail, preview }`. Task 2 defines it, and Task 3
    `metroPart` produces exactly these keys.
  - `select(i, { fly })` and `setNodes(nodes, parts, sel, { restart })` match between Tasks 2 and 3.
- **Deviation from the spec text:** the spec's unit list has `trMetro(canvas, { onPick, onHover })`. The plan uses
  `{ onPick, onFrame, onToggle, onEnter, clock }`. Hover is handled inside the renderer. `onFrame` feeds the HUD and
  the time bar, which the spec puts in the DOM, and `setPreview` carries the late prompt preview.
