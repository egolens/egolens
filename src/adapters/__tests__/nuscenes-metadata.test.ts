/**
 * Tests for quaternion utility and nuScenes metadata loader.
 *
 * Quaternion tests: mathematical correctness of quat→matrix conversion.
 * Metadata tests: database building and scene metadata extraction using
 * minimal synthetic nuScenes JSON data.
 */

import { describe, it, expect } from 'vitest'
import { quaternionToMatrix4x4 } from '../../utils/quaternion'
import {
  buildNuScenesDatabase,
  loadNuScenesSceneMetadata,
  readJsonFile,
} from '../nuscenes/metadata'

// ---------------------------------------------------------------------------
// quaternionToMatrix4x4
// ---------------------------------------------------------------------------

describe('quaternionToMatrix4x4', () => {
  it('identity quaternion [1,0,0,0] → identity matrix', () => {
    const m = quaternionToMatrix4x4([1, 0, 0, 0], [0, 0, 0])
    // prettier-ignore
    const expected = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(expected[i], 10)
    }
  })

  it('identity rotation with translation', () => {
    const m = quaternionToMatrix4x4([1, 0, 0, 0], [10, 20, 30])
    expect(m[3]).toBeCloseTo(10)
    expect(m[7]).toBeCloseTo(20)
    expect(m[11]).toBeCloseTo(30)
    // Rotation part should be identity
    expect(m[0]).toBeCloseTo(1)
    expect(m[5]).toBeCloseTo(1)
    expect(m[10]).toBeCloseTo(1)
  })

  it('90° rotation around Z axis', () => {
    // quat for 90° around Z: [cos(45°), 0, 0, sin(45°)]
    const c = Math.cos(Math.PI / 4)
    const s = Math.sin(Math.PI / 4)
    const m = quaternionToMatrix4x4([c, 0, 0, s], [0, 0, 0])

    // Expected: x→y, y→-x, z→z
    expect(m[0]).toBeCloseTo(0)   // R[0][0]
    expect(m[1]).toBeCloseTo(-1)  // R[0][1]
    expect(m[4]).toBeCloseTo(1)   // R[1][0]
    expect(m[5]).toBeCloseTo(0)   // R[1][1]
    expect(m[10]).toBeCloseTo(1)  // R[2][2]
  })

  it('180° rotation around X axis', () => {
    // quat: [cos(90°), sin(90°), 0, 0] = [0, 1, 0, 0]
    const m = quaternionToMatrix4x4([0, 1, 0, 0], [0, 0, 0])

    expect(m[0]).toBeCloseTo(1)    // x unchanged
    expect(m[5]).toBeCloseTo(-1)   // y flipped
    expect(m[10]).toBeCloseTo(-1)  // z flipped
  })

  it('produces orthogonal rotation matrix (R^T R = I)', () => {
    const m = quaternionToMatrix4x4([0.5, 0.5, 0.5, 0.5], [1, 2, 3])
    // Extract 3x3 rotation
    const R = [
      [m[0], m[1], m[2]],
      [m[4], m[5], m[6]],
      [m[8], m[9], m[10]],
    ]
    // R^T × R should be identity
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let dot = 0
        for (let k = 0; k < 3; k++) {
          dot += R[k][i] * R[k][j]
        }
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 10)
      }
    }
  })

  it('bottom row is [0, 0, 0, 1]', () => {
    const m = quaternionToMatrix4x4([0.7071, 0, 0.7071, 0], [5, 6, 7])
    expect(m[12]).toBe(0)
    expect(m[13]).toBe(0)
    expect(m[14]).toBe(0)
    expect(m[15]).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Synthetic nuScenes data factory
// ---------------------------------------------------------------------------

function createSyntheticNuScenesFiles(): Map<string, File> {
  const files = new Map<string, File>()

  const sensor = [
    { token: 'sensor_lidar', channel: 'LIDAR_TOP', modality: 'lidar' },
    { token: 'sensor_cam_front', channel: 'CAM_FRONT', modality: 'camera' },
  ]

  const calibratedSensor = [
    {
      token: 'cal_lidar',
      sensor_token: 'sensor_lidar',
      translation: [0, 0, 1.8],
      rotation: [1, 0, 0, 0],
      camera_intrinsic: [],
    },
    {
      token: 'cal_cam_front',
      sensor_token: 'sensor_cam_front',
      translation: [1.5, 0, 1.5],
      rotation: [0.5, -0.5, 0.5, -0.5],
      camera_intrinsic: [[1266, 0, 816], [0, 1266, 491], [0, 0, 1]],
    },
  ]

  const category = [
    { token: 'cat_car', name: 'vehicle.car', description: 'Car', index: 0 },
    { token: 'cat_ped', name: 'human.pedestrian.adult', description: 'Adult pedestrian', index: 1 },
  ]

  const instance = [
    { token: 'inst_car1', category_token: 'cat_car', nbr_annotations: 2, first_annotation_token: 'ann1', last_annotation_token: 'ann3' },
    { token: 'inst_ped1', category_token: 'cat_ped', nbr_annotations: 2, first_annotation_token: 'ann2', last_annotation_token: 'ann4' },
  ]

  const scene = [
    {
      token: 'scene_1',
      log_token: 'log_1',
      nbr_samples: 2,
      first_sample_token: 'sample_1',
      last_sample_token: 'sample_2',
      name: 'scene-0001',
      description: 'Test scene',
    },
  ]

  const sample = [
    { token: 'sample_1', timestamp: 1000000, prev: '', next: 'sample_2', scene_token: 'scene_1' },
    { token: 'sample_2', timestamp: 1500000, prev: 'sample_1', next: '', scene_token: 'scene_1' },
  ]

  const egoPose = [
    { token: 'ego_1_lidar', timestamp: 1000000, rotation: [1, 0, 0, 0] as [number, number, number, number], translation: [0, 0, 0] as [number, number, number] },
    { token: 'ego_1_cam', timestamp: 1000050, rotation: [1, 0, 0, 0] as [number, number, number, number], translation: [0.1, 0, 0] as [number, number, number] },
    { token: 'ego_2_lidar', timestamp: 1500000, rotation: [1, 0, 0, 0] as [number, number, number, number], translation: [5, 0, 0] as [number, number, number] },
    { token: 'ego_2_cam', timestamp: 1500050, rotation: [1, 0, 0, 0] as [number, number, number, number], translation: [5.1, 0, 0] as [number, number, number] },
  ]

  const sampleData = [
    // Frame 1 — keyframes
    { token: 'sd_1_lidar', sample_token: 'sample_1', ego_pose_token: 'ego_1_lidar', calibrated_sensor_token: 'cal_lidar', timestamp: 1000000, fileformat: 'pcd.bin', is_key_frame: true, height: 0, width: 0, filename: 'samples/LIDAR_TOP/frame1.pcd.bin', prev: '', next: 'sd_2_lidar' },
    { token: 'sd_1_cam', sample_token: 'sample_1', ego_pose_token: 'ego_1_cam', calibrated_sensor_token: 'cal_cam_front', timestamp: 1000050, fileformat: 'jpg', is_key_frame: true, height: 900, width: 1600, filename: 'samples/CAM_FRONT/frame1.jpg', prev: '', next: 'sd_2_cam' },
    // Frame 2 — keyframes
    { token: 'sd_2_lidar', sample_token: 'sample_2', ego_pose_token: 'ego_2_lidar', calibrated_sensor_token: 'cal_lidar', timestamp: 1500000, fileformat: 'pcd.bin', is_key_frame: true, height: 0, width: 0, filename: 'samples/LIDAR_TOP/frame2.pcd.bin', prev: 'sd_1_lidar', next: '' },
    { token: 'sd_2_cam', sample_token: 'sample_2', ego_pose_token: 'ego_2_cam', calibrated_sensor_token: 'cal_cam_front', timestamp: 1500050, fileformat: 'jpg', is_key_frame: true, height: 900, width: 1600, filename: 'samples/CAM_FRONT/frame2.jpg', prev: 'sd_1_cam', next: '' },
    // A sweep (non-keyframe) — should be filtered out
    { token: 'sd_sweep', sample_token: 'sample_1', ego_pose_token: 'ego_1_lidar', calibrated_sensor_token: 'cal_lidar', timestamp: 1250000, fileformat: 'pcd.bin', is_key_frame: false, height: 0, width: 0, filename: 'sweeps/LIDAR_TOP/sweep.pcd.bin', prev: '', next: '' },
  ]

  const sampleAnnotation = [
    { token: 'ann1', sample_token: 'sample_1', instance_token: 'inst_car1', visibility_token: '4', attribute_tokens: [], translation: [10, 5, 0] as [number, number, number], size: [2, 4.5, 1.5] as [number, number, number], rotation: [1, 0, 0, 0] as [number, number, number, number], prev: '', next: 'ann3', num_lidar_pts: 50, num_radar_pts: 0 },
    { token: 'ann2', sample_token: 'sample_1', instance_token: 'inst_ped1', visibility_token: '3', attribute_tokens: [], translation: [3, 2, 0] as [number, number, number], size: [0.6, 0.7, 1.7] as [number, number, number], rotation: [1, 0, 0, 0] as [number, number, number, number], prev: '', next: 'ann4', num_lidar_pts: 10, num_radar_pts: 0 },
    { token: 'ann3', sample_token: 'sample_2', instance_token: 'inst_car1', visibility_token: '4', attribute_tokens: [], translation: [12, 5, 0] as [number, number, number], size: [2, 4.5, 1.5] as [number, number, number], rotation: [1, 0, 0, 0] as [number, number, number, number], prev: 'ann1', next: '', num_lidar_pts: 45, num_radar_pts: 0 },
    { token: 'ann4', sample_token: 'sample_2', instance_token: 'inst_ped1', visibility_token: '2', attribute_tokens: [], translation: [4, 2, 0] as [number, number, number], size: [0.6, 0.7, 1.7] as [number, number, number], rotation: [1, 0, 0, 0] as [number, number, number, number], prev: 'ann2', next: '', num_lidar_pts: 8, num_radar_pts: 0 },
  ]

  const jsonData: Record<string, unknown[]> = {
    'sensor.json': sensor,
    'calibrated_sensor.json': calibratedSensor,
    'category.json': category,
    'instance.json': instance,
    'scene.json': scene,
    'sample.json': sample,
    'ego_pose.json': egoPose,
    'sample_data.json': sampleData,
    'sample_annotation.json': sampleAnnotation,
    'visibility.json': [],
    'attribute.json': [],
    'log.json': [],
    'map.json': [],
  }

  for (const [name, data] of Object.entries(jsonData)) {
    files.set(name, new File([JSON.stringify(data)], name, { type: 'application/json' }))
  }

  return files
}

// ---------------------------------------------------------------------------
// readJsonFile
// ---------------------------------------------------------------------------

describe('readJsonFile', () => {
  it('parses a JSON file from the map', async () => {
    const files = createSyntheticNuScenesFiles()
    const scenes = await readJsonFile<{ token: string }>(files, 'scene.json')
    expect(scenes).toHaveLength(1)
    expect(scenes[0].token).toBe('scene_1')
  })

  it('returns empty array for missing file', async () => {
    const result = await readJsonFile(new Map(), 'nonexistent.json')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildNuScenesDatabase
// ---------------------------------------------------------------------------

describe('buildNuScenesDatabase', () => {
  it('builds indexed database from JSON files', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)

    expect(db.scenes).toHaveLength(1)
    expect(db.sampleByToken.size).toBe(2)
    expect(db.sampleDataByToken.size).toBe(5)
    expect(db.egoPoseByToken.size).toBe(4)
    expect(db.annotationByToken.size).toBe(4)
    expect(db.calibratedSensorByToken.size).toBe(2)
    expect(db.sensorByToken.size).toBe(2)
    expect(db.instanceByToken.size).toBe(2)
    expect(db.categoryByToken.size).toBe(2)
  })

  it('indexes annotations by sample', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)

    expect(db.annotationsBySample.get('sample_1')).toHaveLength(2)
    expect(db.annotationsBySample.get('sample_2')).toHaveLength(2)
  })

  it('indexes keyframe sample_data by sample (filters out sweeps)', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)

    // 2 keyframes per sample (lidar + camera), sweep excluded
    const sd1 = db.sampleDataBySample.get('sample_1')
    expect(sd1).toHaveLength(2)
    expect(sd1!.every((sd) => sd.is_key_frame)).toBe(true)
  })

  it('resolves instance → category name', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)

    expect(db.instanceCategoryName.get('inst_car1')).toBe('vehicle.car')
    expect(db.instanceCategoryName.get('inst_ped1')).toBe('human.pedestrian.adult')
  })
})

// ---------------------------------------------------------------------------
// loadNuScenesSceneMetadata
// ---------------------------------------------------------------------------

describe('loadNuScenesSceneMetadata', () => {
  it('produces correct number of frames', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.timestamps).toHaveLength(2)
    expect(bundle.timestampToFrame.size).toBe(2)
  })

  it('timestamps are bigint microseconds', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.timestamps[0]).toBe(BigInt(1000000))
    expect(bundle.timestamps[1]).toBe(BigInt(1500000))
  })

  it('builds relative poses (frame 0 is identity)', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.poseByFrameIndex.size).toBe(2)
    expect(bundle.worldOriginInverse).not.toBeNull()

    // Frame 0 pose should be identity (inv(pose0) × pose0)
    const pose0 = bundle.poseByFrameIndex.get(0)!
    expect(pose0[0]).toBeCloseTo(1)
    expect(pose0[3]).toBeCloseTo(0)  // tx = 0 (relative to self)
    expect(pose0[5]).toBeCloseTo(1)

    // Frame 1 ego moved 5m in x → relative translation = [5, 0, 0]
    const pose1 = bundle.poseByFrameIndex.get(1)!
    expect(pose1[3]).toBeCloseTo(5)  // tx
  })

  it('extracts lidar calibration', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.lidarCalibrations.size).toBe(1)
    const cal = bundle.lidarCalibrations.get(1) // LIDAR_TOP → id 1
    expect(cal).toBeDefined()
    expect(cal!.extrinsic).toHaveLength(16)
  })

  it('extracts camera calibration', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.cameraCalibrations).toHaveLength(1) // Only CAM_FRONT in test data
    expect(bundle.cameraCalibrations[0]['key.camera_name']).toBe(2) // CAM_FRONT → id 2
  })

  it('extracts 3D boxes with correct types', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.hasBoxData).toBe(true)
    expect(bundle.lidarBoxByFrame.size).toBe(2)

    // Frame 1 should have 2 boxes (1 car + 1 pedestrian)
    const ts1 = bundle.timestamps[0]
    const boxes1 = bundle.lidarBoxByFrame.get(ts1) as Record<string, unknown>[]
    expect(boxes1).toHaveLength(2)

    // Check car box type
    const carBox = boxes1.find((b) => b['[LiDARBoxComponent].type'] === 1)
    expect(carBox).toBeDefined()

    // Check pedestrian box type
    const pedBox = boxes1.find((b) => b['[LiDARBoxComponent].type'] === 2)
    expect(pedBox).toBeDefined()
  })

  it('builds object trajectories', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.objectTrajectories.size).toBe(2) // car + pedestrian

    // Car trajectory should have 2 points
    const carTrail = bundle.objectTrajectories.get('inst_car1')!
    expect(carTrail).toHaveLength(2)
    expect(carTrail[0].frameIndex).toBe(0)
    expect(carTrail[1].frameIndex).toBe(1)
    expect(carTrail[0].type).toBe(1) // vehicle
  })

  it('stores sensor file paths per frame', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    // vehiclePoseByFrame is repurposed to store sensor file info
    const ts1 = bundle.timestamps[0]
    const sensorFiles = bundle.vehiclePoseByFrame.get(ts1) as Record<string, unknown>[]
    expect(sensorFiles).toBeDefined()
    expect(sensorFiles.length).toBe(2) // lidar + camera
  })

  it('builds segment metadata', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.segmentMeta).not.toBeNull()
    expect(bundle.segmentMeta!.segmentId).toBe('scene-0001')
  })

  it('nuScenes has no camera boxes or cam↔lidar association', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    const bundle = loadNuScenesSceneMetadata(db, 'scene_1')

    expect(bundle.cameraBoxByFrame.size).toBe(0)
    expect(bundle.assocCamToLaser.size).toBe(0)
    expect(bundle.assocLaserToCams.size).toBe(0)
  })

  it('throws for unknown scene token', async () => {
    const files = createSyntheticNuScenesFiles()
    const db = await buildNuScenesDatabase(files)
    expect(() => loadNuScenesSceneMetadata(db, 'nonexistent')).toThrow('Scene not found')
  })
})
