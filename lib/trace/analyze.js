// What a trace means, on explorer spans (ms): the critical path (Jaeger's algorithm), each span's self time,
// tokens and cost rolled up per subtree (from chat spans only: a parent's cost repeats its children's), and the
// failed span most likely to explain the outcome. A running span (end null) ends at the latest end seen.
const num = (v) => (Number.isFinite(v) ? v : 0);

function prepare(spans) {
  let last = -Infinity;
  for (const s of spans) if (Number.isFinite(s.end)) last = Math.max(last, s.end);
  const list = spans
    .filter((s) => s && typeof s.id === 'string' && Number.isFinite(s.start))
    .map((s) => ({ ...s, end: Number.isFinite(s.end) ? s.end : Math.max(s.start, last) }));
  const byId = new Map(list.map((s) => [s.id, s]));
  const kids = new Map();
  for (const s of list)
    if (s.parent && byId.has(s.parent)) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    }
  const roots = list.filter((s) => !s.parent || !byId.has(s.parent)).sort((a, b) => a.start - b.start);
  return { list, byId, kids, roots };
}

// Children clipped to their parent, top-down; a child entirely outside its parent is dropped with its subtree
// (Jaeger's removeOverflowingChildren).
function clipped(root, kids) {
  const boxes = new Map();
  const visit = (s, parent) => {
    let start = s.start;
    let end = s.end;
    if (parent) {
      if (end <= parent.start || start >= parent.end) return;
      start = Math.max(start, parent.start);
      end = Math.min(end, parent.end);
    }
    const box = { id: s.id, p: parent ? parent.id : null, start, end, kids: [] };
    boxes.set(s.id, box);
    if (parent) parent.kids.push(box);
    for (const c of kids.get(s.id) || []) visit(c, box);
  };
  visit(root, null);
  return boxes;
}

// From the root, take the last-finishing child; when a span has no such child, its section up to the returning
// point is on the path and the walk goes back to its parent, looking for a child that finished before this span
// started. The recursion of the Go version, as a loop.
function pathFrom(root, kids) {
  const boxes = clipped(root, kids);
  const out = [];
  let cur = boxes.get(root.id);
  let ret = null;
  for (let guard = 0; cur && guard < boxes.size * 4 + 4; guard++) {
    const end = ret === null ? cur.end : ret;
    let lfc = null;
    for (const c of cur.kids) {
      if (ret !== null && !(c.start < ret && c.end <= ret)) continue;
      if (!lfc || c.end > lfc.end) lfc = c;
    }
    if (lfc) {
      if (lfc.end !== end) out.push({ spanId: cur.id, start: lfc.end, end });
      cur = lfc;
      ret = null;
    } else {
      if (cur.start !== end) out.push({ spanId: cur.id, start: cur.start, end });
      if (!cur.p || cur.id === root.id) break;
      ret = cur.start;
      cur = boxes.get(cur.p);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function pickRoot({ byId, roots }, rootId) {
  return rootId && byId.has(rootId) ? byId.get(rootId) : roots[0] || null;
}

function criticalPath(spans, rootId) {
  const t = prepare(spans);
  const root = pickRoot(t, rootId);
  return root ? pathFrom(root, t.kids) : [];
}

function rollups(roots, kids) {
  const out = {};
  const visit = (s) => {
    const chat = s.kind === 'chat' && s.usage;
    const u = s.usage || {};
    const r = {
      tokensIn: chat ? num(u.input) + num(u.cacheRead) + num(u.cacheWrite5m) + num(u.cacheWrite1h) : 0,
      tokensOut: chat ? num(u.output) : 0,
      costUSD: s.kind === 'chat' ? num(s.cost) : 0,
      spans: 1,
      errors: s.status === 'error' ? 1 : 0,
    };
    for (const c of kids.get(s.id) || []) {
      const x = visit(c);
      r.tokensIn += x.tokensIn;
      r.tokensOut += x.tokensOut;
      r.costUSD += x.costUSD;
      r.spans += x.spans;
      r.errors += x.errors;
    }
    r.costUSD = Math.round(r.costUSD * 1e9) / 1e9; // sums of small prices, without float noise
    out[s.id] = r;
    return r;
  };
  roots.forEach(visit);
  return out;
}

// Time a span spent itself: its duration minus the union of its children's time inside it.
function selfTimes(list, kids) {
  const out = {};
  for (const s of list) {
    const iv = (kids.get(s.id) || [])
      .map((c) => [Math.max(c.start, s.start), Math.min(c.end, s.end)])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    let covered = 0;
    let cs = null;
    let ce = null;
    for (const [a, b] of iv) {
      if (cs === null || a > ce) {
        if (cs !== null) covered += ce - cs;
        cs = a;
        ce = b;
      } else ce = Math.max(ce, b);
    }
    if (cs !== null) covered += ce - cs;
    out[s.id] = Math.max(0, s.end - s.start - covered);
  }
  return out;
}

// The deepest failed span on the critical path; without one, the earliest failed span of the subtree.
function rootCause(root, kids, byId, onPath) {
  const inTree = [];
  const walk = (s) => {
    inTree.push(s);
    for (const c of kids.get(s.id) || []) walk(c);
  };
  walk(root);
  const failed = inTree.filter((s) => s.status === 'error');
  if (!failed.length) return null;
  const depth = (s) => {
    let d = 0;
    for (let p = s.parent; p && byId.has(p) && d < 1000; p = byId.get(p).parent) d++;
    return d;
  };
  const candidates = failed.filter((s) => onPath.has(s.id));
  const pick = candidates.length
    ? candidates.sort((a, b) => depth(b) - depth(a) || a.start - b.start)[0]
    : failed.sort((a, b) => a.start - b.start)[0];
  return {
    spanId: pick.id,
    name: pick.name,
    error: typeof pick.error === 'string' ? pick.error : '',
    onCriticalPath: onPath.has(pick.id),
  };
}

function analyze(spans, { rootId } = {}) {
  const t = prepare(Array.isArray(spans) ? spans : []);
  const root = pickRoot(t, rootId);
  const cp = root ? pathFrom(root, t.kids) : [];
  return {
    rootSpanId: root ? root.id : null,
    criticalPath: cp,
    selfTime: selfTimes(t.list, t.kids),
    rollup: rollups(t.roots, t.kids),
    rootCause: root ? rootCause(root, t.kids, t.byId, new Set(cp.map((x) => x.spanId))) : null,
  };
}

module.exports = { analyze, criticalPath };
