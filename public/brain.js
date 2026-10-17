'use strict';
/* Second-brain graph: a small force layout on canvas with link pulses, hover focus,
   drag/zoom, and a growth replay that adds notes in the order they were created. */

const BRAIN_GROUPS = [
  { id: 'hub', name: 'Hubs & MOCs', color: 'var(--g-1)' },
  { id: 'project', name: 'Project memory', color: 'var(--g-2)' },
  { id: 'reference', name: 'Reference', color: 'var(--g-3)' },
  { id: 'feedback', name: 'Feedback', color: 'var(--g-4)' },
  { id: 'account', name: 'Account files', color: 'var(--g-5)' },
  { id: 'vault', name: 'Vault notes', color: 'var(--g-6)' },
  { id: 'other', name: 'Other', color: 'var(--g-other)' },
];

class BrainGraph {
  constructor(canvas, data, { onHover, onSelect, onReplay } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onReplay = onReplay || (() => {});
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.hiddenGroups = new Set();
    this.pulses = !this.reduce;
    this.cam = { x: 0, y: 0, k: 1 };
    this.userMoved = false;
    this.hover = null; this.selected = null; this.matches = null;
    this.particles = [];
    this.alpha = 1;
    this.readTheme();
    this.setData(data);
    this.bind();
    this.resize();
    if (this.reduce) { for (let i = 0; i < 320; i++) this.tick(); this.fit(true); }
    this.last = performance.now();
    this.startedAt = this.last;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.colors = Object.fromEntries(BRAIN_GROUPS.map((g) => [g.id, v(g.color.slice(4, -1))]));
    this.theme = { edge: v('--graph-edge'), edgeHi: v('--graph-edge-hi'), label: v('--text'), labelMuted: v('--muted'), ring: v('--surface'), bg: v('--surface') };
  }

  setData(data) {
    const groupIdx = Object.fromEntries(BRAIN_GROUPS.map((g, i) => [g.id, i]));
    const n = data.notes.length;
    this.nodes = data.notes.map((d) => {
      const deg = d.inLinks + d.outLinks;
      const gi = groupIdx[d.group] ?? BRAIN_GROUPS.length - 1;
      const a = (gi / BRAIN_GROUPS.length) * Math.PI * 2;
      return {
        ...d, deg, gi, r: 3.2 + Math.sqrt(deg) * 1.55,
        // Start near the centre so the first frames bloom outward.
        x: Math.cos(a) * 6 + (Math.random() - 0.5) * 18, y: Math.sin(a) * 6 + (Math.random() - 0.5) * 18,
        vx: 0, vy: 0, ax: Math.cos(a) * Math.sqrt(n) * 9, ay: Math.sin(a) * Math.sqrt(n) * 9,
        born: performance.now() + Math.random() * 500, shown: true,
      };
    });
    this.edges = data.edges.map(([s, t]) => ({ s: this.nodes[s], t: this.nodes[t], born: performance.now() + 300 + Math.random() * 900 }));
    this.adj = this.nodes.map(() => new Set());
    for (const e of this.edges) { this.adj[e.s.id].add(e.t.id); this.adj[e.t.id].add(e.s.id); }
    const created = this.nodes.map((d) => d.created).filter(Boolean);
    this.timeMin = Math.min(...created); this.timeMax = Math.max(...created);
    this.replay = null;
  }

  /* ---------- simulation ---------- */
  tick() {
    const N = this.nodes; const a = this.alpha;
    for (let i = 0; i < N.length; i++) {
      const p = N[i]; if (!p.shown) continue;
      for (let j = i + 1; j < N.length; j++) {
        const q = N[j]; if (!q.shown) continue;
        let dx = q.x - p.x; let dy = q.y - p.y; let d2 = dx * dx + dy * dy;
        if (d2 > 90000) continue; // ignore far pairs
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = (-240 * a) / Math.max(d2, 64); // floor the distance so close pairs cannot explode
        p.vx += dx * f * 0.5; p.vy += dy * f * 0.5; q.vx -= dx * f * 0.5; q.vy -= dy * f * 0.5;
        const min = p.r + q.r + 3; // collision
        if (d2 < min * min) { const d = Math.sqrt(d2); const push = ((min - d) / d) * 0.25; p.vx -= dx * push; p.vy -= dy * push; q.vx += dx * push; q.vy += dy * push; }
      }
    }
    for (const e of this.edges) {
      const s = e.s; const t = e.t; if (!s.shown || !t.shown) continue;
      const dx = t.x - s.x; const dy = t.y - s.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const L = 34 + Math.min(40, Math.sqrt(Math.min(s.deg, t.deg)) * 4);
      const k = ((d - L) / d) * a * (0.7 / Math.max(1, Math.min(s.deg, t.deg)));
      t.vx -= dx * k; t.vy -= dy * k; s.vx += dx * k; s.vy += dy * k;
    }
    for (const p of N) {
      if (!p.shown) continue;
      // Orphans have no springs holding them, so give them stronger gravity to stay in frame.
      const g = p.deg === 0 ? 0.035 : 0.004;
      p.vx += (p.ax - p.x) * 0.006 * a - p.x * g * a;
      p.vy += (p.ay - p.y) * 0.006 * a - p.y * g * a;
      if (p.fixed) { p.x = p.fx; p.y = p.fy; p.vx = p.vy = 0; continue; }
      p.vx *= 0.6; p.vy *= 0.6;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 24) { p.vx *= 24 / sp; p.vy *= 24 / sp; } // speed cap keeps the bloom smooth
      p.x += p.vx; p.y += p.vy;
    }
    this.alpha += ((this.alphaTarget || 0) - this.alpha) * 0.0228;
  }

  /* ---------- camera ---------- */
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr); this.canvas.height = Math.round(r.height * this.dpr);
  }
  bounds() {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const p of this.nodes) { if (!p.shown || this.hiddenGroups.has(p.group)) continue; x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r); x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r); }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: -100, y0: -100, x1: 100, y1: 100 };
  }
  fit(instant) {
    const b = this.bounds(); const pad = 40;
    const k = Math.min(2.4, Math.min((this.w - pad * 2) / (b.x1 - b.x0 || 1), (this.h - pad * 2) / (b.y1 - b.y0 || 1)));
    const target = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, k };
    if (instant) Object.assign(this.cam, target);
    else this.camTarget = target;
  }
  toWorld(px, py) { return { x: (px - this.w / 2) / this.cam.k + this.cam.x, y: (py - this.h / 2) / this.cam.k + this.cam.y }; }
  nodeAt(px, py) {
    const w = this.toWorld(px, py); let best = null; let bd = Infinity;
    for (const p of this.nodes) {
      if (!this.visible(p)) continue;
      const d = (p.x - w.x) ** 2 + (p.y - w.y) ** 2; const hit = (p.r + 5 / this.cam.k) ** 2;
      if (d < hit && d < bd) { best = p; bd = d; }
    }
    return best;
  }
  visible(p) { return p.shown && !this.hiddenGroups.has(p.group) && (!this.replay || p.created <= this.replay.cut); }

  /* ---------- input ---------- */
  bind() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    this.handlers = {
      down: (e) => {
        const p = pos(e); const n = this.nodeAt(p.x, p.y);
        c.setPointerCapture(e.pointerId);
        this.drag = { start: p, node: n, cam: { ...this.cam }, moved: false };
        if (n) { n.fixed = true; n.fx = n.x; n.fy = n.y; this.alphaTarget = 0.25; this.alpha = Math.max(this.alpha, 0.25); }
      },
      move: (e) => {
        const p = pos(e);
        if (this.drag) {
          const dx = p.x - this.drag.start.x; const dy = p.y - this.drag.start.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
          if (this.drag.node) { const w = this.toWorld(p.x, p.y); this.drag.node.fx = w.x; this.drag.node.fy = w.y; }
          else { this.cam.x = this.drag.cam.x - dx / this.cam.k; this.cam.y = this.drag.cam.y - dy / this.cam.k; this.userMoved = true; this.camTarget = null; }
          return;
        }
        const n = this.nodeAt(p.x, p.y);
        if (n !== this.hover) { this.hover = n; c.style.cursor = n ? 'pointer' : 'grab'; }
        this.onHover(n, e);
      },
      up: (e) => {
        const d = this.drag; this.drag = null;
        if (!d) return;
        if (d.node) { d.node.fixed = false; this.alphaTarget = 0; }
        if (!d.moved) { const n = this.nodeAt(pos(e).x, pos(e).y); this.select(n); this.onSelect(n); }
      },
      leave: () => { this.hover = null; this.onHover(null); },
      wheel: (e) => {
        e.preventDefault();
        const p = pos(e); const before = this.toWorld(p.x, p.y);
        this.cam.k = Math.max(0.2, Math.min(6, this.cam.k * Math.exp(-e.deltaY * 0.0015)));
        const after = this.toWorld(p.x, p.y);
        this.cam.x += before.x - after.x; this.cam.y += before.y - after.y;
        this.userMoved = true; this.camTarget = null;
      },
    };
    c.addEventListener('pointerdown', this.handlers.down);
    c.addEventListener('pointermove', this.handlers.move);
    c.addEventListener('pointerup', this.handlers.up);
    c.addEventListener('pointerleave', this.handlers.leave);
    c.addEventListener('wheel', this.handlers.wheel, { passive: false });
    this.ro = new ResizeObserver(() => { this.resize(); if (!this.userMoved) this.fit(true); });
    this.ro.observe(c);
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.handlers.down); c.removeEventListener('pointermove', this.handlers.move);
    c.removeEventListener('pointerup', this.handlers.up); c.removeEventListener('pointerleave', this.handlers.leave);
    c.removeEventListener('wheel', this.handlers.wheel);
  }

  /* ---------- public controls ---------- */
  select(n) { this.selected = n ? n.id : null; }
  focus(id) {
    const n = this.nodes[id]; if (!n) return;
    this.select(n);
    this.camTarget = { x: n.x, y: n.y, k: Math.max(this.cam.k, 1.8) }; this.userMoved = true;
  }
  zoom(f) { this.camTarget = { ...this.cam, k: Math.max(0.2, Math.min(6, this.cam.k * f)) }; this.userMoved = true; }
  reset() { this.userMoved = false; this.fit(false); }
  setMatches(ids) { this.matches = ids ? new Set(ids) : null; }
  toggleGroup(g) { if (this.hiddenGroups.has(g)) this.hiddenGroups.delete(g); else this.hiddenGroups.add(g); }
  startReplay(ms = 9000) {
    if (this.reduce) ms = 1;
    this.replay = { t0: performance.now(), ms, cut: this.timeMin - 1, prevCut: this.timeMin - 1 };
    for (const p of this.nodes) p.popAt = null;
  }

  /* ---------- render ---------- */
  frame(now) {
    const dt = Math.min(50, now - this.last); this.last = now;
    if (this.alpha > 0.002 || this.alphaTarget) this.tick();
    if (this.replay) {
      const p = Math.min(1, (now - this.replay.t0) / this.replay.ms);
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      this.replay.cut = this.timeMin + (this.timeMax - this.timeMin) * e;
      for (const n of this.nodes) if (n.created <= this.replay.cut && n.created > this.replay.prevCut) n.popAt = now;
      this.replay.prevCut = this.replay.cut;
      this.onReplay(this.replay.cut, p);
      if (p >= 1) { this.replay = null; this.onReplay(null, 1); }
    }
    // Ease the camera toward its target (auto-fit while the layout settles).
    if (!this.userMoved && now - this.startedAt < 4000) this.fit(false);
    if (this.camTarget) {
      const t = this.camTarget; const s = this.reduce ? 1 : 0.12;
      this.cam.x += (t.x - this.cam.x) * s; this.cam.y += (t.y - this.cam.y) * s; this.cam.k += (t.k - this.cam.k) * s;
      if (Math.abs(t.k - this.cam.k) < 0.001 && Math.abs(t.x - this.cam.x) < 0.1) this.camTarget = null;
    }
    this.draw(now, dt);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  draw(now, dt) {
    const { ctx } = this; const k = this.cam.k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.translate(this.w / 2, this.h / 2); ctx.scale(k, k); ctx.translate(-this.cam.x, -this.cam.y);

    const focusId = this.hover ? this.hover.id : this.selected;
    const near = focusId != null ? this.adj[focusId] : null;
    const isLit = (p) => focusId == null ? (!this.matches || this.matches.has(p.id)) : p.id === focusId || near.has(p.id);

    // Edges
    ctx.lineWidth = 0.8 / Math.sqrt(k);
    for (const e of this.edges) {
      if (!this.visible(e.s) || !this.visible(e.t)) continue;
      const lit = focusId != null && (e.s.id === focusId || e.t.id === focusId);
      const fade = this.replay ? Math.min(1, (now - Math.max(e.s.popAt || 0, e.t.popAt || 0)) / 600) : Math.min(1, Math.max(0, (now - e.born) / 700));
      ctx.globalAlpha = (lit ? 0.85 : focusId != null || this.matches ? 0.06 : 0.32) * fade;
      ctx.strokeStyle = lit ? this.colors[e.s.group] : this.theme.edge;
      ctx.lineWidth = (lit ? 1.6 : 0.8) / Math.sqrt(k);
      ctx.beginPath(); ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y); ctx.stroke();
    }

    // Pulses travelling from a note to the note it links to
    if (this.pulses) {
      const visibleEdges = this.edges.filter((e) => this.visible(e.s) && this.visible(e.t));
      const want = focusId != null ? 3 : 1.4;
      for (let i = 0; i < want * (dt / 16); i++) {
        if (this.particles.length > 160 || !visibleEdges.length) break;
        let e;
        if (focusId != null && Math.random() < 0.85) {
          const own = visibleEdges.filter((x) => x.s.id === focusId || x.t.id === focusId);
          e = own[Math.floor(Math.random() * own.length)];
        }
        e ||= visibleEdges[Math.floor(Math.random() * visibleEdges.length)];
        if (e) this.particles.push({ e, p: 0, v: 0.0009 + Math.random() * 0.0011 });
      }
      this.particles = this.particles.filter((q) => (q.p += q.v * dt) < 1 && this.visible(q.e.s) && this.visible(q.e.t));
      for (const q of this.particles) {
        const { s, t } = q.e;
        const x = s.x + (t.x - s.x) * q.p; const y = s.y + (t.y - s.y) * q.p;
        const lit = focusId == null || q.e.s.id === focusId || q.e.t.id === focusId;
        const env = Math.sin(q.p * Math.PI);
        ctx.fillStyle = this.colors[s.group];
        ctx.globalAlpha = (lit ? 0.25 : 0.05) * env;
        ctx.beginPath(); ctx.arc(x, y, 4.5 / Math.sqrt(k), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = (lit ? 0.95 : 0.15) * env;
        ctx.beginPath(); ctx.arc(x, y, 1.7 / Math.sqrt(k), 0, Math.PI * 2); ctx.fill();
      }
    }

    // Nodes
    for (const p of this.nodes) {
      if (!this.visible(p)) continue;
      const age = now - p.born;
      let scale = this.reduce ? 1 : Math.min(1, Math.max(0, age / 500));
      if (p.popAt) { const t = (now - p.popAt) / 700; scale = t < 1 ? 1 + Math.sin(t * Math.PI) * 0.8 : 1; }
      if (scale <= 0) continue;
      const lit = isLit(p);
      const r = p.r * (scale < 1 ? 1 - (1 - scale) ** 3 : scale);
      ctx.globalAlpha = lit ? 1 : 0.18;
      if (p.popAt && now - p.popAt < 900) { // ring burst when a note appears during replay
        const t = (now - p.popAt) / 900;
        ctx.globalAlpha = (1 - t) * 0.6; ctx.strokeStyle = this.colors[p.group]; ctx.lineWidth = 1.5 / k;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r + t * 22, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = lit ? 1 : 0.18;
      }
      ctx.fillStyle = this.colors[p.group];
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = this.theme.ring; ctx.lineWidth = 1.5 / k; ctx.stroke(); // 2px-ish surface ring between overlapping marks
      if (p.id === this.selected) {
        ctx.strokeStyle = this.colors[p.group]; ctx.lineWidth = 2 / k;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 4 / k + Math.sin(now / 300) * 1.2 / k, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Labels: hubs always, more as you zoom in; while focusing, the note and its best-connected neighbours
    if (this.labelFocus !== focusId) {
      this.labelFocus = focusId;
      this.labelSet = focusId == null ? null
        : new Set([focusId, ...[...near].sort((x, y) => this.nodes[y].deg - this.nodes[x].deg).slice(0, 14)]);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const fs = 11 / k;
    ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
    for (const p of this.nodes) {
      if (!this.visible(p)) continue;
      const show = this.labelSet ? this.labelSet.has(p.id) : (p.deg >= 22 / Math.max(1, k * k) || (this.matches && this.matches.has(p.id)));
      if (!show) continue;
      const label = p.name.length > 32 ? p.name.slice(0, 31) + '…' : p.name;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 3 / k; ctx.strokeStyle = this.theme.bg; ctx.strokeText(label, p.x, p.y + p.r + 3 / k);
      ctx.fillStyle = p.id === focusId ? this.theme.label : this.theme.labelMuted;
      ctx.fillText(label, p.x, p.y + p.r + 3 / k);
    }
    ctx.globalAlpha = 1;
  }
}
