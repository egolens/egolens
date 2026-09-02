# Phase 10 evidence protocol

This directory contains the public, fail-closed evidence contract for Spec 014.
Licensed source bytes, source catalogs with paths, browser traces, screenshots,
credentials, absolute paths, and referenced share descriptors stay in protected
storage. Only the schemas, reviewed requirements, capture configurations, and
hash-only gate/freeze reports are public-safe.

## P7 baseline freeze

Do not mount, enumerate, parse, or semantically inspect A2D2, KITTI Raw, ONCE,
PandaSet, or any reserve while running P7. The exact candidate checkout must be
clean before the retained browser runs start. Every benchmark run creates a new
Chrome process and empty temporary profile and records observed process exit and
profile removal.

P7 evidence is generated only after this tooling change is merged. Check out that
reviewed merge commit separately as `PHASE10_TOOL`, keep it clean/read-only, and
run its scripts against a distinct exact `CANDIDATE_REPOSITORY`. Code in the
candidate checkout is not its own trust anchor. The verifier pins the reviewed
Phase 9 requirements hash, Phase 10 requirements hash, production public-key
byte hash, producer commit, and key id; the freeze records those anchors plus the
actual clean verifier-tool commit. The required execution relationship is
`external-reviewed-tool-checkout-required`.

This is deliberately a two-PR procedure. Merge PR A containing the reviewed
verifier tooling first. From a separate clean checkout of that merged commit,
an operator reviews the closure and creates its trust manifest; the generator
records that approval, but running the generator is not itself approval. Store
the manifest outside the checkout in an existing canonical owner-only (`0700`)
directory, and pin its hash independently in the protected operator
environment:

```bash
PHASE10_TOOL=/absolute/path/to/clean-reviewed-verifier
VERIFIER_COMMIT="$(git -C "$PHASE10_TOOL" rev-parse HEAD)"
TRUST_DIR=/absolute/path/to/operator-owned-phase10-trust

node "$PHASE10_TOOL/scripts/phase10-create-verifier-trust-manifest.mjs" \
  --review-id phase10-p7-review-YYYYMMDD \
  --approved-at 2026-09-01T00:00:00.000Z \
  --expected-commit "$VERIFIER_COMMIT" \
  --output "$TRUST_DIR/verifier-trust.json"

export PHASE10_VERIFIER_TRUST_MANIFEST="$TRUST_DIR/verifier-trust.json"
export PHASE10_EXPECTED_VERIFIER_TRUST_MANIFEST_HASH=<separately-pinned-manifestHash>
```

The manifest is created mode `0600`. A missing, moved, symlinked, non-owner-only,
dirty, closure-mismatched, or hash-mismatched verifier fails closed. Only then
perform PR B evidence work against a disjoint exact candidate checkout. Every
producer and gate below is invoked directly from `PHASE10_TOOL`; a candidate
`npm` script is never a verifier trust anchor.

For each shipped dataset, first create a protected source-case manifest and a
catalog from the same unchanged official source subtree:

```bash
node "$PHASE10_TOOL/scripts/phase10-source-case-manifest.mjs" \
  --root "$PROTECTED_SOURCE_ROOT" \
  --dataset-id "$DATASET" --release-id "$RELEASE" \
  --official-source-url "$OFFICIAL_URL" \
  --case-id "$CASE_ID" --role D --order 0 \
  --original-form complete-official-subtree \
  --capability pointClouds --capability timeline \
  --output "$PROTECTED/source-case.json" \
  --public-output "$PUBLIC/source-summary.json"

node "$PHASE10_TOOL/scripts/phase10-source-catalog.mjs" \
  --root "$PROTECTED_SOURCE_ROOT" \
  --source-case "$PROTECTED/source-case.json" \
  --output "$PROTECTED/catalog.json" \
  --public-output "$PUBLIC/catalog-summary.json"
```

Pass every capability listed for the dataset in
`preflight-requirements.json`; the abbreviated pair above is not a complete
Waymo, nuScenes, or Argoverse 2 invocation. The source-case and catalog commands
use exclusive creation and reject symlinks, path traversal, non-regular files,
size/digest drift, or more than 50,000 entries.

Prepare the closed identities and local/remote/share URLs, then serve the
cataloged bytes from a dedicated loopback origin:

```bash
node "$PHASE10_TOOL/scripts/phase10-prepare-preflight.mjs" \
  --source-case "$PROTECTED/source-case.json" \
  --catalog "$PROTECTED/catalog.json" \
  --recipe "$PHASE9_AUTHOR_OUTPUT/$RECIPE_FILE" \
  --phase9-attestation "$PUBLIC/amnesia-attestation.json" \
  --phase9-gate "$PUBLIC/amnesia-gate.json" \
  --phase9-receipt "$PUBLIC/phase9-waymo-receipt.json" \
  --phase9-receipt "$PUBLIC/phase9-nuscenes-receipt.json" \
  --phase9-receipt "$PUBLIC/phase9-argoverse2-receipt.json" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --dataset-id "$DATASET" --scene "$SCENE" \
  --host-origin "http://127.0.0.1:$SOURCE_PORT/" \
  --app-url http://127.0.0.1:4173/ \
  --output-dir "$PROTECTED/prepared"

node "$PHASE10_TOOL/scripts/phase10-range-host.mjs" \
  --root "$PROTECTED_SOURCE_ROOT" \
  --catalog "$PROTECTED/catalog.json" \
  --recipe "$PHASE9_AUTHOR_OUTPUT/$RECIPE_FILE" \
  --descriptor "$PROTECTED/prepared/descriptor.json" \
  --port "$SOURCE_PORT"
```

Create the only accepted build provenance from a sanitized detached worktree.
This command never runs `npm` or candidate package scripts. It requires the
candidate package manifests, TypeScript configs, and Vite config to be byte-for-byte
equal to the reviewed verifier checkout, then rebuilds both bundles with the
operator-approved Node executable and exact resolved verifier `node_modules`
closure. The build runs from `.git`-free staged sources without inherited `VITE_*`
inputs, copies the verified outputs into the candidate repository, and records the
approved runtime/config closure, source-tree, and canonical inventories:

```bash
node "$PHASE10_TOOL/scripts/phase10-build-boundary.mjs" \
  --candidate-repository "$CANDIDATE_REPOSITORY" \
  --production "$CANDIDATE_REPOSITORY/dist" \
  --author "$CANDIDATE_REPOSITORY/dist-amnesia-author" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/build-boundary.json"
```

For each of `local`, `remote`, and `share`, retain three independent benchmark
artifacts. The trusted benchmark script snapshots the copied `dist` bytes,
checks their inventory against `build-boundary.json`, and serves only that
immutable snapshot from its own ephemeral `127.0.0.1` origin. It also re-hashes
the on-disk build before and after every browser process and at finalization;
do not run a candidate `npm` benchmark wrapper or a separate preview server:

- capture: `--warmups 0 --runs 1 --seeks 0 --scene-switches 0
  --playback-loops 0`, plus the checked-in dataset conformance config and
  `--conformance-output`;
- performance: `--warmups 1 --runs 5 --seeks 100 --scene-switches 0
  --playback-loops 2 --trace on`;
- lifecycle: `--warmups 0 --runs 1 --seeks 0 --scene-switches 20
  --playback-loops 0 --trace on`.

All three invocations must pass `--scene`, `--presentation`, the matching
`--expected-preflight-identity`, the exact candidate commit/source-tree hash,
and the reproduced production build root/inventory hash. Local mode additionally
passes `--local-source`, `--expected-source-manifest-hash`, and the exact Phase 9
`--preflight-recipe`; remote and share use the exact URLs emitted in protected
`runtime.json`. A representative capture is:

```bash
node "$PHASE10_TOOL/scripts/phase6-cdp-benchmark.mjs" \
  --dataset "$DATASET" --url "$COUNTED_URL" --scene "$SCENE" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --expected-source-tree-hash "$(jq -r '.sourceTreeHash' "$PUBLIC/build-boundary.json")" \
  --app-build-root "$CANDIDATE_REPOSITORY/dist" \
  --expected-app-build-inventory-hash "$(jq -r '.production.inventoryHash' "$PUBLIC/build-boundary.json")" \
  --presentation "$PROTECTED/prepared/presentation.json" \
  --expected-preflight-identity "$PROTECTED/prepared/$MODE-identity.json" \
  --conformance-config "$PROTECTED/prepared/conformance-config.json" \
  --conformance-output "$PROTECTED/$MODE/conformance.json" \
  --perceptual-output-dir "$PROTECTED/$MODE/perceptual" \
  --output "$PROTECTED/$MODE/capture.json" \
  --warmups 0 --runs 1 --seeks 0 --scene-switches 0 --playback-loops 0
```

For local mode add `--local-source "$PROTECTED_SOURCE_ROOT"
--expected-source-manifest-hash "$SOURCE_MANIFEST_HASH" --preflight-recipe
"$PHASE9_AUTHOR_OUTPUT/$RECIPE_FILE"` to every capture, performance, and
lifecycle invocation. The compiled author recipe owns the managed normalized
scene, worker-reader parameters, isolated conformance factory, and every
dispose/reload generation; the bundled shipped recipe is not a local preflight
fallback. The recorder rejects a dirty/unreviewed verifier checkout, different
candidate identity, served-build drift, reused browser processes/profiles,
identity or presentation drift, fewer than five measured performance runs,
incomplete traces, a lifecycle soak shorter than 20 real dispose/reload
generations, retained scene resources, unpaused capture, or an invalid
conformance artifact:

```bash
node "$PHASE10_TOOL/scripts/phase10-record-preflight-mode.mjs" \
  --mode "$MODE" --identity "$PROTECTED/prepared/$MODE-identity.json" \
  --capture "$PROTECTED/$MODE/capture.json" \
  --conformance "$PROTECTED/$MODE/conformance.json" \
  --performance "$PROTECTED/$MODE/performance.json" \
  --lifecycle "$PROTECTED/$MODE/lifecycle.json" \
  --build-boundary "$PUBLIC/build-boundary.json" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/$MODE-observation.json"
```

Each capture retains the immutable Phase 6 `egolens-perceptual-raster-v1`
signature for hidden-oracle compatibility and separately records
`egolens-perceptual-raster-v2` for transport parity. V2 averages a wider raster
cell before quantization so sparse ±1 compositor rounding cannot masquerade as
a File-vs-HTTP visual difference. Viewport parity is captured a second time at
the reviewed 1440×600 geometry, while the unmodified responsive screenshot is
retained for the Phase 6 oracle. The recorder rejects any other algorithm,
geometry, or reference-ID set. Checked-in conformance templates contain no
source fingerprint. `phase10:prepare-preflight` validates the reviewed template,
derives the fingerprint from the protected source manifest, and writes the
protected `0600` `conformance-config.json` used above.

Assemble local/remote/share observations independently for all three datasets.
The assembler requires equal source, recipe, format, operator, capability,
structural, numeric, perceptual, and presentation hashes:

```bash
node "$PHASE10_TOOL/scripts/phase10-assemble-preflight.mjs" \
  --source-case "$PROTECTED/source-case.json" \
  --local "$PUBLIC/local-observation.json" \
  --remote "$PUBLIC/remote-observation.json" \
  --share "$PUBLIC/share-observation.json" \
  --phase9-attestation "$PUBLIC/amnesia-attestation.json" \
  --phase9-gate "$PUBLIC/amnesia-gate.json" \
  --phase9-receipt "$PUBLIC/phase9-waymo-receipt.json" \
  --phase9-receipt "$PUBLIC/phase9-nuscenes-receipt.json" \
  --phase9-receipt "$PUBLIC/phase9-argoverse2-receipt.json" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/dataset-baseline.json"
```

## Repository and trust-boundary gates

The regression, negative, and evidence-harness gates are executed by the
reviewed verifier itself; they never accept a caller-supplied Vitest JSON or
TAP report. Each gate stages the exact clean candidate commit from a fresh
`git archive`, verifies that the candidate test bytes equal the verifier's
reviewed test bytes, runs the suite under the deny-default
`scripts/phase10-reviewed-test.sb` (or `phase10-reviewed-harness.sb`) Seatbelt
profile with only the verifier's dependency closure and pinned esbuild binary,
proves the boundary with live negative probes, and rejects any residual
detached process. Run them from outside both checkouts:

```bash
node "$PHASE10_TOOL/scripts/phase10-regression-gate.mjs" \
  --candidate-repository "$CANDIDATE_REPOSITORY" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/regression.json"
node "$PHASE10_TOOL/scripts/phase10-negative-gate.mjs" \
  --candidate-repository "$CANDIDATE_REPOSITORY" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/negative.json"
node "$PHASE10_TOOL/scripts/phase10-harness-gate.mjs" \
  --candidate-repository "$CANDIDATE_REPOSITORY" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/harness.json"
```

Passing `--vitest-report`, `--tap-report`, or `--minimum-tests` is an error.

After the protected judges return exact-commit, three-dataset Phase 6 and Phase
9 reports, freeze and verify with the exact commands below. The Phase 9
receipts and gate carry the signed `judgeToolCommit`; the Phase 10 binding
requires it to equal this verifier's trust-manifest `verifierToolCommit`, so
`PHASE9_AMNESIA_JUDGE_TOOL_COMMIT` and the verifier checkout must pin the same
reviewed commit.

```bash
node "$PHASE10_TOOL/scripts/phase10-freeze-baseline.mjs" \
  --dataset "$PUBLIC/waymo-baseline.json" \
  --dataset "$PUBLIC/nuscenes-baseline.json" \
  --dataset "$PUBLIC/argoverse2-baseline.json" \
  --build-boundary "$PUBLIC/build-boundary.json" \
  --negative "$PUBLIC/negative.json" \
  --regression "$PUBLIC/regression.json" \
  --harness "$PUBLIC/harness.json" \
  --phase9-attestation "$PUBLIC/amnesia-attestation.json" \
  --phase9-gate "$PUBLIC/amnesia-gate.json" \
  --phase9-receipt "$PUBLIC/phase9-waymo-receipt.json" \
  --phase9-receipt "$PUBLIC/phase9-nuscenes-receipt.json" \
  --phase9-receipt "$PUBLIC/phase9-argoverse2-receipt.json" \
  --phase6-gate "$PUBLIC/phase6-oracle-gate.json" \
  --phase6-receipt "$PUBLIC/phase6-waymo-receipt.json" \
  --phase6-receipt "$PUBLIC/phase6-nuscenes-receipt.json" \
  --phase6-receipt "$PUBLIC/phase6-argoverse2-receipt.json" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --frozen-at "$FROZEN_AT" \
  --output "$PUBLIC/phase10-baseline-freeze.json"

node "$PHASE10_TOOL/scripts/phase10-baseline-gate.mjs" \
  --freeze "$PUBLIC/phase10-baseline-freeze.json" \
  --negative "$PUBLIC/negative.json" \
  --regression "$PUBLIC/regression.json" \
  --harness "$PUBLIC/harness.json" \
  --phase9-attestation "$PUBLIC/amnesia-attestation.json" \
  --phase9-gate "$PUBLIC/amnesia-gate.json" \
  --phase9-receipt "$PUBLIC/phase9-waymo-receipt.json" \
  --phase9-receipt "$PUBLIC/phase9-nuscenes-receipt.json" \
  --phase9-receipt "$PUBLIC/phase9-argoverse2-receipt.json" \
  --phase6-gate "$PUBLIC/phase6-oracle-gate.json" \
  --phase6-receipt "$PUBLIC/phase6-waymo-receipt.json" \
  --phase6-receipt "$PUBLIC/phase6-nuscenes-receipt.json" \
  --phase6-receipt "$PUBLIC/phase6-argoverse2-receipt.json" \
  --candidate-repository "$CANDIDATE_REPOSITORY" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/phase10-baseline-gate.json"
```

The final gate always rejects a dirty or different candidate HEAD; there is no
optional clean-head switch. It independently rebuilds both outputs in another
sanitized detached worktree and requires byte-inventory equality with the
freeze before emitting `cleanHeadVerified: true`, and it re-verifies the
regression, negative, and evidence-harness reports against the freeze's gate
entries rather than trusting the freeze's self-hash for them. The freeze binds the three
author-selected recipe hashes and signed receipt hashes, records all held-out
state as false, and must exist before any content-blind held-out case/reserve
manifest is generated.

## Held-out ladder

After P7 is merged, the coordinator uses `phase10:source-case` and
`phase10:freeze-cases` to precommit ordered D, A, B, and reserve identities
without exposing source paths or payload semantics. Each counted run uses a
fresh process and the closed attempt schema. Append first-failure,
classification, human-review, generic-change, consumed-case, replacement, and
regression decisions with `phase10:ledger`; it validates and hash-chains every
entry before appending it.
