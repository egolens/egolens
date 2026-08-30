import { describe, expect, it } from 'vitest'
import {
  decodeInterleavedRecordsV1,
  decodeNpzUint16V1,
  decodePcdRecordsV1,
  transformInterleavedXyzV1,
} from '../operators/binaryReaders'

const lidarParams = {
  strideBytes: 20,
  littleEndian: true,
  fields: [
    { name: 'x', type: 'float32' as const, offsetBytes: 0 },
    { name: 'y', type: 'float32' as const, offsetBytes: 4 },
    { name: 'z', type: 'float32' as const, offsetBytes: 8 },
    { name: 'intensity', type: 'float32' as const, offsetBytes: 12 },
  ],
}

function interleavedFixture(): ArrayBuffer {
  const buffer = new ArrayBuffer(40)
  const view = new DataView(buffer)
  const rows = [[1, 2, 3, 0.25, 9], [-4, 5, 6, 0.75, 10]]
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length; column += 1) {
      view.setFloat32(row * 20 + column * 4, rows[row][column], true)
    }
  }
  return buffer
}

function pcdFixture(data = 'binary', trailingBytes = 0, nonZeroTrailing = false): ArrayBuffer {
  const header = [
    '# .PCD v0.7',
    'VERSION 0.7',
    'FIELDS x y z vx vy vx_comp vy_comp',
    'SIZE 4 4 4 4 4 4 4',
    'TYPE F F F F F F F',
    'COUNT 1 1 1 1 1 1 1',
    'WIDTH 2',
    'HEIGHT 1',
    'POINTS 2',
    `DATA ${data}`,
    '',
  ].join('\n')
  const headerBytes = new TextEncoder().encode(header)
  const buffer = new ArrayBuffer(headerBytes.length + 56 + trailingBytes)
  new Uint8Array(buffer).set(headerBytes)
  const view = new DataView(buffer, headerBytes.length)
  const rows = [[1, 2, 3, 4, 5, 6, 7], [-1, -2, -3, -4, -5, -6, -7]]
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length; column += 1) {
      view.setFloat32(row * 28 + column * 4, rows[row][column], true)
    }
  }
  if (nonZeroTrailing && trailingBytes > 0) new Uint8Array(buffer)[buffer.byteLength - 1] = 1
  return buffer
}

function npyUint16(values: readonly number[]): Uint8Array {
  const header = `{'descr': '<u2', 'fortran_order': False, 'shape': (${values.length},), }`
  const pad = 64 - ((10 + header.length) % 64)
  const encodedHeader = new TextEncoder().encode(`${header}${' '.repeat(pad - 1)}\n`)
  const bytes = new Uint8Array(10 + encodedHeader.length + values.length * 2)
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, encodedHeader.length & 0xff, encodedHeader.length >> 8])
  bytes.set(encodedHeader, 10)
  const view = new DataView(bytes.buffer, 10 + encodedHeader.length)
  values.forEach((value, index) => view.setUint16(index * 2, value, true))
  return bytes
}

function storedNpz(name: string, content: Uint8Array): ArrayBuffer {
  const encodedName = new TextEncoder().encode(name)
  const buffer = new ArrayBuffer(30 + encodedName.length + content.length)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(8, 0, true)
  view.setUint32(18, content.length, true)
  view.setUint32(22, content.length, true)
  view.setUint16(26, encodedName.length, true)
  bytes.set(encodedName, 30)
  bytes.set(content, 30 + encodedName.length)
  return buffer
}

describe('binary.interleaved_records@1', () => {
  it('decodes selected fields and applies a rigid transform', () => {
    const decoded = decodeInterleavedRecordsV1(interleavedFixture(), lidarParams)
    const transformed = transformInterleavedXyzV1(decoded, [
      1, 0, 0, 10,
      0, 1, 0, 20,
      0, 0, 1, 30,
      0, 0, 0, 1,
    ])
    expect(transformed.pointCount).toBe(2)
    expect(transformed.attributes).toEqual(['x', 'y', 'z', 'intensity'])
    expect([...transformed.values]).toEqual([11, 22, 33, 0.25, 6, 25, 36, 0.75])
  })

  it('rejects malformed layouts and resource-limit violations', () => {
    expect(() => decodeInterleavedRecordsV1(new ArrayBuffer(21), lidarParams)).toThrow('not divisible')
    expect(() => decodeInterleavedRecordsV1(interleavedFixture(), { ...lidarParams, maxRecords: 1 })).toThrow('exceeds limit')
    expect(() => decodeInterleavedRecordsV1(interleavedFixture(), {
      ...lidarParams,
      fields: [
        { name: 'x', type: 'float32', offsetBytes: 0 },
        { name: 'y', type: 'uint16', offsetBytes: 2 },
      ],
    })).toThrow('overlaps')
  })

  it('honors cancellation before allocation', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => decodeInterleavedRecordsV1(interleavedFixture(), lidarParams, controller.signal)).toThrow('aborted')
  })
})

describe('binary.pcd_records@1', () => {
  const params = { data: 'binary' as const, fields: ['x', 'y', 'z', 'vx', 'vy', 'vx_comp', 'vy_comp'] }

  it('decodes selected PCD binary fields', () => {
    const decoded = decodePcdRecordsV1(pcdFixture(), params)
    expect(decoded.pointCount).toBe(2)
    expect([...decoded.values]).toEqual([1, 2, 3, 4, 5, 6, 7, -1, -2, -3, -4, -5, -6, -7])
  })

  it('accepts only explicitly bounded zero padding after declared points', () => {
    const padded = decodePcdRecordsV1(pcdFixture('binary', 128), {
      ...params,
      trailingPadding: 'zero',
      maxTrailingBytes: 128,
    })
    expect(padded.pointCount).toBe(2)
    expect(() => decodePcdRecordsV1(pcdFixture('binary', 128), params)).toThrow('header declares')
    expect(() => decodePcdRecordsV1(pcdFixture('binary', 129), {
      ...params,
      trailingPadding: 'zero',
      maxTrailingBytes: 128,
    })).toThrow('header declares')
    expect(() => decodePcdRecordsV1(pcdFixture('binary', 128, true), {
      ...params,
      trailingPadding: 'zero',
      maxTrailingBytes: 128,
    })).toThrow('non-zero trailing bytes')
  })

  it('rejects unsupported encodings, payload mismatches, and limits', () => {
    expect(() => decodePcdRecordsV1(pcdFixture('ascii'), params)).toThrow('Unsupported PCD DATA encoding')
    expect(() => decodePcdRecordsV1(pcdFixture().slice(0, -1), params)).toThrow('header declares')
    expect(() => decodePcdRecordsV1(pcdFixture(), { ...params, maxPoints: 1 })).toThrow('exceeds limit')
  })

  it('honors cancellation', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => decodePcdRecordsV1(pcdFixture(), params, controller.signal)).toThrow('aborted')
  })
})

describe('archive.npz_array@1', () => {
  it('decodes only the explicitly selected uint16 array', async () => {
    const result = await decodeNpzUint16V1(storedNpz('labels.npy', npyUint16([1, 17003, 24000])), {
      arrayName: 'labels',
    })
    expect([...result]).toEqual([1, 17003, 24000])
  })

  it('rejects unsafe names and resource-limit violations', async () => {
    await expect(decodeNpzUint16V1(storedNpz('../labels.npy', npyUint16([1])), { arrayName: 'labels' })).rejects.toThrow('Unsafe NPZ entry name')
    await expect(decodeNpzUint16V1(storedNpz('labels.npy', npyUint16([1, 2])), {
      arrayName: 'labels',
      maxElements: 1,
    })).rejects.toThrow('element count exceeds')
  })

  it('honors cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(decodeNpzUint16V1(storedNpz('labels.npy', npyUint16([1])), {
      arrayName: 'labels',
    }, controller.signal)).rejects.toThrow('aborted')
  })
})
