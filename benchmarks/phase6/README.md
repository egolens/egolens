# Phase 6 CDP benchmark

This directory defines the reproducible browser gate for Spec 012. Raw result
JSON is intentionally kept out of git because each file contains a bounded CDP
trace and request URLs. Store approved baseline/candidate artifacts in the
release evidence system with their checksums; do not publish private dataset
URLs.

Run the production build on the same machine and Chrome build for both commits:

```bash
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
npm run benchmark:phase6 -- \
  --dataset nuscenes \
  --url 'http://127.0.0.1:4173/?dataset=nuscenes&data=https%3A%2F%2Fdata.egolens.org%2Fnuscenes%2F&scene=scene-0103' \
  --switch-scenarios /absolute/path/to/scenarios.json \
  --output traces/phase6-nuscenes.json \
  --warmups 1 --runs 5 --seeks 100 --scene-switches 20 --playback-loops 2 --fps 2
```

For the normative cross-dataset lifecycle soak, provide a local JSON file with
licensed, pinned sources (do not commit this file):

```json
[
  { "dataset": "nuscenes", "data": "https://host/nuscenes/", "scene": "scene-0103" },
  { "dataset": "argoverse2", "data": "https://host/av2/log/", "scene": "log-id" },
  { "dataset": "waymo", "data": "https://host/waymo/", "scene": "segment-id" }
]
```

Pass it as `--switch-scenarios /absolute/path/to/scenarios.json`. The runner
then alternates those sources through the ordinary application load command in
one page/runtime. Without this option, each switch performs a real
dispose/reload generation of the initial source; that is suitable for the
same-transport Phase 10 soak but is not sufficient for the Spec 012
cross-dataset gate.

Use an explicitly licensed URL for Waymo and a pinned log URL for Argoverse 2.
The runner:

- attaches CDP to the page and every worker target;
- records individual `Runtime.getHeapUsage` fields and target identities;
- records DOM counters, performance metrics, Network/Range events, cache flags,
  encoded bytes, a bounded filtered trace, and worker creation/destruction;
- samples the read-only `__EGOLENS_PERF__.snapshot()` at coordinated lifecycle
  checkpoints;
- performs two playback loops, 100 non-sequential timeline seeks, repeated
  camera/colormap/world/annotation/model toggles, 20 scene switches (including
  cross-dataset switches when configured), explicit disposal, and a natural
  settle window;
- records a forced-GC snapshot only after that authoritative natural snapshot,
  as a diagnostic for distinguishing collectible detached trees from retained
  references; the comparator requires live document shape and app-owned
  resources to be clean in the natural sample, then uses the forced snapshot
  only to prove that total CDP DOM/listener counters contain no reachable
  detached tree;
- keeps the warm-up separate from the five measured runs.

The runner retains only DrawFrame events, long RunTask events, and User Timing
events from the CDP stream, with a default cap of 100,000 relevant events per
run. `traceCollection.truncated` is recorded and the comparator rejects a
truncated baseline or candidate. Raise the common cap with
`--trace-event-limit` if a normative workload reaches it; never compare runs
captured with missing relevant trace events.

For one-run leak diagnosis, `--heap-snapshot /absolute/path/to/file.heapsnapshot`
captures the page heap after the forced-GC diagnostic point. Heap snapshots can
contain source URLs and application data, are not normative gate inputs, and
must remain outside version control.

The same runner can capture one candidate conformance artifact plus its PNG
references for Spec 013. The config contains reviewed case identity, source
fingerprint, capabilities, frames, presentation settings, and stable capture
selectors, so it must remain outside Git with the licensed evidence:

```bash
npm run benchmark:phase6 -- \
  --dataset nuscenes \
  --url 'http://127.0.0.1:4173/?dataset=nuscenes&data=http%3A%2F%2F127.0.0.1%3A4173%2F&scene=scene-0103' \
  --conformance-config /protected/nuscenes-conformance-config.json \
  --conformance-output /transfer/nuscenes.candidate.json \
  --perceptual-output-dir /transfer/nuscenes-png \
  --output /transfer/nuscenes-capture-run.json \
  --warmups 0 --runs 1 --seeks 0 --scene-switches 0 --playback-loops 0
```

Conformance mode automatically enables the explicit `oracleCapture=1` command
surface, requires a production build with an exact injected Git commit, creates
a fresh scene for structural/numeric capture, and disposes it in `finally`.
Output files use exclusive creation so a rerun cannot silently replace reviewed
evidence.

`usedSize` may be summed across page/worker targets only under the formula
written into each result. It is not total browser, process, or GPU memory.
Exact GPU bytes are not reported; renderer resource counts are the portable
gate. Run baseline and candidate from clean worktrees, compare distributions,
and apply every budget in Spec 012 before advancing the spec status.

The benchmark instrumentation (probe, `benchmarkHold`, and runner) must be
identical on baseline and candidate revisions. If the baseline predates it,
apply the instrumentation-only commit to a temporary baseline worktree; do not
compare an uninstrumented build with an instrumented one.

Apply the normative budgets mechanically after capturing both artifacts:

```bash
npm run benchmark:phase6:compare -- \
  --baseline traces/phase6-nuscenes-baseline.json \
  --candidate traces/phase6-nuscenes-candidate.json \
  --output traces/phase6-nuscenes-gate.json
```

Repeat capture and comparison independently for Waymo, nuScenes, and AV2. A
non-zero comparison exit blocks removal/status advancement for that dataset.
The comparator also rejects dirty builds, mismatched browser/hardware/scenarios,
fewer than one warm-up plus five measured runs, or a workload missing the
100-seek/20-cross-dataset-switch/two-playback-loop minimum.
