import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecipeWorkerPlaybackV1 } from '../runtime/RecipeWorkerPlayback'
import { mapRecipeWorkerGraphV1, frameTransferBuffersV1 } from '../runtime/recipeWorkerPlan'
import type { NormalizedFrameV1, NormalizedSceneV1 } from '../runtime/normalizedScene'
import { RemoteByteSourceV1 } from '../source/RemoteByteSource'
import { sourceCatalogHashV1 } from '../source/SourceCatalog'
import { sha256DigestV1 } from '../source/sha256'

const resources = { nodesExecuted: 0, sourceBytesRead: 0, allocationBytes: 0, peakAllocationBytes: 0 }
const frame = (index: number): NormalizedFrameV1 => ({ index, timestampMicros: BigInt(index), worldFromEgo: null,
  pointClouds: [], radarPointClouds: [], cameraImages: [], boxes3d: [], boxes2d: [], keypoints3d: [], keypoints2d: [], lidarSegmentation: [], cameraSegmentation: [] })
type Message = { type: string; lane?: string; batchIndex?: number; requestId?: number; [key: string]: unknown }
class MockWorker {
  static instances: MockWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror = null
  listeners: ((event: MessageEvent) => void)[] = []
  messages: Message[] = []
  terminated = false
  constructor() { MockWorker.instances.push(this) }
  addEventListener(_type: string, callback: (event: MessageEvent) => void) { this.listeners.push(callback) }
  postMessage(message: Message) {
    this.messages.push(structuredClone(message))
    if (message.type === 'init') queueMicrotask(() => this.emit({ type: 'ready', numBatches: 8 }))
    if (message.type === 'yieldBatch') queueMicrotask(() => this.emit({ type: 'batchYielded', requestId: message.requestId }))
  }
  emit(message: Message) {
    const event = { data: message } as MessageEvent
    for (const listener of this.listeners) listener(event)
    this.onmessage?.(event)
  }
  terminate() { this.terminated = true }
  get lane() { return this.messages.find(message => message.type === 'init')?.lane }
}

function makeScene(): NormalizedSceneV1 {
  const source = { has: () => true, byteLength: () => 8, read: vi.fn(async () => new ArrayBuffer(8)), asyncBuffer: vi.fn() }
  return {
    manifest: { id: 'test', name: 'test', nominalFrameRate: 10, sensors: [], taxonomies: [], pointAttributes: [],
      pointLayout: { interleavedAttributes: ['x', 'y', 'z'], colorModes: [] }, capabilities: new Set(['pointClouds', 'cameraImages']) },
    index: { timestampsMicros: Array.from({ length: 80 }, (_, i) => BigInt(i)), segments: [] },
    relations: { staticTransforms: [], cameraCalibrations: new Map(), trajectories: new Map(), box2dToBox3d: new Map() },
    loadFrame: vi.fn(), dispose() {}, snapshotResources: () => resources,
    recipeWorkerPlan: { compiledRecipe: { recipe: {} } as never, graph: { outputs: new Map(), resources, abortController: new AbortController(), dispose() {} }, source, inventory: [] },
  }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); MockWorker.instances = [] })

describe('recipe WorkerPool parity', () => {
  it('uses 3+2 workers, streams the first frame, queues every batch, yields for a seek, and terminates all pools', async () => {
    vi.stubGlobal('Worker', MockWorker)
    const runtime = new RecipeWorkerPlaybackV1(makeScene(), 1024 ** 2, 1024 ** 2)
    const request = { capabilities: new Set(['pointClouds'] as const) }
    const first = runtime.loadFrame(0, request)
    await vi.waitFor(() => expect(MockWorker.instances.some(worker => worker.messages.some(message => message.type === 'loadBatch'))).toBe(true))
    expect(MockWorker.instances.filter(worker => worker.lane === 'point')).toHaveLength(3)
    expect(MockWorker.instances.filter(worker => worker.lane === 'camera')).toHaveLength(2)
    const initial = MockWorker.instances.find(worker => worker.messages.some(message => message.type === 'loadBatch'))!
    initial.emit({ type: 'recipeFrame', frame: frame(0), resources })
    expect((await first).index).toBe(0)
    expect(runtime.workerDiagnostics().point.inFlight).toBe(1)
    runtime.prefetch()
    await vi.waitFor(() => expect(runtime.workerDiagnostics().point.requests).toBe(8))
    expect(runtime.workerDiagnostics().point).toMatchObject({ inFlight: 3, queued: 5 })
    expect(runtime.workerDiagnostics().camera).toMatchObject({ inFlight: 2, queued: 6, requests: 8 })
    runtime.focus(40)
    const selected = runtime.loadFrame(40, request)
    await vi.waitFor(() => expect(initial.messages.some(message => message.type === 'loadBatch' && message.batchIndex === 4)).toBe(true))
    initial.emit({ type: 'recipeFrame', frame: frame(40), resources })
    expect((await selected).index).toBe(40)
    initial.emit({ type: 'recipeFrame', frame: frame(1), resources })
    expect(runtime.getCachedFrame(40, request)?.index).toBe(40)
    expect(runtime.workerDiagnostics().point).toMatchObject({ cancelled: 1, failed: 0 })
    runtime.dispose()
    expect(MockWorker.instances.every(worker => worker.terminated)).toBe(true)
    expect(runtime.points.bytes + runtime.cameras.bytes).toBe(0)
    expect(runtime.workerDiagnostics().point).toMatchObject({ workers: 0, inFlight: 0, queued: 0, terminated: true })
  })

  it('copies a prepared graph without transferring or retaining its live caches', () => {
    const bytes = new Float32Array([1, 2, 3])
    const collection = { kind: 'binary-collection', context: { throwIfAborted() {} }, cache: new Map([['a', Promise.resolve(bytes)]]), retainedReleases: new Map([['a', () => {}]]), files: [], decoder: {} }
    const graph = new Map([['one', { collection, bytes }], ['two', { collection, bytes }]])
    const encoded = structuredClone(mapRecipeWorkerGraphV1(graph)) as typeof graph
    expect(encoded.get('one')!.collection).toBe(encoded.get('two')!.collection)
    expect(encoded.get('one')!.collection.cache.size).toBe(0)
    expect(collection.cache.size).toBe(1)
    const clone = structuredClone({ values: bytes, duplicate: bytes })
    expect(frameTransferBuffersV1(clone)).toHaveLength(1)
    structuredClone(clone, { transfer: frameTransferBuffersV1(clone) })
    expect(bytes.byteLength).toBe(12)
    expect(clone.values.byteLength).toBe(0)
  })

  it('starts a shared view at its selected camera batch before queueing the rest', async () => {
    vi.stubGlobal('Worker', MockWorker)
    const runtime = new RecipeWorkerPlaybackV1(makeScene(), 1024 ** 2, 1024 ** 2)
    runtime.focus(40)
    const selected = runtime.loadFrame(40, { capabilities: new Set(['pointClouds']) })
    await vi.waitFor(() => expect(MockWorker.instances.some(worker => worker.messages.some(message => message.type === 'loadBatch'))).toBe(true))
    const point = MockWorker.instances.find(worker => worker.messages.some(message => message.type === 'loadBatch'))!
    expect(point.messages.find(message => message.type === 'loadBatch')?.batchIndex).toBe(4)
    point.emit({ type: 'recipeFrame', frame: frame(40), resources })
    await selected
    runtime.prefetch()
    await vi.waitFor(() => expect(runtime.workerDiagnostics().camera?.requests).toBe(8))
    const camera = MockWorker.instances.find(worker => worker.lane === 'camera')!
    expect(camera.messages.find(message => message.type === 'loadBatch')?.batchIndex).toBe(4)
    runtime.dispose()
  })

  it('reuses downloaded objects without hashing their contents', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const payload = { schema: 'egolens-source-catalog-v1' as const, entries: [{ path: 'x.bin', size: bytes.length, sha256: sha256DigestV1(bytes) }] }
    const source = new RemoteByteSourceV1({ rootUrl: 'https://data.example.test/', catalog: { ...payload, catalogHash: sourceCatalogHashV1(payload) }, fetch: vi.fn(async () => new Response(bytes.slice())) })
    const digest = vi.spyOn(crypto.subtle, 'digest')
    expect(await source.read('x.bin')).toEqual(bytes.buffer)
    expect(await source.read('x.bin')).toEqual(bytes.buffer)
    expect(digest).not.toHaveBeenCalled()
    source.dispose()
  })
})
