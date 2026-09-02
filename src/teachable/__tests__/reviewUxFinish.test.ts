/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest'
import { revisionRequestTextV1 } from '../authoring/revisionRequest'
import { assertValidSensorConfigurationV1, inferSensorConfigurationV1, sensorConfigurationDiagnosticsV1 } from '../authoring/sensorConfiguration'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { renderBevThumbnailV1 } from '../authoring/reviewThumbnails'
import type { EgoLensAdapterRecipeV1, RecipeSensorV1 } from '../recipe/types'

function inventoryOf(paths: readonly string[]): SourceInventoryV1 {
  return new SourceInventoryV1(paths.map((path) => [path, new File(['x'], path.split('/').at(-1)!, { lastModified: 1 })]), { sessionId: 'ux' })
}
const sensor = (id: string, modality: RecipeSensorV1['modality']) => ({ id, modality }) as RecipeSensorV1
const recipeWith = (sensors: RecipeSensorV1[]) => ({ scene: { sensors } }) as unknown as EgoLensAdapterRecipeV1

describe('review UX finish', () => {
  it('infers stream names from the folder and enforces them as the declared ids', () => {
    const inferred = inferSensorConfigurationV1(inventoryOf([
      'scene/camera/cam_front_center/1.png', 'scene/camera/cam_rear/1.png', 'scene/lidar/cam_front_center/1.npz', 'scene/lidar/cam_rear/1.npz',
    ]).snapshot())
    expect(inferred).toEqual({ lidar: 2, radar: 0, camera: 2, names: { lidar: ['cam_front_center', 'cam_rear'], camera: ['cam_front_center', 'cam_rear'] } })
    const configuration = assertValidSensorConfigurationV1({ lidar: 0, radar: 0, camera: 2, names: { camera: ['CAM_FRONT', 'CAM_BACK'] } })
    expect(sensorConfigurationDiagnosticsV1(recipeWith([sensor('CAM_FRONT', 'camera'), sensor('CAM_BACK', 'camera')]), configuration)).toEqual([])
    const wrong = sensorConfigurationDiagnosticsV1(recipeWith([sensor('CAM_FRONT', 'camera'), sensor('camera_back', 'camera')]), configuration)
    expect(wrong).toHaveLength(1)
    expect(wrong[0]!.hint).toMatch(/missing: CAM_BACK.*unexpected: camera_back/u)
    expect(() => assertValidSensorConfigurationV1({ lidar: 0, radar: 0, camera: 2, names: { camera: ['only-one'] } })).toThrow(/lists 1 ids but 2/u)
  })

  it('writes a concrete revision request from rejections, layout gaps, unbound sensors, and warnings', () => {
    const text = revisionRequestTextV1({
      reviews: [{ recipeHash: 'sha256:x', capability: 'boxes2d', frameIndices: [0, 19], verdict: 'rejected', issue: 'misaligned' }, { recipeHash: 'sha256:x', capability: 'timeline', frameIndices: [0], verdict: 'accepted' }],
      diagnostics: [{ stage: 'sample', severity: 'warning', code: 'CAMERA_PROJECTION_EMPTY', hint: 'no points reach CAM_BACK' }, { stage: 'bind', severity: 'info', code: 'X', hint: 'ignored' }],
      currentArtifact: recipeWith([sensor('LIDAR_TOP', 'lidar'), sensor('CAM_FRONT', 'camera')]),
      sensorConfiguration: { lidar: 1, radar: 0, camera: 6 },
      sensorSamples: { LIDAR_TOP: [100, 90], CAM_FRONT: [0, 0] },
    })
    expect(text.split('\n')).toEqual([
      'Revise the adapter using my Teachable Lens review:',
      '- boxes2d: rejected on frames 0, 19 (misaligned).',
      '- camera: 6 sensors are expected, 1 declared.',
      '- CAM_FRONT: declared but no data reached any sampled frame.',
      '- CAMERA_PROJECTION_EMPTY: no points reach CAM_BACK',
    ])
    expect(revisionRequestTextV1({ reviews: [], diagnostics: [], currentArtifact: null, sensorConfiguration: null })).toMatch(/Every reviewed capability was accepted/u)
  })

  it('skips the BEV raster where no canvas rendering exists', () => {
    expect(renderBevThumbnailV1({ index: 0, pointClouds: [] } as never)).toBeNull()
  })
})
