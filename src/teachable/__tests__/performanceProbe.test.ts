import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTrackedObjectUrl,
  createTrackedImageBitmap,
  closeTrackedImageBitmap,
  installPerformanceProbe,
  performanceSnapshotV1,
  registerPerformanceRuntime,
  revokeTrackedObjectUrl,
  updateRendererPerformanceInfo,
  type ScenePerformanceSnapshotV1,
} from '../runtime/performanceProbe'

function sceneSnapshot(): ScenePerformanceSnapshotV1 {
  return {
    sceneGeneration: 41,
    disposed: false,
    cache: {
      pointBytes: 16,
      pointPeakBytes: 32,
      pointByteLimit: 64,
      cameraBytes: 8,
      cameraPeakBytes: 16,
      cameraByteLimit: 32,
      metadataFrames: 1,
      metadataFrameLimit: 8,
      pointFrames: 1,
      cameraFrames: 1,
      pointBatches: 1,
      cameraBatches: 1,
    },
    operations: {
      pointBatchRequests: 1,
      pointBatchLoads: 1,
      pointBatchEvictions: 0,
      cameraBatchRequests: 1,
      cameraBatchLoads: 1,
      cameraBatchEvictions: 0,
      rowGroupFetches: 2,
      rowGroupCacheHits: 1,
      recentRowGroupKeys: ['point:0', 'camera:0'],
      decompressions: 2,
      cancellations: 0,
      staleResponses: 0,
    },
    workers: { point: null, camera: null },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  updateRendererPerformanceInfo({ textures: 0, geometries: 0, programs: 0, materials: 0 })
})

describe('Phase 6 performance probe', () => {
  it('installs a read-only, versioned and JSON-serializable snapshot surface', () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const unregister = registerPerformanceRuntime({ snapshotPerformance: sceneSnapshot })
    updateRendererPerformanceInfo({ textures: 2, geometries: 3, programs: 4, materials: 5 })

    installPerformanceProbe(true)
    const snapshot = window.__EGOLENS_PERF__?.snapshot()

    expect(Object.getOwnPropertyDescriptor(window, '__EGOLENS_PERF__')?.writable).toBe(false)
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      scene: { sceneGeneration: 41, cache: { pointByteLimit: 64 } },
      renderer: { textures: 2, geometries: 3, programs: 4, materials: 5 },
    })
    expect(() => JSON.stringify(snapshot)).not.toThrow()
    unregister()
    expect(window.__EGOLENS_PERF__?.snapshot().scene).toBeNull()
    expect(window.__EGOLENS_PERF__?.snapshot().lastDisposedScene?.sceneGeneration).toBe(41)
  })

  it('tracks object URL identity without retaining the Blob', () => {
    const before = performanceSnapshotV1().resources
    const url = createTrackedObjectUrl(new Blob(['frame']))
    const live = performanceSnapshotV1().resources
    revokeTrackedObjectUrl(url)
    revokeTrackedObjectUrl(url)
    const released = performanceSnapshotV1().resources

    expect(live.objectUrlsCreated).toBe(before.objectUrlsCreated + 1)
    expect(live.liveObjectUrls).toBe(before.liveObjectUrls + 1)
    expect(live.liveObjectUrlIds.at(-1)).toMatch(/^object-url-/u)
    expect(released.objectUrlsRevoked).toBe(before.objectUrlsRevoked + 1)
    expect(released.liveObjectUrls).toBe(before.liveObjectUrls)
  })

  it('tracks ImageBitmap identities and counts close idempotently', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    const before = performanceSnapshotV1().resources

    const tracked = await createTrackedImageBitmap(new Blob(['image']))
    expect(performanceSnapshotV1().resources.liveImageBitmapIds.at(-1)).toMatch(/^image-bitmap-/u)
    closeTrackedImageBitmap(tracked)
    closeTrackedImageBitmap(tracked)
    const released = performanceSnapshotV1().resources

    expect(bitmap.close).toHaveBeenCalledTimes(2)
    expect(released.imageBitmapsCreated).toBe(before.imageBitmapsCreated + 1)
    expect(released.imageBitmapsClosed).toBe(before.imageBitmapsClosed + 1)
    expect(released.liveImageBitmaps).toBe(before.liveImageBitmaps)
  })
})
