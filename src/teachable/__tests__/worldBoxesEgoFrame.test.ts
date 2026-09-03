import { describe, expect, it } from 'vitest'
import { egoBoxFromWorldV1, headingFromQuaternionWxyzV1 } from '../operators/sceneGeometry'

describe('egoBoxFromWorldV1', () => {
  const box = { id: 'b', objectId: 'b', classId: 'car', frameId: 'world', center: [10, 0, 1] as const, dimensions: [4, 2, 1.5] as const, orientation: [1, 0, 0, 0] as const, heading: 0 }
  it('moves center, orientation, and heading together under a yaw + translation', () => {
    // ego←world: rotate +90° about z, then translate by (1, 2, 0). Row-major.
    const c = Math.cos(Math.PI / 2), s = Math.sin(Math.PI / 2)
    const m = [c, -s, 0, 1, s, c, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1]
    const out = egoBoxFromWorldV1(box, m)
    expect(out.frameId).toBe('ego')
    expect(out.center.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 12, 1])
    expect(out.heading).toBeCloseTo(Math.PI / 2, 9)
    expect(headingFromQuaternionWxyzV1(out.orientation)).toBeCloseTo(Math.PI / 2, 9)
  })
  it('leaves non-world boxes and missing poses untouched', () => {
    expect(egoBoxFromWorldV1({ ...box, frameId: 'ego' }, [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toEqual({ ...box, frameId: 'ego' })
    expect(egoBoxFromWorldV1(box, null)).toBe(box)
  })
})
