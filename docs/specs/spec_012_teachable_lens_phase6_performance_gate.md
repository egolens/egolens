# Spec 012 — Teachable Lens Phase 6 performance and lifecycle gate

**Status**: planned · **Date**: 2026-08-29

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

- [ ] Baseline artifacts exist for all three datasets and include raw samples.
- [ ] Resource ownership and byte budgets are implemented and tested.
- [ ] `dispose()` and cancellation lifecycle invariants pass in CI.
- [ ] The required browser soak scenarios pass without sustained growth.
- [ ] Structural, numeric, and perceptual parity still pass.
- [ ] Every regression budget passes for each dataset cutover.
- [ ] Each live scene has one frame producer and one cache owner.
- [ ] Compatibility production paths are removed only after their dataset
      passes all gates.
- [ ] `registry.ts` and scene loading no longer choose different execution
      paths for bundled versus learned recipes.
