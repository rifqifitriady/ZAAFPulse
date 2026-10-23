// One stored trace's summary, built span by span as lines are indexed. The root is the span that starts first
// (a request continued from a caller has a remote parent, so "no parent" is not enough). Tokens and cost come
// from chat spans only: agent and workflow spans repeat their children's totals. A span from the return channel
// (src 'remote') is the root only while none of ours is known, and adds names but no tokens, cost, tool calls or
// run id: its tokens were not billed here (or were, through this gateway, and are counted already).
const LIST_MAX = 20;

function blankSummary(traceId) {
  return {
    traceId,
    src: null,
    svc: null,
    root: null,
    rootStart: 0,
    start: 0,
    end: 0,
    spans: 0,
    errors: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUSD: 0,
    models: [],
    agents: [],
    tools: [],
    runId: null,
  };
}

const addTo = (list, v) => {
  if (v != null && v !== '' && !list.includes(String(v)) && list.length < LIST_MAX) list.push(String(v));
};

function addSpan(sum, sp) {
  sum.spans++;
  if (!sp.ok) sum.errors++;
  const end = sp.st + sp.d;
  if (!sum.start || sp.st < sum.start) sum.start = sp.st;
  if (end > sum.end) sum.end = end;
  const remote = sp.src === 'remote';
  // Ours before any remote one: sum.src tells whether the current root came from outside.
  const better = !sum.root || sp.st < sum.rootStart || (sp.st === sum.rootStart && !sp.p);
  if (remote ? !sum.root || (sum.src === 'remote' && better) : sum.src === 'remote' || better) {
    sum.root = sp.n;
    sum.rootStart = sp.st;
    sum.src = sp.src;
    sum.svc = sp.svc;
  }
  const a = sp.a || {};
  const op = a['gen_ai.operation.name'];
  if (op === 'chat') {
    if (!remote) {
      sum.tokensIn += Number(a['gen_ai.usage.input_tokens']) || 0;
      sum.tokensOut += Number(a['gen_ai.usage.output_tokens']) || 0;
      sum.costUSD += Number(a['zaafpulse.cost.usd']) || 0;
    }
    addTo(sum.models, a['gen_ai.request.model']);
  }
  // An integration call under the agent's own tool span is the same call; count the outer one.
  if (op === 'execute_tool' && !a['zaafpulse.tool.nested'] && !remote) sum.toolCalls++;
  addTo(sum.agents, a['gen_ai.agent.id']);
  addTo(sum.tools, a['gen_ai.tool.name']);
  if (a['zaafpulse.run.id'] && !sum.runId && !remote) sum.runId = String(a['zaafpulse.run.id']);
  return sum;
}

function summarize(traceId, spans) {
  const sum = blankSummary(traceId);
  for (const sp of spans) addSpan(sum, sp);
  return sum;
}

module.exports = { blankSummary, addSpan, summarize };
