# Spec 004 — BYO data: a checkable contract, not a silent one

**Status**: planned · **Date**: 2026-08-15 · **Estimated effort**: 3–4 days
**Depends on**: PR #9 (local-load failures reach `failLoad`) — landed. Item 5
rides on spec_002's index entry `url`.

## Why

**The nuScenes adapter is an accidental BYO ingest path.** Of our three
formats it is the only one that is plain JSON + `.pcd.bin` + `.jpg` rather than
a compiled binary schema (Waymo: parquet range images; AV2: feather). It is
therefore the only one a team can target when they want to look at *their own*
recordings.

They already do. Telemetry from 2026-06-15..17 shows one team serving 129
scenes named `scene-2024_09_25_13_02_01_5-2` — their own 2024 vehicle logs,
converted into the nuScenes layout. 18,732 of 20,238 scene-tagged events on
that adapter are theirs, not nuScenes'; only 19 official scenes appear at all.
They did this two months before we shipped any sharding tooling, with no
documentation for it, because none exists.

**Every mistake in that conversion produces the same symptom.**
`readJsonFile` (metadata.ts:86) returns `[]` with a `console.warn` for any file
it cannot find, and the only `throw` in the module is "Scene not found". A
missing table, a typo'd filename, an unrecognised sensor channel and a wrong
path all render as the same blank or subtly-wrong view.

The observed cost of that, on one morning: **70 reloads of a single converted
scene across 23 minutes** (41 of 44 gaps were consecutive-minute), then seven
minutes spinning up three throwaway servers holding one *official* nuScenes
scene each — building a reference oracle by hand, because the app would not
say what was wrong. It resolved at 03:23 and the remaining 90 scenes loaded
without incident.

**Evidence base: one team, telemetry only, no contact, three days.** We do not
know what was actually wrong that morning, only that they had no way to find
out. The justification for this spec is not that team — it is that the same
silence applies to every user's every mistake. `folder_rejected` has fired
zero times to date, which means either nobody has tried the local drop path or
they left before it fired.

## Principle

**Feedback belongs where the work happens.** The converter runs in Python, in
their pipeline — every script in `scripts/` is Python, as is the nuScenes
devkit. A contract they can check *there* closes the loop before a browser is
involved. Runtime errors are the fallback for what a static contract
structurally cannot see, not the primary mechanism.

This reverses the obvious ordering: making the loader shout is the cheaper
change, but it only helps after you have served the data and opened a tab.

## Design

### 1. A published schema, generated from the types we already have

`src/types/nuscenes.ts` already defines all 12 tables, with tuple precision
(`translation: [number, number, number]`, `rotation: [number, number, number,
number]`). It is the source of truth; the schema is generated from it so the
two cannot drift.

- Narrow `NuScenesSensor.channel` from `string` (nuscenes.ts:49) to a union of
  the 12 keys in `NUSCENES_CHANNEL_TO_ID` (manifest.ts:49). This is worth doing
  for TypeScript alone, and it is what makes the schema's `enum` possible.
- Generate `schema/nuscenes-tables.v1.json` with `ts-json-schema-generator`.
- Commit it, publish it at a versioned URL, and add a CI step that regenerates
  and fails on diff.
- Add a `pattern` to `NuScenesSampleData.filename` (relative, under `samples/`
  or `sweeps/`). Free, and it converts one of the blind spots below into a
  caught one.

**Verified on 2026-08-15, before committing to the approach:**

- Tuple types emit correctly — `translation` becomes `minItems: 3, maxItems: 3`
  and `rotation` `minItems: 4, maxItems: 4`. This was the gate; it passes.
- JSDoc becomes the schema `description`, so "Quaternion is scalar-first:
  [w, x, y, z]" travels with the artifact. The schema cannot *enforce* that
  convention (see below) but it can at least state it where the converter
  author is looking.
- The narrowed `channel` union emits as a 12-value `enum`.
- The generated schema validates **all 10 tables of the hosted v1.0-mini —
  82,449 rows — with `additionalProperties: false`**, so our interfaces are an
  exact match for real nuScenes, not a subset. Keep the strict setting, but
  have the validator report `additionalProperties` violations as a *warning*:
  it usefully flags a converter emitting fields that do nothing, while not
  hard-failing on version drift we have not seen.

### 2. `scripts/validate_nuscenes.py`

Consumes the generated schema, and adds the checks JSON Schema cannot express:

- the required file set is present and parseable
- cross-file token integrity (`sample_data.ego_pose_token`,
  `.calibrated_sensor_token`, `.sample_token`; `calibrated_sensor.sensor_token`)
- every `filename` resolves to a file that exists under the root
- every `calibrated_sensor` reaches a `sensor` whose `channel` is accepted

Exit code plus a flat list of problems, shaped to run in someone else's CI.
It consumes the schema rather than reimplementing it — this is a derivative,
not the second parser rejected under Non-goals.

### 3. What the schema catches, and what it cannot — measured

Ten realistic converter mistakes, applied to real hosted rows and run against
the generated schema:

| Mistake | Schema |
|---|---|
| `channel: "lidar_roof"` (their own sensor name) | **caught** — lists the 12 accepted |
| `modality: "LIDAR"` (uppercase) | **caught** |
| `rotation` with 3 elements | **caught** — "is too short" |
| `translation` missing | **caught** — "is a required property" |
| `is_key_frame: "true"` (string) | **caught** — "is not of type 'boolean'" |
| `filename` absolute instead of relative | blind → **caught** once the `pattern` above is added |
| `ego_pose_token` dangling | blind — cross-document, out of JSON Schema's reach → item 2 |
| Quaternion written `[x,y,z,w]` | blind — identical to `[w,x,y,z]`: four floats |
| `size` written `[l,w,h]` | blind — identical to `[w,l,h]`: three floats |
| `translation` in millimetres | blind — a number is a number → validator plausibility check, warning tier |
| Points in world frame, not sensor frame | blind — does not appear in JSON at all |
| `.pcd.bin` wrong stride or dtype | blind — binary payload |

The blind residue is one coherent class: **same types, different meaning.** It
renders *without error and wrong*, which is worse than a blank screen, and no
static contract can reach it. That is what items 4 and 5 are for.

### 4. Runtime errors — demoted to second, still required

PR #9 made local-load failures reach `failLoad`; without it the changes below
would replace a blank viewer with a permanent spinner. On that base:

- **REQUIRED**: `scene`, `sample`, `sample_data`, `ego_pose`,
  `calibrated_sensor`, `sensor`. Missing → `DataLoadError`.
- **OPTIONAL**, and explicitly so: `sample_annotation`, `instance`, `category`,
  `log`, `lidarseg`, `panoptic`. `log` drives only the location/time-of-day
  label (metadata.ts:509-511); the annotation trio gates boxes. A team
  converting raw logs has none of them, and `v1.0-test` legitimately ships an
  empty `sample_annotation.json`.
- Check **presence and parseability only, never row count.**
- `Promise.all` (metadata.ts:124) → `allSettled`, so four missing tables
  produce one error naming four files rather than four round trips.
- Wrap `JSON.parse` (metadata.ts:96): an SPA-fallback host answering 200 +
  `index.html` currently kills the whole load from an *optional* table.
- Zero sensors resolved after the pipeline → an error naming the channels
  found against the channels accepted. This is the failure a converter is most
  likely to hit and today it is completely silent.
- Add a visited set to the sample linked-list walk (metadata.ts:269-276). It
  already breaks on a dangling `next`, but a cycle loops forever pushing
  duplicates until the tab dies.

### 5. A minimal example scene

`public/examples/nuscenes-minimal/` — 2 frames, `LIDAR_TOP`, `CAM_FRONT`, tens
of KB. It replaces the three servers they built by hand. To be useful it must
contain what makes the silent class visible:

- a box whose dimensions are **not** a cube, so `[w,l,h]` order is observable
- a **non-identity** ego rotation, so quaternion order is observable
- two distinct timestamps
- one variant with the annotation trio and one without

Doubles as a test fixture, which is what keeps it honest.

### 6. index.json entries carry their own location

`remote.ts:100` hardcodes `{base}{scene.name}/`, so one root can only span
scenes that are direct subdirectories named exactly after the scene. That is
why eight HTTP servers were needed to hold what one root could. spec_002
already introduces an entry `url`; make the nuScenes shard path honour it
rather than adding a second field.

## Touchpoints

- `src/types/nuscenes.ts` — narrow `channel`
- `schema/nuscenes-tables.v1.json` (new) + generation script + CI drift check
- `scripts/validate_nuscenes.py` (new) + `jsonschema` as its only dependency
- `src/adapters/nuscenes/metadata.ts` — `allSettled`, required set, parse
  guard, cycle guard
- `src/stores/useSceneStore.ts` — zero-sensor error
- `public/examples/nuscenes-minimal/` (new), reused as a fixture
- `docs/NUSCENES_BYO.md` (new) — the contract in prose, linked from the errors
- `src/adapters/nuscenes/remote.ts` — honour the entry `url`

## Acceptance

- A converter emitting `channel: "lidar_roof"` fails `validate_nuscenes.py`
  with the accepted list, without a browser.
- A dangling `ego_pose_token` fails the validator; JSON Schema alone passes it
  (proves the validator earns its existence).
- Deleting `ego_pose.json` and `sensor.json` produces **one** error naming
  **both**, and the error screen renders it.
- Serving the tree from a host that answers 404s with `index.html` does not
  fail the load when only optional tables are absent.
- A `v1.0-test`-shaped tree (empty `sample_annotation.json`) still loads.
- The example scene loads, and `npm test` uses it as a fixture.
- Regenerating the schema in CI produces no diff.

## Non-goals

- **A browser-side "validate this layout" UI.** Item 4 already makes the error
  screen say what is wrong; a second parser in the browser would diverge from
  the loader, and a tree that passes validation but will not open is the worst
  outcome available.
- **A native EgoLens scene format.** The evidence says this team accepted the
  format and was defeated by its opacity. A fourth schema means a fourth
  adapter, a fourth worker, and a migration nobody asked for. Revisit only if
  several teams stall at the *same* point and items 1–5 do not move it.
- **Dynamic channel allocation** (accepting arbitrary sensor names via
  `modality`). Their 90 scenes rendered, so they either renamed their sensors
  or already matched; this would save that rename, not the debugging, and we
  have no evidence either way. Separate decision, on its own evidence.
- `sweeps/` scanning, arbitrary version directory names, camera resolution
  overrides, automatic coordinate-frame detection.

## Risks

- **Turning required tables into throws hardens a currently-forgiving path.**
  A partially-downloaded nuScenes is a real user state. Mitigated by keeping
  the required set to six, checking presence rather than contents, and by the
  `v1.0-test` acceptance case.
- **Schema drift** if generation is not enforced. The CI diff check is not
  optional.
- **A new dev dependency** (`ts-json-schema-generator`) that runs in CI. It is
  build-time only and never ships, but it is a supply-chain surface the project
  did not have. Pin it.
- **Item 5 is justified by inference**, not measurement: we know they built a
  reference by hand, not that a shipped one would have stopped them.

## Landings

1. Narrow `channel`; generate and commit the schema; `filename` pattern;
   CI drift check. (The generator was verified against real data first — see
   Design 1.)
2. `validate_nuscenes.py` with cross-file checks.
3. Runtime: `allSettled`, required set, parse guard, zero-sensor error, cycle
   guard. Tests per failure mode.
4. `docs/NUSCENES_BYO.md`, linked from the error messages.
5. Example scene, reused as a fixture.
6. (after spec_002) nuScenes shards honour the entry `url`.

---

## Working-backwards PRFAQ

*Internal planning artifact for spec 004, written in the voice of the shipped
feature; none of it exists yet — see Landings above. Evidence base: one team,
three days of telemetry, never contacted, and we never learned what was
actually wrong. n=1.*

### Press release

**A checkable nuScenes contract: five of ten converter mistakes fail in your
pipeline, and the schema says which five it can't see.**

Anyone who wants to look at their own recordings in EgoLens has one realistic
target: the nuScenes layout — the only one of our three formats that is plain
JSON and images rather than a compiled binary schema. One team already has: 129
of their own recordings, converted, with no documentation because none exists.

Until now the viewer's UI answered those mistakes the same way — nothing. A
missing table, a typo'd filename, an unrecognised channel and a wrong path each
produce the same blank or subtly-wrong scene, with a `console.warn` as the only
trace. The one team we watched do this built a reference oracle by hand: three
throwaway servers, one official nuScenes scene each, compared by eye.

`schema/nuscenes-tables.v1.json` is published at a versioned URL, generated
from the TypeScript types the loader itself reads, with a CI step that
regenerates and fails on diff — so drift is a build failure, not a stale
document. It fixes `translation` at three numbers, `rotation` at four,
`channel` at one of twelve values and `filename` as relative; its field
descriptions carry the scalar-first `[w, x, y, z]` convention.

`scripts/validate_nuscenes.py` consumes that schema and adds what JSON Schema
cannot see: that every token resolves, that every `filename` points at a real
file, that each calibrated sensor reaches an accepted channel. One dependency,
because it runs in your CI, not ours.

Runtime errors become loud and aggregated: six required tables, six optional so
a converted fleet-log tree still loads, and a zero-sensor failure naming the
channels found against those accepted. `public/examples/nuscenes-minimal/`
ships two frames with a non-cubic box and a non-identity ego rotation, making
`[w,l,h]` and quaternion order observable — a thing to diff against, not a
detector; whether a shipped one would have helped them, we don't know.

Half the mistakes we could think of survive this contract, and none of it
writes your converter — half the ways it can be wrong just become an exit code
instead of a blank tab.

### Customer FAQ

**What exactly do I have to produce?**
A version directory of JSON tables, named `v1.0-mini` for the local-drop path —
the only name the folder scan recognises; others are a Non-goal for now. Plus
`samples/<CHANNEL>/…`: `.jpg` for cameras, `.pcd.bin` for lidar as a flat
float32 array of `[x, y, z, intensity, ring]` per point in the sensor frame.
Poses are translation plus a scalar-first quaternion. Serving it remotely needs
`https://` (`localhost` and `127.0.0.1` excepted); local folders are read in
the page, no server at all.

**Do you write the converter for me?**
No, and the spec doesn't pretend otherwise. Turning fleet logs into that layout
stays your work; what gets cheaper is finding out whether you got it right.

**How much of nuScenes do I really need?**
Six required: `scene`, `sample`, `sample_data`, `ego_pose`,
`calibrated_sensor`, `sensor`. Six optional: `sample_annotation`, `instance`,
`category`, `log`, `lidarseg`, `panoptic` — the annotation trio gates 3D boxes,
`log` supplies only the location and time-of-day labels. Presence is checked,
never row count, so unlabelled raw recordings are supported.

**Do I have to rename my sensors?**
Yes, and that is a real cost this spec does not remove. `channel` must be one
of twelve exact strings — `LIDAR_TOP`, six `CAM_*`, five `RADAR_*` — because
those names map onto the viewer's layout. `lidar_roof` fails with the accepted
list printed. Accepting arbitrary names by modality is a separate decision.

**What gets caught, and what doesn't?**
The schema is the field-level authority: it validates the 10 tables present in
the hosted v1.0-mini — 82,449 rows — with `additionalProperties: false` and no
failures, though `lidarseg`, `panoptic` and trainval are untested, so extra
fields are a warning. Of ten realistic converter mistakes applied to real rows,
five fail on the schema alone: unknown channel, uppercase `modality`, a
3-element `rotation`, a missing `translation`, `is_key_frame` as `"true"`. An
absolute `filename` was blind in that run; Landing 1's `pattern` catches it —
an eleventh case, not one of the ten. Four of the rest are one class, same
types different meaning: quaternion `[x,y,z,w]`, `size` `[l,w,h]`, millimetres,
points in the world frame. Valid JSON of the right shape, so they render
without error and *wrong*, worse than blank; diffing the example scene tells
you where to look, not what is wrong. The fifth, a dangling `ego_pose_token`,
is caught by the Python script; a wrong `.pcd.bin` stride by neither of them.

**Is any of my data uploaded?**
No. Remote data goes from your host to your browser and there is no EgoLens
backend; a local folder never leaves the page. Usage analytics are separate and
not exempt: every build, hosted or cloned, reports to GA4 by default, labelled
`hosted` / `local` / `other`. Almost all of it is interaction shape — which
dataset, colormap, overlay, camera. **One event, `camera_settle`, carries the
scene name and frame index**; if your scene names are themselves sensitive,
that is the one to know about. That analytics is how the usage described in
this document was seen at all.

**Can I turn the analytics off on a self-hosted build?**
Yes — `VITE_ANALYTICS_DISABLED=true` in `.env.local`, which Vite loads for
`npm run build` as well as dev. Note that `CONTRIBUTING.md` currently documents
`.env.development.local`, which Vite loads **only** in dev mode and therefore
does not cover a self-hosted production build. The two are inconsistent and
that is tracked separately from this spec; the mechanism above is what the code
actually does (`analyticsBootstrap.ts:55`).

**I already have a working conversion. What do I get?**
A regression gate: a change that breaks the layout's *shape* fails in CI, not
in someone's browser; one that alters only meaning still passes. Plus
`index.json` entries carrying their own URL, so one root can span scenes that
aren't subdirectories named after them — today that means one server per
version directory, and the observed team ran eight at once.

**Who asked for this?**
Nobody. One team, telemetry only, three days in June, never contacted: 129
recordings converted, then one morning 70 `page_view` events on one converted
scene across 23 minutes and a reference hand-built from official scenes. They
resolved it themselves at 03:23, and the remaining 90 scenes loaded fine. We do
not know what was wrong, only that the app never said. n=1 establishes that the
path is used; that it fails silently for everyone comes from the code.

### Internal FAQ

Questions a reviewer should ask before agreeing to build Design items 1, 2, 4,
5 and 6 (item 3 is the measurement that justifies them).

**Why build for a sample size of one?**
We aren't. That team is not the justification; it is the existence proof that
the adapter is a BYO path. `readJsonFile` (metadata.ts:86) returns `[]` for
anything it cannot find: one observation told us the path is used, the code
tells us it is silent for everyone.

**Then why not build only the runtime errors? They're cheaper.**
They only help after you've written a converter, served the tree and opened a
tab. Whether a louder error would have shortened that morning depends on what
was wrong, which we never learned — the case for moving feedback earlier does
not need that counterfactual. They stay required, demoted not dropped, since a
static contract is blind to five of ten mistakes. Docs are no substitute:
prose cannot fail a build.

**Why not a native EgoLens format instead of hardening someone else's?**
They accepted the layout and got 129 scenes through it, so we have no evidence
the format failed to express their data — and none about what did go wrong. A
fourth format means a fourth adapter, a fourth worker and a migration nobody
requested.

**We're a zero-install browser tool. Why ship a Python script?**
Zero-install is a promise about *viewing*, not about producing data. A pipeline
emitting these files is almost certainly Python — the devkit is, as is
everything in `scripts/`. Node is a further assumption; neither is something we
asked anyone.

**What if nobody runs the validator?**
The runtime errors fire without it, and the example scene is a fixture anyway.
Its failure mode is wasted effort, not a worse product.

**Why keep `additionalProperties: false` if nuScenes updates will break it?**
Because it validated all 10 tables of the hosted v1.0-mini: our interfaces are
an exact match for that split, not a subset. `lidarseg`, `panoptic`, trainval
and test are untested — precisely why violations are a *warning*.

**Doesn't the blind spot list undercut the whole thing?**
It bounds it. The residue is one class that renders without error and *wrong*,
which no static contract reaches — hence the example scene's non-cubic box and
non-identity rotation. If we couldn't state this boundary we shouldn't ship the
schema.

**What's the smallest version that still delivers value?**
Landing 1 alone: narrow `channel`, generate and commit the schema, add the
`filename` pattern, enforce the CI diff check — that check being the one
non-optional piece, since without it the schema is a second, stale source of
truth.

**What would make us stop or reverse this?**
Stop if the generator ever needs hand-editing to produce valid output — drift
by another name. Reverse the required-table throws if they break a
partially-downloaded official nuScenes, a risk mitigated by six tables,
presence-not-contents and the `v1.0-test` case. Rethink it all if the next BYO
team's problem is *expressing* their data rather than *checking* it.

**How would we know it worked, with no contact?**
Honestly: mostly we wouldn't. Our telemetry cannot see a `validate_nuscenes.py`
run in someone's CI — that's the point of moving feedback out of the browser,
and we are choosing an unobservable win over an observable one.
`folder_rejected` has fired **zero** times, which tells us nothing: nobody
tried the local path, or they left before it fired. The strongest signal
available is a bug report, and getting one would beat silence. Do not build
metrics into this spec that we cannot collect.