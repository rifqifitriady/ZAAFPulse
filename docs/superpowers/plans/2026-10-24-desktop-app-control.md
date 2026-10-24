# Desktop app Start/Stop: implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** add Start/Stop for Claude Desktop, ChatGPT, Antigravity and Kiro on the AI Office cards, and show all runtime rows on the Overview's AI Office cards too.

**Spec:** `docs/superpowers/specs/2026-10-24-desktop-app-control-design.md`. It holds every exact value: bundles, executables, waits, texts. Use them verbatim.

## Global constraints

- No new dependencies. Every command is an argv array, run without a shell.
- `SIGKILL` only for `kind: 'app'`, and only after a normal quit and a `SIGTERM` that did not end it. Before each signal, the process is read again and must match pid and start time.
- Control stays off in server mode, with password sign-in, with no sign-in, and in Docker. Every action and step is audited.
- Text reaches the page through `textContent` only (S1). No paths go into API answers.
- **Tests never open, quit or signal a real app or process.** Claude Desktop and Kiro CLI are running on this machine. Use fakes and injected timers only.
- Never touch `.worktrees/live` or port 4777.
- Commits: no AI attribution line, and stage files by name.

---

### Task 1: registry, state, control, topology

**Files:**
- Modify: `lib/runtimes/registry.js`, `lib/runtimes/state.js` (if needed), `lib/runtimes/control.js`, `lib/topology.js`.
- Test: `test/runtimes-registry.test.js`, `test/runtimes-state.test.js`, `test/runtimes-control.test.js`, `test/topology.test.js`.

**Interfaces:**
- **Produces:**
  - presets with `kind: 'app'` and the ids in the spec;
  - list rows with `kind`;
  - the app stop sequence;
  - injectable waits: `appQuitWaitMs` (10000), `appTermWaitMs` (5000), `appKillWaitMs` (3000), `appOpenWaitMs` (15000).
- **Consumes:** existing `install`, `app()`, the `how: 'app'` stop path, `sameProcess` and `sameStart`.

Steps:
- [ ] Write the failing tests from the spec's Testing section (registry, state, control and topology).
- [ ] Implement.
- [ ] Run `node --test test/runtimes-*.test.js test/topology*.test.js`, then `npm test`.
- [ ] Commit: "Start and stop Claude Desktop, ChatGPT, Antigravity and Kiro, closing an app by force when a normal quit does not end it".

### Task 2: UI, Overview, docs

**Files:**
- Modify: `public/runtimesview.js`, `public/overviewview.js`, `docs/local-models.md`, `README.md`.
- Test: `test/runtimes-ui.test.js`, plus an Overview check in whichever test already audits `overviewview.js`.

Steps:
- [ ] Write the failing tests:
  - the app status, result and confirmation texts;
  - `RT_CARD_IDS` includes the four apps;
  - `mountOverview` calls `rtMount`.
- [ ] Implement it, then add the docs section and the README bullet.
- [ ] Check it in a browser, in demo mode:
  - run on a free port outside 5100–5999, with a throwaway `ZAAFPULSE_DATA` and `HOME`, `NO_JUDGE_PORTS` and `ZAAFPULSE_AUTH=none`;
  - make sure the demo runtimes list includes the apps; extend `runtimesDemo` in `lib/demo.js` if needed;
  - screenshot `#squad` and `#overview` at 1440 px and look at them;
  - stop everything and delete the folder.
- [ ] Run `npm test`.
- [ ] Commit: "Show Start/Stop on the desktop app cards and on the Overview".
