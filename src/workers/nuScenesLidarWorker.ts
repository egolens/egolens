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
import { NUSCENES_POINT_STRIDE } from '../types/nuscenes'

// ---------------------------------------------------------------------------
// Init message
// ---------------------------------------------------------------------------

/** A single radar file descriptor for one sensor in one frame. */
export interface NuScenesRadarFileDescriptor {
  sensorId: number
  filename: string
}

export interface NuScenesFrameDescriptor {
  /** Frame timestamp as string (bigint serialized) */
  timestamp: string
  /** Relative path to .pcd.bin file (e.g. "samples/LIDAR_TOP/xxx.pcd.bin") */
  filename: string
  /** Radar files for this frame (one per radar sensor). */
  radarFiles?: NuScenesRadarFileDescriptor[]
  /** Lidarseg label file (e.g. "lidarseg/v1.0-mini/<token>_lidarseg.bin"). Keyframe-only. */
  lidarsegFile?: string
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
  /**
   * Radar sensor→ego extrinsics keyed by sensor ID.
   * Serialized as [sensorId, number[]][] entries.
   */
  radarExtrinsics?: [number, number[]][]
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
/** Radar sensor→ego extrinsics keyed by sensor ID. */
let radarExtrinsics = new Map<number, number[]>()

// LIDAR_TOP sensor ID (from nuScenes manifest)
const LIDAR_TOP_ID = 1

/** Bytes per point in radar PCD v0.7 binary data */
const RADAR_POINT_BYTES = 43

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

/**
 * Parse a nuScenes radar .pcd file (PCD v0.7 binary).
 *
 * Format: ASCII header terminated by "DATA binary\n", then 43 bytes per point.
 * Point layout (byte offsets):
 *   x(f32@0) y(f32@4) z(f32@8) dyn_prop(u8@12) id(u16@13)
 *   rcs(f32@15) vx(f32@19) vy(f32@23) vx_comp(f32@27) vy_comp(f32@31) ...
 *
 * Output: Float32Array with 5 floats per point [x, y, z, speedComp, speedRaw].
 *   speedComp = sqrt(vx_comp² + vy_comp²) — ego-compensated (world mode: true object velocity)
 *   speedRaw  = sqrt(vx² + vy²)           — raw sensor velocity (vehicle mode: relative to ego)
 *
 * The extrinsic transforms positions from radar sensor frame to ego (vehicle) frame.
 */
function parseRadarPcd(
  buffer: ArrayBuffer,
  extrinsic: number[] | null,
): { positions: Float32Array; pointCount: number } {
  // Find end of ASCII header ("DATA binary\n")
  const bytes = new Uint8Array(buffer)
  let headerEnd = 0
  const searchStr = 'DATA binary'
  for (let i = 0; i < Math.min(bytes.length, 2048); i++) {
    let match = true
    for (let j = 0; j < searchStr.length; j++) {
      if (bytes[i + j] !== searchStr.charCodeAt(j)) { match = false; break }
    }
    if (match) {
      headerEnd = i + searchStr.length
      if (bytes[headerEnd] === 0x0D) headerEnd++ // \r
      if (bytes[headerEnd] === 0x0A) headerEnd++ // \n
      break
    }
  }

  if (headerEnd === 0) {
    console.warn('[nuScenes Radar] Could not find DATA binary header')
    return { positions: new Float32Array(0), pointCount: 0 }
  }

  const dataBytes = bytes.length - headerEnd
  const pointCount = Math.floor(dataBytes / RADAR_POINT_BYTES)
  const RADAR_STRIDE = 5 // x, y, z, speedComp, speedRaw
  const positions = new Float32Array(pointCount * RADAR_STRIDE)
  const dataView = new DataView(buffer, headerEnd)

  for (let i = 0; i < pointCount; i++) {
    const off = i * RADAR_POINT_BYTES
    const sx = dataView.getFloat32(off, true)        // x @ offset 0
    const sy = dataView.getFloat32(off + 4, true)     // y @ offset 4
    const sz = dataView.getFloat32(off + 8, true)     // z @ offset 8
    const vx = dataView.getFloat32(off + 19, true)    // vx @ offset 19
    const vy = dataView.getFloat32(off + 23, true)    // vy @ offset 23
    const vxComp = dataView.getFloat32(off + 27, true) // vx_comp @ offset 27
    const vyComp = dataView.getFloat32(off + 31, true) // vy_comp @ offset 31

    const dst = i * RADAR_STRIDE
    if (extrinsic) {
      const e = extrinsic
      positions[dst]     = e[0] * sx + e[1] * sy + e[2] * sz + e[3]
      positions[dst + 1] = e[4] * sx + e[5] * sy + e[6] * sz + e[7]
      positions[dst + 2] = e[8] * sx + e[9] * sy + e[10] * sz + e[11]
    } else {
      positions[dst]     = sx
      positions[dst + 1] = sy
      positions[dst + 2] = sz
    }
    positions[dst + 3] = Math.sqrt(vxComp * vxComp + vyComp * vyComp) // speedComp (world)
    positions[dst + 4] = Math.sqrt(vx * vx + vy * vy)                 // speedRaw (vehicle)
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
      radarExtrinsics = new Map(msg.radarExtrinsics ?? [])
      wMem.snap('init:complete', { note: `${frameBatches.length} batches, ${fileMap.size} files, extrinsic=${!!lidarExtrinsic}, radars=${radarExtrinsics.size}` })

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
        const sensorClouds: SensorCloudResult[] = []

        // 1. Parse keyframe LiDAR .pcd.bin
        const lidarFile = fileMap.get(frameDesc.filename)
        if (!lidarFile) {
          console.warn(`[nuScenes LiDAR] File not found: ${frameDesc.filename}`)
          continue
        }
        const lidarBuffer = await lidarFile.arrayBuffer()
        const { positions: lidarPos, pointCount: lidarPts } = parsePcdBin(lidarBuffer)

        // 1b. Load lidarseg labels if available (uint8 per keyframe point)
        let segLabels: Uint8Array | undefined
        if (frameDesc.lidarsegFile) {
          const segFile = fileMap.get(frameDesc.lidarsegFile)
          if (segFile) {
            const segBuffer = await segFile.arrayBuffer()
            segLabels = new Uint8Array(segBuffer)
          }
        }

        sensorClouds.push({ laserName: LIDAR_TOP_ID, positions: lidarPos, pointCount: lidarPts, segLabels })
        transferBuffers.push(lidarPos.buffer as ArrayBuffer)
        if (segLabels) transferBuffers.push(segLabels.buffer as ArrayBuffer)

        // 2. Parse radar .pcd files (if present)
        if (frameDesc.radarFiles) {
          for (const rf of frameDesc.radarFiles) {
            const radarFile = fileMap.get(rf.filename)
            if (!radarFile) continue
            const radarBuffer = await radarFile.arrayBuffer()
            const ext = radarExtrinsics.get(rf.sensorId) ?? null
            const { positions: radarPos, pointCount: radarPts } = parseRadarPcd(radarBuffer, ext)
            if (radarPts > 0) {
              sensorClouds.push({ laserName: rf.sensorId, positions: radarPos, pointCount: radarPts })
              transferBuffers.push(radarPos.buffer as ArrayBuffer)
            }
          }
        }

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

self.onmessage = (e: MessageEvent<NuScenesLidarWorkerRequest>) => {
  queue.push(e.data)
  processQueue()
}
