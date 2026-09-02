# Spec 014 — Teachable Lens Phase 10 original-data generalization ladder

**Status**: in progress (10.P1–10.P6 implemented; 10.P7 counted evidence on
hold after the 2026-09-02 direction change below; four-dataset original-drop
work proceeds as collaborative authoring) · **Date**: 2026-09-02

**Relationship to earlier specs**: this is the normative acceptance addendum for
[`spec_006_teachable_lens.md`](spec_006_teachable_lens.md) Phase 10. It retains
the Mystery A/B intent while replacing a fabricated Mystery Drive format with
a four-rung held-out corpus of unsupported, officially distributed datasets.
Where this document is more specific, it takes precedence.

## Direction change (2026-09-02)

The 10.P7 counted Phase 9 runs were executed end to end for Waymo, nuScenes,
and Argoverse 2 (ten tooling defects found and fixed on the way, egolens#47
through egolens#56). Comparing the first captured blind recipe with the hidden
oracle showed the structural reason the exact-parity judge cannot pass: a
blind author that is asked only for capabilities collapses sensors (Waymo
1 lidar + 1 camera instead of 5 + 5, nuScenes 1 radar + 1 camera instead of
5 + 6, Argoverse 2 1 camera instead of 7), while every public validation and
the human review still accept the result.

The owner decided that the "authored with public tools only" purity claim is
not a goal. The goal is efficient human + Codex collaboration that yields a
working adapter recipe. Consequences:

- The author workspace asks the human to confirm the sensor layout (counts
  per modality, defaults inferred from the folder) before authoring; the
  session publishes it in the public contract, rejects revisions that declare
  a different layout (`SENSOR_CONFIGURATION_UNMET`), and the review panel
  shows declared sensors per modality against it (egolens#56).
- Feedback to the author flows through the Codex chat, not a new review
  channel; the review receipt keeps only verdicts.
- The 10.P7 counted evidence PR (PR B) is on hold. Reopening it requires the
  same sensor layout in `phase9-requirements.json`, a judge that ignores
  presentation-only fields (manifest name, sensor labels, colors), and fresh
  counted runs. The exact-parity judge is better used as a parity report
  during development than as a merge gate.
- The held-out rungs below no longer wait for that gate. Each rung is
  attempted as a collaborative authoring session; first-failure artifacts,
  classification, and the contract-change rule still apply, but the
  "unopened until 10.P7 freezes" precondition is withdrawn.

## Finding

EgoLens is intended to understand a dataset when a user drops the original
downloaded files or extracted dataset directory into the browser. A generated,
renamed, transcoded, or pre-indexed Mystery format would test the recipe engine
but would not test that product journey. It could also hide exactly the limits
Phase 10 is supposed to discover: unsupported containers, irregular timelines,
coordinate conventions, calibration graphs, source scale, and browser resource
pressure.

Phase 10 therefore uses real unsupported datasets without adding a built-in
adapter for any of them. It proceeds one dataset at a time. A failure is useful
evidence, but it does not automatically justify changing the public contract.
The failure must first be classified as a source limitation, generic operator
gap, authoring-observability gap, runtime/resource gap, extension/security gap,
or genuine recipe/normalized-scene contract gap.

## Decision

### 1. Test the original drop, not a converted fixture

A counted Phase 10 case is one of the following, exactly as published by the
dataset owner:

- an official archive selected in the file picker;
- an extracted official dataset root; or
- a complete official sequence/drive/scene subtree whose internal relative
  paths and bytes have not been changed.

Selecting one complete sequence from a larger release is allowed. Removing a
modality or annotation family required by that case's declared coverage is not.
Archive extraction is allowed; conversion is not.

Before a counted run, the harness records a privacy-safe `SourceCaseManifestV1`
containing the dataset release, official source URL, selected case identity,
relative-path inventory, byte sizes, SHA-256 content digests for every selected
file, and an available official archive checksum when one exists. Its canonical
source subset is hashed as `sourceManifestHash` below. The complete manifest
may remain protected when filenames are sensitive; public evidence retains its
hash, aggregate counts/sizes, release identity, and approved non-sensitive
fields. Absolute paths, credentials, raw payloads, and licensed media do not
enter public evidence.

The following are prohibited for a counted case:

- renaming files, directories, fields, sensors, or annotations;
- transcoding, repacking, extracting records into a different representation,
  pre-indexing records, or generating a dataset-semantic EgoLens sidecar;
- deleting inconvenient files from the selected case root;
- mounting a dataset devkit, reference loader, conversion script, built-in
  recipe, golden output, or hidden oracle in the authoring workspace;
- adding a dataset-name branch, dataset-branded operator, or filename-specific
  escape hatch to make the case pass.

The dataset name and original paths remain visible. This spec does not claim
that a model has no prior semantic knowledge of a public dataset. It proves the
mechanical boundary instead: the counted authoring agent receives source
evidence only through bounded public inspection, while candidate execution
reads source bytes only through the public binding, reader, operator, and
`NormalizedSceneV1` contracts.

### 2. Close the transport/runtime preflight before opening a rung

Phase 10 must measure generalization of the recipe and normalized-scene
contracts, not rediscover that the shared runtime can execute only a narrow
preview or that HTTP cannot enumerate a directory. Before a rung's `D`, `A`,
`B`, or reserve bytes are parsed or semantically inspected by EgoLens or the
authoring agent, the exact candidate baseline must satisfy this entry gate.
Content-blind enumeration and hashing needed to freeze the precommitted case
manifests are allowed; their output cannot reveal payload semantics.

**Implementation checkpoint — 10.P1:** production and isolated conformance
binding now enter one executor selected by the exact set of versioned public
reader/operator IDs, with no `sourceFamily` input. Local authoring inspection,
hashing, and preview plus the nuScenes/Argoverse 2 frame readers consume a
transport-neutral bounded `ByteSourceV1`; the three shipped structural/numeric
parity paths exercise the shared entry point. This checkpoint does **not** close
the preflight gate: the provider-specific preparation/scene bodies still need
to become full graph execution, and the catalog-backed remote source, manifest
hash, share descriptor/URL, local↔remote parity, security, performance, and
fresh-profile evidence remain pending. No held-out rung source is opened by
this checkpoint.

**Implementation checkpoint — 10.P2:** the core operator registry now carries
an executable ABI over typed graph values, and one deterministic topological
kernel owns source selection, node evaluation, cancellation, lifecycle, and
resource accounting. A generic graph-output assembler produces
`NormalizedSceneV1` plus the temporary renderer compatibility projection.
Argoverse 2 production, local import, browser authoring preview, and isolated
conformance now execute the declared Feather/image sources and all eight
pipelines without `AV2LogDatabase`, `AV2RecipeScene`, a provider-specific scene
body, or a fallback. Its optional capability evidence, numeric frame surface,
idempotent disposal, cancellation, and lazy point/image reads are covered by
the Phase 9/Spec 012 suite. Waymo and nuScenes remain on their passing 10.P1
providers until 10.P4 and 10.P3 respectively. No held-out rung source was
opened by this checkpoint.

**Implementation checkpoint — 10.P3:** the public graph value/operator surface
now covers bounded JSON relations, grouped token timelines, interleaved LiDAR,
binary PCD radar, NPZ/point-index labels, camera bytes and calibration, boxes,
trajectories, and scene metadata. The finalized nuScenes recipe executes those
declared sources and nodes in production, local import, browser authoring
preview, and isolated conformance through the same kernel and generic scene
assembler. The prepared `NuScenesDatabase`, `NuScenesRecipeScene`, provider
scene body, and their tests/fallbacks have been removed. Scene discovery and
classic/sharded URL loading also consume the graph's segment index over the raw
source inventory. The Phase 9 recipe hash was deliberately re-reviewed after
the semantic recipe change; nuScenes numeric/capability, lifecycle, store, and
Adapter Amnesia coverage remains green, as do Argoverse 2 and Waymo regressions.
Waymo remains on its passing 10.P1 provider until 10.P4. No held-out rung source
was opened by this checkpoint.

**Implementation checkpoint — 10.P4:** the public graph surface now executes
bounded Parquet projections, relative poses, range-image conversion, Parquet
camera images/calibration, direct 2D/3D boxes and associations, trajectories,
LiDAR/camera segmentation, 2D/3D keypoints, and segment stats. Waymo production,
local import, browser authoring preview, and isolated conformance bind raw
source inventory through the same graph kernel and generic scene assembler as
nuScenes and Argoverse 2. Lazy row-range caches are lifecycle-accounted, label
availability reads only the timestamp projection at startup, and cancellation
and idempotent disposal release eager and lazy allocations. The prepared
Parquet map, Waymo-specific recipe scene and metadata loader, runtime-profile
dispatcher, and their fallback tests have been removed. The deliberately
re-reviewed Waymo recipe hash, all three shipped numeric/capability surfaces,
the full regression suite, production and author-only builds, and Adapter
Amnesia/oracle receipt gates remain green. No held-out rung source was opened
by this checkpoint.

**Implementation checkpoint — 10.P5:** `sourceManifestHash` now hashes the
canonical ordered path/size/full-SHA-256 source subset independently of local
or hosted roots, media metadata, chunking, and credentials. A closed
transport-only `SourceCatalogV1` schema, bounded generator, canonical catalog
hash, deep-frozen validator, and fixed transport-chunk digests feed
`RemoteByteSourceV1` through the same `ByteSourceV1` seam. The remote source
verifies full objects or complete fixed chunks before cache promotion, bounds
range/full/catalog bytes, propagates cancellation, retries transient failures,
keys shared verified cache entries by source identity/path/digest, and fails
with distinct diagnostics for integrity, length/range, budget, CORS, auth,
redirect, URL, and root-confinement failures. Its production binding entry has
no dataset discovery or fallback. Waymo, nuScenes, and Argoverse 2 each execute
their unchanged compiled recipe against both local bytes and an actual
loopback HTTP Range server with equal manifests, metadata, and normalized
frames; transport-negative coverage and the full regression, production,
author-only, Adapter Amnesia, and oracle-receipt suites pass. No held-out rung
source was opened by this checkpoint.

**Implementation checkpoint — 10.P6:** a fetched recipe now crosses the same
256 KiB, closed schema, semantic compiler, registered dependency, and semantic
`recipeHash` gates as local import before hash-keyed cache promotion or
execution. The closed `ShareDescriptorV1` schema, RFC 8785 canonical form,
complete `shareHash`, explicit inline v1 codec, and hash-bound referenced JSON
codec carry source, catalog, recipe, scene/frame/window, stable manifest sensor
IDs, camera pose, overlays, playback, and resolved theme/accent state. URL and
fetch policy requires HTTPS outside loopback, rejects user-info and
credential-bearing references, confines redirects, defaults to omitted
credentials/no referrer, and admits credentials only through an exact-origin
runtime grant. Referenced descriptors are bounded to 64 KiB and hash-verified
before recipe or catalog fetch; ambiguous mixed forms fail closed. The
ordinary browser store binds the fetched recipe/catalog/source directly into
the generic normalized scene, maps stable IDs only after binding, restores the
complete presentation before first Canvas paint, and opens paused. Actual
loopback HTTP counted tests cover a referenced Waymo descriptor and inline
nuScenes/Argoverse 2 URLs from an empty recipe cache, including frame payload
and presentation restoration; ambiguous forms, unavailable dependencies,
hash/schema/identity failures, credential leakage, and cache-boundary
negatives pass. The full 987-test regression, production/author-only builds,
lint (zero errors), Adapter Amnesia, and oracle receipt gates pass. No held-out
rung source was opened by this checkpoint.

#### Normative preflight implementation phases

The remaining preflight is implemented in the following order. These are
sub-phases of Phase 10, not held-out ladder attempts. Every sub-phase starts
from the exact passing head of the previous one, keeps the three shipped
datasets' applicable Phase 9 parity checks green, and leaves all four held-out
rung sources unopened. Passing a later-looking unit in isolation does not
permit skipping an earlier exit gate.

| Sub-phase | Scope | Exit gate |
|---|---|---|
| **10.P1 — shared entry and local byte seam** | Introduce the common recipe-execution entry point, exact versioned reader/operator-profile selection, and transport-neutral bounded local `ByteSourceV1`; route production and isolated conformance binding through that entry. | **Complete.** No `sourceFamily` input remains, local bytes can cross the reader boundary without exposing `File`, and Waymo, nuScenes, and Argoverse 2 retain structural/numeric parity through the shared entry point. Provider-specific preparation and scene bodies are explicitly still transitional. |
| **10.P2 — executable graph kernel and Argoverse 2 migration** | Add the executable core-operator ABI, typed graph values, deterministic topological evaluation, lifecycle/cancellation/resource accounting, and generic `NormalizedSceneV1` assembly. Move the Argoverse 2 recipe first because it exercises Feather, image, timeline join, calibration, boxes, and trajectories with the smallest shipped graph. Production, authoring preview, local import, and isolated conformance must use that graph path. | **Complete.** The finalized Argoverse 2 recipe executes from its declared sources and nodes without a prepared `AV2LogDatabase`, `AV2RecipeScene`, provider-specific scene body, or legacy fallback; its full Phase 9 capability/parity surface and applicable Spec 012 lifecycle/performance cases pass. Waymo and nuScenes parity remains unchanged. |
| **10.P3 — nuScenes graph migration** | Extend the same public graph/value surface only as required by the already shipped nuScenes recipe, including JSON records, token relations, interleaved/PCD point records, NPZ labels, cameras, calibration, boxes, and trajectories. Use raw bound sources rather than a prepared token-table database. | **Complete.** The finalized nuScenes recipe executes end to end through the same graph runtime in production, authoring preview, local import, and isolated conformance, with no prepared `NuScenesDatabase`, `NuScenesRecipeScene`, provider-specific scene body, or legacy fallback. Full nuScenes Phase 9 parity and applicable Spec 012 gates pass; Argoverse 2 and Waymo do not regress. |
| **10.P4 — Waymo graph migration and legacy removal** | Extend the same runtime for the shipped Parquet/range-image graph and its complete optional perception surface, then remove the remaining prepared Parquet/provider scene path and the timeline-only authoring-preview path. Delete obsolete runtime-profile routing once all three recipes execute by their graph. | **Complete.** The finalized Waymo recipe and both previously migrated recipes use one node-by-node executor and generic scene assembler across production, authoring preview, local import, and isolated conformance. No dataset name, `formatId`, bundled identity, filename, transport, prepared database/map, or dataset-specific scene class selects or supplies an alternate runtime. All three Phase 9 parity surfaces and applicable Spec 012 gates pass. This closes the local **One generic recipe executor** requirement below. |
| **10.P5 — source identity, catalog, and remote transport** | Implement canonical `sourceManifestHash`, the closed transport-only `SourceCatalogV1` schema and hash, catalog generation/validation, and `RemoteByteSourceV1` over the same reader contract. Add range/chunk verification, bounded full-object fallback, cancellation, retry, byte budgets, cache identity, URL/root confinement, redirect, CORS, credential, and tamper handling. | **Complete.** Byte-identical local and actually hosted fixtures produce the same `sourceManifestHash`; every shipped recipe binds through both transports without reader/operator changes and retains normalized-frame parity. Specified transport-negative tests pass, catalog-backed production binding has no discovery/fallback path, and verified caches contain only source-identity/path/digest keyed bytes. |
| **10.P6 — portable recipe and share round-trip** | Implement remote recipe fetch/import/cache by `recipeHash`, the closed `ShareDescriptorV1` schema, canonical descriptor/hash and inline/reference URL codecs, explicit presentation serialization, empty-profile restoration, and the existing local recipe-plus-recipient-source handoff. | **Complete.** Each shipped recipe opens its catalog-backed recipe-and-source share URL through the ordinary store path from an empty recipe cache, restores the selected scene/frame and capability-compatible stable sensor/presentation state, and opens paused. Referenced and inline codecs share the closed schema; ambiguous forms, unavailable dependencies, hash/schema/identity failures, credential leakage, and cache-boundary negatives fail as specified. |
| **10.P7 — three-dataset baseline proof and freeze** | Run the complete local↔remote preflight matrix for Waymo, nuScenes, and Argoverse 2; finish the fresh-process evidence harness and public-safe schemas; run Phase 9 Adapter Amnesia, applicable Spec 012 performance/lifecycle cases for both transports, build-boundary scans, perceptual capture, and every required negative case. | One exact baseline commit has passing, retained evidence for every proof in this section and is frozen as the Phase 10 starting point. Only after this gate may content-blind held-out case manifests be frozen and rung 1 source inspection begin. |

The migration order is a complexity gradient, not permission to brand the
runtime. Work learned while migrating Argoverse 2, nuScenes, or Waymo must land
as reusable reader/operator/value/scene behavior identified only by public
contract IDs. Once a recipe has crossed its sub-phase exit gate, its legacy
preparation and scene path is removed rather than retained as a fallback.

`10.P5` precedes sharing because a share descriptor needs a verified,
transport-independent source identity and a real remote byte path. `10.P6`
precedes the baseline freeze because fresh-profile round-trip is part of the
preflight proof, not a post-proof convenience. `10.P7` is the sole transition
from implementation to held-out evaluation; partial success in `10.P2` through
`10.P6` does not authorize opening A2D2, KITTI Raw, ONCE, PandaSet, or their
reserves.

#### One generic recipe executor

The production renderer, authoring preview, local import, and remote URL path
must all execute the same compiled operator graph and bind the same
`NormalizedSceneV1` outputs. The executor may dispatch only by versioned reader
and operator IDs registered in the public operator set. It must not dispatch by
dataset name, `sourceFamily`, bundled-adapter identity, filename, or whether the
bytes came from a local or remote source.

The full graph surface needed by the three shipped recipes must be real in this
shared executor before Phase 10 begins. A timeline-only `json.records` preview
or a binder that hands each known source family to a dataset-specific scene
class does not satisfy the gate, even if it can display a sample frame.

#### One source contract over local and remote bytes

Readers receive a transport-neutral `ByteSourceV1` plus a `SourceInventoryV1`.
The local implementation resolves inventory entries to browser `File` objects.
The remote implementation resolves the same normalized relative paths to
HTTP(S) resources and supports bounded reads, range requests where available,
cancellation, retries, byte limits, and deterministic diagnostics. Reader and
operator behavior above this seam is identical.

Because an HTTP prefix cannot portably enumerate a directory, a remote source
may provide an external, transport-only `SourceCatalogV1`. It contains only its
schema version, normalized relative paths, byte sizes, SHA-256 content digests,
optional media types, optional fixed-size transport-chunk digests, and the
digest of the canonical catalog. Chunk boundaries may exist only to verify
HTTP range responses and must not align to or describe source records. The
catalog must not contain parsed records, schemas inferred from payloads,
semantic byte/row-group indexes, timestamps, calibration, labels,
dataset-specific roles, adapter hints, or a recipe. Paths are canonicalized and
confined beneath the declared source root; absolute paths, traversal,
cross-root redirects, and digest mismatches fail closed before recipe
execution.

`SourceCatalogV1` is hosting metadata outside the unchanged source tree, not a
converted fixture or dataset-semantic sidecar. The remotely served relative
paths and source bytes must match the original selected case. For licensed
data it may live at a private, access-controlled endpoint; access credentials
must not appear in the share URL, recipe, catalog, or public evidence.

`sourceManifestHash` is distinct from `datasetFingerprint`. It is SHA-256 over
the RFC 8785 canonical JSON object `{ version, entries }`, where every entry is
the normalized relative path, exact byte size, and lowercase full-file SHA-256
digest, ordered by normalized path. Source root URLs, local absolute paths,
media types, transport chunking, and credentials are excluded, so the same
unchanged local and remote bytes have the same value. It never participates in
adapter matching and is not stored inside the semantic recipe.

The bounded `datasetFingerprint` remains useful as local provenance and as the
proof that Mystery A and B are different instances; it is not an authorization
or content-integrity boundary. When a share descriptor or evidence record
claims an exact source, a locally selected root is accepted as that source only
after its newly computed `sourceManifestHash` matches the expected one. A
recipe-only import carries no expected source hash and remains free to bind any
compatible source through the normal format-matching and validation path.

A counted remote-share run requires full-file digests for every catalog entry.
Every consumed full object is verified before decode/cache promotion; every
consumed range is verified using fixed-size chunk digests, or the object is
fetched within declared limits and verified in full. An implementation that
checks only filenames, sizes, ETags, or bounded `datasetFingerprint` samples
does not satisfy the gate.

#### Portable recipe and share descriptors

The ordinary UI accepts a recipe by local import or by an HTTP(S) recipe
reference paired with its expected semantic `recipeHash`. A fetched recipe
passes the same size limits, JSON schema validation, semantic compilation,
operator dependency checks, and canonical hash verification as a local import
before it is cached by hash or executed. A recipe reference can select only
already registered operators and extensions; it cannot fetch or install code.

`ShareDescriptorV1` is the complete remote-view contract. Its canonical JSON
form contains these fields; field names and types are normative:

| Object | Fields |
|---|---|
| envelope | `schema: "egolens-share-v1"` |
| `source` | `rootUrl`, `catalogUrl`, `catalogHash`, `sourceManifestHash` |
| `recipe` | `url`, `recipeHash` |
| `view` | `sceneId`, `frameIndex`, optional `t0`/`t1` decimal-int64 strings |
| `presentation` | `cameraStrip`, `coordinateMode`, `visibleSensorIds`, `activeCameraId`, `colormap`, `boxMode`, `trailLength`, `pointSize`, `pointOpacity`, `overlays`, `playbackSpeed`, `followCamera`, `cameraPose`, `theme`, `accent` |

`visibleSensorIds` and `activeCameraId` use stable string IDs from the bound
capability manifest, never dataset-specific numeric slots. `overlays` records
LiDAR projection, 3D keypoints, 2D keypoints, and camera segmentation
independently. `cameraPose` records position, target, azimuth, and distance.
`theme` is the resolved `light` or `dark` value; an `auto` preference is resolved
by the sender so recipient OS settings cannot change a counted shared view.
`accent` is either `null` or six uppercase hexadecimal digits. The encoder
writes explicit JSON values, including defaults, so a later application default
cannot silently change a shared view. Playback's transient playing/paused bit
is not serialized: every shared view opens paused on the selected frame.

The implementation ships a closed JSON Schema for this object. URLs are
absolute strings, hashes are `sha256:` strings, IDs are strings, `frameIndex`
is a non-negative integer, numeric presentation values must be finite and
within the corresponding public control limits, and unknown object fields are
rejected. `catalogHash` covers the exact canonical catalog,
`sourceManifestHash` covers its transport-independent source subset,
`recipeHash` covers recipe semantics, and `shareHash` covers the complete
canonical descriptor.

The canonical inline URL uses `shareVersion=1` plus the following
source/recipe/view keys: `data`, `catalog`, `catalogHash`, `sourceHash`,
`recipe`, `recipeHash`, `scene`, `frame`, `t0`, and `t1`. Existing presentation
keys remain `cameras`, `colormap`, `box`, `world`, `sensors`, `ps`, `opacity`,
`cam`, `trail`, `lidar2d`, `kp3d`, `kp2d`, `camseg`, `speed`, `follow`, `cp`,
`ct`, `az`, `cd`, `theme`, and `accent`. Values are percent-encoded, sensor IDs
are sorted before comma joining, hashes use `sha256:` plus lowercase hex, and
decimal numbers use the shortest finite round-trippable representation except
for int64 timestamps, which remain decimal strings.

The v1 inline encoder writes `frame` even when zero; `cameras`, `world`, all
overlay flags, and `follow` as explicit `0`/`1`; `cam=none` for no active
camera; `sensors=none` for an empty selection; and `accent=default` for a null
accent. It also writes the remaining presentation keys at their current values
rather than omitting application defaults. `t0` and `t1` are the only optional
pair and must appear together. The inline decoder first expands this wire form
into a complete `ShareDescriptorV1`, then applies the same schema validation as
referenced JSON. Legacy URLs without `shareVersion=1` retain their existing
best-effort parser but cannot satisfy a counted round-trip proof.

Alternatively, a URL may contain only `share=<absolute descriptor URL>` and
`shareHash=<descriptor hash>` plus page-envelope parameters. A fetched
descriptor is limited to 64 KiB, parsed as JSON, canonicalized with RFC 8785,
and verified before any source or recipe fetch. Mixing referenced-descriptor
mode with inline identity or view keys is `SHARE_DESCRIPTOR_AMBIGUOUS` and fails
closed; cached state never overrides either representation. `embed`, `controls`,
and `origin` remain page-envelope parameters governed by the embed specs and
may coexist with either representation, but a descriptor cannot widen the
allowed embed origin.

Source and recipe identity must never be inferred from a dataset enum. Sensor
state is validated against the bound scene manifest; no fixed sensor count or
built-in sensor-name list is allowed. Unknown presentation IDs produce a
structured partial-restore diagnostic in ordinary use and fail a counted
round-trip proof. Identity/hash/schema errors always fail the load and may not
fall back to a bundled registry entry. Presentation state does not affect the
recipe hash. Opening the link in an empty browser profile must fetch/validate
the descriptor when used, recipe, and catalog; bind the remote bytes; and
restore the view without an agent call, developer tooling, or a prior local
import.

A local-only drop remains intentionally non-shareable by URL because the
browser cannot grant another user access to local files. A portable local
handoff consists of the exported recipe plus a recipient-selected matching
source root; the same recipe must work when those unchanged bytes are later
hosted behind a valid remote catalog.

#### Remote fetch and authorization rules

Production recipe, descriptor, catalog, and source URLs use HTTPS. Plain HTTP
is allowed only for loopback development and isolated conformance fixtures.
URLs containing user-info are rejected. Relative source paths are resolved
with the URL standard against a trailing-slash root and then rechecked for
root confinement after normalization and every redirect.

Cross-origin endpoints must explicitly allow the EgoLens application origin
through CORS, allow `Range` when range reads are required, and expose the
response headers needed for length, range, cache, and digest validation. Fetches
use `credentials: "omit"` and `referrerPolicy: "no-referrer"` by default. A
private endpoint may receive cookies only after a separate, explicit
user-mediated grant switches fetches to `credentials: "include"` for that exact
origin; the grant is browser state, is not serialized, and is never forwarded
across an origin redirect. Cross-origin or cross-root redirects fail closed.

If a server ignores `Range`, EgoLens may fetch the complete object only when its
catalog size and configured source limits permit it; otherwise it returns the
deterministic `REMOTE_RANGE_REQUIRED` diagnostic. CORS denial, missing exposed
headers, authentication failure, length/digest mismatch, and retry exhaustion
have distinct diagnostics and never trigger dataset-specific URL discovery or
a local/bundled fallback. Recipe caches are keyed by `recipeHash`; source and
range caches are keyed by `sourceManifestHash`, normalized path, and verified
content or chunk digest, not by a mutable URL or credential.

#### Preflight proofs

Before the first rung is opened, Waymo, nuScenes, and Argoverse 2 must each pass
all of the following with the Phase 9 finalized recipe and no agent call:

1. bind the original local source through `ByteSourceV1`;
2. bind byte-identical remotely hosted source paths through
   `SourceCatalogV1` and the HTTP implementation;
3. prove the same `sourceManifestHash` across the local and remote source while
   retaining the same semantic recipe hash, compatible format/operator-set
   fingerprints, capability manifest, structural/numeric observations, and
   perceptual signatures on the declared conformance frames; and
4. round-trip a share URL into an empty profile and restore the same selected
   scene/frame and presentation state.

The baseline must use the exact three blind-authored recipes finalized by the
Phase 9 run. Each semantic recipe hash comes from the verified author
attestation and its signed hidden-oracle receipt; it is not a predeclared hash
of a bundled recipe. Local, remote, and share replay for a dataset all bind that
same attested hash, and the baseline freeze records the attestation, aggregate
gate, signing-key identity, per-dataset receipt hash, and the exact clean judge
tool commit and judge version (`spec013-phase9-v1`) that signed those receipts;
that judge commit must equal the Phase 10 verifier's operator-pinned tool
commit. No held-out rung source is opened while establishing or correcting this
binding.

The baseline must also pass the Phase 9 Adapter Amnesia gates, applicable Spec
012 performance/lifecycle scenarios for both transports, production/isolated
build-boundary scans, and negative tests for catalog traversal, CORS,
credential isolation, redirects, tampering, oversized responses, aborts,
missing range support, source/recipe/descriptor hash mismatch, ambiguous share
forms, and unavailable registered extensions.

Finally, the Phase 10 harness and public-safe evidence schemas must already
support fresh browser processes, precommitted case/reserve manifests, local
`A`, persisted-local `B`, imported-local `B`, remote-share `B`, revision
lineage, human-review receipts, first-failure capture, and the taxonomy below.
No candidate-specific contract or operator work may begin, and no rung source
bytes may be parsed or semantically inspected beyond the content-blind case
freeze above, until this entry-gate evidence is frozen for the exact baseline
commit.

### 3. Use a four-rung generalization ladder

The ladder order increases format, synchronization, scale, and security
pressure without starting from the hardest serialization boundary.

| Rung | Original unsupported dataset | Expected pressure | Official references |
|---:|---|---|---|
| 1 | A2D2 | NPZ/JSON/image readers, six cameras, five LiDAR units, calibration, semantic point/image data, and 3D boxes | [dataset distribution](https://registry.opendata.aws/aev-a2d2/), [paper](https://arxiv.org/abs/2004.06320) |
| 2 | KITTI Raw | interleaved binary point clouds, image streams, timestamp and calibration text, OXTS, XML tracklets, and transform composition | [raw dataset](https://www.cvlibs.net/datasets/kitti/raw_data.php) |
| 3 | ONCE | seven cameras, binary LiDAR, JSON calibration/poses/boxes, long timelines, and large original roots | [dataset](https://once-for-auto-driving.github.io/), [format](https://once-for-auto-driving.github.io/documentation.html), [terms](https://once-for-auto-driving.github.io/terms_of_use.html) |
| 4 | PandaSet | two LiDAR types, six cameras, world-frame points and poses, cuboids/segmentation, compressed pickle input, and the trusted extension boundary | [dataset](https://pandaset.org/), [devkit format](https://github.com/scaleapi/pandaset-devkit) |

The expected-pressure column is a planning hypothesis, not permission to add
those capabilities before a failing observation. Each rung begins from the
runtime that passed the previous rung.

Dataset files remain user-controlled. Local authoring/reuse cases stay local;
the remote-share B proof may read byte-identical paths from a separate endpoint
that the operator and recipient are authorized to access. Dataset bytes are not
committed, bundled, uploaded to GitHub Actions, served by the deployed EgoLens
application, or copied into a public test artifact. Every run must comply with
the official terms for the exact release. Until an evidence-retention review
confirms otherwise, screenshots and other media-derived diagnostics remain
local or protected; public artifacts contain recipes, hashes, diagnostic
codes, measurements, and signed pass/fail statements only.

### 4. Freeze discovery and held-out cases before inspection

For every rung, a coordinator who is not the counted authoring agent commits a
case manifest containing an ordered set of distinct original cases:

1. `D` — discovery case, allowed to expose a platform limitation;
2. `A` — unopened authoring and human-correction case;
3. `B` — unopened fingerprint-reuse case;
4. one or more ordered reserves for consumed `A` or `B` cases.

The manifest is content-addressed and fixed before the first bounded inspection
of `D`. Dataset contents are not embedded in it. `D` never counts as held-out
proof and may be revisited while implementing a generic improvement.

Opening an `A` or `B` case consumes it if the observation leads to an
application, contract, operator, recipe, or test-protocol change. A consumed
case may remain a regression fixture but can no longer supply final held-out
evidence. The next precommitted unopened reserve takes its role. Case selection
may not be changed merely because a scene is difficult or produces an
unfavorable result.

This separation allows the product to learn from real failures without calling
a test case held out after implementation has been tuned to it.

### 5. Run the same A/B protocol at every rung

#### Discovery

1. Start the exact deployed candidate build in a fresh browser profile.
2. Drop the unmodified `D` case through the ordinary directory/file picker.
3. Expose only bounded source inventory/inspection, the public contract, the
   registered generic operator catalog, diagnostics, and the five public
   Teachable Lens tools.
4. Record the first terminal success or failure before changing code.
5. Classify any failure using the taxonomy in this spec.

Official documentation may be consulted during planning and post-failure
triage. A counted authoring attempt may not mount a devkit or documentation
bundle, call a reference loader, or fetch an existing adapter. Network egress
is disabled for the isolated authoring workspace.

#### Mystery A — authoring and human correction

After discovery-driven changes are frozen:

1. Start a new browser process and empty user-data directory at the deployed
   candidate URL.
2. Drop the unopened, unmodified `A` case.
3. Author a recipe through the five public WebMCP tools without changing
   application code or installing executable code from the recipe.
4. Bind and render all capability families declared for the case. Partial
   LiDAR/timeline success does not count when cameras, poses, boxes, labels, or
   cross-output relations are present.
5. Exercise a real semantic human correction. The review must identify a
   visible coordinate, calibration, synchronization, association, label, or
   equivalent scene defect; bind the rejected and corrected recipe hashes;
   identify reviewed capabilities and frames; and produce a new semantic recipe
   hash. A cosmetic title or presentation edit is not a correction.
6. Prove that the rejected/invalid revision preserves the last good scene,
   then finalize and export the corrected JSON recipe.

The run records tool calls and revision lineage. Application source changes,
developer-console injection, manual recipe-file edits, or direct IndexedDB
edits invalidate the attempt.

#### Mystery B — reuse without an agent

With the finalized `A` recipe unchanged:

1. Stop the entire browser process. A page reload alone is insufficient.
2. Start the deployed URL in a new browser process using the persisted
   origin-scoped profile, then drop the unopened, unmodified `B` case.
3. Require the format fingerprint to select the corrected `A` recipe without
   any WebMCP tool execution or agent call.
4. Require a different dataset fingerprint, the same semantic recipe hash,
   compatible operator-set fingerprint, complete declared capabilities, and a
   valid live render.
5. Repeat in an empty profile by importing the exported JSON through the
   ordinary UI before dropping `B`; selection and loading must again occur
   without an agent.
6. Host the same unchanged `B` relative paths and bytes behind a
   `SourceCatalogV1`, then open its recipe-and-source share URL in another empty
   profile. Require the same `sourceManifestHash` as both local B runs, the
   expected catalog and recipe hashes, the same selected format recipe and
   declared capabilities, valid live rendering, and restored scene/frame and
   presentation state without an agent or prior import.

All three B runs are cold browser-process runs. The first proves persisted
local reuse, the second proves portable local import, and the third proves
portable remote sharing. None may fall back to dataset identity, scene ID,
exact filenames from `A`, a bundled registry entry, or a transport-specific
recipe. The remote run may use an access-controlled endpoint when required by
the dataset terms, but the browser running the share link must already possess
any independent access grant; credentials are not serialized into the link.

### 6. Classify failures before changing a contract

| Classification | Evidence | Correct response |
|---|---|---|
| Source limitation | The official case does not contain the timestamp, pose, calibration, label, or relation | Omit the unavailable capability with an explicit diagnostic; never infer or fabricate source truth |
| Generic reader/operator gap | The source concept fits the current recipe and normalized outputs, but no safe registered reader or transform can produce it | Add or extend a versioned dataset-neutral operator with deterministic fixtures |
| Extension/security gap | A codec or container requires separately reviewed executable logic or presents unsafe/unbounded parsing behavior | Add a pinned, integrity-checked trusted extension with worker/resource limits; recipes cannot install it |
| Authoring-observability gap | The engine can express and execute the result, but bounded inspection or diagnostics do not expose enough evidence to author it | Improve the public inspection/diagnostic contract without exposing arbitrary file access |
| Runtime/resource gap | A valid plan exceeds browser time, memory, cache, transfer, worker, or rendering limits | Improve streaming, indexing, cancellation, ownership, or bounded caching and rerun performance/lifecycle gates |
| Recipe contract gap | The generic graph cannot declare a required safe deterministic operation despite an available implementation model | Extend the recipe schema/compiler compatibly and document migration/fingerprint effects |
| Normalized-scene contract gap | Correct source semantics cannot be represented without information loss at the renderer boundary | Propose a versioned normalized-scene addition and update every affected renderer/bridge |

Contract expansion is the last response, not the default response. A proposal
to change the recipe or normalized-scene contract must:

- cite the preserved first-failure artifact and exact source semantics;
- show that the limitation is not a missing source fact, parser, transform,
  inspection result, or resource optimization;
- describe at least one additional plausible dataset or application that needs
  the same generic concept;
- contain no dataset names or case-specific path rules in the new contract;
- define validation, canonicalization, hashing, diagnostics, migration, and
  backwards-compatibility behavior;
- receive a new numbered normative spec when it changes an established
  contract decision.

Breaking changes do not silently mutate v1. They require a new version or an
explicit deterministic migration.

### 7. Preserve the executable-code boundary

Original-data support does not weaken the recipe security model. When a format
such as compressed pickle cannot be decoded by an admitted operator, the
authoring session returns `CAPABILITY_GAP`; it does not deserialize arbitrary
objects, install a package, fetch code, or embed code in the recipe.

A later repository change may provide a generic trusted extension. That
extension must be reviewed and pinned before a counted replacement A/B attempt,
execute in the dedicated Worker boundary, accept only an explicitly supported
safe subset, enforce input/allocation/output/time limits, and participate in
the operator-set and recipe dependency fingerprints. A missing or mismatched
package still fails before reading dataset payloads.

An extension may be motivated by one rung, but its public name and contract
must describe the format or operation rather than the dataset.

### 8. Make improvements cumulative

Every change motivated by a rung must pass, on the same exact candidate commit:

- its deterministic unit, malicious-input, compiler, and runtime tests;
- the current rung's discovery and replacement A/B protocol;
- every previously promoted Phase 10 rung;
- the Phase 9 Adapter Amnesia structural, numeric, and perceptual gates for
  Waymo, nuScenes, and Argoverse 2;
- the relevant Spec 012 performance/lifecycle scenarios when the change affects
  parsing, scheduling, caching, workers, transfer, rendering, or disposal;
- production and isolated author-workspace build-boundary scans.

A new dataset may reveal that a previous recipe was accidentally relying on
undefined behavior. The undefined behavior is fixed generically and all
earlier evidence is regenerated; the new dataset does not receive a private
compatibility branch.

## Evidence contract

Each attempt produces a public-safe `GeneralizationAttemptV1` record containing:

- exact application commit, deployed URL identity, browser version, platform,
  viewport, and cold-profile mode;
- source-case manifest hash and official release identity;
- source manifest, source catalog, and share descriptor hashes for every mode
  in which they apply;
- phase (`D`, `A`, persisted-local `B`, imported-local `B`, or remote-share
  `B`) and whether the case was unopened at start;
- public tool catalog, tool-call counts, network policy, and mounted-resource
  attestation;
- recipe/artifact/format/dataset/operator-set fingerprints and full revision
  lineage;
- declared and successfully bound capabilities;
- structured diagnostics and the failure classification, if any;
- human-review receipt for `A`, tied to exact before/after recipe hashes and
  reviewed frames;
- bounded structural, numeric, cross-output, perceptual-signature, performance,
  and resource-lifecycle observations;
- pass/fail and integrity hash.

No hidden adapter or exact-output oracle exists for these datasets. Passing is
therefore based on public schema/compiler validation, deterministic operator
contracts, source-derived invariants, cross-output consistency, capability
coverage, live human review, and A-to-B reuse. The result must not be described
as exact parity with an unexecuted official devkit.

The implementation maintains an append-only evidence/decision ledger outside
this point-in-time spec. It records the first failure, classification, chosen
layer, generic change, consumed cases, replacement cases, and regression
results. Any normative contract change is captured in a later numbered spec.

## Phase 10 exit gate

Phase 10 is complete only when all of the following hold:

- [ ] The Phase 10 transport/runtime preflight (`10.P1` through `10.P7`) is
      frozen before any rung source bytes are parsed or semantically inspected
      beyond the explicitly allowed
      content-blind case enumeration/hashing, including a shared full-scene
      executor, local/remote source seam, remote source catalog, recipe/share
      URL contracts, evidence harness, and Waymo/nuScenes/Argoverse 2
      local↔remote parity.
- [ ] A2D2 passes an unmodified original-data A authoring/human-correction run
      and all three no-agent B cold runs.
- [ ] KITTI Raw passes an unmodified original-data A authoring/human-correction
      run and all three no-agent B cold runs.
- [ ] ONCE passes an unmodified original-data A authoring/human-correction run
      and all three no-agent B cold runs.
- [ ] PandaSet passes an unmodified original-data A authoring/human-correction
      run and all three no-agent B cold runs.
- [ ] Every retained passing A/B case was unopened at the beginning of its
      counted role; consumed cases are identified but never reused as held-out
      evidence.
- [ ] No counted case was renamed, converted, repacked, pre-indexed, stripped
      of required modalities, or supplemented by an EgoLens-specific sidecar.
- [ ] No dataset-branded runtime, operator, registry branch, hidden adapter, or
      reference devkit participates in authoring, matching, or rendering.
- [ ] Every discovered failure has a preserved first-failure artifact and a
      justified classification; contract changes satisfy the stricter decision
      rule in this spec.
- [ ] All four finalized recipes remain portable JSON-only artifacts, and any
      executable dependency is a separately registered pinned extension.
- [ ] The exact final commit passes all four promoted rungs plus Phase 9
      self-hosting and applicable Spec 012 performance/lifecycle gates.
- [ ] Public evidence contains no raw licensed data, absolute local paths,
      credentials, or media retained without an explicit terms review.

After this gate passes, Spec 006 may advance to `shipped`. A successful
single-dataset demo, a converted fixture, an agent-assisted B run, or a result
that bypasses unsupported original bytes is not sufficient.
