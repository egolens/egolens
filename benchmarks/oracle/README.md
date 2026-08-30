# Phase 6 hidden-oracle promotion runbook

This runbook implements the trust split in
[`spec_013_teachable_lens_hidden_oracle_retention.md`](../../docs/specs/spec_013_teachable_lens_hidden_oracle_retention.md).
The checked-in code defines and tests the artifact and receipt protocols. Real
dataset observations, private keys, and detailed judge reports never belong in
this repository.

## Roles and storage

Use three isolated workspaces:

| Workspace | Code/data mounted | Output |
|---|---|---|
| Producer | pinned legacy revision, capture instrumentation, protected dataset cases | hidden `OracleBundleV1` |
| Author | public recipe runtime and candidate dataset case; no held-out bundled recipe or oracle mount | `SceneConformanceArtifactV1` |
| Judge | hidden bundle, candidate artifact, judge CLI, private Ed25519 key | signed `OracleJudgeReceiptV1` |

The producer and judge should be one-shot CI jobs with egress and logs limited
to protected evidence storage. The author must not be able to invoke the judge
interactively. The root-level `oracle-bundles/`, `oracle-candidates/`, and
`oracle-receipts/` directories are ignored only to reduce accidental commits;
they are **not** a security boundary and must not be mounted into the author
workspace.

The initial reviewed cases are checked in at
`benchmarks/oracle/phase6-requirements.json`. They intentionally use public,
anonymized case IDs. The approved local inputs resolve to:

| Dataset | Frames | Reviewed frame indices | Why selected |
|---|---:|---|---|
| Waymo | 198 | 0, 29, 79, 129, 197 | all available point/camera/box/trajectory capabilities; the middle frames include LiDAR and camera segmentation evidence |
| nuScenes | 40 | 0, 19, 39 | `scene-0103`, including LiDAR, radar, cameras, boxes, trajectories, and segmentation |
| Argoverse 2 | 157 | 0, 78, 156 | the approved local annotated urban log, including seven cameras and first/middle/last coverage |

Raw segment/token/log IDs stay in the protected capture configuration and are
represented in artifacts only by a shared SHA-256 source fingerprint.

## 1. Pin and record the legacy producer

For the initial Phase 6 promotion, use pre-cutover commit
`a42f658e27fce118789d3648e2612f5d25b99488`. Do not advance this reference to
the Phase 6 candidate branch. Record that full SHA as `generatorCommit`, and
record an immutable build identifier as `legacyRuntimeId`.

Bring only the conformance capture instrumentation into the producer build.
Its `createScene` factory must adapt the independently executing legacy loader
to `NormalizedSceneV1`; it must not call the candidate recipe scene or share
the candidate's parse/decode implementation. Capture occurs through
`captureSceneConformanceArtifactV1`, outside Zustand, and the capture function
always disposes the scene. Promote the result with `createOracleBundleV1` and
write it directly to protected evidence storage.

For every case, explicitly provide all exposed capabilities, the required
frame indices, and perceptual references. Use a SHA-256 of an anonymized case
identity for `sourceFingerprint`; never include local paths, URLs, credentials,
or raw licensed data in provenance.

The production preview exposes `?oracleCapture=1` only as an explicit trusted
capture command surface. It constructs a fresh recipe scene from the active
source binding, records the exact build commit compiled by Vite, and disposes
that scene in a `finally` block. `scripts/phase6-cdp-benchmark.mjs` accepts
`--conformance-config`, `--conformance-output`, and
`--perceptual-output-dir` for a one-run capture. The config and PNGs contain
private case evidence and remain outside Git.

## 2. Capture the candidate

Run the held-out recipe through the same public `NormalizedSceneV1` contract
and `captureSceneConformanceArtifactV1`. The target dataset/case, required
capabilities, frame indices, sample count, and perceptual-reference IDs must
match the producer job exactly. Write only the candidate artifact to isolated
transfer storage.

Before transfer, `verifySceneConformanceArtifactV1` must return true. A
candidate artifact contains its own observations; it contains no hidden oracle
values.

The candidate provenance commit must equal the exact PR HEAD; both the judge
and final gate enforce this independently.

## 3. Judge once and sign

Generate the signing key in protected judge infrastructure. Commit or configure
only its public key; never copy the private key into a developer or author
workspace. For example, an operator can create an Ed25519 pair with OpenSSL:

```bash
openssl genpkey -algorithm ED25519 -out judge-private.pem
openssl pkey -in judge-private.pem -pubout -out judge-public.pem
```

In the judge workspace, run:

```bash
npm run oracle:judge -- \
  --oracle /protected/waymo-case.oracle.json \
  --candidate /transfer/waymo-case.candidate.json \
  --private-key /protected/judge-private.pem \
  --key-id phase6-2026-08 \
  --judge-version spec013-v1 \
  --expected-candidate-commit <exact-pr-head-sha> \
  --output /receipts/waymo.json
```

The output file is created with exclusive-write semantics and is never
overwritten. Standard output contains only target identity, pass/fail, receipt
hash, and key ID. A failed comparison returns a non-zero exit status and only
JSON-pointer mismatch locations, never expected values.

Repeat the protected producer, candidate, and judge jobs for `waymo`,
`nuscenes`, and `argoverse2`.

The repository is public, so never upload a hidden bundle as an ordinary
Actions artifact. After all six inputs exist, stage one validated compressed
envelope into the protected GitHub Environment:

```bash
npm run oracle:stage -- \
  --environment phase6-oracle-judge \
  --requirements benchmarks/oracle/phase6-requirements.json \
  --expected-producer-commit a42f658e27fce118789d3648e2612f5d25b99488 \
  --expected-candidate-commit <exact-pr-head-sha> \
  --waymo-oracle /protected/waymo.oracle.json \
  --waymo-candidate /transfer/waymo.candidate.json \
  --nuscenes-oracle /protected/nuscenes.oracle.json \
  --nuscenes-candidate /transfer/nuscenes.candidate.json \
  --argoverse2-oracle /protected/argoverse2.oracle.json \
  --argoverse2-candidate /transfer/argoverse2.candidate.json
```

The staging command validates integrity, provenance, source identity, and exact
reviewed coverage before uploading 40KB chunks. It logs only sizes, chunk
count, and the compressed-envelope hash. The Environment also holds the judge
private key; the public key is
`benchmarks/oracle/keys/phase6-2026-08-public.pem`.

Set `PHASE6_ORACLE_JUDGE_TOOL_COMMIT` in that Environment to the reviewed,
immutable commit containing the judge, gate, requirements, and public key.
The secret-bearing job fetches only this commit; it never checks out, installs,
or executes the PR candidate. The candidate enters the judge solely as the
integrity-checked artifact whose provenance commit must equal the PR HEAD.

## 4. Enforce the deletion gate

Create a reviewed requirements document outside the author workspace. It has
this shape and contains every required case's exact public capture declaration:

```json
{
  "kind": "egolens-oracle-gate-requirements",
  "schemaVersion": 1,
  "targets": [
    {
      "datasetId": "waymo",
      "caseId": "reviewed-case-id",
      "coverage": {
        "requiredCapabilities": ["boxes3d", "cameraImages", "pointClouds", "timeline"],
        "frameIndices": [0, 9, 19],
        "completeTimeline": false,
        "perceptualReferenceIds": ["front-camera-frame-0"]
      }
    }
  ]
}
```

The real document must include unique target cases spanning all three datasets
and must list every currently exposed capability. Verify all public receipts
with that document, the configured public key, and exact pre-cutover commit:

```bash
npm run oracle:gate -- \
  --receipt /receipts/waymo.json \
  --receipt /receipts/nuscenes.json \
  --receipt /receipts/argoverse2.json \
  --requirements /config/phase6-oracle-requirements.json \
  --public-key /config/judge-public.pem \
  --key-id phase6-2026-08 \
  --expected-generator-commit a42f658e27fce118789d3648e2612f5d25b99488 \
  --expected-candidate-commit <exact-pr-head-sha> \
  --output /evidence/phase6-oracle-gate.json
```

The gate passes only with exactly one valid passing receipt for every configured
target, target coverage exactly matching the reviewed declaration, all three
datasets represented, all six checks present and passing, valid Ed25519
signatures, and the expected producer commit. Keep the Phase 6 PR in draft
until this command and the independent Spec 012 performance gate both pass.

After staging, add the `phase6-oracle-evidence` label to PR #20 (or remove and
re-add it for a new HEAD). The workflow accepts only this same-repository Phase
6 branch, waits for the `happyhj` Environment approval, reconstructs the inputs
on an ephemeral GitHub-hosted runner, and uploads only signed receipts and the
public gate report. A later code push triggers the workflow again and the stale
candidate commit fails closed.

After the evidence is retained according to the release policy, the executable
legacy loader is no longer needed by Phase 9. Adapter Amnesia uses the public
candidate capture path; only the trusted judge mounts the immutable bundles.
