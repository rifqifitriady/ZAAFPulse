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
- The camera rides the line on its own, like a train, stopping briefly at each station. This is the owner's choice.
- The ride moves the camera only and never changes the selection.
- Selecting a station flies the camera there and pauses the ride for a while.
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
  - The focus station (where the camera stands) is larger, has a stronger glow and a filled disc.
  - The selected station always carries a white ring on the floor, wherever the camera is.
  - Session is a wider "depot" disc, and Turn is a gate arch that the track passes under.
  - Answer is a green terminal disc.
- **Error.** A red station that sends an expanding red ring across the floor.
- **Repeated calls** (`count > 1`). A dashed ring that rotates around the station, and a `×N` in the label.
- **Floor and sky.** A perspective grid that fades with distance, and a soft violet haze at the horizon.
- **Distance.** Stations further than 1500 units are not drawn. Between 600 and 1500 units they fade out.

### Labels

- The focus station and the next two stations get a label card standing on top of the pillar. The previous station
  also gets one, dimmed.
- The selected station keeps its label whenever it is in view, with a white border.
- Card contents:
  - The kind colour as an edge stripe.
  - Title and meta from `nodeParts()`.
  - Duration and cost, right-aligned.
  - `✕` for an error and `↻` for repeated calls.
  - A small red dot when the node has a failing eval badge.
  - For the Turn station, the turn's prompt preview cut to 48 characters.
- The focus station's card is centred over its pillar. Other cards open towards the outside of the track: to the
  right when the station is right of the camera, to the left otherwise. This keeps neighbouring cards from covering
  each other.
- Hovering an unlabelled station shows its label card while the pointer stays on it.
- All text is drawn with `fillText`, so span text never becomes markup.

### Camera and motion

- **Position.** The camera stands 190 units behind its focus station and 110 above the floor. It looks down the line
  and leans 55% towards the station's x.
- **Auto ride (the tour).** This is on by default.
  - The camera moves from station to station. Each move takes 1.1 s, eased with smoothstep, and the camera then
    rests 0.9 s, so a full step is 2.0 s.
  - While it moves, a white "train" light runs along the track between the two stations.
  - At the last station it rests 2 s, the scene fades out and in over 0.5 s, and the ride starts again at the first
    station.
  - A new turn or session starts the ride at the first station.
- **Selection.**
  - Any selection, from the tree, a station click, the time bar or the keys, flies the camera to the selected station
    in 600 ms.
  - The ride then pauses for 10 s after the last interaction and resumes from the selected station.
  - The ride also pauses while the pointer is over the canvas.
- **Wheel.** A mouse wheel or trackpad scroll slides the camera along the line and counts as an interaction, so it
  pauses the ride for 10 s.
- **Pause button.** A ⏸/▶ button in the HUD stops or resumes the ride for good.
  - Its state is remembered in `store` under `trace.tour`.
  - When stopped, the camera stays on the selected station and follows the selection only.
- **Ambient motion.** Error rings, the rotating rings of repeated calls, a light pulse along the travelled track and
  the glow of the focus orb.
- **Reduced motion** (`prefers-reduced-motion: reduce`):
  - the ride starts stopped, and the ▶ button can still start it;
  - while it runs, the camera jumps from station to station every 2 s instead of flying;
  - there is no ambient motion and no train;
  - the camera jumps to a new selection;
  - the canvas draws only when something changes.

### Panel layout

Inside `#tr-map`, from top to bottom:

1. **HUD.** A DOM overlay at the top left of the canvas:
   - Turn N and the turn title;
   - "Station i / n" for the focus station;
   - elapsed time and cost up to the focus station.

   It also carries the ⏸/▶ ride button. The existing `.tr-legend` stays above the map.
2. **Canvas.** Full width, `height: clamp(360px, 64vh, 760px)`.
3. **Time bar.** A DOM strip under the canvas:
   - one segment per step, placed and sized by its start and end within the turn;
   - a white marker that moves with the camera;
   - a white outline on the selected station's segment;
   - clicking a segment selects that station.

   Session and Turn have no segment because they span the whole turn.
4. **More steps.** When more nodes exist than `TR_MAP_MAX` (150), the HUD says "N more steps · see the tree".

### Keyboard and accessibility

- The canvas is focusable (`tabindex="0"`, `role="group"`) with
  `aria-label="Session map · arrow keys move between stations, Space pauses the ride"`.
- Keys while the canvas has focus:
  - ←/→ select the previous or next station;
  - Home/End select the first or last station;
  - Enter moves focus to the detail text, as a map node does today;
  - Space stops or resumes the ride.
- A separate visually hidden `aria-live="polite"` line announces selection changes only, for example
  "Station 5 of 12: Tool · Bash, failed, 1.0 s". The ride's steps are never announced.
- The tree remains the full accessible list of spans.

### Live sessions and repaints

- `paintMap()` keeps its call sites: turn paint, eval badge changes and live repaint.
- It hands the new node list to the metro.
- When the turn is the same, the camera and the ride keep their place. Only a new turn or session restarts the ride
  at the first station.
- A station that appears at the end of the line fades in over 400 ms.

### Lifecycle and cost

- The drawing loop runs only when all of these hold:
  - the map view is shown (`S.view === 'map'`);
  - the page is visible;
  - the motion is not reduced, or a change is waiting to be drawn.
- Under reduced motion the ride's 2 s steps use a timer, not a frame loop.
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
- `metroLabelled(n, focus, sel)` returns the set of station indexes that carry a label: `focus - 1` through
  `focus + 2`, clamped to the line, plus `sel` when it is a valid index. Whether `sel` is in view is decided at draw
  time.
- `metroTour(ms, n)` returns the camera's float station index at `ms` milliseconds into a ride over `n` stations,
  and the fade (0–1) of the restart. The timings are a 1100 ms move, a 900 ms rest, a 2000 ms rest at the end and a
  250 ms fade out followed by a 250 ms fade in. The ride is a pure function of elapsed time, so it is testable without
  a clock.
- `metroHit(points, x, y)` returns the index of the nearest projected station within 22 px, scaled by `k`, or -1.
  The nearest one is chosen when stations overlap.
- `metroBar(nodes)` returns `[{ i, left, width }]` as fractions of the turn's time, for step nodes with a finite
  start and end.

`trMetro(canvas, { onPick, onHover })` is the renderer. It returns:

- `{ setNodes(nodes, parts, sel, { restart }), select(i), tour(on), show(on), destroy() }`

where `parts[i]` is `{ title, meta, dur, cost, err, loop, evalFail, preview }`. It owns:

- the frame loop and the ResizeObserver;
- the pointer and wheel handlers;
- the ride clock, the 10 s pause after an interaction and the hover pause.

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
- `metroLabelled`: the window at the start, the middle and the end of the line, plus a selection outside the window.
- `metroTour`:
  - index 0 at 0 ms;
  - halfway through the first move at 550 ms;
  - resting at station 1 from 1100 to 2000 ms;
  - the end rest and the fade at the end of the line;
  - a wrap back to 0;
  - one station rests at 0 with no NaN.
- `metroHit`: a hit inside the radius, a miss outside, and the nearest of two overlapping stations.
- `metroBar`:
  - fractions add up for the demo turn (`traceDemo`);
  - a node without times is left out;
  - a zero-length turn gives no NaN.

**`test/trace-ui.test.js`**:

- The existing `mapNodes` tests stay.
- The S1 audit still passes: no `innerHTML` built from span text in the new code. HUD text uses `textContent`.

**Browser check** (manual, recorded in the PR) on the demo server at 1600 and 1280 px:

- the ride runs on its own;
- selection from the tree flies the camera and pauses the ride;
- the ride resumes after 10 s;
- a station click selects the tree row;
- the ⏸/▶ button, the wheel, the keyboard and reduced motion behave as described;
- no console errors.

## Acceptance

- The camera rides the line on its own, and a selection takes over the ride for 10 s.
- The map shows at most four labels around the camera, plus the selected station's label and a hovered station's
  label.
- No cards, side notes or SVG wires remain.
- Tree, map and detail stay in step in both directions.
- `npm test` passes, and CI is green on macOS, Linux and Windows.
