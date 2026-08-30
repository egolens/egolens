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

function matchesType(value: unknown, type: ParquetLogicalTypeV1): boolean {
  switch (type) {
    case 'bigint': return typeof value === 'bigint'
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'utf8': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'binary': return value instanceof ArrayBuffer || value instanceof Uint8Array
    case 'number-list':
      return isList(value) && Array.from(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    case 'integer-list':
      return isList(value) && Array.from(value).every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry))
    case 'boolean-list':
      return isList(value) && Array.from(value).every((entry) => typeof entry === 'boolean')
  }
}

function valueBytes(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength
  if (typeof value === 'boolean') return 1
  if (typeof value === 'number' || typeof value === 'bigint') return 8
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (Array.isArray(value)) return value.reduce((total, entry) => total + valueBytes(entry), 0)
  throw new Error('Unsupported decoded Parquet value.')
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
  const columns = params.columns.map((column) => column.name)
  const utf8 = !params.columns.some((column) => column.type === 'binary')
  const rows = rowStart === 0 && rowEnd === file.numRows
    ? await readAllRows(file, columns, { utf8 })
    : await readRowRange(file, rowStart, rowEnd, columns, { utf8 })
  throwIfAborted(options.signal)
  return validateRows(rows, params, options.signal)
}
