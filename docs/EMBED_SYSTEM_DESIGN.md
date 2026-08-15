# Embed System — Technical Design

**Status**: Draft
**Author**: Heejae Kim
**Date**: 2026-03-14

## 1. Problem Statement

Perception Studio currently works only as a standalone tool — users open the app, drag-and-drop local files, and explore. There's no way to share a specific scene, frame, or view configuration via a URL.

**Goal**: Enable researchers to embed interactive 3D visualizations in paper project pages, dataset documentation, and blog posts via `<iframe>`. The viewer should initialize from URL parameters (data source, frame, display settings) and provide a clean, minimal UI suitable for embedding.

**Non-goals (v1)**: Authentication, private data access, real-time collaboration, custom annotation overlays.

## 2. Requirements

### Functional

- **F1**: Initialize viewer from URL parameters (dataset type, data URL, frame, display settings)
- **F2**: Support three layout modes: `full` (3D + cameras + timeline), `3d` (LiDAR only), `camera` (camera panels only)
- **F3**: Support three playback modes: static frame, range loop, full sequence
- **F4**: Embed mode hides chrome (header, dropzone, control panel, credits) — shows only viewer + timeline + watermark
- **F5**: "Open in Perception Studio" link preserves all URL state, opens full app in new tab
- **F6**: Deep linking — same URL params work in both embed and full mode (for bookmarking/sharing)
- **F7**: Camera angle serialization — share a specific 3D viewpoint via URL

### Non-Functional

- **NF1**: First meaningful paint < 5s on broadband (for embedded contexts where users won't wait)
- **NF2**: No CORS issues — data must be served with appropriate headers (or same-origin)
- **NF3**: iframe security — works within `sandbox="allow-scripts allow-same-origin"`
- **NF4**: No conflict with parent page keyboard shortcuts (embed mode disables global hotkeys)
- **NF5**: Responsive — fills iframe container width/height

## 3. Data Source Strategy

### 3.1 The Core Problem

Currently, data loading has two paths:
1. **Dev mode**: Vite plugin serves local `waymo_data/` directory
2. **Production**: User drags folder into browser → `File` objects

Neither path works for embed. Embed requires **URL-based data access** — the iframe loads with a URL pointing to remotely-hosted data.

### 3.2 URL-Based Data Loading

Embed URLs provide a `data` parameter pointing to a base directory:

```
?dataset=argoverse2&data=https://argoverse.s3.us-east-1.amazonaws.com/av2/sensor/val/01bb304d-...
```

The viewer receives `dataset` (explicit type) + `data` (base URL) and knows what file structure to expect.

### 3.3 Dataset-Specific URL Resolution

Each dataset adapter needs a new method: **`resolveUrls(baseUrl: string) → FileManifest`** that produces the list of URLs to fetch based on known directory structure.

#### Argoverse 2 (S3 public, no auth)

```
Base URL: https://argoverse.s3.us-east-1.amazonaws.com/av2/sensor/val/{log_id}/

Metadata (fetch once at init):
  {base}/calibration/egovehicle_SE3_sensor.feather
  {base}/calibration/intrinsics.feather
  {base}/city_SE3_egovehicle.feather
  {base}/annotations.feather

Per-frame (fetch on demand):
  {base}/sensors/lidar/{timestamp_ns}.feather
  {base}/sensors/cameras/{cam_name}/{timestamp_ns}.jpg
```

AV2 is the ideal first target because:
- Public S3, no auth, CORS-enabled (AWS public datasets)
- Individual files per frame (no row-group random access needed)
- Small metadata files (calibration <10KB, poses ~100KB, annotations ~500KB)
- We already have a working AV2 adapter

#### Waymo (user-hosted)

```
Base URL: https://user-bucket.s3.amazonaws.com/waymo_data/

Metadata (Parquet row-group reads via HTTP Range):
  {base}/vehicle_pose/{segment_id}.parquet
  {base}/lidar_calibration/{segment_id}.parquet
  {base}/camera_calibration/{segment_id}.parquet
  {base}/lidar_box/{segment_id}.parquet (optional)
  {base}/stats/{segment_id}.parquet (optional)

Per-frame (Parquet row-group random access):
  {base}/lidar/{segment_id}.parquet → row group N
  {base}/camera_image/{segment_id}.parquet → row group N
```

Waymo data cannot be publicly hosted (license restriction). Users must host their own copy and provide CORS-enabled URLs. The existing `hyparquet` HTTP Range support handles remote Parquet seamlessly — `openParquetFile()` already accepts URL strings.

#### nuScenes (user-hosted)

```
Base URL: https://user-bucket.s3.amazonaws.com/nuscenes/

Metadata:
  {base}/v1.0-mini/*.json (scene.json, sample.json, sample_data.json, etc.)

Per-frame:
  {base}/samples/LIDAR_TOP/{filename}.pcd.bin
  {base}/samples/CAM_FRONT/{filename}.jpg
  ...
```

### 3.4 File Discovery: Explicit `dataset` Parameter

**Decision**: Require explicit `dataset=waymo|nuscenes|argoverse2` parameter.

**Rejected alternative**: Auto-probing the base URL by trying known file paths. This adds N network round-trips (checking for `vehicle_pose/`, then `sensors/lidar/`, etc.), is slow, and fragile (404 responses may be slow or non-standard).

With explicit dataset type, the adapter knows exactly which files to request — zero probing overhead.

### 3.5 Adapter Interface Extension

```typescript
// New method on each adapter (or new module per adapter)
interface RemoteDataResolver {
  /**
   * Given a base URL, produce the list of metadata file URLs to fetch
   * during initialization (calibration, poses, annotations).
   */
  resolveMetadataUrls(baseUrl: string): string[]

  /**
   * Given base URL + frame index + resolved metadata, produce URLs
   * for per-frame data (LiDAR sweep, camera images).
   */
  resolveFrameUrls(baseUrl: string, frameIndex: number, meta: FrameManifest): FrameFileUrls

  /**
   * Given a base URL, discover available segments/logs.
   * For Waymo: list parquet files in vehicle_pose/.
   * For AV2: the base URL IS the log — no discovery needed.
   * Returns segment IDs.
   */
  discoverSegments?(baseUrl: string): Promise<string[]>
}

interface FrameFileUrls {
  lidar: { sensorId: number; url: string }[]
  cameras: { cameraId: number; url: string }[]
}
```

### 3.6 Frame Discovery (AV2-specific challenge)

AV2 has individual `.feather` files per LiDAR sweep, named by timestamp. The viewer needs to know all available timestamps before it can navigate frames.

**Options**:
1. **Manifest file**: Require a `manifest.json` at the base URL listing all timestamps. Simple but requires pre-generation.
2. **Pose file scan**: The `city_SE3_egovehicle.feather` contains all timestamps. Parse it to get the frame list. (Current local approach)
3. **URL parameter**: `&frames=150` tells the viewer how many frames exist, and a separate index file maps frame→timestamp.

**Decision**: Option 2 — parse `city_SE3_egovehicle.feather` for timestamps. This file is ~100KB, fetched at init anyway for poses, and contains the authoritative timestamp list. No extra files needed. Falls back to Option 1 (manifest.json) if pose file is missing.

For Waymo, the existing Parquet metadata (footer) already provides row counts. No change needed.

## 4. URL Parameter Schema

### 4.1 Complete Parameter Table

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| **Data Source** | | | |
| `dataset` | `waymo\|nuscenes\|argoverse2` | (required) | Dataset format |
| `data` | URL string | (required) | Base URL of data directory |
| `segment` | string | (first available) | Segment/log ID (for multi-segment Waymo) |
| **Playback** | | | |
| `frame` | number | 0 | Initial frame index (0-based) |
| `from` | number | — | Range loop start frame |
| `to` | number | — | Range loop end frame |
| `autoplay` | boolean | false | Auto-start playback on load |
| `loop` | boolean | false | Loop playback (works with range or full) |
| `speed` | number | 1 | Playback speed multiplier (0.5, 1, 2, 4) |
| **View** | | | |
| `colormap` | string | intensity | Colormap mode |
| `bg` | preset ID | dark | Background color preset |
| `pointShape` | `square\|circle` | circle | Point rendering shape |
| `pointSize` | number | 2 | Point size |
| `opacity` | number | 1.0 | Point cloud opacity |
| **Layers** | | | |
| `boxes` | `off\|box\|model` | box | 3D bounding box mode |
| `trails` | number | 0 | Trajectory trail length (0=off) |
| `cameras` | boolean | true | Show camera panel (in `full` layout) |
| **Camera Angle** | | | |
| `cam` | `x,y,z` | — | Camera position (overrides default) |
| `target` | `x,y,z` | — | Look-at target |
| `pov` | camera name | — | Start in POV mode (e.g., `front`) |
| **Layout & UI** | | | |
| `embed` | boolean | false | Embed mode (minimal chrome) |
| `layout` | `full\|3d\|camera` | full | Layout mode |
| `controls` | boolean | false | Show simplified control panel in embed |
| `timeline` | boolean | true | Show timeline in embed |

### 4.2 URL Examples

**Static frame for paper figure**:
```
?embed=true&dataset=argoverse2
&data=https://argoverse.s3.amazonaws.com/av2/sensor/val/01bb304d/
&frame=42&layout=3d&bg=black&pointShape=circle&boxes=box
&cam=15,10,20&target=0,0,1
```

**Looping range for project page**:
```
?embed=true&dataset=argoverse2
&data=https://argoverse.s3.amazonaws.com/av2/sensor/val/01bb304d/
&from=30&to=60&loop=true&autoplay=true&speed=0.5
&colormap=intensity&bg=charcoal
```

**Full viewer deep link (bookmarkable)**:
```
?dataset=waymo
&data=https://my-bucket.s3.amazonaws.com/waymo_data/
&segment=10023947602400723454_1120_000_1140_000
&frame=100&colormap=camera&boxes=model
```

**Camera-only embed (2D detection showcase)**:
```
?embed=true&dataset=argoverse2
&data=https://argoverse.s3.amazonaws.com/av2/sensor/val/01bb304d/
&layout=camera&autoplay=true&loop=true&boxes=box
```

### 4.3 URL ↔ State Synchronization

**On load (URL → State)**:
```
window.location.search → parseEmbedParams() → useSceneStore.setState(overrides)
```

**On interaction (State → URL)** (full mode only, not embed):
```
State change → debounced replaceState() → URL updates without reload
```

This enables the "share current view" feature: user adjusts settings, copies URL, sends to colleague.

## 5. Architecture

### 5.1 Component Hierarchy

```
App.tsx
├── [URL param parsing — before anything renders]
│   └── parseUrlParams() → EmbedConfig
│
├── embed=false (Full Mode — current app)
│   ├── Header (segment selector, status)
│   ├── SensorView
│   │   ├── LidarViewer (with control panel overlay)
│   │   └── CameraPanel
│   ├── Timeline
│   └── CreditBar
│
└── embed=true (Embed Mode — new)
    ├── EmbedViewer
    │   ├── layout=3d   → LidarViewer (full-bleed, no control panel)
    │   ├── layout=camera → CameraPanel (full-bleed)
    │   └── layout=full  → LidarViewer + CameraPanel
    ├── Timeline (if timeline=true, simplified)
    └── EmbedWatermark ("Open in Perception Studio" + branding)
```

### 5.2 Data Flow

```
URL params
    │
    ▼
parseUrlParams()
    │
    ├─► dataset → setManifest(waymoManifest | nuScenesManifest | argoverse2Manifest)
    │
    ├─► data URL → RemoteDataResolver.resolveMetadataUrls()
    │                    │
    │                    ▼
    │              fetch metadata files
    │                    │
    │                    ▼
    │              adapter.loadMetadata() → MetadataBundle
    │                    │
    │                    ▼
    │              store.initFromMetadata(bundle)
    │
    ├─► frame/from/to/autoplay → PlaybackController
    │
    ├─► colormap/bg/pointShape/etc → store display state
    │
    └─► cam/target/pov → initial camera setup
```

### 5.3 New Modules

```
src/
├── embed/
│   ├── parseUrlParams.ts      # URL → EmbedConfig
│   ├── serializeUrlParams.ts  # State → URL (for sharing)
│   ├── EmbedViewer.tsx        # Embed mode root component
│   ├── EmbedWatermark.tsx     # "Open in Perception Studio" overlay
│   ├── PlaybackController.ts  # Range loop / autoplay logic
│   └── types.ts               # EmbedConfig, PlaybackMode types
├── adapters/
│   ├── waymo/
│   │   └── remote.ts          # Waymo RemoteDataResolver
│   ├── nuscenes/
│   │   └── remote.ts          # nuScenes RemoteDataResolver
│   └── argoverse2/
│       └── remote.ts          # AV2 RemoteDataResolver
```

### 5.4 Remote Data Resolver (AV2 implementation sketch)

```typescript
// src/adapters/argoverse2/remote.ts

export class AV2RemoteResolver implements RemoteDataResolver {
  resolveMetadataUrls(baseUrl: string): string[] {
    return [
      `${baseUrl}/calibration/egovehicle_SE3_sensor.feather`,
      `${baseUrl}/calibration/intrinsics.feather`,
      `${baseUrl}/city_SE3_egovehicle.feather`,
      `${baseUrl}/annotations.feather`,
    ]
  }

  resolveFrameUrls(
    baseUrl: string,
    frameIndex: number,
    meta: AV2FrameManifest,
  ): FrameFileUrls {
    const ts = meta.timestamps[frameIndex]
    return {
      lidar: [{ sensorId: 1, url: `${baseUrl}/sensors/lidar/${ts}.feather` }],
      cameras: AV2_RING_CAMERA_NAMES.map((name, i) => ({
        cameraId: AV2_SENSOR_NAME_TO_ID[name],
        url: `${baseUrl}/sensors/cameras/${name}/${meta.cameraTimestamps[frameIndex][i]}.jpg`,
      })),
    }
  }
}
```

### 5.5 Existing Adapter Refactoring

The current AV2 adapter (`buildAV2LogDatabase`) accepts `Map<string, File>`. For URL mode, we need to support `Map<string, File | ArrayBuffer>` or, better, abstract the file access:

```typescript
// Option A: Fetch files → ArrayBuffer → existing parser
// Simplest, minimal refactoring. Just wrap fetched ArrayBuffers.
const response = await fetch(url)
const buffer = await response.arrayBuffer()
// readFeatherFile() already accepts ArrayBuffer (or File — check)
```

**Decision**: Check if `readFeatherFile()` can accept `ArrayBuffer` directly. If it only accepts `File`, add an `ArrayBuffer` overload. This is the minimal-touch approach — existing parsing logic stays untouched.

For camera JPEGs, the current adapter reads `File` objects → blob URL. For URL mode, we just use the URL directly as `<img src>` — even simpler.

## 6. Embed Mode UI Spec

### 6.1 Hidden Elements (embed=true)

- Header bar (logo, segment selector, status text, GitHub link)
- DropZone (no need — data comes from URL)
- Control panel overlay (colormap, sensors, display settings)
- ShortcutHints tooltip
- Credit bar
- MemoryOverlay
- Global keyboard shortcuts (Space, arrows, J/L, Shift+arrows)

### 6.2 Visible Elements

- **3D Viewport** (LidarViewer): fills container, OrbitControls active
- **Camera Panel** (if layout=full or layout=camera)
- **Timeline** (if timeline=true): simplified — play/pause button + scrubber + frame counter. No speed selector, no annotation lanes.
- **Watermark** (bottom-right corner):
  ```
  ┌──────────────────────────┐
  │  ↗ Open in Perception    │
  │    Studio                │
  └──────────────────────────┘
  ```
  Semi-transparent, frosted glass style. Click opens full app with same params (minus `embed=true`). `target="_blank"` for new tab.
- **Loading indicator**: Centered spinner/progress during initial data fetch.

### 6.3 Optional Control Panel (controls=true)

When `controls=true`, a minimal floating panel appears (top-left):
- Colormap selector (dropdown, not radio buttons)
- Background color swatches
- Point shape toggle
- Point size slider
- Box mode toggle

This lets viewers explore settings without giving full app chrome.

### 6.4 Responsive Sizing

Current app: `width: 100vw; height: 100vh` — fills the window.

Embed mode: `width: 100%; height: 100%` — fills the iframe container. Parent page controls the iframe dimensions.

Canvas and camera panel must respond to container resize (listen for `ResizeObserver` instead of relying on `100vh`).

## 7. Camera Angle Serialization

### 7.1 Approach

OrbitControls state = camera position (x,y,z) + look-at target (x,y,z).

URL encoding:
```
&cam=15.2,10.8,20.1&target=0,0,1.5
```

Values rounded to 1 decimal place (sufficient for visual reproduction, keeps URLs short).

### 7.2 Implementation

On load:
```typescript
if (params.cam && params.target) {
  // Set OrbitControls.object.position and OrbitControls.target
  // Call controls.update()
}
```

For "Share current view":
```typescript
const cam = controls.object.position
const target = controls.target
// → cam=15.2,10.8,20.1&target=0.0,0.0,1.5
```

### 7.3 POV Mode

`&pov=front` → triggers POV camera switch (existing `setActiveCam` action).

Maps POV names to camera IDs via `manifest.cameraPovLabels` (reverse lookup).

## 8. Playback Controller

### 8.1 Modes

```typescript
type PlaybackConfig =
  | { mode: 'static'; frame: number }              // URL: ?frame=42
  | { mode: 'range'; from: number; to: number;     // URL: ?from=30&to=60&loop=true
      loop: boolean; speed: number }
  | { mode: 'full'; autoplay: boolean;              // URL: ?autoplay=true&loop=true
      loop: boolean; speed: number }
```

### 8.2 Range Loop Implementation

Current playback logic in the store: `isPlaying` + `requestAnimationFrame` loop that calls `nextFrame()`.

For range loop, modify the frame advance logic:
```typescript
// In playback tick:
if (playbackConfig.mode === 'range') {
  const next = currentFrameIndex + 1
  if (next > playbackConfig.to) {
    if (playbackConfig.loop) {
      seekFrame(playbackConfig.from)
    } else {
      pause()
    }
  } else {
    nextFrame()
  }
}
```

This integrates with the existing `isPlaying` / `playbackSpeed` state. The PlaybackController just sets the boundaries.

## 9. iframe Communication (postMessage API)

### 9.1 Use Cases

- Parent page controls embed playback (seek to frame, play/pause)
- Embed notifies parent of state changes (frame changed, ready)
- Synchronized multi-embed (e.g., same scene from different datasets side by side)

### 9.2 Protocol

```typescript
// Parent → Embed
interface EmbedCommand {
  type: 'perception-studio'
  action: 'seekFrame' | 'play' | 'pause' | 'setColormap'
  payload: unknown
}

// Embed → Parent
interface EmbedEvent {
  type: 'perception-studio'
  event: 'ready' | 'frameChanged' | 'error'
  payload: unknown
}
```

### 9.3 Priority

**v1**: Not implemented. URL params are sufficient for most use cases. postMessage API is a v2 feature for advanced integrations (interactive paper figures that respond to scroll position, etc.).

## 10. Implementation Plan

### Phase 1: URL Param Parsing + Deep Linking (foundation)

1. Create `src/embed/parseUrlParams.ts` — parse `URLSearchParams` into typed config
2. Create `src/embed/serializeUrlParams.ts` — state → URL (debounced `replaceState`)
3. Wire into `App.tsx` — read params on mount, apply to store before first render
4. All display params work in full mode (deep linking / bookmarking)
5. **Test**: manually construct URLs, verify state initialization

### Phase 2: Remote Data Loading

1. Create `RemoteDataResolver` interface
2. Implement `AV2RemoteResolver` — resolve metadata + frame URLs from S3 base URL
3. Extend `readFeatherFile()` to accept `ArrayBuffer` (if needed)
4. Add `loadFromUrl(dataset, baseUrl)` action to store — fetch metadata, init, load first frame
5. Per-frame: fetch LiDAR feather + camera JPEGs on demand (reuse existing frame cache)
6. **Test**: load AV2 val set from `https://argoverse.s3.us-east-1.amazonaws.com/av2/sensor/val/{log_id}/`

### Phase 3: Embed Mode UI

1. Create `EmbedViewer.tsx` — layout modes (full/3d/camera)
2. Create `EmbedWatermark.tsx` — "Open in Perception Studio" link
3. Conditional rendering in `App.tsx` based on `embed` param
4. Disable global keyboard shortcuts in embed mode
5. Responsive sizing (100% instead of 100vh)
6. Simplified Timeline variant for embed
7. **Test**: embed in a test HTML page via `<iframe>`

### Phase 4: Playback Controller

1. Implement range loop logic in store playback tick
2. Wire `from`/`to`/`autoplay`/`loop` params
3. **Test**: range loop, full loop, static frame

### Phase 5: Camera Angle + Polish

1. Camera position/target serialization
2. POV mode from URL
3. Optional control panel (controls=true)
4. Loading states for embed
5. Error states (bad URL, CORS failure, 404)

### Phase 6: Waymo + nuScenes Remote Resolvers

1. Implement `WaymoRemoteResolver` — HTTP Range for Parquet
2. Implement `NuScenesRemoteResolver` — JSON metadata + binary files
3. Segment discovery for multi-segment Waymo URLs

## 11. Trade-off Analysis

### URL Params vs. Hash Fragment

**Chosen**: URL search params (`?key=value`)
**Rejected**: Hash fragment (`#key=value`)

URL params are standard, work with server-side rendering, and are familiar to users. Hash fragments are sometimes used for SPA routing but we don't need routing. Hash fragments also don't get sent to servers (irrelevant for static hosting, but good practice to use standard params).

### React Router vs. Manual URL Parsing

**Chosen**: Manual `URLSearchParams` parsing
**Rejected**: React Router

Adding React Router for what is essentially a single-route app with query params is unnecessary complexity. `URLSearchParams` is a native browser API, zero dependencies, and perfectly sufficient.

### Probing vs. Explicit Dataset Type

**Chosen**: Explicit `dataset=` parameter (required)
**Rejected**: Auto-probing base URL to detect dataset type

Probing requires multiple speculative HTTP requests (try `vehicle_pose/` → 404, try `sensors/` → 200 → must be AV2). This is slow (serial 404s), fragile (different 404 behavior across S3/GCS/custom servers), and unnecessary when the URL author knows their data format. Explicit type is one parameter, zero network overhead.

### Per-Frame Fetch vs. Prefetch All

**Chosen**: Hybrid — fetch metadata upfront, fetch frame data on demand with prefetch-ahead
**Rejected**: Fetch all data upfront (too slow for embed — user sees nothing for 30+ seconds)

Frame-on-demand with a small prefetch window (±3 frames) gives fast first paint while enabling smooth scrubbing. The existing YouTube-style buffer bar provides visual feedback.

### Separate Embed App vs. Single App with Mode Switch

**Chosen**: Single app with `embed` mode flag
**Rejected**: Separate build/entry point for embed

A separate app would duplicate component code and create maintenance burden. Mode switching via a flag is simpler — conditional rendering hides/shows chrome, but the core viewer components are shared.

## 12. Security Considerations

- **CORS**: Remote data URLs must serve `Access-Control-Allow-Origin: *` (or specific origin). Public S3 buckets (like Argoverse) do this by default. User-hosted data needs CORS configuration.
- **iframe sandbox**: Document recommended `sandbox` attributes for embed users
- **Data validation**: Never trust URL-provided data blindly. Validate dataset type is a known enum. Validate URL is HTTPS. Validate numeric params are in range.
- **XSS via URL params**: All URL param values are used as data (store state, fetch URLs), never injected as HTML. React's JSX escaping prevents XSS in rendered output.

## 13. CORS & S3 Configuration Guide (for embed authors)

For users hosting their own data on S3:

```json
// S3 CORS Configuration
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["Range"],
      "ExposeHeaders": ["Content-Length", "Content-Range"],
      "MaxAgeSeconds": 86400
    }
  ]
}
```

`Range` header is required for Waymo Parquet random access. `Content-Range` exposure is needed for `hyparquet` to determine file size.

## 14. Open Questions

1. **AV2 S3 CORS**: Does `s3://argoverse` serve CORS headers for browser fetch? Need to test. If not, we need a CORS proxy or CloudFront distribution.
2. **Frame count discovery for AV2**: If `city_SE3_egovehicle.feather` is missing (some AV2 logs?), do we need a fallback? Could scan `sensors/lidar/` directory listing, but S3 directory listing requires specific bucket policy.
3. **Embed code generator UI**: Should the full app have a "Get Embed Code" button that generates the `<iframe>` snippet? This is a nice-to-have for v1.
4. **Max URL length**: With all params, URLs can get long. Browser limit is ~2000 chars. Camera position + all display params should fit comfortably under 500 chars.
5. **Bandwidth for embedded**: A single AV2 frame is ~2MB LiDAR + ~7×200KB cameras ≈ 3.4MB. At 10fps that's 34MB/s — too fast for many connections. Embed default speed should be lower (0.5x? 1x with frame skip?) or autoplay should pause when tab is not visible.
