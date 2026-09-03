import { describe, expect, it } from 'vitest'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'
import type { GraphPoseTimelineV1 } from '../runtime/GraphValues'

const ops = coreGraphOperatorImplementationsV1
const ctx = {} as never
const records = (rows: readonly Record<string, unknown>[]) => ({ kind: 'records', rows })
const round = (values: ArrayLike<number>) => [...values].map((value) => { const r = Math.round(value * 1000) / 1000; return r === 0 ? 0 : r })

describe('generic gaps surfaced by the KITTI Raw rung', () => {
  it('reads calendar timestamps as microseconds since the epoch', async () => {
    const result = (await ops['geometry.geodetic_poses']!({ rows: records([
      { ts: '2011-09-26 13:02:25.964238', lat: 49, lon: 8.4, yaw: 0 },
      { ts: '2011-09-26T13:02:26.067Z', lat: 49, lon: 8.4, yaw: 0 },
      { ts: '2011-09-26 15:02:27+02:00', lat: 49, lon: 8.4, yaw: 0 },
    ]) }, { timestampField: 'ts', latitudeField: 'lat', longitudeField: 'lon', yawField: 'yaw' }, ctx)).poses as GraphPoseTimelineV1
    const stamps = [...result.worldFromEgoByTimestamp.keys()]
    expect(stamps[0]).toBe(BigInt(Date.UTC(2011, 8, 26, 13, 2, 25)) * 1000n + 964238n)
    expect(stamps[1]! - stamps[0]!).toBe(102762n)
    expect(stamps[2]! - stamps[1]!).toBe(933000n)
  })

  it('explodes nested tracklet poses into one row per frame', async () => {
    const tracklet = { objectType: 'Car', h: 1.5, first_frame: 4, poses: { count: 2, item: [{ tx: 1, ty: 2 }, { tx: 1.5, ty: 2 }] } }
    const result = await ops['records.explode']!({ rows: records([tracklet]) }, { path: 'poses.item', indexField: 'poseIndex' }, ctx)
    expect((result.rows as { rows: unknown[] }).rows).toEqual([
      { objectType: 'Car', h: 1.5, first_frame: 4, tx: 1, ty: 2, poseIndex: 0 },
      { objectType: 'Car', h: 1.5, first_frame: 4, tx: 1.5, ty: 2, poseIndex: 1 },
    ])
    const offset = await ops['records.explode']!({ rows: records([tracklet]) }, { path: 'poses.item', indexField: 'frame', indexOffsetField: 'first_frame' }, ctx)
    expect((offset.rows as { rows: { frame: number }[] }).rows.map((row) => row.frame)).toEqual([4, 5])
    await expect(ops['records.explode']!({ rows: records([{ ...tracklet, first_frame: 'n/a' }]) }, { path: 'poses.item', indexField: 'frame', indexOffsetField: 'first_frame' }, ctx))
      .rejects.toThrow(/GRAPH_EXPLODE_OFFSET_INVALID/u)
    const single = await ops['records.explode']!({ rows: records([{ id: 'x', poses: { item: { tx: 9 } } }]) }, { path: 'poses.item', prefix: 'pose_' }, ctx)
    expect((single.rows as { rows: unknown[] }).rows).toEqual([{ id: 'x', pose_tx: 9 }])
  })

  it('accepts a row-major rotation matrix (with or without its own translation) as the sensor pose', async () => {
    const join = ops['timeline.join']!
    const base = {
      records: { kind: 'binary-collection', files: [{ path: 'velodyne_points/data/0000000000.bin', size: 1 }], cache: new Map(), retainedReleases: new Map() },
      sampleData: records([{ path: 'velodyne_points/data/0000000000.bin', frame: '0', ts: 1, sensor: 'velodyne' }]),
      sensors: records([{ name: 'velodyne' }]),
    }
    const params = { mode: 'token', pathField: 'path', frameKeyField: 'frame', recordKeyField: 'frame', timestampField: 'ts', recordCalibrationKeyField: 'sensor', calibrationKeyField: 'name', calibrationSensorKeyField: 'name', sensorKeyField: 'name', sensorIdField: 'name', quaternionField: 'unused', translationField: 'T', rotationForm: 'matrix', rotationMatrixField: 'R', outputFrame: 'ego' }
    // 90° about z with translation from T
    const nine = (await join({ ...base, calibration: records([{ name: 'velodyne', R: [0, -1, 0, 1, 0, 0, 0, 0, 1], T: [1, 2, 3] }]) }, params, ctx)).pointClouds as { bindings: { egoFromSensor: Float64Array }[] }
    expect(round(nine.bindings[0]!.egoFromSensor)).toEqual([0, -1, 0, 1, 1, 0, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1])
    // 3×4 carries its own translation; no translationField needed
    const twelve = (await join({ ...base, calibration: records([{ name: 'velodyne', Tr: [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7] }]) }, { ...params, translationField: undefined, rotationMatrixField: 'Tr' }, ctx)).pointClouds as { bindings: { egoFromSensor: Float64Array }[] }
    expect(round(twelve.bindings[0]!.egoFromSensor)).toEqual([1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1])
    // identity: the sensor frame is the ego frame
    const identity = (await join({ ...base, calibration: records([{ name: 'velodyne' }]) }, { ...params, rotationForm: 'identity' }, ctx)).pointClouds
    expect(round(identity.bindings[0]!.egoFromSensor)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    // composed sensor ← ego chain (R_rect · [R|T]) inverted into ego ← sensor
    const composed = (await join({ ...base, calibration: records([{ name: 'velodyne', Rr: [1, 0, 0, 0, 1, 0, 0, 0, 1], R: [0, -1, 0, 1, 0, 0, 0, 0, 1], T: [1, 2, 3] }]) }, {
      ...params, translationField: undefined, rotationMatrixFields: [{ matrixField: 'Rr' }, { matrixField: 'R', translationField: 'T' }], invertPose: true,
    }, ctx)).pointClouds
    expect(round(composed.bindings[0]!.egoFromSensor)).toEqual([0, 1, 0, -2, -1, 0, 0, 1, 0, 0, 1, -3, 0, 0, 0, 1])
  })

  it('normalizes 3D boxes from plain records', async () => {
    const result = await ops['geometry.normalize_boxes3d']!({ rows: records([
      { ts: 10, cls: 'Car', id: 'a', qw: 1, qx: 0, qy: 0, qz: 0, x: 1, y: 2, z: 0, l: 4, w: 2, h: 1.5 },
    ]) }, { quaternionOrder: 'wxyz', frameId: 'ego', timestampField: 'ts', classField: 'cls', objectIdField: 'id', quaternionFields: ['qw', 'qx', 'qy', 'qz'], centerFields: ['x', 'y', 'z'], dimensionFields: ['l', 'w', 'h'] }, ctx)
    expect(JSON.stringify(result.boxes).length).toBeGreaterThan(20)
  })

  it('derives numeric fields (float seconds → integer microseconds) and reads dotted paths', async () => {
    const derive = ops['records.derive']!
    const out = await derive({ rows: records([{ t: 1557539924.49981, heading: { w: 0.5 } }]) }, {
      derive: [{ field: 'ts_us', from: 't', scale: 1e6, integer: true }, { field: 'qw', from: 'heading.w', pattern: '^(.*)$', replacement: '$1' }],
    }, ctx) as { rows: { rows: { ts_us: number; qw: string }[] } }
    expect(out.rows.rows[0]).toMatchObject({ ts_us: 1557539924499810, qw: '0.5' })
    await expect(derive({ rows: records([{ t: 'n/a' }]) }, { derive: [{ field: 'x', from: 't', scale: 2 }] }, ctx)).rejects.toThrow(/GRAPH_DERIVE_NUMERIC_INVALID/u)
  })

  it('composes a pose chain from scalar quaternion fields (PandaSet ego ← camera = inverse(world ← lidar) · world ← camera)', async () => {
    const join = ops['timeline.join']!
    const base = {
      records: { kind: 'binary-collection', files: [{ path: 'lidar/00.pkl', size: 1 }], cache: new Map(), retainedReleases: new Map() },
      sampleData: records([{ path: 'lidar/00.pkl', frame: '0', ts: 1, sensor: 'cam' }]),
      sensors: records([{ name: 'cam' }]),
    }
    const params = { mode: 'token', pathField: 'path', frameKeyField: 'frame', recordKeyField: 'frame', timestampField: 'ts', recordCalibrationKeyField: 'sensor', calibrationKeyField: 'name', calibrationSensorKeyField: 'name', sensorKeyField: 'name', sensorIdField: 'name', outputFrame: 'ego' }
    // lidar at world (1,2,3) rotated 90° about z; camera at world (1,2,4) with the same rotation → ego ← camera = translate (0,0,1)
    const row = { name: 'cam', 'lidar.w': Math.SQRT1_2, 'lidar.x': 0, 'lidar.y': 0, 'lidar.z': Math.SQRT1_2, 'lidar.tx': 1, 'lidar.ty': 2, 'lidar.tz': 3, 'cam.w': Math.SQRT1_2, 'cam.x': 0, 'cam.y': 0, 'cam.z': Math.SQRT1_2, 'cam.tx': 1, 'cam.ty': 2, 'cam.tz': 4 }
    const plan = (await join({ ...base, calibration: records([row]) }, { ...params, poseChain: [
      { quaternionFields: ['lidar.w', 'lidar.x', 'lidar.y', 'lidar.z'], translationFields: ['lidar.tx', 'lidar.ty', 'lidar.tz'], invert: true },
      { quaternionFields: ['cam.w', 'cam.x', 'cam.y', 'cam.z'], translationFields: ['cam.tx', 'cam.ty', 'cam.tz'] },
    ] }, ctx)).pointClouds as { bindings: { egoFromSensor: Float64Array }[] }
    expect(round(plan.bindings[0]!.egoFromSensor)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1])
    // scalar quaternion + translation fields without a chain
    const scalar = (await join({ ...base, calibration: records([row]) }, { ...params, quaternionFields: ['cam.w', 'cam.x', 'cam.y', 'cam.z'], translationFields: ['cam.tx', 'cam.ty', 'cam.tz'] }, ctx)).pointClouds as { bindings: { egoFromSensor: Float64Array }[] }
    expect(round(scalar.bindings[0]!.egoFromSensor).slice(0, 4)).toEqual([0, -1, 0, 1])
  })

  it('builds relative ego poses from quaternion rows', async () => {
    const poses = await ops['geometry.relative_poses']!({ rows: records([
      { ts: 1, q: [1, 0, 0, 0], t: [10, 20, 0] },
      { ts: 2, q: [1, 0, 0, 0], t: [11, 20, 0] },
    ]) }, { timestampField: 'ts', quaternionField: 'q', translationField: 't' }, ctx) as { poses: { worldFromEgoByTimestamp: Map<bigint, Float64Array> } }
    expect(round(poses.poses.worldFromEgoByTimestamp.get(2n)!)).toEqual([1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  })

  it('accepts camera intrinsics as four scalar fields', async () => {
    const bind = ops['image.bind_camera_frame']!
    const plan = (await bind({
      bytes: { kind: 'encoded-collection', files: [{ path: 'camera/front_camera/00.jpg', size: 1 }], cache: new Map(), retainedReleases: new Map() },
      sampleData: records([{ path: 'camera/front_camera/00.jpg', frame: '0', ts: 1, cam: 'front_camera' }]),
      calibration: records([{ cam: 'front_camera', fx: 1970, fy: 1970, cx: 970, cy: 483, q: [1, 0, 0, 0], t: [0, 0, 0] }]),
      sensors: records([{ cam: 'front_camera', modality: 'camera' }]),
    }, {
      pathField: 'path', frameKeyField: 'frame', timestampField: 'ts', recordCalibrationKeyField: 'cam', calibrationKeyField: 'cam',
      calibrationSensorKeyField: 'cam', sensorKeyField: 'cam', sensorIdField: 'cam', modalityField: 'modality', cameraModality: 'camera',
      widthField: 'w', heightField: 'h', intrinsicFields: ['fx', 'fy', 'cx', 'cy'], quaternionField: 'q', translationField: 't',
      frameIdSuffix: '_frame', defaultWidth: 1920, defaultHeight: 1080,
    }, ctx)).images as { calibrations: Map<string, { intrinsics: number[] }> }
    expect(plan.calibrations.get('front_camera')!.intrinsics).toEqual([1970, 1970, 970, 483])
  })
})
