/**
 * Tests for the minimal NPZ (NumPy compressed archive) parser.
 */
import { describe, it, expect } from 'vitest'
import { parseNpzUint16 } from '../npz'

// Helper: create a minimal .npy file with uint16 data
function createNpyUint16(data: number[]): Uint8Array {
  const header = `{'descr': '<u2', 'fortran_order': False, 'shape': (${data.length},), }`
  // Pad header to 64-byte alignment
  const totalHeaderLen = 10 + header.length
  const padLen = 64 - (totalHeaderLen % 64)
  const paddedHeader = header + ' '.repeat(padLen - 1) + '\n'

  const headerBytes = new TextEncoder().encode(paddedHeader)
  const npy = new Uint8Array(10 + headerBytes.length + data.length * 2)

  // Magic: \x93NUMPY
  npy[0] = 0x93
  npy[1] = 0x4e  // N
  npy[2] = 0x55  // U
  npy[3] = 0x4d  // M
  npy[4] = 0x50  // P
  npy[5] = 0x59  // Y
  // Version 1.0
  npy[6] = 1
  npy[7] = 0
  // Header length (little-endian uint16)
  npy[8] = headerBytes.length & 0xff
  npy[9] = (headerBytes.length >> 8) & 0xff
  npy.set(headerBytes, 10)

  // Write uint16 data (little-endian)
  const view = new DataView(npy.buffer, 10 + headerBytes.length, data.length * 2)
  for (let i = 0; i < data.length; i++) {
    view.setUint16(i * 2, data[i], true)
  }

  return npy
}

// Helper: create a minimal uncompressed ZIP file containing a single .npy entry
function createUncompressedZip(name: string, content: Uint8Array): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(name)
  const crc = 0 // CRC not checked for uncompressed

  // Local file header (30 + name + content)
  const lfhSize = 30 + nameBytes.length + content.length
  // Central directory header (46 + name)
  const cdhSize = 46 + nameBytes.length
  // End of central directory (22)
  const eocdSize = 22

  const totalSize = lfhSize + cdhSize + eocdSize
  const buf = new ArrayBuffer(totalSize)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  let off = 0

  // Local file header
  view.setUint32(off, 0x04034b50, true); off += 4    // signature
  view.setUint16(off, 20, true); off += 2             // version needed
  view.setUint16(off, 0, true); off += 2              // flags
  view.setUint16(off, 0, true); off += 2              // compression: stored
  view.setUint16(off, 0, true); off += 2              // mod time
  view.setUint16(off, 0, true); off += 2              // mod date
  view.setUint32(off, crc, true); off += 4             // crc32
  view.setUint32(off, content.length, true); off += 4  // compressed size
  view.setUint32(off, content.length, true); off += 4  // uncompressed size
  view.setUint16(off, nameBytes.length, true); off += 2 // name length
  view.setUint16(off, 0, true); off += 2               // extra length
  bytes.set(nameBytes, off); off += nameBytes.length
  bytes.set(content, off); off += content.length

  const cdhOffset = off

  // Central directory header
  view.setUint32(off, 0x02014b50, true); off += 4
  view.setUint16(off, 20, true); off += 2   // version made by
  view.setUint16(off, 20, true); off += 2   // version needed
  view.setUint16(off, 0, true); off += 2    // flags
  view.setUint16(off, 0, true); off += 2    // compression: stored
  view.setUint16(off, 0, true); off += 2    // mod time
  view.setUint16(off, 0, true); off += 2    // mod date
  view.setUint32(off, crc, true); off += 4
  view.setUint32(off, content.length, true); off += 4
  view.setUint32(off, content.length, true); off += 4
  view.setUint16(off, nameBytes.length, true); off += 2
  view.setUint16(off, 0, true); off += 2    // extra
  view.setUint16(off, 0, true); off += 2    // comment
  view.setUint16(off, 0, true); off += 2    // disk start
  view.setUint16(off, 0, true); off += 2    // internal attrs
  view.setUint32(off, 0, true); off += 4    // external attrs
  view.setUint32(off, 0, true); off += 4    // local header offset
  bytes.set(nameBytes, off); off += nameBytes.length

  // End of central directory
  view.setUint32(off, 0x06054b50, true); off += 4
  view.setUint16(off, 0, true); off += 2    // disk number
  view.setUint16(off, 0, true); off += 2    // disk with CDH
  view.setUint16(off, 1, true); off += 2    // entries on disk
  view.setUint16(off, 1, true); off += 2    // total entries
  view.setUint32(off, cdhSize, true); off += 4 // CDH size
  view.setUint32(off, cdhOffset, true); off += 4 // CDH offset
  view.setUint16(off, 0, true)              // comment length

  return buf
}

describe('parseNpzUint16', () => {
  it('parses uncompressed NPZ with uint16 data', async () => {
    // Create panoptic-style labels: category*1000 + instance
    const labels = [17003, 2001, 17005, 0, 24000]  // car#3, ped#1, car#5, noise, driveable
    const npy = createNpyUint16(labels)
    const npz = createUncompressedZip('data.npy', npy)

    const result = await parseNpzUint16(npz)
    expect(result).toBeInstanceOf(Uint16Array)
    expect(result.length).toBe(5)
    expect(result[0]).toBe(17003)
    expect(result[1]).toBe(2001)
    expect(result[2]).toBe(17005)
    expect(result[3]).toBe(0)
    expect(result[4]).toBe(24000)
  })

  it('correctly decodes semantic and instance IDs', async () => {
    const labels = [17003, 2001, 0, 24000]
    const npy = createNpyUint16(labels)
    const npz = createUncompressedZip('data.npy', npy)

    const result = await parseNpzUint16(npz)

    // Decode: semantic = label // 1000, instance = label % 1000
    expect(Math.floor(result[0] / 1000)).toBe(17)   // vehicle.car
    expect(result[0] % 1000).toBe(3)                 // instance 3
    expect(Math.floor(result[1] / 1000)).toBe(2)     // human.pedestrian.adult
    expect(result[1] % 1000).toBe(1)                 // instance 1
    expect(Math.floor(result[2] / 1000)).toBe(0)     // noise
    expect(result[2] % 1000).toBe(0)                 // no instance
    expect(Math.floor(result[3] / 1000)).toBe(24)    // flat.driveable_surface
    expect(result[3] % 1000).toBe(0)                 // stuff (no instance)
  })

  it('falls back to first .npy entry if data.npy not found', async () => {
    const labels = [5001, 5002]
    const npy = createNpyUint16(labels)
    const npz = createUncompressedZip('arr_0.npy', npy)

    const result = await parseNpzUint16(npz)
    expect(result.length).toBe(2)
    expect(result[0]).toBe(5001)
    expect(result[1]).toBe(5002)
  })

  it('throws on empty NPZ (no .npy entries)', async () => {
    // Create ZIP with non-npy entry
    const content = new TextEncoder().encode('hello')
    const npz = createUncompressedZip('readme.txt', content)

    await expect(parseNpzUint16(npz)).rejects.toThrow('No .npy entry found')
  })

  it('throws on wrong dtype', async () => {
    // Create .npy with float32 dtype instead of uint16
    const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (2,), }`
    const padLen = 64 - ((10 + header.length) % 64)
    const paddedHeader = header + ' '.repeat(padLen - 1) + '\n'
    const headerBytes = new TextEncoder().encode(paddedHeader)
    const npy = new Uint8Array(10 + headerBytes.length + 8) // 2 floats = 8 bytes
    npy[0] = 0x93; npy[1] = 0x4e; npy[2] = 0x55; npy[3] = 0x4d; npy[4] = 0x50; npy[5] = 0x59
    npy[6] = 1; npy[7] = 0
    npy[8] = headerBytes.length & 0xff; npy[9] = (headerBytes.length >> 8) & 0xff
    npy.set(headerBytes, 10)

    const npz = createUncompressedZip('data.npy', npy)
    await expect(parseNpzUint16(npz)).rejects.toThrow('Unexpected panoptic dtype')
  })
})
