# Spec 001 — Integration Contract (Roadmap Phase 1)

**Status**: in-progress (landing 1 of 3) · **Date**: 2026-08-15 · **Estimated effort**: ~1 week · **Depends on**: nothing (all enablers landed)

EgoLens is being integrated into downstream workflows through its URL and
postMessage contract — telemetry shows integrators deep-linking scenes,
flipping between result sets, and even inventing their own URL parameters for
a playback time window. Phase 1 makes the contract express what integrators
are already trying to say with it. Every item below removes an observed
workaround; nothing here is speculative.

Four work items, ordered by delivery:

| # | Item | Observed workaround it removes |
|---|------|-------------------------------|
| 1 | Scene deep-link fast path | 10–20s first frame on every deep link; integrators reload anyway and abandon mid-load |
| 2 | `setScene` postMessage command | full iframe reload to switch logs |
| 3 | Time window (`t0`/`t1`) | integrator-invented `miningStart`/`miningEnd` params the app silently ignores |
| 4 | Collections (index.json metadata) | a downstream fork built a parallel scenario-index UI because ours can't carry curation metadata |

Plus a docs pass (item 5).

---

## 1. Scene deep-link fast path

### Problem

`loadFromUrl(dataset, parentUrl, scene)` for an AV2 parent URL always runs
multi-log discovery first (S3 listing or index.json), populates the selector,
and only then loads the requested scene. For a triage loop that opens dozens
of deep links, discovery cost + serialization is pure latency on every open.
Waymo already has the pattern we want (`loadFromUrl` skips discovery when
`initialScene` is present); AV2 and sharded nuScenes do not.

### Design

When `initialScene` is present alongside a parent/root URL:

1. Construct the child URL directly — AV2: `${parentUrl}${scene}/` (for a
   sensor root, try each split in parallel and use the first that responds);
   nuScenes sharded: `${rootUrl}${scene}/`.
2. Begin loading that scene immediately (manifest-first, as today).
3. Run discovery **in the background**; when it completes, populate
   `availableSegments` and the discovered-log list without interrupting the
   active load. Until then `availableSegments = [initialScene]`.
4. If the direct load 404s (bad scene id), fall back to the current
   discovery-first path so the error message stays informative.

### Touchpoints

- `src/stores/useSceneStore.ts` — `loadFromUrl` AV2 branch (parent/root +
  `initialScene` case) and nuScenes sharded branch; background-discovery
  merge must not clobber `currentSegment`.
- `src/adapters/argoverse2/remote.ts` — small helper to probe
  `${root}${split}/${scene}/` across splits (HEAD on `manifest.json`, fall
  back to `calibration/egovehicle_SE3_sensor.feather`).

### Acceptance

- Deep link to a val log renders its first frame without any ListObjectsV2
  delimiter listing having completed (verify in the network panel).
- Selector still fills with the full log list within a few seconds of load.
- Bad scene id produces the existing "not found" error, not a hang.

---

## 2. `setScene` postMessage command

### Problem

The embed API (`src/utils/embedApi.ts`) can seek and play but cannot switch
scenes, so hosts rebuild the iframe per scene — losing warm workers, camera
pose, and toggles, and re-paying full load cost.

### Design

Inbound message:

```ts
{ type: 'setScene', scene: string }
```

- Multi-scene mode (discovered logs/scenes): validate `scene` against
  `availableSegments`, then `actions.selectSegment(scene)` — the in-app
  switch path already handles shard/log loading without a reload.
- Unknown scene → outbound `{ type: 'error', message }` (existing shape).

New outbound event, fired on every successful segment switch (not just
host-initiated ones, so hosts can track user navigation too):

```ts
{ type: 'sceneChange', scene: string, totalFrames: number }
```

`stateReply` gains a `scene` field. Protocol addition is backward-compatible
(old hosts ignore unknown message types).

### Touchpoints

- `src/utils/embedApi.ts` — new inbound case + outbound event; subscribe to
  `currentSegment` transitions.
- `docs/EMBEDDING.md` — message table.

### Acceptance

- In an embed harness page, `setScene` to another discovered log swaps the
  scene without an iframe reload; `sceneChange` fires; toggles and camera
  mode survive the switch.

---

## 3. Time window — `t0` / `t1`

### Problem

Scenario-mining results are *intervals*, not logs. An observed integration
appended `miningStart`/`miningEnd` (nanosecond timestamps) to embed URLs —
parameters we ignore. This is a de-facto spec submission; adopt it.

### Design

URL parameters (and share-link round-trip):

```
&t0=<int64 ns, as string>&t1=<int64 ns, as string>
```

Semantics:

- On load, resolve `t0`/`t1` to frame indices: `f0` = first frame with
  timestamp ≥ `t0`, `f1` = last frame with timestamp ≤ `t1` (clamped,
  `f0 ≤ f1`; unresolvable window → ignore with a console warning).
- Auto-seek to `f0`. `t0` wins over `frame` if both are present.
- **Playback loops within `[f0, f1]`** — looping suits both embed autoplay
  and triage review better than stopping.
- Manual scrubbing outside the window is allowed (the window constrains
  playback, not the user). Timeline renders the window as a highlighted band;
  a small dismiss chip clears the window (drops params via replaceState).
- Timestamps are dataset-native sensor times: AV2 `lidarTimestamps` (ns),
  nuScenes sample timestamps (µs — accept both units by magnitude: values
  < 10^17 are treated as µs), Waymo frame timestamps (µs). v1 must cover
  AV2 (the observed need); nuScenes/Waymo mapping included if trivial,
  otherwise documented as follow-up.

postMessage:

```ts
{ type: 'setWindow', t0: string, t1: string }   // strings — int64 over JSON
{ type: 'setWindow', t0: null }                  // clear
```

`stateReply` gains `window: { t0, t1, f0, f1 } | null`.

### Touchpoints

- `src/utils/embedParams.ts` — parse/validate (int64 as string; reject
  non-numeric).
- `src/utils/urlState.ts` — share links carry the active window.
- `src/stores/useSceneStore.ts` — `playbackWindow: { f0, f1 } | null` state;
  playback advance clamps/loops here (single choke point used by the
  timeline).
- `src/components/Timeline/Timeline.tsx` — window band + clear chip.
- `src/utils/embedApi.ts` — `setWindow` command.
- Timestamp→frame resolution: AV2 `db.lidarTimestamps`; nuScenes
  `sample.timestamp` walk; Waymo per-frame timestamps from the loaded pose
  table.

### Acceptance

- `?...&t0=X&t1=Y&autoplay=true` opens seeked to `f0` and loops inside the
  band; the band is visible on the timeline; share link reproduces it.
- `setWindow` retargets the loop live; clearing restores full-range playback.
- Unit tests: µs/ns unit inference, clamping, `t0` > `t1` rejection,
  `t0`-vs-`frame` precedence.

---

## 4. Collections — index.json curation metadata

### Problem

The largest downstream fork's core feature is a scenario index: per-scene
safety tags, city, and a quality score driving cards, filters, and batch
review. Our index.json (introduced for hosted-mirror discovery) is the right
substrate but carries no metadata, so curation currently requires forking
the UI.

### Design

Extend both index schemas (AV2 `AV2IndexLog`, nuScenes `NuScenesIndexScene`)
with optional fields:

```jsonc
{
  "log_id": "02678d04-…",          // or "name" for nuScenes
  "tags": ["near-miss", "pittsburgh"],  // ≤ 8, shown as selector pills + filter chips
  "score": 0.87,                    // sort key when present (desc)
  "description": "cyclist crossing at dusk",  // searchable, shown under the id
  "url": "https://…/logs/02678d04-…/av2/"     // absolute override — see below
}
```

- **`tags`** — selector filter chips generalize from the existing
  split-chip mechanism (`SelectItem.tag` becomes `tags: string[]`; split
  remains just another tag, keeping its warning tone for `test`). Chips show
  union of tags with counts; multiple active chips AND-combine.
- **`score`** — when any entry has a score, the selector offers score-desc
  ordering (default stays name-asc) and shows the value in the row.
- **`description`** — included in the text-filter haystack; rendered as a
  second line on desktop rows.
- **`url`** — optional absolute log/scene URL, letting a collection point at
  data hosted elsewhere. This makes an index.json a *standalone curation
  file*: a fork-free way to publish "169 scenarios worth labeling" against
  the public S3 bucket or any mirror. (Also the prerequisite already
  identified for split-origin hosting.)

Generator support: `generate_av2_index.py` and `shard_nuscenes.py` pass
through these fields from an optional `--meta <jsonl>` sidecar keyed by
log id/scene name. No pipeline rerun needed to annotate an existing mirror —
regenerating index.json alone suffices.

### Touchpoints

- `src/adapters/argoverse2/remote.ts`, `src/adapters/nuscenes/remote.ts` —
  schema + `AV2DiscoveredLog`/`NuScenesDiscoveredScene` carry the fields;
  honor `entry.url`.
- `src/components/SearchableSelect.tsx` — `tags[]`, multi-chip filter,
  score sort, description line. Keep the component dataset-agnostic.
- `src/stores/useSceneStore.ts` — plumb metadata from discovery to selector
  items (extend the `getSegmentSplits`-style accessor into a general
  `getSegmentMeta`).
- `scripts/generate_av2_index.py`, `scripts/shard_nuscenes.py` — `--meta`.
- Docs: a short "Collections" section in EMBEDDING.md + hosting runbooks.

### Acceptance

- An index.json with tags/score/description renders chips, sort, and
  descriptions with zero code changes for the author.
- A collection file whose entries use absolute `url`s loads scenes from a
  different host than the index itself.
- Datasets without metadata look exactly as today (all fields optional).

---

## 5. Documentation pass

- Commit `docs/EMBED_SYSTEM_DESIGN.md` (currently untracked).
- `docs/EMBEDDING.md`: new params (`t0`/`t1`), new messages (`setScene`,
  `setWindow`, `sceneChange`), collections section, and a "host action
  button" recipe (getState → external send button — the fork's
  "Send Frame to Encord" pattern, achievable without forking).

---

## Sequencing

Three landings, each independently shippable and verified in the browser
before moving on (dev server + the local shard/CORS harness from the
nuScenes work):

1. **Fast path + `setScene`** (items 1–2) — pure loader/API work, no UI.
2. **Time window** (item 3) — store + timeline + params.
3. **Collections + docs** (items 4–5) — selector generalization last, since
   it touches the shared component.

Each landing: unit tests alongside (vitest, existing mock patterns in
`__tests__/indexDiscovery.test.ts` / `embedParams.test.ts`), full suite +
tsc + lint-delta gate, browser e2e against the local harness.

## Non-goals (explicitly out of Phase 1)

- The npm/hosted SDK wrapper (Phase 2) — Phase 1 only makes the raw contract
  worth wrapping.
- Prediction overlay / diff rendering (Phase 4).
- Frame data export (`getFrameData`) — deferred until requested; see roadmap.
- New GA4 dimensions — usage of the new params is observable through
  existing page-path reporting; measurement cleanup belongs to Phase 5.

## Risks

- **int64 in JS** — timestamps exceed 2^53; keep them as strings end-to-end
  (the manifest generator already does this for the same reason) and compare
  as BigInt only at the resolution site.
- **Background discovery races** — the fast path must not let a late
  discovery result reset `currentSegment` or re-trigger selection; guard on
  "user already on a segment".
- **SearchableSelect scope creep** — tags/score/description triple the
  component's surface; keep filtering/sorting logic in pure helpers with
  their own tests, and resist per-dataset branches inside the component.
- **Timestamp unit ambiguity** (ns vs µs) — magnitude-based inference is
  documented and unit-tested; wrong inference degrades to "window ignored",
  never a crash.
