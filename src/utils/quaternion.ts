/**
 * Quaternion → 4×4 rotation matrix conversion.
 *
 * Used by nuScenes (ego_pose, annotations, calibrated_sensor)
 * where rotations are stored as quaternions [w, x, y, z] (scalar-first).
 */

/**
 * Convert a scalar-first quaternion [w, x, y, z] and translation [tx, ty, tz]
 * into a 4×4 row-major homogeneous transform matrix.
 *
 * The resulting matrix is:
 *   [ R  t ]
 *   [ 0  1 ]
 *
 * where R is the 3×3 rotation and t is the 3×1 translation column.
 */
export function quaternionToMatrix4x4(
  rotation: [number, number, number, number],
  translation: [number, number, number],
): number[] {
  const [w, x, y, z] = rotation
  const [tx, ty, tz] = translation

  // Rotation matrix from unit quaternion (row-major)
  const xx = x * x, yy = y * y, zz = z * z
  const xy = x * y, xz = x * z, yz = y * z
  const wx = w * x, wy = w * y, wz = w * z

  // prettier-ignore
  return [
    1 - 2 * (yy + zz),     2 * (xy - wz),     2 * (xz + wy),  tx,
        2 * (xy + wz), 1 - 2 * (xx + zz),     2 * (yz - wx),  ty,
        2 * (xz - wy),     2 * (yz + wx), 1 - 2 * (xx + yy),  tz,
                    0,                  0,                  0,   1,
  ]
}
