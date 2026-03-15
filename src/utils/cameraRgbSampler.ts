/**
 * Camera RGB Sampler — colors each LiDAR point by the camera pixel it projects to.
 *
 * Performance-critical: uses fused single-pass projection+sampling to avoid
 * intermediate object allocation. ~168K points × 5 cameras = ~840K iterations
 * per frame — no GC pressure from ProjectedPoint objects.
 *
 * Uses camera calibration (intrinsics + extrinsics) to compute 3D→2D projection
 * mathematically. No Parquet I/O needed — pure math on data already in memory.
 */

import { type CameraProjector } from './lidarProjection'
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
// Pre-allocated buffers (reused across frames to avoid GC)
// ---------------------------------------------------------------------------

let _bestDepth: Float32Array | null = null

function getBestDepthBuffer(size: number): Float32Array {
  if (!_bestDepth || _bestDepth.length < size) {
    _bestDepth = new Float32Array(size)
  }
  // Fill with Infinity (only the portion we'll use)
  for (let i = 0; i < size; i++) _bestDepth[i] = Infinity
  return _bestDepth
}

// ---------------------------------------------------------------------------
// Fused projection + RGB sampling (zero intermediate allocation)
// ---------------------------------------------------------------------------

/**
 * Fused single-pass: project all points for one camera and sample RGB inline.
 * No intermediate ProjectedPoint[] — eliminates ~168K object allocations per camera.
 *
 * For each point: transform to camera frame → depth check → pinhole project →
 * bounds check → depth-test vs bestDepth → sample RGB from ImageData.
 */
function fusedProjectAndSample(
  positions: Float32Array,
  pointCount: number,
  stride: number,
  proj: CameraProjector,
  imageData: ImageData,
  rgb: Uint8Array,
  bestDepth: Float32Array,
): void {
  const { f_u, f_v, c_u, c_v, width, height, invExtrinsic: inv, isOpticalFrame } = proj
  const { data: pixels, width: imgW } = imageData
  const minDepth = 1.0
  const imgWm1 = width - 1
  const imgHm1 = height - 1

  // Inline transformToCameraFrame + pinhole projection for maximum throughput
  const m0 = inv[0], m1 = inv[1], m2 = inv[2], m3 = inv[3]
  const m4 = inv[4], m5 = inv[5], m6 = inv[6], m7 = inv[7]
  const m8 = inv[8], m9 = inv[9], m10 = inv[10], m11 = inv[11]

  for (let i = 0; i < pointCount; i++) {
    const src = i * stride
    const ex = positions[src]
    const ey = positions[src + 1]
    const ez = positions[src + 2]

    // inv(extrinsic) × [ex, ey, ez, 1] → camera sensor frame
    let cx = m0 * ex + m1 * ey + m2 * ez + m3
    let cy = m4 * ex + m5 * ey + m6 * ez + m7
    let cz = m8 * ex + m9 * ey + m10 * ez + m11

    // Convert sensor frame → optical frame if needed
    if (!isOpticalFrame) {
      const ox = -cy, oy = -cz, oz = cx
      cx = ox; cy = oy; cz = oz
    }

    // Depth check
    if (cz < minDepth) continue

    // Depth-test early: skip if this camera can't beat current best
    if (cz >= bestDepth[i]) continue

    // Pinhole projection
    const invZ = 1 / cz
    const u = f_u * (cx * invZ) + c_u
    const v = f_v * (cy * invZ) + c_v

    // Bounds check
    if (u < -1 || u > width || v < -1 || v > height) continue

    // This camera wins for this point
    bestDepth[i] = cz

    // Sample RGB from decoded image
    const px = u < 0 ? 0 : u > imgWm1 ? imgWm1 : (u + 0.5) | 0
    const py = v < 0 ? 0 : v > imgHm1 ? imgHm1 : (v + 0.5) | 0
    const idx = (py * imgW + px) << 2  // × 4 (RGBA)
    const o = i * 3
    rgb[o] = pixels[idx]
    rgb[o + 1] = pixels[idx + 1]
    rgb[o + 2] = pixels[idx + 2]
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build camera RGB for all sensor clouds in a frame.
 * Projects each point to camera space using calibration, then samples RGB.
 *
 * Performance: fused single-pass projection+sampling eliminates ~840K object
 * allocations per frame. Pre-allocated bestDepth buffer avoids GC.
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

    // Pre-allocated bestDepth buffer (reused across sensor clouds)
    const bestDepth = getBestDepthBuffer(cloud.pointCount)

    // Fused projection + sampling: one pass per camera, zero intermediate objects
    for (const proj of projectorList) {
      const imageData = decodedCameras.get(proj.cameraName)
      if (!imageData) continue

      fusedProjectAndSample(
        cloud.positions, cloud.pointCount, stride,
        proj, imageData, rgb, bestDepth,
      )
    }

    result.set(laserName, rgb)
  }

  return result
}

/** Clear all caches (call on segment switch) */
export function clearCameraRgbCache() {
  decodedImageCache.clear()
}
