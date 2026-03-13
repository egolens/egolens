/**
 * Waymo Camera Worker — loads camera images from Parquet off the main thread.
 *
 * Similar to dataWorker but much simpler: no range-image conversion needed.
 * Reads an entire row group (= 1 batch) at once (same BROTLI decompression
 * cost whether reading 5 rows or 256), yielding ~50 frames of camera images per pass.
 *
 * Camera data columns:
 *   key.frame_timestamp_micros — bigint timestamp
 *   key.camera_name — 1=FRONT, 2=FRONT_LEFT, 3=FRONT_RIGHT, 4=SIDE_LEFT, 5=SIDE_RIGHT
 *   [CameraImageComponent].image — JPEG binary (ArrayBuffer)
 */

import {
  openParquetFile,
  readRowGroupRows,
  type WaymoParquetFile,
} from '../utils/parquet'
import { createWorkerMemoryLogger } from '../utils/memoryLogger'

import type {
  WorkerInitBase,
  CameraImageResult,
  CameraFrameResult,
  CameraBatchRequest,
  CameraBatchResult,
  CameraWorkerReady,
  CameraWorkerError,
  CameraWorkerResponse,
} from './types'

// Re-export shared types so existing consumers can migrate gradually
export type {
  CameraImageResult,
  CameraFrameResult,
  CameraBatchResult,
  CameraWorkerReady,
  CameraWorkerError,
  CameraWorkerResponse,
} from './types'

// ---------------------------------------------------------------------------
// Waymo-specific init message (extends base)
// ---------------------------------------------------------------------------

export interface WaymoCameraWorkerInit extends WorkerInitBase {
  cameraUrl: string | File
}

export type WaymoCameraWorkerRequest = WaymoCameraWorkerInit | CameraBatchRequest

// Legacy aliases for gradual migration
export type CameraWorkerInit = WaymoCameraWorkerInit
export type CameraWorkerRequest = WaymoCameraWorkerRequest
export type CameraWorkerRowGroupResult = CameraBatchResult
export type CameraWorkerLoadRowGroup = CameraBatchRequest

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let cameraPf: WaymoParquetFile | null = null

/** Worker-local memory logger */
let wMem = createWorkerMemoryLogger('worker-cam-?')

// ---------------------------------------------------------------------------
// Waymo Parquet column names
// ---------------------------------------------------------------------------

const CAMERA_COLUMNS = [
  'key.frame_timestamp_micros',
  'key.camera_name',
  '[CameraImageComponent].image',
]

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

const post = self as unknown as {
  postMessage(msg: CameraWorkerResponse, transfer?: Transferable[]): void
}

let processing = false
const queue: WaymoCameraWorkerRequest[] = []

async function processQueue() {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const msg = queue.shift()!
    await handleMessage(msg)
  }

  processing = false
}

async function handleMessage(msg: WaymoCameraWorkerRequest) {
  try {
    if (msg.type === 'init') {
      const idx = msg.workerIndex ?? 0
      wMem = createWorkerMemoryLogger(`worker-cam-${idx}`)
      if (msg.enableMemLog) wMem.setEnabled(true)

      wMem.snap('init:start')
      cameraPf = await openParquetFile('camera_image', msg.cameraUrl)
      wMem.snap('init:complete', { note: `${cameraPf.rowGroups.length} RGs` })

      post.postMessage({
        type: 'ready',
        numBatches: cameraPf.rowGroups.length,
      })
      return
    }

    if (msg.type === 'loadBatch') {
      if (!cameraPf) {
        throw new Error('Camera worker not initialized')
      }

      const t0 = performance.now()
      wMem.snap(`rg${msg.batchIndex}:fetch-start`)

      // 1. Read entire row group (utf8:false → BYTE_ARRAY stays as Uint8Array, not string)
      const allRows = await readRowGroupRows(cameraPf, msg.batchIndex, CAMERA_COLUMNS, { utf8: false })
      wMem.snap(`rg${msg.batchIndex}:decompress-done`, {
        note: `${allRows.length} rows decompressed`,
      })

      // 2. Group by frame timestamp
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

      // 3. Extract JPEG buffers per frame
      const frames: CameraFrameResult[] = []
      const transferBuffers: ArrayBuffer[] = []

      for (const [ts, rows] of frameGroups) {
        const images: CameraImageResult[] = []
        for (const row of rows) {
          const cameraName = row['key.camera_name'] as number
          const imageData = row['[CameraImageComponent].image']

          // With utf8:false, hyparquet returns BYTE_ARRAY as Uint8Array (raw JPEG)
          if (!imageData) continue
          let jpeg: ArrayBuffer
          if (imageData instanceof Uint8Array) {
            // Copy to own ArrayBuffer (source may be a view into shared buffer)
            const copy = new Uint8Array(imageData.byteLength)
            copy.set(imageData)
            jpeg = copy.buffer as ArrayBuffer
          } else if (imageData instanceof ArrayBuffer) {
            jpeg = imageData
          } else {
            continue
          }

          images.push({ cameraName, jpeg })
          transferBuffers.push(jpeg)
        }

        frames.push({
          timestamp: ts.toString(),
          images,
        })
      }

      const totalMs = performance.now() - t0

      let xferBytes = 0
      for (const buf of transferBuffers) xferBytes += buf.byteLength
      wMem.snap(`rg${msg.batchIndex}:complete`, {
        dataSize: xferBytes,
        note: `${frames.length} frames, ${totalMs.toFixed(0)}ms`,
      })

      post.postMessage(
        {
          type: 'batchReady',
          requestId: msg.requestId,
          batchIndex: msg.batchIndex,
          frames,
          totalMs,
        },
        transferBuffers,
      )
    }
  } catch (err) {
    post.postMessage({
      type: 'error',
      requestId: (msg as CameraBatchRequest).requestId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

self.onmessage = (e: MessageEvent<WaymoCameraWorkerRequest>) => {
  queue.push(e.data)
  processQueue()
}
