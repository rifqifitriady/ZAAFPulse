const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
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
    ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai', 'claude-desktop', 'chatgpt', 'antigravity', 'kiro'],
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
  assert.ok(!e.match(row('/opt/homebrew/bin/llama-server -m /models/other.gguf --port 8081')), 'another model on the port');
  const spaced = '/opt/my tools/llama-server -m /models/qwen.gguf --port 8081';
  const argv = ['/opt/my tools/llama-server', '-m', '/models/qwen.gguf', '--port', '8081'];
  assert.ok(e.match(row(spaced, argv)), 'argv[0] when the row has one');
  assert.ok(!e.match(row(spaced)), 'without argv the first word is the program');
  const [h] = ownerEntries([{ ...QWEN, health: 'http://localhost:8081/health' }]);
  assert.equal(h.health, 'http://localhost:8081/health');
  assert.deepEqual(
    entries([QWEN]).map((x) => x.id),
    ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai', 'claude-desktop', 'chatgpt', 'antigravity', 'kiro', 'qwen-local'],
  );
  assert.deepEqual(entries(undefined).length, 9);
  assert.deepEqual(entries({ not: 'a list' }).length, 9);
});

test('owner entries: a command that names its port also needs its other arguments, so a stranger on that number does not match', () => {
  const [vllm] = ownerEntries([{ id: 'vllm', command: ['python3', '-m', 'vllm.entrypoints.openai.api_server', '--port', '8000'], port: 8000 }]);
  assert.ok(vllm.match(row('/usr/bin/python3 -m vllm.entrypoints.openai.api_server --port 8000')));
  assert.ok(vllm.match(row('/usr/bin/python3 -m vllm.entrypoints.openai.api_server --port 8000 --dtype auto')), 'extra arguments');
  assert.ok(!vllm.match(row('/usr/bin/python3 train.py --steps 8000')), 'another script with the number');
  const [a] = ownerEntries([{ id: 'a', command: ['node', '/srv/a.js', '--max', '3000'], port: 3000 }]);
  assert.ok(a.match(row('node /srv/a.js --max 3000', ['node', '/srv/a.js', '--max', '3000'])));
  assert.ok(!a.match(row('node /other/b.js --x 3000', ['node', '/other/b.js', '--x', '3000'])), 'another script');
});

test('owner entries: a command without its port matches only the same program with the same arguments', () => {
  const [py] = ownerEntries([{ id: 'py', command: ['python3', 'serve.py'], port: 8000 }]);
  assert.ok(py.match(row('/usr/bin/python3 serve.py')), 'the exact command, no argv');
  assert.ok(py.match(row('/usr/bin/python3 serve.py', ['/usr/bin/python3', 'serve.py'])), 'the exact command, argv');
  assert.ok(!py.match(row('/usr/bin/python3 manage.py runserver')), 'another script, no argv');
  assert.ok(!py.match(row('/usr/bin/python3 manage.py runserver', ['/usr/bin/python3', 'manage.py', 'runserver'])));
  assert.ok(!py.match(row('/usr/bin/python3 serve.py --debug')), 'an extra argument');
  assert.ok(!py.match(row('/usr/bin/python3', ['/usr/bin/python3'])), 'no arguments');
  const [node] = ownerEntries([{ id: 'srv', command: ['node', 'srv.js'], port: 3000 }]);
  assert.ok(node.match(row('/opt/homebrew/bin/node srv.js', ['/opt/homebrew/bin/node', 'srv.js'])));
  assert.ok(!node.match(row('node /Users/me/.npm/bin/claude')), 'an unrelated node process');
  assert.ok(!node.match(row('node /Users/me/.npm/bin/claude', ['node', '/Users/me/.npm/bin/claude'])));
  // Windows: argv holds the program only; the arguments come from the command line after it.
  const winNode = 'C:\\Program Files\\nodejs\\node.exe';
  assert.ok(node.match(row(`"${winNode}" srv.js`, [winNode])));
  assert.ok(!node.match(row(`"${winNode}" other.js`, [winNode])));
  // A command that names its port is still matched by program and port, whatever its other arguments.
  const [q] = ownerEntries([QWEN]);
  assert.ok(q.match(row('/opt/homebrew/bin/llama-server --port 8081 -m /models/qwen.gguf')));
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
  assert.deepEqual(storedEntry(e), QWEN, 'the default health URL is not stored');
  assert.deepEqual(storedEntry({ ...e, health: null }), QWEN);
  const [own] = ownerEntries([{ ...QWEN, health: 'http://localhost:8081/health' }]);
  assert.deepEqual(storedEntry(own), { ...QWEN, health: 'http://localhost:8081/health' }, 'one the owner gave is');
});

test('the default health URL follows the port; one stored by an earlier version reads as the default', () => {
  const [e] = ownerEntries([QWEN]);
  assert.equal(e.health, 'http://127.0.0.1:8081/');
  assert.equal(e.healthSet, false);
  const [moved] = ownerEntries([storedEntry({ ...e, port: 8082 })]);
  assert.equal(moved.health, 'http://127.0.0.1:8082/', 'a port change moves the health URL with it');
  // Earlier versions stored the default itself. It is read as not given, so it is dropped at the next save and
  // follows the port from then on; the approval hash is the same either way.
  const [old] = ownerEntries([{ ...QWEN, health: 'http://127.0.0.1:8081/' }]);
  assert.equal(old.healthSet, false);
  assert.deepEqual(storedEntry(old), QWEN);
  assert.equal(commandHash(old), commandHash(e));
  assert.equal(commandHash({ ...QWEN, health: 'http://127.0.0.1:8081/' }), commandHash(QWEN));
  const [own] = ownerEntries([{ ...QWEN, health: 'http://localhost:8081/health' }]);
  assert.equal(own.healthSet, true);
  assert.notEqual(commandHash(own), commandHash(e));
});

test('presets match the program, not a word in the arguments', () => {
  const m = (id, ...rows) => rows.map((r) => preset(id).match(r));
  const none = (id, ...rows) => assert.deepEqual(m(id, ...rows), rows.map(() => false), `${id}: ${rows.map((r) => r.args)}`);
  none('ollama', row('vim /Users/u/dev/ollama serve'), row('sudo /usr/local/bin/ollama serve'), row('env FOO=1 ollama serve'),
    row('nohup ollama serve'), row('/bin/zsh -c ollama serve'), row('tail -f /var/log/ollama serve'), row('ollama serve-me'));
  none('llamacpp', row('code /Users/u/dev/llama-server'), row('tail -f /var/log/llama-server'),
    row('/usr/bin/vim /opt/homebrew/bin/llama-server'), row('sudo llama-server -m /m.gguf'));
  none('localai', row('vim /x/local-ai'), row('/Applications/Visual Studio Code.app/Contents/MacOS/Electron /Users/u/Github/local-ai'),
    row('sudo local-ai run'));
  none('lmstudio', row('vim /Applications/LM Studio.app/Contents/MacOS/LM Studio'),
    row('/usr/bin/open /Applications/LM Studio.app/Contents/MacOS/LM Studio'), row('less /Users/u/.lmstudio/bin/llmster'));
  none('jan', row('vim /Applications/Jan.app/Contents/MacOS/Jan'));
  // With argv the program is argv[0] whole, spaces included; the same rules hold.
  const lms = '/Applications/LM Studio.app/Contents/MacOS/LM Studio';
  assert.ok(preset('lmstudio').match(row(lms, [lms])));
  none('lmstudio', row(`vim ${lms}`, ['vim', lms]));
  assert.ok(preset('ollama').match(row('/opt/homebrew/bin/ollama serve', ['/opt/homebrew/bin/ollama', 'serve'])));
  none('ollama', row('sudo /usr/local/bin/ollama serve', ['sudo', '/usr/local/bin/ollama', 'serve']),
    row('/opt/homebrew/bin/ollama runner', ['/opt/homebrew/bin/ollama', 'runner']));
  const winOllama = 'C:\\Program Files\\Ollama\\ollama.exe';
  assert.ok(preset('ollama').match(row(`${winOllama} serve`, [winOllama, 'serve'])), 'a Windows path with spaces, with argv');
  // Editors started by full path with a relative-path argument are not the server (no argv: spaces are not read as folders).
  none('ollama', row('/usr/bin/vim ~/dev/ollama serve'), row('/usr/bin/vim notes/ollama serve'));
  none('llamacpp', row('/usr/bin/vim ./llama-server'), row('/usr/bin/vim src/llama-server'));
  // An editor with a relative or tilde argument is not the app, whatever the app's own folder holds.
  none('lmstudio', row('/usr/bin/vim ~/Applications/LM Studio.app/Contents/MacOS/LM Studio'),
    row('/usr/bin/vim notes/LM Studio.app/Contents/MacOS/LM Studio'));
  none('jan', row('/usr/bin/vim ./Jan.app/Contents/MacOS/Jan'));
  assert.ok(preset('lmstudio').match(row('/Applications/LM Studio.app/Contents/MacOS/LM Studio')));
  assert.ok(preset('jan').match(row('/Applications/Jan.app/Contents/MacOS/Jan')));
  // Windows CommandLine quotes a spaced program: without argv the quoted program is read; with argv = [program] too.
  assert.ok(preset('ollama').match(row(`"${winOllama}" serve`)), 'quoted spaced Windows program, no argv');
  assert.ok(preset('ollama').match(row(`"${winOllama}" serve`, [winOllama])), 'argv holds the program only; arguments from args');
  none('ollama', row(`"${winOllama}" runner`, [winOllama]), row(`"C:\\Program Files\\Vim\\vim.exe" ${winOllama} serve`),
    row('"C:\\Program Files\\Vim\\vim.exe" ollama.exe serve', ['C:\\Program Files\\Vim\\vim.exe']));
  // With argv a spaced non-app path is exact, so it matches; without argv it is the documented false negative.
  const spaced = '/Users/me/My Tools/bin/ollama';
  assert.ok(preset('ollama').match(row(`${spaced} serve`, [spaced, 'serve'])));
  assert.equal(preset('ollama').match(row(`${spaced} serve`)), false, 'known macOS false negative: spaced non-app path, no argv');
  assert.ok(preset('ollama').match(row('/opt/homebrew/bin/ollama serve')));
  assert.ok(preset('localai').match(row('/usr/local/bin/local-ai', ['/usr/local/bin/local-ai'])));
});

test('presets: start and stop commands cannot be changed', () => {
  assert.throws(() => preset('ollama').start.push('x'), TypeError);
  assert.throws(() => preset('lmstudio').stop.push('x'), TypeError);
  assert.deepEqual(preset('ollama').start, ['ollama', 'serve']);
});

test('owner entries: an empty program, a non-string id, and control characters are errors', () => {
  const err = (raw) => ownerEntries([raw])[0].error;
  assert.match(err({ ...QWEN, command: ['/'] }), /start with a program/);
  assert.match(err({ ...QWEN, command: ['foo/'] }), /start with a program/);
  assert.match(err({ ...QWEN, command: ['C:\\bin\\'] }), /start with a program/);
  assert.match(err({ ...QWEN, command: ['llama-server', 'a\nb'] }), /line break or a NUL/);
  assert.match(err({ ...QWEN, command: ['llama-server', 'a\rb'] }), /line break or a NUL/);
  assert.match(err({ ...QWEN, command: ['llama-server', 'a\0b'] }), /line break or a NUL/);
  assert.match(err({ ...QWEN, id: ['ollama'] }), /id must be/);
  assert.match(err({ ...QWEN, id: 5 }), /id must be/);
  assert.match(err({ ...QWEN, id: ['qwen-local'] }), /id must be/);
  assert.equal(ownerEntries([{ ...QWEN, id: ['x'] }])[0].id, 'entry-1');
});

test('commandHash covers the command, the port and the health URL of an entry', () => {
  const [e] = ownerEntries([QWEN]);
  const base = commandHash(e);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(commandHash(QWEN), base, 'the raw config object and the checked entry agree');
  assert.equal(commandHash({ ...QWEN, health: 'http://127.0.0.1:8081/' }), base, 'the default health URL is the same as none');
  assert.notEqual(commandHash({ ...QWEN, command: [...QWEN.command, '-v'] }), base);
  assert.notEqual(commandHash({ ...QWEN, port: 8082 }), base);
  assert.notEqual(commandHash({ ...QWEN, health: 'http://127.0.0.1:8081/health' }), base);
  assert.notEqual(commandHash(QWEN.command), base, 'a bare command is not an entry');
});

// ---- the desktop apps (kind 'app') ----
const APP_IDS = ['claude-desktop', 'chatgpt', 'antigravity', 'kiro'];
const MAIN = {
  'claude-desktop': '/Applications/Claude.app/Contents/MacOS/Claude',
  chatgpt: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
  antigravity: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
  kiro: '/Applications/Kiro.app/Contents/MacOS/Kiro',
};
const KIRO_CLI = '/Applications/Kiro CLI.app/Contents/MacOS/kiro_cli_desktop';

test('apps: four presets of kind app; the model servers are kind server, and so is every owner entry', () => {
  assert.deepEqual(
    PRESETS.filter((p) => p.kind === 'app').map((p) => [p.id, p.name]),
    [
      ['claude-desktop', 'Claude Desktop'],
      ['chatgpt', 'ChatGPT'],
      ['antigravity', 'Antigravity'],
      ['kiro', 'Kiro'],
    ],
  );
  assert.deepEqual(preset('claude-desktop').app, ['Claude.app']);
  assert.deepEqual(preset('chatgpt').app, ['ChatGPT.app']);
  assert.deepEqual(preset('antigravity').app, ['Antigravity.app']);
  assert.deepEqual(preset('kiro').app, ['Kiro.app', 'Kiro CLI.app'], 'Kiro.app first: the first one installed wins');
  for (const id of APP_IDS) {
    const p = preset(id);
    assert.equal(p.openApp, true, `${id}: Start opens the app`);
    assert.equal(p.health, null, `${id}: no health URL`);
    assert.equal(p.port, null);
    assert.equal(p.bin, null);
    assert.equal(p.start, null);
    assert.equal(p.stop, null);
    assert.ok(Object.isFrozen(p.app), `${id}: the bundle list cannot be changed`);
  }
  for (const id of ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai']) assert.equal(preset(id).kind, 'server', id);
  assert.equal(ownerEntries([QWEN])[0].kind, 'server');
  assert.equal(ownerEntries([{ ...QWEN, kind: 'app' }])[0].kind, 'server', 'an owner entry cannot be an app');
  assert.equal(ownerEntries([{ id: 5 }])[0].kind, 'server', 'an invalid entry too');
});

test('apps: the main process matches, in /Applications or ~/Applications; helpers, other apps and arguments do not', () => {
  const homeApps = path.join(os.homedir(), 'Applications');
  for (const id of APP_IDS) {
    const m = preset(id).match;
    const main = MAIN[id];
    assert.ok(m(row(main)), `${id}: the main executable`);
    assert.ok(m(row(`${main} --some-flag`)), `${id}: with arguments`);
    assert.ok(m(row(main, [main])), `${id}: with argv`);
    assert.ok(m(row(main.replace('/Applications', homeApps))), `${id}: in ~/Applications`);
    assert.ok(!m(row(main.replace('/Applications', '/tmp/x/Applications'))), `${id}: another folder`);
    assert.ok(!m(row(`/usr/bin/vim ${main}`)), `${id}: the path in an argument`);
    assert.ok(!m(row(`/usr/bin/vim ${main}`, ['/usr/bin/vim', main])), `${id}: the path in an argv argument`);
    assert.ok(!m(row(`${main}2`)), `${id}: another program in the same folder`);
  }
  const claude = preset('claude-desktop').match;
  for (const helper of [
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility',
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
    '/Applications/Claude.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
  ])
    assert.ok(!claude(row(helper)), helper);
  assert.ok(!claude(row('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')), 'another app');
  assert.ok(!claude(row('/Applications/Claude Code.app/Contents/MacOS/Claude')), 'another bundle');
  assert.ok(!claude(row('/opt/homebrew/bin/claude')), 'Claude Code is not Claude Desktop');
  assert.ok(!preset('chatgpt').match(row(MAIN['claude-desktop'])));
  const kiro = preset('kiro').match;
  assert.ok(kiro(row(KIRO_CLI)), 'Kiro CLI.app main process');
  assert.ok(kiro(row(KIRO_CLI, [KIRO_CLI])));
  assert.ok(!kiro(row('/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli chat')), 'a kiro-cli session is not the app');
  assert.ok(!kiro(row('/Users/u/.local/bin/kiro-cli chat')));
  assert.ok(!kiro(row('/Applications/Kiro.app/Contents/Frameworks/Kiro Helper.app/Contents/MacOS/Kiro Helper')));
  // A model server never matches an app row and the other way round.
  for (const id of ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai'])
    for (const main of [...Object.values(MAIN), KIRO_CLI]) assert.ok(!preset(id).match(row(main)), `${id} ${main}`);
});
