# Phase 9 Adapter Amnesia runbook

This runbook completes the self-hosting gate in
[`spec_006_teachable_lens.md`](../../docs/specs/spec_006_teachable_lens.md) and
the trust split in
[`spec_013_teachable_lens_hidden_oracle_retention.md`](../../docs/specs/spec_013_teachable_lens_hidden_oracle_retention.md).
Phase 6 oracle bundles remain immutable; Phase 9 never regenerates or exposes
them to the authoring workspace.

## Trust domains

The author receives the dedicated `dist-amnesia-author` browser build, one held-out source case, and a
write-only candidate output. The browser exposes only the five public
Teachable Lens tools. The author workspace has no repository checkout, bundled
recipe mount, dataset-loader source, legacy runtime, oracle storage, judge CLI,
private key, or network egress. Its build fails if the module graph gains the
production app/store, any dataset adapter or bundled recipe, conformance/oracle
code, or judge code. It cannot invoke the judge interactively.

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

## 1. Capture each authored recipe

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
  --conformance-output <transfer/candidate.json> \
  --perceptual-output-dir <protected/perceptual> \
  --adapter-amnesia \
  --adapter-recipe <author-output/recipe.egolens-adapter.json>
```

The candidate artifact must pass its own integrity check, match the reviewed
coverage in `phase9-requirements.json`, and carry the exact PR HEAD in both
`generatorCommit` and the Amnesia runtime identity.

## 2. Attest the author boundary

Create one public attestation for the exact candidate commit and the three
authored recipes:

```bash
npm run amnesia:attest -- \
  --candidate-commit <exact-pr-head-sha> \
  --waymo-recipe <author-output/waymo.egolens-adapter.json> \
  --nuscenes-recipe <author-output/nuscenes.egolens-adapter.json> \
  --argoverse2-recipe <author-output/argoverse2.egolens-adapter.json> \
  --output <transfer/amnesia-attestation.json>
```

The staging and judge commands independently recompute the attestation hash,
the semantic recipe hashes, the denied-resource set, public tool set, mount
policy, network policy, and exact candidate commit.

## 3. Stage protected evidence

Use the retained immutable Phase 6 bundles and the new exact-head candidates:

```bash
npm run amnesia:stage -- \
  --environment phase6-oracle-judge \
  --requirements benchmarks/oracle/phase9-requirements.json \
  --attestation <transfer/amnesia-attestation.json> \
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
runs the one-shot judge against all three targets. Any new code push changes
the expected commit and makes the old evidence fail closed.
