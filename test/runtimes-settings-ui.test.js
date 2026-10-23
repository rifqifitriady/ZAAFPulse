// Settings → Local models: the form helper and the entry rows of public/runtimesview.js, built against a stand-in
// document that refuses innerHTML (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const { rtEntryFromForm, rtEntryRow, rtFormFromEntry } = require('../public/runtimesview');

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
const buttons = (n) => flat(n).filter((x) => x.tag === 'button').map((x) => x.attrs['data-rt-entry-act']);

test('rtEntryFromForm: one argument per line, the port as a number, optional name and health', () => {
  const ok = rtEntryFromForm({
    id: ' qwen-local ',
    name: 'Qwen',
    command: 'llama-server\n-m\n~/models/qwen.gguf\n\n--port\n8081\n',
    port: '8081',
    health: '',
  });
  assert.deepEqual(ok, {
    entry: {
      id: 'qwen-local',
      name: 'Qwen',
      command: ['llama-server', '-m', '~/models/qwen.gguf', '--port', '8081'],
      port: 8081,
    },
  });
  assert.match(rtEntryFromForm({ id: 'Bad Id', command: 'x', port: '1' }).error, /^Id/);
  assert.match(rtEntryFromForm({ id: 'a', command: '\n \n', port: '1' }).error, /^Command/);
  assert.match(rtEntryFromForm({ id: 'a', command: 'x', port: '' }).error, /^Port/);
  assert.match(rtEntryFromForm({ id: 'a', command: 'x', port: '70000' }).error, /^Port/);
  assert.match(rtEntryFromForm({ id: 'a', command: 'x', port: '80.5' }).error, /^Port/);
  const h = rtEntryFromForm({ id: 'a', command: 'x', port: '1', health: 'http://127.0.0.1:1/h' });
  assert.equal(h.entry.health, 'http://127.0.0.1:1/h');
  assert.match(rtEntryFromForm(null).error, /^Id/);
});

test('rtEntryRow: name, command, port and approval as text; Approve only for a valid entry not yet approved', () => {
  const e = {
    id: 'qwen-local',
    name: 'Qwen',
    command: ['llama-server', '-m', '~/models/<qwen>.gguf'],
    port: 8081,
    health: 'http://127.0.0.1:8081/',
    approved: false,
    error: null,
  };
  const row = rtEntryRow(fakeDoc(), e);
  assert.equal(row.attrs['data-rt-entry'], 'qwen-local');
  const t = texts(row);
  assert.ok(t.includes('llama-server -m ~/models/<qwen>.gguf'));
  assert.ok(t.includes('qwen-local · port 8081 · http://127.0.0.1:8081/'));
  assert.ok(t.includes('Not approved'));
  assert.deepEqual(buttons(row), ['approve', 'edit', 'delete']);
  const approved = rtEntryRow(fakeDoc(), { ...e, approved: true });
  assert.ok(texts(approved).includes('Approved'));
  assert.deepEqual(buttons(approved), ['edit', 'delete']);
  const bad = rtEntryRow(fakeDoc(), { ...e, error: 'port must be a whole number from 1 to 65535' });
  assert.ok(texts(bad).includes('Port must be a whole number from 1 to 65535'));
  assert.deepEqual(buttons(bad), ['edit', 'delete'], 'an invalid entry cannot be approved');
});

test('rtEntryRow: no command (control off) draws no command line and a masked argument stays text', () => {
  const base = { id: 'a', name: 'A', port: 1, approved: true, error: null };
  const off = rtEntryRow(fakeDoc(), { ...base, command: null });
  assert.equal(flat(off).filter((x) => x.tag === 'code').length, 0);
  const masked = rtEntryRow(fakeDoc(), { ...base, command: ['srv', '--token', '‹GitHub token hidden›'] });
  assert.ok(texts(masked).includes('srv --token ‹GitHub token hidden›'));
});

test('rtFormFromEntry: Edit fills the health field only with a URL the owner gave, never the default', () => {
  const e = {
    id: 'qwen-local',
    name: 'Qwen',
    command: ['llama-server', '--port', '8081'],
    port: 8081,
    health: null,
    healthUsed: 'http://127.0.0.1:8081/',
  };
  assert.deepEqual(rtFormFromEntry(e), {
    id: 'qwen-local',
    name: 'Qwen',
    port: '8081',
    health: '',
    command: 'llama-server\n--port\n8081',
    was: 'qwen-local',
  });
  assert.equal(rtFormFromEntry({ ...e, health: 'http://localhost:8081/h' }).health, 'http://localhost:8081/h');
  assert.deepEqual(rtFormFromEntry({ id: 'a', command: null, port: null }), {
    id: 'a',
    name: '',
    port: '',
    health: '',
    command: '',
    was: 'a',
  });
  // The row shows the URL that is checked, the default included.
  const row = rtEntryRow(fakeDoc(), { ...e, approved: true, error: null });
  assert.ok(texts(row).includes('qwen-local · port 8081 · http://127.0.0.1:8081/'));
});
