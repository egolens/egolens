# Next: Waymo Segmentation + Keypoints Implementation Plan

4 Waymo v2 perception component visualizations.

## Preliminary Work Completed (4f74eb2)

The following items have already been implemented. No additional scaffolding needed for each feature implementation:

- [x] `download.sh` — includes `lidar_segmentation`, `camera_segmentation`, `lidar_hkp`, `camera_hkp` (63a539b)
- [x] `DatasetManifest` type extension — added optional fields `overlayModes`, `annotationModes`, `semanticPalette`, `semanticLabels` (`src/types/dataset.ts`)
- [x] `waymoManifest` + `nuScenesManifest` updated — reflects new fields, palette linked
- [x] Waymo 23-class semantic palette — `src/utils/waymoSemanticClasses.ts` (WAYMO_SEG_PALETTE, WAYMO_SEG_LABELS)
- [x] 14 keypoint types + skeleton bone definitions — `WAYMO_KEYPOINT_TYPES`, `WAYMO_SKELETON_BONES` (same file)
- [x] `upng-js` installed + `src/types/upng-js.d.ts` type declaration — for camera_segmentation uint16 PNG decoding
- [x] `OverlayMode`, `AnnotationMode` types — exported from `src/types/dataset.ts`
- [x] `computePointColor()` + `instanceColor()` palette parameterized — resolve based on manifest.semanticPalette, maintain LIDARSEG_PALETTE fallback (4de9fc0)
- [x] lidar vs lidar_segmentation RG structure analysis — **RG structure completely different** (lidar 4 RGs vs seg 1 RG), TOP sensor only, every 5 frames apart, timestamp matching required, confirmed pre-load all strategy

## Spike Validation Completed (3 required before Phase A starts)

### Spike 1: UPNG uint16 Decoding Validation ✅

End-to-end validation completed with actual `camera_segmentation` parquet data.

**Results**:
- `UPNG.decode()` → `depth=16`, `ctype=0` (grayscale) returns normally
- **Important**: `readAllRows()` requires `utf8: false`. Default decodes BYTE_ARRAY to String, corrupting PNG binary
- `UPNG.decode().data` returns **defiltered data + H trailing bytes**
  - `data.byteLength = W × H × 2 + H` (1 byte residual per row)
  - Valid pixel data: first `W × H × 2` bytes only, big-endian uint16
  - stride = `W × 2`, filter byte removal unnecessary (UPNG already defilters)
- Performance: 1920×1280 PNG decoding **~22ms** (5-run average), 1920×886 estimated ~15ms
  - 5 cameras simultaneous: ~110ms → potential jank on frame switch → `requestIdleCallback` or sequential decoding recommended
- **Camera resolution**: FRONT/LEFT/RIGHT = 1920×1280, SIDE_LEFT/SIDE_RIGHT = 1920×886

**Important Discovery: Camera Segmentation uses different 29-class palette than LiDAR**

| LiDAR seg (23 classes, 0-22) | Camera seg (29 classes, 0-28) |
|------------------------------|-------------------------------|
| 0: Undefined | 0: Undefined |
| 1: Car | 1: Car |
| 2: Truck | 2: Bus |
| 3: Bus | 3: Truck |
| ... | 4: Other Large Vehicle |
| | 5: Trailer |
| | 6: Ego Vehicle |
| 10: Pedestrian | 9: Pedestrian |
| | 12: Ground Animal |
| | 13: Bird |
| 18: Building | 19: Building |
| 14: Road | 20: Road |
| | 25: Sky (camera-only!) |
| | 26: Ground |
| | 27: Static |
| | 28: Dynamic |

**Action required for Phase A**:
- Add `WAYMO_CAMERA_SEG_PALETTE` (29 entries) + `WAYMO_CAMERA_SEG_LABELS` to `waymoSemanticClasses.ts`
- Add `cameraSemanticPalette?: [number,number,number][]` optional field to `DatasetManifest` (or reference separate palette in manifest for camera seg)
- Keep existing `WAYMO_SEG_PALETTE` (23 classes) for LiDAR segmentation only

### Spike 2: segLabelFrames Indexing Validation ✅

In `segLabelFrames: Set<number>`, `number` is **frameIndex** (0-based, `timestampToFrame.get(ts)` result).

**Measured data** (segment `10455472...`):
- Master frame list: 199 frames
- lidar_segmentation: 30 frames, frameIndices = {25, 30, 35, ..., 170}, **exactly 5 frames apart**
- camera_segmentation: 20 frames, frameIndices = {24, 28, 30, 32, 36, 74, 78, 80, 82, 86, ...}, **irregular spacing** (4-2-2-4-38 pattern repeating)
- lidar_hkp: 68 frames, irregular spacing

**Mapping logic** (implemented in Phase A `loadWaymoMetadata()`):
```typescript
// Extract unique timestamps from seg parquet
const segTimestamps = [...new Set(segRows.map(r => r['key.frame_timestamp_micros'] as bigint))]
// Convert using master frame list's timestampToFrame
const segLabelFrames = new Set<number>()
for (const ts of segTimestamps) {
  const fi = bundle.timestampToFrame.get(ts)
  if (fi !== undefined) segLabelFrames.add(fi)
}
```

### Spike 3: camera_seg loading performance — async separation unnecessary ✅

**Benchmark** (Node.js, single segment):

| Component | File Size | Rows | Load Time |
|-----------|-----------|------|-----------|
| **Existing metadata total** | ~2.4 MB | ~63K | **409 ms** |
| lidar_segmentation | 952 KB | 30 | 3 ms |
| lidar_hkp | 66 KB | 139 | 8 ms |
| camera_hkp | 337 KB | 1,807 | 17 ms |
| camera_segmentation | 3,055 KB | 100 | 39 ms |
| **New total** | ~4.4 MB | ~2K | **68 ms** |
| **Grand total** | | | **476 ms** |

camera_segmentation's 39ms is only 8% of total loading (476ms). **Sequential loading within existing `loadWaymoMetadata()` is sufficient without async separation.**
However, use `utf8: false` + specify only required columns in `readAllRows()` to avoid unnecessary column decoding.

---

## Core Principle: Data-Driven UI

**If file doesn't exist, gracefully skip and hide related UI itself.**

- Parquet file doesn't exist or fails to open → `console.warn` then skip, no error thrown
- Don't render UI controls for features with unloaded data:
  - No `lidar_segmentation` → exclude `'segment'` from colormapModes
  - No `lidar_hkp` / `camera_hkp` → hide keypoint toggle buttons
  - No `camera_segmentation` → hide camera seg overlay toggle
- Discrimination method: add `hasSegmentation`, `hasKeypoints`, `hasCameraSegmentation` booleans to store
  - True if that parquet opened successfully during metadata loading and has 1+ rows
  - Conditional rendering in UI components using these flags
- Already `hasBoxData` pattern exists (hide box mode UI when no box data) → follow same pattern

### UI Rendering Logic: manifest ∩ store

```
manifest declares             store confirms           UI shows
──────────────────────────    ──────────────────────    ────────────
'segment' in colormapModes    hasSegmentation=true      segment button visible
'keypoints2d' in overlayModes hasKeypoints=true         2D keypoint toggle visible
'keypoints3d' in annotationModes hasKeypoints=true      3D skeleton toggle visible
'segmentation' in overlayModes  hasCameraSegmentation=true  cam seg toggle visible
```

> When adding new datasets, only define manifest and UI follows automatically.
> Even same dataset: if data varies by segment, store flags reflect dynamically.

---

## Dependency Graph

```
Phase A: Shared Infra (common foundation)
    │
    ├──→ Phase B1: lidar_segmentation (independent)
    │
    ├──→ Phase B2: lidar_hkp (independent, can parallel with B1)
    │         │
    │         └──→ Phase C1: camera_hkp (depends on B2's skeleton definition + toggle state)
    │
    └──→ Phase C2: camera_segmentation (depends on A's Timeline markers + upng infra)
              │
              └──→ Phase D: Integration & Polish (after B1+B2+C1+C2 all complete)
```

**Parallelizable combinations**: B1 ∥ B2, C1 ∥ C2 (but C1 requires B2 complete)

---

## Phase A: Shared Infrastructure

**Goal**: Build once the store flags, MetadataBundle extension, worker protocol, and Timeline marker infrastructure shared by all features.

### A-1. Store has* flags + MetadataBundle extension

**Modified files**: `src/types/dataset.ts`, `src/stores/useSceneStore.ts`, `src/adapters/waymo/metadata.ts`

**Work**:
1. Add optional fields to `MetadataBundle`:
   - `hasSegmentation?: boolean`
   - `hasKeypoints?: boolean`
   - `hasCameraSegmentation?: boolean`
   - `segLabelFrames?: Set<number>` — frame indices with seg labels
   - `keypointFrames?: Set<number>` — frame indices with keypoints
   - `cameraSeg?: Map<bigint, Map<number, { panopticLabel: ArrayBuffer, divisor: number }>>` — (populated in Phase C2)
   - `keypointsByFrame?: Map<bigint, ParquetRow[]>` — 3D keypoint rows
   - `cameraKeypointsByFrame?: Map<bigint, ParquetRow[]>` — 2D keypoint rows
2. Add to `SceneState`:
   - `hasSegmentation: boolean` (default false)
   - `hasKeypoints: boolean` (default false)
   - `hasCameraSegmentation: boolean` (default false)
   - `showKeypoints: boolean` (default false, controls 3D+2D together)
   - `segLabelFrames: Set<number>` (default empty)
   - `keypointFrames: Set<number>` (default empty)
   - `cameraSeg: Map<...> | null`
   - `keypointsByFrame: Map<...> | null`
   - `cameraKeypointsByFrame: Map<...> | null`
3. Add to `SceneActions`:
   - `toggleKeypoints(): void`
4. In `loadWaymoMetadata()`, attempt to open seg/hkp/camera_seg/camera_hkp parquets:
   - Open fails → `console.warn` + skip (has* = false)
   - Open succeeds → has* = true + build sparse frame index
   - **hkp/camera_hkp are ~29KB/~116KB very small, can readAllRows() all**
   - **lidar_seg loaded in worker** (metadata only confirms file exists + builds frame index)
   - **camera_seg also loaded in metadata** (~2.3MB, readAllRows() → cache PNG bytes)
5. In store's `loadDataset()` → `unpackMetadata()` unpack new fields

### A-2. Worker Init Protocol Extension

**Modified files**: `src/workers/waymoLidarWorker.ts`, `src/stores/useSceneStore.ts`

**Work**:
1. Add `segUrl?: string | File` field to `WaymoLidarWorkerInit`
2. In worker init handler, if `segUrl` given:
   - `openParquetFile(segUrl)` → `readAllRows()` → build `Map<bigint, Map<number, {shape, values}>>`
   - Cache this Map internally in worker (init 1x only)
3. Call worker init from store with `segUrl` (url/file from parquetFiles.get('lidar_segmentation'))
4. Don't change `WorkerInitBase` (stay dataset-agnostic). Add only to Waymo-specific init.

### A-3. Timeline Marker Infrastructure

**Modified files**: `src/components/Timeline/Timeline.tsx`

**Work**:
1. `Timeline` subscribes to `segLabelFrames`, `keypointFrames` from store
2. Render dot markers above scrubber track (position = frameIndex / totalFrames × 100%)
3. Marker color scheme:
   - seg frames → `#00CCFF` (cyan dot, 2px)
   - keypoint frames → `#CCFF00` (lime dot, 2px)
   - camera seg frames → `#FF44FF` (magenta dot, 2px)
4. Markers show only when feature active:
   - seg marker → when `colormapMode === 'segment'`
   - keypoint marker → when `showKeypoints === true`
   - camera seg marker → when camera seg overlay ON

### A-4. Colormap 'segment' Dynamic Gating

**Modified files**: `src/adapters/waymo/manifest.ts`, `src/components/LidarViewer/LidarViewer.tsx`

**Work**:
1. Add `'segment'` to `waymoManifest.colormapModes` (static declaration)
2. When rendering colormap buttons, filter: `manifest.colormapModes.filter(mode => mode !== 'segment' || hasSegmentation)`
3. This achieves 2-stage gating: manifest says "this dataset can support segment", store says "this segment has actual data"

**Acceptance Criteria**:
- [ ] Existing features work normally in segments with `hasBoxData` (no regression)
- [ ] Loading segments without seg/hkp/camera_seg/camera_hkp parquets produces no errors, has*=false
- [ ] Timeline component has marker rendering slot ready (empty Set = 0 markers)
- [ ] `showKeypoints` toggle exists and works (UI hidden when no data)
- [ ] segment mode button hidden when hasSegmentation=false
- [ ] All 27 existing tests pass

**Concerns**:
- Verify adding optional fields to `MetadataBundle` doesn't impact nuScenes/AV2 adapters (optional so OK, but type-check)
- ~~`loadWaymoMetadata()` execution time increase~~ → **benchmark complete: +68ms (409ms → 476ms existing). async separation unnecessary**
- Watch for missing initializations in reset() for new state fields
- **camera_segmentation `readAllRows()` must pass `utf8: false`** (PNG bytes become corrupted if converted to String)
- **Camera seg palette**: separate `WAYMO_CAMERA_SEG_PALETTE` (29 classes) + `WAYMO_CAMERA_SEG_LABELS` needed. Add `cameraSemanticPalette` reference to `waymoManifest`

**Estimated effort**: 2–3 hours

---

## Phase B1: lidar_segmentation — LiDAR 23-class Semantic Segmentation

**Prerequisite**: Phase A (store flags, worker protocol, Timeline markers, colormap gating)
**Follow-on**: None (self-contained)

### Data Format

Same structure as range image `[H, W, 2]` — channel 0 = semantic class, channel 1 = instance ID
- Column: `[LiDARSegmentationLabelComponent].range_image_return1.values` + `.shape`
- Key: `key.frame_timestamp_micros`, `key.laser_name`
- File size: ~850KB (can load all at startup)

### RG Structure Analysis Results (validated with real data)

```
                    lidar                    lidar_segmentation
RG count            4 (256, 256, 256, 222)   1 (all)
Total rows          990                      20~30
frames              198 (all)                20~30 (sparse, every 5th frame)
sensors/frame       5 (laser 1~5)            1 (laser 1 = TOP only)
File size           ~176MB                   ~850KB
```

- **RG structure completely different** → can't sync RG indices, must match timestamps
- **TOP sensor only (laser_name=1)** has seg labels → other 4 sensors have segLabels=null
- **Every 5 frames apart** (2Hz), starting from frame 24. 20~30 frames per segment
- seg frames scattered across lidar's **4 RGs**

### Implementation Strategy (based on RG analysis)

Since seg file is ~850KB, **load all in worker init + timestamp-indexed Map**:

```
At init time:
  segFile → readAllRows() → Map<bigint, Map<number, {shape, values}>>
  (timestamp → laser_name → range image seg data, ~30 entries)

At loadBatch(batchIndex) time:
  lidar RG decode → frameGroups (by timestamp)
  For each frame, each sensor:
    segMap.get(timestamp)?.get(laserName) exists?
      → extract per-point labels using same coords as range image
      → SensorCloudResult.segLabels = Uint8Array
    else → segLabels = undefined (no seg data for this frame/sensor)
```

### Implementation Work

1. **waymoLidarWorker.ts** — in init, `readAllRows()` seg parquet → build timestamp Map
   - Skip if no `segUrl` (segment without seg)
   - Init time target: +50ms max (850KB readAllRows)
2. **waymoLidarWorker.ts** — in loadBatch, timestamp lookup + extract per-point labels
   - range image `[H, W, 2]`, channel 0 = semantic class
   - Same indexing as lidar range image conversion for valid pixels only (`ri_row * W + ri_col`)
   - Inject segLabels in `convertAllSensors()` or post-processing
3. **SensorCloudResult** — `segLabels: Uint8Array` field already exists (for nuScenes), reuse for Waymo
4. **PointCloud.tsx** — in segment mode, handle non-TOP sensors:
   - No `segLabels` on sensor → gray (#808080) + opacity 0.3
5. **LidarViewer.tsx** — add 'segment' to colormap toggle (Phase A does gating infra)
6. **Timeline.tsx** — activate `segLabelFrames` markers (Phase A does infra)

### Acceptance Criteria

- [ ] Selecting segment colormap mode renders TOP sensor points in 23-class colors
- [ ] Non-TOP sensors (FRONT, SIDE_L, SIDE_R, REAR) show as gray (#808080, opacity 0.3)
- [ ] Frames without seg labels: segment mode → auto-fallback to previous colormap (intensity) + console warning
- [ ] Load folder without `lidar_segmentation` parquet → 'segment' button not shown, no error
- [ ] Timeline shows seg frame markers (cyan dots) at correct positions (only when segment mode active)
- [ ] Performance: segment colormap vs existing colormap frame render time **+5ms max**
- [ ] Worker init time: including seg loading **+100ms max**
- [ ] Segment switch: previous segMap garbage collected (no memory leak)
- [ ] Existing intensity/range/elongation/camera colormap modes regression-free
- [ ] Vitest: add unit tests for timestamp matching logic (frames with/without seg, edge cases)

### Concerns & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| range image coordinate indexing error — seg and lidar H×W differ | seg labels assigned to wrong points | Add assert comparing seg `.shape` and lidar `.shape` |
| worker `readAllRows()` failure (corrupt parquet) | worker init fails entirely | try-catch → segMap = null, continue without segLabels |
| instance ID (channel 1) ignored, panoptic mode later hard | re-parsing needed if panoptic added later | cache channel 1 too (memory +64KB, negligible) |
| seg frame spacing varies by segment (assume 5-frame intervals) | marker positions inaccurate in some segments | Don't assume, compute dynamically from actual timestamps |

**Estimated effort**: 3–4 hours

---

## Phase B2: lidar_hkp — 3D Human Keypoints (14 joints)

**Prerequisite**: Phase A (store flags, Timeline markers, showKeypoints toggle)
**Follow-on**: Phase C1 (camera_hkp shares skeleton definition + toggle state)

### Data Format

Per-object keypoint coordinates
- Column: `[LiDARKeypointComponent].keypoint.location_m.{x,y,z}`, `.type` (int8)
- Key: `key.frame_timestamp_micros`, `key.laser_object_id`
- File size: ~29KB (very small)

### Implementation Work

1. **metadata.ts** — in `loadWaymoMetadata()`, `readAllRows()` `lidar_hkp`
   - Build per-frame×object Map: `Map<bigint, KeypointObject[]>`
   - `KeypointObject = { objectId: string, joints: { type: number, x: number, y: number, z: number }[] }`
   - Build `keypointFrames: Set<number>` (for Timeline markers)
2. **KeypointSkeleton.tsx** new component (Three.js)
   - Input: `KeypointObject[]` (all pedestrians in current frame)
   - Joints: `<mesh><sphereGeometry args={[0.08, 8, 8]} />` (8cm radius)
   - Bones: `<Line points={[jointA, jointB]} lineWidth={2} />` (drei Line)
   - Read bone connections from `WAYMO_SKELETON_BONES` (already defined)
3. **Color Matching**: `laser_object_id` → sync with BoundingBoxes tracking colors
   - Currently BoundingBoxes uses type-based colors (Vehicle=orange, Pedestrian=lime, etc.)
   - Keypoints are pedestrians only → lime (#CCFF00) fixed or tracking ID-based
   - **Decision needed**: type-based (simple) vs tracking ID-based (distinguishable but needs palette)
   - **Recommended**: type-based lime fixed — keypoints distinguish by position, reduces color complexity
4. **World mode**: `showKeypoints && worldMode` → apply `poseByFrameIndex` to each joint coordinate
5. **LidarViewer.tsx** — add skeleton toggle next to BoxMode panel:
   - `[Off] [Boxes] [Models]  ·  [Skeleton ☐]`
   - Independent of BoxMode (both can show together)
6. **Timeline.tsx** — activate `keypointFrames` markers

### Acceptance Criteria

- [ ] showKeypoints ON + current frame has keypoint data → 14-joint skeleton renders above each pedestrian
- [ ] Skeleton joints positioned at correct 3D locations (inside bounding boxes)
- [ ] Bone lines connect correctly per `WAYMO_SKELETON_BONES` definition
- [ ] World mode: skeleton transforms to world coords correctly
- [ ] showKeypoints ON + current frame no keypoints → nothing rendered, no error
- [ ] No `lidar_hkp` parquet → skeleton toggle UI itself hidden
- [ ] Timeline shows keypoint frame markers (lime dots) when showKeypoints active
- [ ] Performance: 10 pedestrians × 14 joints = 140 spheres + ~120 lines → frame render time +2ms max
- [ ] Vitest: KeypointSkeleton unit tests (joint positions, bone connections, empty data)

### Concerns & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| joint `.type` value 0-indexed vs 1-indexed unclear | joints in wrong order → wrong bone connections | Print type values to console after loading first segment, verify |
| object has <14 joints (occluded joints) | line endpoints missing → NaN coords | Check joint existence before rendering bone |
| tracking color sync method undefined | design change requires BoundingBoxes modification | Decide before Phase B2 start |
| Many pedestrians (>20) → sphere/line explosion | frame drops | Use InstancedMesh for batch joint rendering |

**Estimated effort**: 2–3 hours

---

## Phase C1: camera_hkp — 2D Camera Keypoints (14 joints)

**Prerequisite**: Phase B2 (skeleton definition shared, showKeypoints toggle state)
**Follow-on**: None

### Data Format

Per-object 2D keypoint coordinates
- Column: `[CameraKeypointComponent].keypoint_2d.location_px.{x,y}`, `.type`, `.is_occluded`
- Key: `key.frame_timestamp_micros`, `key.camera_name`, `key.camera_object_id`
- File size: ~116KB

### Implementation Work

1. **metadata.ts** — in `loadWaymoMetadata()`, `readAllRows()` `camera_hkp`
   - Build `Map<bigint, Map<number, CameraKeypointObject[]>>` (timestamp → camera_name → objects)
   - `CameraKeypointObject = { objectId: string, joints: { type: number, x: number, y: number, occluded: boolean }[] }`
2. **KeypointOverlay.tsx** new component (SVG)
   - Same pattern as existing `BBoxOverlayCanvas` (inside CameraPanel)
   - Joints: `<circle r={3} />` (3px radius)
   - Bones: `<line strokeWidth={2} />` (2px)
   - Occluded joints: `opacity: 0.3` + `strokeDasharray: "3 2"` (dashed)
3. **Cross-modal hover sync**:
   - `camera_object_id` → `assocCamToLaser` → `laser_object_id` reuse existing Map
   - 2D keypoint hover → 3D skeleton highlight (reuse store's setHoveredBox)
4. **Toggle sync**: Single `showKeypoints` controls both 3D + 2D

### Acceptance Criteria

- [ ] showKeypoints ON + current frame + camera image → 2D skeleton overlay shown
- [ ] Occluded joints appear semi-transparent (0.3) + dashed
- [ ] 5 camera panels each show keypoints for their camera_name only
- [ ] Hover 2D keypoint → highlight corresponding 3D skeleton/bbox in scene
- [ ] No `camera_hkp` parquet → 2D keypoint overlay hidden, no error
- [ ] showKeypoints OFF → both 2D + 3D hidden
- [ ] Vitest: SVG coordinate transform tests (image coords → camera panel coords scaling)

### Concerns & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `camera_object_id` not in `assocCamToLaser` | hover sync fails | null-check — if sync unavailable, skip hover (silent) |
| camera_hkp frames ≠ camera_image frames | keypoints show on wrong image frame | Verify with timestamp matching, skip on mismatch |
| SVG element explosion (5cam × 10ped × 14joint × 2) | camera panel render delay | Consider Canvas 2D if SVG limits exceeded |

**Estimated effort**: 2–3 hours

---

## Phase C2: camera_segmentation — Camera Panoptic Segmentation

**Prerequisite**: Phase A (store flags, Timeline markers)
**Follow-on**: None

### Data Format

PNG-encoded uint16 image (same camera resolution)
- Column: `[CameraSegmentationComponent].panoptic_label`, `...panoptic_label_divisor`
- Encoding: `pixel_value = semantic_class * divisor + instance_id`
- 1Hz (only 1 frame per 10)
- File size: ~2.3MB

### Implementation Work

1. **metadata.ts** — read panoptic_label (PNG bytes) + divisor
   - `readAllRows()` → per-frame×camera `Map<bigint, Map<number, { panopticLabel: ArrayBuffer, divisor: number }>>`
   - Store in MetadataBundle's `cameraSeg` field
2. **CameraSegOverlay.tsx** new component (Canvas 2D)
   - `UPNG.decode(buffer)` → uint16 array (preserve depth=16)
   - `semantic_class = pixel_value / divisor | 0`
   - `instance_id = pixel_value % divisor`
   - semantic class → `WAYMO_SEG_PALETTE` → RGBA canvas overlay
   - Alpha: 0.4 (semi-transparent, see camera image below)
3. **Toggle**: independent toggle on camera panel (can ON simultaneously with 2D bbox, lidar overlay)
4. **Memory Management**:
   - Decode only 5 cameras of current frame (~10MB)
   - Clear previous canvas on frame switch (reuse overlay canvas)
   - PNG bytes cached in MetadataBundle (2.3MB, segment lifetime)
   - Decoded RGBA not cached (re-decode on frame switch)
5. **Timeline.tsx** — activate camera seg frame markers (magenta dots)

### Acceptance Criteria

- [ ] camera seg overlay ON + 1Hz frame → semi-transparent colored overlay on 5 camera panels
- [ ] Colors match WAYMO_SEG_PALETTE (road=purple, vehicle=orange, pedestrian=light-green, etc.)
- [ ] Non-1Hz frames → overlay inactive (empty canvas, toggle visible but "No data" shown)
- [ ] No `camera_segmentation` parquet → seg overlay toggle itself hidden
- [ ] 2D bbox + seg overlay ON together → both layers visible correctly (z-order: image > seg > bbox)
- [ ] divisor values applied correctly (semantic/instance separation)
- [ ] Memory: previous decoded RGBA GC'd on frame switch (verify DevTools Memory snapshot)
- [ ] Timeline shows camera seg frame markers (magenta dots) when overlay active
- [ ] Performance: UPNG.decode (1920×1280 uint16 PNG) **< 50ms** per camera
- [ ] Vitest: divisor application tests (various divisor values)

### Concerns & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| ~~UPNG.decode may not support uint16 depth~~ | ~~entire pipeline broken~~ | **✅ Resolved: depth=16 works, ~22ms/frame** |
| 5 cameras decode simultaneously (~22ms × 5 = 110ms) | frame switch jank | Sequential decode 1 per frame + progressive rendering or requestIdleCallback |
| 3MB PNG bytes accumulate in main thread metadata | GC pressure | **Benchmark: 39ms, negligible**. Store as ArrayBuffer, GC on segment switch |
| divisor varies frame-to-frame (within segment) | semantic/instance split wrong | Store per-row divisor (row-level, not segment-level) |
| Resolution mismatch: SIDE cameras (1920×886) vs FRONT (1920×1280) | hardcoded canvas breaks | Read dynamic resolution from manifest.cameraSensors. **Spike verified: FRONT=1920×1280, SIDE=1920×886** |
| `readAllRows()` default converts BYTE_ARRAY to String | PNG binary corrupted, decode fails | **Must pass `utf8: false` option** (same pattern as waymoCameraWorker) |
| `UPNG.decode().data` includes scanline trailing bytes | `data.byteLength = W×H×2 + H`, not pure uint16 | Read H rows with stride `W × 2`, ignore trailing bytes. Or `data.slice(0, W*H*2)` |
| **Camera seg class taxonomy differs from LiDAR (29 vs 23)** | Using existing `WAYMO_SEG_PALETTE` (23) misses classes 23-28 | **Need separate `WAYMO_CAMERA_SEG_PALETTE` (29 entries)** (add to Phase A prerequisites) |

**Estimated effort**: 3–4 hours

---

## Phase D: Integration & Polish

**Prerequisite**: B1 + B2 + C1 + C2 all complete

### Work

1. **Cross-modal integration testing**
   - 3D skeleton + 2D keypoint simultaneous display → hover sync working
   - segment colormap + camera seg overlay simultaneous active → visual consistency
   - All features ON + playback → measure frame rate

2. **Edge case cleanup**
   - Segments with only some of seg/hkp/camera_seg/camera_hkp
   - Very many pedestrians (>30) → render performance
   - Segment switch × 2: previous data cleaned up (no memory leak)
   - world mode ↔ vehicle mode switch during keypoint display → coords transform correct

3. **UI Polish**
   - Toggle button layout: integrate naturally into existing frosted glass panel
   - If controls get crowded, consider collapse/expand
   - Tooltip explaining why non-TOP sensors are gray in seg mode

4. **Performance Profiling**
   - Chrome DevTools Performance tab: full pipeline profile
   - Memory snapshots: pre-load → all features ON → post segment-switch
   - Goal: memory increase from features < 50MB, frame rate ≥ 30fps maintained

5. **Add Tests**
   - timestamp matching unit tests (lidar_seg worker)
   - skeleton bone connection unit tests
   - divisor application unit tests
   - integration test: store loadDataset() with seg/hkp files

### Acceptance Criteria

- [ ] All features (seg + hkp + camera_hkp + camera_seg) ON simultaneously render correctly
- [ ] 198-frame full playback smooth (≥30fps, even on seg/hkp frames)
- [ ] Segment switch × 2: memory doesn't monotonically increase
- [ ] 10+ new tests added, entire test suite passes
- [ ] nuScenes/AV2 segments without seg/hkp data: no regressions

**Estimated effort**: 2–3 hours

---

## 5. Camera RGB GPU Acceleration (separate issue recommended)

Performance optimization independent of segmentation/keypoints. WebGPU compute shader parallelizes 168K point projection + sampling.

Current JS main thread ~50ms → GPU ~1ms expected. But WebGPU availability + WebGL fallback add complexity, recommend separate work.

Detailed plan to move to separate document.

---

## Total Estimated Effort

| Phase | Work | Hours |
|-------|------|-------|
| A | Shared Infra | 2–3h |
| B1 | lidar_segmentation | 3–4h |
| B2 | lidar_hkp | 2–3h |
| C1 | camera_hkp | 2–3h |
| C2 | camera_segmentation | 3–4h |
| D | Integration & Polish | 2–3h |
| **Total** | | **14–20h** |

Parallel B1 ∥ B2: Critical path A → B2 → C1 → D = **8–12h**

---

## File Impact Scope

```
New files:
  src/components/LidarViewer/KeypointSkeleton.tsx  — 3D skeleton renderer
✅ src/utils/waymoSemanticClasses.ts                — 23-class palette + labels + keypoint/bone definitions (complete)
  src/components/CameraPanel/CameraSegOverlay.tsx  — camera seg overlay canvas
  src/components/CameraPanel/KeypointOverlay.tsx   — 2D keypoint SVG overlay

Modified files:
  src/workers/waymoLidarWorker.ts    — read seg parquet + extract per-point labels (Phase B1)
  src/workers/types.ts               — add segUrl to WaymoLidarWorkerInit (Phase A)
  src/stores/useSceneStore.ts        — has* flags + *Frames: Set<number> + showKeypoints (Phase A)
  src/types/dataset.ts               — add MetadataBundle optional fields (Phase A)
  src/adapters/waymo/metadata.ts     — parse hkp + camera_hkp + camera_seg metadata (Phase A)
  src/adapters/waymo/manifest.ts     — add 'segment' to colormapModes (Phase A)
  src/components/LidarViewer/LidarViewer.tsx  — keypoint toggle UI + segment gating (Phase A/B2)
  src/components/LidarViewer/PointCloud.tsx   — non-TOP sensor fallback handling (Phase B1)
  src/components/CameraPanel/CameraPanel.tsx  — integrate 2D keypoint + seg overlay (Phase C1/C2)
  src/components/Timeline/Timeline.tsx        — sparse annotation frame markers (Phase A)

Complete files (no changes needed):
✅ src/types/dataset.ts               — OverlayMode, AnnotationMode, manifest extension
✅ src/types/upng-js.d.ts             — upng-js type declaration
✅ src/adapters/waymo/manifest.ts     — overlayModes, annotationModes, palette linked
✅ src/adapters/nuscenes/manifest.ts  — overlayModes, annotationModes, palette linked
✅ src/utils/colormaps.ts             — computePointColor() + instanceColor() palette parameterized (4de9fc0)
✅ src/components/LidarViewer/PointCloud.tsx     — pass manifest.semanticPalette (4de9fc0)
✅ src/components/CameraPanel/LidarProjectionOverlay.tsx — pass manifest.semanticPalette (4de9fc0)
```

## Open Decisions — All Confirmed

| # | Decision | Confirmed | Rationale |
|---|----------|-----------|-----------|
| 1 | keypoint color strategy | **(a) type-based lime fixed** | pedestrians only, position sufficient to distinguish, reduces complexity |
| 2 | camera_seg load location | **(a) load all in metadata** | benchmark: 39ms, 8% of total. async separation unnecessary |
| 3 | visual handling for sensors without seg | **(a) gray + low opacity** | shows sensor exists but seg absent visually distinct |
| 4 | UPNG uint16 pre-validation | **✅ validation complete** | depth=16 works, ~22ms/frame, `utf8:false` required |
| 5 | Camera seg palette | **new: separate 29-class palette** | LiDAR(23) and Camera(29) class taxonomies differ. Camera-only: SKY, Ground Animal, etc. |
