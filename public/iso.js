'use strict';
/* Shared holographic toolkit: palette, metric tiles, ring gauges, and a tiny isometric 3D engine
   (canvas 2D, orthographic projection) used by the overview and live pages. */

// Fixed holographic palette: holo decks are a dark "screen" in both themes.
const HOLO = {
  cyan: '#4de8ff', blue: '#5b8cff', violet: '#8b7bff', pink: '#ff4fd8', orange: '#ff9a3c',
  text: '#dfe6ff', muted: '#8f98cc', line: 'rgba(120, 140, 255, .18)',
};
// One color per app, in rank order: violet through pink to orange, like a heat ramp.
const APP_RAMP = ['#7b6cff', '#9d5cff', '#c45cf2', '#ec5cd0', '#ff5ca8', '#ff6f7d', '#ff8a5c', '#ffaa4a'];
const appColor = (i) => APP_RAMP[Math.min(i, APP_RAMP.length - 1)];
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/* ---------- HTML blocks ---------- */
// p (0..1) draws a fill bar along the tile's bottom edge.
function metricTile({ label, value, sub = '', color, drill = '', p = null }) {
  return `<div class="metric" style="--c:${color}"${drill ? ` role="button" tabindex="0" data-drill="${drill}" aria-label="${esc(label)}: open details"` : ''}>
    <span>${label}</span><b class="num">${value}</b><small>${sub}</small>${p == null ? '' : `<i class="metric-bar" style="width:${(Math.max(0, Math.min(1, p)) * 100).toFixed(1)}%"></i>`}</div>`;
}
let gaugeSeq = 0;
function gauge(label, p, sub, c1, c2) {
  const r = 38; const C = 2 * Math.PI * r; const v = Math.max(0, Math.min(1, p || 0)); const id = `hg${gaugeSeq++}`;
  return `<div class="gauge"><svg viewBox="0 0 100 100" width="104" height="104" role="img" aria-label="${esc(label)} ${fmtPct(v)}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(120,140,255,.14)" stroke-width="8"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#${id})" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${(C * v).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)" style="filter:drop-shadow(0 0 4px ${c1})"/>
    <text x="50" y="54" text-anchor="middle" class="gauge-v">${fmtPct(v)}</text></svg>
    <b>${label}</b><small class="num">${sub}</small></div>`;
}
const readouts = (items) => items.map(([k, v, s, c]) =>
  `<div class="readout" style="--c:${c}"><span>${k}</span><b class="num">${v}</b><small>${s}</small></div>`).join('');

/* ---------- isometric engine ---------- */
const isoStages = new Set();

// draw(g) runs every animation frame with the projection and drawing helpers in g.
function isoStage(canvas, { draw, yaw = -0.42, pitch = 0.56, fit = [12.6, 8.3], origin = [0.47, 0.66], onDestroy }) {
  const ctx = canvas.getContext('2d');
  const st = { canvas, drag: 0, raf: 0, W: 0, H: 0, s: 1, pointer: null, t0: performance.now() };
  const particles = Array.from({ length: 46 }, () => ({ x: (Math.random() - 0.5) * 10.4, z: -3 + Math.random() * 5.8, y: Math.random() * 5, v: 0.15 + Math.random() * 0.35 }));

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    st.W = canvas.clientWidth; st.H = canvas.clientHeight;
    canvas.width = st.W * dpr; canvas.height = st.H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    st.s = Math.min(st.W / fit[0], st.H / fit[1]);
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  // Drag to rotate (clamped so back walls stay behind the platform); hover position for tooltips.
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, d: st.drag }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (down) st.drag = Math.max(-0.5, Math.min(0.5, down.d + (e.clientX - down.x) / 400));
    const r = canvas.getBoundingClientRect();
    st.pointer = down ? null : { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
  });
  canvas.addEventListener('pointerup', () => { down = null; });
  canvas.addEventListener('pointerleave', () => { st.pointer = null; });
  canvas.addEventListener('dblclick', () => { st.drag = 0; });

  function frame(now) {
    const t = (now - st.t0) / 1000;
    const still = reduceMotion.matches;
    const yw = yaw + st.drag + (still ? 0 : Math.sin(t * 0.18) * 0.1);
    const cy = Math.cos(yw); const sy = Math.sin(yw); const cp = Math.cos(pitch); const sp = Math.sin(pitch);
    const ox = st.W * origin[0]; const oy = st.H * origin[1]; const s = st.s;
    const P = (x, y, z) => { const rx = x * cy - z * sy; const rz = x * sy + z * cy; return [ox + rx * s, oy + (rz * sp - y * cp) * s, rz * cp + y * sp]; };
    const facing = (nx, ny, nz) => ny * sp + (nx * sy + nz * cy) * cp > 0;
    const poly = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); };
    const seg = (a, b) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };

    const g = {
      ctx, t, still, s, W: st.W, H: st.H, P, facing, poly, pointer: st.pointer,
      glow() {
        const gr = ctx.createRadialGradient(ox, oy + s * 0.6, 0, ox, oy + s * 0.6, s * 7.5);
        gr.addColorStop(0, 'rgba(91, 108, 255, .28)'); gr.addColorStop(1, 'rgba(91, 108, 255, 0)');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, st.W, st.H);
      },
      platform(X0, X1, Z0, Z1, T = 0.32) {
        const sides = [[[X0, 0, Z1], [X1, 0, Z1], [X1, -T, Z1], [X0, -T, Z1], [0, 0, 1]], [[X1, 0, Z0], [X1, 0, Z1], [X1, -T, Z1], [X1, -T, Z0], [1, 0, 0]],
          [[X0, 0, Z0], [X0, 0, Z1], [X0, -T, Z1], [X0, -T, Z0], [-1, 0, 0]], [[X0, 0, Z0], [X1, 0, Z0], [X1, -T, Z0], [X0, -T, Z0], [0, 0, -1]]];
        for (const f of sides) {
          if (!facing(...f[4])) continue;
          poly(f.slice(0, 4).map((p) => P(...p))); ctx.fillStyle = 'rgba(40, 46, 120, .85)'; ctx.fill();
          ctx.strokeStyle = 'rgba(140, 150, 255, .5)'; ctx.lineWidth = 1; ctx.stroke();
        }
        poly([P(X0, 0, Z0), P(X1, 0, Z0), P(X1, 0, Z1), P(X0, 0, Z1)]);
        const tg = ctx.createLinearGradient(0, P(0, 0, Z0)[1], 0, P(0, 0, Z1)[1]);
        tg.addColorStop(0, 'rgba(24, 28, 84, .92)'); tg.addColorStop(1, 'rgba(46, 40, 130, .92)');
        ctx.fillStyle = tg; ctx.fill();
        ctx.save(); ctx.shadowColor = HOLO.violet; ctx.shadowBlur = 14; ctx.strokeStyle = 'rgba(160, 150, 255, .9)'; ctx.lineWidth = 1.4; ctx.stroke(); ctx.restore();
        ctx.strokeStyle = HOLO.line; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = Math.ceil(X0); x <= X1; x += 1) seg(P(x, 0, Z0), P(x, 0, Z1));
        for (let z = Math.ceil(Z0); z <= Z1; z += 1) seg(P(X0, 0, z), P(X1, 0, z));
        ctx.stroke();
      },
      // A translucent standing pane with glowing bars. trend: [i0, v0, i1, v1] dashed line; guide: dashed level.
      wall(ax, az, bx, bz, { vals, n = vals.length, H = 3.3, max, color, title, value, hot = -1, trend, guide, guideLabel }) {
        poly([P(ax, 0, az), P(bx, 0, bz), P(bx, H, bz), P(ax, H, az)]);
        ctx.fillStyle = 'rgba(30, 40, 110, .32)'; ctx.fill(); ctx.strokeStyle = 'rgba(120, 140, 255, .45)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = 'rgba(120, 140, 255, .12)'; ctx.beginPath();
        for (let k = 1; k < 4; k++) seg(P(ax, (H * k) / 4, az), P(bx, (H * k) / 4, bz));
        ctx.stroke();
        const top = max || Math.max(1e-9, ...vals, guide || 0, trend ? trend[3] : 0) * 1.15;
        const at = (i, v) => { const f = (i + 0.5) / n; return P(ax + (bx - ax) * f, 0.15 + (v / top) * (H - 0.6), az + (bz - az) * f); };
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineWidth = Math.max(1.2, Math.min(s * 0.06, (s * 4.8) / n));
        const bars = (pick, c, blur) => { // one path per color: a shadowed stroke per bar is too slow
          ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = blur; ctx.beginPath();
          vals.forEach((v, i) => { if (pick(i)) seg(at(i, 0), at(i, v * (still ? 1 : 0.92 + 0.08 * Math.sin(t * 6 + i)))); });
          ctx.stroke();
        };
        bars((i) => i !== hot, color, 8);
        if (hot >= 0) bars((i) => i === hot, HOLO.pink, 14);
        ctx.lineWidth = 1.2; ctx.setLineDash([6, 5]);
        if (trend) { ctx.strokeStyle = HOLO.pink; ctx.shadowColor = HOLO.pink; ctx.beginPath(); seg(at(trend[0], trend[1]), at(trend[2], trend[3])); ctx.stroke(); }
        if (guide != null) {
          ctx.strokeStyle = HOLO.orange; ctx.shadowColor = HOLO.orange; ctx.beginPath(); seg(at(-0.5, guide), at(n - 0.5, guide)); ctx.stroke();
          if (guideLabel) { const q = at(n - 0.5, guide); ctx.setLineDash([]); ctx.fillStyle = HOLO.orange; ctx.font = '600 10.5px system-ui, sans-serif'; ctx.fillText(guideLabel, q[0] - ctx.measureText(guideLabel).width - 6, q[1] - 5); }
        }
        ctx.setLineDash([]); ctx.restore();
        const tl = P(ax, H, az);
        ctx.fillStyle = HOLO.text; ctx.font = '600 11px system-ui, sans-serif'; ctx.fillText(title, tl[0] + 8, tl[1] + 16);
        if (value) { ctx.fillStyle = color; ctx.font = '700 15px system-ui, sans-serif'; ctx.fillText(value, tl[0] + 8, tl[1] + 34); }
      },
      // y0 lifts the box (a monitor on a desk, a body on legs).
      box(x, z, w, d, h, color, { slices = 0.35, glow = 18, alpha = 1, y0 = 0 } = {}) {
        const x1 = x + w; const z1 = z + d; const y1 = y0 + h;
        const faces = [
          { n: [0, 0, 1], p: [[x, y0, z1], [x1, y0, z1], [x1, y1, z1], [x, y1, z1]], k: 0.7 },
          { n: [1, 0, 0], p: [[x1, y0, z], [x1, y0, z1], [x1, y1, z1], [x1, y1, z]], k: 0.5 },
          { n: [-1, 0, 0], p: [[x, y0, z], [x, y0, z1], [x, y1, z1], [x, y1, z]], k: 0.5 },
          { n: [0, 0, -1], p: [[x, y0, z], [x1, y0, z], [x1, y1, z], [x, y1, z]], k: 0.7 },
        ];
        ctx.save(); ctx.globalAlpha = alpha;
        for (const f of faces) {
          if (!facing(...f.n)) continue;
          const pts = f.p.map((p) => P(...p));
          poly(pts);
          const lg = ctx.createLinearGradient(0, pts[0][1], 0, pts[2][1]);
          lg.addColorStop(0, hexA(color, 0.35 * f.k)); lg.addColorStop(1, hexA(color, 0.95 * f.k + 0.05));
          ctx.fillStyle = lg; ctx.fill();
          ctx.strokeStyle = hexA(color, 0.9); ctx.lineWidth = 1; ctx.stroke();
          if (slices && h > slices) { // glassy floor-by-floor slices
            ctx.strokeStyle = 'rgba(255, 255, 255, .14)'; ctx.beginPath();
            for (let y = y0 + slices; y < y1; y += slices) seg(P(f.p[0][0], y, f.p[0][2]), P(f.p[1][0], y, f.p[1][2]));
            ctx.stroke();
          }
        }
        poly([P(x, y1, z), P(x1, y1, z), P(x1, y1, z1), P(x, y1, z1)]);
        ctx.fillStyle = hexA(color, 0.95); if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; } ctx.fill();
        ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255, 255, 255, .7)'; ctx.stroke();
        ctx.restore();
      },
      spike(x, z, h, color) {
        const a = P(x, 0, z); const b = P(x, h, z);
        ctx.strokeStyle = hexA(color, 0.55); ctx.lineWidth = 1; ctx.beginPath(); seg(a, b); ctx.stroke();
        ctx.fillStyle = hexA(color, 0.95); ctx.fillRect(b[0] - 1, b[1] - 1, 2, 2);
      },
      particles() {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        for (const p of particles) {
          if (!still) { p.y += p.v * 0.016; if (p.y > 5.2) { p.y = 0; p.x = (Math.random() - 0.5) * 10.4; } }
          const q = P(p.x, p.y, p.z); const a = Math.max(0, 1 - p.y / 5.2) * 0.8;
          ctx.fillStyle = `rgba(150, 200, 255, ${a.toFixed(2)})`; ctx.beginPath(); ctx.arc(q[0], q[1], 1.3, 0, 7); ctx.fill();
        }
        ctx.restore();
      },
      // Callouts with leader lines; each item {at: [sx, sy], text, color}. Stacked upward so none overlap.
      labels(items) {
        ctx.font = '600 11.5px system-ui, sans-serif';
        const ls = items.map((it) => { const w = ctx.measureText(it.text).width + 12; return { ...it, w, x: it.at[0] - 26 - w, y: it.at[1] - 30 }; });
        const placed = [];
        for (const l of [...ls].sort((p, q) => q.y - p.y)) {
          for (let moved = true; moved;) {
            moved = false;
            // Overlap test (< 21) is looser than the 22px move, so float rounding cannot re-trigger it forever.
            for (const o of placed) if (l.x < o.x + o.w + 4 && o.x < l.x + l.w + 4 && Math.abs(l.y - o.y) < 21) { l.y = o.y - 22; moved = true; }
          }
          l.x = Math.max(6, l.x); placed.push(l);
        }
        for (const l of ls) {
          ctx.strokeStyle = 'rgba(223, 230, 255, .55)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(l.at[0], l.at[1]); ctx.lineTo(l.x + l.w + 8, l.y); ctx.lineTo(l.x + l.w, l.y); ctx.stroke();
          ctx.fillStyle = l.color; ctx.beginPath(); ctx.arc(l.at[0], l.at[1], 2.6, 0, 7); ctx.fill();
          ctx.fillStyle = 'rgba(8, 10, 34, .82)'; ctx.fillRect(l.x, l.y - 10, l.w, 19);
          ctx.fillStyle = l.color; ctx.fillRect(l.x, l.y - 10, 2, 19);
          ctx.fillStyle = HOLO.text; ctx.fillText(l.text, l.x + 7, l.y + 4);
        }
      },
    };
    ctx.clearRect(0, 0, st.W, st.H);
    draw(g);
    st.raf = requestAnimationFrame(frame);
  }
  st.raf = requestAnimationFrame(frame);
  st.destroy = () => { cancelAnimationFrame(st.raf); ro.disconnect(); isoStages.delete(st); if (onDestroy) onDestroy(); };
  isoStages.add(st);
  return st;
}

function unmountStages() {
  for (const st of [...isoStages]) st.destroy();
}
