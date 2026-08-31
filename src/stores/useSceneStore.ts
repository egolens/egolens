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
  type WaymoParquetFile,
} from '../utils/parquet'
import {
  type LidarCalibration,
  type PointCloud,
} from '../utils/rangeImage'
import type { LidarBatchResult } from '../workers/types'
import type { CameraBatchResult } from '../workers/types'
import { WorkerPool } from '../workers/workerPool'
import type { SegmentMeta } from '../types/waymo'
import type { MetadataBundle } from '../types/dataset'
import { memLog } from '../utils/memoryLogger'
import { DataLoadError, type DataLoadErrorCode } from '../utils/errors'
import { getAdapterById, getManifest, setAdapter } from '../adapters/registry'
import {
  detectNuScenesVersionRoot,
  discoverNuScenesScenes,
  type NuScenesDiscoveredScene,
} from '../adapters/nuscenes/remote'
import type { NuScenesFrameDescriptor, NuScenesRadarFileDescriptor } from '../workers/nuScenesLidarWorker'
import type {
  NuScenesCameraFrameDescriptor,
  NuScenesCameraImageDescriptor,
} from '../workers/nuScenesCameraWorker'
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

import { clearCameraRgbCache } from '../utils/cameraRgbSampler'
import { clearThumbnailCache } from '../hooks/useThumbnailCache'
import { setUrlSource, clearUrlSource, getUrlSource, syncSegmentToUrl, syncWindowToUrl, getInitialSearch, parseViewParams, parseCamerasParam } from '../utils/urlState'
import { resolveWindowToFrames } from '../utils/playbackWindow'
import { getEmbedParams } from '../utils/embedParams'
import { trackSegmentSwitch, trackColormapChange, trackPovSwitch, trackOverlayToggle, trackDatasetLoad } from '../utils/analytics'
import { setKeypointsByFrameRef } from '../components/LidarViewer/KeypointSkeleton'
import { setCameraKeypointsByFrameRef } from '../components/CameraPanel/KeypointOverlay'
import { setCameraSegByFrameRef } from '../components/CameraPanel/CameraSegOverlay'
import { applyTheme, initialTheme, viewportBg, type ThemeName } from '../theme'
import { argoverse2CompiledRecipe, nuScenesCompiledRecipe, waymoCompiledRecipe } from '../adapters/recipes/bundled'
import type { FeatherColumnsParamsV1 } from '../teachable/operators/featherColumns'
import type { ParquetColumnsParamsV1 } from '../teachable/operators/parquetColumns'
import type { CompiledRecipeV1 } from '../teachable/recipe/compiler'
import {
  bindRecipeSceneV1,
  prepareParquetColumnsRuntimeV1,
} from '../teachable/runtime/bindRecipeScene'
import { decodeJsonRecordsV1 } from '../teachable/operators/jsonRecords'
import type { GraphSegmentDescriptorV1 } from '../teachable/runtime/GraphValues'
import { MappedByteSourceV1, type ByteSourceV1 } from '../teachable/source/ByteSource'
import {
  manageNormalizedSceneV1,
  type ManagedNormalizedSceneV1,
} from '../teachable/runtime/ManagedNormalizedScene'
import { bridgeNormalizedFrame } from '../teachable/runtime/compatibilityBridge'
import { markPerformanceEvent, noteFrameRequest } from '../teachable/runtime/performanceProbe'
import type { NormalizedCapabilityV1, NormalizedSceneV1 } from '../teachable/runtime/normalizedScene'

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

function activateAdapter(id: string): void {
  const adapter = getAdapterById(id)
  if (!adapter) throw new DataLoadError(`Dataset adapter "${id}" is not registered.`, 'MANIFEST')
  setAdapter(adapter)
}

const internal = {
  parquetFiles: new Map<string, WaymoParquetFile>(),
  /** Transport-neutral bytes passed to the recipe executor. */
  recipeByteSource: null as ByteSourceV1 | null,
  timestamps: [] as bigint[],
  /** Reverse lookup: timestamp → frame index */
  timestampToFrame: new Map<bigint, number>(),
  lidarBoxByFrame: new Map<unknown, ParquetRow[]>(),
  cameraBoxByFrame: new Map<unknown, ParquetRow[]>(),
  vehiclePoseByFrame: new Map<unknown, ParquetRow[]>(),
  playIntervalId: null as ReturnType<typeof setInterval> | null,
  /** Camera refresh interval — polls for late-arriving camera data during playback */
  cameraRefreshId: null as ReturnType<typeof setInterval> | null,
  cameraPrefetchStarted: false,
  /** Camera batch identities loaded at least once; progress is not LRU residency. */
  cameraLoadedBatchesEver: new Set<number>(),
  /** Prevent duplicate prefetchAllRowGroups calls (React StrictMode) */
  prefetchStarted: false,
  /**
   * Deferred camera-pool init. Camera JPEGs are the biggest allocation in a
   * scene, so when nothing needs the images (strip hidden, no camera
   * colormap, no POV) the pool is never started — the init closure is kept
   * here and run later if something asks for images.
   */
  cameraPoolInit: null as (() => Promise<void>) | null,
  /** Colormap waiting for the first camera images to arrive (see setColormapMode) */
  pendingCameraColormap: false,
  /** Last per-frame conversion time (for performance tracking) */
  lastConvertMs: 0,
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
  /** Raw nuScenes graph sources keyed by unchanged relative path. */
  nuScenesSampleFiles: null as Map<string, File | string> | null,
  /** Scene currently materialized from a sharded remote source. */
  nuScenesLoadedShard: null as string | null,
  /** Discovered per-scene shards from an index.json root (sharded hosting mode) */
  nuScenesDiscoveredScenes: null as NuScenesDiscoveredScene[] | null,
  /** Single metadata root selected by the bounded recipe binder. */
  nuScenesVersionRoot: null as string | null,
  /** Phase 6 authoritative scene: sole owner of workers and transferred frame/image buffers. */
  normalizedScene: null as ManagedNormalizedSceneV1 | null,
  /** One-shot recipe scene factory used only by the isolated conformance capture hook. */
  conformanceSceneFactory: null as ((compiledRecipe?: CompiledRecipeV1) => Promise<NormalizedSceneV1>) | null,
  /**
   * Seek requested before its frame was cached (cold load). loadFrame drops
   * cache misses so it never fights the prefetch queue, which would silently
   * strand a deep link — `?frame=` or a t0/t1 range — at frame 0 while the
   * user waits. Applied by syncCachedFrames once the frame arrives.
   */
  pendingSeekFrame: null as number | null,
  // -- Argoverse 2-specific state --
  /** Active AV2 log identity; graph inputs live exclusively in av2SampleFiles. */
  av2LogId: null as string | null,
  /** AV2 sensor data files keyed by relative path (File for local, string URL for remote) */
  av2SampleFiles: null as Map<string, File | string> | null,
  /** Discovered AV2 logs from parent URL (multi-log mode) */
  av2DiscoveredLogs: null as AV2DiscoveredLog[] | null,
  // -- Waymo-specific remote state --
  /** Base URL for remote Waymo loading (e.g. https://bucket.s3.../waymo_data/) */
  waymoBaseUrl: null as string | null,
}

function resetInternal() {
  internal.normalizedScene?.dispose()
  internal.normalizedScene = null
  internal.conformanceSceneFactory = null
  internal.parquetFiles.clear()
  internal.recipeByteSource = null
  internal.timestamps = []
  internal.pendingSeekFrame = null
  internal.cameraLoadedBatchesEver.clear()
  internal.cameraPoolInit = null
  internal.pendingCameraColormap = false
  internal.timestampToFrame.clear()
  internal.lidarBoxByFrame.clear()
  internal.cameraBoxByFrame.clear()
  internal.vehiclePoseByFrame.clear()
  // Clear decoded camera RGB cache
  clearCameraRgbCache()
  clearThumbnailCache()
  internal.objectTrajectories.clear()
  internal.assocCamToLaser.clear()
  internal.assocLaserToCams.clear()
  internal.poseByFrameIndex.clear()
  internal.worldOriginInverse = null
  internal.prefetchStarted = false
  if (internal.playIntervalId !== null) {
    clearInterval(internal.playIntervalId)
    internal.playIntervalId = null
  }
  if (internal.cameraRefreshId !== null) {
    clearInterval(internal.cameraRefreshId)
    internal.cameraRefreshId = null
  }
  internal.cameraPrefetchStarted = false
  // Segmentation & keypoint caches
  internal.keypointsByFrame.clear()
  setKeypointsByFrameRef(internal.keypointsByFrame)
  internal.cameraKeypointsByFrame.clear()
  setCameraKeypointsByFrameRef(internal.cameraKeypointsByFrame)
  internal.cameraSeg.clear()
  setCameraSegByFrameRef(internal.cameraSeg)
}

// ---------------------------------------------------------------------------
// Managed normalized-scene cache synchronization
// ---------------------------------------------------------------------------

/** Update the cachedFrames state for the buffer bar UI */
function syncCachedFrames(set: (partial: Partial<SceneState>) => void) {
  const indices = [...(internal.normalizedScene?.cachedPointFrames() ?? [])]
  set({ cachedFrames: indices })

  // A deep-linked seek that missed the cache lands here, the moment its
  // frame arrives — otherwise a cold load strands the viewer at frame 0.
  const pending = internal.pendingSeekFrame
  if (pending !== null && internal.normalizedScene?.hasPointFrame(pending)) {
    internal.pendingSeekFrame = null
    void useSceneStore.getState().actions.loadFrame(pending)
  }
}

/** Update the cameraCachedFrames state for the camera buffer lane UI */
function syncCameraCachedFrames(set: (partial: Partial<SceneState>) => void) {
  const indices = [...(internal.normalizedScene?.cachedCameraFrames() ?? [])]
  set({ cameraCachedFrames: indices })

  // A camera colormap held back while images loaded takes effect now
  if (internal.pendingCameraColormap && indices.length > 0) {
    internal.pendingCameraColormap = false
    set({ colormapMode: 'camera' })
  }
}

async function loadRendererFrame(
  scene: ManagedNormalizedSceneV1,
  frameIndex: number,
): Promise<FrameData> {
  const capabilities = rendererFrameCapabilities(scene, frameIndex)
  const frame = await scene.loadFrame(frameIndex, { capabilities })
  return bridgeNormalizedFrame(frame, scene.manifest, internal.timestamps[frameIndex])
}

function rendererFrameCapabilities(
  scene: ManagedNormalizedSceneV1,
  frameIndex: number,
): Set<NormalizedCapabilityV1> {
  const capabilities = new Set(scene.manifest.capabilities)
  // Camera loading is intentionally lazy. A missing camera batch must not
  // block the point-cloud first paint or trigger the delegate's second decoder.
  if (!scene.hasCameraFrame(frameIndex)) capabilities.delete('cameraImages')
  return capabilities
}

function getCachedRendererFrame(
  scene: ManagedNormalizedSceneV1,
  frameIndex: number,
): FrameData | null {
  const frame = scene.getCachedFrame(frameIndex, {
    capabilities: rendererFrameCapabilities(scene, frameIndex),
  })
  return frame ? bridgeNormalizedFrame(frame, scene.manifest, internal.timestamps[frameIndex]) : null
}

function batchIndexForFrame(frame: number, batchCount: number): number {
  if (batchCount <= 0) return 0
  const perBatch = Math.ceil(internal.timestamps.length / batchCount)
  if (perBatch <= 0) return 0
  return Math.min(Math.floor(frame / perBatch), batchCount - 1)
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
    const versionRoot = allFiles.get('__versionRoot__')?.name ?? 'v1.0-mini'

    // Preserve the raw source tree. The scanner reports metadata filenames
    // relative to the selected version root, so restore that public path here.
    const sourceFiles = new Map<string, File>()
    const jsonFiles = new Map<string, File>()
    for (const [path, file] of allFiles) {
      if (path === '__versionRoot__') continue
      if (path.endsWith('.json')) {
        jsonFiles.set(path, file)
        sourceFiles.set(path.includes('/') ? path : `${versionRoot}/${path}`, file)
      } else {
        sourceFiles.set(path, file)
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
    internal.nuScenesSampleFiles = sourceFiles
    internal.nuScenesDiscoveredScenes = null
    internal.nuScenesLoadedShard = null
    internal.nuScenesVersionRoot = versionRoot
    activateAdapter('nuscenes')

    // Execute the same graph once for transport-neutral scene discovery.
    set({ status: 'loading', loadStep: 'parsing' as LoadStep, loadProgress: 0 })
    const graphSegments = await inspectNuScenesGraphSegments(sourceFiles)
    const sceneNames = graphSegments.map((segment) => segment.id).sort()
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
    activateAdapter('argoverse2')

    internal.av2LogId = logId

    // AV2 has a single "scene" per log — use log ID as segment name
    set({ availableSegments: [logId], loadProgress: 0.1 })

    // Auto-select the single log
    await get().actions.selectSegment(logId)
    return
  }

  // Waymo path — store file references for later use by selectSegment
  internal.datasetId = 'waymo'
  internal.nuScenesSampleFiles = null
  internal.nuScenesLoadedShard = null
  internal.nuScenesDiscoveredScenes = null
  internal.av2LogId = null
  internal.av2SampleFiles = null
  internal.av2DiscoveredLogs = null
  internal.waymoBaseUrl = null
  activateAdapter('waymo')
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
      internal.recipeByteSource = new MappedByteSourceV1([...sources].map(([component, source]) => {
        const sourceName = typeof source === 'string'
          ? source.split(/[?#]/u, 1)[0].split('/').at(-1) || `${component}.parquet`
          : source.name
        return [`${component}/${sourceName}`, source] as const
      }))
      markPerformanceEvent('scene-load-start', { dataset: 'waymo' })
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
        await bindParquetComponentScene(set, get)
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
        await runPostWorkerPipeline(set, get, 'waymo')
      } catch (e) {
        failLoad(set, e, 'loadDataset')
      }
    },

    loadFrame: async (frameIndex) => {
      if (frameIndex < 0 || frameIndex >= internal.timestamps.length) return
      const scene = internal.normalizedScene
      if (!scene) return
      noteFrameRequest(scene.sceneGeneration, frameIndex)

      // Point and camera caches have independent byte budgets. A camera batch
      // can be evicted while the requested point frame remains hot, so every
      // seek must restore the missing camera batch independently. Keep this
      // detached from the point first-paint path; loadAndCacheCameraRowGroup
      // patches the displayed frame as soon as the JPEGs arrive.
      if (cameraImagesWanted() && scene.cameraBatchCount > 0 && !scene.hasCameraFrame(frameIndex)) {
        const cameraBatchIndex = batchIndexForFrame(frameIndex, scene.cameraBatchCount)
        void loadAndCacheCameraRowGroup(cameraBatchIndex, set, { priority: true })
      }

      if (!scene.hasPointFrame(frameIndex)) {
        internal.pendingSeekFrame = frameIndex
        const batchIndex = batchIndexForFrame(frameIndex, scene.pointBatchCount)
        void loadAndCacheRowGroup(batchIndex, set, { priority: true })
        return
      }

      const hotFrame = getCachedRendererFrame(scene, frameIndex)
      if (hotFrame) {
        internal.pendingSeekFrame = null
        set({
          currentFrameIndex: frameIndex,
          currentFrame: hotFrame,
          lastFrameLoadMs: 0,
          lastConvertMs: hotFrame.sensorClouds.size > 0 ? get().lastConvertMs : 0,
        })
        return
      }

      try {
        const frame = await loadRendererFrame(scene, frameIndex)
        if (scene !== internal.normalizedScene || scene.disposed) return
        internal.pendingSeekFrame = null
        set({
          currentFrameIndex: frameIndex,
          currentFrame: frame,
          lastFrameLoadMs: 0,
          lastConvertMs: frame.sensorClouds.size > 0 ? get().lastConvertMs : 0,
        })
      } catch (error) {
        if (scene !== internal.normalizedScene || scene.disposed) return
        throw error
      }
    },

    nextFrame: () => get().actions.loadFrame(get().currentFrameIndex + 1),
    prevFrame: () => get().actions.loadFrame(get().currentFrameIndex - 1),
    seekFrame: (index) => get().actions.loadFrame(index),

    play: () => {
      if (get().isPlaying) return
      const startWindow = get().playbackWindow
      const startFrame = get().currentFrameIndex
      if (startWindow && (startFrame < startWindow.f0 || startFrame > startWindow.f1)) {
        // A playback window is a clip, not merely a loop boundary. Starting
        // outside it always begins at the clip's first frame. On a cold cache
        // this records a pending seek; the interval below keeps playback from
        // advancing outside the window while that frame arrives.
        void get().actions.loadFrame(startWindow.f0)
      }
      set({ isPlaying: true })
      const fps = getManifest().frameRate // Waymo=10Hz, nuScenes=2Hz
      const intervalMs = (1000 / fps) / get().playbackSpeed
      internal.playIntervalId = setInterval(async () => {
        const win = get().playbackWindow
        const current = get().currentFrameIndex
        // A cold seek may still be showing its old frame. Hold at the window
        // start rather than walking toward the range from outside it.
        if (win && (current < win.f0 || current > win.f1)) {
          await get().actions.loadFrame(win.f0)
          return
        }
        const next = current + 1
        // Time window: loop inside [f0, f1] instead of running to the end
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
      // are available in the managed normalized image cache.
      internal.cameraRefreshId = setInterval(() => {
        const fi = get().currentFrameIndex
        const currentFrame = get().currentFrame
        if (!currentFrame) return
        const scene = internal.normalizedScene
        if (!scene?.hasCameraFrame(fi)) return
        // Skip if camera count hasn't changed (already up-to-date)
        void loadRendererFrame(scene, fi).then((frame) => {
          if (scene !== internal.normalizedScene) return
          if (currentFrame.cameraImages.size === frame.cameraImages.size) return
          set({ currentFrame: frame })
        }).catch(() => {})
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
      if (mode === 'camera' && (internal.normalizedScene?.cachedCameraFrames().length ?? 0) === 0 && internal.cameraPoolInit) {
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
      if (internal.datasetId === 'nuscenes' && (internal.nuScenesSampleFiles || internal.nuScenesDiscoveredScenes)) {
        activateAdapter('nuscenes')
      } else if (internal.datasetId === 'argoverse2' && internal.av2LogId) {
        activateAdapter('argoverse2')
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
            && internal.nuScenesLoadedShard !== segmentId) {
          const entry = internal.nuScenesDiscoveredScenes.find(s => s.name === segmentId)
          if (!entry) throw new Error(`nuScenes scene not found: ${segmentId}`)

          set({ status: 'loading', loadStep: 'opening' as LoadStep, loadProgress: 0, error: null })
          try {
            const { sourceFiles, versionRoot, segments } = await fetchNuScenesVersionData(entry.sceneUrl, set)
            if (!segments.some((segment) => segment.id === segmentId)) throw new Error(`nuScenes scene not found: ${segmentId}`)
            internal.nuScenesSampleFiles = sourceFiles
            internal.nuScenesVersionRoot = versionRoot
            internal.nuScenesLoadedShard = segmentId
          } catch (e) {
            failLoad(set, e, 'selectSegment:nuScenesShard')
            return
          }
        }

        if (internal.nuScenesSampleFiles) {
          await loadRelationalGraphScene(segmentId, set, get)
          syncSegmentToUrl(segmentId, get().playbackWindow)
          return
        }
      }

      if (internal.datasetId === 'argoverse2') {
        // Multi-log mode: if switching to a different log, load it from URL first
        if (internal.av2DiscoveredLogs && internal.av2LogId !== segmentId) {
          const logEntry = internal.av2DiscoveredLogs.find(l => l.logId === segmentId)
          if (!logEntry) throw new Error(`AV2 log not found: ${segmentId}`)

          set({ status: 'loading', loadStep: 'opening' as LoadStep, loadProgress: 0, error: null })

          const manifest = await fetchAV2Manifest(logEntry.logUrl)
          const { logId, fileEntries } = await loadAV2FromUrl(logEntry.logUrl, manifest, (p) => {
            set({ loadProgress: p * 0.2 })
          })

          const sampleFiles = new Map<string, string>()
          for (const [filename, url] of fileEntries) {
            sampleFiles.set(filename, url)
          }

          internal.av2LogId = logId
          internal.av2SampleFiles = sampleFiles
        }

        if (internal.av2LogId) {
          await loadFeatherLogScene(segmentId, set, get)
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
                internal.av2LogId = null
                internal.av2SampleFiles = null
                internal.nuScenesSampleFiles = null
                internal.nuScenesLoadedShard = null
                internal.nuScenesDiscoveredScenes = null
                activateAdapter('argoverse2')
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
            internal.av2LogId = null
            internal.av2SampleFiles = null
            internal.nuScenesSampleFiles = null
            internal.nuScenesLoadedShard = null
            internal.nuScenesDiscoveredScenes = null
            activateAdapter('argoverse2')

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

          // 2. Discover the unchanged URL-backed source inventory
          const { logId, fileEntries } = await loadAV2FromUrl(baseUrl, manifest, (p) => {
            set({ loadProgress: 0.05 + p * 0.15 }) // 0.05 → 0.20
          })

          // 3. Build URL-based sample files map for workers
          const sampleFiles = new Map<string, string>()
          for (const [filename, url] of fileEntries) {
            sampleFiles.set(filename, url)
          }

          // 4. Initialize AV2 graph-source state (same as local mode)
          internal.datasetId = 'argoverse2'
          internal.av2LogId = logId
          internal.av2SampleFiles = sampleFiles
          internal.nuScenesSampleFiles = null
          internal.nuScenesLoadedShard = null
          internal.nuScenesDiscoveredScenes = null
          activateAdapter('argoverse2')

          // AV2 has a single "scene" per log
          set({ availableSegments: [logId], loadProgress: 0.2 })

          // 5. Load scene (metadata → batches → workers → pipeline)
          await get().actions.selectSegment(logId)
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
              const { sourceFiles, versionRoot, segments } = await fetchNuScenesVersionData(sceneUrl, set)
              if (segments.some((segment) => segment.id === initialScene)) {
                console.log(`[loadFromUrl] nuScenes direct scene: ${sceneUrl}`)
                internal.datasetId = 'nuscenes'
                internal.nuScenesDiscoveredScenes = [{ name: initialScene, sceneUrl }]
                internal.nuScenesSampleFiles = sourceFiles
                internal.nuScenesLoadedShard = initialScene
                internal.nuScenesVersionRoot = versionRoot
                activateAdapter('nuscenes')
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
            internal.nuScenesSampleFiles = null
            internal.nuScenesLoadedShard = null
            activateAdapter('nuscenes')

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
          activateAdapter('nuscenes')

          const { sourceFiles, versionRoot, segments } = await fetchNuScenesVersionData(baseUrl, set)
          internal.nuScenesSampleFiles = sourceFiles
          internal.nuScenesLoadedShard = null
          internal.nuScenesVersionRoot = versionRoot

          // Set available scenes and auto-select first
          const sceneNames = segments.map((segment) => segment.id).sort()
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
          internal.nuScenesSampleFiles = null
          internal.nuScenesLoadedShard = null
          internal.nuScenesDiscoveredScenes = null
          internal.av2LogId = null
          internal.av2SampleFiles = null
          internal.av2DiscoveredLogs = null
          activateAdapter('waymo')

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

/** Load entire row group via Worker and cache all its frames. */
async function loadAndCacheRowGroup(
  rgIndex: number,
  set: (partial: Partial<SceneState>) => void,
  opts?: { priority?: boolean },
): Promise<void> {
  const scene = internal.normalizedScene
  if (!scene || scene.loadedPointBatches().has(rgIndex)) return
  try {
    await scene.loadPointBatch(rgIndex, opts)
    if (scene !== internal.normalizedScene) return
    const snapshot = scene.snapshotPerformance()
    internal.lastConvertMs = scene.lastConvertMs
    memLog.snap(`cache:point-batch${rgIndex}`, {
      dataSize: snapshot.cache.pointBytes,
      note: `${snapshot.cache.pointFrames} frames retained by normalized scene`,
    })
    syncCachedFrames(set)
  } catch (error) {
    if (scene === internal.normalizedScene && !scene.disposed) throw error
  }
}

async function bindParquetComponentScene(set: (partial: Partial<SceneState>) => void, get: () => SceneState) {
  // Read the lightweight metadata tables before the managed worker path starts.
  if (!internal.recipeByteSource) throw new Error('RECIPE_BYTE_SOURCE_MISSING: Waymo source was not initialized.')
  const binding = await bindRecipeSceneV1({
    compiledRecipe: waymoCompiledRecipe,
    source: internal.recipeByteSource,
    preparation: prepareParquetColumnsRuntimeV1(internal.parquetFiles),
  })
  const bundle = binding.metadata
  const conformanceFiles = new Map(internal.parquetFiles)
  const conformanceSource = internal.recipeByteSource
  internal.conformanceSceneFactory = async (compiledRecipe = waymoCompiledRecipe) => (await bindRecipeSceneV1({
    compiledRecipe,
    source: conformanceSource,
    preparation: prepareParquetColumnsRuntimeV1(conformanceFiles),
    metadataBundle: bundle,
  })).scene
  internal.normalizedScene?.dispose()
  internal.normalizedScene = manageNormalizedSceneV1(binding.scene, {
    workerTimestamps: bundle.timestamps,
  })
  for (const diagnostic of binding.diagnostics) {
    console.info(`[Waymo recipe] ${diagnostic.code}: ${diagnostic.hint}`)
  }

  // Unpack bundle into internal state
  applyMetadataBundle({
    ...bundle,
    hasBoxData: binding.scene.manifest.capabilities.has('boxes3d'),
    hasSegmentation: binding.scene.manifest.capabilities.has('lidarSegmentation'),
    hasKeypoints: binding.scene.manifest.capabilities.has('keypoints3d')
      || binding.scene.manifest.capabilities.has('keypoints2d'),
    hasCameraSegmentation: binding.scene.manifest.capabilities.has('cameraSegmentation'),
  }, set, get)
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
  const owner = internal.normalizedScene
  if (!lidarSource || !owner) return

  const pool = new WorkerPool<Record<string, unknown>, LidarBatchResult>(
    WORKER_CONCURRENCY,
    () => new Worker(new URL('../workers/waymoLidarWorker.ts', import.meta.url), { type: 'module' }),
  )
  // Ownership begins before asynchronous initialization so a scene switch can
  // terminate workers that have not emitted their ready message yet.
  owner.attachPointPool(pool, 0)
  // Pass segmentation parquet URL if available (Phase A worker protocol)
  const segSource = internal.parquetFiles.has('lidar_segmentation')
    ? sources.get('lidar_segmentation')
    : undefined
  const { numBatches } = await pool.init({
    lidarUrl: lidarSource,
    calibrationEntries: [...get().lidarCalibrations.entries()],
    lidarReaderParams: waymoCompiledRecipe.recipe.sources.lidarRows.params as unknown as ParquetColumnsParamsV1,
    ...(segSource ? {
      segUrl: segSource,
      segReaderParams: waymoCompiledRecipe.recipe.sources.lidarSegmentationRows.params as unknown as ParquetColumnsParamsV1,
    } : {}),
  })

  if (owner !== internal.normalizedScene || owner.disposed) {
    pool.terminate()
    return
  }
  owner.attachPointPool(pool, numBatches)
}

/** Initialize camera worker pool (separate from lidar pool) */
async function initCameraWorker(
  sources: Map<string, File | string>,
) {
  const cameraSource = sources.get('camera_image')
  const owner = internal.normalizedScene
  if (!cameraSource || !internal.parquetFiles.has('camera_image') || !owner) return

  const start = async () => {
  const pool = new WorkerPool<Record<string, unknown>, CameraBatchResult>(
    2,
    () => new Worker(new URL('../workers/waymoCameraWorker.ts', import.meta.url), { type: 'module' }),
  )
  owner.attachCameraPool(pool, 0)
  const { numBatches } = await pool.init({
    cameraUrl: cameraSource,
    cameraReaderParams: waymoCompiledRecipe.recipe.sources.cameraImageRows.params as unknown as ParquetColumnsParamsV1,
  })

  if (owner !== internal.normalizedScene || owner.disposed) {
    pool.terminate()
    return
  }
  owner.attachCameraPool(pool, numBatches)
  useSceneStore.setState({ cameraTotalCount: numBatches })
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
 * Produce the bounded, transport-neutral inventory consumed by the graph
 * runtime. URL entries deliberately report an unknown size; the byte source
 * applies the same limits while reading them.
 */
function graphInventoryEntries(files: ReadonlyMap<string, File | string>) {
  return [...files].map(([path, value]) => ({
    path,
    size: typeof value === 'string' ? null : value.size,
  }))
}

/** Execute the bundled graph to discover its public segment index. */
async function inspectNuScenesGraphSegments(
  sourceFiles: ReadonlyMap<string, File | string>,
): Promise<readonly GraphSegmentDescriptorV1[]> {
  const binding = await bindRecipeSceneV1({
    compiledRecipe: nuScenesCompiledRecipe,
    source: new MappedByteSourceV1(sourceFiles),
    inventoryEntries: graphInventoryEntries(sourceFiles),
  })
  try {
    if (binding.availableSegments) return binding.availableSegments
    return binding.scene.index.segments.map((segment) => ({
      groupId: segment.id,
      id: segment.id,
      label: segment.label,
      metadata: segment.metadata,
    }))
  } finally {
    binding.scene.dispose()
  }
}

/**
 * Fetch one nuScenes version directory as unchanged graph inputs. Works for a
 * classic full directory (v1.0-mini) and a per-scene shard alike.
 */
async function fetchNuScenesVersionData(
  baseUrl: string,
  set: (partial: Partial<SceneState>) => void,
): Promise<{
  sourceFiles: Map<string, File | string>
  versionRoot: string
  segments: readonly GraphSegmentDescriptorV1[]
}> {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  // 1. Auto-detect split by probing known metadata paths
  const detectedSplit = await detectNuScenesVersionRoot(root)
  console.log(`[loadFromUrl] nuScenes detected: ${detectedSplit}`)
  set({ loadProgress: 0.05 })

  // Same string-limit guard as the local path — enforced only when the server
  // reports a size, so hosts without content-length still load normally.
  const head = await fetch(`${root}${detectedSplit}/sample_data.json`, { method: 'HEAD' })
    .catch(() => null)
  const tableBytes = Number(head?.headers.get('content-length') ?? 0)
  if (tableBytes > NUSCENES_TABLE_SIZE_LIMIT) {
    throw new Error(
      `sample_data.json is ${(tableBytes / 1e9).toFixed(1)}GB — full-split nuScenes metadata `
      + 'is too large for a browser to parse. Shard it per scene with '
      + 'scripts/shard_nuscenes.py (see docs/NUSCENES_FULL_HOSTING.md) and load the shard root instead.',
    )
  }

  // 2. Fetch metadata JSONs and preserve their public paths for source binding.
  const metaBase = `${root}${detectedSplit}/`
  const jsonFileNames = [
    'scene.json', 'sample.json', 'sample_data.json', 'ego_pose.json',
    'sample_annotation.json', 'calibrated_sensor.json', 'sensor.json',
    'instance.json', 'category.json', 'log.json',
    'lidarseg.json', 'panoptic.json', 'attribute.json', 'visibility.json',
  ]

  const jsonTexts = new Map<string, string>()
  const sourceFiles = new Map<string, File | string>()
  const fetchResults = await Promise.allSettled(
    jsonFileNames.map(async (name) => {
      const res = await fetch(`${metaBase}${name}`)
      if (res.ok) {
        const bytes = await res.arrayBuffer()
        sourceFiles.set(
          `${detectedSplit}/${name}`,
          new File([bytes], name, { type: 'application/json' }),
        )
        if (name === 'sample_data.json' || name === 'lidarseg.json' || name === 'panoptic.json') {
          jsonTexts.set(name, new TextDecoder().decode(bytes))
        }
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

  // 3. Add unchanged payload paths referenced by the relational tables.
  const sampleDataText = jsonTexts.get('sample_data.json')
  if (sampleDataText) {
    for (const entry of decodeJsonRecordsV1<{ filename?: unknown }>(sampleDataText)) {
      if (typeof entry.filename === 'string' && entry.filename.length > 0) {
        sourceFiles.set(entry.filename, `${root}${entry.filename}`)
      }
    }
  }
  for (const segTable of ['lidarseg.json', 'panoptic.json']) {
    const text = jsonTexts.get(segTable)
    if (text) {
      for (const entry of decodeJsonRecordsV1<{ filename?: unknown }>(text)) {
        if (typeof entry.filename === 'string' && entry.filename.length > 0) {
          sourceFiles.set(entry.filename, `${root}${entry.filename}`)
        }
      }
    }
  }
  console.log(`[loadFromUrl] nuScenes graph inventory: ${sourceFiles.size} entries`)

  // 4. Scene discovery is itself a graph result; no provider-specific DB is prepared.
  const segments = await inspectNuScenesGraphSegments(sourceFiles)
  console.log(`[loadFromUrl] nuScenes graph indexed: ${segments.length} scenes`)
  set({ loadProgress: 0.2 })

  return { sourceFiles, versionRoot: detectedSplit, segments }
}

async function loadRelationalGraphScene(
  sceneName: string,
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
) {
  if (!internal.nuScenesSampleFiles) {
    throw new Error('nuScenes graph source not loaded')
  }

  set({
    status: 'loading',
    error: null,
    loadProgress: 0,
    loadStep: 'parsing' as LoadStep,
    availableComponents: ['samples', internal.nuScenesVersionRoot ?? 'v1.0-mini'],
    cachedFrames: [],
  })

  try {
    markPerformanceEvent('scene-load-start', { dataset: 'nuscenes', scene: sceneName })
    memLog.snap('nuscenes:scene-start', { note: sceneName })

    // 1. Execute the public graph and assemble its selected scene.
    const inventoryEntries = graphInventoryEntries(internal.nuScenesSampleFiles)
    const binding = await bindRecipeSceneV1({
      compiledRecipe: nuScenesCompiledRecipe,
      source: new MappedByteSourceV1(internal.nuScenesSampleFiles),
      sceneId: sceneName,
      inventoryEntries,
    })
    const bundle = binding.metadata
    const conformanceFiles = new Map(internal.nuScenesSampleFiles)
    const conformanceSource = new MappedByteSourceV1(conformanceFiles)
    internal.conformanceSceneFactory = async (compiledRecipe = nuScenesCompiledRecipe) => (await bindRecipeSceneV1({
      compiledRecipe,
      source: conformanceSource,
      sceneId: sceneName,
      inventoryEntries: graphInventoryEntries(conformanceFiles),
    })).scene
    internal.normalizedScene?.dispose()
    internal.normalizedScene = manageNormalizedSceneV1(binding.scene, {
      workerTimestamps: bundle.timestamps,
    })
    for (const diagnostic of binding.diagnostics) {
      console.info(`[nuScenes recipe] ${diagnostic.code}: ${diagnostic.hint}`)
    }
    set({ loadProgress: 0.2 })

    // 2. Extract frame batch info BEFORE applying bundle
    //    (vehiclePoseByFrame contains sensor file paths for nuScenes)
    const { lidarBatches, cameraBatches } = buildNuScenesFrameBatches(bundle)

    // 3. Apply metadata bundle to internal state
    applyMetadataBundle({
      ...bundle,
      hasBoxData: binding.scene.manifest.capabilities.has('boxes3d'),
      hasSegmentation: binding.scene.manifest.capabilities.has('lidarSegmentation'),
    }, set, get)
    set({ loadProgress: 0.3 })
    memLog.snap('nuscenes:metadata-applied', {
      note: `${bundle.timestamps.length} frames, ${lidarBatches.length} lidar batches, ${cameraBatches.length} camera batches`,
    })

    // 4. Init nuScenes workers in parallel
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

    // 5. Load first frames, display, and prefetch remaining
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
  const owner = internal.normalizedScene
  if (!internal.nuScenesSampleFiles || batches.length === 0 || !owner) return

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
  owner.attachPointPool(pool, 0)
  const { numBatches } = await pool.init({
    frameBatches: batches,
    fileEntries,
    lidarExtrinsic,
    radarExtrinsics,
  })

  if (owner !== internal.normalizedScene || owner.disposed) {
    pool.terminate()
    return
  }
  owner.attachPointPool(pool, numBatches)
}

/** Init nuScenes camera worker pool with pre-built frame batches + file entries. */
async function initNuScenesCameraWorker(
  batches: NuScenesCameraFrameDescriptor[][],
) {
  const owner = internal.normalizedScene
  if (!internal.nuScenesSampleFiles || batches.length === 0 || !owner) return

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
    owner.attachCameraPool(pool, 0)
    const { numBatches } = await pool.init({
      frameBatches: batches,
      fileEntries,
    })

    if (owner !== internal.normalizedScene || owner.disposed) {
      pool.terminate()
      return
    }
    owner.attachCameraPool(pool, numBatches)
    useSceneStore.setState({ cameraTotalCount: numBatches })
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

async function loadFeatherLogScene(
  logId: string,
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
) {
  if (!internal.av2LogId || !internal.av2SampleFiles) {
    throw new Error('AV2 graph source not loaded')
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
    markPerformanceEvent('scene-load-start', { dataset: 'argoverse2', scene: logId })
    memLog.snap('av2:scene-start', { note: logId })

    // 1. Load metadata → MetadataBundle
    const inventoryEntries = [...internal.av2SampleFiles].map(([path, value]) => ({
      path,
      size: typeof value === 'string' ? null : value.size,
    }))
    const binding = await bindRecipeSceneV1({
      compiledRecipe: argoverse2CompiledRecipe,
      source: new MappedByteSourceV1(internal.av2SampleFiles),
      sceneId: logId,
      inventoryEntries,
    })
    const bundle = binding.metadata
    const conformanceFiles = new Map(internal.av2SampleFiles)
    const conformanceSource = new MappedByteSourceV1(conformanceFiles)
    internal.conformanceSceneFactory = async (compiledRecipe = argoverse2CompiledRecipe) => (await bindRecipeSceneV1({
      compiledRecipe,
      source: conformanceSource,
      sceneId: logId,
      inventoryEntries,
    })).scene
    internal.normalizedScene?.dispose()
    internal.normalizedScene = manageNormalizedSceneV1(binding.scene, {
      workerTimestamps: bundle.timestamps,
    })
    for (const diagnostic of binding.diagnostics) {
      console.info(`[AV2 recipe] ${diagnostic.code}: ${diagnostic.hint}`)
    }
    set({ loadProgress: 0.2 })

    // 2. Extract frame batch info BEFORE applying bundle
    const { lidarBatches, cameraBatches } = buildAV2FrameBatches(bundle)

    // 3. Apply metadata bundle to internal state
    applyMetadataBundle({
      ...bundle,
      hasBoxData: binding.scene.manifest.capabilities.has('boxes3d'),
    }, set, get)
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
  const owner = internal.normalizedScene
  if (!internal.av2SampleFiles || batches.length === 0 || !owner) return

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
  owner.attachPointPool(pool, 0)
  const { numBatches } = await pool.init({
    frameBatches: batches,
    fileEntries,
    readerParams: argoverse2CompiledRecipe.recipe.sources.lidarFrames.params as unknown as FeatherColumnsParamsV1,
  })

  if (owner !== internal.normalizedScene || owner.disposed) {
    pool.terminate()
    return
  }
  owner.attachPointPool(pool, numBatches)
}

/** Init AV2 camera worker pool */
async function initAV2CameraWorker(batches: AV2CameraFrameDescriptor[][]) {
  const owner = internal.normalizedScene
  if (!internal.av2SampleFiles || batches.length === 0 || !owner) return

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
    owner.attachCameraPool(pool, 0)
    const { numBatches } = await pool.init({
      frameBatches: batches,
      fileEntries,
    })

    if (owner !== internal.normalizedScene || owner.disposed) {
      pool.terminate()
      return
    }
    owner.attachCameraPool(pool, numBatches)
    useSceneStore.setState({ cameraTotalCount: numBatches })
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
 * Guarded by the managed-scene owner identity: an await here can outlive the
 * scene that queued it, but may never attach work to its replacement.
 */
async function ensureCameraPool(set: (partial: Partial<SceneState>) => void): Promise<void> {
  const scene = internal.normalizedScene
  const init = internal.cameraPoolInit
  if (!scene || scene.cameraBatchCount > 0 || !init) return
  internal.cameraPoolInit = null

  try {
    await init()
  } catch (e) {
    console.warn('[camera] deferred init failed:', e)
    return
  }
  if (scene !== internal.normalizedScene || scene.cameraBatchCount <= 0) return

  // Load the batch the viewer is actually on first — a plain prefetch would
  // start at batch 0 and hand the user images for every frame but theirs.
  const state = useSceneStore.getState()
  const perBatch = scene.cameraBatchCount > 0
    ? Math.ceil(internal.timestamps.length / scene.cameraBatchCount)
    : internal.timestamps.length
  const visibleBatch = perBatch > 0
    ? Math.min(Math.floor(state.currentFrameIndex / perBatch), scene.cameraBatchCount - 1)
    : 0
  await loadAndCacheCameraRowGroup(visibleBatch, set, { priority: true }).catch(() => {})

  if (scene !== internal.normalizedScene || scene.disposed) return
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
  const scene = internal.normalizedScene
  if (!scene || scene.loadedCameraBatches().has(rgIndex)) return
  try {
    await scene.loadCameraBatch(rgIndex, opts)
    if (scene !== internal.normalizedScene) return
    internal.cameraLoadedBatchesEver.add(rgIndex)

    // Update camera loading progress + buffer bar, and patch current frame
    // if new camera images arrived for it.  Merged into a single set() to
    // avoid triggering two separate React re-render cycles.
    syncCameraCachedFrames(set)
    const state = useSceneStore.getState()
    const fi = state.currentFrameIndex
    const currentFrame = state.currentFrame
    const loadedCount = internal.cameraLoadedBatchesEver.size
    if (scene.hasPointFrame(fi) && scene.hasCameraFrame(fi)) {
      const frame = await loadRendererFrame(scene, fi)
      if (scene !== internal.normalizedScene) return
      const needsFramePatch = !currentFrame || currentFrame.cameraImages.size !== frame.cameraImages.size
      set({
        cameraLoadedCount: loadedCount,
        ...(needsFramePatch ? { currentFrame: frame } : {}),
      })
    } else {
      set({ cameraLoadedCount: loadedCount })
    }
  } catch (e) {
    if (scene === internal.normalizedScene && !scene.disposed) {
      console.error(`[CameraPool] Failed to load batch ${rgIndex}:`, e)
    }
  }
}

/** Prefetch all camera row groups in parallel */
async function prefetchAllCameraRowGroups(
  set: (partial: Partial<SceneState>) => void,
) {
  const scene = internal.normalizedScene
  if (!scene) return
  const promises: Promise<void>[] = []
  for (let rg = 0; rg < scene.cameraBatchCount; rg++) {
    if (scene.loadedCameraBatches().has(rg)) continue
    promises.push(
      loadAndCacheCameraRowGroup(rg, set).catch(() => {}),
    )
  }
  await Promise.all(promises)
  if (scene !== internal.normalizedScene) return

  const snapshot = scene.snapshotPerformance()
  memLog.snap('prefetch:camera-complete', {
    dataSize: snapshot.cache.cameraBytes,
    note: `${snapshot.cache.cameraFrames} camera frames retained`,
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
  const scene = internal.normalizedScene
  if (!scene) return
  const promises: Promise<void>[] = []

  for (let rg = 0; rg < scene.pointBatchCount; rg++) {
    if (scene.loadedPointBatches().has(rg)) continue

    promises.push(
      loadAndCacheRowGroup(rg, set).catch(() => {
        // Non-critical: prefetch failure doesn't block user interaction
      }),
    )
  }

  await Promise.all(promises)
  if (scene !== internal.normalizedScene) return

  const snapshot = scene.snapshotPerformance()
  memLog.snap('prefetch:lidar-complete', {
    dataSize: snapshot.cache.pointBytes,
    note: `${snapshot.cache.pointFrames} point frames retained`,
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
 */
async function runPostWorkerPipeline(
  set: (partial: Partial<SceneState>) => void,
  get: () => SceneState,
  logLabel: string,
): Promise<void> {
  const scene = internal.normalizedScene
  if (!scene) throw new Error('Normalized scene is not bound.')
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

  const targetBatch = batchIndexForFrame(targetFrame, scene.pointBatchCount)
  const camTargetBatch = batchIndexForFrame(targetFrame, scene.cameraBatchCount)

  // Past a few batches, prioritising the range is the same as prioritising
  // everything — so a wide range keeps the ordinary behaviour.
  const RANGE_BATCH_CAP = 3
  const rangeLastBatch = linkRange ? batchIndexForFrame(linkRange.f1, scene.pointBatchCount) : targetBatch
  const rangeIsNarrow = linkRange != null && rangeLastBatch - targetBatch + 1 <= RANGE_BATCH_CAP

  set({ loadStep: 'first-frame' as LoadStep })
  const rgT0 = performance.now()
  const firstFramePromises: Promise<void>[] = []
  /** Queued right after the critical path — ordering only, never awaited. */
  const queueAfterFirstPaint: (() => void)[] = []

  if (scene.pointBatchCount > 0) {
    if (linkRange) {
      // Critical path is the range's own first batch. Batch 0 is dead weight
      // for a link that points elsewhere, so it drops to the background —
      // this makes the first paint faster than the no-range case, not slower.
      firstFramePromises.push(loadAndCacheRowGroup(targetBatch, set, { priority: true }))
      const rest: number[] = []
      if (rangeIsNarrow) {
        for (let b = targetBatch + 1; b <= rangeLastBatch; b++) rest.push(b)
      } else if (targetBatch + 1 < scene.pointBatchCount) {
        rest.push(targetBatch + 1)
      }
      rest.push(0)
      queueAfterFirstPaint.push(() => {
        for (const b of rest) {
          if (b >= 0 && b < scene.pointBatchCount && !scene.loadedPointBatches().has(b)) {
            void loadAndCacheRowGroup(b, set, { priority: true }).catch(() => {})
          }
        }
      })
    } else {
      const batchesToLoad = new Set([0, targetBatch])
      // Also load neighbor batch for smoother playback from target
      if (targetBatch > 0) batchesToLoad.add(targetBatch - 1)
      if (targetBatch + 1 < scene.pointBatchCount) batchesToLoad.add(targetBatch + 1)
      for (const b of batchesToLoad) {
        firstFramePromises.push(loadAndCacheRowGroup(b, set))
      }
    }
  }

  if (scene.cameraBatchCount > 0) {
    if (linkRange) {
      firstFramePromises.push(loadAndCacheCameraRowGroup(camTargetBatch, set, { priority: true }))
      const camRest: number[] = []
      const camLast = batchIndexForFrame(linkRange.f1, scene.cameraBatchCount)
      if (rangeIsNarrow) {
        for (let b = camTargetBatch + 1; b <= camLast; b++) camRest.push(b)
      } else if (camTargetBatch + 1 < scene.cameraBatchCount) {
        camRest.push(camTargetBatch + 1)
      }
      camRest.push(0)
      queueAfterFirstPaint.push(() => {
        for (const b of camRest) {
          if (b >= 0 && b < scene.cameraBatchCount) {
            void loadAndCacheCameraRowGroup(b, set, { priority: true }).catch(() => {})
          }
        }
      })
    } else {
      const camBatchesToLoad = new Set([0, camTargetBatch])
      if (camTargetBatch > 0) camBatchesToLoad.add(camTargetBatch - 1)
      if (camTargetBatch + 1 < scene.cameraBatchCount) camBatchesToLoad.add(camTargetBatch + 1)
      for (const b of camBatchesToLoad) {
        firstFramePromises.push(loadAndCacheCameraRowGroup(b, set))
      }
    }
  }

  await Promise.all(firstFramePromises)
  if (scene !== internal.normalizedScene || scene.disposed) return
  const rgMs = performance.now() - rgT0
  memLog.snap(`${logLabel}:first-batches-loaded`, {
    note: `${rgMs.toFixed(0)}ms, target frame ${targetFrame}`,
  })

  // Queue the rest of the range (then batch 0). The range batches are
  // flagged priority, so they jump the queue rather than relying on having
  // been queued before the bulk prefetch.
  for (const queue of queueAfterFirstPaint) queue()

  // 2. Show target frame (or frame 0 as fallback)
  const displayFrame = scene.hasPointFrame(targetFrame) ? targetFrame : 0
  noteFrameRequest(scene.sceneGeneration, displayFrame)
  // If neither is cached yet (a failed target batch), let the frame land as
  // soon as it arrives rather than showing nothing.
  if (!scene.hasPointFrame(displayFrame)) internal.pendingSeekFrame = targetFrame
  if (scene.hasPointFrame(displayFrame)) {
    const firstFrame = await loadRendererFrame(scene, displayFrame)
    if (scene !== internal.normalizedScene || scene.disposed) return
    set({
      currentFrameIndex: displayFrame,
      currentFrame: firstFrame,
      lastFrameLoadMs: rgMs,
      lastConvertMs: internal.lastConvertMs,
    })
  }

  set({ status: 'ready', loadProgress: 1 })
  markPerformanceEvent('dataset-ready', { dataset: logLabel, sceneGeneration: scene.sceneGeneration })
  memLog.snap(`${logLabel}:first-frame-rendered`, {
    note: `${scene.cachedPointFrames().length} frames cached`,
  })

  // Auto-play unless opened via Share URL (has view params)
  const hasViewParams = Object.keys(viewParams).length > 0
  if (!hasViewParams) {
    get().actions.play()
  }

  // 3. Prefetch remaining batches in background
  if (scene.pointBatchCount > 0 && !internal.prefetchStarted) {
    internal.prefetchStarted = true
    prefetchAllRowGroups(set, get)
  }
  if (scene.cameraBatchCount > 0 && !internal.cameraPrefetchStarted) {
    internal.cameraPrefetchStarted = true
    prefetchAllCameraRowGroups(set)
  }
}

// ---------------------------------------------------------------------------
// Public accessor for internal trajectory data (not reactive — static after load)
// ---------------------------------------------------------------------------

export function getActiveConformanceDescriptor(): {
  readonly datasetId: string
  readonly frameCount: number
  readonly capabilities: readonly NormalizedCapabilityV1[]
} | null {
  const scene = internal.normalizedScene
  if (!scene || scene.disposed || !internal.conformanceSceneFactory) return null
  return {
    datasetId: scene.manifest.id,
    frameCount: scene.index.timestampsMicros.length,
    capabilities: [...scene.manifest.capabilities].sort(),
  }
}

export async function createActiveConformanceScene(
  compiledRecipe?: CompiledRecipeV1,
): Promise<NormalizedSceneV1> {
  const factory = internal.conformanceSceneFactory
  if (!factory) throw new Error('No active conformance scene is available.')
  return factory(compiledRecipe)
}

/**
 * Present one frame produced by an isolated conformance scene in the ordinary
 * renderer. This is deliberately outside Zustand's production cache owner:
 * Adapter Amnesia owns and disposes the scene, while the store receives only
 * the public normalized-frame projection needed for perceptual capture.
 */
export async function presentConformanceFrame(
  scene: NormalizedSceneV1,
  index: number,
): Promise<number> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= scene.index.timestampsMicros.length) {
    throw new RangeError(`Conformance frame ${index} is out of range.`)
  }
  const frame = await scene.loadFrame(index, {
    capabilities: new Set(scene.manifest.capabilities),
  })
  const rendererTimestamp = internal.timestamps[index] ?? frame.timestampMicros
  useSceneStore.setState({
    currentFrameIndex: index,
    currentFrame: bridgeNormalizedFrame(frame, scene.manifest, rendererTimestamp),
  })
  return index
}

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
  if (internal.datasetId !== 'argoverse2' || !internal.av2LogId) return null
  return internal.lidarBoxByFrame.size > 0
}

function loadedAV2FrontThumbnail(): string | null {
  if (!internal.av2SampleFiles || internal.timestamps.length === 0) return null
  const files = internal.vehiclePoseByFrame.get(internal.timestamps[0]) ?? []
  const front = files.find((entry) => entry.modality === 'camera' && entry.sensorId === 4)
  const backing = front ? internal.av2SampleFiles.get(String(front.filename)) : undefined
  return typeof backing === 'string' ? backing : null
}

function loadedNuScenesFrontThumbnail(): string | null {
  if (!internal.nuScenesSampleFiles || internal.timestamps.length === 0) return null
  const files = internal.vehiclePoseByFrame.get(internal.timestamps[0]) ?? []
  const front = files.find((entry) => entry.modality === 'camera' && entry.sensorId === 2)
  const backing = front ? internal.nuScenesSampleFiles.get(String(front.filename)) : undefined
  return typeof backing === 'string' ? backing : null
}

export function getThumbnailResolver(): ((segmentId: string) => Promise<string | null> | string | null) | null {
  const datasetId = internal.datasetId

  if (datasetId === 'argoverse2') {
    // Multi-log mode: discovered logs have per-log URLs
    if (internal.av2DiscoveredLogs && internal.av2DiscoveredLogs.length > 0) {
      const logMap = new Map(internal.av2DiscoveredLogs.map(l => [l.logId, l]))

      return async (segmentId: string) => {
        if (internal.av2LogId === segmentId) {
          const thumbnail = loadedAV2FrontThumbnail()
          if (thumbnail) return thumbnail
        }

        const log = logMap.get(segmentId)
        if (!log) return null

        // index.json mirrors publish a thumbnail per log — no listing needed
        if (log.thumbnailUrl) return log.thumbnailUrl

        // For unloaded logs: S3 ListObjects with max-keys=1 on ring_front_center prefix
        return fetchAV2ThumbnailUrl(log.logUrl)
      }
    }

    if (internal.av2LogId) return () => loadedAV2FrontThumbnail()
  }

  // Sharded nuScenes: the index carries a pre-resized thumbnail per scene
  if (datasetId === 'nuscenes' && internal.nuScenesDiscoveredScenes) {
    const thumbByName = new Map(
      internal.nuScenesDiscoveredScenes.map(s => [s.name, s.thumbnailUrl ?? null]),
    )
    return (sceneName: string) => thumbByName.get(sceneName)
      ?? (sceneName === useSceneStore.getState().currentSegment ? loadedNuScenesFrontThumbnail() : null)
  }

  if (datasetId === 'nuscenes' && internal.nuScenesSampleFiles) {
    return (sceneName: string) => sceneName === useSceneStore.getState().currentSegment
      ? loadedNuScenesFrontThumbnail()
      : null
  }

  // Waymo: thumbnails not available without loading full Parquet
  return null
}
