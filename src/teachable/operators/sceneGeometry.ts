import { invertRowMajor4x4 } from '../../utils/matrix'
import type { NormalizedBox2dV1, NormalizedBox3dV1, NormalizedCameraCalibrationV1 } from '../runtime/normalizedScene'

function transformPoint(matrix: readonly number[], x: number, y: number, z: number): [number, number, number] {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
    matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
    matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
  ]
}

export function headingFromQuaternionWxyzV1(quaternion: readonly [number, number, number, number]): number {
  const [w, x, y, z] = quaternion
  if (quaternion.some((value) => !Number.isFinite(value))) throw new Error('Box quaternion must be finite.')
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
}

/** Project an ego-frame cuboid through a pinhole camera and clip to its image. */
export function projectBox3dPinholeV1(
  box: NormalizedBox3dV1,
  calibration: NormalizedCameraCalibrationV1,
): NormalizedBox2dV1 | null {
  const cameraFromEgo = invertRowMajor4x4([...calibration.egoFromCamera])
  const [length, width, height] = box.dimensions
  const heading = box.heading ?? headingFromQuaternionWxyzV1(box.orientation)
  const cos = Math.cos(heading)
  const sin = Math.sin(heading)
  const xs: number[] = []
  const ys: number[] = []
  for (const dx of [-length / 2, length / 2]) {
    for (const dy of [-width / 2, width / 2]) {
      for (const dz of [-height / 2, height / 2]) {
        const egoX = box.center[0] + cos * dx - sin * dy
        const egoY = box.center[1] + sin * dx + cos * dy
        const egoZ = box.center[2] + dz
        const [x, y, z] = transformPoint(cameraFromEgo, egoX, egoY, egoZ)
        if (z <= 1e-3) continue
        xs.push(calibration.intrinsics[0] * x / z + calibration.intrinsics[2])
        ys.push(calibration.intrinsics[1] * y / z + calibration.intrinsics[3])
      }
    }
  }
  if (xs.length === 0) return null
  const left = Math.max(0, Math.min(...xs))
  const right = Math.min(calibration.width, Math.max(...xs))
  const top = Math.max(0, Math.min(...ys))
  const bottom = Math.min(calibration.height, Math.max(...ys))
  if (right <= left || bottom <= top) return null
  return {
    id: `${box.id}:${calibration.sensorId}`,
    objectId: box.objectId,
    classId: box.classId,
    cameraId: calibration.sensorId,
    center: [(left + right) / 2, (top + bottom) / 2],
    dimensions: [right - left, bottom - top],
  }
}
