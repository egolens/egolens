/**
 * Scene store — Zustand-based central state for Perception Studio.
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
import { CameraWorkerPool } from '../workers/cameraWorkerPool'
import type { SegmentMeta } from '../types/waymo'
import type { MetadataBundle } from '../types/dataset'
import { memLog } from '../utils/memoryLogger'
import { getManifest } from '../adapters/registry'
import { loadWaymoMetadata } from '../adapters/waymo/metadata'

import { multiplyRowMajor4x4 } from '../utils/matrix'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type BoxMode = 'off' | 'box' | 'model'
export type ColormapMode = 'intensity' | 'range' | 'elongation'
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
  toggleWorldMode: () => void
  reset: () => void
}

export type LoadStep = 'opening' | 'parsing' | 'workers' | 'first-frame'

export interface SceneState {
  // Loading
  status: LoadStatus
  error: string | null
  availableComponents: string[]
  loadProgress: number
  /** Current loading step for UI feedback */
  loadStep: LoadStep

  // Frame navigation
  totalFrames: number
  currentFrameIndex: number
  isPlaying: boolean
  playbackSpeed: number

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
  /** World coordinate mode (true = world frame, false = vehicle frame) */
  worldMode: boolean
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
  /** Worker pool for parallel batch loading (lidar) */
  workerPool: null as WorkerPool | null,
  numBatches: 0,
  /** Track which lidar batches have been loaded or are in-flight */
  loadedRowGroups: new Set<number>(),
  /** Camera worker pool */
  cameraPool: null as CameraWorkerPool | null,
  cameraNumBatches: 0,
  /** Track which camera batches have been loaded or are in-flight */
  cameraLoadedRowGroups: new Set<number>(),
  cameraPrefetchStarted: false,
  /** Prevent duplicate prefetchAllRowGroups calls (React StrictMode) */
  prefetchStarted: false,
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
}

function resetInternal() {
  internal.parquetFiles.clear()
  internal.timestamps = []
  internal.timestampToFrame.clear()
  internal.lidarBoxByFrame.clear()
  internal.cameraBoxByFrame.clear()
  internal.vehiclePoseByFrame.clear()
  internal.frameCache.clear()
  internal.cameraImageCache.clear()
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
}

// ---------------------------------------------------------------------------
// Worker pool communication
// ---------------------------------------------------------------------------

function requestRowGroup(
  rowGroupIndex: number,
): Promise<LidarBatchResult> {
  if (!internal.workerPool) {
    return Promise.reject(new Error('Worker pool not initialized'))
  }
  return internal.workerPool.requestRowGroup(rowGroupIndex)
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
    const rawPose = (poseRows?.[0]?.[poseCol] as number[]) ?? null
    const vehiclePose = rawPose && internal.worldOriginInverse
      ? multiplyRowMajor4x4(internal.worldOriginInverse, rawPose)
      : rawPose

    const sensorClouds = new Map<number, PointCloud>()
    if (frame.sensorClouds) {
      for (const sc of frame.sensorClouds) {
        sensorClouds.set(sc.laserName, { positions: sc.positions, pointCount: sc.pointCount })
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
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSceneStore = create<SceneState>((set, get) => ({
  status: 'idle',
  error: null,
  availableComponents: [],
  loadProgress: 0,
  loadStep: 'opening' as LoadStep,
  totalFrames: 0,
  currentFrameIndex: 0,
  isPlaying: false,
  playbackSpeed: 1,
  currentFrame: null,
  lidarCalibrations: new Map(),
  cameraCalibrations: [],
  lastFrameLoadMs: 0,
  lastConvertMs: 0,
  cachedFrames: [],
  cameraLoadedCount: 0,
  cameraTotalCount: 0,
  visibleSensors: new Set([1, 2, 3, 4, 5]),
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
  worldMode: true,
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

        // 4. Load first 2 row groups: LiDAR + Camera in parallel
        //    Loading 2 RGs prevents a stall at the RG boundary when autoplay starts.
        set({ loadStep: 'first-frame' as LoadStep })
        const rgT0 = performance.now()
        const firstFramePromises: Promise<void>[] = []
        if (internal.workerPool?.isReady()) {
          firstFramePromises.push(loadAndCacheRowGroup(0, set))
          if (internal.numBatches > 1) {
            firstFramePromises.push(loadAndCacheRowGroup(1, set))
          }
        } else {
          const lidarPf = internal.parquetFiles.get('lidar')
          if (lidarPf) {
            firstFramePromises.push(
              buildHeavyFileFrameIndex(lidarPf).then(async (idx) => {
                internal.lidarFrameIndex = idx
                await loadFrameMainThread(0, set, get)
              })
            )
          }
        }
        if (internal.cameraPool?.isReady()) {
          firstFramePromises.push(loadAndCacheCameraRowGroup(0, set))
          if (internal.cameraNumBatches > 1) {
            firstFramePromises.push(loadAndCacheCameraRowGroup(1, set))
          }
        }
        await Promise.all(firstFramePromises)
        const rgMs = performance.now() - rgT0
        memLog.snap('phase4:first-rgs-loaded', {
          note: `2 lidar + 2 camera RGs in ${rgMs.toFixed(0)}ms`,
        })

        // Show first frame with camera images ready
        const firstFrame = internal.frameCache.get(0)
        if (firstFrame) {
          const camData = internal.cameraImageCache.get(0)
          set({
            currentFrameIndex: 0,
            currentFrame: {
              ...firstFrame,
              cameraImages: camData ? new Map(camData) : new Map(),
            },
            lastFrameLoadMs: rgMs,
            lastConvertMs: internal.lastConvertMs,
          })
        }

        set({ status: 'ready', loadProgress: 1 })
        memLog.snap('phase5:first-frame-rendered', {
          note: `${internal.frameCache.size} frames cached`,
        })
        get().actions.play()

        // 5. Prefetch remaining row groups in background (LiDAR + Camera)
        if (internal.workerPool?.isReady() && !internal.prefetchStarted) {
          internal.prefetchStarted = true
          prefetchAllRowGroups(set, get)
        }
        if (internal.cameraPool?.isReady() && !internal.cameraPrefetchStarted) {
          internal.cameraPrefetchStarted = true
          prefetchAllCameraRowGroups(set)
        }
      } catch (e) {
        console.error('[loadDataset] Error:', e)
        set({
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },

    loadFrame: async (frameIndex) => {
      if (frameIndex < 0 || frameIndex >= internal.timestamps.length) return

      // Cache hit — instant (the common case after prefetch completes)
      const cached = internal.frameCache.get(frameIndex)
      if (cached) {
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

      // Cache miss — frame not yet prefetched, ignore navigation.
      // Prefetch loads all row groups sequentially; the frame will become
      // available shortly. This avoids contention with the prefetch queue.
    },

    nextFrame: () => get().actions.loadFrame(get().currentFrameIndex + 1),
    prevFrame: () => get().actions.loadFrame(get().currentFrameIndex - 1),
    seekFrame: (index) => get().actions.loadFrame(index),

    play: () => {
      if (get().isPlaying) return
      set({ isPlaying: true })
      const intervalMs = 100 / get().playbackSpeed
      internal.playIntervalId = setInterval(async () => {
        const next = get().currentFrameIndex + 1
        if (next >= get().totalFrames) {
          get().actions.pause()
          return
        }
        await get().actions.loadFrame(next)
      }, intervalMs)
    },

    pause: () => {
      if (!get().isPlaying) return
      if (internal.playIntervalId !== null) {
        clearInterval(internal.playIntervalId)
        internal.playIntervalId = null
      }
      set({ isPlaying: false })
    },

    togglePlayback: () => {
      if (get().isPlaying) {
        get().actions.pause()
      } else {
        // If at the end, rewind to start before playing
        if (get().currentFrameIndex >= get().totalFrames - 1) {
          get().actions.loadFrame(0).then(() => get().actions.play())
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
    },

    setTrailLength: (len: number) => {
      set({ trailLength: Math.max(0, Math.min(50, len)) })
    },

    setPointOpacity: (opacity: number) => {
      set({ pointOpacity: Math.max(0.1, Math.min(1, opacity)) })
    },
    setColormapMode: (mode: ColormapMode) => {
      set({ colormapMode: mode })
    },
    setActiveCam: (cam: number | null) => {
      set({ activeCam: cam })
    },
    toggleActiveCam: (cam: number) => {
      set((s) => ({ activeCam: s.activeCam === cam ? null : cam }))
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
      const { actions, visibleSensors, boxMode, trailLength, pointOpacity } = get()
      // Preserve UI panel settings across segment switches
      const savedSettings = { visibleSensors: new Set(visibleSensors), boxMode, trailLength, pointOpacity }
      actions.reset()
      set({ currentSegment: segmentId, ...savedSettings })

      // File-based path (drag & drop / folder picker)
      if (internal.filesBySegment?.has(segmentId)) {
        const fileMap = internal.filesBySegment.get(segmentId)!
        // Pass File objects directly — workers can receive them via postMessage
        const sources = new Map<string, File | string>(fileMap)
        await actions.loadDataset(sources)
        return
      }

      // URL-based path (Vite dev server)
      const components = [
        'vehicle_pose', 'lidar_calibration', 'camera_calibration',
        'lidar_box', 'camera_box', 'camera_to_lidar_box_association',
        'lidar', 'camera_image', 'stats',
      ]
      const sources = new Map<string, string>()
      for (const comp of components) {
        sources.set(comp, `/waymo_data/${comp}/${segmentId}.parquet`)
      }
      await actions.loadDataset(sources as Map<string, File | string>)
    },

    toggleWorldMode: () => {
      set((s) => ({ worldMode: !s.worldMode }))
    },

    loadFromFiles: async (segments: Map<string, Map<string, File>>) => {
      // Store file references for later use by selectSegment
      internal.filesBySegment = segments
      const segmentIds = [...segments.keys()].sort()
      set({ availableSegments: segmentIds })

      // Auto-select if only one segment, otherwise select first
      if (segmentIds.length > 0) {
        await get().actions.selectSegment(segmentIds[0])
      }
    },

    reset: () => {
      get().actions.pause()
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
        currentFrame: null,
        lidarCalibrations: new Map(),
        cameraCalibrations: [],
        lastFrameLoadMs: 0,
        lastConvertMs: 0,
        cachedFrames: [],
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
): Promise<void> {
  if (internal.loadedRowGroups.has(rgIndex)) return
  internal.loadedRowGroups.add(rgIndex) // Mark as in-flight to prevent duplicates

  try {
    const result = await requestRowGroup(rgIndex)
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

  // Zustand state updates
  set({
    totalFrames: bundle.timestamps.length,
    lidarCalibrations: bundle.lidarCalibrations,
    cameraCalibrations: bundle.cameraCalibrations,
    hasBoxData: bundle.hasBoxData,
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

  const pool = new WorkerPool(WORKER_CONCURRENCY)
  const { numBatches } = await pool.init({
    lidarUrl: lidarSource,
    calibrationEntries: [...get().lidarCalibrations.entries()],
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

  const pool = new CameraWorkerPool(2)
  const { numBatches } = await pool.init({ cameraUrl: cameraSource })

  internal.cameraPool = pool
  internal.cameraNumBatches = numBatches
  useSceneStore.setState({ cameraTotalCount: internal.cameraNumBatches })
}

/** Load + cache a single camera row group */
async function loadAndCacheCameraRowGroup(
  rgIndex: number,
  set: (partial: Partial<SceneState>) => void,
): Promise<void> {
  if (internal.cameraLoadedRowGroups.has(rgIndex)) return
  internal.cameraLoadedRowGroups.add(rgIndex)

  try {
    const result = await internal.cameraPool!.requestRowGroup(rgIndex)
    cacheCameraRowGroupFrames(result)

    // Update camera loading progress
    set({ cameraLoadedCount: internal.cameraLoadedRowGroups.size })

    // Force re-render of current frame with new camera data
    const state = useSceneStore.getState()
    const fi = state.currentFrameIndex
    const cached = internal.frameCache.get(fi)
    const camData = internal.cameraImageCache.get(fi)
    if (cached && camData && camData.size > 0) {
      set({
        currentFrame: {
          ...cached,
          cameraImages: new Map(camData),
        },
      })
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

