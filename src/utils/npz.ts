/**
 * Minimal NPZ (NumPy compressed archive) parser for browser use.
 *
 * NPZ files are ZIP archives containing .npy files. Each .npy file
 * has a header describing the dtype and shape, followed by raw data.
 *
 * We only need to support uint16 arrays (panoptic labels).
 */

// ---------------------------------------------------------------------------
// ZIP local-file-header parsing (minimal, no external dependency)
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  compressedData: Uint8Array
  compressionMethod: number
}

/** Parse ZIP local file headers and extract entries. */
function parseZipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer)
  const entries: ZipEntry[] = []
  let offset = 0

  while (offset + 30 <= buffer.byteLength) {
    const sig = view.getUint32(offset, true)
    if (sig !== 0x04034b50) break  // Not a local file header

    const compressionMethod = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameBytes = new Uint8Array(buffer, offset + 30, nameLength)
    const name = new TextDecoder().decode(nameBytes)

    const dataOffset = offset + 30 + nameLength + extraLength
    const compressedData = new Uint8Array(buffer, dataOffset, compressedSize)

    entries.push({ name, compressedData, compressionMethod })
    offset = dataOffset + compressedSize
  }

  return entries
}

// ---------------------------------------------------------------------------
// NPY header parsing
// ---------------------------------------------------------------------------

interface NpyHeader {
  dtype: string   // e.g. '<u2' (little-endian uint16)
  fortranOrder: boolean
  shape: number[]
}

function parseNpyHeader(data: Uint8Array): { header: NpyHeader; dataOffset: number } {
  // Magic: \x93NUMPY
  if (data[0] !== 0x93 || data[1] !== 0x4e) {
    throw new Error('Invalid .npy magic bytes')
  }
  const majorVersion = data[6]
  let headerLen: number
  let headerStart: number
  if (majorVersion === 1) {
    headerLen = data[8] | (data[9] << 8)
    headerStart = 10
  } else {
    // Version 2+: 4-byte header length
    headerLen = data[8] | (data[9] << 8) | (data[10] << 16) | (data[11] << 24)
    headerStart = 12
  }

  const headerStr = new TextDecoder().decode(data.slice(headerStart, headerStart + headerLen))
  // Parse Python dict string: {'descr': '<u2', 'fortran_order': False, 'shape': (34688,)}
  const descrMatch = headerStr.match(/'descr'\s*:\s*'([^']+)'/)
  const fortranMatch = headerStr.match(/'fortran_order'\s*:\s*(True|False)/)
  const shapeMatch = headerStr.match(/'shape'\s*:\s*\(([^)]*)\)/)

  const dtype = descrMatch ? descrMatch[1] : '<f4'
  const fortranOrder = fortranMatch ? fortranMatch[1] === 'True' : false
  const shapeStr = shapeMatch ? shapeMatch[1] : ''
  const shape = shapeStr
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)

  return {
    header: { dtype, fortranOrder, shape },
    dataOffset: headerStart + headerLen,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an NPZ file and extract the first uint16 array (typically 'data').
 * Uses DecompressionStream for DEFLATE-compressed entries (modern browsers).
 */
export async function parseNpzUint16(buffer: ArrayBuffer): Promise<Uint16Array> {
  const entries = parseZipEntries(buffer)

  // Find the 'data.npy' entry (standard key used by np.savez_compressed)
  // Fall back to the first .npy entry if 'data.npy' is not found
  const target = entries.find((e) => e.name === 'data.npy')
    ?? entries.find((e) => e.name.endsWith('.npy'))

  if (!target) {
    throw new Error('No .npy entry found in NPZ archive')
  }

  let npyBytes: Uint8Array
  if (target.compressionMethod === 8) {
    // DEFLATE compressed — use DecompressionStream API
    const ds = new DecompressionStream('deflate-raw')
    const writer = ds.writable.getWriter()
    const reader = ds.readable.getReader()

    // Write compressed data and close
    writer.write(new Uint8Array(target.compressedData.buffer, target.compressedData.byteOffset, target.compressedData.byteLength) as unknown as BufferSource).then(() => writer.close())

    // Read decompressed chunks
    const chunks: Uint8Array[] = []
    let totalLen = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      totalLen += value.byteLength
    }

    // Concatenate chunks
    npyBytes = new Uint8Array(totalLen)
    let off = 0
    for (const chunk of chunks) {
      npyBytes.set(chunk, off)
      off += chunk.byteLength
    }
  } else {
    // Stored (no compression)
    npyBytes = target.compressedData
  }

  const { header, dataOffset } = parseNpyHeader(npyBytes)

  // Verify dtype is uint16 (little-endian or native)
  if (!header.dtype.includes('u2') && !header.dtype.includes('uint16')) {
    throw new Error(`Unexpected panoptic dtype: ${header.dtype}`)
  }

  const totalElements = header.shape.reduce((a, b) => a * b, 1)
  const rawData = npyBytes.slice(dataOffset, dataOffset + totalElements * 2)

  // Create Uint16Array — need to handle alignment
  if (rawData.byteOffset % 2 === 0) {
    return new Uint16Array(rawData.buffer, rawData.byteOffset, totalElements)
  }
  // Misaligned: copy to aligned buffer
  const aligned = new Uint8Array(rawData.length)
  aligned.set(rawData)
  return new Uint16Array(aligned.buffer, 0, totalElements)
}
