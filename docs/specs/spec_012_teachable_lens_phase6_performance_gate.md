# Spec 012 — Teachable Lens Phase 6 performance and lifecycle gate

**Status**: in-progress (runtime/lifecycle cutover and CDP harness implemented; isolated 20-switch cross-dataset lifecycle soak passes; hidden-oracle promotion → spec 013 pending) · **Date**: 2026-08-30

**Relationship to Spec 006**: this is the normative acceptance addendum for
[`spec_006_teachable_lens.md`](spec_006_teachable_lens.md) Phase 6. Phase 6 may
remove the dual runtime only after satisfying the performance, ownership, and
lifecycle gates in this document. Where this document is more specific, it
takes precedence over Spec 006.

## Decision

Phase 6 is a performance-preserving runtime migration, not a loader rewrite.
The existing row-group scheduling, caching, cancellation, transferable-buffer,
and renderer behavior are the baseline implementation. They move behind
`NormalizedSceneV1` before their compatibility wrappers are deleted.

No dataset cutover is complete merely because output parity passes. It must
also prove that it does not introduce sustained memory growth, duplicate
decoding, unbounded caches, leaked workers or graphics resources, or a material
latency/frame-rate regression.

## 1. Capture a baseline before deleting either path

Record the following measurements on the same browser build, machine, viewport,
dataset scene, and presentation settings before and after each cutover:

- time to dataset ready and time to first rendered frame;
- cold and warm frame-load latency, including p50 and p95;
- rapid-scrub input-to-frame latency and playback frame rate;
- Parquet row-group fetch and decompression counts;
- main-thread JS heap, worker memory, and total retained frame/image bytes;
- active worker, object URL, `ImageBitmap`, WebGL texture, geometry, and material
  counts where the platform exposes them;
- memory after scene disposal and after switching to another dataset.

Use at least five runs after one warm-up run. Compare distributions rather than
a single fastest run. Store the benchmark scenario, commit, browser version,
hardware, raw samples, and summary so a future regression can be reproduced.
The rapid-scrub input must resolve the same stable timeline selector in both
revisions. Its latency distribution is limited to `frame-presented` trace marks
whose scene generation matches the initially loaded scene; cold first-frame
marks from later cross-dataset soak generations are not warm/rapid samples.
The runner must fail validation when that interaction target or sample set is
absent rather than substituting another generation.

### Measurement source matrix

The benchmark runner must use Chrome DevTools Protocol (CDP) as the external
source of browser/runtime facts and a read-only EgoLens application probe for
state whose meaning is not visible to the browser. A passing result may not be
based on DevTools UI readings or manual observation.

| Measurement | Authoritative source | Required collection method |
|---|---|---|
| main-page and worker JavaScript heap | CDP | attach to the page and every worker target through `Target`; record every field returned by `Runtime.getHeapUsage` separately per target |
| worker lifetime and survivors after disposal | CDP | record `Target` creation/destruction and the attached worker target set at each snapshot |
| documents, DOM nodes, and JavaScript event listeners | CDP | record `Memory.getDOMCounters` at the same lifecycle checkpoints |
| HTTP requests, Range requests, encoded bytes, timing, and cache reuse | CDP | derive them from `Network` request/response/loading events, preserving URL, Range header, initiator, cache flags, and request identity |
| long tasks, main-thread work, frame timing, and User Timing milestones | CDP | capture a bounded `Tracing` recording; use `Performance` metrics as supporting counters rather than as the sole frame-rate source |
| dataset-ready, first-usable-frame, and input-to-frame latency | application marks + CDP | emit uniquely named `performance.mark()` entries and collect them through the trace or `Runtime.evaluate`; timestamps must use the page's monotonic clock |
| row-group fetches | CDP + application probe | CDP proves physical requests; the probe maps requests/cache hits to logical row-group keys |
| row-group decompressions and decoded frame/image bytes | application probe | expose cumulative operation counts plus current and peak retained bytes for each bounded cache |
| worker-pool queue, in-flight, cancellation, and stale-drop state | application probe | expose current gauges and cumulative counters grouped by scene generation and operation type |
| live object URLs and `ImageBitmap` objects | application probe | count creation and successful revoke/close operations; expose live identities or stable diagnostic IDs without retaining the resources themselves |
| WebGL textures, geometries, programs, and scene-owned materials | application probe | snapshot Three.js `renderer.info` and the renderer bridge's explicit ownership registry before load and after disposal |
| exact GPU memory bytes | unavailable portable metric | do not invent a byte estimate; use stable renderer resource counts, disposal assertions, and browser-process observations only as supporting evidence |

The benchmark build must expose a versioned
`globalThis.__EGOLENS_PERF__.snapshot()` (or an equivalent injected test hook)
whose result is JSON-serializable and contains no live scene, buffer, bitmap,
texture, worker, or DOM references. It must include the active scene generation,
cache byte gauges and limits, cumulative fetch/decompression counters, worker
pool gauges, cancellation/stale-response counters, live resource counts, and
renderer resource counts. The hook is diagnostic-only, read-only from the
benchmark's perspective, and must not change scheduling, cache policy, or
resource lifetime when sampled.

Each raw sample must retain the individual CDP heap fields and target identity.
For the regression comparison, use one documented aggregation formula across
both revisions; do not label a sum of V8, embedder, and backing-store fields as
total browser or GPU memory. Shared browser processes and allocator behavior
make that interpretation invalid.

Capture coordinated CDP and application snapshots before scene load, after the
warm-up/settle window, at every soak checkpoint, immediately after disposal,
and after the post-disposal settle window. Record a forced-GC snapshot only
after its paired naturally settled snapshot. The natural checkpoint is authoritative
for live document shape, worker/object/image/renderer ownership, and bounded
application caches. The forced snapshot is additionally required to prove that
CDP's all-document node/listener counters contain no reachable detached viewer
tree. During a heterogeneous cross-dataset soak, paired forced-GC diagnostics
also provide the retained-memory series, grouped by revisited dataset. The
runner must collect the page and every live worker target before sampling;
page-only collection leaves worker V8 garbage in the series. Never fit
differently sized dataset heaps into one slope. Preserve the original global
switch index as the independent variable after grouping: a dataset revisited
every third switch still has three switches between samples, and the regression
budget is bytes per global switch rather than bytes per revisit. Forced diagnostics must not
replace the natural checkpoint or rescue a failure in any natural ownership
invariant. Steady traced FPS is computed only between the initial scene's ready
mark and its first replacement/disposal mark, excluding later loading periods.

Every warm-up and measured run must start a fresh Chrome process with a fresh
user-data directory. `Target.closeTarget` is not a sufficient run boundary:
Chrome may keep a renderer from a completed trace alive after its page target
disappears, and that renderer can consume CPU and heap while a later run loads.
The runner must terminate the isolated browser process, wait for exit, and
remove its profile before starting the next run. The artifact records this as
`scenario.browserIsolation = "per-run"`.

A lifecycle-only candidate artifact may disable CDP tracing to remove tracing
overhead while it exercises switches, forced-GC diagnostics, ownership, and
disposal. Such an artifact must record `scenario.traceEnabled = false` and may
only supplement a traced performance candidate captured from the same
production-app commit. It cannot supply or waive latency, FPS, or long-task
budgets, and a trace-free artifact must never be compared to a traced baseline
as if their workloads were identical.

### Browser renderer lifecycle findings

The Phase 6 Waymo production smoke and normative switch soak exposed five browser-framework retention
edges that are not visible in Zustand cache gauges:

1. `@react-three/fiber` 9.5 keeps its last frame state/subscription variables
   after its animation loop stops;
2. its embedded React reconciler may retain the last unmounted `FiberRoot` for
   nested-update detection, while R3F leaves `containerInfo` pointing at the
   disposed scene store;
3. `WebGLRenderer.dispose()` does not clear `WebGLAttributes` entries by
   itself. Every geometry rendered by the main viewer or the secondary BEV
   renderer must emit `dispose` before renderer disposal, including shared
   Three.js Sprite geometry used through a portal scene.
4. `useLoader` uses the process-wide `suspend-react` response cache. A cached
   GLTF response strongly retains its shared geometries; if a transient model
   is rendered between ownership samples, that response can keep the geometry,
   its `WebGLBuffer`, the dead WebGL context, detached canvases, and viewer
   control DOM reachable. Viewer teardown must clear all model URLs it owns
   from the loader cache. Browser HTTP caching remains independent and may
   continue to serve later model loads.
5. A closed CDP page target does not prove that its Chrome renderer process has
   exited. Reusing one browser for all benchmark runs left a prior traced
   renderer consuming about 3.5 GiB RSS and multiple CPU cores while the next
   Waymo load waited at its first frame. Per-run browser-process isolation
   removed the survivor; a trace-free nuScenes → Waymo smoke then completed in
   75 seconds, and a six-switch Waymo/nuScenes/AV2 lifecycle smoke completed in
   97 seconds with no browser process left behind.

The production build therefore applies a fail-closed R3F 9.5 lifecycle patch:
it releases last-frame variables at the loop terminal and clears the disposed
FiberRoot's `containerInfo` only after R3F removes the canvas root. The build
must fail if the pinned dependency source no longer matches these reviewed
terminals. Both viewer renderers must track every geometry/material they render,
dispose those resources before their renderer, and remain safe to recreate on
the next scene. Re-evaluate and remove the patch when upgrading R3F.

Phase 5 currently binds a shadow `NormalizedSceneV1` while compatibility
workers still feed the renderer. Its duplicate timestamp/index scans are part
of the measured starting state, not behavior to preserve. Phase 6 must remove
those duplicate scans as soon as one authoritative path owns frame indexing.

## 2. One owner for every expensive resource

The runtime must document and test the owner and release point for every
expensive resource:

| Resource | Owner while live | Required release |
|---|---|---|
| compressed Parquet ranges | bounded row-group cache | cache eviction or scene disposal |
| decoded point buffers | normalized frame cache | transfer/eviction or scene disposal |
| encoded camera bytes | normalized image cache | eviction or scene disposal |
| `ImageBitmap` and GPU texture | renderer resource cache | `close()` / `dispose()` |
| object URLs | component that created them | `URL.revokeObjectURL()` |
| workers and message listeners | normalized scene runtime | abort, detach, and `terminate()` |
| timers, subscriptions, controls | creating component/runtime | unsubscribe or clear on disposal |

A point or image buffer may be transferred or viewed without copying, but may
not be retained independently by a compatibility cache, normalized cache, and
renderer cache. Cache keys and byte budgets must be explicit. An LRU or
equivalent bounded policy is required wherever data can grow with frame count.
Pure compatibility projections may be memoized only as weakly keyed derived
views whose lifetime follows the normalized manifest/frame component that owns
their input. This includes renderer sensor/class maps, box rows, and lossy radar
layouts used by the existing renderer. A hot seek must reuse those projections
without creating a second strongly retained frame cache.
Eviction must be operational rather than merely bounded: every consumer-facing
seek demand-reloads each independently missing point or camera batch. A cache
hit in one resource class must never suppress restoration of another class.
Progress counters must record cumulative unique batches separately from current
LRU residency. Evicting already-read data changes buffer availability, not the
fact that initial loading completed.

## 3. Scene disposal is an idempotent contract

`NormalizedSceneV1.dispose()` must be safe to call more than once and must:

1. advance a scene-generation token so stale responses cannot mutate the next
   scene;
2. abort queued and in-flight reads and conversions;
3. detach worker listeners and terminate scene-owned workers;
4. clear row-group, frame, camera, projection, and annotation caches;
5. close image resources, revoke object URLs, and dispose GPU resources owned
   by the scene/renderer bridge;
6. release timers and subscriptions;
7. prevent future `loadFrame()` calls from starting work.

Cancellation is not disposal by itself. A cancelled task must release temporary
allocations even if its scene remains live. A late worker message must be
dropped by generation/request identity before touching caches.

## 4. Cut over one dataset at a time

Use the same sequence for Waymo, nuScenes, and Argoverse 2:

```text
baseline compatibility path
        ↓
NormalizedScene-backed renderer bridge using existing algorithms
        ↓ structural/numeric/perceptual parity
        ↓ performance + lifecycle + soak gates
remove that dataset's compatibility production path
```

Do not keep both frame-production paths active for a gradual rollout. A guarded
fallback may select either path at scene creation while the migration is under
review, but one scene must have exactly one authoritative frame/cache owner.

Do not cut over the next dataset until the previous dataset passes its gates
and its obsolete production path is removed. Golden fixture/oracle code may
remain in tests.

## 5. Required soak scenarios

Automate deterministic lifecycle invariants in CI and run browser memory/perf
measurements on a stable benchmark host. At minimum exercise:

- 20 repeated scene switches, including cross-dataset switches;
- two complete playback loops;
- at least 100 rapid non-sequential frame seeks;
- repeated camera POV, camera colormap, world mode, segmentation, keypoint, and
  box/model toggles when the dataset supports them;
- cancellation during Parquet read, conversion, camera decode, and scene
  switch;
- disposal while workers have queued and in-flight requests;
- recovery by loading a valid scene immediately after each cancellation case.

Tests must assert stable worker counts, bounded cache bytes, no accepted stale
responses, and idempotent disposal. Browser runs must sample memory after an
explicit settle window; they must not treat an immediate pre-GC snapshot as a
leak or assume that garbage collection alone releases GPU and worker resources.

## 6. Regression budgets

Unless a stricter dataset-specific budget is recorded with evidence, each
cutover must satisfy all of these on the benchmark scenario:

- time to first rendered frame p95: no more than 10% or 50 ms slower than the
  baseline, whichever allowance is larger;
- warm frame-load and rapid-scrub p95: no more than 10% or one 60 Hz frame
  (16.7 ms) slower, whichever allowance is larger;
- steady playback frame rate: no more than 5% lower;
- row-group fetch/decompression count: no increase for the same access trace,
  and zero duplicate decompressions caused by parallel runtime paths;
- settled main-thread plus worker memory: no more than 10% or 32 MiB above the
  baseline, whichever allowance is larger;
- after the first warm-up cycle, settled retained-memory slope across the
  20-switch soak: at most 1 MiB per switch and no monotonically growing cache;
- workers/listeners/object URLs owned by a disposed scene: zero;
- renderer resource counts after disposal: return to the pre-scene baseline,
  allowing at most two intentionally shared persistent resources documented by
  name.

A regression outside these limits blocks deletion of the compatibility path.
An exception requires a new numbered spec with measurements, user-visible
benefit, bounded impact, and an explicit accepted budget; an implementation PR
description is not sufficient.

## Phase 6 exit gate

- [ ] Baseline artifacts exist for all three datasets and include coordinated
      raw CDP traces/metrics and application-probe snapshots.
- [x] Resource ownership and byte budgets are implemented and tested.
- [x] `dispose()` and cancellation lifecycle invariants pass in CI.
- [x] The required browser soak scenarios pass without sustained growth.
- [ ] Structural, numeric, and perceptual parity still pass.
- [ ] Every regression budget passes for each dataset cutover.
- [ ] Each live scene has one frame producer and one cache owner.
- [ ] Compatibility production paths are removed only after their dataset
      passes all gates.
- [ ] `registry.ts` and scene loading no longer choose different execution
      paths for bundled versus learned recipes.
