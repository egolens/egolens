/**
 * nuScenes Camera Worker — reads JPEG image files off the main thread.
 *
 * Unlike Waymo (Parquet-embedded JPEGs), nuScenes stores each camera image
 * as an individual .jpg file. The worker simply reads files and passes through
 * the ArrayBuffer — no decompression or conversion needed.
 *
 * Init payload:
 *   - frameBatches: array of batches, each batch is an array of frame descriptors
 *     { timestamp, images: [{ cameraId, filename }] }
 *   - fileEntries: serialized Map of filename → File
 */

import type {
  WorkerInitBase,
  CameraImageResult,
  CameraFrameResult,
  CameraBatchRequest,
  CameraWorkerResponse,
} from './types'
import { createWorkerMemoryLogger } from '../utils/memoryLogger'
import { resolveFileEntry } from './fetchHelper'

// ---------------------------------------------------------------------------
// Init message
// ---------------------------------------------------------------------------

export interface NuScenesCameraImageDescriptor {
  /** Numeric camera ID (from NUSCENES_CHANNEL_TO_ID) */
  cameraId: number
  /** Relative path to .jpg file (e.g. "samples/CAM_FRONT/xxx.jpg") */
  filename: string
}

export interface NuScenesCameraFrameDescriptor {
  /** Frame timestamp as string (bigint serialized) */
  timestamp: string
  /** Camera images for this frame */
  images: NuScenesCameraImageDescriptor[]
}

export interface NuScenesCameraWorkerInit extends WorkerInitBase {
  /** Frames grouped into batches */
  frameBatches: NuScenesCameraFrameDescriptor[][]
  /** File access: [filename, File | URL string][] — File for local, string for remote */
  fileEntries: [string, File | string][]
}

export type NuScenesCameraWorkerRequest = NuScenesCameraWorkerInit | CameraBatchRequest

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let frameBatches: NuScenesCameraFrameDescriptor[][] = []
let fileMap = new Map<string, File | string>()
let wMem = createWorkerMemoryLogger('worker-nuscenes-cam-?')

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

const post = self as unknown as {
  postMessage(msg: CameraWorkerResponse, transfer?: Transferable[]): void
}

let processing = false
const queue: NuScenesCameraWorkerRequest[] = []

async function processQueue() {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const msg = queue.shift()!
    await handleMessage(msg)
  }

  processing = false
}

async function handleMessage(msg: NuScenesCameraWorkerRequest) {
  try {
    if (msg.type === 'init') {
      const idx = msg.workerIndex ?? 0
      wMem = createWorkerMemoryLogger(`worker-nuscenes-cam-${idx}`)
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
          const entry = fileMap.get(imgDesc.filename)
          if (!entry) {
            console.warn(`[nuScenes Camera] File not found: ${imgDesc.filename}`)
            continue
          }

          const jpeg = await resolveFileEntry(entry)
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

self.onmessage = (e: MessageEvent<NuScenesCameraWorkerRequest>) => {
  queue.push(e.data)
  processQueue()
}
