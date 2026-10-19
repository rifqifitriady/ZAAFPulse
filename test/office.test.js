const test = require('node:test');
const assert = require('node:assert/strict');
const { zoneFor, targetFor, commandName, decide } = require('../lib/office');

test('zoneFor sends each kind of tool to its room', () => {
  assert.equal(zoneFor('Edit'), 'code');
  assert.equal(zoneFor('Grep'), 'read');
  assert.equal(zoneFor('Bash'), 'terminal');
  assert.equal(zoneFor('exec_command'), 'terminal');
  assert.equal(zoneFor('WebFetch'), 'web');
  assert.equal(zoneFor('Task'), 'meeting');
  assert.equal(zoneFor('mcp__dynatrace__list_problems'), 'tools');
});

test('targetFor keeps only a file name, command name or hostname', () => {
  assert.equal(targetFor('Edit', { file_path: '/Users/me/secret/app.js', old_string: 'x' }), 'app.js');
  assert.equal(targetFor('WebFetch', { url: 'https://example.com/a?token=1' }), 'example.com');
  assert.equal(targetFor('Bash', { command: 'cd /repo && API_KEY=abc npm test' }), 'npm');
  assert.equal(targetFor('Grep', { pattern: 'password' }), '');
});

test('commandName skips assignments, cd and flags', () => {
  assert.equal(commandName('C=$(ls -t x)'), 'ls');
  assert.equal(commandName('(cd x && make)'), 'make');
});

const agent = (fields) => ({
  kind: 'session',
  pending: new Map(),
  lastKind: null,
  lastTool: null,
  lastTs: 0,
  ...fields,
});

test('decide reads state from pending calls and the last turn', () => {
  const now = 1e12;
  const running = agent({
    lastTs: now - 5000,
    pending: new Map([['t1', { ts: now - 5000, tool: 'Bash', target: 'npm' }]]),
  });
  assert.equal(decide(running, now).state, 'working');
  assert.equal(running.zone, 'terminal');

  const stuck = agent({
    lastTs: now - 60000,
    pending: new Map([['t1', { ts: now - 60000, tool: 'Edit', target: 'a.js' }]]),
  });
  assert.equal(decide(stuck, now).state, 'approval');

  const asked = agent({
    lastTs: now - 1000,
    pending: new Map([['t1', { ts: now - 1000, tool: 'AskUserQuestion', target: '' }]]),
  });
  assert.equal(decide(asked, now).state, 'waiting');

  assert.equal(decide(agent({ lastTs: now - 60000, lastKind: 'done' }), now).zone, 'help');
  assert.equal(decide(agent({ lastTs: now - 3600000, lastKind: 'done' }), now).state, 'idle');
});
