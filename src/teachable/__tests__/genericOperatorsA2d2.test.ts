import { describe, expect, it } from 'vitest'
import { decodeNpzRecordsV1 } from '../operators/binaryReaders'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'

function npy(descr: string, shape: readonly number[], write: (view: DataView) => void, byteLength: number): Uint8Array {
  const header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`
  const pad = 64 - ((10 + header.length) % 64)
  const encodedHeader = new TextEncoder().encode(`${header}${' '.repeat(pad - 1)}\n`)
  const bytes = new Uint8Array(10 + encodedHeader.length + byteLength)
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, encodedHeader.length & 0xff, encodedHeader.length >> 8])
  bytes.set(encodedHeader, 10)
  write(new DataView(bytes.buffer, 10 + encodedHeader.length))
  return bytes
}

function storedZip(entries: readonly (readonly [string, Uint8Array])[]): ArrayBuffer {
  const parts = entries.map(([name, content]) => {
    const encodedName = new TextEncoder().encode(name)
    const local = new Uint8Array(30 + encodedName.length + content.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, 0, true)
    view.setUint32(18, content.length, true); view.setUint32(22, content.length, true); view.setUint16(26, encodedName.length, true)
    local.set(encodedName, 30); local.set(content, 30 + encodedName.length)
    return local
  })
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total); let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out.buffer
}

const context = (files: Record<string, string>) => ({
  read: async (path: string) => new TextEncoder().encode(files[path]!),
} as never)

describe('generic operators surfaced by the A2D2 rung', () => {
  it('decodes several numeric NPZ arrays into interleaved point records', async () => {
    const points = npy('<f8', [2, 3], (view) => [1.5, 2.5, 3.5, -1, -2, -3].forEach((value, index) => view.setFloat64(index * 8, value, true)), 48)
    const reflectance = npy('<i8', [2], (view) => { view.setBigInt64(0, 7n, true); view.setBigInt64(8, 9n, true) }, 16)
    const decoded = await decodeNpzRecordsV1(storedZip([['points.npy', points], ['reflectance.npy', reflectance]]), {
      arrays: [{ name: 'points', fields: ['x', 'y', 'z'] }, { name: 'reflectance', fields: ['reflectance'] }],
    })
    expect(decoded.attributes).toEqual(['x', 'y', 'z', 'reflectance'])
    expect(decoded.pointCount).toBe(2)
    expect([...decoded.values]).toEqual([1.5, 2.5, 3.5, 7, -1, -2, -3, 9])
    await expect(decodeNpzRecordsV1(storedZip([['points.npy', points]]), { arrays: [{ name: 'points', fields: ['x'] }] })).rejects.toThrow(/3 columns; 1 field name/u)
    await expect(decodeNpzRecordsV1(storedZip([['points.npy', points]]), { arrays: [{ name: 'depth', fields: ['d'] }] })).rejects.toThrow(/not found: depth/u)
  })

  it('reads JSON objects as rows and stamps the source path', async () => {
    const jsonRecords = coreGraphOperatorImplementationsV1['json.records']!
    const files = {
      'cams_lidars.json': JSON.stringify({ lidars: { front_center: { origin: [1, 2, 3] } }, note: 'x' }),
      'camera/cam_front_center/a.json': JSON.stringify({ cam_tstamp: 10, cam_name: 'front_center' }),
      'camera/cam_front_center/b.json': JSON.stringify({ cam_tstamp: 20, cam_name: 'front_center' }),
    }
    const rows = async (params: Record<string, unknown>, paths: string[]) => (await jsonRecords({ files: paths.map((path) => ({ path, size: 1 })) }, params, context(files))).rows as { rows: unknown[] }
    expect((await rows({ layout: 'object-rows' }, ['cams_lidars.json'])).rows).toEqual([
      { key: 'lidars', front_center: { origin: [1, 2, 3] } }, { key: 'note', value: 'x' },
    ])
    expect((await rows({ layout: 'file-row', pathField: 'path' }, ['camera/cam_front_center/a.json', 'camera/cam_front_center/b.json'])).rows).toEqual([
      { cam_tstamp: 10, cam_name: 'front_center', path: 'camera/cam_front_center/a.json' },
      { cam_tstamp: 20, cam_name: 'front_center', path: 'camera/cam_front_center/b.json' },
    ])
    await expect(rows({}, ['cams_lidars.json'])).rejects.toThrow(/expected a JSON array/u)
  })

  it('expands a nested calibration object into flattened rows through rootPath', async () => {
    const jsonRecords = coreGraphOperatorImplementationsV1['json.records']!
    const files = { 'cams_lidars.json': JSON.stringify({ vehicle: {}, lidars: { front_center: { view: { origin: [1, 2, 3], 'x-axis': [1, 0, 0] } }, rear_left: { view: { origin: [0, 0, 0], 'x-axis': [0, 1, 0] } } } }) }
    const result = await jsonRecords({ files: [{ path: 'cams_lidars.json', size: 1 }] }, { layout: 'object-rows', keyField: 'name', rootPath: 'lidars', flatten: true }, context(files))
    expect((result.rows as { rows: unknown[] }).rows).toEqual([
      { name: 'front_center', 'view.origin': [1, 2, 3], 'view.x-axis': [1, 0, 0] },
      { name: 'rear_left', 'view.origin': [0, 0, 0], 'view.x-axis': [0, 1, 0] },
    ])
    await expect(jsonRecords({ files: [{ path: 'cams_lidars.json', size: 1 }] }, { layout: 'object-rows', rootPath: 'cameras' }, context(files))).rejects.toThrow(/does not name a nested object/u)
  })

  it('binds every row when no keyframe field is declared and explains an empty binding', async () => {
    const join = coreGraphOperatorImplementationsV1['timeline.join']!
    const params = {
      mode: 'token', pathField: 'lidarPath', frameKeyField: 'frame', recordKeyField: 'frame', timestampField: 'ts',
      recordCalibrationKeyField: 'sensor', calibrationKeyField: 'name', calibrationSensorKeyField: 'name', sensorKeyField: 'name',
      sensorIdField: 'name', quaternionField: 'unused', translationField: 'view.origin', rotationForm: 'axes', axisFields: ['view.x-axis', 'view.y-axis'], outputFrame: 'ego',
    }
    const calibration = { kind: 'records', rows: [{ name: 'front_center', 'view.origin': [0, 0, 0], 'view.x-axis': [1, 0, 0], 'view.y-axis': [0, 1, 0] }] }
    const sensors = { kind: 'records', rows: [{ name: 'front_center' }] }
    const records = { kind: 'binary-collection', files: [{ path: 'scene/lidar/cam_front_center/1.npz', size: 1 }], cache: new Map(), retainedReleases: new Map() }
    const bound = (await join({ records, sampleData: { kind: 'records', rows: [{ lidarPath: 'scene/lidar/cam_front_center/1.npz', frame: '1', ts: 5, sensor: 'front_center' }] }, calibration, sensors }, params, context({}))).pointClouds as { bindings: unknown[] }
    expect(bound.bindings).toHaveLength(1)
    await expect(join({ records, sampleData: { kind: 'records', rows: [{ lidarPath: '1.npz', frame: '1', ts: 5, sensor: 'front_center' }] }, calibration, sensors }, params, context({})))
      .rejects.toThrow(/GRAPH_POINT_RELATION_UNBOUND: none of 1 sampleData rows .* lidarPath="1.npz" must equal an inventory-relative record path such as "scene\/lidar\/cam_front_center\/1.npz"/u)
  })

  it('derives fields with regular expressions and drops rows a required derivation misses', async () => {
    const derive = coreGraphOperatorImplementationsV1['records.derive']!
    const padded = await derive({ rows: { kind: 'records', rows: [{ index: 7 }, { index: 1234 }] } }, {
      derive: [{ field: 'path', from: 'index', pattern: '^(\\d+)$', replacement: '$1', pad: 10 }],
    }, context({})) as { rows: { rows: { path: string }[] } }
    expect(padded.rows.rows.map((row) => row.path)).toEqual(['0000000007', '0000001234'])
    const result = await derive({ rows: { kind: 'records', rows: [
      { path: '20180810_150607/camera/cam_front_center/20180810150607_camera_frontcenter_000000083.json' },
      { path: 'README.txt' },
    ] } }, { derive: [
      { field: 'lidarPath', from: 'path', pattern: '^(.*)/camera/(cam_[a-z_]+)/(\\d+)_camera_([a-z]+)_(\\d+)\\.json$', replacement: '$1/lidar/$2/$3_lidar_$4_$5.npz' },
      { field: 'frameKey', from: 'path', pattern: '^.*_(\\d+)\\.json$', replacement: '$1' },
      { field: 'note', from: 'missing', pattern: '.+', replacement: 'x', required: false },
    ] }, context({}))
    expect((result.rows as { rows: unknown[] }).rows).toEqual([{
      path: '20180810_150607/camera/cam_front_center/20180810150607_camera_frontcenter_000000083.json',
      lidarPath: '20180810_150607/lidar/cam_front_center/20180810150607_lidar_frontcenter_000000083.npz',
      frameKey: '000000083',
    }])
  })

  it('accepts axis-vector calibration in the relational point-cloud join', async () => {
    const join = coreGraphOperatorImplementationsV1['timeline.join']!
    const records = { kind: 'binary-collection', files: [{ path: 'lidar/a.npz', size: 1 }], cache: new Map(), retainedReleases: new Map() }
    const plan = (await join({
      records,
      sampleData: { kind: 'records', rows: [{ path: 'lidar/a.npz', frame: 'f1', token: 'r1', ts: 10, calib: 'front_center', key: true }] },
      calibration: { kind: 'records', rows: [{ key: 'front_center', sensor: 'front_center', origin: [1, 2, 3], xAxis: [0, 2, 0], yAxis: [-1, 0, 0] }] },
      sensors: { kind: 'records', rows: [{ key: 'front_center', channel: 'lidar_front_center' }] },
    }, {
      mode: 'token', pathField: 'path', frameKeyField: 'frame', recordKeyField: 'token', timestampField: 'ts',
      recordCalibrationKeyField: 'calib', calibrationKeyField: 'key', calibrationSensorKeyField: 'sensor', sensorKeyField: 'key',
      sensorIdField: 'channel', keyframeField: 'key', quaternionField: 'unused', translationField: 'origin',
      rotationForm: 'axes', axisFields: ['xAxis', 'yAxis'], outputFrame: 'ego',
    }, context({}))).pointClouds as { bindings: { egoFromSensor: Float64Array; sensorId: string }[] }
    expect(plan.bindings[0]!.sensorId).toBe('lidar_front_center')
    expect([...plan.bindings[0]!.egoFromSensor].map((value) => { const rounded = Math.round(value * 1000) / 1000; return rounded === 0 ? 0 : rounded })).toEqual([0, -1, 0, 1, 1, 0, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1])
  })

  it('publishes the new operators and layouts through the contract', () => {
    const names = bundledPhase2OperatorRegistry.list().map((operator) => operator.name)
    expect(names).toEqual(expect.arrayContaining(['archive.npz_records', 'records.derive', 'json.records']))
    const json = bundledPhase2OperatorRegistry.list().find((operator) => operator.name === 'json.records')!
    expect(JSON.stringify(json.paramsContract)).toMatch(/object-rows/u)
  })
})
