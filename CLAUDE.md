# Perception Studio for Waymo Open Dataset

Browser-based 3D visualization tool for Waymo Open Dataset v2.0.

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
│   │   ├── PointCloud.tsx     # Point cloud renderer (turbo colormap, per-sensor coloring)
│   │   ├── BoundingBoxes.tsx  # 3D boxes (wireframe or GLB models) with tracking colors
│   │   └── CameraFrustums.tsx # Camera FOV frustums with hover highlight
│   ├── CameraPanel/    # 5 camera image strip with POV switching + hover highlight
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
npm test        # Vitest (27 tests)
```

## Key Features (Implemented)
- Multi-segment support with dropdown selector (auto-discovers segments from waymo_data/)
- LiDAR point cloud: 5 sensors, ~168K points/frame, 4 colormap modes (intensity/height/range/elongation)
- 3D bounding boxes: wireframe or GLB models (car/pedestrian/cyclist), class-colored
- 2D camera bounding boxes: SVG overlay on camera panels, synced with boxMode toggle
- Cross-modal hover highlight: hover 2D box → highlight linked 3D box (and vice versa) via association data
- Trajectory trails: past N frames of object positions as fading polylines
- 5 camera image panels: preloaded JPEG, POV switching (click card), hover border highlight
- Camera frustum visualization: base-only default, full wireframe on hover, per-camera FOV sizing
- POV camera: quaternion slerp for gimbal-lock-free orbital↔POV transitions
- Timeline: scrubber, play/pause (spacebar), speed control (0.5x–4x), YouTube-style buffer bar
- Unified frosted glass control panel with conditional UI (opacity hidden when all sensors off)
- Parallel worker pools: 4 lidar workers + 2 camera workers for fast row group decompression

## Data Components Used
9 essential: `vehicle_pose`, `lidar_calibration`, `camera_calibration`, `lidar_box`, `camera_box`, `camera_to_lidar_box_association`, `lidar`, `camera_image`, `stats`

## Download Script (`download.sh`)
Supports two modes: **index-based** (pick specific segments by 0-based index) or **count-based** (first N segments). Set `INDICES="23 114 172 ..."` for specific segments, or comment it out and set `N=15` for sequential download.

## Current Phase
Phase 2 — Camera views + 3D perception features complete. Next: 3DGS BEV integration.
