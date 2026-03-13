/**
 * LiDAR Worker Pool — manages N workers for parallel batch loading.
 *
 * Each worker independently opens the same data source and can process
 * batches concurrently. A "batch" maps to a Parquet row group for Waymo
 * (~51 frames per batch) or a group of per-frame files for nuScenes.
 *
 * Usage:
 *   const pool = new WorkerPool(4)
 *   await pool.init({ lidarUrl, calibrationEntries })
 *   const result = await pool.requestBatch(0)  // dispatches to idle worker
 *   pool.terminate()
 */

import type {
  WaymoLidarWorkerRequest,
  DataWorkerResponse,
} from './dataWorker'
import type {
  LidarBatchResult,
  LidarWorkerReady,
} from './types'
import type { LidarCalibration } from '../utils/rangeImage'
import { memLog } from '../utils/memoryLogger'
import type { MemorySnapshot } from '../utils/memoryLogger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerPoolInitOptions {
  lidarUrl: string | File
  calibrationEntries: [number, LidarCalibration][]
}

interface PendingRequest {
  resolve: (result: LidarBatchResult) => void
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

export class WorkerPool {
  private workers: PoolWorker[] = []
  private pendingRequests = new Map<number, PendingRequest>()
  private nextRequestId = 0
  private numBatches = 0
  /** Queue of batch requests waiting for an idle worker */
  private waitQueue: Array<{
    requestId: number
    batchIndex: number
    resolve: (result: LidarBatchResult) => void
    reject: (err: Error) => void
  }> = []

  readonly concurrency: number

  constructor(concurrency: number) {
    this.concurrency = concurrency
  }

  /**
   * Initialize all workers. Each opens the data source independently.
   * Resolves when ALL workers are ready.
   */
  async init(opts: WorkerPoolInitOptions): Promise<{ numBatches: number }> {
    const readyPromises: Promise<LidarWorkerReady>[] = []

    for (let i = 0; i < this.concurrency; i++) {
      const worker = new Worker(
        new URL('./dataWorker.ts', import.meta.url),
        { type: 'module' },
      )

      const poolWorker: PoolWorker = { worker, busy: false, ready: false }
      this.workers.push(poolWorker)

      const readyPromise = new Promise<LidarWorkerReady>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<DataWorkerResponse>) => {
          if (e.data.type === 'ready') {
            poolWorker.ready = true
            worker.onmessage = (ev: MessageEvent<DataWorkerResponse>) =>
              this.handleWorkerMessage(i, ev)
            resolve(e.data)
          } else if (e.data.type === 'error') {
            reject(new Error(e.data.message))
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

      const initMsg: WaymoLidarWorkerRequest = {
        type: 'init',
        lidarUrl: opts.lidarUrl,
        calibrationEntries: opts.calibrationEntries,
        workerIndex: i,
        enableMemLog,
      }
      worker.postMessage(initMsg)
    }

    const results = await Promise.all(readyPromises)
    this.numBatches = results[0].numBatches
    return { numBatches: this.numBatches }
  }

  /**
   * Re-initialize existing workers with a new file (skip worker creation).
   * Much faster than terminate + init — reuses WASM modules.
   */
  async reinit(opts: WorkerPoolInitOptions): Promise<{ numBatches: number }> {
    // Reject in-flight and queued promises so callers don't hang
    this.rejectAllPending('Worker pool reinitialized')
    this.nextRequestId = 0

    const readyPromises: Promise<LidarWorkerReady>[] = []

    for (let i = 0; i < this.workers.length; i++) {
      const pw = this.workers[i]
      pw.busy = false
      pw.ready = false

      const readyPromise = new Promise<LidarWorkerReady>((resolve, reject) => {
        pw.worker.onmessage = (e: MessageEvent<DataWorkerResponse>) => {
          if (e.data.type === 'ready') {
            pw.ready = true
            pw.worker.onmessage = (ev: MessageEvent<DataWorkerResponse>) =>
              this.handleWorkerMessage(i, ev)
            resolve(e.data)
          } else if (e.data.type === 'error') {
            reject(new Error(e.data.message))
          }
        }
      })

      readyPromises.push(readyPromise)

      const enableMemLog = typeof window !== 'undefined' && (
        (window as Window).__WAYMO_MEMORY_LOG === true ||
        localStorage.getItem('waymo-memory-log') === 'true'
      )

      const initMsg: WaymoLidarWorkerRequest = {
        type: 'init',
        lidarUrl: opts.lidarUrl,
        calibrationEntries: opts.calibrationEntries,
        workerIndex: i,
        enableMemLog,
      }
      pw.worker.postMessage(initMsg)
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
   * or queues the request if all workers are busy.
   */
  requestBatch(batchIndex: number): Promise<LidarBatchResult> {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++

      // Find an idle worker
      const idle = this.workers.find((w) => w.ready && !w.busy)
      if (idle) {
        this.dispatchToWorker(idle, requestId, batchIndex, resolve, reject)
      } else {
        // All busy — queue it
        this.waitQueue.push({ requestId, batchIndex, resolve, reject })
      }
    })
  }

  // Legacy alias
  requestRowGroup(batchIndex: number): Promise<LidarBatchResult> {
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

    for (const { reject } of this.waitQueue) {
      reject(new Error(reason))
    }
    this.waitQueue = []
  }

  private dispatchToWorker(
    pw: PoolWorker,
    requestId: number,
    batchIndex: number,
    resolve: (result: LidarBatchResult) => void,
    reject: (err: Error) => void,
  ): void {
    pw.busy = true
    this.pendingRequests.set(requestId, { resolve, reject })
    pw.worker.postMessage({
      type: 'loadBatch',
      requestId,
      batchIndex,
    } satisfies WaymoLidarWorkerRequest)
  }

  private handleWorkerMessage(
    workerIndex: number,
    e: MessageEvent<DataWorkerResponse | { type: '__memorySnapshot'; snapshot: MemorySnapshot }>,
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
          pending.reject(new Error(msg.message))
        } else {
          pending.resolve(msg)
        }
      }

      // Worker is now idle — dispatch next queued request if any
      pw.busy = false
      this.drainQueue()
    }
  }

  private drainQueue(): void {
    while (this.waitQueue.length > 0) {
      const idle = this.workers.find((w) => w.ready && !w.busy)
      if (!idle) break

      const next = this.waitQueue.shift()!
      this.dispatchToWorker(idle, next.requestId, next.batchIndex, next.resolve, next.reject)
    }
  }
}
