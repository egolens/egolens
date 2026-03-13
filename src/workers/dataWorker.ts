/**
 * Waymo LiDAR Worker — runs Parquet I/O + range image → xyz conversion off the main thread.
 *
 * Key optimization: reads an entire Parquet **row group** (= 1 batch) in one shot.
 * Parquet decompresses a full RG anyway (~256 rows, ~40 MB compressed),
 * so reading 5 rows costs the same as reading 256.
 * By processing the whole RG we cache ~51 frames per decompression pass —
 * only 4 RG reads needed for the entire 199-frame segment.
 *
 * Architecture: thin orchestration layer. Actual logic lives in parquet.ts and rangeImage.ts.
 */

import {
  openParquetFile,
  buildHeavyFileFrameIndex,
  readRowGroupRows,
  type WaymoParquetFile,
  type FrameRowIndex,
} from '../utils/parquet'
import {
  convertAllSensors,
  type LidarCalibration,
  type RangeImage,
} from '../utils/rangeImage'
import { createWorkerMemoryLogger } from '../utils/memoryLogger'

import type {
  WorkerInitBase,
  SensorCloudResult,
  LidarFrameResult,
  LidarBatchRequest,
  LidarBatchResult,
  LidarWorkerReady,
  LidarWorkerError,
  LidarWorkerResponse,
} from './types'

// Re-export shared types so existing consumers can migrate gradually
export type {
  SensorCloudResult,
  LidarFrameResult,
  LidarBatchResult,
  LidarWorkerReady,
  LidarWorkerError,
  LidarWorkerResponse,
} from './types'

// ---------------------------------------------------------------------------
// Waymo-specific init message (extends base)
// ---------------------------------------------------------------------------

export interface WaymoLidarWorkerInit extends WorkerInitBase {
  lidarUrl: string | File
  /** Serialized as [laserName, calibration][] since Map can't be postMessage'd */
  calibrationEntries: [number, LidarCalibration][]
}

export type WaymoLidarWorkerRequest = WaymoLidarWorkerInit | LidarBatchRequest

// Legacy aliases for gradual migration
export type DataWorkerInit = WaymoLidarWorkerInit
export type DataWorkerRequest = WaymoLidarWorkerRequest
export type DataWorkerRowGroupResult = LidarBatchResult
export type DataWorkerReady = LidarWorkerReady
export type DataWorkerError = LidarWorkerError
export type DataWorkerResponse = LidarWorkerResponse
export type FrameResult = LidarFrameResult
export type DataWorkerLoadRowGroup = LidarBatchRequest

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let lidarPf: WaymoParquetFile | null = null
let lidarIndex: FrameRowIndex | null = null
let calibrations = new Map<number, LidarCalibration>()

/** Worker-local memory logger — posts snapshots to main thread */
let wMem = createWorkerMemoryLogger('worker-lidar-?')

// ---------------------------------------------------------------------------
// Waymo Parquet column names
// ---------------------------------------------------------------------------

const LIDAR_COLUMNS = [
  'key.frame_timestamp_micros',
  'key.laser_name',
  '[LiDARComponent].range_image_return1.shape',
  '[LiDARComponent].range_image_return1.values',
]

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

const post = self as unknown as {
  postMessage(msg: LidarWorkerResponse, transfer?: Transferable[]): void
}

let processing = false
const queue: WaymoLidarWorkerRequest[] = []

async function processQueue() {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const msg = queue.shift()!
    await handleMessage(msg)
  }

  processing = false
}

async function handleMessage(msg: WaymoLidarWorkerRequest) {
  try {
    if (msg.type === 'init') {
      // Configure memory logger
      const idx = msg.workerIndex ?? 0
      wMem = createWorkerMemoryLogger(`worker-lidar-${idx}`)
      if (msg.enableMemLog) wMem.setEnabled(true)

      wMem.snap('init:start')
      lidarPf = await openParquetFile('lidar', msg.lidarUrl)
      lidarIndex = await buildHeavyFileFrameIndex(lidarPf)
      calibrations = new Map(msg.calibrationEntries)
      wMem.snap('init:complete', { note: `${lidarPf.rowGroups.length} RGs` })

      post.postMessage({
        type: 'ready',
        numBatches: lidarPf.rowGroups.length,
      })
      return
    }

    if (msg.type === 'loadBatch') {
      if (!lidarPf || !lidarIndex) {
        throw new Error('Worker not initialized')
      }

      const t0 = performance.now()
      wMem.snap(`rg${msg.batchIndex}:fetch-start`)

      // 1. Read entire row group — one decompression pass
      const allRows = await readRowGroupRows(lidarPf, msg.batchIndex, LIDAR_COLUMNS)
      wMem.snap(`rg${msg.batchIndex}:decompress-done`, {
        note: `${allRows.length} rows decompressed`,
      })

      // 2. Group rows by frame timestamp
      const frameGroups = new Map<bigint, typeof allRows>()
      for (const row of allRows) {
        const ts = row['key.frame_timestamp_micros'] as bigint
        let group = frameGroups.get(ts)
        if (!group) {
          group = []
          frameGroups.set(ts, group)
        }
        group.push(row)
      }

      wMem.snap(`rg${msg.batchIndex}:convert-start`, {
        note: `${frameGroups.size} frames to convert`,
      })

      // 3. Convert each frame's range images → xyz point cloud
      const frames: LidarFrameResult[] = []
      const transferBuffers: ArrayBuffer[] = []

      for (const [ts, rows] of frameGroups) {
        const rangeImages = new Map<number, RangeImage>()
        for (const row of rows) {
          const laserName = row['key.laser_name'] as number
          rangeImages.set(laserName, {
            shape: row['[LiDARComponent].range_image_return1.shape'] as [number, number, number],
            values: row['[LiDARComponent].range_image_return1.values'] as number[],
          })
        }

        const ct0 = performance.now()
        const result = convertAllSensors(rangeImages, calibrations)
        const convertMs = performance.now() - ct0

        const sensorClouds: SensorCloudResult[] = []
        for (const [laserName, cloud] of result.perSensor) {
          const scResult: SensorCloudResult = { laserName, positions: cloud.positions, pointCount: cloud.pointCount }

          sensorClouds.push(scResult)
          transferBuffers.push(cloud.positions.buffer as ArrayBuffer)
        }

        frames.push({
          timestamp: ts.toString(),
          sensorClouds,
          convertMs,
        })
      }

      const totalMs = performance.now() - t0

      // Calculate total transfer size
      let xferBytes = 0
      for (const buf of transferBuffers) xferBytes += buf.byteLength
      wMem.snap(`rg${msg.batchIndex}:complete`, {
        dataSize: xferBytes,
        note: `${frames.length} frames, ${totalMs.toFixed(0)}ms, transferring ${transferBuffers.length} buffers`,
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

self.onmessage = (e: MessageEvent<WaymoLidarWorkerRequest>) => {
  queue.push(e.data)
  processQueue()
}
