import type { ParquetRow } from '../../utils/merge'
import { readAllRows, readRowRange, type WaymoParquetFile } from '../../utils/parquet'

export type ParquetLogicalTypeV1 =
  | 'bigint'
  | 'integer'
  | 'number'
  | 'utf8'
  | 'boolean'
  | 'binary'
  | 'number-list'
  | 'integer-list'
  | 'boolean-list'

export interface ParquetColumnSpecV1 {
  readonly name: string
  readonly type: ParquetLogicalTypeV1
  readonly optional?: boolean
  readonly nullable?: boolean
}

export interface ParquetColumnsParamsV1 {
  readonly columns: readonly ParquetColumnSpecV1[]
  readonly maxInputBytes: number
  readonly maxRows: number
  readonly maxOutputBytes: number
}

export interface ParquetReadOptionsV1 {
  readonly rowStart?: number
  readonly rowEnd?: number
  readonly signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`)
}

export function assertValidParquetColumnsParamsV1(params: ParquetColumnsParamsV1): void {
  if (!Array.isArray(params.columns) || params.columns.length === 0 || params.columns.length > 256) {
    throw new Error('columns must contain between 1 and 256 entries.')
  }
  const names = new Set<string>()
  for (const column of params.columns) {
    const hasControlCharacter = typeof column.name === 'string'
      && [...column.name].some((character) => character.charCodeAt(0) <= 0x1f)
    if (typeof column.name !== 'string' || column.name.length === 0 || column.name.length > 512 || hasControlCharacter) {
      throw new Error(`Invalid Parquet column name: ${column.name}`)
    }
    if (names.has(column.name)) throw new Error(`Duplicate Parquet column: ${column.name}`)
    names.add(column.name)
  }
  positiveSafeInteger(params.maxInputBytes, 'maxInputBytes')
  positiveSafeInteger(params.maxRows, 'maxRows')
  positiveSafeInteger(params.maxOutputBytes, 'maxOutputBytes')
}

function isList(value: unknown): value is ArrayLike<unknown> {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))
}

/**
 * Validate every element of a decoded list in place. Range-image lists hold
 * tens of millions of numbers per row group; copying them (`Array.from`) for
 * validation doubled the renderer's peak memory and crashed the authoring
 * preview before any limit could fire.
 */
function everyListEntry(value: ArrayLike<unknown>, predicate: (entry: unknown) => boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!predicate(value[index])) return false
  }
  return true
}

const isFiniteNumber = (entry: unknown): boolean => typeof entry === 'number' && Number.isFinite(entry)
const isSafeInteger = (entry: unknown): boolean => typeof entry === 'number' && Number.isSafeInteger(entry)
const isBoolean = (entry: unknown): boolean => typeof entry === 'boolean'

function matchesType(value: unknown, type: ParquetLogicalTypeV1): boolean {
  switch (type) {
    case 'bigint': return typeof value === 'bigint'
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'utf8': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'binary': return value instanceof ArrayBuffer || value instanceof Uint8Array
    case 'number-list': return isList(value) && everyListEntry(value, isFiniteNumber)
    case 'integer-list': return isList(value) && everyListEntry(value, isSafeInteger)
    case 'boolean-list': return isList(value) && everyListEntry(value, isBoolean)
  }
}

function valueBytes(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength
  if (typeof value === 'boolean') return 1
  if (typeof value === 'number' || typeof value === 'bigint') return 8
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (Array.isArray(value)) {
    // Flat numeric/boolean lists dominate; account for them without
    // recursion or allocation, and fall back to recursion only for nesting.
    let total = 0
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index]
      total += typeof entry === 'number' || typeof entry === 'bigint' ? 8
        : typeof entry === 'boolean' ? 1
          : valueBytes(entry)
    }
    return total
  }
  throw new Error('Unsupported decoded Parquet value.')
}

/**
 * Upper bound on the transient decoded footprint of one Parquet read. Parquet
 * decompresses whole row groups, so a five-row frame read still materializes
 * every selected column of every overlapping row group as JavaScript arrays;
 * the browser renderer, not the recipe, decides when that is fatal. Wide
 * (list/binary) columns are therefore read one at a time so the peak equals
 * the largest single column, and each read is measured against this ceiling
 * before any page is decoded. The value sits below the renderer heap limits
 * observed for counted Chrome and above the largest shipped Waymo range-image
 * column (about 1.4 GB decoded per row group).
 */
export const PARQUET_MAX_DECODED_BYTES_PER_READ_V1 = 2 * 1024 * 1024 * 1024

const WIDE_TYPES: ReadonlySet<ParquetLogicalTypeV1> = new Set(['number-list', 'integer-list', 'boolean-list', 'binary'])

export interface ParquetDecodeEstimateV1 {
  /** Estimated decoded bytes for the selected columns of the overlapping row groups. */
  readonly bytes: number
  readonly rowGroups: number
  readonly columns: readonly string[]
}

/**
 * Estimate, from footer metadata only, how many bytes the selected columns
 * of the row groups overlapping `[rowStart, rowEnd)` occupy once decoded.
 * hyparquet materializes every leaf value as a JavaScript number, boolean, or
 * bigint (8 bytes each) regardless of the stored width or compression, so the
 * leaf value count, not the uncompressed size, drives the estimate; strings
 * and binary payloads add their uncompressed bytes.
 */
export function estimateParquetDecodedBytesV1(
  file: WaymoParquetFile,
  columns: readonly ParquetColumnSpecV1[],
  rowStart: number,
  rowEnd: number,
): ParquetDecodeEstimateV1 {
  const selected = new Map(columns.map((column) => [column.name, column.type]))
  let bytes = 0
  let rowGroups = 0
  file.rowGroups.forEach((group, index) => {
    if (group.rowEnd <= rowStart || group.rowStart >= rowEnd) return
    rowGroups += 1
    for (const chunk of file.metadata.row_groups[index]?.columns ?? []) {
      const meta = chunk.meta_data
      const leaf = meta?.path_in_schema?.[0]
      const type = typeof leaf === 'string' ? selected.get(leaf) : undefined
      if (!meta || !type) continue
      const values = Number(meta.num_values ?? 0)
      const uncompressed = Number(meta.total_uncompressed_size ?? 0)
      if (!Number.isFinite(values) || values < 0 || !Number.isFinite(uncompressed) || uncompressed < 0) {
        throw new Error(`Parquet column ${leaf} has invalid chunk metadata.`)
      }
      bytes += type === 'utf8' || type === 'binary' ? uncompressed + values * 8 : values * 8
    }
  })
  return { bytes, rowGroups, columns: columns.map((column) => column.name) }
}

function assertDecodeBudget(file: WaymoParquetFile, columns: readonly ParquetColumnSpecV1[], rowStart: number, rowEnd: number): void {
  const estimate = estimateParquetDecodedBytesV1(file, columns, rowStart, rowEnd)
  if (estimate.bytes > PARQUET_MAX_DECODED_BYTES_PER_READ_V1) {
    throw new Error(
      `PARQUET_DECODE_BUDGET_EXCEEDED: decoding ${estimate.rowGroups} row group(s) of `
      + `[${estimate.columns.join(', ')}] needs about ${estimate.bytes} bytes, above the `
      + `${PARQUET_MAX_DECODED_BYTES_PER_READ_V1}-byte per-read ceiling. Select a narrower column, or a `
      + 'source whose row groups are smaller.',
    )
  }
}

/**
 * Split a projection into one read for every wide column plus one read for
 * all scalar columns, so the transient decode peak is the largest column
 * rather than the sum of all of them.
 */
function readPlansV1(columns: readonly ParquetColumnSpecV1[]): readonly (readonly ParquetColumnSpecV1[])[] {
  const scalars = columns.filter((column) => !WIDE_TYPES.has(column.type))
  const wide = columns.filter((column) => WIDE_TYPES.has(column.type))
  if (wide.length <= 1) return [columns]
  return [...(scalars.length > 0 ? [scalars] : []), ...wide.map((column) => [column])]
}

function validateRows(
  rows: readonly ParquetRow[],
  params: ParquetColumnsParamsV1,
  signal?: AbortSignal,
): ParquetRow[] {
  if (rows.length > params.maxRows) {
    throw new Error(`Parquet row count ${rows.length} exceeds limit ${params.maxRows}.`)
  }
  let outputBytes = 0
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if ((rowIndex & 0x3ff) === 0) throwIfAborted(signal)
    const row = rows[rowIndex]
    for (const spec of params.columns) {
      if (!(spec.name in row)) {
        if (spec.optional) continue
        throw new Error(`Required Parquet column is missing: ${spec.name}`)
      }
      const value = row[spec.name]
      if (value === null || value === undefined) {
        if (spec.nullable) continue
        throw new Error(`Parquet column ${spec.name} is null at row ${rowIndex}.`)
      }
      if (!matchesType(value, spec.type)) {
        throw new Error(`Parquet column ${spec.name} does not match declared type ${spec.type} at row ${rowIndex}.`)
      }
      outputBytes += valueBytes(value)
      if (!Number.isSafeInteger(outputBytes) || outputBytes > params.maxOutputBytes) {
        throw new Error(`Parquet selected output exceeds limit ${params.maxOutputBytes}.`)
      }
    }
  }
  return [...rows]
}

/** Read and validate an explicit, bounded Parquet column projection. */
export async function readParquetColumnsV1(
  file: WaymoParquetFile,
  params: ParquetColumnsParamsV1,
  options: ParquetReadOptionsV1 = {},
): Promise<ParquetRow[]> {
  throwIfAborted(options.signal)
  assertValidParquetColumnsParamsV1(params)
  if (file.buffer.byteLength > params.maxInputBytes) {
    throw new Error(`Parquet input size ${file.buffer.byteLength} exceeds limit ${params.maxInputBytes}.`)
  }
  const rowStart = options.rowStart ?? 0
  const rowEnd = options.rowEnd ?? file.numRows
  if (!Number.isSafeInteger(rowStart) || !Number.isSafeInteger(rowEnd) || rowStart < 0 || rowEnd < rowStart || rowEnd > file.numRows) {
    throw new RangeError(`Invalid Parquet row range [${rowStart}, ${rowEnd}).`)
  }
  if (rowEnd - rowStart > params.maxRows) {
    throw new Error(`Parquet row range ${rowEnd - rowStart} exceeds limit ${params.maxRows}.`)
  }
  const plans = readPlansV1(params.columns)
  for (const plan of plans) assertDecodeBudget(file, plan, rowStart, rowEnd)
  let merged: ParquetRow[] | null = null
  for (const plan of plans) {
    const columns = plan.map((column) => column.name)
    const utf8 = !plan.some((column) => column.type === 'binary')
    const rows = rowStart === 0 && rowEnd === file.numRows
      ? await readAllRows(file, columns, { utf8 })
      : await readRowRange(file, rowStart, rowEnd, columns, { utf8 })
    throwIfAborted(options.signal)
    if (merged === null) merged = rows
    else {
      if (rows.length !== merged.length) throw new Error('Parquet column reads returned different row counts.')
      for (let index = 0; index < rows.length; index += 1) Object.assign(merged[index], rows[index])
    }
  }
  return validateRows(merged ?? [], params, options.signal)
}
