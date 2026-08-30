import { describe, expect, it, vi } from 'vitest'
import { compareNormalizedScenes } from '../runtime/parityHarness'
import type { NormalizedFrameV1, NormalizedSceneV1 } from '../runtime/normalizedScene'

function makeScene(value = 1, dispose = vi.fn()): NormalizedSceneV1 {
  const frame: NormalizedFrameV1 = {
    index: 0,
    timestampMicros: 100n,
    worldFromEgo: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    pointClouds: [{
      sensorId: 'top',
      frameId: 'ego',
      values: new Float32Array([value, 2, 3]),
      pointCount: 1,
      stride: 3,
      attributes: ['x', 'y', 'z'],
    }],
    radarPointClouds: [],
    cameraImages: [],
    boxes3d: [],
    boxes2d: [],
    keypoints3d: [],
    keypoints2d: [],
    lidarSegmentation: [],
    cameraSegmentation: [],
  }
  return {
    manifest: {
      id: 'fixture',
      name: 'Fixture',
      nominalFrameRate: 10,
      sensors: [{ id: 'top', rendererId: 1, label: 'TOP', modality: 'lidar', frameId: 'ego', color: '#ffffff' }],
      taxonomies: [],
      pointAttributes: [
        { id: 'x', storage: 'float32' },
        { id: 'y', storage: 'float32' },
        { id: 'z', storage: 'float32' },
      ],
      pointLayout: { interleavedAttributes: ['x', 'y', 'z'], colorModes: ['distance'] },
      capabilities: new Set(['timeline', 'pointClouds']),
    },
    index: { timestampsMicros: [100n], segments: [{ id: 'one', firstFrame: 0, frameCount: 1 }] },
    relations: {
      staticTransforms: [],
      cameraCalibrations: new Map(),
      trajectories: new Map(),
      box2dToBox3d: new Map(),
    },
    loadFrame: async () => frame,
    dispose,
  }
}

describe('headless parity harness', () => {
  it('compares serialized scenes without touching the Zustand store', async () => {
    const leftDispose = vi.fn()
    const rightDispose = vi.fn()
    const result = await compareNormalizedScenes(
      async () => makeScene(1, leftDispose),
      async () => makeScene(1, rightDispose),
    )
    expect(result.equal).toBe(true)
    expect(leftDispose).toHaveBeenCalledOnce()
    expect(rightDispose).toHaveBeenCalledOnce()
  })

  it('reports the first deterministic sampled-buffer difference', async () => {
    const result = await compareNormalizedScenes(
      async () => makeScene(1),
      async () => makeScene(9),
    )
    expect(result.equal).toBe(false)
    expect(result.differences[0]?.path).toContain('/frames/0/pointClouds/0/values/samples/0')
  })
})
