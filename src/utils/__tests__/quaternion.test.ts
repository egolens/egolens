import { describe, expect, it } from 'vitest'
import { quaternionToMatrix4x4 } from '../quaternion'

describe('quaternionToMatrix4x4', () => {
  it('maps identity rotation and translation into a row-major transform', () => {
    expect(quaternionToMatrix4x4([1, 0, 0, 0], [10, 20, 30])).toEqual([
      1, 0, 0, 10,
      0, 1, 0, 20,
      0, 0, 1, 30,
      0, 0, 0, 1,
    ])
  })

  it('rotates 90 degrees around the Z axis', () => {
    const c = Math.cos(Math.PI / 4)
    const s = Math.sin(Math.PI / 4)
    const matrix = quaternionToMatrix4x4([c, 0, 0, s], [0, 0, 0])
    expect(matrix[0]).toBeCloseTo(0)
    expect(matrix[1]).toBeCloseTo(-1)
    expect(matrix[4]).toBeCloseTo(1)
    expect(matrix[5]).toBeCloseTo(0)
    expect(matrix[10]).toBeCloseTo(1)
  })

  it('rotates 180 degrees around the X axis', () => {
    const matrix = quaternionToMatrix4x4([0, 1, 0, 0], [0, 0, 0])
    expect(matrix[0]).toBeCloseTo(1)
    expect(matrix[5]).toBeCloseTo(-1)
    expect(matrix[10]).toBeCloseTo(-1)
  })

  it('produces an orthogonal rotation matrix', () => {
    const matrix = quaternionToMatrix4x4([0.5, 0.5, 0.5, 0.5], [1, 2, 3])
    const rotation = [
      [matrix[0], matrix[1], matrix[2]],
      [matrix[4], matrix[5], matrix[6]],
      [matrix[8], matrix[9], matrix[10]],
    ]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let dot = 0
        for (let k = 0; k < 3; k++) dot += rotation[k][i] * rotation[k][j]
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 10)
      }
    }
  })
})
