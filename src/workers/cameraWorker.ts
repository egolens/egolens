/**
 * Camera Worker — loads camera images from Parquet off the main thread.
 *
 * Similar to dataWorker but much simpler: no range-image conversion needed.
 * Reads an entire row group at once (same BROTLI decompression cost whether
 * reading 5 rows or 256), yielding ~50 frames of camera images per pass.
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

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let cameraPf: WaymoParquetFile | null = null

/** Worker-local memory logger */
let wMem = createWorkerMemoryLogger('worker-cam-?')

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface CameraWorkerInit {
  type: 'init'
  cameraUrl: string | File
  /** Worker index for memory logging identification */
  workerIndex?: number
  /** Enable memory logging in this worker */
  enableMemLog?: boolean
}

export interface CameraWorkerLoadRowGroup {
  type: 'loadRowGroup'
  requestId: number
  rowGroupIndex: number
}

export type CameraWorkerRequest = CameraWorkerInit | CameraWorkerLoadRowGroup

/** A single camera image within a frame */
export interface CameraImageResult {
  cameraName: number
  jpeg: ArrayBuffer
}

/** A single frame's camera images within a row group batch */
export interface CameraFrameResult {
  /** bigint timestamp serialized as string */
  timestamp: string
  images: CameraImageResult[]
}

export interface CameraWorkerRowGroupResult {
  type: 'rowGroupReady'
  requestId: number
  rowGroupIndex: number
  frames: CameraFrameResult[]
  totalMs: number
}

export interface CameraWorkerReady {
  type: 'ready'
  numRowGroups: number
}

export interface CameraWorkerError {
  type: 'error'
  requestId?: number
  message: string
}

export type CameraWorkerResponse =
  | CameraWorkerReady
  | CameraWorkerRowGroupResult
  | CameraWorkerError

// ---------------------------------------------------------------------------
// Columns to read
// ---------------------------------------------------------------------------

const CAMERA_COLUMNS = [
  'key.frame_timestamp_micros',
  'key.camera_name',
  '[CameraImageComponent].image',
]

const post = self as unknown as {
  postMessage(msg: CameraWorkerResponse, transfer?: Transferable[]): void
}

// ---------------------------------------------------------------------------
// Sequential queue (same pattern as dataWorker)
// ---------------------------------------------------------------------------

let processing = false
const queue: CameraWorkerRequest[] = []

async function processQueue() {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const msg = queue.shift()!
    await handleMessage(msg)
  }

  processing = false
}

async function handleMessage(msg: CameraWorkerRequest) {
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
        numRowGroups: cameraPf.rowGroups.length,
      })
      return
    }

    if (msg.type === 'loadRowGroup') {
      if (!cameraPf) {
        throw new Error('Camera worker not initialized')
      }

      const t0 = performance.now()
      wMem.snap(`rg${msg.rowGroupIndex}:fetch-start`)

      // 1. Read entire row group (utf8:false → BYTE_ARRAY stays as Uint8Array, not string)
      const allRows = await readRowGroupRows(cameraPf, msg.rowGroupIndex, CAMERA_COLUMNS, { utf8: false })
      wMem.snap(`rg${msg.rowGroupIndex}:decompress-done`, {
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
      wMem.snap(`rg${msg.rowGroupIndex}:complete`, {
        dataSize: xferBytes,
        note: `${frames.length} frames, ${totalMs.toFixed(0)}ms`,
      })

      post.postMessage(
        {
          type: 'rowGroupReady',
          requestId: msg.requestId,
          rowGroupIndex: msg.rowGroupIndex,
          frames,
          totalMs,
        },
        transferBuffers,
      )
    }
  } catch (err) {
    post.postMessage({
      type: 'error',
      requestId: (msg as CameraWorkerLoadRowGroup).requestId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

self.onmessage = (e: MessageEvent<CameraWorkerRequest>) => {
  queue.push(e.data)
  processQueue()
}
