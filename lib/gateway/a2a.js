// A2A (Agent2Agent) server for ZAAFPulse: JSON-RPC 2.0 over HTTP with SSE streaming, no dependencies.
// The agent card is at /.well-known/agent-card.json; calls go to POST /a2a with a ZAAFPulse key that has
// the "agents" scope. v1.0 method names (SendMessage, GetTask, ...) and v0.3 names (message/send,
// tasks/get, ...) are both accepted, and each answer uses the shape of the version it was asked in.
// A task is a collaboration run and contextId is the session. Skills: the collaboration patterns,
// "agent:<id>" for one specialist and "workflow:<id>" for a saved workflow; the skill comes from
// message.metadata.skill (default "auto"), and metadata.options holds pattern options (agents, effort, ...).
// Push notifications are off: the spec forbids loopback webhooks and this gateway is localhost only.
const crypto = require('crypto');

const METHODS = {
  SendMessage: 'send',
  'message/send': 'send',
  SendStreamingMessage: 'stream',
  'message/stream': 'stream',
  GetTask: 'get',
  'tasks/get': 'get',
  ListTasks: 'list',
  'tasks/list': 'list',
  CancelTask: 'cancel',
  'tasks/cancel': 'cancel',
  SubscribeToTask: 'subscribe',
  'tasks/resubscribe': 'subscribe',
  GetExtendedAgentCard: 'card',
  'agent/getAuthenticatedExtendedCard': 'card',
  CreateTaskPushNotificationConfig: 'push',
  GetTaskPushNotificationConfig: 'push',
  ListTaskPushNotificationConfigs: 'push',
  DeleteTaskPushNotificationConfig: 'push',
  'tasks/pushNotificationConfig/set': 'push',
  'tasks/pushNotificationConfig/get': 'push',
  'tasks/pushNotificationConfig/list': 'push',
  'tasks/pushNotificationConfig/delete': 'push',
};
const ERR = {
  parse: [-32700, 'Parse error'],
  invalid: [-32600, 'Invalid Request'],
  method: [-32601, 'Method not found'],
  params: [-32602, 'Invalid params'],
  internal: [-32603, 'Internal error'],
  notFound: [-32001, 'Task not found'],
  notCancelable: [-32002, 'Task cannot be canceled'],
  push: [-32003, 'Push notifications are not supported'],
  unsupported: [-32004, 'This operation is not supported'],
};
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);
const v1State = (s) => `TASK_STATE_${String(s).toUpperCase().replace(/-/g, '_')}`;
const rpcError = (id, kind, detail) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code: ERR[kind][0], message: detail ? `${ERR[kind][1]}: ${detail}` : ERR[kind][1] },
});

function agentCard({ base, version, agents, workflows, patterns }) {
  const skill = (id, name, description, tags, examples) => ({
    id,
    name,
    description,
    tags,
    ...(examples ? { examples } : {}),
    inputModes: ['text/plain'],
    outputModes: ['text/plain', 'application/json'],
  });
  return {
    name: 'ZAAFPulse Agent Gateway',
    description:
      'Domain agents and multi-agent collaboration (orchestrator, vote, debate, review, group chat, handoff, workflows) on this machine.',
    version,
    supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    url: `${base}/a2a`,
    preferredTransport: 'JSONRPC',
    protocolVersion: '0.3.0', // for v0.3 clients
    provider: { organization: 'ZAAFPulse (local)', url: base },
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      zaafpulseKey: { type: 'http', scheme: 'bearer', description: 'A ZAAFPulse API key (zp_…) with the agents scope' },
    },
    security: [{ zaafpulseKey: [] }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      ...Object.entries(patterns)
        .filter(([id]) => !['agent', 'workflow'].includes(id))
        .map(([id, p]) => skill(id, p.name, p.description, ['collaboration', id])),
      ...agents.map((a) =>
        skill(
          `agent:${a.id}`,
          a.name,
          a.description,
          ['agent', a.domain].filter(Boolean),
          (a.keywords || []).slice(0, 2).map((k) => `Help with ${k}`),
        ),
      ),
      ...workflows.map((w) =>
        skill(`workflow:${w.id}`, w.name, w.description || `Workflow with ${w.steps.length} steps`, ['workflow']),
      ),
    ],
  };
}

function createA2A({ collab, sessions, agents, workflows, version }) {
  const textOf = (message) =>
    (Array.isArray(message.parts) ? message.parts : [])
      .map((p) => (typeof p.text === 'string' ? p.text : p.data !== undefined ? JSON.stringify(p.data) : ''))
      .filter(Boolean)
      .join('\n');
  const message = (legacy, run, role, text, id) =>
    legacy
      ? {
          kind: 'message',
          messageId: id,
          role: role === 'user' ? 'user' : 'agent',
          parts: [{ kind: 'text', text }],
          taskId: run.id,
          contextId: run.contextId,
        }
      : {
          messageId: id,
          role: role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT',
          parts: [{ text }],
          taskId: run.id,
          contextId: run.contextId,
        };
  const statusOf = (run, legacy) => {
    const note =
      run.state === 'input-required' && run.pending
        ? run.pending.question
        : run.state === 'failed'
          ? run.error
          : run.stop && TERMINAL.has(run.state)
            ? run.stop.reason
            : '';
    return {
      state: legacy ? run.state : v1State(run.state),
      timestamp: new Date(run.updatedAt).toISOString(),
      ...(note ? { message: message(legacy, run, 'agent', note, `${run.id}-status`) } : {}),
    };
  };
  const artifactsOf = (run, legacy) => [
    ...(run.answer
      ? [
          {
            artifactId: `${run.id}-answer`,
            name: 'answer',
            parts: [legacy ? { kind: 'text', text: run.answer } : { text: run.answer, mediaType: 'text/plain' }],
          },
        ]
      : []),
    ...(run.verdict
      ? [
          {
            artifactId: `${run.id}-verdict`,
            name: 'verdict',
            parts: [
              legacy ? { kind: 'data', data: run.verdict } : { data: run.verdict, mediaType: 'application/json' },
            ],
          },
        ]
      : []),
  ];
  function toTask(run, legacy, historyLength = 0) {
    const history = historyLength
      ? [
          message(legacy, run, 'user', run.task, `${run.id}-in`),
          ...(run.answer ? [message(legacy, run, 'agent', run.answer, `${run.id}-out`)] : []),
        ].slice(-historyLength)
      : undefined;
    return {
      ...(legacy ? { kind: 'task' } : {}),
      id: run.id,
      contextId: run.contextId,
      status: statusOf(run, legacy),
      artifacts: artifactsOf(run, legacy),
      ...(history ? { history } : {}),
      metadata: {
        pattern: run.pattern,
        effort: run.effort,
        usage: {
          inputTokens: run.spent.input,
          outputTokens: run.spent.output,
          costUSD: +run.spent.cost.toFixed(6),
          modelCalls: run.spent.requests,
        },
        steps: run.steps.length,
        ...(run.verdict && run.verdict.needsReview ? { needsReview: true } : {}),
      },
    };
  }
  // skill → collaboration spec; errors as a string.
  function specFor(skill, options, text) {
    const s = String(skill || 'auto');
    if (s.startsWith('agent:')) return { ...options, pattern: 'agent', agent: s.slice(6), task: text };
    if (s.startsWith('workflow:')) return { ...options, pattern: 'workflow', workflow: s.slice(9), task: text };
    if (!collab.PATTERNS[s] || s === 'agent' || s === 'workflow') return `unknown skill "${s}"; see the agent card`;
    return { ...options, pattern: s, task: text };
  }

  // Handles one JSON-RPC request. Returns the response object, or null when it streamed the answer itself.
  async function rpc(body, { key, ctx, res, headers }) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      body.jsonrpc !== '2.0' ||
      typeof body.method !== 'string'
    )
      return rpcError(body && body.id, 'invalid');
    const { id, method } = body;
    const params = body.params || {};
    const kind = METHODS[method];
    if (!kind) return rpcError(id, 'method', method);
    const legacy = method.includes('/');
    const own = (taskId) => collab.get(String(taskId || ''), key.id);
    const ok = (result) => ({ jsonrpc: '2.0', id, result });

    if (kind === 'push') return rpcError(id, 'push');
    if (kind === 'card') return rpcError(id, 'unsupported', 'there is no extended agent card');
    if (kind === 'get') {
      const r = own(params.id);
      if (!r) return rpcError(id, 'notFound');
      return ok(toTask(r, legacy, Math.max(0, Math.min(50, Number(params.historyLength) || 0))));
    }
    if (kind === 'list') {
      const size = Math.max(1, Math.min(50, Number(params.pageSize) || 20));
      const list = collab
        .list({ keyId: key.id, contextId: params.contextId, limit: 200 })
        .filter((r) => !params.status || [r.state, v1State(r.state)].includes(params.status));
      const offset = Math.max(0, Number(params.pageToken) || 0);
      return ok({
        tasks: list.slice(offset, offset + size).map((r) => toTask(r, legacy)),
        nextPageToken: offset + size < list.length ? String(offset + size) : '',
        pageSize: size,
        totalSize: list.length,
      });
    }
    if (kind === 'cancel') {
      const c = collab.cancel(String(params.id || ''), key.id);
      if (c.error === 'not-found') return rpcError(id, 'notFound');
      if (c.error) return rpcError(id, 'notCancelable', `the task is ${c.run.state}`);
      return ok(toTask(c.run, legacy));
    }
    if (kind === 'subscribe') {
      const r = own(params.id);
      if (!r) return rpcError(id, 'notFound');
      if (TERMINAL.has(r.state)) return rpcError(id, 'unsupported', `the task is already ${r.state}`);
      stream(res, id, r, legacy, null, headers);
      return null;
    }

    // send / stream
    const msg = params.message;
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.parts))
      return rpcError(id, 'params', 'message with parts is required');
    const text = textOf(msg).trim();
    if (!text) return rpcError(id, 'params', 'the message has no text part');
    const meta = { ...(params.metadata || {}), ...(msg.metadata || {}) };
    let started;
    if (msg.taskId) {
      // A follow-up to a task waiting for input: an approval decision (metadata.approve, or a yes/no reply).
      const r = own(msg.taskId);
      if (!r) return rpcError(id, 'notFound');
      if (r.state !== 'input-required')
        return rpcError(
          id,
          'unsupported',
          `task ${r.id} is ${r.state}; send a new message (with referenceTaskIds) instead`,
        );
      // Only an explicit decision counts: metadata.approve, or a reply that starts with a clear yes or no.
      // Anything else ("not yet", "nanti saja") leaves the task waiting, so an unclear reply never approves.
      const yes = /^\s*(yes|y|approve|approved|ok|okay|go ahead|setuju|ya|iya|lanjut|lanjutkan)\b/i.test(text);
      const no = /^\s*(no|n|reject|rejected|deny|stop|cancel|tolak|tidak|jangan|batal|nanti)\b/i.test(text);
      const approve = typeof meta.approve === 'boolean' ? meta.approve : yes && !no ? true : no && !yes ? false : null;
      if (approve === null)
        return rpcError(
          id,
          'params',
          'reply with an explicit decision: start with "approve" or "reject", or set metadata.approve to true or false',
        );
      started = collab.resume(r.id, { approve, note: text }, ctx);
      if (started.error) return rpcError(id, 'unsupported', started.error);
    } else {
      const opened = sessions.open(msg.contextId, { keyId: key.id, agent: 'a2a', title: text });
      if (opened.error) return rpcError(id, 'params', 'contextId belongs to another key');
      const spec = specFor(
        meta.skill || meta.skillId,
        meta.options && typeof meta.options === 'object' ? meta.options : {},
        text,
      );
      if (typeof spec === 'string') return rpcError(id, 'params', spec);
      started = collab.start(spec, { ...ctx, session: opened.session });
      if (started.errors) return rpcError(id, 'params', started.errors.join('; '));
    }
    if (kind === 'stream') {
      stream(res, id, started.run, legacy, started.done, headers);
      return null;
    }
    const cfg = params.configuration || {};
    const immediate = cfg.returnImmediately === true || cfg.blocking === false;
    const run = immediate ? started.run : await started.done;
    const task = toTask(run, legacy, Math.max(0, Math.min(50, Number(cfg.historyLength) || 0)));
    return ok(legacy ? task : { task });
  }

  // SSE: the task first, then status and artifact events while it runs, then the stream closes.
  function stream(res, id, run, legacy, done, headers) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...headers,
    });
    const send = (result) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
    };
    const status = (final, note) => {
      const ev = {
        taskId: run.id,
        contextId: run.contextId,
        status: note
          ? { ...statusOf(run, legacy), message: message(legacy, run, 'agent', note, crypto.randomUUID()) }
          : statusOf(run, legacy),
      };
      send(legacy ? { kind: 'status-update', ...ev, final } : { statusUpdate: ev });
    };
    send(legacy ? toTask(run, legacy) : { task: toTask(run, legacy) });
    if (run.state === 'working') status(false);
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      off && off();
      for (const a of artifactsOf(run, legacy)) {
        const ev = { taskId: run.id, contextId: run.contextId, artifact: a, append: false, lastChunk: true };
        send(legacy ? { kind: 'artifact-update', ...ev } : { artifactUpdate: ev });
      }
      status(true);
      res.end();
    };
    // Progress: a working status whenever an agent starts, so clients can show who is on it.
    const off = collab.subscribe(run.id, (ev) => {
      if (ev.type === 'span' && ev.span.name.startsWith('invoke_agent '))
        status(false, `${ev.span.attrs['gen_ai.agent.name'] || ev.span.attrs['gen_ai.agent.id']} is working`);
      if (ev.type === 'status' && (TERMINAL.has(ev.state) || ev.state === 'input-required')) setImmediate(finish);
    });
    res.on('close', () => {
      closed = true;
      off && off();
    });
    if (TERMINAL.has(run.state) || run.state === 'input-required' || !off) setImmediate(finish);
    else if (done)
      done.then(
        () => setImmediate(finish),
        () => setImmediate(finish),
      );
  }

  return {
    card: (base) =>
      agentCard({ base, version, agents: agents.enabled(), workflows: workflows.list(), patterns: collab.PATTERNS }),
    rpc,
    toTask,
    rpcError,
  };
}

module.exports = { createA2A, agentCard, v1State, METHODS };
