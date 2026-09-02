import { invertRowMajor4x4 } from '../../utils/matrix'
import type { NormalizedCameraCalibrationV1, NormalizedFrameV1, NormalizedPointCloudV1 } from '../runtime/normalizedScene'

/** Pixel positions and depths of ego-frame points seen by one camera. */
export interface ProjectedPointsV1 {
  readonly u: Float32Array
  readonly v: Float32Array
  readonly depth: Float32Array
  readonly count: number
}

export interface ReviewThumbnailV1 {
  readonly frameIndex: number
  readonly sensorId: string
  readonly width: number
  readonly height: number
  readonly projectedPoints: number
  readonly dataUrl: string
}

export const REVIEW_THUMBNAIL_WIDTH_V1 = 320
export const REVIEW_THUMBNAIL_MAX_POINTS_V1 = 6000

/**
 * Pinhole projection of ego-frame point clouds into a normalized camera
 * (optical frame: x right, y down, z forward). Distortion is ignored; the
 * thumbnails exist to catch gross calibration and binding mistakes.
 */
export function projectPointsToCameraV1(
  clouds: readonly NormalizedPointCloudV1[],
  calibration: NormalizedCameraCalibrationV1,
  maxPoints = REVIEW_THUMBNAIL_MAX_POINTS_V1,
): ProjectedPointsV1 {
  const cameraFromEgo = invertRowMajor4x4([...calibration.egoFromCamera])
  const [fx, fy, cx, cy] = calibration.intrinsics
  const total = clouds.reduce((sum, cloud) => sum + (cloud.frameId === 'ego' ? cloud.pointCount : 0), 0)
  const step = Math.max(1, Math.ceil(total / maxPoints))
  const u = new Float32Array(Math.min(total, maxPoints))
  const v = new Float32Array(u.length)
  const depth = new Float32Array(u.length)
  let count = 0
  let cursor = 0
  for (const cloud of clouds) {
    if (cloud.frameId !== 'ego') continue
    for (let index = 0; index < cloud.pointCount; index += 1, cursor += 1) {
      if (cursor % step !== 0 || count >= u.length) continue
      const base = index * cloud.stride
      const x = cloud.values[base]!, y = cloud.values[base + 1]!, z = cloud.values[base + 2]!
      const px = cameraFromEgo[0]! * x + cameraFromEgo[1]! * y + cameraFromEgo[2]! * z + cameraFromEgo[3]!
      const py = cameraFromEgo[4]! * x + cameraFromEgo[5]! * y + cameraFromEgo[6]! * z + cameraFromEgo[7]!
      const pz = cameraFromEgo[8]! * x + cameraFromEgo[9]! * y + cameraFromEgo[10]! * z + cameraFromEgo[11]!
      if (!(pz > 0.5)) continue
      const pu = fx * px / pz + cx
      const pv = fy * py / pz + cy
      if (pu < 0 || pv < 0 || pu >= calibration.width || pv >= calibration.height) continue
      u[count] = pu; v[count] = pv; depth[count] = pz
      count += 1
    }
  }
  return { u: u.subarray(0, count), v: v.subarray(0, count), depth: depth.subarray(0, count), count }
}

function depthColor(depth: number): string {
  // near = warm, far = cool; clamp to 60 m
  const t = Math.min(1, Math.max(0, depth / 60))
  const hue = 200 * t
  return `hsl(${Math.round(hue)}, 90%, 60%)`
}

/** Browser-only: true when thumbnails can be rasterized in this environment. */
export function canRenderReviewThumbnailsV1(): boolean {
  return typeof createImageBitmap === 'function' && typeof document !== 'undefined' && typeof document.createElement === 'function'
}

/**
 * Rasterizes one camera image of a sampled frame with the projected lidar
 * points drawn on top, downscaled to the review width. Returns null when the
 * environment cannot decode images.
 */
export async function renderReviewThumbnailV1(
  frame: NormalizedFrameV1,
  sensorId: string,
  calibrations: ReadonlyMap<string, NormalizedCameraCalibrationV1>,
  width = REVIEW_THUMBNAIL_WIDTH_V1,
): Promise<ReviewThumbnailV1 | null> {
  if (!canRenderReviewThumbnailsV1()) return null
  const image = frame.cameraImages.find((entry) => entry.sensorId === sensorId)
  const calibration = image ? calibrations.get(image.calibrationId) ?? calibrations.get(sensorId) : undefined
  if (!image || !calibration) return null
  const bitmap = await createImageBitmap(new Blob([image.encodedBytes], { type: image.mimeType }))
  try {
    const scale = width / bitmap.width
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0, width, height)
    const projected = projectPointsToCameraV1(frame.pointClouds, calibration)
    const sx = width / calibration.width
    const sy = height / calibration.height
    for (let index = 0; index < projected.count; index += 1) {
      context.fillStyle = depthColor(projected.depth[index]!)
      context.fillRect(projected.u[index]! * sx - 1, projected.v[index]! * sy - 1, 2, 2)
    }
    return { frameIndex: frame.index, sensorId, width, height, projectedPoints: projected.count, dataUrl: canvas.toDataURL('image/jpeg', 0.7) }
  } finally {
    bitmap.close()
  }
}

/** Thumbnails for every camera of every sampled frame, bounded to keep the panel light. */
export async function renderReviewThumbnailsV1(
  frames: readonly NormalizedFrameV1[],
  calibrations: ReadonlyMap<string, NormalizedCameraCalibrationV1>,
  maxThumbnails = 24,
): Promise<readonly ReviewThumbnailV1[]> {
  const thumbnails: ReviewThumbnailV1[] = []
  for (const frame of frames) {
    for (const image of frame.cameraImages) {
      if (thumbnails.length >= maxThumbnails) return thumbnails
      const thumbnail = await renderReviewThumbnailV1(frame, image.sensorId, calibrations)
      if (thumbnail) thumbnails.push(thumbnail)
    }
  }
  return thumbnails
}
