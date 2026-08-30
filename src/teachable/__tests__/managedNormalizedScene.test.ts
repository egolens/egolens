import { describe, expect, it, vi } from 'vitest'
import type { CameraBatchResult, LidarBatchResult } from '../../workers/types'
import {
  ManagedNormalizedSceneV1,
  NormalizedFramePendingError,
  type OwnedBatchPoolV1,
} from '../runtime/ManagedNormalizedScene'
import type { NormalizedFrameV1, NormalizedSceneV1 } from '../runtime/normalizedScene'

const ALL_CAPABILITIES = new Set([
  'timeline',
  'egoPoses',
  'pointClouds',
  'cameraImages',
  'boxes3d',
  'lidarSegmentation',
] as const)

function emptyFrame(index: number): NormalizedFrameV1 {
  return {
    index,
    timestampMicros: BigInt(1000 + index),
    worldFromEgo: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    pointClouds: [],
    radarPointClouds: [],
    cameraImages: [],
    boxes3d: [{
      id: `box-${index}`,
      objectId: `box-${index}`,
      classId: 'vehicle',
      frameId: 'ego',
      center: [1, 2, 3],
      dimensions: [4, 2, 1],
      orientation: [1, 0, 0, 0],
    }],
    boxes2d: [],
    keypoints3d: [],
    keypoints2d: [],
    lidarSegmentation: [],
    cameraSegmentation: [],
  }
}

function delegate(frameCount = 2): NormalizedSceneV1 & { dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn()
  return {
    manifest: {
      id: 'test',
      name: 'Test',
      nominalFrameRate: 10,
      sensors: [
        { id: 'lidar', rendererId: 1, label: 'LiDAR', modality: 'lidar', frameId: 'lidar-frame', color: '#fff' },
        {
          id: 'camera', rendererId: 1, label: 'Camera', modality: 'camera', frameId: 'camera-frame', color: '#fff',
          image: { width: 16, height: 8, model: 'pinhole', view: 'front' },
        },
      ],
      taxonomies: [{
        id: 'semantics',
        role: 'lidar-semantics',
        classes: [{ id: 'vehicle', rendererId: 1, label: 'Vehicle', color: '#fff' }],
      }],
      pointAttributes: [
        { id: 'x', storage: 'float32' },
        { id: 'y', storage: 'float32' },
        { id: 'z', storage: 'float32' },
        { id: 'intensity', storage: 'float32' },
      ],
      pointLayout: {
        interleavedAttributes: ['x', 'y', 'z', 'intensity'],
        colorModes: ['intensity', 'segment'],
      },
      capabilities: ALL_CAPABILITIES,
    },
    index: {
      timestampsMicros: Array.from({ length: frameCount }, (_, index) => BigInt(1000 + index)),
      segments: [{ id: 'test', firstFrame: 0, frameCount }],
    },
    relations: {
      staticTransforms: [],
      cameraCalibrations: new Map(),
      trajectories: new Map(),
      box2dToBox3d: new Map(),
    },
    loadFrame: vi.fn(async (index) => emptyFrame(index)),
    dispose,
  }
}

class MockPool<TResult> implements OwnedBatchPoolV1<TResult> {
  readonly requestBatch = vi.fn<(batchIndex: number) => Promise<TResult>>()
  readonly terminate = vi.fn()

  constructor(private readonly results: Map<number, TResult>) {
    this.requestBatch.mockImplementation(async (batchIndex) => {
      const result = this.results.get(batchIndex)
      if (!result) throw new Error(`Missing batch ${batchIndex}`)
      return result
    })
  }

  isReady(): boolean {
    return true
  }
}

class DeferredPool<TResult> implements OwnedBatchPoolV1<TResult> {
  readonly terminate = vi.fn()
  readonly requestBatch = vi.fn<(_batchIndex: number) => Promise<TResult>>()
  resolve!: (result: TResult) => void

  constructor() {
    this.requestBatch.mockImplementation(() => new Promise<TResult>((resolve) => {
      this.resolve = resolve
    }))
  }

  isReady(): boolean {
    return true
  }
}

function pointBatch(batchIndex: number, frameIndex: number, bytes = 32): LidarBatchResult {
  const pointCount = bytes / 16
  return {
    type: 'batchReady',
    requestId: batchIndex,
    batchIndex,
    totalMs: 1,
    frames: [{
      timestamp: String(1000 + frameIndex),
      convertMs: 0.5,
      sensorClouds: [{
        laserName: 1,
        positions: new Float32Array(pointCount * 4),
        pointCount,
        segLabels: new Uint8Array(pointCount).fill(1),
        panopticLabels: new Uint32Array(pointCount).fill(100_001),
      }],
    }],
  }
}

function cameraBatch(batchIndex: number, frameIndex: number): CameraBatchResult {
  return {
    type: 'batchReady',
    requestId: batchIndex,
    batchIndex,
    totalMs: 1,
    frames: [{
      timestamp: String(1000 + frameIndex),
      images: [{ cameraName: 1, jpeg: new ArrayBuffer(24) }],
    }],
  }
}

describe('ManagedNormalizedSceneV1', () => {
  it('makes worker output authoritative while preserving normalized metadata', async () => {
    const base = delegate()
    const scene = new ManagedNormalizedSceneV1(base)
    scene.attachPointPool(new MockPool(new Map([[0, pointBatch(0, 0)]])), 1)
    scene.attachCameraPool(new MockPool(new Map([[0, cameraBatch(0, 0)]])), 1)

    await Promise.all([scene.loadPointBatch(0), scene.loadCameraBatch(0)])
    const frame = await scene.loadFrame(0, { capabilities: ALL_CAPABILITIES })

    expect(frame.pointClouds).toHaveLength(1)
    expect(frame.pointClouds[0].panopticLabels).toBeInstanceOf(Uint32Array)
    expect(frame.cameraImages[0].encodedBytes.byteLength).toBe(24)
    expect(frame.boxes3d[0].id).toBe('box-0')
    expect(base.loadFrame).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent batch requests and exposes one cache owner', async () => {
    const scene = new ManagedNormalizedSceneV1(delegate())
    const pool = new MockPool(new Map([[0, pointBatch(0, 0)]]))
    scene.attachPointPool(pool, 1)

    await Promise.all([scene.loadPointBatch(0), scene.loadPointBatch(0), scene.loadPointBatch(0)])

    expect(pool.requestBatch).toHaveBeenCalledOnce()
    expect(scene.cachedPointFrames()).toEqual([0])
    expect(scene.snapshotPerformance().operations.decompressions).toBe(1)
  })

  it('does not fall through to a second point decoder on a managed cache miss', async () => {
    const base = delegate()
    const scene = new ManagedNormalizedSceneV1(base)
    scene.attachPointPool(new MockPool(new Map()), 1)

    await expect(scene.loadFrame(0, { capabilities: new Set(['pointClouds']) }))
      .rejects.toBeInstanceOf(NormalizedFramePendingError)
    expect(base.loadFrame).not.toHaveBeenCalled()
  })

  it('evicts whole batches at an explicit byte limit so reload remains valid', async () => {
    const scene = new ManagedNormalizedSceneV1(delegate(), { pointCacheByteLimit: 50 })
    const pool = new MockPool(new Map([
      [0, pointBatch(0, 0, 32)],
      [1, pointBatch(1, 1, 32)],
    ]))
    scene.attachPointPool(pool, 2)

    await scene.loadPointBatch(0)
    await scene.loadPointBatch(1)

    expect(scene.cachedPointFrames()).toEqual([1])
    expect(scene.snapshotPerformance().operations.pointBatchEvictions).toBe(1)
    await scene.loadPointBatch(0)
    expect(pool.requestBatch).toHaveBeenCalledTimes(3)
  })

  it('reloads an evicted camera batch under its independent byte limit', async () => {
    const scene = new ManagedNormalizedSceneV1(delegate(), { cameraCacheByteLimit: 40 })
    const pool = new MockPool(new Map([
      [0, cameraBatch(0, 0)],
      [1, cameraBatch(1, 1)],
    ]))
    scene.attachCameraPool(pool, 2)

    await scene.loadCameraBatch(0)
    await scene.loadCameraBatch(1)

    expect(scene.cachedCameraFrames()).toEqual([1])
    expect(scene.snapshotPerformance().operations.cameraBatchEvictions).toBe(1)
    await scene.loadCameraBatch(0)
    expect(scene.cachedCameraFrames()).toEqual([0])
    expect(pool.requestBatch).toHaveBeenCalledTimes(3)
  })

  it('disposes pools, caches, delegate and probe state idempotently', async () => {
    const base = delegate()
    const pointPool = new MockPool(new Map([[0, pointBatch(0, 0)]]))
    const cameraPool = new MockPool(new Map([[0, cameraBatch(0, 0)]]))
    const scene = new ManagedNormalizedSceneV1(base)
    scene.attachPointPool(pointPool, 1)
    scene.attachCameraPool(cameraPool, 1)
    await Promise.all([scene.loadPointBatch(0), scene.loadCameraBatch(0)])

    scene.dispose()
    scene.dispose()

    expect(pointPool.terminate).toHaveBeenCalledOnce()
    expect(cameraPool.terminate).toHaveBeenCalledOnce()
    expect(base.dispose).toHaveBeenCalledOnce()
    expect(scene.snapshotPerformance()).toMatchObject({
      disposed: true,
      cache: { pointBytes: 0, cameraBytes: 0, pointFrames: 0, cameraFrames: 0 },
    })
    expect(() => JSON.stringify(scene.snapshotPerformance())).not.toThrow()
    await expect(scene.loadFrame(0, { capabilities: ALL_CAPABILITIES })).rejects.toThrow('disposed')
  })

  it('advances its generation and drops a worker response that arrives after disposal', async () => {
    const pool = new DeferredPool<LidarBatchResult>()
    const scene = new ManagedNormalizedSceneV1(delegate())
    scene.attachPointPool(pool, 1)
    const liveGeneration = scene.sceneGeneration
    const pending = scene.loadPointBatch(0)

    scene.dispose()
    pool.resolve(pointBatch(0, 0))
    await pending

    expect(scene.sceneGeneration).not.toBe(liveGeneration)
    expect(scene.snapshotPerformance()).toMatchObject({
      disposed: true,
      cache: { pointBytes: 0, pointFrames: 0 },
      operations: { staleResponses: 1, cancellations: 1 },
    })
  })

  it('keeps 100 non-sequential seeks bounded and releases 20 scene generations', async () => {
    const seekOrder = Array.from({ length: 100 }, (_, index) => (index * 37) % 100)
    const results = new Map(seekOrder.map((frameIndex) => [frameIndex, pointBatch(frameIndex, frameIndex, 16)]))
    const scene = new ManagedNormalizedSceneV1(delegate(100), {
      pointCacheByteLimit: 1024 * 1024,
      metadataFrameLimit: 8,
    })
    scene.attachPointPool(new MockPool(results), 100)

    for (const frameIndex of seekOrder) await scene.loadPointBatch(frameIndex)
    for (const frameIndex of seekOrder) {
      const cached = scene.getCachedFrame(frameIndex, { capabilities: ALL_CAPABILITIES })
      const frame = cached ?? await scene.loadFrame(frameIndex, { capabilities: ALL_CAPABILITIES })
      expect(frame.index).toBe(frameIndex)
    }
    expect(scene.snapshotPerformance().cache.pointBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(scene.snapshotPerformance().cache.metadataFrames).toBeLessThanOrEqual(8)
    scene.dispose()

    const generations = new Set<number>()
    for (let index = 0; index < 20; index++) {
      const switched = new ManagedNormalizedSceneV1(delegate(1))
      generations.add(switched.sceneGeneration)
      switched.dispose()
      switched.dispose()
      expect(switched.snapshotPerformance().cache.pointBytes).toBe(0)
    }
    expect(generations.size).toBe(20)
  })
})
