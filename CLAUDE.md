# EgoLens

Browser-based 3D perception explorer for autonomous driving datasets (Waymo, nuScenes, Argoverse 2).

## Quick Context
- **Detailed technical plan**: `docs/TECHNICAL_PLAN.md` (read for architecture decisions, data schemas, reasoning)
- Zero-install: browser-only, no server, no Python
- Parquet native: `hyparquet` + `hyparquet-compressors` (BROTLI) for browser parsing with row-group random access
- LiDAR data is **range images** (not xyz) — must convert spherical→cartesian in Web Worker
- 3DGS .ply is bundled (Waymo license allows trained weight distribution)

## Tech Stack
React 19 + Vite 7 + TypeScript 5.9 + @react-three/fiber + drei + gsplat.js + hyparquet

## Structure
```
src/
├── components/
│   ├── LidarViewer/    # 3D point cloud + bounding boxes + camera frustums + trajectory trails
│   │   ├── LidarViewer.tsx    # Canvas, OrbitControls, sensor/box toggles, trail slider
│   │   ├── PointCloud.tsx     # Point cloud renderer (turbo colormap, per-sensor coloring, GPU camera mode)
│   │   ├── CameraColorMaterial.ts  # Custom ShaderMaterial for GPU camera colormap
│   │   ├── BoundingBoxes.tsx  # 3D boxes (wireframe or GLB models) with tracking colors
│   │   └── CameraFrustums.tsx # Camera FOV frustums with hover highlight
│   │   └── KeypointSkeleton.tsx  # 3D human keypoint skeleton (14 joints, per-joint colors)
│   ├── CameraPanel/    # 5 camera image strip with POV switching + hover highlight + overlays
│   │   ├── CameraPanel.tsx        # Camera strip layout + CameraView sub-component
│   │   ├── BBoxOverlayCanvas.tsx  # 2D bounding box Canvas overlay
│   │   ├── KeypointOverlay.tsx    # 2D camera keypoint skeleton overlay (Canvas 2D)
│   │   └── CameraSegOverlay.tsx   # Camera panoptic segmentation overlay (UPNG uint16 decode)
│   └── Timeline/       # Frame scrubber + play/pause + speed control + buffer bar
├── workers/
│   ├── dataWorker.ts        # Parquet I/O + range image→xyz (runs in Web Worker)
│   ├── workerPool.ts        # N-worker pool for parallel row group decompression
│   ├── cameraWorker.ts      # Camera JPEG extraction (separate worker)
│   └── cameraWorkerPool.ts  # Camera worker pool (2 workers)
├── stores/
│   └── useSceneStore.ts     # Zustand central state + all data loading logic
├── utils/
│   ├── parquet.ts       # hyparquet wrapper (AsyncBuffer, row-group reads)
│   ├── rangeImage.ts    # Spherical→cartesian conversion math
│   ├── rangeImageGpu.ts # WebGPU compute shader (unused in current build)
│   └── merge.ts         # Component merge (JS port of Waymo v2.merge())
├── types/
│   └── waymo.ts         # v2.0 type definitions (CameraName, LaserName, BoxType)
└── App.tsx              # Layout + segment selector + spacebar play/pause
```

## Commands
```bash
npm run dev     # Start dev server
npm run build   # Type-check + build
npm run lint    # ESLint
npm test        # Vitest (415+ tests)
```

## Key Features (Implemented)
- Multi-segment support with dropdown selector (auto-discovers segments from waymo_data/)
- LiDAR point cloud: 5 sensors, ~168K points/frame, 6 colormap modes (intensity/height/range/elongation/segment/panoptic)
- **Camera colormap (GPU)**: custom ShaderMaterial projects LiDAR→camera in vertex shader, samples texture in fragment — zero CPU overhead per frame
- LiDAR segmentation: 23-class semantic coloring (TOP sensor, ~5-frame interval)
- 3D bounding boxes: wireframe or GLB models (car/pedestrian/cyclist), class-colored
- 2D camera bounding boxes: Canvas overlay on camera panels, synced with boxMode toggle
- Cross-modal hover highlight: hover 2D box → highlight linked 3D box (and vice versa) via association data
- Trajectory trails: past N frames of object positions as fading polylines
- 3D human keypoints: 14-joint skeleton per pedestrian, per-joint/bone colors, InstancedMesh
- 2D camera keypoints: Canvas 2D overlay with occluded joint indicators (alpha + dashed bones)
- Camera panoptic segmentation: UPNG uint16 PNG decode → 29-class colored overlay (alpha 0.35)
- 5 camera image panels: preloaded JPEG, POV switching (click card), hover border highlight
- Camera frustum visualization: base-only default, full wireframe on hover, per-camera FOV sizing
- POV camera: quaternion slerp for gimbal-lock-free orbital↔POV transitions
- Timeline: scrubber, play/pause (spacebar), speed control (0.5x–4x), YouTube-style buffer bar
- Timeline annotation markers: per-feature colored dots (seg=cyan, KP3D=lime, KP2D=light-cyan, CamSeg=magenta)
- Unified frosted glass control panel with conditional UI (data-driven: toggles hidden when data absent)
- Independent toggles: Keypoints 3D, Keypoints 2D, Cam Seg (preserved across segment switches)
- Parallel worker pools: 4 lidar workers + 2 camera workers for fast row group decompression

## Performance Optimizations
- **GPU camera colormap** (`CameraColorMaterial.ts`): vertex shader projects 168K points to all cameras (up to 7), picks shallowest depth per point, passes UV+camera index to fragment shader for texture sampling. Eliminates ~80ms/frame CPU projection+decode overhead. OffscreenCanvas texture pipeline ensures cross-platform Y-orientation. Anti-flicker: previous frame textures carry over during async decode.
- **Fused CPU fallback** (`cameraRgbSampler.ts`): single-pass projection+RGB sampling per camera with pre-allocated `bestDepth` Float32Array. Eliminates ~840K `ProjectedPoint` object allocations per frame (168K points × 5 cameras).
- **Ego-frame projection**: camera calibration (intrinsics + extrinsics) operates in ego/vehicle frame. Shader uses raw `position` for projection, not `modelMatrix * position` (which includes WorldPoseSync ego→world transform).
- **Material swap**: `PointsMaterial` (CPU colormaps) and `CameraColorMaterial` (GPU camera mode) swapped imperatively in `useFrame` — no React re-renders.
- **Point opacity**: read from Zustand store inside `useFrame` (not React subscription) to prevent R3F material re-attachment.

## Data Components Used
13 total: `vehicle_pose`, `lidar_calibration`, `camera_calibration`, `lidar_box`, `camera_box`, `camera_to_lidar_box_association`, `lidar`, `camera_image`, `stats`, `lidar_segmentation`, `lidar_hkp`, `camera_hkp`, `camera_segmentation`

## Download Script (`download.sh`)
Supports two modes: **index-based** (pick specific segments by 0-based index) or **count-based** (first N segments). Set `INDICES="23 114 172 ..."` for specific segments, or comment it out and set `N=15` for sequential download.

## Current Phase
Phase 3 complete — Full perception pipeline with GPU-optimized camera colormap. Next: 3DGS BEV integration.
