# Spec 010 — Teachable Lens Phase 4 implementation findings

**Status**: shipped · **Date**: 2026-08-29

**Relationship to Spec 006**: this is the normative implementation addendum for
[`spec_006_teachable_lens.md`](spec_006_teachable_lens.md) Phase 4 and later
runtime migration. It records constraints discovered while binding the bundled
Argoverse 2 recipe to an official Sensor Dataset log. Where this document is
more specific about the findings below, it takes precedence over Spec 006.

## Decision

Phase 4 keeps Feather decoding, temporal alignment, and scene geometry generic.
The AV2 adapter may select declarative parameters for those operators, but it
may not introduce an Argoverse-branded executable reader, join, or projector.

## 1. Feather columns require exact logical types and explicit budgets

The official AV2 tables use heterogeneous Arrow types. LiDAR `x`, `y`, and `z`
are `float16`; intensity is `uint8`; calibration and annotation geometry is
`float64`; timestamps are `int64`; and identity fields are UTF-8, sometimes
through Arrow dictionary encoding.

`feather.columns@1` must therefore require every selected column's name and
logical type, plus explicit limits for input bytes, rows, and output bytes. It
must reject missing or mismatched columns before allocating normalized output.
Dictionary-encoded strings satisfy `utf8` only when their decoded logical value
type is UTF-8.

The reader must not pretend source geometry is `float32` merely because the
renderer consumes a `Float32Array`. Source validation happens against the Arrow
schema; conversion happens once at the normalized interleaved point-buffer
boundary.

## 2. Nearest-timestamp joins are bounded semantics

AV2 LiDAR timestamps form the master timeline. Ego poses can align within a
recipe-declared 1 ms bound, while the seven ring cameras are asynchronous and
require a separate 50 ms bound. The official Phase 4 log's largest selected
ring-camera delta is approximately 40.421 ms.

`timeline.join@1` and numeric-path camera binding must declare `maxDeltaNs` when
their mode is nearest. The alignment operator must:

- require sorted, unique source timestamps;
- select the earlier sample on an exact tie;
- return no match outside the declared bound;
- preserve the camera image's actual timestamp rather than replacing it with
  the LiDAR frame timestamp.

An out-of-bound camera image is absent for that frame. It must never be matched
arbitrarily to keep a capability looking complete.

## 3. Combined AV2 LiDAR points are already in the ego frame

AV2 calibration describes the physical up and down LiDAR sensors, but the
published per-sweep Feather points consumed by EgoLens are already expressed in
the ego-vehicle frame. The normalized combined LiDAR stream therefore uses one
stable string sensor ID and an identity `ego` transform.

Applying either physical LiDAR extrinsic again would double-transform the point
cloud. Camera sensors remain separate string identities and retain their actual
ego-from-camera extrinsics, intrinsics, distortion coefficients, and image
geometry. Numeric renderer IDs are used only by the compatibility edge.

## 4. AV2 reuses the shared scene geometry boundary

Quaternion heading conversion and pinhole 3D-box projection are shared core
geometry operations. Phase 4 extracts them from the nuScenes recipe runtime and
uses the same functions for AV2. Dataset-specific branches are limited to
binding raw table fields into normalized inputs.

The current renderer-compatible box overlay remains pinhole-based. AV2 radial
distortion coefficients are preserved in `NormalizedCameraCalibrationV1` so a
future distortion-aware projection operator can be added by versioned contract
rather than silently changing `projectBox3dPinholeV1` semantics.

## 5. Graph inputs and duplicated source-column declarations are compile-time contracts

Closed parameter schemas alone do not prevent a recipe node from wiring the
wrong input names. Before binding dataset bytes, the compiler must also validate
every node's `inputs` against the selected operator descriptor.

When a source has both the portable `columns` list and typed reader
`params.columns`, their ordered names must match exactly. A mismatch fails with
`SOURCE_COLUMNS_CONTRACT_MISMATCH`; an invalid node input fails with
`OPERATOR_INPUTS_INVALID`.

## Phase 4 acceptance evidence

- [x] Strict fixtures cover Feather success, schema mismatch, missing columns,
      input/row/output limits, interleaving, and cancellation.
- [x] Timestamp fixtures cover earlier-tie determinism, maximum-delta rejection,
      unsorted input, and nanosecond-to-microsecond normalization.
- [x] Headless shadow parity compares the AV2 normalized pose, point buffer,
      cameras, 3D/2D boxes, and tracks with compatibility metadata.
- [x] An official AV2 log binds 157 frames, 2,689 poses, 157 annotation frames,
      seven ring cameras, and all eight declared capabilities with no binding
      diagnostics; a sampled frame contains 98,236 LiDAR points, 88 3D boxes,
      104 projected 2D boxes, and 155 trajectories.
- [x] Live browser review renders the full 157-frame timeline, seven-camera
      strip, LiDAR cloud, 3D boxes, front-camera POV, LiDAR-to-camera overlay,
      and GPU camera colormap without application errors.
- [x] AV2 registry resolution uses the bundled recipe-backed strategy; the
      compatibility worker remains the renderer oracle until Phase 6 removes
      the dual runtime.
