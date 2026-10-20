#!/usr/bin/env node
// Indexer benchmark on synthetic logs. Nothing here reads ~/.claude or ~/.codex.
//   node scripts/bench-index.js                  300 MB of logs, first index + rescans
//   node scripts/bench-index.js --mb 30          a smaller set
//   node scripts/bench-index.js --mix dense      the code-review mix: one session-shaped file of long
//                                                code-like tool output (the shape of the review's probe)
//   node scripts/bench-index.js --dir /tmp/x     reuse (or keep) the generated logs in that folder
//   ZAAFPULSE_INDEX_WORKERS=0 node scripts/...   force in-process parsing
// The logs mimic what a coding agent writes: short prompts, streamed assistant blocks, Read results
// full of numbered source lines, test and build output, grep hits, some failures and web pages, plus
// Codex rollouts (about a fifth of the bytes). The generator is seeded, so runs are comparable.
// Indexing runs in a child process so the RSS it reports belongs to the indexer alone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

// Seeded PRNG (mulberry32): the same --mb always produces the same bytes.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CODE = [
  "import { createServer } from 'node:http';",
  "const config = require('../config/default.json');",
  'export async function loadUser(id: string): Promise<User | null> {',
  '  const row = await db.query("SELECT * FROM users WHERE id = $1", [id]);',
  '  if (!row) throw new NotFoundError(`user ${id} not found`);',
  '  return mapRow(row, { includeProfile: true, depth: 2 });',
  '}',
  'def compute_totals(items: list[dict]) -> float:',
  '    return sum(i["price"] * i.get("qty", 1) for i in items if i.get("active"))',
  'class OrderService {',
  '  private readonly cache = new Map<string, Order>();',
  '  constructor(private repo: OrderRepository, private clock = Date) {}',
  '  // retry up to 3 times with backoff: 250ms, 500ms, 1000ms',
  '  for (let attempt = 0; attempt < 3; attempt++) {',
  '    const res = await fetch(`${BASE_URL}/v2/orders/${orderId}`, { headers });',
  '    if (res.status === 429) await sleep(250 * 2 ** attempt);',
  "  logger.info('order.created', { orderId, total: order.total.toFixed(2) });",
  '  return { ...state, items: state.items.filter((x) => x.id !== action.id) };',
  "describe('checkout', () => { it('applies the 15% discount', () => expect(total(cart)).toBe(84.15)); });",
  "  'src/components/CartSummary.tsx': { lines: 182, covered: 0.913 },",
  '    padding: 12px 16px; border-radius: 8px; color: var(--muted);',
  'SELECT o.id, o.total, c.email FROM orders o JOIN customers c ON c.id = o.customer_id;',
  '  "dependencies": { "react": "18.3.1", "zod": "3.23.8" },',
  'func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {',
];
const PROSE = [
  'The request handler validates the payload before it reaches the service layer.',
  'Rate limits apply per API key; the default is 600 requests per minute.',
  'This guide explains how to configure the deployment for staging and production.',
  'Pagination uses an opaque cursor returned in the next field of every response.',
  'Errors follow RFC 9457 problem details with a type, title, status and detail.',
];
const PROMPTS = [
  'add pagination to the orders endpoint',
  'fix the failing test in src/checkout/total.test.ts',
  'why does the build fail on CI?',
  'refactor lib/auth.js so the session check lives in one place',
  'tolong tambahkan validasi email di form registrasi',
  'perbaiki bug login di halaman checkout',
  'write tests for the cart reducer',
  'no, that is not what I meant, keep the old API',
  'lanjut',
  'explain how the retry logic in src/net/client.ts works',
];
const BASH = [
  'npm test -- --runInBand',
  'git status --short',
  'ls -la src/components',
  'npx tsc --noEmit',
  'grep -rn "TODO" src | head -50',
  'git diff --stat HEAD~1',
  'node scripts/migrate.js --dry-run',
  'python -m pytest tests/test_totals.py -q',
];

// The mix used in the code review that found the slow regex: one big Claude file, every turn a
// prompt, a 600-byte reply, a Read and a 6-12 KB result of repeated code-like text.
function generateDense(dir, mb) {
  const file = path.join(dir, 'claude', '-w-app', 'dense.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  const filler = (n) => 'const value = compute(alpha, beta); // src/lib/module '.repeat(Math.ceil(n / 56)).slice(0, n);
  let size = 0;
  for (let i = 1; size < mb * 1e6; i++) {
    const ts = new Date(Date.parse('2026-10-01T00:00:00Z') + i * 1000).toISOString();
    const sid = `S${i % 50}`;
    const lines =
      [
        {
          type: 'user',
          sessionId: sid,
          timestamp: ts,
          cwd: '/w/app',
          message: { role: 'user', content: `please refactor src/lib/module${i % 97}.js and fix the failing test` },
        },
        {
          type: 'assistant',
          sessionId: sid,
          requestId: `r${i}`,
          timestamp: ts,
          message: {
            id: `m${i}`,
            role: 'assistant',
            model: 'claude-opus-4-1',
            content: [
              { type: 'text', text: `I will read \`module${i}\` first. ${filler(600)}` },
              {
                type: 'tool_use',
                id: `tu${i}`,
                name: 'Read',
                input: { file_path: `/w/app/src/lib/module${i % 97}.js` },
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 400,
              cache_read_input_tokens: 90000,
              cache_creation_input_tokens: 2000,
            },
          },
        },
        {
          type: 'user',
          sessionId: sid,
          timestamp: ts,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: filler(6000 + (i % 7) * 1000) }],
          },
        },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n';
    fs.writeSync(fd, lines);
    size += Buffer.byteLength(lines);
  }
  fs.closeSync(fd);
  return { files: 1, bytes: size };
}

function generate(dir, mb) {
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const code = (lines) => {
    const out = [];
    let n = 1 + Math.floor(r() * 200);
    for (let i = 0; i < lines; i++) out.push(`${String(n++).padStart(6)}\t${pick(CODE)}`);
    return out.join('\n');
  };
  const testLog = () => {
    const out = [];
    for (let i = 0; i < 20 + r() * 60; i++)
      out.push(`  ${r() < 0.9 ? '✓' : '✗'} ${pick(PROSE).slice(0, 40)} (${Math.floor(r() * 900)} ms)`);
    out.push(`Tests: ${Math.floor(r() * 4)} failed, ${Math.floor(50 + r() * 300)} passed`);
    return out.join('\n');
  };
  const grep = () => {
    const out = [];
    for (let i = 0; i < 10 + r() * 40; i++)
      out.push(
        `src/${pick(['lib', 'api', 'components', 'util'])}/mod${Math.floor(r() * 300)}.ts:${Math.floor(r() * 400)}:${pick(CODE)}`,
      );
    return out.join('\n');
  };
  const target = mb * 1e6;
  let total = 0;
  let fileNo = 0;
  const files = [];
  while (total < target) {
    fileNo++;
    const isCodex = fileNo % 5 === 0;
    // Session files range from a few hundred KB to tens of MB, like real ones.
    const want = Math.min(target - total, Math.max(2e5, Math.floor(Math.exp(12 + r() * 5))));
    const file = isCodex
      ? path.join(dir, 'codex', '2026', '10', String(1 + (fileNo % 28)).padStart(2, '0'), `rollout-${fileNo}.jsonl`)
      : path.join(dir, 'claude', `-w-proj${fileNo % 7}`, `session-${fileNo}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'w');
    let size = 0;
    let t = Date.parse('2026-10-01T08:00:00Z') + fileNo * 3600e3;
    let i = 0;
    const put = (o) => {
      const s = JSON.stringify(o) + '\n';
      fs.writeSync(fd, s);
      size += Buffer.byteLength(s);
    };
    const sid = `s-${fileNo}`;
    const iso = () => new Date((t += 1000 + r() * 20000)).toISOString();
    if (isCodex) {
      put({ timestamp: iso(), type: 'session_meta', payload: { id: sid, cwd: '/w/app', originator: 'codex_cli_rs' } });
      put({ timestamp: iso(), type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/w/app' } });
      let tokens = 0;
      while (size < want) {
        i++;
        put({ timestamp: iso(), type: 'event_msg', payload: { type: 'task_started' } });
        put({ timestamp: iso(), type: 'event_msg', payload: { type: 'user_message', message: pick(PROMPTS) } });
        for (let k = 0; k < 2 + r() * 6; k++) {
          const cmd = pick(BASH);
          put({
            timestamp: iso(),
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'shell',
              call_id: `c${i}_${k}`,
              arguments: JSON.stringify({ command: ['bash', '-lc', cmd], workdir: '/w/app' }),
            },
          });
          const fail = r() < 0.08;
          put({
            timestamp: iso(),
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: `c${i}_${k}`,
              output: JSON.stringify({
                output: r() < 0.5 ? code(40 + r() * 200) : testLog(),
                metadata: { exit_code: fail ? 1 : 0, duration_seconds: r() * 4 },
              }),
            },
          });
          tokens += 2000 + Math.floor(r() * 9000);
          put({
            timestamp: iso(),
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: {
                  input_tokens: tokens,
                  cached_input_tokens: tokens * 0.8,
                  output_tokens: tokens / 20,
                  total_tokens: tokens * 1.05,
                },
              },
            },
          });
        }
        put({
          timestamp: iso(),
          type: 'event_msg',
          payload: { type: 'agent_message', message: pick(PROSE) + ' Updated `src/lib/orders.ts`.' },
        });
      }
    } else {
      while (size < want) {
        i++;
        const base = { sessionId: sid, cwd: '/w/app', gitBranch: 'main', entrypoint: 'cli', version: '2.1.0' };
        put({
          ...base,
          type: 'user',
          uuid: `u${i}`,
          timestamp: iso(),
          message: { role: 'user', content: pick(PROMPTS) },
        });
        for (let k = 0; k < 1 + r() * 5; k++) {
          const id = `msg_${fileNo}_${i}_${k}`;
          const usage = {
            input_tokens: 4,
            output_tokens: 200 + Math.floor(r() * 900),
            cache_read_input_tokens: 50000 + Math.floor(r() * 90000),
            cache_creation_input_tokens: 1500,
            cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 0 },
          };
          const msg = { id, role: 'assistant', model: 'claude-opus-4-1', usage, stop_reason: 'tool_use' };
          // Claude Code writes one line per content block of a streamed message.
          put({
            ...base,
            type: 'assistant',
            requestId: `req_${id}`,
            timestamp: iso(),
            message: {
              ...msg,
              content: [{ type: 'text', text: `${pick(PROSE)} I will check \`src/lib/mod${k}.ts\` next.` }],
            },
          });
          const kind = r();
          const tuid = `toolu_${fileNo}_${i}_${k}`;
          const [name, input, out] =
            kind < 0.45
              ? ['Read', { file_path: `/w/app/src/lib/mod${Math.floor(r() * 300)}.ts` }, code(80 + r() * 400)]
              : kind < 0.7
                ? ['Bash', { command: pick(BASH), description: 'Run the check' }, testLog()]
                : kind < 0.85
                  ? ['Grep', { pattern: 'createOrder', path: 'src' }, grep()]
                  : kind < 0.95
                    ? [
                        'Edit',
                        { file_path: '/w/app/src/lib/orders.ts', old_string: pick(CODE), new_string: pick(CODE) },
                        'The file /w/app/src/lib/orders.ts has been updated.',
                      ]
                    : [
                        'WebFetch',
                        { url: 'https://docs.example.com/api/pagination', prompt: 'summarise' },
                        Array.from({ length: 30 }, () => pick(PROSE)).join(' '),
                      ];
          put({
            ...base,
            type: 'assistant',
            requestId: `req_${id}`,
            timestamp: iso(),
            message: { ...msg, content: [{ type: 'tool_use', id: tuid, name, input }] },
          });
          const err = r() < 0.06;
          put({
            ...base,
            type: 'user',
            uuid: `r${i}_${k}`,
            timestamp: iso(),
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: tuid,
                  is_error: err,
                  content: err ? 'Exit code 1\n' + testLog() : out,
                },
              ],
            },
          });
        }
        put({ ...base, type: 'system', subtype: 'turn_duration', timestamp: iso(), durationMs: 12000 });
      }
    }
    fs.closeSync(fd);
    files.push(file);
    total += size;
  }
  return { files: files.length, bytes: total };
}

// Child: index the folder and print one JSON line.
async function run(dir) {
  const { Indexer } = require(path.join(ROOT, 'lib', 'indexer'));
  const claude = require(path.join(ROOT, 'lib', 'claude'));
  const codex = require(path.join(ROOT, 'lib', 'codex'));
  const list = (sub) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) out.push(p);
      }
    };
    if (fs.existsSync(path.join(dir, sub))) walk(path.join(dir, sub));
    return out;
  };
  // Same parse functions as the app, pointed at the synthetic folders.
  const sources = [
    { id: 'claude', listFiles: () => list('claude'), parseFile: claude.parseFile },
    { id: 'codex', listFiles: () => list('codex'), parseFile: codex.parseFile },
  ];
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-bench-cache-'));
  const cacheFile = path.join(cacheDir, 'index.json');
  const bytes = [...list('claude'), ...list('codex')].reduce((a, f) => a + fs.statSync(f).size, 0);
  let peak = 0;
  let heap = 0;
  const sample = setInterval(() => {
    const m = process.memoryUsage();
    peak = Math.max(peak, m.rss);
    heap = Math.max(heap, m.heapUsed);
  }, 25);
  const ix = new Indexer(sources, cacheFile);
  const cpu0 = process.cpuUsage();
  let t = process.hrtime.bigint();
  await ix.refresh();
  const firstMs = Number(process.hrtime.bigint() - t) / 1e6;
  const cpu = process.cpuUsage(cpu0);
  const workers = ix.state.workers || 0;
  const files = Object.keys(ix.files).length;
  peak = Math.max(peak, process.memoryUsage().rss);
  t = process.hrtime.bigint();
  await ix.refresh();
  const rescanMs = Number(process.hrtime.bigint() - t) / 1e6;
  // One growing session: append a turn to the largest Claude file and rescan.
  const biggest = list('claude').sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  const line = {
    type: 'user',
    sessionId: 'x',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'lanjut' },
  };
  fs.appendFileSync(biggest, JSON.stringify(line) + '\n');
  t = process.hrtime.bigint();
  await ix.refresh();
  const changedMs = Number(process.hrtime.bigint() - t) / 1e6;
  fs.appendFileSync(path.join(path.dirname(biggest), 'session-new.jsonl'), JSON.stringify(line) + '\n');
  t = process.hrtime.bigint();
  await ix.refresh();
  const newFileMs = Number(process.hrtime.bigint() - t) / 1e6;
  fs.rmSync(path.join(path.dirname(biggest), 'session-new.jsonl'));
  // A fresh process loading the cache it left behind.
  t = process.hrtime.bigint();
  const again = new Indexer(sources, cacheFile);
  const loadMs = Number(process.hrtime.bigint() - t) / 1e6;
  const cacheBytes = fs.readdirSync(cacheDir).reduce((a, f) => a + fs.statSync(path.join(cacheDir, f)).size, 0);
  clearInterval(sample);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const events = ix.results().reduce((a, r) => a + r.events.length, 0);
  process.stdout.write(
    JSON.stringify({
      bytes,
      files,
      loaded: Object.keys(again.files).length,
      events,
      firstMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      rescanMs,
      changedMs,
      newFileMs,
      loadMs,
      peakRssMb: Math.round(peak / 1e6),
      peakHeapMb: Math.round(heap / 1e6),
      maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      cacheMb: +(cacheBytes / 1e6).toFixed(1),
      workers,
    }) + '\n',
  );
}

async function main() {
  if (process.argv[2] === '--child') return run(process.argv[3]);
  const mb = Number(arg('mb', 300));
  const keep = arg('dir');
  const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), 'zp-bench-logs-'));
  const mix = arg('mix', 'agent');
  const stamp = path.join(dir, `.generated-${mix}-${mb}`);
  if (!fs.existsSync(stamp)) {
    fs.rmSync(path.join(dir, 'claude'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'codex'), { recursive: true, force: true });
    const t = Date.now();
    const g = mix === 'dense' ? generateDense(dir, mb) : generate(dir, mb);
    fs.writeFileSync(stamp, JSON.stringify(g));
    console.log(
      `generated ${g.files} files, ${(g.bytes / 1e6).toFixed(0)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`,
    );
  }
  const out = execFileSync(process.execPath, [__filename, '--child', dir], {
    encoding: 'utf8',
    maxBuffer: 1 << 20,
    env: process.env,
  });
  const r = JSON.parse(out.trim().split('\n').pop());
  const mbps = r.bytes / 1e6 / (r.firstMs / 1000);
  const cpu = os.cpus();
  console.log(
    `machine     ${cpu[0].model}, ${cpu.length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, Node ${process.version}`,
  );
  console.log(`logs        ${mix} mix, ${r.files} files, ${(r.bytes / 1e6).toFixed(1)} MB, ${r.events} usage events`);
  console.log(
    `first index ${(r.firstMs / 1000).toFixed(2)} s = ${mbps.toFixed(1)} MB/s wall (workers: ${r.workers || 'none'}); CPU ${(r.cpuMs / 1000).toFixed(2)} s = ${(r.bytes / 1e3 / r.cpuMs).toFixed(1)} MB per CPU-second`,
  );
  console.log(
    `memory      peak RSS ${r.peakRssMb} MB (sampled), max RSS ${r.maxRssMb} MB, peak JS heap ${r.peakHeapMb} MB`,
  );
  console.log(
    `rescan      ${r.rescanMs.toFixed(0)} ms unchanged · ${r.changedMs.toFixed(0)} ms after one file grew · ${r.newFileMs.toFixed(0)} ms after a new file`,
  );
  console.log(`cache       ${r.cacheMb} MB on disk, reloaded ${r.loaded} files in ${r.loadMs.toFixed(0)} ms`);
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
