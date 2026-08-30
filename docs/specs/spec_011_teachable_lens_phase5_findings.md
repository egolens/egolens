# Spec 011 — Teachable Lens Phase 5 implementation findings

**Status**: shipped · **Date**: 2026-08-29

**Relationship to Spec 006**: this is the normative implementation addendum for
[`spec_006_teachable_lens.md`](spec_006_teachable_lens.md) Phase 5 and later
runtime migration. It records constraints discovered while binding the bundled
Waymo recipe to v2 component Parquet files. Where this document is more
specific about the findings below, it takes precedence over Spec 006.

## Decision

Phase 5 expresses Waymo table selection, range-image conversion, calibration,
relations, and annotations through generic versioned contracts. It does not add
a Waymo-branded executable operator. The compatibility workers remain the
renderer/cache oracle until Phase 6 removes the dual runtime, but they receive
their selected columns and limits from the same compiled recipe.

## 1. Parquet validation happens at the decoded logical boundary

The physical Parquet representation of Waymo nested fields varies across
writers. Fixed and variable lists may use different repetition layouts while
decoding to the same logical value. `parquet.columns@1` therefore validates:

- an explicit ordered column projection;
- decoded logical types, including numeric, integer, boolean, binary, and list
  variants;
- required, optional, and nullable fields;
- input bytes, row count, and decoded-output byte budgets;
- row ranges and cancellation.

The reader must not depend on one writer's physical LIST encoding after
`hyparquet` has decoded it. A source's portable `columns` and typed
`params.columns` remain an exact compile-time contract.

Waymo camera principal points are a concrete optional-field case. Some v2
exports omit `intrinsic.c_u` and `intrinsic.c_v`; the normalized calibration
uses the image centre in that case. Focal lengths, image dimensions, and the
extrinsic remain required.

## 2. Waymo camera extrinsics require an optical-frame composition

Raw Waymo camera extrinsics map a vehicle-aligned sensor frame into the ego
frame. The normalized pinhole camera contract uses optical axes:

```text
x = right, y = down, z = forward
```

The normalized `egoFromCamera` is therefore:

```text
raw egoFromSensor × opticalToSensor
```

where optical X maps to sensor −Y, optical Y maps to sensor −Z, and optical Z
maps to sensor +X. Merely relabeling the raw matrix as optical would rotate
frustums and projected geometry incorrectly. The recipe camera frame
conventions and runtime transform must describe the same composition.

## 3. Range-image labels join through source pixel indices

Spherical conversion drops pixels whose range is not positive. Segmentation
cannot be zipped against the compacted point array by output index. Every
normalized Waymo cloud retains `sourceIndices`, mapping each point back to its
flattened range-image pixel.

Waymo LiDAR segmentation channels are `[instance_id, semantic_class]`. Semantic
and panoptic labels are gathered through `sourceIndices`; panoptic output uses
an unsigned 32-bit value so `semantic * 1000 + instance` is not truncated.

## 4. Row groups are the execution/cache unit; frames are the scene API unit

Parquet decompression remains row-group based in workers, because selecting
five frame rows does not avoid decompressing the containing row group. The
recipe-backed `NormalizedSceneV1`, however, exposes frame requests and stable
string sensor IDs. Implementations may cache a row group and serve many frame
requests from it, but must not retain a second merged point buffer in addition
to the per-sensor clouds.

The five physical LiDAR identities remain separate normalized streams. Numeric
Waymo enum values are compatibility-edge renderer IDs, not portable sensor
identities.

## 5. Optional capabilities require successfully bound evidence

URL construction is not evidence that an optional component exists. Static
hosts often return the application HTML with HTTP 200 for a missing Parquet
path. If footer validation rejects that response, the corresponding worker must
not retry the original URL or keep the capability enabled.

Capability evidence is based on successfully opened tables plus their required
calibration or relation inputs. This applies to camera images, segmentation,
keypoints, 2D boxes, and cross-modal associations. Missing optional data emits
`OPTIONAL_OUTPUT_UNBOUND` and leaves the remaining scene usable.

## 6. Phase 5 cutover retains one compatibility edge

Waymo registry resolution now uses `RecipeBackedDatasetAdapter`, and startup
binds a recipe-backed `NormalizedSceneV1` in shadow mode. The existing renderer
still consumes compatibility caches populated by workers. Those workers now
use the compiled recipe's strict `parquet.columns@1` contracts, preventing the
shadow and renderer paths from silently selecting different data.

Phase 6 may remove dataset-specific orchestration only after preserving the
row-group scheduling, cancellation, transfer-buffer, and memory behavior of
this compatibility edge.

## Phase 5 acceptance evidence

- [x] Strict Parquet fixtures cover explicit projection, decoded logical types,
      missing/type drift, input/row/output limits, row ranges, and cancellation.
- [x] Headless shadow parity covers the 199-frame deterministic Waymo fixture,
      five LiDAR range images, relative poses, 75 first-frame 3D boxes, camera
      calibration transforms, trajectories, capability filtering, and disposal.
- [x] Synthetic optional-table evidence covers 2D boxes, cross-modal
      associations, LiDAR semantic/panoptic labels, camera PNG masks, and 3D/2D
      keypoints through the normalized contract.
- [x] Browser review loads the fixture through the Waymo deep-link path,
      renders all five LiDAR streams, boxes, playback, and the 199-frame
      timeline with no application errors in a clean tab.
- [x] Missing optional Parquet paths that resolve to HTML no longer start a
      worker or fail the otherwise valid scene.
- [x] Registry resolution uses the bundled recipe-backed strategy for Waymo,
      nuScenes, and Argoverse 2; the compatibility workers remain renderer
      oracles until Phase 6.
