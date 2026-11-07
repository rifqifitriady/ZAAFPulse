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
    for (let i = 1; i < n - 1; i++) if (st.lay[i].branch) track(st.lay[i - 1], st.lay[i + 1], PINK, 0.3, [6, 9], false);
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
      const born = st.born[i] && !calm ? Math.min(1, (t - st.born[i]) / 400) : 1;
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
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? st.H : 1); // pixels, lines or pages
      st.hold = Math.max(0, Math.min(st.nodes.length - 1, cameraAt(t).p + dy / 300));
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
      if (st.ride) st.until = 0; // ▶ resumes the ride, even inside the pause after an interaction
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
    trMetro,
  };
