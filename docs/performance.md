# Indexing performance

ZAAFPulse reads your Claude Code and Codex logs once, keeps the parsed counts in a cache, and after
that only re-reads files that changed. This page gives measured numbers for that first index and
for rescans, and how to reproduce them.

## How it was measured

`node scripts/bench-index.js` generates synthetic logs (never your real ones), indexes them in a
child process with the app's own parsers, and reports throughput, CPU time and memory:

```
node scripts/bench-index.js --mb 300                  # agent mix, 300 MB
node scripts/bench-index.js --mix dense --mb 30       # the code-review mix
ZAAFPULSE_INDEX_WORKERS=0 node scripts/bench-index.js # no worker threads
```

- **Agent mix** (default): 55 files from 0.2 to 24 MB, four fifths Claude Code and one fifth Codex.
  Short prompts, streamed assistant blocks, Read results full of numbered source lines, test and build
  output, grep hits, failed calls and fetched web pages. Seeded, so every run writes the same bytes.
- **Dense mix**: the shape the code review used. One big file, every turn a prompt, a 600-byte reply
  and a 6–12 KB result of repeated code-like text.
- **Machine**: Apple M4 (10 cores), 16 GB, macOS 26.6, Node 24.16.0. Other work was running on the
  machine (load average 7 to 14), which moves single runs by a factor of two or more. The numbers below
  are the median of three runs, before and after alternated, so both saw the same load. On a quiet
  machine expect higher numbers: one later run of the agent mix reached 115 MB/s.
- **Before** is release 1.0.3 (commit `f2b198d`), run with the same benchmark script.

## Results

| Mix | | Before | After, worker threads | After, one thread |
|---|---|---|---|---|
| Agent, 300 MB | first index | 20.9 MB/s (14.4 s) | **66.2 MB/s** (4.5 s) | 29.9 MB/s |
| | peak RSS | 326 MB | 512 MB | 291 MB |
| Agent, 30 MB | first index | 21.0 MB/s | **48.6 MB/s** | 23.8 MB/s |
| | peak RSS | 164 MB | 211 MB | 155 MB |
| Dense, 30 MB | first index | 19.1 MB/s | 53.7 MB/s (one file: no workers) | **62.3 MB/s** |
| | peak RSS | 97 MB | 100 MB | 100 MB |

Other measurements from the same runs:

- A rescan with no changes takes 1–3 ms. A new small file adds a few milliseconds.
- When one large session grows, that whole file is parsed again: about 0.4–0.9 s for the 24 MB file
  in the agent mix (before: 0.8–1.0 s). See "Not done yet" below.
- The cache is about 1.3% of the log size (4 MB for 300 MB of logs) and reloads in under 30 ms.
- The detectors themselves: the prompt-injection scan runs at about 140–160 MB/s on tool output
  (1.0.3: about 220 MB/s, with far fewer patterns); the secret scan at about 400 MB/s.

**For the README:** at the measured 66 MB/s, a first index of 2 GB takes about 30 s; at 30 MB/s
(one thread, or a busy machine) about 70 s. A rescan stays in the milliseconds unless a large
session grew. 2 GB itself was not generated (disk space). Files are parsed independently, so the time
grows with the total size. The 30 MB agent set gains less from workers because one 24 MB file is most
of it, and one file runs on one thread.

## What changed

1. **File-name extraction no longer backtracks.** The reference finder used a single regex,
   `(?:[\w.-]+\/)*[\w-]+\.(?:js|ts|…)\b`, which takes quadratic time on long runs of path characters.
   One 40 KB tool result of `a.a.a.…` took 3.9 s, and 60 KB of `ab-ab-…` took 10 s. Minified bundles
   and lockfiles have that shape. Tokens are now found in one linear pass and only their last segment
   is checked: 1–3 ms on the same inputs. A test keeps it that way.
2. **`TurnGrader.learn()` is bounded.** Identical tool output (the same file read again) is learned
   once per session, recognised by a 32-bit hash of its length, head and tail. Tool results are read up
   to 16 KB instead of 40 KB, and nothing is scanned once the context sets are full.
3. **Injection patterns run only near anchors.** One pass finds the words every pattern needs. The
   patterns then run on windows around them, so a code file that says "token" no longer pays for
   the whole pattern set.
4. **Worker threads.** Parsing is CPU-bound, so the six "concurrent" in-process parses of 1.0.3
   took turns on one core. A first index above 8 MB now goes to a pool of `min(4, cores − 1)`
   worker threads, largest file first. The main thread only receives the results, so the dashboard
   stays responsive during a first index.
   - `ZAAFPULSE_INDEX_WORKERS=N` sets the pool size, and `0` turns it off.
   - A worker loads the parser by its module file, found through `require.cache`. A source without
     one, a worker that cannot start, or a worker that dies falls back to the main thread (tested).
   - **Single-file build:** `scripts/sea-main.js` unpacks the app into a cache folder and requires
     it from there, so the worker script and parsers are real files. This was checked with a real SEA
     binary, built locally from the official Node 24.16.0 binary with postject 1.0.0-alpha.6. Three
     workers started and the results were identical to in-thread parsing, file by file. Windows and
     Linux builds were not tried.
   - Cost: each worker has its own heap, so peak memory during a large first index is higher (512 MB
     instead of 326 MB for 300 MB of logs). The workers exit when the index is done. With
     `ZAAFPULSE_INDEX_WORKERS=0`, memory is slightly lower than in 1.0.3.
5. **Cache journal.** 1.0.3 rewrote the whole cache file whenever anything changed, which for an
   active session means once a minute. Changed entries are now appended to `index.json.journal`.
   The journal is folded into a fresh `index.json` when it outgrows half the base (at least 8 MB).
   A generation number in both files makes a journal left over from a crash harmless. `CACHE_VERSION`
   is now 7, so the first start after upgrading re-indexes once.

## Not done yet: parsing only what a growing file appended

The parsers read a file from the start every time it changes. For the session you are working in,
that means re-reading it every minute: 0.4–0.9 s for a 24 MB session here, growing with the file.
Reading only the appended bytes would need a change to `lib/claude.js` and `lib/codex.js`: a parser
that can stop after the last complete line and continue from that byte offset with its in-memory
state. It is planned as a separate change.

## Trace explorer: showing one session of a huge log

The trace explorer never reads a whole log to show a session. The index keeps the byte offset of every
turn, so a skeleton reads only the last turn (or the one asked for), and the text of one span is read
later, on its own, by byte range. The registry (`lib/trace/index.js`) adds these limits:

- **Cache:** at most 20 built skeletons and about 200 MB of them (the length of their JSON), least
  recently used out first. A session's content ids go with its cache slot.
- **Worker:** a Claude or Codex file over 50 MB is built in `lib/trace/worker.js` (a worker thread), so
  the server keeps answering. The worker gets only the session's own record, its subagent files and its
  usage rows. A worker that cannot start, fails, exits or runs over 30 s is replaced by a build in the
  main thread.
- **Read limit:** at most 4 skeleton builds or content reads run at once; the rest wait in order.
- **Isolation:** a source that throws is shown as unavailable with its reason, and the others still work.

### How it was measured

`test/trace-perf.test.js` writes a synthetic Claude Code session to the temp folder (never your logs):
20,000 lines in 200 turns, each turn a prompt, 49 tool calls with a 31 KB result each and a reply,
about 310 MB in all. It indexes the file, then times the last-turn skeleton and one content page. It
asserts the skeleton under 3 s and the page under 100 ms, prints the numbers, and removes the file. It
takes a few seconds, but writes 300 MB, so it only runs on request:

```
ZAAFPULSE_PERF=1 node --test test/trace-perf.test.js
```

| Step (310 MB session) | Time |
|---|---|
| Last-turn skeleton, in a worker | 21 ms |
| Last-turn skeleton, in the main thread | 5 ms |
| One 31 KB content page | 1.1 ms |
| First index of the file (for reference) | 3.3 s |

Machine: Apple M4 (10 cores), macOS 26.6, Node 24.16.0. The worker costs a few milliseconds of start-up
and copying, and buys a main thread that stays free while a slow turn is read; that matters for a turn
with thousands of tool calls, not for the 100 calls here. Thresholds are the limits the explorer
promises (P1, P2), not what this machine reaches: on a slow disk or a busy machine expect more, and the
test is the way to check.
