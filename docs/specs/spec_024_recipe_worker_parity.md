# Recipe and built-in playback parity

**Status**: in-progress; implemented and validated locally, deployment pending; results in ../RECIPE_PLAYBACK_PERFORMANCE.md · **Date**: 2026-09-11

## Authorization and scope

After reviewing Phase 1's different concurrency and queue behavior, the user
explicitly requested parity with built-in datasets. This authorizes the
Worker implementation described as Phase 2 in spec 022. This supersedes the
fixed small pending queue for browser playback in spec 023.

## Shared execution

- Reuse `WorkerPool` and shared constants for three point Workers, two camera
  Workers, and ten-frame batches for file-based datasets. Waymo continues to
  use its native row groups.
- Queue all remaining batches after the first usable frame, as built-in
  playback does. Maintain bounded payload caches and dispose every Worker
  when the scene ends.
- Execute the recipe graph once. Send its prepared, cloneable read plans and
  metadata to Workers with empty lazy caches. Never execute graph startup or
  download all metadata independently in every Worker.
- Broker authorized reads through the original ByteSource and its shared
  verified cache. Each frame Worker schedules one file read at a time, matching
  the built-in file-worker loops. Five active Workers share at most five reads.
- Decode, transform, and assemble normalized frame payloads in Workers.
  Transfer cloned result buffers so graph metadata and lazy caches are never
  detached accidentally. Stream completed frames before their batch finishes.
- Promote the current batch. Cooperative recipe Workers can yield an active
  background batch for a new foreground seek; otherwise ten large PandaSet
  frames would delay the seek by an entire batch. Yielded batches return to
  background prefetch. This is an opt-in extension of the shared WorkerPool;
  existing worker protocols continue unchanged.
- Preserve exact source verification, but perform native asynchronous SHA-256
  once per fetched object/chunk rather than hashing it separately at download
  and cache insertion. Renderer correctness does not inherently require these
  digests; this retains the existing portable catalog integrity contract.

## Verification

Verify actual browser creation of 3+2 Workers, all-batch queueing, early frame
delivery, foreground priority, cancellation, retry, memory disposal, and exact
normalized output parity for all 80 original sample frames. Repeat the timing
and full-buffering benchmark from Phase 1 after functional checks pass. Report
store readiness separately from renderer presentation and nominal playback
cadence. Validate existing built-in loading tests and shared WorkerPool tests.

No saved recipe rewrite, dataset reduction, hosting change, or deployment is
included. The non-Worker fallback remains available in environments without
Workers, including ordinary Node conformance tests.
