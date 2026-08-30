import { describe, expect, it } from 'vitest'
import { buildNuScenesDatabase, loadNuScenesSceneMetadata } from '../../adapters/nuscenes/metadata'
import { nuScenesCompiledRecipe } from '../../adapters/recipes/bundled'
import type { NormalizedFrameV1 } from '../runtime/normalizedScene'
import { bindNuScenesRecipeSceneV1 } from '../runtime/NuScenesRecipeScene'
import { compareNormalizedFramesV1 } from '../runtime/parity'

function lidarFile(points: readonly (readonly number[])[]): File {
  const buffer = new ArrayBuffer(points.length * 20)
  const view = new DataView(buffer)
  points.forEach((point, row) => point.forEach((value, column) => view.setFloat32(row * 20 + column * 4, value, true)))
  return new File([buffer], 'lidar.pcd.bin')
}

function radarFile(): File {
  const header = [
    'VERSION 0.7',
    'FIELDS x y z vx vy vx_comp vy_comp',
    'SIZE 4 4 4 4 4 4 4',
    'TYPE F F F F F F F',
    'COUNT 1 1 1 1 1 1 1',
    'WIDTH 1',
    'HEIGHT 1',
    'POINTS 1',
    'DATA binary',
    '',
  ].join('\n')
  const encoded = new TextEncoder().encode(header)
  const buffer = new ArrayBuffer(encoded.length + 28)
  new Uint8Array(buffer).set(encoded)
  const view = new DataView(buffer, encoded.length)
  ;[1, 2, 3, 4, 5, 6, 7].forEach((value, index) => view.setFloat32(index * 4, value, true))
  return new File([buffer], 'radar.pcd')
}

async function fixture() {
  const tables: Record<string, unknown[]> = {
    'scene.json': [{ token: 'scene', log_token: 'log', nbr_samples: 1, first_sample_token: 'sample', last_sample_token: 'sample', name: 'scene-0001', description: 'clear' }],
    'sample.json': [{ token: 'sample', timestamp: 1_000_000, prev: '', next: '', scene_token: 'scene' }],
    'sensor.json': [
      { token: 'lidar-sensor', channel: 'LIDAR_TOP', modality: 'lidar' },
      { token: 'radar-sensor', channel: 'RADAR_FRONT', modality: 'radar' },
      { token: 'camera-sensor', channel: 'CAM_FRONT', modality: 'camera' },
      { token: 'camera-left-sensor', channel: 'CAM_FRONT_LEFT', modality: 'camera' },
    ],
    'calibrated_sensor.json': [
      { token: 'lidar-cal', sensor_token: 'lidar-sensor', translation: [10, 20, 30], rotation: [1, 0, 0, 0], camera_intrinsic: [] },
      { token: 'radar-cal', sensor_token: 'radar-sensor', translation: [0, 0, 0], rotation: [1, 0, 0, 0], camera_intrinsic: [] },
      { token: 'camera-cal', sensor_token: 'camera-sensor', translation: [0, 0, 1], rotation: [0.5, -0.5, 0.5, -0.5], camera_intrinsic: [[100, 0, 800], [0, 100, 450], [0, 0, 1]] },
      { token: 'camera-left-cal', sensor_token: 'camera-left-sensor', translation: [0, 0, 1], rotation: [0.5, -0.5, 0.5, -0.5], camera_intrinsic: [[100, 0, 800], [0, 100, 450], [0, 0, 1]] },
    ],
    'ego_pose.json': [{ token: 'pose', timestamp: 1_000_000, translation: [0, 0, 0], rotation: [1, 0, 0, 0] }],
    'sample_data.json': [
      { token: 'lidar-data', sample_token: 'sample', ego_pose_token: 'pose', calibrated_sensor_token: 'lidar-cal', timestamp: 1_000_000, fileformat: 'pcd.bin', is_key_frame: true, height: 0, width: 0, filename: 'samples/LIDAR_TOP/one.pcd.bin', prev: '', next: '' },
      { token: 'radar-data', sample_token: 'sample', ego_pose_token: 'pose', calibrated_sensor_token: 'radar-cal', timestamp: 1_000_000, fileformat: 'pcd', is_key_frame: true, height: 0, width: 0, filename: 'samples/RADAR_FRONT/one.pcd', prev: '', next: '' },
      { token: 'camera-data', sample_token: 'sample', ego_pose_token: 'pose', calibrated_sensor_token: 'camera-cal', timestamp: 1_000_000, fileformat: 'jpg', is_key_frame: true, height: 900, width: 1600, filename: 'samples/CAM_FRONT/one.jpg', prev: '', next: '' },
    ],
    'category.json': [{ token: 'category', name: 'vehicle.car', description: 'car', index: 17 }],
    'instance.json': [{ token: 'instance', category_token: 'category', nbr_annotations: 1, first_annotation_token: 'annotation', last_annotation_token: 'annotation' }],
    'sample_annotation.json': [{ token: 'annotation', sample_token: 'sample', instance_token: 'instance', visibility_token: '4', attribute_tokens: [], translation: [10, 0, 1], size: [2, 4, 2], rotation: [1, 0, 0, 0], prev: '', next: '', num_lidar_pts: 2, num_radar_pts: 1 }],
    'log.json': [{ token: 'log', logfile: 'n015-2018-07-24-11-22-45+0800', vehicle: 'car', date_captured: '2018-07-24', location: 'singapore-onenorth' }],
    'lidarseg.json': [{ token: 'seg', sample_data_token: 'lidar-data', filename: 'lidarseg/v1.0-mini/one.bin' }],
    'panoptic.json': [],
  }
  const db = await buildNuScenesDatabase(new Map(Object.entries(tables).map(([name, rows]) => [name, JSON.stringify(rows)])))
  const files = new Map<string, File | string>([
    ['samples/LIDAR_TOP/one.pcd.bin', lidarFile([[1, 2, 3, 0.5, 9], [-1, -2, -3, 0.75, 10]])],
    ['samples/RADAR_FRONT/one.pcd', radarFile()],
    ['samples/CAM_FRONT/one.jpg', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'one.jpg')],
    ['lidarseg/v1.0-mini/one.bin', new File([new Uint8Array([17, 24])], 'one.bin')],
  ])
  return { db, files }
}

describe('nuScenes recipe-backed NormalizedSceneV1', () => {
  it('binds capabilities from real outputs and preserves string sensor identity', async () => {
    const { db, files } = await fixture()
    const { scene, diagnostics } = bindNuScenesRecipeSceneV1({ compiledRecipe: nuScenesCompiledRecipe, database: db, sceneToken: 'scene', files })
    expect(diagnostics).toEqual([])
    expect(scene.manifest.capabilities).toEqual(nuScenesCompiledRecipe.capabilities)
    expect(scene.relations.staticTransforms.map((relation) => relation.childFrameId)).toContain('LIDAR_TOP-frame')
    expect(scene.relations.cameraCalibrations.has('CAM_FRONT_LEFT')).toBe(true)
    expect(scene.relations.cameraCalibrations.has('LIDAR_TOP')).toBe(false)
  })

  it('matches legacy metadata structurally and numerically in a headless frame', async () => {
    const { db, files } = await fixture()
    const legacy = loadNuScenesSceneMetadata(db, 'scene')
    const { scene } = bindNuScenesRecipeSceneV1({ compiledRecipe: nuScenesCompiledRecipe, database: db, sceneToken: 'scene', files })
    const actual = await scene.loadFrame(0, { capabilities: scene.manifest.capabilities })
    const legacyBox = legacy.lidarBoxByFrame.get(legacy.timestamps[0])![0]
    const expected: NormalizedFrameV1 = {
      ...actual,
      timestampMicros: legacy.timestamps[0],
      worldFromEgo: new Float64Array(legacy.poseByFrameIndex.get(0)!),
      pointClouds: [{
        ...actual.pointClouds[0],
        values: new Float32Array([11, 22, 33, 0.5, 9, 18, 27, 0.75]),
        pointCount: 2,
        stride: 4,
        attributes: ['x', 'y', 'z', 'intensity'],
      }],
      radarPointClouds: [{
        ...actual.radarPointClouds[0],
        values: new Float32Array([1, 2, 3, 4, 5, 6, 7]),
      }],
      boxes3d: [{
        ...actual.boxes3d[0],
        center: [
          legacyBox['[LiDARBoxComponent].box.center.x'] as number,
          legacyBox['[LiDARBoxComponent].box.center.y'] as number,
          legacyBox['[LiDARBoxComponent].box.center.z'] as number,
        ],
        dimensions: [4, 2, 2],
      }],
    }
    expect(compareNormalizedFramesV1(expected, actual)).toEqual([])
    expect(actual.cameraImages.map((image) => image.sensorId)).toEqual(['CAM_FRONT'])
    expect(actual.boxes2d.length).toBeGreaterThan(0)
    expect(actual.lidarSegmentation[0].sensorId).toBe('LIDAR_TOP')
    expect([...actual.pointClouds[0].semanticLabels!]).toEqual([17, 24])
  })

  it('removes optional capabilities when their files cannot bind', async () => {
    const { db, files } = await fixture()
    files.delete('samples/RADAR_FRONT/one.pcd')
    const { scene, diagnostics } = bindNuScenesRecipeSceneV1({ compiledRecipe: nuScenesCompiledRecipe, database: db, sceneToken: 'scene', files })
    expect(scene.manifest.capabilities.has('radarPointClouds')).toBe(false)
    expect(diagnostics).toContainEqual(expect.objectContaining({
      stage: 'bind',
      code: 'OPTIONAL_OUTPUT_UNBOUND',
      jsonPointer: '/outputs/radarPointClouds',
    }))
  })
})
