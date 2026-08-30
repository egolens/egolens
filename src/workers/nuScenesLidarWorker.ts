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
  LidarWorkerResponse,
} from './types'
import { createWorkerMemoryLogger } from '../utils/memoryLogger'
import { resolveFileEntry } from './fetchHelper'
import { parseNpzUint16 } from '../utils/npz'
import {
  decodeInterleavedRecordsV1,
  decodePcdRecordsV1,
  transformInterleavedXyzV1,
} from '../teachable/operators/binaryReaders'

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
  /** Panoptic label file (e.g. "panoptic/v1.0-mini/<token>_panoptic.npz"). Keyframe-only. */
  panopticFile?: string
}

export interface NuScenesLidarWorkerInit extends WorkerInitBase {
  /**
   * Frames grouped into batches. Each batch is processed as one unit.
   * Batch size is configurable by the store (e.g. 10-20 frames per batch).
   */
  frameBatches: NuScenesFrameDescriptor[][]
  /**
   * File access: Map serialized as [filename, File | URL string][] entries.
   * File for local drag-and-drop, string for remote URL loading.
   * The worker resolves filenames against this map via resolveFileEntry().
   */
  fileEntries: [string, File | string][]
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
let fileMap = new Map<string, File | string>()
let wMem = createWorkerMemoryLogger('worker-nuscenes-lidar-?')
/** LiDAR sensor→ego extrinsic (row-major 4×4). null = identity (no transform). */
let lidarExtrinsic: number[] | null = null
/** Radar sensor→ego extrinsics keyed by sensor ID. */
let radarExtrinsics = new Map<number, number[]>()

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
  const decoded = decodeInterleavedRecordsV1(buffer, {
    strideBytes: 20,
    littleEndian: true,
    fields: [
      { name: 'x', type: 'float32', offsetBytes: 0 },
      { name: 'y', type: 'float32', offsetBytes: 4 },
      { name: 'z', type: 'float32', offsetBytes: 8 },
      { name: 'intensity', type: 'float32', offsetBytes: 12 },
    ],
  })
  const transformed = transformInterleavedXyzV1(decoded, lidarExtrinsic)
  return { positions: transformed.values, pointCount: transformed.pointCount }
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
  const decoded = transformInterleavedXyzV1(decodePcdRecordsV1(buffer, {
    data: 'binary',
    trailingPadding: 'zero',
    maxTrailingBytes: 4096,
    fields: ['x', 'y', 'z', 'vx', 'vy', 'vx_comp', 'vy_comp'],
  }), extrinsic)
  const positions = new Float32Array(decoded.pointCount * 5)
  for (let index = 0; index < decoded.pointCount; index += 1) {
    const source = index * decoded.stride
    const target = index * 5
    positions[target] = decoded.values[source]
    positions[target + 1] = decoded.values[source + 1]
    positions[target + 2] = decoded.values[source + 2]
    positions[target + 3] = Math.hypot(decoded.values[source + 5], decoded.values[source + 6])
    positions[target + 4] = Math.hypot(decoded.values[source + 3], decoded.values[source + 4])
  }
  return { positions, pointCount: decoded.pointCount }
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
        const lidarEntry = fileMap.get(frameDesc.filename)
        if (!lidarEntry) {
          console.warn(`[nuScenes LiDAR] File not found: ${frameDesc.filename}`)
          continue
        }
        const lidarBuffer = await resolveFileEntry(lidarEntry)
        const { positions: lidarPos, pointCount: lidarPts } = parsePcdBin(lidarBuffer)

        // 1b. Load lidarseg labels if available (uint8 per keyframe point)
        let segLabels: Uint8Array | undefined
        if (frameDesc.lidarsegFile) {
          const segEntry = fileMap.get(frameDesc.lidarsegFile)
          if (segEntry) {
            const segBuffer = await resolveFileEntry(segEntry)
            segLabels = new Uint8Array(segBuffer)
          }
        }

        // 1c. Load panoptic labels if available (uint16 per point, encoded as category*1000+instance)
        let panopticLabels: Uint16Array | undefined
        if (frameDesc.panopticFile) {
          const panEntry = fileMap.get(frameDesc.panopticFile)
          if (panEntry) {
            try {
              const panBuffer = await resolveFileEntry(panEntry)
              panopticLabels = await parseNpzUint16(panBuffer)
              // If we have panoptic but no lidarseg, derive semantic labels from panoptic
              if (!segLabels && panopticLabels) {
                segLabels = new Uint8Array(panopticLabels.length)
                for (let i = 0; i < panopticLabels.length; i++) {
                  segLabels[i] = Math.floor(panopticLabels[i] / 1000)
                }
              }
            } catch (e) {
              console.warn(`[nuScenes LiDAR] Failed to parse panoptic file: ${frameDesc.panopticFile}`, e)
            }
          }
        }

        sensorClouds.push({ laserName: LIDAR_TOP_ID, positions: lidarPos, pointCount: lidarPts, segLabels, panopticLabels })
        transferBuffers.push(lidarPos.buffer as ArrayBuffer)
        if (segLabels) transferBuffers.push(segLabels.buffer as ArrayBuffer)
        if (panopticLabels) transferBuffers.push(panopticLabels.buffer as ArrayBuffer)

        // 2. Parse radar .pcd files (if present)
        if (frameDesc.radarFiles) {
          for (const rf of frameDesc.radarFiles) {
            const radarEntry = fileMap.get(rf.filename)
            if (!radarEntry) continue
            const radarBuffer = await resolveFileEntry(radarEntry)
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
