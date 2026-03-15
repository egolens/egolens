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
    const readyPromises: Promise<{ type: 'ready'; numBatches: number }>[] = []

    for (let i = 0; i < this.concurrency; i++) {
      const worker = this.workerFactory()

      const poolWorker: PoolWorker = { worker, busy: false, ready: false }
      this.workers.push(poolWorker)

      const readyPromise = new Promise<{ type: 'ready'; numBatches: number }>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<PoolWorkerResponse>) => {
          if (e.data.type === 'ready') {
            poolWorker.ready = true
            worker.onmessage = (ev: MessageEvent<PoolWorkerResponse>) =>
              this.handleWorkerMessage(i, ev)
            resolve(e.data as { type: 'ready'; numBatches: number })
          } else if (e.data.type === 'error') {
            reject(new Error(e.data.message ?? 'Worker init failed'))
          }
        }
        worker.onerror = (e) => reject(new Error(e.message))
      })

      readyPromises.push(readyPromise)

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

    const results = await Promise.all(readyPromises)
    this.numBatches = results[0].numBatches
    return { numBatches: this.numBatches }
  }

  /**
   * Re-initialize existing workers with a new file (skip worker creation).
   * Much faster than terminate + init — reuses WASM modules.
   */
  async reinit(payload: TInitPayload): Promise<{ numBatches: number }> {
    // Reject in-flight and queued promises so callers don't hang
    this.rejectAllPending('Worker pool reinitialized')
    this.nextRequestId = 0

    const readyPromises: Promise<{ type: 'ready'; numBatches: number }>[] = []

    for (let i = 0; i < this.workers.length; i++) {
      const pw = this.workers[i]
      pw.busy = false
      pw.ready = false

      const readyPromise = new Promise<{ type: 'ready'; numBatches: number }>((resolve, reject) => {
        pw.worker.onmessage = (e: MessageEvent<PoolWorkerResponse>) => {
          if (e.data.type === 'ready') {
            pw.ready = true
            pw.worker.onmessage = (ev: MessageEvent<PoolWorkerResponse>) =>
              this.handleWorkerMessage(i, ev)
            resolve(e.data as { type: 'ready'; numBatches: number })
          } else if (e.data.type === 'error') {
            reject(new Error(e.data.message ?? 'Worker reinit failed'))
          }
        }
      })

      readyPromises.push(readyPromise)

      const enableMemLog = typeof window !== 'undefined' && (
        (window as Window).__WAYMO_MEMORY_LOG === true ||
        localStorage.getItem('waymo-memory-log') === 'true'
      )

      pw.worker.postMessage({
        ...payload,
        type: 'init',
        workerIndex: i,
        enableMemLog,
      })
    }

    const results = await Promise.all(readyPromises)
    this.numBatches = results[0].numBatches
    return { numBatches: this.numBatches }
  }

  /** Total batches available (row groups for Waymo). */
  getNumBatches(): number {
    return this.numBatches
  }

  // Legacy alias
  getNumRowGroups(): number {
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
  requestBatch(batchIndex: number): Promise<TResult> {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++

      // Find an idle worker, but also respect maxConcurrentFetches
      const idle = this.workers.find((w) => w.ready && !w.busy)
      if (idle && this.inFlightCount < this.maxConcurrentFetches) {
        this.dispatchToWorker(idle, requestId, batchIndex, resolve, reject)
      } else {
        // All busy or fetch limit reached — queue it
        this.waitQueue.push({ requestId, batchIndex, resolve, reject })
      }
    })
  }

  // Legacy alias
  requestRowGroup(batchIndex: number): Promise<TResult> {
    return this.requestBatch(batchIndex)
  }

  /** Terminate all workers. */
  terminate(): void {
    this.rejectAllPending('Worker pool terminated')
    for (const pw of this.workers) {
      pw.worker.terminate()
    }
    this.workers = []
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Reject all in-flight and queued promises so callers don't hang. */
  private rejectAllPending(reason: string): void {
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
    e: MessageEvent<PoolWorkerResponse | { type: '__memorySnapshot'; snapshot: MemorySnapshot }>,
  ): void {
    const msg = e.data

    // Forward worker memory snapshots to main thread logger
    if (msg.type === '__memorySnapshot' && 'snapshot' in msg) {
      memLog.addWorkerSnapshot(msg.snapshot)
      return
    }

    const pw = this.workers[workerIndex]

    if (msg.type === 'batchReady' || msg.type === 'error') {
      const rid = 'requestId' in msg ? msg.requestId : -1
      const pending = this.pendingRequests.get(rid ?? -1)
      if (pending) {
        this.pendingRequests.delete(rid!)
        if (msg.type === 'error') {
          pending.reject(new Error(msg.message ?? 'Worker error'))
        } else {
          pending.resolve(msg as unknown as TResult)
        }
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
