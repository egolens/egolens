/**
 * Worker Pool — manages N data workers for parallel row group decompression.
 *
 * Each worker independently opens the same Parquet file and can decompress
 * + convert row groups concurrently. Row groups are independent data blocks
 * so there are no data races.
 *
 * Usage:
 *   const pool = new WorkerPool(4)
 *   await pool.init({ lidarUrl, calibrationEntries })
 *   const result = await pool.requestRowGroup(0)  // dispatches to idle worker
 *   pool.terminate()
 */

import type {
  DataWorkerRequest,
  DataWorkerResponse,
  DataWorkerRowGroupResult,
  DataWorkerReady,
} from './dataWorker'
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
  resolve: (result: DataWorkerRowGroupResult) => void
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
  private numRowGroups = 0
  /** Queue of row group requests waiting for an idle worker */
  private waitQueue: Array<{
    requestId: number
    rowGroupIndex: number
    resolve: (result: DataWorkerRowGroupResult) => void
    reject: (err: Error) => void
  }> = []

  readonly concurrency: number

  constructor(concurrency: number) {
    this.concurrency = concurrency
  }

  /**
   * Initialize all workers. Each opens the Parquet file independently.
   * Resolves when ALL workers are ready.
   */
  async init(opts: WorkerPoolInitOptions): Promise<{ numRowGroups: number }> {
    const readyPromises: Promise<DataWorkerReady>[] = []

    for (let i = 0; i < this.concurrency; i++) {
      const worker = new Worker(
        new URL('./dataWorker.ts', import.meta.url),
        { type: 'module' },
      )

      const poolWorker: PoolWorker = { worker, busy: false, ready: false }
      this.workers.push(poolWorker)

      const readyPromise = new Promise<DataWorkerReady>((resolve, reject) => {
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

      const initMsg: DataWorkerRequest = {
        type: 'init',
        lidarUrl: opts.lidarUrl,
        calibrationEntries: opts.calibrationEntries,
        workerIndex: i,
        enableMemLog,
      }
      worker.postMessage(initMsg)
    }

    const results = await Promise.all(readyPromises)
    this.numRowGroups = results[0].numRowGroups
    return { numRowGroups: this.numRowGroups }
  }

  /**
   * Re-initialize existing workers with a new file (skip worker creation).
   * Much faster than terminate + init — reuses WASM modules.
   */
  async reinit(opts: WorkerPoolInitOptions): Promise<{ numRowGroups: number }> {
    // Reject in-flight and queued promises so callers don't hang
    this.rejectAllPending('Worker pool reinitialized')
    this.nextRequestId = 0

    const readyPromises: Promise<DataWorkerReady>[] = []

    for (let i = 0; i < this.workers.length; i++) {
      const pw = this.workers[i]
      pw.busy = false
      pw.ready = false

      const readyPromise = new Promise<DataWorkerReady>((resolve, reject) => {
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

      const initMsg: DataWorkerRequest = {
        type: 'init',
        lidarUrl: opts.lidarUrl,
        calibrationEntries: opts.calibrationEntries,
        workerIndex: i,
        enableMemLog,
      }
      pw.worker.postMessage(initMsg)
    }

    const results = await Promise.all(readyPromises)
    this.numRowGroups = results[0].numRowGroups
    return { numRowGroups: this.numRowGroups }
  }

  /** Total row groups in the lidar file (available after init). */
  getNumRowGroups(): number {
    return this.numRowGroups
  }

  /** Whether the pool is initialized and has at least one ready worker. */
  isReady(): boolean {
    return this.workers.some((w) => w.ready)
  }

  /**
   * Request a row group to be loaded. Dispatches to an idle worker,
   * or queues the request if all workers are busy.
   */
  requestRowGroup(rowGroupIndex: number): Promise<DataWorkerRowGroupResult> {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++

      // Find an idle worker
      const idle = this.workers.find((w) => w.ready && !w.busy)
      if (idle) {
        this.dispatchToWorker(idle, requestId, rowGroupIndex, resolve, reject)
      } else {
        // All busy — queue it
        this.waitQueue.push({ requestId, rowGroupIndex, resolve, reject })
      }
    })
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
    rowGroupIndex: number,
    resolve: (result: DataWorkerRowGroupResult) => void,
    reject: (err: Error) => void,
  ): void {
    pw.busy = true
    this.pendingRequests.set(requestId, { resolve, reject })
    pw.worker.postMessage({
      type: 'loadRowGroup',
      requestId,
      rowGroupIndex,
    } satisfies DataWorkerRequest)
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

    if (msg.type === 'rowGroupReady' || msg.type === 'error') {
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
      this.dispatchToWorker(idle, next.requestId, next.rowGroupIndex, next.resolve, next.reject)
    }
  }
}
