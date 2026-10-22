// The trace explorer page's pure helpers, without a browser: the tree rows, the map nodes, the text parts
// content is drawn from (S1), and an audit of public/traceview.js for HTML built from content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { traceDemo } = require('../lib/demo');
const {
  treeRows,
  mapNodes,
  textNodes,
  textFragment,
  fmtDur,
  trIsLive,
  trLivePlan,
  trNavKey,
  trPrimary,
  trColor,
  trSrc,
  trBadges,
  trCritical,
  trCpMs,
  trSpanFacts,
  trCause,
  trAncestors,
  trDepRows,
  trOffNote,
  trStartCollapsed,
  trNameParts,
  evalRows,
  turnEvalSummary,
  spanEvalBadges,
  trJudgeBanner,
  trFeedbackMark,
  trCanAct,
  trNextRating,
  trRateBody,
  trEvalWhy,
  trNoteSaved,
  trMarkQueue,
} = require('../public/traceview.js');
const { EVALUATORS } = require('../lib/evals/registry');

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

// A stand-in for an element: `closest` answers for the selectors listed (and #tr-app when inside the explorer).
const el = (inApp, ...matches) => ({ closest: (sel) => (sel === '#tr-app' ? inApp : sel.split(',').some((x) => matches.includes(x.trim()))) || null });
test('trNavKey: j/k and the arrows only inside the explorer or on the page, never with Shift, not on tabs or range buttons', () => {
  const body = { closest: () => null };
  const page = [body];
  const key = (k, target, extra = {}) => trNavKey({ key: k, target, ...extra }, page);
  const row = el(true);
  assert.equal(key('j', row), 'down');
  assert.equal(key('k', row), 'up');
  assert.equal(key('ArrowLeft', row), 'prev');
  assert.equal(key('ArrowRight', body), 'next', 'focus on the page itself');
  // Outside the explorer (the sidebar, the top bar) nothing moves.
  assert.equal(key('j', el(false)), null);
  assert.equal(key('ArrowRight', el(false)), null);
  // Shift and the other modifiers are left alone.
  for (const mod of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey']) assert.equal(key('j', row, { [mod]: true }), null, mod);
  assert.equal(key('ArrowLeft', row, { shiftKey: true }), null);
  // Arrows keep their meaning on tabs, the range buttons, the chip row and the splitter; j/k still move there.
  for (const sel of ['[role="tab"]', '.tr-seg', '.tr-chips', '#tr-split']) {
    assert.equal(key('ArrowLeft', el(true, sel)), null, sel);
    assert.equal(key('j', el(true, sel)), 'down', sel);
  }
  // Never while typing.
  assert.equal(key('j', el(true, 'input')), null);
  assert.equal(key('Enter', row), null);
  assert.equal(trNavKey(null, page), null);
});

test('trPrimary: the splitter drags with the main button only', () => {
  assert.equal(trPrimary({ button: 0 }), true);
  assert.equal(trPrimary({ button: 2 }), false, 'right click');
  assert.equal(trPrimary({ button: 1 }), false, 'middle click');
  assert.equal(trPrimary(null), false);
});

test('lookups by a value from a log use own keys only', () => {
  for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(trColor({ kind, status: 'ok' }), '#8f98cc', kind);
    const [abbr, color] = trSrc(kind);
    assert.equal(typeof abbr, 'string', kind);
    assert.equal(color, '#8f98cc', kind);
  }
  const b = trBadges({ status: 'error', signals: ['constructor', 'toString'] });
  assert.deepEqual(b.map((x) => x.label), ['error', 'toString']);
  assert.ok(b.every((x) => typeof x.label === 'string'));
  assert.equal(trColor({ kind: 'tool', status: 'ok' }), '#ffb547');
  assert.deepEqual(trSrc('codex').slice(0, 2), ['CX', '#10a37f']);
});

test('trIsLive: sources that never change through live are not polled', () => {
  const now = 10 * 3600e3;
  const sk = (source, status = 'ok') => ({ session: { source, end: now - 60e3 }, turns: [], spans: [{ id: 'a', start: 1, end: now - 60e3, status }] });
  for (const src of ['gateway', 'kiro', 'gemini', 'antigravity']) {
    assert.equal(trIsLive(sk(src), now), false, src);
    assert.equal(trIsLive(sk(src, 'running'), now), false, `${src} running`);
  }
  for (const src of ['claude', 'codex']) assert.equal(trIsLive(sk(src), now), true, src);
});

test('trOffNote: an up-front notice when content is off (S10)', () => {
  assert.match(trOffNote({ content: false }), /Content viewing is off/);
  assert.equal(trOffNote({ content: true }), '');
  assert.equal(trOffNote(null), '');
});

test('the halves stack by window width at 1100 px, not by the deck width', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /@container trace \(max-width: 1100px\)/);
  const m = /@media \(max-width: 1100px\) \{\s*\.trace-app\.holo-deck \{\s*grid-template-columns: minmax\(0, 1fr\);/.exec(css);
  assert.ok(m, 'the stacking rule is a viewport media query');
});

test('trStartCollapsed: a stored choice wins; without one a narrow explorer half starts with the list as icons', () => {
  assert.equal(trStartCollapsed('1', 1200), true, 'the user collapsed it');
  assert.equal(trStartCollapsed('0', 500), false, 'the user opened it, even when narrow');
  assert.equal(trStartCollapsed('', 599), true, '1280 px with the sidebar open');
  assert.equal(trStartCollapsed(null, 759), true);
  assert.equal(trStartCollapsed('', 760), false);
  assert.equal(trStartCollapsed('', 900), false);
  assert.equal(trStartCollapsed('', 0), false, 'not measured yet: keep the list');
  assert.equal(trStartCollapsed(undefined, NaN), false);
});

test('a narrow tree drops the timeline column and keeps the span name and the time', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const m = /@container trtree \(max-width: 460px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, 'a 460 px rule for the tree');
  assert.match(m[1], /grid-template-columns: minmax\(0, 1fr\) 56px;/);
  assert.match(m[1], /\.tr-track,\s*\.tr-cols \.tr-tl \{\s*display: none;/);
});

test('trNameParts: a tool call splits into its operation and its tool name; other names stay whole', () => {
  assert.deepEqual(trNameParts('execute_tool · Read'), ['execute_tool · ', 'Read']);
  assert.deepEqual(trNameParts('chat · claude-opus-5-5'), ['', 'chat · claude-opus-5-5']);
  assert.deepEqual(trNameParts('Explore'), ['', 'Explore']);
  assert.deepEqual(trNameParts(null), ['', '']);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /@container trtree \(max-width: 400px\) \{\s*\.tr-row \.tr-op \{\s*display: none;/);
});

// ---- local evals in the explorer ----
// The evaluator list as GET /api/evals/evaluators gives it to the page.
const EVS = EVALUATORS.map(({ id, kind, scope, title, labels, pass }) => ({ id, kind, scope, title, labels, pass }));
const res = (evaluator, label, extra = {}) => {
  const e = EVALUATORS.find((x) => x.id === evaluator);
  return {
    evaluator,
    kind: e ? e.kind : 'judge',
    scope: e ? e.scope : 'turn',
    turn: e && e.scope === 'session' ? null : 0,
    label,
    score: null,
    pass: !!e && label === e.pass,
    explanation: null,
    judge: e && e.kind === 'judge' ? { kind: 'ollama', model: 'qwen3:8b', provider: 'ollama' } : null,
    trimmed: false,
    evidence: [],
    ts: 1,
    ...extra,
  };
};

test('evalRows: the pass label is pass, the last label is fail, anything between is mid', () => {
  const rows = evalRows(
    [
      res('task_completion', 'complete'),
      res('tool_selection', 'questionable'),
      res('relevance', 'off-topic'),
      res('secret_leak', 'leaked'),
      res('prompt_injection', 'local'),
      res('faithfulness', 'faithful'),
    ],
    EVS,
  );
  const tone = Object.fromEntries(rows.map((r) => [r.id, r.tone]));
  assert.deepEqual(tone, {
    task_completion: 'pass',
    tool_selection: 'mid',
    relevance: 'fail',
    secret_leak: 'fail',
    prompt_injection: 'mid',
    faithfulness: 'pass',
  });
  // Failing first, then the middle ones, then the passes; each group in the registry's order.
  assert.deepEqual(
    rows.map((r) => r.id),
    ['secret_leak', 'relevance', 'prompt_injection', 'tool_selection', 'faithfulness', 'task_completion'],
  );
  const leak = rows.find((r) => r.id === 'secret_leak');
  assert.equal(leak.title, 'Secret leak');
  assert.equal(leak.label, 'leaked');
  assert.equal(leak.model, 'code', 'a code evaluator has no model');
  assert.equal(rows.find((r) => r.id === 'faithfulness').model, 'qwen3:8b');
});

test('evalRows: session verdicts after the turn ones, explanation and trimming kept, odd input tolerated', () => {
  const rows = evalRows(
    [
      res('user_frustration', 'some', { explanation: 'Two corrections.' }),
      res('faithfulness', 'unfaithful', { explanation: 'Claims a test that never ran.', trimmed: true, score: 0 }),
      res('made_up', 'odd', { pass: false }),
      null,
      { evaluator: 42 },
      res('relevance', 'relevant', { explanation: null }),
    ],
    EVS,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['faithfulness', 'made_up', 'relevance', 'user_frustration'],
  );
  const f = rows[0];
  assert.equal(f.explanation, 'Claims a test that never ran.');
  assert.equal(f.trimmed, true);
  assert.equal(f.score, 0);
  assert.equal(rows[1].title, 'made_up', 'an evaluator the page does not know shows its id');
  assert.equal(rows[1].tone, 'fail');
  assert.equal(rows[2].explanation, null, 'content off: the page says it is hidden');
  assert.equal(rows[3].scope, 'session');
  assert.equal(rows[3].tone, 'mid');
  assert.deepEqual(evalRows(null, null), []);
  assert.equal(evalRows([res('secret_leak', 'leaked')], null)[0].tone, 'fail', 'without the list: pass or fail');
  // Own keys only: an evaluator id from a log is never a prototype lookup.
  assert.equal(evalRows([res('constructor', 'x')], EVS)[0].title, 'constructor');
});

test('turnEvalSummary: how many verdicts, how many pass, which fail', () => {
  const sum = turnEvalSummary([
    res('secret_leak', 'leaked'),
    res('tool_loop', 'none'),
    res('faithfulness', 'faithful'),
    res('task_completion', 'partial'),
    res('relevance', 'relevant'),
    null,
  ]);
  assert.deepEqual(sum, { judged: 5, passed: 3, failing: ['secret_leak', 'task_completion'] });
  assert.deepEqual(turnEvalSummary([]), { judged: 0, passed: 0, failing: [] });
  assert.deepEqual(turnEvalSummary(undefined), { judged: 0, passed: 0, failing: [] });
});

test('spanEvalBadges: a tool span gets the failing label of a code verdict that names its tool', () => {
  const results = [
    res('secret_leak', 'leaked', { evidence: [{ tool: 'Bash', label: 'Anthropic API key' }] }),
    res('tool_loop', 'loop', { evidence: [{ tool: 'Read', label: 'same file read 4 times' }] }),
    res('prompt_injection', 'local', { evidence: [{ tool: 'Bash', label: 'ignore previous' }] }),
    res('risky_command', 'safe', { evidence: [{ tool: 'Bash', label: 'rm' }] }),
    res('non_existent_target', 'hallucinated', { evidence: [{ tool: null, label: 'missing file' }] }),
    res('faithfulness', 'unfaithful', { evidence: [{ tool: 'Bash', label: 'x' }] }),
  ];
  const bash = { id: 'a', kind: 'tool', name: 'execute_tool Bash', tool: { name: 'Bash' } };
  const b = spanEvalBadges(bash, results, EVS);
  assert.deepEqual(
    b.map((x) => [x.label, x.tone]),
    [
      ['leaked', 'bad'],
      ['local', 'warn'],
    ],
    'failing code verdicts only: a pass, a judge verdict and a null tool add nothing',
  );
  assert.match(b[0].title, /Secret leak/);
  assert.deepEqual(
    spanEvalBadges({ kind: 'tool', tool: { name: 'Read' } }, results, EVS).map((x) => x.label),
    ['loop'],
  );
  // The same works for a map node, which carries the tool the same way.
  assert.deepEqual(
    spanEvalBadges({ kind: 'tool', label: 'execute_tool · Read', tool: { name: 'Read' }, count: 3 }, results).map(
      (x) => x.label,
    ),
    ['loop'],
  );
  assert.deepEqual(spanEvalBadges({ kind: 'chat', tool: { name: 'Bash' } }, results), [], 'not a tool span');
  assert.deepEqual(spanEvalBadges({ kind: 'tool', tool: null }, results), []);
  assert.deepEqual(spanEvalBadges({ kind: 'tool', tool: { name: 'Grep' } }, results), []);
  assert.deepEqual(spanEvalBadges(null, results), []);
  assert.deepEqual(spanEvalBadges(bash, null), []);
  // Two pieces of evidence for one tool give one badge.
  const twice = [res('secret_leak', 'leaked', { evidence: [{ tool: 'Bash' }, { tool: 'Bash' }] })];
  assert.equal(spanEvalBadges(bash, twice).length, 1);
});

test('trNavKey: g, b and n rate the turn and open the note, never while typing or with a modifier', () => {
  const body = { closest: () => null };
  const key = (k, target, extra = {}) => trNavKey({ key: k, target, ...extra }, [body]);
  const row = el(true);
  assert.equal(key('g', row), 'good');
  assert.equal(key('b', row), 'bad');
  assert.equal(key('n', body), 'note');
  assert.equal(key('g', el(false)), null, 'outside the explorer');
  for (const sel of ['input', 'textarea', 'select']) {
    for (const k of ['g', 'b', 'n']) assert.equal(key(k, el(true, sel)), null, `${k} in ${sel}`);
  }
  for (const mod of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey'])
    assert.equal(key('b', row, { [mod]: true }), null, mod);
  // On a tab the letters still work (only the arrows belong to the tabs).
  assert.equal(key('g', el(true, '[role="tab"]')), 'good');
});

test('trJudgeBanner: a slim line when the judge waits or is paused, nothing when it runs', () => {
  const ok = { judge: { ok: true, waiting: false, reason: null }, paused: null, queue: 0 };
  assert.equal(trJudgeBanner(ok), null);
  assert.equal(trJudgeBanner(null), null);
  const waiting = (reason) => trJudgeBanner({ judge: { ok: false, waiting: true, reason } });
  const none = waiting('Install or start Ollama, or choose a provider');
  assert.equal(none.text, 'Judge waiting: install or start Ollama, or choose a provider in');
  assert.equal(none.waiting, true);
  const confirm = waiting('Confirm the preview before sending to openrouter');
  assert.equal(confirm.text, 'Judge waiting: confirm the preview before sending to openrouter ·');
  const back = waiting('Judge provider unavailable, retrying in 4 min');
  assert.match(back.text, /^Judge waiting: judge provider unavailable, retrying in 4 min/);
  const capped = trJudgeBanner({ ...ok, paused: 'daily cap' });
  assert.match(capped.text, /^Judging paused: daily cap reached, resumes tomorrow/);
  assert.match(trJudgeBanner({ ...ok, paused: 'cost cap' }).text, /^Judging paused: cost cap reached/);
  const off = trJudgeBanner({ ...ok, paused: 'judge off' });
  assert.match(off.text, /^Judging is off/);
  assert.equal(off.waiting, true, 'nothing would judge a session now');
  assert.equal(capped.waiting, false, 'a capped run still queues for tomorrow');
  // A reason is shown as text, and a long one is cut.
  const long = trJudgeBanner({ judge: { waiting: true, reason: 'x'.repeat(500) } });
  assert.ok(long.text.length < 200);
});

test('trFeedbackMark: thumbs down wins over thumbs up, nothing without a rating', () => {
  assert.equal(trFeedbackMark({ good: 2, bad: 0 }).mark, '👍');
  assert.equal(trFeedbackMark({ good: 1, bad: 1 }).mark, '👎');
  assert.equal(trFeedbackMark({ good: 1, bad: 1 }).title, 'Your feedback: 1 good, 1 bad');
  assert.equal(trFeedbackMark({ good: 0, bad: 0 }), null);
  assert.equal(trFeedbackMark(null), null);
});

test('the eval code builds no HTML from an explanation, a note, a label or a title (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // Every innerHTML assignment, with each esc(...) call taken out: what is left may not name such a value.
  const sets = [...src.matchAll(/\binnerHTML\s*\+?=\s*([\s\S]*?);\s*\n/g)].map((m) => m[1]);
  const unescaped = (s) => s.replace(/\besc\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, 'ESC');
  for (const rhs of sets)
    assert.doesNotMatch(
      unescaped(rhs),
      /\b(explanation|note|label|title)\b/,
      `innerHTML built from: ${rhs.slice(0, 80)}`,
    );
  // In a line of markup, such a value is always inside esc().
  for (const line of src.split('\n').filter((l) => /<[a-z]/i.test(l)))
    for (const m of unescaped(line).matchAll(/\$\{([^{}]*)\}/g))
      assert.doesNotMatch(m[1], /\.(explanation|note|label|title)\b/, `unescaped in markup: ${m[0]}`);
  // The eval pane and the note are filled with textContent and value only.
  assert.match(src, /return \{ text: r\.explanation, quiet: false \}/);
  assert.match(src, /line\.textContent = why\.text;/);
  assert.doesNotMatch(src, /innerHTML[^;\n]*\b(evRows|evalRows|noteText)\b/);
});

// ---- review fixes: one action line, ratings pinned to the session on show ----
test('the action row stays on one line: the info text gives way, the buttons do not wrap', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const acts = /\n\.tr-acts \{([^}]*)\}/.exec(css);
  assert.ok(acts, 'a .tr-acts rule');
  assert.match(acts[1], /flex-wrap: nowrap;/);
  const info = /\n\.tr-dinfo \{([^}]*)\}/.exec(css);
  assert.match(info[1], /flex: 1 1 0;/);
  assert.match(info[1], /min-width: 0;/);
  assert.match(info[1], /text-overflow: ellipsis;/);
  assert.match(info[1], /white-space: nowrap;/);
  // With "Load next 64 KB" in a narrow row, Edit note and Judge keep their icons only.
  const compact = /\.tr-acts:has\(#tr-more:not\(\[hidden\]\)\) :is\(#tr-addnote, #tr-judge-run\) \.tr-bl \{/;
  assert.match(css, compact);
  const src = fs.readFileSync(SRC, 'utf8');
  for (const name of ['Good (g)', 'Bad (b)', 'Judge this session'])
    assert.match(src, new RegExp(`aria-label="${name.replace(/[()]/g, '\\$&')}"`), `${name} keeps a name as an icon`);
});

test('trCanAct: only once the skeleton on show belongs to the selected session', () => {
  assert.equal(trCanAct({ key: 'A', skKey: 'A', sk: {} }), true);
  assert.equal(trCanAct({ key: 'B', skKey: 'A', sk: {} }), false, 'a switch to B is still loading');
  assert.equal(trCanAct({ key: 'A', skKey: 'A', sk: null }), false, 'no skeleton');
  assert.equal(trCanAct({ key: null, skKey: null, sk: {} }), false);
  assert.equal(trCanAct(null), false);
});

test('trNextRating: the same rating again takes it back, another one replaces it', () => {
  assert.equal(trNextRating(null, 'good'), 'good');
  assert.equal(trNextRating('good', 'good'), null);
  assert.equal(trNextRating('bad', 'bad'), null);
  assert.equal(trNextRating('good', 'bad'), 'bad');
  assert.equal(trNextRating(undefined, 'bad'), 'bad');
});

test('trRateBody: a rating names the session and turn on show, and a key switch in flight blocks it', () => {
  const S = { key: 'A', skKey: 'A', sk: { turns: [{}, {}, {}] }, turn: 2 };
  assert.deepEqual(trRateBody(S, null, 'good'), { key: 'A', turn: 2, rating: 'good' });
  assert.deepEqual(trRateBody(S, 'good', 'good'), { key: 'A', turn: 2, rating: null });
  // The list selected B: S.key moved, the tree and S.turn are still A's.
  S.key = 'B';
  assert.equal(trRateBody(S, null, 'good'), null, 'nothing is sent for B with A\'s turn');
  S.skKey = 'B';
  assert.deepEqual(trRateBody(S, null, 'bad'), { key: 'B', turn: 2, rating: 'bad' });
  assert.equal(trRateBody(S, null, 'meh'), null);
});

test('trEvalWhy: the explanation, a hidden one, a missing one, or the evidence of a failing code check', () => {
  const judge = { kind: 'judge', tone: 'fail', explanation: null, evidence: [] };
  const said = trEvalWhy({ ...judge, explanation: 'Claims a test.' }, false);
  assert.deepEqual(said, { text: 'Claims a test.', quiet: false });
  assert.deepEqual(trEvalWhy(judge, true), { text: 'hidden while content viewing is off', quiet: true });
  assert.deepEqual(trEvalWhy(judge, false), { text: 'no explanation', quiet: true });
  const code = { kind: 'code', tone: 'fail', explanation: null, evidence: ['Bash: Anthropic API key'] };
  assert.deepEqual(trEvalWhy(code, true), { text: 'Bash: Anthropic API key', quiet: false });
  assert.equal(trEvalWhy({ ...code, tone: 'pass' }, false), null, 'a passing code check says nothing');
  assert.equal(trEvalWhy({ ...code, evidence: [] }, false), null);
});

test('trNoteSaved: a draft typed after the save stays, and the field is only refilled when nothing changed', () => {
  assert.deepEqual(trNoteSaved({ draft: 'abc', sent: 'abc', value: 'abc' }), { dropDraft: true, refill: true });
  // Typed on while the save was on its way.
  assert.deepEqual(trNoteSaved({ draft: 'abcd', sent: 'abc', value: 'abcd' }), { dropDraft: false, refill: false });
  assert.deepEqual(trNoteSaved({ draft: undefined, sent: 'abc', value: 'abc' }), { dropDraft: false, refill: true });
});

test('trMarkQueue: a key in flight is not asked twice; a refresh during the flight asks again after it', () => {
  const q = trMarkQueue();
  const none = () => false;
  q.want(['a', 'b', '', null], none);
  const first = q.take(50);
  assert.deepEqual(first, ['a', 'b']);
  q.want(['a', 'b', 'c'], none); // a repaint while a and b are on their way
  assert.deepEqual(q.take(50), ['c']);
  q.refresh('a'); // a rating changed for a, still in flight
  assert.deepEqual(q.done(first), ['a'], 'a goes again: the answer in flight is older than the change');
  assert.deepEqual(q.take(50), ['a']);
  q.want(['b'], (k) => k === 'b');
  assert.equal(q.size, 0, 'a key with a marker is not asked for');
  q.refresh('b');
  assert.deepEqual(q.take(1), ['b'], 'a refresh outside a flight just queues');
  assert.equal(q.take(50).length, 0);
});

test('analysis helpers: critical path, span facts, cause and dependency rows', () => {
  const an = {
    rootSpanId: 'r',
    criticalPath: [
      { spanId: 'r', start: 0, end: 100 },
      { spanId: 'b', start: 100, end: 1600 },
    ],
    selfTime: { r: 100, b: 1500 },
    rollup: { r: { tokensIn: 12000, tokensOut: 800, costUSD: 0.25, spans: 4, errors: 1 }, b: { tokensIn: 0, tokensOut: 0, costUSD: 0, spans: 1, errors: 1 } },
    rootCause: { spanId: 'b', name: 'execute_tool Bash', error: 'Exit code 1', onCriticalPath: true },
  };
  assert.deepEqual([...trCritical(an)], ['r', 'b']);
  assert.equal(trCritical(null).size, 0);
  assert.equal(trCpMs(an), 1600);
  assert.equal(trCpMs(null), 0);
  assert.deepEqual(trSpanFacts(an, 'r'), ['self 100 ms', 'branch $0.25 12k → 800 tok 1 error', 'on the critical path']);
  assert.deepEqual(trSpanFacts(an, 'b'), ['self 1.5 s', 'on the critical path']);
  assert.deepEqual(trSpanFacts(null, 'b'), []);
  const spans = new Map([['b', { id: 'b', kind: 'tool', name: 'execute_tool Bash' }]]);
  assert.deepEqual(trCause(an, spans), { id: 'b', line: 'Likely cause: execute_tool · Bash: Exit code 1 (on the critical path)' });
  assert.equal(trCause({ ...an, rootCause: null }, spans), null);
  assert.deepEqual(
    trDepRows({
      nodes: [
        { id: 'agent:a', kind: 'agent', label: 'a', count: 1 },
        { id: 'model:m', kind: 'model', label: 'm', count: 1 },
      ],
      edges: [{ from: 'agent:a', to: 'model:m', count: 3, errors: 1, p95Ms: 2300 }],
    }),
    [['agent a', 'model m', '3', '1', '2.3 s']],
  );
  assert.deepEqual(trDepRows(null), []);
});

test('the analysis UI fills the cause and the dependency table with text only (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /\$\('#tr-cause-msg'\)\.textContent = /);
  assert.match(src, /insertCell\(\)\.textContent = /);
  assert.doesNotMatch(src, /innerHTML[^;\n]*\b(trDepRows|trCause|cells)\b/);
});

test('trAncestors lists the ids above a span and survives cycles', () => {
  const m = new Map([
    ['a', { id: 'a', parent: null }],
    ['b', { id: 'b', parent: 'a' }],
    ['c', { id: 'c', parent: 'b' }],
    ['x', { id: 'x', parent: 'y' }],
    ['y', { id: 'y', parent: 'x' }],
    ['o', { id: 'o', parent: 'gone' }],
  ]);
  assert.deepEqual(trAncestors(m, 'c'), ['b', 'a']);
  assert.deepEqual(trAncestors(m, 'a'), []);
  assert.deepEqual(trAncestors(m, 'nope'), []);
  assert.deepEqual(trAncestors(m, 'x'), ['y']);
  assert.deepEqual(trAncestors(m, 'o'), ['gone']);
});

test('audit: Show opens collapsed ancestors, live adopt refreshes the analysis, deps ignore stale replies', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /trAncestors\(S\.spans, id\)\.filter\(\(a\) => S\.collapsed\.delete\(a\)\)/);
  const live = src.slice(src.indexOf('async function pollLive'));
  assert.match(live, /S\.an = r\.skeleton\.analysis \|\| null;\s+S\.cp = trCritical\(S\.an\);[\s\S]*?paintCause\(\);/);
  const deps = src.slice(src.indexOf('async function loadDeps'), src.indexOf('// The session'));
  assert.match(deps, /const my = \+\+S\.dreq/);
  assert.equal((deps.match(/my === S\.dreq|my !== S\.dreq/g) || []).length, 2);
});
