# URL-Based Data Loading — Implementation Plan

**Status**: Draft (rev 5 — Phase 0 implemented: feather overloads, DataLoadError, WorkerPool limiter, pipeline extraction)
**Date**: 2026-03-14
**Prereq for**: Embed System (EMBED_SYSTEM_DESIGN.md)

## 1. Motivation

Before building the embed iframe system, the standalone app needs a third data entry point: URL-based loading. Currently the app has two ways to ingest data:

1. **Dev auto-discovery** — Vite plugin serves local `waymo_data/`, app fetches `/api/segments`
2. **Drag & drop** — User drops folder, browser `File` objects flow through pipeline

Both are **local-only**. URL-based loading enables:
- Landing page URL input (paste a data URL, click Load)
- Deep linking (`?dataset=argoverse2&data=https://...`)
- Future embed system (same `loadFromUrl()` code path)

## 2. Current Architecture Analysis

### 2.1 Data Flow Summary

```
                ┌───────────────┐
User drops      │  loadFromFiles │   Detects dataset type via sentinel keys
folder ────────►│  (store action) │──► (__nuscenes__, __argoverse2__, or plain Waymo)
                └───────┬───────┘
                        │
           ┌────────────┼────────────┐
           ▼            ▼            ▼
        Waymo       nuScenes       AV2
           │            │            │
    File→Parquet   File→JSON    File→Feather
    openParquet()  readJsonFile()  readFeatherFile()
           │            │            │
           ▼            ▼            ▼
    loadWaymoMeta  buildNuScenesDB  buildAV2LogDB
           │            │            │
           └────────────┼────────────┘
                        ▼
                 MetadataBundle
                        │
                        ▼
              selectSegment() → loadDataset()
                        │
                        ▼
              Worker Pool init (File objects transferred)
                        │
                        ▼
              Per-frame loading (row groups / individual files)
```

### 2.2 File Access Points — Where `File` Objects Are Used

#### Waymo
| Phase | Function | Input | How File is used |
|-------|----------|-------|------------------|
| Init | `openParquetFile()` | `File \| string \| AsyncBuffer` | **Already supports URL strings** via `asyncBufferFromUrl()` |
| Metadata | `loadWaymoMetadata()` | `Map<string, WaymoParquetFile>` | Reads through `AsyncBuffer` — **source-agnostic** |
| Workers | `WorkerPool.init()` | `{ fileEntries: [component, File][] }` | Transfers `File` objects to workers. Workers call `openParquetFile(file)` |

**Waymo is almost ready** — `openParquetFile` already accepts URL strings. The only gap is worker initialization: workers receive `File` objects and need to also accept URLs.

#### nuScenes
| Phase | Function | Input | How File is used |
|-------|----------|-------|------------------|
| DB build | `readJsonFile()` | `Map<string, File>` → `file.text()` | Reads JSON via `File.text()` |
| Metadata | `buildNuScenesDatabase()` | `Map<string, File>` (JSON files) | Passes to `readJsonFile()` |
| LiDAR worker | `initNuScenesLidarWorker()` | `fileEntries: [filename, File][]` | Transfers Files to workers |
| Camera worker | `initNuScenesCameraWorker()` | `fileEntries: [filename, File][]` | Transfers Files to workers |
| Per-frame | Worker reads | `File` | Workers do `file.arrayBuffer()` for .bin, `readFeatherFile(file)` for radar |

**nuScenes needs moderate work** — JSON reading needs URL fetch alternative, and workers need URL-based file access.

#### Argoverse 2
| Phase | Function | Input | How File is used |
|-------|----------|-------|------------------|
| DB build | `readFeatherFile(file)` | `File` → `file.arrayBuffer()` | Small files (<1MB) |
| DB build | `readFeatherColumns(file)` | `File` → `file.arrayBuffer()` | Medium files (poses ~100KB, annotations ~500KB) |
| Discovery | File path matching | `logFiles.keys()` regex scan | Discovers LiDAR timestamps and camera files from `Map<string, File>` keys |
| LiDAR worker | `initAV2LidarWorker()` | `fileEntries: [filename, File][]` | Transfers Files to workers |
| Camera worker | `initAV2CameraWorker()` | `fileEntries: [filename, File][]` | Transfers Files to workers |

**AV2 needs the most rethinking** — currently scans `Map<string, File>` keys to discover frame timestamps and camera files. With URL loading, there's no directory listing — we need a different discovery mechanism.

### 2.3 Worker Architecture

All three datasets use the same `WorkerPool` pattern:

```typescript
// Main thread:
pool.init({
  frameBatches: [...],  // What to load per batch
  fileEntries: [        // File objects transferred to worker
    ['sensors/lidar/123.feather', file],
    ['sensors/cameras/ring_front_center/456.jpg', file],
  ],
})

// Worker thread:
// Receives fileEntries, stores in internal Map
// On requestRowGroup(batchIndex):
//   reads from internal File map → processes → returns result
```

Workers currently can only access data via transferred `File` objects. For URL loading, workers need to `fetch()` instead.

## 3. Design: Simplified Dual-Source Strategy

### 3.1 Core Principle

**No new abstractions. Use what already exists.** The codebase already has the building blocks:
- `openParquetFile(component, source: File | string | AsyncBuffer)` — Parquet already handles URLs
- `readFeatherBuffer(buffer: ArrayBuffer)` — Feather already accepts ArrayBuffer
- Workers already receive `File | string` unions (Waymo LiDAR worker)

Instead of introducing a `DataSource` class hierarchy, we use **two simple patterns** at two different layers:

| Layer | Pattern | Why |
|-------|---------|-----|
| **Main thread utilities** | `File \| ArrayBuffer` | Utilities call `.arrayBuffer()` or receive pre-fetched buffer. No class needed — one `instanceof` check. |
| **Worker messages** | `File \| string` | Workers receive `File` (local) or URL `string` (remote) via `postMessage`. Workers resolve with a 3-line helper. |

These two patterns never intersect — main thread fetches + passes `ArrayBuffer` to utilities, while workers receive `File | string` and self-resolve. No shared abstraction needed.

### 3.2 Main Thread: `File | ArrayBuffer` Overloads

```typescript
// feather.ts — add ArrayBuffer overload (2-line change)
export async function readFeatherFile(source: File | ArrayBuffer): Promise<Record<string, unknown>[]> {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  return readFeatherBuffer(buffer)
}

export async function readFeatherColumns(source: File | ArrayBuffer): Promise<{ columns: Record<string, unknown[]>; numRows: number }> {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  // ... rest unchanged (already operates on ArrayBuffer internally)
}

// nuscenes metadata.ts — readJsonFile
export async function readJsonFile(source: File | string): Promise<unknown> {
  // string = pre-fetched text from URL, File = local
  const text = typeof source === 'string' ? source : await source.text()
  return JSON.parse(text)
}
```

**URL mode call site** (main thread fetches, passes buffer):
```typescript
// In loadAV2FromUrl():
const poseBuf = await fetchBuffer(`${base}city_SE3_egovehicle.feather`)
const poseRows = readFeatherBuffer(poseBuf)  // existing function, no change
```

This means `loadFromUrl` does the `fetch()` → `ArrayBuffer` conversion at the top level, then calls **identical** parsing functions as local mode. Zero abstraction overhead.

### 3.3 Workers: `File | string` with Self-Resolve

```typescript
// src/workers/fetchHelper.ts (new, 15 lines)
const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 1000

export async function resolveFileEntry(entry: File | string): Promise<ArrayBuffer> {
  if (typeof entry !== 'string') return entry.arrayBuffer()

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(entry)
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${entry}`)
      return res.arrayBuffer()
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err
      await new Promise(r => setTimeout(r, BACKOFF_BASE_MS * (2 ** attempt)))
    }
  }
  throw new Error('unreachable')
}
```

Workers call `resolveFileEntry(entry)` instead of `entry.arrayBuffer()`. The retry logic (3 retries, exponential backoff 1s/2s/4s) is embedded here — **workers handle their own retries**, no coordination with main thread needed.

### 3.4 Why Not `DataSource` Class

The `DataSource` interface (`arrayBuffer()` + `text()` + `name`) is isomorphic to `File` itself — it adds a class hierarchy that:
1. **Can't cross `postMessage` boundary** (not Structured-Cloneable), so workers can't use it anyway
2. **Duplicates what `File` already does** — `File` already has `.arrayBuffer()` and `.text()`
3. **Forces wrapping** — every `File` must be wrapped in `FileDataSource` at call sites

The `File | ArrayBuffer` + `File | string` approach requires zero wrapping, zero new types, and zero changes to existing call sites that pass `File` objects.

## 4. AV2 Frame Discovery (URL Mode)

### 4.1 Problem

Local mode discovers frames by scanning `Map<string, File>` keys:
```typescript
for (const path of logFiles.keys()) {
  const match = path.match(/^sensors\/lidar\/(\d+)\.feather$/)
  if (match) lidarTimestamps.push(BigInt(match[1]))
}
```

With URL loading, there's no directory listing. We need another way to know what frames exist.

### 4.2 Solution: `manifest.json` (Always Required for URL Mode)

Each dataset type has a fixed-schema `manifest.json` that is **always available** at the base URL. This is a per-dataset-type contract — if someone hosts data for URL loading, they must provide this file. Since the schema is fixed and well-documented, this is a one-time generation step.

**AV2 manifest schema**:
```json
{
  "version": 1,
  "dataset": "argoverse2",
  "log_id": "01bb304d-7bd8-35f8-bbef-7086b688e35e",
  "frames": [
    {
      "timestamp_ns": 315966265659927216,
      "cameras": {
        "ring_front_center": 315966265649927222,
        "ring_front_left": 315966265649927333
      }
    }
  ]
}
```

This ~50KB file provides:
1. **Frame discovery**: LiDAR timestamps → construct URLs `{base}/sensors/lidar/{ts}.feather`
2. **Camera timestamp resolution**: exact per-camera timestamps → construct URLs `{base}/sensors/cameras/{cam}/{ts}.jpg`
3. **Zero ambiguity**: no pose-file heuristics, no nearest-match guessing

**Why manifest.json is always available**: it's a fixed schema per dataset type, generated once from the local data directory. We provide generation scripts:

```python
# scripts/generate_av2_manifest.py  — scans AV2 log dir → manifest.json
# scripts/generate_waymo_manifest.py — scans Waymo segment dir → manifest.json
# scripts/generate_nuscenes_manifest.py — scans nuScenes dir → manifest.json
```

**No fallback path needed**: if `manifest.json` is missing, the URL is invalid for URL-mode loading. Show a clear error: "manifest.json not found at {base}. Generate it with: `python generate_av2_manifest.py /path/to/log`"

## 5. Landing Page UI

### 5.1 Updated DropZone Layout

```
┌─────────────────────────────────────────┐
│          Perception Studio              │
│   Browser-native 3D perception...       │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │     📁 Drop dataset folder     │    │
│  │                                 │    │
│  │       [ Select Folder ]         │    │
│  └─────────────────────────────────┘    │
│                                         │
│              ── or ──                   │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  🔗 Load from URL              │    │
│  │                                 │    │
│  │  Dataset:  [ Argoverse 2  ▾ ]  │    │
│  │                                 │    │
│  │  ┌─────────────────────────┐   │    │
│  │  │ https://argoverse.s3... │   │    │
│  │  └─────────────────────────┘   │    │
│  │                                 │    │
│  │           [ Load ]              │    │
│  │                                 │    │
│  │  hint: paste the base URL of   │    │
│  │  a hosted dataset directory    │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ▶ Need data? Download script...        │
└─────────────────────────────────────────┘
```

### 5.2 Dataset Selector Options

| Value | Label | Placeholder URL |
|-------|-------|-----------------|
| `argoverse2` | Argoverse 2 | `https://argoverse.s3.us-east-1.amazonaws.com/av2/sensor/val/{log_id}/` |
| `waymo` | Waymo Open Dataset | `https://your-bucket.s3.amazonaws.com/waymo_data/` |
| `nuscenes` | nuScenes | `https://your-bucket.s3.amazonaws.com/nuscenes/` |

### 5.3 Validation

On "Load" click:
1. Validate URL format (must start with `https://`)
2. Fetch `manifest.json` from the base URL (simple GET — no HEAD, no Range):
   - This acts as both CORS probe AND manifest loading in one request
   - AV2 public S3 has no CORS headers, but simple GET body is readable (see Addendum A.1)
   - For self-hosted data (Waymo/nuScenes), server must have CORS configured
3. On fetch failure (`TypeError`): show error "Cannot access data at this URL. Check CORS settings and URL format."
4. On 404: show error "manifest.json not found at this URL. Generate with: `python scripts/generate_av2_manifest.py`"
5. On success: parse manifest, transition to loading state, call `loadFromUrl(dataset, baseUrl, manifest)`

### 5.4 Quick-Load Buttons (Optional)

For AV2 (public S3), we can offer pre-filled example URLs:

```
💡 Try with public Argoverse 2 data:
  [ Load example scene ] ← pre-fills a known val log URL
```

This gives users instant gratification without needing their own data.

## 6. Store Changes

### 6.1 New Action

```typescript
interface SceneActions {
  // ... existing ...
  loadFromUrl: (dataset: DatasetId, baseUrl: string) => Promise<void>
}

type DatasetId = 'waymo' | 'nuscenes' | 'argoverse2'
```

### 6.2 loadFromUrl Implementation Sketch

```typescript
loadFromUrl: async (datasetId: DatasetId, baseUrl: string) => {
  // Normalize: ensure trailing slash
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'

  // Set manifest
  const manifest = { waymo: waymoManifest, nuscenes: nuScenesManifest, argoverse2: argoverse2Manifest }[datasetId]
  setManifest(manifest)
  internal.datasetId = datasetId

  set({ status: 'loading', loadStep: 'opening', loadProgress: 0 })

  if (datasetId === 'argoverse2') {
    await loadAV2FromUrl(base, set, get)
  } else if (datasetId === 'waymo') {
    await loadWaymoFromUrl(base, set, get)
  } else if (datasetId === 'nuscenes') {
    await loadNuScenesFromUrl(base, set, get)
  }
}
```

### 6.3 AV2 URL Loading Flow (first implementation)

```typescript
async function loadAV2FromUrl(base: string, set, get) {
  // 1. Fetch manifest.json (required for URL mode — provides frame list + camera timestamps)
  const manifestRes = await fetch(`${base}manifest.json`)
  if (!manifestRes.ok) {
    throw new DataLoadError(
      'manifest.json not found. Generate with: python generate_av2_manifest.py /path/to/log',
      'MANIFEST', `${base}manifest.json`
    )
  }
  const manifest: AV2Manifest = await manifestRes.json()

  // 2. Fetch metadata files in parallel
  const [extrinsicsBuf, intrinsicsBuf, posesBuf, annotationsBuf] = await Promise.all([
    fetchBuffer(`${base}calibration/egovehicle_SE3_sensor.feather`),
    fetchBuffer(`${base}calibration/intrinsics.feather`),
    fetchBuffer(`${base}city_SE3_egovehicle.feather`),
    fetchBuffer(`${base}annotations.feather`).catch(() => null), // optional
  ])
  set({ loadProgress: 0.2 })

  // 3. Parse metadata using existing functions (accept ArrayBuffer)
  //    readFeatherBuffer() already exists and accepts ArrayBuffer!
  const extrinsicsRows = readFeatherBuffer(extrinsicsBuf)
  const intrinsicsRows = readFeatherBuffer(intrinsicsBuf)
  // ... parse poses and annotations similarly ...

  // 4. Build database from parsed ArrayBuffers
  //    readFeatherBuffer() already accepts ArrayBuffer — same parsing pipeline as local

  // 5. Discover frames from pose timestamps (or manifest.json)
  //    Construct URL map: filename → URL string

  // 6. Build URL-based file map for workers
  //    Workers receive URL strings instead of File objects
  const fileEntries: [string, string][] = lidarTimestamps.map(ts =>
    [`sensors/lidar/${ts}.feather`, `${base}sensors/lidar/${ts}.feather`]
  )

  // 7. Init workers with URL entries
  // 8. Load first frame, transition to ready
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return res.arrayBuffer()
}
```

## 7. Refactoring Plan

### 7.1 Phase 1: Utility Layer (no UI changes)

**Goal**: Make all file-reading utilities accept both `File` and `ArrayBuffer`.

| File | Change | Risk |
|------|--------|------|
| `src/utils/feather.ts` | `readFeatherFile` / `readFeatherColumns` — add `ArrayBuffer` overload | Low — `readFeatherBuffer` already exists, this is a 1-line `instanceof` check |
| `src/adapters/nuscenes/metadata.ts` | `readJsonFile` — accept `string` (pre-fetched text) in addition to `File` | Low — isolated function |
| `src/utils/parquet.ts` | Already supports URL via `asyncBufferFromUrl` | None — no change needed |

**Concrete changes**:
```typescript
// feather.ts — 1-line instanceof check per function
export async function readFeatherFile(source: File | ArrayBuffer) {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  return readFeatherBuffer(buffer)
}

export async function readFeatherColumns(source: File | ArrayBuffer) {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  // ... rest unchanged ...
}

// nuscenes/metadata.ts
async function readJsonFile(source: File | string): Promise<unknown> {
  const text = typeof source === 'string' ? source : await source.text()
  return JSON.parse(text)
}
```

### 7.2 Phase 2: AV2 Remote Adapter

**Goal**: Load an AV2 log from a base URL.

| File | Change |
|------|--------|
| `src/adapters/argoverse2/remote.ts` (new) | `loadAV2FromUrl(baseUrl)` — fetch metadata, discover frames, build database |
| `src/adapters/argoverse2/metadata.ts` | No change needed — `loadAV2FromUrl` fetches buffers and calls existing `readFeatherBuffer()` directly |
| `src/stores/useSceneStore.ts` | Add `loadFromUrl` action, wire AV2 path |

**Key decision: Refactor vs. New Function**

Option A — Refactor `buildAV2LogDatabase` to accept pre-fetched `ArrayBuffer` map:
- Cleaner, single code path
- Core parsing functions (`readFeatherBuffer`) already accept `ArrayBuffer`
- Local path: `File.arrayBuffer()` → pass buffer. URL path: `fetch()` → pass buffer. Same downstream.

Option B — New `buildAV2LogDatabaseFromUrl(baseUrl: string)`:
- Separate code path, doesn't touch working code
- Some duplication of parsing logic

**Decision: Option A** — but the refactor is at the **caller level**, not the function signature. `buildAV2LogDatabase` already calls `readFeatherBuffer(buffer)` internally. The only change is that `loadAV2FromUrl()` pre-fetches buffers and calls the same parsing pipeline. No wrapper classes, no signature changes to core parsing functions.

### 7.3 Phase 3: Worker URL Support

**Goal**: Workers can fetch from URLs (not just read `File` objects).

| File | Change |
|------|--------|
| `src/workers/av2LidarWorker.ts` | Accept `[filename, File \| string]` entries. If string, `fetch()` on demand. |
| `src/workers/av2CameraWorker.ts` | Same pattern |
| `src/workers/dataWorker.ts` (Waymo) | Already receives Parquet via AsyncBuffer — may need URL pass-through |
| `src/workers/nuScenesLidarWorker.ts` | Accept URL strings |
| `src/workers/nuScenesCameraWorker.ts` | Accept URL strings |

**Worker-side helper** (shared):
```typescript
// src/workers/fetchHelper.ts
export async function resolveFileEntry(entry: File | string): Promise<ArrayBuffer> {
  if (typeof entry === 'string') {
    const res = await fetch(entry)
    if (!res.ok) throw new Error(`Worker fetch failed: ${entry}`)
    return res.arrayBuffer()
  }
  return entry.arrayBuffer()
}
```

### 7.4 Phase 4: Store Integration + Landing Page UI

| File | Change |
|------|--------|
| `src/stores/useSceneStore.ts` | Add `loadFromUrl(dataset, baseUrl)` action |
| `src/App.tsx` | Add URL input section to DropZone |
| `src/App.tsx` | On mount: check `URLSearchParams` for `dataset` + `data`, auto-load if present |

### 7.5 Phase 5: Waymo + nuScenes Remote

Lower priority — Waymo/nuScenes data can't be publicly hosted, so URL loading for these datasets only benefits users who self-host.

| Dataset | Complexity | Notes |
|---------|-----------|-------|
| Waymo | Low | `openParquetFile` already accepts URL. Just need to construct component URLs from base URL + segment ID. Workers already use AsyncBuffer. |
| nuScenes | Medium | JSON files need URL fetch. Binary files (.bin, .jpg) need URL construction from sample_data paths. |

## 8. AV2 Frame Loading Strategy (URL mode)

### 8.1 The Problem with Transferring All Files to Workers

Local mode: all files are transferred to workers at init time (as File objects). Workers hold references and read on demand.

URL mode: we can't pre-transfer 150+ LiDAR feather files and 150×7 camera JPEGs. That would require fetching ~1000 files upfront.

### 8.2 Solution: Lazy Worker Fetching

Workers receive **URL strings** (not data). When a batch is requested, the worker fetches the needed files on demand:

```typescript
// Worker receives:
fileEntries: [
  ['sensors/lidar/315966265659927216.feather', 'https://s3.../sensors/lidar/315966265659927216.feather'],
  ['sensors/lidar/315966265759927216.feather', 'https://s3.../sensors/lidar/315966265759927216.feather'],
  ...
]

// On requestRowGroup(batchIndex):
// Worker looks up URLs for this batch's frames
// Fetches each file, processes, returns result
```

**Caching in worker**: After fetching, worker stores the ArrayBuffer in a local cache. If the frame is requested again (e.g., user scrubs back), no re-fetch needed.

### 8.3 Prefetch Strategy

Same as local mode — after first frame loads, prefetch remaining batches in background. The difference is latency: network fetch is slower than local File read, so the buffer bar will fill more slowly. This is expected and the YouTube-style buffer bar already communicates this to the user.

**Bandwidth estimation** (AV2):
- 1 LiDAR frame: ~2MB (feather)
- 7 camera images: ~7×150KB = ~1MB
- Total per frame: ~3MB
- 150 frames: ~450MB total
- At 50 Mbps: ~72 seconds to prefetch all

This is fine — the buffer bar shows progress, and frame-on-demand means the user can start viewing immediately.

## 9. Phased Implementation Plan

### Dependency Graph

```
Phase 0 (Prerequisites)
   │
   ├──► Phase 1 (Core Abstraction)
   │       │
   │       ├──► Phase 2 (AV2 Remote Loading)
   │       │       │
   │       │       └──► Phase 3 (Landing Page + URL Params)
   │       │               │
   │       │               ├──► Phase 4 (Service Worker Cache)
   │       │               │
   │       │               └──► Phase 5 (Embed Mode)
   │       │
   │       └──► Phase 6 (Waymo + nuScenes Remote) [stretch]
```

---

### Phase 0: Prerequisites (no URL code — foundation only)

**Goal**: Land low-risk foundational changes that make Phases 1–5 safer and simpler. Each task is an independent PR that doesn't break existing functionality.

| # | Task | Files | Depends on | Status |
|---|------|-------|------------|--------|
| 0a | Feather `ArrayBuffer` overloads | `src/utils/feather.ts` | — | **DONE** |
| 0b | Error type system (`DataLoadError`) — see Section 14 for full design | `src/utils/errors.ts` (new) | — | **DONE** |
| 0c | Worker fetch concurrency limiter | `src/workers/workerPool.ts` | — | **DONE** |
| 0d | Extract `runPostWorkerPipeline()` from loaders | `src/stores/useSceneStore.ts` | — | **DONE** |
| 0e | Unit tests for 0a–0d | `src/utils/__tests__/`, `src/workers/__tests__/` | 0a, 0b, 0c, 0d | **DONE** |

**Acceptance Criteria**:
- [x] `readFeatherColumns(arrayBuffer)` passes — existing `readFeatherColumns(file)` calls unchanged and still pass (7 tests)
- [x] `DataLoadError` classifies CORS / 404 / network / timeout correctly (12 unit tests)
- [x] `WorkerPool(n, factory, maxConcurrentFetches)` limits in-flight dispatches — test with mock workers (5 tests)
- [x] `runPostWorkerPipeline()` extracted — all existing drag-and-drop tests pass with zero logic changes
- [x] `npm test` green — 439 tests pass, 0 failures, no regressions

---

### Phase 1: Utility Overloads + Worker Fetch Helper

**Goal**: All file-reading utilities accept `File | ArrayBuffer`, all workers accept `File | string`. No new types or classes.

| # | Task | Files | Depends on |
|---|------|-------|------------|
| 1a | `readFeatherFile` / `readFeatherColumns` accept `File \| ArrayBuffer` | `src/utils/feather.ts` | Phase 0a |
| 1b | `readJsonFile` accepts `File \| string` (pre-fetched text) | `src/adapters/nuscenes/metadata.ts` | — |
| 1c | Worker `resolveFileEntry()` helper (with retry) | `src/workers/fetchHelper.ts` (new, ~15 lines) | Phase 0b |
| 1d | Update all worker init message types to `File \| string` | `src/workers/*.ts` | 1c |
| 1e | Unit tests: feather overloads, resolveFileEntry retry | tests | 1a–1d |

**Acceptance Criteria**:
- [ ] `readFeatherFile(arrayBuffer)` returns identical rows to `readFeatherFile(file)` (byte-for-byte)
- [ ] `readJsonFile(textString)` returns identical result to `readJsonFile(file)`
- [ ] Existing drag-and-drop path: all callers still pass `File` — zero code changes at call sites
- [ ] Workers accept both `File` and URL string entries — `resolveFileEntry` returns identical `ArrayBuffer` for both
- [ ] `resolveFileEntry` retries 3 times with exponential backoff on network failure (unit test with mock fetch)
- [ ] Zero runtime regressions: `npm test` green

---

### Phase 2: AV2 Remote Loading (first dataset)

**Goal**: `loadFromUrl('argoverse2', 'https://s3.../log_id/')` loads a full AV2 scene from a remote URL.

| # | Task | Files | Depends on |
|---|------|-------|------------|
| 2a | AV2 manifest.json schema + parser | `src/adapters/argoverse2/manifest.ts` (new) | — |
| 2b | AV2 URL loader: fetch metadata buffers + parse with existing functions | `src/adapters/argoverse2/remote.ts` (new) | Phase 1a |
| 2c | AV2 URL frame discovery from `manifest.json` | `src/adapters/argoverse2/remote.ts` | 2a, 2b |
| 2d | AV2 LiDAR + camera workers accept URL strings | `src/workers/av2LidarWorker.ts`, `av2CameraWorker.ts` | Phase 1d, 1e |
| 2e | Store: `loadFromUrl` action (AV2 path), calls `loadDatasetCore` | `src/stores/useSceneStore.ts` | Phase 0d, 2b, 2c, 2d |
| 2f | `manifest.json` generator script | `scripts/generate_av2_manifest.py` | 2a |
| 2g | Integration tests with MSW mock server | `src/__tests__/av2Remote.test.ts` | 2a–2e |

**Acceptance Criteria**:
- [ ] `loadFromUrl('argoverse2', mockServerUrl)` → metadata bundle matches local drag-and-drop equivalent
- [ ] First frame renders within 5s on mock server (feather + JPEG fetched, decoded, displayed)
- [ ] Timeline scrubbing works — forward/backward frame navigation fetches correct URLs
- [ ] Prefetch fills buffer bar progressively (respects `maxConcurrentFetches`)
- [ ] Missing `manifest.json` → clear error: "manifest.json not found. Generate with: python generate_av2_manifest.py"
- [ ] Python script generates valid `manifest.json` from local AV2 log directory
- [ ] Worker memory: no leaked ArrayBuffers after 50 frame navigations (worker cache works)

---

### Phase 3: Landing Page UI + URL Parameter Auto-Load

**Goal**: Users can paste a URL on the landing page or visit a deep link to load a scene directly.

| # | Task | Files | Depends on |
|---|------|-------|------------|
| 3a | DropZone: URL input section + dataset selector dropdown | `src/App.tsx` or `src/components/DropZone.tsx` | — |
| 3b | URL validation + CORS probe + user-facing error messages | `src/utils/urlValidation.ts` (new) | Phase 0b |
| 3c | Quick-load example button (AV2 public S3) | `src/App.tsx` | 3a |
| 3d | URL param parser: `?dataset=&data=` auto-load on mount | `src/App.tsx` (top-level) | Phase 2e |
| 3e | `singleSceneMode` state: hide segment dropdown in URL mode | `src/stores/useSceneStore.ts`, `src/App.tsx` | Phase 2e |
| 3f | E2E manual test on GitHub Pages deployment | — | 3a–3e |

**Acceptance Criteria**:
- [ ] Landing page shows URL input section below drop zone with "or" divider
- [ ] Dataset dropdown shows Argoverse 2 / Waymo / nuScenes with correct placeholder URLs
- [ ] "Load" button disabled until URL is valid HTTPS; shows spinner during CORS probe
- [ ] CORS failure → clear error message: "Cannot access data. Check CORS settings." (not generic fetch error)
- [ ] 404 failure → "Data not found at this URL. Check the path."
- [ ] Quick-load button pre-fills a working AV2 public URL and loads the scene in one click
- [ ] `?dataset=argoverse2&data=https://...` on fresh page load → bypasses DropZone, loads directly
- [ ] Segment dropdown hidden in URL mode; spacebar play/pause still works
- [ ] Browser back button from loaded scene → returns to landing page (history state managed)

---

### Phase 4: Service Worker Caching

**Goal**: Revisiting a previously-loaded URL scene uses cached data — zero re-download for immutable files.

| # | Task | Files | Depends on |
|---|------|-------|------------|
| 4a | Service Worker shell: registration in `main.ts`, Vite SW plugin | `src/sw.ts` (new), `src/main.ts`, `vite.config.ts` | — |
| 4b | Cache-first strategy for Feather / JPEG / calibration files | `src/sw.ts` | 4a |
| 4c | Network-first strategy for manifest.json | `src/sw.ts` | 4a |
| 4d | LRU eviction with 2GB cap + cache size tracking | `src/sw.ts` | 4b |
| 4e | UI: cache usage indicator + "Clear cache" button in settings | `src/components/ControlPanel/` | 4d |
| 4f | Verify: second load of same scene → zero network requests for data files | — | 4b–4d |

**Acceptance Criteria**:
- [ ] Service Worker registers successfully on first load; `navigator.serviceWorker.controller` is active on reload
- [ ] First visit: all Feather/JPEG fetches pass through SW and are cached (Network tab: SW intercept visible)
- [ ] Second visit (same URL): all Feather/JPEG served from cache — Network tab shows 0 bytes transferred for data files
- [ ] `manifest.json` re-fetched on second visit (network-first) — falls back to cache if offline
- [ ] Cache stays under 2GB: after loading 5+ large scenes, oldest entries evicted
- [ ] "Clear cache" button → `caches.delete()` → cache size indicator shows 0
- [ ] Parquet Range Requests NOT intercepted by SW (pass through to browser HTTP cache)
- [ ] Local drag-and-drop mode unaffected — SW only intercepts cross-origin data URLs
- [ ] Offline: previously-cached scene loads fully without network (Feather/JPEG served from cache)

---

### Phase 5: Embed Mode (Matterport-style)

**Goal**: Third-party sites can embed a Perception Studio scene via iframe with URL parameter customization, following the Matterport `<iframe src="...?m=xxx&param=value">` pattern.

| # | Task | Files | Depends on |
|---|------|-------|------------|
| 5a | Embed URL parameter parser (full parameter set) | `src/utils/embedParams.ts` (new) | Phase 3d |
| 5b | Embed chrome mode: hide header, DropZone, controls per params | `src/App.tsx`, `src/components/` | 5a |
| 5c | Embed-specific loading UX: full-bleed loader, no landing page | `src/components/EmbedLoader.tsx` (new) | 5a, Phase 2e |
| 5d | `postMessage` API for host↔iframe communication | `src/utils/embedApi.ts` (new) | 5a |
| 5e | Embed documentation page + copy-paste snippet generator | `docs/EMBEDDING.md` (new) | 5a–5d |
| 5f | Cross-origin iframe security: sandbox attrs, CSP headers | `vite.config.ts`, HTML template | 5a |
| 5g | E2E test: embed in a test HTML page, verify all params | — | 5a–5f |

**Acceptance Criteria**:
- [ ] `<iframe src="https://studio.example.com/?dataset=argoverse2&data=https://...&embed=true">` renders scene without any landing page or header chrome
- [ ] `&controls=false` hides all control panels — viewer is view-only (orbit still works)
- [ ] `&controls=minimal` shows only play/pause + frame counter
- [ ] `&frame=42` starts at frame 42 after loading
- [ ] `&camera=ring_front_center` starts in POV of that camera
- [ ] `&autoplay=true` begins playback automatically after first frame loads
- [ ] `&colormap=height` sets initial point cloud colormap
- [ ] `&bgcolor=000000` sets canvas background (for dark host pages)
- [ ] `&lang=ko` shows UI strings in Korean (i18n, stretch goal)
- [ ] Host page can send `postMessage({ type: 'setFrame', frame: 50 })` → viewer jumps to frame 50
- [ ] Viewer sends `postMessage({ type: 'ready' })` to host when first frame renders
- [ ] Viewer sends `postMessage({ type: 'frameChange', frame: N })` on each frame change
- [ ] iframe `sandbox` attribute includes `allow-scripts allow-same-origin` — no `allow-top-navigation`
- [ ] No console errors when embedded cross-origin
- [ ] Embed snippet in docs: copy-pasteable HTML with clear placeholder for data URL

---

### Phase 6: Waymo + nuScenes Remote (stretch)

**Goal**: URL loading works for all three datasets, not just AV2.

| # | Task | Files | Depends on |
|---|------|-------|------------|
| 6a | Waymo: construct component Parquet URLs from base URL | `src/adapters/waymo/remote.ts` (new) | Phase 1a |
| 6b | Waymo: worker init with URL strings (already near-ready) | `src/workers/waymoLidarWorker.ts`, `waymoCameraWorker.ts` | Phase 1e |
| 6c | nuScenes: JSON fetch from URL + binary URL construction | `src/adapters/nuscenes/remote.ts` (new) | Phase 1a, 1c |
| 6d | nuScenes: workers accept URL strings | `src/workers/nuScenes*.ts` | Phase 1e |
| 6e | Store: wire Waymo + nuScenes paths in `loadFromUrl` | `src/stores/useSceneStore.ts` | 6a–6d |
| 6f | Integration tests for both datasets | tests | 6a–6e |

**Acceptance Criteria**:
- [ ] `loadFromUrl('waymo', 'https://.../segment_id/')` → full Waymo scene renders (points, boxes, cameras)
- [ ] `loadFromUrl('nuscenes', 'https://.../v1.0-mini/')` → nuScenes scene renders
- [ ] Both datasets work with Service Worker caching (Phase 4)
- [ ] Landing page dataset selector correctly routes to each dataset's URL loading path

---

### Implementation Timeline Summary

| Phase | Duration | Blocking? | Can Parallelize With |
|-------|----------|-----------|---------------------|
| **Phase 0** (Prerequisites) | 2–3 days | Yes — all phases depend on it | — |
| **Phase 1** (Core Abstraction) | 2–3 days | Yes — Phases 2, 6 depend on it | — |
| **Phase 2** (AV2 Remote) | 3–4 days | Yes — Phases 3, 5 depend on it | — |
| **Phase 3** (Landing Page + URL Params) | 2–3 days | Yes — Phase 5 depends on 3d | Phase 4 |
| **Phase 4** (Service Worker Cache) | 2–3 days | No | Phase 3 |
| **Phase 5** (Embed Mode) | 3–4 days | No | Phase 6 |
| **Phase 6** (Waymo + nuScenes) | 3–4 days | No | Phase 5 |
| **Total** | ~3–4 weeks | | |

**Critical path**: Phase 0 → 1 → 2 → 3 → 5 (embed is the final deliverable)

## 10. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| AV2 S3 CORS not configured | ~~Blocks URL loading entirely~~ **RESOLVED** | Tested 2026-03-14: S3 has no CORS config, but simple GET works on public bucket. AV2 uses Feather (no Range needed) → **all fetches succeed**. See Addendum A.1 |
| Worker fetch performance | Slow first frame | Show loading progress per-file. Prefetch prioritizes visible frames. Worker retry (3x backoff) in `resolveFileEntry` |
| Memory pressure from fetch + cache | Large scenes (~450MB raw + ~750MB decoded) may exhaust memory | Worker LRU cache (3 batches max), SW 2GB cap. See Section 15 Memory Budget |
| Breaking existing drag-and-drop | Regression in working feature | Zero changes to existing call sites. Utilities accept `File \| ArrayBuffer` — `File` still works. Worker `File \| string` — `File` still works |
| Server missing Range/Cache headers | Degraded performance, no caching | Non-blocking warning toast. Document required server config (Section 11.5) |

## 11. Service Worker Caching (Required)

### 11.1 Why This Is Not Optional

Autonomous driving datasets are **immutable after release** — files never change once published. This makes them ideal caching targets with zero invalidation complexity. Without caching, every page visit re-downloads the full scene (~450MB for AV2). Real-world usage patterns make this unacceptable:

- Researchers iterate on the same scene dozens of times while writing papers
- Embedded viewers on a blog/paper page are revisited by readers
- Demo links shared in Slack/Twitter get clicked repeatedly

**Decision**: Service Worker caching is a **Week 1 deliverable**, not a stretch goal.

### 11.2 Caching Strategy

**Two-tier approach** based on file type:

| File type | Strategy | Rationale |
|-----------|----------|-----------|
| Feather (.feather) | **Cache-first** — serve from cache, never revalidate | Immutable sensor data. Filename includes timestamp (content-addressable). |
| JPEG (.jpg) | **Cache-first** — same as feather | Immutable camera images. Filename is timestamp. |
| Parquet (.parquet) | **Range-aware cache** (Phase 2) | `hyparquet` uses HTTP Range Requests internally. Caching partial responses requires custom logic. |
| manifest.json | **Network-first, cache fallback** | Small file, could theoretically be updated by data host. |
| calibration files | **Cache-first** | Immutable per log. Fetched once during metadata load. |

### 11.3 Implementation

```typescript
// sw.ts — Service Worker (register in main.ts)
const CACHE_NAME = 'perception-studio-data-v1'
const MAX_CACHE_SIZE = 2 * 1024 * 1024 * 1024  // 2GB cap

// Intercept fetch for data URLs only (not app assets — Vite handles those)
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url)

  // Only cache data files (feather, jpg, parquet) from external origins
  if (isDataUrl(url)) {
    event.respondWith(cacheFirst(event.request))
  }
})

function isDataUrl(url: URL): boolean {
  const ext = url.pathname.split('.').pop()
  return ['feather', 'jpg', 'jpeg', 'parquet', 'json'].includes(ext ?? '')
    && url.origin !== self.location.origin  // Don't cache app assets
}

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    // Clone before caching (response body is one-use)
    cache.put(request, response.clone())
    // Async: evict oldest if over budget
    evictIfOverBudget(cache)
  }
  return response
}
```

### 11.4 Eviction Policy

**LRU by access time**, capped at 2GB total:

1. On each `cache.put()`, record entry timestamp in a metadata cache key
2. When total exceeds 2GB, evict oldest-accessed entries until under 1.5GB (hysteresis)
3. User can clear cache via UI button in settings panel ("Clear cached data: X MB used")

### 11.5 Parquet Range Request Caching

`hyparquet.asyncBufferFromUrl()` issues HTTP Range Requests (`Range: bytes=X-Y`). The Cache API can store partial responses, but matching requires exact Range header match. Options:

**(a) Cache full Parquet file on first access** — after all row groups are read, reconstruct full file and cache it. Subsequent visits get instant full-file access.
**(b) Cache individual Range responses** — store each `206 Partial Content` response keyed by URL + Range. More granular but complex.
**(c) Defer to browser HTTP cache** — Parquet files with proper `Cache-Control: immutable` headers are cached by the browser automatically. No SW logic needed.

**Decision**: **Layered approach:**

1. **Default (Phase 2)**: Service Worker intercepts Parquet Range Requests and caches full `200 OK` responses only. If the server returns `206 Partial Content`, pass through to browser HTTP cache.

2. **Server requirements documented**: hosting servers MUST set `Cache-Control: public, max-age=31536000, immutable` and `Accept-Ranges: bytes` on Parquet files. This is default for S3/CloudFront. For self-hosted (nginx, etc.), we document the required config:

```nginx
# Required nginx config for Perception Studio URL loading
location ~* \.(parquet|feather)$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Accept-Ranges bytes;
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Headers Range;
}
```

3. **Fallback validation**: on first `loadFromUrl()`, if any Range Request returns without `Accept-Ranges: bytes` header, show a non-blocking warning: "Server may not support range requests. Performance may be degraded." This doesn't block loading — hyparquet falls back to full file fetch — but informs the user.

This keeps SW implementation simple (cache full responses, let Range pass through) while documenting server requirements so users can get optimal caching.

## 12. Single-Scene Design Principle

### 12.1 URL Mode = One Scene

`loadFromUrl()` always loads **exactly one scene/log**. The URL points to a single log directory, not a dataset root with multiple logs.

**Rationale**: URL-based loading serves three use cases — all single-scene:

1. **Landing page URL input**: user pastes a specific log URL
2. **Deep linking**: `?dataset=argoverse2&data=https://.../log_id/` — one log
3. **Embed system**: iframe shows one scene, host page controls navigation

Multi-scene browsing (listing available logs, switching between them) is the **host page's responsibility**, not the viewer's. The host page provides different `?data=` URLs for each scene. This is simpler and more robust than having the viewer attempt remote directory listing (which requires bucket-specific APIs like S3 `ListObjectsV2`).

### 12.2 UI Implications

| Mode | Segment dropdown | Controls | URL bar |
|------|-----------------|----------|---------|
| Local (drag & drop) | Shown (multi-segment) | Full | Hidden |
| URL standalone | **Hidden** (single scene) | Full | Shown in header |
| URL embed (`?embed=true`) | **Hidden** | Minimal or hidden (`?controls=false`) | Hidden |

When `loadFromUrl()` completes, the store sets `singleSceneMode: true`, which hides the segment selector and disables segment-switching keyboard shortcuts.

### 12.3 Embed URL Parameters (Matterport-style)

Inspired by Matterport's `<iframe src="https://my.matterport.com/show/?m=xxx&help=1&play=0">` pattern, all viewer behavior is controlled via URL parameters. The host page simply sets `src` on the iframe — no SDK required for basic usage.

**Embed snippet** (copy-paste for host page):
```html
<iframe
  width="960" height="540"
  src="https://perception-studio.example.com/?dataset=argoverse2&data=https://s3.../log_id/&embed=true"
  frameborder="0"
  allow="fullscreen; xr-spatial-tracking"
></iframe>
```

**Full parameter reference**:

| Parameter | Default | Values | Description |
|-----------|---------|--------|-------------|
| `dataset` | (required) | `argoverse2`, `waymo`, `nuscenes` | Dataset type. Determines parsing pipeline. |
| `data` | (required) | HTTPS URL | Base URL of a single log/segment directory. |
| `embed` | `false` | `true`, `false` | Enable embed mode: hides landing page, header chrome, segment dropdown. |
| `controls` | `true` | `true`, `false`, `minimal` | `true` = full control panel. `minimal` = play/pause + frame counter only. `false` = no controls (view-only orbit). |
| `frame` | `0` | integer | Start at specific frame index (0-based). |
| `camera` | (none) | camera name string | Start in POV of specific camera (e.g., `ring_front_center`). If omitted, starts in orbital/BEV view. |
| `autoplay` | `false` | `true`, `false` | Auto-play after first frame loads. Like Matterport's `play=0` (show play button) vs auto-start. |
| `colormap` | `intensity` | `intensity`, `height`, `range`, `elongation`, `segment`, `camera` | Initial point cloud colormap. |
| `bgcolor` | `111111` | hex color (no #) | Canvas background color. Useful for matching host page theme. |
| `speed` | `1` | `0.5`, `1`, `2`, `4` | Playback speed multiplier. |
| `loop` | `false` | `true`, `false` | Loop playback (like Matterport's `lp` param for guided tour looping). |
| `cameras` | `true` | `true`, `false` | Show/hide camera image panel strip. |
| `boxes` | `true` | `true`, `false` | Show/hide 3D bounding boxes on load. |
| `lang` | `en` | `en`, `ko`, ... | UI language (stretch goal). |

**Parameter precedence**: URL parameters override any user-saved preferences. If `embed=true`, the viewer never shows the landing page — it goes straight to loading (like Matterport's `quickstart` skipping the Dollhouse intro).

**Advanced: postMessage API** (for host pages that need programmatic control):
```javascript
// Host page → iframe
iframe.contentWindow.postMessage({ type: 'setFrame', frame: 50 }, '*')
iframe.contentWindow.postMessage({ type: 'setCamera', camera: 'ring_front_center' }, '*')
iframe.contentWindow.postMessage({ type: 'play' }, '*')
iframe.contentWindow.postMessage({ type: 'pause' }, '*')

// iframe → host page (events)
window.addEventListener('message', (e) => {
  if (e.data.type === 'ready') { /* first frame rendered */ }
  if (e.data.type === 'frameChange') { /* e.data.frame = current frame index */ }
  if (e.data.type === 'cameraChange') { /* e.data.camera = current camera name */ }
  if (e.data.type === 'error') { /* e.data.message = error description */ }
})
```

This follows the same pattern as Matterport's Showcase SDK, where basic embedding is parameter-only and programmatic control is an optional `postMessage` layer.

### 12.4 Impact on Open Questions

The former Open Question #2 ("Segment discovery for Waymo URL mode") is **resolved by elimination**: URL mode doesn't discover segments. The URL IS the segment. Waymo URL would be `?data=https://.../waymo_data/segment_id/` pointing to one segment's component parquet files.

## 13. Prerequisite Work

Before starting the main implementation phases, these foundational changes should land first. They are independently useful and reduce risk during the main work.

### 13.1 Feather ArrayBuffer Overloads

**File**: `src/utils/feather.ts`

Add `ArrayBuffer` acceptance to `readFeatherFile` and `readFeatherColumns`. This is a pure additive change — existing `File` callers continue to work, and new URL-based callers can pass pre-fetched `ArrayBuffer` directly.

```typescript
export async function readFeatherColumns(
  source: File | ArrayBuffer
): Promise<{ columns: Record<string, unknown[]>; numRows: number }> {
  const buffer = source instanceof File ? await source.arrayBuffer() : source
  // ... rest unchanged (already operates on ArrayBuffer internally)
}
```

**Risk**: None — `readFeatherBuffer(buffer)` already exists and works. This just removes the unnecessary `File` → `ArrayBuffer` indirection at the call site.

### 13.2 Worker Fetch Concurrency Limiter

**File**: `src/workers/workerPool.ts`

Add a `maxConcurrentFetches` option to throttle parallel network requests in URL mode. Without this, prefetch fires all row groups simultaneously (potentially 150+ concurrent fetches), which overwhelms servers and triggers rate limiting.

```typescript
interface WorkerPoolOptions<TInit, TResult> {
  // ... existing ...
  maxConcurrentFetches?: number  // default: unlimited (local), 6 (URL mode)
}
```

The pool already has a `waitQueue` for worker dispatch — extend this to also gate on total in-flight network requests across all workers.

**Risk**: Low — additive option, default behavior unchanged for local mode.

### 13.3 Error Type System

**File**: `src/utils/errors.ts` (new)

Currently errors are ad-hoc (`console.warn` + `catch(() => null)`). URL mode introduces network errors that need user-facing messages. Full design in **Section 14** (Error Boundary & UI Error Messaging).

Core type: `DataLoadError` with classification codes (`CORS`, `NOT_FOUND`, `NETWORK`, `TIMEOUT`, `PARSE`, `MANIFEST`, `RANGE`). Detection heuristic: `classifyFetchError()` inspects `TypeError` messages and HTTP status codes to produce actionable user-facing error messages.

**Risk**: None — new file, no existing code changes.

### 13.4 Common Loading Pipeline Extraction

**File**: `src/stores/useSceneStore.ts`

Currently `loadNuScenesScene`, `loadAV2Scene`, and the Waymo `loadDataset` action share an identical 5-step tail:

```
1. applyMetadataBundle(bundle)     ← shared, already extracted
2. initDataset-SpecificWorkers()   ← dataset-specific (different worker files)
3. loadAndCacheRowGroup(0) + (1)   ← shared
4. Display first frame             ← shared
5. prefetchAllRowGroups()          ← shared
```

Steps 3–5 are **already shared functions** (`loadAndCacheRowGroup`, `prefetchAllRowGroups`, `prefetchAllCameraRowGroups`). The only duplication is the orchestration code that calls them in sequence and manages state transitions.

**Refactoring plan — extract `runPostMetadataPipeline()`:**

```typescript
/**
 * Shared pipeline after metadata is loaded and workers are initialized.
 * Called by loadDataset (Waymo), loadNuScenesScene, loadAV2Scene, AND loadFromUrl.
 */
async function runPostMetadataPipeline(
  set: SetFn,
  get: GetFn,
): Promise<void> {
  // 1. Load first 2 row groups (LiDAR + Camera in parallel)
  set({ loadStep: 'first-frame' as LoadStep })
  const firstFramePromises: Promise<void>[] = []

  if (internal.workerPool?.isReady()) {
    firstFramePromises.push(loadAndCacheRowGroup(0, set))
    if (internal.numBatches > 1) firstFramePromises.push(loadAndCacheRowGroup(1, set))
  }
  if (internal.cameraPool?.isReady()) {
    firstFramePromises.push(loadAndCacheCameraRowGroup(0, set))
    if (internal.cameraNumBatches > 1) firstFramePromises.push(loadAndCacheCameraRowGroup(1, set))
  }
  await Promise.all(firstFramePromises)

  // 2. Display first frame
  const firstFrame = internal.frameCache.get(0)
  if (firstFrame) {
    const camData = internal.cameraImageCache.get(0)
    set({
      currentFrameIndex: 0,
      currentFrame: {
        ...firstFrame,
        cameraImages: camData ? new Map(camData) : new Map(),
      },
    })
  }

  // 3. Transition to ready + autoplay
  set({ status: 'ready', loadProgress: 1 })
  get().actions.play()

  // 4. Prefetch remaining in background
  if (internal.workerPool?.isReady() && !internal.prefetchStarted) {
    internal.prefetchStarted = true
    prefetchAllRowGroups(set, get)
  }
  if (internal.cameraPool?.isReady() && !internal.cameraPrefetchStarted) {
    internal.cameraPrefetchStarted = true
    prefetchAllCameraRowGroups(set)
  }
}
```

**Each dataset's loader simplifies to:**
```typescript
async function loadAV2Scene(logId, set, get) {
  // 1. Dataset-specific: load metadata
  const bundle = await loadAV2LogMetadata(...)
  applyMetadataBundle(bundle, set, get)

  // 2. Dataset-specific: init workers
  await initAV2LidarWorker(...)
  await initAV2CameraWorker(...)

  // 3. Shared pipeline (identical for all datasets + URL mode)
  await runPostMetadataPipeline(set, get)
}
```

This removes ~50 lines of duplicated orchestration from each of the 3 dataset loaders, and `loadFromUrl` reuses `runPostMetadataPipeline` directly.

**Risk**: Medium — the extraction is mechanical (copy-paste shared lines into function, replace with call), but must be tested against all 3 dataset paths. Strategy: extract in a separate PR, verify all existing 415+ tests pass before starting URL work.

## 14. Error Boundary & UI Error Messaging

### 14.1 Error Type System

```typescript
// src/utils/errors.ts (new)

export type DataLoadErrorCode =
  | 'CORS'         // Blocked by CORS (opaque fetch failure)
  | 'NOT_FOUND'    // 404 — wrong URL or missing file
  | 'NETWORK'      // Network offline or DNS failure
  | 'TIMEOUT'      // Fetch took > 30s
  | 'PARSE'        // File fetched but unparseable (corrupt/wrong format)
  | 'MANIFEST'     // manifest.json missing or malformed
  | 'RANGE'        // Server doesn't support Range requests (warning, not fatal)
  | 'UNKNOWN'

export class DataLoadError extends Error {
  constructor(
    message: string,
    public readonly code: DataLoadErrorCode,
    public readonly url?: string,
    public readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = 'DataLoadError'
  }
}

// Detection heuristic
export function classifyFetchError(error: unknown, url: string): DataLoadError {
  if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
    return new DataLoadError(
      `Cannot access data at this URL. This is usually a CORS issue.\n` +
      `Ensure the hosting server allows cross-origin requests.`,
      'CORS', url, true
    )
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new DataLoadError(
      `Request timed out. The server may be slow or the file too large.`,
      'TIMEOUT', url, true
    )
  }
  // ... status-based classification for Response errors
  return new DataLoadError(String(error), 'UNKNOWN', url)
}

export function classifyHttpError(status: number, url: string): DataLoadError {
  if (status === 404) {
    return new DataLoadError(
      `File not found: ${url.split('/').pop()}\nCheck the URL path.`,
      'NOT_FOUND', url
    )
  }
  if (status === 403) {
    return new DataLoadError(
      `Access denied. The hosting server may require authentication or CORS headers.`,
      'CORS', url
    )
  }
  return new DataLoadError(`HTTP ${status} for ${url}`, 'UNKNOWN', url, status >= 500)
}
```

### 14.2 Error Propagation Layers

Errors can occur at 4 levels. Each handles differently:

| Layer | Error source | Handling |
|-------|-------------|----------|
| **URL validation** (landing page) | Invalid URL, CORS probe failure | Inline error below URL input, red border. User fixes URL and retries. |
| **Metadata loading** (main thread) | manifest.json missing, calibration fetch fail | Full-screen error overlay with `DataLoadError.message`. "Try Again" button calls `loadFromUrl()` again. |
| **Worker frame fetch** | Individual frame 404, network blip | `resolveFileEntry` retries 3x internally. After exhaustion, worker sends `{ type: 'error', batchIndex, code }` to main thread. |
| **Rendering** | WebGL context lost, shader compile fail | React Error Boundary catches, shows "Rendering error" overlay with reset button. |

### 14.3 Store Error State

```typescript
// Add to SceneState:
interface SceneState {
  // ... existing ...
  error: string | null            // existing — fatal error message
  errorCode: DataLoadErrorCode | null  // new — for UI to show specific guidance
  warnings: DataLoadWarning[]     // new — non-fatal warnings (e.g. missing Range support)
  failedFrames: Set<number>       // new — frames where worker fetch failed after retries
}

interface DataLoadWarning {
  code: 'RANGE' | 'SLOW_SERVER' | 'PARTIAL_DATA'
  message: string
}
```

### 14.4 UI Error Components

**Fatal errors** (metadata load fail, CORS block):
```
┌──────────────────────────────────────┐
│  ⚠ Cannot load scene                │
│                                      │
│  Cannot access data at this URL.     │
│  This is usually a CORS issue.       │
│                                      │
│  Ensure the hosting server allows    │
│  cross-origin requests.              │
│                                      │
│  URL: https://s3.../log_id/         │
│  Error: CORS                         │
│                                      │
│  [ Try Again ]  [ Back to Home ]     │
└──────────────────────────────────────┘
```

**Per-frame failures** (shown in buffer bar):
- Failed frames rendered as red segments in the buffer bar (existing gray = not loaded, blue = loaded)
- Tooltip on hover: "Frame 42: fetch failed after 3 retries. Click to retry."
- Clicking a red segment triggers `retryFrame(42)` which re-dispatches to worker pool

**Non-fatal warnings** (shown as dismissible toast):
- "Server doesn't support Range requests. Loading may be slower than expected."
- Auto-dismiss after 8 seconds, or click X to dismiss

### 14.5 React Error Boundary

```typescript
// src/components/ErrorBoundary.tsx (new)
class SceneErrorBoundary extends React.Component<Props, State> {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-overlay">
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message}</p>
          <button onClick={() => {
            this.setState({ hasError: false })
            window.location.reload()
          }}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
```

Wrap the main scene in `App.tsx`:
```tsx
<SceneErrorBoundary>
  <LidarViewer />
  <CameraPanel />
  <Timeline />
</SceneErrorBoundary>
```

This catches WebGL crashes, R3F rendering errors, and unexpected throws that would otherwise white-screen the app.

## 15. Memory Budget

### 15.1 Memory Zones

URL mode introduces a new memory concern: fetched data lives in JS heap (unlike local `File.slice()` which is zero-copy from disk). Data can exist in up to 3 locations:

| Zone | What | Lifecycle | Eviction |
|------|------|-----------|----------|
| **Worker cache** | Fetched `ArrayBuffer` per frame (LiDAR feather, camera JPEG) | Lives in worker thread heap | LRU: keep last N batches, evict oldest |
| **Main thread frame cache** | Decoded `FrameData` (Float32Arrays, box objects) | `internal.frameCache` Map | Same as local mode: full segment cached |
| **Service Worker cache** | Raw HTTP responses (feather, JPEG files) | `CacheStorage` (persistent) | LRU with 2GB cap |

### 15.2 Per-Dataset Memory Estimates (URL Mode)

| Dataset | Per-frame (raw) | Per-frame (decoded) | 150 frames (all cached) | Peak (raw + decoded) |
|---------|----------------|--------------------|-----------------------|---------------------|
| **AV2** | ~3MB (2MB lidar feather + 7×150KB JPEG) | ~5MB (Float32Array + boxes) | ~750MB decoded | ~1.2GB |
| **Waymo** | ~8MB (range image parquet RG share) | ~8MB (168K pts × 5 sensors) | ~1.6GB decoded | ~2.0GB |
| **nuScenes** | ~1MB (34K pts bin + 6×100KB JPEG) | ~2MB | ~300MB decoded | ~450MB |

### 15.3 Worker Cache Policy

Workers hold fetched `ArrayBuffer`s in an internal `Map<string, ArrayBuffer>`. Without eviction, a full AV2 segment keeps ~450MB of raw data in worker heap (on top of decoded data sent to main thread).

**Policy**: Workers keep raw `ArrayBuffer` cache for the **current batch and adjacent batches only** (N-1, N, N+1). When batch N+2 is requested, batch N-1's raw data is evicted. This caps worker raw cache at ~3 batches × ~batch_size.

```typescript
// In worker: after processing a batch
const MAX_CACHED_BATCHES = 3

function evictOldBatches(currentBatch: number) {
  for (const [key, _] of rawCache) {
    const batchIdx = getBatchIndex(key)
    if (Math.abs(batchIdx - currentBatch) > 1) {
      rawCache.delete(key)
    }
  }
}
```

**Main thread frame cache**: unchanged from local mode — all frames stay decoded in `internal.frameCache`. This is the same behavior as local mode (which also caches all frames). For very long segments, this could be revisited, but it's not a regression from current behavior.

### 15.4 Service Worker Cache Budget

2GB LRU cap as specified in Section 11.4. Key addition: the SW cache is **persistent across sessions** (unlike worker cache which is per-page-load). This means:

- First visit: ~450MB fetched + cached in SW + decoded in worker/main
- Second visit: ~0 bytes fetched (SW serves from cache) + decoded in worker/main
- Peak: ~450MB (SW) + ~750MB (decoded) = ~1.2GB total for AV2

### 15.5 Memory Monitoring

Add to the existing `memLog` utility:
```typescript
// Log memory at key points
memLog.snap('url:metadata-fetched', { note: 'calibration + pose buffers' })
memLog.snap('url:batch-decoded', { note: `batch ${i}, worker cache: ${workerCacheSize}MB` })
```

The existing `memLog` already tracks memory at pipeline phases. URL mode adds fetch-phase snapshots. No new tooling needed — same debug panel shows memory timeline.

## 16. Open Questions

1. **Offline-first potential** — With Service Worker caching, a previously-viewed scene could work fully offline. Worth advertising this capability? Could be valuable for conference demos with unreliable WiFi.

2. **Progressive loading UI** — For URL mode, should we show individual file fetch progress (e.g., "Fetching calibration... Fetching poses... Fetching frame 1/150...")? This gives better feedback than a single progress bar but adds UI complexity. **Tentative**: show a step-level indicator (`loadStep`) for metadata phase, then switch to buffer bar for frame phase. This is what local mode already does — no new UI needed.

---

## Addendum A: Code Audit Findings (rev 4)

> Added 2026-03-14 after thorough codebase analysis.
> Addresses: CORS risk, feather.ts gap confirmation, Phase 0d extraction feasibility,
> CORS probe method improvement, Parquet Range caching strategy, manifest.json generation.

### A.1 AV2 S3 CORS — Tested (2026-03-14, two rounds)

**Bucket**: `s3://argoverse` → `https://argoverse.s3.us-east-1.amazonaws.com`
**Test files**: Real Feather files from train log `00a6ffc1-6ce9-3bc3-a060-6006e9893a1a`
**Test page**: `scripts/test_av2_cors.html`

#### Final Test Results (Round 2)

| Test | Result | Detail |
|------|--------|--------|
| Simple GET annotations.feather | **200 OK**, body readable | No `Access-Control-Allow-Origin` header, but body accessible |
| Simple GET city_SE3_egovehicle.feather | **200 OK**, body readable | Same — public S3 behavior |
| Body read (arrayBuffer) | **Success** — 163.8 KB, Feather magic `ARROW1` verified | Full body readable in JS |
| Range GET (bytes=0-1023) | **206 Partial Content**, body readable (1024 bytes) | Works! `Range` is a CORS-safelisted header per Fetch spec |
| OPTIONS preflight (Range) | **Failed to fetch** | Bucket has no CORS configuration — explicit preflight rejected |
| S3 ListObjectsV2 | **200 OK**, XML parseable | 10 LiDAR files listed, IsTruncated=true (pagination available) |
| Camera directory listing | **200 OK** | ring_front_center JPEGs listable |

#### Interpretation

The bucket has **no CORS configuration** (OPTIONS fails), yet almost everything works:

1. **Simple GET works** — public S3 serves data to any origin. Browser receives full response.
2. **Body is readable** — even without `Access-Control-Allow-Origin`, the Fetch spec allows reading response body for "basic" mode requests to public resources. This is because a CORS-unconfigured public bucket doesn't return an opaque response — it returns a normal response that simply lacks CORS headers.
3. **Range GET works** (!) — the `Range` header is a [CORS-safelisted request header](https://fetch.spec.whatwg.org/#cors-safelisted-request-header) per the Fetch specification. Browsers do NOT trigger a preflight for it. The initial test failure (round 1) was likely a cached preflight failure from a prior test. Round 2 confirmed `Range: bytes=0-1023` returns 206 with a readable 1024-byte body.
4. **Response headers are opaque** — `Content-Length`, `Content-Range`, etc. read as `null` because there's no `Access-Control-Expose-Headers`.
5. **S3 ListObjectsV2 works** — the `?list-type=2&prefix=...` query is a simple GET. Returns XML with file keys.

#### Impact on URL Loading Strategy — Better Than Expected

**ALL planned fetch patterns work for AV2 on public S3:**

| Capability | Works? | Implication |
|-----------|--------|-------------|
| Simple GET (full Feather/JPEG) | **Yes** | All AV2 sensor data fetchable |
| Range GET (partial read) | **Yes** | hyparquet could work on AV2 Parquet if needed (not currently used) |
| Body read (arrayBuffer) | **Yes** | flechette parser, JPEG decode all work |
| S3 ListObjectsV2 | **Yes** | **Frame discovery without manifest.json** — see A.10 |
| Response headers | **No** | Can't read Content-Length. Use frame count for progress instead |

#### Frame Discovery: Two Options Now Available

With ListObjectsV2 working, we have two viable paths for frame discovery:

| Approach | Latency | Robustness | Maintenance |
|----------|---------|-----------|-------------|
| **manifest.json** (original plan) | 1 request, ~50KB | High — explicit frame list + camera timestamps | Requires generation script per log |
| **S3 ListObjectsV2** (new option) | 2–3 requests (~150 LiDAR + 7×~300 camera files need pagination) | Medium — depends on S3 API availability | Zero maintenance — reads live bucket |

**Recommended: Dual strategy** — try ListObjectsV2 first (zero setup), fall back to manifest.json if listing fails (e.g., non-S3 hosting without directory listing). See **A.10** for detailed design.

#### Revised Risk Assessment

| Original assessment | Revised | Why |
|--------------------|---------|----|
| "CORS blocks all browser fetches" | **Everything works on public S3** | No CORS config needed. Simple GET, Range, ListObjects all succeed |
| "Need CloudFront proxy fallback" | **Not needed for AV2** | Direct S3 access works for all operations |
| "CORS is critical blocker" | **Non-issue for AV2** | Only affects servers that actively reject cross-origin (rare for public data) |
| "manifest.json required" | **Optional for S3-hosted data** | ListObjectsV2 enables manifest-free frame discovery |

#### Response Header Opacity Workaround

Since `Content-Length` etc. are unreadable:
- **Progress tracking**: Use frame count from ListObjectsV2 or manifest.json. Show "Frame 12/150" instead of "45 MB / 450 MB".
- **File existence check**: ListObjectsV2 confirms files exist before fetching. No need for HEAD requests.

#### `resolveFileEntry` — Worker Fetch Helper

Simple GET is all we need. No special handling required:

```typescript
export async function resolveFileEntry(entry: File | string): Promise<ArrayBuffer> {
  if (typeof entry !== 'string') return entry.arrayBuffer()
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(entry)  // Simple GET — works on public S3 without CORS
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${entry}`)
      return res.arrayBuffer()
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err
      await new Promise(r => setTimeout(r, BACKOFF_BASE_MS * (2 ** attempt)))
    }
  }
  throw new Error('unreachable')
}
```

#### CORS Summary for All Datasets

| Dataset | Data format | Range needed? | CORS needed? | S3 ListObjects? | Status |
|---------|------------|--------------|-------------|----------------|--------|
| **AV2** | Feather + JPEG | No (full GET) | **No** (public S3 works) | **Yes** — frame discovery | **Ready** |
| **Waymo** | Parquet | Yes (hyparquet) | Yes (for Range preflight on non-public servers) | N/A (self-hosted) | User configures CORS |
| **nuScenes** | JSON + .bin + JPEG | No | No (if public) | N/A (self-hosted) | User configures CORS |

### A.2 Feather.ts — Confirmed Gap & Fix

**Finding**: Current signatures are strictly `File`-only:

```typescript
// Current (feather.ts lines 30, 66)
export async function readFeatherFile(file: File): Promise<Record<string, unknown>[]>
export async function readFeatherColumns(file: File): Promise<{ columns; numRows }>
```

`readFeatherBuffer(buffer: ArrayBuffer)` already exists (line 38) and is the internal workhorse. The fix is exactly as the plan describes — 1-line `instanceof` check:

```typescript
export async function readFeatherFile(source: File | ArrayBuffer): Promise<Record<string, unknown>[]> {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  return readFeatherBuffer(buffer)
}

export async function readFeatherColumns(source: File | ArrayBuffer): Promise<{ columns; numRows }> {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  const table = tableFromIPC(buffer, { useProxy: false, useBigInt: true })
  // ... rest unchanged
}
```

**Impact on AV2 metadata.ts**: `buildAV2LogDatabase()` calls `readFeatherFile(extrinsicsFile)` and `readFeatherColumns(posesFile)` on lines 79, 95, 114, 139. After this change, URL mode can pass pre-fetched `ArrayBuffer` directly. **Zero call-site changes needed for existing local mode.**

**Risk**: None. Additive change, backward compatible.

### A.3 Phase 0d — Post-Metadata Pipeline Extraction Feasibility

**Full code audit result** of the three dataset loaders:

#### What IS identical (safely extractable):

| Step | Function | Lines saved |
|------|----------|-------------|
| First 2 batch loading | `loadAndCacheRowGroup(0)` + `(1)` parallel dispatch | ~12 lines × 3 |
| Camera batch loading | `loadAndCacheCameraRowGroup(0)` + `(1)` parallel | ~8 lines × 3 |
| First frame display | `set({ currentFrameIndex: 0, currentFrame: ... })` | ~10 lines × 3 |
| Status transition | `set({ status: 'ready', loadProgress: 1 })` | ~3 lines × 3 |
| Auto-play | `get().actions.play()` | ~1 line × 3 |
| Background prefetch | `prefetchAllRowGroups()` + `prefetchAllCameraRowGroups()` | ~8 lines × 3 |
| **Total** | | **~126 lines removed** |

#### What is NOT extractable (fundamentally dataset-specific):

| Step | Why different |
|------|--------------|
| Metadata loading | Waymo: Parquet footer + row reads. nuScenes: pre-loaded JSON DB + scene lookup. AV2: pre-loaded Feather DB + log lookup |
| Frame batch building | Waymo: implicit (Parquet RG structure). nuScenes/AV2: explicit `buildFrameBatches()` from `vehiclePoseByFrame`. **Timing matters**: must run BEFORE `applyMetadataBundle()` because it reads `vehiclePoseByFrame` which gets consumed |
| Worker initialization | Different worker files, different init payloads (Waymo: `lidarUrl` + calibrations. nuScenes: `fileEntries` + extrinsics. AV2: `fileEntries` only) |

#### Recommended extraction — `runPostMetadataPipeline()`:

```typescript
/**
 * Shared tail of all dataset loading paths.
 * Called AFTER: (1) metadata applied, (2) workers initialized.
 */
async function runPostMetadataPipeline(set: SetFn, get: GetFn): Promise<void> {
  // 1. Load first 2 batches (LiDAR + Camera in parallel)
  set({ loadStep: 'first-frame' })
  const promises: Promise<void>[] = []
  if (internal.workerPool?.isReady()) {
    promises.push(loadAndCacheRowGroup(0, set))
    if (internal.numBatches > 1) promises.push(loadAndCacheRowGroup(1, set))
  }
  if (internal.cameraPool?.isReady()) {
    promises.push(loadAndCacheCameraRowGroup(0, set))
    if (internal.cameraNumBatches > 1) promises.push(loadAndCacheCameraRowGroup(1, set))
  }
  await Promise.all(promises)

  // 2. Display first frame
  const firstFrame = internal.frameCache.get(0)
  if (firstFrame) {
    const camData = internal.cameraImageCache.get(0)
    set({
      currentFrameIndex: 0,
      currentFrame: {
        ...firstFrame,
        cameraImages: camData ? new Map(camData) : new Map(),
      },
    })
  }

  // 3. Ready + play
  set({ status: 'ready', loadProgress: 1 })
  get().actions.play()

  // 4. Background prefetch
  if (internal.workerPool?.isReady() && !internal.prefetchStarted) {
    internal.prefetchStarted = true
    prefetchAllRowGroups(set, get)
  }
  if (internal.cameraPool?.isReady() && !internal.cameraPrefetchStarted) {
    internal.cameraPrefetchStarted = true
    prefetchAllCameraRowGroups(set)
  }
}
```

Each dataset loader simplifies to:

```typescript
// AV2 (same pattern for Waymo, nuScenes)
async function loadAV2Scene(logId, set, get) {
  const bundle = loadAV2LogMetadata(av2Db)
  const { lidarBatches, cameraBatches } = buildAV2FrameBatches(bundle) // BEFORE apply
  applyMetadataBundle(bundle, set, get)
  await initAV2LidarWorker(lidarBatches, ...)
  await initAV2CameraWorker(cameraBatches, ...)
  await runPostMetadataPipeline(set, get)  // ← shared tail
}
```

**Risk**: Medium. The extraction is mechanical, but `useSceneStore.ts` is 1847 lines and the 3 loaders have subtle ordering differences. **Mitigation**: extract in a separate PR, run all 415+ tests + manual test each dataset before merging.

**Recommendation**: Do this extraction **before** starting URL work. `loadFromUrl()` will call `runPostMetadataPipeline()` as its shared tail, avoiding a 4th copy of the same code.

### A.4 CORS Probe — Improved Strategy

**Problem with current plan (Section 5.3)**: HEAD requests to S3 may not return CORS headers. Some S3 configurations only attach `Access-Control-Allow-Origin` to GET responses, not HEAD/OPTIONS.

**Improved approach**: Merge CORS probe with `manifest.json` fetch:

```typescript
async function validateAndLoadManifest(
  baseUrl: string,
  dataset: DatasetId,
): Promise<{ manifest?: AV2Manifest; error?: DataLoadError }> {
  const manifestUrl = `${baseUrl}manifest.json`

  try {
    const res = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(10_000), // 10s timeout
    })

    if (!res.ok) {
      if (res.status === 404) {
        return { error: new DataLoadError(
          'manifest.json not found at this URL.\n' +
          'Generate with: python scripts/generate_av2_manifest.py /path/to/log',
          'MANIFEST', manifestUrl
        )}
      }
      return { error: classifyHttpError(res.status, manifestUrl) }
    }

    const manifest = await res.json() as AV2Manifest
    return { manifest }
  } catch (err) {
    // TypeError('Failed to fetch') = CORS block or network error
    return { error: classifyFetchError(err, manifestUrl) }
  }
}
```

**Benefits**:
1. **One request instead of two** — no separate HEAD probe
2. **Catches CORS at the first real fetch** — manifest.json is the first file we need anyway
3. **Correct error classification** — CORS block produces `TypeError`, not HTTP status
4. **Timeout included** — AbortSignal.timeout catches hung connections

**Landing page flow**:

```
User clicks "Load"
  → validateAndLoadManifest(baseUrl, dataset)
    → Success: proceed to loadFromUrl()
    → CORS error: "Cannot access data. The hosting server must configure CORS headers."
    → 404: "manifest.json not found. Generate with: python generate_*.py"
    → Timeout: "Server not responding. Check the URL and try again."
```

**Updated for CORS test results**: For AV2 on public S3, `manifest.json` must also be hosted alongside the data. Since S3 has no CORS but simple GET works, the fetch above will succeed as long as `manifest.json` exists at the URL. The `TypeError` catch path handles the case where a user points to a non-public or truly CORS-blocked server. The `res.status` check handles missing manifest (404).

**Important nuance**: Since `Access-Control-Allow-Origin` is not returned by AV2 S3, `res.headers.get(...)` returns `null` for all response headers. But `res.ok` and `res.json()` still work. Error classification must NOT rely on reading response headers — only on HTTP status and catch/TypeError.

### A.5 Parquet Range Caching — Waymo Revisit Strategy

**Problem**: Section 11.5's "layered approach" leaves Waymo Parquet files completely uncached by the Service Worker. `hyparquet.asyncBufferFromUrl()` always sends Range requests → server responds with 206 Partial → SW passes through to browser HTTP cache. On revisit, if browser cache is evicted (common for 162MB files), all Range requests repeat.

**Revised strategy — Row-Group-Level SW Caching**:

Instead of caching at the HTTP level, cache at the **semantic level** — after a row group is decompressed, the worker already produces `FrameData` objects. These can be serialized and cached in the SW.

However, this adds significant complexity. A simpler approach:

**Option: Full-file SW cache after all RGs read**

```typescript
// In the main thread, after prefetch completes for a Parquet file:
async function cacheFullParquetFile(url: string, asyncBuffer: AsyncBuffer) {
  if (!('serviceWorker' in navigator)) return

  // Read the full file into an ArrayBuffer
  const fullBuffer = await asyncBuffer.slice(0, asyncBuffer.byteLength)

  // Store as a synthetic 200 response (not 206)
  const cache = await caches.open('perception-studio-data-v1')
  const syntheticResponse = new Response(fullBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fullBuffer.byteLength),
      'X-Cached-Full-File': 'true',
    },
  })
  await cache.put(url, syntheticResponse)
}
```

Then the SW intercepts future Range requests and serves them from the cached full file:

```typescript
// In sw.ts
async function handleRangeRequest(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME)
  const fullResponse = await cache.match(new Request(request.url)) // Match without Range header

  if (fullResponse && fullResponse.headers.get('X-Cached-Full-File')) {
    const rangeHeader = request.headers.get('Range')
    if (rangeHeader) {
      const [start, end] = parseRangeHeader(rangeHeader, fullResponse)
      const body = (await fullResponse.arrayBuffer()).slice(start, end + 1)
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fullResponse.headers.get('Content-Length')}`,
          'Content-Length': String(body.byteLength),
        },
      })
    }
    return fullResponse
  }

  // Not cached — pass through to network
  return fetch(request)
}
```

**Pros**: Zero re-download on revisit. Waymo's 162MB `lidar.parquet` cached once, served locally forever.
**Cons**: 162MB stored in CacheStorage. But within our 2GB budget (a full Waymo segment would use ~500MB of cache).

**Timeline**: Implement in Phase 4 (Service Worker), not Phase 2. Phase 2 focuses on AV2 (Feather files, not Parquet).

### A.6 manifest.json — Schema & Generation Script

The plan references `manifest.json` but doesn't provide the generation script. Here's the complete implementation:

**AV2 manifest.json schema** (TypeScript type):

```typescript
interface AV2Manifest {
  version: 1
  dataset: 'argoverse2'
  log_id: string
  num_frames: number
  frames: AV2ManifestFrame[]
}

interface AV2ManifestFrame {
  /** LiDAR timestamp in nanoseconds */
  timestamp_ns: string   // string because JSON can't represent int64
  /** Per-camera image timestamps (nanoseconds), keyed by camera name */
  cameras: Record<string, string>  // cam_name → timestamp_ns
}
```

**Generation script** (`scripts/generate_av2_manifest.py`):

```python
#!/usr/bin/env python3
"""
Generate manifest.json for an Argoverse 2 log directory.

Usage:
    python scripts/generate_av2_manifest.py /path/to/av2/sensor/val/01bb304d-7bd8-35f8-bbef-7086b688e35e

Output:
    {log_dir}/manifest.json
"""

import json
import re
import sys
from pathlib import Path

RING_CAMERAS = [
    'ring_rear_left', 'ring_side_left', 'ring_front_left',
    'ring_front_center',
    'ring_front_right', 'ring_side_right', 'ring_rear_right',
]

def generate_manifest(log_dir: Path) -> dict:
    log_id = log_dir.name

    # 1. Discover LiDAR timestamps
    lidar_dir = log_dir / 'sensors' / 'lidar'
    lidar_timestamps = sorted(
        int(f.stem) for f in lidar_dir.glob('*.feather')
    )

    # 2. Discover camera timestamps per camera
    cam_timestamps: dict[str, list[int]] = {}
    for cam_name in RING_CAMERAS:
        cam_dir = log_dir / 'sensors' / 'cameras' / cam_name
        if cam_dir.exists():
            cam_timestamps[cam_name] = sorted(
                int(f.stem) for f in cam_dir.glob('*.jpg')
            )

    # 3. Match each LiDAR frame to nearest camera timestamp
    frames = []
    for lidar_ts in lidar_timestamps:
        cameras = {}
        for cam_name, cam_ts_list in cam_timestamps.items():
            closest = min(cam_ts_list, key=lambda t: abs(t - lidar_ts))
            cameras[cam_name] = str(closest)
        frames.append({
            'timestamp_ns': str(lidar_ts),
            'cameras': cameras,
        })

    return {
        'version': 1,
        'dataset': 'argoverse2',
        'log_id': log_id,
        'num_frames': len(frames),
        'frames': frames,
    }


def main():
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} /path/to/av2/log_dir', file=sys.stderr)
        sys.exit(1)

    log_dir = Path(sys.argv[1])
    if not (log_dir / 'sensors' / 'lidar').exists():
        print(f'Error: {log_dir}/sensors/lidar/ not found', file=sys.stderr)
        sys.exit(1)

    manifest = generate_manifest(log_dir)
    out_path = log_dir / 'manifest.json'
    with open(out_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f'Wrote {out_path} ({manifest["num_frames"]} frames)')


if __name__ == '__main__':
    main()
```

**Waymo manifest.json schema** (for Phase 6):

```typescript
interface WaymoManifest {
  version: 1
  dataset: 'waymo'
  segment_id: string
  /** Parquet component files available at {base}/{component}.parquet */
  components: string[]   // e.g. ['vehicle_pose', 'lidar', 'camera_image', ...]
}
```

Waymo is simpler — component filenames are fixed per segment. The manifest just lists which components are available. `manifest.json` size: ~200 bytes.

**nuScenes manifest.json schema** (for Phase 6):

```typescript
interface NuScenesManifest {
  version: 1
  dataset: 'nuscenes'
  /** Version string (e.g. 'v1.0-mini') */
  nuscenes_version: string
  /** Available scene names */
  scenes: string[]
  /** JSON table files available at {base}/{version}/{filename} */
  json_tables: string[]   // e.g. ['scene.json', 'sample.json', ...]
}
```

### A.7 buildAV2LogDatabase — URL Mode Refactoring Path

**Current coupling**: `buildAV2LogDatabase(logFiles: Map<string, File>, logId: string)` is tightly coupled to `File` objects:

1. Lines 74-75: `logFiles.get('calibration/...')` → `File`
2. Lines 79, 95: `readFeatherFile(file)` — needs `File`
3. Lines 114, 139: `readFeatherColumns(file)` — needs `File`
4. Lines 176-181: `logFiles.keys()` scan for LiDAR timestamps
5. Lines 188-201: `logFiles.keys()` scan for camera filenames

**URL mode refactoring plan (two options)**:

**Option A — Refactor `buildAV2LogDatabase` to accept pre-fetched buffers** (recommended):

```typescript
// New: accepts both File map (local) and ArrayBuffer map (URL)
export async function buildAV2LogDatabase(
  logFiles: Map<string, File> | null,
  logId: string,
  options?: {
    /** Pre-fetched buffers for URL mode (calibration + pose + annotations) */
    buffers?: {
      extrinsics: ArrayBuffer
      intrinsics: ArrayBuffer
      poses: ArrayBuffer
      annotations?: ArrayBuffer
    }
    /** From manifest.json: replaces file-path scanning for frame discovery */
    manifest?: AV2Manifest
  }
): Promise<AV2LogDatabase>
```

URL mode call site:
```typescript
const [extrinsicsBuf, intrinsicsBuf, posesBuf, annBuf] = await Promise.all([
  fetchBuffer(`${base}calibration/egovehicle_SE3_sensor.feather`),
  fetchBuffer(`${base}calibration/intrinsics.feather`),
  fetchBuffer(`${base}city_SE3_egovehicle.feather`),
  fetchBuffer(`${base}annotations.feather`).catch(() => null),
])

const manifest = await fetchJson<AV2Manifest>(`${base}manifest.json`)

const db = await buildAV2LogDatabase(null, manifest.log_id, {
  buffers: { extrinsics: extrinsicsBuf, intrinsics: intrinsicsBuf, poses: posesBuf, annotations: annBuf },
  manifest,
})
```

**Option B — Separate function `buildAV2LogDatabaseFromUrl`** (safer but duplicates):

```typescript
export async function buildAV2LogDatabaseFromUrl(
  baseUrl: string,
  manifest: AV2Manifest,
): Promise<AV2LogDatabase>
```

**Decision: Option A** — the internal parsing logic (`readFeatherBuffer`, quaternion conversion, annotation grouping) is identical. Only the data source differs. Use `instanceof` checks + `options?.manifest` for frame discovery.

### A.8 Updated Risk Matrix

| Risk | Original Assessment | Final Assessment (post-testing) | Change |
|------|--------------------|--------------------|--------|
| AV2 S3 CORS | "User confirmed CORS works" | **RESOLVED ✓** — All operations work: simple GET, Range 206, ListObjectsV2. No CORS config needed for public S3 | ⬇ Eliminated |
| AV2 frame discovery | "Requires manifest.json" | **Simplified** — S3 ListObjectsV2 works, manifest.json only needed as fallback for non-S3 hosting | ⬇ |
| Phase 0d extraction | "Medium risk" | **Medium risk — confirmed feasible** but must handle ordering difference (batch building BEFORE applyMetadataBundle for nuScenes/AV2) | Same |
| Feather overloads | "Low risk" | **No risk — trivial** | ⬇ |
| CORS probe method | Not assessed | **Merged with manifest/ListObjects fetch** — first real request acts as probe | Resolved |
| Parquet Range caching (Waymo) | "Defer to browser HTTP cache" | **Browser cache evicts 162MB files — need SW full-file caching** (Phase 4). Not blocking for AV2 | Same |
| Worker `postMessage` for 1200 URL strings | Not assessed | **No risk — strings are small (~200 bytes each), structured clone handles fine** | New |
| Response header opacity | Not assessed | **Low impact** — Content-Length unreadable but progress can use frame count from ListObjectsV2/manifest | New |

### A.9 Revised Phase 0 Task List

| # | Task | Status | Notes |
|---|------|--------|-------|
| 0a | Feather `ArrayBuffer` overloads | **DONE ✓** | `readFeatherFile(File \| ArrayBuffer)` and `readFeatherColumns(File \| ArrayBuffer)` — `instanceof ArrayBuffer` check, backward compatible. 7 unit tests. |
| 0b | Error type system (`DataLoadError`) | **DONE ✓** | `src/utils/errors.ts` — `DataLoadError` class + `classifyFetchError()` + `classifyHttpError()`. Uses explicit field assignment (no parameter properties) for `erasableSyntaxOnly` compat. 12 unit tests. |
| 0c | Worker fetch concurrency limiter | **DONE ✓** | `WorkerPool` constructor takes optional 3rd arg `maxConcurrentFetches` (default `Infinity`). Tracks `inFlightCount`, gates `requestBatch()` and `drainQueue()`. Reset in `rejectAllPending()`. 5 unit tests with mock Workers. |
| 0d | Extract `runPostWorkerPipeline()` | **DONE ✓** | Shared function in `useSceneStore.ts` replaces ~50 duplicate lines in each of 3 loaders. Takes `logLabel` param for memLog + optional `mainThreadFallback` callback (Waymo-only). Batch-building ordering preserved (nuScenes/AV2 call before `applyMetadataBundle`). |
| ~~0e~~ | ~~AV2 S3 CORS verification~~ | **DONE ✓** | All operations work on public S3 without CORS. See A.1 |
| 0f | `manifest.json` schema + generation script | **Ready** | Python script from A.6. Optional if using ListObjectsV2 (A.10) — but still needed as fallback for non-S3 hosting |
| 0g | Unit tests for 0a–0d | **DONE ✓** | 24 new tests across 3 files: `errors.test.ts` (12), `featherOverloads.test.ts` (7), `workerPoolConcurrency.test.ts` (5). Total suite: 439 tests pass. |

### A.10 S3 ListObjectsV2 — Manifest-Free Frame Discovery (New Option)

**Discovery**: The AV2 S3 bucket supports unauthenticated `ListObjectsV2` via simple GET. This enables frame discovery directly from S3 without requiring a pre-generated `manifest.json`.

#### How It Works

S3's ListObjectsV2 API is a simple GET with query parameters:

```
GET https://argoverse.s3.us-east-1.amazonaws.com
    ?list-type=2
    &prefix=datasets/av2/sensor/train/{log_id}/sensors/lidar/
    &delimiter=/
    &max-keys=1000
```

Returns XML:
```xml
<ListBucketResult>
  <KeyCount>158</KeyCount>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>datasets/.../sensors/lidar/315967376859506000.feather</Key>
    <Size>2097152</Size>
  </Contents>
  <Contents>
    <Key>datasets/.../sensors/lidar/315967376959702000.feather</Key>
    <Size>2097152</Size>
  </Contents>
  ...
</ListBucketResult>
```

#### Implementation: `discoverAV2FramesFromS3()`

```typescript
// src/adapters/argoverse2/s3Discovery.ts (new)

interface AV2FrameDiscovery {
  lidarTimestamps: bigint[]
  cameraTimestampsByCam: Map<string, bigint[]>
}

const AV2_RING_CAMERAS = [
  'ring_rear_left', 'ring_side_left', 'ring_front_left',
  'ring_front_center',
  'ring_front_right', 'ring_side_right', 'ring_rear_right',
]

/**
 * Discover AV2 frames by listing S3 objects.
 * No manifest.json needed — reads the bucket directly.
 *
 * Makes 1 + 7 requests (1 for LiDAR + 7 for ring cameras).
 * Each request returns up to 1000 keys (enough for most AV2 logs).
 */
export async function discoverAV2FramesFromS3(
  baseUrl: string,  // e.g. https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/train/{log_id}/
): Promise<AV2FrameDiscovery> {
  // Parse bucket URL to extract bucket host + prefix
  const url = new URL(baseUrl)
  const bucketOrigin = url.origin  // https://argoverse.s3.us-east-1.amazonaws.com
  const pathPrefix = url.pathname.replace(/^\//, '').replace(/\/$/, '')  // datasets/av2/.../log_id

  // 1. List LiDAR files
  const lidarKeys = await listS3Keys(bucketOrigin, `${pathPrefix}/sensors/lidar/`)
  const lidarTimestamps = lidarKeys
    .map(key => {
      const match = key.match(/(\d+)\.feather$/)
      return match ? BigInt(match[1]) : null
    })
    .filter((ts): ts is bigint => ts !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  // 2. List camera files (all 7 cameras in parallel)
  const cameraTimestampsByCam = new Map<string, bigint[]>()
  await Promise.all(AV2_RING_CAMERAS.map(async (camName) => {
    const camKeys = await listS3Keys(bucketOrigin, `${pathPrefix}/sensors/cameras/${camName}/`)
    const timestamps = camKeys
      .map(key => {
        const match = key.match(/(\d+)\.jpg$/)
        return match ? BigInt(match[1]) : null
      })
      .filter((ts): ts is bigint => ts !== null)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    cameraTimestampsByCam.set(camName, timestamps)
  }))

  return { lidarTimestamps, cameraTimestampsByCam }
}

/**
 * List all object keys under a prefix using S3 ListObjectsV2.
 * Handles pagination via ContinuationToken.
 */
async function listS3Keys(bucketOrigin: string, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | null = null

  do {
    const params = new URLSearchParams({
      'list-type': '2',
      'prefix': prefix,
      'max-keys': '1000',
    })
    if (continuationToken) {
      params.set('continuation-token', continuationToken)
    }

    const res = await fetch(`${bucketOrigin}?${params}`)
    if (!res.ok) throw new Error(`S3 list failed: ${res.status}`)

    const xml = await res.text()
    const doc = new DOMParser().parseFromString(xml, 'text/xml')

    for (const el of doc.querySelectorAll('Contents > Key')) {
      if (el.textContent) keys.push(el.textContent)
    }

    const isTruncated = doc.querySelector('IsTruncated')?.textContent === 'true'
    continuationToken = isTruncated
      ? doc.querySelector('NextContinuationToken')?.textContent ?? null
      : null
  } while (continuationToken)

  return keys
}
```

#### Request Budget

| Request | Keys expected | Size |
|---------|-------------|------|
| List `sensors/lidar/` | ~150 | ~15 KB XML |
| List `sensors/cameras/ring_*` × 7 | ~300 each | ~30 KB each |
| **Total** | ~2250 files | **8 requests, ~225 KB** |

All requests are parallel (except pagination). Total latency: ~200–400ms on a decent connection.

#### Dual Strategy: ListObjects → manifest.json Fallback

```typescript
async function discoverAV2Frames(
  baseUrl: string,
): Promise<AV2FrameDiscovery> {
  // Try S3 ListObjectsV2 first (zero setup for S3-hosted data)
  try {
    return await discoverAV2FramesFromS3(baseUrl)
  } catch {
    // Fall back to manifest.json (for non-S3 hosting: nginx, CloudFront, etc.)
    const manifestUrl = baseUrl.replace(/\/$/, '') + '/manifest.json'
    const res = await fetch(manifestUrl)
    if (!res.ok) {
      throw new DataLoadError(
        'Could not discover frames. Either host on S3 (ListObjectsV2) or provide manifest.json.\n' +
        'Generate with: python scripts/generate_av2_manifest.py /path/to/log',
        'MANIFEST', manifestUrl,
      )
    }
    const manifest: AV2Manifest = await res.json()
    return parseManifestToDiscovery(manifest)
  }
}
```

**This is the best of both worlds**:
- **S3 hosting** (public bucket): zero setup, zero maintenance. Just upload the log directory.
- **Non-S3 hosting** (nginx, CloudFront, GitHub Pages): generate `manifest.json` once with the Python script.

#### Impact on Phase 2 (AV2 Remote Loading)

Phase 2 task 2a (`manifest.json` schema + parser) becomes **optional** for S3 hosting. The critical path simplifies to:

```
discoverAV2FramesFromS3(baseUrl)
  → lidarTimestamps + cameraTimestampsByCam
  → construct URLs: ${baseUrl}sensors/lidar/${ts}.feather
  → pass to workers as fileEntries: [filename, urlString][]
```

No manifest generation, no manifest hosting, no manifest parsing. Just point at the S3 log directory and go.
