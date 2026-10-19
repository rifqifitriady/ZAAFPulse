'use strict';
/* Quality & safety views. Every number here is a signal detected in local logs, and each
   drawer lists the matched items so the reader can judge them. */

// Model-caused failure categories, in the validated adjacent order (aqua, violet, magenta, yellow).
const FAIL_CATS = [
  { id: 'other', name: 'Other tool error', color: 'var(--tt-input)' },
  { id: 'process', name: 'Skipped a step', color: 'var(--tt-output)' },
  { id: 'hallucination', name: 'Hallucination signal', color: 'var(--tt-cread)' },
  { id: 'execution', name: 'Command or test failed', color: 'var(--tt-cwrite)' },
];
// Fixed neon colors for the 3D failures chart (the deck is dark in both themes).
const FAIL_NEON = { other: '#3ee6b0', process: '#8b7bff', hallucination: '#ff5ca8', execution: '#ffb547' };
const KIND_HELP = {
  'Path that does not exist': 'The model read or wrote a file path that is not on disk.',
  'Edit text not in the file': 'The model tried to replace text that the file does not contain.',
  'Invalid tool arguments': 'The model called a tool with parameters that do not exist or are malformed.',
  'URL that does not exist': 'The model fetched a URL that returned 404 or does not resolve.',
};
// Change in percentage points. lowerIsBetter flips the color, not the arrow.
const pts = (cur, prev, lowerIsBetter = false) => {
  if (cur == null || prev == null) return '';
  const d = (cur - prev) * 100;
  const cls = Math.abs(d) < 0.05 ? 'flat' : d > 0 !== lowerIsBetter ? 'up' : 'down';
  return `<small class="delta ${cls}">${d > 0 ? '↑' : d < 0 ? '↓' : '→'} ${Math.abs(d).toFixed(1)} pts</small>`;
};

function eventList(events, empty = 'Nothing detected in this range.') {
  if (!events.length) return `<div class="empty">${empty}</div>`;
  return `<ul class="events">${events
    .map(
      (e, i) => `<li class="ev" style="--i:${Math.min(i, 12)}">
    <span class="ev-dot k-${esc(e.kind)}${e.category ? ' c-' + esc(e.category) : ''}"></span>
    <div class="ev-main"><div class="ev-top"><b>${esc(e.label)}</b>${e.source ? `<span class="tag">${esc(e.source.replace(/^mcp__/, '').slice(0, 40))}</span>` : ''}${e.external ? '<span class="tag warn">external</span>' : ''}
      <span class="muted">${esc(e.project || toolName(e.tool))} · ${ago(e.ts)}</span></div>
      ${e.text ? `<div class="ev-text">${esc(e.text)}</div>` : ''}</div></li>`,
    )
    .join('')}</ul>`;
}

function qualityKpis() {
  const q = state.data.quality;
  const topKind = q.kinds.find((k) => KIND_HELP[k.label]);
  const inj = q.injection;
  const c = q.corrections;
  const rel = q.relevance || {};
  const fa = q.faithfulness || {};
  return `<div class="grid kpis six">
    ${kpiCard({
      title: 'Accuracy',
      chip: 'green',
      ic: 'target',
      drill: 'accuracy',
      value: q.accuracy ?? 0,
      fmt: 'pct',
      after: pts(q.accuracy, q.prevAccuracy),
      sub: `${whole.format(q.modelFailures)} model-caused failures in ${fmtN(q.results)} tool calls`,
    })}
    ${kpiCard({
      title: 'Hallucination signals',
      chip: 'violet',
      ic: 'ghost',
      drill: 'hallucination',
      value: q.hallucinations,
      fmt: 'int',
      after: delta(q.hallucinations, q.prevHallucinations, true),
      sub: `${q.hallucinationRate.toFixed(1)} per 1,000 calls${topKind ? ` · mostly ${topKind.label.toLowerCase()}` : ''}`,
    })}
    ${kpiCard({
      title: 'Poisoning detections',
      chip: inj.external ? 'red' : 'blue',
      ic: 'shield',
      drill: 'poisoning',
      value: inj.external,
      fmt: 'int',
      after: `<small class="muted">from external content</small>`,
      sub: `${fmtN(inj.externalCalls)} web and MCP results scanned · ${inj.local} matches in local files`,
    })}
    ${kpiCard({
      title: 'Correction rate',
      chip: 'amber',
      ic: 'undo',
      drill: 'corrections',
      value: c.rate,
      fmt: 'pct',
      after: pts(c.rate, c.prevRate, true),
      sub: `${c.corrections} corrections · ${c.interrupts} interrupts · ${c.rejections} rejections`,
    })}
    ${kpiCard({
      title: 'Relevance',
      chip: 'blue',
      ic: 'compass',
      drill: 'relevance',
      value: rel.score ?? 0,
      fmt: 'pct',
      after: pts(rel.score, rel.prev),
      sub: rel.turns ? `${fmtN(rel.turns)} turns graded · ${rel.low} off-topic` : 'no graded turns yet',
    })}
    ${kpiCard({
      title: 'Faithfulness',
      chip: fa.unsupported ? 'amber' : 'green',
      ic: 'anchor',
      drill: 'faithfulness',
      value: fa.score ?? 0,
      fmt: 'pct',
      after: pts(fa.score, fa.prev),
      sub: fa.claims ? `${fmtN(fa.grounded)} of ${fmtN(fa.claims)} references grounded` : 'no checkable references yet',
    })}
  </div>`;
}

function failureSeries() {
  return FAIL_CATS.map((c) => ({ ...c, get: (d) => d.cats[c.id] || 0 }));
}

function viewQuality() {
  const q = state.data.quality;
  const s = q.safety;
  const r = q.reliability;
  const tile = (drill, label, value, sub, warn) =>
    `<div class="tile clickable${warn ? ' warn' : ''}" role="button" tabindex="0" data-drill="${drill}"><span>${label}</span><b class="num">${counter(value, 'int')}</b><small>${sub}</small></div>`;
  return (
    hero(
      'QUALITY & SAFETY',
      'How well your AI is working',
      `Accuracy, relevance, faithfulness, hallucination, poisoning and safety signals from the ${rangeText()}.`,
    ) +
    `<div class="notice info">${icon('alert')}<div><b>These are signals detected in your local logs</b>, not a graded evaluation. Every card opens the exact items that were matched, so you can judge them yourself.</div></div>
    ${qualityKpis()}
    <section class="holo stage failures-stage">
      <canvas id="quality-scene" aria-label="3D chart of model-caused failures per day, stacked by category, with daily accuracy and tool calls on the back walls"></canvas>
      <div class="stage-tl"><div class="holo-kicker">MODEL-CAUSED FAILURES PER DAY</div>
        <div class="stage-key">One tower per day, stacked by cause · back walls: accuracy and tool calls per day · hover a tower · drag to rotate</div></div>
      <div class="stage-legend">${FAIL_CATS.map((c) => `<span><i style="background:${FAIL_NEON[c.id]}"></i>${c.name}</span>`).join('')}</div>
    </section>
    <div class="grid two">
      <div class="card"><div class="card-head"><h3>Safety</h3><span class="meta">what the AI saw and did</span></div>
        <div class="tiles">
          ${tile('safety', 'Secrets exposed', s.secrets, 'keys or tokens in tool output', s.secrets > 0)}
          ${tile('safety', 'Risky commands', s.risky, 'force deletes, force pushes, sudo…', false)}
          ${tile('corrections', 'Guardrail rejections', q.corrections.rejections, 'blocked by you or auto mode', false)}
          ${tile('poisoning', 'Injection matches', q.injection.external + q.injection.local, `${q.injection.external} external · ${q.injection.local} local`, q.injection.external > 0)}
        </div></div>
      <div class="card"><div class="card-head"><h3>Reliability</h3><span class="meta">things that interrupted the work</span></div>
        <div class="tiles">
          ${tile('reliability', 'API errors', r.apiErrors, 'limits, outages, network', false)}
          ${tile('reliability', 'Network & timeouts', r.environment, 'tool calls that could not finish', false)}
          ${tile('reliability', 'Repeat loops', r.loops, 'same call 3+ times in a row', r.loops > 0)}
          ${tile('reliability', 'Context compactions', r.compactions, 'sessions that ran out of context', false)}
        </div></div>
    </div>
    <div class="grid two">
      <div class="card"><div class="card-head"><h3>Failure rate by tool</h3><span class="meta">model-caused failures ÷ calls</span></div>
        ${
          q.tools.length
            ? `<div class="table-wrap"><table><thead><tr><th>Tool</th><th class="r">Calls</th><th class="r">Failures</th><th class="r">Rate</th></tr></thead><tbody>
        ${q.tools
          .map(
            (
              t,
            ) => `<tr><td><div class="clip">${esc(t.tool.replace(/^mcp__/, ''))}</div></td><td class="r num">${fmtN(t.calls)}</td><td class="r num">${t.modelFailures}</td>
          <td class="r num"><span class="rate"><i style="width:${Math.min(100, t.failureRate * 400)}%"></i></span>${fmtPct(t.failureRate)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
            : '<div class="empty">Not enough tool calls yet.</div>'
        }</div>
      <div class="card"><div class="card-head"><h3>Recent signals</h3><span class="meta">newest first</span></div>
        <div class="feed">${eventList(q.feed.slice(0, 12))}</div></div>
    </div>`
  );
}

function drawQualityChart(el) {
  drawStacked(el, {
    rows: state.data.quality.daily,
    height: 220,
    fmt: (v) => whole.format(Math.round(v)),
    label: 'Model-caused failures per day by category',
    series: failureSeries(),
    extraTip: (d) =>
      `<div class="row"><span>Tool calls</span><span class="num">${fmtN(d.results)}</span></div><div class="row"><span>Accuracy</span><span class="num">${d.accuracy == null ? '—' : fmtPct(d.accuracy)}</span></div>`,
  });
}

const QUALITY_DRILLS = {
  accuracy() {
    const q = state.data.quality;
    const excluded =
      (q.categories.find((c) => c.id === 'environment')?.count || 0) +
      (q.categories.find((c) => c.id === 'rejection')?.count || 0);
    return {
      eyebrow: `QUALITY · ${rangeText().toUpperCase()}`,
      title: 'Accuracy',
      body:
        tiles([
          ['Accuracy', counter(q.accuracy ?? 0, 'pct'), pts(q.accuracy, q.prevAccuracy) || 'tool calls that worked'],
          ['Tool calls', counter(q.results, 'n'), 'with a recorded result'],
          ['Model-caused failures', counter(q.modelFailures, 'int'), 'counted against accuracy'],
          ['Not counted', counter(excluded, 'int'), 'network, timeouts, your rejections'],
        ]) +
        dsec(
          1,
          'How it is measured',
          `<p class="drawer-note" style="margin:0">Accuracy is the share of tool calls that succeeded. A call counts as a failure when the model caused it: a hallucinated path or argument, an edit that did not match, a command or test that failed. Network errors, timeouts and calls you rejected are left out. It measures how reliably the AI acts, not whether its written answers are true.</p>`,
        ) +
        dsec(
          2,
          'Failures by cause',
          composition(
            q.categories.map((c, i) => ({
              name: c.label + (c.modelFault ? '' : ' (not counted)'),
              value: c.count,
              color:
                FAIL_CATS.find((f) => f.id === c.id)?.color ||
                (c.id === 'environment' ? 'var(--muted)' : 'var(--border-strong)'),
            })),
            (v) => whole.format(v),
          ),
        ) +
        dsec(3, 'Failures per day', `<div class="chart" data-chart="failures"></div>${legend(FAIL_CATS)}`) +
        dsec(
          4,
          'Most failure-prone tools',
          barList(q.tools.slice(0, 6), {
            value: (t) => t.failureRate,
            label: (t) => `${esc(t.tool.replace(/^mcp__/, ''))}<small>${t.modelFailures} of ${fmtN(t.calls)}</small>`,
            color: () => 'var(--accent)',
            fmt: fmtPct,
          }),
        ) +
        dsec(
          5,
          'Latest failures',
          eventList(q.events.error.filter((e) => !['environment', 'rejection'].includes(e.category)).slice(0, 15)),
        ) +
        '<a class="btn ghost" href="#quality">Open quality & safety →</a>',
      charts: {
        failures: (el) =>
          drawStacked(el, {
            rows: q.daily,
            height: 180,
            fmt: (v) => whole.format(Math.round(v)),
            series: failureSeries(),
            label: 'Failures per day',
          }),
      },
    };
  },

  hallucination() {
    const q = state.data.quality;
    const kinds = q.kinds.filter((k) => KIND_HELP[k.label]);
    return {
      eyebrow: `QUALITY · ${rangeText().toUpperCase()}`,
      title: 'Hallucination signals',
      body:
        tiles([
          [
            'Signals',
            counter(q.hallucinations, 'int'),
            delta(q.hallucinations, q.prevHallucinations, true) || 'in this range',
          ],
          ['Per 1,000 calls', q.hallucinationRate.toFixed(1), 'lower is better'],
          ['Most common', kinds[0] ? esc(kinds[0].label) : '—', kinds[0] ? `${kinds[0].count} times` : ''],
          ['Tool calls checked', counter(q.calls, 'n'), 'Claude Code and Codex'],
        ]) +
        dsec(
          1,
          'What counts as a hallucination signal',
          `<ul class="defs">${Object.entries(KIND_HELP)
            .map(([k, v]) => `<li><b>${k}</b><span>${v}</span></li>`)
            .join('')}</ul>
          <p class="drawer-note">Each is a case where the model acted on something that was not true about your files, tools or the web, and the tool told it so. Made-up facts in written answers leave no trace in the logs and are not counted.</p>`,
        ) +
        dsec(
          2,
          'By type',
          barList(kinds, {
            value: (k) => k.count,
            label: (k) => esc(k.label),
            color: () => 'var(--tt-cread)',
            fmt: (v) => whole.format(v),
            empty: 'No hallucination signals in this range.',
          }),
        ) +
        dsec(3, 'Every signal', eventList(q.events.hallucination)),
    };
  },

  poisoning() {
    const q = state.data.quality;
    const inj = q.injection;
    const labels = {};
    for (const e of q.events.injection) labels[e.label] = (labels[e.label] || 0) + 1;
    return {
      eyebrow: `SAFETY · ${rangeText().toUpperCase()}`,
      title: 'Poisoning & prompt injection',
      body:
        tiles([
          ['From external content', counter(inj.external, 'int'), inj.external ? 'review these' : 'none found'],
          ['In local files', counter(inj.local, 'int'), 'usually docs or test data'],
          ['External results scanned', counter(inj.externalCalls, 'n'), 'web pages, searches, MCP tools'],
          ['Secrets exposed', counter(q.safety.secrets, 'int'), 'keys seen in tool output'],
        ]) +
        dsec(
          1,
          'What is checked',
          `<p class="drawer-note" style="margin:0">Every tool result is scanned for text that tries to steer the model: instructions to ignore previous instructions, persona hijacks ("you are now…"), requests to send keys or credentials, instructions to hide something from you, fake system tags, and commands to run without asking. Matches from web pages, searches and MCP tools are the ones that matter. Matches in your own files are usually security documentation or test data.</p>`,
        ) +
        dsec(
          2,
          'By pattern',
          barList(
            Object.entries(labels)
              .map(([name, count]) => ({ name, count }))
              .sort((a, b) => b.count - a.count),
            {
              value: (x) => x.count,
              label: (x) => esc(x.name),
              color: () => 'var(--accent)',
              fmt: (v) => whole.format(v),
              empty: 'No injection patterns matched.',
            },
          ),
        ) +
        dsec(3, 'Every match', eventList(q.events.injection)),
    };
  },

  relevance() {
    const q = state.data.quality;
    const r = q.relevance;
    const days = q.daily.filter((d) => d.relevance != null);
    return {
      eyebrow: `QUALITY · ${rangeText().toUpperCase()}`,
      title: 'Answer relevance',
      body:
        tiles([
          [
            'Relevance',
            counter(r.score ?? 0, 'pct'),
            r.prev == null ? 'no earlier period' : `${pct(r.prev)} the period before`,
          ],
          ['Turns graded', counter(r.turns, 'n'), 'prompts with 3+ key terms'],
          ['Off-topic turns', counter(r.low, 'int'), 'below 30%'],
          [
            'Best day',
            counter(days.length ? Math.max(...days.map((d) => d.relevance)) : 0, 'pct'),
            days.length ? `${days.length} days with graded turns` : '—',
          ],
        ]) +
        dsec(
          1,
          'How relevance is measured',
          `<p class="drawer-note" style="margin:0">Each typed prompt and everything the model did until your next prompt is one turn. Relevance is the share of the prompt's key terms (words without stop words in English and Indonesian, plus file names, identifiers and numbers) that the reply or the turn's tool calls address. Half of the terms counts as fully relevant, because a good answer does not repeat every word of the question. It is computed on this machine, with no judge model, and no text is stored. Replies in another language than the prompt score lower: read the list before acting on it.</p>`,
        ) +
        dsec(
          2,
          'Relevance per day',
          days.length
            ? barList(days.slice(-14).reverse(), {
                value: (d) => d.relevance,
                label: (d) => esc(dayLabel(d.date)),
                color: () => 'var(--tt-input)',
                fmt: (v) => pct(v),
                max: 1,
              })
            : '<div class="empty">No graded turns in this range.</div>',
        ) +
        dsec(3, 'Off-topic turns', eventList(q.events.relevance, 'No low-relevance turns in this range.')),
    };
  },

  faithfulness() {
    const q = state.data.quality;
    const f = q.faithfulness;
    const days = q.daily.filter((d) => d.faithfulness != null);
    return {
      eyebrow: `QUALITY · ${rangeText().toUpperCase()}`,
      title: 'Faithfulness',
      body:
        tiles([
          [
            'Faithfulness',
            counter(f.score ?? 0, 'pct'),
            f.prev == null ? 'no earlier period' : `${pct(f.prev)} the period before`,
          ],
          ['References checked', counter(f.claims, 'n'), 'file names, identifiers, URLs, numbers'],
          ['Grounded', counter(f.grounded, 'n'), 'seen in prompts, tool inputs or results'],
          ['Unsupported', counter(f.unsupported, 'int'), 'mentioned but never seen'],
        ]) +
        dsec(
          1,
          'How faithfulness is measured',
          `<p class="drawer-note" style="margin:0">A faithful answer only states what its context supports. In every reply, the checkable references are collected: file names, <code>identifiers</code> in backticks, URLs, and numbers with three or more digits, decimals or a percent sign. Each one is grounded when it appeared earlier in the session: in your prompts, in what the model passed to its tools, or in what the tools returned. A reference that appeared nowhere is unsupported. That is not always wrong (a sum it computed, a file it proposes to create), but it is where invented paths, APIs and numbers show up. Computed locally, with no text stored.</p>`,
        ) +
        dsec(
          2,
          'Faithfulness per day',
          days.length
            ? barList(days.slice(-14).reverse(), {
                value: (d) => d.faithfulness,
                label: (d) => esc(dayLabel(d.date)),
                color: () => 'var(--tt-cread)',
                fmt: (v) => pct(v),
                max: 1,
              })
            : '<div class="empty">No checkable references in this range.</div>',
        ) +
        dsec(
          3,
          'Replies with unsupported references',
          eventList(q.events.unsupported, 'Every reference in this range was grounded.'),
        ),
    };
  },

  corrections() {
    const q = state.data.quality;
    const c = q.corrections;
    return {
      eyebrow: `QUALITY · ${rangeText().toUpperCase()}`,
      title: 'Corrections',
      body:
        tiles([
          ['Correction rate', counter(c.rate, 'pct'), 'corrections + interrupts ÷ prompts'],
          ['Correction prompts', counter(c.corrections, 'int'), `of ${whole.format(c.prompts)} prompts`],
          ['Interrupts', counter(c.interrupts, 'int'), 'you stopped the model'],
          ['Rejections', counter(c.rejections, 'int'), 'tool calls you or a guardrail refused'],
        ]) +
        dsec(
          1,
          'How corrections are found',
          `<p class="drawer-note" style="margin:0">A prompt counts as a correction when it asks the model to fix or redo its own work, in English or Indonesian ("kamu salah…", "masih belum…", "perbaiki…", "that's not what I asked"). Prompts where you correct your own input ("saya salah mengisi…") are not counted. This is a heuristic: read the list below to judge it.</p>`,
        ) +
        dsec(2, 'Correction prompts', eventList(q.events.correction, 'No correction prompts in this range.')) +
        dsec(
          3,
          'Rejected tool calls',
          eventList(q.events.error.filter((e) => e.category === 'rejection').slice(0, 15), 'No rejections.'),
        ),
    };
  },

  safety() {
    const q = state.data.quality;
    const labels = {};
    for (const e of q.events.risky) labels[e.label] = (labels[e.label] || 0) + 1;
    return {
      eyebrow: `SAFETY · ${rangeText().toUpperCase()}`,
      title: 'Safety',
      body:
        tiles([
          ['Secrets exposed', counter(q.safety.secrets, 'int'), 'masked below'],
          ['Risky commands', counter(q.safety.risky, 'int'), 'run by the AI'],
          ['Guardrail rejections', counter(q.corrections.rejections, 'int'), 'calls that were blocked'],
          [
            'Injection matches',
            counter(q.injection.external + q.injection.local, 'int'),
            `${q.injection.external} external`,
          ],
        ]) +
        dsec(
          1,
          'Secrets seen in tool output',
          `${eventList(q.events.secret, 'No secrets detected.')}<p class="drawer-note">Only the key type is kept, never the value. If one of these was a live key, rotate it.</p>`,
        ) +
        dsec(
          2,
          'Risky commands by type',
          barList(
            Object.entries(labels)
              .map(([name, count]) => ({ name, count }))
              .sort((a, b) => b.count - a.count),
            {
              value: (x) => x.count,
              label: (x) => esc(x.name),
              color: () => 'var(--tt-cwrite)',
              fmt: (v) => whole.format(v),
              empty: 'No risky commands.',
            },
          ),
        ) +
        dsec(3, 'Latest risky commands', eventList(q.events.risky.slice(0, 20))),
    };
  },

  reliability() {
    const q = state.data.quality;
    const r = q.reliability;
    return {
      eyebrow: `RELIABILITY · ${rangeText().toUpperCase()}`,
      title: 'Reliability',
      body:
        tiles([
          ['API errors', counter(r.apiErrors, 'int'), 'limits, outages, network'],
          ['Network & timeouts', counter(r.environment, 'int'), 'tool calls that could not finish'],
          ['Repeat loops', counter(r.loops, 'int'), 'same call 3+ times in a row'],
          ['Context compactions', counter(r.compactions, 'int'), 'context window filled up'],
        ]) +
        dsec(1, 'API errors', eventList(q.events.apiError, 'No API errors.')) +
        dsec(2, 'Repeat loops', eventList(q.events.loop, 'No loops detected.')) +
        dsec(
          3,
          'Network and timeout failures',
          eventList(q.events.error.filter((e) => e.category === 'environment').slice(0, 15), 'None.'),
        ) +
        dsec(4, 'Context compactions', eventList(q.events.compaction, 'No compactions.')),
    };
  },
};
