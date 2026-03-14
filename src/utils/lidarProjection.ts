/**
 * LiDAR → Camera projection utilities.
 *
 * Projects 3D LiDAR points (vehicle/ego frame) onto camera image plane
 * using the camera extrinsic (sensor→ego, 4×4) and intrinsic (f_u, f_v, c_u, c_v).
 *
 * Coordinate conventions:
 *   Vehicle frame: X=forward, Y=left, Z=up
 *   nuScenes camera (optical): X=right, Y=down, Z=forward
 *   Waymo camera (sensor-aligned): similar to vehicle frame
 *
 * For nuScenes (__isOpticalFrame=true):
 *   p_cam = inv(extrinsic) × p_ego   →  project with pinhole model
 *
 * For Waymo (__isOpticalFrame=false):
 *   Need additional optical↔sensor rotation (TODO: verify when Waymo support added)
 */

import type { ParquetRow } from './merge'

const CAM_PREFIX = '[CameraCalibrationComponent]'

/** Pre-computed projection data for one camera */
export interface CameraProjector {
  cameraName: number
  width: number
  height: number
  /** Camera intrinsic: focal lengths + principal point */
  f_u: number
  f_v: number
  c_u: number
  c_v: number
  /** inv(extrinsic): ego→camera transform (4×4 row-major) */
  invExtrinsic: number[]
  /** Is the sensor frame already optical convention? (nuScenes=true, Waymo=false) */
  isOpticalFrame: boolean
}

/** Invert a 4×4 rigid-body transform: [R|t] → [R^T | -R^T·t] */
function invertRigid4x4(m: number[]): number[] {
  // Rotation part (3×3 transpose)
  const r00 = m[0], r01 = m[1], r02 = m[2]
  const r10 = m[4], r11 = m[5], r12 = m[6]
  const r20 = m[8], r21 = m[9], r22 = m[10]
  const tx = m[3], ty = m[7], tz = m[11]
  // -R^T · t
  const itx = -(r00 * tx + r10 * ty + r20 * tz)
  const ity = -(r01 * tx + r11 * ty + r21 * tz)
  const itz = -(r02 * tx + r12 * ty + r22 * tz)
  return [
    r00, r10, r20, itx,
    r01, r11, r21, ity,
    r02, r12, r22, itz,
    0,   0,   0,   1,
  ]
}

/**
 * Parse camera calibration rows into CameraProjector array.
 * Each projector pre-computes the inverse extrinsic for fast projection.
 */
export function buildCameraProjectors(rows: ParquetRow[]): Map<number, CameraProjector> {
  const result = new Map<number, CameraProjector>()

  for (const row of rows) {
    const cameraName = row['key.camera_name'] as number
    if (!cameraName) continue

    const extrinsic = row[`${CAM_PREFIX}.extrinsic.transform`] as number[]
    const width = row[`${CAM_PREFIX}.width`] as number
    const height = row[`${CAM_PREFIX}.height`] as number
    const f_u = row[`${CAM_PREFIX}.intrinsic.f_u`] as number
    const f_v = row[`${CAM_PREFIX}.intrinsic.f_v`] as number
    const c_u = (row[`${CAM_PREFIX}.intrinsic.c_u`] as number) ?? width / 2
    const c_v = (row[`${CAM_PREFIX}.intrinsic.c_v`] as number) ?? height / 2
    const isOpticalFrame = !!row['__isOpticalFrame']

    if (!extrinsic || !width || !height || !f_u || !f_v) continue

    result.set(cameraName, {
      cameraName,
      width,
      height,
      f_u,
      f_v,
      c_u,
      c_v,
      invExtrinsic: invertRigid4x4(extrinsic),
      isOpticalFrame,
    })
  }

  return result
}

// ---------------------------------------------------------------------------
// 3D Box → Camera projection (nuScenes render_annotation style)
// ---------------------------------------------------------------------------

/** 8 corners of a 3D box projected to image plane */
export interface ProjectedBox {
  /** 8 corner pixel coordinates [u,v] — same ordering as nuScenes Box.corners():
   *  First 4 face forward, last 4 face backward.
   *  Corner layout (looking from above, X=forward):
   *    0: +x +y +z   (front-left-top)
   *    1: +x -y +z   (front-right-top)
   *    2: +x -y -z   (front-right-bottom)
   *    3: +x +y -z   (front-left-bottom)
   *    4: -x +y +z   (rear-left-top)
   *    5: -x -y +z   (rear-right-top)
   *    6: -x -y -z   (rear-right-bottom)
   *    7: -x +y -z   (rear-left-bottom)
   */
  corners: [number, number][]
  /** Whether all 8 corners are in front of camera (z > 0.1) */
  allInFront: boolean
  /** Whether any corner is visible within image bounds */
  anyVisible: boolean
}

/**
 * Compute 8 corners of a 3D bounding box in ego/vehicle frame.
 * Convention matches nuScenes: X=forward, Y=left, Z=up.
 *
 * @param cx,cy,cz  Box center in ego frame
 * @param length    Size along X (forward)
 * @param width     Size along Y (left)
 * @param height    Size along Z (up)
 * @param heading   Yaw rotation around Z axis (radians)
 * @returns 8 corners as [x,y,z] arrays, same order as nuScenes Box.corners()
 */
function boxCorners3D(
  cx: number, cy: number, cz: number,
  length: number, width: number, height: number,
  heading: number,
): [number, number, number][] {
  const cosH = Math.cos(heading)
  const sinH = Math.sin(heading)
  const hl = length / 2, hw = width / 2, hh = height / 2

  // Local corner offsets: [dx, dy, dz] — nuScenes convention
  const offsets: [number, number, number][] = [
    [+hl, +hw, +hh],  // 0: front-left-top
    [+hl, -hw, +hh],  // 1: front-right-top
    [+hl, -hw, -hh],  // 2: front-right-bottom
    [+hl, +hw, -hh],  // 3: front-left-bottom
    [-hl, +hw, +hh],  // 4: rear-left-top
    [-hl, -hw, +hh],  // 5: rear-right-top
    [-hl, -hw, -hh],  // 6: rear-right-bottom
    [-hl, +hw, -hh],  // 7: rear-left-bottom
  ]

  return offsets.map(([dx, dy, dz]) => [
    cx + cosH * dx - sinH * dy,
    cy + sinH * dx + cosH * dy,
    cz + dz,
  ])
}

/**
 * Project a 3D bounding box onto a camera image plane.
 * Replicates nuScenes devkit Box.render() logic:
 *  1. Compute 8 corners in ego frame
 *  2. Transform ego → camera via inv(extrinsic)
 *  3. Pinhole projection to image plane
 *
 * @returns null if box is entirely behind camera
 */
export function projectBoxToCamera(
  cx: number, cy: number, cz: number,
  length: number, width: number, height: number,
  heading: number,
  projector: CameraProjector,
): ProjectedBox | null {
  const corners3D = boxCorners3D(cx, cy, cz, length, width, height, heading)
  const { f_u, f_v, c_u, c_v, width: imgW, height: imgH, invExtrinsic: inv, isOpticalFrame } = projector

  const corners2D: [number, number][] = []
  let allInFront = true
  let anyVisible = false

  for (const [ex, ey, ez] of corners3D) {
    // Ego → camera transform
    let camX = inv[0] * ex + inv[1] * ey + inv[2] * ez + inv[3]
    let camY = inv[4] * ex + inv[5] * ey + inv[6] * ez + inv[7]
    let camZ = inv[8] * ex + inv[9] * ey + inv[10] * ez + inv[11]

    if (!isOpticalFrame) {
      const ox = -camY, oy = -camZ, oz = camX
      camX = ox; camY = oy; camZ = oz
    }

    if (camZ <= 0.1) {
      allInFront = false
      corners2D.push([-9999, -9999]) // placeholder for behind-camera corners
      continue
    }

    const u = f_u * (camX / camZ) + c_u
    const v = f_v * (camY / camZ) + c_v
    corners2D.push([u, v])

    if (u >= 0 && u < imgW && v >= 0 && v < imgH) {
      anyVisible = true
    }
  }

  if (!allInFront) return null // skip boxes with any corner behind camera

  return { corners: corners2D, allInFront, anyVisible }
}

/** Projected point: pixel coordinates + depth (z in camera frame) */
export interface ProjectedPoint {
  u: number  // pixel x
  v: number  // pixel y
  depth: number  // distance from camera
  /** Index into original point array (for color lookup) */
  srcIndex: number
}

/**
 * Project LiDAR points (vehicle frame) into a camera's image plane.
 *
 * @param positions  Interleaved float32 [x, y, z, ...] with given stride
 * @param pointCount Number of valid points
 * @param stride     Floats per point in positions array
 * @param projector  Camera projection parameters
 * @param minDepth   Minimum depth to include (default: 1m)
 * @returns Array of projected points that fall within image bounds
 */
export function projectPointsToCamera(
  positions: Float32Array,
  pointCount: number,
  stride: number,
  projector: CameraProjector,
  minDepth = 1.0,
): ProjectedPoint[] {
  const { f_u, f_v, c_u, c_v, width, height, invExtrinsic: inv, isOpticalFrame } = projector
  const result: ProjectedPoint[] = []

  for (let i = 0; i < pointCount; i++) {
    const src = i * stride
    const ex = positions[src]
    const ey = positions[src + 1]
    const ez = positions[src + 2]

    // Transform ego → camera: p_cam = inv(extrinsic) × p_ego
    let cx = inv[0] * ex + inv[1] * ey + inv[2] * ez + inv[3]
    let cy = inv[4] * ex + inv[5] * ey + inv[6] * ez + inv[7]
    let cz = inv[8] * ex + inv[9] * ey + inv[10] * ez + inv[11]

    if (!isOpticalFrame) {
      // Waymo: sensor frame is vehicle-aligned, convert to optical
      // optical X = -sensor Y, optical Y = -sensor Z, optical Z = sensor X
      const ox = -cy
      const oy = -cz
      const oz = cx
      cx = ox; cy = oy; cz = oz
    }

    // Depth check: point must be in front of camera
    if (cz < minDepth) continue

    // Pinhole projection
    const u = f_u * (cx / cz) + c_u
    const v = f_v * (cy / cz) + c_v

    // Bounds check (with small margin)
    if (u < -1 || u >= width + 1 || v < -1 || v >= height + 1) continue

    result.push({ u, v, depth: cz, srcIndex: i })
  }

  return result
}
