# Spec 007 — Teachable Lens Phase 2 contract lock

**Status**: shipped · **Date**: 2026-08-29

**Relationship to Spec 006**: this is the normative addendum for
[`spec_006_teachable_lens.md`](spec_006_teachable_lens.md) Phase 2. A request to
implement “Spec 006 Phase 2” requires reading and applying both specifications;
for the four contract decisions documented here, Spec 007 takes precedence.

## Decision

Phase 2 migrates the three bundled dataset manifests into complete,
schema-valid `EgoLensAdapterRecipeV1` artifacts. It does not introduce a second
manifest-fragment format and it does not use placeholder or dataset-branded
operators. A Phase 2 recipe compiles its real source and operator descriptors;
operator execution may remain unconnected until the dataset's runtime migration
phase.

Four previously open projection decisions are fixed as follows.

### Stable format identity

`scene.formatId` is required and owns the stable adapter/runtime identifier.
`identity.name` remains display-only. Renaming an artifact must not change the
adapter ID, executable binding, or format identity.

### Inventory and manifest projection

`match.inventory.rootEntries` is the ordered source of truth for the authorized
dataset-root entries. Each entry declares whether it is required for bounded
pre-read detection. The compatibility bridge projects this list to legacy
`knownComponents` and `requiredComponents` without putting those legacy names
inside `NormalizedSceneV1`.

`scene.pointLayout.interleavedAttributes` defines buffer order and stride.
`scene.pointLayout.colorModes` declares color modes supported by the normalized
point payload. Taxonomies have exactly one role—`objects`, `lidar-semantics`, or
`camera-semantics`—so palettes and box classes project without array-order
conventions. Camera `view` is semantic POV metadata; the temporary legacy panel
flex value remains an EgoLens-owned compatibility policy derived from view and
image geometry, not a recipe presentation preference.

### Raw source bindings

Raw column or field names remain under `sources.*.bindings`, using the closed
logical roles `timestamp`, `sensorId`, `rangeImageShape`, `rangeImageValues`,
and `egoPose`. The compiler requires a bound field to be selected by its source
and rejects conflicting values for the same logical role. Only the temporary
compatibility bridge projects these roles into legacy `DatasetManifest.columnMap`;
the normalized manifest and render contract never expose it.

### Complete recipe shells

Bundled Phase 2 assets always include engine requirements, matching, sources,
scene semantics, pipelines, outputs, and validation. Partial manifest JSON is
invalid. Compile-time operator descriptors are sufficient for the Phase 2
projection gate; this does not imply that an unimplemented operator can execute.
Later phases connect the same descriptors to bounded runtime implementations.

## Invariants

- every source and path matcher begins at a declared inventory root;
- at least one inventory root is required;
- the interleaved point layout begins with `x`, `y`, `z` and references only
  declared point attributes;
- taxonomy roles and inventory roots are unique;
- display metadata cannot change semantic format identity;
- raw source bindings cannot enter `NormalizedManifestV1`;
- no Phase 2 artifact can bypass the full v1 schema as a manifest fragment.

## Phase 2 handoff

Create the three bundled recipes under `src/adapters/recipes/`, compile them
with the versioned operator registry, project their compatibility manifests,
and compare behavior-normalized snapshots against the current TypeScript
manifests. Switch each manifest consumer only after its snapshot passes.
