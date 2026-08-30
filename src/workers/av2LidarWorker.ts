/**
 * Argoverse 2 LiDAR Worker — reads .feather point cloud files off the main thread.
 *
 * AV2 LiDAR sweeps are Apache Feather files with columns:
 *   x, y, z (float64) — already in ego frame
 *   intensity (uint8)
 *   laser_number (uint8) — 0–63 (two stacked 32-beam lidars)
 *   offset_ns (int32) — nanosecond offset from sweep start
 *
 * Uses flechette's tableFromIPC to parse Feather files (lightweight, fast cold-start).
 * Output: Float32Array with 4 floats per point [x, y, z, intensity].
 *
 * Init/batch protocol matches the generic WorkerPool interface.
 */

import type {
  WorkerInitBase,
  SensorCloudResult,
  LidarFrameResult,
  LidarBatchRequest,
  LidarWorkerResponse,
} from './types'
import { createWorkerMemoryLogger } from '../utils/memoryLogger'
import { resolveFileEntry } from './fetchHelper'
import {
  decodeFeatherColumnsV1,
  interleaveFeatherNumericColumnsV1,
  type FeatherColumnsParamsV1,
} from '../teachable/operators/featherColumns'

// ---------------------------------------------------------------------------
// Init message
// ---------------------------------------------------------------------------

export interface AV2LidarFrameDescriptor {
  /** Frame timestamp as string (bigint serialized) */
  timestamp: string
  /** Relative path to .feather file (e.g. "sensors/lidar/315968261059707000.feather") */
  filename: string
}

export interface AV2LidarWorkerInit extends WorkerInitBase {
  /** Frames grouped into batches */
  frameBatches: AV2LidarFrameDescriptor[][]
  /** File access: [filename, File | URL string][] — File for local, string for remote */
  fileEntries: [string, File | string][]
  /** Strict recipe-bound Feather schema and resource limits. */
  readerParams: FeatherColumnsParamsV1
}

export type AV2LidarWorkerRequest = AV2LidarWorkerInit | LidarBatchRequest

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let frameBatches: AV2LidarFrameDescriptor[][] = []
let fileMap = new Map<string, File | string>()
let readerParams: FeatherColumnsParamsV1 | null = null
let wMem = createWorkerMemoryLogger('worker-av2-lidar-?')

const LIDAR_COMBINED_ID = 1

// ---------------------------------------------------------------------------
// Feather → Float32Array
// ---------------------------------------------------------------------------

/**
 * Parse an AV2 LiDAR .feather file into a point cloud.
 * Columns: x (f64), y (f64), z (f64), intensity (u8), laser_number (u8), offset_ns (i32)
 *
 * Output: Float32Array with 4 floats per point [x, y, z, intensity]
 * Points are already in the ego frame — no transform needed.
 */
function parseFeatherPointCloud(buffer: ArrayBuffer): { positions: Float32Array; pointCount: number } {
  if (!readerParams) throw new Error('AV2 Feather reader was not initialized.')
  const decoded = interleaveFeatherNumericColumnsV1(
    decodeFeatherColumnsV1(buffer, readerParams),
    ['x', 'y', 'z', 'intensity'],
  )
  return { positions: decoded.values, pointCount: decoded.pointCount }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

const post = self as unknown as {
  postMessage(msg: LidarWorkerResponse, transfer?: Transferable[]): void
}

let processing = false
const queue: AV2LidarWorkerRequest[] = []

async function processQueue() {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const msg = queue.shift()!
    await handleMessage(msg)
  }

  processing = false
}

async function handleMessage(msg: AV2LidarWorkerRequest) {
  try {
    if (msg.type === 'init') {
      const idx = msg.workerIndex ?? 0
      wMem = createWorkerMemoryLogger(`worker-av2-lidar-${idx}`)
      if (msg.enableMemLog) wMem.setEnabled(true)

      wMem.snap('init:start')
      frameBatches = msg.frameBatches
      fileMap = new Map(msg.fileEntries)
      readerParams = msg.readerParams
      wMem.snap('init:complete', { note: `${frameBatches.length} batches, ${fileMap.size} files` })

      post.postMessage({
        type: 'ready',
        numBatches: frameBatches.length,
      })
      return
    }

    if (msg.type === 'loadBatch') {
      const batch = frameBatches[msg.batchIndex]
      if (!batch) {
        throw new Error(`Invalid batch index: ${msg.batchIndex}`)
      }

      const t0 = performance.now()
      wMem.snap(`batch${msg.batchIndex}:start`)

      const frames: LidarFrameResult[] = []
      const transferBuffers: ArrayBuffer[] = []

      for (const frameDesc of batch) {
        const entry = fileMap.get(frameDesc.filename)
        if (!entry) {
          console.warn(`[AV2 LiDAR] File not found: ${frameDesc.filename}`)
          continue
        }

        const buffer = await resolveFileEntry(entry)
        const { positions, pointCount } = parseFeatherPointCloud(buffer)

        const sensorClouds: SensorCloudResult[] = [{
          laserName: LIDAR_COMBINED_ID,
          positions,
          pointCount,
        }]
        transferBuffers.push(positions.buffer as ArrayBuffer)

        frames.push({
          timestamp: frameDesc.timestamp,
          sensorClouds,
          convertMs: 0,
        })
      }

      const totalMs = performance.now() - t0

      let xferBytes = 0
      for (const buf of transferBuffers) xferBytes += buf.byteLength
      wMem.snap(`batch${msg.batchIndex}:complete`, {
        dataSize: xferBytes,
        note: `${frames.length} frames, ${totalMs.toFixed(0)}ms`,
      })

      post.postMessage({
        type: 'batchReady',
        requestId: msg.requestId,
        batchIndex: msg.batchIndex,
        frames,
        totalMs,
      }, transferBuffers)
    }
  } catch (err) {
    post.postMessage({
      type: 'error',
      requestId: (msg as LidarBatchRequest).requestId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

self.onmessage = (e: MessageEvent<AV2LidarWorkerRequest>) => {
  queue.push(e.data)
  processQueue()
}
