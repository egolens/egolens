/**
 * Camera calibration parser — extracts position, orientation, and FOV
 * from Waymo camera_calibration Parquet rows.
 *
 * Waymo extrinsic is a 4×4 row-major matrix (sensor frame → vehicle frame).
 * The sensor frame is vehicle-aligned (≈ identity rotation for ideal mount),
 * NOT the optical camera convention.
 *
 * To place frustums (built in optical space: X=right, Y=down, Z=forward),
 * we compose: R_extrinsic × R_optical_to_sensor.
 *
 * Vehicle frame: X=forward, Y=left, Z=up.
 */

import * as THREE from 'three'
import type { ParquetRow } from './merge'

/**
 * Rotation from optical camera convention to sensor (vehicle-aligned) frame.
 *
 *   Optical:  X=right,   Y=down,  Z=forward
 *   Sensor:   X=forward, Y=left,  Z=up
 *
 *   optical X(right)   → sensor −Y (right)   = [0, −1, 0]
 *   optical Y(down)    → sensor −Z (down)     = [0,  0, −1]
 *   optical Z(forward) → sensor  X (forward)  = [1,  0, 0]
 */
const OPTICAL_TO_SENSOR = (() => {
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(1, 0, 0),
  )
  return new THREE.Quaternion().setFromRotationMatrix(m)
})()

export interface CameraCalib {
  cameraName: number
  width: number
  height: number
  /** Vertical field of view in radians */
  vFov: number
  /** Horizontal field of view in radians */
  hFov: number
  /** Camera position in vehicle frame */
  position: THREE.Vector3
  /** Camera orientation in vehicle frame (optical camera → vehicle) */
  quaternion: THREE.Quaternion
  /** Raw 4×4 extrinsic (row-major): sensor → vehicle */
  extrinsic: number[]
}

const CAM_PREFIX = '[CameraCalibrationComponent]'

/**
 * Parse camera calibration rows into a Map keyed by camera name (1-5).
 *
 * Waymo camera frame convention: X=right, Y=down, Z=forward.
 * The extrinsic matrix transforms from this frame into vehicle frame.
 */
export function parseCameraCalibrations(rows: ParquetRow[]): Map<number, CameraCalib> {
  const result = new Map<number, CameraCalib>()

  for (const row of rows) {
    const cameraName = row['key.camera_name'] as number
    if (!cameraName) continue

    const extrinsic = row[`${CAM_PREFIX}.extrinsic.transform`] as number[]
    const width = row[`${CAM_PREFIX}.width`] as number
    const height = row[`${CAM_PREFIX}.height`] as number
    const f_u = row[`${CAM_PREFIX}.intrinsic.f_u`] as number
    const f_v = row[`${CAM_PREFIX}.intrinsic.f_v`] as number

    if (!extrinsic || !width || !height || !f_u || !f_v) continue

    // FOV from focal length
    const vFov = 2 * Math.atan(height / (2 * f_v))
    const hFov = 2 * Math.atan(width / (2 * f_u))

    // Extrinsic is sensor→vehicle (same convention as LiDAR).
    // The sensor frame is vehicle-aligned, NOT optical camera convention.
    // Row-major 4×4: [R | t], t = sensor origin in vehicle frame.
    const e = extrinsic

    // Camera position in vehicle frame (translation column)
    const position = new THREE.Vector3(e[3], e[7], e[11])

    // Rotation: R_extrinsic maps sensor axes to vehicle frame.
    const m4 = new THREE.Matrix4()
    m4.makeBasis(
      new THREE.Vector3(e[0], e[4], e[8]),
      new THREE.Vector3(e[1], e[5], e[9]),
      new THREE.Vector3(e[2], e[6], e[10]),
    )
    const qExtrinsic = new THREE.Quaternion().setFromRotationMatrix(m4)

    // Waymo sensor frame is vehicle-aligned → need optical→sensor rotation.
    // nuScenes sensor frame IS optical convention → skip the extra rotation.
    const isOpticalFrame = !!row['__isOpticalFrame']
    const quaternion = isOpticalFrame
      ? qExtrinsic
      : qExtrinsic.multiply(OPTICAL_TO_SENSOR)

    result.set(cameraName, {
      cameraName,
      width,
      height,
      vFov,
      hFov,
      position,
      quaternion,
      extrinsic,
    })
  }

  return result
}

/**
 * Compute far plane corners for a given camera FOV.
 */
function frustumCorners(hFov: number, vFov: number, far: number): number[][] {
  const fl = far * Math.tan(hFov / 2)
  const ft = far * Math.tan(vFov / 2)
  return [
    [-fl, -ft, far],
    [fl, -ft, far],
    [fl, ft, far],
    [-fl, ft, far],
  ]
}

/**
 * Build the full frustum wireframe (base rectangle + 4 pyramid edges).
 */
export function buildFrustumLines(
  hFov: number,
  vFov: number,
  far: number,
): Float32Array {
  const f = frustumCorners(hFov, vFov, far)
  const lines: number[] = []
  const addLine = (a: number[], b: number[]) => {
    lines.push(a[0], a[1], a[2], b[0], b[1], b[2])
  }
  for (let i = 0; i < 4; i++) addLine(f[i], f[(i + 1) % 4])
  const o = [0, 0, 0]
  for (let i = 0; i < 4; i++) addLine(o, f[i])
  return new Float32Array(lines)
}

/**
 * Build only the base rectangle (far plane outline) of the frustum.
 */
export function buildFrustumBase(
  hFov: number,
  vFov: number,
  far: number,
): Float32Array {
  const f = frustumCorners(hFov, vFov, far)
  const lines: number[] = []
  for (let i = 0; i < 4; i++) {
    const a = f[i], b = f[(i + 1) % 4]
    lines.push(a[0], a[1], a[2], b[0], b[1], b[2])
  }
  return new Float32Array(lines)
}

/**
 * Build only the 4 pyramid edges (origin → far corners), without the base.
 */
export function buildFrustumEdges(
  hFov: number,
  vFov: number,
  far: number,
): Float32Array {
  const f = frustumCorners(hFov, vFov, far)
  const lines: number[] = []
  const o = [0, 0, 0]
  for (let i = 0; i < 4; i++) {
    lines.push(o[0], o[1], o[2], f[i][0], f[i][1], f[i][2])
  }
  return new Float32Array(lines)
}
