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

For each shipped dataset, first create a protected source-case manifest and a
catalog from the same unchanged official source subtree:

```bash
npm run phase10:source-case -- \
  --root "$PROTECTED_SOURCE_ROOT" \
  --dataset-id "$DATASET" --release-id "$RELEASE" \
  --official-source-url "$OFFICIAL_URL" \
  --case-id "$CASE_ID" --role D --order 0 \
  --original-form complete-official-subtree \
  --capability pointClouds --capability timeline \
  --output "$PROTECTED/source-case.json" \
  --public-output "$PUBLIC/source-summary.json"

npm run phase10:source-catalog -- \
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
npm run phase10:prepare-preflight -- \
  --source-case "$PROTECTED/source-case.json" \
  --catalog "$PROTECTED/catalog.json" \
  --recipe "src/adapters/recipes/$RECIPE_FILE" \
  --requirements benchmarks/phase10/preflight-requirements.json \
  --dataset-id "$DATASET" --scene "$SCENE" \
  --host-origin "http://127.0.0.1:$SOURCE_PORT/" \
  --app-url http://127.0.0.1:4173/ \
  --output-dir "$PROTECTED/prepared"

npm run phase10:range-host -- \
  --root "$PROTECTED_SOURCE_ROOT" \
  --catalog "$PROTECTED/catalog.json" \
  --recipe "src/adapters/recipes/$RECIPE_FILE" \
  --descriptor "$PROTECTED/prepared/descriptor.json" \
  --port "$SOURCE_PORT"
```

Build and preview the exact clean commit. For each of `local`, `remote`, and
`share`, retain three independent benchmark artifacts:

- capture: `--warmups 0 --runs 1 --seeks 0 --scene-switches 0
  --playback-loops 0`, plus the checked-in dataset conformance config and
  `--conformance-output`;
- performance: `--warmups 1 --runs 5 --seeks 100 --scene-switches 0
  --playback-loops 2 --trace on`;
- lifecycle: `--warmups 0 --runs 1 --seeks 0 --scene-switches 20
  --playback-loops 0 --trace on`.

All three invocations must pass `--scene`, `--presentation`, and the matching
`--expected-preflight-identity`. Local mode additionally passes
`--local-source` and `--expected-source-manifest-hash`; remote and share use the
exact URLs emitted in protected `runtime.json`. A representative capture is:

```bash
npm run benchmark:phase6 -- \
  --dataset "$DATASET" --url "$COUNTED_URL" --scene "$SCENE" \
  --presentation "$PROTECTED/prepared/presentation.json" \
  --expected-preflight-identity "$PROTECTED/prepared/$MODE-identity.json" \
  --conformance-config "benchmarks/phase10/conformance/$DATASET.json" \
  --conformance-output "$PROTECTED/$MODE/conformance.json" \
  --perceptual-output-dir "$PROTECTED/$MODE/perceptual" \
  --output "$PROTECTED/$MODE/capture.json" \
  --warmups 0 --runs 1 --seeks 0 --scene-switches 0 --playback-loops 0
```

Add the local-only flags described above when `$MODE` is `local`. The recorder
rejects dirty or different commits, reused browser processes/profiles, identity
or presentation drift, fewer than five measured performance runs, incomplete
traces, a lifecycle soak shorter than 20 real dispose/reload generations,
retained scene resources, unpaused capture, or an invalid conformance artifact:

```bash
npm run phase10:record-mode -- \
  --mode "$MODE" --identity "$PROTECTED/prepared/$MODE-identity.json" \
  --capture "$PROTECTED/$MODE/capture.json" \
  --conformance "$PROTECTED/$MODE/conformance.json" \
  --performance "$PROTECTED/$MODE/performance.json" \
  --lifecycle "$PROTECTED/$MODE/lifecycle.json" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/$MODE-observation.json"
```

Assemble local/remote/share observations independently for all three datasets.
The assembler requires equal source, recipe, format, operator, capability,
structural, numeric, perceptual, and presentation hashes:

```bash
npm run phase10:assemble-preflight -- \
  --source-case "$PROTECTED/source-case.json" \
  --local "$PUBLIC/local-observation.json" \
  --remote "$PUBLIC/remote-observation.json" \
  --share "$PUBLIC/share-observation.json" \
  --requirements benchmarks/phase10/preflight-requirements.json \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/dataset-baseline.json"
```

## Repository and trust-boundary gates

Retain machine-readable output for the full regression suite, the exact 13-case
negative suite, evidence-harness TAP run, both builds, Phase 9 Adapter Amnesia,
and Phase 6 oracle receipts. The local gates are generated as follows:

```bash
npx vitest run --reporter=json --outputFile="$PROTECTED/regression-vitest.json"
npx vitest run src/teachable/__tests__/phase10NegativeGate.test.ts \
  --reporter=json --outputFile="$PROTECTED/negative-vitest.json"
node --test --test-reporter=tap scripts/phase10-evidence.node.mjs \
  > "$PROTECTED/phase10-harness.tap"

npm run build
npm run build:amnesia-author
npm run phase10:build-boundary -- \
  --production dist --author dist-amnesia-author \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/build-boundary.json"
npm run phase10:regression-gate -- \
  --vitest-report "$PROTECTED/regression-vitest.json" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/regression.json"
npm run phase10:negative-gate -- \
  --vitest-report "$PROTECTED/negative-vitest.json" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/negative.json"
npm run phase10:harness-gate -- \
  --tap-report "$PROTECTED/phase10-harness.tap" \
  --expected-commit "$CANDIDATE_COMMIT" \
  --output "$PUBLIC/harness.json"
```

After the protected judges return exact-commit, three-dataset Phase 6 and Phase
9 gate reports, combine all public-safe reports with
`phase10:freeze-baseline`. Validate the result with
`phase10:baseline-gate --require-clean-head`. The freeze records all held-out
state as false and must exist before any content-blind held-out case/reserve
manifest is generated.

## Held-out ladder

After P7 is merged, the coordinator uses `phase10:source-case` and
`phase10:freeze-cases` to precommit ordered D, A, B, and reserve identities
without exposing source paths or payload semantics. Each counted run uses a
fresh process and the closed attempt schema. Append first-failure,
classification, human-review, generic-change, consumed-case, replacement, and
regression decisions with `phase10:ledger`; it validates and hash-chains every
entry before appending it.
