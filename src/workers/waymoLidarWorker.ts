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
  readAllRows,
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
  /** Optional: lidar_segmentation parquet URL for per-point semantic labels */
  segUrl?: string | File
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
// Segmentation state (loaded at init, ~850KB)
// Map<timestamp, Map<laserName, { shape, values }>>
// ---------------------------------------------------------------------------
type SegRangeImage = { shape: number[]; values: number[] }
let segMap: Map<bigint, Map<number, SegRangeImage>> | null = null

/** Whether we've logged seg diagnostics for the first frame */
let segDiagLogged = false

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

      // Load segmentation parquet if provided (~850KB, full load)
      segMap = null
      if (msg.segUrl) {
        try {
          const segPf = await openParquetFile('lidar_segmentation', msg.segUrl)
          const segRows = await readAllRows(segPf, [
            'key.frame_timestamp_micros',
            'key.laser_name',
            '[LiDARSegmentationLabelComponent].range_image_return1.shape',
            '[LiDARSegmentationLabelComponent].range_image_return1.values',
          ])
          segMap = new Map()
          for (const row of segRows) {
            const ts = row['key.frame_timestamp_micros'] as bigint
            const laserName = row['key.laser_name'] as number
            const shape = row['[LiDARSegmentationLabelComponent].range_image_return1.shape'] as [number, number, number]
            const values = row['[LiDARSegmentationLabelComponent].range_image_return1.values'] as number[]
            let frameMap = segMap.get(ts)
            if (!frameMap) {
              frameMap = new Map()
              segMap.set(ts, frameMap)
            }
            frameMap.set(laserName, { shape, values })
          }
          wMem.snap('init:seg-loaded', { note: `${segRows.length} seg rows, ${segMap.size} frames` })
        } catch (e) {
          console.warn('[worker-lidar] Could not load lidar_segmentation, skipping:', e)
          segMap = null
        }
      }

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
        // Lookup seg data for this frame+sensor (if available)
        const segFrameMap = segMap?.get(ts) ?? null
        for (const [laserName, cloud] of result.perSensor) {
          const sc: SensorCloudResult = { laserName, positions: cloud.positions, pointCount: cloud.pointCount }

          // Inject per-point segmentation labels from seg range image
          if (segFrameMap) {
            const segRI = segFrameMap.get(laserName)
            if (segRI && cloud.validIndices) {
              // Waymo seg range image: shape [H, W, 2], interleaved (channels-last)
              // IMPORTANT: channel 0 = instance_id, channel 1 = semantic_class
              // (reversed from the naive assumption of sem=ch0, inst=ch1)
              const C = segRI.shape.length >= 3 ? segRI.shape[2] : 1

              // One-time diagnostic log
              if (!segDiagLogged) {
                segDiagLogged = true
                const sampleN = Math.min(20, cloud.pointCount)
                const samples: string[] = []
                for (let s = 0; s < sampleN; s++) {
                  const ri = cloud.validIndices[s]
                  const ch0 = segRI.values[ri * C] ?? -999
                  const ch1 = C >= 2 ? (segRI.values[ri * C + 1] ?? -999) : -999
                  samples.push(`(${ch0},${ch1})`)
                }
                console.log(
                  `[worker-lidar] seg: shape=[${segRI.shape}], C=${C}, len=${segRI.values.length}` +
                  ` | first ${sampleN} pts (inst,sem): ${samples.join(' ')}`
                )
              }

              const segLabels = new Uint8Array(cloud.pointCount)
              const panopticLabels = new Uint16Array(cloud.pointCount)

              for (let i = 0; i < cloud.pointCount; i++) {
                const ri = cloud.validIndices[i] // flattened row*W+col index
                // Channel 0 = instance_id, Channel 1 = semantic_class
                const instId = segRI.values[ri * C] ?? 0
                const semClass = C >= 2 ? (segRI.values[ri * C + 1] ?? 0) : (segRI.values[ri * C] ?? 0)
                segLabels[i] = semClass
                panopticLabels[i] = semClass * 1000 + (instId >= 0 ? instId : 0)
              }
              sc.segLabels = segLabels
              sc.panopticLabels = panopticLabels
              transferBuffers.push(segLabels.buffer as ArrayBuffer)
              transferBuffers.push(panopticLabels.buffer as ArrayBuffer)
            }
          }

          sensorClouds.push(sc)
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
