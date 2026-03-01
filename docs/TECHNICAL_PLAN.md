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
- **What it does**: 통합 driving scene reconstruction 프레임워크. 정적 배경 + 동적 rigid 객체(차량) + non-rigid 요소(보행자) 통합 재구성. Waymo, nuScenes, PandaSet 등 주요 데이터셋 지원.
- **Street Gaussians 대비 장점**: non-rigid 보행자 처리, 멀티 데이터셋 통합 지원, 활발한 커뮤니티
- **Why we use it**: Waymo에 top-down camera 없음 → 3DGS로 BEV 생성 필요. OmniRe가 2025 최신 SOTA이며 Waymo 데이터셋 직접 지원.

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
- 통합 프레임워크: 정적 배경 + 동적 객체 + non-rigid 요소(보행자) 통합 재구성
- Waymo, nuScenes, PandaSet 등 주요 데이터셋 지원
- Street Gaussians (ECCV 2024) 대비: non-rigid 요소 처리 우수, 학술 인용에 유리
- Export .ply → bundle with app → orthographic BEV camera

### Distribution
- Trained .ply is distributable under Waymo license (non-commercial)
- Same segment as README's recommended download → direct raw-vs-reconstructed comparison
- 3DGS Lab works with zero data download

### Perception Analysis 관점
- 3D bounding box prediction: 1프레임 입력 → single-frame 추론
- 3DGS reconstruction: ~200프레임 전체 학습 → dense multi-frame context
- 3DGS가 single-frame perception보다 ground truth에 가까운 scene representation 제공
- Perception engineer가 prediction과 3DGS를 교차 비교 → false positive/negative 원인 분석 가능
- LiDAR (sparse + accurate) + Camera (dense + 2D) + 3DGS (dense + 3D) = 상호 보완적 3가지 뷰

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

### R3F vs Vanilla Three.js — 성능 동등성

R3F(@react-three/fiber)는 Three.js 위의 얇은 React 바인딩이며, 렌더 루프 자체는 동일한 Three.js `WebGLRenderer`가 실행한다. 성능 차이가 없는 이유:

1. **렌더 루프**: R3F의 `useFrame` 훅은 Three.js의 `requestAnimationFrame` 루프에 직접 콜백을 등록. 포인트 클라우드 업데이트 시 `bufferGeometry.attributes.position.needsUpdate = true`를 imperative하게 호출 — vanilla Three.js와 완전히 동일한 코드 경로.

2. **Draw call 최소화**: 168K 포인트를 개별 `<mesh>`로 만들면 React reconciliation 오버헤드 발생. 우리는 `BufferGeometry` + `<points>`로 **한 번의 draw call**에 전체 포인트 클라우드 렌더. 바운딩 박스도 `InstancedMesh`로 94개를 **1 draw call**.

3. **React 오버헤드 구간**: 컴포넌트 마운트/언마운트 시 Three.js 오브젝트 생성/삭제에만 발생. 이건 초기화 때 한 번이고 60fps 렌더 루프에는 영향 없음.

4. **R3F 선택 이유**: Waymo JD가 React/TypeScript를 명시. R3F는 React 생태계 숙련도를 보여주면서도 Three.js 성능을 그대로 유지. 선언적 씬 그래프 구성 (카메라 패널, 컨트롤 등)에서 개발 생산성도 높음.

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

실제 Waymo v2.0 데이터로 range image → xyz 변환을 구현하면서 발견한 사실들:

**Range image format**:
- Values는 `number[]` (not Float32Array). hyparquet가 Parquet의 float list를 JS Array로 디코딩함.
- 4 channels [range, intensity, elongation, nlz] 이 flat array로 인터리브됨: `[r0, i0, e0, n0, r1, i1, e1, n1, ...]`
- Shape은 `[height, width, channels]` = `[64, 2650, 4]` for TOP → 169,600 pixels × 4 values = 678,400 elements.

**Valid pixel ratio**:
- TOP lidar: 149,796 valid (range > 0) out of 169,600 total → **88.3%** valid.
- Invalid pixels have `range = -1` (not `0`). Filter condition `range > 0` correctly handles both.
- First ~32 pixels in row 0 are typically invalid (very top of FOV, sky region).

**Spatial distribution (vehicle frame)**:
- Range: 2.3m ~ 75m (this segment, SF downtown).
- X/Y: max distance ~75m from vehicle center, reasonable for urban lidar.
- **Z range: -20m ~ +30m** — much wider than the naïve expectation of "ground at -2m, buildings at +10m". SF downtown has steep hills, underground parking ramp exits visible to lidar, and tall buildings/overpasses. Test thresholds adjusted to `[-25, +40]`.

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

### D18. Data Worker — Parquet I/O + 변환을 메인 스레드에서 완전 분리

- **문제**: 프레임 전환에 ~4.5초 소요. 원인은 BROTLI 해제 + Parquet 컬럼 디코딩이 메인 스레드에서 동기적으로 실행되어 UI 프레임 드랍 유발.
- **단순 프리페칭이 안 되는 이유**: 프리페칭은 동일 작업을 미리 실행할 뿐, BROTLI 해제 자체가 메인 스레드 CPU를 점유. 3프레임 프리페칭 시 블로킹이 3배로 증가.
- **해결**: `dataWorker.ts` — 전체 파이프라인(fetch → BROTLI 해제 → Parquet 디코딩 → range image → xyz 변환)을 Web Worker에서 실행. 메인 스레드는 최종 `Float32Array`만 `transfer`로 수신 (zero-copy).
- **아키텍처 — 모듈 책임 분리 유지**:
  ```
  dataWorker.ts (얇은 오케스트레이션, ~130줄)
    ├── import { readFrameData } from parquet.ts      ← Parquet I/O 책임 (변경 없음)
    ├── import { convertAllSensors } from rangeImage.ts ← 변환 책임 (변경 없음)
    └── postMessage(Float32Array, [buffer])             ← zero-copy transfer
  ```
  Worker는 기존 모듈을 import해서 호출만 함. 각 모듈의 단일 책임 원칙 유지. Vite의 `new Worker(new URL(...))` 문법이 import를 자동 번들링.
- **통신 패턴**: Promise-based request/response. `requestId`로 동시 다발 프리페치 요청 구분.
  ```
  Main Thread                          Data Worker
  ──────────                          ───────────
  init(lidarUrl, calibrations) ──→   openParquetFile + buildFrameIndex
                               ←──   { type: 'ready' }
  loadFrame(requestId, ts)     ──→   readFrameData → convertAllSensors
                               ←──   { type: 'frameReady', positions: Float32Array } (transfer)
  loadFrame(requestId+1, ts)   ──→   (프리페치 — 동시 처리)
  loadFrame(requestId+2, ts)   ──→
  ```
- **프리페칭**: 현재 프레임 로드 완료 후 다음 3프레임을 Worker에 요청. Worker가 별도 스레드에서 처리하므로 메인 스레드 블로킹 제로. 순차 탐색 시 캐시 히트로 즉시 전환.
- **YouTube-style buffer bar**: `cachedFrames: number[]` 상태로 캐시된 프레임 인덱스를 React에 노출. Timeline에서 연속 구간을 계산하여 반투명 바로 표시. 유저가 프리페치 진행 상황을 시각적으로 확인 가능.
- **성능 영향**:
  - 이전: 프레임 전환 시 메인 스레드 ~4.5초 블로킹 → UI 멈춤
  - 이후: 메인 스레드 블로킹 0ms (postMessage 수신 + 캐시 저장만). Worker에서 ~4.5초 처리되지만 UI는 60fps 유지.
  - 프리페치 적중 시: 프레임 전환 0ms (캐시에서 즉시 로드)
- **면접 포인트**: "162MB LiDAR Parquet의 BROTLI 해제가 메인 스레드를 4.5초 블로킹하는 문제를 발견하고, Data Worker + transfer 패턴으로 메인 스레드 블로킹을 제로로 만들었습니다. 기존 parquet.ts와 rangeImage.ts 모듈은 변경 없이 Worker에서 import하여 재사용 — 단일 책임 원칙을 유지하면서 실행 컨텍스트만 이동했습니다."

### D17. CPU 변환 성능 regression guard — `lastConvertMs < 50ms`
- **목적**: `convertAllSensors()` (range image → xyz) 알고리즘 변경 시 성능 퇴행을 로컬 테스트에서 자동 감지.
- **측정 기준**: M2 MacBook Air에서 5 센서 ~168K 포인트 기준 ~5ms. Threshold은 10배 마진인 50ms.
- **적용 위치**: `useSceneStore.test.ts`의 frame 로딩 테스트 (`nextFrame`, `seekFrame`, `first frame timing`)에 `expect(lastConvertMs).toBeLessThan(50)` assertion.
- **감지 불가능한 것**: Parquet I/O 성능 (8초 중 5ms만 변환이므로 I/O 노이즈에 묻힘). GPU 변환 (Dawn 소프트웨어 렌더러는 비현실적, 브라우저 프로파일링 필요).
- **보완**: `rangeImageBenchmark.test.ts`에서 순수 변환만 5회 반복 평균 측정 가능 (기본 vitest run에서 제외, 수동 실행).

### D16. State management → Zustand
- **Alternatives considered**: (A) Zustand, (B) `useSyncExternalStore` + TS class, (C) Context + `useReducer`
- **Reasoning**:
  - **(C) Context 탈락**: 상태 하나 바뀌면 트리 전체 리렌더. 168K 포인트 매 프레임 업데이트하는 이 프로젝트에서 치명적.
  - **(B) `useSyncExternalStore` 검토**: 의존성 제로, 면접 임팩트. 그러나 subscribe/emit/getSnapshot 보일러플레이트가 커짐. Zustand 내부도 `useSyncExternalStore` 기반이므로 성능 동일하면서 코드가 훨씬 심플.
  - **(A) Zustand 채택**: selector 기반 슬라이스 구독으로 불필요한 리렌더 없음. React 밖에서 `getState()` 접근 가능 (Worker 결과 반영 등). ~1KB. 보일러플레이트 최소. 나중에 `devtools`/`persist` middleware 필요하면 한 줄 추가로 끝.
- **구현**: `useSceneStore` — Zustand store에 state + actions 통합. 내부 데이터(Parquet files, frame indices, cache)는 모듈 스코프에 분리하여 React 리렌더에서 제외.

### D19. Azimuth correction — Waymo SDK의 `az_correction` 재현

- **문제**: FRONT/REAR/SIDE 센서의 포인트 클라우드가 차량 기준으로 잘못된 방향에 뿌려짐. FRONT와 REAR가 시각적으로 뒤바뀌어 보임.
- **원인 분석**: Waymo SDK의 `compute_range_image_polar()` 코드를 확인한 결과, column→azimuth 매핑에 **센서 yaw 보정값**이 필요함을 발견:
  ```python
  az_correction = atan2(extrinsic[1][0], extrinsic[0][0])  # 센서의 yaw 각도
  azimuth = (ratio * 2 - 1) * π - az_correction
  ```
  이 보정 없이는 모든 센서가 동일한 column→azimuth 매핑을 사용하게 되어, yaw가 큰 센서(REAR: -179°, SIDE: ±90°)에서 방향이 크게 틀어짐. FRONT(yaw≈1°)는 거의 영향 없음.
- **해결**: `computeAzimuths(width, azCorrection)` 함수에 `azCorrection` 파라미터 추가. `convertRangeImageToPointCloud()`에서 extrinsic으로부터 `atan2(e[4], e[0])` 계산하여 전달.
- **추가 수정 — TOP 센서 inclination 반전**: TOP의 non-uniform `beam_inclination.values`가 ascending 순서(min→max)로 저장되어 있으나, range image의 row 0 = max(상단). 배열을 역순으로 읽어 uniform 센서와 동일한 descending 컨벤션으로 맞춤.
- **검증 방법**: 각 센서의 extrinsic 4×4 행렬에서 yaw/pitch/roll, translation, sensor-forward 방향을 추출하여 물리적 장착 위치와 대조:
  - FRONT: yaw=1°, tx=4.07m (전방 장착, 정면 방향) ✓
  - REAR: yaw=-179°, tx=-1.16m (후방 장착, 후방 방향) ✓
  - SIDE_LEFT: yaw=90°, tx=3.24m, ty=1.03m (좌측 전방, 왼쪽 방향) ✓
  - SIDE_RIGHT: yaw=-89°, tx=3.24m, ty=-1.03m (우측 전방, 오른쪽 방향) ✓
  - TOP: yaw=148°, tz=2.18m (지붕 위, 360° 회전) ✓
- **lidar_pose**: Waymo v2의 `lidar_pose` 컴포넌트 분석 결과, TOP 센서만 199행(프레임당 1행), shape `[64, 2650, 6]`의 per-pixel vehicle pose 제공. ego-motion 보정용으로 ~1m 위치 왜곡을 줄이지만, 방향성 오류의 원인은 아님. MVP에서는 미적용.

### D20. Worker Pool — 병렬 row group 디컴프레션

- **문제**: 4개 row group을 순차 로딩하면 전체 세그먼트(199프레임) 캐싱에 row group 1개 시간 × 4 소요.
- **해결**: `WorkerPool` 클래스 도입. N개의 독립 Data Worker를 생성하여 row group을 병렬 디컴프레스.
  ```
  WorkerPool (concurrency=4)
    ├── Worker 0: init(lidarUrl, calibrations) → loadRowGroup(0)
    ├── Worker 1: init(lidarUrl, calibrations) → loadRowGroup(1)
    ├── Worker 2: init(lidarUrl, calibrations) → loadRowGroup(2)
    └── Worker 3: init(lidarUrl, calibrations) → loadRowGroup(3)
  ```
- **설계 결정사항**:
  - 각 Worker가 독립적으로 Parquet 파일을 open — row group 간 데이터 의존성 없으므로 안전.
  - `WORKER_CONCURRENCY = 4` 상수로 조절 가능. 4개 row group에 4개 Worker = 이론적 ~4배 속도.
  - WorkerPool 내부에 idle worker 탐지 + 대기 큐 구현. 모든 Worker busy 시 요청이 큐에 들어가고, Worker 완료 시 자동 dispatch.
  - `prefetchAllRowGroups()`가 모든 row group을 `Promise.all`로 한번에 dispatch — Pool이 내부적으로 분배.
- **사이드 이펙트 분석**:
  - 메모리: Worker당 디컴프레스 버퍼 동시 점유. 4개 RG × ~40MB = ~160MB 피크. 데스크탑에서는 문제없음.
  - 프레임 순서: row group 완료 순서가 비결정적이지만, `cacheRowGroupFrames()`가 timestamp 기반으로 frameCache에 삽입하므로 순서 무관.
  - I/O: 로컬 파일(File API)은 병렬 slice 호출 가능. URL 기반은 브라우저 커넥션 제한(도메인당 6개)에 주의 필요하나, 4개는 안전 범위.
- **결과**: 1개 row group 로딩 시간에 4개가 동시 완료 — 전체 세그먼트가 거의 즉시 캐싱됨.

### D21. Camera Worker Pool — 카메라 JPEG 디코딩 분리

- **문제**: 카메라 이미지(328MB)도 BROTLI 해제 + Parquet 디코딩이 필요. LiDAR Worker와 동일 Worker에서 처리하면 카메라 로딩이 LiDAR 프레임 캐싱을 블로킹.
- **해결**: `CameraWorkerPool` 별도 구현 (2개 Worker). 카메라는 I/O bound이므로 LiDAR(4개)보다 적은 Worker로 충분.
- **아키텍처**: `cameraWorker.ts`가 camera_image Parquet을 열고, row group 단위로 JPEG ArrayBuffer를 추출. 메인 스레드에서 `cameraImageCache`에 별도 저장 (LiDAR frameCache와 독립).
- **JPEG 무결성**: `hyparquet`의 `utf8: false` 옵션으로 바이너리 원본 보존. `new Image()` preloading으로 디코딩 완료 후에만 src swap — 깨진 이미지 아이콘 방지.

### D22. Camera Frustum Visualization + POV Switching

- **카메라 프러스텀**: `camera_calibration`의 intrinsic (f_u, f_v, c_u, c_v, width, height) + extrinsic (4×4 matrix)으로 각 카메라의 시야각(FOV)을 3D 공간에 사다리꼴 와이어프레임으로 렌더링.
  - FOV 계산: `fovX = 2 * atan(width / (2 * f_u))`, `fovY = 2 * atan(height / (2 * f_v))`
  - Near plane에 4개 코너 포인트 생성 → extrinsic 역행렬로 vehicle frame 변환
  - `THREE.LineSegments`로 렌더링 (origin → 4 corners + 4 edges)
- **POV 전환**: 카메라 패널 클릭 시 `activeCam` 상태 설정 → OrbitControls 비활성화 → `PovController`가 `useFrame`에서 position lerp + quaternion slerp로 부드럽게 전환. ESC 또는 버튼으로 orbital 모드 복귀.
  - **진입 시**: orbital camera의 position/quaternion/fov/target을 `savedState`에 저장. POV 카메라의 extrinsic quaternion에 optical→Three.js 변환(X축 180° 회전) 적용 후 slerp.
  - **복귀 시**: 저장된 quaternion으로 직접 slerp. `lookAt()` 미사용 — bird's-eye view(카메라 방향이 Z축과 평행)에서 up vector `(0,0,1)`과 충돌하여 gimbal lock이 발생하므로, lookAt 기반 quaternion 계산을 제거하고 저장된 quaternion으로 직접 보간.
  - **카메라 간 전환**: 복귀 애니메이션 중 다른 카메라 클릭 시, 복귀 목적지를 새 savedState로 저장하여 끊김 없이 전환.
- **프러스텀 디스플레이**: 기본 상태에서는 far plane 사각형(base)만 표시, hover/active 시 origin→corner 엣지(pyramid) 추가 표시. `buildFrustumBase()` + `buildFrustumEdges()` 분리. FRUSTUM_FAR = 2m.
  - FRONT 카메라(넓은 vFov)와 SIDE 카메라(좁은 vFov)의 세로 크기 차이는 실제 FOV 차이를 반영한 정상 동작.
- **Hover highlight sync**: 카메라 패널 hover → `hoveredCam` 상태 → CameraFrustums에서 해당 프러스텀을 흰색 + 불투명도 1.0으로 강조. 나머지는 dim (0.6).

### D23. Multi-Segment Support

- **자동 탐색**: `waymo_data/vehicle_pose/` 폴더의 `.parquet` 파일 목록에서 세그먼트 ID 추출. `fetch()` + HTTP status로 존재 여부 확인.
- **UI**: 세그먼트가 2개 이상이면 헤더에 `<select>` 드롭다운 표시. 선택 시 `reset()` → 새 세그먼트의 6개 Parquet 파일 열기 → Worker 재초기화 → 프리페치.
- **에러 처리**: `openParquetFile()`을 try/catch로 감싸서 optional 컴포넌트(segmentation 등)가 없을 때 graceful skip. `console.warn`으로 로깅만.

### D24. Segmentation 제거 결정

- **배경**: lidar_segmentation + camera_segmentation 시각화를 구현 시도.
- **발견된 문제**:
  1. 9개 세그먼트 중 1개(`10023947602400723454`)만 segmentation 데이터 보유
  2. 해당 세그먼트도 199프레임 중 ~10프레임만 라벨 존재 (sparse annotation)
  3. camera_segmentation은 1Hz (10프레임당 1프레임)
  4. Worker postMessage로 Int32Array 전송 시 데이터 손실 의심 (라벨이 전부 -1)
- **결정**: 전체 코드 제거. `semanticColors.ts`, `extractSegmentationLabels()`, `ColorMode` 타입, worker setSegmentation, CameraPanel segmentation overlay 등 모든 관련 코드 삭제.
- **교훈**: Waymo v2.0의 segmentation annotation은 전체 데이터셋의 일부 subset에만 존재. 데이터 가용성을 먼저 확인한 후 기능을 구현해야 함.

### D25. Spacebar Play/Pause + Auto-Rewind

- **구현**: `App.tsx`에서 global `keydown` 이벤트 리스너. `Space` 키 → `togglePlayback()`.
- **input 보호**: `e.target.tagName`이 INPUT/TEXTAREA/SELECT면 무시 (텍스트 입력 중 오동작 방지).
- **Auto-rewind**: 마지막 프레임(currentFrameIndex >= totalFrames - 1)에서 play 시 자동으로 frame 0으로 이동 후 재생 시작.

### D26. Waymo-Inspired UI Theme — 다크 테마 + 컬러 체계

- **배경**: 기본 R3F 씬이 개발 도구 느낌이라 포트폴리오 품질에 미달. Waymo 브랜드와 조화되는 전문적 UI 필요.
- **결정**: 다크 테마 (#1a1a2e 배경) + Waymo teal (#00bfa5) 액센트 컬러. 전체 레이아웃을 Full-screen 3D viewport + 하단 카메라 스트립 + 타임라인으로 고정.
- **세부 변경**: LiDAR 뷰어 배경을 검정(#0a0a1a)으로, 카메라 패널 160px 고정 높이, 타임라인 컨트롤을 teal 계열로 통일, 세그먼트 셀렉터 + 상태 표시를 상단 바에 집약.

### D27. Drag & Drop + Folder Picker — File 객체를 Worker에 직접 전달

- **문제**: GitHub Pages 배포 시 `/api/segments` 엔드포인트 없음. 사용자가 `waymo_data/` 폴더를 드래그 & 드롭해야 함.
- **해결**: `folderScan.ts` 유틸 신규 추가. `FileSystemDirectoryHandle` (Chrome `showDirectoryPicker()`) 또는 `DataTransferItem.webkitGetAsEntry()` (드래그 & 드롭)로 폴더 트래버싱.
  - 폴더 구조 `{component}/{segment_id}.parquet` 파싱 → `Map<segmentId, Map<component, File>>` 반환
  - `vehicle_pose/` 서브폴더 존재 여부로 세그먼트 자동 탐지
  - 상위 `waymo_data/` 폴더가 없이 component 폴더를 직접 드롭해도 처리
- **Worker 전달 방식**: `File` 객체를 `postMessage`로 직접 전달 (structured clone). Worker 내에서 `File.slice()` → `ArrayBuffer`로 Parquet 읽기. `URL.createObjectURL()`이 불필요해짐.
  - 이전 계획에서는 blob URL 방식을 고려했으나, `File`이 structured clone 가능하고 `hyparquet`의 `AsyncBuffer`가 File을 직접 지원하므로 더 단순한 방식 채택.
- **Store 변경**: `loadFromFiles(segments)` 액션 추가. `internal.filesBySegment`에 File Map 저장. `selectSegment()`가 file 모드 vs URL 모드를 자동 분기.

### D28. 세그먼트 메타데이터 — stats 컴포넌트 활용

- **발견**: `stats` Parquet에 세그먼트별 `location`, `time_of_day`, `weather` 등 메타데이터 존재.
- **활용**: 드롭다운 옵션에 `#1 · 10023947… · SF Downtown · Day` 형식으로 truncated segment ID + 위치 + 시간대 표시.
- **LOCATION_LABELS 매핑**: `location_sf_downtown` → `SF Downtown`, `location_phx_mesa` → `Phoenix Mesa` 등 Waymo 공식 location 코드를 사람이 읽기 좋은 라벨로 변환.

### D29. Keyboard Shortcuts — 프레임 탐색 + ShortcutHints

- **구현**: `App.tsx`에서 global `keydown` 리스너.
  - `← →`: ±1 프레임
  - `J L`: ±10 프레임 (빠른 탐색)
  - `Space`: play/pause
  - `Shift+← →`: 이전/다음 세그먼트
  - `?`: ShortcutHints 토글
- **ShortcutHints 컴포넌트**: 첫 로드 시 5초간 표시 후 자동 페이드아웃 (CSS opacity transition 300ms). `?` 키로 재표시/숨김 토글. 아무 키 입력(? 제외) 시 페이드아웃 트리거.
- **Input 보호**: 모든 키보드 핸들러에서 `e.target.tagName`이 INPUT/TEXTAREA/SELECT면 무시.

### D30. 2개 Row Group 사전 로딩 — RG 경계 재생 끊김 방지

- **문제**: 첫 RG만 로딩 후 렌더 시작 → 자동재생이 두 번째 RG 경계에 도달하면 아직 로딩 중이라 재생이 잠시 멈춤.
- **기존 메커니즘**: `setInterval` 기반 재생에서 캐시 미스 시 retry (100ms 폴링). 멈추진 않지만 눈에 띄는 끊김 발생.
- **시도했으나 철회한 방식**: `rgLoadPromises` Map으로 진행 중인 RG 로딩을 추적하고 `loadFrame`에서 await하는 방식. 기존 poll-based retry가 이미 동작하고 있었고, 불필요한 복잡도 추가라 판단하여 `git checkout`으로 즉시 롤백.
- **채택한 방식**: `loadDataset()` 에서 첫 프레임 로딩 단계를 RG 0 + RG 1 병렬 로딩으로 확장. LiDAR와 Camera 각각 2개 RG를 `Promise.all`로 동시 로딩. ~100프레임 분량이 사전 캐싱되어 prefetch가 따라잡을 시간 확보.
  ```ts
  // LiDAR RG 0+1
  firstFramePromises.push(loadAndCacheRowGroup(0, set))
  if (internal.numRowGroups > 1) firstFramePromises.push(loadAndCacheRowGroup(1, set))
  // Camera RG 0+1
  firstFramePromises.push(loadAndCacheCameraRowGroup(0, set))
  if (internal.cameraNumRowGroups > 1) firstFramePromises.push(loadAndCacheCameraRowGroup(1, set))
  await Promise.all(firstFramePromises)
  ```
- **교훈**: 단순한 해결책(사전 로딩량 증가)이 복잡한 해결책(await 기반 로딩 파이프라인 변경)보다 나을 때가 있다.

### D31. Loading Skeleton — 4단계 진행 표시 + 카메라 스트립 스켈레톤

- **로딩 UX**: `loadStep` 상태로 4단계 진행 표시:
  1. `calibration` — "Loading calibrations…"
  2. `metadata` — "Loading frame metadata…"
  3. `first-frame` — "Decoding first frame…"
  4. `ready` — 렌더링 시작
- **3D 뷰포트**: 로딩 중 반투명 오버레이 + 단계별 메시지 + CSS pulse 애니메이션.
- **카메라 스트립 스켈레톤**: 5개 카메라 슬롯에 shimmer 애니메이션 (gradient slide). 실제 이미지가 로드되면 자연스럽게 교체.
- **중복 제거**: 센터 로딩 스켈레톤이 이미 진행 상태를 보여주므로, 헤더의 "Loading… 100%" 텍스트와 타임라인의 ⏳ 이모지를 제거.

### D32. Landing Page — 소개 + 다운로드 가이드

- **문제**: README를 통해 접근하지 않은 방문자가 처음 보는 화면이 "드래그 앤 드롭하세요" — 맥락 없이 무엇을 드롭하라는 건지 모름.
- **해결**: DropZone 상단에 소개 섹션 추가:
  - 제목: "Perception Studio"
  - 설명: "In-browser perception explorer for Waymo Open Dataset v2.0.1. No setup, no server — just drop Parquet files and explore."
- **DownloadGuide 컴포넌트**: 접이식(collapsible) 쉘 스크립트 가이드.
  - "How to get data ▸" 클릭 → gsutil 다운로드 스크립트 표시 (N=3 세그먼트 기본값)
  - 복사 버튼 (navigator.clipboard.writeText)
  - `overflow: auto` + 커스텀 투명 스크롤바로 긴 스크립트 스크롤 지원
- **Product naming**: "Browser-based 3D viewer" → "In-browser perception explorer". Foxglove, Rerun 등 경쟁 제품의 자기 명명 관행 참고. "Zero-install"은 모호하여 제거, "No setup, no server"로 대체.

### D33. Worker Concurrency 조정 — LiDAR 3 + Camera 2

- **변경**: LiDAR Worker Pool을 4개 → 3개로 축소. Camera Worker Pool은 2개 유지.
- **이유**: 총 5개 Worker가 동시 실행 시 CPU 코어 경합. LiDAR는 CPU-intensive (BROTLI 해제 + range image 변환), Camera는 I/O-bound (BROTLI 해제 + JPEG 추출). 3+2 = 5 Worker가 대부분의 머신에서 적정 수준.
- **Worker 초기화**: `initWorkerPools()`에서 LiDAR Pool과 Camera Pool을 `Promise.all`로 병렬 초기화 — 순차 초기화 대비 ~50% 시간 단축.

### D34. 3DGS 전략 업데이트 — DriveStudio/OmniRe 선호

- **배경**: Street Gaussians (ECCV 2024) vs DriveStudio/OmniRe (ICLR 2025 Spotlight) 비교 검토.
- **DriveStudio 장점**:
  - Waymo, nuScenes, PandaSet 등 주요 데이터셋 모두 지원하는 통합 프레임워크
  - OmniRe (ICLR 2025 Spotlight): 정적 배경 + 동적 객체 + non-rigid 요소(보행자) 통합 재구성
  - 활발한 개발 + 커뮤니티 (GitHub 업데이트 빈번)
  - 학술 논문에서 인용/비교에 유리
- **Street Gaussians 한계**: 동적 전경 처리가 rigid-body 가정 (보행자 같은 non-rigid 객체에 약함)
- **전략 변경**: 3DGS Lab에서 사용할 .ply 생성을 DriveStudio/OmniRe 파이프라인으로 전환 검토.
- **Perception 분석 관점에서 3DGS의 의미**:
  - 3D bounding box prediction은 보통 1프레임의 LiDAR/Camera 데이터로 생성
  - 3DGS는 세그먼트 전체(~200프레임)의 데이터를 학습하여 dense reconstruction 생성
  - 결과적으로 3DGS reconstruction이 single-frame perception보다 ground truth에 가까움
  - LiDAR는 정확하지만 sparse, Camera는 dense하지만 2D → 3DGS가 dense + 3D context 제공
  - Perception engineer가 prediction과 3DGS reconstruction을 교차 비교하면 false positive/negative 원인 분석 가능

### D35. LiDAR Colormap 모드 — 4가지 시각화 속성

- **배경**: 포인트 클라우드가 intensity 단일 색상만 지원 → perception 분석에 부족. 자율주행 업계에서 range/height/elongation 컬러맵이 표준적으로 사용됨.
- **구현**: `POINT_STRIDE`를 4→6으로 확장하여 `[x, y, z, intensity, range, elongation]` interleaved. 각 속성별 전용 컬러 팔레트:
  - **Intensity** (0–1): dark → cyan → yellow → white (turbo 계열)
  - **Height/Z** (-3–8m): blue → green → yellow → red (지면/객체 분리에 유용)
  - **Range** (0–75m): green → yellow → red → dark (거리 기반 밀도 분석)
  - **Elongation** (0–1): dark → purple → magenta → pink (반사 특성)
- **R3F 버퍼 업데이트 타이밍 이슈**: `useEffect` + `needsUpdate = true` 방식이 R3F reconciler의 `<bufferAttribute {...posAttr} />` 재적용으로 무효화됨. **해결**: dirty ref + `useFrame` 패턴으로 전환 — 버퍼 업데이트를 Three.js 렌더 루프 내에서 수행하여 reconciler 간섭 회피.
- **센서별 색상 제거**: 모든 5개 센서가 동일한 4채널 range image 포맷이므로, 센서 필터링 시에도 항상 선택된 컬러맵 적용 (기존 센서별 고유색 제거).

### D36. 통합 Frosted Glass 컨트롤 패널

- **문제**: 개별 UI 요소(버튼, 레이블)에 배경이 없어 밝은 장면에서 가독성 저하. 레이블에만 frost 배경을 넣으면 디자인 불일치.
- **해결**: 전체 컨트롤 패널을 단일 frosted container로 감싸기:
  - `backgroundColor: rgba(26, 31, 53, 0.75)` + `backdropFilter: blur(12px)`
  - 내부 요소는 개별 배경 없이, 활성 요소만 `rgba(255,255,255,0.06)` subtle highlight
  - 섹션 구분: 1px `colors.border` divider
- **레이블 변경**: "Sensors" → "LiDAR" (더 직관적)
- **조건부 UI**: 모든 센서 off 시 opacity 슬라이더 숨김 (`visibleSensors.size > 0` 조건)

### D37. POV 복귀 Gimbal Lock 수정 — Quaternion 직접 Slerp

- **문제**: bird's-eye view(Z축 직하방)에서 POV 진입 후 복귀 시 카메라가 비정상적으로 회전.
- **원인**: 복귀 애니메이션에서 매 프레임 `Matrix4.lookAt(pos, target, up=(0,0,1))`로 target quaternion 계산. 카메라 방향이 Z축과 거의 평행할 때 lookAt의 up vector와 forward vector가 충돌 → 불안정한 rotation matrix → gimbal lock.
- **해결**: POV 진입 시 orbital camera의 `quaternion`을 `savedState`에 함께 저장. 복귀 시 `lookAt()` 없이 저장된 quaternion으로 직접 `camera.quaternion.slerp(rt.quat, LERP_SPEED)`. Quaternion slerp는 특이점이 없으므로 모든 카메라 각도에서 안정적 보간.
- **교훈**: 3D 카메라 시스템에서 `lookAt()`은 편리하지만, up vector가 view direction과 평행한 경우(top-down, bottom-up) degenerate. 가능하면 quaternion을 직접 저장/보간하는 것이 안정적.

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
24. ⬜ DriveStudio/OmniRe 3DGS training + .ply export
23. ⬜ gsplat.js integration for 3DGS BEV tab
24. ⬜ GitHub Pages deployment + demo GIF + LinkedIn post
25. ⬜ IEEE VIS 2026 Short Paper (deadline: April 30)
