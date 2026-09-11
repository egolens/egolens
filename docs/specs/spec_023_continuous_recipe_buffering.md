# Continuous recipe buffering within byte budgets

**Status**: superseded for browser worker playback by spec 024; Phase 1 fallback implemented and validated · **Date**: 2026-09-11

## Decision

This clarifies Phase 1 item 3 of spec 022. During testing, the user reported
that buffering stopped after the initial few frames. A fixed four-frame
lookahead does not provide the expected background loading experience.

Keep the pending queue bounded, but replenish it after each completion until
the sequence ends or the payload cache reaches its byte budget. Playback can
remain paused while the buffer grows. A queue limit is not a stopping point
for the sequence.

## Behavior

- Keep at most two frame jobs active, with at most four outstanding jobs per
  point/camera lane. All graph reads share a six-read concurrency limit.
- Give the current point frame and its matching cameras priority. Reset the
  forward traversal after a seek and cancel obsolete work.
- Measure retained frame bytes before extending the queue. Reserve space for
  pending jobs using the largest observed frame in that lane.
- Background loading may reclaim cached history behind the playhead. It must
  not evict the current frame or the buffered future merely to download later
  frames. Stop when those retained frames fill the budget; resume as playback
  advances. Variable-size frames still undergo an actual byte check on arrival.
- A failed background request must not cause an infinite retry loop. An
  explicit foreground request can retry the frame.
- Preserve independent point/camera delivery and report actual residency.

The memory budgets remain 512 MiB for normalized point frames, 256 MiB for
camera frames, 128 MiB for lazy decoded graph payloads, and the existing 64 MiB
remote raw-object cache. These are payload-owner budgets, not a browser heap
or GPU memory limit.

## Verification

1. A paused synthetic 80-frame scene buffers through frame 79 without manual
   advancement while keeping the outstanding queue bounded.
2. A three-frame byte budget stops at frames 0, 1, 2 without cache churn, then
   advances to frames 2, 3, 4 after the playhead moves to frame 2.
3. The existing sealed remote PandaSet sample fills all 80 point/camera frames
   if its retained payloads fit the budgets. Record completion time and bytes.
4. Preserve cancellation, failure retry, delayed camera, and output parity
   checks from spec 022.

This is a correction within the approved Phase 1. Real Worker execution,
transport changes, and deployment still require their separate next steps.
