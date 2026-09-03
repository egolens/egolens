import { describe, expect, it } from 'vitest'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'
import type { GraphCameraPlanV1 } from '../runtime/GraphValues'

const ops = coreGraphOperatorImplementationsV1
const ctx = {} as never
const records = (rows: readonly Record<string, unknown>[]) => ({ kind: 'records', rows })
const round = (values: ArrayLike<number>) => [...values].map((value) => { const r = Math.round(value * 1000) / 1000; return r === 0 ? 0 : r })

describe('KITTI calibration reshaping', () => {
  it('unpivots a wide key-value calibration row into one row per camera', async () => {
    const wide = { calib_time: 'x', P_rect_00: [1], P_rect_02: [2], R_rect_00: [3], S_rect_02: [4], R: [9], T: [8] }
    const result = await ops['records.unpivot']!({ rows: records([wide]) }, { pattern: '^([A-Za-z_]+?)_(0\\d)$', keyField: 'camera' }, ctx)
    expect((result.rows as { rows: unknown[] }).rows).toEqual([
      { calib_time: 'x', R: [9], T: [8], camera: '00', P_rect: [1], R_rect: [3] },
      { calib_time: 'x', R: [9], T: [8], camera: '02', P_rect: [2], S_rect: [4] },
    ])
  })

  it('shifts a camera by the baseline encoded in a 3x4 projection matrix', async () => {
    const bind = ops['image.bind_camera_frame']!
    const fx = 700, baselineMeters = 0.54
    const plan = (await bind({
      bytes: { kind: 'encoded-collection', files: [{ path: 'image_02/data/0000000000.png', size: 1 }], cache: new Map(), retainedReleases: new Map() },
      sampleData: records([{ path: 'image_02/data/0000000000.png', frame: '0', ts: 1, calib: '02' }]),
      calibration: records([{ camera: '02', P_rect: [fx, 0, 600, -fx * baselineMeters, 0, fx, 180, 0, 0, 0, 1, 0], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], T: [0, 0, 0] }]),
      sensors: records([{ camera: '02', modality: 'camera' }]),
    }, {
      pathField: 'path', frameKeyField: 'frame', timestampField: 'ts', recordCalibrationKeyField: 'calib', calibrationKeyField: 'camera',
      calibrationSensorKeyField: 'camera', sensorKeyField: 'camera', sensorIdField: 'camera', modalityField: 'modality', cameraModality: 'camera',
      widthField: 'w', heightField: 'h', intrinsicMatrixField: 'P_rect', quaternionField: 'unused', translationField: 'T', rotationForm: 'matrix', rotationMatrixField: 'R',
      frameIdSuffix: '-frame', defaultWidth: 1242, defaultHeight: 375,
    }, ctx)).images as GraphCameraPlanV1
    const calibration = plan.calibrations.get('02')!
    expect(calibration.intrinsics).toEqual([fx, fx, 600, 180])
    // identity rotation: the camera sits +0.54 m along its x axis (to the right of camera 00)
    const t = round(calibration.egoFromCamera)
    expect([t[3], t[7], t[11]]).toEqual([baselineMeters, 0, 0])
  })
})
