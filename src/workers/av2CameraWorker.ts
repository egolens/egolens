/**
 * Argoverse 2 Camera Worker — reads JPEG image files off the main thread.
 *
 * AV2 stores each camera image as an individual .jpg file:
 *   sensors/cameras/{cam_name}/{timestamp_ns}.jpg
 *
 * The worker simply reads files and passes through the ArrayBuffer.
 * Init/batch protocol matches the generic WorkerPool interface.
 */

import type {
  WorkerInitBase,
  CameraImageResult,
  CameraFrameResult,
  CameraBatchRequest,
  CameraWorkerResponse,
} from './types'
import { createWorkerMemoryLogger } from '../utils/memoryLogger'

// ---------------------------------------------------------------------------
// Init message
// ---------------------------------------------------------------------------

export interface AV2CameraImageDescriptor {
  /** Numeric camera ID (from AV2_SENSOR_NAME_TO_ID) */
  cameraId: number
  /** Relative path to .jpg file */
  filename: string
}

export interface AV2CameraFrameDescriptor {
  /** Frame timestamp as string (bigint serialized) */
  timestamp: string
  /** Camera images for this frame */
  images: AV2CameraImageDescriptor[]
}

export interface AV2CameraWorkerInit extends WorkerInitBase {
  /** Frames grouped into batches */
  frameBatches: AV2CameraFrameDescriptor[][]
  /** File access: serialized as [filename, File][] */
  fileEntries: [string, File][]
}

export type AV2CameraWorkerRequest = AV2CameraWorkerInit | CameraBatchRequest

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let frameBatches: AV2CameraFrameDescriptor[][] = []
let fileMap = new Map<string, File>()
let wMem = createWorkerMemoryLogger('worker-av2-cam-?')

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

const post = self as unknown as {
  postMessage(msg: CameraWorkerResponse, transfer?: Transferable[]): void
}

let processing = false
const queue: AV2CameraWorkerRequest[] = []

async function processQueue() {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const msg = queue.shift()!
    await handleMessage(msg)
  }

  processing = false
}

async function handleMessage(msg: AV2CameraWorkerRequest) {
  try {
    if (msg.type === 'init') {
      const idx = msg.workerIndex ?? 0
      wMem = createWorkerMemoryLogger(`worker-av2-cam-${idx}`)
      if (msg.enableMemLog) wMem.setEnabled(true)

      wMem.snap('init:start')
      frameBatches = msg.frameBatches
      fileMap = new Map(msg.fileEntries)
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

      const frames: CameraFrameResult[] = []
      const transferBuffers: ArrayBuffer[] = []

      for (const frameDesc of batch) {
        const images: CameraImageResult[] = []

        for (const imgDesc of frameDesc.images) {
          const file = fileMap.get(imgDesc.filename)
          if (!file) {
            console.warn(`[AV2 Camera] File not found: ${imgDesc.filename}`)
            continue
          }

          const jpeg = await file.arrayBuffer()
          images.push({ cameraName: imgDesc.cameraId, jpeg })
          transferBuffers.push(jpeg)
        }

        frames.push({
          timestamp: frameDesc.timestamp,
          images,
        })
      }

      const totalMs = performance.now() - t0

      let xferBytes = 0
      for (const buf of transferBuffers) xferBytes += buf.byteLength
      wMem.snap(`batch${msg.batchIndex}:complete`, {
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

self.onmessage = (e: MessageEvent<AV2CameraWorkerRequest>) => {
  queue.push(e.data)
  processQueue()
}
