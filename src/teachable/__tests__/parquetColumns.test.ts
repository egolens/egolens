import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AsyncBuffer } from 'hyparquet'
import { openParquetFile } from '../../utils/parquet'
import {
  PARQUET_MAX_DECODED_BYTES_PER_READ_V1,
  estimateParquetDecodedBytesV1,
  readParquetColumnsV1,
  type ParquetColumnsParamsV1,
} from '../operators/parquetColumns'

const fixturePath = resolve(__dirname, '../../__fixtures__/mock_segment_0000/vehicle_pose.parquet')

function fixtureBuffer(): AsyncBuffer {
  const bytes = readFileSync(fixturePath)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return { byteLength: buffer.byteLength, slice: (start, end) => buffer.slice(start, end) }
}

const params: ParquetColumnsParamsV1 = {
  columns: [
    { name: 'key.segment_context_name', type: 'utf8' },
    { name: 'key.frame_timestamp_micros', type: 'bigint' },
    { name: '[VehiclePoseComponent].world_from_vehicle.transform', type: 'number-list' },
  ],
  maxInputBytes: 1_000_000,
  maxRows: 250,
  maxOutputBytes: 1_000_000,
}

describe('parquet.columns@1', () => {
  it('reads an explicit bounded row projection with decoded logical types', async () => {
    const file = await openParquetFile('vehicle_pose', fixtureBuffer())
    const rows = await readParquetColumnsV1(file, params, { rowStart: 0, rowEnd: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0]['key.segment_context_name']).toBe('mock_segment_0000')
    expect(rows[0]['key.frame_timestamp_micros']).toBe(1_000_000_000_000n)
    expect(rows[0]['[VehiclePoseComponent].world_from_vehicle.transform']).toHaveLength(16)
  })

  it('rejects missing columns, logical type drift, and resource limits', async () => {
    const file = await openParquetFile('vehicle_pose', fixtureBuffer())
    await expect(readParquetColumnsV1(file, {
      ...params,
      columns: [{ name: 'missing', type: 'number' }],
    }, { rowStart: 0, rowEnd: 1 })).rejects.toThrow('missing')
    await expect(readParquetColumnsV1(file, {
      ...params,
      columns: [{ name: 'key.frame_timestamp_micros', type: 'number' }],
    }, { rowStart: 0, rowEnd: 1 })).rejects.toThrow('declared type number')
    await expect(readParquetColumnsV1(file, { ...params, maxInputBytes: 1 })).rejects.toThrow('input size')
    await expect(readParquetColumnsV1(file, { ...params, maxRows: 1 })).rejects.toThrow('row range')
    await expect(readParquetColumnsV1(file, { ...params, maxOutputBytes: 1 }, {
      rowStart: 0, rowEnd: 1,
    })).rejects.toThrow('selected output')
  })

  it('estimates the decoded row-group footprint from leaf value counts, not compressed size', async () => {
    const file = await openParquetFile('vehicle_pose', fixtureBuffer())
    const estimate = estimateParquetDecodedBytesV1(file, params.columns, 0, 1)
    expect(estimate.rowGroups).toBeGreaterThan(0)
    const listOnly = estimateParquetDecodedBytesV1(file, params.columns.filter((column) => column.type === 'number-list'), 0, 1)
    // Every 4x4 transform contributes 16 JavaScript numbers per row of every overlapping row group.
    const rowsInGroups = file.rowGroups.filter((group) => group.rowStart < 1).reduce((sum, group) => sum + group.numRows, 0)
    expect(listOnly.bytes).toBe(rowsInGroups * 16 * 8)
    expect(estimate.bytes).toBeGreaterThan(listOnly.bytes)
    // Out-of-range row windows touch no row group and therefore decode nothing.
    expect(estimateParquetDecodedBytesV1(file, params.columns, file.numRows, file.numRows).rowGroups).toBe(0)
    expect(PARQUET_MAX_DECODED_BYTES_PER_READ_V1).toBe(2 * 1024 * 1024 * 1024)
  })

  it('reads several wide columns one at a time and merges them into the same rows', async () => {
    const bytes = readFileSync(resolve(__dirname, '../../__fixtures__/mock_segment_0000/lidar_calibration.parquet'))
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const file = await openParquetFile('lidar_calibration', { byteLength: buffer.byteLength, slice: (start, end) => buffer.slice(start, end) })
    const wide: ParquetColumnsParamsV1 = {
      ...params,
      columns: [
        { name: 'key.laser_name', type: 'integer' },
        { name: '[LiDARCalibrationComponent].extrinsic.transform', type: 'number-list' },
        { name: '[LiDARCalibrationComponent].beam_inclination.values', type: 'number-list', nullable: true },
      ],
    }
    const rows = await readParquetColumnsV1(file, wide)
    expect(rows.length).toBeGreaterThan(1)
    const laserNames = new Set<unknown>()
    for (const row of rows) {
      laserNames.add(row['key.laser_name'])
      expect(row['[LiDARCalibrationComponent].extrinsic.transform']).toHaveLength(16)
      expect('[LiDARCalibrationComponent].beam_inclination.values' in row).toBe(true)
    }
    expect(laserNames.size).toBe(rows.length)
  })

  it('honors cancellation before reading Parquet row groups', async () => {
    const file = await openParquetFile('vehicle_pose', fixtureBuffer())
    const controller = new AbortController()
    controller.abort()
    await expect(readParquetColumnsV1(file, params, { signal: controller.signal })).rejects.toThrow('aborted')
  })
})
