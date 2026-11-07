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
