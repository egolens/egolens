/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import minimalJson from '../__fixtures__/minimal.egolens-adapter.json'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import { TeachableAuthoringSessionV1, type AuthoringRevisionEvaluatorV1 } from '../authoring/AuthoringSession'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import {
  assertValidSensorConfigurationV1,
  declaredSensorSummaryV1,
  inferSensorConfigurationV1,
  sensorConfigurationDiagnosticsV1,
} from '../authoring/sensorConfiguration'
import { assertValidRecipeV1 } from '../schema/validateSchema'

function inventoryOf(paths: readonly string[]): SourceInventoryV1 {
  return new SourceInventoryV1(paths.map((path) => [path, new File(['x'], path.split('/').at(-1)!, { lastModified: 1 })]), { sessionId: 'sensors' })
}

const sensor = (id: string, modality: 'lidar' | 'radar' | 'camera') => ({
  id, rendererId: 1, label: id, modality, frameId: `${id}-frame`, color: '#ffffff',
  ...(modality === 'camera' ? { image: { width: 16, height: 16, model: 'pinhole' as const, view: 'front' as const } } : {}),
})

describe('sensor configuration', () => {
  it('infers one sensor per image directory and per named point stream', () => {
    const nuscenes = inventoryOf([
      'v1.0-mini/sensor.json',
      'samples/CAM_FRONT/a.jpg', 'samples/CAM_FRONT/b.jpg', 'samples/CAM_BACK/a.jpg',
      'samples/LIDAR_TOP/a.pcd.bin', 'samples/RADAR_FRONT/a.pcd', 'samples/RADAR_BACK_LEFT/a.pcd',
    ]).snapshot()
    expect(inferSensorConfigurationV1(nuscenes)).toEqual({ lidar: 1, radar: 2, camera: 2, names: { lidar: ['LIDAR_TOP'], radar: ['RADAR_BACK_LEFT', 'RADAR_FRONT'], camera: ['CAM_BACK', 'CAM_FRONT'] } })
    const av2 = inventoryOf([
      'annotations.feather', 'sensors/lidar/1.feather', 'sensors/cameras/ring_front_center/1.jpg', 'sensors/cameras/ring_side_left/1.jpg',
    ]).snapshot()
    expect(inferSensorConfigurationV1(av2)).toMatchObject({ lidar: 1, radar: 0, camera: 2, names: { lidar: ['lidar'], camera: ['ring_front_center', 'ring_side_left'] } })
    // KITTI-style generic leaf folders take the parent folder's name.
    expect(inferSensorConfigurationV1(inventoryOf([
      'drive/image_00/data/0000000000.png', 'drive/image_02/data/0000000000.png', 'drive/velodyne_points/data/0000000000.bin',
    ]).snapshot())).toEqual({ lidar: 1, radar: 0, camera: 2, names: { lidar: ['velodyne_points'], camera: ['image_00', 'image_02'] } })
    // Single-table layouts carry no per-stream directories: the human fills these in.
    expect(inferSensorConfigurationV1(inventoryOf(['lidar/segment.parquet', 'camera_image/segment.parquet']).snapshot())).toEqual({ lidar: 0, radar: 0, camera: 0 })
  })

  it('validates confirmed counts', () => {
    expect(assertValidSensorConfigurationV1({ lidar: 5, radar: 0, camera: 5 })).toEqual({ lidar: 5, radar: 0, camera: 5 })
    expect(() => assertValidSensorConfigurationV1({ lidar: 0, radar: 0, camera: 0 })).toThrow(/at least one sensor/u)
    expect(() => assertValidSensorConfigurationV1({ lidar: -1, radar: 0, camera: 1 })).toThrow(/between 0 and 64/u)
  })

  it('summarizes declared sensors per modality and flags every count that disagrees', () => {
    const recipe = { scene: { sensors: [sensor('lidar', 'lidar'), sensor('camera', 'camera')] } } as unknown as EgoLensAdapterRecipeV1
    expect(declaredSensorSummaryV1(recipe)).toEqual([
      { modality: 'lidar', ids: ['lidar'] }, { modality: 'radar', ids: [] }, { modality: 'camera', ids: ['camera'] },
    ])
    expect(sensorConfigurationDiagnosticsV1(recipe, null)).toEqual([])
    const diagnostics = sensorConfigurationDiagnosticsV1(recipe, { lidar: 5, radar: 0, camera: 5 })
    expect(diagnostics.map((item) => item.code)).toEqual(['SENSOR_CONFIGURATION_UNMET', 'SENSOR_CONFIGURATION_UNMET'])
    expect(diagnostics[0]!.hint).toMatch(/expects 5 lidar sensors; the recipe declares 1 \(lidar\)/u)
    expect(diagnostics[1]!.hint).toMatch(/expects 5 camera sensors; the recipe declares 1 \(camera\)/u)
  })

  it('makes the session enforce the confirmed layout and publish it through the contract', async () => {
    const evaluator: AuthoringRevisionEvaluatorV1 = { prepare: vi.fn() }
    const session = new TeachableAuthoringSessionV1(evaluator)
    const inventory = inventoryOf(['frames.json', 'points/000001.bin'])
    session.start(inventory, { sensorConfiguration: { lidar: 1, radar: 0, camera: 0 } })
    expect(session.getState().sensorConfiguration).toEqual({ lidar: 1, radar: 0, camera: 0 })
    expect(session.getContract().sensorConfiguration).toEqual({ lidar: 1, radar: 0, camera: 0 })

    const result = await session.applyRevision(assertValidRecipeV1(structuredClone(minimalJson)))
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toMatchObject([{ code: 'SENSOR_CONFIGURATION_UNMET', jsonPointer: '/scene/sensors' }])
    expect(evaluator.prepare).not.toHaveBeenCalled()

    const unconstrained = new TeachableAuthoringSessionV1({ prepare: vi.fn() })
    unconstrained.start(inventoryOf(['frames.json']))
    expect(unconstrained.getState().sensorConfiguration).toBeNull()
  })

  it('counts a PandaSet-style lidar folder of pickle frames as one lidar stream', () => {
    const entries = ['lidar/00.pkl', 'lidar/01.pkl', 'lidar/poses.json', 'camera/front_camera/00.jpg', 'camera/back_camera/00.jpg', 'annotations/cuboids/00.pkl', 'annotations/semseg/00.pkl']
      .map((path) => ({ path, size: 1, extension: path.slice(path.lastIndexOf('.')), lastModified: 0 }))
    const configuration = inferSensorConfigurationV1({ sessionId: 's', entries, truncated: false, revoked: false } as never)
    expect(configuration.lidar).toBe(1)
    expect(configuration.camera).toBe(2)
    expect(configuration.names?.lidar).toEqual(['lidar'])
  })
})
