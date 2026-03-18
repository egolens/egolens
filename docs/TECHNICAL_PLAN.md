# Technical Plan — Perception Studio for Waymo Open Dataset

Portfolio project targeting Waymo Fullstack Engineer (Applications & Tools) role.
Timeline: 4–5 days.

## 1. Architecture Decisions

### Data Pipeline — Browser-Native Parquet (Zero Preprocessing)

**Decision**: Read Parquet files directly in the browser via `hyparquet` (pure JS). No Python, no server, no preprocessing.

**Why this works**: Parquet files have footer metadata with row group offsets. Browser reads footer (few KB) first, then fetches only the needed row group via `File.slice(offset, length)`. This enables random access into 328MB camera_image and 162MB lidar files without loading them fully into memory.

**Why this matters**: v1.0 TFRecord requires sequential reads via TensorFlow — that's why erksch needed a Python server. v2.0 Parquet was designed for selective/columnar access, and we exploit this to the maximum: zero-install, browser-only, file-in → visualization-out. This should be emphasized in interviews.

### Data Loading (Two Modes)

- **Local dev**: `VITE_WAYMO_DATA_PATH=./waymo_data` in `.env`. Vite serves data as static assets. Auto-loads on startup.
- **Deployed demo / visitors**: Folder drag & drop into browser. App scans `{component}/{segment_id}.parquet` structure, auto-detects segments/components. If multiple segments, show picker.
- 3DGS Lab tab always works immediately (bundled .ply).

### Licensing

- **Raw data**: Cannot redistribute. Users must download from Waymo (free, license agreement required).
- **Trained model weights (.ply)**: Distributable (non-commercial). Pre-built 3DGS .ply bundled with app.
- Result: 3DGS Lab = zero-download demo. Sensor View = user provides data.

### World Coordinate Mode — Frame-0-Relative Normalization

**Decision**: World mode transforms all poses to be relative to frame 0's position, rather than using raw global (UTM-like) coordinates.

**Problem**: Waymo `world_from_vehicle` transform uses global coordinates (likely UTM). First frame of a typical segment is at (-865, 15064, 8) — ~15km from origin. Three.js camera/grid sit at origin, so toggling world mode shows nothing.

**Solution**: At load time, compute `inv(pose₀)` and store it. Every pose becomes `inv(pose₀) × poseₙ`, making frame 0 = identity = origin. This keeps the grid visible, avoids float precision issues at large coordinates, and makes trajectory trails intuitive.

**Math**: Row-major 4×4 rigid-body inverse uses `[R^T | -R^T·t]` (no general matrix inverse needed since rotation matrices are orthogonal). Composition via standard row-major 4×4 multiply.

**Camera behavior**: In world mode, camera stays at initial position (no vehicle-following). This lets the user see the full trajectory path. Vehicle frame mode retains the default orbital camera around the vehicle.

### Test Fixtures — Mock Parquet Files

**Decision**: Generate deterministic mock Parquet fixtures with pyarrow instead of using real Waymo data in tests.

**Why not real data**: Waymo data files are 50MB–328MB each, cannot be checked into git (license + size). Tests that depend on external data downloads are fragile and non-portable.

**Approach**: `scripts/generate_fixtures.py` uses pyarrow + numpy with `seed(42)` to generate 5 small Parquet files (~5.5MB total) in `src/__fixtures__/mock_segment_0000/`. Range images are deliberately small (TOP: 8×100, FRONT: 8×50, SIDE/REAR: 4×20) to keep fixtures git-friendly while exercising the full conversion pipeline.

**Mock data properties**:
- 199 frames matching real segment structure
- 5 LiDAR sensors with realistic calibration (non-uniform inclinations, per-sensor extrinsics)
- 75 tracked objects per frame with bounding boxes
- ~1,266 valid points per frame (~88% density, matching Waymo's typical valid-pixel ratio)
- ZSTD compression, 5 row groups

### Worker Pool Mocking for Vitest

**Decision**: Mock `WorkerPool` and `CameraWorkerPool` via `vi.mock` with in-process implementations, rather than using `@vitest/web-worker` or other Worker polyfills.

**Why not `@vitest/web-worker`**: The worker files import complex modules (hyparquet, BROTLI compressors, range image conversion). `@vitest/web-worker` creates a real worker thread but module resolution hangs for 30s+ because Vite's transform pipeline doesn't apply in vitest workers.

**Solution**: The mock `WorkerPool.init()` opens the Parquet file via the same `openParquetFile()` function used in production. `requestRowGroup()` reads rows and runs `convertAllSensors()` — identical logic to the real worker, just synchronous in the main thread. This validates the full data pipeline (Parquet → range image → xyz conversion) without needing actual Web Workers.

**CameraWorkerPool** is mocked as a no-op (returns 0 row groups) since camera image fixtures are not included.

### GPU Shader — Azimuth Correction Fix

**Decision**: Add per-sensor azimuth correction (`atan2(extrinsic[4], extrinsic[0])`) to the WebGPU compute shader's `computeAzimuths` call.

**Bug**: The GPU path called `computeAzimuths(width)` without the azimuth correction parameter, while the CPU path correctly computed `azCorrection = atan2(extrinsic[1][0], extrinsic[0][0])`. This caused the GPU shader to produce xyz positions rotated by the sensor's yaw angle, leading to incorrect bounding boxes. The bug was masked in production because the GPU path was optional and only used for performance.

**Discovery**: The mock fixture tests exposed this because they run both CPU and GPU paths against the same small data. With real Waymo data, the TOP sensor has near-zero yaw so the error was subtle; the FRONT/SIDE sensors have larger yaw angles where the mismatch is obvious.

## 2. Waymo v2.0 Data Structure

Files: `{component}/{segment_id}.parquet`
Key columns: `key.segment_context_name`, `key.frame_timestamp_micros`, `key.laser_name` (1-5), `key.camera_name` (1-5)

### Sample Segment: `10023947602400723454_1120_000_1140_000`
- SF downtown, daytime, sunny
- 199 frames (~20 sec at 10Hz)
- Avg 94 objects/frame, 115 unique tracked objects
- Types: 1=VEHICLE(36/frame), 2=PEDESTRIAN(33), 3=SIGN(23), 4=CYCLIST(1)

### LiDAR — CRITICAL: Range Image format, NOT xyz points

`lidar` component stores **range images**, not point clouds. Must convert to xyz in browser.

| LiDAR | laser_name | Range Image Shape | Pixels |
|-------|-----------|-------------------|--------|
| TOP | 1 | 64 × 2650 × 4 | 169,600 |
| FRONT | 2 | 200 × 600 × 4 | 120,000 |
| SIDE_LEFT | 3 | 200 × 600 × 4 | 120,000 |
| SIDE_RIGHT | 4 | 200 × 600 × 4 | 120,000 |
| REAR | 5 | 200 × 600 × 4 | 120,000 |

- 4 channels = [range, intensity, elongation, is_in_no_label_zone]
- Total ~649K range pixels/frame (valid points fewer — filter range > 0)
- Two returns per pulse: `range_image_return1` (primary) and `range_image_return2` (secondary reflection). MVP uses return1 only.

#### Range Image → XYZ Conversion Math

Source: Official Waymo SDK `lidar_utils.convert_range_image_to_point_cloud()` and GitHub issues #656, #51, #307, #863.

**Step 1: Compute inclination and azimuth per pixel**

- **Inclination** (vertical angle):
  - TOP LiDAR: **non-uniform** — `lidar_calibration` provides a `beam_inclination.values` array (64 exact angles, one per row).
  - Other 4 LiDARs: **uniform** — only `beam_inclination.min` and `beam_inclination.max` provided. Linear interpolation: `inclination = max - (row / height) * (max - min)` (row 0 = top = max angle).
- **Azimuth** (horizontal angle):
  - `azimuth = azimuth_offset + (col / width) * 2π`
  - Column 0 = rear direction (azimuth ≈ π), center column = forward (azimuth ≈ 0).

**Step 2: Spherical → Cartesian**

```
x = range × cos(inclination) × cos(azimuth)
y = range × cos(inclination) × sin(azimuth)
z = range × sin(inclination)
```

Skip pixels where `range <= 0` (invalid).

**Step 3: Extrinsic transform (sensor frame → vehicle frame)**

Apply 4×4 extrinsic matrix from `lidar_calibration`:
```
[x_v, y_v, z_v, 1]ᵀ = extrinsic × [x, y, z, 1]ᵀ
```

**Step 4: Per-point ego-motion correction (TOP only)**

`lidar_pose` provides a per-pixel vehicle pose for the TOP LiDAR to correct rolling shutter distortion. Other 4 LiDARs don't need this (their sweep is fast enough). For MVP, this step can be deferred — the visual difference is subtle.

#### Conversion Strategy: CPU Web Worker Pool (WebGPU deferred)

The conversion is **embarrassingly parallel** — each pixel is independent (cos, sin, matrix mul).

- **CPU Web Worker Pool** (current): 3 LiDAR workers + 2 camera workers (see D33). Each processes a row group (~51 frames). ~5ms/frame for all 5 sensors (~168K points). Fast enough for 10Hz playback.
- **WebGPU Compute Shader** (implemented but unused): `rangeImageGpu.ts` exists with working compute shader. Deferred because CPU Worker Pool + row-group batching already achieves <5ms/frame, and WebGPU adds browser compatibility concerns.

```
src/utils/rangeImage.ts        ← Pure conversion math (shared, testable)
src/workers/dataWorker.ts      ← Parquet I/O + conversion in Web Worker
src/workers/workerPool.ts      ← N-worker pool for parallel row group processing
src/utils/rangeImageGpu.ts     ← WebGPU compute shader (unused, available for future)
```

#### Gotchas from Waymo SDK Issues

- **#656**: beam_inclination.values can be null for uniform sensors — always check before using.
- **#307**: Raw data is already corrected to vehicle frame — don't apply additional azimuth corrections.
- **#863**: When merging DataFrames, laser_name must match between lidar and lidar_calibration.
- **#51**: range_image_top_pose is per-pixel, not per-frame — only TOP LiDAR has this.

#### Reference: erksch viewer (v1.0)

erksch doesn't do this conversion in the browser at all. Python server calls `frame_utils.convert_range_image_to_point_cloud()` (official Waymo util with TensorFlow), converts to xyz, then sends `[x, y, z, intensity, laser_id, label]` as Float32 binary over WebSocket. Our project does this **entirely in the browser** — no Python, no TensorFlow.

### Camera

| Camera | camera_name | Resolution |
|--------|-----------|------------|
| FRONT | 1 | 1920 × 1280 |
| FRONT_LEFT | 2 | 1920 × 1280 |
| FRONT_RIGHT | 3 | 1920 × 1280 |
| SIDE_LEFT | 4 | 1920 × 886 |
| SIDE_RIGHT | 5 | 1920 × 886 |

- `camera_image` stores JPEG binary in `[CameraImageComponent].image`
- `camera_segmentation` is **1Hz** (not 10Hz) — only 20 frames have segmentation

### File Sizes (1 segment = ~597MB total)

| Component | Size | Load Strategy |
|-----------|------|--------------|
| camera_image | 328MB | Lazy per-frame (row group) |
| lidar | 162MB | Lazy per-frame (row group, 4 RGs) |
| lidar_camera_projection | 74MB | Lazy per-frame |
| lidar_pose | 22MB | Lazy per-frame |
| camera_segmentation | 2.3MB | Load at startup |
| lidar_box | 976KB | Load at startup |
| lidar_camera_synced_box | 543KB | Load at startup |
| lidar_segmentation | 531KB | Load at startup |
| projected_lidar_box | 611KB | Load at startup |
| camera_box | 291KB | Load at startup |
| camera_hkp | 116KB | Load at startup |
| lidar_hkp | 29KB | Load at startup |
| vehicle_pose | 28KB | Load at startup |
| stats | 24KB | Load at startup |
| camera_to_lidar_box_association | 24KB | Load at startup |
| camera_calibration | 8.8KB | Load at startup |
| lidar_calibration | 4.7KB | Load at startup |

### Component Schemas (Key Columns)

**lidar_box** (18,633 rows = ~94/frame × 199 frames):
- `key.laser_object_id` — tracking ID, persistent across frames
- `[LiDARBoxComponent].box.center.{x,y,z}` — double
- `[LiDARBoxComponent].box.size.{x,y,z}` — double
- `[LiDARBoxComponent].box.heading` — double
- `[LiDARBoxComponent].type` — int8 (1=vehicle, 2=pedestrian, 3=sign, 4=cyclist)
- `[LiDARBoxComponent].speed.{x,y,z}` — double
- `[LiDARBoxComponent].acceleration.{x,y,z}` — double

**vehicle_pose** (199 rows):
- `[VehiclePoseComponent].world_from_vehicle.transform` — fixed_size_list<double>[16] (4×4 matrix)

**lidar_calibration** (5 rows):
- `[LiDARCalibrationComponent].extrinsic.transform` — fixed_size_list<double>[16]
- `[LiDARCalibrationComponent].beam_inclination.{min,max}` — double
- `[LiDARCalibrationComponent].beam_inclination.values` — list<double>

**camera_calibration** (5 rows):
- `[CameraCalibrationComponent].intrinsic.{f_u,f_v,c_u,c_v,k1,k2,p1,p2,k3}` — double
- `[CameraCalibrationComponent].extrinsic.transform` — fixed_size_list<double>[16]
- `[CameraCalibrationComponent].{width,height}` — int32

**camera_image** (995 rows = 5 cameras × 199 frames):
- `[CameraImageComponent].image` — binary (JPEG)
- `[CameraImageComponent].pose.transform` — fixed_size_list<double>[16]

**lidar** (995 rows = 5 LiDARs × 199 frames):
- `[LiDARComponent].range_image_return1.values` — list<float>
- `[LiDARComponent].range_image_return1.shape` — fixed_size_list<int32>[3]
- `[LiDARComponent].range_image_return2.{values,shape}` — second return

## 3. Reference Projects (Prior Art)

### erksch/waymo-open-dataset-viewer (2019)
- **GitHub**: https://github.com/erksch/waymo-open-dataset-viewer
- **Stack**: Webpack + TypeScript, Python WebSocket server (TensorFlow GPU)
- **What it does**: LiDAR point cloud (5 sensors), 3D bounding boxes, point color by label/intensity, per-LiDAR toggle, frame slider, OrbitControls
- **What it doesn't do**: No camera images, no map data, no segmentation, no play/pause animation (commented out)
- **Architecture**: Python server reads v1.0 TFRecord → parses via TensorFlow → streams binary frames over WebSocket → Three.js renders in browser
- **Key limitation**: v1.0 only, TensorFlow dependency, requires Python server
- **What we learn**: Basic Three.js point cloud rendering approach (BufferGeometry + Points), WebSocket frame streaming pattern, UI layout inspiration

### Foxglove Studio (industry standard)
- **GitHub (open-source fork)**: https://github.com/AD-EYE/foxglove-opensource (v1.87.0, MPL-2.0)
- **Stack**: React + Three.js, desktop app (Electron)
- **What it does**: Multi-panel layout (diagnostics, aerial view, camera views, 3D perspective), camera segmentation overlay, play/pause/speed control, dual 3D views, camera vs LiDAR object count comparison
- **What it doesn't do**: No Waymo v2.0 Parquet support (requires ROS/MCAP conversion), no 3DGS
- **Key insight**: Panel-based "studio" UI pattern — resizable panels, multiple views of same data. Our UI layout is inspired by this.
- **Closed source since v2.0**: Only open-source fork (v1.87.0) is available

### hailanyi/3D-Detection-Tracking-Viewer (522 stars)
- **GitHub**: https://github.com/hailanyi/3D-Detection-Tracking-Viewer
- **Stack**: Python + VTK/Vedo, desktop app
- **What it does**: GT vs Prediction dual box rendering (red/blue), tracking ID color mapping via matplotlib colormaps, 3D car OBJ model rendering, 2D camera projection, supports KITTI + Waymo (OpenPCDet format)
- **What it doesn't do**: No browser, requires Python + preprocessed npy/pkl files, no 3DGS
- **What we adopt**: (1) Tracking ID → rainbow colormap per `laser_object_id`, (2) BoxType-specific 3D meshes (car/pedestrian/cyclist), (3) Camera frustum visualization in 3D view
- **What we skip**: GT vs Prediction comparison (not portfolio-relevant for a viewer tool)

### Street Gaussians (ECCV 2024)
- **GitHub**: https://github.com/zju3dv/street_gaussians
- **Paper**: Street Gaussians for Modeling Dynamic Urban Scenes
- **What it does**: Static background (standard 3DGS) + dynamic foreground (tracked pose + 4D SH). Clean background rendering with vehicle removal. Novel view synthesis including BEV.
- **Performance**: PSNR ~28, 135 FPS, ~30 min training per segment
- **Status**: Superseded by DriveStudio/OmniRe for this project (see D34).

### DriveStudio / OmniRe (ICLR 2025 Spotlight)
- **GitHub**: https://github.com/ziyc/drivestudio
- **Paper**: OmniRe: Omni Urban Scene Reconstruction (ICLR 2025 Spotlight)
- **What it does**: Unified driving scene reconstruction framework. Integrates static background + dynamic rigid objects (vehicles) + non-rigid elements (pedestrians) into a single reconstruction. Supports major datasets including Waymo, nuScenes, PandaSet.
- **Advantages vs Street Gaussians**: Better handling of non-rigid pedestrians, multi-dataset unified support, active community development
- **Why we use it**: Waymo lacks top-down camera data → need to generate BEV via 3DGS. OmniRe is the 2025 state-of-the-art and has direct Waymo dataset support.

### gsplat.js
- **GitHub**: https://github.com/dylanebert/gsplat.js
- **What it does**: Browser-native Gaussian Splat rendering. Loads .ply files, renders in WebGL.
- **Why we use it**: Renders Street Gaussians .ply output directly in browser. Separate canvas from R3F Three.js to avoid WebGL context conflicts.

## 4. Differentiation Matrix

| Feature | erksch (2019) | Foxglove (2024) | Rerun (2024) | Ours (2026) |
|---------|--------------|----------------|--------------|-------------|
| Dataset | v1.0 TFRecord | ROS/MCAP | Custom SDK | **v2.0 Parquet native** |
| Install | Python + TF server | Desktop app | pip install | **None (browser)** |
| LiDAR | ✅ | ✅ | ✅ | ✅ |
| Camera | ❌ | ✅ | ✅ | ✅ |
| Keyboard nav | ❌ | ✅ | ✅ | ✅ (←→, J/L, Space, ?) |
| Drag & drop | ❌ | ❌ | ❌ | **✅ Folder drop** |
| 3DGS BEV | ❌ | ❌ | ❌ | **✅ Killer Feature** |
| Cross-modal sync | ❌ | Partial | Partial | **✅ Frustum hover sync** |

## 4. Visualization Features (Implemented)

- **LiDAR point cloud**: 5 sensors (~168K points/frame), turbo colormap by intensity, per-sensor visibility toggle with sensor-specific coloring.
- **3D bounding boxes**: Wireframe or GLB model mode (car/pedestrian/cyclist). Tracking ID → rainbow colormap per `laser_object_id`.
- **Trajectory trails**: Past N frames of each tracked object's position rendered as fading polylines. Slider UI (0–199 frames).
- **Camera frustum visualization**: Wire frustums from camera intrinsic/extrinsic. Hover highlight sync with camera panel.
- **5 camera panels**: Horizontal strip (SL, FL, F, FR, SR). Preloaded JPEG with broken-image prevention. POV switching on click.
- **Timeline**: Frame scrubber, play/pause (spacebar), speed control (0.5x–4x), YouTube-style buffer bar showing cached frames.
- **Multi-segment**: Auto-discovers segments from `waymo_data/`, dropdown selector in header.

## 5. UI Design

Dark theme (#1a1a2e). Two tabs: [Sensor View] [3DGS Lab 🧪]

### Landing Page (No Data Loaded)
```
┌──────────────────────────────────────────────────┐
│                                                    │
│            Perception Studio                       │
│  In-browser perception explorer for Waymo Open     │
│  Dataset v2.0.1. No setup, no server — just drop   │
│  Parquet files and explore.                        │
│                                                    │
│          ┌─────────────────────────┐               │
│          │   📂 Drop waymo_data/   │               │
│          │   folder here           │               │
│          │   or  [Select Folder]   │               │
│          └─────────────────────────┘               │
│                                                    │
│  ▸ How to get data                                 │ ← Collapsible download script
│                                                    │
└──────────────────────────────────────────────────┘
```

### Sensor View (Data Loaded)
```
┌──────────────────────────────────────────────────┐
│ [Segment Selector ▾]            Perception Studio  │ ← Header (visible when >1 segment)
├──────────────────────────────────────────────────┤
│                                                    │
│   3D LiDAR View                                    │ ← Main viewport
│   (point cloud + bounding boxes + frustums         │    OrbitControls or camera POV
│    + trajectory trails)                            │
│                              [Sensor toggles]      │ ← Right panel overlay
│                              [BOX: MODE]           │
│                              [TRAIL: slider]       │
│                                                    │
│  [←→ frame · J L ±10 · Space play · ? shortcuts]   │ ← ShortcutHints (auto-fade 5s)
├──────────────────────────────────────────────────┤
│ SL | FL | FRONT | FR | SR                          │ ← Camera strip (160px)
│ (click = POV toggle, hover = frustum highlight)    │
├──────────────────────────────────────────────────┤
│ ▶  ────●──────────── 042/199   ×1                  │ ← Timeline + buffer bar
└──────────────────────────────────────────────────┘
```

### 3DGS Lab
- Full viewport gsplat.js renderer with pre-built .ply
- Separate tab to avoid WebGL context conflicts

## 6. Implementation Phases

1. ✅ **MVP (2 days)**: Parquet loading + LiDAR point cloud (range image→xyz) + bounding boxes + timeline
2. ✅ **Camera + Perception (1.5 days)**: 5 camera panels with parallel worker loading + Camera-LiDAR sync + POV switching + camera frustum visualization + hover highlight sync
3. ✅ **Multi-segment + Polish (0.5 day)**: Segment auto-discovery + dropdown selector + spacebar play/pause + trajectory trails
4. ✅ **UX Polish (1 day)**: Waymo-inspired dark theme + drag & drop folder loading + keyboard shortcuts + loading skeleton + landing page with download guide + README rewrite
5. ⬜ **3DGS BEV (1 day)**: DriveStudio/OmniRe training + .ply export + gsplat.js renderer
6. ⬜ **Deploy (0.5 day)**: GitHub Pages deployment, demo GIF, LinkedIn post

## 7. 3DGS Strategy

### Approach: DriveStudio / OmniRe (ICLR 2025 Spotlight)
- Unified framework: Static background + dynamic objects + non-rigid elements (pedestrians) integrated reconstruction
- Supports major datasets including Waymo, nuScenes, PandaSet
- Advantages vs Street Gaussians (ECCV 2024): Better non-rigid element handling, superior academic citations
- Export .ply → bundle with app → orthographic BEV camera

### Distribution
- Trained .ply is distributable under Waymo license (non-commercial)
- Same segment as README's recommended download → direct raw-vs-reconstructed comparison
- 3DGS Lab works with zero data download

### Perception Analysis Perspective
- 3D bounding box prediction: Single-frame input → single-frame inference
- 3DGS reconstruction: Training on ~200 frames entire sequence → dense multi-frame context
- 3DGS provides scene representation closer to ground truth than single-frame perception
- Perception engineer can cross-compare prediction vs 3DGS reconstruction → analyze false positive/negative causes
- LiDAR (sparse + accurate) + Camera (dense + 2D) + 3DGS (dense + 3D) = mutually complementary three views

## 8. Performance Notes

- LiDAR range image → xyz: CPU Web Worker (~5ms/frame). WebGPU Compute Shader implemented but deferred (see D8).
- Point cloud: BufferGeometry + Points
- Bounding boxes: InstancedMesh (avg 94/frame)
- Worker pools: 3 LiDAR workers + 2 camera workers (see D33). Promise.all parallel init.
- Row group pre-loading: 2 RGs loaded before render start to prevent playback stall (see D30).
- Lazy frame loading: current ± N frames in memory, prefetch ahead
- camera_image/lidar: row-group random access, never full file
- Calibrations + boxes + poses: full load at startup (<2MB total)
- Perf-critical rendering: useFrame + imperative refs

### R3F vs Vanilla Three.js — Performance Equivalence

R3F (@react-three/fiber) is a thin React binding over Three.js, and the render loop itself runs the same Three.js `WebGLRenderer`. There is no performance difference because:

1. **Render loop**: R3F's `useFrame` hook registers a callback directly to Three.js's `requestAnimationFrame` loop. When updating point cloud, we imperatively call `bufferGeometry.attributes.position.needsUpdate = true` — exactly the same code path as vanilla Three.js.

2. **Draw call minimization**: Creating 168K points as individual `<mesh>` elements causes React reconciliation overhead. Instead, we use `BufferGeometry` + `<points>` for **one draw call** of the entire point cloud. Bounding boxes use `InstancedMesh` for 94 objects in **1 draw call**.

3. **React overhead only during mount/unmount**: Three.js object creation/deletion happens only during component initialization, not in the 60fps render loop, so it doesn't impact performance.

4. **Why we chose R3F**: Waymo JD explicitly requires React/TypeScript. R3F demonstrates React ecosystem proficiency while maintaining Three.js performance. Declarative scene graph composition (camera panels, controls) also improves developer productivity.

## 9. Interview Narrative

"I built a browser-native perception explorer for Waymo Open Dataset v2.0 — no server, no install, just drag & drop Parquet files and explore LiDAR + camera + 3D annotations interactively. Existing tools like Foxglove require desktop install and ROS conversion; erksch's viewer needs a Python + TensorFlow server. Mine reads v2.0 Parquet directly in the browser with Web Worker pools for parallel BROTLI decompression and range image conversion. The key technical challenge was converting LiDAR range images to xyz point clouds entirely in the browser — something previously only done server-side with TensorFlow. For the 3DGS Bird's Eye View, I'm using DriveStudio/OmniRe (ICLR 2025 Spotlight) to provide dense scene context that complements sparse LiDAR and 2D camera views for perception debugging."

## 10. Decision Log

Chronological record of technical decisions and the reasoning behind them.

### D1. Project Name → `waymo-perception-studio`
- **Alternatives considered**: waymo-viewer, waymo-3d-viewer, waymo-scene-studio, wod-viewer
- **Reasoning**: "Waymo" gives brand recognition on LinkedIn/GitHub. "Perception" matches the Waymo Perception team and dataset domain. "Studio" implies multi-panel tool (not just a simple viewer) — justified by our multi-view layout, tab system, and panel customization. Foxglove also calls itself "Studio."
- **Rejected**: `wod-viewer` (too obscure — only paper authors know "WOD"), `waymo-scene-studio` (less domain-specific)

### D2. Build Tool → Vite over Webpack/Next.js
- **Alternatives considered**: Webpack (erksch used it), Next.js, Vite
- **Reasoning**: (1) Near-instant dev server startup via native ES modules — critical for iterating on Three.js scenes. Webpack bundles everything upfront. (2) 2026 standard for React + TS SPA — CRA is deprecated, Next.js is overkill for pure client-side app (no SSR needed). (3) Web Worker support out of the box (`new Worker(new URL(..., import.meta.url))`). (4) `waymo_data/` static serving trivial via config. (5) erksch used Webpack in 2019 — Vite modernizes the stack.
- **Rejected**: Next.js (SSR/SSG unnecessary, adds complexity for what is a pure browser-side tool)

### D3. 3D Library → @react-three/fiber (R3F) over Vanilla Three.js
- **Reasoning**: Waymo JD emphasizes React/TypeScript. R3F demonstrates React ecosystem mastery. Declarative patterns for UI-heavy panels (cameras, controls). Performance-critical paths (200K point cloud) handled via `useFrame` + imperative refs — no performance gap vs vanilla.
- **Trade-off accepted**: Slightly larger bundle, but developer velocity and interview alignment win.

### D4. Data Pipeline → Browser-native Parquet, no Python preprocessing
- **Alternatives considered**: (A) Python script → JSON/Binary, (B) Browser Parquet parsing
- **Reasoning**: Option B makes "Parquet native" claim genuine. Zero setup friction vs erksch (Python + TF). Leverages Parquet row-group random access — read footer metadata, then slice into specific frames without loading full file. This is only possible because Waymo v2.0 chose Parquet over v1.0 TFRecord (sequential-only).
- **Key insight**: `File.slice(offset, length)` in browser = HTTP Range Request for local files. Footer metadata gives row group offsets. 328MB camera_image becomes manageable.

### D5. No GitHub Pages for data → Local-first with deployed demo for 3DGS
- **Reasoning**: Waymo license prohibits data redistribution. erksch also requires "download yourself." But we go further: deployed URL hosts the app + bundled 3DGS .ply (trained weights are distributable). Sensor View requires user data; 3DGS Lab works immediately.
- **User flow impact**: Interview → share URL → 3DGS BEV loads instantly → "wow" moment → motivated to try Sensor View.

### D6. Data loading → .env path (dev) + folder drag & drop (deployed)
- **Alternatives considered**: (A) Drag & drop only, (B) showDirectoryPicker() only, (C) .env + dev server
- **Reasoning**: Developers clone → .env path → auto-load (zero friction). Visitors → drag & drop `waymo_data/` folder. `showDirectoryPicker()` as bonus for Chrome/Edge. Multiple entry points, same parsing pipeline.
- **Rejected**: Individual file drag & drop (17 component folders with same filename — would overwrite each other).

### D7. 3DGS .ply is distributable → bundle with app
- **Evidence**: Waymo license explicitly allows "trained model architectures, including weights and biases, developed using the Dataset" for non-commercial purposes.
- **Impact**: Killer feature (3DGS BEV) becomes zero-download demo. Same segment as recommended gsutil download → raw vs reconstructed comparison possible.

### D8. LiDAR data is range images → need spherical-to-cartesian conversion
- **Discovery**: Parquet analysis revealed `lidar` component stores range images (64×2650×4 for TOP, 200×600×4 for others), not xyz point clouds.
- **Impact**: Must implement range image → xyz conversion in browser. Uses beam inclination angles from `lidar_calibration` + extrinsic matrix. CPU intensive → Web Worker.
- **Positive spin**: This is non-trivial engineering that demonstrates understanding of LiDAR data representation — good interview talking point.

### D9. Tracking ID → zero-cost tracking visualization
- **Discovery**: `lidar_box` has `key.laser_object_id` that persists across frames for the same physical object. 115 unique objects in sample segment.
- **Impact**: Assign color per object ID with rainbow colormap → automatic tracking visualization with no additional ML. Same color = same car across 20 seconds.

### D10. Camera segmentation is 1Hz, not 10Hz (segmentation removed — see D24)
- **Discovery**: `camera_segmentation` has 100 rows (5 cameras × 20 frames), not 995. Segmentation is sampled at 1Hz.
- **Further discovery**: Segmentation data only exists for 1 of 9 downloaded segments, and only ~10 of 199 frames have lidar segmentation labels. Too sparse to be useful.
- **Outcome**: Segmentation feature entirely removed in D24.

### D11. Parquet row-group structure enables lazy loading without preprocessing
- **Discovery**: lidar file has 4 row groups (~50 frames each). camera_image also has 4 row groups. Browser can read specific row groups without loading the entire file.
- **Impact**: No preprocessing step needed. User drags folder → app reads Parquet footer → fetches frame data on demand. This is the fundamental architectural advantage over v1.0 TFRecord approach.
- **Interview angle**: "I chose v2.0 Parquet specifically because its columnar format enables browser-native random access — something impossible with v1.0 TFRecord."

### D12. Lazy loading mechanism — File.slice() vs HTTP Range Requests
- **Two paths, same interface**: hyparquet's `AsyncBuffer` abstracts byte access. We implement two backends:
  - **Drag & drop (File API)**: `file.slice(start, end).arrayBuffer()` — reads bytes from local file handle, no network involved.
  - **Static serving (Vite dev / deployed)**: `fetch(url, { headers: { Range: 'bytes=start-end' } })` → server responds `206 Partial Content` with only the requested bytes. Vite dev server, nginx, S3, Cloudflare Pages all support Range Requests by default.
- **Loading flow**: (1) Read last 8 bytes → get footer length. (2) Read footer (few KB) → get all row group offsets/sizes. (3) On frame request → read only that row group's byte range → decode.
- **Result**: 328MB camera_image file, but each frame request reads ~1.6MB. No server-side logic. No preprocessing.
- **Why this works**: Parquet was designed for distributed storage (HDFS, S3) where Range Requests are the access primitive. We're just using the same mechanism in the browser.
- **AsyncBuffer interface**:
  ```typescript
  interface AsyncBuffer {
    byteLength: number
    slice(start: number, end: number): Promise<ArrayBuffer>
  }
  // File API backend
  const fileBuffer: AsyncBuffer = {
    byteLength: file.size,
    slice: (s, e) => file.slice(s, e).arrayBuffer()
  }
  // HTTP Range Request backend
  const urlBuffer: AsyncBuffer = {
    byteLength: totalSize,
    slice: (s, e) => fetch(url, {
      headers: { Range: `bytes=${s}-${e - 1}` }
    }).then(r => r.arrayBuffer())
  }
  ```

### D13. Component merge strategy — JS port of Waymo's v2.merge()
- **Source**: Official Waymo Python SDK `v2.dataframe_utils.merge()` ([GitHub](https://github.com/waymo-research/waymo-open-dataset/blob/master/src/waymo_open_dataset/v2/dataframe_utils.py))
- **What the official API does**: (1) Auto-detect join keys via `key.` prefix. (2) Find common keys between two tables (intersection). (3) Optional `groupby → agg(list)` to prevent cartesian product when row counts differ. (4) Pandas merge on common keys.
- **Our JS port** (`src/utils/merge.ts`): Same logic, but using `Map` lookup instead of Pandas merge. Faster in browser (no Pandas overhead).
- **Key insight from reference projects**:
  - erksch (v1.0): No join needed — TFRecord bundles everything per frame.
  - 3D-Detection-Tracking-Viewer: Pre-processes into per-frame `.npy` files — join happens offline.
  - Waymo official v2.0: `key.frame_timestamp_micros` is the universal join key. Components with different granularity (per-frame vs per-sensor vs per-object) joined via common key intersection.
- **Our approach**: Port v2.merge() to TypeScript. `vehicle_pose` (199 rows) provides master frame list. All other components join via `key.frame_timestamp_micros` + optional `key.camera_name` / `key.laser_name`.
- **Interview angle**: "I studied the official Waymo v2 Python SDK's merge strategy and ported it to TypeScript for browser-native use — same relational join pattern, zero Python dependency."

### D15. Real Data Observations — Range Image Conversion

Observations from implementing range image → xyz conversion with actual Waymo v2.0 data:

**Range image format**:
- Values are `number[]` (not Float32Array). hyparquet decodes Parquet's float list as JS Array.
- 4 channels [range, intensity, elongation, nlz] are interleaved in flat array: `[r0, i0, e0, n0, r1, i1, e1, n1, ...]`
- Shape is `[height, width, channels]` = `[64, 2650, 4]` for TOP → 169,600 pixels × 4 values = 678,400 elements.

**Valid pixel ratio**:
- TOP lidar: 149,796 valid (range > 0) out of 169,600 total → **88.3%** valid.
- Invalid pixels have `range = -1` (not `0`). Filter condition `range > 0` correctly handles both.
- First ~32 pixels in row 0 are typically invalid (very top of FOV, sky region).

**Spatial distribution (vehicle frame)**:
- Range: 2.3m ~ 75m (this segment, SF downtown).
- X/Y: max distance ~75m from vehicle center, reasonable for urban lidar.
- **Z range: -20m ~ +30m** — much wider than the naive expectation of "ground at -2m, buildings at +10m". SF downtown has steep hills, underground parking ramp exits visible to lidar, and tall buildings/overpasses. Test thresholds adjusted to `[-25, +40]`.

**Beam inclination**:
- TOP (`laser_name=1`): `beam_inclination.values` is a 64-element `number[]` — non-uniform spacing, denser near horizon.
- FRONT/SIDE/REAR (`laser_name=2-5`): `beam_inclination.values` is `undefined` (not present in Parquet row). Must use `min`/`max` for uniform linear interpolation. Height is 200 rows for these sensors.

**Extrinsic calibration**:
- All 5 sensors have 16-element `number[]` (4×4 row-major). TOP's extrinsic includes ~1.8m Z translation (roof mount height).
- Extrinsic transforms sensor-frame xyz → vehicle-frame xyz. Vehicle frame: X=forward, Y=left, Z=up.

**Performance (CPU, single thread, M2 MacBook Air)**:
- TOP (64×2650, 149K valid points): ~2.3ms per frame
- All 5 sensors merged: ~5ms per frame, ~168K total points
- Already fast enough for 10Hz (100ms budget). WebGPU will further improve in real browser with hardware GPU.
- Dawn software renderer (Node.js `webgpu` pkg): ~35ms — slower due to no hardware acceleration. Browser Metal/Vulkan path expected ~1-2ms.

### D14. Waymo Parquet uses BROTLI compression → hyparquet-compressors required
- **Discovery**: All Waymo v2.0 Parquet files use BROTLI compression codec. hyparquet core only includes Snappy; BROTLI requires `hyparquet-compressors` plugin.
- **Why BROTLI**: Standard in Google's big data stack (BigQuery, Cloud Storage). ~20-30% better compression than GZIP on structured data. Waymo chose it for storage efficiency across petabyte-scale datasets.
- **Why this is good for us**: BROTLI was originally designed by Google for web content delivery (`Content-Encoding: br`). Browser-native support exists for HTTP streams. The JS WASM decompressor in hyparquet-compressors is well-optimized. So Waymo's infrastructure choice accidentally aligns perfectly with browser-based access.
- **Impact**: Must pass `compressors` option to all `parquetReadObjects()` calls. Added to `parquet.ts` as default. ~3KB additional dependency.

### D18. Data Worker — Completely separate Parquet I/O + conversion from main thread

- **Problem**: Frame switching took ~4.5 seconds. Root cause: BROTLI decompression + Parquet column decoding executed synchronously on main thread, causing UI frame drops.
- **Why simple prefetching doesn't work**: Prefetching just executes the same work earlier. BROTLI decompression itself monopolizes main thread CPU. 3-frame prefetch just increases blocking by 3×.
- **Solution**: `dataWorker.ts` — execute entire pipeline (fetch → BROTLI decompression → Parquet decoding → range image → xyz conversion) in Web Worker. Main thread receives only final `Float32Array` via `transfer` (zero-copy).
- **Architecture — maintaining module separation of concerns**:
  ```
  dataWorker.ts (thin orchestration, ~130 lines)
    ├── import { readFrameData } from parquet.ts      ← Parquet I/O responsibility (unchanged)
    ├── import { convertAllSensors } from rangeImage.ts ← Conversion responsibility (unchanged)
    └── postMessage(Float32Array, [buffer])             ← zero-copy transfer
  ```
  Worker imports existing modules and calls them. Each module maintains single responsibility. Vite's `new Worker(new URL(...))` syntax auto-bundles imports.
- **Communication pattern**: Promise-based request/response. `requestId` distinguishes concurrent prefetch requests.
  ```
  Main Thread                          Data Worker
  ──────────                          ───────────
  init(lidarUrl, calibrations) ──→   openParquetFile + buildFrameIndex
                               ←──   { type: 'ready' }
  loadFrame(requestId, ts)     ──→   readFrameData → convertAllSensors
                               ←──   { type: 'frameReady', positions: Float32Array } (transfer)
  loadFrame(requestId+1, ts)   ──→   (prefetch — concurrent processing)
  loadFrame(requestId+2, ts)   ──→
  ```
- **Prefetching**: After current frame loads, request next 3 frames from Worker. Worker processes on separate thread, so main thread has zero blocking. Sequential traversal hits cache for instant frame switch.
- **YouTube-style buffer bar**: `cachedFrames: number[]` state exposes cached frame indices to React. Timeline calculates contiguous ranges and displays as semi-transparent bar. User sees prefetch progress visually.
- **Performance impact**:
  - Before: Frame switch caused main thread blocking ~4.5s → UI freezes
  - After: Main thread blocking 0ms (only postMessage receive + cache store). Worker processes ~4.5s on separate thread, UI stays 60fps.
  - Prefetch hit: Frame switch 0ms (load from cache)
- **Interview point**: "I discovered that 162MB LiDAR Parquet BROTLI decompression blocked the main thread for 4.5 seconds, discovered the issue through profiling, and fixed it using a Data Worker + structured clone pattern to move CPU-intensive work off main thread. Existing parquet.ts and rangeImage.ts modules remained unchanged — I only moved execution context, demonstrating separation of concerns while solving the performance problem."

### D17. CPU conversion performance regression guard — `lastConvertMs < 50ms`
- **Purpose**: Auto-detect performance regression in `convertAllSensors()` (range image → xyz) algorithm when running local tests.
- **Baseline**: M2 MacBook Air, 5 sensors ~168K points → ~5ms. Threshold set to 50ms for 10× safety margin.
- **Applied to**: Frame loading tests in `useSceneStore.test.ts` (`nextFrame`, `seekFrame`, `first frame timing`) — `expect(lastConvertMs).toBeLessThan(50)` assertion.
- **Cannot detect**: Parquet I/O performance (I/O dominates 8 seconds, conversion is 5ms noise). GPU conversion (Dawn software renderer is unrealistic, need browser profiling).
- **Supplement**: `rangeImageBenchmark.test.ts` measures pure conversion across 5 iterations for averaging (excluded from default vitest run, manual execution).

### D16. State management → Zustand
- **Alternatives considered**: (A) Zustand, (B) `useSyncExternalStore` + TS class, (C) Context + `useReducer`
- **Reasoning**:
  - **(C) Context rejected**: State change causes entire tree re-render. Fatal for this project where we update 168K points every frame.
  - **(B) `useSyncExternalStore` reviewed**: Zero dependencies, good interview impact. But subscribe/emit/getSnapshot boilerplate grows large. Zustand internals use `useSyncExternalStore` anyway, so performance identical while code is much simpler.
  - **(A) Zustand adopted**: Selector-based slice subscription prevents unnecessary re-renders. Can access `getState()` outside React (for Worker results, etc). ~1KB. Minimal boilerplate. Middleware (`devtools`, `persist`) easily added later if needed.
- **Implementation**: `useSceneStore` — Zustand store integrates state + actions. Internal data (Parquet files, frame indices, cache) separated to module scope to exclude from React re-renders.

### D19. Azimuth correction — Reproducing Waymo SDK's `az_correction`

- **Problem**: FRONT/REAR/SIDE sensor point clouds spray at wrong orientation relative to vehicle. FRONT and REAR visually appear swapped.
- **Root cause analysis**: Inspecting Waymo SDK's `compute_range_image_polar()` code, discovered **sensor yaw correction** required in column→azimuth mapping:
  ```python
  az_correction = atan2(extrinsic[1][0], extrinsic[0][0])  # Sensor yaw angle
  azimuth = (ratio * 2 - 1) * π - az_correction
  ```
  Without this correction, all sensors use identical column→azimuth mapping, but sensors with large yaw (REAR: -179°, SIDE: ±90°) have severely rotated directions. FRONT (yaw≈1°) barely affected.
- **Fix**: Add `azCorrection` parameter to `computeAzimuths(width, azCorrection)`. `convertRangeImageToPointCloud()` calculates `atan2(e[4], e[0])` from extrinsic and passes it.
- **Additional fix — TOP sensor inclination flip**: TOP's non-uniform `beam_inclination.values` stored in ascending order (min→max), but range image row 0 = maximum angle (top). Read array in reverse order to match descending convention of uniform sensors.
- **Verification method**: Extract yaw/pitch/roll, translation, sensor-forward direction from each sensor's extrinsic 4×4 matrix and verify against physical mount position:
  - FRONT: yaw=1°, tx=4.07m (front mount, forward-facing) ✓
  - REAR: yaw=-179°, tx=-1.16m (rear mount, rear-facing) ✓
  - SIDE_LEFT: yaw=90°, tx=3.24m, ty=1.03m (front-left, left-facing) ✓
  - SIDE_RIGHT: yaw=-89°, tx=3.24m, ty=-1.03m (front-right, right-facing) ✓
  - TOP: yaw=148°, tz=2.18m (roof, 360° rotation) ✓
- **lidar_pose**: Analysis of Waymo v2's `lidar_pose` component shows TOP sensor only gets 199 rows (per-frame), shape `[64, 2650, 6]` per-pixel vehicle pose for ego-motion correction. Reduces ~1m positional distortion but not directional error source. Deferred for MVP.

### D20. Worker Pool — Parallel row group decompression

- **Problem**: Sequential loading of 4 row groups takes 1 RG load time × 4. Full segment caching (199 frames) takes too long.
- **Solution**: `WorkerPool` class. Create N independent Data Workers to decompress row groups in parallel.
  ```
  WorkerPool (concurrency=4)
    ├── Worker 0: init(lidarUrl, calibrations) → loadRowGroup(0)
    ├── Worker 1: init(lidarUrl, calibrations) → loadRowGroup(1)
    ├── Worker 2: init(lidarUrl, calibrations) → loadRowGroup(2)
    └── Worker 3: init(lidarUrl, calibrations) → loadRowGroup(3)
  ```
- **Design decisions**:
  - Each Worker independently opens Parquet file — no data dependencies between row groups, so safe.
  - `WORKER_CONCURRENCY = 4` constant adjustable. 4 row groups + 4 Workers = theoretical ~4× speedup.
  - WorkerPool internals track idle Worker detection + wait queue. When all Workers busy, requests queue; Worker completion auto-dispatches.
  - `prefetchAllRowGroups()` dispatches all row groups via `Promise.all` — Pool internally distributes.
- **Side effects analysis**:
  - Memory: Simultaneous decompression buffers per Worker. 4 RGs × ~40MB = ~160MB peak. Fine for desktop.
  - Frame order: Row group completion order is non-deterministic, but `cacheRowGroupFrames()` inserts to frameCache by timestamp, so order irrelevant.
  - I/O: Local file (File API) allows parallel slice calls. URL-based aware of browser connection limits (6 per domain) — 4 is safe.
- **Result**: All 4 row groups complete in time of 1 → segment caches almost immediately.

### D21. Camera Worker Pool — Separate JPEG decoding

- **Problem**: Camera images (328MB) also need BROTLI decompression + Parquet decoding. Processing in same Worker as LiDAR blocks LiDAR frame caching.
- **Solution**: Separate `CameraWorkerPool` (2 Workers). Camera is I/O-bound, so fewer Workers sufficient.
- **Architecture**: `cameraWorker.ts` opens camera_image Parquet, extracts JPEG ArrayBuffer per row group. Main thread stores in separate `cameraImageCache` (independent from LiDAR frameCache).
- **JPEG integrity**: Use hyparquet's `utf8: false` option to preserve binary original. Preload via `new Image()` — only swap src after decode complete — prevents broken image icon.

### D22. Camera Frustum Visualization + POV Switching

- **Camera frustums**: Using `camera_calibration` intrinsic (f_u, f_v, c_u, c_v, width, height) + extrinsic (4×4 matrix), render each camera's field-of-view as 3D trapezoidal wireframe.
  - FOV calculation: `fovX = 2 * atan(width / (2 * f_u))`, `fovY = 2 * atan(height / (2 * f_v))`
  - Generate 4 corner points on near plane → transform to vehicle frame via extrinsic inverse
  - Render with `THREE.LineSegments` (origin → 4 corners + 4 edges)
- **POV switching**: Click camera panel → set `activeCam` state → disable OrbitControls → `PovController` performs smooth position lerp + quaternion slerp in `useFrame`. ESC or button returns to orbital mode.
  - **Entry**: Save orbital camera's position/quaternion/fov/target to `savedState`. Apply optical→Three.js transform (180° X rotation) to POV camera's extrinsic quaternion, then slerp.
  - **Exit**: Directly slerp to saved quaternion. Skip `lookAt()` — bird's-eye view (camera pointing parallel to Z) causes gimbal lock with up vector `(0,0,1)`, so use stored quaternion instead of lookAt-based computation.
  - **Inter-camera transition**: During exit animation, clicking another camera updates exit destination to new `savedState`, transitioning smoothly without interruption.
- **Frustum display**: Default shows only far plane quad (base). Hover/active adds origin→corner edges (pyramid). Split `buildFrustumBase()` + `buildFrustumEdges()`. FRUSTUM_FAR = 2m.
  - FRONT camera (wide vFOV) vs SIDE camera (narrow vFOV) vertical size difference reflects actual FOV difference — normal operation.
- **Hover highlight sync**: Camera panel hover → `hoveredCam` state → CameraFrustums highlights that frustum white + opaque. Others dim (0.6).

### D23. Multi-Segment Support

- **Auto-discovery**: Extract segment IDs from `.parquet` files in `waymo_data/vehicle_pose/` folder. Verify existence via `fetch()` + HTTP status.
- **UI**: 2+ segments → show `<select>` dropdown in header. Selection triggers `reset()` → open 6 Parquet files from new segment → reinitialize Workers → prefetch.
- **Error handling**: Wrap `openParquetFile()` in try/catch for optional components (segmentation, etc.) that may not exist. Log with `console.warn` only.

### D24. Segmentation Removal Decision

- **Background**: Attempted lidar_segmentation + camera_segmentation visualization.
- **Problems discovered**:
  1. Only 1 of 9 segments has segmentation data
  2. That segment has labels in only ~10 of 199 frames (sparse annotation)
  3. camera_segmentation is 1Hz (1 frame per 10)
  4. Suspected data loss when posting Int32Array via Worker postMessage (all labels became -1)
- **Decision**: Remove all segmentation code entirely. Delete `semanticColors.ts`, `extractSegmentationLabels()`, `ColorMode` type, worker setSegmentation, CameraPanel segmentation overlay, etc.
- **Lesson**: Always verify data availability before implementing features. Waymo v2.0 segmentation exists only for subset of full dataset.

### D25. Spacebar Play/Pause + Auto-Rewind

- **Implementation**: Global `keydown` listener in `App.tsx`. `Space` key → `togglePlayback()`.
- **Input protection**: Check `e.target.tagName` — skip if INPUT/TEXTAREA/SELECT (prevent accidental toggle during text entry).
- **Auto-rewind**: Reaching last frame (currentFrameIndex >= totalFrames - 1) during playback → auto-jump to frame 0, resume playback.

### D26. Waymo-Inspired UI Theme — Dark theme + Color palette

- **Background**: Stock R3F scene looked like dev tool, not portfolio-quality. Need professional UI aligned with Waymo brand.
- **Decision**: Dark theme (#1a1a2e background) + Waymo teal (#00bfa5) accent. Full-screen 3D viewport + bottom camera strip + timeline.
- **Details**: LiDAR viewport background black (#0a0a1a), camera panels 160px fixed, timeline controls teal, segment selector + status in header bar.

### D27. Drag & Drop + Folder Picker — Pass File objects directly to Worker

- **Problem**: GitHub Pages has no `/api/segments` endpoint. Users must drag & drop `waymo_data/` folder.
- **Solution**: New `folderScan.ts` util. Handle `FileSystemDirectoryHandle` (Chrome `showDirectoryPicker()`) or `DataTransferItem.webkitGetAsEntry()` (drag & drop) for folder traversal.
  - Parse `{component}/{segment_id}.parquet` structure → return `Map<segmentId, Map<component, File>>`
  - Auto-detect segments by `vehicle_pose/` subfolder presence
  - Handle direct component folder drop (no parent `waymo_data/` folder)
- **Worker delivery**: Pass `File` object directly via `postMessage` (structured clone). Worker uses `File.slice()` → `ArrayBuffer` for Parquet reading. No `URL.createObjectURL()` needed.
  - Previous plan considered blob URL approach, but since `File` is structured-cloneable and `hyparquet` supports File directly, simpler approach adopted.
- **Store change**: Add `loadFromFiles(segments)` action. Store internal `filesBySegment` as File Map. `selectSegment()` auto-branches file vs URL mode.

### D28. Segment Metadata — Utilize stats component

- **Discovery**: `stats` Parquet contains segment-level metadata: `location`, `time_of_day`, `weather`, etc.
- **Usage**: Dropdown options show truncated segment ID + location + time. Example: `#1 · 10023947… · SF Downtown · Day`
- **LOCATION_LABELS mapping**: Convert Waymo official codes (`location_sf_downtown` → `SF Downtown`, `location_phx_mesa` → `Phoenix Mesa`, etc.) to human-readable labels.

### D29. Keyboard Shortcuts — Frame navigation + ShortcutHints

- **Implementation**: Global `keydown` listener in `App.tsx`.
  - `← →`: ±1 frame
  - `J L`: ±10 frames (fast navigation)
  - `Space`: play/pause
  - `Shift+← →`: previous/next segment
  - `?`: toggle ShortcutHints
- **ShortcutHints component**: Display for 5s on first load, then auto-fade (CSS opacity transition 300ms). `?` key toggles show/hide. Any keypress (except `?`) triggers fade-out.
- **Input protection**: All keyboard handlers skip if `e.target.tagName` is INPUT/TEXTAREA/SELECT.

### D30. 2 Row Groups Pre-load — Prevent playback stutter at RG boundary

- **Problem**: Load first RG, start rendering → auto-play reaches second RG boundary, still loading, playback stutters.
- **Existing mechanism**: `setInterval` playback retries on cache miss (100ms polling). Doesn't pause but visible stutter.
- **Tried then reverted**: Track in-flight RG loading with `rgLoadPromises` Map, await in `loadFrame`. Existing poll-based retry already worked; unnecessary complexity — `git checkout` immediately.
- **Adopted approach**: Expand `loadDataset()` first-frame phase to parallel-load RG 0 + RG 1. LiDAR and Camera each preload 2 RGs via `Promise.all`. ~100 frames cached before playback begins, giving prefetch time to catch up.
  ```ts
  // LiDAR RG 0+1
  firstFramePromises.push(loadAndCacheRowGroup(0, set))
  if (internal.numRowGroups > 1) firstFramePromises.push(loadAndCacheRowGroup(1, set))
  // Camera RG 0+1
  firstFramePromises.push(loadAndCacheCameraRowGroup(0, set))
  if (internal.cameraNumRowGroups > 1) firstFramePromises.push(loadAndCacheCameraRowGroup(1, set))
  await Promise.all(firstFramePromises)
  ```
- **Lesson**: Simple solution (load more upfront) beats complex one (pipeline restructuring).

### D31. Loading Skeleton — 4-step progress display + camera strip shimmer

- **Loading UX**: `loadStep` state tracks 4 stages:
  1. `calibration` — "Loading calibrations…"
  2. `metadata` — "Loading frame metadata…"
  3. `first-frame` — "Decoding first frame…"
  4. `ready` — render begins
- **3D viewport**: Semi-transparent overlay + stage message + CSS pulse animation during load.
- **Camera strip skeleton**: 5 camera slots with shimmer animation (gradient slide). Real images replace when loaded.
- **De-duplication**: Center loading skeleton already shows progress, so removed "Loading… 100%" text from header and ⏳ emoji from timeline.

### D32. Landing Page — Intro + download guide

- **Problem**: Visitors without README context see "drag and drop" with no context — what are they dropping?
- **Solution**: Add intro section above DropZone:
  - Title: "Perception Studio"
  - Subtitle: "In-browser perception explorer for Waymo Open Dataset v2.0.1. No setup, no server — just drop Parquet files and explore."
- **DownloadGuide component**: Collapsible shell script guide.
  - "How to get data ▸" expands gsutil download script (N=3 segments default)
  - Copy button (navigator.clipboard.writeText)
  - Scrollable with custom transparent scrollbar for long script
- **Product naming**: "Browser-based 3D viewer" → "In-browser perception explorer". Follow Foxglove/Rerun's self-naming convention. Drop "Zero-install" (vague) → "No setup, no server" (specific).

### D33. Worker Concurrency Tuning — LiDAR 3 + Camera 2

- **Change**: LiDAR Worker Pool 4 → 3. Camera Worker Pool stays 2.
- **Reasoning**: 5 concurrent Workers total. LiDAR CPU-intensive (BROTLI + range image), Camera I/O-bound (BROTLI + JPEG extract). 3+2=5 strikes balance for most machines.
- **Worker init**: `initWorkerPools()` parallel-initialize LiDAR and Camera Pools via `Promise.all` — ~50% faster than sequential.

### D34. 3DGS Strategy Update — Prefer DriveStudio/OmniRe

- **Background**: Street Gaussians (ECCV 2024) vs DriveStudio/OmniRe (ICLR 2025 Spotlight) comparison.
- **DriveStudio advantages**:
  - Unified framework supporting Waymo, nuScenes, PandaSet
  - OmniRe (ICLR 2025 Spotlight): Static background + dynamic objects + non-rigid elements (pedestrians) integrated reconstruction
  - Active development + community (frequent GitHub updates)
  - Favorable for academic paper citations/comparisons
- **Street Gaussians limitation**: Dynamic foreground handles rigid-body only (weak on non-rigid like pedestrians).
- **Strategic shift**: Generate .ply via DriveStudio/OmniRe pipeline for 3DGS Lab.
- **Perception analysis significance**:
  - 3D box prediction uses single-frame LiDAR/Camera → single-frame inference
  - 3DGS trains on ~200-frame sequence → dense multi-frame context
  - Result: 3DGS reconstruction closer to ground truth than single-frame prediction
  - LiDAR (sparse+accurate) + Camera (dense+2D) + 3DGS (dense+3D) = mutually complementary views
  - Engineer can cross-compare prediction vs 3DGS to trace false positive/negative causes

### D35. LiDAR Colormap Modes — 4 visualization attributes

- **Background**: Point cloud previously intensity-only → insufficient for perception analysis. Auto industry standard: range/height/elongation colormaps.
- **Implementation**: Extend `POINT_STRIDE` from 4 → 6 for `[x, y, z, intensity, range, elongation]` interleaved. Dedicated palette per attribute:
  - **Intensity** (0–1): dark → cyan → yellow → white (turbo-like)
  - **Height/Z** (-3–8m): blue → green → yellow → red (ground/object separation)
  - **Range** (0–75m): green → yellow → red → dark (distance-based density analysis)
  - **Elongation** (0–1): dark → purple → magenta → pink (reflection characteristic)
- **R3F buffer update timing issue**: `useEffect` + `needsUpdate = true` invalidated by R3F reconciler's `<bufferAttribute {...posAttr} />` reapplication. **Fix**: dirty ref + `useFrame` pattern — perform buffer update in Three.js render loop, bypassing reconciler.
- **Remove per-sensor colors**: All 5 sensors use identical 4-channel range image format, so sensor filtering always applies selected colormap (removed sensor-specific colors).

### D36. Unified Frosted Glass Control Panel

- **Problem**: Individual UI elements (buttons, labels) lack background — poor readability on bright scenes. Adding frost to labels only breaks design cohesion.
- **Solution**: Wrap entire control panel in single frosted container:
  - `backgroundColor: rgba(26, 31, 53, 0.75)` + `backdropFilter: blur(12px)`
  - Inner elements no individual backgrounds; active elements only get `rgba(255,255,255,0.06)` subtle highlight
  - Sections divided by 1px `colors.border` separator
- **Label change**: "Sensors" → "LiDAR" (more intuitive)
- **Conditional UI**: Hide opacity slider when all sensors off (`visibleSensors.size > 0` condition)

### D37. POV Exit Gimbal Lock Fix — Direct Quaternion Slerp

- **Problem**: Bird's-eye view (Z-axis straight down) → enter POV → exit causes abnormal camera rotation.
- **Root cause**: Exit animation calculates target quaternion every frame via `Matrix4.lookAt(pos, target, up=(0,0,1))`. When view direction near-parallel to Z, lookAt's up vector conflicts with forward → unstable rotation matrix → gimbal lock.
- **Fix**: On POV entry, save orbital camera's `quaternion` to `savedState` along with position. Exit via direct `camera.quaternion.slerp(rt.quat, LERP_SPEED)` — no lookAt(). Quaternion slerp has no singularities, stable for all camera angles.
- **Lesson**: `lookAt()` convenient but degenerate when up-vector parallel to view-direction (top-down, bottom-up). Prefer direct quaternion storage/interpolation for robustness.

## 11. Progress Tracker

1. ✅ Project scaffolding (Vite + React + TS + R3F)
2. ✅ Waymo Dataset v2.0 download (sample segment)
3. ✅ Parquet schema analysis
4. ✅ Parquet loading infrastructure (hyparquet + merge + tests — 27 passing)
5. ✅ Range image → xyz pure math (rangeImage.ts + 14 tests passing against real Waymo data)
6. ✅ CPU Web Worker + WebGPU compute shader (dataWorker.ts, rangeImageGpu.ts)
7. ✅ Phase 1 MVP: LiDAR point cloud + 3D bounding boxes (wireframe + GLB models) + timeline + worker pool
8. ✅ Camera image panels: 5-camera strip with parallel camera worker loading + preloaded JPEG
9. ✅ Camera frustum visualization + POV switching (orbital ↔ camera perspective)
10. ✅ Hover highlight sync between camera panel and 3D frustums
11. ✅ Multi-segment support: auto-discovery from waymo_data/ + dropdown selector
12. ✅ Trajectory trails: past N frames of object positions as fading polylines
13. ✅ Spacebar play/pause with auto-rewind at end
14. ❌ Segmentation removed (sparse data: 1/9 segments, ~10/199 frames)
15. ✅ Waymo-inspired dark theme + full-screen layout redesign
16. ✅ Drag & drop folder loading + File System Access API + folder picker
17. ✅ Keyboard shortcuts (←→, J/L, Shift+←→, Space, ?) + ShortcutHints overlay
18. ✅ Loading skeleton: 4-step progress + camera strip shimmer + 2 RG pre-loading
19. ✅ Landing page: intro section + collapsible download guide with copy button
20. ✅ Segment dropdown with truncated ID + location/time metadata
21. ✅ README rewrite for public-facing GitHub Pages deployment
22. ✅ LiDAR colormap modes (intensity/height/range/elongation) + unified frosted control panel
23. ✅ POV gimbal lock fix (quaternion slerp) + frustum base/edge split display
24. ✅ World coordinate mode + frame-0-relative normalization
25. ✅ Mock parquet test fixtures + Worker mock for vitest
26. ✅ GPU azimuth correction bug fix
27. ⬜ DriveStudio/OmniRe 3DGS training + .ply export
28. ⬜ gsplat.js integration for 3DGS BEV tab
29. ⬜ GitHub Pages deployment + demo GIF + LinkedIn post
30. ⬜ IEEE VIS 2026 Short Paper (deadline: April 30)
