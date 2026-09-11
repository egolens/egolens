import { WorkerPool } from '../../workers/workerPool'
import { POINT_WORKER_CONCURRENCY, CAMERA_WORKER_CONCURRENCY, FILE_FRAME_BATCH_SIZE } from '../../workers/playbackConfig'
import { RecipePlaybackV1 } from './RecipePlayback'
import { mapRecipeWorkerGraphV1 } from './recipeWorkerPlan'
import { ReadSchedulerV1, setReadPriority } from './ReadScheduler'
import type { FrameCapabilityRequest, NormalizedFrameV1, NormalizedSceneV1 } from './normalizedScene'
import type { GraphResourceSnapshotV1 } from './GraphValues'

type Lane = 'point' | 'camera'
type BatchResult = { batchIndex: number }
type FrameWaiter = { index: number; lane: Lane; resolve: () => void; reject: (error: Error) => void }
const aborted = () => new DOMException('Recipe playback disposed.', 'AbortError')

/** Same pools and whole-sequence batch queue as built-in file datasets. */
export class RecipeWorkerPlaybackV1 {
  readonly #frames: RecipePlaybackV1
  readonly #scene: NormalizedSceneV1
  readonly #point: WorkerPool<Record<string, unknown>, BatchResult>
  readonly #camera: WorkerPool<Record<string, unknown>, BatchResult> | null
  readonly #reads = new ReadSchedulerV1(POINT_WORKER_CONCURRENCY + CAMERA_WORKER_CONCURRENCY)
  readonly #lifecycle = new AbortController()
  readonly #batchJobs = new Map<string, Promise<BatchResult>>()
  readonly #attempted = new Set<string>()
  readonly #waiters = new Set<FrameWaiter>()
  readonly #workerResources = new Map<Worker, GraphResourceSnapshotV1>()
  readonly #readSignals = new Set<{ index: number; signal: AbortSignal }>()
  readonly #ready: Promise<unknown>
  #target = 0
  #loads = 0
  #sourceBytes = 0
  #disposed = false

  constructor(scene: NormalizedSceneV1, pointBytes: number, cameraBytes: number) {
    this.#scene = scene
    this.#frames = new RecipePlaybackV1(scene, pointBytes, cameraBytes)
    const plan = scene.recipeWorkerPlan!
    const outputs = mapRecipeWorkerGraphV1(plan.graph.outputs)
    const factory = (lane: Lane) => () => {
      const worker = new Worker(new URL('../../workers/recipeFrameWorker.ts', import.meta.url), { type: 'module' })
      const requests = new Map<number, AbortController>()
      worker.addEventListener('message', ({ data: message }) => {
        if (this.#disposed) return
        if (message.type === 'recipeReadCancel') { requests.get(message.id)?.abort() }
        else if (message.type === 'recipeRead') {
          const controller = new AbortController()
          requests.set(message.id, controller)
          const signal = AbortSignal.any([controller.signal, this.#lifecycle.signal])
          const tracked = { index: message.frameIndex, signal }
          this.#readSignals.add(tracked)
          setReadPriority(signal, Math.abs(message.frameIndex - this.#target))
          const key = JSON.stringify([message.path, message.start, message.end])
          void this.#reads.read(key, signal => plan.source.read(message.path, { start: message.start, end: message.end, signal }), signal).then(bytes => {
            if (this.#disposed) return
            this.#sourceBytes += bytes.byteLength
            if (this.#sourceBytes > 1024 ** 3) throw new Error('GRAPH_SOURCE_BYTE_BUDGET_EXCEEDED')
            worker.postMessage({ type: 'recipeReadResult', id: message.id, bytes }, [bytes])
          }).catch(error => {
            if (!this.#disposed) worker.postMessage({ type: 'recipeReadResult', id: message.id, error: String(error) })
          }).finally(() => { this.#readSignals.delete(tracked); requests.delete(message.id) })
        } else if (message.type === 'recipeFrame') {
          const frame = message.frame as NormalizedFrameV1
          this.#workerResources.set(worker, { ...message.resources, decodedCacheBytes: message.decodedCacheBytes })
          const accepted = this.#frames.acceptWorkerFrame(frame.index, lane, frame)
          this.#loads++
          for (const waiter of [...this.#waiters]) if (waiter.index === frame.index && waiter.lane === lane) {
            this.#waiters.delete(waiter)
            if (accepted) waiter.resolve()
            else waiter.reject(new Error('RECIPE_FRAME_CACHE_BUDGET_EXCEEDED'))
          }
        }
      })
      return worker
    }
    this.#point = new WorkerPool(POINT_WORKER_CONCURRENCY, factory('point'))
    this.#camera = scene.manifest.capabilities.has('cameraImages') ? new WorkerPool(CAMERA_WORKER_CONCURRENCY, factory('camera')) : null
    const input = { recipe: plan.compiledRecipe.recipe, outputs, inventory: plan.inventory, sceneId: plan.sceneId }
    this.#ready = Promise.all([
      this.#point.init({ ...input, lane: 'point', decodedCacheBytes: 32 * 1024 ** 2 }),
      this.#camera?.init({ ...input, lane: 'camera', decodedCacheBytes: 16 * 1024 ** 2 }),
    ]).catch(error => { this.dispose(); throw error })
    void this.#ready.catch(() => {})
  }
  get points() { return this.#frames.points }
  get cameras() { return this.#frames.cameras }
  subscribe(listener: () => void) { return this.#frames.subscribe(listener) }
  getCachedFrame(index: number, request: FrameCapabilityRequest) { return this.#frames.getCachedFrame(index, request) }
  workerDiagnostics() { return { point: this.#point.diagnostics(), camera: this.#camera?.diagnostics() ?? null } }
  snapshot() {
    const point = this.#point.diagnostics(), camera = this.#camera?.diagnostics()
    return { active: point.inFlight + (camera?.inFlight ?? 0), queued: point.queued + (camera?.queued ?? 0),
      loads: this.#loads, cancellations: point.cancelled + (camera?.cancelled ?? 0), target: this.#target }
  }
  graphSnapshot(): GraphResourceSnapshotV1 {
    const initial = this.#scene.snapshotResources?.()
    const values = [...this.#workerResources.values()]
    const reads = this.#reads.snapshot()
    return { nodesExecuted: initial?.nodesExecuted ?? 0, sourceBytesRead: (initial?.sourceBytesRead ?? 0) + this.#sourceBytes,
      allocationBytes: (initial?.allocationBytes ?? 0) + values.reduce((n, v) => n + v.allocationBytes, 0),
      peakAllocationBytes: (initial?.peakAllocationBytes ?? 0) + values.reduce((n, v) => n + v.peakAllocationBytes, 0),
      decodedCacheBytes: values.reduce((n, v) => n + (v.decodedCacheBytes ?? 0), 0),
      rawCacheBytes: this.#scene.recipeWorkerPlan?.source.snapshotResources?.().rawCacheBytes,
      activeReads: reads.active, queuedReads: reads.queued, completedReads: reads.completed }
  }
  focus(index: number): void {
    this.#target = index
    this.#frames.focus(index)
    const batch = Math.floor(index / FILE_FRAME_BATCH_SIZE)
    this.#point.prioritizeBatch(batch); this.#camera?.prioritizeBatch(batch)
    if (this.#batchJobs.has(`point:${batch}`)) this.#point.interruptForBatch(batch)
    if (this.#batchJobs.has(`camera:${batch}`)) this.#camera?.interruptForBatch(batch)
    for (const request of this.#readSignals) setReadPriority(request.signal, Math.abs(request.index - index))
  }
  prefetch(): void {
    void this.#ready.then(() => {
      if (this.#disposed) return
      const count = Math.ceil(this.#scene.index.timestampsMicros.length / FILE_FRAME_BATCH_SIZE)
      const target = Math.floor(this.#target / FILE_FRAME_BATCH_SIZE)
      const batches = [target, ...Array.from({ length: count }, (_, index) => index).filter(index => index !== target)]
      for (const lane of ['point', 'camera'] as const) {
        if (lane === 'camera' && !this.#camera) continue
        for (const batch of batches) {
          const key = `${lane}:${batch}`
          if (!this.#attempted.has(key)) void this.#requestBatch(batch, lane, batch === target).catch(() => {})
        }
      }
    }).catch(() => {})
  }
  async loadFrame(index: number, request: FrameCapabilityRequest): Promise<NormalizedFrameV1> {
    if (this.#disposed || request.signal?.aborted) throw aborted()
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#scene.index.timestampsMicros.length) throw new RangeError('RECIPE_FRAME_OUT_OF_RANGE')
    await this.#ready
    const lanes: Lane[] = []
    if ([...request.capabilities].some(capability => capability !== 'cameraImages') || !request.capabilities.size) lanes.push('point')
    if (request.capabilities.has('cameraImages') && this.#camera) lanes.push('camera')
    await Promise.all(lanes.map(lane => this.#waitForFrame(index, lane)))
    if (this.#disposed || request.signal?.aborted) throw aborted()
    const frame = this.getCachedFrame(index, request)
    if (!frame) throw new Error('RECIPE_FRAME_CACHE_BUDGET_EXCEEDED')
    return frame
  }
  #waitForFrame(index: number, lane: Lane): Promise<void> {
    if ((lane === 'point' ? this.points : this.cameras).has(index)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = { index, lane, resolve, reject }; this.#waiters.add(waiter)
      const batch = Math.floor(index / FILE_FRAME_BATCH_SIZE)
      const pool = lane === 'point' ? this.#point : this.#camera!
      pool.prioritizeBatch(batch)
      void this.#requestBatch(batch, lane, true).then(() => {
        if (this.#waiters.delete(waiter)) reject(new Error('RECIPE_FRAME_NOT_DELIVERED'))
      }).catch(error => { if (this.#waiters.delete(waiter)) reject(error) })
      pool.interruptForBatch(batch)
    })
  }
  #requestBatch(batch: number, lane: Lane, priority = false): Promise<BatchResult> {
    const key = `${lane}:${batch}`
    const pending = this.#batchJobs.get(key)
    if (pending) return pending
    this.#attempted.add(key)
    const pool = lane === 'point' ? this.#point : this.#camera!
    let yielded = false
    const job = pool.requestBatch(batch, { priority }).catch(error => {
      yielded = error instanceof Error && error.name === 'AbortError'
      if (yielded) this.#attempted.delete(key)
      throw error
    }).finally(() => { this.#batchJobs.delete(key); if (yielded && !this.#disposed) this.prefetch() })
    this.#batchJobs.set(key, job)
    return job
  }
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#lifecycle.abort(); this.#reads.dispose()
    this.#point.terminate(); this.#camera?.terminate()
    for (const waiter of this.#waiters) waiter.reject(aborted())
    this.#waiters.clear(); this.#batchJobs.clear(); this.#workerResources.clear(); this.#readSignals.clear()
    this.#frames.dispose()
  }
}
