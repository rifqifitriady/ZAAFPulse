const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const { finalOf, cluster, decide } = require('../lib/gateway/collab');

const reply = (content, extra = {}) => ({
  body: {
    choices: [{ message: { role: 'assistant', content, ...extra } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
});
const toolCall = (name, args, id = 't1') =>
  reply(null, { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sys = (r) => r.body.messages[0].content;
const agentOf = (r) => (sys(r).match(/^You are the (.+?) agent in ZAAFPulse/) || [])[1];
const lastUser = (r) => [...r.body.messages].reverse().find((m) => m.role === 'user').content;
const toolMsgs = (r) => r.body.messages.filter((m) => m.role === 'tool');

async function setup(handler, { tools = [] } = {}) {
  const upstream = await fakeServer({
    'POST /chat/completions': async (r) => {
      const out = await handler(r);
      return typeof out === 'string' ? reply(out) : out;
    },
    'GET /models': { body: { data: [{ id: 'm' }] } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-collab-'));
  const gw = {
    providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, tier: 'private', approved: true }],
    defaults: { model: 'fake/m', plannerModel: 'fake/m' },
  };
  const toolCalls = [];
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({
      // Like the real registry: every tool says whether it is read-only.
      listTools: async () => tools.map((t) => ({ annotations: { readOnlyHint: !t.write }, ...t })),
      callTool: async (name) => {
        toolCalls.push(name);
        return { result: { content: [{ type: 'text', text: `result of ${name}` }] } };
      },
    }),
  });
  const server = http.createServer(async (req, res) => {
    if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, key, body, method = 'POST') => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* sse */
    }
    return { status: r.status, json, text };
  };
  const key = (extra = {}) => gateway.keys.create({ name: 'k', scopes: ['agents', 'llm'], rpm: 1000, ...extra }).secret;
  return {
    gateway,
    upstream,
    call,
    key,
    base,
    toolCalls,
    collab: gateway.collab,
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await upstream.close();
    },
  };
}

test('helpers: final answers, clustering and the majority-with-quorum rule', () => {
  assert.deepEqual(finalOf('Reasoning…\nFINAL ANSWER: **1,200 users**\nCONFIDENCE: 85%'), {
    answer: '1,200 users',
    confidence: 0.85,
  });
  assert.equal(finalOf('just this line').answer, 'just this line');
  assert.equal(finalOf('FINAL ANSWER: x\nCONFIDENCE: 7').confidence, 0.1); // 7 → 7% → clipped up to 0.1
  const c = cluster([
    { answer: '1,200 users', confidence: 0.5, agent: 'a' },
    { answer: '1200 users.', confidence: 0.5, agent: 'b' },
    { answer: 'about 900', confidence: 0.9, agent: 'c' },
  ]);
  assert.equal(c[0].votes, 2);
  assert.deepEqual(c[0].agents, ['a', 'b']);
  const v = (a) => ({ answer: a, confidence: 0.5, ok: true });
  assert.equal(decide([v('a'), v('a'), v('b')]).decided, true);
  assert.equal(decide([v('a'), v('b')]).decided, false); // tie
  assert.equal(decide([v('a'), v('a'), v('b'), v('c'), v('d')]).decided, false); // 2 of 5 is not a majority
});

test('auto: independent steps run in parallel and the dependent step builds on both', async () => {
  let inflight = 0;
  let peak = 0;
  const t = await setup(async (r) => {
    if (sys(r).startsWith('You are the ZAAFPulse planner'))
      return JSON.stringify({
        steps: [
          { id: 'net', agent: 'network-ops', instruction: 'check the network', dependsOn: [] },
          { id: 'sec', agent: 'security', instruction: 'check for attacks', dependsOn: [] },
          {
            id: 'msg',
            agent: 'content-writer',
            instruction: 'write the update',
            output: 'a short status update',
            dependsOn: ['net', 'sec'],
          },
        ],
        reason: 'two checks then a message',
      });
    inflight++;
    peak = Math.max(peak, inflight);
    await sleep(40);
    inflight--;
    return `done by ${agentOf(r)}`;
  });
  try {
    const { run } = await t.collab.run({ pattern: 'auto', task: 'Checkout is slow, find out why and tell customers' });
    assert.equal(run.state, 'completed');
    assert.equal(peak, 2);
    assert.equal(run.answer, 'done by Content Writer');
    const writer = t.upstream.requests.find((q) => agentOf(q) === 'Content Writer');
    assert.match(sys(writer), /<agent_output from="network-ops">[\s\S]*<agent_output from="security">/);
    assert.match(lastUser(writer), /Return: a short status update/);
    assert.deepEqual(run.plan.steps.find((s) => s.id === 'msg').dependsOn, ['net', 'sec']);
    const root = run.trace.find((s) => s.name === 'invoke_workflow auto');
    assert.ok(root.end != null && root.attrs['zp.model_calls'] === 4);
    assert.ok(
      run.trace.filter((s) => s.name.startsWith('chat ')).every((s) => s.attrs['gen_ai.usage.input_tokens'] === 10),
    );
    assert.ok(!JSON.stringify(run.trace).includes('Checkout is slow')); // spans carry no prompt text
  } finally {
    await t.close();
  }
});

test('vote: a clear majority wins; a split vote draws two more samples, then the order-swapped judge decides', async () => {
  let answers = ['42', '42', '17', '42', '9'];
  let i = 0;
  const t = await setup((r) => {
    if (/impartial judge/.test(sys(r))) {
      const parts = lastUser(r).split(/Candidate (\d+):/);
      for (let k = 1; k < parts.length; k += 2)
        if (/FINAL ANSWER: X/.test(parts[k + 1])) return `{"best": ${parts[k]}}`;
      return '{"best": 1}';
    }
    return `Thinking.\nFINAL ANSWER: ${answers[i++ % answers.length]}\nCONFIDENCE: 0.8`;
  });
  try {
    let { run } = await t.collab.run({ pattern: 'vote', task: 'How many?', agents: ['data-analyst'] });
    assert.equal(run.verdict.method, 'majority');
    assert.equal(run.verdict.winner, '42');
    assert.equal(run.verdict.agreement, 0.6);
    assert.equal(run.verdict.needsReview, false);
    assert.equal(run.steps.length, 5);
    assert.match(run.answer, /FINAL ANSWER: 42/);
    answers = ['X', 'Y', 'X', 'Y', 'Z', 'X', 'Y'];
    i = 0;
    ({ run } = await t.collab.run({ pattern: 'vote', task: 'Which?', agents: ['data-analyst'] }));
    assert.equal(run.steps.length, 7);
    assert.equal(run.verdict.method, 'judge');
    assert.equal(run.verdict.winner, 'X');
    assert.equal(run.verdict.judge.agreed, true);
    assert.equal(t.upstream.requests.filter((q) => /impartial judge/.test(sys(q))).length, 2);
  } finally {
    await t.close();
  }
});

test('debate: agents read each other, stop once they all agree, then vote', async () => {
  const t = await setup((r) => {
    const who = agentOf(r);
    const revising = /Other agents answered/.test(lastUser(r));
    return `My view.\nFINAL ANSWER: ${revising || who !== 'Research' ? '4' : '5'}\nCONFIDENCE: 0.7`;
  });
  try {
    const { run } = await t.collab.run({
      pattern: 'debate',
      task: '2+2?',
      agents: ['data-analyst', 'research', 'ai-ops'],
      rounds: 3,
    });
    assert.equal(run.steps.length, 6);
    assert.match(run.stop.reason, /agreed in round 2/);
    assert.equal(run.verdict.winner, '4');
    assert.equal(run.verdict.agreement, 1);
    const r2 = t.upstream.requests.find((q) => agentOf(q) === 'Research' && /Other agents answered/.test(lastUser(q)));
    assert.match(lastUser(r2), /<agent_output from="data-analyst">/);
    assert.match(lastUser(r2), /Keep your answer unless you find a concrete error/);
  } finally {
    await t.close();
  }
});

test('review: the critic scores each draft; the best draft is kept when the score stops improving', async () => {
  const scores = { 1: 0.5, 2: 0.7, 3: 0.6 };
  let drafts = 0;
  const t = await setup((r) => {
    if (/strict reviewer/.test(sys(r))) {
      const n = Number(lastUser(r).match(/draft v(\d)/)[1]);
      return JSON.stringify({
        score: scores[n],
        issues: [n === 1 ? 'add the numbers' : 'name the owners'],
        summary: `v${n}`,
      });
    }
    return `draft v${++drafts}`;
  });
  try {
    const { run } = await t.collab.run({ pattern: 'review', task: 'Write the plan', agent: 'project-manager' });
    assert.equal(run.answer, 'draft v2');
    assert.equal(run.verdict.best, 2);
    assert.equal(run.verdict.score, 0.7);
    assert.deepEqual(
      run.verdict.scores.map((s) => s.score),
      [0.5, 0.7, 0.6],
    );
    assert.match(run.stop.reason, /stopped improving/);
    const second = t.upstream.requests.find((q) => /A reviewer scored it 0.5/.test(lastUser(q)));
    assert.match(lastUser(second), /- add the numbers/);
  } finally {
    await t.close();
  }
});

test('group: the progress ledger picks speakers and ends the task; a stalled team replans twice, then stops', async () => {
  let mode = 'normal';
  let ledger = 0;
  const t = await setup((r) => {
    if (sys(r).startsWith('You are the ZAAFPulse group orchestrator')) {
      const u = lastUser(r);
      if (/Write FACTS/.test(u)) return 'FACTS: none yet. PLAN: network then security.';
      if (/Write the final answer/.test(u)) return 'final from group';
      ledger++;
      if (mode === 'stall')
        return JSON.stringify({
          is_progress_being_made: { reason: 'same again', answer: false },
          next_speaker: { answer: 'network-ops' },
          instruction_or_question: { answer: 'look again' },
        });
      const next = ledger === 1 ? 'network-ops' : 'security';
      return JSON.stringify({
        is_request_satisfied: { reason: '', answer: ledger >= 3 },
        is_in_loop: { answer: false },
        is_progress_being_made: { answer: true },
        next_speaker: { reason: '', answer: next },
        instruction_or_question: { answer: `${next}: do your part` },
      });
    }
    return `contribution of ${agentOf(r)}`;
  });
  try {
    let { run } = await t.collab.run({
      pattern: 'group',
      task: 'Investigate the outage',
      agents: ['network-ops', 'security', 'content-writer'],
    });
    assert.deepEqual(
      run.steps.map((s) => s.agent),
      ['network-ops', 'security'],
    );
    assert.equal(run.answer, 'final from group');
    assert.equal(run.ledger.length, 3);
    assert.match(run.stop.reason, /judged the task done at turn 3/);
    const sec = t.upstream.requests.find((q) => agentOf(q) === 'Security');
    assert.match(sys(sec), /Shared blackboard:[\s\S]*contribution of Network Operations/);
    mode = 'stall';
    ledger = 0;
    ({ run } = await t.collab.run({
      pattern: 'group',
      task: 'Investigate again',
      agents: ['network-ops', 'security'],
      turns: 20,
    }));
    assert.match(run.stop.reason, /stalled after two replans/);
    assert.equal(run.blackboard.filter((e) => e.kind === 'plan').length, 3);
  } finally {
    await t.close();
  }
});

test('handoff: an agent hands the conversation on and the session remembers who is in charge', async () => {
  const t = await setup((r) => {
    const who = agentOf(r);
    if (who === 'Customer Service')
      return toolMsgs(r).length
        ? 'Passing you to Finance.'
        : toolCall('zp_handoff', { agent: 'hr-finance', note: 'refund of $900 is over my limit' });
    return 'Finance approves the refund.';
  });
  try {
    const key = t.key();
    const a = await t.call('/v1/collaborate', key, {
      pattern: 'handoff',
      agent: 'customer-service',
      task: 'I want a $900 refund',
    });
    assert.equal(a.status, 200);
    assert.equal(a.json.answer, 'Finance approves the refund.');
    assert.equal(a.json.activeAgent, 'hr-finance');
    const first = t.upstream.requests.find((q) => agentOf(q) === 'Customer Service');
    const ho = first.body.tools.find((x) => x.function.name === 'zp_handoff');
    assert.ok(ho && !ho.function.parameters.properties.agent.enum.includes('customer-service'));
    const fin = t.upstream.requests.find((q) => agentOf(q) === 'HR & Finance');
    assert.match(lastUser(fin), /Handed over by the Customer Service agent[\s\S]*over my limit/);
    assert.equal(t.gateway.sessions.get(a.json.session_id).activeAgent, 'hr-finance');
    const b = await t.call('/v1/collaborate', key, {
      pattern: 'handoff',
      task: 'And when will it arrive?',
      session_id: a.json.session_id,
    });
    assert.equal(b.json.steps[0].agent, 'hr-finance');
  } finally {
    await t.close();
  }
});

test('workflows: an approval gate pauses the run until it is approved; a rejection ends it', async () => {
  const t = await setup((r) => `${agentOf(r)} says: ${lastUser(r).slice(0, 30)}`);
  try {
    assert.ok(
      t.gateway.workflows.save({
        id: 'gated',
        name: 'Gated',
        steps: [
          { agent: 'hr-finance', prompt: 'Review {{input}}' },
          { agent: 'legal-compliance', prompt: 'Sign off {{step1}}', approve: true },
        ],
      }).workflow,
    );
    const key = t.key();
    const r = await t.call('/v1/workflows/gated/run', key, { input: 'laptop $2,400' });
    assert.equal(r.json.state, 'input-required');
    // The gated step has already worked out its proposal; nothing that changes anything has run.
    assert.equal(r.json.steps.length, 2);
    assert.equal(r.json.steps[1].role, 'proposal');
    assert.equal(r.json.pending.step, 2);
    // The app that started the run may not approve it; a person does, in the dashboard.
    assert.equal((await t.call(`/v1/runs/${r.json.id}/resume`, key, { approve: true })).status, 403);
    assert.deepEqual(
      (
        await t.gateway.admin('collab', 'POST', {
          action: 'resume',
          id: r.json.id,
          approve: true,
          note: 'cap it at $2,000',
        })
      ).errors,
      undefined,
    );
    let ok;
    for (let i = 0; i < 50; i++) {
      ok = await t.call(`/v1/runs/${r.json.id}`, key, null, 'GET');
      if (ok.json.state === 'completed') break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(ok.json.state, 'completed');
    assert.equal(ok.json.steps.length, 3);
    assert.match(ok.json.answer, /^Legal & Compliance says: Sign off HR & Finance/);
    assert.match(ok.json.answer, /Approved with this note: cap it at \$2,000/);
    assert.equal(ok.json.approvals[0].note, 'cap it at $2,000');
    assert.equal((await t.call(`/v1/runs/${r.json.id}/resume`, key, { approve: false })).status, 409);
    const r2 = await t.call('/v1/workflows/gated/run', key, { input: 'yacht' });
    const no = await t.call(`/v1/runs/${r2.json.id}/resume`, key, { approve: false, note: 'too expensive' });
    assert.equal(no.json.state, 'rejected');
    assert.match(no.json.stop.reason, /not approved: too expensive/);
    assert.equal((await t.call(`/v1/runs/${r.json.id}`, t.key(), null, 'GET')).status, 404); // another key cannot see it
    // A step whose agent is gone fails the run instead of being skipped.
    t.gateway.workflows.save({
      id: 'broken',
      name: 'Broken',
      steps: [
        { agent: 'hr-finance', prompt: '{{input}}' },
        { agent: 'no-such-agent', prompt: '{{step1}}' },
      ],
    });
    const br = await t.call('/v1/workflows/broken/run', key, { input: 'x' });
    assert.equal(br.json.state, 'failed');
    assert.match(br.json.error, /step 2: agent "no-such-agent" is missing or disabled/);
    // An approval nobody gives in 72 hours ends the run as rejected.
    const r3 = await t.call('/v1/workflows/gated/run', key, { input: 'chairs' });
    t.collab.get(r3.json.id).pending.expiresAt = Date.now() - 1;
    const late = await t.call(`/v1/runs/${r3.json.id}`, key, null, 'GET');
    assert.equal(late.json.state, 'rejected');
    assert.match(late.json.stop.reason, /within 72 hours/);
  } finally {
    await t.close();
  }
});

test('guards: budget stop keeps the best answer, consult cycles and repeated tool calls are refused, cancel wins', async () => {
  let drafts = 0;
  let seenCycle = '';
  let slow = false;
  const t = await setup(
    async (r) => {
      const who = agentOf(r);
      if (/strict reviewer/.test(sys(r))) return '{"score": 0.5, "issues": ["more detail"], "summary": "weak"}';
      if (slow) {
        await sleep(300);
        return 'late';
      }
      if (who === 'Customer Service')
        return toolMsgs(r).length
          ? 'final for the customer'
          : toolCall('zp_ask_agent', { agent: 'hr-finance', question: 'What is the refund limit?' });
      if (who === 'HR & Finance') {
        if (/refund limit/.test(lastUser(r))) {
          if (!toolMsgs(r).length)
            return toolCall('zp_ask_agent', { agent: 'customer-service', question: 'Who is asking?' });
          seenCycle = toolMsgs(r)[0].content;
          return 'limit is $100';
        }
        const n = toolMsgs(r).length;
        return n < 3
          ? toolCall('acc_usage_summary', {}, `u${n}`)
          : `done after ${toolMsgs(r)
              .map((m) => m.content)
              .join(' | ')}`;
      }
      return `draft v${++drafts}`;
    },
    { tools: [{ name: 'acc_usage_summary', description: 'usage', inputSchema: { type: 'object', properties: {} } }] },
  );
  try {
    let { run } = await t.collab.run({
      pattern: 'review',
      task: 'Write it',
      agent: 'content-writer',
      budget: { calls: 3 },
    });
    assert.equal(run.state, 'completed');
    assert.equal(run.answer, 'draft v1');
    assert.equal(run.stop.partial, true);
    assert.match(run.stop.reason, /budget reached \(model calls\)/);
    ({ run } = await t.collab.run({ pattern: 'agent', agent: 'customer-service', task: 'Customer wants $80 back' }));
    assert.equal(run.answer, 'final for the customer');
    assert.match(seenCycle, /already working on this request \(customer-service → hr-finance\)/);
    assert.ok(run.blackboard.some((e) => e.kind === 'consult' && e.by === 'hr-finance'));
    assert.equal(run.trace.find((s) => s.name === 'invoke_agent hr-finance').attrs['zp.depth'], 1);
    ({ run } = await t.collab.run({ pattern: 'agent', agent: 'hr-finance', task: 'usage this month' }));
    assert.equal(t.toolCalls.length, 2);
    assert.match(run.answer, /already made this exact call twice/);
    slow = true;
    const s = t.collab.start({ pattern: 'agent', agent: 'content-writer', task: 'slow one' });
    await sleep(20);
    assert.equal(t.collab.cancel(s.run.id).run.state, 'canceled');
    assert.equal((await s.done).state, 'canceled');
    assert.equal(t.collab.cancel(s.run.id).error, 'not-cancelable');
    assert.deepEqual(t.collab.start({ pattern: 'vote', task: 'x', agents: ['nobody'] }).errors, [
      'agents: no enabled agent "nobody"',
    ]);
  } finally {
    await t.close();
  }
});

test('A2A: agent card, SendMessage in v1.0 and v0.3, streaming, tasks, approvals and errors', async () => {
  const t = await setup((r) =>
    sys(r).startsWith('You are the ZAAFPulse planner') ? 'no plan' : `answer from ${agentOf(r)}`,
  );
  try {
    const card = await t.call('/.well-known/agent-card.json', null, null, 'GET');
    assert.equal(card.status, 200);
    assert.equal(card.json.capabilities.streaming, true);
    assert.equal(card.json.capabilities.pushNotifications, false);
    const skills = card.json.skills.map((s) => s.id);
    for (const id of [
      'auto',
      'vote',
      'debate',
      'review',
      'group',
      'handoff',
      'agent:customer-service',
      'workflow:incident-triage-rca',
    ])
      assert.ok(skills.includes(id), id);
    assert.equal(card.json.supportedInterfaces[0].url, `${t.base}/a2a`);
    assert.equal(
      (await t.call('/a2a', null, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} })).status,
      401,
    );
    const key = t.key({ approveOwnRuns: true }); // this test approves its own tasks over A2A;
    const rpc = (method, params, id = 1) => t.call('/a2a', key, { jsonrpc: '2.0', id, method, params });
    const v1 = await rpc('SendMessage', {
      message: {
        messageId: 'm1',
        role: 'ROLE_USER',
        parts: [{ text: 'Draft a refund reply' }],
        metadata: { skill: 'agent:customer-service' },
      },
    });
    const task = v1.json.result.task;
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(task.artifacts[0].parts[0].text, 'answer from Customer Service');
    assert.match(task.contextId, /^ses_/);
    const v03 = await rpc('message/send', {
      message: {
        kind: 'message',
        messageId: 'm2',
        role: 'user',
        parts: [{ kind: 'text', text: 'Same again' }],
        contextId: task.contextId,
        metadata: { skill: 'agent:customer-service' },
      },
    });
    assert.equal(v03.json.result.kind, 'task');
    assert.equal(v03.json.result.status.state, 'completed');
    assert.equal(v03.json.result.contextId, task.contextId);
    const got = await rpc('GetTask', { id: task.id, historyLength: 2 });
    assert.equal(got.json.result.history.length, 2);
    assert.equal(got.json.result.history[0].role, 'ROLE_USER');
    assert.equal((await rpc('tasks/get', { id: 'run_0000' })).json.error.code, -32001);
    assert.equal((await rpc('NoSuchMethod', {})).json.error.code, -32601);
    assert.equal(
      (await rpc('SendMessage', { message: { parts: [{ text: 'x' }], metadata: { skill: 'telepathy' } } })).json.error
        .code,
      -32602,
    );
    assert.equal((await rpc('CancelTask', { id: task.id })).json.error.code, -32002);
    assert.equal((await rpc('CreateTaskPushNotificationConfig', {})).json.error.code, -32003);
    const list = await rpc('ListTasks', { contextId: task.contextId });
    assert.equal(list.json.result.totalSize, 2);
    const sse = await rpc('SendStreamingMessage', {
      message: {
        messageId: 'm3',
        role: 'ROLE_USER',
        parts: [{ text: 'stream it' }],
        metadata: { skill: 'agent:research' },
      },
    });
    const events = sse.text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)).result);
    assert.ok(events[0].task);
    assert.ok(events.some((e) => e.statusUpdate && e.statusUpdate.status.state === 'TASK_STATE_WORKING'));
    assert.equal(events.find((e) => e.artifactUpdate).artifactUpdate.artifact.parts[0].text, 'answer from Research');
    assert.equal(events.at(-1).statusUpdate.status.state, 'TASK_STATE_COMPLETED');
    t.gateway.workflows.save({
      id: 'gated',
      name: 'Gated',
      steps: [
        { agent: 'hr-finance', prompt: '{{input}}' },
        { agent: 'legal-compliance', prompt: '{{step1}}', approve: true },
      ],
    });
    const w = await rpc('SendMessage', {
      message: {
        messageId: 'm4',
        role: 'ROLE_USER',
        parts: [{ text: 'buy laptops' }],
        metadata: { skill: 'workflow:gated' },
      },
    });
    assert.equal(w.json.result.task.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.match(w.json.result.task.status.message.parts[0].text, /Approve step 2/);
    // An unclear reply never approves; the task keeps waiting.
    const vague = await rpc('SendMessage', {
      message: {
        messageId: 'm5a',
        role: 'ROLE_USER',
        taskId: w.json.result.task.id,
        parts: [{ text: 'jangan kirim dulu' }],
      },
    });
    assert.equal(vague.json.error, undefined);
    assert.equal(vague.json.result.task.status.state, 'TASK_STATE_REJECTED');
    const w2 = await rpc('SendMessage', {
      message: {
        messageId: 'm4b',
        role: 'ROLE_USER',
        parts: [{ text: 'buy laptops' }],
        metadata: { skill: 'workflow:gated' },
      },
    });
    assert.equal(
      (
        await rpc('SendMessage', {
          message: {
            messageId: 'm5b',
            role: 'ROLE_USER',
            taskId: w2.json.result.task.id,
            parts: [{ text: 'hmm, maybe later' }],
          },
        })
      ).json.error.code,
      -32602,
    );
    const yes = await rpc('SendMessage', {
      message: {
        messageId: 'm5',
        role: 'ROLE_USER',
        taskId: w2.json.result.task.id,
        parts: [{ text: 'yes, approved' }],
      },
    });
    assert.equal(yes.json.result.task.status.state, 'TASK_STATE_COMPLETED');
    assert.match(
      yes.json.result.task.artifacts[0].parts[0].text,
      /^answer from Legal & Compliance\n\nApproved with this note: yes, approved\./,
    );
  } finally {
    await t.close();
  }
});

test('remote A2A agents and collab/<pattern> models through chat completions', async () => {
  const t = await setup((r) =>
    sys(r).startsWith('You are the ZAAFPulse planner')
      ? 'no plan'
      : `answer from ${agentOf(r)}\nFINAL ANSWER: yes\nCONFIDENCE: 0.9`,
  );
  try {
    process.env.ZP_SECRET_REMOTE_TEST = t.key();
    assert.deepEqual(
      t.gateway.agents.save({
        id: 'remote-helper',
        name: 'Remote helper',
        description: 'A helper on another A2A server',
        remoteUrl: `${t.base}/a2a`,
        remoteTokenEnv: 'ZP_SECRET_REMOTE_TEST',
      }).errors,
      undefined,
    );
    const { run } = await t.collab.run({
      pattern: 'agent',
      agent: 'remote-helper',
      task: 'Is the content writer there?',
    });
    assert.equal(run.state, 'completed');
    assert.match(run.answer, /^answer from Content Writer/);
    assert.match(run.steps[0].model, /^a2a:127\.0\.0\.1/);
    const priv = await t.call('/v1/collaborate', t.key({ privateOnly: true }), {
      pattern: 'agent',
      agent: 'remote-helper',
      task: 'hi',
    });
    assert.equal(priv.json.state, 'failed');
    assert.match(priv.json.error, /private models only/);
    const key = t.key();
    const models = await t.call('/v1/models', key, null, 'GET');
    assert.ok(models.json.data.some((m) => m.id === 'collab/vote'));
    const c = await t.call('/v1/chat/completions', key, {
      model: 'collab/vote',
      messages: [{ role: 'user', content: 'Is it up?' }],
      zp: { samples: 3, agents: ['sre-observability'] },
    });
    assert.equal(c.status, 200);
    assert.match(c.json.choices[0].message.content, /FINAL ANSWER: yes/);
    assert.equal(t.collab.list({ limit: 1 })[0].steps.length, 3);
    assert.equal(
      (
        await t.call('/v1/chat/completions', key, {
          model: 'collab/telepathy',
          messages: [{ role: 'user', content: 'x' }],
        })
      ).status,
      404,
    );
  } finally {
    delete process.env.ZP_SECRET_REMOTE_TEST;
    await t.close();
  }
});

test('a failed run keeps the upstream HTTP code: 404 for an unknown model, not 502', async () => {
  const t = await setup(() => ({ status: 404, body: { error: { message: 'model m not found' } } }));
  try {
    const { run } = await t.collab.run({ pattern: 'agent', agent: 'sre-observability', task: 'Is it up?' });
    assert.equal(run.state, 'failed');
    assert.equal(run.steps[0].status, 'failed');
    assert.equal(run.steps[0].httpStatus, 404);
    assert.equal(run.errorStatus, 404);
    const c = await t.call('/v1/chat/completions', t.key(), {
      model: 'collab/parallel',
      messages: [{ role: 'user', content: 'Is it up?' }],
      zp: { agents: ['sre-observability'] },
    });
    assert.equal(c.status, 404);
    assert.equal(c.json.error.type, 'invalid_request_error');
    assert.match(c.json.error.message, /model m not found/);
  } finally {
    await t.close();
  }
});

test('a failed run whose upstream broke still reports 502 upstream_error', async () => {
  const t = await setup(() => ({ status: 500, body: { error: { message: 'boom' } } }));
  try {
    const c = await t.call('/v1/chat/completions', t.key(), {
      model: 'collab/parallel',
      messages: [{ role: 'user', content: 'Is it up?' }],
      zp: { agents: ['sre-observability'] },
    });
    assert.equal(c.status, 502);
    assert.equal(c.json.error.type, 'upstream_error');
    const run = t.collab.list({ limit: 1 })[0];
    assert.equal(run.steps[0].httpStatus, 500);
  } finally {
    await t.close();
  }
});
