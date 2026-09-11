# Recipe playback performance

Local development verification on September 11, 2026. Phase 1 follows
[spec 022](specs/spec_022_recipe_playback_scheduling.md) and
[spec 023](specs/spec_023_continuous_recipe_buffering.md). The current browser
path implements the subsequently authorized Worker parity in
[spec 024](specs/spec_024_recipe_worker_parity.md). Nothing has been deployed.

## Current Worker path

The built-in file datasets and recipe playback share `WorkerPool`, three point
Workers, two camera Workers, and a ten-frame batch size. Remaining batches are
queued in full. Recipe Workers stream each completed frame before the batch
finishes and can yield a background batch to prioritize a new seek. Point and
camera foreground batches both receive priority. Waymo's built-in batch unit
remains its native Parquet row group.

The recipe graph executes once. Workers receive prepared plans and metadata,
with their own empty lazy caches, and access the original authorized source
through a shared broker. Five active Workers perform at most five concurrent
file reads. Decoding and frame assembly execute in Workers, and cloned frame
buffers are transferred without detaching graph-owned metadata or caches.

Remote file and chunk payloads are no longer hashed on download or cache access
(see spec 025). The bounded cache uses remote root, manifest identity, path, and
byte range; transport length and range checks remain. Catalog and recipe identity
hashes remain compatible with saved artifacts. The measurements below predate
this removal and do not measure its performance impact.

The original 512 MiB point and 256 MiB camera payload limits remain. Worker lazy
decode caches are limited to 32 MiB per point Worker and 16 MiB per camera Worker
(128 MiB combined). Prepared static metadata copies, transient transfers,
renderer allocations, and GPU memory are outside these payload-owner budgets.

## Worker results

One warm-up followed by five measured trials, using the same machine, browser,
sealed recipe, and full remote sample as Phase 1. The definitions and timing
limitations below also apply here.

| Store-ready measurement | Original baseline p50 / p95 | Worker path p50 / p95 |
| --- | --- | --- |
| First point frame, including graph startup | 16,301 / 22,053 ms | 4,563 / 4,897 ms |
| First six camera payloads, from the same start | 16,301 / 22,054 ms | 7,099 / 7,698 ms |
| Cold seek to frame 40 | 1,884 / 2,443 ms | 1,620 / 2,146 ms |
| Sequential advances through frames 41–45 | 1,866 / 2,120 ms | 284 / 1,265 ms |
| Immediate repeat of frame 40 | 158 / 164 ms | 0.6 / 0.7 ms |

Whole-sequence prefetch does more speculative work than Phase 1's smaller
queue. The measured trials received 232–237 responses and approximately
272–296 MB of decoded response-body bytes, compared with approximately 79 MB
in the original baseline. First camera completion also took longer than Phase
1's 4,833 ms median; Worker parity does not improve every metric.

In one fresh full-sequence run, paused buffering completed in **43.4 seconds
after the first point frame**, versus 69.4 seconds in Phase 1. All eight point
batches and eight camera batches finished without failure. All 80 point frames
(237,805,692 bytes) and 80 camera frames (103,703,680 bytes) were retained. Worker
decoded allocations totaled 94,863,148 bytes at completion; the sum of their
reported peaks was 100,457,576 bytes. Graph startup plus playback consumed
874,531,304 logical source bytes.

Actual browser Workers produced identical normalized outputs for **80/80
frames** against direct graph execution, including typed-array bytes, camera
bytes, poses, boxes, labels, and metadata. The unchanged recipe hash is recorded
below. Rapid seeks 50, 10, 60 ended on frame 60 with its six camera payloads.

After reset, Worker counts, queued/in-flight batch jobs, normalized caches,
decoded allocations, object URLs, and renderer resource counters returned to
zero. All five timing trials also terminated every Worker and released their
normalized caches on reset.

**Remaining presentation limit:** with the entire sequence cached, ordinary
playback still took 15.73 seconds to advance through 79 frames. Median store
advance spacing was 198.6 ms and maximum spacing was 230.7 ms. All 78 measured
gaps exceeded 150 ms despite the recipe's nominal 100 ms cadence. Network
buffering is no longer the cause in that case. The remaining conversion/render
cost requires separate profiling; Worker scheduling parity does not establish
10 Hz presentation or a main-thread responsiveness guarantee.

Validation: the non-GPU run passed 1,176 tests, with three GPU checks skipped.
Those three checks passed separately with Vitest's fork pool. The default
thread-pool run encountered an existing native Dawn/Node shutdown crash;
the isolated GPU run avoided it. Production build passed, and ESLint reported
zero errors and 64 existing warnings. The Worker, queue, foreground interruption,
buffer ownership, remote digest, and cache tests are included in those results.

## Phase 1 behavior and retained baseline

Independent frame reads and metadata files use one shared six-read scheduler.
The recipe runtime runs at most two frame jobs, with a maximum of four
outstanding jobs per point/camera lane. Completion replenishes the queue until
the sequence ends or retained payloads fill the byte budget. The current frame
has priority; seeking cancels obsolete jobs and resumes from the new target.

Point data can become visible before its cameras finish. Camera completion
updates only the matching displayed frame. Resident frames reuse normalized
payloads and renderer projections. Buffer bars reflect resident frames.

These limits differ from the built-in paths: those use three point Workers
and two camera Workers and queue all remaining batches. Argoverse 2 and
nuScenes batches contain ten frames. Worker batch concurrency is not the same
unit as the recipe runtime's per-file read concurrency.

Normalized payload budgets are 512 MiB for point frames and 256 MiB for camera
frames. Lazy decoded graph payloads use a 128 MiB LRU; the remote source keeps
its existing 64 MiB raw-object cache. Background reads may reclaim history
behind the playhead, but do not evict the current or buffered future frames
to load farther ahead. These are retained payload budgets, not total browser
heap or GPU memory limits.

## Phase 1 timing comparison

Baseline: commit `dd94298`. Both variants used the same machine, Codex in-app
browser, live React/Canvas application, unchanged sealed recipe, and full
80-frame remote sample. One warm-up and five measured trials per variant.
Each trial reconnects with a fresh source inventory and runtime. Trials were
run sequentially, so CDN/network conditions are not controlled or randomized.

| Store-ready measurement | Baseline p50 / p95 | Phase 1 p50 / p95 |
| --- | --- | --- |
| First point frame, including graph startup | 16,301 / 22,053 ms | 4,366 / 5,246 ms |
| First six camera payloads, from the same start | 16,301 / 22,054 ms | 4,833 / 5,733 ms |
| Cold seek to frame 40 | 1,884 / 2,443 ms | 1,271 / 1,511 ms |
| Sequential advances through frames 41–45 | 1,866 / 2,120 ms | 761 / 1,274 ms |
| Immediate repeat of frame 40 | 158 / 164 ms | 0.6 / 0.7 ms |

The sequential measurements benefit from prefetch and are not independent
cold seeks. Camera completion means encoded images are available to the
store; it does not measure decoded texture upload or first GPU presentation.
The first-frame clock starts after source recognition, immediately before
`loadAuthoredScene`. p95 uses nearest rank; with five startup trials it is
the slowest observed trial, not a stable tail estimate.

The baseline measured 151 responses and 78,797,211 decoded response-body bytes
per trial. Phase 1 measured 151–153 responses and 78,797,211–83,801,550 bytes.
Extra bytes can be work already in flight when the test seeks or resets.
Failed requests that never produce response headers are not counted by the
response-body instrumentation. These are decoded body bytes, not wire bytes.

## Phase 1 output and lifecycle verification

- The unchanged artifact is `sha256:5ccdc724d530966449676e11c2bf2b522e5394e980a1d50acc6db4b93c16e4a7`.
- The source catalog is `sha256:1739c7780cdac2c667c5cfab80aee1784595f2a6edd742eb23b720338c4d40df`.
- All 80 normalized frame digests matched the baseline using the original
  staged sample bytes. Digests include typed-array data, encoded cameras,
  labels, boxes, poses, and normalized metadata.
- Full-sequence graph reads totaled 874,531,304 bytes. Decoded graph allocation
  peaked at 134,214,424 bytes, below 128 MiB, and returned to zero on disposal.
- All five measured browser trials released their normalized point/camera
  caches to zero on reset. An immediate disposal snapshot can still report
  aborting reads until their promises settle.
- Rapid seeks 50, 10, 60 retained frame 60 with all six camera payloads after
  allowing late completions to settle.

The full remote sample buffered while paused in 69.4 seconds after the first
point frame became ready. It retained all 80 point frames (237,805,692 bytes)
and all 80 camera frames (103,703,680 bytes). At completion there were zero
active or queued frame jobs and source reads. This is one full-sequence run,
not a five-run completion-time distribution.

Ordinary playback then advanced through all 79 remaining frames without a
network cache miss. However, it took 15.97 seconds, with store frame advances
spaced at a median 201.5 ms and maximum 234.2 ms. The recipe declares 10 Hz,
so buffered playback still missed the nominal 100 ms cadence. All 78 measured
inter-frame gaps exceeded 150 ms. First-time presentation work remains a
profiling target; an immediate repeated warm seek is not representative of
presenting every different frame. This measurement does not isolate CPU
conversion, React rendering, or GPU presentation costs.

After the full run reset, normalized caches, decoded graph allocation, active
jobs/reads, object URLs, and renderer resource counters returned to zero. The
raw-source value in `lastDisposedScene` is a snapshot taken before the harness
revokes the inventory; it is not a post-revocation heap measurement.

Checks: 105 test files / 1,174 tests passed. Focused scheduling and managed
runtime checks passed after the final capability-selection adjustment.
Production build passed. ESLint reported zero errors and 64 existing warnings.

## Reproduce

1. Run `npm run dev` with the existing sealed sample adapter saved in the
   browser's profile.
2. Open `/scripts/recipe-playback-benchmark.html?perf=1&benchmarkHold=1` on the
   development server in a separate tab. This page is not a production build
   entry. It renders the actual application and provides visible benchmark
   controls; no browser debugging protocol is required.
3. Run **Run six browser trials**, then **Download report** before editing
   application source, because Vite reloads can clear the in-memory report.
4. Run **Verify background buffering** to exercise rapid seeks, a fresh paused
   full-sequence load, ordinary playback after buffering, and reset. Download
   the updated report. This step reads the full remote sample.
5. Run **Verify worker output parity** to compare all 80 actual Worker frames
   against the direct graph using the same original source bytes.
6. Compare reports using only trials where `warmup` is false. Inspect errors,
   request bytes, cache bytes, and disposal alongside latency.

The development harness saves progress under the isolated local-storage key
`egolens:recipe-worker-benchmark:2026-09-11`. Restoring a checkpoint does not
revalidate code edits; rerun the relevant checks after changing implementation.

Raw local evidence is retained in
`/Users/heejaekim/Workspace/egolens-hosted-samples/performance-20260911/`:
`baseline.json`, `phase1-after.json`, `graph-parity.json`, and `parity.json`
retain Phase 1 evidence. `phase2-worker-parity.json` and `phase2-after.json`
contain the actual Worker parity, five-trial timing, full buffering, playback,
and disposal results.

This verifies the implementation locally. It does not establish uninterrupted streaming
at nominal frame rate on arbitrary connections, measure main-thread long
tasks, or replace the formal cross-dataset promotion gate in spec 012. No
hosting, compression, source integrity, saved recipe, or deployment changes
are included.
