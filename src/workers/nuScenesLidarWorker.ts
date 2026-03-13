/**
 * nuScenes LiDAR Worker — reads .pcd.bin files off the main thread.
 *
 * Unlike the Waymo worker, no Parquet decompression or range image conversion
 * is needed. Each .pcd.bin file is a flat array of float32 [x, y, z, intensity, ring].
 * The worker reads files in batches and returns Float32Array point clouds.
 *
 * Init payload:
 *   - frameBatches: array of batches, each batch is an array of frame descriptors
 *     { timestamp, filename, file? }
 *   - dataRoot: FileSystemDirectoryHandle or base URL (for file access)
 *
 * Batch protocol matches the generic WorkerPool interface:
 *   init → ready { numBatches }
 *   loadBatch { batchIndex } → batchReady { frames[] }
 */

import type {
  WorkerInitBase,
  SensorCloudResult,
  LidarFrameResult,
  LidarBatchRequest,
  LidarBatchResult,
  LidarWorkerResponse,
} from './types'
import { createWorkerMemoryLogger } from '../utils/memoryLogger'
import { NUSCENES_POINT_STRIDE, NUSCENES_POINT_BYTES } from '../types/nuscenes'

// ---------------------------------------------------------------------------
// Init message
// ---------------------------------------------------------------------------

export interface NuScenesFrameDescriptor {
  /** Frame timestamp as string (bigint serialized) */
  timestamp: string
  /** Relative path to .pcd.bin file (e.g. "samples/LIDAR_TOP/xxx.pcd.bin") */
  filename: string
}

export interface NuScenesLidarWorkerInit extends WorkerInitBase {
  /**
   * Frames grouped into batches. Each batch is processed as one unit.
   * Batch size is configurable by the store (e.g. 10-20 frames per batch).
   */
  frameBatches: NuScenesFrameDescriptor[][]
  /**
   * File access: Map serialized as [filename, File][] entries.
   * The worker resolves filenames against this map.
   */
  fileEntries: [string, File][]
  /**
   * LiDAR sensor→ego extrinsic (row-major 4×4, 16 floats).
   * Applied to every point to transform from sensor frame to ego (vehicle) frame.
   * nuScenes LiDAR sensor frame: X=right, Y=forward, Z=up.
   */
  lidarExtrinsic?: number[]
}

export type NuScenesLidarWorkerRequest = NuScenesLidarWorkerInit | LidarBatchRequest

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let frameBatches: NuScenesFrameDescriptor[][] = []
let fileMap = new Map<string, File>()
let wMem = createWorkerMemoryLogger('worker-nuscenes-lidar-?')
/** LiDAR sensor→ego extrinsic (row-major 4×4). null = identity (no transform). */
let lidarExtrinsic: number[] | null = null

// LIDAR_TOP sensor ID (from nuScenes manifest)
const LIDAR_TOP_ID = 1

// ---------------------------------------------------------------------------
// Point cloud parsing
// ---------------------------------------------------------------------------

/**
 * Parse a .pcd.bin file into a positions Float32Array.
 *
 * Input format: flat float32 array, 5 floats per point [x, y, z, intensity, ring_index].
 * Output: Float32Array with 4 floats per point [x, y, z, intensity] for the renderer.
 *
 * If lidarExtrinsic is set, each point is transformed from sensor frame to ego frame:
 *   [x', y', z'] = R × [x, y, z] + t   (row-major 4×4)
 */
function parsePcdBin(buffer: ArrayBuffer): { positions: Float32Array; pointCount: number } {
  const floats = new Float32Array(buffer)
  const pointCount = Math.floor(floats.length / NUSCENES_POINT_STRIDE)

  // Output: 4 floats per point [x, y, z, intensity]
  const positions = new Float32Array(pointCount * 4)
  const e = lidarExtrinsic

  for (let i = 0; i < pointCount; i++) {
    const srcOffset = i * NUSCENES_POINT_STRIDE
    const dstOffset = i * 4
    const sx = floats[srcOffset]
    const sy = floats[srcOffset + 1]
    const sz = floats[srcOffset + 2]

    if (e) {
      // Apply sensor→ego extrinsic: row-major 4×4 [R|t]
      positions[dstOffset]     = e[0] * sx + e[1] * sy + e[2] * sz + e[3]
      positions[dstOffset + 1] = e[4] * sx + e[5] * sy + e[6] * sz + e[7]
      positions[dstOffset + 2] = e[8] * sx + e[9] * sy + e[10] * sz + e[11]
    } else {
      positions[dstOffset]     = sx
      positions[dstOffset + 1] = sy
      positions[dstOffset + 2] = sz
    }
    positions[dstOffset + 3] = floats[srcOffset + 3] // intensity
  }

  return { positions, pointCount }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

const post = self as unknown as {
  postMessage(msg: LidarWorkerResponse, transfer?: Transferable[]): void
}

let processing = false
const queue: NuScenesLidarWorkerRequest[] = []

async function processQueue() {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const msg = queue.shift()!
    await handleMessage(msg)
  }

  processing = false
}

async function handleMessage(msg: NuScenesLidarWorkerRequest) {
  try {
    if (msg.type === 'init') {
      const idx = msg.workerIndex ?? 0
      wMem = createWorkerMemoryLogger(`worker-nuscenes-lidar-${idx}`)
      if (msg.enableMemLog) wMem.setEnabled(true)

      wMem.snap('init:start')
      frameBatches = msg.frameBatches
      fileMap = new Map(msg.fileEntries)
      lidarExtrinsic = msg.lidarExtrinsic ?? null
      wMem.snap('init:complete', { note: `${frameBatches.length} batches, ${fileMap.size} files, extrinsic=${!!lidarExtrinsic}` })

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
        const file = fileMap.get(frameDesc.filename)
        if (!file) {
          console.warn(`[nuScenes LiDAR] File not found: ${frameDesc.filename}`)
          continue
        }

        const buffer = await file.arrayBuffer()
        const { positions, pointCount } = parsePcdBin(buffer)

        const sensorClouds: SensorCloudResult[] = [
          { laserName: LIDAR_TOP_ID, positions, pointCount },
        ]

        transferBuffers.push(positions.buffer as ArrayBuffer)

        frames.push({
          timestamp: frameDesc.timestamp,
          sensorClouds,
          convertMs: 0, // No conversion needed for nuScenes
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

self.onmessage = (e: MessageEvent<NuScenesLidarWorkerRequest>) => {
  queue.push(e.data)
  processQueue()
}
