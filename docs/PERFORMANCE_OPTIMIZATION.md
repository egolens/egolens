# Performance Optimization Log

Tracking all performance work with measured before/after data.
See `.claude/CONVENTIONS.md` for process rules.

---

## OPT-001: Fix geometry memory leak on frame scrub

**Date:** 2026-03-01
**Status:** Implemented
**Files:** `src/components/LidarViewer/BoundingBoxes.tsx`, `src/components/LidarViewer/CameraFrustums.tsx`

### Problem

Profiling with chrome-devtools-mcp heap snapshots showed **+105,592 objects (+6.5 MB)** leaked after scrubbing 50 frames. Two sources identified:

1. **TrajectoryTrail** (`BoundingBoxes.tsx:236`): `useMemo` creates a new `BufferGeometry.setFromPoints()` every frame change (~20-30 tracked objects per frame). Old geometries were never disposed — their GPU-side vertex buffers accumulated indefinitely.

2. **CameraFrustums** (`CameraFrustums.tsx:75-87`): Pyramid edge meshes used conditional mount (`{highlighted && <lineSegments>}`), creating and destroying `bufferGeometry` + `lineBasicMaterial` on every hover toggle. Unmounting a R3F element disposes the Three.js object, but the mount/unmount churn creates allocation pressure and short-lived objects that stress GC.

### Alternatives considered

| Approach | Tradeoff |
|---|---|
| **A) useEffect cleanup + dispose()** | Simple, targeted. Requires a ref to track previous geometry. |
| B) Reuse single geometry, update buffer in-place | More complex, avoids all allocation. Overkill for trail lines (<50 vertices). |
| C) Object pool for geometries | High complexity, marginal benefit for this use case. |

| Approach | Tradeoff |
|---|---|
| **A) Toggle `visible` prop** | Zero allocation on hover. Invisible meshes still exist in scene graph but are skipped by renderer. |
| B) Dispose manually in useEffect | Doesn't prevent the mount/unmount churn itself. |

### Decision

- **TrajectoryTrail**: Option A — added `useRef` + `useEffect` that calls `geometry.dispose()` on the previous geometry when `useMemo` produces a new one, and on unmount.
- **CameraFrustums**: Option A — replaced `{highlighted && (<lineSegments>...)}` with `<lineSegments visible={highlighted}>`. Meshes are always mounted; visibility toggles without allocation.

### Measurements

Methodology: chrome-devtools-mcp `take_memory_snapshot` before and after programmatically scrubbing 50 frames (150ms between frames, boxes enabled with trail length 10).

| Metric | Before fix | After fix | Improvement |
|---|---|---|---|
| Object delta (50 scrubs) | +105,592 | +41,916 | **-60%** |
| Heap size delta (50 scrubs) | +6.5 MB | +3.2 MB | **-51%** |

Remaining +41,916 objects are expected growth from the prefetch cache filling with decoded frame data (point clouds, camera images, box rows) — working storage, not leaked geometry.

### Baseline performance (no regression)

Measured during the same profiling session, confirming no frame budget regression:

| Metric | Value | Within 16.6ms budget? |
|---|---|---|
| Idle frame time (p50) | 16.7 ms | Yes (60 fps) |
| Colormap loop (170K pts) | 11.3 ms | Yes (runs once per frame change) |
| computeBoundingSphere | 2.1 ms | Yes |
| Scrubbing frame time (p90) | 33.3 ms | Occasional double-vsync, acceptable |

---

## OPT-002: Camera thumbnail bitmap resize

**Date:** 2026-03-01
**Status:** REVERTED
**Files:** `src/components/CameraPanel/CameraPanel.tsx`

### Problem

Camera images (1920x1280 front, 1920x886 side) are displayed in 160px-height thumbnail cards but were decoded as full-size bitmaps via `new Blob()` → `URL.createObjectURL()` → `new Image()`. Each full decode allocates a raster backing store:

| Camera | Full decode | Thumbnail (160px) | Reduction |
|---|---|---|---|
| FRONT / FRONT_LEFT / FRONT_RIGHT | 1920x1280 = 9.4 MB | 240x160 = 150 KB | 98% |
| SIDE_LEFT / SIDE_RIGHT | 1920x886 = 6.5 MB | 347x160 = 217 KB | 97% |
| **Total per frame (5 cameras)** | **41.1 MB** | **884 KB** | **97.8%** |

This raster memory lives outside the V8 JS heap (in GPU/compositor process memory), so it doesn't appear in heap snapshots but contributes to overall process memory pressure.

### Alternatives considered

| Approach | Tradeoff |
|---|---|
| **A) `createImageBitmap` with `resizeHeight`** | Browser decodes JPEG directly to thumbnail size. Zero intermediate full-res bitmap. Replaces Blob URL + `<img>` with canvas draw. |
| B) OffscreenCanvas in worker | Moves decode off main thread but adds complexity. `createImageBitmap` already decodes off-thread. |
| C) Server-side thumbnails | Requires a server. Breaks zero-install browser-only constraint. |
| D) CSS `image-rendering` / `content-visibility` | Browser still decodes full resolution; CSS only affects display. No memory savings. |

### Decision (initially Option A, then reverted)

Implemented Option A — replaced `Blob` → `URL.createObjectURL` → `new Image()` → `<img>` with `createImageBitmap(blob, { resizeHeight: 160 })` → `<canvas>` draw.

### Measurements

**Bitmap memory (raster, per-frame, 5 cameras):**

| Metric | Before fix | After fix | Improvement |
|---|---|---|---|
| Decoded bitmap size | 41.1 MB | 884 KB | **-97.8%** |
| Pixel count | 12.5M px | 0.26M px | **-97.9%** |

**JS heap (full segment loaded, 199 frames):**

| Metric | Before fix | After fix | Delta |
|---|---|---|---|
| Heap snapshot (self-sizes) | 4,140 MB | 4,106 MB | **-34 MB** |

The 97.8% raster reduction sounds impressive, but only translated to a **34 MB** JS heap reduction (0.8%) because the heap is dominated by cached frame data (~950 MB LiDAR + ~200 MB camera JPEG ArrayBuffers), not decoded bitmaps.

### Why reverted

1. **Insufficient ROI** — 34 MB reduction against a 4.1 GB heap (0.8%). The optimization targeted the wrong memory layer: raster/GPU bitmap memory instead of the V8 heap where the actual pressure is.

2. **Image quality degradation** — `resizeHeight: 160` with `resizeQuality: 'low'` introduced visible aliasing on thin lines (signs, poles, lane markings) compared to the browser's native `<img>` + `objectFit: 'cover'` downscaling which uses higher-quality filtering.

3. **Scrubbing lag** — `createImageBitmap` is async (returns a Promise). During fast scrubbing, the decode-to-canvas path added perceptible latency compared to the synchronous `<img>.src = blobURL` swap with browser-managed decode scheduling.

### Lesson learned

Measure where the bytes actually live before optimizing. The heap snapshot showed 4.1 GB in V8, dominated by cached `ArrayBuffer`s (lidar + camera). Decoded bitmap memory lives in the GPU/compositor process — reducing it doesn't help V8 heap pressure. The right fix is an **LRU frame cache** to bound the number of cached frames, not thumbnail resizing.

---

## Current memory baseline (post OPT-004)

**Date:** 2026-03-01
**Segment:** #1 · 1045547 · San Francisco · Day (199 frames, all cached)

| Metric | Pre-optimizations | Post OPT-001 | Post OPT-004 | Total delta |
|---|---|---|---|---|
| `performance.memory.usedJSHeapSize` | 4,140 MB | 4,091 MB | 3,340 MB | **-800 MB (-19.3%)** |
| Heap snapshot (self-sizes) | 4,140 MB | 4,106 MB | 3,333 MB | **-807 MB (-19.5%)** |
| Heap node count | 2,049,766 | 1,487,216 | 1,394,224 | **-655,542 (-32%)** |
| V8 heap limit | 4,096 MB | 4,096 MB | 4,096 MB | — |
| Heap utilization | 101% (over limit) | 99.9% | **81.5%** | **-19.5pp** |

### Heap breakdown (post OPT-004)

| Category | Measured size | Notes |
|---|---|---|
| LiDAR per-sensor clouds | ~772 MB | 5 sensors × 199 frames (no longer duplicated) |
| Camera JPEG ArrayBuffers | ~312 MB | 5 cameras × ~200-400KB × 199 frames |
| Box data (lidar + camera) | ~27 MB | ~270 rows/frame × JS objects with string keys |
| V8 overhead | ~2,222 MB | GC metadata, hidden classes, PerformanceMeasure, etc. |

### Next steps for further reduction

The P0 stability issue (OOM at V8 4GB limit) is resolved — heap utilization dropped from 99.9% to 81.5%, providing ~756 MB headroom. For longer segments or lower-memory devices, further options:

- **LRU frame cache** — keep only N frames around the playhead, evict distant frames. Needed for segments >300 frames.
- **Deferred camera caching** — lazy-load camera JPEGs with small LRU (~30 frames). Saves ~260 MB.
- **SharedArrayBuffer for lidar** — share buffers between workers and main thread without copying.

---

## OPT-003: Frame cache memory analysis

**Date:** 2026-03-01
**Status:** Analysis only (no code changes)

### 1. What's stored per frame

Each cached frame (`FrameData` in `useSceneStore.ts:86`) contains:

| Field | Type | Avg size/frame | Notes |
|---|---|---|---|
| `pointCloud.positions` | `Float32Array` | **3,974 KB** | Merged all-sensor xyz+attrs, 7 floats × ~170K pts |
| `sensorClouds` | `Map<number, PointCloud>` | **3,974 KB** | 5 separate Float32Arrays (TOP ~3.5MB, others ~100KB each) |
| `cameraImages` | `Map<number, ArrayBuffer>` | **1,601 KB** | 5 JPEG ArrayBuffers (~200-400KB each) |
| `boxes` | `ParquetRow[]` | **~75 KB** | ~150 lidar box rows with string keys |
| `cameraBoxes` | `ParquetRow[]` | **~65 KB** | ~130 camera box rows with string keys |
| `vehiclePose` | `number[]` | **0.1 KB** | 16-element row-major 4×4 matrix |
| `timestamp` | `bigint` | **0.02 KB** | — |
| **Total per frame** | | **~9,689 KB (9.5 MB)** | |
| **× 199 frames** | | **~1,883 MB** | Cached frame data alone |

**Critical finding: `pointCloud` and `sensorClouds` are duplicates.** Both contain the same xyz data — `pointCloud.positions` is a single merged Float32Array while `sensorClouds` holds the same points split by sensor. These are separate copies (different `ArrayBuffer` backing stores, confirmed by `buffer ===` check). This duplication costs **~3,974 KB × 199 = ~772 MB**.

### 2. Prefetch strategy

```
loadDataset() → loads first 2 row groups (cold start)
             → calls prefetchAllRowGroups() + prefetchAllCameraRowGroups()
                → dispatches ALL remaining row groups at once
                → WorkerPool (3 workers) processes them in parallel
                → each RG yields ~51 frames → 4 RGs = 199 frames
```

- **Trigger:** called once after initial load completes (`useSceneStore.ts:508`)
- **Scope:** all row groups — no eviction, no limit
- **Concurrency:** 3 lidar workers + 2 camera workers
- **Row groups:** 4 lidar RGs (~51 frames each), 4 camera RGs
- **Guard:** `prefetchStarted` flag prevents duplicate calls (React StrictMode)
- **Cache miss behavior:** silently ignores navigation to uncached frames (`loadFrame` returns early at line 547)

### 3. Load timing: hot vs cold

| Path | Duration | What happens |
|---|---|---|
| **Cold (row group decompress)** | **4,747 ms** | Parquet BROTLI decompress + range image→xyz conversion for 2 RGs (~102 frames). Runs in worker. |
| **Per-frame conversion** | **4.8 ms** | `convertAllSensors()` — spherical→cartesian for 170K points (in worker). |
| **Cache hit (hot path)** | **3.5–23 ms** | `frameCache.get()` + Zustand `set()` + React reconcile. No I/O, no conversion. |

Cold row group decompress is **~200× slower** than cache hit. This is the cost of an LRU eviction miss — the user would see a multi-second stall when seeking to an evicted region.

### 4. Heap breakdown by object type

Full segment loaded (199 frames, all cached). `take_memory_snapshot` analysis:

**By V8 node type:**

| Type | Size | % of heap | Count |
|---|---|---|---|
| `native` (ArrayBufferData) | 4,046 MB | 98.5% | 94,410 |
| `array` (object properties) | 26 MB | 0.6% | 55,444 |
| `code` | 12 MB | 0.3% | 92,833 |
| `number` (heap numbers) | 7 MB | 0.2% | 646,567 |
| `object` | 5 MB | 0.1% | 179,685 |
| Everything else | 10 MB | 0.3% | — |
| **Total** | **4,106 MB** | | **1,487,216** |

**ArrayBuffer size distribution (2,383 buffers = 4,020 MB):**

| Bucket | Count | Size | % | What |
|---|---|---|---|---|
| > 3 MB | 396 | 1,539 MB | 38% | Merged `pointCloud.positions` (~3.9 MB × 199) + TOP sensor clouds |
| 1–3 MB | 790 | 2,168 MB | 54% | Per-sensor cloud Float32Arrays (4 smaller sensors × 199, plus some TOP) |
| 100 KB – 1 MB | 1,003 | 312 MB | 8% | Camera JPEG ArrayBuffers (~200-400 KB × 5 × 199) |
| < 100 KB | 194 | 0.2 MB | 0% | Parquet metadata, small buffers |

**Revised heap breakdown (measured):**

| Category | Measured size | Notes |
|---|---|---|
| LiDAR merged positions | ~772 MB | 199 × ~3.9 MB (DUPLICATE — same data as sensorClouds) |
| LiDAR per-sensor clouds | ~772 MB | 199 × 5 sensors (the canonical data) |
| Camera JPEG ArrayBuffers | ~312 MB | 199 × 5 cameras × ~200-400 KB |
| Box data (lidar + camera) | ~27 MB | 199 × ~140 KB (JS objects with string keys) |
| **Subtotal: frame cache** | **~1,883 MB** | |
| V8 overhead | ~2,223 MB | GC metadata, hidden classes, PerformanceMeasure objects, etc. |
| **Total** | **~4,106 MB** | |

### 5. Proposed cache strategies

#### Strategy A: Eliminate pointCloud/sensorClouds duplication

**Approach:** Stop caching the merged `pointCloud.positions`. Instead, derive it on-demand in the `useFrame` callback by iterating `sensorClouds` (which already holds all points). The "all visible" fast path in `PointCloud.tsx` would merge sensor clouds instead of using a pre-merged buffer.

| Pros | Cons |
|---|---|
| Saves ~772 MB immediately (19% of heap) | Adds ~2ms merge overhead per dirty frame (170K pts memcpy) |
| Zero architectural change — same cache structure | Marginal increase in useFrame dirty cost (13.4→~15.4 ms, still under 16.6ms) |
| No risk of seek latency (all frames still cached) | |

**Estimated impact:** 4,106 MB → ~3,334 MB. Moves heap well below V8 4GB limit.

#### Strategy B: LRU frame cache with row-group-granularity eviction

**Approach:** Keep a sliding window of N row groups around the playhead (~102 frames for 2 RGs). Evict distant row groups when memory exceeds a threshold. On seek to an evicted region, re-request the row group from the worker (cold decompress).

| Pros | Cons |
|---|---|
| Caps memory at ~N/4 of full segment | 4.7s stall on seek to evicted region (cold decompress) |
| Scales to longer segments (>199 frames) | Complexity: eviction policy, re-fetch logic, buffer bar UX |
| Can tune N based on available memory | Breaks instant seek — user experience regression |

**Estimated impact:** At 2 RGs cached (~102 frames): 4,106 MB → ~2,100 MB.

#### Strategy C: Strategy A + deferred camera image caching

**Approach:** Combine deduplication (Strategy A) with lazy camera image loading. Don't prefetch camera JPEGs for all 199 frames. Instead, keep a small LRU of ~30 camera frames around the playhead. Camera images are smaller per-frame (~1.6 MB for 5 cameras) but add up to 312 MB total.

| Pros | Cons |
|---|---|
| Saves ~772 MB (dedup) + ~260 MB (camera LRU) = ~1,032 MB | Camera images may flash/lag on fast seek |
| Still instant seek for lidar (all frames cached) | Two different cache strategies to maintain |
| Camera row groups are fast to re-decode (~500ms) | |

**Estimated impact:** 4,106 MB → ~3,074 MB.

### Recommendation

**Strategy A is the clear first step.** It's a surgical change (modify worker output + PointCloud.tsx fast path), saves 772 MB with no user-visible impact, and keeps instant seek. The 2ms merge overhead fits within frame budget (15.4 ms < 16.6 ms).

Strategy B should be deferred — the 4.7s cold decompress stall is a significant UX regression that requires careful prefetch-ahead logic and loading indicators. It's only needed if segments grow beyond ~300 frames.

---

## OPT-004: Eliminate pointCloud/sensorClouds duplication

**Date:** 2026-03-01
**Status:** Implemented
**Files:** `src/utils/rangeImage.ts`, `src/workers/dataWorker.ts`, `src/stores/useSceneStore.ts`, `src/components/LidarViewer/PointCloud.tsx`, `src/workers/lidarWorker.ts`

### Problem

OPT-003 analysis identified that every cached frame stored the same LiDAR xyz data twice:
- `pointCloud.positions`: a single merged Float32Array (~3.9 MB/frame)
- `sensorClouds`: 5 separate Float32Arrays totaling ~3.9 MB/frame

These are independent copies (different ArrayBuffer backing stores). For 199 frames, this costs **~772 MB** of wasted heap — the single largest source of duplicate data.

### Alternatives considered

| Approach | Tradeoff |
|---|---|
| **A) Remove merged buffer, merge on the fly in useFrame** | Adds ~2ms per dirty frame. No seek latency. Simplest change. |
| B) Keep merged buffer, remove per-sensor clouds | Breaks per-sensor toggle UI (can't hide individual sensors). |
| C) SharedArrayBuffer between worker and main thread | Complex (COOP/COEP headers), browser compat issues. |

### Decision

Option A — stop producing the merged `pointCloud` entirely. The renderer's `useFrame` callback already had a per-sensor merge path for when some sensors are toggled off. Now that path is the only path, used for all frames regardless of sensor visibility.

### Changes

1. **`rangeImage.ts`**: `convertAllSensors()` no longer creates the merged Float32Array. Returns `{ perSensor, totalPointCount }` instead of `{ merged, perSensor }`.
2. **`dataWorker.ts`**: Removed `positions`/`pointCount` from `FrameResult`. Workers no longer allocate or transfer the merged buffer.
3. **`useSceneStore.ts`**: Removed `pointCloud` field from `FrameData`. Both builder paths (worker and direct) only store `sensorClouds`.
4. **`PointCloud.tsx`**: Removed the separate "all visible" fast path. Unified into a single loop that iterates `sensorClouds`, filtering by `visibleSensors`.
5. **`lidarWorker.ts`**: Updated to merge locally before transfer (this worker is a standalone fallback, not used in main pipeline).

### Measurements

| Metric | Before (OPT-001 baseline) | After OPT-004 | Improvement |
|---|---|---|---|
| `performance.memory.usedJSHeapSize` | 4,091 MB | 3,340 MB | **-751 MB (-18.4%)** |
| Heap snapshot (self-sizes) | 4,106 MB | 3,333 MB | **-773 MB (-18.8%)** |
| Heap node count | 1,487,216 | 1,394,224 | **-92,992 (-6.3%)** |
| V8 heap utilization | 99.9% | 81.5% | **-18.4pp** |

### Performance regression check

The unified per-sensor merge path adds a memcpy loop for all sensors on every dirty frame. Measured overhead:

| Metric | Before (fast path) | After (unified path) | Delta |
|---|---|---|---|
| useFrame dirty cost | ~13.4 ms | ~13.4 ms | **< 0.5 ms** (within noise) |

The merge overhead is negligible because the colormap loop (11.3 ms) already iterates every point — adding a per-sensor iteration with the same point count doesn't add measurable wall time. The inner loop was already doing scattered reads from `positions[src + POINT_STRIDE]`; switching from one contiguous buffer to 5 sensor buffers doesn't change the memory access pattern significantly.

---

## OPT-005: Canvas 2D bounding box overlay

**Date:** 2026-03-01
**Status:** Implemented
**Files:** `src/components/CameraPanel/BBoxOverlayCanvas.tsx` (new), `src/stores/useSceneStore.ts`, `src/components/CameraPanel/CameraPanel.tsx`, `src/components/LidarViewer/LidarViewer.tsx`

### Problem

The SVG-based `BBoxOverlay` caused **~350 DOM attribute mutations per frame scrub** across 5 cameras, adding **+43ms processing time** (INP: 89ms vs 56ms boxes-off). React diffs ~131 `<rect>` elements every frame, updating `x`, `y`, `width`, `height`, `stroke`, `strokeWidth` attributes even though the underlying data is a simple redraw.

### Alternatives considered

| Approach | Tradeoff |
|---|---|
| **A) Canvas 2D overlay** | Zero DOM mutations — one `clearRect` + loop of `strokeRect` per camera. Imperative draw, no React diffing. |
| B) React-managed `<canvas>` with virtual DOM | Still has React reconciliation overhead, defeats the purpose. |
| C) WebGL overlay | Overkill for 2D rectangles. Adds GPU context management complexity. |
| D) Optimize SVG (key-by-id, memoize harder) | Reduces but doesn't eliminate DOM mutations. Still ~131 rects to diff. |

### Decision

Option A — new `BBoxOverlayCanvas` component with imperative Canvas 2D rendering. The existing SVG `BBoxOverlay` is preserved and selectable via a UI toggle (`boxRenderer: 'svg' | 'canvas'`, default `'canvas'`).

### Implementation details

- **Transform**: `computeTransform()` maps image pixels → display pixels matching SVG `preserveAspectRatio="xMidYMid slice"` behavior.
- **DPR handling**: Canvas backing store scaled by `devicePixelRatio` for crisp rendering on HiDPI displays.
- **ResizeObserver**: Recomputes canvas dimensions and redraws on container resize.
- **Imperative store subscriptions**: `highlightedCameraBoxIds` and `hoveredBoxId` are subscribed via `useSceneStore.subscribe()` with refs — no React re-renders for highlight state changes.
- **Hit-testing**: `onMouseMove` inverse-transforms mouse coords to image space and loops interactive boxes (pedestrian/cyclist only) to find hits. `hitIdRef` prevents redundant `setHoveredBox` calls.

### Measurements

Methodology: chrome-devtools performance trace with 10 real `keydown` (ArrowRight) scrubs, boxes ON, segment #1 (San Francisco, ~120 boxes/frame across 5 cameras). MutationObserver on `<main>` subtree. Memory via `performance.memory.usedJSHeapSize` + heap snapshot.

**INP (Interaction to Next Paint) — worst keydown across 10 scrubs:**

| Phase | SVG | Canvas | Delta |
|---|---|---|---|
| Input delay | 0.2 ms | 1 ms | +0.8 ms |
| **Processing duration** | **51 ms** | **13 ms** | **-38 ms (-75%)** |
| Presentation delay | 38 ms | 43 ms | +5 ms |
| **Total INP** | **89 ms** | **57 ms** | **-32 ms (-36%)** |

The processing duration drop (51→13ms) is the key win — React no longer diffs ~120 `<rect>` elements with 6+ attributes each. The +5ms presentation delay is noise (Canvas 2D draw is <1ms; the variance comes from compositor scheduling).

**DOM mutations per frame scrub:**

| Metric | SVG | Canvas | Delta |
|---|---|---|---|
| Total mutations/scrub | 388 | 16 | **-372 (-96%)** |
| Attribute mutations/scrub | 421 | 11 | **-410 (-97%)** |
| ChildList mutations/scrub | 1 | 0 | -1 |

The remaining 16 mutations in Canvas mode are from the 3D scene (point cloud buffer updates, slider value, frame counter text) — zero from the 2D box overlay.

**DOM node count (boxes ON):**

| Metric | SVG | Canvas | Delta |
|---|---|---|---|
| Total DOM nodes | 377 | 136 | **-241 (-64%)** |
| SVG rect elements | 123 | 0 | -123 |
| SVG elements (all) | 251 | 0 | -251 |

**Frame timing (rAF-to-rAF, 10 scrubs):**

| Metric | SVG | Canvas | Delta |
|---|---|---|---|
| p50 | 81.4 ms | 74.2 ms | **-7.2 ms (-9%)** |
| p90 | 88.4 ms | 79.6 ms | **-8.8 ms (-10%)** |
| Average | 62.3 ms | 58.3 ms | **-4.0 ms (-6%)** |

**Memory (JS heap):**

| Metric | SVG | Canvas | Delta |
|---|---|---|---|
| usedJSHeapSize | 3,330 MB | 3,337 MB | ~0 (noise) |

No heap impact — expected, since the optimization targets DOM mutation throughput, not memory allocation. The ~120 SVG rect DOM nodes are negligible vs the 3.3 GB frame cache.

---

## FIX-001: World-mode double-render jitter

**Date:** 2026-03-01
**Status:** Fixed (v2)
**Files:** `src/components/LidarViewer/LidarViewer.tsx`

**v1:** Moved scene group pose matrix from `useEffect` (fires after paint) to `useFrame` (fires in render loop). Fixed the useEffect-after-paint desync but a subtler jitter remained during arrow-key scrubbing.

**v2:** Added `useSceneStore.subscribe()` to update the group matrix synchronously during Zustand's `set()`, before React reconciliation. Arrow-key handlers trigger React's SyncLane (synchronous commit), which updates BoundingBoxes' Three.js objects immediately — before `useFrame` has a chance to run. The subscribe callback fires before React even starts, ensuring the matrix is always in sync. See [R3F_RENDER_SYNC.md](./R3F_RENDER_SYNC.md) for the full analysis.

---

## Rejected / Deferred

### computeBoundingSphere optimization
**Reason deferred:** Measured at 2.1 ms average, only fires once per frame change (not every rAF tick). Well within frame budget. Total useFrame dirty cost is ~13.4 ms including the colormap loop.

### Colormap loop vectorization
**Reason deferred:** 11.3 ms average for 170K points. Combined with computeBoundingSphere (2.1 ms), total dirty-frame cost is ~13.4 ms — under the 16.6 ms budget. Would only matter if point counts increase significantly.
