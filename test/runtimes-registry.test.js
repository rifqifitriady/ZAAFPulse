const test = require('node:test');
const assert = require('node:assert/strict');
const { PRESETS, entries, ownerEntries, commandHash, storedEntry } = require('../lib/runtimes/registry');

const row = (args, argv) => ({ pid: 9, ppid: 1, args, ...(argv ? { argv } : {}) });
const preset = (id) => PRESETS.find((p) => p.id === id);
const QWEN = {
  id: 'qwen-local',
  name: 'Qwen (llama.cpp)',
  command: ['llama-server', '-m', '/models/qwen.gguf', '--port', '8081'],
  port: 8081,
};

test('presets: ids, start and stop commands, health URLs', () => {
  assert.deepEqual(
    PRESETS.map((p) => p.id),
    ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai'],
  );
  assert.deepEqual(preset('ollama').start, ['ollama', 'serve']);
  assert.equal(preset('ollama').stop, null);
  assert.equal(preset('ollama').health, 'http://127.0.0.1:11434/api/version');
  assert.equal(preset('ollama').brew, 'ollama');
  assert.equal(preset('ollama').app, 'Ollama.app');
  assert.deepEqual(preset('lmstudio').start, ['lms', 'server', 'start']);
  assert.deepEqual(preset('lmstudio').stop, ['lms', 'server', 'stop']);
  assert.equal(preset('lmstudio').health, 'http://127.0.0.1:1234/v1/models');
  assert.equal(preset('lmstudio').upByHealth, true);
  assert.equal(preset('llamacpp').start, null, 'it needs a model path: an owner entry');
  assert.equal(preset('ollama').openApp, true, 'Ollama.app starts its server');
  assert.equal(preset('lmstudio').openApp, false, 'opening LM Studio does not start its server');
  assert.equal(preset('jan').openApp, true);
  assert.equal(preset('jan').health, 'http://127.0.0.1:1337/v1/models');
  assert.equal(preset('jan').app, 'Jan.app');
  assert.deepEqual(preset('localai').start, ['local-ai', 'run']);
  assert.equal(preset('localai').health, 'http://127.0.0.1:8080/readyz');
  for (const p of PRESETS) {
    assert.equal(p.preset, true);
    assert.ok(Object.isFrozen(p));
  }
});

test('presets: each recognises its own server and not its helpers', () => {
  const o = preset('ollama').match;
  assert.ok(o(row('/opt/homebrew/opt/ollama/bin/ollama serve')));
  assert.ok(o(row('/Applications/Ollama.app/Contents/Resources/ollama serve')));
  assert.ok(o(row('C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe serve')));
  assert.ok(!o(row('/opt/homebrew/Cellar/ollama/0.12.6/bin/ollama runner --model /x')), 'a runner is a child');
  assert.ok(!o(row('/Applications/Ollama.app/Contents/MacOS/Ollama')), 'the app itself is not the server');
  assert.ok(!o(row('vim ollama-notes.md')));
  const l = preset('lmstudio').match;
  assert.ok(l(row('/Applications/LM Studio.app/Contents/MacOS/LM Studio')));
  assert.ok(l(row('/Users/u/.lmstudio/bin/llmster --port 1234')));
  assert.ok(
    !l(row('/Applications/LM Studio.app/Contents/Frameworks/LM Studio Helper (GPU).app/Contents/MacOS/LM Studio Helper (GPU) --type=gpu-process')),
  );
  assert.ok(preset('llamacpp').match(row('/opt/homebrew/bin/llama-server -m /m.gguf --port 8081')));
  assert.ok(!preset('llamacpp').match(row('/opt/homebrew/bin/llama-server-helper')));
  assert.ok(preset('jan').match(row('/Applications/Jan.app/Contents/MacOS/Jan')));
  assert.ok(preset('localai').match(row('/usr/local/bin/local-ai run --models-path /m')));
  assert.ok(preset('localai').match(row('/usr/local/bin/local-ai')));
  assert.ok(!preset('localai').match(row('/usr/local/bin/local-ai models list')));
});

test('owner entries: a valid entry gets its start command, a default health URL and a matcher by program and port', () => {
  const [e] = ownerEntries([QWEN]);
  assert.equal(e.error, null);
  assert.equal(e.preset, false);
  assert.deepEqual(e.start, QWEN.command);
  assert.equal(e.health, 'http://127.0.0.1:8081/');
  assert.ok(e.match(row('/opt/homebrew/bin/llama-server -m /models/qwen.gguf --port 8081')));
  assert.ok(!e.match(row('/opt/homebrew/bin/llama-server -m /models/other.gguf --port 8082')), 'another port');
  assert.ok(!e.match(row('/usr/bin/python3 -m http.server 8081')), 'another program');
  const spaced = '/opt/my tools/llama-server --port 8081';
  assert.ok(e.match(row(spaced, ['/opt/my tools/llama-server', '--port', '8081'])), 'argv[0] when the row has one');
  assert.ok(!e.match(row(spaced)), 'without argv the first word is the program');
  const [h] = ownerEntries([{ ...QWEN, health: 'http://localhost:8081/health' }]);
  assert.equal(h.health, 'http://localhost:8081/health');
  assert.deepEqual(entries([QWEN]).map((x) => x.id), ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai', 'qwen-local']);
  assert.deepEqual(entries(undefined).length, 5);
  assert.deepEqual(entries({ not: 'a list' }).length, 5);
});

test('owner entries: invalid ones keep their reason and cannot start', () => {
  const err = (raw) => ownerEntries([raw])[0].error;
  assert.match(err({ ...QWEN, id: 'Bad Id' }), /id must be/);
  assert.match(err({ ...QWEN, id: 'x'.repeat(41) }), /id must be/);
  assert.match(err({ ...QWEN, command: 'llama-server -m x' }), /command must be a non-empty list of strings/);
  assert.match(err({ ...QWEN, command: [] }), /command must be a non-empty list/);
  assert.match(err({ ...QWEN, command: ['llama-server', 8081] }), /command must be a non-empty list of strings/);
  assert.match(err({ ...QWEN, command: ['llama-server', 'x'.repeat(1001)] }), /at most 1000 characters/);
  assert.match(err({ ...QWEN, command: [' '] }), /start with a program/);
  assert.match(err({ ...QWEN, port: 0 }), /port must be/);
  assert.match(err({ ...QWEN, port: 65536 }), /port must be/);
  assert.match(err({ ...QWEN, port: 80.5 }), /port must be/);
  assert.match(err({ ...QWEN, port: '8081' }), /port must be/);
  assert.match(err({ ...QWEN, id: 'ollama' }), /preset/);
  assert.match(err({ ...QWEN, health: 'http://example.com/' }), /on this machine/);
  assert.match(err({ ...QWEN, health: 'file:///etc/passwd' }), /on this machine/);
  assert.match(err('just text'), /must be an object/);
  const dup = ownerEntries([QWEN, { ...QWEN, name: 'Again' }]);
  assert.equal(dup[0].error, null);
  assert.match(dup[1].error, /same id/);
  for (const e of ownerEntries([{ ...QWEN, port: 0 }, 'x'])) {
    assert.equal(e.start, null);
    assert.equal(e.match(row('/opt/homebrew/bin/llama-server --port 8081')), false);
  }
});

test('commandHash changes with the command; storedEntry keeps only the stored fields', () => {
  const a = commandHash(QWEN.command);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(commandHash([...QWEN.command]), a);
  assert.notEqual(commandHash([...QWEN.command.slice(0, -1), '8082']), a);
  assert.notEqual(commandHash(['llama-server -m', '/models/qwen.gguf']), commandHash(['llama-server', '-m /models/qwen.gguf']));
  const [e] = ownerEntries([QWEN]);
  assert.deepEqual(storedEntry(e), { ...QWEN, health: 'http://127.0.0.1:8081/' });
  assert.deepEqual(storedEntry({ ...e, health: null }), QWEN);
});
