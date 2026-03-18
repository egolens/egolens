# Multi-Dataset Refactoring Plan

**Date:** 2026-03-13
**Goal:** Create a dataset-independent architecture starting with nuScenes dataset support, with future expansion to KITTI / Argoverse and others.
**Approach:** Progressively extract abstraction layers without breaking the existing Waymo pipeline.

---

## 1. Analysis of Waymo Coupling in Current Architecture

Investigated the entire codebase and classified Waymo-specific dependencies into 3 layers.

### Layer 1 — Data Format (Deep coupling, high change cost)

| File | Coupling Point | Description |
|---|---|---|
| `workers/dataWorker.ts:104-109` | `LIDAR_COLUMNS` array | Hardcoded Waymo Parquet column names: `[LiDARComponent].range_image_return1.*` |
| `workers/dataWorker.ts:192-198` | Range image parsing | Assemble `shape` + `values` into `RangeImage` type → call `convertAllSensors()` |
| `workers/cameraWorker.ts` | Camera JPEG extraction | Extract JPEG bytes from `[CameraImageComponent].image` column |
| `utils/rangeImage.ts` | Spherical→cartesian conversion | Waymo-specific range image format. Does not exist in nuScenes/KITTI |
| `stores/useSceneStore.ts:876-1030` | `loadStartupData()` | Direct reference to 20+ Waymo Parquet column names (poses, calibrations, boxes, associations, statistics) |

### Layer 2 — Sensor Configuration (Medium coupling, medium change cost)

| File | Coupling Point | Description |
|---|---|---|
| `types/waymo.ts:7-13` | `LidarName` enum | 5 sensors (TOP, FRONT, SIDE_LEFT, SIDE_RIGHT, REAR) |
| `types/waymo.ts:17-23` | `CameraName` enum | 5 cameras (FRONT, FRONT_LEFT, FRONT_RIGHT, SIDE_LEFT, SIDE_RIGHT) |
| `types/waymo.ts:27-33` | `BoxType` enum | 5 types (UNKNOWN, VEHICLE, PEDESTRIAN, SIGN, CYCLIST) |
| `types/waymo.ts:49-55` | `CAMERA_RESOLUTION` | Camera resolutions (1920×1280 / 1920×886) |
| `stores/useSceneStore.ts:774` | `visibleSensors` initial value | Hardcoded `new Set([1, 2, 3, 4, 5])` |
| `stores/useSceneStore.ts:725-728` | `components` array | 9 Waymo component names + `/waymo_data/` path |

### Layer 3 — UI Labels (Shallow coupling, low change cost)

| File | Coupling Point | Description |
|---|---|---|
| `components/LidarViewer/LidarViewer.tsx:39-45` | Sensor toggle UI | 5 Waymo sensor names displayed as labels |
| `components/CameraPanel/CameraPanel.tsx:22-28` | Camera panel layout | 5-camera surround view layout |
| `App.tsx` | Title, download instructions | "for Waymo Open Dataset", gsutil commands |

### Already Generic Code (No changes needed)

| Code | Reason |
|---|---|
| `PointCloud.tsx`, `BoundingBoxes.tsx`, `CameraFrustums.tsx` | Consume only `Float32Array`, `ParquetRow[]` — data source agnostic |
| `workerPool.ts`, `cameraWorkerPool.ts` | Message protocol based — can manage any worker |
| `FrameData` type | Sensor ID abstracted as `number`, `Map<number, PointCloud>` |
| Timeline, playback logic | Frame index based, dataset agnostic |
| 4×4 matrix operations (world mode, trails) | Math is dataset independent |
| `memoryLogger.ts`, `MemoryOverlay.tsx` | Fully generic infrastructure |

---

## 2. Waymo vs nuScenes Data Comparison

Comparison based on investigation of v1.0-mini actual data.

### Sensor Configuration

| | Waymo | nuScenes |
|---|---|---|
| LiDAR | 5 units (64-beam TOP + 4× short-range) | **1 unit** (Velodyne HDL-32E, 32-beam) |
| Camera | 5 units (1920×1280/886) | **6 units** (1600×900, 360° coverage) |
| Radar | None | **5 units** (PCD v0.7, ~125 pts/sweep) |
| Keyframe frequency | 10 Hz | **2 Hz** |

### Data Format

| | Waymo | nuScenes |
|---|---|---|
| Metadata | Parquet columnar | **JSON relational DB** (13 tables, token-linked) |
| LiDAR storage | Parquet → range image (spherical) | **`.pcd.bin`** (flat float32: x,y,z,intensity,ring) |
| LiDAR parsing cost | sin/cos + matrix (~4 sec/RG) | **`new Float32Array(buf)`** (~0 ms) |
| LiDAR point count | ~168K/frame (5 sensors) | **~34K/frame** (1 sensor) |
| Camera storage | Parquet column (JPEG bytes) | **Individual `.jpg` files** |
| Ego pose | Parquet column (4×4 matrix) | **JSON** (quaternion + translation) |
| Box coordinate frame | vehicle-frame | **global-frame** (→ vehicle conversion needed) |
| Box categories | 5 int enum | **23 string hierarchy** (e.g. `vehicle.car`) |
| Frame indexing | bigint timestamp | **Token linked list** (sample.next/prev) |
| Data across scenes | Independent Parquet per segment | **File independent, JSON shared** (filter by scene_token) |

### Memory Profile (per 1 scene)

| | Waymo (199 frames) | nuScenes (~40 keyframes) |
|---|---|---|
| LiDAR cache | 775 MB (after slice fix) | **~27 MB** (34K × 20B × 40) |
| Camera cache | 310 MB | **~34 MB** (6cam × 140KB × 40) |
| Metadata JSON | N/A (Parquet) | **~33 MB** (mini) / ~400 MB (trainval) |
| **Total** | **~1,085 MB** | **~94 MB** |

---

## 3. Target Architecture: DatasetAdapter Pattern

```
┌──────────────────────────────────────────────────────────────────┐
│                         App / UI Layer                          │
│  LidarViewer, CameraPanel, Timeline, BoundingBoxes              │
│  ← manifest.lidarSensors, manifest.cameraSensors for dynamic build │
└───────────────────────────┬──────────────────────────────────────┘
                            │ FrameData (same interface)
┌───────────────────────────┴──────────────────────────────────────┐
│                        useSceneStore                             │
│  loadDataset() → adapter.detect() → adapter.loadMetadata()      │
│  Frame cache, playback, world mode ← dataset agnostic            │
└───────────────┬──────────────────────────────┬───────────────────┘
                │                                  │
    ┌───────────┴───────────┐          ┌───────────┴───────────┐
    │    LiDAR WorkerPool   │          │   Camera WorkerPool   │
    │  adapter.createLidar  │          │  adapter.createCamera  │
    │  Worker()             │          │  Worker()             │
    └───────────┬───────────┘          └───────────┬───────────┘
                │                                  │
    ┌───────────┴───────────┐          ┌───────────┴───────────┐
    │  WaymoLidarWorker     │          │  WaymoCameraWorker    │
    │  (Parquet→rangeImg    │          │  (Parquet→JPEG)       │
    │   →cartesian)         │          │                       │
    ├───────────────────────┤          ├───────────────────────┤
    │  NuScenesLidarWorker  │          │  NuScenesCameraWorker │
    │  (.pcd.bin→Float32)   │          │  (.jpg file→ArrayBuf) │
    └───────────────────────┘          └───────────────────────┘
```

### Core Interfaces

```typescript
// src/types/dataset.ts (new)

interface DatasetManifest {
  id: string                           // 'waymo' | 'nuscenes'
  name: string                         // Display name
  lidarSensors: SensorDef[]            // [{id: 1, name: 'TOP', ...}]
  cameraSensors: CameraSensorDef[]     // [{id: 1, name: 'FRONT', width, height}]
  boxTypes: BoxTypeDef[]               // [{id: 1, label: 'Vehicle', color: '#FF9E00'}]
  frameRate: number                    // 10 (Waymo) | 2 (nuScenes keyframe)
  hasRadar: boolean
}

interface SensorDef {
  id: number
  name: string
}

interface CameraSensorDef extends SensorDef {
  width: number
  height: number
}

interface BoxTypeDef {
  id: number
  label: string
  color: string
}

interface MetadataBundle {
  timestamps: bigint[]                              // Sorted frame timestamps
  poses: Map<bigint, number[]>                      // ts → 4x4 row-major matrix
  lidarCalibrations: Map<number, LidarCalibration>  // sensorId → calib
  cameraCalibrations: CameraCalibration[]
  boxes3D: Map<bigint, ParquetRow[]>                // ts → boxes (unified field names)
  boxes2D: Map<bigint, ParquetRow[]>                // ts → camera boxes
  associations: {
    camToLaser: Map<string, string>
    laserToCams: Map<string, Set<string>>
  }
  trajectories: Map<string, TrajectoryPoint[]>
  segmentMeta?: SegmentMeta
}

interface DatasetAdapter {
  /** Detect if this is the dataset based on file/folder structure */
  detect(files: Map<string, File | string>): boolean

  /** Return static manifest of sensor config, box types, etc. */
  getManifest(): DatasetManifest

  /** Return list of scenes/segments */
  discoverScenes(files: Map<string, File | string>): Promise<SceneInfo[]>

  /** Load metadata (poses, calibrations, boxes, etc.) */
  loadMetadata(
    files: Map<string, File | string>,
    sceneId: string,
  ): Promise<MetadataBundle>

  /** Return dataset-specific LiDAR worker URL */
  createLidarWorkerUrl(): string

  /** Generate LiDAR worker init message */
  buildLidarWorkerInit(
    files: Map<string, File | string>,
    calibrations: Map<number, LidarCalibration>,
    workerIndex: number,
  ): object

  /** Return dataset-specific camera worker URL */
  createCameraWorkerUrl(): string

  /** Generate camera worker init message */
  buildCameraWorkerInit(
    files: Map<string, File | string>,
    workerIndex: number,
  ): object
}
```

### Worker Output Protocol (Unified)

LiDAR and camera worker outputs are already nearly generic. This remains unchanged:

```typescript
// Already existing types — keep as is
interface SensorCloudResult {
  laserName: number         // Sensor ID (different numbering per dataset)
  positions: Float32Array   // [x,y,z,intensity,range,elongation, ...]
  pointCount: number
}

interface FrameResult {
  timestamp: string
  sensorClouds: SensorCloudResult[]
  convertMs: number
}
```

nuScenes workers return the same `FrameResult`, but with different stride in `positions`:
- Waymo: stride 6 (x, y, z, intensity, range, elongation)
- nuScenes: stride 5 (x, y, z, intensity, ring)

→ Get `POINT_STRIDE` from manifest, or define minimal common stride (x,y,z,intensity = 4).

---

## 4. Implementation Roadmap (5 Phases)

### Phase 0 — Type Definitions + Auto-Detection (Half Day)

**Change scope:** New files only, no changes to existing code

1. Create `src/types/dataset.ts` — define interfaces above
2. Create `src/adapters/registry.ts` — adapter registry + `detectDataset()` function
3. Create `src/adapters/waymo/manifest.ts` — wrap sensor definitions from current `waymo.ts` as `DatasetManifest`

**Auto-detection logic:**
```typescript
// Waymo: *.parquet files with lidar/, camera_image/ etc. component folders
// nuScenes: v1.0-*/ folder + samples/ + sweeps/ + *.json metadata
function detectDataset(files: Map<string, File | string>): DatasetAdapter
```

**Validation:** Confirm existing Waymo loading is not broken (27 existing tests pass)

### Phase 1 — UI Genericization (1 Day)

**Change scope:** UI components + part of Store

1. `LidarViewer.tsx` — hardcoded 5 sensors → dynamically generate from `manifest.lidarSensors`
2. `CameraPanel.tsx` — hardcoded 5 cameras → dynamic layout from `manifest.cameraSensors`
3. `useSceneStore.ts` — derive `visibleSensors` initial value from manifest
4. `App.tsx` — display dataset name, download instructions from adapter

**Core principle:** UI automatically adapts when manifest provides sensor list.

**Layout strategy:** Camera panel adapts based on camera count:
- 5 cameras (Waymo): current 1 row × 5 columns
- 6 cameras (nuScenes): 2 rows × 3 columns (front 3 + rear 3) or 1 row × 6 columns
- Flexible: CSS grid based on `manifest.cameraSensors.length`

### Phase 2 — MetadataLoader Extraction (1-2 Days)

**Change scope:** Refactor `loadStartupData()` in Store

Current `loadStartupData()` directly references 20+ Waymo Parquet columns at lines 875-1030. Extract this to `adapter.loadMetadata()`.

**Waymo adapter:**
```
vehicle_pose parquet     → poses: Map<bigint, number[]>         (4×4 matrix as-is)
lidar_calibration parquet → lidarCalibrations: Map<number, LC>   (keep parseLidarCalibration)
lidar_box parquet        → boxes3D: Map<bigint, Row[]>          (normalize column names only)
camera_box parquet       → boxes2D: Map<bigint, Row[]>
association parquet      → associations
stats parquet            → segmentMeta
```

**nuScenes adapter:**
```
ego_pose.json            → poses: Map<bigint, number[]>         (quat→4×4 conversion)
calibrated_sensor.json   → lidarCalibrations + cameraCalibrations (quat→4×4 + intrinsic)
sample_annotation.json   → boxes3D: Map<bigint, Row[]>          (global→vehicle conversion)
                           boxes2D: none (nuScenes has no 2D boxes)
                           associations: none
scene.json + sample.json → timestamps (linked list → sorted array)
category.json + instance → boxType mapping (string hierarchy → int)
```

**nuScenes specific conversions:**

1. **Quaternion → 4×4 matrix:** Both ego_pose and calibrated_sensor use quaternion(w,x,y,z) + translation(x,y,z). Need utility to convert to 4×4 row-major matrix.

2. **Global → vehicle frame boxes:** nuScenes annotations are in global coordinate frame. Renderer expects vehicle frame, so need `inv(ego_pose) × annotation_pose` conversion.

3. **Category hierarchy → BoxType int:** Map `human.pedestrian.*` → PEDESTRIAN, `vehicle.*` → VEHICLE, etc. via lookup table.

**Store change:** Call `adapter.loadMetadata()` after `loadStartupData()`, store results in same internal structure. Rest of Store logic (caching, playback, world mode) unchanged.

### Phase 3 — LiDAR Worker Abstraction (2-3 Days, core)

**Change scope:** Worker creation logic + new nuScenes Worker

This is the largest change. Current `dataWorker.ts` couples Parquet I/O + range image conversion.

**Structure change:**

```
src/workers/
├── dataWorker.ts           → waymoLidarWorker.ts (rename, keep content)
├── nuScenesLidarWorker.ts  (new)
├── workerPool.ts           (no change — already generic)
├── cameraWorker.ts         → waymoCameraWorker.ts (rename)
├── nuScenesCameraWorker.ts (new)
└── cameraWorkerPool.ts     (no change)
```

**nuScenesLidarWorker implementation:**

nuScenes LiDAR already has xyz coordinates, so worker is extremely simple:

```typescript
// Core logic — instead of Waymo's 4-second conversion → ~0ms
async function loadFrame(filePath: string): SensorCloudResult {
  const buffer = await fetch(filePath).then(r => r.arrayBuffer())
  const floats = new Float32Array(buffer)
  const pointCount = floats.length / 5  // x,y,z,intensity,ring
  return { laserName: 1, positions: floats, pointCount }
}
```

**nuScenesCameraWorker implementation:**

Just read individual `.jpg` files to `ArrayBuffer`. No Parquet decompression, so also simple.

**WorkerPool change:**

`WorkerPool.init()` currently hardcodes worker URL. Change to get URL from `adapter.createLidarWorkerUrl()`.

```typescript
// Current
const worker = new Worker(new URL('../workers/dataWorker.ts', import.meta.url))

// After change
const workerUrl = adapter.createLidarWorkerUrl()
const worker = new Worker(workerUrl)
```

**Row Group vs File-per-Frame:**

Waymo uses row group units (~51 frames/RG), nuScenes uses file-per-frame. Must unify worker message protocol:

| | Waymo Worker | nuScenes Worker |
|---|---|---|
| Init | Parquet URL + calibrations | base URL + file list |
| Request | `loadRowGroup(rgIndex)` | `loadFrameBatch(fileList)` |
| Response | `FrameResult[]` (same) | `FrameResult[]` (same) |

Change current `requestRowGroup(index)` pattern in WorkerPool to generic name like `requestBatch(index)`, and let adapter decide batching strategy.

### Phase 4 — nuScenes Adapter Integration Test (1 Day)

**Change scope:** Tests + integration

1. End-to-end test with v1.0-mini data
2. Confirm all 10 scenes load
3. Memory profiling (reuse memoryLogger)
4. Regression check on existing 27 Waymo tests
5. Test scene switching

**Expected results:**
- Scene loading: JSON parsing ~500ms + file fetch ~200ms (mini baseline)
- Memory: ~94 MB per scene (vs Waymo 1,085 MB)
- LiDAR worker time: no Parquet decompression, no conversion → <100ms

---

## 5. nuScenes-Specific Implementation Details

### 5.1 JSON Metadata Loading Strategy

v1.0-mini JSON file sizes:
- `sample_data.json`: 15.9 MB (31,206 entries)
- `sample_annotation.json`: 9.3 MB (18,538 entries)
- `ego_pose.json`: 7.6 MB (31,206 entries)
- Rest: <1 MB combined

**Strategy:** Parse entire JSON once and build in-memory index by filtering on scene_token. Even full trainval (~400 MB) parses in 2-3 seconds with `JSON.parse()`, then scene switching is instant (filtering only).

```
Load phase:
1. sensor.json, calibrated_sensor.json, category.json → small, parse immediately
2. scene.json, sample.json → build scene list
3. ego_pose.json, sample_data.json → large, parse once → build token-based Map
4. sample_annotation.json → parse once → build sample_token-based Map

When selecting scene:
1. Traverse linked list from scene.first_sample_token → collect sample tokens
2. Extract sensor file paths for those samples from sample_data
3. Extract poses for those timestamps from ego_pose
4. Extract boxes for those samples from annotations + category mapping
```

### 5.2 Coordinate Frame Conversion

**Ego pose (quaternion → 4×4):**
```
Input: translation [x, y, z], rotation [w, x, y, z] (scalar first)
Output: 4×4 row-major matrix
```

Reuse existing `invertRowMajor4x4()`, `multiplyRowMajor4x4()`. Just add quaternion→rotation matrix conversion utility.

**Box coordinate conversion:**

nuScenes annotations are in global frame. Convert to vehicle frame:
```
box_vehicle = inv(ego_pose) × box_global
```

This conversion is identical to pattern already done in Waymo world mode: `inv(pose₀) × poseₙ`.

### 5.3 Category Mapping

nuScenes 23 categories → renderer BoxType int:

```typescript
const NUSCENES_CATEGORY_MAP: Record<string, number> = {
  // Vehicle types
  'vehicle.car': 1,
  'vehicle.truck': 1,
  'vehicle.bus.bendy': 1,
  'vehicle.bus.rigid': 1,
  'vehicle.construction': 1,
  'vehicle.emergency.ambulance': 1,
  'vehicle.emergency.police': 1,
  'vehicle.trailer': 1,
  'vehicle.motorcycle': 4,      // → CYCLIST (closest match)
  'vehicle.bicycle': 4,         // → CYCLIST

  // Pedestrian types
  'human.pedestrian.adult': 2,
  'human.pedestrian.child': 2,
  'human.pedestrian.wheelchair': 2,
  'human.pedestrian.stroller': 2,
  'human.pedestrian.personal_mobility': 2,
  'human.pedestrian.police_officer': 2,
  'human.pedestrian.construction_worker': 2,

  // Other
  'animal': 0,                  // → UNKNOWN
  'movable_object.barrier': 0,
  'movable_object.trafficcone': 3,  // → SIGN (closest visual match)
  'movable_object.pushable_pullable': 0,
  'movable_object.debris': 0,
  'static_object.bicycle_rack': 0,
}
```

### 5.4 Sweep Support (Phase 4+, optional)

nuScenes keyframes are 2Hz, but including sweeps (intermediate frames) gives LiDAR 20Hz and cameras 12Hz. Initial implementation supports keyframes only; sweeps as future option:

- `sample_data.json` entries with `is_key_frame: false` = sweeps
- Sweeps have no annotations (need interpolation)
- Worker can load sweeps in batch too (same `.pcd.bin` format)

---

## 6. Folder Structure Changes

```
src/
├── types/
│   ├── waymo.ts          (keep — Waymo-specific constants/types)
│   └── dataset.ts        (new — shared interfaces)
├── adapters/
│   ├── registry.ts       (new — detectDataset, adapter registry)
│   ├── waymo/
│   │   ├── manifest.ts   (extracted from waymo.ts)
│   │   ├── adapter.ts    (DatasetAdapter implementation)
│   │   └── metadata.ts   (Parquet parsing extracted from loadStartupData)
│   └── nuscenes/
│       ├── manifest.ts   (sensor defs, category mapping)
│       ├── adapter.ts    (DatasetAdapter implementation)
│       ├── metadata.ts   (JSON parsing + coordinate conversion)
│       └── quaternion.ts (quat→matrix utility)
├── workers/
│   ├── waymoLidarWorker.ts    (rename from dataWorker.ts)
│   ├── waymoCameraWorker.ts   (rename from cameraWorker.ts)
│   ├── nuScenesLidarWorker.ts (new)
│   ├── nuScenesCameraWorker.ts(new)
│   ├── workerPool.ts          (keep — already generic)
│   └── cameraWorkerPool.ts    (keep)
├── stores/
│   └── useSceneStore.ts       (refactor with adapter calls)
├── utils/
│   ├── rangeImage.ts          (keep — import only in Waymo worker)
│   ├── parquet.ts             (keep — import only in Waymo worker)
│   └── merge.ts               (keep)
└── components/                (dynamic UI based on manifest)
```

---

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Waymo pipeline regression | High | Verify 27 existing tests pass per phase. Phase 0 makes no changes to existing code. |
| Full trainval JSON parse speed | Medium | ~400 MB JSON.parse takes 2-3 seconds. If needed, parse in Web Worker. |
| POINT_STRIDE mismatch | Medium | Colormaps hardcode intensity/range/elongation indices. Define stride and field offsets in manifest. |
| nuScenes global-frame box conversion accuracy | Low | Quaternion conversion is well-known math. Validate against devkit reference. |
| Browser File API limits | Low | v1.0-mini has 404 LiDAR + 2,424 camera = ~2,828 files. Use FileSystemDirectoryHandle on drag-drop for bulk file access. |

---

## 8. Timeline Summary

| Phase | Task | Est. Time | Change Impact |
|---|---|---|---|
| **Phase 0** | Type definitions + auto-detection | 0.5 day | New files only (zero risk) |
| **Phase 1** | UI genericization | 1 day | UI components (low risk) |
| **Phase 2** | MetadataLoader extraction | 1-2 days | Store refactoring (medium risk) |
| **Phase 3** | Worker abstraction + nuScenes Worker | 2-3 days | Core pipeline (high risk) |
| **Phase 4** | Integration testing + polish | 1 day | Tests + bugfixes |
| **Total** | | **5.5-7.5 days** | |

Phases 0 → 1 can run in parallel. Phases 2 and 3 are sequential (3 depends on 2's output).
