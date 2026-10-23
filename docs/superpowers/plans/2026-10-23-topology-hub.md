# Topology with ZAAFPulse as the hub: implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** redraw the Provider topology with ZAAFPulse as the central hub that every node connects through.

**Spec:** `docs/superpowers/specs/2026-10-23-topology-hub-design.md`. It amends `2026-10-23-provider-topology-design.md`. Use its values verbatim.

## Global constraints

- No new dependencies.
- The S1 rule applies: data reaches the page only through `textContent`. No URL, path, token, email or prompt goes into `/api/topology`.
- These are unchanged from today:
  - the status thresholds: active ≤ 5 min ok, recent ≤ 60 min ok, error ≤ 60 min failed;
  - the overrides for a running tool and a running runtime;
  - the 3 h window, the 20 requests, and the cap of 12 per layer, now on layers 0, 2 and 3;
  - the route's caps and cache;
  - the 10 s poll that updates in place.
- Tests never call the real OmniRoute or Ollama, nor touch the owner's `~/.claude` or `~/.codex`. A spawned `server.js` uses `NO_JUDGE_PORTS`.
- Never touch `.worktrees/live` or port 4777.
- Commits carry no AI attribution line. Stage files by name.

---

### Task 1: the hub in `lib/topology.js` and the demo

**Files:**
- Modify: `lib/topology.js`, `lib/demo.js` (`topologyDemo`).
- Tests: `test/topology.test.js`, `test/topology-api.test.js`.

**Interfaces:**
- **Produces** the node shape `{ id, layer: 0|1|2|3, kind, label, status, note, via? }`:
  - `kind` gains `'hub'`;
  - tool nodes carry `via`: `'gateway'`, a router label, or `null`;
  - there is no `gateway` node anymore.
- **Edges and paths** are as the spec's table says.

Steps:
- [ ] Rewrite the affected tests first, and add the new ones from the spec's Testing section. Run them and see them fail.
- [ ] Implement in `lib/topology.js`. Keep every scrub, status rule and attribution rule.
- [ ] Update `topologyDemo` and `test/topology-api.test.js` (the demo answer has a hub and 4 layers).
- [ ] Run `node --test test/topology*.test.js`, then `npm test`.
- [ ] Commit: "Put ZAAFPulse at the centre of the topology: every tool, router, runtime and provider connects through it".

### Task 2: the page and the docs

**Files:**
- Modify: `public/topologyview.js`, `public/styles.css` (`.topo-hub`), `docs/topology.md`.
- Test: `test/topology-ui.test.js`.

**Interfaces:**
- **Consumes** Task 1's shape.
- `topoLayout` handles 4 layers, and the hub's wider size.

Steps:
- [ ] Write the failing UI tests:
  - the hub node is wide and centred and has the class `topo-hub`;
  - the tool sub-label shows "via gateway", "via OmniRoute" or "monitored";
  - request rows show the hub in their path;
  - the layout works with 4 layers.
- [ ] Implement it. Use the app's own icon for the hub: check `public/app.js` `icon()` for a fitting name, such as `pulse`, `activity` or `logo`, or the app's mark if there is one.
- [ ] Update `docs/topology.md`.
- [ ] Take screenshots in demo mode at 1440 px and 390 px:
  - use a free port outside 5100–5999;
  - use a throwaway `ZAAFPULSE_DATA` and `HOME` under `/private/tmp/claude-501`;
  - pass `NO_JUDGE_PORTS` and `ZAAFPULSE_AUTH=none`;
  - use headless Chrome, with a unique debugging port above 40000 if you need CDP.

  Look at the screenshots and fix the layout until it reads well. Then stop the server and delete the folder.
- [ ] Run `npm test`.
- [ ] Commit: "Draw ZAAFPulse as the hub of the topology".
