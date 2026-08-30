import { describe, expect, it } from 'vitest'
import { bridgeNormalizedFrame } from '../runtime/compatibilityBridge'
import type { NormalizedFrameV1, NormalizedManifestV1 } from '../runtime/normalizedScene'

const manifest = {
  sensors: [
    { id: 'radar-front', rendererId: 10, modality: 'radar' },
    { id: 'camera-front', rendererId: 1, modality: 'camera' },
  ],
  taxonomies: [{ role: 'objects', classes: [{ id: 'car', rendererId: 1 }] }],
} as unknown as NormalizedManifestV1

function frameWithRadar(values: Float32Array): NormalizedFrameV1 {
  return {
    index: 0,
    timestampMicros: 1n,
    worldFromEgo: null,
    pointClouds: [],
    radarPointClouds: [{
      sensorId: 'radar-front',
      frameId: 'ego',
      values,
      pointCount: 1,
      stride: 7,
      attributes: ['x', 'y', 'z', 'vx', 'vy', 'vx_comp', 'vy_comp'],
    }],
    cameraImages: [],
    boxes3d: [],
    boxes2d: [],
    keypoints3d: [],
    keypoints2d: [],
    lidarSegmentation: [],
    cameraSegmentation: [],
    metadata: null,
  }
}

describe('bridgeNormalizedFrame', () => {
  it('projects normalized radar velocity components into the legacy five-value layout', () => {
    const normalizedValues = new Float32Array([1, 2, 3, 3, 4, 6, 8])

    const bridged = bridgeNormalizedFrame(frameWithRadar(normalizedValues), manifest)

    expect(Array.from(bridged.sensorClouds.get(10)?.positions ?? [])).toEqual([1, 2, 3, 10, 5])
    expect(Array.from(normalizedValues)).toEqual([1, 2, 3, 3, 4, 6, 8])
  })

  it('keeps projected cuboids on the legacy wireframe path', () => {
    const base = frameWithRadar(new Float32Array([1, 2, 3, 3, 4, 6, 8]))
    const bridged = bridgeNormalizedFrame({
      ...base,
      radarPointClouds: [],
      boxes2d: [
        {
          id: 'native', objectId: 'native', classId: 'car', cameraId: 'camera-front',
          presentation: 'rectangle', center: [10, 20], dimensions: [30, 40],
        },
        {
          id: 'projected', objectId: 'projected', classId: 'car', cameraId: 'camera-front',
          presentation: 'projected-cuboid', center: [10, 20], dimensions: [30, 40],
        },
      ],
    }, manifest)

    expect(bridged.cameraBoxes).toHaveLength(1)
    expect(bridged.cameraBoxes[0]['key.camera_object_id']).toBe('native')
  })

  it('preserves a source-unit timestamp at the renderer boundary', () => {
    const frame = frameWithRadar(new Float32Array([1, 2, 3, 3, 4, 6, 8]))

    expect(bridgeNormalizedFrame(frame, manifest, 1_000n).timestamp).toBe(1_000n)
  })
})
