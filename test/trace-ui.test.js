// The trace explorer page's pure helpers, without a browser: the tree rows, the map nodes, the text parts
// content is drawn from (S1), and an audit of public/traceview.js for HTML built from content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { traceDemo } = require('../lib/demo');
const { treeRows, mapNodes, textNodes, textFragment, fmtDur, trIsLive, trLivePlan } = require('../public/traceview.js');

const SRC = path.join(__dirname, '..', 'public', 'traceview.js');
const claudeSpans = () => traceDemo(Date.UTC(2026, 9, 20, 12)).skeletons['demo-claude-1'].spans;
const byName = (spans, name) => spans.filter((s) => s.name === name);

test('treeRows: depth-first in time order, with depth, kind and badges', () => {
  const spans = claudeSpans();
  const rows = treeRows(spans);
  assert.equal(rows.length, spans.length, 'every span is a row');
  const [root, turn] = rows;
  assert.equal(root.kind, 'session');
  assert.equal(root.depth, 0);
  assert.equal(turn.kind, 'turn');
  assert.equal(turn.depth, 1);
  // The turn's children in start order; the subagent's own two spans right under it, one level deeper.
  const order = rows.slice(2).map((r) => `${r.depth}:${r.name}`);
  assert.deepEqual(order, [
    '2:chat · claude-opus-5-5',
    '2:execute_tool · Read',
    '2:Explore',
    '3:chat · claude-haiku-5-5',
    '3:execute_tool · Grep',
    '2:execute_tool · Read',
    '2:execute_tool · Read',
    '2:execute_tool · Read',
    '2:execute_tool · Bash',
    '2:chat · claude-opus-5-5',
    '2:execute_tool · Edit',
    '2:execute_tool · Bash',
    '2:answer',
  ]);
  for (const r of rows) {
    assert.equal(typeof r.id, 'string');
    assert.ok(Number.isFinite(r.start));
    assert.ok(Array.isArray(r.badges));
  }
  const fail = rows.find((r) => r.status === 'error');
  assert.deepEqual(fail.badges[0], { label: 'command failed', tone: 'bad' });
  const agent = rows.find((r) => r.kind === 'agent');
  assert.equal(agent.kids, 2);
  assert.ok(agent.badges.some((b) => b.label === 'subagent'));
});

test('treeRows: a collapsed node keeps its row and hides what is under it', () => {
  const spans = claudeSpans();
  const agent = spans.find((s) => s.kind === 'agent');
  const rows = treeRows(spans, { collapsed: new Set([agent.id]) });
  assert.equal(rows.length, spans.length - 2);
  const row = rows.find((r) => r.id === agent.id);
  assert.equal(row.open, false);
  assert.equal(row.kids, 2);
  assert.ok(!rows.some((r) => r.depth === 3));
  // Collapsing the turn leaves the root and the turn.
  const turn = spans.find((s) => s.kind === 'turn');
  assert.deepEqual(
    treeRows(spans, { collapsed: new Set([turn.id]) }).map((r) => r.kind),
    ['session', 'turn'],
  );
});

test('treeRows: bad input, orphans and cycles never hide a span or loop', () => {
  assert.deepEqual(treeRows(null), []);
  const rows = treeRows([
    { id: 'a', parent: null, kind: 'session', name: 'invoke_agent x', start: 1 },
    { id: 'b', parent: 'gone', kind: 'tool', name: 'execute_tool Read', start: 2 },
    { id: 'c', parent: 'd', kind: 'tool', name: 'c', start: 3 },
    { id: 'd', parent: 'c', kind: 'tool', name: 'd', start: 4 },
  ]);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['a', 'b', 'c', 'd']);
});

test('mapNodes: five identical Read calls in a row fold into one node with a count', () => {
  const t0 = 1000;
  const spans = [
    { id: 'r', parent: null, kind: 'session', name: 'invoke_agent claude-code', start: t0, end: t0 + 100 },
    { id: 't', parent: 'r', kind: 'turn', name: 'turn 1', start: t0, end: t0 + 100 },
    { id: 'c', parent: 't', kind: 'chat', name: 'chat m', model: 'm', start: t0 + 1, end: t0 + 2 },
    ...[1, 2, 3, 4, 5].map((i) => ({
      id: `read${i}`,
      parent: 't',
      kind: 'tool',
      name: 'execute_tool Read',
      tool: { name: 'Read', target: 'a.js' },
      start: t0 + 10 + i,
      end: t0 + 11 + i,
      status: 'ok',
    })),
    { id: 'a', parent: 't', kind: 'answer', name: 'answer', start: t0 + 50, end: t0 + 50 },
  ];
  const nodes = mapNodes(spans);
  assert.deepEqual(
    nodes.map((n) => [n.kind, n.count]),
    [
      ['session', 1],
      ['turn', 1],
      ['chat', 1],
      ['tool', 5],
      ['answer', 1],
    ],
  );
  const read = nodes[3];
  assert.equal(read.id, 'read1');
  assert.deepEqual(read.ids, ['read1', 'read2', 'read3', 'read4', 'read5']);
  assert.equal(read.start, t0 + 11);
  assert.equal(read.end, t0 + 16);
});

test('mapNodes: the demo turn folds only repeats in a row, keeps failures apart and leaves subagent spans out', () => {
  const nodes = mapNodes(claudeSpans());
  assert.deepEqual(
    nodes.map((n) => `${n.kind}${n.count > 1 ? `x${n.count}` : ''}${n.status === 'error' ? '!' : ''}`),
    ['session', 'turn', 'chat', 'tool', 'agent', 'toolx3', 'tool!', 'chat', 'tool', 'tool', 'answer'],
  );
  const agent = nodes.find((n) => n.kind === 'agent');
  assert.equal(agent.tools, 1, 'the subagent node counts its own tool calls');
  assert.equal(byName(claudeSpans(), 'execute_tool Read').length, 4);
  assert.deepEqual(mapNodes(undefined), []);
});

test('textNodes: plain text and masked parts, in order', () => {
  const parts = textNodes('a ‹api key hidden› b', [{ start: 2, end: 18, label: 'api key' }]);
  assert.deepEqual(parts, [
    { text: 'a ', masked: null },
    { text: '‹api key hidden›', masked: 'api key', index: 0 },
    { text: ' b', masked: null },
  ]);
  assert.deepEqual(textNodes('plain', []), [{ text: 'plain', masked: null }]);
  assert.deepEqual(textNodes('', []), []);
  assert.deepEqual(textNodes(null, null), []);
  // Masks out of range, backwards or overlapping a previous one are ignored, but keep their index.
  const odd = textNodes('0123456789', [
    { start: 2, end: 4, label: 'x' },
    { start: 3, end: 6, label: 'overlap' },
    { start: 8, end: 99, label: 'past the end' },
    { start: 7, end: 6, label: 'backwards' },
  ]);
  assert.deepEqual(odd, [
    { text: '01', masked: null },
    { text: '23', masked: 'x', index: 0 },
    { text: '456789', masked: null },
  ]);
});

test('textNodes returns plain parts, never markup: HTML in content stays text', () => {
  const html = '<img src=x onerror="alert(1)"><script>alert(2)</script>&amp;';
  const parts = textNodes(html, [{ start: 5, end: 10, label: 'token' }]);
  assert.equal(parts.map((p) => p.text).join(''), html, 'the text comes back as it went in, unescaped and unwrapped');
  for (const p of parts) {
    assert.deepEqual(Object.keys(p).filter((k) => !['text', 'masked', 'index'].includes(k)), []);
    assert.equal(typeof p.text, 'string');
  }
  assert.ok(!parts.map((p) => p.text).join('').includes('class="mask"'), 'no markup is added');
});

// A tiny stand-in for `document` that records how nodes are filled and refuses innerHTML.
function fakeDoc() {
  const made = [];
  const el = (tag) => {
    const node = { tag, children: [], className: '', attrs: {}, textContent: '' };
    node.append = (...c) => node.children.push(...c);
    node.appendChild = (c) => (node.children.push(c), c);
    node.setAttribute = (k, v) => (node.attrs[k] = String(v));
    Object.defineProperty(node, 'innerHTML', {
      set() {
        throw new Error('innerHTML used for content');
      },
    });
    made.push(node);
    return node;
  };
  return {
    made,
    createElement: el,
    createTextNode: (text) => ({ tag: '#text', text }),
    createDocumentFragment: () => el('#fragment'),
  };
}

test('textFragment builds text nodes and mask spans with textContent only', () => {
  const doc = fakeDoc();
  const html = 'run <b>x</b> with ‹api key hidden›';
  const masked = [{ start: 18, end: 34, label: 'api key' }];
  const frag = textFragment(textNodes(html, masked), doc, { offset: 0 });
  const flat = [];
  const walk = (n) => {
    flat.push(n);
    (n.children || []).forEach(walk);
  };
  walk(frag);
  const texts = flat.filter((n) => n.tag === '#text').map((n) => n.text);
  assert.equal(texts[0], 'run <b>x</b> with ');
  const mask = flat.find((n) => n.className === 'tr-mask');
  assert.ok(mask, 'a mask span');
  assert.equal(mask.attrs['data-index'], '0');
  assert.equal(mask.attrs['data-offset'], '0');
  const label = flat.find((n) => n.className === 'tr-mask-text');
  assert.equal(label.textContent, '‹api key hidden›');
  const show = flat.find((n) => n.tag === 'button');
  assert.equal(show.textContent, 'show');
});

test('traceview.js builds no HTML from text, content or value (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // Every innerHTML assignment, up to the end of its statement.
  const sets = [...src.matchAll(/\binnerHTML\s*\+?=\s*([\s\S]*?);\s*\n/g)].map((m) => m[1]);
  assert.ok(sets.length > 0, 'the audit sees the assignments it checks');
  for (const rhs of sets)
    assert.doesNotMatch(rhs, /\b(text|content|value)\b/, `innerHTML built from content: ${rhs.slice(0, 80)}`);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|DOMParser|createContextualFragment/);
  assert.match(src, /textNodes\(/);
  assert.match(src, /\.textContent\s*=/);
});

test('fmtDur reads like the mockup', () => {
  assert.equal(fmtDur(40), '40 ms');
  assert.equal(fmtDur(4100), '4.1 s');
  assert.equal(fmtDur(130000), '2 m 10 s');
  assert.equal(fmtDur(42 * 60000), '42 m');
  assert.equal(fmtDur(65 * 60000), '1 h 5 m');
  assert.equal(fmtDur(0), '—');
  assert.equal(fmtDur(null), '—');
});

test('trIsLive: poll while the last span runs or the session ended under 10 minutes ago', () => {
  const now = 10 * 3600e3;
  const sk = (end, status = 'ok') => ({ session: { end }, turns: [], spans: [{ id: 'a', start: 1, end, status }] });
  assert.equal(trIsLive(sk(now - 5 * 60e3), now), true);
  assert.equal(trIsLive(sk(now - 2 * 3600e3), now), false);
  assert.equal(trIsLive(sk(now - 2 * 3600e3, 'running'), now), true);
  assert.equal(trIsLive(null, now), false);
});

test('trLivePlan: a changed file is always adopted; only a new shape repaints', () => {
  const sk = (n, end, ids = 'a') => ({ session: {}, turns: [{ index: 0 }], spans: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, text: `ci_${ids}${i}`, start: i, end, status: 'ok' })) });
  const cur = sk(3, 10, 'a');
  // Lines that make no span (attachment, mode, ...) grew the file: same shape, new content ids.
  assert.deepEqual(trLivePlan(cur, { changed: true, skeleton: sk(3, 10, 'b') }), { adopt: true, repaint: false });
  assert.deepEqual(trLivePlan(cur, { changed: true, skeleton: sk(4, 12, 'b') }), { adopt: true, repaint: true });
  assert.deepEqual(trLivePlan(cur, { changed: true, skeleton: sk(3, 11, 'b') }), { adopt: true, repaint: true });
  assert.deepEqual(trLivePlan(cur, { changed: false, cursor: 'x' }), { adopt: false, repaint: false });
  assert.deepEqual(trLivePlan(cur, { changed: true }), { adopt: false, repaint: false });
  assert.deepEqual(trLivePlan(null, { changed: true, skeleton: cur }), { adopt: false, repaint: false });
});
