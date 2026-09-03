import { tableFromArrays, tableToIPC } from '@uwdata/flechette'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import { featherSchemaFromPrefixV1, inspectSourceInventoryV1 } from '../authoring/inspection'

function featherBytes(format: 'file' | 'stream'): Uint8Array {
  const table = tableFromArrays({
    timestamp_ns: new BigInt64Array([1n, 2n]),
    intensity: new Uint8Array([7, 9]),
    x: new Float64Array([0.5, 1.5]),
    sensor_name: ['ring_front_center', 'ring_front_left'],
  })
  return tableToIPC(table, { format })
}

describe('feather table-schema inspection', () => {
  it('decodes the leading schema message from a bounded prefix of a file or stream', () => {
    for (const format of ['file', 'stream'] as const) {
      const schema = featherSchemaFromPrefixV1(featherBytes(format).subarray(0, 2048), 2048)
      expect(schema.map((field) => [field.name, field.logicalType])).toEqual([
        ['timestamp_ns', 'int64'], ['intensity', 'uint8'], ['x', 'float64'], ['sensor_name', 'utf8'],
      ])
    }
  })

  it('fails closed when the schema message does not fit within maxBytes', () => {
    expect(() => featherSchemaFromPrefixV1(featherBytes('file').subarray(0, 40), 40)).toThrow(/does not fit within maxBytes/u)
  })

  it('exposes feather column names and types through the public inspect tool without reading batches', async () => {
    const bytes = featherBytes('file')
    const inventory = new SourceInventoryV1([
      ['calibration/intrinsics.feather', new File([bytes], 'intrinsics.feather', { lastModified: 1 })],
    ], { sessionId: 'feather-session' })
    const result = await inspectSourceInventoryV1(inventory, { mode: 'table-schema', path: 'calibration/intrinsics.feather', maxBytes: 4096 })
    expect(result.data).toEqual({
      byteLength: bytes.byteLength,
      schema: [
        { name: 'timestamp_ns', logicalType: 'int64', arrowTypeId: 2, nullable: true },
        { name: 'intensity', logicalType: 'uint8', arrowTypeId: 2, nullable: true },
        { name: 'x', logicalType: 'float64', arrowTypeId: 3, nullable: true },
        { name: 'sensor_name', logicalType: 'utf8', arrowTypeId: -1, nullable: true },
      ],
    })
  })
})

describe('pickle table-schema inspection', () => {
  it('exposes DataFrame column names, types, samples, and row count for .pkl.gz files', async () => {
    const bytes = readFileSync(path.join(__dirname, '..', '__fixtures__', 'pandas-cuboids-sample.pkl.gz'))
    const inventory = new SourceInventoryV1([
      ['annotations/cuboids/00.pkl.gz', new File([bytes], '00.pkl.gz', { lastModified: 1 })],
    ], { sessionId: 'pickle-session' })
    const result = await inspectSourceInventoryV1(inventory, { mode: 'table-schema', path: 'annotations/cuboids/00.pkl.gz', maxBytes: 4096 })
    const data = result.data as { numRows: number; schema: { name: string; type: string; sample: unknown[] }[] }
    expect(data.numRows).toBe(2)
    expect(data.schema.find((column) => column.name === 'label')).toEqual({ name: 'label', type: 'string', sample: ['Car', 'Pedestrian'] })
    expect(data.schema.find((column) => column.name === 'stationary')?.type).toBe('boolean')
    expect(data.schema.find((column) => column.name === 'position.x')?.type).toBe('number')
  })
})
