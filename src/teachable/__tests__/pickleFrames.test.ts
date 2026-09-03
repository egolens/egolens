import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dataFrameFromPickleV1, decodePickleDataFrameV1, decodePickleRecordsV1, parsePickleV1 } from '../operators/pickleFrames'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, '..', '__fixtures__', name)))

describe('pickle DataFrame reader', () => {
  it('decodes a gzip pandas DataFrame of float and int columns', async () => {
    const frame = await decodePickleDataFrameV1(fixture('pandas-lidar-sample.pkl.gz'))
    expect(frame.rowCount).toBe(2)
    expect(frame.columns.map((column) => column.name)).toEqual(['x', 'y', 'z', 'i', 't', 'd'])
    expect(frame.columns.find((column) => column.name === 'x')!.values).toEqual([1.5, -2])
    expect(frame.columns.find((column) => column.name === 'y')!.values).toEqual([0, 3.25])
    expect(frame.columns.find((column) => column.name === 'd')!.values).toEqual([0, 1])
    expect(frame.columns.find((column) => column.name === 't')!.values[1]).toBeCloseTo(1.6e9 + 0.1, 3)
  })

  it('decodes string and boolean columns of a cuboid table', async () => {
    const frame = await decodePickleDataFrameV1(fixture('pandas-cuboids-sample.pkl.gz'))
    const column = (name: string) => frame.columns.find((entry) => entry.name === name)!.values
    expect(frame.rowCount).toBe(2)
    expect(column('label')).toEqual(['Car', 'Pedestrian'])
    expect(column('uuid')).toEqual(['a', 'b'])
    expect(column('position.x')).toEqual([1, 2])
    expect(column('dimensions.z')).toEqual([1.5, 1.8])
    expect(column('stationary')).toEqual([false, true])
  })

  it('never executes code: globals stay tagged nodes and unknown opcodes fail closed', () => {
    const tree = parsePickleV1(new Uint8Array([0x80, 0x04, 0x8c, 0x02, 0x6f, 0x73, 0x8c, 0x06, 0x73, 0x79, 0x73, 0x74, 0x65, 0x6d, 0x93, 0x2e]))
    expect(tree).toEqual({ __global: 'os.system' })
    expect(() => parsePickleV1(new Uint8Array([0x80, 0x04, 0xff, 0x2e]))).toThrow(/PICKLE_UNSUPPORTED_OPCODE/u)
  })

  it('interleaves selected columns into float records with renamed attributes', async () => {
    const records = await decodePickleRecordsV1(fixture('pandas-lidar-sample.pkl.gz'), { columns: ['x', 'y', 'z', 'i'], attributes: ['x', 'y', 'z', 'intensity'] })
    expect(records.pointCount).toBe(2)
    expect(records.stride).toBe(4)
    expect(records.attributes).toEqual(['x', 'y', 'z', 'intensity'])
    expect(Array.from(records.values.subarray(0, 4))).toEqual([1.5, 0, expect.any(Number), expect.any(Number)])
    await expect(decodePickleRecordsV1(fixture('pandas-lidar-sample.pkl.gz'), { columns: ['nope'] })).rejects.toThrow(/PICKLE_COLUMN_MISSING: nope/u)
  })

  it('registers archive.pickle_records and archive.pickle_rows as bundled operators', () => {
    const names = bundledPhase2OperatorRegistry.list().map((operator) => operator.name)
    expect(names).toContain('archive.pickle_records')
    expect(names).toContain('archive.pickle_rows')
  })

  it('reads the legacy pandas 1.x BlockManager tuple layout (PandaSet 2021 files)', () => {
    const index = (cls: string, data: unknown) => ({ __global: 'pandas.core.indexes.base._new_Index', args: [{ __global: cls }, data] })
    const nd = (shape: number[], dtype: string, data: unknown) => ({ __ndarray: true, shape, dtype, fortran: false, data })
    const tree = {
      __global: 'pandas.core.frame.DataFrame', args: [],
      state: { _data: { __global: 'pandas.core.internals.managers.BlockManager', args: [], state: [
        [index('pandas.core.indexes.base.Index', { data: nd([3], 'O8', ['x', 'label', 'd']), name: null }), index('pandas.core.indexes.range.RangeIndex', { name: 'index', start: 0, stop: 2, step: 1 })],
        [nd([2, 2], 'f8', new Uint8Array(new Float64Array([1.5, -2, 0, 1]).buffer)), nd([1, 2], 'O8', ['Car', 'Bus'])],
        [index('pandas.core.indexes.base.Index', { data: nd([2], 'O8', ['x', 'd']), name: null }), index('pandas.core.indexes.base.Index', { data: nd([1], 'O8', ['label']), name: null })],
      ] } },
    }
    const frame = dataFrameFromPickleV1(tree)
    expect(frame.rowCount).toBe(2)
    expect(frame.columns.map((column) => column.name)).toEqual(['x', 'label', 'd'])
    expect(frame.columns[0]!.values).toEqual([1.5, -2])
    expect(frame.columns[1]!.values).toEqual(['Car', 'Bus'])
    expect(frame.columns[2]!.values).toEqual([0, 1])
  })
})
