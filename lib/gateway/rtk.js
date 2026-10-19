// Token saver for tool results (the idea of rtk, "Rust Token Killer", rebuilt here): coding agents send
// back whole command outputs (diffs, logs, listings, test runs) on every turn. Before a request goes
// upstream, long tool results are shortened by a filter picked from the tool call (name and command)
// or, failing that, from the output's shape. It is lossy on purpose: errors, failures, file names and
// summaries stay; repetition, progress noise and the middle of very long outputs go. Results shorter
// than MIN_CHARS and error results are never touched, and a filter that throws leaves the text as is.
const MIN_CHARS = 600;
const MAX_CHARS = 10 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const NOISE_DIRS = /(^|\/)(node_modules|\.git|dist|build|\.next|\.venv|venv|__pycache__|\.cache|target|coverage)(\/|$)/;

const lines = (t) => t.split('\n');
const omitted = (n, what = 'lines') => `… ${n} ${what} omitted`;
function headTail(ls, head, tail) {
  return ls.length <= head + tail + 1
    ? ls
    : [...ls.slice(0, head), omitted(ls.length - head - tail), ...ls.slice(-tail)];
}

// Runs of identical lines (digits and hex ids ignored, so timestamps do not break a run) collapse to one.
function dedupe(ls) {
  const out = [];
  let prev = null;
  let run = 0;
  const key = (l) =>
    l
      .replace(/\b[0-9a-f]{7,}\b/gi, '#')
      .replace(/\d+/g, '0')
      .trim();
  const flush = () => {
    if (run > 1) out.push(`  (× ${run} similar lines)`);
  };
  for (const l of ls) {
    const k = key(l);
    if (k === prev && k) {
      run++;
      continue;
    }
    flush();
    out.push(l);
    prev = k;
    run = 1;
  }
  flush();
  return out.filter((l, i, a) => !(l.trim() === '' && (a[i - 1] || '').trim() === ''));
}

const FILTERS = {
  // Per file: the header and each hunk up to 60 lines; at most 400 lines in all.
  'git-diff': (t) => {
    const out = [];
    let hunk = 0;
    for (const l of lines(t)) {
      if (/^(diff --git|index |--- |\+\+\+ )/.test(l)) {
        out.push(l);
        hunk = 0;
        continue;
      }
      if (l.startsWith('@@')) {
        out.push(l);
        hunk = 0;
        continue;
      }
      if (++hunk <= 60) out.push(l);
      else if (hunk === 61) out.push('  … rest of hunk omitted');
    }
    return headTail(out, 300, 100).join('\n');
  },
  'git-log': (t) =>
    headTail(
      lines(t)
        .filter((l) => /^(commit |Author:|Date:|Merge:)/.test(l) || /^ {4}\S/.test(l))
        .filter((l, i, a) => !/^ {4}/.test(l) || !/^ {4}/.test(a[i - 1] || '')),
      150,
      20,
    ).join('\n'),
  'git-status': (t) => {
    const out = [];
    let n = 0;
    for (const l of lines(t)) {
      if (/^\s+(modified|new file|deleted|renamed):|^\s{1,2}[MADRCU?!]{1,2}\s/.test(l) || /^\t\S/.test(l)) {
        if (++n <= 25) out.push(l);
        else if (n === 26) out.push(omitted('more', 'files'));
      } else {
        n = 0;
        out.push(l);
      }
    }
    return out.join('\n');
  },
  // Build, install and test output: every error or failure (with the 3 lines after it), warnings capped,
  // progress lines counted, and the closing summary.
  build: (t) => {
    const ls = lines(t);
    const keep = new Set();
    let warn = 0;
    let progress = 0;
    ls.forEach((l, i) => {
      if (/\b(error|ERR!|fail(ed|ure)?|✖|✗|panic|exception|traceback|not ok|assert)/i.test(l))
        for (let k = i; k <= i + 3 && k < ls.length; k++) keep.add(k);
      else if (/\bwarn(ing)?\b/i.test(l) && warn++ < 5) keep.add(i);
      else if (
        /^\s*(Compiling|Downloading|Downloaded|Fetching|Installing|Resolving|Collecting|Building|Progress|\[\d+\/\d+\]|\d+%)/i.test(
          l,
        )
      )
        progress++;
    });
    const summary = ls.slice(-25);
    const body = ls.map((l, i) => (keep.has(i) ? l : null)).filter((l) => l !== null);
    return [
      ...(progress ? [`(${progress} progress lines)`] : []),
      ...dedupe(body).slice(0, 300),
      ...(body.length ? ['…'] : []),
      ...summary,
    ].join('\n');
  },
  // grep -n output: grouped by file, 10 matches per file, 40 files.
  grep: (t) => {
    const by = new Map();
    const other = [];
    for (const l of lines(t)) {
      const m = l.match(/^((?:[\w.@-]*\/)*[\w.@-]+\.\w{1,10}):(\d+)[:-]/);
      if (m) {
        if (!by.has(m[1])) by.set(m[1], []);
        by.get(m[1]).push(l);
      } else if (l.trim()) other.push(l);
    }
    const out = [];
    let files = 0;
    for (const [f, ls] of by) {
      if (++files > 40) {
        out.push(omitted(by.size - 40, 'more files'));
        break;
      }
      out.push(...ls.slice(0, 10));
      if (ls.length > 10) out.push(`  ${omitted(ls.length - 10, `more matches in ${f}`)}`);
    }
    return [...out, ...other.slice(0, 20)].join('\n');
  },
  // Path listings (find, ls -R, glob): noise folders dropped, 12 entries per folder, 40 folders.
  listing: (t) => {
    const ls = lines(t).filter((l) => l.trim() && !NOISE_DIRS.test(l.trim()));
    const by = new Map();
    for (const l of ls) {
      const p = l.trim().replace(/^.*\s(?=\S+$)/, '');
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
      if (!by.has(dir)) by.set(dir, []);
      by.get(dir).push(l);
    }
    const out = [];
    let dirs = 0;
    for (const [d, items] of by) {
      if (++dirs > 40) {
        out.push(omitted(by.size - 40, 'more folders'));
        break;
      }
      out.push(...items.slice(0, 12));
      if (items.length > 12) out.push(`  ${omitted(items.length - 12, `more in ${d}`)}`);
    }
    return out.join('\n');
  },
  // Large JSON: compacted, long arrays cut to their first 20 items.
  json: (t) => {
    const cut = (v, depth = 0) =>
      Array.isArray(v)
        ? [...v.slice(0, 20).map((x) => cut(x, depth + 1)), ...(v.length > 20 ? [`… ${v.length - 20} more items`] : [])]
        : v && typeof v === 'object' && depth < 12
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, depth + 1)]))
          : typeof v === 'string' && v.length > 2000
            ? `${v.slice(0, 2000)}… (${v.length} chars)`
            : v;
    return JSON.stringify(cut(JSON.parse(t)));
  },
  // File reads with line numbers, and anything else very long: the start and the end.
  read: (t) => headTail(lines(t), 160, 60).join('\n'),
  log: (t) => headTail(dedupe(lines(t)), 200, 80).join('\n'),
};

// The filter for one result: from the tool call when we know it, else from the first 2 KB of output.
function pickFilter(text, hint = '') {
  const h = hint.toLowerCase();
  const head = text.slice(0, 2048);
  if (/\bgit\b[^|;&]*\bdiff\b|\bgit\b[^|;&]*\bshow\b/.test(h) || /^diff --git /m.test(head)) return 'git-diff';
  if (/\bgit\b[^|;&]*\blog\b/.test(h) || /^commit [0-9a-f]{7,40}$/m.test(head)) return 'git-log';
  if (/\bgit\b[^|;&]*\bstatus\b/.test(h) || /^On branch |^Changes (not staged|to be committed)/m.test(head))
    return 'git-status';
  if (
    /\b(npm|pnpm|yarn|bun|pip|poetry|cargo|go (build|test)|mvn|gradle|make|tsc|jest|vitest|pytest|node --test|xcodebuild|flutter)\b/.test(
      h,
    ) ||
    /^(npm (ERR|WARN)|> .+@\d|added \d+ packages|\s*Compiling |PASS |FAIL |ℹ tests|={3,} test session|Tests? (passed|failed))/m.test(
      head,
    )
  )
    return 'build';
  // file:line: matches need a path with an extension, so timestamps (10:00:05) do not count.
  if (
    /\b(grep|rg|ag)\b/.test(h) ||
    /^grep$/i.test(hint) ||
    (head.match(/^(?:[\w.@-]*\/)*[\w.@-]+\.\w{1,10}:\d+[:-]/gm) || []).length >= 3
  )
    return 'grep';
  if (/^\s*[[{]/.test(head) && /[\]}]\s*$/.test(text.slice(-64))) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      /* not json */
    }
  }
  if (/\b(find|ls|tree|fd|glob)\b/.test(h) || /^glob$/i.test(hint)) return 'listing';
  if (/^(read|cat)\b/i.test(hint) || (head.match(/^\s*\d+[\t|→]/gm) || []).length >= 10) return 'read';
  if (text.length > 4000) return 'log';
  return null;
}

// Shortens one tool result; returns { text, filter, saved } or null when nothing was gained.
function compressText(raw, hint) {
  if (typeof raw !== 'string' || raw.length < MIN_CHARS || raw.length > MAX_CHARS || raw.startsWith('[error]'))
    return null;
  const clean = raw.replace(ANSI, '');
  const filter = pickFilter(clean, hint);
  let text = clean;
  if (filter) {
    try {
      text = FILTERS[filter](clean);
    } catch {
      text = clean;
    }
  }
  if (text.length >= raw.length || !text.trim())
    return clean.length < raw.length ? { text: clean, filter: 'ansi', saved: raw.length - clean.length } : null;
  return { text, filter: filter || 'ansi', saved: raw.length - text.length };
}

// Applies the saver to a chat request (OpenAI messages) or an Anthropic Messages body, in place.
// Returns { savedChars, savedTokens, hits: [{ filter, saved }] } or null.
function saveTokens(body, format = 'openai') {
  if (!body || !Array.isArray(body.messages)) return null;
  const hits = [];
  if (format === 'anthropic') {
    const calls = new Map();
    for (const m of body.messages)
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'tool_use')
          calls.set(
            b.id,
            `${b.name} ${(b.input && (b.input.command || b.input.pattern || b.input.file_path || b.input.path)) || ''}`,
          );
        if (b.type !== 'tool_result' || b.is_error) continue;
        const hint = calls.get(b.tool_use_id) || '';
        if (typeof b.content === 'string') {
          const r = compressText(b.content, hint);
          if (r) {
            b.content = r.text;
            hits.push(r);
          }
        } else if (Array.isArray(b.content))
          for (const c of b.content)
            if (c.type === 'text') {
              const r = compressText(c.text, hint);
              if (r) {
                c.text = r.text;
                hits.push(r);
              }
            }
      }
  } else {
    const calls = new Map();
    for (const m of body.messages) {
      for (const tc of m.tool_calls || []) {
        let a = {};
        try {
          a = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* partial */
        }
        calls.set(
          tc.id,
          `${tc.function.name} ${a.command || a.cmd || a.pattern || a.file_path || a.path || a.input || ''}`,
        );
      }
      if (m.role !== 'tool') continue;
      const hint = calls.get(m.tool_call_id) || '';
      if (typeof m.content === 'string') {
        const r = compressText(m.content, hint);
        if (r) {
          m.content = r.text;
          hits.push(r);
        }
      } else if (Array.isArray(m.content))
        for (const c of m.content)
          if (c.type === 'text') {
            const r = compressText(c.text, hint);
            if (r) {
              c.text = r.text;
              hits.push(r);
            }
          }
    }
  }
  if (!hits.length) return null;
  const savedChars = hits.reduce((n, h) => n + h.saved, 0);
  return {
    savedChars,
    savedTokens: Math.round(savedChars / 4),
    hits: hits.map(({ filter, saved }) => ({ filter, saved })),
  };
}

module.exports = { saveTokens, compressText, pickFilter, FILTERS, MIN_CHARS };
