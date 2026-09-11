# Recipe playback scheduling and worker execution

**Status**: in-progress; Phases 1 and 2 implemented and validated locally; Worker parity in spec 024; deployment pending · **Date**: 2026-09-11

## Problem and observed implementation

Opening a sealed remote PandaSet recipe is much slower than playing a built-in
Argoverse scene. Recognition now works; the remaining issue is frame delivery.
This proposal improves the common recipe runtime rather than changing the
sealed recipe or introducing a PandaSet-specific loader.

At baseline commit `dd94298`:

- `loadAuthoredScene` binds a recipe with `delegateOwnsFramePayloads: true`,
  loads frame zero, and marks the scene ready. It attaches no frame worker pools
  and does not enter `runPostWorkerPipeline`, which starts built-in prefetch.
- The delegate path loads each uncached frame when requested. Completed frame
  caching and some in-flight deduplication already exist, but no lookahead
  scheduler populates the next frames.
- `GraphSceneAssembler` awaits point data and labels, then reads camera files
  sequentially. Its metadata readers also read matched files sequentially.
- `ManagedNormalizedScene` treats every valid delegate frame as available in
  `hasPointFrame` and `hasCameraFrame`; these answers describe loadability, not
  actual cache residency. Its metadata-frame fetch requests all capabilities.
- Core operators marked `execution: 'worker'` are still called directly by
  `executeCore`; the descriptor does not dispatch work to a Worker. The pickle
  frame decoder is also invoked directly by the graph's lazy binary reader.
- Delegate frame retention is bounded by a frame count, while decoded graph
  collections retain their own payloads. Lookahead must have byte budgets and
  release both owners, not merely remove entries from a wrapper cache.

The earlier single-file experiment downloaded 8,121,262 bytes in about 1.18 s;
pickle decoding took about 29 ms and one JavaScript SHA-256 pass about 95 ms.
These are single Node measurements on the same machine, not browser playback
latency distributions. They support measuring network waiting separately from
CPU work. Dataset fingerprinting's earlier 8.2 s measurement belongs to
authoring/finalization and must not be reported as playback cost.

## Phase 1: Frame scheduling and bounded parallel reads

Approval scope: common recipe loading, caching, diagnostics, and focused tests.

1. Capture a browser baseline with the existing sealed PandaSet recipe and all
   80 frames available. Separate startup metadata, first usable point frame,
   camera completion, cold seek, warm seek, and playback stalls. Record request
   counts/bytes and retained payload bytes alongside latency.
2. Add bounded parallel reads for independent frame payloads and metadata
   files. Preserve deterministic file, sensor, row, and timestamp ordering.
   Enforce one shared concurrency budget so nested readers cannot multiply it.
3. Prioritize the current frame and the most recent seek. After the first
   usable frame, prefetch a bounded window ahead of the playhead. Reprioritize
   after a seek and cancel obsolete work on source changes or disposal.
4. Separate camera delivery from the point-frame critical path. Present the
   requested frame's point data when ready and update its cameras when their
   matching payloads arrive. Never combine images from a stale frame with the
   current frame's overlays or pose. Preserve required capability dependencies.
5. Reuse in-flight reads/decodes. Bound raw, decoded, and normalized payload
   retention by bytes; eviction must release the graph's allocations as well
   as wrapper references. A later revisit may legitimately reload evicted data.
6. Report actual point/camera residency to the buffer bar and scheduler.
   Distinguish loadable, queued, loading, cached, and failed work internally.
   Surface foreground failures; background failures must remain retryable.

Use conservative initial concurrency and lookahead limits, tuned from the
baseline under the existing byte budgets. Available bandwidth still limits
sustained playback; prefetch is not evidence that arbitrary connections can
stream the full uncompressed sequence at its nominal frame rate.

### Phase 1 acceptance

- The existing sealed artifact loads unchanged, including all declared sensors
  and outputs. The first frame does not wait for the entire sequence.
- A delayed camera response does not delay the usable point frame. Independent
  camera requests overlap within the configured concurrency bound.
- The next frames become cached before an explicit user request. Rapid seeks
  prioritize the latest target and late results never replace that target.
- Concurrent foreground/prefetch requests share work. Identical warm requests
  do not refetch/redecode resident payloads.
- Cache limits apply to actual retained payload bytes. Disposal cancels work
  and releases allocations; failures do not permanently poison cache entries.
- Compare cold/warm p50 and p95, first usable frame, playback stalls, requests,
  and retained bytes on the same browser/machine/recipe. Use a warm-up and at
  least five comparable runs, following the measurement principles of spec 012.
  Retain raw results and identify unavailable measurements explicitly.
- Run focused scheduling, cancellation, capability, and lifecycle regressions,
  existing built-in loading checks, build, and lint. Report the results before
  asking to start Phase 2.

## Phase 2: Actual Worker execution

Separate approval after Phase 1 results. Move heavy generic decoding and
transforms behind a real Worker execution boundary that the recipe runtime
uses for both local and remote inventories. Transfer typed-array payloads,
preserve catalog verification and source authorization, and use the common
scheduler's priority, cancellation, and memory accounting. Do not duplicate
whole graph startup and source downloads independently in every worker.

Evaluate hash CPU time as well as pickle/other binary decoding; offloading only
pickle decoding leaves synchronous verification work on the UI thread.
Validate worker creation/disposal, transferred-buffer ownership, output parity,
main-thread responsiveness, and cold/warm latency before considering rollout.

## Further transport work

Host CORS exposure, partial inspection reads, immutable caching, and HTTP
compression are separate transport changes to evaluate from the measurements.
Range alone cannot avoid a complete pickle file when decoding that frame.
No hosting changes, recipe rewrites, data reduction, or application deployment
are included in Phase 1 or implied by this proposal.
