/**
 * Generic Worker Pool — manages N workers for parallel batch loading.
 *
 * Dataset-agnostic: the pool doesn't know what kind of worker it manages.
 * The caller provides a `workerFactory` function and an opaque init payload.
 *
 * Usage:
 *   const pool = new WorkerPool<WaymoLidarInitPayload, LidarBatchResult>(
 *     4,
 *     () => new Worker(new URL('./waymoLidarWorker.ts', import.meta.url), { type: 'module' }),
 *   )
 *   await pool.init({ lidarUrl, calibrationEntries })
 *   const result = await pool.requestBatch(0)
 *   pool.terminate()
 */

import { memLog } from '../utils/memoryLogger'
import type { MemorySnapshot } from '../utils/memoryLogger'
import type { WorkerPoolPerformanceSnapshotV1 } from '../teachable/runtime/performanceProbe'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Response union that the pool can handle (ready | batchReady | error) */
interface PoolWorkerResponse {
  type: string
  requestId?: number
  numBatches?: number
  message?: string
}

interface PendingRequest<TResult> {
  resolve: (result: TResult) => void
  reject: (err: Error) => void
}

interface PoolWorker {
  worker: Worker
  busy: boolean
  ready: boolean
}

// ---------------------------------------------------------------------------
// WorkerPool
// ---------------------------------------------------------------------------

export class WorkerPool<TInitPayload extends Record<string, unknown> = Record<string, unknown>, TResult = unknown> {
  private workers: PoolWorker[] = []
  private pendingRequests = new Map<number, PendingRequest<TResult>>()
  private nextRequestId = 0
  private numBatches = 0
  /** Queue of batch requests waiting for an idle worker */
  private waitQueue: Array<{
    requestId: number
    batchIndex: number
    resolve: (result: TResult) => void
    reject: (err: Error) => void
  }> = []

  readonly concurrency: number
  private workerFactory: () => Worker

  /**
   * Optional limit on total in-flight batch dispatches across all workers.
   * Useful for URL mode where concurrent network requests should be throttled
   * to avoid overwhelming the server. Default: unlimited (local/File mode).
   */
  readonly maxConcurrentFetches: number

  /** Current count of in-flight dispatched batches (across all workers). */
  private inFlightCount = 0
  private lifecycleGeneration = 0
  private terminated = false
  private requestCount = 0
  private completedCount = 0
  private failedCount = 0
  private cancelledCount = 0
  private staleResponseCount = 0
  /** Initialization promises must settle when their owning scene is disposed. */
  private pendingInitRejects = new Set<(reason?: unknown) => void>()

  constructor(concurrency: number, workerFactory: () => Worker, maxConcurrentFetches?: number) {
    this.concurrency = concurrency
    this.workerFactory = workerFactory
    this.maxConcurrentFetches = maxConcurrentFetches ?? Infinity
  }

  /**
   * Initialize all workers. Each opens the data source independently.
   * Resolves when ALL workers are ready.
   *
   * The pool adds `type: 'init'`, `workerIndex`, and `enableMemLog`
   * to the provided payload before sending to each worker.
   */
  async init(payload: TInitPayload): Promise<{ numBatches: number }> {
    if (this.terminated) throw new Error('Worker pool has been terminated')
    const generation = this.lifecycleGeneration
    const readyPromises: Promise<{ type: 'ready'; numBatches: number }>[] = []

    for (let i = 0; i < this.concurrency; i++) {
      const worker = this.workerFactory()

      const poolWorker: PoolWorker = { worker, busy: false, ready: false }
      this.workers.push(poolWorker)

      let rejectInit!: (reason?: unknown) => void
      const readyPromise = new Promise<{ type: 'ready'; numBatches: number }>((resolve, reject) => {
        rejectInit = reject
        this.pendingInitRejects.add(reject)
        worker.onmessage = (e: MessageEvent<PoolWorkerResponse>) => {
          if (e.data.type === 'ready') {
            poolWorker.ready = true
            worker.onmessage = (ev: MessageEvent<PoolWorkerResponse>) =>
              this.handleWorkerMessage(i, generation, ev)
            resolve(e.data as { type: 'ready'; numBatches: number })
          } else if (e.data.type === 'error') {
            reject(new Error(e.data.message ?? 'Worker init failed'))
          }
        }
        worker.onerror = (e) => reject(new Error(e.message))
      })

      readyPromises.push(readyPromise.finally(() => {
        this.pendingInitRejects.delete(rejectInit)
      }))

      // Check if memory logging is enabled on main thread
      const enableMemLog = typeof window !== 'undefined' && (
        (window as Window).__WAYMO_MEMORY_LOG === true ||
        localStorage.getItem('waymo-memory-log') === 'true'
      )

      worker.postMessage({
        ...payload,
        type: 'init',
        workerIndex: i,
        enableMemLog,
      })
    }

    try {
      const results = await Promise.all(readyPromises)
      this.numBatches = results[0].numBatches
      return { numBatches: this.numBatches }
    } catch (error) {
      this.terminate()
      throw error
    }
  }

  /** Total batches available (row groups for Waymo). */
  getNumBatches(): number {
    return this.numBatches
  }

  /** Whether the pool is initialized and has at least one ready worker. */
  isReady(): boolean {
    return this.workers.some((w) => w.ready)
  }

  /**
   * Request a batch to be loaded. Dispatches to an idle worker,
   * or queues the request if all workers are busy or the in-flight
   * fetch limit has been reached.
   */
  requestBatch(batchIndex: number, opts?: { priority?: boolean }): Promise<TResult> {
    if (this.terminated) return Promise.reject(new Error('Worker pool has been terminated'))
    this.requestCount += 1
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++

      // Find an idle worker, but also respect maxConcurrentFetches
      const idle = this.workers.find((w) => w.ready && !w.busy)
      if (idle && this.inFlightCount < this.maxConcurrentFetches) {
        this.dispatchToWorker(idle, requestId, batchIndex, resolve, reject)
      } else if (opts?.priority) {
        // Frames someone is waiting to watch (a t0/t1 range) go to the head
        // of the queue. Stating the intent here means callers never have to
        // depend on having queued before the bulk prefetch.
        this.waitQueue.unshift({ requestId, batchIndex, resolve, reject })
      } else {
        // All busy or fetch limit reached — queue it
        this.waitQueue.push({ requestId, batchIndex, resolve, reject })
      }
    })
  }

  /** Terminate all workers. */
  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    this.lifecycleGeneration += 1
    this.cancelledCount += this.pendingInitRejects.size
    for (const reject of this.pendingInitRejects) reject(new Error('Worker pool terminated during initialization'))
    this.pendingInitRejects.clear()
    this.rejectAllPending('Worker pool terminated')
    for (const pw of this.workers) {
      pw.worker.onmessage = null
      pw.worker.onerror = null
      pw.worker.terminate()
    }
    this.workers = []
  }

  diagnostics(): WorkerPoolPerformanceSnapshotV1 {
    return {
      workers: this.workers.length,
      readyWorkers: this.workers.filter((worker) => worker.ready).length,
      queued: this.waitQueue.length,
      inFlight: this.inFlightCount,
      requests: this.requestCount,
      completed: this.completedCount,
      failed: this.failedCount,
      cancelled: this.cancelledCount,
      staleResponses: this.staleResponseCount,
      terminated: this.terminated,
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Reject all in-flight and queued promises so callers don't hang. */
  private rejectAllPending(reason: string): void {
    this.cancelledCount += this.pendingRequests.size + this.waitQueue.length
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error(reason))
    }
    this.pendingRequests.clear()
    this.inFlightCount = 0

    for (const { reject } of this.waitQueue) {
      reject(new Error(reason))
    }
    this.waitQueue = []
  }

  private dispatchToWorker(
    pw: PoolWorker,
    requestId: number,
    batchIndex: number,
    resolve: (result: TResult) => void,
    reject: (err: Error) => void,
  ): void {
    pw.busy = true
    this.inFlightCount++
    this.pendingRequests.set(requestId, { resolve, reject })
    pw.worker.postMessage({
      type: 'loadBatch',
      requestId,
      batchIndex,
    })
  }

  private handleWorkerMessage(
    workerIndex: number,
    generation: number,
    e: MessageEvent<PoolWorkerResponse | { type: '__memorySnapshot'; snapshot: MemorySnapshot }>,
  ): void {
    const msg = e.data

    if (generation !== this.lifecycleGeneration || this.terminated) {
      this.staleResponseCount += 1
      return
    }

    // Forward worker memory snapshots to main thread logger
    if (msg.type === '__memorySnapshot' && 'snapshot' in msg) {
      memLog.addWorkerSnapshot(msg.snapshot)
      return
    }

    const pw = this.workers[workerIndex]
    if (!pw) {
      this.staleResponseCount += 1
      return
    }

    if (msg.type === 'batchReady' || msg.type === 'error') {
      const rid = 'requestId' in msg ? msg.requestId : -1
      const pending = this.pendingRequests.get(rid ?? -1)
      if (!pending) {
        this.staleResponseCount += 1
        return
      }
      this.pendingRequests.delete(rid!)
      if (msg.type === 'error') {
        this.failedCount += 1
        pending.reject(new Error(msg.message ?? 'Worker error'))
      } else {
        this.completedCount += 1
        pending.resolve(msg as unknown as TResult)
      }

      // Worker is now idle — decrement in-flight counter and dispatch next
      pw.busy = false
      this.inFlightCount--
      this.drainQueue()
    }
  }

  private drainQueue(): void {
    while (this.waitQueue.length > 0) {
      // Respect both worker availability and in-flight fetch limit
      if (this.inFlightCount >= this.maxConcurrentFetches) break
      const idle = this.workers.find((w) => w.ready && !w.busy)
      if (!idle) break

      const next = this.waitQueue.shift()!
      this.dispatchToWorker(idle, next.requestId, next.batchIndex, next.resolve, next.reject)
    }
  }
}
