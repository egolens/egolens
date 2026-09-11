import { describe, expect, it } from 'vitest'
import { bridgeNormalizedFrame, normalizedManifestToDatasetManifest } from '../runtime/compatibilityBridge'
import type { NormalizedFrameV1, NormalizedManifestV1 } from '../runtime/normalizedScene'

const manifest = {
  sensors: [
    { id: 'radar-front', rendererId: 10, modality: 'radar' },
    { id: 'camera-front', rendererId: 1, modality: 'camera' },
  ],
  taxonomies: [{ role: 'objects', classes: [{ id: 'car', rendererId: 1 }] }],
} as unknown as NormalizedManifestV1

describe('semantic taxonomy projection', () => {
  const semanticManifest: NormalizedManifestV1 = {
    id: 'custom', name: 'Custom', nominalFrameRate: 10,
    sensors: [], pointAttributes: [], capabilities: new Set(['lidarSegmentation']),
    pointLayout: { interleavedAttributes: ['x', 'y', 'z'], colorModes: ['segment'] },
    taxonomies: [{
      id: 'semantics', role: 'lidar-semantics',
      classes: [
        { id: 'pedestrian-object', rendererId: 31, label: 'Pedestrian with Object', color: '#8040ff' },
        { id: 'road', rendererId: 13, label: 'Road', color: '#00ffff' },
      ],
    }],
  }

  it('uses recipe colors and renderer IDs when no explicit palette is provided', () => {
    const projected = normalizedManifestToDatasetManifest(semanticManifest)
    expect(projected.semanticLabels?.[31]).toBe('Pedestrian with Object')
    expect(projected.semanticLabels?.[13]).toBe('Road')
    expect(projected.semanticPalette?.[31]).toEqual([128 / 255, 64 / 255, 1])
    expect(projected.semanticPalette?.[13]).toEqual([0, 1, 1])
    expect(projected.semanticPalette?.[12]).toEqual([0.5, 0.5, 0.5])
  })

  it('preserves explicit palettes for existing datasets and camera semantics', () => {
    const palette = Array.from({ length: 32 }, () => [0.1, 0.2, 0.3] as const)
    const projected = normalizedManifestToDatasetManifest({
      ...semanticManifest,
      taxonomies: [{ ...semanticManifest.taxonomies[0], role: 'camera-semantics', palette }],
    })
    expect(projected.cameraSemanticPalette?.[31]).toEqual([0.1, 0.2, 0.3])
    expect(projected.cameraSemanticLabels?.[31]).toBe('Pedestrian with Object')
    expect(projected.semanticPalette).toBeUndefined()
  })
})

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

  it('reuses derived renderer views while normalized cache identities remain live', () => {
    const normalized = frameWithRadar(new Float32Array([1, 2, 3, 3, 4, 6, 8]))

    const first = bridgeNormalizedFrame(normalized, manifest)
    const second = bridgeNormalizedFrame(normalized, manifest)

    expect(second.sensorClouds).toBe(first.sensorClouds)
    expect(second.sensorClouds.get(10)).toBe(first.sensorClouds.get(10))
    expect(second.sensorClouds.get(10)?.positions).toBe(first.sensorClouds.get(10)?.positions)
    expect(second.boxes).toBe(first.boxes)
    expect(second.cameraBoxes).toBe(first.cameraBoxes)
    expect(second.cameraImages).toBe(first.cameraImages)
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
