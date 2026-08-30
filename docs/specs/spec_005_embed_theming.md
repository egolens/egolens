# Spec 005 — Chrome token hygiene, and a two-parameter embed theme

**Status**: in-progress · **Date**: 2026-08-15 · **Estimated effort**: 2 days
**Depends on**: nothing. Reopens one line of spec_003's Non-goals.

## Why

**The hypothesis this spec was opened to test — "theming and layout are the
fork driver" — is not supported, and this spec does not build it.**

Forensics on `rafaelmaranon/waymo-triage`: "159 commits / 150 files" is a rebase
artifact that replayed 137 of *our* commits. The real delta from fork point
`fcf957b` is 40 files, and of its 3,614 hand-written lines the entire reskin is
**54 lines in `src/theme.ts` — 1.5%**; theme plus layout, ~11%. The rest is a
Python FastAPI/Encord backend, a generated scenario index, and a triage sidebar
that restyles nothing of ours because we have no sidebar. The rendering engine
has zero diff (`LidarViewer.tsx`, `PointCloud.tsx`, `src/workers/`,
`src/adapters/`). Shipping `theme=` in March would not have prevented it.

Worse for the premise: **the fork is evidence the token layer works.** The 31
hardcoded hexes and 266 `style={{` sites did not obstruct them — they edited one
file and it propagated, leaking once. They wanted EgoLens as an *engine inside
their shell*, with a server; no colour config touches that. Foxglove is the
control experiment: same category, real embed SDK, `colorScheme` and nothing
more, with an extension API for anything deeper.

What the evidence *does* support: **the token layer has drifted, and closing
that drift is what makes a fork's merges survivable.** A two-parameter chrome
theme then rides on it cheaply.

## Principle

**Chrome is themeable; dataset semantics are not.** Chrome is the panels,
timeline, buttons and text around the view. Dataset semantics — box classes,
sensor and camera identities, colormaps — live in the adapter manifests
(`src/adapters/waymo/manifest.ts:36-56, 76-80`) and carry meaning across
screenshots, docs and users; recolouring a pedestrian breaks it. Every tool
surveyed draws this line.

Corollary: chrome and data tokens live in **separate modules**, because a chrome
value reaching a non-CSS consumer fails silently (see Risks).

## Scope

**In:** token hygiene (dead tokens, drift, split by consumer); then, as a
deliberate bet, `theme=dark|light|auto` and `accent=RRGGBB` via CSS custom
properties, plus `setTheme`.

**Out:** layout. `SensorView` (`App.tsx:1700-1755`) and
`CameraPanel.tsx:28-29`'s `STRIP_HEIGHT` hardcode strip-at-bottom; moving it is
a refactor, not a parameter.

## Design

### Hygiene

`src/theme.ts` is 118 lines with 280 `colors.*` references across `App.tsx` and
`src/components/`.

- **Dead:** `boxVehicle/Pedestrian/Sign/Cyclist/Unknown` (`theme.ts:60-64`) —
  **zero references**, superseded by `manifest.boxTypes[].color`. Delete.
- **Missing:** error red `#FF6B6B`, hardcoded at `App.tsx:1218, 1304, 1423`.
  Add `danger` (`theme.ts:46` already spends that hex on `radarFront`).
- **Drift:** `rgba(0, 200, 219, …)` is `accentBlue` `#00C9DB` off by one in
  green, at `LidarViewer.tsx:1042, 1347, 1484, 1657, 1679` and
  `BevOverlay.tsx:44` — which puts the drifted value and the correct
  `colors.accentBlue` in the *same* declaration. Plus 37 hand-derived `rgba()`
  alphas, invisible to a hex grep; fold into alpha tokens.
- **Split** into `chrome` (13 live tokens); `scene` (`gridMajor/Minor`,
  `vehicleMarker`, `gizmoX/Y/Z`, all at `LidarViewer.tsx:929, 947, 988`); `data`
  (`sensor*`, `radar*`, `cam*`, read only inside the three manifests).

The "31 hexes" is inflated: 11 sit in `MemoryOverlay.tsx`, gated at
`App.tsx:408`.

### The two parameters

**CSS custom properties, changing only what the chrome tokens *are*.** React
assigns inline styles through the CSSOM, which accepts `var()`, so
`accent: 'var(--el-accent, #00E89D)'` keeps all 280 call sites, every template
interpolation, `shadows.glow` (`theme.ts:105`) and `gradients` (`theme.ts:115`)
working verbatim — a 331-declaration refactor becomes one file. Set the vars on
`#root` from `parseEmbedParams`; `index.html:83-115` hand-copies four and must
follow.

URL params carry first paint — the only option with no flash; `setTheme` on the
existing protocol (`embedApi.ts:36-44`) carries later changes.

**Delete `bgcolor` first.** It was parsed and applied once, then completely
covered by opaque children and the WebGL clear colour. It had no observed use
and duplicated the existing viewport background presets. Remove the parser,
tests, and documentation rather than preserving a dead public knob.

## Touchpoints

- `src/theme.ts` — split chrome/scene/data; drop 5 dead tokens; add `danger` and
  alpha tokens; chrome becomes `var()` strings.
- `src/adapters/*/manifest.ts` — import from `data`.
- `src/components/LidarViewer/{LidarViewer,BevOverlay}.tsx` — drift fix.
- `src/utils/embedParams.ts` — `theme`, `accent` (hex-validated); remove
  `bgcolor`.
- `src/App.tsx` — `setProperty` on `#root`; dedupe `useIsMobile`.
- `src/utils/embedApi.ts` — `setTheme`. Also `index.html`, `docs/EMBEDDING.md`.

## Acceptance

- Zero references to the five `box*` tokens, box colours unchanged on screen, no
  `rgba(0, 200, 219` anywhere; a test asserts no literal in `src/components/`
  duplicates a chrome token.
- Chrome and data tokens are separate modules, with a lint rule forbidding
  chrome imports into `src/adapters/` or any Canvas 2D / `THREE.Color` site.
- `theme=light` repaints panels, timeline, buttons, text **and** the
  `index.html` slider thumbs, with no first-paint flash; the gizmo, grid and
  both `setClearColor` paths (`LidarViewer.tsx:685, 908`, `BevMinimap.tsx:53,
  83`) still render.
- `accent=FF6F00` changes every `colors.accent` site — and **no** box, sensor,
  camera, colormap or layer colour.
- `theme=`/`accent=` instrumented in GA, so spec 006 has a number.

## Non-goals

- **Layout as configuration.** spec_003 cut it and the forensics uphold that:
  layout is ~10% of the fork, and no surveyed tool passes layout as style across
  an iframe — they pass suppression flags (which `controls=` already is) or
  opaque JSON. Per-surface `ui_*` booleans are the shape if demand appears; a
  layout language never is.
- **A themeable token map, or a host stylesheet URL.** kepler.gl exposes its
  internal tokens and inherits every one as a compatibility surface; a giscus-
  style stylesheet URL couples host CSS to our DOM, recreating the very
  upgrade-path problem this spec reduces.
- **Themeable dataset semantics** (see Principle), and any second 3D-background
  path — `BG_PRESETS` (`useSceneStore.ts:129-136`) already gives six.
- **EgoLens as a mountable component.** What the fork actually wanted; it solves
  theming outright via the host's cascade, at the cost of CSS isolation, version
  coupling and any cross-origin story. Rejected deliberately, not by omission —
  a packaging spec, not this one.

## Risks

- **n=1, and the fork is dead** (last commit 2026-03-31; author unanswered three
  months). The 1,169-URL integrator used only spec_003 params, never `bgcolor` —
  the one theming knob that exists. Nobody has asked. Frame the params as
  *"cheap enough that one fork arguably suffices"*, never as new evidence; if
  instrumentation is empty in two quarters, delete them.
- **`THREE.Color` cannot parse `var()`** — `LidarViewer.tsx:929, 947, 988, 908`
  and `BevMinimap.tsx:53` throw or render black. Scene tokens stay literal hex;
  the two `bgDeep` reads resolve via `getComputedStyle`.
- **Canvas 2D fails silently:** `ctx.strokeStyle = 'var(--x)'` does not throw —
  the assignment is ignored and the prior colour persists
  (`BBoxOverlayCanvas.tsx:120`, `KeypointOverlay.tsx:176-202`,
  `BoxProjectionOverlay.tsx:305-319`), and `hexToRgb`
  (`BoxProjectionOverlay.tsx:54`) yields `NaN` the same way. Safe only while
  inputs stay manifest-sourced — hence the lint rule.
- **Layer accents rhyme with class colours by design** — `#CCFF00` is both kp3d
  and Pedestrian, `Timeline.tsx:437`'s buffer bar `#FF9E00` collides exactly
  with Vehicle. Deduplicating them into a `layers` export must preserve the
  rhyme, not resolve it.

## Landings

1. **Token hygiene** (½–1 day, as maintenance): dead tokens, `danger`, the six
   drift sites, the 37 alphas, the split, the lint rule.
2. **`bgcolor` removed** — parser, tests, and documentation together.
3. **`theme=dark|light|auto`** over CSS vars, including `index.html`.
4. **`accent=RRGGBB`**, with contrast-coupled text-on-accent: the five `#000`
   sites (`App.tsx:818, 1100, 1239, 1687`, `SearchableSelect.tsx:478`) flip with
   accent luminance instead of being a fixed token.
5. **`setTheme` postMessage** — one `setProperty` call on top of 3.

Landings 3–5 are the bet. Landings 1–2 are not, and ship regardless.
