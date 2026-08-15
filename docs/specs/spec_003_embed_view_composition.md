# Spec 003 — Embed view composition (`controls`, `cameras`)

**Status**: planned · **Date**: 2026-08-15 · **Revised**: 2026-08-15 after
adversarial review (43 confirmed findings, 8 blocking) · **Estimated
effort**: 2–3 days
**Depends on**: nothing. Independent of spec_002.

## Why

**1. `controls=minimal` does not do what we documented.** EMBEDDING.md
promises "Only play/pause button, scrubber, and frame counter". The
implementation passes `minimal` to the Timeline (dropping annotation lanes
and the camera buffer lane) and tightens footer padding — and stops there.
The layer control panel and the floating BEV/Pin/Keys buttons stay fully
visible. An embed asking for minimal chrome gets most of the chrome.
(`controls=none` is fine: `showTimeline` at App.tsx:362 already suppresses
the footer, so only `minimal` is under-implemented.)

**2. `cameras=` was invented by an integrator and silently ignored.** A
scenario-mining team's embed URLs carry
`…&embed=true&controls=minimal&cameras=false&…`. We never implemented
`cameras`, so it does nothing — the same pattern as `miningStart`/`miningEnd`
(adopted as `t0`/`t1` in spec_001).

**3. `camera=` (singular) is worse: parsed, documented, never applied.**
`embedParams.camera` is read at embedParams.ts:82 and documented in
EMBEDDING.md as "Initial camera POV", but no code consumes it. A host that
follows our docs gets nothing. Any work in this area must resolve the
three-way name collision (`camera`, `cameras`, `cam`) rather than add a
fourth.

## Principle

**`controls` governs chrome; `cameras` governs content.** Interactive UI is
one axis, what sensor data is displayed is another. They compose:
`controls=none&cameras=all` is a bare viewer that still shows camera images.

## Scope

**In**: correct `minimal`; `cameras=all|false`; resolve the `camera`/`cam`
name collision; skip camera loading when nothing needs the images.

**Out**: **camera subsets** (`cameras=front,rear-left`). Cut deliberately —
see Non-goals. Only `cameras=false` has an observed request, and the subset
form drags in cross-dataset naming, digit-shortcut renumbering, mobile
layout and worker-protocol questions for a need nobody has expressed.

## `controls` — exact surfaces

Header and credit bar are already hidden by embed mode and are out of scope.

| Surface | `full` | `minimal` today | `minimal` specified | `none` today | `none` specified |
|---|---|---|---|---|---|
| Layer panel (coordinate / sensors / colormap / perception) | shown | **shown** | hidden | hidden | hidden |
| Floating buttons (BEV, Pin, Keys) | shown | **shown** | hidden | hidden | hidden |
| Axis gizmo (`GizmoHelper`) | shown | shown | shown | **shown** | hidden |
| POV indicator + ESC button | shown | shown | shown | **shown** | hidden |
| Timeline footer (play/pause, scrubber, counter, buffer bar) | shown | shown | shown | hidden | hidden |
| Timeline: annotation lanes, camera buffer lane | shown | hidden | hidden | n/a | n/a |
| Playback-range handles | draggable | ticks only | ticks only | n/a | n/a |
| Camera strip | shown | shown | governed by `cameras` | hidden | governed by `cameras`, default hidden |

Bold cells are today's behaviour that this spec changes. The axis gizmo and
the POV indicator are gated **only** for `none` — they are orientation aids
for a still-navigable view, not chrome, and `minimal` keeps them.

**Keyboard shortcuts are not uniformly "active".** Digit keys (camera POV)
and the range-trim shortcuts live in components this spec hides, so:
`minimal` keeps all shortcuts (its hidden surfaces are panels, not handlers);
`none` loses the range-trim shortcuts with the timeline and keeps orbit
controls. The table above is the contract; the docs must say this rather
than claim shortcuts always work.

`SensorView`'s single `hideOverlays` boolean cannot express three modes —
it must take the mode itself.

## `cameras` — grammar

```
cameras = "all" | "false"        // also accepted: "none", "0" → false
```

Unset means "inherit the `controls` default": `all` for `full`/`minimal`,
`false` for `none` (preserving today's behaviour). This is the one place the
two axes touch, and it exists so `controls=none` stays backward compatible;
an explicit `cameras=` always wins.

Invalid values (anything else) are ignored with a console warning and the
default applies.

### The three-name collision

| Name | Status today | Resolution |
|---|---|---|
| `cam=<numeric id>` | Works; sets POV camera; round-trips in Share links | Keep. Renaming breaks existing share links |
| `camera=<string>` | Parsed, documented, **never applied** | Make it work as a POV alias accepting the dataset's camera **label** (`FRONT`, `ring_front_center` as documented), resolved against the active dataset's manifest after load; `cam` wins if both are present |
| `cameras=all\|false` | Not implemented; requested by an integrator | Implement as the content switch |

Resolution of `camera=` happens **after** the dataset is loaded, not at parse
time: `getEmbedParams()` runs before any manifest is active, so a label
cannot be mapped to an id in the parser.

### Where `cameras` is parsed

**Not in `parseViewParams`.** That function's *emptiness* is the de-facto
"opened via a Share link" signal at three call sites — `isShareView()`
(urlState.ts:281), the post-load autoplay decision (useSceneStore.ts:2507)
and the layer panel's initial open state (LidarViewer.tsx:777). Adding a key
to it silently suppresses autoplay and collapses the panel for every URL
carrying that key.

- `cameras` gets its own parser used by both embed and normal mode, and a
  field on `ShareableState` for `buildShareUrl` only, so Share links still
  carry it.
- **Known consequence of spec_001** to fix while here: `t0`/`t1` already
  joined `parseViewParams`, so a range link today opens with the layer panel
  collapsed and no autoplay. Decide explicitly — the recommendation is that
  a range link *should* keep autoplay (it says "watch this interval") and
  should not collapse the panel — and make the share-link signal explicit
  (a dedicated key set) rather than "any view param".

## Skipping camera loads

Camera JPEGs are the largest allocation in a loaded scene, and they are
fetched by a dedicated 2-worker pool that prefetches every batch. When the
strip is hidden and nothing else needs images, that work is pure waste — and
it is the one lever that makes two embedded viewers survivable in one tab.

Design constraints found in review:

- **The decision is per scene, not per page.** Both inputs (`colormapMode`,
  `activeCam`) can change across a scene switch, and `resetInternal` clears
  pool state. Re-evaluate on every scene load.
- **The decision must be made after view-param restore**, not before, or a
  URL selecting the camera colormap will have its pool skipped.
- **There is no `initCameraPool()`** — pool creation is inline in each
  dataset's load path. Extract one `ensureCameraPool()` used by both the
  initial path and the lazy path; guard it with the current scene token so a
  late start cannot install a pool over a scene the user has since left.
- **Lazy start must load the visible batch first**, not batch 0, reusing the
  priority mechanism from spec_001 landing 2. Otherwise the user switches to
  the camera colormap and watches every other frame get images before theirs.
- **The camera colormap must degrade, not freeze.** Without textures the GPU
  colormap has nothing to sample; selecting it while images are still loading
  must keep the previous colormap (or render neutral) and switch when the
  first images arrive — never leave a frozen or black cloud.

## Touchpoints

- `src/utils/embedParams.ts` — `cameras` parsing; keep `camera` for
  post-load resolution.
- `src/utils/urlState.ts` — `cameras` on `ShareableState` (build only);
  make the share-link signal an explicit key set.
- `src/App.tsx` — `SensorView` takes the mode, not a boolean; surface gating
  per the table; thread the camera switch.
- `src/components/LidarViewer/LidarViewer.tsx` — `hideControls` covers
  `minimal`; gizmo and POV indicator gated for `none`.
- `src/components/CameraPanel/CameraPanel.tsx` — render or not.
- `src/stores/useSceneStore.ts` — `ensureCameraPool()`, per-scene skip
  decision, lazy start with priority, colormap degradation.
- `docs/EMBEDDING.md` — the surfaces table, the three names, shortcut
  caveats, and a corrected `minimal` description.

## Acceptance

- `controls=minimal` shows the timeline and nothing else: no layer panel, no
  floating buttons, no annotation lanes. Gizmo and POV indicator remain.
- `controls=none` renders the 3D view alone — no gizmo, no POV chip, no
  footer — and orbit/pan/zoom still work.
- `controls=none&cameras=all` shows the camera strip with no chrome.
- `cameras=false` with a non-camera colormap and no POV: **zero network
  requests whose path matches the dataset's camera file pattern**, and
  `internal.cameraImageCache.size === 0` after load (assert in a store test
  rather than eyeballing memory).
- Switching to the camera colormap after `cameras=false` starts camera
  loading, prioritises the visible frame's batch, and never shows a frozen
  or black point cloud.
- `camera=FRONT` enters that POV on all three datasets; `cam=` wins when both
  are given.
- A URL carrying `cameras` does **not** change autoplay or layer-panel
  behaviour (regression test against the `parseViewParams` emptiness signal).
- A Share View link round-trips `cameras`.

## Non-goals

- **Camera subsets** (`cameras=<slug list>`). Cut on the same evidence bar
  used elsewhere: nobody asked for it. It would also need a camera identity
  vocabulary, and review established that labels do **not** align across
  datasets (AV2 `REAR LEFT` vs nuScenes `BACK LEFT`; nuScenes has no side
  cameras), so a portable slug set has to be authored per manifest — work
  worth doing only when a demo needs it.
- Layout presets (`layout=cinema|cameras|…`), per-camera sizing, strip
  reordering, theming.

## Risks

- **Changing `minimal` is a behaviour change** for existing embeds, and we
  cannot bound who relies on today's behaviour: telemetry shows embed usage
  but not `controls` values. Mitigation: the change moves toward the
  documented contract; ship it with a changelog entry and keep `full` as the
  escape hatch for anyone who wanted the panels.
- **Lazy camera start is the subtle part** — pool lifecycle, scene tokens,
  and priority ordering all interact. It carries most of the implementation
  risk in this spec.
- **The share-link signal change** touches autoplay and panel state for every
  link shape, including ones this spec does not otherwise care about. It
  needs its own tests.
