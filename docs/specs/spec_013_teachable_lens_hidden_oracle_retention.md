# Spec 013 — Teachable Lens hidden-oracle retention

**Status**: in-progress (reviewed cases and protected GitHub judge provisioned; real bundles/receipts pending) · **Date**: 2026-08-30

**Relationship to earlier specs**: this is the normative addendum for
[`spec_006_teachable_lens.md`](spec_006_teachable_lens.md) Phases 6 and 9 and
[`spec_012_teachable_lens_phase6_performance_gate.md`](spec_012_teachable_lens_phase6_performance_gate.md).
Where this document is more specific, it takes precedence.

## Finding

Phase 6 correctly removes the dual production runtime after Waymo, nuScenes,
and Argoverse 2 have migrated, but Phase 9 still needs an oracle for Adapter
Amnesia. Deleting the executable legacy path before promoting its observations
would make self-hosting parity circular: a candidate recipe would be compared
only with code and algorithms it can inspect or share.

The earlier wording describes both an “existing adapter” and “hidden golden
outputs.” These are successive states, not permanent parallel runtimes:

1. while migration is underway, the isolated executable legacy adapter is the
   oracle;
2. before that executable path is deleted, a trusted process promotes its
   outputs into immutable hidden oracle bundles;
3. Phase 9 compares authored candidates with those bundles through a separate
   judge. The browser application never ships or loads the oracle.

The three migrations being complete permits promotion and deletion. It does
not permit deletion before the promotion receipts exist.

## Decision

### 1. Separate production, authoring, and judging trust domains

| Domain | May access bundled recipes | May access legacy code | May access oracle values |
|---|---:|---:|---:|
| Deployed EgoLens runtime | yes | no | no |
| Adapter Amnesia authoring workspace | no for the held-out dataset | no | no |
| Trusted oracle producer | not required | yes, pinned pre-cutover revision | yes |
| Trusted conformance judge | candidate artifact only | no | yes |

The authoring agent must not be able to import, enumerate, read, fetch, or call
the hidden bundle or judge private key. A repository path ignored by Git is
not by itself hidden: the authoring workspace must not mount that storage.

### 2. Promote observations, not the production loader

The producer runs from the pinned pre-cutover base revision and emits one or
more `OracleBundleV1` artifacts for every supported dataset. Each bundle must
contain:

- schema version and target dataset/case identity;
- generator commit, legacy runtime identity, anonymized source fingerprint,
  capture timestamp, and declared feature coverage;
- deterministic structural observations;
- deterministic numeric observations, including typed-buffer type, length,
  full SHA-256, finite-value statistics, and distributed samples;
- perceptual reference identities and SHA-256 values for required rendered
  views;
- a bundle integrity hash over the canonical payload.

Dataset URLs, credentials, raw licensed frames, and unredacted paths must not
enter the bundle metadata or repository.

The bundle is stored in access-controlled CI/release evidence storage. It is
not checked into this repository, published with GitHub Pages, embedded in the
application bundle, or exposed through WebMCP.

### 3. Candidate artifacts use the same public contract

The authored recipe is executed in Adapter Amnesia mode and emits a
`SceneConformanceArtifactV1` through the public normalized-scene contract. It
contains the same structural, numeric, and perceptual observation shapes as
the oracle but no oracle values.

Capture must happen outside Zustand and must dispose each scene after use.
Required capabilities and frame indices are part of the artifact so a
LiDAR-only or undersampled candidate cannot appear to pass.

### 4. Only the trusted judge compares values

The trusted judge receives one hidden oracle bundle and one candidate artifact.
It verifies both integrity hashes, target identity, coverage, and structural,
numeric, and perceptual parity. Its public output is a signed
`OracleJudgeReceiptV1` containing:

- target, producer commit/runtime identity, oracle bundle hash, and candidate
  artifact hash;
- the public oracle coverage declaration (capabilities, frames, and perceptual
  reference IDs), which contains no expected observation values;
- pass/fail for structural, numeric, perceptual, coverage, and integrity;
- mismatch JSON pointers without expected oracle values;
- judge version, timestamp, receipt hash, signing key ID, and signature.

The candidate artifact must also carry its exact generator commit, immutable
runtime ID, anonymized source fingerprint, and capture timestamp. The judge
compares the source fingerprint without publishing it and places the candidate
commit/runtime identity in the signed receipt. The deletion gate must require
that candidate commit to equal the exact PR HEAD. An artifact hash alone is not
sufficient: without this binding, an older passing artifact could be replayed
after the candidate code changes.

Detailed oracle-side diagnostics remain a trusted human artifact. The
authoring loop cannot query the judge repeatedly as an oracle-extraction API.

### Capture-readiness finding

The Waymo evidence run showed that the interactive `seekFrame()` action may
return after scheduling a cold row-group request, before the requested frame is
actually presented. That behavior is correct for the ordinary non-blocking UI
but is not a valid capture barrier. The trusted browser capture command must
wait for the requested `currentFrameIndex` and non-null frame, fail on scene
error, and time out rather than hash the previously displayed frame. Settling
and image-complete checks occur only after that barrier.

The initial-load command has the same ordering requirement. The CDP runner may
observe the performance probe before React has committed the URL-load effect,
so it must wait for an explicit benchmark-command-ready signal before sending
the one-shot start event. A fixed delay alone is not a valid synchronization
barrier.

### 5. Phase 6 deletion and merge gate

Removal of a dataset's obsolete production path is accepted only when a trusted
receipt proves that its hidden bundle was produced from the pinned legacy
revision and covers every currently exposed feature. Phase 6 requires valid
receipts for `waymo`, `nuscenes`, and `argoverse2` in addition to all Spec 012
performance gates.

The Phase 6 candidate branch may delete the production path for measurement,
but it remains a draft and must not merge until the receipts are verified. The
pre-cutover main revision remains the producer source until promotion finishes.

## Implementation contract

Repository code provides:

- a versioned normalized-scene artifact capture library;
- deterministic canonicalization and SHA-256 integrity;
- a judge implementation that reports paths but not expected values;
- an Ed25519-signed receipt CLI and a three-dataset receipt gate;
- exact candidate-commit and anonymized source-case binding from artifact to
  signed receipt to PR gate;
- a reviewed requirement manifest that pins every target case's public coverage
  declaration so an underspecified oracle cannot pass the deletion gate;
- tests for deterministic capture, drift detection, tamper rejection,
  insufficient coverage, and receipt signature verification;
- a runbook for isolated producer/author/judge workspaces.

The repository intentionally does not contain real hidden oracle bundles or a
private signing key. Provisioning the protected storage, producer inputs, and
judge key is release evidence work, not browser runtime functionality.

For the initial promotion, the protected GitHub Environment is
`phase6-oracle-judge`. It requires `happyhj` approval, disallows administrator
bypass, and accepts deployments only from `codex/spec-006-phase-6` or `main`.
Because the repository is public, hidden bundles and candidates are compressed
into a bounded, integrity-checked Environment-secret envelope. Only public
signed receipts and the gate report may be retained as ordinary Actions
artifacts. The secret-bearing job executes only an Environment-pinned immutable
judge-tool commit; it must not check out, install, or execute the candidate PR.

## Phase 6 gate additions

- [ ] A hidden `OracleBundleV1` exists for every required Waymo case and covers
      all exposed Waymo capabilities.
- [ ] A hidden `OracleBundleV1` exists for every required nuScenes case and
      covers all exposed nuScenes capabilities.
- [ ] A hidden `OracleBundleV1` exists for every required Argoverse 2 case and
      covers all exposed AV2 capabilities.
- [ ] Bundle provenance points to the pinned pre-cutover legacy revision.
- [ ] The authoring workspace cannot access bundled held-out recipes, legacy
      source, oracle storage, or the judge private key.
- [ ] The trusted judge returns valid signed receipts for structural, numeric,
      perceptual, coverage, and integrity checks.
- [ ] The receipt gate verifies all three datasets with the configured public
      key and exact reviewed target coverage before the Phase 6 deletion PR
      becomes mergeable.
- [ ] Every receipt binds the candidate artifact to the exact Phase 6 PR HEAD;
      a stale candidate artifact fails before judging.
- [ ] Spec 012 performance/lifecycle evidence passes independently; oracle
      parity and runtime performance never substitute for one another.

## Phase 9 gate additions

- [ ] Adapter Amnesia produces candidate artifacts only through public recipe,
      operator, and normalized-scene contracts.
- [ ] Oracle bundles are mounted only in the trusted judge workspace.
- [ ] The authoring agent receives no oracle values or executable built-in
      adapter and cannot invoke the judge as an interactive probing tool.
- [ ] Signed receipts and trusted detailed reports cover every exposed feature
      at structural, numeric, and perceptual levels.
