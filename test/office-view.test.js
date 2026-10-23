// The AI Office page's browser helpers (public/officeview.js, public/iso.js) are plain scripts, so they are
// loaded into a vm context and the pure parts are tested: which agents get a callout, and where callouts go.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(file, expr) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  return vm.runInNewContext(`${src}\n;(${expr})`, {});
}
const { calloutAgents } = load('officeview.js', '({ calloutAgents })');
const { placeLabels } = load('iso.js', '({ placeLabels })');

const ag = (id, kind, state, lastTs = 0) => ({ id, kind, state, lastTs });
const ids = (xs) => Array.from(xs, (a) => a.id);
const pos = (xs) => Array.from(xs, (l) => [l.x, l.y]);

test('calloutAgents folds idle subagents into the summary and keeps every other agent', () => {
  const agents = [
    ag('s-idle', 'session', 'idle'),
    ag('guest', 'guest', 'running'),
    ag('sub-idle-1', 'subagent', 'idle'),
    ag('sub-idle-2', 'subagent', 'idle'),
    ag('sub-work', 'subagent', 'working'),
  ];
  const { shown, hidden } = calloutAgents(agents);
  assert.deepEqual(ids(hidden), ['sub-idle-1', 'sub-idle-2']);
  assert.deepEqual(ids(shown).sort(), ['guest', 's-idle', 'sub-work']);
});

test('calloutAgents ranks needs-you, then working, thinking, sessions and guests, then the rest', () => {
  const agents = [
    ag('done-sub', 'subagent', 'done'),
    ag('idle-session', 'session', 'idle'),
    ag('thinking', 'subagent', 'thinking'),
    ag('working', 'session', 'working'),
    ag('guest', 'guest', 'running'),
    ag('waiting', 'session', 'waiting'),
    ag('approval', 'session', 'approval'),
  ];
  const { shown } = calloutAgents(agents);
  assert.deepEqual(ids(shown).slice(0, 4), ['waiting', 'approval', 'working', 'thinking']);
  assert.deepEqual(ids(shown).slice(4, 6).sort(), ['guest', 'idle-session']);
  assert.equal(ids(shown)[6], 'done-sub');
});

test('calloutAgents caps the total at 14 and keeps a slot for the lounge summary', () => {
  const crowd = [];
  for (let i = 0; i < 58; i++) crowd.push(ag(`sub${i}`, 'subagent', 'idle'));
  for (let i = 0; i < 20; i++) crowd.push(ag(`w${i}`, 'subagent', 'working', i));
  for (let i = 0; i < 3; i++) crowd.push(ag(`n${i}`, 'session', 'waiting'));
  const { shown, hidden } = calloutAgents(crowd);
  assert.equal(hidden.length, 58);
  assert.equal(shown.length, 13); // 13 + 1 lounge summary = 14
  assert.deepEqual(ids(shown).slice(0, 3).sort(), ['n0', 'n1', 'n2']);
  assert.equal(ids(shown)[3], 'w19'); // among equals the most recent wins
  assert.equal(calloutAgents(crowd.filter((a) => a.state !== 'idle')).shown.length, 14);
  assert.equal(calloutAgents(crowd, 5).shown.length, 4);
});

const box = (x, y, w = 120) => ({ x, y, w });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && Math.abs(a.y - b.y) < 19;
const area = { W: 800, H: 500 };

test('placeLabels leaves a few callouts where the single-pass stacking put them', () => {
  const out = placeLabels([box(100, 300), box(400, 280)], [], area);
  assert.deepEqual(pos(out).sort(), [
    [100, 300],
    [400, 280],
  ]);
  // Two on top of each other still stack upward by 22px.
  const stacked = placeLabels([box(100, 300), box(110, 300)], [], area);
  assert.deepEqual(pos(stacked).map((p) => p[1]).sort(), [278, 300]);
});

test('placeLabels drops what cannot fit instead of pushing it off the canvas', () => {
  const column = Array.from({ length: 40 }, () => box(300, 400));
  const out = placeLabels(column, [], area);
  assert.ok(out.length > 5 && out.length < 40);
  for (const l of out) assert.ok(l.y - 10 >= 4 && l.y + 10 <= area.H - 4, `y ${l.y} is on the canvas`);
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) assert.ok(!overlap(out[i], out[j]));
});

test('placeLabels keeps callouts inside the canvas horizontally', () => {
  const [left, right] = placeLabels([box(-50, 200), box(790, 100)], [], area);
  assert.ok(left.x >= 6 && right.x + right.w <= area.W - 6);
});

test('placeLabels never covers an overlay box such as the page heading', () => {
  const heading = { x: 10, y: 10, w: 360, h: 60 };
  const crowd = Array.from({ length: 12 }, (_, i) => box(40 + (i % 3) * 20, 120 + i * 3));
  const out = placeLabels(crowd, [], { ...area, avoid: [heading] });
  assert.ok(out.length > 0);
  for (const l of out) {
    const across = l.x < heading.x + heading.w && heading.x < l.x + l.w;
    const hit = across && l.y + 10 > heading.y && l.y - 11 < heading.y + heading.h;
    assert.ok(!hit, `callout at ${l.x},${l.y} covers the heading`);
  }
});

// The Installed AI tools cards: their status line and CPU, memory and uptime follow the live data every poll, so a
// server started from the card's own Start button shows as running without a page reload.
const { squadLive, squadPatch } = vm.runInNewContext(
  `${fs.readFileSync(path.join(__dirname, '..', 'public', 'officeview.js'), 'utf8')}\n;({ squadLive, squadPatch })`,
  { ago: () => '5m ago', fmtN: (n) => String(n), dur: (s) => `${s}s` },
);

test('squadLive: running, idle with logs, installed, and stats only for a tool without logs', () => {
  const r = { processes: 2, cpu: 1.25, memMB: 26, uptimeSec: 89 };
  assert.deepEqual(JSON.parse(JSON.stringify(squadLive(r, true, null))), {
    cls: 'running',
    text: 'Running now · 2 processes',
    stats: ['1.3%', '26 MB', '89s'],
  });
  assert.equal(squadLive({ ...r, processes: 1 }, true, null).text, 'Running now · 1 process');
  assert.deepEqual(JSON.parse(JSON.stringify(squadLive(null, true, null))), {
    cls: 'idle',
    text: 'Installed · not running',
    stats: ['—', '—', '—'],
  });
  const t = { lastActive: 1 };
  assert.equal(squadLive(null, true, t).text, 'Idle · last active 5m ago');
  assert.equal(squadLive(null, true, t).stats, null);
  assert.equal(squadLive(null, false, null).cls, 'off');
});

// A stand-in card: a status line (an <i> and a text node) and three stat values.
function fakeCard(id) {
  const text = { nodeType: 3, nodeValue: 'Installed · not running' };
  const status = { className: 'status idle', lastChild: text };
  const bs = [0, 1, 2].map(() => ({ textContent: '—' }));
  return {
    dataset: { appCard: id },
    querySelector: (s) => (s === '.status' ? status : null),
    querySelectorAll: (s) => (s === '.agent-stats b' ? bs : []),
    status,
    text,
    bs,
  };
}

test('squadPatch: a card follows the live data in place, as text', () => {
  const ollama = fakeCard('ollama');
  const claude = fakeCard('claude');
  const root = { querySelectorAll: (s) => (s === '[data-app-card]' ? [ollama, claude] : []) };
  const data = { apps: [{ id: 'ollama', processes: 1, cpu: 0, memMB: 26, uptimeSec: 89 }], installed: ['ollama', 'claude'] };
  squadPatch(root, data, [{ id: 'claude', lastActive: 1 }]);
  assert.equal(ollama.status.className, 'status running');
  assert.equal(ollama.text.nodeValue, 'Running now · 1 process');
  assert.deepEqual(ollama.bs.map((b) => b.textContent), ['0.0%', '26 MB', '89s']);
  assert.equal(claude.text.nodeValue, 'Idle · last active 5m ago');
  assert.deepEqual(claude.bs.map((b) => b.textContent), ['—', '—', '—'], 'a tool with logs keeps its own stats');
  squadPatch(root, { apps: [], installed: ['ollama'] }, []);
  assert.equal(ollama.status.className, 'status idle');
  assert.equal(ollama.text.nodeValue, 'Installed · not running');
  assert.deepEqual(ollama.bs.map((b) => b.textContent), ['—', '—', '—']);
  squadPatch(root, null, null); // no live data yet: nothing throws
});
