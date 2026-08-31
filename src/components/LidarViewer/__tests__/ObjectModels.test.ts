import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ clear: vi.fn() }))

vi.mock('@react-three/fiber', () => ({
  useLoader: Object.assign(vi.fn(), { clear: mocks.clear }),
}))

import { clearObjectModelCache } from '../ObjectModels'

describe('clearObjectModelCache', () => {
  beforeEach(() => mocks.clear.mockClear())

  it('releases every process-wide GLTF loader entry owned by the viewer', () => {
    clearObjectModelCache()

    expect(mocks.clear).toHaveBeenCalledTimes(8)
    expect(mocks.clear.mock.calls.map(([, url]) => url).sort()).toEqual([
      '/models/barrier.glb',
      '/models/bicycle.glb',
      '/models/car.glb',
      '/models/cone.glb',
      '/models/cyclist.glb',
      '/models/motorcycle.glb',
      '/models/person.glb',
      '/models/sign.glb',
    ])
  })
})
