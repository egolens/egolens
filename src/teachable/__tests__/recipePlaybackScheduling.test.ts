import { loadGraphBinaryV1 } from '../operators/coreGraphOperators'
import { GraphResourceAccountV1, type GraphBinaryCollectionV1 } from '../runtime/GraphValues'
import { releaseGraphValue } from '../runtime/GraphKernel'
import { describe, expect, it, vi } from 'vitest'
import { ReadSchedulerV1, setReadPriority, mapConcurrentV1 } from '../runtime/ReadScheduler'
import { PayloadCacheV1, retainedPayloadBytesV1 } from '../runtime/PayloadCache'
import { RecipePlaybackV1 } from '../runtime/RecipePlayback'
import type { NormalizedFrameV1, NormalizedSceneV1 } from '../runtime/normalizedScene'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const signal = () => new AbortController()
const frame = (index: number): NormalizedFrameV1 => ({
  index, timestampMicros: BigInt(index), worldFromEgo: null, pointClouds: [], radarPointClouds: [], cameraImages: [],
  boxes3d: [], boxes2d: [], keypoints3d: [], keypoints2d: [], lidarSegmentation: [], cameraSegmentation: [],
})
function scene(loadFrame: NormalizedSceneV1['loadFrame']): NormalizedSceneV1 {
  return {
    manifest: { id: 'test', name: 'test', nominalFrameRate: 10, sensors: [], taxonomies: [], pointAttributes: [],
      pointLayout: { interleavedAttributes: ['x', 'y', 'z'], colorModes: [] }, capabilities: new Set(['pointClouds', 'cameraImages']) },
    index: { timestampsMicros: Array.from({ length: 80 }, (_, i) => BigInt(i)), segments: [] },
    relations: { staticTransforms: [], cameraCalibrations: new Map(), trajectories: new Map(), box2dToBox3d: new Map() },
    loadFrame, dispose() {},
  }
}
const points = { capabilities: new Set(['pointClouds'] as const) }
const cameras = { capabilities: new Set(['cameraImages'] as const) }

describe('shared recipe read scheduling', () => {
  it('bounds reads, promotes foreground work, and coalesces duplicate reads with independent cancellation', async () => {
    const scheduler = new ReadSchedulerV1(1)
    const first = deferred<ArrayBuffer>()
    const source = vi.fn(() => first.promise)
    const a = signal(), b = signal(), background = signal(), foreground = signal()
    setReadPriority(background.signal, 10)
    setReadPriority(foreground.signal, 0)
    const p1 = scheduler.read('same', source, a.signal)
    const rejection = expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    const p2 = scheduler.read('same', source, b.signal)
    const order: string[] = []
    const low = scheduler.read('low', async () => { order.push('low'); return new ArrayBuffer(1) }, background.signal)
    const high = scheduler.read('high', async () => { order.push('high'); return new ArrayBuffer(1) }, foreground.signal)
    a.abort()
    first.resolve(new ArrayBuffer(4))
    await rejection
    expect((await p2).byteLength).toBe(4)
    await Promise.all([low, high])
    expect(source).toHaveBeenCalledOnce()
    expect(order).toEqual(['high', 'low'])
    expect(scheduler.snapshot().peak).toBe(1)
    scheduler.dispose()
  })

  it('keeps metadata order with out-of-order completion and bounded fan-out', async () => {
    const waits = [deferred<number>(), deferred<number>(), deferred<number>()]
    const started: number[] = []
    const result = mapConcurrentV1([0, 1, 2], async i => { started.push(i); return waits[i].promise }, 2)
    expect(started).toEqual([0, 1])
    waits[1].resolve(11)
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]))
    waits[2].resolve(12)
    waits[0].resolve(10)
    expect(await result).toEqual([10, 11, 12])
  })

  it('aborts transport only when its last reader leaves and allows a clean retry', async () => {
    const scheduler = new ReadSchedulerV1(2)
    const a = signal(), b = signal()
    let transportSignal!: AbortSignal
    const pending = scheduler.read('x', s => { transportSignal = s; return new Promise((_ok, fail) => s.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')))) }, a.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    a.abort()
    expect(transportSignal.aborted).toBe(true)
    await rejected
    expect((await scheduler.read('x', async () => new ArrayBuffer(8), b.signal)).byteLength).toBe(8)
    scheduler.dispose()
  })
})

describe('recipe payload ownership', () => {
  it('evicts decoded graph buffers and releases their allocation accounting', async () => {
    const resources = new GraphResourceAccountV1({ maxNodes: 100, maxSourceBytes: 1024, maxAllocationBytes: 64 })
    const decodedPayloads = new PayloadCacheV1<object, true>(64)
    const read = vi.fn(async () => new Float32Array(8).buffer)
    const source = { has: () => true, byteLength: () => 32, read, async asyncBuffer() { return { byteLength: 32, slice: read } } }
    const collection: GraphBinaryCollectionV1 = {
      kind: 'binary-collection', files: [], cache: new Map(), retainedReleases: new Map(),
      decoder: { kind: 'interleaved', params: { strideBytes: 4, littleEndian: true, fields: [{ name: 'x', type: 'float32', offsetBytes: 0 }] } },
      context: { signal: signal().signal, source, read, asyncBuffer: source.asyncBuffer, resources, decodedPayloads, throwIfAborted() {} },
    }
    await loadGraphBinaryV1(collection, 'a')
    await loadGraphBinaryV1(collection, 'b')
    await loadGraphBinaryV1(collection, 'a')
    await loadGraphBinaryV1(collection, 'c')
    expect(read).toHaveBeenCalledTimes(3)
    expect(collection.cache.has('b')).toBe(false)
    expect(resources.snapshot().allocationBytes).toBe(64)
    expect(decodedPayloads.bytes).toBe(64)
    await loadGraphBinaryV1(collection, 'b')
    expect(read).toHaveBeenCalledTimes(4)
    releaseGraphValue(collection, new WeakSet())
    expect(collection.cache.size).toBe(0)
    expect(resources.snapshot().allocationBytes).toBe(0)
    expect(decodedPayloads.bytes).toBe(0)
  })

  it('evicts actual payload owners and counts shared buffers only once', () => {
    const cache = new PayloadCacheV1<number, ArrayBuffer>(16)
    const release = vi.fn()
    cache.set(1, new ArrayBuffer(8), 8, release)
    cache.set(2, new ArrayBuffer(8), 8)
    cache.set(3, new ArrayBuffer(8), 8, () => {}, 1)
    expect(cache.has(1)).toBe(true)
    expect(cache.has(2)).toBe(false)
    expect(cache.bytes).toBe(16)
    expect(cache.set(4, new ArrayBuffer(32), 32)).toBe(false)
    cache.clear()
    expect(release).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(0)
    const shared = new ArrayBuffer(64)
    expect(retainedPayloadBytesV1([new Uint8Array(shared), new Float32Array(shared)])).toBe(96)
  })
})

describe('recipe playback', () => {
  it('presents points without waiting for cameras and keeps replenishing a bounded queue to the end', async () => {
    const camera = deferred<NormalizedFrameV1>()
    const load = vi.fn<NormalizedSceneV1['loadFrame']>(async (i, r) => r.capabilities.has('cameraImages') && i === 0 ? camera.promise : frame(i))
    const runtime = new RecipePlaybackV1(scene(load), 1024 * 1024, 1024 * 1024, 2)
    const first = await runtime.loadFrame(0, points)
    expect(first.index).toBe(0)
    expect(runtime.cameras.has(0)).toBe(false)
    runtime.prefetch()
    await vi.waitFor(() => expect(runtime.points.has(79)).toBe(true))
    expect(runtime.points.keys()).toHaveLength(80)
    expect(runtime.snapshot().queued).toBeLessThanOrEqual(4)
    const before = load.mock.calls.length
    expect(await runtime.loadFrame(0, points)).toBe(first)
    expect(load).toHaveBeenCalledTimes(before)
    camera.resolve({ ...frame(0), cameraImages: [{ sensorId: 'cam', timestampMicros: 0n, encodedBytes: new ArrayBuffer(16), mimeType: 'image/jpeg', width: 1, height: 1, calibrationId: 'cam' }] })
    await runtime.loadFrame(0, cameras)
    expect(runtime.getCachedFrame(0, points)?.cameraImages).toHaveLength(0)
    expect(runtime.getCachedFrame(0, cameras)?.cameraImages).toHaveLength(1)
    runtime.dispose()
    expect(runtime.points.bytes + runtime.cameras.bytes).toBe(0)
  })

  it('stops at its byte budget without evicting upcoming frames and resumes as playback advances', async () => {
    const load = vi.fn<NormalizedSceneV1['loadFrame']>(async i => frame(i))
    const bytes = retainedPayloadBytesV1(frame(0))
    const runtime = new RecipePlaybackV1(scene(load), bytes * 3, bytes * 3, 2)
    await runtime.loadFrame(0, points)
    runtime.prefetch()
    await vi.waitFor(() => {
      expect(runtime.snapshot().active + runtime.snapshot().queued).toBe(0)
      expect(runtime.points.keys().sort()).toEqual([0, 1, 2])
      expect(runtime.cameras.keys().sort()).toEqual([0, 1, 2])
    })
    const loads = load.mock.calls.length
    runtime.prefetch()
    expect(load).toHaveBeenCalledTimes(loads)
    runtime.focus(2)
    await runtime.loadFrame(2, points)
    runtime.prefetch()
    await vi.waitFor(() => expect(runtime.points.has(4) && runtime.cameras.has(4)).toBe(true))
    expect(runtime.points.keys().sort()).toEqual([2, 3, 4])
    expect(runtime.points.bytes).toBeLessThanOrEqual(bytes * 3)
    expect(runtime.cameras.bytes).toBeLessThanOrEqual(bytes * 3)
    runtime.dispose()
  })

  it('drops superseded results, cancels background reads, and retries foreground failures', async () => {
    const pending = deferred<NormalizedFrameV1>()
    const load = vi.fn<NormalizedSceneV1['loadFrame']>(async i => i === 0 ? pending.promise : frame(i))
    const runtime = new RecipePlaybackV1(scene(load), 4096, 4096)
    const old = runtime.loadFrame(0, points)
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    runtime.focus(40)
    expect((await runtime.loadFrame(40, points)).index).toBe(40)
    pending.resolve(frame(0))
    await rejected
    expect(runtime.points.has(0)).toBe(false)
    load.mockRejectedValueOnce(new Error('temporary failure'))
    runtime.focus(50)
    await expect(runtime.loadFrame(50, points)).rejects.toThrow('temporary failure')
    expect((await runtime.loadFrame(50, points)).index).toBe(50)
    runtime.dispose()
  })
})
