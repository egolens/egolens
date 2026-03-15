/**
 * Unit tests for feather.ts ArrayBuffer overloads (Phase 0a).
 *
 * Verifies that readFeatherFile and readFeatherColumns accept both
 * File and ArrayBuffer inputs, producing identical results.
 */

import { describe, it, expect } from 'vitest'
import { readFeatherFile, readFeatherColumns, readFeatherBuffer } from '../feather'
import { tableToIPC, tableFromArrays } from '@uwdata/flechette'

/** Create a minimal Feather/Arrow IPC buffer for testing. */
function makeTestFeatherBuffer(): ArrayBuffer {
  const table = tableFromArrays({
    id: [1, 2, 3],
    name: ['a', 'b', 'c'],
    value: [1.5, 2.5, 3.5],
  })
  const bytes = tableToIPC(table)
  // tableToIPC returns Uint8Array — extract underlying ArrayBuffer
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** Create a File from an ArrayBuffer. */
function bufferToFile(buffer: ArrayBuffer, name: string): File {
  return new File([buffer], name)
}

describe('readFeatherFile (File | ArrayBuffer overload)', () => {
  it('reads rows from an ArrayBuffer', async () => {
    const buffer = makeTestFeatherBuffer()
    const rows = await readFeatherFile(buffer)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveProperty('id')
    expect(rows[0]).toHaveProperty('name')
    expect(rows[0]).toHaveProperty('value')
  })

  it('reads rows from a File', async () => {
    const buffer = makeTestFeatherBuffer()
    const file = bufferToFile(buffer, 'test.feather')
    const rows = await readFeatherFile(file)
    expect(rows).toHaveLength(3)
  })

  it('produces identical results for File and ArrayBuffer', async () => {
    const buffer = makeTestFeatherBuffer()
    const file = bufferToFile(buffer, 'test.feather')

    const fromBuffer = await readFeatherFile(buffer)
    const fromFile = await readFeatherFile(file)

    expect(fromBuffer).toEqual(fromFile)
  })
})

describe('readFeatherColumns (File | ArrayBuffer overload)', () => {
  it('reads columns from an ArrayBuffer', async () => {
    const buffer = makeTestFeatherBuffer()
    const { columns, numRows } = await readFeatherColumns(buffer)
    expect(numRows).toBe(3)
    expect(columns).toHaveProperty('id')
    expect(columns).toHaveProperty('name')
    expect(columns).toHaveProperty('value')
  })

  it('reads columns from a File', async () => {
    const buffer = makeTestFeatherBuffer()
    const file = bufferToFile(buffer, 'test.feather')
    const { columns, numRows } = await readFeatherColumns(file)
    expect(numRows).toBe(3)
    expect(columns).toHaveProperty('id')
  })

  it('produces identical results for File and ArrayBuffer', async () => {
    const buffer = makeTestFeatherBuffer()
    const file = bufferToFile(buffer, 'test.feather')

    const fromBuffer = await readFeatherColumns(buffer)
    const fromFile = await readFeatherColumns(file)

    expect(fromBuffer.numRows).toBe(fromFile.numRows)
    expect(Object.keys(fromBuffer.columns)).toEqual(Object.keys(fromFile.columns))
  })
})

describe('readFeatherBuffer (existing function)', () => {
  it('reads rows from buffer directly', () => {
    const buffer = makeTestFeatherBuffer()
    const rows = readFeatherBuffer(buffer)
    expect(rows).toHaveLength(3)
    expect(rows[0].id).toBe(1)
    expect(rows[0].name).toBe('a')
  })
})
