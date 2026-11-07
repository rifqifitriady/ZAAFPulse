# Trace Explorer: the session map as a 3D metro line

Date: 2026-11-07. Branch `feat/trace-3d`. The owner chose direction D, "Jalur metro 3D", from the six animated directions
shown in the brainstorm companion. The reference mockup is `docs/superpowers/specs/mockups/trace-metro.html`.

## Problem

The right half of the Trace Explorer (`#tr-map`) draws one turn as a vertical zigzag of cards. Each card has a side
note, and glowing SVG S-curves run between the cards. With more than a handful of steps the panel is full of boxes,
notes and wires at once, and nothing tells the eye where to look. The owner asked for a design that is 3D, animated
and easy to take in at a glance.

## Goal

Replace that card map with a 3D metro line drawn on a canvas:

- The turn is one glowing track that runs away from the viewer towards the horizon.
- Every map node is a station on the track.
- The camera sits on the line and flies to the selected station.
- Only the stations near the camera carry labels. Stations further away fade into the distance, so the panel is
  never full however long the turn is.

Selection stays shared with the tree and the detail panel, exactly as today.

## Out of scope

- The Dependencies view, the tree, the detail panel and the session list.
- How nodes are built: `mapNodes()` stays as it is, including the folding of repeated calls and of subagents.
- Showing more than one turn on the track. The turn stepper ◀ ▶ still moves between turns.
- Free 3D orbit or rotating the camera with the mouse.
- WebGL and any third-party library.

## Design

### Scene

- **Track.**
  - Stations stand along the depth axis, 120 world units apart, in the order of `mapNodes()`.
  - The track has a gentle S-sway: x = sin(i × 0.85) × 80.
  - A subagent station moves 160 units to the side, onto a pink branch track that leaves the previous station and
    rejoins at the next one. Consecutive subagents alternate sides.
  - A dashed pink bypass joins the two main-line stations around the branch; it shows that the parent waits.
- **Travelled and future track.** Track the camera has passed is bright and glowing; track ahead is dim.
- **Station.**
  - A glowing disc on the floor, a light pillar, and an orb in the colour of its kind, from `TR_COLOR`.
  - The selected station is larger, has a stronger glow and a filled disc.
  - Session is a wider "depot" disc, and Turn is a gate arch that the track passes under.
  - Answer is a green terminal disc.
- **Error.** A red station that sends an expanding red ring across the floor.
- **Repeated calls** (`count > 1`). A dashed ring that rotates around the station, and a `×N` in the label.
- **Floor and sky.** A perspective grid that fades with distance, and a soft violet haze at the horizon.
- **Distance.** Stations further than 1500 units are not drawn. Between 600 and 1500 units they fade out.

### Labels

- The selected station and the next two stations get a label card standing on top of the pillar. The previous
  station also gets one, dimmed.
- Card contents:
  - The kind colour as an edge stripe.
  - Title and meta from `nodeParts()`.
  - Duration and cost, right-aligned.
  - `✕` for an error and `↻` for repeated calls.
  - A small red dot when the node has a failing eval badge.
  - For the Turn station, the turn's prompt preview cut to 48 characters.
- The selected station's card is centred over its pillar. Other cards open towards the outside of the track: to the
  right when the station is right of the camera, to the left otherwise. This keeps neighbouring cards from covering
  each other.
- Hovering an unlabelled station shows its label card while the pointer stays on it.
- All text is drawn with `fillText`, so span text never becomes markup.

### Camera and motion

- **Follow.** The camera follows the selected station: it sits 190 units behind it and 110 above the floor, looks
  down the line, and leans 55% towards the station's x.
- **Selection change.** The camera flies to the new station over 600 ms, eased with smoothstep. While it flies, a
  white "train" light runs along the track between the two stations.
- **Wheel.** The mouse wheel or a trackpad scroll slides the camera along the line without changing the selection.
  A click on a station, or any selection change, brings the camera back to the selected station.
- **Replay.** A ▶ Replay button runs a replay. It selects each station from the first to the last, one every
  1.6 s, so the tree and the detail panel follow along. Replay stops at the last station, on ■, on any click,
  keypress or wheel in the map, and on a turn or session change.
- **Ambient motion.** Error rings, the rotating rings of repeated calls, a light pulse along the travelled track and
  the glow of the selected orb.
- **Reduced motion** (`prefers-reduced-motion: reduce`):
  - no ambient motion and no train;
  - the camera jumps instead of flying;
  - replay steps every 1.6 s with jumps;
  - the canvas draws only when something changes.

### Panel layout

Inside `#tr-map`, from top to bottom:

1. **HUD.** A DOM overlay at the top left of the canvas:
   - Turn N and the turn title;
   - "Station i / n";
   - elapsed time and cost up to the selected station.

   It also carries the ▶ Replay button. The existing `.tr-legend` stays above the map.
2. **Canvas.** Full width, `height: clamp(360px, 64vh, 760px)`.
3. **Time bar.** A DOM strip under the canvas:
   - one segment per step, placed and sized by its start and end within the turn;
   - a white marker at the selected station;
   - clicking a segment selects that station.

   Session and Turn have no segment because they span the whole turn.
4. **More steps.** When more nodes exist than `TR_MAP_MAX` (150), the HUD says "N more steps · see the tree".

### Keyboard and accessibility

- The canvas is focusable (`tabindex="0"`, `role="group"`) with
  `aria-label="Session map · arrow keys move between stations, Space plays the replay"`.
- Keys while the canvas has focus:
  - ←/→ select the previous or next station;
  - Home/End select the first or last station;
  - Enter moves focus to the detail text, as a map node does today;
  - Space starts or stops the replay.
- The HUD's station line is an `aria-live="polite"` region. It reads, for example,
  "Station 5 of 12: Tool · Bash, failed, 1.0 s".
- The tree remains the full accessible list of spans.

### Live sessions and repaints

- `paintMap()` keeps its call sites: turn paint, eval badge changes and live repaint.
- It hands the new node list to the metro, which keeps the camera where it is when the selected station still exists.
- A station that appears at the end of the line fades in over 400 ms.

### Lifecycle and cost

- The drawing loop runs only when all of these hold:
  - the map view is shown (`S.view === 'map'`);
  - the page is visible;
  - the motion is not reduced, or a change is waiting to be drawn.
- `onUnmount` cancels the loop and disconnects the ResizeObserver.
- The canvas uses a device pixel ratio capped at 2, like `isoStage`.

## Units

**`public/tracemetro.js`** (new; a plain browser script loaded before `traceview.js`, with `module.exports` for the
tests). Pure helpers, with no DOM:

- `metroLayout(nodes)` returns `[{ x, z, branch: -1 | 0 | 1 }]` per node. It applies the S-sway and the subagent
  branch, with sides alternating for consecutive subagents.
- `metroCamera(layout, p)` returns `{ x, z }` for a float station index `p`. It interpolates between neighbours, with
  smoothstep on x.
- `metroProject(cam, pt, view)` returns `[sx, sy, k, dz]`, or `null` behind the near plane. `view` is
  `{ w, h, f: 380, height: 110, horizon: 0.27 }`.
- `metroLabelled(n, sel)` returns the set of station indexes that carry a label: `sel - 1` through `sel + 2`,
  clamped to the line.
- `metroHit(points, x, y)` returns the index of the nearest projected station within 22 px, scaled by `k`, or -1.
  The nearest one is chosen when stations overlap.
- `metroBar(nodes)` returns `[{ i, left, width }]` as fractions of the turn's time, for step nodes with a finite
  start and end.

`trMetro(canvas, { onPick, onHover })` is the renderer. It returns:

- `{ setNodes(nodes, parts, sel), select(i), play(), stop(), show(on), destroy() }`

where `parts[i]` is `{ title, meta, dur, cost, err, loop, evalFail, preview }`. It owns the loop, the
ResizeObserver, the pointer and wheel handlers and the replay timer.

**`public/traceview.js`**:

- The `#tr-map` markup becomes the HUD, the canvas and the time bar.
- `paintMap()` builds `parts` from `nodeParts()` and `spanEvalBadges()`, then calls `setNodes`.
- `select()` calls `metro.select(ni)` instead of toggling `.tr-node` elements.
- `showView()` calls `metro.show()`.
- `onKey` no longer treats `.tr-node` as an Enter target.
- `drawWires`, `queueWires`, `scrollNode` and the map's ResizeObserver are removed.

**`public/styles.css`**:

- Add `.tr-metro`, `.tr-hud` and `.tr-bar`.
- Remove the rules of `.tr-node`, `.tr-note`, `.tr-gap`, `svg.tr-wires`, `.tr-wire`, `.tr-flow`, `.tr-packet` and
  `.tr-more-steps`, and the `trmap` container rules that only serve them.
- This file is edited by hand and never formatted with `prettier --write`.

**`public/index.html`**: add `<script src="tracemetro.js"></script>` before `traceview.js`.

## Error handling

- No `getContext('2d')` (a very old browser): the map shows a line saying "The map needs canvas support · see the
  tree".
- An empty node list (a turn with no valid spans): the canvas shows "No steps in this turn".
- A node with no start or end has no time bar segment, but it is still a station.
- Non-finite cost or duration show as an empty field, never as `NaN`.

## Testing

**`test/trace-metro.test.js`** (node:test, no browser):

- `metroLayout`:
  - stations 120 apart in order;
  - a subagent station on a side branch;
  - two subagents in a row on opposite sides;
  - an empty list.
- `metroCamera`: integer and fractional positions; clamping past either end.
- `metroProject`: a point straight ahead lands on the centre column; a point behind the near plane returns `null`;
  `k` shrinks with distance.
- `metroLabelled`: the window at the start, the middle and the end of the line.
- `metroHit`: a hit inside the radius, a miss outside, and the nearest of two overlapping stations.
- `metroBar`:
  - fractions add up for the demo turn (`traceDemo`);
  - a node without times is left out;
  - a zero-length turn gives no NaN.

**`test/trace-ui.test.js`**:

- The existing `mapNodes` tests stay.
- The S1 audit still passes: no `innerHTML` built from span text in the new code. HUD text uses `textContent`.

**Browser check** (manual, recorded in the PR) on the demo server at 1600 and 1280 px:

- selection from the tree flies the camera;
- a station click selects the tree row;
- replay, wheel, keyboard and reduced motion behave as described;
- no console errors.

## Acceptance

- The map shows the selected station and at most four labels, plus the label of a hovered station. No cards, side notes or SVG wires remain.
- Tree, map and detail stay in step in both directions.
- `npm test` passes, and CI is green on macOS, Linux and Windows.
