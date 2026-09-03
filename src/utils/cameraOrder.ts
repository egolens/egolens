import type { CameraSensorDef } from '../types/dataset'
import type { ParquetRow } from './merge'

const CAM_PREFIX = '[CameraCalibrationComponent]'

/** Mounting yaw (radians, ego frame, +left) of a camera from its ego ← camera extrinsic. */
export function cameraYawFromExtrinsic(extrinsic: readonly number[], isOpticalFrame: boolean): number {
  // Row-major 4×4: the camera's forward axis in ego coordinates is column 2 (optical z)
  // or column 0 (Waymo-style x-forward camera frame).
  const column = isOpticalFrame ? 2 : 0
  return Math.atan2(extrinsic[4 + column] ?? 0, extrinsic[column] ?? 1)
}

/**
 * Order camera tiles the way a person turns their head: a left-to-right sweep
 * that starts at the leftmost forward-facing camera and continues around the
 * right side to the rear. Cameras with (near) identical yaw keep their given
 * order, so a stereo rig stays left, right. Cameras without a calibration row
 * are appended in their given order.
 */
export function orderCamerasByYawV1(cameras: readonly CameraSensorDef[], calibrationRows: readonly ParquetRow[]): CameraSensorDef[] {
  const yawById = new Map<number, number>()
  for (const row of calibrationRows) {
    const id = row['key.camera_name']
    const extrinsic = row[`${CAM_PREFIX}.extrinsic.transform`]
    if (typeof id !== 'number' || !Array.isArray(extrinsic) || extrinsic.length !== 16) continue
    yawById.set(id, cameraYawFromExtrinsic(extrinsic as number[], Boolean(row.__isOpticalFrame)))
  }
  const known = cameras.filter((camera) => yawById.has(camera.id))
  const unknown = cameras.filter((camera) => !yawById.has(camera.id))
  if (known.length < 2) return [...cameras]
  const degrees = (camera: CameraSensorDef) => (yawById.get(camera.id)! * 180) / Math.PI
  const bucket = (camera: CameraSensorDef) => Math.round(degrees(camera) / 5) // 5° buckets keep stereo pairs stable
  const sorted = [...known].sort((left, right) => bucket(right) - bucket(left) || known.indexOf(left) - known.indexOf(right))
  // Start the sweep at the leftmost camera that still looks forward-ish (≤ 120° from forward).
  const startIndex = sorted.findIndex((camera) => degrees(camera) <= 120)
  const rotated = startIndex > 0 ? [...sorted.slice(startIndex), ...sorted.slice(0, startIndex)] : sorted
  return [...rotated, ...unknown]
}
