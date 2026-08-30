import { tableFromArrays, tableToIPC } from '@uwdata/flechette'
import { describe, expect, it } from 'vitest'
import {
  decodeFeatherColumnsV1,
  interleaveFeatherNumericColumnsV1,
  type FeatherColumnsParamsV1,
} from '../operators/featherColumns'
import { alignNearestTimestampV1, normalizeNanosecondTimelineV1 } from '../operators/temporal'

function featherFixture(): ArrayBuffer {
  const table = tableFromArrays({
    x: new Float64Array([1.5, -2.5]),
    intensity: new Uint8Array([7, 9]),
    timestamp_ns: new BigInt64Array([1_000n, 2_000n]),
    label: ['one', 'two'],
  })
  const bytes = tableToIPC(table)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

const params: FeatherColumnsParamsV1 = {
  columns: [
    { name: 'x', type: 'float64' },
    { name: 'intensity', type: 'uint8' },
    { name: 'timestamp_ns', type: 'int64' },
    { name: 'label', type: 'utf8' },
  ],
  maxInputBytes: 1_000_000,
  maxRows: 10,
  maxOutputBytes: 1_000_000,
}

describe('feather.columns@1', () => {
  it('decodes only explicitly typed columns and interleaves numeric output', () => {
    const decoded = decodeFeatherColumnsV1(featherFixture(), params)
    expect(decoded.numRows).toBe(2)
    expect(Array.from(decoded.columns.timestamp_ns)).toEqual([1_000n, 2_000n])
    expect(Array.from(decoded.columns.label)).toEqual(['one', 'two'])
    const interleaved = interleaveFeatherNumericColumnsV1(decoded, ['x', 'intensity'])
    expect(interleaved).toMatchObject({ pointCount: 2, stride: 2, attributes: ['x', 'intensity'] })
    expect([...interleaved.values]).toEqual([1.5, 7, -2.5, 9])
  })

  it('rejects schema mismatches, missing columns, and resource limits', () => {
    const buffer = featherFixture()
    expect(() => decodeFeatherColumnsV1(buffer, {
      ...params,
      columns: [{ name: 'x', type: 'float32' }],
    })).toThrow('expected float32')
    expect(() => decodeFeatherColumnsV1(buffer, {
      ...params,
      columns: [{ name: 'missing', type: 'float64' }],
    })).toThrow('missing')
    expect(() => decodeFeatherColumnsV1(buffer, { ...params, maxRows: 1 })).toThrow('row count')
    expect(() => decodeFeatherColumnsV1(buffer, { ...params, maxInputBytes: 1 })).toThrow('input size')
    expect(() => decodeFeatherColumnsV1(buffer, { ...params, maxOutputBytes: 1 })).toThrow('selected output')
  })

  it('honors cancellation before Arrow parsing', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => decodeFeatherColumnsV1(featherFixture(), params, controller.signal)).toThrow('aborted')
  })
})

describe('bounded timestamp alignment', () => {
  it('selects the nearest timestamp with deterministic earlier tie-breaking', () => {
    expect(alignNearestTimestampV1([100n, 200n], 150n, 50n)).toBe(100n)
    expect(alignNearestTimestampV1([100n, 200n], 151n, 50n)).toBe(200n)
    expect(alignNearestTimestampV1([100n, 200n], 151n, 48n)).toBeNull()
  })

  it('rejects unordered timelines and normalizes nanoseconds to microseconds', () => {
    expect(() => alignNearestTimestampV1([200n, 100n], 150n, 100n)).toThrow('strictly increasing')
    expect(normalizeNanosecondTimelineV1([1_000n, 2_999n])).toEqual([1n, 2n])
  })
})
