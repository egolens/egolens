# Spec 008 — Teachable Lens Phase 3 implementation findings

**Status**: planned · **Date**: 2026-08-29

**Relationship to Spec 006**: this is the normative implementation addendum for
[`spec_006_teachable_lens.md`](spec_006_teachable_lens.md) Phase 3 and later
runtime migration. It records constraints discovered while implementing the
three bundled Phase 2 recipes. Where this document is more specific about the
findings below, it takes precedence over Spec 006.

## Decision

Phase 3 must preserve the portable v1 recipe boundary while closing six gaps
that were not visible until the bundled Waymo, nuScenes, and Argoverse 2
manifests compiled through the same compatibility projection.

These are runtime and contract requirements, not reasons to add a trusted
dataset-specific escape hatch.

## 1. Sensor identity has two renderer-ID namespaces

Legacy renderer IDs are not globally unique. Waymo, for example, assigns the
same numeric values to LiDAR sensors and cameras. The compatibility boundary
therefore has two numeric namespaces:

- point sensors, shared by LiDAR and radar;
- cameras.

Within `NormalizedSceneV1`, the stable string `sensor.id` remains the canonical
identity and must be globally unique. `rendererId` is compatibility metadata.
Calibration, frame, image, projection, segmentation, and association lookups
must use the string sensor ID. A numeric renderer ID may be used only together
with its namespace at the legacy renderer edge.

The compiler must reject duplicate renderer IDs within either namespace while
allowing a point sensor and a camera to share the same numeric value. Runtime
maps keyed only by `rendererId` are invalid unless their type and ownership make
the namespace unambiguous.

## 2. Capabilities come only from bound outputs

The legacy `DatasetManifest` permits omitted `overlayModes` and
`annotationModes`, then supplies broad UI defaults. That behavior does not
describe the actual normalized data contract and must not enter the recipe
runtime.

For recipe-backed scenes:

- a capability exists only when its output binding compiles, binds to the
  active dataset, and satisfies the required cross-output invariants;
- UI defaults, `has*` store flags, and legacy omitted properties cannot create
  a capability;
- a failed or missing optional source removes the affected capability and
  produces a structured diagnostic rather than silently enabling a control;
- derived outputs are valid—for example, `boxes2d` may be produced by bounded
  projection of normalized 3D boxes—but their derivation must be explicit in
  the operator graph.

The compatibility bridge may project bound capabilities into legacy mode
arrays during migration. It must remain one-way and must not infer normalized
capabilities from legacy defaults.

## 3. Three generic binary readers are required for nuScenes

The Phase 2 recipes exposed three distinct input contracts that cannot be
represented accurately by one generic byte reader:

- `binary.interleaved_records@1` for fixed-stride little-endian records;
- `binary.pcd_records@1` for radar Point Cloud Data files;
- `archive.npz_array@1` for NumPy arrays stored in NPZ containers.

These names describe documented encodings, not nuScenes. They are core operator
candidates and must not be replaced with `nuscenes.parse`, `nuscenes.load`, or
equivalent branded operators.

Before Phase 3 executes them, each reader requires deterministic fixtures and
bounded failure behavior.

### `binary.interleaved_records@1`

- declare scalar type, endianness, stride, field offsets, and selected fields;
- reject a byte length that is not divisible by the declared stride;
- reject overlapping or out-of-stride fields at compile/bind time;
- enforce record-count and output-byte limits before allocating output arrays.

### `binary.pcd_records@1`

- bound header bytes, header lines, field count, point count, and output bytes;
- validate `FIELDS`, `SIZE`, `TYPE`, `COUNT`, `POINTS`, and `DATA` consistently;
- support only explicitly declared PCD data encodings; report a stable
  unsupported-encoding diagnostic for all others;
- reject duplicate fields, inconsistent row widths, non-finite numeric output,
  and payloads shorter or longer than the declared point count.

### `archive.npz_array@1`

- bound archive entry count, per-entry and total expanded bytes, compression
  ratio, rank, and element count;
- reject traversal, duplicate names, encrypted entries, and unsupported ZIP or
  NPY features;
- validate NPY dtype, byte order, shape, and payload length before allocation;
- select an explicitly named array and never deserialize Python objects or
  executable content.

All three operators execute in workers with cancellation and transferable
typed-array output.

## 4. Compile-time operator contracts must become strict before execution

Phase 2 intentionally registers descriptor shells with broad object contracts.
That is sufficient to prove that complete recipes reference available generic
operator names, but it is not sufficient authority to execute dataset bytes.

Before an operator is connected in Phase 3, its descriptor must define closed
input, parameter, and output schemas. The compiler must validate at least:

- required inputs and their normalized types;
- field names, scalar types, byte order, shapes, units, and coordinate frames;
- legal enum values and mutually exclusive parameter combinations;
- maximum input, allocation, output, and execution budgets;
- the exact output contract consumed by the next node.

`additionalProperties: true` is not permitted for an executable operator's
parameter schema. Moving validation solely into `execute()` is also not
permitted: incompatible recipes must fail before dataset file bodies are read.

## 5. nuScenes version-root selection is unresolved by exact mini parity

The Phase 2 migration preserves the current `v1.0-mini` detection and source
paths exactly. This does not yet prove safe binding for `v1.0-trainval` or
`v1.0-test`, even though those layouts are product targets.

Phase 3 must choose and test a bounded version-root model before claiming those
variants. The chosen model must:

- select exactly one metadata root from an allowlisted set;
- keep every resolved source under that selected inventory root;
- reject a drop with multiple viable roots as ambiguous unless the user or
  embedding context selects one explicitly;
- never concatenate tables from mini, trainval, and test through a broad glob;
- preserve stable `scene.formatId` and format identity across supported
  version roots when their executable semantics are otherwise the same;
- include local and URL-mode fixtures for every supported root.

Whether this is expressed as bounded source variants, a selector binding, or
separate recipes remains a focused Phase 3 schema decision. A broad
`v1.0-*` file glob is not an acceptable implementation.

## 6. Camera panel flex remains a temporary compatibility policy

Recipe camera semantics contain image geometry and semantic `view`; they do not
contain a panel flex value. Phase 2 reproduces current manifests through an
EgoLens-owned `view` and aspect-ratio compatibility policy.

Later runtime migration must not treat that heuristic as portable scene
semantics. Once camera consumers read normalized image geometry and `view`
directly, remove `flex` from the recipe compatibility path and let the product
layout own responsive sizing. Add layout tests for portrait, landscape, front,
side, and rear cameras before removing the bridge.

## Phase 3 implementation order

1. Lock strict contracts and fixtures for the operators used by the nuScenes
   recipe, including the three binary readers above.
2. Make string sensor IDs and explicit renderer namespaces flow through
   calibration, point-cloud, image, and projection operators.
3. Bind outputs progressively and derive capabilities only after binding and
   cross-output validation.
4. Resolve and test the nuScenes version-root model without weakening inventory
   containment.
5. Run structural and numeric parity before switching the nuScenes registry
   path; then complete perceptual parity in the live UI.
6. Retain camera flex only in the legacy compatibility projection until its UI
   consumers migrate.

## Phase 3 acceptance additions

- [ ] A point sensor and camera may share a renderer ID without collision;
      duplicates within one renderer namespace fail compilation.
- [ ] No normalized relation or calibration map depends on an unqualified
      numeric renderer ID.
- [ ] UI controls are derived from successfully bound outputs, not legacy
      defaults or authored capability booleans.
- [ ] Interleaved, PCD, and NPZ readers pass deterministic success, malformed
      input, cancellation, and resource-limit fixtures.
- [ ] Every executable operator used by nuScenes has closed parameter, input,
      and output contracts before it reads dataset bytes.
- [ ] A supported nuScenes version root binds in isolation; multiple viable
      roots produce a deterministic ambiguity diagnostic.
- [ ] No recipe or operator name contains a dataset-branded executable escape
      hatch.
- [ ] Camera layout remains behaviorally equivalent while `flex` stays confined
      to the temporary compatibility bridge.
