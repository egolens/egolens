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
    presentation: 'projected-cuboid',
    center: [(left + right) / 2, (top + bottom) / 2],
    dimensions: [right - left, bottom - top],
  }
}

function quaternionWxyzFromRowMajorV1(m: ArrayLike<number>): [number, number, number, number] {
  const r00 = m[0]!, r01 = m[1]!, r02 = m[2]!, r10 = m[4]!, r11 = m[5]!, r12 = m[6]!, r20 = m[8]!, r21 = m[9]!, r22 = m[10]!
  const trace = r00 + r11 + r22
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    return [0.25 * s, (r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s]
  }
  if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2
    return [(r21 - r12) / s, 0.25 * s, (r01 + r10) / s, (r02 + r20) / s]
  }
  if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2
    return [(r02 - r20) / s, (r01 + r10) / s, 0.25 * s, (r12 + r21) / s]
  }
  const s = Math.sqrt(1 + r22 - r00 - r11) * 2
  return [(r10 - r01) / s, (r02 + r20) / s, (r12 + r21) / s, 0.25 * s]
}

function multiplyQuaternionWxyzV1(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): [number, number, number, number] {
  const [aw, ax, ay, az] = a
  const [bw, bx, by, bz] = b
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ]
}

/**
 * Re-express a world-frame box in the ego frame given a row-major ego←world
 * matrix. Center, orientation, and heading all move together; boxes already in
 * another frame are returned untouched.
 */
export function egoBoxFromWorldV1<T extends {
  readonly frameId: string
  readonly center: readonly [number, number, number]
  readonly orientation: readonly [number, number, number, number]
  readonly heading?: number
}>(box: T, egoFromWorld: ArrayLike<number> | null): T {
  if (box.frameId !== 'world' || !egoFromWorld) return box
  const m = egoFromWorld
  const [x, y, z] = box.center
  const center: [number, number, number] = [
    m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
    m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
    m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
  ]
  const orientation = multiplyQuaternionWxyzV1(quaternionWxyzFromRowMajorV1(m), box.orientation)
  const heading = (box.heading ?? headingFromQuaternionWxyzV1(box.orientation)) + Math.atan2(m[4]!, m[0]!)
  return { ...box, center, orientation, heading, frameId: 'ego' }
}
