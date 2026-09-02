export type BinaryScalarType =
  | 'float32'
  | 'float64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'int8'
  | 'int16'
  | 'int32'

export interface InterleavedFieldV1 {
  readonly name: string
  readonly type: BinaryScalarType
  readonly offsetBytes: number
}

export interface InterleavedRecordsParamsV1 {
  readonly strideBytes: number
  readonly littleEndian: boolean
  readonly fields: readonly InterleavedFieldV1[]
  readonly maxRecords?: number
  readonly maxOutputBytes?: number
}

export interface PcdRecordsParamsV1 {
  readonly data: 'binary'
  readonly fields: readonly string[]
  readonly trailingPadding?: 'zero'
  readonly maxTrailingBytes?: number
  readonly maxHeaderBytes?: number
  readonly maxPoints?: number
  readonly maxOutputBytes?: number
}

export interface DecodedNumericRecordsV1 {
  readonly values: Float32Array
  readonly pointCount: number
  readonly stride: number
  readonly attributes: readonly string[]
}

export interface NpzUint16ParamsV1 {
  readonly arrayName?: string
  readonly maxEntries?: number
  readonly maxExpandedBytes?: number
  readonly maxCompressionRatio?: number
  readonly maxElements?: number
  readonly maxRank?: number
}

const DEFAULT_MAX_RECORDS = 10_000_000
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024
const DEFAULT_MAX_ARCHIVE_ENTRIES = 16
const DEFAULT_MAX_EXPANDED_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_COMPRESSION_RATIO = 200
const DEFAULT_MAX_RANK = 4

const scalarBytes: Readonly<Record<BinaryScalarType, number>> = {
  float32: 4,
  float64: 8,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  int8: 1,
  int16: 2,
  int32: 4,
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`)
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`)
}

function readScalar(
  view: DataView,
  offset: number,
  type: BinaryScalarType,
  littleEndian: boolean,
): number {
  switch (type) {
    case 'float32': return view.getFloat32(offset, littleEndian)
    case 'float64': return view.getFloat64(offset, littleEndian)
    case 'uint8': return view.getUint8(offset)
    case 'uint16': return view.getUint16(offset, littleEndian)
    case 'uint32': return view.getUint32(offset, littleEndian)
    case 'int8': return view.getInt8(offset)
    case 'int16': return view.getInt16(offset, littleEndian)
    case 'int32': return view.getInt32(offset, littleEndian)
  }
}

export function assertValidInterleavedRecordsParamsV1(params: InterleavedRecordsParamsV1): void {
  assertPositiveSafeInteger(params.strideBytes, 'strideBytes')
  if (params.strideBytes > 4096) throw new Error('strideBytes exceeds the 4096-byte operator limit.')
  if (params.fields.length === 0 || params.fields.length > 64) {
    throw new Error('fields must contain between 1 and 64 entries.')
  }
  const names = new Set<string>()
  const occupied = new Set<number>()
  for (const field of params.fields) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/u.test(field.name)) {
      throw new Error(`Invalid field name: ${field.name}`)
    }
    if (names.has(field.name)) throw new Error(`Duplicate field name: ${field.name}`)
    names.add(field.name)
    if (!Number.isSafeInteger(field.offsetBytes) || field.offsetBytes < 0) {
      throw new Error(`Field ${field.name} has an invalid byte offset.`)
    }
    const end = field.offsetBytes + scalarBytes[field.type]
    if (end > params.strideBytes) {
      throw new Error(`Field ${field.name} extends beyond the declared stride.`)
    }
    for (let byte = field.offsetBytes; byte < end; byte += 1) {
      if (occupied.has(byte)) throw new Error(`Field ${field.name} overlaps another selected field.`)
      occupied.add(byte)
    }
  }
}

/** Decode a bounded fixed-stride binary record stream into interleaved floats. */
export function decodeInterleavedRecordsV1(
  buffer: ArrayBuffer,
  params: InterleavedRecordsParamsV1,
  signal?: AbortSignal,
): DecodedNumericRecordsV1 {
  throwIfAborted(signal)
  assertValidInterleavedRecordsParamsV1(params)
  if (buffer.byteLength % params.strideBytes !== 0) {
    throw new Error(`Input byte length ${buffer.byteLength} is not divisible by stride ${params.strideBytes}.`)
  }
  const pointCount = buffer.byteLength / params.strideBytes
  const maxRecords = params.maxRecords ?? DEFAULT_MAX_RECORDS
  assertPositiveSafeInteger(maxRecords, 'maxRecords')
  if (pointCount > maxRecords) throw new Error(`Record count ${pointCount} exceeds limit ${maxRecords}.`)
  const outputBytes = pointCount * params.fields.length * Float32Array.BYTES_PER_ELEMENT
  const maxOutputBytes = params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  assertPositiveSafeInteger(maxOutputBytes, 'maxOutputBytes')
  if (!Number.isSafeInteger(outputBytes) || outputBytes > maxOutputBytes) {
    throw new Error(`Decoded output size ${outputBytes} exceeds limit ${maxOutputBytes}.`)
  }

  const view = new DataView(buffer)
  const values = new Float32Array(pointCount * params.fields.length)
  for (let index = 0; index < pointCount; index += 1) {
    if ((index & 0x3fff) === 0) throwIfAborted(signal)
    const source = index * params.strideBytes
    const target = index * params.fields.length
    for (let fieldIndex = 0; fieldIndex < params.fields.length; fieldIndex += 1) {
      const field = params.fields[fieldIndex]
      const value = readScalar(view, source + field.offsetBytes, field.type, params.littleEndian)
      if (!Number.isFinite(value)) throw new Error(`Non-finite value in field ${field.name} at record ${index}.`)
      values[target + fieldIndex] = value
    }
  }
  return {
    values,
    pointCount,
    stride: params.fields.length,
    attributes: params.fields.map((field) => field.name),
  }
}

interface PcdFieldLayout {
  readonly name: string
  readonly size: number
  readonly type: 'F' | 'I' | 'U'
  readonly count: number
  readonly offset: number
}

function pcdScalarType(field: PcdFieldLayout): BinaryScalarType {
  if (field.count !== 1) throw new Error(`Selected PCD field ${field.name} must have COUNT 1.`)
  if (field.type === 'F' && field.size === 4) return 'float32'
  if (field.type === 'F' && field.size === 8) return 'float64'
  if (field.type === 'U' && field.size === 1) return 'uint8'
  if (field.type === 'U' && field.size === 2) return 'uint16'
  if (field.type === 'U' && field.size === 4) return 'uint32'
  if (field.type === 'I' && field.size === 1) return 'int8'
  if (field.type === 'I' && field.size === 2) return 'int16'
  if (field.type === 'I' && field.size === 4) return 'int32'
  throw new Error(`Unsupported PCD scalar ${field.type}${field.size} for field ${field.name}.`)
}

function parsePcdHeader(
  buffer: ArrayBuffer,
  maxHeaderBytes: number,
): { layouts: readonly PcdFieldLayout[]; pointCount: number; rowBytes: number; dataOffset: number } {
  const bytes = new Uint8Array(buffer)
  const scanLength = Math.min(bytes.length, maxHeaderBytes)
  let dataOffset = -1
  let lineStart = 0
  const lines: string[] = []
  const decoder = new TextDecoder('ascii', { fatal: true })
  for (let index = 0; index < scanLength; index += 1) {
    if (bytes[index] !== 0x0a) continue
    const end = index > lineStart && bytes[index - 1] === 0x0d ? index - 1 : index
    const line = decoder.decode(bytes.subarray(lineStart, end)).trim()
    if (line.length > 0 && !line.startsWith('#')) lines.push(line)
    lineStart = index + 1
    if (line.toUpperCase().startsWith('DATA ')) {
      dataOffset = lineStart
      break
    }
    if (lines.length > 128) throw new Error('PCD header exceeds the 128-line limit.')
  }
  if (dataOffset < 0) throw new Error(`PCD DATA line was not found within ${maxHeaderBytes} bytes.`)

  const entries = new Map<string, string[]>()
  for (const line of lines) {
    const [key, ...values] = line.split(/\s+/u)
    const normalized = key.toUpperCase()
    if (entries.has(normalized)) throw new Error(`Duplicate PCD header field: ${normalized}`)
    entries.set(normalized, values)
  }
  if (entries.get('DATA')?.[0]?.toLowerCase() !== 'binary') {
    throw new Error(`Unsupported PCD DATA encoding: ${entries.get('DATA')?.[0] ?? 'missing'}`)
  }
  const names = entries.get('FIELDS') ?? entries.get('FIELD')
  const sizes = entries.get('SIZE')?.map(Number)
  const types = entries.get('TYPE') as ('F' | 'I' | 'U')[] | undefined
  const counts = (entries.get('COUNT') ?? names?.map(() => '1'))?.map(Number)
  if (!names || !sizes || !types || !counts) throw new Error('PCD header is missing FIELDS, SIZE, TYPE, or COUNT.')
  if (names.length === 0 || names.length > 128) throw new Error('PCD field count must be between 1 and 128.')
  if (new Set(names).size !== names.length) throw new Error('PCD FIELDS contains duplicates.')
  if (![sizes.length, types.length, counts.length].every((length) => length === names.length)) {
    throw new Error('PCD FIELDS, SIZE, TYPE, and COUNT lengths differ.')
  }

  let offset = 0
  const layouts = names.map((name, index): PcdFieldLayout => {
    const size = sizes[index]
    const type = types[index]
    const count = counts[index]
    if (![1, 2, 4, 8].includes(size) || !['F', 'I', 'U'].includes(type) || !Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Invalid PCD layout for field ${name}.`)
    }
    const layout = { name, size, type, count, offset }
    offset += size * count
    return layout
  })
  const pointsEntry = entries.get('POINTS')?.[0]
  const widthEntry = entries.get('WIDTH')?.[0]
  const heightEntry = entries.get('HEIGHT')?.[0]
  const points = pointsEntry === undefined ? null : Number(pointsEntry)
  const width = widthEntry === undefined ? null : Number(widthEntry)
  const height = heightEntry === undefined ? 1 : Number(heightEntry)
  const dimensionsCount = width === null ? null : width * height
  const pointCount = points ?? dimensionsCount
  if (pointCount === null) throw new Error('PCD header must declare POINTS or WIDTH and HEIGHT.')
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) throw new Error('PCD point count is invalid.')
  if (points !== null && dimensionsCount !== null && points !== dimensionsCount) {
    throw new Error('PCD POINTS does not equal WIDTH × HEIGHT.')
  }
  return { layouts, pointCount, rowBytes: offset, dataOffset }
}

/** Decode selected scalar fields from a bounded PCD v0.7 binary payload. */
export function decodePcdRecordsV1(
  buffer: ArrayBuffer,
  params: PcdRecordsParamsV1,
  signal?: AbortSignal,
): DecodedNumericRecordsV1 {
  throwIfAborted(signal)
  if (params.data !== 'binary') throw new Error(`Unsupported PCD DATA encoding: ${params.data}`)
  if (params.fields.length === 0 || params.fields.length > 64 || new Set(params.fields).size !== params.fields.length) {
    throw new Error('PCD selected fields must contain 1–64 unique names.')
  }
  const maxHeaderBytes = params.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES
  assertPositiveSafeInteger(maxHeaderBytes, 'maxHeaderBytes')
  const { layouts, pointCount, rowBytes, dataOffset } = parsePcdHeader(buffer, maxHeaderBytes)
  const maxPoints = params.maxPoints ?? DEFAULT_MAX_RECORDS
  assertPositiveSafeInteger(maxPoints, 'maxPoints')
  if (pointCount > maxPoints) throw new Error(`PCD point count ${pointCount} exceeds limit ${maxPoints}.`)
  const expectedBytes = pointCount * rowBytes
  const payloadBytes = buffer.byteLength - dataOffset
  if (payloadBytes < expectedBytes) {
    throw new Error(`PCD payload is ${payloadBytes} bytes; header declares ${expectedBytes}.`)
  }
  if (payloadBytes > expectedBytes) {
    const trailingBytes = payloadBytes - expectedBytes
    const maxTrailingBytes = params.maxTrailingBytes ?? 4096
    assertPositiveSafeInteger(maxTrailingBytes, 'maxTrailingBytes')
    if (params.trailingPadding !== 'zero' || trailingBytes > maxTrailingBytes) {
      throw new Error(`PCD payload is ${payloadBytes} bytes; header declares ${expectedBytes}.`)
    }
    const trailing = new Uint8Array(buffer, dataOffset + expectedBytes, trailingBytes)
    if (trailing.some((byte) => byte !== 0)) {
      throw new Error(`PCD payload contains ${trailingBytes} non-zero trailing bytes.`)
    }
  }
  const selected = params.fields.map((name) => {
    const layout = layouts.find((candidate) => candidate.name === name)
    if (!layout) throw new Error(`Selected PCD field is missing: ${name}`)
    return { layout, scalar: pcdScalarType(layout) }
  })
  const outputBytes = pointCount * selected.length * Float32Array.BYTES_PER_ELEMENT
  const maxOutputBytes = params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  assertPositiveSafeInteger(maxOutputBytes, 'maxOutputBytes')
  if (!Number.isSafeInteger(outputBytes) || outputBytes > maxOutputBytes) {
    throw new Error(`Decoded PCD output size ${outputBytes} exceeds limit ${maxOutputBytes}.`)
  }

  const view = new DataView(buffer, dataOffset, expectedBytes)
  const values = new Float32Array(pointCount * selected.length)
  for (let index = 0; index < pointCount; index += 1) {
    if ((index & 0x3fff) === 0) throwIfAborted(signal)
    const source = index * rowBytes
    const target = index * selected.length
    for (let fieldIndex = 0; fieldIndex < selected.length; fieldIndex += 1) {
      const field = selected[fieldIndex]
      const value = readScalar(view, source + field.layout.offset, field.scalar, true)
      if (!Number.isFinite(value)) throw new Error(`Non-finite PCD value in ${field.layout.name} at point ${index}.`)
      values[target + fieldIndex] = value
    }
  }
  return { values, pointCount, stride: selected.length, attributes: [...params.fields] }
}

interface ZipEntryV1 {
  readonly name: string
  readonly compressedData: Uint8Array
  readonly compressionMethod: 0 | 8
  readonly expandedBytes: number
}

function parseBoundedZipEntries(buffer: ArrayBuffer, params: Required<NpzUint16ParamsV1>): ZipEntryV1[] {
  const view = new DataView(buffer)
  const entries: ZipEntryV1[] = []
  const names = new Set<string>()
  let offset = 0
  let totalExpanded = 0
  while (offset + 30 <= buffer.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    if (entries.length >= params.maxEntries) throw new Error(`NPZ entry count exceeds limit ${params.maxEntries}.`)
    const flags = view.getUint16(offset + 6, true)
    if ((flags & 0x1) !== 0) throw new Error('Encrypted NPZ entries are not supported.')
    if ((flags & 0x8) !== 0) throw new Error('NPZ data descriptors are not supported.')
    const method = view.getUint16(offset + 8, true)
    if (method !== 0 && method !== 8) throw new Error(`Unsupported NPZ compression method: ${method}`)
    const compressedBytes = view.getUint32(offset + 18, true)
    const expandedBytes = view.getUint32(offset + 22, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const dataOffset = offset + 30 + nameLength + extraLength
    const end = dataOffset + compressedBytes
    if (end > buffer.byteLength) throw new Error('NPZ entry extends beyond the archive.')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, offset + 30, nameLength))
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw new Error(`Unsafe NPZ entry name: ${name}`)
    }
    if (names.has(name)) throw new Error(`Duplicate NPZ entry name: ${name}`)
    names.add(name)
    totalExpanded += expandedBytes
    if (totalExpanded > params.maxExpandedBytes) throw new Error(`NPZ expanded size exceeds limit ${params.maxExpandedBytes}.`)
    if (compressedBytes === 0 ? expandedBytes > 0 : expandedBytes / compressedBytes > params.maxCompressionRatio) {
      throw new Error(`NPZ entry ${name} exceeds compression-ratio limit ${params.maxCompressionRatio}.`)
    }
    entries.push({
      name,
      compressedData: new Uint8Array(buffer, dataOffset, compressedBytes),
      compressionMethod: method,
      expandedBytes,
    })
    offset = end
  }
  return entries
}

async function expandZipEntry(entry: ZipEntryV1, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal)
  if (entry.compressionMethod === 0) {
    if (entry.compressedData.byteLength !== entry.expandedBytes) throw new Error(`Stored NPZ entry ${entry.name} has inconsistent sizes.`)
    return entry.compressedData
  }
  const stream = new Blob([entry.compressedData as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    throwIfAborted(signal)
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > entry.expandedBytes) throw new Error(`NPZ entry ${entry.name} expands beyond its declared size.`)
    chunks.push(value)
  }
  if (total !== entry.expandedBytes) throw new Error(`NPZ entry ${entry.name} expanded to ${total} bytes; expected ${entry.expandedBytes}.`)
  const expanded = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    expanded.set(chunk, offset)
    offset += chunk.byteLength
  }
  return expanded
}

export interface NpzRecordsArraySpecV1 {
  /** `.npy` entry name inside the archive (without extension). */
  readonly name: string
  /** Attribute name for a 1-D array, or one name per column for a 2-D array. */
  readonly fields: readonly string[]
}

export interface NpzRecordsParamsV1 {
  readonly arrays: readonly NpzRecordsArraySpecV1[]
  readonly maxEntries?: number
  readonly maxExpandedBytes?: number
  readonly maxCompressionRatio?: number
  readonly maxElements?: number
  readonly maxRank?: number
}

interface NpyHeaderV1 {
  readonly dtype: string
  readonly shape: readonly number[]
  readonly dataOffset: number
}

function parseNpyHeader(bytes: Uint8Array, maxRank: number, maxElements: number): NpyHeaderV1 {
  if (bytes.byteLength < 10 || bytes[0] !== 0x93 || new TextDecoder().decode(bytes.subarray(1, 6)) !== 'NUMPY') {
    throw new Error('Invalid .npy magic bytes.')
  }
  const major = bytes[6]!
  const minor = bytes[7]!
  if (!((major === 1 || major === 2) && minor === 0)) throw new Error(`Unsupported NPY version ${major}.${minor}.`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true)
  const headerStart = major === 1 ? 10 : 12
  if (headerLength > DEFAULT_MAX_HEADER_BYTES || headerStart + headerLength > bytes.byteLength) throw new Error('Invalid or oversized NPY header.')
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength))
  const dtype = header.match(/['"]descr['"]\s*:\s*['"]([^'"]+)['"]/u)?.[1]
  const fortran = header.match(/['"]fortran_order['"]\s*:\s*(True|False)/u)?.[1]
  const shapeText = header.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/u)?.[1]
  if (!dtype) throw new Error('NPY dtype is missing.')
  if (fortran !== 'False') throw new Error('Fortran-order NPY arrays are not supported.')
  if (shapeText === undefined) throw new Error('NPY shape is missing.')
  const shape = shapeText.split(',').map((part) => part.trim()).filter(Boolean).map(Number)
  if (shape.length === 0 || shape.length > maxRank || shape.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`NPY shape is invalid or exceeds rank ${maxRank}.`)
  }
  const elements = shape.reduce((product, value) => product * value, 1)
  if (!Number.isSafeInteger(elements) || elements > maxElements) throw new Error(`NPY element count exceeds limit ${maxElements}.`)
  return { dtype, shape, dataOffset: headerStart + headerLength }
}

const NPY_SCALARS: Readonly<Record<string, { readonly bytes: number; readonly read: (view: DataView, offset: number, little: boolean) => number }>> = {
  f4: { bytes: 4, read: (view, offset, little) => view.getFloat32(offset, little) },
  f8: { bytes: 8, read: (view, offset, little) => view.getFloat64(offset, little) },
  i1: { bytes: 1, read: (view, offset) => view.getInt8(offset) },
  u1: { bytes: 1, read: (view, offset) => view.getUint8(offset) },
  i2: { bytes: 2, read: (view, offset, little) => view.getInt16(offset, little) },
  u2: { bytes: 2, read: (view, offset, little) => view.getUint16(offset, little) },
  i4: { bytes: 4, read: (view, offset, little) => view.getInt32(offset, little) },
  u4: { bytes: 4, read: (view, offset, little) => view.getUint32(offset, little) },
  i8: { bytes: 8, read: (view, offset, little) => Number(view.getBigInt64(offset, little)) },
  u8: { bytes: 8, read: (view, offset, little) => Number(view.getBigUint64(offset, little)) },
}

/** Reads a numeric NPY array as rows × columns of JS numbers (int64 loses precision beyond 2^53). */
function decodeNpyNumeric(bytes: Uint8Array, maxRank: number, maxElements: number): { readonly rows: number; readonly columns: number; readonly at: (row: number, column: number) => number } {
  const header = parseNpyHeader(bytes, maxRank, maxElements)
  const match = /^([<>|=])([fiu][1248])$/u.exec(header.dtype)
  if (!match) throw new Error(`Unsupported NPY dtype ${header.dtype}; numeric little-endian arrays only.`)
  const little = match[1] !== '>'
  const scalar = NPY_SCALARS[match[2]!]!
  if (header.shape.length > 2) throw new Error('NPY arrays of rank above 2 are not supported for records.')
  const rows = header.shape[0] ?? 0
  const columns = header.shape.length === 2 ? header.shape[1]! : 1
  if (bytes.byteLength - header.dataOffset !== rows * columns * scalar.bytes) throw new Error('NPY payload length does not match shape.')
  const view = new DataView(bytes.buffer, bytes.byteOffset + header.dataOffset, rows * columns * scalar.bytes)
  return { rows, columns, at: (row, column) => scalar.read(view, (row * columns + column) * scalar.bytes, little) }
}

/**
 * Decode several numeric NPY arrays of one NPZ archive into interleaved
 * per-point records: every array contributes its 1-D values or its 2-D
 * columns as attributes, and all arrays must agree on the record count.
 */
export async function decodeNpzRecordsV1(
  buffer: ArrayBuffer,
  params: NpzRecordsParamsV1,
  signal?: AbortSignal,
): Promise<DecodedNumericRecordsV1> {
  if (!Array.isArray(params.arrays) || params.arrays.length === 0) throw new Error('npz records need at least one array.')
  const resolved = {
    arrayName: '',
    maxEntries: params.maxEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES,
    maxExpandedBytes: params.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES,
    maxCompressionRatio: params.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO,
    maxElements: params.maxElements ?? DEFAULT_MAX_EXPANDED_BYTES / 2,
    maxRank: params.maxRank ?? DEFAULT_MAX_RANK,
  }
  const entries = parseBoundedZipEntries(buffer, resolved)
  const decoded: { readonly fields: readonly string[]; readonly array: ReturnType<typeof decodeNpyNumeric> }[] = []
  for (const spec of params.arrays) {
    const target = entries.find((entry) => entry.name === `${spec.name}.npy`)
    if (!target) throw new Error(`NPZ array was not found: ${spec.name}`)
    const array = decodeNpyNumeric(await expandZipEntry(target, signal), resolved.maxRank, resolved.maxElements)
    if (array.columns !== spec.fields.length) {
      throw new Error(`NPZ array ${spec.name} has ${array.columns} column${array.columns === 1 ? '' : 's'}; ${spec.fields.length} field name${spec.fields.length === 1 ? '' : 's'} were given.`)
    }
    decoded.push({ fields: spec.fields, array })
  }
  const pointCount = decoded[0]!.array.rows
  if (decoded.some((entry) => entry.array.rows !== pointCount)) throw new Error('NPZ arrays disagree on the record count.')
  const attributes = decoded.flatMap((entry) => entry.fields)
  const stride = attributes.length
  const values = new Float32Array(pointCount * stride)
  let column = 0
  for (const entry of decoded) {
    for (let field = 0; field < entry.fields.length; field += 1) {
      for (let row = 0; row < pointCount; row += 1) values[row * stride + column] = entry.array.at(row, field)
      column += 1
    }
    throwIfAborted(signal)
  }
  return { values, pointCount, stride, attributes }
}

function decodeNpyUint16(bytes: Uint8Array, params: Required<NpzUint16ParamsV1>): Uint16Array {
  if (bytes.byteLength < 10 || bytes[0] !== 0x93 || new TextDecoder('ascii').decode(bytes.subarray(1, 6)) !== 'NUMPY') {
    throw new Error('Invalid .npy magic bytes.')
  }
  const major = bytes[6]
  const minor = bytes[7]
  if (!((major === 1 || major === 2) && minor === 0)) throw new Error(`Unsupported NPY version ${major}.${minor}.`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerStart = major === 1 ? 10 : 12
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true)
  if (headerLength > DEFAULT_MAX_HEADER_BYTES || headerStart + headerLength > bytes.byteLength) throw new Error('Invalid or oversized NPY header.')
  const header = new TextDecoder('latin1', { fatal: true }).decode(bytes.subarray(headerStart, headerStart + headerLength))
  const dtype = header.match(/['"]descr['"]\s*:\s*['"]([^'"]+)['"]/u)?.[1]
  const fortran = header.match(/['"]fortran_order['"]\s*:\s*(True|False)/u)?.[1]
  const shapeText = header.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/u)?.[1]
  if (dtype !== '<u2' && dtype !== '|u2' && dtype !== '=u2') throw new Error(`Unexpected panoptic dtype: ${dtype ?? 'missing'}`)
  if (fortran !== 'False') throw new Error('Fortran-order NPY arrays are not supported.')
  if (shapeText === undefined) throw new Error('NPY shape is missing.')
  const shape = shapeText.split(',').map((part) => part.trim()).filter(Boolean).map(Number)
  if (shape.length === 0 || shape.length > params.maxRank || shape.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`NPY shape is invalid or exceeds rank ${params.maxRank}.`)
  }
  const elements = shape.reduce((product, value) => product * value, 1)
  if (!Number.isSafeInteger(elements) || elements > params.maxElements) throw new Error(`NPY element count exceeds limit ${params.maxElements}.`)
  const dataOffset = headerStart + headerLength
  const dataBytes = elements * Uint16Array.BYTES_PER_ELEMENT
  if (bytes.byteLength - dataOffset !== dataBytes) throw new Error(`NPY payload length does not match shape (${elements} elements).`)
  const output = new Uint16Array(elements)
  const dataView = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, dataBytes)
  for (let index = 0; index < elements; index += 1) output[index] = dataView.getUint16(index * 2, true)
  return output
}

/** Decode one explicitly selected uint16 NPY array from a bounded NPZ archive. */
export async function decodeNpzUint16V1(
  buffer: ArrayBuffer,
  params: NpzUint16ParamsV1 = {},
  signal?: AbortSignal,
): Promise<Uint16Array> {
  const resolved: Required<NpzUint16ParamsV1> = {
    arrayName: params.arrayName ?? '',
    maxEntries: params.maxEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES,
    maxExpandedBytes: params.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES,
    maxCompressionRatio: params.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO,
    maxElements: params.maxElements ?? DEFAULT_MAX_EXPANDED_BYTES / 2,
    maxRank: params.maxRank ?? DEFAULT_MAX_RANK,
  }
  assertPositiveSafeInteger(resolved.maxEntries, 'maxEntries')
  assertPositiveSafeInteger(resolved.maxExpandedBytes, 'maxExpandedBytes')
  assertPositiveFinite(resolved.maxCompressionRatio, 'maxCompressionRatio')
  assertPositiveSafeInteger(resolved.maxElements, 'maxElements')
  assertPositiveSafeInteger(resolved.maxRank, 'maxRank')
  const entries = parseBoundedZipEntries(buffer, resolved)
  const expectedName = resolved.arrayName ? `${resolved.arrayName}.npy` : ''
  const target = expectedName
    ? entries.find((entry) => entry.name === expectedName)
    : entries.find((entry) => entry.name === 'data.npy') ?? entries.find((entry) => entry.name.endsWith('.npy'))
  if (!target) throw new Error(expectedName ? `NPZ array was not found: ${resolved.arrayName}` : 'No .npy entry found in NPZ archive')
  return decodeNpyUint16(await expandZipEntry(target, signal), resolved)
}

/** Apply a row-major rigid transform to xyz while preserving remaining fields. */
export function transformInterleavedXyzV1(
  decoded: DecodedNumericRecordsV1,
  transform: readonly number[] | null,
): DecodedNumericRecordsV1 {
  if (!transform) return decoded
  if (transform.length !== 16 || transform.some((value) => !Number.isFinite(value))) {
    throw new Error('Rigid transform must contain 16 finite values.')
  }
  const xIndex = decoded.attributes.indexOf('x')
  const yIndex = decoded.attributes.indexOf('y')
  const zIndex = decoded.attributes.indexOf('z')
  if (xIndex < 0 || yIndex < 0 || zIndex < 0) throw new Error('Decoded records must contain x, y, and z fields.')
  const values = new Float32Array(decoded.values)
  for (let index = 0; index < decoded.pointCount; index += 1) {
    const offset = index * decoded.stride
    const x = values[offset + xIndex]
    const y = values[offset + yIndex]
    const z = values[offset + zIndex]
    values[offset + xIndex] = transform[0] * x + transform[1] * y + transform[2] * z + transform[3]
    values[offset + yIndex] = transform[4] * x + transform[5] * y + transform[6] * z + transform[7]
    values[offset + zIndex] = transform[8] * x + transform[9] * y + transform[10] * z + transform[11]
  }
  return { ...decoded, values }
}
