/**
 * Camera Worker Pool — manages N workers for parallel camera image loading.
 *
 * Same architecture as WorkerPool (lidar) but for camera data.
 * Camera images don't need CPU conversion (just BROTLI decompress + JPEG pass-through),
 * so the pool mainly parallelizes Parquet decompression.
 */

import type {
  WaymoCameraWorkerRequest,
  CameraWorkerResponse,
} from './cameraWorker'
import type {
  CameraBatchResult,
  CameraWorkerReady,
} from './types'
import { memLog } from '../utils/memoryLogger'
import type { MemorySnapshot } from '../utils/memoryLogger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CameraPoolInitOptions {
  cameraUrl: string | File
}

interface PendingRequest {
  resolve: (result: CameraBatchResult) => void
  reject: (err: Error) => void
}

interface PoolWorker {
  worker: Worker
  busy: boolean
  ready: boolean
}

// ---------------------------------------------------------------------------
// CameraWorkerPool
// ---------------------------------------------------------------------------

export class CameraWorkerPool {
  private workers: PoolWorker[] = []
  private pendingRequests = new Map<number, PendingRequest>()
  private nextRequestId = 0
  private numBatches = 0
  private waitQueue: Array<{
    requestId: number
    batchIndex: number
    resolve: (result: CameraBatchResult) => void
    reject: (err: Error) => void
  }> = []

  readonly concurrency: number

  constructor(concurrency: number) {
    this.concurrency = concurrency
  }

  async init(opts: CameraPoolInitOptions): Promise<{ numBatches: number }> {
    const readyPromises: Promise<CameraWorkerReady>[] = []

    for (let i = 0; i < this.concurrency; i++) {
      const worker = new Worker(
        new URL('./cameraWorker.ts', import.meta.url),
        { type: 'module' },
      )

      const poolWorker: PoolWorker = { worker, busy: false, ready: false }
      this.workers.push(poolWorker)

      const readyPromise = new Promise<CameraWorkerReady>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<CameraWorkerResponse>) => {
          if (e.data.type === 'ready') {
            poolWorker.ready = true
            worker.onmessage = (ev: MessageEvent<CameraWorkerResponse>) =>
              this.handleWorkerMessage(i, ev)
            resolve(e.data)
          } else if (e.data.type === 'error') {
            reject(new Error(e.data.message))
          }
        }
        worker.onerror = (e) => reject(new Error(e.message))
      })

      readyPromises.push(readyPromise)

      const enableMemLog = typeof window !== 'undefined' && (
        (window as Window).__WAYMO_MEMORY_LOG === true ||
        localStorage.getItem('waymo-memory-log') === 'true'
      )

      worker.postMessage({
        type: 'init',
        cameraUrl: opts.cameraUrl,
        workerIndex: i,
        enableMemLog,
      } satisfies WaymoCameraWorkerRequest)
    }

    const results = await Promise.all(readyPromises)
    this.numBatches = results[0].numBatches
    return { numBatches: this.numBatches }
  }

  /**
   * Re-initialize existing workers with a new file (skip worker creation).
   * Much faster than terminate + init — reuses WASM modules.
   */
  async reinit(opts: CameraPoolInitOptions): Promise<{ numBatches: number }> {
    this.rejectAllPending('Camera worker pool reinitialized')
    this.nextRequestId = 0

    const readyPromises: Promise<CameraWorkerReady>[] = []

    for (let i = 0; i < this.workers.length; i++) {
      const pw = this.workers[i]
      pw.busy = false
      pw.ready = false

      const readyPromise = new Promise<CameraWorkerReady>((resolve, reject) => {
        pw.worker.onmessage = (e: MessageEvent<CameraWorkerResponse>) => {
          if (e.data.type === 'ready') {
            pw.ready = true
            pw.worker.onmessage = (ev: MessageEvent<CameraWorkerResponse>) =>
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

      pw.worker.postMessage({
        type: 'init',
        cameraUrl: opts.cameraUrl,
        workerIndex: i,
        enableMemLog,
      } satisfies WaymoCameraWorkerRequest)
    }

    const results = await Promise.all(readyPromises)
    this.numBatches = results[0].numBatches
    return { numBatches: this.numBatches }
  }

  getNumBatches(): number {
    return this.numBatches
  }

  // Legacy alias
  getNumRowGroups(): number {
    return this.numBatches
  }

  isReady(): boolean {
    return this.workers.some((w) => w.ready)
  }

  requestBatch(batchIndex: number): Promise<CameraBatchResult> {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++
      const idle = this.workers.find((w) => w.ready && !w.busy)
      if (idle) {
        this.dispatchToWorker(idle, requestId, batchIndex, resolve, reject)
      } else {
        this.waitQueue.push({ requestId, batchIndex, resolve, reject })
      }
    })
  }

  // Legacy alias
  requestRowGroup(batchIndex: number): Promise<CameraBatchResult> {
    return this.requestBatch(batchIndex)
  }

  terminate(): void {
    this.rejectAllPending('Camera worker pool terminated')
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
    resolve: (result: CameraBatchResult) => void,
    reject: (err: Error) => void,
  ): void {
    pw.busy = true
    this.pendingRequests.set(requestId, { resolve, reject })
    pw.worker.postMessage({
      type: 'loadBatch',
      requestId,
      batchIndex,
    } satisfies WaymoCameraWorkerRequest)
  }

  private handleWorkerMessage(
    workerIndex: number,
    e: MessageEvent<CameraWorkerResponse | { type: '__memorySnapshot'; snapshot: MemorySnapshot }>,
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
