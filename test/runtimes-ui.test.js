// AI Office's Start and Stop: the pure helpers of public/runtimesview.js without a browser, its nodes built against a
// stand-in document that refuses innerHTML, and an audit of the file (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  rtStatus,
  rtHowNote,
  rtButton,
  rtConfirmText,
  rtResultText,
  rtErrorText,
  rtLogLines,
  rtCardPlan,
  rtActionRow,
  rtCard,
  rtModelsText,
  RT_CARD_IDS,
} = require('../public/runtimesview');

const SRC = path.join(__dirname, '..', 'public', 'runtimesview.js');
const R = (over = {}) => ({
  id: 'ollama',
  name: 'Ollama',
  preset: true,
  installed: true,
  running: true,
  healthy: true,
  how: 'process',
  pid: 4242,
  startTime: 1,
  children: 1,
  port: 11434,
  canStart: false,
  canStop: true,
  reason: null,
  approved: true,
  error: null,
  ...over,
});

test('rtButton: Stop while running, Start while stopped, a label while a request is out, none when not allowed', () => {
  assert.deepEqual(rtButton(R()), { action: 'stop', label: 'Stop', disabled: false });
  assert.deepEqual(rtButton(R({ running: false, canStop: false, canStart: true })), {
    action: 'start',
    label: 'Start',
    disabled: false,
  });
  assert.deepEqual(rtButton(R(), 'start'), { action: 'start', label: 'Starting…', disabled: true });
  assert.deepEqual(rtButton(R(), 'stop'), { action: 'stop', label: 'Stopping…', disabled: true });
  assert.equal(rtButton(R({ canStop: false, reason: 'runtime control is off on this server' })), null);
  assert.equal(rtButton(R({ running: false, canStart: false })), null);
  assert.equal(rtButton(null), null);
});

test('rtStatus and rtHowNote: the status line and how a server runs', () => {
  assert.deepEqual(rtStatus(R()), { cls: 'running', text: 'Server running · port 11434 · 1 model process' });
  assert.equal(rtStatus(R({ healthy: false, children: 2 })).text, 'Server running · port 11434 · not answering · 2 model processes');
  assert.deepEqual(rtStatus(R({ running: false })), { cls: 'idle', text: 'Server stopped · port 11434' });
  assert.deepEqual(rtStatus(R({ running: false, installed: false })), { cls: 'off', text: 'Not installed' });
  assert.equal(rtHowNote(R()), 'started outside ZAAFPulse');
  assert.equal(rtHowNote(R({ how: 'service' })), 'brew service');
  assert.equal(rtHowNote(R({ how: 'app' })), 'app');
  assert.equal(rtHowNote(R({ how: 'zaafpulse' })), 'started here');
  assert.equal(rtHowNote(R({ how: 'system' })), 'managed by the system');
  assert.equal(rtHowNote(R({ how: '<b>x</b>' })), '');
  assert.equal(rtHowNote(R({ running: false })), '');
});

test('rtConfirmText, rtResultText and rtErrorText', () => {
  assert.equal(rtConfirmText(R()), 'Stop Ollama? Models it has loaded are unloaded.');
  assert.equal(rtResultText('start', { state: 'running' }), 'Started.');
  assert.equal(rtResultText('start', { state: 'starting', note: 'started, not answering yet' }), 'Started, not answering yet.');
  assert.equal(rtResultText('stop', { state: 'stopped' }), 'Stopped.');
  assert.equal(rtResultText('stop', { state: 'stopping', note: 'still shutting down' }), 'Still shutting down.');
  assert.equal(rtResultText('start', { state: 'running', demo: true }), 'Demo mode: nothing was started.');
  assert.equal(rtResultText('stop', { state: 'stopped', demo: true }), 'Demo mode: nothing was stopped.');
  assert.equal(rtErrorText({ status: 409, message: 'the process changed; refresh' }), 'The process changed; refresh (409)');
  assert.equal(rtErrorText({ status: 403, message: 'approve it in Settings first' }), 'Approve it in Settings first (403)');
  assert.equal(rtErrorText({}), 'The request failed');
});

test('rtLogLines keeps at most 20 lines of text', () => {
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  assert.deepEqual(rtLogLines(many), many.slice(-20));
  assert.deepEqual(rtLogLines(['a\u0000b', 7, '<script>x</script>']), ['a b', '<script>x</script>']);
  assert.deepEqual(rtLogLines('nope'), []);
});

test('rtCardPlan: Ollama and LM Studio go on their cards when they have one, the rest get their own', () => {
  const list = [R(), R({ id: 'lmstudio' }), R({ id: 'localai' }), R({ id: 'qwen-local', preset: false }), null];
  const plan = rtCardPlan(list, ['ollama', 'lmstudio']);
  assert.deepEqual(plan.slots.map((r) => r.id), ['ollama', 'lmstudio']);
  assert.deepEqual(plan.own.map((r) => r.id), ['localai', 'qwen-local']);
  assert.deepEqual(rtCardPlan(list, ['ollama']).own.map((r) => r.id), ['lmstudio', 'localai', 'qwen-local']);
  assert.deepEqual(rtCardPlan(null, []), { slots: [], own: [] });
});

// A tiny stand-in for `document` that records how nodes are filled and refuses innerHTML.
function fakeDoc() {
  const el = (tag) => {
    const node = { tag, children: [], className: '', attrs: {}, textContent: '' };
    node.appendChild = (c) => (node.children.push(c), c);
    node.setAttribute = (k, v) => (node.attrs[k] = String(v));
    Object.defineProperty(node, 'innerHTML', {
      set() {
        throw new Error('innerHTML used for content');
      },
    });
    return node;
  };
  return { createElement: el, createTextNode: (text) => ({ tag: '#text', text }) };
}
const flat = (n, out = []) => {
  out.push(n);
  for (const c of n.children || []) flat(c, out);
  return out;
};
const texts = (n) => flat(n).map((x) => (x.tag === '#text' ? x.text : x.textContent)).filter(Boolean);

test('the action row: error and log lines are text, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const row = rtActionRow(fakeDoc(), R({ running: false, canStart: true }), {
    msg: `The command could not start ${evil} (502)`,
    tone: 'bad',
    log: [`error ${evil}`, 'second line'],
  });
  const all = flat(row);
  const btn = all.find((n) => n.tag === 'button');
  assert.equal(btn.textContent, 'Start');
  assert.equal(btn.attrs['data-rt-act'], 'start');
  assert.equal(btn.attrs['data-rt-id'], 'ollama');
  const msg = all.find((n) => n.className.includes('rt-msg'));
  assert.equal(msg.textContent, `The command could not start ${evil} (502)`);
  assert.equal(msg.attrs.role, 'status');
  const pre = all.find((n) => n.tag === 'pre');
  assert.equal(pre.textContent, `error ${evil}\nsecond line`);
  const off = rtActionRow(fakeDoc(), R({ canStop: false, reason: 'runtime control is off in Docker' }));
  assert.ok(!flat(off).some((n) => n.tag === 'button'), 'no button when control is off');
  assert.ok(texts(off).includes('Runtime control is off in Docker'));
});

test('a card of its own is built from text', () => {
  const card = rtCard(fakeDoc(), R({ id: 'localai', name: 'Local<b>AI</b>', port: 8080, children: 0 }));
  assert.equal(card.attrs['data-rt-card'], 'localai');
  const t = texts(card);
  assert.ok(t.includes('LOCAL<B>AI</B>'));
  assert.ok(t.includes('Running now'));
  assert.ok(t.includes('8080'));
  assert.ok(t.includes('Stop'));
});

test('runtimesview.js builds no HTML from server text (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // The only innerHTML is the app's own icon markup.
  const sets = [...src.matchAll(/\binnerHTML\s*\+?=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(sets, ['iconHtml']);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|DOMParser|createContextualFragment/);
  // No HTML template takes a value: markup in a template is static (the Settings shell), text goes in by textContent.
  for (const t of [...src.matchAll(/`[^`]*`/g)].map((m) => m[0]).filter((x) => /<[a-z]/.test(x)))
    assert.doesNotMatch(t, /\$\{/, `a template with markup takes a value: ${t.slice(0, 60)}`);
  assert.match(src, /\.textContent = text/);
});

test('the per-runtime UI state has no prototype, so an id such as constructor stays its own slot', () => {
  const { RT } = require('../public/runtimesview');
  assert.equal(Object.getPrototypeOf(RT.ui), null);
  assert.equal(RT.ui.constructor, undefined);
  assert.equal(RT.ui.__proto__, undefined);
});

test('styles: hidden wins over .btn in the runtimes form, and the command box shows several lines', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.rt-form \[hidden\] \{\s*display: none;\s*\}/, 'Cancel stays hidden in "Add a runtime" mode');
  const m = /\.rt-form textarea\.input \{([^}]*)\}/.exec(css);
  assert.ok(m, 'a rule for the command textarea');
  assert.match(m[1], /height: auto;/);
  assert.match(m[1], /min-height: 7\.5em;/);
});

// Models are loaded again on Start (lib/runtimes/models.js): the line under the action row says which.
const M = (over = {}) => ({ remembered: ['llama3.2:3b'], loading: false, loaded: [], failed: [], ...over });

test('rtModelsText: what a Start reloads, what is loading, what loaded and what could not', () => {
  const stopped = (models) => R({ running: false, canStart: true, models });
  assert.equal(rtModelsText(stopped(M())), 'Start reloads llama3.2:3b');
  assert.equal(rtModelsText(stopped(M({ remembered: ['a', 'b'] }))), 'Start reloads a and b');
  assert.equal(rtModelsText(stopped(M({ remembered: ['a', 'b', 'c', 'd'] }))), 'Start reloads a, b and 2 more');
  assert.equal(rtModelsText(stopped(M({ remembered: [] }))), '');
  assert.equal(rtModelsText(R({ models: M({ loading: true }) })), 'Loading llama3.2:3b…');
  assert.equal(rtModelsText(R({ models: M({ loaded: ['llama3.2:3b'] }) })), 'Model loaded: llama3.2:3b');
  assert.equal(rtModelsText(R({ models: M({ loaded: ['a', 'b'] }) })), 'Models loaded: a and b');
  assert.equal(
    rtModelsText(R({ models: M({ loaded: ['a'], failed: [{ name: 'b', error: 'not found' }] }) })),
    'Model loaded: a. Could not load b (not found)',
  );
  assert.equal(rtModelsText(R({ models: M() })), '', 'running with nothing reloaded says nothing');
  assert.equal(rtModelsText(R({ models: null })), '');
  assert.equal(rtModelsText(R()), '');
  assert.equal(rtModelsText(null), '');
});

test('the start result and the Stop confirmation name the reload', () => {
  // The models line says what is loading and stays current; the result does not repeat it and go stale.
  assert.equal(rtResultText('start', { state: 'running', reloading: ['llama3.2:3b'] }), 'Started.');
  assert.equal(rtResultText('start', { state: 'running', reloading: [] }), 'Started.');
  assert.equal(
    rtConfirmText(R({ models: M() })),
    'Stop Ollama? Its models are unloaded now and loaded again on the next Start.',
  );
  assert.equal(rtConfirmText(R({ models: null })), 'Stop Ollama? Models it has loaded are unloaded.');
});

test('the action row shows the models line as text', () => {
  const evil = '<b>x</b>';
  const row = rtActionRow(fakeDoc(), R({ running: false, canStart: true, models: M({ remembered: [evil] }) }));
  const line = flat(row).find((n) => n.className && n.className.includes('rt-models'));
  assert.equal(line.textContent, `Start reloads ${evil}`);
  const none = rtActionRow(fakeDoc(), R({ models: null }));
  assert.ok(!flat(none).some((n) => n.className && n.className.includes('rt-models')));
});

// The desktop apps (kind 'app': Claude Desktop, ChatGPT, Antigravity, Kiro) get the same row on their own cards.
const APP = (over = {}) =>
  R({ id: 'claude-desktop', name: 'Claude Desktop', kind: 'app', how: 'app', port: null, children: 3, ...over });

test('RT_CARD_IDS: the four desktop apps have a slot on their cards, next to Ollama and LM Studio', () => {
  for (const id of ['ollama', 'lmstudio', 'claude-desktop', 'chatgpt', 'antigravity', 'kiro'])
    assert.ok(RT_CARD_IDS.includes(id), id);
});

test('an app: "App open" or "App closed", no port, no model processes, no how note', () => {
  assert.deepEqual(rtStatus(APP()), { cls: 'running', text: 'App open' });
  assert.deepEqual(rtStatus(APP({ healthy: false })), { cls: 'running', text: 'App open' });
  assert.deepEqual(rtStatus(APP({ running: false, port: 1234 })), { cls: 'idle', text: 'App closed' });
  // Not found where it is opened from (or not on macOS): the reason line under the row says why.
  assert.deepEqual(rtStatus(APP({ running: false, installed: false })), { cls: 'off', text: '' });
  assert.equal(rtHowNote(APP()), '');
  assert.equal(rtHowNote(APP({ how: 'process' })), '');
});

test('an app: the Stop confirmation warns of the force-close, and the results say opened and closed', () => {
  assert.equal(
    rtConfirmText(APP()),
    'Quit Claude Desktop? If it is still open after 10 s it is force-closed; unsaved work or a running chat or agent can be lost.',
  );
  assert.equal(rtConfirmText(APP({ name: 'Kiro', id: 'kiro' })).slice(0, 11), 'Quit Kiro? ');
  const app = APP();
  assert.equal(rtResultText('start', { state: 'running' }, app), 'Opened.');
  assert.equal(rtResultText('start', { state: 'starting', note: 'opening, not up yet' }, app), 'Opening, not up yet.');
  assert.equal(rtResultText('start', { state: 'starting' }, app), 'Opening, not up yet.');
  assert.equal(rtResultText('stop', { state: 'stopped' }, app), 'Closed.');
  assert.equal(rtResultText('stop', { state: 'stopping', note: 'still shutting down' }, app), 'Still shutting down.');
  assert.equal(rtResultText('stop', { state: 'stopped', demo: true }, app), 'Demo mode: nothing was stopped.');
  // A model server keeps its own words.
  assert.equal(rtResultText('start', { state: 'running' }, R()), 'Started.');
  assert.equal(rtResultText('stop', { state: 'stopped' }, R({ kind: 'server' })), 'Stopped.');
});

test('rtCardPlan: an app never gets a card of its own, and a slots-only grid (the Overview) draws no own cards', () => {
  const list = [
    R(),
    APP(),
    APP({ id: 'chatgpt', name: 'ChatGPT' }),
    APP({ id: 'kiro', name: 'Kiro', reason: 'macOS only' }),
    R({ id: 'localai' }),
  ];
  const office = rtCardPlan(list, ['ollama', 'claude-desktop']);
  assert.deepEqual(office.slots.map((r) => r.id), ['ollama', 'claude-desktop']);
  assert.deepEqual(office.own.map((r) => r.id), ['localai'], 'the apps without a card on the page are not drawn');
  const overview = rtCardPlan(list, ['claude-desktop', 'chatgpt'], { slotsOnly: true });
  assert.deepEqual(overview.slots.map((r) => r.id), ['claude-desktop', 'chatgpt']);
  assert.deepEqual(overview.own, []);
});

test('an app\'s action row: the state, Stop, no how note; off macOS no button and the reason as given', () => {
  const all = flat(rtActionRow(fakeDoc(), APP()));
  assert.equal(all.find((n) => n.className === 'rt-state').textContent, 'App open');
  assert.equal(all.find((n) => n.tag === 'button').attrs['data-rt-id'], 'claude-desktop');
  assert.ok(!all.some((n) => n.className === 'rt-how'));
  const off = rtActionRow(
    fakeDoc(),
    APP({ running: false, installed: false, canStart: false, canStop: false, reason: 'macOS only' }),
  );
  assert.ok(!flat(off).some((n) => n.tag === 'button'));
  assert.ok(!flat(off).some((n) => n.className === 'rt-state'), 'no empty state line');
  assert.ok(texts(off).includes('macOS only'), texts(off).join(' | '));
  assert.ok(texts(rtActionRow(fakeDoc(), R({ canStop: false, reason: 'not installed' }))).includes('Not installed'));
});
