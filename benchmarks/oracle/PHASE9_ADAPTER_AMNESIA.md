# Phase 9 Adapter Amnesia runbook

This runbook completes the self-hosting gate in
[`spec_006_teachable_lens.md`](../../docs/specs/spec_006_teachable_lens.md) and
the trust split in
[`spec_013_teachable_lens_hidden_oracle_retention.md`](../../docs/specs/spec_013_teachable_lens_hidden_oracle_retention.md).
Phase 6 oracle bundles remain immutable; Phase 9 never regenerates or exposes
them to the authoring workspace.

## Trust domains

The author controller receives no application, dataset, or candidate-output
mount. A separately launched trusted broker runs the dedicated
`dist-amnesia-author` browser build under macOS Seatbelt with exactly one
read-only source case, the read-only author build, and a write-only candidate
output. Only fixed loopback traffic connects the controller to that broker,
which exposes the five public Teachable Lens tools. The controller's exact
process may use its model control plane, while its child/tool processes have no
external network access. The author has no repository checkout, bundled recipe
mount, dataset-loader source, legacy runtime, oracle storage, judge CLI, or
private key. A fresh broker, browser profile, and scratch directory are created
and destroyed for every dataset. The author build fails if its module graph
gains the production app/store, any dataset adapter or bundled recipe,
conformance/oracle code, or judge code. The controller cannot invoke the judge
interactively.

The candidate capture workspace receives the authored recipe and the same
source case. `--adapter-amnesia --adapter-recipe` installs that external recipe
through the public schema/compiler/operator registry, creates an isolated
`NormalizedSceneV1`, and uses that scene for both artifact observations and the
frames presented to perceptual capture. The capture API fails closed when
Adapter Amnesia mode has no external recipe. Its runtime identity binds the
exact candidate commit and semantic recipe hash:

```text
egolens-amnesia-<40-character-commit>-sha256:<64 hex characters>
```

Only the protected judge workspace mounts the retained Phase 6 oracle bundles,
the private Ed25519 key, and the one-shot judge. Public output is limited to the
authoring attestation, signed receipts, and aggregate gate report. Detailed
reports are created inside the trusted workspace and destroyed with the oracle
inputs after the gate runs.

## 1. Run the trusted counted author coordinator

On the trusted macOS evidence host, check out the exact reviewed candidate SHA.
Repeat `run-case` once for each reviewed Waymo, nuScenes, and Argoverse 2
target, using its owner-only Phase 6 capture config, exactly one source-case
directory, and a separate empty output root per dataset. The examples below use
`$AUTHOR_OUT` for the parent of those per-dataset output roots and
`$EVIDENCE` for the owner-only protected evidence directory:

```bash
npm run amnesia:coordinate -- run-case \
  --candidate-commit <exact-pr-head-sha> \
  --dataset-id waymo \
  --case-id phase6-waymo-rich-001 \
  --dataset <one-source-case-directory> \
  --capture-config <protected-capture-config.json> \
  --output-root "$AUTHOR_OUT/waymo" \
  --evidence-dir "$EVIDENCE"
```

Each successful run prints its `runId` and writes exactly one recipe,
`$AUTHOR_OUT/<dataset>/<dataset>.egolens-adapter.json`, plus three protected
run-scoped artifacts under `$EVIDENCE`:

| Artifact | Path |
| --- | --- |
| Boundary-case artifact (staged and judged) | `$EVIDENCE/<dataset>.<runId>.boundary-case.json` |
| Negative-probe report (protected) | `$EVIDENCE/<dataset>.<runId>.negative-probe.json` |
| Source manifest (protected, never staged) | `$EVIDENCE/<dataset>.<runId>.source-manifest.json` |

Record each printed `runId`; every later command names the boundary-case
artifact by that exact `<dataset>.<runId>` prefix.

The dataset must be a canonical, symlink-free external case root. The
capture-config file, output root, and evidence root must additionally be owned
by the coordinator user and have owner-only permissions. All four must be
pairwise disjoint and disjoint from the repository, author build, runtime, and
controller roots. Do not point the coordinator at the repository's ignored
`waymo_data` (or an equivalent in-repository data directory); copy the original
case bytes without symlinks into a dedicated external directory first. The
coordinator writes `<dataset>.<runId>.source-manifest.json` as a mode-`0600`,
protected-local artifact. It must never appear in stdout, the PR, the workflow
archive, or the staged evidence archive. The boundary-case artifact carries only
its compact hash/count/byte commitment.

Then assemble exactly those three protected run-scoped case artifacts into the
full report, substituting the three recorded run IDs:

```bash
npm run amnesia:coordinate -- assemble-report \
  --candidate-commit <exact-pr-head-sha> \
  --case "$EVIDENCE/waymo.<waymo-runId>.boundary-case.json" \
  --case "$EVIDENCE/nuscenes.<nuscenes-runId>.boundary-case.json" \
  --case "$EVIDENCE/argoverse2.<argoverse2-runId>.boundary-case.json" \
  --output "$EVIDENCE/amnesia-boundary-report.json"
```

The trusted operator, the reviewed coordinator checkout, and the macOS Seatbelt
negative probes are the root of trust for this local run. The self-hashes are
tamper commitments, not remote-host attestation. Pin the exact reviewed tool SHA
as `PHASE9_AMNESIA_JUDGE_TOOL_COMMIT`; the pinned judge revalidates all three
protected case artifacts, their policy and tool commitments, the report's exact
case payloads, and the candidate/application/source/recipe bindings before it
signs anything. The judge also binds its own checkout: it refuses to run unless
its checkout is clean and its `HEAD` equals `--expected-judge-tool-commit`, it
accepts only `--judge-version spec013-phase9-v1`, and it signs both values into
every receipt as `judgeToolCommit` and `judgeVersion`. The gate, staging, and
Phase 10 binding reject receipts from any other commit or version. Do not stage
a hand-authored report or artifacts produced by an unreviewed coordinator
checkout.

## 2. Capture each authored recipe

Build the exact candidate commit, then repeat this command for Waymo, nuScenes,
and Argoverse 2 with the matching URL, config, recipe, and output directory:

```bash
npm run benchmark:phase6 -- \
  --url <reviewed-case-url> \
  --output <private-run-output.json> \
  --dataset <dataset> \
  --warmups 0 --runs 1 --seeks 0 --scene-switches 0 --playback-loops 0 \
  --trace off --timeout-ms 360000 \
  --conformance-config <protected-capture-config.json> \
  --conformance-output <transfer/<dataset>.candidate.json> \
  --perceptual-output-dir <protected/perceptual/<dataset>> \
  --adapter-amnesia \
  --adapter-recipe "$AUTHOR_OUT/<dataset>/<dataset>.egolens-adapter.json"
```

The candidate artifact must pass its own integrity check, match the reviewed
coverage in `phase9-requirements.json`, and carry the exact PR HEAD in both
`generatorCommit` and the Amnesia runtime identity.

## 3. Attest the author boundary

The trusted coordinator must first emit a machine-verified boundary report for
all three fresh author runs. It records each concrete Seatbelt policy hash,
negative-probe report hash, canonical mount paths, write/read denials, network
confinement, public tool catalog, and profile/scratch lifecycle. The full report,
canonical paths, source fingerprints, policy hashes, and negative-probe hashes
remain protected. The public attestation contains only the report commitment and
a path-free witness of non-sensitive enforced roles and outcomes. Create that
attestation for the exact candidate commit and the three blind-authored recipes:

```bash
npm run amnesia:attest -- \
  --candidate-commit <exact-pr-head-sha> \
  --boundary-report "$EVIDENCE/amnesia-boundary-report.json" \
  --waymo-recipe "$AUTHOR_OUT/waymo/waymo.egolens-adapter.json" \
  --nuscenes-recipe "$AUTHOR_OUT/nuscenes/nuscenes.egolens-adapter.json" \
  --argoverse2-recipe "$AUTHOR_OUT/argoverse2/argoverse2.egolens-adapter.json" \
  --output <transfer/amnesia-attestation.json>
```

The attestation is the only public output of this step. The full boundary
report stays in `$EVIDENCE`.

The staging and judge commands independently recompute the boundary-report and
attestation hashes, each blind-authored semantic recipe hash, the denied-resource
set, public tool set, mount/network policy, source-case binding, and exact
candidate commit. `phase9-requirements.json` reviews target and coverage only;
it intentionally contains no target recipe hash. The author-selected hash is
accepted only after the hidden structural, numeric, and perceptual judge passes
and signs a receipt for that same hash and runtime identity.

## 4. Stage protected evidence

Use the retained immutable Phase 6 bundles and the new exact-head candidates:

```bash
npm run amnesia:stage -- \
  --environment phase6-oracle-judge \
  --requirements benchmarks/oracle/phase9-requirements.json \
  --attestation <transfer/amnesia-attestation.json> \
  --boundary-report "$EVIDENCE/amnesia-boundary-report.json" \
  --waymo-boundary-case "$EVIDENCE/waymo.<waymo-runId>.boundary-case.json" \
  --nuscenes-boundary-case "$EVIDENCE/nuscenes.<nuscenes-runId>.boundary-case.json" \
  --argoverse2-boundary-case "$EVIDENCE/argoverse2.<argoverse2-runId>.boundary-case.json" \
  --expected-producer-commit a42f658e27fce118789d3648e2612f5d25b99488 \
  --expected-candidate-commit <exact-pr-head-sha> \
  --waymo-oracle <protected/waymo.oracle.json> \
  --waymo-candidate <transfer/waymo.candidate.json> \
  --nuscenes-oracle <protected/nuscenes.oracle.json> \
  --nuscenes-candidate <transfer/nuscenes.candidate.json> \
  --argoverse2-oracle <protected/argoverse2.oracle.json> \
  --argoverse2-candidate <transfer/argoverse2.candidate.json>
```

Pin `PHASE9_AMNESIA_JUDGE_TOOL_COMMIT` in the protected Environment to the
reviewed immutable commit containing the Phase 9 judge and gate. Add the
`phase9-amnesia-evidence` label to the Phase 9 PR. Environment approval then
checks out exactly that commit, runs the one-shot judge against all three
targets and their matching protected case artifacts with
`--expected-judge-tool-commit "$PHASE9_AMNESIA_JUDGE_TOOL_COMMIT"`, and runs the
gate with the same pin. Every receipt and the gate report therefore carry the
signed `judgeToolCommit` and `judgeVersion: spec013-phase9-v1`; the Phase 10
verifier later requires that `judgeToolCommit` to equal its own trust-manifest
`verifierToolCommit`. Receipts publish only each artifact's canonical
commitment; the workflow destroys the artifacts, full boundary report,
source/oracle inputs, and trusted reports before retaining public evidence. Any
new code push changes the expected commit and makes the old evidence fail
closed.

When rehearsing the judge and gate locally, run them from a clean, exact
checkout of the pinned commit (for example a fresh `git worktree` or clone),
never from a dirty development tree; both tools refuse a dirty or mismatched
checkout before reading any protected input.
