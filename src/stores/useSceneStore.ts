/**
 * Scene store — Zustand-based central state for EgoLens.
 *
 * Heavy work (Parquet I/O + BROTLI decompress + LiDAR conversion) runs in
 * a pool of N Data Workers — main thread stays free for 60fps rendering.
 *
 * Prefetch strategy: load ALL row groups in parallel via WorkerPool.
 * Each row group decompression yields ~51 frames at once — only 4 reads
 * to cache the entire 199-frame segment, now across N concurrent workers.
 *
 * Usage in React:
 *   const sensorClouds = useSceneStore(s => s.currentFrame?.sensorClouds)
 *   const { loadDataset, nextFrame } = useSceneStore(s => s.actions)
 */

import { create } from 'zustand'
import type { ParquetRow } from '../utils/merge'
import {
  openParquetFile,
  buildHeavyFileFrameIndex,
  readFrameData,
  type WaymoParquetFile,
  type FrameRowIndex,
} from '../utils/parquet'
import {
  convertAllSensors,
  type LidarCalibration,
  type PointCloud,
  type RangeImage,
} from '../utils/rangeImage'
import type { LidarBatchResult } from '../workers/types'
import type { CameraBatchResult } from '../workers/types'
import { WorkerPool } from '../workers/workerPool'
import type { SegmentMeta } from '../types/waymo'
import type { MetadataBundle } from '../types/dataset'
import { memLog } from '../utils/memoryLogger'
import { DataLoadError, type DataLoadErrorCode } from '../utils/errors'
import { getManifest, setManifest } from '../adapters/registry'
import { waymoManifest } from '../adapters/waymo/manifest'
import { loadWaymoMetadata } from '../adapters/waymo/metadata'
import { nuScenesManifest } from '../adapters/nuscenes/manifest'
import {
  buildNuScenesDatabase,
  loadNuScenesSceneMetadata,
  type NuScenesDatabase,
} from '../adapters/nuscenes/metadata'
import {
  discoverNuScenesScenes,
  type NuScenesDiscoveredScene,
} from '../adapters/nuscenes/remote'
import type { NuScenesFrameDescriptor, NuScenesRadarFileDescriptor } from '../workers/nuScenesLidarWorker'
import type {
  NuScenesCameraFrameDescriptor,
  NuScenesCameraImageDescriptor,
} from '../workers/nuScenesCameraWorker'
import { argoverse2Manifest } from '../adapters/argoverse2/manifest'
import {
  buildAV2LogDatabase,
  loadAV2LogMetadata,
  type AV2LogDatabase,
} from '../adapters/argoverse2/metadata'
import {
  fetchAV2Manifest,
  loadAV2FromUrl,
  isAV2ParentUrl,
  isAV2SensorRootUrl,
  discoverAV2Logs,
  discoverAV2AllSplits,
  resolveAV2DirectLogUrl,
  fetchAV2ThumbnailUrl,
  type AV2DiscoveredLog,
  type AV2Split,
} from '../adapters/argoverse2/remote'
import {
  fetchWaymoManifest as fetchWaymoRemoteManifest,
  discoverWaymoSegments,
  buildWaymoSegmentUrls,
} from '../adapters/waymo/remote'
import type { AV2LidarFrameDescriptor } from '../workers/av2LidarWorker'
import type {
  AV2CameraFrameDescriptor,
  AV2CameraImageDescriptor,
} from '../workers/av2CameraWorker'

import { multiplyRowMajor4x4 } from '../utils/matrix'
import { clearCameraRgbCache } from '../utils/cameraRgbSampler'
import { setUrlSource, clearUrlSource, getUrlSource, syncSegmentToUrl, syncWindowToUrl, getInitialSearch, parseViewParams, parseCamerasParam } from '../utils/urlState'
import { resolveWindowToFrames } from '../utils/playbackWindow'
import { getEmbedParams } from '../utils/embedParams'
import { trackSegmentSwitch, trackColormapChange, trackPovSwitch, trackOverlayToggle, trackDatasetLoad } from '../utils/analytics'
import { setKeypointsByFrameRef } from '../components/LidarViewer/KeypointSkeleton'
import { setCameraKeypointsByFrameRef } from '../components/CameraPanel/KeypointOverlay'
import { setCameraSegByFrameRef } from '../components/CameraPanel/CameraSegOverlay'
import { applyTheme, initialTheme, viewportBg, type ThemeName } from '../theme'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type BoxMode = 'off' | 'box' | 'model'
/**
 * Every colormap mode, in UI display order.
 *
 * ColormapMode is derived from this array rather than declared alongside it, so
 * a new mode cannot be added to one and forgotten in the other. Anything that
 * needs to enumerate modes — the picker in LidarViewer, exhaustiveness tests —
 * must iterate this instead of a hand-written list. A hand-written list is what
 * let camera mode go untested and blank the app.
 */
export const ALL_COLORMAP_MODES = [
  'distance', 'intensity', 'range', 'elongation', 'segment', 'panoptic', 'camera',
] as const

export type ColormapMode = typeof ALL_COLORMAP_MODES[number]

/** Short button labels for the colormap picker. Record<> forces a label per mode. */
export const COLORMAP_LABELS: Record<ColormapMode, string> = {
  distance: 'Dist',
  intensity: 'Int',
  range: 'Range',
  elongation: 'Elong',
  segment: 'Seg',
  panoptic: 'Pan',
  camera: 'Cam',
}
export type PointShape = 'square' | 'circle'

/** Background color presets for 3D viewport */
export const BG_PRESETS = [
  { id: 'auto',      label: 'Match theme', color: '' },  // theme-exempt: resolved from the theme, see resolveViewportBg
  { id: 'black',     label: 'Black',     color: '#000000' },
  { id: 'dark',      label: 'Dark',      color: '#0C0F1A' },  // theme-exempt: consumed by THREE.setClearColor, and a viewport preset is not a UI theme
  { id: 'charcoal',  label: 'Charcoal',  color: '#1a1a1a' },
  { id: 'midgray',   label: 'Mid Gray',  color: '#4d4d4d' },
  { id: 'navy',      label: 'Navy',      color: '#0d1117' },
  { id: 'white',     label: 'White',     color: '#ffffff' },
] as const
export type BgPresetId = typeof BG_PRESETS[number]['id']

/**
 * The viewport clear colour, as literal hex for THREE.
 *
 * `auto` is the default and follows the UI theme, which is the whole point of
 * the light theme: a figure destined for a white page should not have a black
 * rectangle in it. An explicit preset always wins — a light-theme user who
 * finds the point cloud hard to read on white can still choose a dark
 * viewport, and the ramps do read better there.
 */
export function resolveViewportBg(bgPreset: BgPresetId, theme: ThemeName): string {
  if (bgPreset === 'auto') return viewportBg(theme)
  return BG_PRESETS.find((p) => p.id === bgPreset)?.color || viewportBg(theme)
}
export interface FrameData {
  timestamp: bigint
  /** Per-sensor point clouds (keyed by laser_name: 1=TOP,2=FRONT,3=SIDE_LEFT,4=SIDE_RIGHT,5=REAR) */
  sensorClouds: Map<number, PointCloud>
  boxes: ParquetRow[]
  /** 2D camera bounding boxes for overlay on camera panels */
  cameraBoxes: ParquetRow[]
  cameraImages: Map<number, ArrayBuffer>
  vehiclePose: number[] | null
}

interface SceneActions {
  loadDataset: (sources: Map<string, File | string>) => Promise<void>
  loadFrame: (index: number) => Promise<void>
  nextFrame: () => Promise<void>
  prevFrame: () => Promise<void>
  seekFrame: (index: number) => Promise<void>
  play: () => void
  pause: () => void
  togglePlayback: () => void
  setPlaybackSpeed: (speed: number) => void
  /** Set the playback time window from raw t0/t1 timestamps (strings — int64). Null clears. */
  setPlaybackWindow: (t0: string | null, t1?: string) => void
  /** Set the window by frame indices (handle dragging). Derives t0/t1 from scene timestamps; no auto-seek. */
  setPlaybackWindowFrames: (f0: number, f1: number) => void
  toggleSensor: (laserName: number) => void
  cycleBoxMode: () => void
  setBoxMode: (mode: BoxMode) => void
  setTrailLength: (len: number) => void
  setPointOpacity: (opacity: number) => void
  setColormapMode: (mode: ColormapMode) => void
  setActiveCam: (cam: number | null) => void
  toggleActiveCam: (cam: number) => void
  setHoveredCam: (cam: number | null) => void
  /** Set hovered box for cross-modal 2D↔3D highlight (association-linked boxes only) */
  setHoveredBox: (id: string | null, source: 'laser' | 'camera' | null) => void
  setAvailableSegments: (segments: string[]) => void
  selectSegment: (segmentId: string) => Promise<void>
  loadFromFiles: (segments: Map<string, Map<string, File>>) => Promise<void>
  /** Load dataset from a remote URL. Optional initialScene to auto-select a specific scene. */
  loadFromUrl: (dataset: string, baseUrl: string, initialScene?: string) => Promise<void>
  toggleWorldMode: () => void
  toggleLidarOverlay: () => void
  toggleKeypoints3D: () => void
  toggleKeypoints2D: () => void
  toggleCameraSeg: () => void
  // Display settings
  setBgPreset: (id: BgPresetId) => void
  setTheme: (theme: ThemeName, accent?: string | null) => void
  setPointShape: (shape: PointShape) => void
  setPointSize: (size: number) => void
  setFollowCam: (follow: boolean) => void
  setPinCamera: (pin: boolean) => void
  reset: () => void
}

export type LoadStep = 'opening' | 'parsing' | 'workers' | 'first-frame'

export interface SceneState {
  // Loading
  status: LoadStatus
  error: string | null
  /** Classified cause of the last failure — drives telemetry, not the message */
  errorCode: DataLoadErrorCode | null
  availableComponents: string[]
  loadProgress: number
  /** Current loading step for UI feedback */
  loadStep: LoadStep

  // Frame navigation
  totalFrames: number
  currentFrameIndex: number
  isPlaying: boolean
  playbackSpeed: number
  /** Playback time window (t0/t1 params, setWindow command) — playback loops inside [f0, f1]; null = full range */
  playbackWindow: { f0: number; f1: number; t0: string; t1: string } | null

  // Current frame data
  currentFrame: FrameData | null

  // Calibrations (loaded once)
  lidarCalibrations: Map<number, LidarCalibration>
  cameraCalibrations: ParquetRow[]

  // Performance
  lastFrameLoadMs: number
  lastConvertMs: number

  // Prefetch progress (for YouTube-style buffer bar)
  /** Sorted array of cached frame indices */
  cachedFrames: number[]
  /** Sorted frame indices where camera images are cached */
  cameraCachedFrames: number[]
  /** Number of camera row groups loaded so far */
  cameraLoadedCount: number
  /** Total camera row groups to load */
  cameraTotalCount: number
  /** Which sensors are visible (1=TOP,2=FRONT,3=SIDE_LEFT,4=SIDE_RIGHT,5=REAR) */
  visibleSensors: Set<number>
  /** Bounding box / model display mode */
  boxMode: BoxMode
  /** Number of past frames to show in trajectory trail (0 = off) */
  trailLength: number
  /** Point cloud opacity (0..1) */
  pointOpacity: number
  /** Point cloud colormap mode */
  colormapMode: ColormapMode
  /** Whether lidar_box data is available (false for test set) */
  hasBoxData: boolean
  /** Active camera for POV mode (null = orbital view) */
  activeCam: number | null
  /** Camera being hovered in CameraPanel (for frustum highlight) */
  hoveredCam: number | null
  /** Currently hovered box ID (laser_object_id or camera_object_id) */
  hoveredBoxId: string | null
  /** Camera box IDs to highlight (derived from hovering a 3D box) */
  highlightedCameraBoxIds: Set<string>
  /** Laser box ID to highlight (derived from hovering a 2D box) */
  highlightedLaserBoxId: string | null
  /** LiDAR point projection overlay on camera panels */
  showLidarOverlay: boolean
  /** World coordinate mode (true = world frame, false = vehicle frame) */
  worldMode: boolean

  // -- Segmentation & Keypoint flags (Phase A) --------------------------------

  /** Whether lidar_segmentation data is available for this segment */
  hasSegmentation: boolean
  /** Whether keypoint (lidar_hkp / camera_hkp) data is available */
  hasKeypoints: boolean
  /** Whether camera_segmentation data is available */
  hasCameraSegmentation: boolean
  /** Show 3D lidar keypoint skeletons */
  showKeypoints3D: boolean
  /** Show 2D camera keypoint overlays */
  showKeypoints2D: boolean
  /** Show camera segmentation overlay */
  showCameraSeg: boolean
  /** Frame indices with lidar segmentation labels (for Timeline markers) */
  segLabelFrames: Set<number>
  /** Frame indices with 3D lidar keypoint data (for Timeline markers) */
  keypointFrames: Set<number>
  /** Frame indices with 2D camera keypoint data (for Timeline markers) */
  cameraKeypointFrames: Set<number>
  /** Frame indices with camera segmentation data (for Timeline markers) */
  cameraSegFrames: Set<number>

  // -- Display settings (rendering style, not perception data) ----------------
  /** Background color preset for 3D viewport */
  bgPreset: BgPresetId
  /** UI theme. Chrome follows via CSS custom properties; scene colours are
   *  resolved from this at render time, because THREE cannot read var(). */
  theme: ThemeName
  /** Point rendering shape: square (GL default) or circle (discard outside radius) */
  pointShape: PointShape
  /** Point world-space size (default 0.08) */
  pointSize: number
  /** Whether camera follows ego vehicle in world mode */
  followCam: boolean
  /** Pin camera position across segment switches */
  pinCamera: boolean
  /** Saved camera pose for pin restore after remount */
  pinnedCameraPose: { position: [number, number, number]; target: [number, number, number] } | null

  /** All discovered segment IDs */
  availableSegments: string[]
  /** Segment metadata from stats component (segmentId → SegmentMeta) */
  segmentMetas: Map<string, SegmentMeta>
  /** Currently loaded segment ID */
  currentSegment: string | null
  // Actions
  actions: SceneActions
}

// ---------------------------------------------------------------------------
// Internal state (not exposed to React — no re-renders on mutation)
// ---------------------------------------------------------------------------

/** Number of parallel workers for row group decompression */
const WORKER_CONCURRENCY = 3

const internal = {
  parquetFiles: new Map<string, WaymoParquetFile>(),
  timestamps: [] as bigint[],
  /** Reverse lookup: timestamp → frame index */
  timestampToFrame: new Map<bigint, number>(),
  lidarBoxByFrame: new Map<unknown, ParquetRow[]>(),
  cameraBoxByFrame: new Map<unknown, ParquetRow[]>(),
  vehiclePoseByFrame: new Map<unknown, ParquetRow[]>(),
  /** No eviction needed — row-group loading caches all ~199 frames, which is the goal. */
  frameCache: new Map<number, FrameData>(),
  /** Separate camera image cache (frameIndex → cameraName → JPEG ArrayBuffer).
   *  Stored independently so camera data is never lost due to lidar timing. */
  cameraImageCache: new Map<number, Map<number, ArrayBuffer>>(),
  playIntervalId: null as ReturnType<typeof setInterval> | null,
  /** Camera refresh interval — polls for late-arriving camera data during playback */
  cameraRefreshId: null as ReturnType<typeof setInterval> | null,
  /** Worker pool for parallel batch loading (lidar) */
  workerPool: null as WorkerPool<Record<string, unknown>, LidarBatchResult> | null,
  numBatches: 0,
  /** Track which lidar batches have been loaded or are in-flight */
  loadedRowGroups: new Set<number>(),
  /** Camera worker pool */
  cameraPool: null as WorkerPool<Record<string, unknown>, CameraBatchResult> | null,
  cameraNumBatches: 0,
  /** Track which camera batches have been loaded or are in-flight */
  cameraLoadedRowGroups: new Set<number>(),
  cameraPrefetchStarted: false,
  /** Prevent duplicate prefetchAllRowGroups calls (React StrictMode) */
  prefetchStarted: false,
  /**
   * Deferred camera-pool init. Camera JPEGs are the biggest allocation in a
   * scene, so when nothing needs the images (strip hidden, no camera
   * colormap, no POV) the pool is never started — the init closure is kept
   * here and run later if something asks for images.
   */
  cameraPoolInit: null as (() => Promise<void>) | null,
  /** Bumped on every scene reset — a late lazy start must not install a pool over a newer scene */
  sceneToken: 0,
  /** Colormap waiting for the first camera images to arrive (see setColormapMode) */
  pendingCameraColormap: false,
  /** Last per-frame conversion time (for performance tracking) */
  lastConvertMs: 0,
  /** Frame index for per-frame fallback (test env / no Worker) */
  lidarFrameIndex: null as FrameRowIndex | null,
  /** Object trajectory index: objectId → sorted array of {frameIndex, x, y, z, type} */
  objectTrajectories: new Map<string, { frameIndex: number; x: number; y: number; z: number; type: number }[]>(),
  /** Association lookup: camera_object_id → laser_object_id */
  assocCamToLaser: new Map<string, string>(),
  /** Association lookup: laser_object_id → Set<camera_object_id> */
  assocLaserToCams: new Map<string, Set<string>>(),
  /** Vehicle pose per frame index (for world-mode trajectory trails) — relative to frame 0 */
  poseByFrameIndex: new Map<number, number[]>(),
  /** Inverse of frame 0's world_from_vehicle (used to make frame 0 = origin) */
  worldOriginInverse: null as number[] | null,
  /** File-based segments from drag & drop (segmentId → component → File) */
  filesBySegment: null as Map<string, Map<string, File>> | null,
  /** Blob URLs created for workers — revoke on reset to free memory */
  blobUrls: [] as string[],
  // -- Segmentation & keypoint internal caches --------------------------------
  /** 3D keypoint rows grouped by timestamp */
  keypointsByFrame: new Map<bigint, ParquetRow[]>(),
  /** 2D camera keypoint rows grouped by timestamp */
  cameraKeypointsByFrame: new Map<bigint, ParquetRow[]>(),
  /** Camera segmentation: timestamp → cameraName → { panopticLabel, divisor } */
  cameraSeg: new Map<bigint, Map<number, { panopticLabel: ArrayBuffer; divisor: number }>>(),
  // -- nuScenes-specific state (persists across scene switches, like filesBySegment) --
  /** Active dataset type */
  datasetId: 'waymo' as string,
  /** Parsed nuScenes database (built once from JSON, reused across scene switches) */
  nuScenesDb: null as NuScenesDatabase | null,
  /** nuScenes sample data files keyed by relative path (File for local, string URL for remote) */
  nuScenesSampleFiles: null as Map<string, File | string> | null,
  /** Discovered per-scene shards from an index.json root (sharded hosting mode) */
  nuScenesDiscoveredScenes: null as NuScenesDiscoveredScene[] | null,
  /**
   * Seek requested before its frame was cached (cold load). loadFrame drops
   * cache misses so it never fights the prefetch queue, which would silently
   * strand a deep link — `?frame=` or a t0/t1 range — at frame 0 while the
   * user waits. Applied by syncCachedFrames once the frame arrives.
   */
  pendingSeekFrame: null as number | null,
  // -- Argoverse 2-specific state --
  /** Parsed AV2 log database */
  av2Db: null as AV2LogDatabase | null,
  /** AV2 sensor data files keyed by relative path (File for local, string URL for remote) */
  av2SampleFiles: null as Map<string, File | string> | null,
  /** Discovered AV2 logs from parent URL (multi-log mode) */
  av2DiscoveredLogs: null as AV2DiscoveredLog[] | null,
  // -- Waymo-specific remote state --
  /** Base URL for remote Waymo loading (e.g. https://bucket.s3.../waymo_data/) */
  waymoBaseUrl: null as string | null,
}

function resetInternal() {
  internal.parquetFiles.clear()
  internal.timestamps = []
  internal.pendingSeekFrame = null
  internal.cameraPoolInit = null
  internal.pendingCameraColormap = false
  internal.sceneToken++
  internal.timestampToFrame.clear()
  internal.lidarBoxByFrame.clear()
  internal.cameraBoxByFrame.clear()
  internal.vehiclePoseByFrame.clear()
  internal.frameCache.clear()
  internal.cameraImageCache.clear()
  // Clear decoded camera RGB cache
  clearCameraRgbCache()
  internal.objectTrajectories.clear()
  internal.assocCamToLaser.clear()
  internal.assocLaserToCams.clear()
  internal.poseByFrameIndex.clear()
  internal.worldOriginInverse = null
  internal.loadedRowGroups.clear()
  internal.prefetchStarted = false
  if (internal.playIntervalId !== null) {
    clearInterval(internal.playIntervalId)
    internal.playIntervalId = null
  }
  if (internal.cameraRefreshId !== null) {
    clearInterval(internal.cameraRefreshId)
    internal.cameraRefreshId = null
  }
  if (internal.workerPool) {
    internal.workerPool.terminate()
    internal.workerPool = null
  }
  internal.numBatches = 0
  if (internal.cameraPool) {
    internal.cameraPool.terminate()
    internal.cameraPool = null
  }
  internal.cameraNumBatches = 0
  internal.cameraLoadedRowGroups.clear()
  internal.cameraPrefetchStarted = false
  // Revoke blob URLs to free memory
  for (const url of internal.blobUrls) {
    URL.revokeObjectURL(url)
  }
  internal.blobUrls = []
  // Segmentation & keypoint caches
  internal.keypointsByFrame.clear()
  setKeypointsByFrameRef(internal.keypointsByFrame)
  internal.cameraKeypointsByFrame.clear()
  setCameraKeypointsByFrameRef(internal.cameraKeypointsByFrame)
  internal.cameraSeg.clear()
  setCameraSegByFrameRef(internal.cameraSeg)
}

// ---------------------------------------------------------------------------
// Worker pool communication
// ---------------------------------------------------------------------------

function requestRowGroup(
  rowGroupIndex: number,
  opts?: { priority?: boolean },
): Promise<LidarBatchResult> {
  if (!internal.workerPool) {
    return Promise.reject(new Error('Worker pool not initialized'))
  }
  return internal.workerPool.requestRowGroup(rowGroupIndex, opts)
}

/** Cache all frames from a row group result into internal.frameCache */
function cacheRowGroupFrames(
  result: LidarBatchResult,
  set: (partial: Partial<SceneState>) => void,
) {
  for (const frame of result.frames) {
    const timestamp = BigInt(frame.timestamp)
    const frameIndex = internal.timestampToFrame.get(timestamp)
    if (frameIndex === undefined) continue
    if (internal.frameCache.has(frameIndex)) continue

    const boxes = internal.lidarBoxByFrame.get(timestamp) ?? []
    const cameraBoxes = internal.cameraBoxByFrame.get(timestamp) ?? []
    const poseRows = internal.vehiclePoseByFrame.get(timestamp)
    const poseCol = getManifest().columnMap.vehiclePose
    // For Waymo: read pose from Parquet column. For nuScenes (empty poseCol): null.
    const rawPose = poseCol ? (poseRows?.[0]?.[poseCol] as number[]) ?? null : null
    // Waymo: multiply by worldOriginInverse. nuScenes: fall back to pre-computed poseByFrameIndex.
    const vehiclePose = rawPose && internal.worldOriginInverse
      ? multiplyRowMajor4x4(internal.worldOriginInverse, rawPose)
      : rawPose ?? (internal.poseByFrameIndex.get(frameIndex) ?? null)

    const sensorClouds = new Map<number, PointCloud>()
    if (frame.sensorClouds) {
      for (const sc of frame.sensorClouds) {
        sensorClouds.set(sc.laserName, {
          positions: sc.positions,
          pointCount: sc.pointCount,
          segLabels: sc.segLabels,
          panopticLabels: sc.panopticLabels,
          cameraProjection: sc.cameraProjection,
        })
      }
    }

    const frameData: FrameData = {
      timestamp,
      sensorClouds,
      boxes,
      cameraBoxes,
      cameraImages: new Map(),
      vehiclePose,
    }

    internal.frameCache.set(frameIndex, frameData)

    // Track last conversion time from worker result
    if (frame.convertMs > 0) {
      internal.lastConvertMs = frame.convertMs
    }
  }

  // Measure how much memory the cached point clouds occupy
  let rgBytes = 0
  for (const frame of result.frames) {
    if (frame.sensorClouds) {
      for (const sc of frame.sensorClouds) {
        rgBytes += sc.positions.buffer.byteLength
      }
    }
  }
  memLog.snap(`cache:lidar-rg${result.batchIndex}`, {
    dataSize: rgBytes,
    note: `${result.frames.length} frames, ${internal.frameCache.size} total cached`,
  })

  syncCachedFrames(set)
}

/** Cache all camera images from a camera row group result (separate cache) */
function cacheCameraRowGroupFrames(
  result: CameraBatchResult,
) {
  for (const frame of result.frames) {
    const timestamp = BigInt(frame.timestamp)
    const frameIndex = internal.timestampToFrame.get(timestamp)
    if (frameIndex === undefined) continue

    let camMap = internal.cameraImageCache.get(frameIndex)
    if (!camMap) {
      camMap = new Map()
      internal.cameraImageCache.set(frameIndex, camMap)
    }
    for (const img of frame.images) {
      camMap.set(img.cameraName, img.jpeg)
    }
  }

  // Measure cached JPEG sizes
  let jpegBytes = 0
  for (const frame of result.frames) {
    for (const img of frame.images) {
      jpegBytes += img.jpeg.byteLength
    }
  }
  memLog.snap(`cache:camera-rg${result.batchIndex}`, {
    dataSize: jpegBytes,
    note: `${result.frames.length} frames, ${internal.cameraImageCache.size} total cached`,
  })
}

/** Update the cachedFrames state for the buffer bar UI */
function syncCachedFrames(set: (partial: Partial<SceneState>) => void) {
  const indices = [...internal.frameCache.keys()].sort((a, b) => a - b)
  set({ cachedFrames: indices })

  // A deep-linked seek that missed the cache lands here, the moment its
  // frame arrives — otherwise a cold load strands the viewer at frame 0.
  const pending = internal.pendingSeekFrame
  if (pending !== null && internal.frameCache.has(pending)) {
    internal.pendingSeekFrame = null
    void useSceneStore.getState().actions.loadFrame(pending)
  }
}

/** Update the cameraCachedFrames state for the camera buffer lane UI */
function syncCameraCachedFrames(set: (partial: Partial<SceneState>) => void) {
  const indices = [...internal.cameraImageCache.keys()].sort((a, b) => a - b)
  set({ cameraCachedFrames: indices })

  // A camera colormap held back while images loaded takes effect now
  if (internal.pendingCameraColormap && indices.length > 0) {
    internal.pendingCameraColormap = false
    set({ colormapMode: 'camera' })
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------


/**
 * Put the store into its failed state.
 *
 * Every load path funnels through here so a failure always carries a classified
 * code alongside the human message. Telemetry reads the code; adding a new load
 * path cannot silently skip it the way seven hand-written catch blocks could.
 */
function failLoad(
  set: (partial: Partial<SceneState>) => void,
  error: unknown,
  context: string,
): void {
  console.error(`[${context}] Error:`, error)
  set({
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
    errorCode: error instanceof DataLoadError ? error.code : 'UNKNOWN',
  })
}

/**
 * Load a scanned local folder, dispatching on the sentinel key the scanner
 * put in the segment map.
 *
 * Split out of the `loadFromFiles` action so the action can funnel every
 * failure through `failLoad` with one catch rather than one per branch.
 */
async function loadLocalSegments(
  segments: Map<string, Map<string, File>>,
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
): Promise<void> {
  // Check for nuScenes sentinel key (produced by folder scanner)
  if (segments.has('__nuscenes__')) {
    const allFiles = segments.get('__nuscenes__')!

    // Separate JSON metadata from sample data files
    const jsonFiles = new Map<string, File>()
    const sampleFiles = new Map<string, File>()
    for (const [path, file] of allFiles) {
      if (path.endsWith('.json')) {
        jsonFiles.set(path, file)
      } else {
        sampleFiles.set(path, file)
      }
    }

    // Full-split metadata dies on V8's ~512MB string limit before
    // JSON.parse even starts — fail with directions, not a RangeError.
    const oversized = [...jsonFiles.entries()].find(([, f]) => f.size > NUSCENES_TABLE_SIZE_LIMIT)
    if (oversized) {
      failLoad(set, new Error(
        `${oversized[0]} is ${(oversized[1].size / 1e9).toFixed(1)}GB — full-split nuScenes metadata `
        + 'is too large for a browser to parse. Shard it per scene first with '
        + 'scripts/shard_nuscenes.py (see docs/NUSCENES_FULL_HOSTING.md), then serve '
        + 'the output folder and load it by URL.',
      ), 'loadFromFiles:nuScenesOversize')
      return
    }

    // Initialize nuScenes state (local files → single-directory mode)
    internal.datasetId = 'nuscenes'
    internal.nuScenesSampleFiles = sampleFiles
    internal.nuScenesDiscoveredScenes = null
    setManifest(nuScenesManifest)

    // Build one-time database from JSON tables
    set({ status: 'loading', loadStep: 'parsing' as LoadStep, loadProgress: 0 })
    internal.nuScenesDb = await buildNuScenesDatabase(jsonFiles)

    // Discover scenes as available "segments"
    const sceneNames = internal.nuScenesDb.scenes.map(s => s.name).sort()
    set({ availableSegments: sceneNames, loadProgress: 0.1 })

    // Auto-select first scene
    if (sceneNames.length > 0) {
      await get().actions.selectSegment(sceneNames[0])
    }
    return
  }

  // Check for Argoverse 2 sentinel key (produced by folder scanner)
  if (segments.has('__argoverse2__')) {
    const allFiles = segments.get('__argoverse2__')!

    // Extract log ID from sentinel file
    const logIdFile = allFiles.get('__logId__')
    const logId = logIdFile?.name || 'av2_log'

    // Remove sentinel entries
    const sampleFiles = new Map<string, File>()
    for (const [path, file] of allFiles) {
      if (path !== '__logId__') {
        sampleFiles.set(path, file)
      }
    }

    // Initialize AV2 state
    internal.datasetId = 'argoverse2'
    internal.av2SampleFiles = sampleFiles
    setManifest(argoverse2Manifest)

    // Build log database from Feather files
    set({ status: 'loading', loadStep: 'parsing' as LoadStep, loadProgress: 0 })
    internal.av2Db = await buildAV2LogDatabase(sampleFiles, logId)

    // AV2 has a single "scene" per log — use log ID as segment name
    set({ availableSegments: [logId], loadProgress: 0.1 })

    // Auto-select the single log
    await get().actions.selectSegment(logId)
    return
  }

  // Waymo path — store file references for later use by selectSegment
  internal.datasetId = 'waymo'
  internal.nuScenesDb = null
  internal.nuScenesSampleFiles = null
  internal.nuScenesDiscoveredScenes = null
  internal.av2Db = null
  internal.av2SampleFiles = null
  internal.av2DiscoveredLogs = null
  internal.waymoBaseUrl = null
  setManifest(waymoManifest)
  internal.filesBySegment = segments
  const segmentIds = [...segments.keys()].sort()
  set({ availableSegments: segmentIds })

  // Auto-select if only one segment, otherwise select first
  if (segmentIds.length > 0) {
    await get().actions.selectSegment(segmentIds[0])
  }
}

export const useSceneStore = create<SceneState>((set, get) => ({
  status: 'idle',
  error: null,
  errorCode: null,
  availableComponents: [],
  loadProgress: 0,
  loadStep: 'opening' as LoadStep,
  totalFrames: 0,
  currentFrameIndex: 0,
  isPlaying: false,
  playbackSpeed: 1,
  playbackWindow: null,
  currentFrame: null,
  lidarCalibrations: new Map(),
  cameraCalibrations: [],
  lastFrameLoadMs: 0,
  lastConvertMs: 0,
  cachedFrames: [],
  cameraCachedFrames: [],
  cameraLoadedCount: 0,
  cameraTotalCount: 0,
  visibleSensors: new Set(getManifest().lidarSensors.map(s => s.id)),
  boxMode: 'box' as BoxMode,
  trailLength: 10,
  pointOpacity: 0.85,
  colormapMode: 'intensity' as ColormapMode,
  hasBoxData: false,
  activeCam: null,
  hoveredCam: null,
  hoveredBoxId: null,
  highlightedCameraBoxIds: new Set<string>(),
  highlightedLaserBoxId: null,
  showLidarOverlay: false,
  worldMode: false,
  // Segmentation & keypoint state
  hasSegmentation: false,
  hasKeypoints: false,
  hasCameraSegmentation: false,
  showKeypoints3D: false,
  showKeypoints2D: false,
  showCameraSeg: false,
  segLabelFrames: new Set<number>(),
  keypointFrames: new Set<number>(),
  cameraKeypointFrames: new Set<number>(),
  cameraSegFrames: new Set<number>(),
  // Display settings
  bgPreset: 'auto' as BgPresetId,
  theme: initialTheme(),
  pointShape: 'circle' as PointShape,
  pointSize: 0.08,
  followCam: false,
  pinCamera: false,
  pinnedCameraPose: null,
  availableSegments: [],
  segmentMetas: new Map(),
  currentSegment: null,

  actions: {
    loadDataset: async (sources) => {
      resetInternal()
      set({
        status: 'loading',
        availableComponents: [...sources.keys()],
        error: null,
        loadProgress: 0,
        loadStep: 'opening' as LoadStep,
        cachedFrames: [],
        cameraCachedFrames: [],
      })

      try {
        const totalSteps = sources.size + 2
        let completed = 0

        memLog.snap('pipeline:start', { note: `${sources.size} components` })

        // 1. Open all Parquet files (footer only — lightweight, main thread OK)
        for (const [component, source] of sources) {
          try {
            const pf = await openParquetFile(component, source)
            internal.parquetFiles.set(component, pf)
          } catch {
            // Optional components (e.g. segmentation) may not exist — skip silently
            console.warn(`[store] Could not open ${component}, skipping`)
          }
          completed++
          set({ loadProgress: completed / totalSteps })
        }
        memLog.snap('phase1:footers-opened', { note: `${sources.size} parquet footers` })

        // 2. Load startup data (small files: poses, calibrations, boxes)
        set({ loadStep: 'parsing' as LoadStep })
        await loadStartupData(set, get)
        completed++
        set({ loadProgress: completed / totalSteps })
        memLog.snap('phase2:startup-data-loaded', { note: 'poses, calibrations, boxes, associations' })

        // 3. Init LiDAR + Camera workers in parallel
        set({ loadStep: 'workers' as LoadStep })
        await Promise.all([
          initDataWorker(sources, get, set),
          initCameraWorker(sources),
        ])
        completed++
        set({ loadProgress: completed / totalSteps })
        memLog.snap('phase3:workers-initialized', {
          note: `${WORKER_CONCURRENCY} lidar + 2 camera workers`,
        })

        // 4. Load first frames, display, and prefetch remaining
        await runPostWorkerPipeline(set, get, 'waymo', async () => {
          // Main-thread fallback for test env / no Worker
          const lidarPf = internal.parquetFiles.get('lidar')
          if (lidarPf) {
            internal.lidarFrameIndex = await buildHeavyFileFrameIndex(lidarPf)
            await loadFrameMainThread(0, set, get)
          }
        })
      } catch (e) {
        failLoad(set, e, 'loadDataset')
      }
    },

    loadFrame: async (frameIndex) => {
      if (frameIndex < 0 || frameIndex >= internal.timestamps.length) return

      // Cache hit — instant (the common case after prefetch completes)
      const cached = internal.frameCache.get(frameIndex)
      if (cached) {
        // An explicit landing supersedes any queued deep-link seek
        internal.pendingSeekFrame = null
        // Merge camera images from separate cache (always create new Map for re-render)
        const camData = internal.cameraImageCache.get(frameIndex)
        const cameraImages = camData ? new Map(camData) : new Map<number, ArrayBuffer>()

        set({
          currentFrameIndex: frameIndex,
          currentFrame: {
            ...cached,
            cameraImages,
          },
          lastFrameLoadMs: 0,
          lastConvertMs: cached.sensorClouds.size > 0 ? get().lastConvertMs : 0,
        })
        return
      }

      // Cache miss — frame not yet prefetched, so don't fight the prefetch
      // queue; remember it and let syncCachedFrames land it on arrival.
      internal.pendingSeekFrame = frameIndex
    },

    nextFrame: () => get().actions.loadFrame(get().currentFrameIndex + 1),
    prevFrame: () => get().actions.loadFrame(get().currentFrameIndex - 1),
    seekFrame: (index) => get().actions.loadFrame(index),

    play: () => {
      if (get().isPlaying) return
      set({ isPlaying: true })
      const fps = getManifest().frameRate // Waymo=10Hz, nuScenes=2Hz
      const intervalMs = (1000 / fps) / get().playbackSpeed
      internal.playIntervalId = setInterval(async () => {
        const next = get().currentFrameIndex + 1
        // Time window: loop inside [f0, f1] instead of running to the end
        const win = get().playbackWindow
        if (win && next > win.f1) {
          await get().actions.loadFrame(win.f0)
          return
        }
        if (next >= get().totalFrames) {
          get().actions.pause()
          return
        }
        await get().actions.loadFrame(next)
      }, intervalMs)

      // Secondary interval: refresh current frame's camera images when they arrive late.
      // Camera workers may finish after LiDAR, so the displayed frame can have stale
      // (empty) camera data. This polls at ~4Hz and patches currentFrame if new images
      // are available in cameraImageCache.
      internal.cameraRefreshId = setInterval(() => {
        const fi = get().currentFrameIndex
        const currentFrame = get().currentFrame
        if (!currentFrame) return
        const camData = internal.cameraImageCache.get(fi)
        if (!camData || camData.size === 0) return
        // Skip if camera count hasn't changed (already up-to-date)
        if (currentFrame.cameraImages.size === camData.size) return
        set({
          currentFrame: {
            ...currentFrame,
            cameraImages: new Map(camData),
          },
        })
      }, 250)
    },

    pause: () => {
      if (!get().isPlaying) return
      if (internal.playIntervalId !== null) {
        clearInterval(internal.playIntervalId)
        internal.playIntervalId = null
      }
      if (internal.cameraRefreshId !== null) {
        clearInterval(internal.cameraRefreshId)
        internal.cameraRefreshId = null
      }
      set({ isPlaying: false })
    },

    togglePlayback: () => {
      if (get().isPlaying) {
        get().actions.pause()
      } else {
        // If at the end, rewind to start (window start when one is active)
        if (get().currentFrameIndex >= get().totalFrames - 1) {
          get().actions.loadFrame(get().playbackWindow?.f0 ?? 0).then(() => get().actions.play())
        } else {
          get().actions.play()
        }
      }
    },

    setPlaybackSpeed: (speed) => {
      const wasPlaying = get().isPlaying
      if (wasPlaying) get().actions.pause()
      set({ playbackSpeed: speed })
      if (wasPlaying) get().actions.play()
    },

    setPlaybackWindow: (t0, t1) => {
      if (t0 == null || t1 == null) {
        set({ playbackWindow: null })
        syncWindowToUrl(null)
        return
      }
      const resolved = resolveWindowToFrames(internal.timestamps, t0, t1)
      if (!resolved) {
        console.warn(`[playbackWindow] t0/t1 (${t0}..${t1}) don't resolve against this scene — window ignored`)
        set({ playbackWindow: null })
        syncWindowToUrl(null)
        return
      }
      const win = { ...resolved, t0, t1 }
      set({ playbackWindow: win })
      // syncSegmentToUrl rewrites the query on load and on every scene
      // switch, dropping t0/t1 — re-assert them whenever the range is set,
      // so a shared link survives its own load.
      syncWindowToUrl(win)
      void get().actions.seekFrame(resolved.f0)
    },

    setPlaybackWindowFrames: (f0, f1) => {
      const ts = internal.timestamps
      if (ts.length === 0) return
      const lo = Math.max(0, Math.min(Math.floor(f0), ts.length - 1))
      const hi = Math.max(lo, Math.min(Math.floor(f1), ts.length - 1))
      set({ playbackWindow: { f0: lo, f1: hi, t0: String(ts[lo]), t1: String(ts[hi]) } })
    },

    toggleSensor: (laserName: number) => {
      const prev = get().visibleSensors
      const next = new Set(prev)
      if (next.has(laserName)) next.delete(laserName)
      else next.add(laserName)
      set({ visibleSensors: next })
    },

    cycleBoxMode: () => {
      const order: BoxMode[] = ['off', 'box', 'model']
      const cur = order.indexOf(get().boxMode)
      set({ boxMode: order[(cur + 1) % order.length] })
    },

    setBoxMode: (mode: BoxMode) => {
      set({ boxMode: mode })
      trackOverlayToggle('box_mode', mode !== 'off')
    },

    setTrailLength: (len: number) => {
      set({ trailLength: Math.max(0, Math.min(50, len)) })
    },

    setPointOpacity: (opacity: number) => {
      set({ pointOpacity: Math.max(0.1, Math.min(1, opacity)) })
    },
    setColormapMode: (mode: ColormapMode) => {
      trackColormapChange(mode)
      // The camera colormap samples camera textures. If images were skipped
      // (cameras=false), start them now and stay on the current colormap
      // until the first frames land — switching early would sample nothing
      // and freeze the cloud on stale or empty colour.
      if (mode === 'camera' && internal.cameraImageCache.size === 0 && internal.cameraPoolInit) {
        internal.pendingCameraColormap = true
        console.log('[camera] camera colormap requested — loading images first')
        void ensureCameraPool(set)
        return
      }
      set({ colormapMode: mode })
    },
    setActiveCam: (cam: number | null) => {
      if (cam !== null) void ensureCameraPool(set)
      set({ activeCam: cam })
      trackPovSwitch(cam !== null ? `camera_${cam}` : 'orbit')
    },
    toggleActiveCam: (cam: number) => {
      const next = get().activeCam === cam ? null : cam
      set({ activeCam: next })
      trackPovSwitch(next !== null ? `camera_${cam}` : 'orbit')
    },
    setHoveredCam: (cam: number | null) => {
      set({ hoveredCam: cam })
    },

    setHoveredBox: (id: string | null, source: 'laser' | 'camera' | null) => {
      if (!id || !source) {
        // Clear all highlights
        set({
          hoveredBoxId: null,
          highlightedCameraBoxIds: new Set<string>(),
          highlightedLaserBoxId: null,
        })
        return
      }

      if (source === 'laser') {
        // Hovering a 3D box → find linked 2D camera box IDs
        const camIds = internal.assocLaserToCams.get(id)
        set({
          hoveredBoxId: id,
          highlightedCameraBoxIds: camIds ? new Set(camIds) : new Set<string>(),
          highlightedLaserBoxId: null,
        })
      } else {
        // Hovering a 2D camera box → find linked 3D laser box ID
        const laserId = internal.assocCamToLaser.get(id)
        // Also find all sibling camera boxes linked to the same laser box
        const siblingCamIds = laserId ? internal.assocLaserToCams.get(laserId) : undefined
        set({
          hoveredBoxId: id,
          highlightedCameraBoxIds: siblingCamIds ? new Set(siblingCamIds) : new Set<string>(),
          highlightedLaserBoxId: laserId ?? null,
        })
      }
    },

    setAvailableSegments: (segments: string[]) => {
      set({ availableSegments: segments })
    },

    selectSegment: async (segmentId: string) => {
      const prev = get()
      trackSegmentSwitch(internal.datasetId ?? segmentId)
      prev.actions.reset()

      // After reset, UI prefs are already preserved. Just set the segment.
      // If the dataset type changed, visibleSensors IDs may be stale — validate them.
      if (internal.datasetId === 'nuscenes' && (internal.nuScenesDb || internal.nuScenesDiscoveredScenes)) {
        setManifest(nuScenesManifest)
      } else if (internal.datasetId === 'argoverse2' && internal.av2Db) {
        setManifest(argoverse2Manifest)
      }

      // Validate preserved visibleSensors against current manifest's sensor IDs
      const manifestIds = new Set(getManifest().lidarSensors.map(s => s.id))
      const preserved = get().visibleSensors
      const valid = new Set([...preserved].filter(id => manifestIds.has(id)))
      // If nothing valid remains (e.g. dataset type switch), enable all sensors
      const visibleSensors = valid.size > 0 ? valid : manifestIds
      set({ currentSegment: segmentId, visibleSensors })

      if (internal.datasetId === 'nuscenes') {
        // Sharded mode: fetch the scene's shard first if it isn't the loaded one
        if (internal.nuScenesDiscoveredScenes
            && (!internal.nuScenesDb || !internal.nuScenesDb.scenes.some(s => s.name === segmentId))) {
          const entry = internal.nuScenesDiscoveredScenes.find(s => s.name === segmentId)
          if (!entry) throw new Error(`nuScenes scene not found: ${segmentId}`)

          set({ status: 'loading', loadStep: 'opening' as LoadStep, loadProgress: 0, error: null })
          try {
            const { db, sampleFiles } = await fetchNuScenesVersionData(entry.sceneUrl, set)
            internal.nuScenesDb = db
            internal.nuScenesSampleFiles = sampleFiles
          } catch (e) {
            failLoad(set, e, 'selectSegment:nuScenesShard')
            return
          }
        }

        if (internal.nuScenesDb) {
          await loadNuScenesScene(segmentId, set, get)
          syncSegmentToUrl(segmentId, get().playbackWindow)
          return
        }
      }

      if (internal.datasetId === 'argoverse2') {
        // Multi-log mode: if switching to a different log, load it from URL first
        if (internal.av2DiscoveredLogs && (!internal.av2Db || internal.av2Db.logId !== segmentId)) {
          const logEntry = internal.av2DiscoveredLogs.find(l => l.logId === segmentId)
          if (!logEntry) throw new Error(`AV2 log not found: ${segmentId}`)

          set({ status: 'loading', loadStep: 'opening' as LoadStep, loadProgress: 0, error: null })

          const manifest = await fetchAV2Manifest(logEntry.logUrl)
          const { db, fileEntries } = await loadAV2FromUrl(logEntry.logUrl, manifest, (p) => {
            set({ loadProgress: p * 0.2 })
          })

          const sampleFiles = new Map<string, string>()
          for (const [filename, url] of fileEntries) {
            sampleFiles.set(filename, url)
          }

          internal.av2Db = db
          internal.av2SampleFiles = sampleFiles
        }

        if (internal.av2Db) {
          await loadAV2Scene(segmentId, set, get)
          syncSegmentToUrl(segmentId, get().playbackWindow)
          return
        }
      }

      // Waymo: file-based path (drag & drop / folder picker)
      if (internal.filesBySegment?.has(segmentId)) {
        const fileMap = internal.filesBySegment.get(segmentId)!
        // Pass File objects directly — workers can receive them via postMessage
        const sources = new Map<string, File | string>(fileMap)
        await get().actions.loadDataset(sources)
        // No URL sync for local files (drag & drop has no URL source)
        return
      }

      // Waymo: URL-based path (remote S3 or Vite dev server)
      const waymoBase = internal.waymoBaseUrl || '/waymo_data/'
      const sources = buildWaymoSegmentUrls(waymoBase, segmentId)
      await get().actions.loadDataset(sources as Map<string, File | string>)

      // Sync segment ID to URL bar (replaceState, no history pollution)
      syncSegmentToUrl(segmentId, get().playbackWindow)
    },

    toggleWorldMode: () => {
      set((s) => ({ worldMode: !s.worldMode }))
    },
    toggleLidarOverlay: () => {
      set((s) => ({ showLidarOverlay: !s.showLidarOverlay }))
    },
    toggleKeypoints3D: () => {
      const next = !get().showKeypoints3D
      set({ showKeypoints3D: next })
      trackOverlayToggle('keypoints_3d', next)
    },
    toggleKeypoints2D: () => {
      const next = !get().showKeypoints2D
      set({ showKeypoints2D: next })
      trackOverlayToggle('keypoints_2d', next)
    },
    toggleCameraSeg: () => {
      const next = !get().showCameraSeg
      set({ showCameraSeg: next })
      trackOverlayToggle('camera_seg', next)
    },

    // Display settings
    setBgPreset: (id: BgPresetId) => set({ bgPreset: id }),

    setTheme: (theme: ThemeName, accent?: string | null) => {
      applyTheme(theme, document.documentElement, accent)
      try { localStorage.setItem('egolens-theme', theme) } catch { /* private mode */ }
      set({ theme })
    },
    setPointShape: (shape: PointShape) => set({ pointShape: shape }),
    setPointSize: (size: number) => set({ pointSize: size }),
    setFollowCam: (follow: boolean) => set({ followCam: follow }),
    setPinCamera: (pin: boolean) => set({ pinCamera: pin }),
    loadFromFiles: async (segments: Map<string, Map<string, File>>) => {
      // Local files — clear URL source so segment changes don't sync to URL bar
      clearUrlSource()
      const datasetHint = segments.has('__nuscenes__') ? 'nuscenes' : segments.has('__argoverse2__') ? 'argoverse2' : 'waymo'
      trackDatasetLoad(datasetHint, 'local')

      // Local loading sets status to "loading" before it parses anything, which
      // unmounts the drop zone (App renders it only while status is "idle").
      // Without this catch a parse failure left the store in "loading" for good:
      // no error screen, no drop zone, just the skeleton. Every other load path
      // already funnels through failLoad.
      try {
        await loadLocalSegments(segments, set, get)
      } catch (e) {
        failLoad(set, e, 'loadFromFiles')
      }
    },

    loadFromUrl: async (dataset: string, baseUrl: string, initialScene?: string) => {
      // Track URL source for auto-sync on segment change
      setUrlSource(dataset, baseUrl)

      if (dataset === 'argoverse2') {
        set({ status: 'loading', loadStep: 'opening' as LoadStep, loadProgress: 0, error: null })

        try {
          // Check if this is a parent URL (e.g. .../sensor/ or .../train/) → multi-log discovery
          if (isAV2SensorRootUrl(baseUrl) || isAV2ParentUrl(baseUrl)) {
            // Deep-link fast path: with a scene id we can construct the log
            // URL directly and start loading now; discovery fills the
            // selector in the background instead of blocking the first frame.
            if (initialScene) {
              const direct = await resolveAV2DirectLogUrl(baseUrl, initialScene)
              if (direct) {
                console.log(`[loadFromUrl] AV2 direct scene: ${direct.logUrl}`)
                internal.datasetId = 'argoverse2'
                internal.av2DiscoveredLogs = [direct]
                internal.av2Db = null
                internal.av2SampleFiles = null
                internal.nuScenesDb = null
                internal.nuScenesSampleFiles = null
                internal.nuScenesDiscoveredScenes = null
                setManifest(argoverse2Manifest)
                set({ availableSegments: [initialScene], loadProgress: 0.05 })

                void discoverAV2LogsInBackground(baseUrl, set)
                await get().actions.selectSegment(initialScene)
                return
              }
              // Probe failed (bad scene id or HEAD-blocked host) — fall
              // through to discovery-first for the informative error.
            }

            console.log('[loadFromUrl] AV2 parent URL detected — discovering logs...')
            const logs = isAV2SensorRootUrl(baseUrl)
              ? await discoverAV2AllSplits(baseUrl, 700)
              : await discoverAV2Logs(baseUrl, 700)
            console.log(`[loadFromUrl] Found ${logs.length} AV2 logs`)

            if (logs.length === 0) {
              throw new Error('No AV2 logs found under this URL.')
            }

            // Store discovered logs for later selectSegment calls
            internal.datasetId = 'argoverse2'
            internal.av2DiscoveredLogs = logs
            internal.av2Db = null
            internal.av2SampleFiles = null
            internal.nuScenesDb = null
            internal.nuScenesSampleFiles = null
            internal.nuScenesDiscoveredScenes = null
            setManifest(argoverse2Manifest)

            // Show all log IDs as available segments
            const logIds = logs.map(l => l.logId)
            set({ availableSegments: logIds, loadProgress: 0.1 })

            // Auto-select: use initialScene if valid, otherwise first log
            const targetLog = initialScene && logIds.includes(initialScene)
              ? initialScene
              : logIds[0]
            await get().actions.selectSegment(targetLog)
            return
          }

          // Single log URL — existing flow
          // 1. Try manifest.json first, fall back to S3 listing
          const manifest = await fetchAV2Manifest(baseUrl)
          if (manifest) {
            console.log('[loadFromUrl] Using manifest.json for frame discovery')
          } else {
            console.log('[loadFromUrl] No manifest.json — falling back to S3 listing')
          }
          set({ loadProgress: 0.05 })

          // 2. Fetch metadata + build database
          const { db, fileEntries } = await loadAV2FromUrl(baseUrl, manifest, (p) => {
            set({ loadProgress: 0.05 + p * 0.15 }) // 0.05 → 0.20
          })

          // 3. Build URL-based sample files map for workers
          const sampleFiles = new Map<string, string>()
          for (const [filename, url] of fileEntries) {
            sampleFiles.set(filename, url)
          }

          // 4. Initialize AV2 state (same as local mode)
          internal.datasetId = 'argoverse2'
          internal.av2Db = db
          internal.av2SampleFiles = sampleFiles
          internal.nuScenesDb = null
          internal.nuScenesSampleFiles = null
          internal.nuScenesDiscoveredScenes = null
          setManifest(argoverse2Manifest)

          // AV2 has a single "scene" per log
          set({ availableSegments: [db.logId], loadProgress: 0.2 })

          // 5. Load scene (metadata → batches → workers → pipeline)
          await get().actions.selectSegment(db.logId)
        } catch (e) {
          failLoad(set, e, 'loadFromUrl:AV2')
        }
        return
      }

      if (dataset === 'nuscenes') {
        set({ status: 'loading', loadStep: 'opening' as LoadStep, loadProgress: 0, error: null })

        try {
          // Deep-link fast path: try the scene's shard directly and let
          // index discovery fill the selector in the background. Falls
          // through when the URL isn't a shard root (e.g. classic v1.0-mini
          // dir + scene param) — the shard probe simply finds no version dir.
          if (initialScene) {
            const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
            const sceneUrl = `${base}${initialScene}/`
            try {
              const { db, sampleFiles } = await fetchNuScenesVersionData(sceneUrl, set)
              if (db.scenes.some(s => s.name === initialScene)) {
                console.log(`[loadFromUrl] nuScenes direct scene: ${sceneUrl}`)
                internal.datasetId = 'nuscenes'
                internal.nuScenesDiscoveredScenes = [{ name: initialScene, sceneUrl }]
                internal.nuScenesDb = db
                internal.nuScenesSampleFiles = sampleFiles
                setManifest(nuScenesManifest)
                set({ availableSegments: [initialScene], loadProgress: 0.25 })

                void discoverNuScenesScenesInBackground(baseUrl, set)
                await get().actions.selectSegment(initialScene)
                return
              }
            } catch { /* not a shard root — fall through to discovery-first */ }
          }

          // Sharded hosting: an index.json at the root lists per-scene shards
          // (see scripts/shard_nuscenes.py). Each shard loads on scene select.
          const discovered = await discoverNuScenesScenes(baseUrl)
          if (discovered && discovered.length > 0) {
            console.log(`[loadFromUrl] nuScenes index found: ${discovered.length} scenes`)
            internal.datasetId = 'nuscenes'
            internal.nuScenesDiscoveredScenes = discovered
            internal.nuScenesDb = null
            internal.nuScenesSampleFiles = null
            setManifest(nuScenesManifest)

            const sceneNames = discovered.map(s => s.name)
            set({ availableSegments: sceneNames, loadProgress: 0.1 })

            const targetScene = initialScene && sceneNames.includes(initialScene)
              ? initialScene
              : sceneNames[0]
            await get().actions.selectSegment(targetScene)
            return
          }

          // Classic single version directory (v1.0-mini style)
          internal.nuScenesDiscoveredScenes = null
          internal.datasetId = 'nuscenes'
          setManifest(nuScenesManifest)

          const { db, sampleFiles } = await fetchNuScenesVersionData(baseUrl, set)
          internal.nuScenesDb = db
          internal.nuScenesSampleFiles = sampleFiles

          // Set available scenes and auto-select first
          const sceneNames = db.scenes.map(s => s.name).sort()
          set({ availableSegments: sceneNames, loadProgress: 0.25 })

          if (sceneNames.length > 0) {
            // If a specific scene was requested, use it; otherwise first scene
            const targetScene = initialScene && sceneNames.includes(initialScene)
              ? initialScene
              : sceneNames[0]
            await get().actions.selectSegment(targetScene)
          }
        } catch (e) {
          failLoad(set, e, 'loadFromUrl:nuScenes')
        }
        return
      }

      if (dataset === 'waymo') {
        set({ status: 'loading', loadStep: 'opening' as LoadStep, loadProgress: 0, error: null })

        try {
          // Common state setup
          internal.datasetId = 'waymo'
          internal.waymoBaseUrl = baseUrl
          internal.filesBySegment = null
          internal.nuScenesDb = null
          internal.nuScenesSampleFiles = null
          internal.nuScenesDiscoveredScenes = null
          internal.av2Db = null
          internal.av2SampleFiles = null
          internal.av2DiscoveredLogs = null
          setManifest(waymoManifest)

          // Direct segment access: if scene param is provided, skip discovery
          if (initialScene) {
            console.log(`[loadFromUrl] Waymo direct segment: ${initialScene}`)
            set({ availableSegments: [initialScene], loadProgress: 0.15 })
            await get().actions.selectSegment(initialScene)
            return
          }

          // Segment discovery: manifest → S3 listing → HTTP directory listing
          const manifest = await fetchWaymoRemoteManifest(baseUrl)
          let segmentIds: string[]

          if (manifest) {
            console.log(`[loadFromUrl] Waymo manifest found: ${manifest.segments.length} segments`)
            segmentIds = manifest.segments.sort()
          } else {
            console.log('[loadFromUrl] No Waymo manifest — discovering segments...')
            segmentIds = await discoverWaymoSegments(baseUrl)
            console.log(`[loadFromUrl] Discovered ${segmentIds.length} Waymo segments`)
          }

          if (segmentIds.length === 0) {
            throw new Error(
              'No Waymo segments found. Expected vehicle_pose/*.parquet files at the given URL.'
            )
          }
          set({ availableSegments: segmentIds, loadProgress: 0.15 })
          await get().actions.selectSegment(segmentIds[0])
        } catch (e) {
          failLoad(set, e, 'loadFromUrl:Waymo')
        }
        return
      }

      // Unknown dataset
      failLoad(set, new DataLoadError(`URL loading for "${dataset}" is not supported.`, 'UNKNOWN'), 'loadFromUrl')
    },

    reset: () => {
      const prev = get()
      prev.actions.pause()
      resetInternal()
      set({
        status: 'idle',
        error: null,
        availableComponents: [],
        loadProgress: 0,
        loadStep: 'opening' as LoadStep,
        totalFrames: 0,
        currentFrameIndex: 0,
        isPlaying: false,
        playbackSpeed: 1,
        playbackWindow: null,
        currentFrame: null,
        lidarCalibrations: new Map(),
        cameraCalibrations: [],
        lastFrameLoadMs: 0,
        lastConvertMs: 0,
        cachedFrames: [],
        cameraCachedFrames: [],
        cameraLoadedCount: 0,
        cameraTotalCount: 0,
        // Preserve user's UI preferences across segment switches
        visibleSensors: prev.visibleSensors,
        boxMode: prev.boxMode,
        showLidarOverlay: prev.showLidarOverlay,
        trailLength: prev.trailLength,
        pointOpacity: prev.pointOpacity,
        colormapMode: prev.colormapMode,
        hasBoxData: false,
        // Segmentation & keypoint flags reset
        hasSegmentation: false,
        hasKeypoints: false,
        hasCameraSegmentation: false,
        segLabelFrames: new Set<number>(),
        keypointFrames: new Set<number>(),
        cameraKeypointFrames: new Set<number>(),
        cameraSegFrames: new Set<number>(),
        // Preserve keypoint/seg toggles across segment switches (like boxMode)
        showKeypoints3D: prev.showKeypoints3D,
        showKeypoints2D: prev.showKeypoints2D,
        showCameraSeg: prev.showCameraSeg,
        activeCam: null,
        hoveredCam: null,
        hoveredBoxId: null,
        highlightedCameraBoxIds: new Set<string>(),
        highlightedLaserBoxId: null,
      })
    },
  },
}))

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getLidarColumns(): string[] {
  const cm = getManifest().columnMap
  return [cm.frameTimestamp, cm.laserName, cm.rangeImageShape, cm.rangeImageValues]
}

/** Load entire row group via Worker and cache all its frames. */
async function loadAndCacheRowGroup(
  rgIndex: number,
  set: (partial: Partial<SceneState>) => void,
  opts?: { priority?: boolean },
): Promise<void> {
  if (internal.loadedRowGroups.has(rgIndex)) return
  internal.loadedRowGroups.add(rgIndex) // Mark as in-flight to prevent duplicates

  try {
    const result = await requestRowGroup(rgIndex, opts)
    cacheRowGroupFrames(result, set)
  } catch {
    // If loading failed, allow retry
    internal.loadedRowGroups.delete(rgIndex)
  }
}

/**
 * Main-thread fallback: load a SINGLE frame via per-frame row range.
 * Used in test env / File-based sources where Worker is not available.
 * Each call decompresses the full row group (wasteful), but only keeps
 * 5 rows in memory — avoids OOM that row-group-level caching would cause.
 */
async function loadFrameMainThread(
  frameIndex: number,
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
): Promise<FrameData | null> {
  const lidarPf = internal.parquetFiles.get('lidar')
  if (!lidarPf || !internal.lidarFrameIndex) return null

  const timestamp = internal.timestamps[frameIndex]
  if (timestamp === undefined) return null

  const cm = getManifest().columnMap
  const lidarRows = await readFrameData(
    lidarPf,
    internal.lidarFrameIndex,
    timestamp,
    getLidarColumns(),
  )

  const rangeImages = new Map<number, RangeImage>()
  for (const row of lidarRows) {
    const laserName = row[cm.laserName] as number
    rangeImages.set(laserName, {
      shape: row[cm.rangeImageShape] as [number, number, number],
      values: row[cm.rangeImageValues] as number[],
    })
  }

  const ct0 = performance.now()
  const result = convertAllSensors(rangeImages, get().lidarCalibrations)
  internal.lastConvertMs = performance.now() - ct0

  const boxes = internal.lidarBoxByFrame.get(timestamp) ?? []
  const cameraBoxes = internal.cameraBoxByFrame.get(timestamp) ?? []
  const poseRows = internal.vehiclePoseByFrame.get(timestamp)
  const vehiclePose = (poseRows?.[0]?.[cm.vehiclePose] as number[]) ?? null

  const frameData: FrameData = {
    timestamp,
    sensorClouds: result.perSensor,
    boxes,
    cameraBoxes,
    cameraImages: new Map(),
    vehiclePose,
  }

  internal.frameCache.set(frameIndex, frameData)
  syncCachedFrames(set)
  return frameData
}

async function loadStartupData(set: (partial: Partial<SceneState>) => void, get: () => SceneState) {
  // Delegate to Waymo adapter (returns dataset-agnostic MetadataBundle)
  const bundle = await loadWaymoMetadata(internal.parquetFiles)

  // Unpack bundle into internal state
  applyMetadataBundle(bundle, set, get)
}

/**
 * Unpack a MetadataBundle into the store's internal state.
 * This function is dataset-agnostic — any adapter's bundle works.
 */
function applyMetadataBundle(
  bundle: MetadataBundle,
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
) {
  // Frame list
  internal.timestamps = bundle.timestamps
  internal.timestampToFrame = bundle.timestampToFrame

  // Poses
  internal.vehiclePoseByFrame = bundle.vehiclePoseByFrame
  internal.worldOriginInverse = bundle.worldOriginInverse
  internal.poseByFrameIndex = bundle.poseByFrameIndex

  // Boxes + trajectories
  internal.lidarBoxByFrame = bundle.lidarBoxByFrame
  internal.cameraBoxByFrame = bundle.cameraBoxByFrame
  internal.objectTrajectories = bundle.objectTrajectories

  // Associations
  internal.assocCamToLaser = bundle.assocCamToLaser
  internal.assocLaserToCams = bundle.assocLaserToCams

  // Segmentation & keypoint data
  if (bundle.keypointsByFrame) {
    internal.keypointsByFrame = bundle.keypointsByFrame
    // Share reference with KeypointSkeleton component for direct access
    setKeypointsByFrameRef(bundle.keypointsByFrame)
  }
  if (bundle.cameraKeypointsByFrame) {
    internal.cameraKeypointsByFrame = bundle.cameraKeypointsByFrame
    setCameraKeypointsByFrameRef(bundle.cameraKeypointsByFrame)
  }
  if (bundle.cameraSeg) {
    internal.cameraSeg = bundle.cameraSeg
    setCameraSegByFrameRef(bundle.cameraSeg)
  }

  // Zustand state updates
  set({
    totalFrames: bundle.timestamps.length,
    lidarCalibrations: bundle.lidarCalibrations,
    cameraCalibrations: bundle.cameraCalibrations,
    hasBoxData: bundle.hasBoxData,
    // Segmentation & keypoint flags
    hasSegmentation: bundle.hasSegmentation ?? false,
    hasKeypoints: bundle.hasKeypoints ?? false,
    hasCameraSegmentation: bundle.hasCameraSegmentation ?? false,
    segLabelFrames: bundle.segLabelFrames ?? new Set<number>(),
    keypointFrames: bundle.keypointFrames ?? new Set<number>(),
    cameraKeypointFrames: bundle.cameraKeypointFrames ?? new Set<number>(),
    cameraSegFrames: bundle.cameraSegFrames ?? new Set<number>(),
  })

  // Segment metadata
  if (bundle.segmentMeta) {
    const prev = get().segmentMetas
    const next = new Map(prev)
    next.set(bundle.segmentMeta.segmentId, bundle.segmentMeta)
    set({ segmentMetas: next })
  }
}

// ---------------------------------------------------------------------------
// Worker pool init
// ---------------------------------------------------------------------------

async function initDataWorker(
  sources: Map<string, File | string>,
  get: () => SceneState,
  _set: (partial: Partial<SceneState>) => void,
) {
  const lidarSource = sources.get('lidar')
  if (!lidarSource) return

  const pool = new WorkerPool<Record<string, unknown>, LidarBatchResult>(
    WORKER_CONCURRENCY,
    () => new Worker(new URL('../workers/waymoLidarWorker.ts', import.meta.url), { type: 'module' }),
  )
  // Pass segmentation parquet URL if available (Phase A worker protocol)
  const segSource = sources.get('lidar_segmentation')
  const { numBatches } = await pool.init({
    lidarUrl: lidarSource,
    calibrationEntries: [...get().lidarCalibrations.entries()],
    ...(segSource ? { segUrl: segSource } : {}),
  })

  internal.workerPool = pool
  internal.numBatches = numBatches
}

/** Initialize camera worker pool (separate from lidar pool) */
async function initCameraWorker(
  sources: Map<string, File | string>,
) {
  const cameraSource = sources.get('camera_image')
  if (!cameraSource) return

  const start = async () => {
  const pool = new WorkerPool<Record<string, unknown>, CameraBatchResult>(
    2,
    () => new Worker(new URL('../workers/waymoCameraWorker.ts', import.meta.url), { type: 'module' }),
  )
  const { numBatches } = await pool.init({ cameraUrl: cameraSource })

  internal.cameraPool = pool
  internal.cameraNumBatches = numBatches
  useSceneStore.setState({ cameraTotalCount: internal.cameraNumBatches })
  }

  internal.cameraPoolInit = start
  if (cameraImagesWanted()) await start()
  else console.log('[camera] nothing needs images — pool deferred')
}

// ---------------------------------------------------------------------------
// nuScenes scene loading
// ---------------------------------------------------------------------------

/**
 * Load a nuScenes scene — the nuScenes equivalent of loadDataset.
 * Called from selectSegment when the active dataset is nuScenes.
 */
/**
 * Fill the scene selector after a deep-link fast path load. Runs detached:
 * a failure leaves the selector single-scene (the loaded scene still works),
 * and a stale result — the user switched dataset or URL mid-listing — is
 * dropped rather than allowed to clobber current state.
 */
async function discoverAV2LogsInBackground(
  baseUrl: string,
  set: (partial: Partial<SceneState>) => void,
): Promise<void> {
  try {
    const logs = isAV2SensorRootUrl(baseUrl)
      ? await discoverAV2AllSplits(baseUrl, 700)
      : await discoverAV2Logs(baseUrl, 700)
    if (logs.length === 0) return

    const src = getUrlSource()
    if (internal.datasetId !== 'argoverse2' || src?.baseUrl !== baseUrl) return

    // Keep the directly-loaded log even if discovery somehow missed it
    const current = internal.av2DiscoveredLogs?.[0]
    const merged = current && !logs.some(l => l.logId === current.logId)
      ? [current, ...logs]
      : logs
    internal.av2DiscoveredLogs = merged
    set({ availableSegments: merged.map(l => l.logId) })
    console.log(`[loadFromUrl] Background discovery filled selector: ${merged.length} AV2 logs`)
  } catch (e) {
    console.warn('[loadFromUrl] Background AV2 discovery failed — selector stays single-scene:', e)
  }
}

/** nuScenes counterpart of discoverAV2LogsInBackground. */
async function discoverNuScenesScenesInBackground(
  baseUrl: string,
  set: (partial: Partial<SceneState>) => void,
): Promise<void> {
  try {
    const discovered = await discoverNuScenesScenes(baseUrl)
    if (!discovered || discovered.length === 0) return

    const src = getUrlSource()
    if (internal.datasetId !== 'nuscenes' || !internal.nuScenesDiscoveredScenes || src?.baseUrl !== baseUrl) return

    const current = internal.nuScenesDiscoveredScenes[0]
    const merged = current && !discovered.some(s => s.name === current.name)
      ? [current, ...discovered]
      : discovered
    internal.nuScenesDiscoveredScenes = merged
    set({ availableSegments: merged.map(s => s.name) })
    console.log(`[loadFromUrl] Background discovery filled selector: ${merged.length} nuScenes scenes`)
  } catch (e) {
    console.warn('[loadFromUrl] Background nuScenes discovery failed — selector stays single-scene:', e)
  }
}

/**
 * Largest metadata table the browser will attempt to parse. V8 caps strings
 * at ~512MB, so a full-split sample_data.json (~1.3GB for trainval) fails in
 * File.text()/res.text() with an opaque RangeError — this limit turns that
 * into an actionable "shard it first" error instead.
 */
const NUSCENES_TABLE_SIZE_LIMIT = 400 * 1024 * 1024

/**
 * Fetch one nuScenes version directory over HTTP and build the database plus
 * URL-based sample file map. Works for a classic full directory (v1.0-mini)
 * and for a per-scene shard (scripts/shard_nuscenes.py) alike — a shard is
 * just a version dir with one scene in it.
 */
async function fetchNuScenesVersionData(
  baseUrl: string,
  set: (partial: Partial<SceneState>) => void,
): Promise<{ db: NuScenesDatabase; sampleFiles: Map<string, string> }> {
  // 1. Auto-detect split by probing known metadata paths
  const splits = ['v1.0-mini', 'v1.0-trainval', 'v1.0-test']
  let detectedSplit: string | null = null

  for (const split of splits) {
    try {
      const url = `${baseUrl}${split}/scene.json`
      const res = await fetch(url, { method: 'HEAD' })
      if (res.ok) {
        detectedSplit = split
        console.log(`[loadFromUrl] nuScenes detected: ${split}`)
        break
      }
    } catch { /* try next split */ }
  }

  if (!detectedSplit) {
    throw new Error(
      'Could not detect nuScenes data. Expected v1.0-mini/, v1.0-trainval/, or v1.0-test/ folder with scene.json at the given URL.'
    )
  }
  set({ loadProgress: 0.05 })

  // Same string-limit guard as the local path — enforced only when the server
  // reports a size, so hosts without content-length still load normally.
  const head = await fetch(`${baseUrl}${detectedSplit}/sample_data.json`, { method: 'HEAD' })
    .catch(() => null)
  const tableBytes = Number(head?.headers.get('content-length') ?? 0)
  if (tableBytes > NUSCENES_TABLE_SIZE_LIMIT) {
    throw new Error(
      `sample_data.json is ${(tableBytes / 1e9).toFixed(1)}GB — full-split nuScenes metadata `
      + 'is too large for a browser to parse. Shard it per scene with '
      + 'scripts/shard_nuscenes.py (see docs/NUSCENES_FULL_HOSTING.md) and load the shard root instead.',
    )
  }

  // 2. Fetch all metadata JSONs as text strings (buildNuScenesDatabase accepts string values)
  const metaBase = `${baseUrl}${detectedSplit}/`
  const jsonFileNames = [
    'scene.json', 'sample.json', 'sample_data.json', 'ego_pose.json',
    'sample_annotation.json', 'calibrated_sensor.json', 'sensor.json',
    'instance.json', 'category.json', 'log.json',
    'lidarseg.json', 'panoptic.json', 'attribute.json', 'visibility.json',
  ]

  const jsonFiles = new Map<string, string>()
  const fetchResults = await Promise.allSettled(
    jsonFileNames.map(async (name) => {
      const res = await fetch(`${metaBase}${name}`)
      if (res.ok) {
        jsonFiles.set(name, await res.text())
      }
    })
  )
  // Log any failures (non-critical files like panoptic.json may be missing)
  for (let i = 0; i < fetchResults.length; i++) {
    if (fetchResults[i].status === 'rejected') {
      console.warn(`[loadFromUrl] Failed to fetch ${jsonFileNames[i]}`)
    }
  }
  set({ loadProgress: 0.15, loadStep: 'parsing' as LoadStep })

  // 3. Build nuScenes database (same as local mode)
  const db = await buildNuScenesDatabase(jsonFiles)
  console.log(`[loadFromUrl] nuScenes DB built: ${db.scenes.length} scenes`)
  set({ loadProgress: 0.2 })

  // 4. Build URL-based sample file map (filename → full URL)
  //    Workers will fetch files by URL string instead of reading File objects
  const sampleFiles = new Map<string, string>()
  for (const [, sd] of db.sampleDataByToken) {
    sampleFiles.set(sd.filename, `${baseUrl}${sd.filename}`)
  }
  // Also add lidarseg/panoptic files if present
  for (const segTable of ['lidarseg.json', 'panoptic.json']) {
    if (jsonFiles.has(segTable)) {
      try {
        const entries = JSON.parse(jsonFiles.get(segTable)!) as Array<{ filename: string }>
        for (const entry of entries) {
          sampleFiles.set(entry.filename, `${baseUrl}${entry.filename}`)
        }
      } catch { /* ignore parse errors */ }
    }
  }
  console.log(`[loadFromUrl] nuScenes file map: ${sampleFiles.size} entries`)

  return { db, sampleFiles }
}

async function loadNuScenesScene(
  sceneName: string,
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
) {
  if (!internal.nuScenesDb || !internal.nuScenesSampleFiles) {
    throw new Error('nuScenes database not loaded')
  }

  set({
    status: 'loading',
    error: null,
    loadProgress: 0,
    loadStep: 'parsing' as LoadStep,
    availableComponents: ['samples', 'v1.0-mini'],
    cachedFrames: [],
  })

  try {
    // 1. Find scene by name
    const scene = internal.nuScenesDb.scenes.find(s => s.name === sceneName)
    if (!scene) throw new Error(`Scene not found: ${sceneName}`)
    memLog.snap('nuscenes:scene-start', { note: sceneName })

    // 2. Load scene metadata → MetadataBundle
    const bundle = loadNuScenesSceneMetadata(internal.nuScenesDb, scene.token)
    set({ loadProgress: 0.2 })

    // 3. Extract frame batch info BEFORE applying bundle
    //    (vehiclePoseByFrame contains sensor file paths for nuScenes)
    const { lidarBatches, cameraBatches } = buildNuScenesFrameBatches(bundle)

    // 4. Apply metadata bundle to internal state
    applyMetadataBundle(bundle, set, get)
    set({ loadProgress: 0.3 })
    memLog.snap('nuscenes:metadata-applied', {
      note: `${bundle.timestamps.length} frames, ${lidarBatches.length} lidar batches, ${cameraBatches.length} camera batches`,
    })

    // 5. Init nuScenes workers in parallel
    //    Pass LiDAR extrinsic so the worker transforms points from sensor→ego frame
    //    Pass radar extrinsics (sensor IDs 10-14) for radar sensor→ego transforms
    const lidarTopCalib = bundle.lidarCalibrations.get(1) // LIDAR_TOP = sensor ID 1
    const lidarExtrinsic = (lidarTopCalib?.extrinsic as number[] | undefined)
    const radarExtrinsics: [number, number[]][] = []
    for (const [sensorId, calib] of bundle.lidarCalibrations) {
      if (sensorId >= 10) { // Radar sensor IDs are 10+
        radarExtrinsics.push([sensorId, calib.extrinsic])
      }
    }
    set({ loadStep: 'workers' as LoadStep })
    await Promise.all([
      initNuScenesLidarWorker(lidarBatches, lidarExtrinsic, radarExtrinsics),
      initNuScenesCameraWorker(cameraBatches),
    ])
    set({ loadProgress: 0.5 })
    memLog.snap('nuscenes:workers-initialized')

    // 6. Load first frames, display, and prefetch remaining
    await runPostWorkerPipeline(set, get, 'nuscenes')
  } catch (e) {
    failLoad(set, e, 'loadNuScenesScene')
  }
}

/** Number of frames per worker batch for nuScenes */
const NUSCENES_BATCH_SIZE = 10

/**
 * Extract frame descriptors from nuScenes MetadataBundle and group into batches.
 * Must be called BEFORE applyMetadataBundle (which moves data into internal state).
 */
function buildNuScenesFrameBatches(bundle: MetadataBundle) {
  const lidarFrames: NuScenesFrameDescriptor[] = []
  const cameraFrames: NuScenesCameraFrameDescriptor[] = []

  for (let fi = 0; fi < bundle.timestamps.length; fi++) {
    const ts = bundle.timestamps[fi]
    const sensorFiles = bundle.vehiclePoseByFrame.get(ts) as Record<string, unknown>[] | undefined
    if (!sensorFiles) continue

    // LiDAR frame + radar files
    const lidarFile = sensorFiles.find(sf => sf.modality === 'lidar')
    if (lidarFile) {
      // Collect radar files for this frame
      const radarFiles: NuScenesRadarFileDescriptor[] = []
      for (const sf of sensorFiles) {
        if (sf.modality === 'radar') {
          radarFiles.push({
            sensorId: sf.sensorId as number,
            filename: sf.filename as string,
          })
        }
      }
      // Extract lidarseg / panoptic label filenames (if available)
      const lidarsegFile = lidarFile.lidarsegFile as string | undefined
      const panopticFile = lidarFile.panopticFile as string | undefined

      lidarFrames.push({
        timestamp: ts.toString(),
        filename: lidarFile.filename as string,
        radarFiles: radarFiles.length > 0 ? radarFiles : undefined,
        lidarsegFile,
        panopticFile,
      })
    }

    // Camera frame (all cameras for this sample)
    const camImages: NuScenesCameraImageDescriptor[] = []
    for (const sf of sensorFiles) {
      if (sf.modality === 'camera') {
        camImages.push({
          cameraId: sf.sensorId as number,
          filename: sf.filename as string,
        })
      }
    }
    if (camImages.length > 0) {
      cameraFrames.push({
        timestamp: ts.toString(),
        images: camImages,
      })
    }
  }

  // Group into batches
  const lidarBatches: NuScenesFrameDescriptor[][] = []
  for (let i = 0; i < lidarFrames.length; i += NUSCENES_BATCH_SIZE) {
    lidarBatches.push(lidarFrames.slice(i, i + NUSCENES_BATCH_SIZE))
  }

  const cameraBatches: NuScenesCameraFrameDescriptor[][] = []
  for (let i = 0; i < cameraFrames.length; i += NUSCENES_BATCH_SIZE) {
    cameraBatches.push(cameraFrames.slice(i, i + NUSCENES_BATCH_SIZE))
  }

  return { lidarBatches, cameraBatches }
}

/** Init nuScenes LiDAR+Radar worker pool with pre-built frame batches + file entries. */
async function initNuScenesLidarWorker(
  batches: NuScenesFrameDescriptor[][],
  lidarExtrinsic?: number[],
  radarExtrinsics?: [number, number[]][],
) {
  if (!internal.nuScenesSampleFiles || batches.length === 0) return

  // Collect only the files referenced by the batches (LiDAR + radar + lidarseg)
  const neededFiles = new Set<string>()
  for (const batch of batches) {
    for (const frame of batch) {
      neededFiles.add(frame.filename)
      if (frame.radarFiles) {
        for (const rf of frame.radarFiles) neededFiles.add(rf.filename)
      }
      if (frame.lidarsegFile) {
        neededFiles.add(frame.lidarsegFile)
      }
      if (frame.panopticFile) {
        neededFiles.add(frame.panopticFile)
      }
    }
  }
  const fileEntries: [string, File | string][] = []
  for (const filename of neededFiles) {
    const entry = internal.nuScenesSampleFiles.get(filename)
    if (entry) fileEntries.push([filename, entry])
  }

  const pool = new WorkerPool<Record<string, unknown>, LidarBatchResult>(
    WORKER_CONCURRENCY,
    () => new Worker(new URL('../workers/nuScenesLidarWorker.ts', import.meta.url), { type: 'module' }),
  )
  const { numBatches } = await pool.init({
    frameBatches: batches,
    fileEntries,
    lidarExtrinsic,
    radarExtrinsics,
  })

  internal.workerPool = pool
  internal.numBatches = numBatches
}

/** Init nuScenes camera worker pool with pre-built frame batches + file entries. */
async function initNuScenesCameraWorker(
  batches: NuScenesCameraFrameDescriptor[][],
) {
  if (!internal.nuScenesSampleFiles || batches.length === 0) return

  // Collect only the files referenced by the batches
  const neededFiles = new Set<string>()
  for (const batch of batches) {
    for (const frame of batch) {
      for (const img of frame.images) {
        neededFiles.add(img.filename)
      }
    }
  }
  const fileEntries: [string, File | string][] = []
  for (const filename of neededFiles) {
    const entry = internal.nuScenesSampleFiles.get(filename)
    if (entry) fileEntries.push([filename, entry])
  }

  const start = async () => {
    const pool = new WorkerPool<Record<string, unknown>, CameraBatchResult>(
      2,
      () => new Worker(new URL('../workers/nuScenesCameraWorker.ts', import.meta.url), { type: 'module' }),
    )
    const { numBatches } = await pool.init({
      frameBatches: batches,
      fileEntries,
    })

    internal.cameraPool = pool
    internal.cameraNumBatches = numBatches
    useSceneStore.setState({ cameraTotalCount: internal.cameraNumBatches })
  }

  internal.cameraPoolInit = start
  if (cameraImagesWanted()) await start()
  else console.log('[camera] nothing needs images — pool deferred')
}

// ---------------------------------------------------------------------------
// Argoverse 2 loading
// ---------------------------------------------------------------------------

/** Number of frames per worker batch for AV2 */
const AV2_BATCH_SIZE = 10

async function loadAV2Scene(
  logId: string,
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
) {
  if (!internal.av2Db || !internal.av2SampleFiles) {
    throw new Error('AV2 database not loaded')
  }

  set({
    status: 'loading',
    error: null,
    loadProgress: 0,
    loadStep: 'parsing' as LoadStep,
    availableComponents: ['sensors', 'calibration'],
    cachedFrames: [],
  })

  try {
    memLog.snap('av2:scene-start', { note: logId })

    // 1. Load metadata → MetadataBundle
    const bundle = loadAV2LogMetadata(internal.av2Db)
    set({ loadProgress: 0.2 })

    // 2. Extract frame batch info BEFORE applying bundle
    const { lidarBatches, cameraBatches } = buildAV2FrameBatches(bundle)

    // 3. Apply metadata bundle to internal state
    applyMetadataBundle(bundle, set, get)
    set({ loadProgress: 0.3 })
    memLog.snap('av2:metadata-applied', {
      note: `${bundle.timestamps.length} frames, ${lidarBatches.length} lidar batches, ${cameraBatches.length} camera batches`,
    })

    // 4. Init AV2 workers in parallel
    set({ loadStep: 'workers' as LoadStep })
    await Promise.all([
      initAV2LidarWorker(lidarBatches),
      initAV2CameraWorker(cameraBatches),
    ])
    set({ loadProgress: 0.5 })
    memLog.snap('av2:workers-initialized')

    // 5. Load first frames, display, and prefetch remaining
    await runPostWorkerPipeline(set, get, 'av2')
  } catch (e) {
    failLoad(set, e, 'loadAV2Scene')
  }
}

/**
 * Extract frame descriptors from AV2 MetadataBundle and group into batches.
 */
function buildAV2FrameBatches(bundle: MetadataBundle) {
  const lidarFrames: AV2LidarFrameDescriptor[] = []
  const cameraFrames: AV2CameraFrameDescriptor[] = []

  for (let fi = 0; fi < bundle.timestamps.length; fi++) {
    const ts = bundle.timestamps[fi]
    const sensorFiles = bundle.vehiclePoseByFrame.get(ts) as Record<string, unknown>[] | undefined
    if (!sensorFiles) continue

    // LiDAR frame
    const lidarFile = sensorFiles.find(sf => sf.modality === 'lidar')
    if (lidarFile) {
      lidarFrames.push({
        timestamp: ts.toString(),
        filename: lidarFile.filename as string,
      })
    }

    // Camera frame (all cameras for this frame)
    const camImages: AV2CameraImageDescriptor[] = []
    for (const sf of sensorFiles) {
      if (sf.modality === 'camera') {
        camImages.push({
          cameraId: sf.sensorId as number,
          filename: sf.filename as string,
        })
      }
    }
    if (camImages.length > 0) {
      cameraFrames.push({
        timestamp: ts.toString(),
        images: camImages,
      })
    }
  }

  // Group into batches
  const lidarBatches: AV2LidarFrameDescriptor[][] = []
  for (let i = 0; i < lidarFrames.length; i += AV2_BATCH_SIZE) {
    lidarBatches.push(lidarFrames.slice(i, i + AV2_BATCH_SIZE))
  }

  const cameraBatches: AV2CameraFrameDescriptor[][] = []
  for (let i = 0; i < cameraFrames.length; i += AV2_BATCH_SIZE) {
    cameraBatches.push(cameraFrames.slice(i, i + AV2_BATCH_SIZE))
  }

  return { lidarBatches, cameraBatches }
}

/** Init AV2 LiDAR worker pool */
async function initAV2LidarWorker(batches: AV2LidarFrameDescriptor[][]) {
  if (!internal.av2SampleFiles || batches.length === 0) return

  const neededFiles = new Set<string>()
  for (const batch of batches) {
    for (const frame of batch) {
      neededFiles.add(frame.filename)
    }
  }
  const fileEntries: [string, File | string][] = []
  for (const filename of neededFiles) {
    const entry = internal.av2SampleFiles.get(filename)
    if (entry) fileEntries.push([filename, entry])
  }

  const pool = new WorkerPool<Record<string, unknown>, LidarBatchResult>(
    WORKER_CONCURRENCY,
    () => new Worker(new URL('../workers/av2LidarWorker.ts', import.meta.url), { type: 'module' }),
  )
  const { numBatches } = await pool.init({
    frameBatches: batches,
    fileEntries,
  })

  internal.workerPool = pool
  internal.numBatches = numBatches
}

/** Init AV2 camera worker pool */
async function initAV2CameraWorker(batches: AV2CameraFrameDescriptor[][]) {
  if (!internal.av2SampleFiles || batches.length === 0) return

  const neededFiles = new Set<string>()
  for (const batch of batches) {
    for (const frame of batch) {
      for (const img of frame.images) {
        neededFiles.add(img.filename)
      }
    }
  }
  const fileEntries: [string, File | string][] = []
  for (const filename of neededFiles) {
    const entry = internal.av2SampleFiles.get(filename)
    if (entry) fileEntries.push([filename, entry])
  }

  const start = async () => {
    const pool = new WorkerPool<Record<string, unknown>, CameraBatchResult>(
      2,
      () => new Worker(new URL('../workers/av2CameraWorker.ts', import.meta.url), { type: 'module' }),
    )
    const { numBatches } = await pool.init({
      frameBatches: batches,
      fileEntries,
    })

    internal.cameraPool = pool
    internal.cameraNumBatches = numBatches
    useSceneStore.setState({ cameraTotalCount: internal.cameraNumBatches })
  }

  internal.cameraPoolInit = start
  if (cameraImagesWanted()) await start()
  else console.log('[camera] nothing needs images — pool deferred')
}

/**
 * Does anything on screen need camera images right now?
 *
 * Three consumers: the camera strip, the LiDAR→camera colormap, and POV mode.
 * Re-evaluated per scene, because all three can change across a switch.
 */
function cameraImagesWanted(): boolean {
  const stripVisible = parseCamerasParam() ?? getEmbedParams().controls !== 'none'
  if (stripVisible) return true
  const state = useSceneStore.getState()
  return state.colormapMode === 'camera' || state.activeCam !== null
}

/**
 * Start the camera pipeline that `cameraImagesWanted() === false` skipped.
 * No-op when the pool is already running or there is nothing deferred.
 *
 * Guarded by the scene token: an await here can outlive the scene that
 * queued it, and installing a stale pool over a new scene would feed it
 * another log's frames.
 */
async function ensureCameraPool(set: (partial: Partial<SceneState>) => void): Promise<void> {
  // Read through a getter: a direct `internal.cameraPool` check narrows the
  // property to null for the rest of the function, and init() assigns it.
  const pool = () => internal.cameraPool
  const init = internal.cameraPoolInit
  if (pool() || !init) return
  const token = internal.sceneToken
  internal.cameraPoolInit = null

  try {
    await init()
  } catch (e) {
    console.warn('[camera] deferred init failed:', e)
    return
  }
  if (token !== internal.sceneToken) return  // scene changed under us
  if (!pool()?.isReady()) return

  // Load the batch the viewer is actually on first — a plain prefetch would
  // start at batch 0 and hand the user images for every frame but theirs.
  const state = useSceneStore.getState()
  const perBatch = internal.cameraNumBatches > 0
    ? Math.ceil(internal.timestamps.length / internal.cameraNumBatches)
    : internal.timestamps.length
  const visibleBatch = perBatch > 0
    ? Math.min(Math.floor(state.currentFrameIndex / perBatch), internal.cameraNumBatches - 1)
    : 0
  await loadAndCacheCameraRowGroup(visibleBatch, set, { priority: true }).catch(() => {})

  if (token !== internal.sceneToken) return
  if (!internal.cameraPrefetchStarted) {
    internal.cameraPrefetchStarted = true
    void prefetchAllCameraRowGroups(set)
  }
}

/** Load + cache a single camera row group */
async function loadAndCacheCameraRowGroup(
  rgIndex: number,
  set: (partial: Partial<SceneState>) => void,
  opts?: { priority?: boolean },
): Promise<void> {
  if (internal.cameraLoadedRowGroups.has(rgIndex)) return
  internal.cameraLoadedRowGroups.add(rgIndex)

  try {
    const result = await internal.cameraPool!.requestRowGroup(rgIndex, opts)
    cacheCameraRowGroupFrames(result)

    // Update camera loading progress + buffer bar, and patch current frame
    // if new camera images arrived for it.  Merged into a single set() to
    // avoid triggering two separate React re-render cycles.
    syncCameraCachedFrames(set)
    const state = useSceneStore.getState()
    const fi = state.currentFrameIndex
    const cached = internal.frameCache.get(fi)
    const camData = internal.cameraImageCache.get(fi)
    const currentFrame = state.currentFrame
    // Only replace currentFrame when camera count actually increased —
    // if loadFrame already merged the same images, skip the redundant update.
    const needsFramePatch = cached && camData && camData.size > 0 &&
      (!currentFrame || currentFrame.cameraImages.size !== camData.size)
    if (needsFramePatch) {
      set({
        cameraLoadedCount: internal.cameraLoadedRowGroups.size,
        currentFrame: {
          ...cached,
          cameraImages: new Map(camData),
        },
      })
    } else {
      set({ cameraLoadedCount: internal.cameraLoadedRowGroups.size })
    }
  } catch (e) {
    console.error(`[CameraPool] Failed to load RG ${rgIndex}:`, e)
    internal.cameraLoadedRowGroups.delete(rgIndex)
  }
}

/** Prefetch all camera row groups in parallel */
async function prefetchAllCameraRowGroups(
  set: (partial: Partial<SceneState>) => void,
) {
  const promises: Promise<void>[] = []
  for (let rg = 0; rg < internal.cameraNumBatches; rg++) {
    if (internal.cameraLoadedRowGroups.has(rg)) continue
    promises.push(
      loadAndCacheCameraRowGroup(rg, set).catch(() => {}),
    )
  }
  await Promise.all(promises)

  // Compute total cached JPEG sizes
  let totalJpegBytes = 0
  for (const camMap of internal.cameraImageCache.values()) {
    for (const jpeg of camMap.values()) {
      totalJpegBytes += jpeg.byteLength
    }
  }
  memLog.snap('prefetch:camera-complete', {
    dataSize: totalJpegBytes,
    note: `${internal.cameraImageCache.size} frames × cameras cached`,
  })

  // Print full summary when everything is done
  memLog.snap('pipeline:all-prefetch-complete')
  memLog.printSummary()
}

// ---------------------------------------------------------------------------
// Row-group-level prefetching — load ALL row groups in parallel
// ---------------------------------------------------------------------------

/**
 * Load all row groups from the lidar file via worker pool.
 * Each RG yields ~51 frames — after 4 RGs, all 199 frames are cached.
 *
 * Dispatches ALL remaining row groups at once. The WorkerPool internally
 * queues them and distributes across N workers (WORKER_CONCURRENCY).
 */
async function prefetchAllRowGroups(
  set: (partial: Partial<SceneState>) => void,
  _get: () => SceneState,
) {
  const promises: Promise<void>[] = []

  for (let rg = 0; rg < internal.numBatches; rg++) {
    if (internal.loadedRowGroups.has(rg)) continue

    promises.push(
      loadAndCacheRowGroup(rg, set).catch(() => {
        // Non-critical: prefetch failure doesn't block user interaction
      }),
    )
  }

  await Promise.all(promises)

  // Compute total cached sizes
  let totalLidarBytes = 0
  for (const frame of internal.frameCache.values()) {
    for (const cloud of frame.sensorClouds.values()) {
      totalLidarBytes += cloud.positions.buffer.byteLength
    }
  }
  memLog.snap('prefetch:lidar-complete', {
    dataSize: totalLidarBytes,
    note: `${internal.frameCache.size} frames fully cached`,
  })
}

// ---------------------------------------------------------------------------
// Shared post-worker pipeline (first frame + prefetch)
// ---------------------------------------------------------------------------

/**
 * Common tail logic shared by all three dataset loaders.
 * Called after workers are initialized. Loads first frame, displays it,
 * and kicks off background prefetch.
 *
 * @param set - Zustand set function
 * @param get - Zustand get function
 * @param logLabel - Label prefix for memLog (e.g. 'waymo', 'nuscenes', 'av2')
 * @param mainThreadFallback - Optional: called when workerPool isn't ready (Waymo-only)
 */
async function runPostWorkerPipeline(
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
  logLabel: string,
  mainThreadFallback?: () => Promise<void>,
): Promise<void> {
  // Determine target frame from Share URL (if any)
  const initSearch = getInitialSearch()
  const viewParams = initSearch ? parseViewParams(initSearch) : {}

  // A t0/t1 link says "watch this interval", so its first frame — not frame
  // 0 — is what the first paint should wait for.
  const linkRange = viewParams.t0 && viewParams.t1
    ? resolveWindowToFrames(internal.timestamps, viewParams.t0, viewParams.t1)
    : null

  const targetFrame = linkRange
    ? linkRange.f0
    : viewParams.frame != null
      ? Math.min(viewParams.frame, internal.timestamps.length - 1)
      : 0

  /** Which batch of `numBatches` holds a frame (lidar and camera split differently). */
  const batchIndexOf = (frame: number, numBatches: number): number => {
    if (numBatches <= 0) return 0
    const perBatch = Math.ceil(internal.timestamps.length / numBatches)
    if (perBatch <= 0) return 0
    return Math.min(Math.floor(frame / perBatch), numBatches - 1)
  }

  const targetBatch = batchIndexOf(targetFrame, internal.numBatches)
  const camTargetBatch = batchIndexOf(targetFrame, internal.cameraNumBatches)

  // Past a few batches, prioritising the range is the same as prioritising
  // everything — so a wide range keeps the ordinary behaviour.
  const RANGE_BATCH_CAP = 3
  const rangeLastBatch = linkRange ? batchIndexOf(linkRange.f1, internal.numBatches) : targetBatch
  const rangeIsNarrow = linkRange != null && rangeLastBatch - targetBatch + 1 <= RANGE_BATCH_CAP

  set({ loadStep: 'first-frame' as LoadStep })
  const rgT0 = performance.now()
  const firstFramePromises: Promise<void>[] = []
  /** Queued right after the critical path — ordering only, never awaited. */
  const queueAfterFirstPaint: (() => void)[] = []

  if (internal.workerPool?.isReady()) {
    if (linkRange) {
      // Critical path is the range's own first batch. Batch 0 is dead weight
      // for a link that points elsewhere, so it drops to the background —
      // this makes the first paint faster than the no-range case, not slower.
      firstFramePromises.push(loadAndCacheRowGroup(targetBatch, set, { priority: true }))
      const rest: number[] = []
      if (rangeIsNarrow) {
        for (let b = targetBatch + 1; b <= rangeLastBatch; b++) rest.push(b)
      } else if (targetBatch + 1 < internal.numBatches) {
        rest.push(targetBatch + 1)
      }
      rest.push(0)
      queueAfterFirstPaint.push(() => {
        for (const b of rest) {
          if (b >= 0 && b < internal.numBatches && !internal.loadedRowGroups.has(b)) {
            void loadAndCacheRowGroup(b, set, { priority: true }).catch(() => {})
          }
        }
      })
    } else {
      const batchesToLoad = new Set([0, targetBatch])
      // Also load neighbor batch for smoother playback from target
      if (targetBatch > 0) batchesToLoad.add(targetBatch - 1)
      if (targetBatch + 1 < internal.numBatches) batchesToLoad.add(targetBatch + 1)
      for (const b of batchesToLoad) {
        firstFramePromises.push(loadAndCacheRowGroup(b, set))
      }
    }
  } else if (mainThreadFallback) {
    firstFramePromises.push(mainThreadFallback())
  }

  if (internal.cameraPool?.isReady()) {
    if (linkRange) {
      firstFramePromises.push(loadAndCacheCameraRowGroup(camTargetBatch, set, { priority: true }))
      const camRest: number[] = []
      const camLast = batchIndexOf(linkRange.f1, internal.cameraNumBatches)
      if (rangeIsNarrow) {
        for (let b = camTargetBatch + 1; b <= camLast; b++) camRest.push(b)
      } else if (camTargetBatch + 1 < internal.cameraNumBatches) {
        camRest.push(camTargetBatch + 1)
      }
      camRest.push(0)
      queueAfterFirstPaint.push(() => {
        for (const b of camRest) {
          if (b >= 0 && b < internal.cameraNumBatches) {
            void loadAndCacheCameraRowGroup(b, set, { priority: true }).catch(() => {})
          }
        }
      })
    } else {
      const camBatchesToLoad = new Set([0, camTargetBatch])
      if (camTargetBatch > 0) camBatchesToLoad.add(camTargetBatch - 1)
      if (camTargetBatch + 1 < internal.cameraNumBatches) camBatchesToLoad.add(camTargetBatch + 1)
      for (const b of camBatchesToLoad) {
        firstFramePromises.push(loadAndCacheCameraRowGroup(b, set))
      }
    }
  }

  await Promise.all(firstFramePromises)
  const rgMs = performance.now() - rgT0
  memLog.snap(`${logLabel}:first-batches-loaded`, {
    note: `${rgMs.toFixed(0)}ms, target frame ${targetFrame}`,
  })

  // Queue the rest of the range (then batch 0). The range batches are
  // flagged priority, so they jump the queue rather than relying on having
  // been queued before the bulk prefetch.
  for (const queue of queueAfterFirstPaint) queue()

  // 2. Show target frame (or frame 0 as fallback)
  const displayFrame = internal.frameCache.has(targetFrame) ? targetFrame : 0
  // If neither is cached yet (a failed target batch), let the frame land as
  // soon as it arrives rather than showing nothing.
  if (!internal.frameCache.has(displayFrame)) internal.pendingSeekFrame = targetFrame
  const firstFrame = internal.frameCache.get(displayFrame)
  if (firstFrame) {
    const camData = internal.cameraImageCache.get(displayFrame)
    set({
      currentFrameIndex: displayFrame,
      currentFrame: {
        ...firstFrame,
        cameraImages: camData ? new Map(camData) : new Map(),
      },
      lastFrameLoadMs: rgMs,
      lastConvertMs: internal.lastConvertMs,
    })
  }

  set({ status: 'ready', loadProgress: 1 })
  memLog.snap(`${logLabel}:first-frame-rendered`, {
    note: `${internal.frameCache.size} frames cached`,
  })

  // Auto-play unless opened via Share URL (has view params)
  const hasViewParams = Object.keys(viewParams).length > 0
  if (!hasViewParams) {
    get().actions.play()
  }

  // 3. Prefetch remaining batches in background
  if (internal.workerPool?.isReady() && !internal.prefetchStarted) {
    internal.prefetchStarted = true
    prefetchAllRowGroups(set, get)
  }
  if (internal.cameraPool?.isReady() && !internal.cameraPrefetchStarted) {
    internal.cameraPrefetchStarted = true
    prefetchAllCameraRowGroups(set)
  }
}

// ---------------------------------------------------------------------------
// Public accessor for internal trajectory data (not reactive — static after load)
// ---------------------------------------------------------------------------

export function getObjectTrajectories() {
  return internal.objectTrajectories
}

/** Check if a laser_object_id has any camera box association */
export function hasLaserAssociation(laserObjectId: string): boolean {
  return internal.assocLaserToCams.has(laserObjectId)
}

/** Per-frame vehicle poses for world-mode trajectory trails */
export function getPoseByFrameIndex(): Map<number, number[]> {
  return internal.poseByFrameIndex
}

// ---------------------------------------------------------------------------
// Thumbnail resolver — used by SearchableSelect for scene preview thumbnails
// ---------------------------------------------------------------------------

/**
 * Build a thumbnail resolver function based on the currently active dataset.
 *
 * Returns an async function that, given a segmentId, produces a direct image
 * URL for the first frame's FRONT camera, or null if not available.
 *
 * - AV2 multi-log: fetches manifest.json per log → extract first FRONT camera ts → JPEG URL
 * - AV2 single-log: extracts from loaded database
 * - nuScenes: extracts from loaded database (first sample's CAM_FRONT)
 * - Waymo: returns null (images locked in Parquet)
 */
/**
 * Split of each discovered AV2 log, for selector badges/filtering.
 * Null when not in AV2 multi-log mode or no split info was discovered.
 */
export function getSegmentSplits(): Map<string, AV2Split> | null {
  const logs = internal.av2DiscoveredLogs
  if (!logs) return null
  const map = new Map<string, AV2Split>()
  for (const log of logs) {
    if (log.split) map.set(log.logId, log.split)
  }
  return map.size > 0 ? map : null
}

/**
 * Whether the currently loaded AV2 log carries annotations.
 * Test-split logs ship without labels; the viewer uses this to say so
 * instead of silently showing no boxes. Null when no AV2 log is loaded.
 */
export function getLoadedAV2HasAnnotations(): boolean | null {
  const db = internal.av2Db
  if (!db) return null
  return db.annotationsByTimestamp.size > 0
}

export function getThumbnailResolver(): ((segmentId: string) => Promise<string | null> | string | null) | null {
  const datasetId = internal.datasetId

  if (datasetId === 'argoverse2') {
    // Multi-log mode: discovered logs have per-log URLs
    if (internal.av2DiscoveredLogs && internal.av2DiscoveredLogs.length > 0) {
      const logMap = new Map(internal.av2DiscoveredLogs.map(l => [l.logId, l]))

      return async (segmentId: string) => {
        // If this is the currently loaded log, try the db first
        if (internal.av2Db && internal.av2Db.logId === segmentId) {
          const frame0Cams = internal.av2Db.cameraFilesByFrame.get(0)
          const front = frame0Cams?.find(c => c.cameraId === 4) // RING_FRONT_CENTER = 4
          if (front && internal.av2SampleFiles) {
            const entry = internal.av2SampleFiles.get(front.filename)
            if (typeof entry === 'string') return entry
          }
        }

        const log = logMap.get(segmentId)
        if (!log) return null

        // index.json mirrors publish a thumbnail per log — no listing needed
        if (log.thumbnailUrl) return log.thumbnailUrl

        // For unloaded logs: S3 ListObjects with max-keys=1 on ring_front_center prefix
        return fetchAV2ThumbnailUrl(log.logUrl)
      }
    }

    // Single-log mode: db is already loaded
    if (internal.av2Db) {
      const db = internal.av2Db
      const sampleFiles = internal.av2SampleFiles
      return (_segmentId: string) => {
        const frame0Cams = db.cameraFilesByFrame.get(0)
        const front = frame0Cams?.find(c => c.cameraId === 4) // RING_FRONT_CENTER = 4
        if (!front || !sampleFiles) return null
        const entry = sampleFiles.get(front.filename)
        return typeof entry === 'string' ? entry : null
      }
    }
  }

  // Sharded nuScenes: the index carries a pre-resized thumbnail per scene
  if (datasetId === 'nuscenes' && internal.nuScenesDiscoveredScenes) {
    const thumbByName = new Map(
      internal.nuScenesDiscoveredScenes.map(s => [s.name, s.thumbnailUrl ?? null]),
    )
    return (sceneName: string) => thumbByName.get(sceneName) ?? null
  }

  if (datasetId === 'nuscenes' && internal.nuScenesDb && internal.nuScenesSampleFiles) {
    const db = internal.nuScenesDb
    const sampleFiles = internal.nuScenesSampleFiles

    return (sceneName: string) => {
      const scene = db.scenes.find(s => s.name === sceneName)
      if (!scene) return null

      // Walk from first_sample_token → find CAM_FRONT sample_data
      const firstSample = db.sampleByToken.get(scene.first_sample_token)
      if (!firstSample) return null

      // Find CAM_FRONT data for this sample
      const sds = db.sampleDataBySample.get(firstSample.token) ?? []
      for (const sd of sds) {
        const calSensor = db.calibratedSensorByToken.get(sd.calibrated_sensor_token)
        if (!calSensor) continue
        const sensor = db.sensorByToken.get(calSensor.sensor_token)
        if (!sensor || sensor.channel !== 'CAM_FRONT') continue

        // sd.filename is like "samples/CAM_FRONT/n015-2018-07-24-11-22-45+0800__CAM_FRONT__1532402927612460.jpg"
        const entry = sampleFiles.get(sd.filename)
        if (typeof entry === 'string') return entry
      }
      return null
    }
  }

  // Waymo: thumbnails not available without loading full Parquet
  return null
}
