/**
 * Row-major 4×4 matrix utilities for rigid-body transforms.
 *
 * Used by metadata loaders (pose computation) and the store (frame caching).
 * All matrices are flat 16-element number arrays in row-major order.
 */

/** Multiply two row-major 4×4 matrices: result = A × B */
export function multiplyRowMajor4x4(a: number[], b: number[]): number[] {
  const r = new Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      r[i * 4 + j] =
        a[i * 4 + 0] * b[0 * 4 + j] +
        a[i * 4 + 1] * b[1 * 4 + j] +
        a[i * 4 + 2] * b[2 * 4 + j] +
        a[i * 4 + 3] * b[3 * 4 + j]
    }
  }
  return r
}

/** Invert a row-major 4×4 rigid-body transform [R|t; 0 0 0 1] → [R^T | -R^T·t] */
export function invertRowMajor4x4(m: number[]): number[] {
  const r00 = m[0], r01 = m[1], r02 = m[2], tx = m[3]
  const r10 = m[4], r11 = m[5], r12 = m[6], ty = m[7]
  const r20 = m[8], r21 = m[9], r22 = m[10], tz = m[11]
  return [
    r00, r10, r20, -(r00 * tx + r10 * ty + r20 * tz),
    r01, r11, r21, -(r01 * tx + r11 * ty + r21 * tz),
    r02, r12, r22, -(r02 * tx + r12 * ty + r22 * tz),
    0, 0, 0, 1,
  ]
}
