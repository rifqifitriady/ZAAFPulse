'use strict';
/* Cost Control charts (sub-project 3a): SVG builders that take the data of GET /api/cost/view and return markup,
   plus the isometric treemap on isoStage (public/iso.js). The builders are pure (no DOM), so Node tests run them.
   Every name from the server (models, providers, projects, centers, budgets) reaches the markup through esc(); amounts
   go through the formatter the page passes in (`fmt`). Entrance motion is CSS keyed on #view.animate, which render()
   sets only without prefers-reduced-motion. */

// The holo palette (public/iso.js HOLO), repeated here so the builders also run in Node.
const COST_C = {
  cyan: '#4de8ff',
  blue: '#5b8cff',
  violet: '#8b7bff',
  pink: '#ff4fd8',
  orange: '#ff9a3c',
  green: '#5cf0a8',
  text: '#dfe6ff',
  muted: '#8f98cc',
};
// Ring colors by budget tone (lib/cost/views.js toneOf): ok cyan, a warning level orange, used up pink, no data muted.
const COST_TONE = { ok: COST_C.cyan, warn: COST_C.orange, exceeded: COST_C.pink, none: COST_C.muted };
// Flow columns and treemap centers take these in order.
const COST_SERIES = ['#4de8ff', '#8b7bff', '#ff4fd8', '#ff9a3c', '#5cf0a8', '#5b8cff', '#ffb547'];
const COST_OTHER = '__other';
const COST_PLAN = '__plan';
const COST_NONE = '__none';
// The calendar's five steps, dim to bright cyan; an empty day is drawn as an outline.
const COST_HEAT = ['#123a52', '#1b5f7e', '#2589a8', '#35b8d4', '#4de8ff'];
const COST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const costF = (v) => (Number.isFinite(v) ? v : 0).toFixed(1);
function costNiceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
// "22 Oct" from YYYY-MM-DD, without a Date (no time zone can move it).
const costDayLabel = (day) => `${Number(day.slice(8, 10))} ${COST_MONTHS[Number(day.slice(5, 7)) - 1] || ''}`;
// A chart that scales to its panel; `fixed` keeps its drawn size (the calendar's cells stay square and small).
const costSvg = (W, H, body, cls = '', fixed = false, label = '', role = 'img') =>
  `<svg class="${fixed ? '' : 'hchart '}cost-chart${cls ? ` ${cls}` : ''}" viewBox="0 0 ${W} ${H}"${fixed ? ` width="${W}" height="${H}"` : ''} role="${role}" aria-label="${esc(label)}">${body}</svg>`;
const costTip = (parts) => esc(parts.filter((x) => x !== '' && x != null).join(' · '));
const costPctText = (x) => (x == null ? '—' : `${(x * 100).toFixed(x >= 0.995 || x < 0.1 ? 1 : 0)}%`);
// A path through points; a null y breaks it (a gap, not zero).
function costPath(pts) {
  let d = '';
  let pen = false;
  for (const [x, y] of pts) {
    if (y == null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${costF(x)},${costF(y)}`;
    pen = true;
  }
  return d;
}
// The y-axis labels are right-anchored 6 px left of the margin: the margin grows to fit the longest one ("IDR 20,000"),
// at about 0.62 em per glyph of the 10.5 px axis text.
const COST_GLYPH = 0.62 * 10.5;
function costAxisLeft(max, fmt, min) {
  let n = 0;
  for (let i = 0; i <= 4; i++) n = Math.max(n, String(fmt(max * (1 - i / 4))).length);
  return Math.max(min, Math.ceil(n * COST_GLYPH + 8));
}
function costAxis(W, m, ih, max, fmt) {
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const y = m.t + (ih * i) / 4;
    out.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${costF(y)}" y2="${costF(y)}" class="gl"/><text x="${m.l - 6}" y="${costF(y + 3)}" text-anchor="end">${esc(fmt(max * (1 - i / 4)))}</text>`,
    );
  }
  return out.join('');
}

/* ---------- Overview ---------- */

// Cumulative spend per day of the month, the forecast from today to the month's end with its band, and the global
// monthly budgets as levels. `o` is the overview answer. The scale follows the spend: a budget more than twice the
// reach (the larger of the forecast's end and the band's top) is pinned at the top edge as "↑ Budget <amount>", so a
// large budget never flattens the curve.
const COST_BUDGET_FIT = 2;
function costBurnSvg(o, fmt) {
  const W = 1100; // a full-width panel: a wider drawing keeps its text at the panel's size
  const H = 300;
  const m = { t: 14, r: 12, b: 24, l: 60 };
  const ih = H - m.t - m.b;
  const days = o.month.days;
  const f = o.forecast;
  // The forecast's end sets the reach, or the band's top when that is higher (right-skewed spend: end above the band).
  const reach = Math.max(f.projected || 0, f.early ? 0 : f.high || 0);
  const fits = (l) => (l.amount || 0) <= COST_BUDGET_FIT * reach;
  const lines = o.budgetLines.filter(fits);
  const pinned = o.budgetLines.filter((l) => !fits(l));
  const max = costNiceMax(Math.max(o.total || 0, reach, ...lines.map((l) => l.amount || 0)) * 1.1);
  m.l = costAxisLeft(max, fmt, m.l);
  const iw = W - m.l - m.r;
  const x = (day) => m.l + ((Number(day.slice(8, 10)) - 1) / Math.max(1, days - 1)) * iw;
  const y = (v) => m.t + ih - (Math.min(v, max) / max) * ih;
  const out = [costAxis(W, m, ih, max, fmt)];
  // The band is drawn only where it has a width (to the cent); a stretch as wide as the line gets no polygon.
  const wide = (p) => !f.early && p.low != null && p.high != null && fmt(p.low) !== fmt(p.high);
  for (let i = 0; i < f.line.length;) {
    if (!wide(f.line[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < f.line.length && wide(f.line[j + 1])) j++;
    const run = f.line.slice(i, j + 1);
    if (run.length > 1) {
      const top = run.map((p) => [x(p.day), y(p.high)]);
      const bottom = run.map((p) => [x(p.day), y(p.low)]).reverse();
      out.push(
        `<path class="cost-band" d="${costPath([...top, ...bottom])}Z" fill="${COST_C.violet}" fill-opacity=".16"/>`,
      );
    }
    i = j + 1;
  }
  out.push(
    `<path class="cost-line" pathLength="1" d="${costPath(o.daily.map((d) => [x(d.day), y(d.cum)]))}" fill="none" stroke="${COST_C.cyan}" stroke-width="2.4" style="filter:drop-shadow(0 0 4px ${COST_C.cyan})"/>`,
    `<path class="cost-fade" d="${costPath(f.line.map((p) => [x(p.day), y(p.cum)]))}" fill="none" stroke="${COST_C.violet}" stroke-width="2" stroke-dasharray="6 5"/>`,
  );
  for (const l of lines) {
    const yy = costF(y(l.amount));
    out.push(
      `<g class="cost-fade" data-tip="${costTip(['Monthly budget', l.name, fmt(l.amount)])}"><line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="${COST_C.orange}" stroke-width="1.6" stroke-dasharray="4 4"/><text x="${W - m.r - 4}" y="${costF(y(l.amount) - 5)}" text-anchor="end" fill="${COST_C.orange}">${esc(l.name)} · ${esc(fmt(l.amount))}</text></g>`,
    );
  }
  pinned.forEach((l, i) => {
    const yy = m.t + 12 + i * 14;
    out.push(
      `<g class="cost-fade cost-pinned" data-tip="${costTip(['Monthly budget', l.name, fmt(l.amount), 'above this scale'])}"><line x1="${W - m.r - 190}" x2="${W - m.r}" y1="${m.t}" y2="${m.t}" stroke="${COST_C.orange}" stroke-width="1.6" stroke-dasharray="4 4"/><text x="${W - m.r - 4}" y="${yy}" text-anchor="end" fill="${COST_C.orange}">${esc(`↑ Budget ${fmt(l.amount)}`)}</text></g>`,
    );
  });
  const today = x(o.month.today);
  out.push(`<line x1="${costF(today)}" x2="${costF(today)}" y1="${m.t}" y2="${m.t + ih}" class="cost-today"/>`);
  const step = iw / Math.max(1, days - 1);
  for (const d of o.daily)
    out.push(
      `<rect x="${costF(x(d.day) - step / 2)}" y="${m.t}" width="${costF(step)}" height="${ih}" fill="transparent" data-tip="${costTip([costDayLabel(d.day), `spent ${fmt(d.cum)}`, `that day ${fmt(d.spend)}`])}"/>`,
    );
  for (const p of f.line.slice(1))
    out.push(
      `<rect x="${costF(x(p.day) - step / 2)}" y="${m.t}" width="${costF(step)}" height="${ih}" fill="transparent" data-tip="${costTip([costDayLabel(p.day), `forecast ${fmt(p.cum)}`, f.early ? 'no band yet' : wide(p) ? `${fmt(p.low)} – ${fmt(p.high)}` : null])}"/>`,
    );
  for (let i = 1; i <= days; i += Math.ceil(days / 8))
    out.push(
      `<text x="${costF(m.l + ((i - 1) / Math.max(1, days - 1)) * iw)}" y="${H - 6}" text-anchor="middle">${i}</text>`,
    );
  return costSvg(W, H, out.join(''), 'cost-burn', false, 'Burn-down');
}

// Daily spend as bars against each day's 7-day baseline; a spike is a pink marker with its day, spend, baseline and
// the day's top model.
function costSpikeSvg(spikes, fmt) {
  const W = 640;
  const H = 170;
  const m = { t: 12, r: 10, b: 22, l: 60 };
  const ih = H - m.t - m.b;
  const n = Math.max(1, spikes.length);
  const max = costNiceMax(Math.max(...spikes.map((s) => Math.max(s.spend || 0, s.baseline || 0)), 0));
  m.l = costAxisLeft(max, fmt, m.l);
  const iw = W - m.l - m.r;
  const step = iw / n;
  const bw = Math.max(2, Math.min(18, step * 0.62));
  const y = (v) => m.t + ih - (Math.min(v || 0, max) / max) * ih;
  const out = [costAxis(W, m, ih, max, fmt)];
  spikes.forEach((s, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    const h = m.t + ih - y(s.spend);
    const color = s.spike ? COST_C.pink : COST_C.blue;
    const tip = costTip([
      costDayLabel(s.day),
      fmt(s.spend),
      s.baseline == null ? 'no baseline yet' : `baseline ${fmt(s.baseline)}`,
      s.spike ? 'spike' : '',
      s.topModel ? 'top model ' + s.topModel : '', // costTip escapes the whole line
    ]);
    out.push(
      `<g data-tip="${tip}"><rect x="${costF(m.l + i * step)}" y="${m.t}" width="${costF(step)}" height="${ih}" fill="transparent"/><rect class="cost-grow" x="${costF(x)}" y="${costF(y(s.spend))}" width="${costF(bw)}" height="${costF(Math.max(0, h))}" rx="1.5" fill="${color}" fill-opacity="${s.spike ? 1 : 0.7}"/>${s.spike ? `<circle class="cost-spike" cx="${costF(x + bw / 2)}" cy="${costF(y(s.spend) - 7)}" r="4" fill="${COST_C.pink}" style="filter:drop-shadow(0 0 5px ${COST_C.pink})"/>` : ''}</g>`,
    );
  });
  out.push(
    // No baseline (fewer than 3 known days before): no dashed segment there.
    `<path class="cost-fade" d="${costPath(spikes.map((s, i) => [m.l + i * step + step / 2, s.baseline == null ? null : y(s.baseline)]))}" fill="none" stroke="${COST_C.orange}" stroke-width="1.4" stroke-dasharray="4 4"/>`,
  );
  const k = Math.ceil(n / 8);
  spikes.forEach((s, i) => {
    if (i % k === 0)
      out.push(
        `<text x="${costF(m.l + i * step + step / 2)}" y="${H - 6}" text-anchor="middle">${esc(costDayLabel(s.day))}</text>`,
      );
  });
  return costSvg(W, H, out.join(''), 'cost-spikes', false, 'Daily spend');
}

// One budget ring: the percent (capped at 100 % on the ring, the overflow as a pink outer arc), dashed and muted
// without data. `size` is the drawn width in px.
function costRingSvg(percent, tone, size = 64) {
  const r = 26;
  const C = 2 * Math.PI * r;
  const color = COST_TONE[tone] || COST_TONE.none;
  const none = percent == null;
  const p = none ? 0 : Math.max(0, Math.min(1, percent / 100));
  const over = none ? 0 : Math.max(0, Math.min(1, (percent - 100) / 100));
  const R = 31;
  const C2 = 2 * Math.PI * R;
  return `<svg class="cost-ring-svg" viewBox="0 0 70 70" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="35" cy="35" r="${r}" fill="none" stroke="rgba(140,160,255,.16)" stroke-width="6"${none ? ' stroke-dasharray="3 4"' : ''}/>
    ${none || p === 0 ? '' : `<circle class="cost-ring-arc" pathLength="1" cx="35" cy="35" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${costF(C * p)} ${costF(C)}" transform="rotate(-90 35 35)" style="filter:drop-shadow(0 0 4px ${color})"/>`}
    ${over > 0 ? `<circle cx="35" cy="35" r="${R}" fill="none" stroke="${COST_C.pink}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${costF(C2 * over)} ${costF(C2)}" transform="rotate(-90 35 35)"/>` : ''}
    <text x="35" y="39" text-anchor="middle">${none ? '—' : `${Math.round(percent)}%`}</text></svg>`;
}

// The Overview's compact rings, riskiest first (the server orders them), each linking to its card in Budgets. A ring
// whose forecast passes its amount within the period says when ("runs out ~21 Nov").
function costRingsHtml(rings, more) {
  if (!rings.length) return '';
  const items = rings.map((b) => {
    const href = `#cost/budgets?focus=${encodeURIComponent(b.id)}`;
    const state = b.tone === 'none' ? 'no data' : b.projected ? 'projected over' : b.state.replace('_', ' ');
    const out = typeof b.runsOut === 'string' ? `runs out ~${costDayLabel(b.runsOut)}` : '';
    const caption = out ? `<small class="cost-ring-out">${esc(out)}</small>` : '';
    return `<a class="cost-ring tone-${esc(b.tone)}" href="${esc(href)}" data-tip="${costTip([b.name, state, out])}">${costRingSvg(b.percent, b.tone, 58)}<span>${esc(b.name)}</span>${caption}</a>`;
  });
  if (more > 0) items.push(`<a class="cost-ring cost-more" href="#cost/budgets">+ ${more} more</a>`);
  return `<div class="cost-rings">${items.join('')}</div>`;
}

/* ---------- Breakdown ---------- */

// The flow: four columns of nodes, links as bands whose width is the spend. A node of a real ledger value is a button
// for the table filter (data-cost-node="<column>:<key>"); Other, Unknown and Plan fee are not, and their tooltip says
// "(not filterable)". `label(col, key)` names a node (center names, Other, Plan fee).
function costFlowSvg(flow, { fmt, label }) {
  const W = 900;
  const H = 320;
  const nodeW = 12;
  const gap = 8;
  const cols = flow.columns.length;
  const colX = (c) => 120 + (c * (W - 260)) / Math.max(1, cols - 1);
  const byCol = flow.columns.map((_, c) => flow.nodes.filter((n) => n.col === c));
  const totals = byCol.map((ns) => ns.reduce((a, n) => a + n.value, 0));
  const most = Math.max(...byCol.map((ns, c) => totals[c] / Math.max(1, H - 20 - gap * (ns.length - 1))), 1e-9);
  const scale = 1 / most;
  const pos = new Map();
  byCol.forEach((ns, c) => {
    let yy = 10;
    for (const n of ns) {
      const h = Math.max(2, n.value * scale);
      pos.set(n.id, { x: colX(c), y: yy, h, out: 0, in: 0, col: c });
      yy += h + gap;
    }
  });
  const total = totals[0] || 1;
  const out = [];
  for (const l of flow.links) {
    const a = pos.get(l.source);
    const b = pos.get(l.target);
    if (!a || !b) continue;
    const h = Math.max(1, l.value * scale);
    const x0 = a.x + nodeW;
    const x1 = b.x;
    const y0 = a.y + a.out;
    const y1 = b.y + b.in;
    a.out += h;
    b.in += h;
    const xm = (x0 + x1) / 2;
    const color = COST_SERIES[a.col % COST_SERIES.length];
    const name = (id) => {
      const [col, ...key] = id.split(':');
      return label(col, key.join(':'));
    };
    out.push(
      `<path class="cost-link cost-fade" d="M${costF(x0)},${costF(y0)}C${costF(xm)},${costF(y0)} ${costF(xm)},${costF(y1)} ${costF(x1)},${costF(y1)}L${costF(x1)},${costF(y1 + h)}C${costF(xm)},${costF(y1 + h)} ${costF(xm)},${costF(y0 + h)} ${costF(x0)},${costF(y0 + h)}Z" fill="${color}" fill-opacity=".28" data-tip="${costTip([`${name(l.source)} → ${name(l.target)}`, fmt(l.value), costPctText(l.value / total)])}"/>`,
    );
  }
  for (const n of flow.nodes) {
    const p = pos.get(n.id);
    const col = flow.columns[n.col];
    const name = label(col, n.key);
    const color = COST_SERIES[n.col % COST_SERIES.length];
    const filterable = n.key !== COST_OTHER && n.key !== COST_PLAN && n.key !== COST_NONE;
    const left = n.col === 0;
    out.push(
      `<g class="cost-node${filterable ? ' cost-click' : ''}"${filterable ? ` data-cost-node="${esc(n.id)}" role="button" tabindex="0" aria-label="${esc(`Filter the table to ${name}`)}"` : ''} data-tip="${costTip([name, fmt(n.value), costPctText(n.value / total) + (filterable ? '' : ' (not filterable)')])}"><rect class="cost-grow" x="${costF(p.x)}" y="${costF(p.y)}" width="${nodeW}" height="${costF(p.h)}" rx="2" fill="${color}" style="filter:drop-shadow(0 0 4px ${color})"/><text x="${costF(left ? p.x - 6 : p.x + nodeW + 6)}" y="${costF(p.y + p.h / 2 + 4)}" text-anchor="${left ? 'end' : 'start'}">${esc(name.length > 26 ? `${name.slice(0, 25)}…` : name)}</text></g>`,
    );
  }
  return costSvg(W, H, out.join(''), 'cost-flow', false, 'Cost flow', 'group');
}

// Weeks as columns, Monday to Sunday as rows; the color step is the day's level (lib/cost/views.js calendarOf).
function costCalendarSvg(cal, fmt) {
  const cell = 24;
  const gap = 4;
  const left = 34;
  const top = 18;
  const weeks = cal.days.length ? cal.days[cal.days.length - 1].week + 1 : 1;
  const W = left + weeks * (cell + gap) + 6;
  const H = top + 7 * (cell + gap) + 4;
  const out = [];
  ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((d, i) => {
    if (d) out.push(`<text x="${left - 6}" y="${top + i * (cell + gap) + 16}" text-anchor="end">${d}</text>`);
  });
  let labelled = null; // a month is named once, over the first week column it starts
  for (const d of cal.days) {
    const x = left + d.week * (cell + gap);
    const y = top + d.weekday * (cell + gap);
    const month = d.day.slice(0, 7);
    if (month !== labelled && (d.weekday === 0 || d === cal.days[0])) {
      labelled = month;
      out.push(`<text x="${x}" y="${top - 6}">${esc(COST_MONTHS[Number(d.day.slice(5, 7)) - 1] || '')}</text>`);
    }
    const fill = d.level ? COST_HEAT[d.level - 1] : 'rgba(120,140,255,.06)';
    out.push(
      `<rect class="cost-cell" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${fill}"${d.level ? '' : ' stroke="rgba(120,140,255,.22)"'} data-tip="${costTip([costDayLabel(d.day), d.spend ? fmt(d.spend) : 'nothing spent', d.topModel ? 'top model ' + d.topModel : ''])}"/>`,
    );
  }
  return costSvg(W, H, out.join(''), 'cost-calendar', true, 'Spend calendar');
}

// Center strips across the platform, each as wide as its share; inside, one block per project as deep as its share
// of the center; height by spend per request. Pure, so the layout is tested; costMountTreemap draws it.
function costTreemapLayout(treemap, { X0 = -5.6, X1 = 5.6, Z0 = -2.2, Z1 = 2.2, gap = 0.1 } = {}) {
  const total = treemap.reduce((a, c) => a + c.spend, 0);
  const maxPer = Math.max(1e-9, ...treemap.flatMap((c) => c.blocks.map((b) => b.perRequest || 0)));
  const out = [];
  let x = X0;
  treemap.forEach((c, ci) => {
    const w = total > 0 ? ((X1 - X0) * c.spend) / total : 0;
    let z = Z0;
    for (const b of c.blocks) {
      const d = c.spend > 0 ? ((Z1 - Z0) * b.spend) / c.spend : 0;
      out.push({
        ...b,
        x: x + gap / 2,
        z: z + gap / 2,
        w: Math.max(0.02, w - gap),
        d: Math.max(0.02, d - gap),
        h: 0.2 + 2.6 * ((b.perRequest || 0) / maxPer),
        color: COST_SERIES[ci % COST_SERIES.length],
      });
      z += d;
    }
    x += w;
  });
  return out;
}

// The hover text of a block (plain, escaped where drawn): the global "Other centers" block has center and project
// '__other'; a center's own Other block names how many projects it folds.
function costTreemapText(b, { fmt, label }) {
  return [
    b.center === COST_OTHER ? 'Other centers' : label('center', b.center),
    b.project === COST_OTHER ? `Other (${b.projects} projects)` : b.project || 'No project (gateway, judge)',
    fmt(b.spend),
    costPctText(b.share),
    b.perRequest == null ? '' : `${fmt(b.perRequest)} per request`,
  ]
    .filter(Boolean)
    .join(' · ');
}

// The treemap on the isometric stage: blocks grow to their height (at once with reduced motion, or on a quiet
// refresh: grow false); hover names one. Returns the stage, which the page destroys before a repaint.
function costMountTreemap(canvas, blocks, { fmt, label, grow = true }) {
  const grown = new Map(grow ? [] : blocks.map((b, i) => [i, b.h]));
  let tip = '';
  return isoStage(canvas, {
    fit: [12.8, 8.6],
    origin: [0.5, 0.64],
    draw(g) {
      const { P, still } = g;
      g.glow();
      g.platform(-5.8, 5.8, -2.4, 2.4);
      const tops = [];
      const items = blocks.map((b, i) => {
        const h = still ? b.h : (grown.get(i) ?? 0.02) + (b.h - (grown.get(i) ?? 0.02)) * 0.08;
        grown.set(i, h);
        tops.push({ at: P(b.x + b.w / 2, h, b.z + b.d / 2), b });
        return {
          depth: P(b.x + b.w / 2, 0, b.z + b.d / 2)[2],
          draw: () => g.box(b.x, b.z, b.w, b.d, h, b.color, { slices: 0.4, glow: 10 }),
        };
      });
      items.sort((a, b) => a.depth - b.depth).forEach((it) => it.draw());
      g.particles();
      const p = g.pointer;
      let hit = null;
      if (p)
        for (const t of tops) {
          const dd = Math.hypot(t.at[0] - p.x, t.at[1] - p.y);
          if (dd < 18 && (!hit || dd < hit.dd)) hit = { ...t, dd };
        }
      if (hit) {
        const b = hit.b;
        const text = costTreemapText(b, { fmt, label });
        const key = `${text}|${p.cx}|${p.cy}`;
        if (key !== tip) showTip({ clientX: p.cx, clientY: p.cy }, esc(text));
        tip = key;
      } else if (tip) {
        hideTip();
        tip = '';
      }
    },
  });
}
/* ---------- Value ---------- */

// Usage value against plan fee per source on a plan, with the multiplier; below 1× the bar is orange and says so.
// `label(source)` names a source.
function costPlanBarsHtml(plans, fmt, label) {
  if (!plans.length) return '';
  const max = Math.max(1e-9, ...plans.flatMap((p) => [p.value, p.fee]));
  const bar = (v, color, text) =>
    `<div class="cost-pbar"><i class="cost-grow-x" style="width:${costF(Math.max(0.5, (v / max) * 100))}%;background:${color};box-shadow:0 0 8px ${color}"></i><span>${esc(text)}</span></div>`;
  return `<div class="cost-plans">${plans
    .map((p) => {
      const under = p.multiplier != null && p.multiplier < 1;
      const times =
        p.multiplier == null ? 'no fee in this range' : `${p.multiplier.toFixed(p.multiplier < 1 ? 2 : 1)}× the fee`;
      return `<div class="cost-plan${under ? ' under' : ''}"><div class="cost-plan-head"><b>${esc(label(p.source))}</b><span>${esc(p.plan || 'Plan')} · ${p.days} days</span><em>${esc(times)}</em></div>
        ${bar(p.value, under ? COST_C.orange : COST_C.cyan, `Usage value ${fmt(p.value)}`)}${bar(p.fee, COST_C.violet, `Plan fee ${fmt(p.fee)}`)}
        ${under ? '<p class="cost-note">The plan cost more than metered use would have.</p>' : ''}</div>`;
    })
    .join('')}</div>`;
}

// A step's change with its sign; a change that formats as zero (under a cent, or under one whole unit of IDR) has none.
function costStepText(amount, fmt) {
  const shown = fmt(Math.abs(amount));
  return shown === fmt(0) ? shown : `${amount < 0 ? '−' : '+'}${shown}`;
}

// Without cache → cache savings (down) → plan savings (down, or up when a plan cost more) → paid.
function costWaterfallSvg(w, fmt) {
  const W = 640;
  const H = 230;
  const m = { t: 22, r: 12, b: 34, l: 60 };
  const ih = H - m.t - m.b;
  const max = costNiceMax(Math.max(w.withoutCache, w.usage, w.paid, 0));
  m.l = costAxisLeft(max, fmt, m.l);
  const iw = W - m.l - m.r;
  const y = (v) => m.t + ih - (Math.max(0, Math.min(v, max)) / max) * ih;
  const steps = [
    {
      name: 'Without cache',
      from: 0,
      to: w.withoutCache,
      color: COST_C.cyan,
      tip: 'usage value plus the cache savings',
    },
    {
      name: 'Cache savings',
      from: w.withoutCache,
      to: w.usage,
      color: COST_C.green,
      tip: 'estimate: base rates of each day',
    },
    {
      name: w.planSaved >= 0 ? 'Plan savings' : 'Plan cost more',
      from: w.usage,
      to: w.paid,
      color: w.planSaved >= 0 ? COST_C.green : COST_C.orange,
      tip: 'usage value minus what was paid',
    },
    { name: 'Paid', from: 0, to: w.paid, color: COST_C.violet, tip: 'what was paid' },
  ];
  const step = iw / steps.length;
  const bw = Math.min(90, step * 0.56);
  const out = [costAxis(W, m, ih, max, fmt)];
  steps.forEach((s, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    const top = y(Math.max(s.from, s.to));
    const h = Math.max(1, Math.abs(y(s.from) - y(s.to)));
    const amount = i === 0 || i === 3 ? s.to : s.to - s.from;
    out.push(
      `<g data-tip="${costTip([s.name, fmt(amount), s.tip])}"><rect class="cost-grow" x="${costF(x)}" y="${costF(top)}" width="${costF(bw)}" height="${costF(h)}" rx="2" fill="${s.color}" fill-opacity=".85" style="filter:drop-shadow(0 0 4px ${s.color})"/><text x="${costF(x + bw / 2)}" y="${costF(top - 6)}" text-anchor="middle" class="cost-val">${esc(i === 0 || i === 3 ? fmt(amount) : costStepText(amount, fmt))}</text><text x="${costF(x + bw / 2)}" y="${H - 12}" text-anchor="middle">${esc(s.name)}</text></g>`,
    );
    if (i < steps.length - 1) {
      const next = m.l + (i + 1) * step + (step - bw) / 2;
      out.push(
        `<line x1="${costF(x + bw)}" x2="${costF(next)}" y1="${costF(y(s.to))}" y2="${costF(y(s.to))}" class="cost-join"/>`,
      );
    }
  });
  return costSvg(W, H, out.join(''), 'cost-waterfall', false, 'Savings waterfall');
}

// Free local models: requests and tokens, never money.
function costLocalHtml(local, label = (s) => s) {
  if (!local.requests) return '<p class="cost-note">No local model calls in this range.</p>';
  const rows = local.models
    .map(
      (l) =>
        `<tr><td>${esc(l.model || 'Unknown model')}</td><td>${esc(label(l.source))}</td><td class="num">${l.requests.toLocaleString('en')}</td><td class="num">${l.tokens.toLocaleString('en')}</td></tr>`,
    )
    .join('');
  return `<table class="cost-table"><thead><tr><th>Model</th><th>Source</th><th class="num">Requests</th><th class="num">Tokens</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="cost-note">Not priced: these run on your own machine. A later version compares them with a cloud model.</p>`;
}

// One dot per model: spend per request across, tool-call accuracy up, size by requests; hollow with little data.
// With `accuracyError` (the Value answer's fixed phrase) the accuracy could not be read: say so instead of a chart.
function costScatterSvg(scatter, fmt, { accuracyError = null } = {}) {
  if (accuracyError) return '<p class="cost-note">Tool-call accuracy could not be read.</p>';
  const dots = scatter.dots;
  if (!dots.length && !(scatter.noToolCalls || []).length)
    return '<p class="cost-note">No model had requests in this range.</p>';
  const W = 1100;
  const H = 320;
  const m = { t: 16, r: 20, b: 30, l: 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const maxX = costNiceMax(Math.max(0, ...dots.map((d) => d.perRequest || 0)));
  const lowY = Math.max(0, Math.floor((Math.min(1, ...dots.map((d) => d.accuracy)) - 0.01) * 50) / 50);
  const x = (v) => m.l + (Math.min(v || 0, maxX) / (maxX * 1.1)) * iw; // 10% headroom for the biggest dot
  const pad = 22; // room above the 100% line for the biggest dot
  const y = (a) => m.t + pad + (ih - pad) - ((a - lowY) / Math.max(1e-9, 1 - lowY)) * (ih - pad);
  const maxReq = Math.max(1, ...dots.map((d) => d.requests));
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const a = lowY + ((1 - lowY) * (4 - i)) / 4;
    const yy = costF(y(a));
    out.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" class="gl"/><text x="${m.l - 6}" y="${costF(y(a) + 3)}" text-anchor="end">${(a * 100).toFixed(1)}%</text>`,
    );
  }
  for (let i = 0; i <= 4; i++)
    out.push(
      `<text x="${costF(x((maxX * i) / 4))}" y="${H - 8}" text-anchor="middle">${esc(fmt((maxX * i) / 4))}</text>`,
    );
  dots.forEach((d, i) => {
    const r = 4 + 14 * Math.sqrt(d.requests / maxReq);
    const color = COST_SERIES[i % COST_SERIES.length];
    const right = x(d.perRequest) > m.l + iw * 0.6;
    const pass =
      d.passRate && d.passRate.total
        ? `Datasets pass rate ${costPctText(d.passRate.pass / d.passRate.total)} (${d.passRate.pass}/${d.passRate.total})`
        : '';
    const tip = costTip([
      d.model,
      `${fmt(d.perRequest)} per request`,
      `accuracy ${costPctText(d.accuracy)}`,
      `${d.toolResults.toLocaleString('en')} tool results`,
      `${d.requests.toLocaleString('en')} requests`,
      d.littleData ? 'little data' : '',
      pass,
    ]);
    out.push(
      `<g class="cost-dot" data-tip="${tip}"><circle class="cost-pop" cx="${costF(x(d.perRequest))}" cy="${costF(y(d.accuracy))}" r="${costF(r)}" fill="${d.littleData ? 'none' : color}" fill-opacity=".55" stroke="${color}" stroke-width="2"${d.littleData ? ' stroke-dasharray="3 3"' : ''}/><text x="${costF(right ? x(d.perRequest) - r - 4 : x(d.perRequest) + r + 4)}" y="${costF(y(d.accuracy) + 4)}"${right ? ' text-anchor="end"' : ''}>${esc(d.model)}${d.littleData ? ' · little data' : ''}</text></g>`,
    );
  });
  const none = (scatter.noToolCalls || []).length
    ? `<p class="cost-note">No tool calls to measure: ${scatter.noToolCalls.map((n) => esc(n.model)).join(', ')}</p>`
    : '';
  return costSvg(W, H, out.join(''), 'cost-scatter', false, 'Cost vs quality') + none;
}

// One unit-cost line over the range with its own scale; a day without its denominator is a gap.
const COST_UNIT_LABEL = {
  perRequest: 'Unit cost per request',
  perMillionTokens: 'Unit cost per million tokens',
  perThousandToolCalls: 'Unit cost per 1,000 successful tool calls',
};
function costUnitSvg(unit, key, fmt, color) {
  const W = 340;
  const H = 170;
  const m = { t: 10, r: 8, b: 22, l: 56 };
  const ih = H - m.t - m.b;
  const vals = unit.map((u) => u[key]);
  const max = costNiceMax(Math.max(0, ...vals.filter((v) => v != null)));
  m.l = costAxisLeft(max, fmt, m.l);
  const iw = W - m.l - m.r;
  const x = (i) => m.l + (unit.length < 2 ? iw / 2 : (i / (unit.length - 1)) * iw);
  const y = (v) => (v == null ? null : m.t + ih - (Math.min(v, max) / max) * ih);
  const out = [costAxis(W, m, ih, max, fmt)];
  out.push(
    `<path class="cost-line" pathLength="1" d="${costPath(vals.map((v, i) => [x(i), y(v)]))}" fill="none" stroke="${color}" stroke-width="2" style="filter:drop-shadow(0 0 3px ${color})"/>`,
  );
  vals.forEach((v, i) => {
    if (v != null && (i === 0 || vals[i - 1] == null) && (i === vals.length - 1 || vals[i + 1] == null))
      out.push(`<circle cx="${costF(x(i))}" cy="${costF(y(v))}" r="2.5" fill="${color}"/>`); // a lone day between gaps
    out.push(
      `<rect x="${costF(x(i) - iw / unit.length / 2)}" y="${m.t}" width="${costF(iw / unit.length)}" height="${ih}" fill="transparent" data-tip="${costTip([costDayLabel(unit[i].day), v == null ? 'no data' : fmt(v)])}"/>`,
    );
  });
  const k = Math.ceil(unit.length / 6);
  unit.forEach((u, i) => {
    if (i % k === 0)
      out.push(`<text x="${costF(x(i))}" y="${H - 6}" text-anchor="middle">${esc(costDayLabel(u.day))}</text>`);
  });
  return costSvg(W, H, out.join(''), 'cost-unit', false, COST_UNIT_LABEL[key] || 'Unit cost');
}

if (typeof module !== 'undefined')
  module.exports = {
    COST_TONE,
    costNiceMax,
    costAxisLeft,
    costDayLabel,
    costPath,
    costBurnSvg,
    costSpikeSvg,
    costRingSvg,
    costRingsHtml,
    costFlowSvg,
    costCalendarSvg,
    costTreemapLayout,
    costTreemapText,
    costPlanBarsHtml,
    costWaterfallSvg,
    costLocalHtml,
    costScatterSvg,
    costUnitSvg,
  };
