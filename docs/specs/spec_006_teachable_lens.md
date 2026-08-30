# Spec 006 — Teachable Lens: portable full-scene adapter recipes

**Status**: in-progress (Phases 2–4 shipped; Phase 3–4 addenda → specs 008–010; Phase 5 next) · **Date**: 2026-08-29 · **Estimated effort**: staged weekend foundation

## Decision

Teachable Lens produces a portable, schema-validated JSON artifact:

```text
<format-name>.egolens-adapter.json
```

It does **not** produce or execute agent-authored JavaScript. The artifact is a
declarative program—`EgoLensAdapterRecipeV1`—that composes versioned readers,
transforms, joins, and validators owned by the EgoLens runtime.

The contract is full-scene from version 1. Every rendering capability currently
available in EgoLens must be representable by the recipe and its normalized
outputs:

- frame discovery, timestamps, synchronization, playback, and segments;
- LiDAR and radar point clouds, attributes, and camera projection data;
- ego poses, world mode, sensor frames, and calibrations;
- camera images, intrinsics, extrinsics, distortion, and POV metadata;
- 3D and 2D boxes, class taxonomies, tracks, and cross-modal associations;
- LiDAR and camera semantic/panoptic segmentation;
- 3D and 2D keypoints;
- segment metadata and data-driven capability flags.

An individual dataset may omit capabilities it does not contain. The recipe
schema and runtime may not omit a capability merely because the first demo does
not use it.

The product statement is:

> **Teachable Lens does not generate code. It generates a portable, validated,
> fingerprinted description of how EgoLens should understand a dataset.**

## Why JSON, and what “JSON adapter” means

JSON is the serialized artifact, not the execution engine and not a container
for the dataset itself.

```text
Codex-authored JSON recipe
        ↓ structural and semantic validation
        ↓ deterministic compilation
EgoLens-owned operator graph
        ↓ bounded execution in workers
Normalized EgoLens scene
        ↓
Existing renderers and controls
```

This boundary gives the product properties that generated JavaScript cannot
provide reliably:

- validate the entire artifact before executing it;
- explain a revision as a semantic diff;
- hash and identify the exact executable meaning;
- match the learned format against a second dataset;
- import it in a browser that did not author it;
- cache, review, test, migrate, and eventually sign it;
- prove that it cannot access the DOM, network, or unrelated local files.

“Declarative” does not mean “flat configuration.” The recipe is a typed,
acyclic data-flow program. It can select files and columns, decode records,
join tables, transform coordinate frames, derive trajectories, and bind those
results to normalized scene outputs, but only through operators registered by
EgoLens.

## Industry alignment

This is an industry-grade architecture, but the artifact must not be marketed
as an existing industry standard merely because it is JSON.

- Encord's Scene SDK models point-cloud, image, camera, frame-of-reference, pose,
  coordinate-convention, timestamp, and view-setting streams. Its Python
  builder validates and serializes a Scene payload; it explicitly avoids asking
  users to write raw Scene JSON. Teachable Lens adopts the same separation
  between source data and a normalized scene, while adding declarative decoding
  of an unknown source format. See
  [Encord Scene SDK](https://docs.encord.com/sdk-documentation/index-sdk/sdk-scenes).
- Supervisely's Point Cloud Episode format is the closest public JSON precedent:
  it represents frame-to-cloud mappings, tracked cuboids, images, intrinsics,
  extrinsics, and sensor metadata. It is a canonical project format backed by
  fixed importers, not an unknown-format recipe. See
  [Supervisely Point Cloud Episodes](https://docs.supervisely.com/customization-and-integration/00_ann_format_navi/07_supervisely_format_pointcloud_episode).
- ASAM OpenLABEL is the relevant standards vocabulary for multi-sensor streams,
  coordinate systems, transforms, objects, and annotations. EgoLens should
  align names and semantics where practical without claiming compliance until
  conformance is tested. See
  [ASAM OpenLABEL](https://www.asam.net/standards/detail/openlabel/).
- Foxglove, FiftyOne, and CVAT use code extensions for truly custom input
  formats. Teachable Lens replaces the common cases with a constrained recipe;
  it does not pretend every future codec can be expressed without adding a new
  runtime operator.

The novel part is not JSON alone. It is the WebMCP authoring loop in which an
agent derives the recipe from private local evidence, applies it to the live
renderer, and revises it using human perceptual feedback.

## Non-negotiable design boundaries

### The recipe describes data semantics, not presentation preferences

The recipe may define facts necessary to understand the data:

- sensor identity and modality;
- class taxonomy and semantic palette;
- camera model and image dimensions;
- available point attributes;
- coordinate conventions and physical units.

It must not define personal or session presentation preferences:

- background theme;
- current point size or opacity;
- active camera or orbit pose;
- which sensor is currently hidden;
- whether boxes are rendered as models or wireframes;
- panel layout or playback speed.

Those remain EgoLens UI state. A recipe tells EgoLens *what the scene means*;
the product decides *how the user currently views it*.

### JSON contains no executable escape hatch

The following are invalid anywhere in an adapter:

- JavaScript, WebAssembly, expressions, callbacks, or dynamic imports;
- function names outside the versioned operator registry;
- network URLs used as executable inputs;
- DOM selectors or browser-storage keys;
- absolute local paths or traversal segments such as `../`;
- recursion, unbounded loops, or a graph cycle.

If the agent encounters an encoding for which EgoLens has no operator, the
correct outcome is explicit:

```text
UNSUPPORTED_RUNTIME_OPERATOR: decoder "acme_lidar_v3" is not available
```

A future signed WASM extension system would be a separate artifact type with a
separate trust flow. It must not be smuggled into the JSON recipe.

### Full contract, optional dataset capabilities

`EgoLensAdapterRecipeV1` supports all normalized outputs from the start. A
recipe declares which ones it produces. The application derives controls from
successfully bound outputs rather than trusting booleans authored by the agent.

For example, `cameraSegmentation` only becomes available when the output binds
to a valid camera stream, label decoder, palette, and frame index. Merely
writing `"hasCameraSegmentation": true` has no effect.

## Artifact envelope

The top-level shape is stable and deliberately small:

```json
{
  "kind": "egolens-adapter",
  "schemaVersion": 1,
  "engine": {
    "minimumVersion": "1.0.0",
    "requiredOperators": {
      "parquet.columns": { "major": 1, "provider": "core" },
      "timeline.join": { "major": 1, "provider": "core" },
      "geometry.range_image_to_cartesian": { "major": 1, "provider": "core" }
    }
  },
  "identity": {
    "name": "Example perception format",
    "description": "Multi-sensor driving logs"
  },
  "match": {},
  "sources": {},
  "scene": {},
  "pipelines": {},
  "outputs": {},
  "validation": {},
  "hashes": {},
  "provenance": {}
}
```

Unknown top-level properties are rejected in v1. Every nested object follows
the same default: `additionalProperties: false` unless the schema explicitly
defines a metadata bag.

### `engine`

Pins compatibility instead of assuming the current website can execute every
artifact forever.

- `minimumVersion`: oldest EgoLens recipe engine that may compile the artifact.
- `requiredOperators`: provider, exact major version, and—for an extension
  dependency—the package identity and integrity expected for every referenced
  operator.
- compilation fails before file reads if an operator is absent or incompatible.
- minor operator changes must preserve output semantics; a semantic change
  requires a new major version.

### `identity`

Human-readable information only. It does not participate in format matching.
Changing the name changes the exported artifact metadata but not its executable
recipe hash.

### `match`

Defines bounded evidence used to decide whether a recipe is a candidate for a
new drop:

```json
{
  "all": [
    { "kind": "path", "glob": "sensors/lidar/*.feather", "minCount": 2 },
    { "kind": "path", "glob": "calibration/*.json", "minCount": 1 },
    {
      "kind": "table-schema",
      "source": "lidarFrames",
      "requiredFields": ["x", "y", "z", "intensity"]
    }
  ],
  "none": [
    { "kind": "path", "glob": "**/*.exe" }
  ]
}
```

Supported matcher evidence is allowlisted: normalized relative path templates,
extension, file count, size range/divisibility, bounded magic bytes, JSON keys,
and Parquet/Arrow schema fields. Regex is not accepted in v1; use the product's
bounded glob implementation.

Matching is a candidate-selection step, not proof. A candidate must still bind
and pass its validation pipeline before automatic reuse.

### `sources`

Names immutable views over the active dataset inventory:

```json
{
  "lidarFrames": {
    "reader": "feather.columns",
    "files": { "glob": "sensors/lidar/*.feather", "order": "numeric-path" },
    "columns": ["x", "y", "z", "intensity", "timestamp_ns"]
  },
  "annotations": {
    "reader": "feather.columns",
    "files": { "exact": "annotations.feather" },
    "columns": ["timestamp_ns", "track_uuid", "category", "tx_m", "ty_m", "tz_m"]
  }
}
```

Source definitions may inspect only files in the active session inventory. A
source cannot construct a URL. Large values are streamed or row-grouped; they
are never materialized into the JSON artifact.

### `scene`

Declares semantic entities that pipelines refer to:

- master timeline and segment boundaries;
- coordinate-frame graph (`world`, `ego`, sensor frames);
- LiDAR, radar, and camera sensors;
- camera models, image geometry, and distortion families;
- object taxonomy, model hints, and palettes;
- point attribute definitions and normalization ranges.

Coordinate conventions use semantic directions—`forward`, `backward`, `left`,
`right`, `up`, `down`—and explicit units. Raw matrices remain allowed as data
read from a source, but an agent cannot insert an unchecked arbitrary matrix as
an executable transform. The binding step validates dimensions, finiteness,
invertibility where required, and handedness.

### `pipelines`

Each pipeline is a typed directed acyclic graph:

```json
{
  "lidarPoints": {
    "nodes": [
      {
        "id": "readRangeImage",
        "op": "parquet.columns",
        "version": 1,
        "params": {
          "source": "lidarRows",
          "columns": ["shape", "values", "laser_name", "timestamp"]
        }
      },
      {
        "id": "toCartesian",
        "op": "geometry.range_image_to_cartesian",
        "version": 1,
        "inputs": {
          "rangeImage": "readRangeImage.rows",
          "calibration": "lidarCalibration.rows",
          "pose": "lidarPose.rows"
        },
        "params": { "return": 1 }
      }
    ],
    "result": "toCartesian.pointClouds"
  }
}
```

Node IDs are unique within a pipeline. Inputs reference sources, scene entities,
or earlier node outputs. Compilation performs topological sorting and rejects
cycles, missing references, type mismatches, incompatible operator versions,
and unreachable nodes.

### `outputs`

Binds pipeline results to the normalized scene contract:

```json
{
  "timeline": "timeline.frames",
  "egoPoses": "poses.normalized",
  "pointClouds": "lidarPoints.result",
  "cameraImages": "cameraFrames.result",
  "boxes3d": "boxes3d.result",
  "boxes2d": "boxes2d.result",
  "boxAssociations": "associations.result",
  "trajectories": "tracks.result",
  "lidarSegmentation": "lidarSeg.result",
  "cameraSegmentation": "cameraSeg.result",
  "keypoints3d": "keypoints3d.result",
  "keypoints2d": "keypoints2d.result",
  "segmentMetadata": "metadata.result"
}
```

The artifact never serializes `Float32Array`, JPEG bytes, label masks, or all
frame rows. Outputs are bindings evaluated lazily by the runtime.

### `validation`

Contains declarative assertions, sampling plans, and human-review requirements.
It cannot waive engine safety checks.

```json
{
  "sampleFrames": ["first", "middle", "last"],
  "assertions": [
    { "kind": "timestamps-strictly-increasing", "output": "timeline" },
    { "kind": "finite-ratio", "output": "pointClouds", "minimum": 0.9999 },
    { "kind": "minimum-point-count", "output": "pointClouds", "value": 1000 },
    { "kind": "box-dimensions-positive", "output": "boxes3d" },
    { "kind": "projection-in-frame-ratio", "output": "cameraImages", "minimum": 0.05 }
  ],
  "humanReview": ["orientation", "handedness", "scale", "box-alignment"]
}
```

### `provenance`

Records authorship and revision lineage, but is excluded from executable recipe
identity:

- author: `codex`, `imported`, or a future registry identity;
- creation time;
- parent recipe hash;
- concise change summary and assumptions;
- human review receipt;
- validator version and validation summary;
- source dataset fingerprint used during authoring.

Raw filenames, byte samples, artifact inspection logs, and free-form private
feedback are not exported by default.

### `hashes`

Stores the engine-computed `artifactHash`, `recipeHash`, `formatFingerprint`,
and `operatorSetFingerprint`. An imported artifact is rejected if a supplied
hash does not recompute exactly. `datasetFingerprint` belongs in provenance
because it identifies the authoring instance rather than the reusable recipe.

## Full normalized scene contract

The current `DatasetManifest`, `MetadataBundle`, `FrameData`, and worker result
types are close to a normalized boundary but still contain historical Waymo
names and raw `ParquetRow` values. Teachable Lens must not make those leaks part
of the portable format.

Introduce a strict `NormalizedSceneV1` boundary:

```ts
interface NormalizedSceneV1 {
  manifest: NormalizedManifestV1
  index: NormalizedSceneIndexV1
  relations: NormalizedRelationsV1
  loadFrame(index: number, request: FrameCapabilityRequest): Promise<NormalizedFrameV1>
  dispose(): void
}
```

`NormalizedManifestV1` contains sensors, cameras, taxonomies, palettes, point
attributes, nominal rates, and capabilities. `NormalizedSceneIndexV1` contains
segments and monotonic frame timestamps. `NormalizedRelationsV1` contains
calibration graphs, object-track indexes, and cross-modal association indexes.

`NormalizedFrameV1` can carry:

| Output | Required normalized meaning |
|---|---|
| Point clouds | sensor ID, interleaved attributes, point count, optional semantic/panoptic labels and camera projection |
| Ego pose | finite 4×4 `world_from_ego`, with units and convention already normalized |
| Camera image | camera ID, encoded bytes, timestamp, dimensions, calibration reference |
| 3D box | stable object ID, class ID, center, dimensions, orientation, frame ID |
| 2D box | stable object ID, camera ID, pixel geometry, class ID |
| Association | explicit 2D object ↔ 3D object identity |
| Keypoints | named joint schema, positions, visibility/occlusion, object identity |
| Segmentation | sensor/camera ID, label buffer or encoded mask, divisor, taxonomy reference |

An internal compatibility layer converts `NormalizedSceneV1` into the existing
store shapes during migration. New recipe semantics must not mention
`ParquetRow`, Waymo component names, or numeric sensor constants owned by an
existing adapter.

## Operator registry

EgoLens owns a registry of deterministic, versioned operators:

```ts
interface RecipeOperator<I, O> {
  name: string
  majorVersion: number
  inputContract: Schema
  paramsContract: Schema
  outputContract: Schema
  execution: 'main' | 'worker'
  deterministic: true
  estimateCost(input: BoundInput): CostEstimate
  execute(input: I, params: unknown, signal: AbortSignal): Promise<O>
}
```

Initial families required to express all three current adapters:

### Inventory and readers

- `inventory.glob`
- `binary.interleaved_records`
- `json.records`
- `parquet.columns`
- `feather.columns`
- `image.encoded_bytes`
- `png.uint16_labels`

### Relational and temporal transforms

- `records.select`, `records.rename`, `records.cast`
- `records.lookup`, `records.filter`, `records.group_by`
- `timeline.sort`, `timeline.nearest`, `timeline.join`
- `relations.token_join`, `relations.composite_key_join`
- `tracks.derive_trajectories`

### Geometry and calibration

- `geometry.axis_map`
- `geometry.unit_scale`
- `geometry.quaternion_to_matrix`
- `geometry.compose_transform`, `geometry.invert_transform`
- `geometry.relative_poses`
- `geometry.range_image_to_cartesian`
- `geometry.project_points_to_camera`
- `geometry.normalize_boxes3d`, `geometry.normalize_boxes2d`
- `geometry.normalize_keypoints`

### Labels and imagery

- `labels.semantic_lookup`
- `labels.panoptic_split`
- `labels.attach_by_point_index`
- `labels.decode_camera_mask`
- `image.bind_camera_frame`

Operator names describe operations, not datasets. `waymo.load` and
`nuscenes.parse` are forbidden. A specialized operator is acceptable only when
it represents a documented encoding or mathematical transform independently of
a dataset brand.

Operators are not all-purpose scripting primitives. The registry has no eval,
JavaScript-string expression evaluator, filesystem handle, clock, random
source, or mutable global state. Worker execution uses cancellation, memory
budgets, output-size checks, and deterministic errors.

### Three operator tiers

The runtime separates composition, safe parameterized transforms, and new
executable capability.

#### Tier 1 — Core operators

Core operators ship with EgoLens, are reviewed with the application, and are
available to any compatible recipe. The three bundled dataset recipes must use
this tier. Migrating a legacy adapter by creating one dataset-branded core
operator is not acceptable.

#### Tier 2 — Bounded expression operators

Common human corrections—axis permutation, sign inversion, unit conversion,
field selection, clamping, and small arithmetic derivations—may use a typed JSON
AST understood by a specific core operator. It is not JavaScript and contains
no source strings or property access outside declared inputs.

```json
{
  "operator": "geometry.map_vector@1",
  "params": {
    "components": [
      { "input": "x" },
      { "negate": { "input": "z" } },
      { "input": "y" }
    ],
    "scale": 0.01
  }
}
```

Each expression operator owns a closed node vocabulary, static input/output
types, maximum depth/node count, and cost model. There is no general expression
language, loop, recursion, dynamic lookup, function call, or string evaluation.

#### Tier 3 — Registered custom operator packages

A format may require a genuinely new codec, binary packet decoder, projection
model, or mathematical operation. In that case a developer—including Codex
acting in the repository—may author TypeScript/JavaScript as a separately
reviewed operator package. The recipe references the registered operator by
identity; executable source is never embedded in `.egolens-adapter.json`.

```ts
interface EgoLensOperatorPackageManifest {
  packageId: string
  version: string
  engineRange: string
  integrity: string
  operators: Array<{
    name: string
    majorVersion: number
    inputContract: Schema
    paramsContract: Schema
    outputContract: Schema
    execution: 'worker'
  }>
}
```

V1 supports custom packages registered at application build/install time. A
future runtime package installer may be added only with an explicit trust and
permission UX; importing a recipe must never install code. JavaScript operator
packages are trusted executable extensions. Running them in a Worker provides
fault and performance isolation, but is not presented as a security proof or a
safe sandbox for untrusted code.

An extension operator must:

- register through the same typed/versioned registry as a core operator;
- execute in a dedicated Worker with cancellation, timeout, memory/output
  budgets, and transferable-output validation;
- declare package version and integrity, included in compatibility diagnostics
  and `operatorSetFingerprint`;
- receive only explicitly bound inputs and a restricted execution context;
- never be fetched, installed, or updated as a side effect of loading a recipe;
- include deterministic fixtures and contract tests before distribution.

If a required custom operator is missing, compilation stops with
`OPERATOR_MISSING` and reports its exact package, version, and integrity. The UI
may explain how to obtain a trusted package, but it cannot silently fall back to
agent-authored code.

This creates two different portability claims:

- a core-only recipe works on any compatible EgoLens deployment;
- an extension-dependent recipe works only where its declared operator package
  is registered. The JSON remains portable and inspectable, but it is not
  standalone executable capability.

The expected Codex development flow for a new capability is: author operator
source and tests in the repository, obtain human review, build/register the
package, then author a JSON recipe that references it. Runtime Teachable Lens
authoring composes registered capabilities; it does not covertly extend the
engine.

## Validation pipeline

Validation is progressive and no later stage may override an earlier failure.

### V0 — Parse and resource limits

- maximum artifact size: 256 KiB in v1;
- strict JSON, UTF-8, no duplicate keys, no non-finite numbers;
- bounded object depth, array length, string length, graph nodes, and glob count;
- reject absolute paths, traversal, URLs, and unknown properties.

### V1 — JSON schema

Validate the complete artifact against the repository-pinned
`egolens-adapter-v1.schema.json`. Tool inputs use the same schema; there is not
a permissive “agent version” and a stricter import version.

### V2 — Semantic compilation

- every source, frame, sensor, pipeline, and output reference resolves;
- operator and contract versions are available;
- every extension dependency matches its declared package version and
  integrity; a recipe cannot trigger installation;
- graph is acyclic and fully typed;
- required normalized fields are bound;
- capabilities are derived from outputs;
- coordinate graph is connected, finite, and internally consistent.

### V3 — Dataset binding

- matcher evidence is recomputed from the active inventory;
- file selectors match within declared limits;
- required columns/JSON keys/magic bytes exist;
- byte stride, shapes, image dimensions, and label encodings are plausible;
- no source reaches outside the active session.

### V4 — Sample execution

Run the first, middle, and last available frame, plus frames named by the recipe.
Check output types, finiteness, counts, monotonic timestamps, matrix validity,
positive box dimensions, label ranges, and memory/time budgets. Preserve the
last good render when a revision fails.

### V5 — Cross-output invariants

- sensor frames resolve into ego/world frames;
- 2D/3D associations reference real objects;
- boxes and keypoints refer to existing taxonomies;
- segmentation labels fit their palette/divisor;
- camera projections use a compatible calibration and image frame;
- track identities remain stable across the sampled timeline.

### V6 — Human perceptual review

The engine cannot prove that an internally consistent coordinate convention is
the intended one. Finalization therefore requires human review of every output
family produced by the recipe:

- orientation and handedness;
- scale;
- ego-motion stability;
- box-to-cloud alignment;
- camera-to-LiDAR projection;
- temporal synchronization;
- segmentation/keypoint alignment when present.

The review UI is capability-aware. It does not ask about boxes when no box
output exists, and it cannot mark a capability as reviewed before the user has
rendered a frame containing that capability.

### V7 — Finalization

Finalization requires V0–V5 to pass and V6 to contain no unresolved rejection.
It computes identity, stores the revision, updates the local matcher index, and
enables export. Warnings remain visible in provenance.

Diagnostics are structured and stable:

```ts
interface AdapterDiagnostic {
  stage: 'parse' | 'schema' | 'compile' | 'bind' | 'sample' | 'cross-output' | 'human'
  severity: 'error' | 'warning' | 'info'
  code: string
  jsonPointer?: string
  source?: string
  expected?: unknown
  got?: unknown
  hint: string
}
```

## Identity and fingerprinting

One hash cannot safely represent executable revision identity, exact exported
bytes, format reuse, and a particular dataset instance. Keep them separate.

| Identifier | Answers | Expected stability |
|---|---|---|
| `artifactHash` | Is this the exact same exported artifact, including provenance? | Changes when any exported field changes. |
| `recipeHash` | Does this have the same executable adapter semantics? | Stable across title, review, and provenance-only edits. |
| `formatFingerprint` | Is this another instance of the learned source format? | Stable across scenes and semantic corrections. |
| `datasetFingerprint` | Is this the same dropped dataset instance? | Changes with the selected files/content evidence. |
| `operatorSetFingerprint` | Can this engine supply the exact core and extension operator dependencies? | Stable until operator requirements or extension integrity change. |

### `artifactHash`

Exact exported-artifact identity. Remove only the `artifactHash` field itself,
canonicalize the complete remaining artifact with RFC 8785, then compute
SHA-256. This includes `identity`, `provenance`, validation summary, and human
review receipts. It supports integrity checks and byte-independent comparison
of semantically identical JSON serialization.

### `recipeHash`

Identity of executable semantics.

1. Remove `identity`, `provenance`, computed hashes, comments, and review text.
2. Canonicalize the remaining JSON with the
   [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html).
3. Compute SHA-256 over the canonical UTF-8 bytes.

Changing a transform, matcher, validation assertion, source mapping, or operator
version changes `recipeHash`. Renaming the adapter or recording a new review
does not.

### `formatFingerprint`

Identity of the source format family used for learned-adapter matching. It is
computed by EgoLens from normalized evidence after successful binding:

- path templates with instance tokens removed;
- extensions and reader families;
- bounded magic bytes where applicable;
- structural table/JSON schemas;
- record stride, shape, and encoding invariants;
- declared format-version evidence when present.

It excludes scene content, timestamps, object counts, transforms, palettes, and
human feedback. Correcting `z: down` to `z: up` changes the recipe hash but keeps
the format fingerprint, allowing a corrected revision to replace its parent for
the same format.

### `datasetFingerprint`

Identity of the particular dropped instance. It uses normalized relative path
templates, file sizes, and bounded per-file samples selected by the engine. It
is local provenance, not telemetry, and is excluded from automatic matching
across scenes.

### `operatorSetFingerprint`

Hash of the exact operator names, major versions, providers, and extension
package identities/integrities needed to compile the recipe. It provides a fast
compatibility check and a useful debugging signal without changing recipe
semantics.

## Revisions and human feedback

Every `apply_revision` call submits a complete artifact, never an imperative
patch. It includes `parentRecipeHash`; EgoLens rejects a stale parent to prevent
the agent from overwriting a newer human-approved revision.

Internally, EgoLens computes a semantic diff grouped by:

- source discovery;
- timeline and synchronization;
- coordinate frames and units;
- sensors and calibrations;
- geometry and annotations;
- taxonomy and labels;
- validation assertions.

A human review records structured observations against a recipe hash and an
output family:

```ts
interface HumanReviewItem {
  recipeHash: string
  capability: 'pointClouds' | 'egoPoses' | 'cameraImages' | 'boxes3d' |
    'boxes2d' | 'projection' | 'segmentation' | 'keypoints' | 'timeline'
  frameIndices: number[]
  verdict: 'accepted' | 'rejected'
  issue?: 'upside-down' | 'mirrored' | 'wrong-scale' | 'drift' |
    'misaligned' | 'out-of-sync' | 'wrong-labels' | 'other'
  note?: string
}
```

Free-form notes remain local unless the user explicitly asks Codex to read them.
The UI provides a copyable prompt because the page cannot assume it can push a
message into the agent conversation:

> Revise the adapter using my latest Teachable Lens review.

## Persistence and portability

The exported file is the source of truth. Browser storage is a cache.

- IndexedDB stores finalized artifacts, matcher evidence, validation summaries,
  and the preferred recipe hash per format fingerprint.
- `localStorage` is not used for artifacts.
- File objects and raw samples remain in memory for the active session and are
  not persisted with the recipe.
- Export produces one self-contained `.egolens-adapter.json` file.
- Import performs the same V0–V5 validation as an agent-authored revision.
- A normal Chrome browser without WebMCP can import and execute a finalized
  recipe.
- An optional future registry stores artifacts by short ID; URLs carry that ID,
  never serialized recipe contents.

When a dataset is dropped, local reuse proceeds as follows:

1. Build a privacy-preserving inventory.
2. Find candidate recipes using cheap matcher evidence.
3. Bind candidates in descending confidence order.
4. Run V3–V5 against bounded samples.
5. If exactly one candidate passes, load it and show provenance.
6. If zero pass, offer Teachable Lens.
7. If multiple pass, ask the human to choose; never silently pick by name.

## Security and privacy model

- Dropping/selecting the folder is the user's private-data access gesture.
- WebMCP inspection tools can address only inventory paths returned by the page.
- Each inspection call has byte/value/row limits and an abort signal.
- Raw paths, filenames, byte samples, recipe content, and human notes never enter
  analytics.
- Tool output is untrusted input to the agent, and agent-authored recipes are
  untrusted input to EgoLens.
- Compilation happens before execution; recipes use already-registered,
  versioned operators and worker boundaries, never `eval`, source strings, or
  recipe-triggered dynamic module loading.
- Installing a custom JavaScript operator is a separate trusted-code action,
  equivalent to adding application code. Recipe import never grants that
  authority and a Worker is not treated as a complete sandbox.
- A failed revision cannot replace the last good render or preferred cached
  artifact.
- Export visibly lists the capabilities, fingerprint, recipe hash, provenance,
  validation warnings, and required engine/operator versions.

## WebMCP surface

Use a small, stable tool set registered once in the top-level document. The
[official OpenAI WebMCP documentation](https://learn.chatgpt.com/docs/webmcp)
states that the built-in browser does not discover iframe-registered tools and
recommends narrow inputs, explicit side effects, verification data, and a normal
human interface. An iframe/worker may isolate runtime work but cannot own tool
registration.

| Tool | Side effect | Purpose |
|---|---|---|
| `egolens_teachable_inspect` | Read-only | Inspect bounded inventory, schema, bytes, rows, and numeric summaries. |
| `egolens_teachable_get_contract` | Read-only | Return recipe schema version, normalized outputs, operator registry, limits, and current diagnostics. |
| `egolens_teachable_apply_revision` | Mutating | Validate a complete recipe against `parentRecipeHash`, bind it, sample-run it, and render the valid outputs. |
| `egolens_teachable_get_state` | Read-only | Return phase, current recipe identity, diagnostics, semantic diff, and latest human review. |
| `egolens_teachable_finalize` | Mutating | Require engine validation and capability-aware human review, then cache and prepare export. |

Feature detection is limited to the public capability:

```ts
const webMcpAvailable =
  typeof document.modelContext?.registerTool === 'function'
```

The first actual tool execution, not capability detection, sets
`agentEngaged = true` and changes the human UI to `CODEX IS TEACHING EGOLENS`.

## Self-hosting and conformance

Mystery Drive alone is not sufficient evidence. Before treating the authoring
system as real, run **Adapter Amnesia** tests against every format EgoLens
already supports.

In Adapter Amnesia mode:

- the dataset-specific registry entry and recipe are hidden from Codex;
- dataset-branded loader calls are unavailable;
- Codex sees only raw inventory, bounded evidence, the recipe contract, and the
  generic operator registry;
- the existing adapter runs separately as a hidden oracle;
- the authored recipe is compared against the oracle and the live render.

### Required parity

| Dataset | Teachable recipe must reproduce current EgoLens behavior |
|---|---|
| Waymo | five LiDAR sensors and attributes, range-image conversion, poses, five cameras and calibration, 3D/2D boxes and association, trajectories, LiDAR segmentation, camera segmentation, 3D/2D keypoints, camera projection/coloring, metadata |
| nuScenes | LiDAR and five radar streams, six cameras and calibration, ego/world poses, 3D boxes and trajectories, 2D boxes where available, LiDAR semantic/panoptic labels, camera projection/coloring, metadata |
| Argoverse 2 | LiDAR, seven ring cameras and calibration, ego/world poses, 3D boxes and trajectories, camera projection/coloring, metadata |

Parity is evaluated at three levels:

1. **Structural:** segments, frame count, timestamps, sensors, capabilities,
   taxonomies, and available annotation frames.
2. **Numeric:** point counts, finite ratios, attribute quantiles, poses, box
   centers/dimensions/orientations, calibration matrices, projection coverage,
   and deterministic sampled buffers.
3. **Perceptual:** orientation, ego-motion stability, box alignment, camera
   projection, segmentation/keypoints, and timeline synchronization in the live
   UI.

All features currently exposed for that dataset must reach parity. A
LiDAR-and-timeline-only result is an engine smoke test, not a passing adapter.

After all three leave-one-adapter-out tests pass, Mystery Drive becomes the
held-out generalization test:

- no built-in adapter or oracle;
- more than one modality and at least one cross-output relation;
- an intentionally ambiguous but internally plausible coordinate convention;
- Mystery A for authoring and human correction;
- Mystery B with the same format but different scene content for automatic
  reuse.

## Implementation handoff snapshot

This section records the repository reality on **2026-08-29** so a new Codex
session can start implementation without reconstructing the planning
conversation. The normative product and architecture decisions remain the rest
of this spec. If the code has changed since this date, inspect the current code
and update this section rather than forcing the snapshot onto it.

### Canonical product and UX decisions

- The feature name is **Teachable Lens**. “Teacherable Lens” and “Adopter” are
  typos; use **adapter** in code and copy.
- The initiating promise is **“Teach the lens what it can’t yet see.”**
- The primary entry point is a failed/unsupported dataset drop, not a separate
  agent-only application. Preserve the dataset selection and ordinary browser
  UI for users without WebMCP.
- When an unsupported folder remains available in the current browser session,
  show an action near the lower-left drop-zone diagnostics such as **“Teach
  EgoLens this dataset”**. In the Codex in-app browser, supporting copy may ask
  the user to tell Codex to help teach the adapter. Do not claim Codex is
  available by probing an invented object such as `CodexGetTools`.
- Human and agent work in the same live UI, but their responsibilities are
  distinct: the agent inspects structure, proposes a recipe, runs deterministic
  checks, and applies revisions; the human judges perceptual meaning and gives
  corrections such as “the point cloud appears upside down.”
- The durable result is one portable `.egolens-adapter.json` artifact. Browser
  storage is a convenience cache, not the source of portability; JavaScript is
  neither generated nor executed.
- The three existing datasets are the self-hosting proof. The Mystery dataset is
  attempted only after Waymo, nuScenes, and Argoverse 2 pass full-feature parity.
- A point-cloud-and-timeline demo is insufficient. Every currently exposed
  rendering and interaction capability supported by the source dataset is in
  the parity gate.

### Read-first files for a new session

1. This specification.
2. [`AGENTS.md`](../../AGENTS.md) for repository constraints and current product
   capabilities.
3. [`docs/TECHNICAL_PLAN.md`](../TECHNICAL_PLAN.md) for existing loading,
   rendering, caching, and worker architecture.
4. [`docs/specs/README.md`](README.md) for spec status conventions.
5. Run `git status --short` before editing. This snapshot was created in a dirty
   worktree; uncommitted and untracked files are user-owned.

Baseline commands are:

```bash
npm test
npm run build
npm run lint
```

The first implementation turn should run the relevant focused tests before and
after each seam change, followed by the full commands above at a delivery gate.

### Current data path, not the destination architecture

At the snapshot date, the effective strategy is distributed rather than
represented by a formal `DatasetAdapter` interface:

```text
DropZone in App.tsx
  → folderScan.ts
  → registry.detectDataset() and hard-coded dataset scanners
  → sentinel-shaped Map<string, Map<string, File>>
  → useSceneStore.loadFromFiles()
  → dataset-specific metadata loaders and worker pools
  → MetadataBundle + FrameData
  → existing renderers and controls
```

The important implementation seams are:

| Concern | Current repository reality | Migration seam |
| --- | --- | --- |
| Detection | [`src/adapters/registry.ts`](../../src/adapters/registry.ts) owns a static manifest list; first required-component match wins | Compile recipe match rules into an explicit registry entry |
| Active configuration | The same registry owns a mutable process-wide `activeManifest` singleton | Pass a compiled adapter/manifest through load context; do not rely on the singleton for shadow comparison |
| Folder scan | [`src/utils/folderScan.ts`](../../src/utils/folderScan.ts) accepts only known layouts and emits `__nuscenes__` / `__argoverse2__` sentinels | Introduce a source inventory that can retain an unknown folder's files/handles for the teaching session |
| Failure UI | `DropZone` in [`src/App.tsx`](../../src/App.tsx) turns an empty scan into a terminal error | Convert eligible unsupported drops into the Teachable Lens entry state while retaining actionable errors |
| Orchestration | [`src/stores/useSceneStore.ts`](../../src/stores/useSceneStore.ts) branches on sentinel keys and dataset-specific internal state | Add a formal adapter boundary, then route legacy and recipe-backed implementations through it |
| Shared metadata | [`src/types/dataset.ts`](../../src/types/dataset.ts) defines `DatasetManifest` and `MetadataBundle` | Treat these as a compatibility bridge, not the final normalized contract |
| Frame payloads | Store `FrameData` and [`src/workers/types.ts`](../../src/workers/types.ts) already share typed arrays for sensor clouds and images | Preserve the efficient payload shape while removing dataset-specific semantics from it |
| Heavy decoding | Dataset-specific workers exist for Waymo, nuScenes, and AV2 | Extract generic bounded operators behind the existing worker/pool protocol |
| WebMCP | No `document.modelContext` or `registerTool` integration exists | Add top-level registration only after the underlying application commands exist |
| Recipe validation | No Ajv, Zod, or other JSON Schema validator is currently installed | Select the runtime validator deliberately; do not hand-roll partial schema validation |
| Persistence | There is no adapter import/export or recipe IndexedDB | Implement file import/export as the portability path and browser storage as a cache |

The legacy manifests live at:

- [`src/adapters/waymo/manifest.ts`](../../src/adapters/waymo/manifest.ts)
- [`src/adapters/nuscenes/manifest.ts`](../../src/adapters/nuscenes/manifest.ts)
- [`src/adapters/argoverse2/manifest.ts`](../../src/adapters/argoverse2/manifest.ts)

The corresponding metadata loaders and remote loaders are in the same three
adapter directories. Dataset-specific binary work currently lives in
`src/workers/waymo*`, `src/workers/nuScenes*`, and `src/workers/av2*`. Existing
adapter, store, folder-rejection, worker-pool, projection, range-image, and
calibration tests are the first regression suite to preserve.

### Compatibility facts that the recipe bridge must preserve

`MetadataBundle` is unified only at the TypeScript surface. It still exposes
Waymo/Parquet-shaped values such as raw `ParquetRow` boxes and camera
calibrations, a Waymo `SegmentMeta`, numeric sensor IDs, and
`LidarCalibration`. `DatasetManifest.columnMap` is required even for nuScenes
and AV2, whose manifests currently fill it with empty strings. These leaks are
technical debt and must not become `NormalizedSceneV1` merely by renaming the
type.

During migration, the compatibility bridge must satisfy the store and renderer
without weakening the normalized contract:

- preserve stable numeric sensor IDs at the renderer boundary, even if recipe
  identity uses stable string keys internally;
- preserve interleaved `Float32Array` point buffers, `pointStride`, point count,
  segmentation/panoptic arrays, and Waymo camera-projection arrays;
- preserve timestamps, poses, calibrations, boxes, associations, trajectories,
  camera images, keypoints, segment metadata, and capability flags;
- keep the GPU camera-colormap projection path and its camera texture behavior;
- keep world/ego coordinate behavior, POV transitions, timeline synchronization,
  prefetch, cancellation, cache semantics, and error reporting;
- transfer large typed arrays between workers rather than cloning them;
- retain Parquet row-group random access and separate LiDAR/camera worker pools;
- never materialize a whole multi-gigabyte dataset merely to validate or match a
  recipe.

EgoLens remains browser-only at runtime: no server, Python process, or native
helper may be required. Repository scripts may create development fixtures, but
an exported recipe and supported dataset must work in the deployed browser app.

### Shadow-mode hazard

Do not implement parity by loading both adapters concurrently through the live
store. The current global manifest, dataset-specific `internal` state, caches,
and worker pools can make the two runs overwrite or influence each other.

Build a headless comparator that passes adapter/load context explicitly and
captures normalized outputs before they enter Zustand. Run the legacy oracle
and recipe-backed path in isolated or serialized contexts, canonicalize Maps and
typed arrays, and compare deterministic summaries plus sampled buffers. Only
the selected result should enter the UI store. The legacy code is an oracle
during migration, not a permanent second production runtime.

### Unknown-drop retention and privacy

The current scanner records unknown top-level directory names in
`FolderRejection.found` for local error copy and deliberately reports only a
safe allowlist subset plus counts to analytics. Preserve that privacy boundary.
Unknown file names, paths, schemas, sample values, fingerprints, and recipes
must not be sent to analytics.

The current scanner also discards the unknown tree after producing the
rejection. Teachable Lens needs a session-scoped `SourceInventory` that retains
the user-authorized `File` objects or directory handle long enough for
inspection and preview. It must:

- remain local and avoid reading file bodies until a bounded inspection command
  requests them;
- expose stable logical paths, sizes, extensions, and sampled schema summaries;
- make revocation, page refresh, or a lost handle an explicit recoverable state;
- never serialize `File`, `Blob`, or directory handles into the adapter artifact;
- avoid putting sensitive raw names or values in WebMCP tool descriptions or
  global application logs.

Legacy `webkitRelativePath` drops and modern File System Access handles both
need a path into this inventory. A recipe stores selectors relative to the
authorized dataset root, never absolute local paths.

### WebMCP implementation and test assumptions

Use [OpenAI's Site tools documentation](https://learn.chatgpt.com/docs/webmcp)
as the current integration reference and re-check it when implementation starts,
because availability and supported APIs can change.

As of this snapshot:

- Codex and ChatGPT Work discover site tools from the same live page and session
  in the desktop app's built-in browser.
- Register JavaScript tools from the **top-level page**. Tools in iframes and the
  declarative HTML API are not currently discovered.
- Feature-detect with
  `typeof document.modelContext?.registerTool === "function"`; absence is a
  normal browser state, not an application error.
- Keep inputs narrow, label read/write effects, validate again inside the
  application command, and return identifiers/diagnostics sufficient to verify
  what changed.
- Tool handlers should call the same command layer as the human UI. They must
  not manipulate React state or the DOM as a parallel implementation.
- Closing or navigating away from the page can make the tools unavailable.
- At this date, official docs specify GPT-5.6 Sol or Terra, the latest desktop
  app, and note that Luna has WebMCP disabled and Enterprise/Edu workspaces do
  not have site tools. Treat this as a test-environment note, not a permanent
  product invariant.

The first tool call should produce a visible teaching session in the UI so the
agent and person remain grounded in the same state. Every mutating tool result
must return the new revision ID, validation state, and a concise observable
effect. The ordinary UI remains fully usable when WebMCP is unavailable.

### First implementation milestone: contract lock, no behavior change

The safest first session is narrower than “build Teachable Lens UI.” Complete
the following in order:

1. Run the baseline tests and record failures that already exist.
2. Introduce the formal `DatasetAdapter`/load-context boundary around current
   behavior without changing dataset output.
3. Add `EgoLensAdapterRecipeV1`, `NormalizedSceneV1`, diagnostics, operator
   descriptors, operator-package dependency descriptors, and JSON Schema as
   versioned types/assets.
4. Choose and add a standards-compliant runtime JSON Schema validator, then test
   structural rejection, unknown fields, version mismatch, and stable
   canonicalization.
5. Add a compiler skeleton and `RecipeBackedDatasetAdapter` that can instantiate
   one minimal hand-authored fixture recipe through the same boundary.
6. Add a headless parity-harness skeleton that does not touch the global store.
7. Verify no behavior/UI change with focused tests, full tests, build, and lint.

**Milestone exit:** a minimal fixture recipe validates, compiles, and reaches the
existing adapter boundary; legacy datasets behave exactly as before. No
Teachable Lens card, WebMCP tool, or dataset migration is required yet.

Suggested subsequent commit/PR boundaries are Phase 2 manifest extraction,
then one commit series per dataset migration, legacy-runtime removal, the custom
operator extension boundary, authoring/session UI, WebMCP, persistence, and
finally the Mystery fixture. Avoid mixing a renderer rewrite into the adapter
migration unless a parity failure proves that the normalized contract requires
it.

### Decisions intentionally left for implementation

The following require a focused implementation decision or spike. A new session
should not silently guess and then encode the guess across the architecture:

- exact runtime JSON Schema validator and whether schemas are generated from or
  checked against TypeScript types;
- exact `DatasetAdapter` method surface and explicit load-context ownership;
- canonical normalized forms for boxes, calibration/distortion, keypoints,
  segmentation, and segment metadata;
- operator parameter sub-schemas, resource budgets, cancellation, and error
  taxonomy;
- custom operator package layout, build-time registration API, integrity
  representation, and the exact restricted Worker context;
- recipe canonicalization details used by each hash;
- IndexedDB schema, recipe upgrade UX, and import conflict resolution;
- development feature flag and the precise legacy-oracle removal point;
- size and licensing of checked-in parity fixtures and the judge-ready Mystery
  dataset.

Resolve each as narrowly as possible, add contract tests, and update this spec
when the decision changes a public artifact or normalized runtime guarantee.

### Worktree state at handoff

At the time this snapshot was written, `git status --short` included unrelated
or user-owned modifications and untracked assets. In particular,
`src/utils/analyticsBootstrap.ts`, `AGENTS.md`, `docs/specs/spec_005_embed_theming.md`,
several files under `assets/`, and `egolens-pipeline-analysis.html` must not be
overwritten or cleaned up as part of this feature. This spec and its index row
were also untracked/modified planning work. Always trust a fresh `git status`
over this list and preserve everything outside the requested implementation
scope.

## Migration architecture

The current dataset adapters remain operational while the recipe engine is
built, but the destination is one path:

```text
Bundled Waymo recipe ─┐
Bundled nuScenes recipe ─┼→ Recipe compiler/runtime → NormalizedSceneV1 → UI
Bundled AV2 recipe ───┤
Learned recipe ───────┘
```

No permanent “trusted built-in adapter runtime” and “limited learned adapter
runtime” split is allowed. Bundled recipes may be reviewed and shipped with the
app, but they use the same public schema, compiler, operator contracts, and
normalized outputs as imported and agent-authored recipes.

### Migration phases

#### Phase 1 — Freeze the strategy boundary and add the recipe-backed wrapper

Define `NormalizedSceneV1`, the recipe schema, diagnostics, operator registry,
the three operator-tier contracts, and a formal adapter strategy boundary. Add
one implementation:

```ts
class RecipeBackedDatasetAdapter implements DatasetAdapter {
  constructor(
    private readonly recipe: EgoLensAdapterRecipeV1,
    private readonly operators: OperatorRegistry,
  ) {}
}
```

The existing UI and scene store continue to depend on the adapter strategy, not
on recipes or individual datasets. `RecipeBackedDatasetAdapter` compiles a
recipe and bridges `NormalizedSceneV1` into the current store during migration.
No dataset behavior changes in this phase.

**Exit gate:** a minimal hand-authored recipe passes schema/compile tests and can
be instantiated through the same strategy boundary as a legacy adapter.

#### Phase 2 — Move declarative manifests for all three datasets to JSON

Move the parts that are already data out of TypeScript first:

- detection paths and required components;
- sensor/camera identities and labels;
- frame rates and point attributes;
- class taxonomies, colors, palettes, and model hints;
- camera aliases and POV labels;
- declared output capabilities.

The JSON recipe becomes the source of truth. Temporary generated TypeScript or
a compatibility loader may feed existing call sites, but parallel hand-edited
manifest definitions are forbidden.

**Exit gate:** the three JSON manifests reproduce the current
`DatasetManifest` values exactly, with snapshot tests and no UI regression.

#### Phase 3 — Migrate nuScenes end to end

Use nuScenes as the first full recipe because it exercises broad scene semantics
with comparatively transparent inputs:

- interleaved binary LiDAR and radar records;
- JSON table sources and token joins;
- six camera streams, intrinsics, extrinsics, and ego poses;
- boxes, tracks, associations, lidarseg, and panoptic labels;
- camera projection/coloring and segment metadata.

Extract generic reader/join/geometry/label operators from the legacy adapter.
Run the recipe-backed and legacy adapters in shadow mode on the same scenes.

**Exit gate:** structural, numeric, and perceptual parity passes for every
nuScenes feature currently exposed by EgoLens. Switch only nuScenes registry
resolution to its bundled recipe; keep the legacy implementation available as
a test oracle until all three migrations finish.

#### Phase 4 — Migrate Argoverse 2 end to end

Add generic Feather/Arrow column readers, timestamp alignment, ring-camera
calibration, pose, boxes/tracks, and projection operators needed by AV2. Reuse
the normalized contracts and operators established by nuScenes rather than
adding AV2-specific branches.

**Exit gate:** full current AV2 structural, numeric, and perceptual parity passes
in shadow mode. Switch AV2 registry resolution to its bundled recipe.

#### Phase 5 — Migrate Waymo end to end

Migrate the most complex format after the contracts have survived two datasets:

- Parquet row-group sources and nested columns;
- five-sensor range images and spherical-to-Cartesian conversion;
- LiDAR/camera calibration, poses, and camera projection;
- five camera streams;
- 3D/2D boxes, tracks, and associations;
- LiDAR and camera segmentation;
- 3D and 2D keypoints;
- all current camera-color and annotation behavior.

Operators must describe documented encodings or mathematical operations. Do not
add `waymo.load`, `waymo.parse`, or an equivalent branded escape hatch.

**Exit gate:** every Waymo feature currently exposed by EgoLens reaches shadow
parity and the registry resolves Waymo through its bundled recipe.

#### Phase 6 — Remove the dual runtime

After all three registry paths use `RecipeBackedDatasetAdapter`, classify the
remaining legacy code:

- retain generic readers, transforms, joins, worker scheduling, caching, and
  normalized-output bridges;
- move retained algorithms behind versioned operator contracts;
- delete dataset-specific orchestration that is now expressed by recipes;
- keep golden fixtures and oracle outputs, not a second production loader.

**Exit gate:** `registry.ts` does not distinguish bundled and learned recipes by
execution path. No permanent `loadWaymoDataset`, `parseNuScenesScene`, or
equivalent dataset-branded production path remains.

#### Phase 7 — Add the custom operator extension boundary

Implement registered operator-package manifests, provider/version/integrity
resolution, dedicated Worker execution, resource enforcement, contract tests,
and deterministic missing-operator diagnostics. Add at least one harmless test
extension proving that recipe import cannot install or execute unregistered
source. Build-time registration is sufficient for v1; a runtime package
marketplace or untrusted-code sandbox is not required.

Custom operators extend the engine when a format needs genuinely new executable
capability. They are not the default answer to difficult recipe composition and
must not become dataset-branded replacements for the migrated core graph.

**Exit gate:** a recipe referencing a registered test extension executes through
the normal operator contract; the same recipe fails before file access with a
structured `OPERATOR_MISSING` diagnostic when that package is absent or its
integrity differs.

#### Phase 8 — Add Teachable Lens authoring

Add unsupported-session capture, bounded inspection, the WebMCP tools, revision
application, semantic diff, capability-aware human review, IndexedDB caching,
and JSON import/export. Agent-authored and imported artifacts go through the
same schema, compiler, operators, and validation stages as bundled recipes.

**Exit gate:** Codex can author and revise a full-scene recipe without changing
application code, and a failed revision preserves the last good scene.

If inspection proves that a genuinely new decoder/operator is required, the UI
returns a capability-gap diagnostic. Codex may implement that operator in the
repository development workflow, but the live authoring session does not embed
or install its JavaScript.

#### Phase 9 — Prove self-hosting before the mystery dataset

Run Adapter Amnesia on Waymo, nuScenes, and Argoverse 2. Codex cannot inspect or
invoke their bundled recipes; the hidden golden outputs remain available only
to the conformance harness.

**Exit gate:** Codex-authored recipes reproduce every currently exposed feature
for all three datasets under structural, numeric, and perceptual parity checks.

#### Phase 10 — Run the held-out generalization test

Only after self-hosting passes, add Mystery A/B. Mystery A proves unknown-format
authoring and human correction; Mystery B proves fingerprint-based reuse in a
fresh browser session without an agent call.

## Proposed code organization

```text
src/teachable/
├── schema/
│   ├── egolens-adapter-v1.schema.json
│   ├── validateSchema.ts
│   └── migrateRecipe.ts
├── recipe/
│   ├── types.ts
│   ├── canonicalize.ts
│   ├── fingerprints.ts
│   ├── compiler.ts
│   ├── diagnostics.ts
│   └── semanticDiff.ts
├── operators/
│   ├── registry.ts
│   ├── expressionAst.ts
│   ├── readers/
│   ├── records/
│   ├── timeline/
│   ├── geometry/
│   └── labels/
├── extensions/
│   ├── packageManifest.ts
│   ├── resolvePackage.ts
│   ├── extensionWorker.ts
│   └── verifyIntegrity.ts
├── runtime/
│   ├── normalizedScene.ts
│   ├── executePlan.ts
│   ├── workerProtocol.ts
│   └── compatibilityBridge.ts
├── session/
│   ├── inventory.ts
│   ├── inspect.ts
│   ├── reviews.ts
│   └── store.ts
├── persistence/
│   ├── indexedDb.ts
│   ├── importRecipe.ts
│   └── exportRecipe.ts
├── webmcp.ts
└── __tests__/

src/adapters/recipes/
├── waymo-v2.egolens-adapter.json
├── nuscenes.egolens-adapter.json
└── argoverse2.egolens-adapter.json

src/components/TeachableLens/
├── TeachableLensCard.tsx
├── RecipeDiff.tsx
├── HumanReviewTray.tsx
├── ValidationPanel.tsx
└── ProvenancePanel.tsx
```

The JSON Schema is checked into the public repository and linked from exported
artifacts/documentation. Runtime TypeScript types are generated from or tested
for parity with the schema; two manually maintained divergent contracts are not
acceptable.

## Delivery gates

The full-scene decision invalidates a one-day point-cloud-only implementation
schedule. Delivery is gated by evidence rather than a clock.

### Gate A — Contract lock

- `NormalizedSceneV1` covers every current renderer input.
- JSON Schema, TypeScript types, operator contract, canonicalization, and
  diagnostics are committed.
- malicious/invalid recipe fixtures fail deterministically.

### Gate B — Self-hosted runtime

- all three bundled recipes compile through the same engine;
- their current features pass structural, numeric, and visual parity;
- no dataset-branded operator exists;
- all three bundled recipes remain core-only and require no custom package;
- existing URL/local loading behavior remains intact.

### Gate C — Extension boundary

- custom operator source is packaged and registered separately from recipes;
- provider, version, and integrity participate in compilation and fingerprinting;
- missing/mismatched packages fail before source data is read;
- Worker/resource controls and deterministic contract fixtures pass;
- importing a recipe cannot install or evaluate JavaScript.

### Gate D — Teachable authoring

- unsupported drops preserve a bounded local session;
- Codex can inspect, author, apply, revise, and finalize through WebMCP;
- the UI shows agent/human/EgoLens ownership and capability-aware review;
- a failed revision preserves the last good scene.

### Gate E — Portability and reuse

- finalized JSON exports and imports in ordinary Chrome;
- fingerprints select the corrected recipe for a second scene;
- stale revisions and ambiguous matcher results cannot silently replace a
  preferred recipe.

### Gate F — Held-out proof

- Mystery A exercises multi-modal/cross-output authoring and a real perceptual
  correction;
- Mystery B loads without an agent;
- two cold runs succeed on the deployed URL in the Codex in-app browser.

## Acceptance criteria

### Artifact and runtime

- [ ] The exported artifact contains valid JSON only and conforms to the public
      v1 schema.
- [ ] No recipe field can execute JavaScript, WebAssembly, network access, DOM
      access, arbitrary filesystem access, or unregistered operators.
- [ ] Custom JavaScript operators are separately registered trusted packages;
      recipe import cannot fetch, install, update, or embed them.
- [ ] Missing or integrity-mismatched extension dependencies fail compilation
      before dataset file access.
- [ ] All current EgoLens rendering capabilities are expressible as normalized
      outputs, whether or not a particular dataset supplies them.
- [ ] Capabilities are derived from successfully compiled output bindings.
- [ ] Every operator is versioned, deterministic, typed, cancellable, and
      subject to resource limits.
- [ ] Schema, compiler, binder, sample, cross-output, and human-review failures
      produce structured diagnostics.

### Identity and portability

- [ ] Recipe hashes use RFC 8785 canonicalization plus SHA-256 and exclude
      presentation metadata/provenance.
- [ ] Artifact hashes cover the complete exported artifact except the computed
      `artifactHash` field itself.
- [ ] Format, recipe, dataset, and operator-set fingerprints have separate test
      fixtures and never substitute for one another.
- [ ] A semantic revision changes `recipeHash`; a title-only change does not.
- [ ] A corrected revision can retain the same `formatFingerprint` and become
      the preferred recipe for a second scene.
- [ ] A core-only recipe exports/imports in a fresh non-WebMCP Chrome session;
      an extension-dependent recipe reports its declared missing package until
      that trusted extension is registered.

### Self-hosting

- [ ] Waymo, nuScenes, and Argoverse 2 can each load through a bundled v1 recipe
      and the shared recipe runtime.
- [ ] Each reproduces every feature EgoLens currently exposes for that dataset,
      not merely LiDAR and timeline.
- [ ] Adapter Amnesia prevents Codex from reading or invoking the hidden built-in
      recipe/adapter while preserving a hidden oracle for comparison.
- [ ] Structural, numeric, and perceptual parity reports are saved as test
      artifacts.

### WebMCP and human collaboration

- [ ] Tools are registered once in the top-level document using public feature
      detection.
- [ ] Inspection is bounded and raw private evidence is never sent to analytics.
- [ ] Applying a revision requires the current parent recipe hash.
- [ ] Invalid revisions preserve the last good render.
- [ ] Human review is tied to the exact recipe hash, capability, and reviewed
      frames.
- [ ] Finalization requires all produced capability families to pass engine and
      human validation.
- [ ] The artifact and UI visibly distinguish `Codex proposed`, `You reviewed`,
      and `EgoLens validated`.

## Non-goals

- Making JSON Turing-complete.
- Claiming that `.egolens-adapter.json` is an ASAM or other industry standard.
- Storing raw sensor frames, images, masks, or point arrays inside the artifact.
- Encoding per-user rendering preferences in a dataset adapter.
- Automatically creating, installing, or trusting a runtime operator when the
  required codec does not exist. Codex may author a separately reviewed package
  in the repository development workflow.
- A public adapter marketplace, signing infrastructure, or remote registry in
  v1.
- Uploading private source data to author an adapter.
- Weather authoring, natural-language querying, briefing, or dashboard tools in
  the Teachable Lens core.

## Submission narrative

**Why WebMCP:** the page and Codex share the same live local-file session,
validated recipe runtime, render state, and human review. The agent can inspect
bounded evidence and propose a full scene interpretation without the user
transcribing schemas or moving private files to a backend.

**Why the artifact matters:** the collaboration leaves behind a portable JSON
description rather than ephemeral chat or browser-specific state. It is
inspectable, diffable, testable, fingerprinted, reusable, and safe to execute
through an allowlisted runtime.

**What humans and agents do together:** Codex is better at discovering file
structure, joins, encodings, and transformations. A person is better at judging
whether a world is upside down, mirrored, drifting, out of scale, or
miscalibrated. EgoLens validates both contributions and turns them into a
reusable adapter revision.

**Why this is more than a demo:** the same recipe engine must first reproduce
the full existing Waymo, nuScenes, and Argoverse 2 experiences under
leave-one-adapter-out tests. Mystery Drive is a held-out generalization test,
not the implementation target.
