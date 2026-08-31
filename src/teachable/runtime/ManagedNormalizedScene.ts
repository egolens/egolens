import type { CameraBatchResult, LidarBatchResult, SensorCloudResult } from '../../workers/types'
import type {
  FrameCapabilityRequest,
  NormalizedCameraImageV1,
  NormalizedCapabilityV1,
  NormalizedFrameV1,
  NormalizedPointCloudV1,
  NormalizedSceneV1,
  NormalizedSegmentationV1,
} from './normalizedScene'
import {
  registerPerformanceRuntime,
  markPerformanceEvent,
  type ScenePerformanceSnapshotV1,
  type WorkerPoolPerformanceSnapshotV1,
} from './performanceProbe'

const DEFAULT_POINT_CACHE_BYTES = 512 * 1024 * 1024
const DEFAULT_CAMERA_CACHE_BYTES = 256 * 1024 * 1024
const DEFAULT_METADATA_FRAME_LIMIT = 512

export interface OwnedBatchPoolV1<TResult> {
  requestBatch(batchIndex: number, opts?: { priority?: boolean }): Promise<TResult>
  isReady(): boolean
  terminate(): void
  diagnostics?(): WorkerPoolPerformanceSnapshotV1
}

export interface ManagedNormalizedSceneOptionsV1 {
  /** Worker timestamps before unit normalization (AV2 workers use nanoseconds). */
  readonly workerTimestamps?: readonly bigint[]
  /**
   * Portable graph scenes decode their own point/camera payloads through the
   * delegate and therefore do not attach dataset-specific worker pools.
   */
  readonly delegateOwnsFramePayloads?: boolean
  readonly pointCacheByteLimit?: number
  readonly cameraCacheByteLimit?: number
  readonly metadataFrameLimit?: number
}

export class NormalizedFramePendingError extends Error {
  readonly frameIndex: number

  constructor(frameIndex: number) {
    super(`Normalized frame ${frameIndex} has not reached the managed point cache.`)
    this.name = 'NormalizedFramePendingError'
    this.frameIndex = frameIndex
  }
}

interface PointFrameCacheEntry {
  readonly pointClouds: readonly NormalizedPointCloudV1[]
  readonly radarPointClouds: readonly NormalizedPointCloudV1[]
  readonly lidarSegmentation: readonly NormalizedSegmentationV1[]
}

interface PointBatchCacheEntry {
  readonly frames: Map<number, PointFrameCacheEntry>
  readonly bytes: number
}

interface CameraBatchCacheEntry {
  readonly frames: Map<number, readonly NormalizedCameraImageV1[]>
  readonly bytes: number
}

interface MutableOperationCounters {
  pointBatchRequests: number
  pointBatchLoads: number
  pointBatchEvictions: number
  cameraBatchRequests: number
  cameraBatchLoads: number
  cameraBatchEvictions: number
  rowGroupFetches: number
  rowGroupCacheHits: number
  recentRowGroupKeys: string[]
  decompressions: number
  cancellations: number
  staleResponses: number
}

let nextSceneGeneration = 1

function emptyWorkerSnapshot(): WorkerPoolPerformanceSnapshotV1 {
  return {
    workers: 0,
    readyWorkers: 0,
    queued: 0,
    inFlight: 0,
    requests: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    staleResponses: 0,
    terminated: false,
  }
}

function positiveByteLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}

function byteLength(view: ArrayBufferView | undefined): number {
  return view?.byteLength ?? 0
}

function pointCloudBytes(cloud: NormalizedPointCloudV1): number {
  return cloud.values.byteLength
    + byteLength(cloud.semanticLabels)
    + byteLength(cloud.panopticLabels)
    + byteLength(cloud.cameraProjection)
    + byteLength(cloud.cameraRgb)
    + byteLength(cloud.sourceIndices)
}

function frameCapabilitiesWithoutWorkerOutputs(
  capabilities: ReadonlySet<NormalizedCapabilityV1>,
): ReadonlySet<NormalizedCapabilityV1> {
  const result = new Set(capabilities)
  result.delete('pointClouds')
  result.delete('radarPointClouds')
  result.delete('lidarSegmentation')
  result.delete('cameraImages')
  return result
}

function linkedSignal(sceneSignal: AbortSignal, requestSignal?: AbortSignal): AbortSignal {
  if (!requestSignal) return sceneSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([sceneSignal, requestSignal])
  const controller = new AbortController()
  const abort = () => controller.abort()
  sceneSignal.addEventListener('abort', abort, { once: true })
  requestSignal.addEventListener('abort', abort, { once: true })
  if (sceneSignal.aborted || requestSignal.aborted) controller.abort()
  return controller.signal
}

function emptyPointFrame(): PointFrameCacheEntry {
  return { pointClouds: [], radarPointClouds: [], lidarSegmentation: [] }
}

/**
 * The Phase 6 authoritative runtime.
 *
 * Dataset workers still implement the already-shipped reader algorithms, but
 * their pools, transferred buffers, cache policy, cancellation and disposal
 * have exactly one owner: this normalized scene.
 */
export class ManagedNormalizedSceneV1 implements NormalizedSceneV1 {
  readonly manifest
  readonly index
  readonly relations
  readonly #delegate: NormalizedSceneV1
  readonly #workerTimestampToFrame = new Map<bigint, number>()
  readonly #pointCacheByteLimit: number
  readonly #cameraCacheByteLimit: number
  readonly #metadataFrameLimit: number
  readonly #delegateOwnsFramePayloads: boolean
  readonly #abortController = new AbortController()
  readonly #metadataFrames = new Map<number, Promise<NormalizedFrameV1>>()
  readonly #resolvedMetadataFrames = new Map<number, NormalizedFrameV1>()
  readonly #pointBatches = new Map<number, PointBatchCacheEntry>()
  readonly #cameraBatches = new Map<number, CameraBatchCacheEntry>()
  readonly #pointFrameToBatch = new Map<number, number>()
  readonly #cameraFrameToBatch = new Map<number, number>()
  readonly #pointInflight = new Map<number, Promise<void>>()
  readonly #cameraInflight = new Map<number, Promise<void>>()
  readonly #operations: MutableOperationCounters = {
    pointBatchRequests: 0,
    pointBatchLoads: 0,
    pointBatchEvictions: 0,
    cameraBatchRequests: 0,
    cameraBatchLoads: 0,
    cameraBatchEvictions: 0,
    rowGroupFetches: 0,
    rowGroupCacheHits: 0,
    recentRowGroupKeys: [],
    decompressions: 0,
    cancellations: 0,
    staleResponses: 0,
  }
  readonly #unregisterPerformance: () => void

  #pointPool: OwnedBatchPoolV1<LidarBatchResult> | null = null
  #cameraPool: OwnedBatchPoolV1<CameraBatchResult> | null = null
  #disposedPointWorkers: WorkerPoolPerformanceSnapshotV1 | null = null
  #disposedCameraWorkers: WorkerPoolPerformanceSnapshotV1 | null = null
  #pointBatchCount = 0
  #cameraBatchCount = 0
  #pointBytes = 0
  #pointPeakBytes = 0
  #cameraBytes = 0
  #cameraPeakBytes = 0
  #lastConvertMs = 0
  #disposed = false
  #sceneGeneration = nextSceneGeneration++

  constructor(delegate: NormalizedSceneV1, options: ManagedNormalizedSceneOptionsV1 = {}) {
    this.#delegate = delegate
    this.manifest = delegate.manifest
    this.index = delegate.index
    this.relations = delegate.relations
    this.#pointCacheByteLimit = positiveByteLimit(options.pointCacheByteLimit, DEFAULT_POINT_CACHE_BYTES)
    this.#cameraCacheByteLimit = positiveByteLimit(options.cameraCacheByteLimit, DEFAULT_CAMERA_CACHE_BYTES)
    this.#metadataFrameLimit = positiveByteLimit(options.metadataFrameLimit, DEFAULT_METADATA_FRAME_LIMIT)
    this.#delegateOwnsFramePayloads = options.delegateOwnsFramePayloads === true
    const workerTimestamps = options.workerTimestamps ?? delegate.index.timestampsMicros
    workerTimestamps.forEach((timestamp, index) => this.#workerTimestampToFrame.set(timestamp, index))
    this.#unregisterPerformance = registerPerformanceRuntime(this)
  }

  get disposed(): boolean {
    return this.#disposed
  }

  get sceneGeneration(): number {
    return this.#sceneGeneration
  }

  get pointBatchCount(): number {
    return this.#pointBatchCount
  }

  get cameraBatchCount(): number {
    return this.#cameraBatchCount
  }

  get lastConvertMs(): number {
    return this.#lastConvertMs
  }

  attachPointPool(pool: OwnedBatchPoolV1<LidarBatchResult>, batchCount: number): void {
    this.#assertLive()
    if (this.#pointPool && this.#pointPool !== pool) throw new Error('The normalized scene already owns a point worker pool.')
    this.#pointPool = pool
    this.#pointBatchCount = Math.max(0, batchCount)
  }

  attachCameraPool(pool: OwnedBatchPoolV1<CameraBatchResult>, batchCount: number): void {
    this.#assertLive()
    if (this.#cameraPool && this.#cameraPool !== pool) throw new Error('The normalized scene already owns a camera worker pool.')
    this.#cameraPool = pool
    this.#cameraBatchCount = Math.max(0, batchCount)
  }

  hasPointFrame(index: number): boolean {
    if (this.#delegateOwnsFramePayloads) return Number.isSafeInteger(index) && index >= 0 && index < this.index.timestampsMicros.length
    return this.#pointFrameToBatch.has(index)
  }

  hasCameraFrame(index: number): boolean {
    if (this.#delegateOwnsFramePayloads) return Number.isSafeInteger(index) && index >= 0 && index < this.index.timestampsMicros.length
    return this.#cameraFrameToBatch.has(index)
  }

  cachedPointFrames(): readonly number[] {
    if (this.#delegateOwnsFramePayloads) return [...this.#resolvedMetadataFrames.keys()].sort((left, right) => left - right)
    return [...this.#pointFrameToBatch.keys()].sort((left, right) => left - right)
  }

  cachedCameraFrames(): readonly number[] {
    if (this.#delegateOwnsFramePayloads) return [...this.#resolvedMetadataFrames.keys()].sort((left, right) => left - right)
    return [...this.#cameraFrameToBatch.keys()].sort((left, right) => left - right)
  }

  loadedPointBatches(): ReadonlySet<number> {
    return new Set(this.#pointBatches.keys())
  }

  loadedCameraBatches(): ReadonlySet<number> {
    return new Set(this.#cameraBatches.keys())
  }

  async loadPointBatch(batchIndex: number, opts?: { priority?: boolean }): Promise<void> {
    this.#assertLive()
    if (this.#pointBatches.has(batchIndex)) {
      this.#recordRowGroup(`point:${batchIndex}`, true)
      this.#touch(this.#pointBatches, batchIndex)
      return
    }
    const existing = this.#pointInflight.get(batchIndex)
    if (existing) return existing
    if (!this.#pointPool?.isReady()) throw new Error('Point worker pool is not ready.')
    this.#operations.pointBatchRequests += 1
    this.#recordRowGroup(`point:${batchIndex}`, false)
    const generation = this.sceneGeneration
    const promise = this.#pointPool.requestBatch(batchIndex, opts).then((result) => {
      if (this.#disposed || generation !== this.sceneGeneration) {
        this.#operations.staleResponses += 1
        return
      }
      return this.#acceptPointBatch(result)
    }).finally(() => {
      this.#pointInflight.delete(batchIndex)
    })
    this.#pointInflight.set(batchIndex, promise)
    return promise
  }

  async loadCameraBatch(batchIndex: number, opts?: { priority?: boolean }): Promise<void> {
    this.#assertLive()
    if (this.#cameraBatches.has(batchIndex)) {
      this.#recordRowGroup(`camera:${batchIndex}`, true)
      this.#touch(this.#cameraBatches, batchIndex)
      return
    }
    const existing = this.#cameraInflight.get(batchIndex)
    if (existing) return existing
    if (!this.#cameraPool?.isReady()) throw new Error('Camera worker pool is not ready.')
    this.#operations.cameraBatchRequests += 1
    this.#recordRowGroup(`camera:${batchIndex}`, false)
    const generation = this.sceneGeneration
    const promise = this.#cameraPool.requestBatch(batchIndex, opts).then((result) => {
      if (this.#disposed || generation !== this.sceneGeneration) {
        this.#operations.staleResponses += 1
        return
      }
      this.#acceptCameraBatch(result)
    }).finally(() => {
      this.#cameraInflight.delete(batchIndex)
    })
    this.#cameraInflight.set(batchIndex, promise)
    return promise
  }

  async loadFrame(index: number, request: FrameCapabilityRequest): Promise<NormalizedFrameV1> {
    this.#assertLive()
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.index.timestampsMicros.length) {
      throw new RangeError(`Frame index ${index} is out of range.`)
    }
    if (request.signal?.aborted) throw new DOMException('Scene frame load was aborted.', 'AbortError')
    const requested = new Set([...request.capabilities].filter((capability) => this.manifest.capabilities.has(capability)))
    const pointRequired = requested.has('pointClouds') || requested.has('radarPointClouds') || requested.has('lidarSegmentation')
    const pointFrame = this.#pointFrame(index)
    if (pointRequired && this.#pointPool && !pointFrame) throw new NormalizedFramePendingError(index)

    const base = await this.#ensureMetadataFrame(index, request.signal)
    this.#assertLive()
    return this.#composeFrame(base, requested, pointFrame, this.#cameraFrame(index))
  }

  /** Synchronous renderer hot path after a worker batch has been normalized. */
  getCachedFrame(index: number, request: FrameCapabilityRequest): NormalizedFrameV1 | null {
    this.#assertLive()
    const base = this.#resolvedMetadataFrames.get(index)
    if (!base) return null
    const requested = new Set([...request.capabilities].filter((capability) => this.manifest.capabilities.has(capability)))
    const pointRequired = requested.has('pointClouds') || requested.has('radarPointClouds') || requested.has('lidarSegmentation')
    const pointFrame = this.#pointFrame(index)
    if (pointRequired && this.#pointPool && !pointFrame) return null
    return this.#composeFrame(base, requested, pointFrame, this.#cameraFrame(index))
  }

  dispose(): void {
    if (this.#disposed) return
    const disposedGeneration = this.#sceneGeneration
    markPerformanceEvent('scene-dispose-start', { sceneGeneration: disposedGeneration })
    this.#disposed = true
    this.#sceneGeneration = nextSceneGeneration++
    this.#abortController.abort()
    this.#operations.cancellations += this.#pointInflight.size + this.#cameraInflight.size
    this.#pointPool?.terminate()
    this.#cameraPool?.terminate()
    this.#disposedPointWorkers = this.#pointPool
      ? (this.#pointPool.diagnostics?.() ?? { ...emptyWorkerSnapshot(), terminated: true })
      : null
    this.#disposedCameraWorkers = this.#cameraPool
      ? (this.#cameraPool.diagnostics?.() ?? { ...emptyWorkerSnapshot(), terminated: true })
      : null
    this.#pointPool = null
    this.#cameraPool = null
    this.#pointInflight.clear()
    this.#cameraInflight.clear()
    this.#metadataFrames.clear()
    this.#resolvedMetadataFrames.clear()
    this.#pointBatches.clear()
    this.#cameraBatches.clear()
    this.#pointFrameToBatch.clear()
    this.#cameraFrameToBatch.clear()
    this.#pointBytes = 0
    this.#cameraBytes = 0
    this.#delegate.dispose()
    this.#unregisterPerformance()
    markPerformanceEvent('scene-dispose-end', { sceneGeneration: disposedGeneration })
  }

  snapshotPerformance(): ScenePerformanceSnapshotV1 {
    return {
      sceneGeneration: this.sceneGeneration,
      disposed: this.#disposed,
      cache: {
        pointBytes: this.#pointBytes,
        pointPeakBytes: this.#pointPeakBytes,
        pointByteLimit: this.#pointCacheByteLimit,
        cameraBytes: this.#cameraBytes,
        cameraPeakBytes: this.#cameraPeakBytes,
        cameraByteLimit: this.#cameraCacheByteLimit,
        metadataFrames: this.#resolvedMetadataFrames.size,
        metadataFrameLimit: this.#metadataFrameLimit,
        pointFrames: this.#pointFrameToBatch.size,
        cameraFrames: this.#cameraFrameToBatch.size,
        pointBatches: this.#pointBatches.size,
        cameraBatches: this.#cameraBatches.size,
      },
      operations: {
        ...this.#operations,
        recentRowGroupKeys: [...this.#operations.recentRowGroupKeys],
      },
      workers: {
        point: this.#pointPool?.diagnostics?.()
          ?? (this.#pointPool ? emptyWorkerSnapshot() : this.#disposedPointWorkers),
        camera: this.#cameraPool?.diagnostics?.()
          ?? (this.#cameraPool ? emptyWorkerSnapshot() : this.#disposedCameraWorkers),
      },
    }
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('Normalized scene has been disposed.')
  }

  async #acceptPointBatch(result: LidarBatchResult): Promise<void> {
    const frames = new Map<number, PointFrameCacheEntry>()
    let bytes = 0
    for (const frame of result.frames) {
      this.#lastConvertMs = Math.max(this.#lastConvertMs, frame.convertMs)
      const frameIndex = this.#workerTimestampToFrame.get(BigInt(frame.timestamp))
      if (frameIndex === undefined) continue
      const entry = this.#normalizePointFrame(frame.sensorClouds)
      frames.set(frameIndex, entry)
      for (const cloud of [...entry.pointClouds, ...entry.radarPointClouds]) bytes += pointCloudBytes(cloud)
    }
    const previous = this.#pointBatches.get(result.batchIndex)
    if (previous) this.#removePointBatch(result.batchIndex, previous, false)
    this.#pointBatches.set(result.batchIndex, { frames, bytes })
    for (const frameIndex of frames.keys()) this.#pointFrameToBatch.set(frameIndex, result.batchIndex)
    this.#pointBytes += bytes
    this.#pointPeakBytes = Math.max(this.#pointPeakBytes, this.#pointBytes)
    this.#operations.pointBatchLoads += 1
    this.#operations.decompressions += 1
    this.#evictPointBatches()
    // Preserve the pre-Phase-6 synchronous seek contract: metadata and
    // annotations are normalized before a point batch is announced as ready.
    try {
      await Promise.all([...frames.keys()].map((frameIndex) => this.#ensureMetadataFrame(frameIndex)))
    } catch (error) {
      const accepted = this.#pointBatches.get(result.batchIndex)
      if (accepted) this.#removePointBatch(result.batchIndex, accepted, false)
      throw error
    }
  }

  #normalizePointFrame(sensorClouds: readonly SensorCloudResult[]): PointFrameCacheEntry {
    const pointClouds: NormalizedPointCloudV1[] = []
    const radarPointClouds: NormalizedPointCloudV1[] = []
    const lidarSegmentation: NormalizedSegmentationV1[] = []
    // Point and camera renderer IDs intentionally occupy separate namespaces.
    // Never let camera ID 1 overwrite LiDAR ID 1 in this lookup.
    const sensors = new Map(this.manifest.sensors
      .filter((sensor) => sensor.modality !== 'camera')
      .map((sensor) => [sensor.rendererId, sensor]))
    const taxonomyId = this.manifest.taxonomies.find((taxonomy) => taxonomy.role === 'lidar-semantics')?.id
    for (const result of sensorClouds) {
      const sensor = sensors.get(result.laserName)
      if (!sensor || sensor.modality === 'camera') continue
      const stride = result.pointCount > 0 ? result.positions.length / result.pointCount : this.manifest.pointLayout.interleavedAttributes.length
      const attributes = stride === this.manifest.pointLayout.interleavedAttributes.length
        ? this.manifest.pointLayout.interleavedAttributes
        : ['x', 'y', 'z', ...Array.from({ length: Math.max(0, stride - 3) }, (_, index) => `attribute-${index + 3}`)]
      const cloud: NormalizedPointCloudV1 = {
        sensorId: sensor.id,
        frameId: 'ego',
        values: result.positions,
        pointCount: result.pointCount,
        stride,
        attributes,
        semanticLabels: result.segLabels,
        panopticLabels: result.panopticLabels,
        cameraProjection: result.cameraProjection,
        sourceIndices: result.validIndices,
      }
      if (sensor.modality === 'radar') radarPointClouds.push(cloud)
      else pointClouds.push(cloud)
      if (taxonomyId && result.segLabels) {
        lidarSegmentation.push({
          sensorId: sensor.id,
          taxonomyId,
          labels: result.panopticLabels ?? result.segLabels,
          divisor: result.panopticLabels ? 1000 : undefined,
          encoding: 'point-index',
        })
      }
    }
    return { pointClouds, radarPointClouds, lidarSegmentation }
  }

  #acceptCameraBatch(result: CameraBatchResult): void {
    const frames = new Map<number, readonly NormalizedCameraImageV1[]>()
    const cameras = new Map(this.manifest.sensors
      .filter((sensor) => sensor.modality === 'camera')
      .map((sensor) => [sensor.rendererId, sensor]))
    let bytes = 0
    for (const frame of result.frames) {
      const frameIndex = this.#workerTimestampToFrame.get(BigInt(frame.timestamp))
      if (frameIndex === undefined) continue
      const images: NormalizedCameraImageV1[] = []
      for (const image of frame.images) {
        const sensor = cameras.get(image.cameraName)
        if (!sensor?.image) continue
        bytes += image.jpeg.byteLength
        images.push({
          sensorId: sensor.id,
          timestampMicros: this.index.timestampsMicros[frameIndex],
          encodedBytes: image.jpeg,
          mimeType: 'image/jpeg',
          width: sensor.image.width,
          height: sensor.image.height,
          calibrationId: sensor.id,
        })
      }
      frames.set(frameIndex, images)
    }
    const previous = this.#cameraBatches.get(result.batchIndex)
    if (previous) this.#removeCameraBatch(result.batchIndex, previous, false)
    this.#cameraBatches.set(result.batchIndex, { frames, bytes })
    for (const frameIndex of frames.keys()) this.#cameraFrameToBatch.set(frameIndex, result.batchIndex)
    this.#cameraBytes += bytes
    this.#cameraPeakBytes = Math.max(this.#cameraPeakBytes, this.#cameraBytes)
    this.#operations.cameraBatchLoads += 1
    this.#operations.decompressions += 1
    this.#evictCameraBatches()
  }

  #pointFrame(index: number): PointFrameCacheEntry | undefined {
    const batchIndex = this.#pointFrameToBatch.get(index)
    if (batchIndex === undefined) return undefined
    this.#touch(this.#pointBatches, batchIndex)
    return this.#pointBatches.get(batchIndex)?.frames.get(index) ?? emptyPointFrame()
  }

  #cameraFrame(index: number): readonly NormalizedCameraImageV1[] | undefined {
    const batchIndex = this.#cameraFrameToBatch.get(index)
    if (batchIndex === undefined) return undefined
    this.#touch(this.#cameraBatches, batchIndex)
    return this.#cameraBatches.get(batchIndex)?.frames.get(index)
  }

  #ensureMetadataFrame(index: number, requestSignal?: AbortSignal): Promise<NormalizedFrameV1> {
    const resolved = this.#resolvedMetadataFrames.get(index)
    if (resolved) {
      this.#touch(this.#resolvedMetadataFrames, index)
      return Promise.resolve(resolved)
    }
    let pending = this.#metadataFrames.get(index)
    if (!pending) {
      const capabilities = this.#delegateOwnsFramePayloads
        ? this.manifest.capabilities
        : frameCapabilitiesWithoutWorkerOutputs(this.manifest.capabilities)
      pending = this.#delegate.loadFrame(index, {
        capabilities,
        signal: linkedSignal(this.#abortController.signal, requestSignal),
      }).then((frame) => {
        if (!this.#disposed) {
          this.#resolvedMetadataFrames.set(index, frame)
          while (this.#resolvedMetadataFrames.size > this.#metadataFrameLimit) {
            const oldest = this.#resolvedMetadataFrames.keys().next().value as number | undefined
            if (oldest === undefined) break
            this.#resolvedMetadataFrames.delete(oldest)
          }
        }
        return frame
      })
      this.#metadataFrames.set(index, pending)
      void pending.finally(() => this.#metadataFrames.delete(index)).catch(() => {})
    }
    return pending
  }

  #composeFrame(
    base: NormalizedFrameV1,
    requested: ReadonlySet<NormalizedCapabilityV1>,
    pointFrame: PointFrameCacheEntry | undefined,
    cameraFrame: readonly NormalizedCameraImageV1[] | undefined,
  ): NormalizedFrameV1 {
    return {
      ...base,
      pointClouds: requested.has('pointClouds') ? (pointFrame?.pointClouds ?? base.pointClouds) : [],
      radarPointClouds: requested.has('radarPointClouds') ? (pointFrame?.radarPointClouds ?? base.radarPointClouds) : [],
      cameraImages: requested.has('cameraImages') ? (cameraFrame ?? base.cameraImages) : [],
      lidarSegmentation: requested.has('lidarSegmentation')
        ? (pointFrame?.lidarSegmentation ?? base.lidarSegmentation)
        : [],
    }
  }

  #evictPointBatches(): void {
    while (this.#pointBytes > this.#pointCacheByteLimit && this.#pointBatches.size > 1) {
      const oldest = this.#pointBatches.entries().next().value as [number, PointBatchCacheEntry] | undefined
      if (!oldest) break
      this.#removePointBatch(oldest[0], oldest[1], true)
    }
  }

  #removePointBatch(batchIndex: number, entry: PointBatchCacheEntry, eviction: boolean): void {
    this.#pointBatches.delete(batchIndex)
    for (const frameIndex of entry.frames.keys()) {
      if (this.#pointFrameToBatch.get(frameIndex) === batchIndex) this.#pointFrameToBatch.delete(frameIndex)
    }
    this.#pointBytes = Math.max(0, this.#pointBytes - entry.bytes)
    if (eviction) this.#operations.pointBatchEvictions += 1
  }

  #evictCameraBatches(): void {
    while (this.#cameraBytes > this.#cameraCacheByteLimit && this.#cameraBatches.size > 1) {
      const oldest = this.#cameraBatches.entries().next().value as [number, CameraBatchCacheEntry] | undefined
      if (!oldest) break
      this.#removeCameraBatch(oldest[0], oldest[1], true)
    }
  }

  #removeCameraBatch(batchIndex: number, entry: CameraBatchCacheEntry, eviction: boolean): void {
    this.#cameraBatches.delete(batchIndex)
    for (const frameIndex of entry.frames.keys()) {
      if (this.#cameraFrameToBatch.get(frameIndex) === batchIndex) this.#cameraFrameToBatch.delete(frameIndex)
    }
    this.#cameraBytes = Math.max(0, this.#cameraBytes - entry.bytes)
    if (eviction) this.#operations.cameraBatchEvictions += 1
  }

  #touch<T>(cache: Map<number, T>, key: number): void {
    const value = cache.get(key)
    if (value === undefined) return
    cache.delete(key)
    cache.set(key, value)
  }

  #recordRowGroup(key: string, cacheHit: boolean): void {
    if (cacheHit) this.#operations.rowGroupCacheHits += 1
    else this.#operations.rowGroupFetches += 1
    this.#operations.recentRowGroupKeys.push(key)
    if (this.#operations.recentRowGroupKeys.length > 256) {
      this.#operations.recentRowGroupKeys.splice(0, this.#operations.recentRowGroupKeys.length - 256)
    }
  }
}

export function manageNormalizedSceneV1(
  scene: NormalizedSceneV1,
  options?: ManagedNormalizedSceneOptionsV1,
): ManagedNormalizedSceneV1 {
  return new ManagedNormalizedSceneV1(scene, options)
}
