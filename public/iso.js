'use strict';
/* Shared holographic toolkit: palette, metric tiles, ring gauges, and a tiny isometric 3D engine
   (canvas 2D, orthographic projection) used by the overview and live pages. */

// Fixed holographic palette: holo decks are a dark "screen" in both themes.
const HOLO = {
  cyan: '#4de8ff',
  blue: '#5b8cff',
  violet: '#8b7bff',
  pink: '#ff4fd8',
  orange: '#ff9a3c',
  text: '#dfe6ff',
  muted: '#8f98cc',
  line: 'rgba(120, 140, 255, .18)',
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
// A KPI card: title, big value, a sub line (may start with a delta), and on the right a sparkline of
// real values (spark) or, when there is no series, a small ring for a 0..1 share (p).
let tileSeq = 0;
function metricTile({ label, value, sub = '', color, drill = '', p = null, spark = null }) {
  const art =
    spark && spark.length > 1 && spark.some((v) => v > 0)
      ? tileSpark(spark, color)
      : p != null
        ? tileRing(p, color)
        : '';
  return `<div class="metric${art ? '' : ' plain'}" style="--c:${color}"${drill ? ` role="button" tabindex="0" data-drill="${drill}" aria-label="${esc(label)}: open details"` : ''}>
    <span>${label}</span><b class="num" title="${esc(String(value).replace(/<[^>]+>/g, ''))}">${value}</b><small title="${esc(String(sub).replace(/<[^>]+>/g, ''))}">${sub}</small>${art}</div>`;
}
// Smooth (Catmull-Rom) line with a gradient stroke from the tile color to violet, and a soft area.
function tileSpark(vals, color) {
  const W = 104;
  const H = 46;
  const id = `ts${tileSeq++}`;
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 4 - ((v - min) / span) * (H - 12)]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return `<svg class="tile-art" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs>
    <linearGradient id="${id}s" x1="0" x2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#b06cff"/></linearGradient>
    <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L${W},${H}L0,${H}Z" fill="url(#${id}f)"/><path d="${d}" fill="none" stroke="url(#${id}s)" stroke-width="2.2" stroke-linecap="round" style="filter:drop-shadow(0 0 4px ${color})"/>
    <circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="2.6" fill="#fff" style="filter:drop-shadow(0 0 4px ${color})"/></svg>`;
}
function tileRing(p, color) {
  const v = Math.max(0, Math.min(1, p));
  const r = 17;
  const C = 2 * Math.PI * r;
  const id = `tr${tileSeq++}`;
  return `<svg class="tile-art ring" viewBox="0 0 44 44" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#b06cff"/></linearGradient></defs>
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="rgba(140,160,255,.16)" stroke-width="4"/>
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="url(#${id})" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(C * v).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 22 22)" style="filter:drop-shadow(0 0 3px ${color})"/>
    <text x="22" y="25.5" text-anchor="middle">${Math.round(v * 100)}</text></svg>`;
}
let gaugeSeq = 0;
function gauge(label, p, sub, c1, c2) {
  const r = 38;
  const C = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, p || 0));
  const id = `hg${gaugeSeq++}`;
  return `<div class="gauge"><svg viewBox="0 0 100 100" width="104" height="104" role="img" aria-label="${esc(label)} ${fmtPct(v)}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(120,140,255,.14)" stroke-width="8"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#${id})" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${(C * v).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)" style="filter:drop-shadow(0 0 4px ${c1})"/>
    <text x="50" y="54" text-anchor="middle" class="gauge-v">${fmtPct(v)}</text></svg>
    <b>${label}</b><small class="num">${sub}</small></div>`;
}
// Stage readouts: icon + label, value with an optional delta pill, sub line and a small visual from real
// data: spark (series), pips (one dot per agent, colored by state) or p (0..1 progress). Arrays still work.
function readouts(items) {
  return items
    .map((it) => {
      const r = Array.isArray(it) ? { label: it[0], value: it[1], sub: it[2], color: it[3] } : it;
      const art =
        r.spark && r.spark.length > 1 && r.spark.some((v) => v > 0)
          ? `<span class="ro-art">${tileSpark(r.spark, r.color)}</span>`
          : r.pips
            ? `<span class="ro-pips">${
                r.pips.length
                  ? r.pips
                      .slice(0, 14)
                      .map((c) => `<i style="--p:${c}"></i>`)
                      .join('') + (r.pips.length > 14 ? `<em>+${r.pips.length - 14}</em>` : '')
                  : '<em>none</em>'
              }</span>`
            : r.p != null
              ? `<span class="ro-bar"><i style="width:${(Math.max(0, Math.min(1, r.p)) * 100).toFixed(1)}%"></i></span>`
              : '';
      return `<div class="readout" style="--c:${r.color}">
      <div class="ro-top">${r.icon ? `<span class="ro-ic">${icon(r.icon, 13)}</span>` : ''}<span class="ro-label">${r.label}</span>${r.delta || ''}</div>
      <b class="num">${r.value}</b><div class="ro-foot"><small>${r.sub || ''}</small>${art}</div></div>`;
    })
    .join('');
}

/* ---------- isometric engine ---------- */
const isoStages = new Set();

// draw(g) runs every animation frame with the projection and drawing helpers in g.
function isoStage(canvas, { draw, yaw = -0.42, pitch = 0.56, fit = [12.6, 8.3], origin = [0.47, 0.66], onDestroy }) {
  const ctx = canvas.getContext('2d');
  const st = { canvas, drag: 0, raf: 0, W: 0, H: 0, s: 1, pointer: null, t0: performance.now() };
  const particles = Array.from({ length: 46 }, () => ({
    x: (Math.random() - 0.5) * 10.4,
    z: -3 + Math.random() * 5.8,
    y: Math.random() * 5,
    v: 0.15 + Math.random() * 0.35,
  }));

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    st.W = canvas.clientWidth;
    st.H = canvas.clientHeight;
    canvas.width = st.W * dpr;
    canvas.height = st.H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    st.s = Math.min(st.W / fit[0], st.H / fit[1]);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // Drag to rotate (clamped so back walls stay behind the platform); hover position for tooltips.
  let down = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, d: st.drag };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (down) st.drag = Math.max(-0.5, Math.min(0.5, down.d + (e.clientX - down.x) / 400));
    const r = canvas.getBoundingClientRect();
    st.pointer = down ? null : { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
  });
  canvas.addEventListener('pointerup', () => {
    down = null;
  });
  canvas.addEventListener('pointerleave', () => {
    st.pointer = null;
  });
  canvas.addEventListener('dblclick', () => {
    st.drag = 0;
  });

  function frame(now) {
    const t = (now - st.t0) / 1000;
    const still = reduceMotion.matches;
    const yw = yaw + st.drag + (still ? 0 : Math.sin(t * 0.18) * 0.1);
    const cy = Math.cos(yw);
    const sy = Math.sin(yw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const ox = st.W * origin[0];
    const oy = st.H * origin[1];
    const s = st.s;
    const P = (x, y, z) => {
      const rx = x * cy - z * sy;
      const rz = x * sy + z * cy;
      return [ox + rx * s, oy + (rz * sp - y * cp) * s, rz * cp + y * sp];
    };
    const facing = (nx, ny, nz) => ny * sp + (nx * sy + nz * cy) * cp > 0;
    const poly = (pts) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
    };
    const seg = (a, b) => {
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    };

    const reserved = []; // screen boxes callouts must not cover this frame (wall titles)
    const g = {
      ctx,
      t,
      still,
      s,
      W: st.W,
      H: st.H,
      P,
      facing,
      poly,
      pointer: st.pointer,
      glow() {
        const gr = ctx.createRadialGradient(ox, oy + s * 0.6, 0, ox, oy + s * 0.6, s * 7.5);
        gr.addColorStop(0, 'rgba(91, 108, 255, .28)');
        gr.addColorStop(1, 'rgba(91, 108, 255, 0)');
        ctx.fillStyle = gr;
        ctx.fillRect(0, 0, st.W, st.H);
      },
      platform(X0, X1, Z0, Z1, T = 0.32) {
        const sides = [
          [
            [X0, 0, Z1],
            [X1, 0, Z1],
            [X1, -T, Z1],
            [X0, -T, Z1],
            [0, 0, 1],
          ],
          [
            [X1, 0, Z0],
            [X1, 0, Z1],
            [X1, -T, Z1],
            [X1, -T, Z0],
            [1, 0, 0],
          ],
          [
            [X0, 0, Z0],
            [X0, 0, Z1],
            [X0, -T, Z1],
            [X0, -T, Z0],
            [-1, 0, 0],
          ],
          [
            [X0, 0, Z0],
            [X1, 0, Z0],
            [X1, -T, Z0],
            [X0, -T, Z0],
            [0, 0, -1],
          ],
        ];
        for (const f of sides) {
          if (!facing(...f[4])) continue;
          poly(f.slice(0, 4).map((p) => P(...p)));
          ctx.fillStyle = 'rgba(40, 46, 120, .85)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(140, 150, 255, .5)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        poly([P(X0, 0, Z0), P(X1, 0, Z0), P(X1, 0, Z1), P(X0, 0, Z1)]);
        const tg = ctx.createLinearGradient(0, P(0, 0, Z0)[1], 0, P(0, 0, Z1)[1]);
        tg.addColorStop(0, 'rgba(24, 28, 84, .92)');
        tg.addColorStop(1, 'rgba(46, 40, 130, .92)');
        ctx.fillStyle = tg;
        ctx.fill();
        ctx.save();
        ctx.shadowColor = HOLO.violet;
        ctx.shadowBlur = 14;
        ctx.strokeStyle = 'rgba(160, 150, 255, .9)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = HOLO.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = Math.ceil(X0); x <= X1; x += 1) seg(P(x, 0, Z0), P(x, 0, Z1));
        for (let z = Math.ceil(Z0); z <= Z1; z += 1) seg(P(X0, 0, z), P(X1, 0, z));
        ctx.stroke();
      },
      // A translucent standing pane with glowing bars. trend: [i0, v0, i1, v1] dashed line; guide: dashed level.
      wall(
        ax,
        az,
        bx,
        bz,
        { vals, n = vals.length, H = 3.3, max, color, title, value, hot = -1, trend, guide, guideLabel },
      ) {
        poly([P(ax, 0, az), P(bx, 0, bz), P(bx, H, bz), P(ax, H, az)]);
        ctx.fillStyle = 'rgba(30, 40, 110, .32)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(120, 140, 255, .45)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(120, 140, 255, .12)';
        ctx.beginPath();
        for (let k = 1; k < 4; k++) seg(P(ax, (H * k) / 4, az), P(bx, (H * k) / 4, bz));
        ctx.stroke();
        const top = max || Math.max(1e-9, ...vals, guide || 0, trend ? trend[3] : 0) * 1.15;
        const at = (i, v) => {
          const f = (i + 0.5) / n;
          return P(ax + (bx - ax) * f, 0.15 + (v / top) * (H - 0.6), az + (bz - az) * f);
        };
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineWidth = Math.max(1.2, Math.min(s * 0.06, (s * 4.8) / n));
        const bars = (pick, c, blur) => {
          // one path per color: a shadowed stroke per bar is too slow
          ctx.strokeStyle = c;
          ctx.shadowColor = c;
          ctx.shadowBlur = blur;
          ctx.beginPath();
          vals.forEach((v, i) => {
            if (pick(i)) seg(at(i, 0), at(i, v * (still ? 1 : 0.92 + 0.08 * Math.sin(t * 6 + i))));
          });
          ctx.stroke();
        };
        bars((i) => i !== hot, color, 8);
        if (hot >= 0) bars((i) => i === hot, HOLO.pink, 14);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([6, 5]);
        if (trend) {
          ctx.strokeStyle = HOLO.pink;
          ctx.shadowColor = HOLO.pink;
          ctx.beginPath();
          seg(at(trend[0], trend[1]), at(trend[2], trend[3]));
          ctx.stroke();
        }
        if (guide != null) {
          ctx.strokeStyle = HOLO.orange;
          ctx.shadowColor = HOLO.orange;
          ctx.beginPath();
          seg(at(-0.5, guide), at(n - 0.5, guide));
          ctx.stroke();
          if (guideLabel) {
            const q = at(n - 0.5, guide);
            ctx.setLineDash([]);
            ctx.fillStyle = HOLO.orange;
            ctx.font = '600 10.5px system-ui, sans-serif';
            ctx.fillText(guideLabel, q[0] - ctx.measureText(guideLabel).width - 6, q[1] - 5);
          }
        }
        ctx.setLineDash([]);
        ctx.restore();
        const tl = P(ax, H, az);
        ctx.fillStyle = HOLO.text;
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillText(title, tl[0] + 8, tl[1] + 16);
        let tw = ctx.measureText(title).width;
        if (value) {
          ctx.fillStyle = color;
          ctx.font = '700 15px system-ui, sans-serif';
          ctx.fillText(value, tl[0] + 8, tl[1] + 34);
          tw = Math.max(tw, ctx.measureText(value).width);
        }
        reserved.push({ x: tl[0] + 4, w: tw + 10, y0: tl[1] + 2, y1: tl[1] + (value ? 40 : 22) });
      },
      // y0 lifts the box (a monitor on a desk, a body on legs).
      box(x, z, w, d, h, color, { slices = 0.35, glow = 18, alpha = 1, y0 = 0 } = {}) {
        const x1 = x + w;
        const z1 = z + d;
        const y1 = y0 + h;
        const faces = [
          {
            n: [0, 0, 1],
            p: [
              [x, y0, z1],
              [x1, y0, z1],
              [x1, y1, z1],
              [x, y1, z1],
            ],
            k: 0.7,
          },
          {
            n: [1, 0, 0],
            p: [
              [x1, y0, z],
              [x1, y0, z1],
              [x1, y1, z1],
              [x1, y1, z],
            ],
            k: 0.5,
          },
          {
            n: [-1, 0, 0],
            p: [
              [x, y0, z],
              [x, y0, z1],
              [x, y1, z1],
              [x, y1, z],
            ],
            k: 0.5,
          },
          {
            n: [0, 0, -1],
            p: [
              [x, y0, z],
              [x1, y0, z],
              [x1, y1, z],
              [x, y1, z],
            ],
            k: 0.7,
          },
        ];
        ctx.save();
        ctx.globalAlpha = alpha;
        for (const f of faces) {
          if (!facing(...f.n)) continue;
          const pts = f.p.map((p) => P(...p));
          poly(pts);
          const lg = ctx.createLinearGradient(0, pts[0][1], 0, pts[2][1]);
          lg.addColorStop(0, hexA(color, 0.35 * f.k));
          lg.addColorStop(1, hexA(color, 0.95 * f.k + 0.05));
          ctx.fillStyle = lg;
          ctx.fill();
          ctx.strokeStyle = hexA(color, 0.9);
          ctx.lineWidth = 1;
          ctx.stroke();
          if (slices && h > slices) {
            // glassy floor-by-floor slices
            ctx.strokeStyle = 'rgba(255, 255, 255, .14)';
            ctx.beginPath();
            for (let y = y0 + slices; y < y1; y += slices) seg(P(f.p[0][0], y, f.p[0][2]), P(f.p[1][0], y, f.p[1][2]));
            ctx.stroke();
          }
        }
        poly([P(x, y1, z), P(x1, y1, z), P(x1, y1, z1), P(x, y1, z1)]);
        ctx.fillStyle = hexA(color, 0.95);
        if (glow) {
          ctx.shadowColor = color;
          ctx.shadowBlur = glow;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255, 255, 255, .7)';
        ctx.stroke();
        ctx.restore();
      },
      spike(x, z, h, color) {
        const a = P(x, 0, z);
        const b = P(x, h, z);
        ctx.strokeStyle = hexA(color, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath();
        seg(a, b);
        ctx.stroke();
        ctx.fillStyle = hexA(color, 0.95);
        ctx.fillRect(b[0] - 1, b[1] - 1, 2, 2);
      },
      particles() {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const p of particles) {
          if (!still) {
            p.y += p.v * 0.016;
            if (p.y > 5.2) {
              p.y = 0;
              p.x = (Math.random() - 0.5) * 10.4;
            }
          }
          const q = P(p.x, p.y, p.z);
          const a = Math.max(0, 1 - p.y / 5.2) * 0.8;
          ctx.fillStyle = `rgba(150, 200, 255, ${a.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(q[0], q[1], 1.3, 0, 7);
          ctx.fill();
        }
        ctx.restore();
      },
      // Callouts with leader lines; each item {at: [sx, sy], text, color}. Stacked upward so none overlap.
      labels(items) {
        ctx.font = '600 11.5px system-ui, sans-serif';
        const ls = items.map((it) => {
          const w = ctx.measureText(it.text).width + 12;
          return { ...it, w, x: it.at[0] - 26 - w, y: it.at[1] - 30 };
        });
        const placed = [];
        for (const l of [...ls].sort((p, q) => q.y - p.y)) {
          l.x = Math.max(6, l.x);
          for (let moved = true, guard = 0; moved && guard < 60; guard++) {
            moved = false;
            // Overlap test (< 21) is looser than the 22px move, so float rounding cannot re-trigger it forever.
            for (const o of placed)
              if (l.x < o.x + o.w + 4 && o.x < l.x + l.w + 4 && Math.abs(l.y - o.y) < 21) {
                l.y = o.y - 22;
                moved = true;
              }
            // Wall titles stay readable: a callout over one moves above it, or below it near the top edge.
            for (const r of reserved)
              if (l.x < r.x + r.w && r.x < l.x + l.w && l.y + 10 > r.y0 && l.y - 11 < r.y1) {
                l.y = r.y0 - 13 > 14 ? r.y0 - 13 : r.y1 + 12;
                moved = true;
              }
          }
          placed.push(l);
        }
        for (const l of ls) {
          ctx.strokeStyle = 'rgba(223, 230, 255, .55)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(l.at[0], l.at[1]);
          ctx.lineTo(l.x + l.w + 8, l.y);
          ctx.lineTo(l.x + l.w, l.y);
          ctx.stroke();
          ctx.fillStyle = l.color;
          ctx.beginPath();
          ctx.arc(l.at[0], l.at[1], 2.6, 0, 7);
          ctx.fill();
          ctx.fillStyle = 'rgba(8, 10, 34, .82)';
          ctx.fillRect(l.x, l.y - 10, l.w, 19);
          ctx.fillStyle = l.color;
          ctx.fillRect(l.x, l.y - 10, 2, 19);
          ctx.fillStyle = HOLO.text;
          ctx.fillText(l.text, l.x + 7, l.y + 4);
        }
      },
    };
    ctx.clearRect(0, 0, st.W, st.H);
    draw(g);
    st.raf = requestAnimationFrame(frame);
  }
  st.raf = requestAnimationFrame(frame);
  st.destroy = () => {
    cancelAnimationFrame(st.raf);
    ro.disconnect();
    isoStages.delete(st);
    if (onDestroy) onDestroy();
  };
  isoStages.add(st);
  return st;
}

function unmountStages() {
  for (const st of [...isoStages]) st.destroy();
  runUnmountHooks();
}

/* ---------- subpages and SVG charts ---------- */
// [slug, label, description] per page; '' is the page's own overview.
const SUBPAGES = {
  quality: [
    ['', 'Overview'],
    ['utilization', 'Utilization'],
    ['cache', 'Cache'],
    ['compression', 'Compression'],
    ['providers', 'Provider stats'],
    ['models', 'Models'],
    ['rankings', 'Rankings'],
  ],
  endpoint: [
    ['', 'Overview'],
    ['keys', 'API keys'],
    ['mcp', 'MCP server'],
    ['connect', 'Connect'],
    ['tools', 'Code tools'],
  ],
  gateway: [
    ['', 'Overview'],
    ['providers', 'Providers'],
    ['router', 'Model router'],
    ['sessions', 'Sessions & memory'],
    ['playground', 'Playground'],
  ],
  skills: [
    ['', 'ZAAFPulse skills'],
    ['usage', 'Usage in your tools'],
  ],
  rag: [
    ['', 'Knowledge bases'],
    ['connect', 'API & usage'],
  ],
  a2a: [
    ['', 'Workflows'],
    ['collaborate', 'Collaborate'],
    ['runs', 'Runs'],
    ['agents', 'Specialist agents'],
    ['collaboration', 'Collaboration'],
  ],
  squad: [
    ['', 'Office'],
    ['logs', 'Logs'],
    ['proxy', 'Proxy logs'],
    ['time', 'Time'],
  ],
};
function subTabs(route) {
  return `<nav class="subtabs" aria-label="Subpages">${SUBPAGES[route]
    .map(
      ([slug, label]) =>
        `<a href="#${route}${slug ? '/' + slug : ''}" class="${(state.sub || '') === slug ? 'on' : ''}" ${(state.sub || '') === slug ? 'aria-current="page"' : ''}>${label}</a>`,
    )
    .join('')}</nav>`;
}
function subHero(eyebrow, title, sub, extra = '') {
  return `<div class="hero"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${sub}</p></div><div class="hero-actions">${extra}</div></div>`;
}
const panel = (title, meta, body, extra = '') =>
  `<section class="holo panel"${extra}><div class="panel-head"><h3>${title}</h3>${meta ? `<span class="meta">${meta}</span>` : ''}</div>${body}</section>`;
const holoEmpty = (text) => `<div class="empty">${text}</div>`;
const pct = (x) => `${(x * 100).toFixed(x >= 0.995 || x < 0.1 ? 1 : 0)}%`;
const msFmt = (ms) =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : dur(ms / 1000);
const quantile = (xs, q) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};

// Axis label: small counts keep their halves (2, 1.5, 1…) instead of rounding to repeats.
const tick = (v, max, fmt) => (fmt === fmtN && max < 10 ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : fmt(v));

// Stacked bars. series: [{ name, color, get(row) }]; rows from ghostFrom on are drawn as a forecast.
// W is the drawing width: full-width panels pass a larger one so their text does not scale up.
function holoBars(rows, { series, label = () => '', fmt = fmtN, height = 190, ghostFrom = Infinity, every, W = 640 }) {
  const H = height;
  const m = { t: 10, r: 6, b: 22, l: 48 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = niceMax(Math.max(1e-9, ...rows.map((r) => series.reduce((a, s) => a + (s.get(r) || 0), 0))));
  const step = iw / Math.max(1, rows.length);
  const bw = Math.max(1.5, Math.min(22, step * 0.7));
  const k = every || Math.ceil(rows.length / 8);
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const y = m.t + (ih * i) / 4;
    out.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" class="gl"/><text x="${m.l - 6}" y="${y + 3}" text-anchor="end">${tick(max * (1 - i / 4), max, fmt)}</text>`,
    );
  }
  rows.forEach((r, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    let base = m.t + ih;
    const ghost = i >= ghostFrom;
    const tip = `${label(r)}${ghost ? ' (forecast)' : ''} · ${series.map((s) => `${s.name} ${fmt(s.get(r) || 0)}`).join(' · ')}`;
    out.push(
      `<g data-tip="${esc(tip)}"><rect x="${m.l + i * step}" y="${m.t}" width="${step}" height="${ih}" fill="transparent"/>`,
    );
    for (const s of series) {
      const h = ((s.get(r) || 0) / max) * ih;
      if (h < 0.4) continue;
      out.push(
        `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${s.color}" ${ghost ? `fill-opacity=".28" stroke="${s.color}" stroke-dasharray="3 2"` : `style="filter:drop-shadow(0 0 3px ${s.color})"`}/>`,
      );
      base -= h;
    }
    out.push('</g>');
    if (i % k === 0)
      out.push(
        `<text x="${(m.l + i * step + step / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(label(r))}</text>`,
      );
  });
  return `<svg class="hchart" viewBox="0 0 ${W} ${H}" role="img">${out.join('')}</svg>`;
}

// Lines with a soft area under the first series. series: [{ name, color, get(row) }].
function holoLine(rows, { series, label = () => '', fmt = fmtN, height = 190, max: fixedMax, W = 640 }) {
  const H = height;
  const m = { t: 10, r: 8, b: 22, l: 48 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = fixedMax || niceMax(Math.max(1e-9, ...rows.flatMap((r) => series.map((s) => s.get(r) || 0))));
  const x = (i) => m.l + (rows.length < 2 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (v) => m.t + ih - (Math.min(v, max) / max) * ih;
  const out = [];
  const k = Math.ceil(rows.length / 8);
  for (let i = 0; i <= 4; i++) {
    const yy = m.t + (ih * i) / 4;
    out.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" class="gl"/><text x="${m.l - 6}" y="${yy + 3}" text-anchor="end">${tick(max * (1 - i / 4), max, fmt)}</text>`,
    );
  }
  series.forEach((s, si) => {
    const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(s.get(r) || 0).toFixed(1)}`);
    if (si === 0 && pts.length > 1)
      out.push(
        `<path d="M${pts.join('L')}L${x(rows.length - 1)},${m.t + ih}L${x(0)},${m.t + ih}Z" fill="${s.color}" fill-opacity=".12"/>`,
      );
    out.push(
      `<path d="M${pts.join('L')}" fill="none" stroke="${s.color}" stroke-width="2" style="filter:drop-shadow(0 0 4px ${s.color})"/>`,
    );
  });
  rows.forEach((r, i) => {
    out.push(
      `<rect x="${(x(i) - iw / rows.length / 2).toFixed(1)}" y="${m.t}" width="${(iw / rows.length).toFixed(1)}" height="${ih}" fill="transparent" data-tip="${esc(`${label(r)} · ${series.map((s) => `${s.name} ${fmt(s.get(r) || 0)}`).join(' · ')}`)}"/>`,
    );
    if (i % k === 0) out.push(`<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(label(r))}</text>`);
  });
  return `<svg class="hchart" viewBox="0 0 ${W} ${H}" role="img">${out.join('')}</svg>`;
}

// Horizontal meter rows: [{ label, value, max, color, right }].
const meters = (rows) =>
  `<div class="hmeters">${rows
    .map(
      (r) => `<div class="hmeter"><div class="hmeter-top"><span>${r.label}</span><b class="num">${r.right}</b></div>
  <div class="meter"><i style="width:${Math.min(100, Math.max(0.5, (r.value / (r.max || 1)) * 100)).toFixed(1)}%;background:${r.color};box-shadow:0 0 8px ${r.color}"></i></div></div>`,
    )
    .join('')}</div>`;

// Small cleanup hooks for pages that poll; run on every route change.
const unmountHooks = [];
const onUnmount = (fn) => unmountHooks.push(fn);
function runUnmountHooks() {
  while (unmountHooks.length) {
    try {
      unmountHooks.pop()();
    } catch {
      /* keep going */
    }
  }
}
