/**
 * Range image → xyz point cloud conversion.
 *
 * Port of Waymo SDK's `lidar_utils.convert_range_image_to_point_cloud()`.
 * Source: https://github.com/waymo-research/waymo-open-dataset
 * References: GitHub issues #656, #51, #307, #863
 *
 * Math:
 *   x = range × cos(inclination) × cos(azimuth)
 *   y = range × cos(inclination) × sin(azimuth)
 *   z = range × sin(inclination)
 *   Then apply extrinsic 4×4 matrix (sensor frame → vehicle frame).
 *
 * This module contains pure math — no DOM, no Workers, no WebGPU.
 * Both CPU Worker and WebGPU shader use the same logic.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LidarCalibration {
  laserName: number
  /** 4×4 row-major transform matrix (sensor → vehicle frame) */
  extrinsic: number[]
  /** Non-uniform beam inclinations (e.g. 64 values for TOP). null = uniform. */
  beamInclinationValues: number[] | null
  /** Min inclination angle (radians). Used for uniform interpolation. */
  beamInclinationMin: number
  /** Max inclination angle (radians). Used for uniform interpolation. */
  beamInclinationMax: number
}

export interface RangeImage {
  /** Flat array of [range, intensity, elongation, nlz] × (height × width) */
  values: number[] | Float32Array
  /** [height, width, channels] */
  shape: [number, number, number]
}

/** Floats per point in the interleaved buffer */
export const POINT_STRIDE = 6

export interface PointCloud {
  /** Interleaved [x, y, z, intensity, range, elongation, ...] in vehicle frame */
  positions: Float32Array
  /** Number of valid points */
  pointCount: number
  /** Per-point semantic segmentation labels (uint8, 0–31). nuScenes lidarseg only. */
  segLabels?: Uint8Array
  /** Per-point panoptic labels (uint16, encoded as category_id*1000 + instance_id). nuScenes panoptic only. */
  panopticLabels?: Uint16Array
  /** Per-point camera projection: [camName, pixelX, pixelY] × pointCount (Int16). Waymo only. */
  cameraProjection?: Int16Array
  /** Per-point camera RGB colors: [R, G, B] × pointCount (Uint8, 0–255). Computed from cameraProjection + camera images. */
  cameraRgb?: Uint8Array
  /** Per-point range image pixel index (row*W+col), for matching with seg labels. Waymo only. */
  validIndices?: Uint32Array
}

// ---------------------------------------------------------------------------
// Calibration parsing
// ---------------------------------------------------------------------------

/**
 * Parse LidarCalibration from a Parquet row.
 */
export function parseLidarCalibration(row: Record<string, unknown>): LidarCalibration {
  return {
    laserName: row['key.laser_name'] as number,
    extrinsic: row['[LiDARCalibrationComponent].extrinsic.transform'] as number[],
    beamInclinationValues:
      (row['[LiDARCalibrationComponent].beam_inclination.values'] as number[] | undefined) ?? null,
    beamInclinationMin: row['[LiDARCalibrationComponent].beam_inclination.min'] as number,
    beamInclinationMax: row['[LiDARCalibrationComponent].beam_inclination.max'] as number,
  }
}

// ---------------------------------------------------------------------------
// Core conversion
// ---------------------------------------------------------------------------

/**
 * Compute beam inclination angles for each row of the range image.
 *
 * - Non-uniform (TOP): use provided values array directly.
 * - Uniform (others): linearly interpolate between min and max.
 *   Row 0 = max (top of image), last row = min.
 */
export function computeInclinations(
  height: number,
  calib: LidarCalibration,
): Float32Array {
  const inclinations = new Float32Array(height)

  if (calib.beamInclinationValues && calib.beamInclinationValues.length === height) {
    // Values are stored ascending (min→max) but range image row 0 = max (top),
    // so reverse to match the uniform convention (descending).
    for (let i = 0; i < height; i++) {
      inclinations[i] = calib.beamInclinationValues[height - 1 - i]
    }
  } else {
    // Uniform interpolation: row 0 = max, last row = min
    for (let i = 0; i < height; i++) {
      const t = height > 1 ? i / (height - 1) : 0
      inclinations[i] = calib.beamInclinationMax * (1 - t) + calib.beamInclinationMin * t
    }
  }

  return inclinations
}

/**
 * Compute azimuth angles for each column of the range image.
 *
 * Matches Waymo SDK's `compute_range_image_polar()`:
 *   ratio = (width - col - 0.5) / width
 *   azimuth = (ratio * 2 - 1) * π - az_correction
 *
 * az_correction = atan2(extrinsic[1][0], extrinsic[0][0]) accounts for
 * sensor yaw so that column→azimuth mapping is correct per sensor.
 */
export function computeAzimuths(width: number, azCorrection: number): Float32Array {
  const azimuths = new Float32Array(width)

  for (let col = 0; col < width; col++) {
    const ratio = (width - col - 0.5) / width
    azimuths[col] = (ratio * 2 - 1) * Math.PI - azCorrection
  }

  return azimuths
}

/**
 * Convert a range image to a 3D point cloud (vehicle frame).
 *
 * This is the core function — pure math, no side effects.
 * Processes a single LiDAR sensor's range image for a single frame.
 *
 * Output format: Float32Array of [x, y, z, intensity, x, y, z, intensity, ...]
 * Only valid points (range > 0) are included.
 *
 */
/**
 * Optional projection data — same shape as range image [H, W, 6].
 * Channels: [cam1, x1, y1, cam2, x2, y2] per pixel.
 */
export interface ProjectionImage {
  values: number[] | Float32Array
  shape: [number, number, number]
}

export function convertRangeImageToPointCloud(
  rangeImage: RangeImage,
  calibration: LidarCalibration,
  projection?: ProjectionImage,
): PointCloud {
  const [height, width, channels] = rangeImage.shape
  const values = rangeImage.values

  // Precompute angles
  const inclinations = computeInclinations(height, calibration)
  // az_correction = atan2(extrinsic[1][0], extrinsic[0][0]) — sensor yaw
  const azCorrection = Math.atan2(calibration.extrinsic[4], calibration.extrinsic[0])
  const azimuths = computeAzimuths(width, azCorrection)

  // Precompute trig tables
  const cosInc = new Float32Array(height)
  const sinInc = new Float32Array(height)
  for (let r = 0; r < height; r++) {
    cosInc[r] = Math.cos(inclinations[r])
    sinInc[r] = Math.sin(inclinations[r])
  }
  const cosAz = new Float32Array(width)
  const sinAz = new Float32Array(width)
  for (let c = 0; c < width; c++) {
    cosAz[c] = Math.cos(azimuths[c])
    sinAz[c] = Math.sin(azimuths[c])
  }

  // Extrinsic matrix components (row-major 4×4)
  const e = calibration.extrinsic
  const e00 = e[0], e01 = e[1], e02 = e[2], e03 = e[3]
  const e10 = e[4], e11 = e[5], e12 = e[6], e13 = e[7]
  const e20 = e[8], e21 = e[9], e22 = e[10], e23 = e[11]

  // Worst case: all pixels valid → POINT_STRIDE floats per point
  const maxPoints = height * width
  const output = new Float32Array(maxPoints * POINT_STRIDE)
  // Track valid pixel indices (row*width+col) for seg label matching
  const validIdxBuf = new Uint32Array(maxPoints)
  // Optional projection output: 3 int16s per point (camName, pixelX, pixelY)
  const projValues = projection?.values
  const projChannels = projection ? projection.shape[2] : 0
  const projOutput = projValues ? new Int16Array(maxPoints * 3) : null
  let pointCount = 0

  for (let row = 0; row < height; row++) {
    const ci = cosInc[row]
    const si = sinInc[row]

    for (let col = 0; col < width; col++) {
      const pixelIdx = (row * width + col) * channels
      const range = values[pixelIdx]

      if (range <= 0) continue

      const intensity = values[pixelIdx + 1]
      const elongation = values[pixelIdx + 2]

      // Spherical → Cartesian (sensor frame)
      const x = range * ci * cosAz[col]
      const y = range * ci * sinAz[col]
      const z = range * si

      // Apply extrinsic (sensor → vehicle frame)
      const vx = e00 * x + e01 * y + e02 * z + e03
      const vy = e10 * x + e11 * y + e12 * z + e13
      const vz = e20 * x + e21 * y + e22 * z + e23

      // Record which range image pixel this point came from (for seg matching)
      validIdxBuf[pointCount] = row * width + col

      const outIdx = pointCount * POINT_STRIDE
      output[outIdx] = vx
      output[outIdx + 1] = vy
      output[outIdx + 2] = vz
      output[outIdx + 3] = intensity
      output[outIdx + 4] = range
      output[outIdx + 5] = elongation

      // Extract camera projection (1st projection only — channels 0,1,2)
      if (projOutput && projValues) {
        const projIdx = (row * width + col) * projChannels
        projOutput[pointCount * 3] = projValues[projIdx]       // camName
        projOutput[pointCount * 3 + 1] = projValues[projIdx + 1] // pixelX
        projOutput[pointCount * 3 + 2] = projValues[projIdx + 2] // pixelY
      }

      pointCount++
    }
  }

  // slice() creates an independent trimmed copy instead of a view on the full buffer.
  const positions = output.slice(0, pointCount * POINT_STRIDE)
  const cameraProjection = projOutput ? projOutput.slice(0, pointCount * 3) : undefined
  const validIndices = validIdxBuf.slice(0, pointCount)
  return { positions, pointCount, cameraProjection, validIndices }
}

// ---------------------------------------------------------------------------
// Multi-sensor merge
// ---------------------------------------------------------------------------

/** Result of converting all sensors — per-sensor point clouds only. */
export interface MultiSensorResult {
  /** Per-sensor point clouds keyed by laser_name */
  perSensor: Map<number, PointCloud>
  /** Total point count across all sensors */
  totalPointCount: number
}

/**
 * Convert range images from all 5 LiDAR sensors into per-sensor point clouds.
 *
 * No merged buffer is produced — the renderer merges on the fly in useFrame
 * to avoid storing duplicate data (~772 MB savings for a 199-frame segment).
 *
 * @param rangeImages - Map from laser_name → RangeImage
 * @param calibrations - Map from laser_name → LidarCalibration
 * @returns per-sensor point clouds in vehicle frame
 */
export function convertAllSensors(
  rangeImages: Map<number, RangeImage>,
  calibrations: Map<number, LidarCalibration>,
  projections?: Map<number, ProjectionImage>,
): MultiSensorResult {
  const perSensor = new Map<number, PointCloud>()
  let totalPointCount = 0

  for (const [laserName, rangeImage] of rangeImages) {
    const calib = calibrations.get(laserName)
    if (!calib) {
      console.warn(`[rangeImage] No calibration for laser_name=${laserName}, skipping`)
      continue
    }
    const proj = projections?.get(laserName)
    const cloud = convertRangeImageToPointCloud(rangeImage, calib, proj)
    perSensor.set(laserName, cloud)
    totalPointCount += cloud.pointCount
  }

  return { perSensor, totalPointCount }
}
