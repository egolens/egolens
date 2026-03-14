/**
 * Camera RGB Sampler — colors each LiDAR point by the camera pixel it projects to.
 *
 * Uses camera calibration (intrinsics + extrinsics) to compute 3D→2D projection
 * mathematically. No Parquet I/O needed — pure math on data already in memory.
 *
 * For each point: project to all cameras, pick the best (shallowest depth,
 * within image bounds), sample RGB from decoded camera JPEG.
 */

import {
  projectPointsToCamera,
  type CameraProjector,
} from './lidarProjection'
import { getManifest } from '../adapters/registry'

// ---------------------------------------------------------------------------
// Decoded camera image cache
// ---------------------------------------------------------------------------

type DecodedCameras = Map<number, ImageData>

const decodedImageCache = new Map<bigint, DecodedCameras>()
const MAX_IMAGE_CACHE = 4

async function decodeCameraImages(
  cameraImages: Map<number, ArrayBuffer>,
): Promise<DecodedCameras> {
  const result: DecodedCameras = new Map()
  const entries = [...cameraImages.entries()]
  const decoded = await Promise.all(
    entries.map(async ([camName, jpegBuf]) => {
      try {
        const blob = new Blob([jpegBuf], { type: 'image/jpeg' })
        const bitmap = await createImageBitmap(blob)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        return { camName, imageData }
      } catch {
        return null
      }
    }),
  )
  for (const d of decoded) {
    if (d) result.set(d.camName, d.imageData)
  }
  return result
}

async function getDecodedCameras(
  timestamp: bigint,
  cameraImages: Map<number, ArrayBuffer>,
): Promise<DecodedCameras> {
  const cached = decodedImageCache.get(timestamp)
  if (cached) return cached

  const decoded = await decodeCameraImages(cameraImages)
  if (decodedImageCache.size >= MAX_IMAGE_CACHE) {
    const oldest = decodedImageCache.keys().next().value
    if (oldest !== undefined) decodedImageCache.delete(oldest)
  }
  decodedImageCache.set(timestamp, decoded)
  return decoded
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build camera RGB for all sensor clouds in a frame.
 * Projects each point to camera space using calibration, then samples RGB.
 *
 * @returns Map of laserName → Uint8Array (RGB per point)
 */
export async function buildCameraRgbForFrame(
  timestamp: bigint,
  sensorClouds: Map<number, { positions: Float32Array; pointCount: number }>,
  cameraImages: Map<number, ArrayBuffer>,
  projectors: Map<number, CameraProjector>,
): Promise<Map<number, Uint8Array>> {
  const result = new Map<number, Uint8Array>()
  if (cameraImages.size === 0 || projectors.size === 0) return result

  // Decode camera JPEGs → ImageData (cached per frame)
  const decodedCameras = await getDecodedCameras(timestamp, cameraImages)
  if (decodedCameras.size === 0) return result

  const projectorList = [...projectors.values()]
  const stride = getManifest().pointStride

  for (const [laserName, cloud] of sensorClouds) {
    const rgb = new Uint8Array(cloud.pointCount * 3)
    // Default: dark gray for points with no camera coverage
    rgb.fill(30)

    // For each camera, project all points and pick best (shallowest) per point
    const bestDepth = new Float32Array(cloud.pointCount)
    bestDepth.fill(Infinity)

    for (const proj of projectorList) {
      const imageData = decodedCameras.get(proj.cameraName)
      if (!imageData) continue

      const projected = projectPointsToCamera(
        cloud.positions, cloud.pointCount, stride, proj, 1.0,
      )

      const { data: pixels, width: imgW } = imageData

      for (const pt of projected) {
        const i = pt.srcIndex
        if (pt.depth < bestDepth[i]) {
          bestDepth[i] = pt.depth
          const px = Math.round(Math.max(0, Math.min(pt.u, imageData.width - 1)))
          const py = Math.round(Math.max(0, Math.min(pt.v, imageData.height - 1)))
          const idx = (py * imgW + px) * 4
          rgb[i * 3] = pixels[idx]
          rgb[i * 3 + 1] = pixels[idx + 1]
          rgb[i * 3 + 2] = pixels[idx + 2]
        }
      }
    }

    result.set(laserName, rgb)
  }

  return result
}

/** Clear all caches (call on segment switch) */
export function clearCameraRgbCache() {
  decodedImageCache.clear()
}
