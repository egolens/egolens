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
    expect(round(nine.bindings[0]!.egoFromSensor)).toEqual([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1])
    // 3×4 carries its own translation; no translationField needed
    const twelve = (await join({ ...base, calibration: records([{ name: 'velodyne', Tr: [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7] }]) }, { ...params, translationField: undefined, rotationMatrixField: 'Tr' }, ctx)).pointClouds as { bindings: { egoFromSensor: Float64Array }[] }
    expect(round(twelve.bindings[0]!.egoFromSensor)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1])
  })

  it('normalizes 3D boxes from plain records', async () => {
    const result = await ops['geometry.normalize_boxes3d']!({ rows: records([
      { ts: 10, cls: 'Car', id: 'a', qw: 1, qx: 0, qy: 0, qz: 0, x: 1, y: 2, z: 0, l: 4, w: 2, h: 1.5 },
    ]) }, { quaternionOrder: 'wxyz', frameId: 'ego', timestampField: 'ts', classField: 'cls', objectIdField: 'id', quaternionFields: ['qw', 'qx', 'qy', 'qz'], centerFields: ['x', 'y', 'z'], dimensionFields: ['l', 'w', 'h'] }, ctx)
    expect(JSON.stringify(result.boxes).length).toBeGreaterThan(20)
  })
})
