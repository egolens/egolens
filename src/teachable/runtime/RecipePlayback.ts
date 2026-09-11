import type { FrameCapabilityRequest, NormalizedCapabilityV1, NormalizedFrameV1, NormalizedSceneV1 } from './normalizedScene'
import { PayloadCacheV1, retainedPayloadBytesV1 } from './PayloadCache'
import { setReadPriority } from './ReadScheduler'

type Lane = 'point' | 'camera'
interface FrameJob {
  index: number
  lane: Lane
  controller: AbortController
  promise: Promise<NormalizedFrameV1>
  resolve: (frame: NormalizedFrameV1) => void
  reject: (error: unknown) => void
  active: boolean
}
const abortError = () => new DOMException('Recipe frame request was superseded.', 'AbortError')

/** Common recipe playback: independent camera delivery and byte-bounded streaming. */
export class RecipePlaybackV1 {
  readonly points: PayloadCacheV1<number, NormalizedFrameV1>
  readonly cameras: PayloadCacheV1<number, NormalizedFrameV1>
  readonly #jobs = new Map<string, FrameJob>()
  readonly #composed = new Map<number, { selection: string; point?: NormalizedFrameV1; camera?: NormalizedFrameV1; frame: NormalizedFrameV1 }>()
  #target = 0
  #active = 0
  #disposed = false
  readonly #listeners = new Set<() => void>()
  #loads = 0
  #cancellations = 0
  #prefetchEnabled = false
  #filling = false
  #cursor: Record<Lane, number> = { point: 0, camera: 0 }
  #frameBytes: Record<Lane, number> = { point: 0, camera: 0 }
  #budgetBlocked: Record<Lane, boolean> = { point: false, camera: false }
  readonly scene: NormalizedSceneV1
  readonly lookahead: number
  constructor(scene: NormalizedSceneV1, pointBytes: number, cameraBytes: number, lookahead = 4) {
    this.scene = scene
    this.lookahead = lookahead
    this.points = new PayloadCacheV1(pointBytes)
    this.cameras = new PayloadCacheV1(cameraBytes)
  }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  /** Shared frame ownership for the WorkerPool-backed batch path. */
  acceptWorkerFrame(index: number, lane: Lane, frame: NormalizedFrameV1): boolean {
    if (this.#disposed) return false
    const cache = lane === 'point' ? this.points : this.cameras
    const accepted = cache.set(index, frame, retainedPayloadBytesV1(frame), () => this.#composed.delete(index), this.#target)
    if (accepted) for (const listener of this.#listeners) listener()
    return accepted
  }
  snapshot() { return { active: this.#active, queued: [...this.#jobs.values()].filter(j => !j.active).length, loads: this.#loads, cancellations: this.#cancellations, target: this.#target } }
  focus(index: number): void {
    if (index === this.#target) return
    this.#target = index
    this.#cursor = { point: index, camera: index }
    this.#budgetBlocked = { point: false, camera: false }
    for (const [key, job] of this.#jobs) {
      if (job.index !== index) {
        this.#jobs.delete(key)
        job.controller.abort()
        job.reject(abortError())
        this.#cancellations++
      } else setReadPriority(job.controller.signal, this.#priority(job))
    }
  }
  prefetch(): void {
    if (this.#disposed) return
    this.#prefetchEnabled = true
    this.#fill()
  }
  #makeRoom(lane: Lane, bytes: number): boolean {
    const cache = lane === 'point' ? this.points : this.cameras
    if (bytes > cache.limit) return false
    // Background work can reclaim history, but must not evict the buffered future.
    for (const index of cache.keys().filter(i => i < this.#target).sort((a, b) => a - b)) {
      if (cache.bytes + bytes <= cache.limit) break
      cache.delete(index)
    }
    return cache.bytes + bytes <= cache.limit
  }
  #fill(): void {
    if (this.#disposed || !this.#prefetchEnabled) return
    this.#filling = true
    try {
      for (const lane of ['point', 'camera'] as const) {
        if (lane === 'camera' && !this.scene.manifest.capabilities.has('cameraImages')) continue
        if (this.#budgetBlocked[lane]) continue
        const cache = lane === 'point' ? this.points : this.cameras
        let pending = [...this.#jobs.values()].filter(job => job.lane === lane).length
        // Measure one frame first, then reserve space for the bounded pending queue.
        const queueLimit = this.#frameBytes[lane] ? this.lookahead : 1
        while (pending < queueLimit && this.#cursor[lane] < this.scene.index.timestampsMicros.length) {
          const index = this.#cursor[lane]
          if (cache.has(index) || this.#jobs.has(`${lane}:${index}`)) { this.#cursor[lane]++; continue }
          if (!this.#makeRoom(lane, this.#frameBytes[lane] * (pending + 1))) break
          this.#cursor[lane]++
          pending++
          void this.#request(index, lane).catch(() => {})
        }
      }
    } finally { this.#filling = false }
    this.#pump()
  }
  getCachedFrame(index: number, request: FrameCapabilityRequest): NormalizedFrameV1 | null {
    const needsCamera = request.capabilities.has('cameraImages') && this.scene.manifest.capabilities.has('cameraImages')
    const needsPoint = [...request.capabilities].some(c => c !== 'cameraImages')
    const point = this.points.get(index)
    const camera = this.cameras.get(index)
    if ((needsPoint && !point) || (needsCamera && !camera)) return null
    const base = point ?? camera
    if (!base) return null
    const selection = [...request.capabilities].sort().join(',')
    const previous = this.#composed.get(index)
    if (previous && previous.selection === selection && previous.point === point && previous.camera === camera) return previous.frame
    const frame = {
      ...base,
      pointClouds: request.capabilities.has('pointClouds') ? base.pointClouds : [],
      radarPointClouds: request.capabilities.has('radarPointClouds') ? base.radarPointClouds : [],
      lidarSegmentation: request.capabilities.has('lidarSegmentation') ? base.lidarSegmentation : [],
      cameraImages: needsCamera ? (camera?.cameraImages ?? []) : [],
    }
    this.#composed.set(index, { selection, point, camera, frame })
    return frame
  }
  async loadFrame(index: number, request: FrameCapabilityRequest): Promise<NormalizedFrameV1> {
    if (this.#disposed || request.signal?.aborted) throw abortError()
    if (!Number.isInteger(index) || index < 0 || index >= this.scene.index.timestampsMicros.length) throw new RangeError('RECIPE_FRAME_OUT_OF_RANGE')
    const needsCamera = request.capabilities.has('cameraImages') && this.scene.manifest.capabilities.has('cameraImages')
    const needsPoint = [...request.capabilities].some(c => c !== 'cameraImages') || !needsCamera
    const work: Promise<NormalizedFrameV1>[] = []
    if (needsPoint) work.push(this.#request(index, 'point'))
    if (needsCamera) work.push(this.#request(index, 'camera'))
    await Promise.all(work)
    if (this.#disposed || request.signal?.aborted) throw abortError()
    const frame = this.getCachedFrame(index, request)
    if (!frame) throw new Error('RECIPE_FRAME_CACHE_BUDGET_EXCEEDED')
    return frame
  }
  dispose(): void {
    this.#disposed = true
    for (const job of this.#jobs.values()) { job.controller.abort(); job.reject(abortError()); this.#cancellations++ }
    this.#jobs.clear()
    this.points.clear()
    this.cameras.clear()
    this.#composed.clear()
    this.#listeners.clear()
  }
  #priority(job: Pick<FrameJob, 'index' | 'lane'>): number {
    return job.index === this.#target ? (job.lane === 'point' ? 0 : 1) : 2 + Math.abs(job.index - this.#target) * 2 + (job.lane === 'camera' ? 1 : 0)
  }
  #request(index: number, lane: Lane): Promise<NormalizedFrameV1> {
    if (this.#disposed) return Promise.reject(abortError())
    const cached = (lane === 'point' ? this.points : this.cameras).get(index)
    if (cached) return Promise.resolve(cached)
    const key = `${lane}:${index}`
    const existing = this.#jobs.get(key)
    if (existing) return existing.promise
    let resolve!: FrameJob['resolve']
    let reject!: FrameJob['reject']
    const promise = new Promise<NormalizedFrameV1>((ok, fail) => { resolve = ok; reject = fail })
    const job: FrameJob = { index, lane, controller: new AbortController(), promise, resolve, reject, active: false }
    setReadPriority(job.controller.signal, this.#priority(job))
    this.#jobs.set(key, job)
    if (!this.#filling) this.#pump()
    return promise
  }
  #pump(): void {
    if (this.#disposed) return
    while (this.#active < 2) {
      const job = [...this.#jobs.values()].filter(j => !j.active).sort((a, b) => this.#priority(a) - this.#priority(b))[0]
      if (!job) return
      job.active = true
      this.#active++
      void this.#execute(job)
    }
  }
  async #execute(job: FrameJob): Promise<void> {
    const key = `${job.lane}:${job.index}`
    try {
      const capabilities = job.lane === 'camera'
        ? new Set<NormalizedCapabilityV1>(['cameraImages'])
        : new Set([...this.scene.manifest.capabilities].filter(c => c !== 'cameraImages'))
      const frame = await this.scene.loadFrame(job.index, { capabilities, signal: job.controller.signal })
      if (this.#disposed || job.controller.signal.aborted) throw abortError()
      const cache = job.lane === 'point' ? this.points : this.cameras
      const bytes = retainedPayloadBytesV1(frame)
      this.#frameBytes[job.lane] = Math.max(this.#frameBytes[job.lane], bytes)
      if (job.index !== this.#target && !this.#makeRoom(job.lane, bytes)) {
        this.#budgetBlocked[job.lane] = true
        throw new Error('RECIPE_FRAME_CACHE_BUDGET_EXCEEDED')
      }
      const retained = cache.set(job.index, frame, bytes, () => this.#composed.delete(job.index), this.#target)
      if (!retained) throw new Error('RECIPE_FRAME_CACHE_BUDGET_EXCEEDED')
      this.#loads++
      job.resolve(frame)
      for (const listener of this.#listeners) listener()
    } catch (error) { job.controller.abort(); job.reject(error) }
    finally {
      if (this.#jobs.get(key) === job) this.#jobs.delete(key)
      this.#active--
      this.#fill()
      this.#pump()
    }
  }
}
