// Read-time fixes on explorer spans, in the order of Jaeger's standard adjusters: duplicate span ids, orphans,
// clock skew between services, then start order. The input is not modified. Clock skew only applies where both
// spans name their service and the services differ (a remote agent's spans next to ours); log sources have no
// service, so their spans keep the times their logs gave them.
const durOf = (s) => (Number.isFinite(s.end) ? s.end - s.start : 0);

// Jaeger's rule: a child outside its parent is centred inside it; a longer child that starts first is moved to
// the parent's start.
function skewOf(parent, child) {
  const pd = durOf(parent);
  const cd = durOf(child);
  if (cd > pd) return child.start < parent.start ? parent.start - child.start : 0;
  if (child.start >= parent.start && child.start + cd <= parent.start + pd) return 0;
  return parent.start + Math.floor((pd - cd) / 2) - child.start;
}

function adjust(spans) {
  // A span sent twice (once at start, once with its end) keeps the longer record.
  const byId = new Map();
  for (const s of spans) {
    if (!s || typeof s.id !== 'string') continue;
    const had = byId.get(s.id);
    if (!had || durOf(s) > durOf(had)) byId.set(s.id, { ...s });
  }
  const list = [...byId.values()].sort((a, b) => a.start - b.start);
  if (!list.length) return list;

  // Orphans hang under the root; without a root, the earliest span becomes it.
  let root = list.find((s) => !s.parent);
  if (!root) {
    root = list[0];
    root.orphanOf = root.parent;
    root.parent = null;
  }
  for (const s of list)
    if (s.parent && !byId.has(s.parent)) {
      s.orphanOf = s.parent;
      s.parent = root.id;
    }

  const kids = new Map();
  for (const s of list)
    if (s.parent) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    }
  const shift = (s, delta) => {
    s.start += delta;
    if (Number.isFinite(s.end)) s.end += delta;
    for (const c of kids.get(s.id) || []) if (c.service === s.service) shift(c, delta);
  };
  const seen = new Set();
  const visit = (s) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    for (const c of kids.get(s.id) || []) {
      if (s.service && c.service && c.service !== s.service) {
        const delta = skewOf(s, c);
        if (delta) {
          shift(c, delta);
          c.skewMs = delta;
        }
      }
      visit(c);
    }
  };
  for (const s of list) if (!s.parent) visit(s);

  return list.sort((a, b) => a.start - b.start);
}

module.exports = { adjust, skewOf };
