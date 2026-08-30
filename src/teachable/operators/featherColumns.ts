import { setCompressionCodec, tableFromIPC } from '@uwdata/flechette'
import lz4 from 'lz4js'
import type { DecodedNumericRecordsV1 } from './binaryReaders'

export type FeatherLogicalTypeV1 =
  | 'float16'
  | 'float32'
  | 'float64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'utf8'

export interface FeatherColumnSpecV1 {
  readonly name: string
  readonly type: FeatherLogicalTypeV1
}

export interface FeatherColumnsParamsV1 {
  readonly columns: readonly FeatherColumnSpecV1[]
  readonly maxInputBytes: number
  readonly maxRows: number
  readonly maxOutputBytes: number
}

export type FeatherColumnValuesV1 = ArrayLike<number | bigint | string>

export interface DecodedFeatherColumnsV1 {
  readonly columns: Readonly<Record<string, FeatherColumnValuesV1>>
  readonly numRows: number
}

interface FlechetteFieldLike {
  readonly name: string
  readonly type: {
    readonly typeId: number
    readonly precision?: number
    readonly bitWidth?: number
    readonly signed?: boolean
    readonly dictionary?: { readonly typeId: number }
  }
}

setCompressionCodec(0, {
  decode(buffer: Uint8Array): Uint8Array { return lz4.decompress(buffer) },
  encode(buffer: Uint8Array): Uint8Array { return lz4.compress(buffer) },
})

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`)
}

export function assertValidFeatherColumnsParamsV1(params: FeatherColumnsParamsV1): void {
  if (!Array.isArray(params.columns) || params.columns.length === 0 || params.columns.length > 128) {
    throw new Error('columns must contain between 1 and 128 entries.')
  }
  const names = new Set<string>()
  for (const column of params.columns) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(column.name)) throw new Error(`Invalid Feather column name: ${column.name}`)
    if (names.has(column.name)) throw new Error(`Duplicate Feather column: ${column.name}`)
    names.add(column.name)
  }
  assertPositiveSafeInteger(params.maxInputBytes, 'maxInputBytes')
  assertPositiveSafeInteger(params.maxRows, 'maxRows')
  assertPositiveSafeInteger(params.maxOutputBytes, 'maxOutputBytes')
}

function logicalType(field: FlechetteFieldLike): FeatherLogicalTypeV1 | null {
  const type = field.type
  if (type.typeId === -1 && type.dictionary?.typeId === 5) return 'utf8'
  if (type.typeId === 5) return 'utf8'
  if (type.typeId === 3) {
    if (type.precision === 0) return 'float16'
    if (type.precision === 1) return 'float32'
    if (type.precision === 2) return 'float64'
    return null
  }
  if (type.typeId === 2 && type.bitWidth) {
    if (type.bitWidth === 64 && type.signed) return 'int64'
    const prefix = type.signed ? 'int' : 'uint'
    const candidate = `${prefix}${type.bitWidth}`
    if (['int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32'].includes(candidate)) {
      return candidate as FeatherLogicalTypeV1
    }
  }
  return null
}

function columnByteLength(values: FeatherColumnValuesV1): number {
  if (ArrayBuffer.isView(values)) return values.byteLength
  let bytes = 0
  const encoder = new TextEncoder()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    bytes += typeof value === 'string' ? encoder.encode(value).byteLength : 8
  }
  return bytes
}

/** Decode explicitly typed columns from a bounded Arrow IPC / Feather file. */
export function decodeFeatherColumnsV1(
  buffer: ArrayBuffer,
  params: FeatherColumnsParamsV1,
  signal?: AbortSignal,
): DecodedFeatherColumnsV1 {
  throwIfAborted(signal)
  assertValidFeatherColumnsParamsV1(params)
  if (buffer.byteLength > params.maxInputBytes) {
    throw new Error(`Feather input size ${buffer.byteLength} exceeds limit ${params.maxInputBytes}.`)
  }

  let table: ReturnType<typeof tableFromIPC>
  try {
    table = tableFromIPC(buffer, { useProxy: false, useBigInt: true })
  } catch (error) {
    throw new Error(`Invalid or unsupported Feather/Arrow IPC input: ${error instanceof Error ? error.message : String(error)}`)
  }
  throwIfAborted(signal)
  if (!Number.isSafeInteger(table.numRows) || table.numRows < 0 || table.numRows > params.maxRows) {
    throw new Error(`Feather row count ${table.numRows} exceeds limit ${params.maxRows}.`)
  }

  const fields = new Map(
    (table.schema.fields as readonly FlechetteFieldLike[]).map((field) => [field.name, field]),
  )
  const columns: Record<string, FeatherColumnValuesV1> = {}
  let outputBytes = 0
  for (const spec of params.columns) {
    throwIfAborted(signal)
    const field = fields.get(spec.name)
    if (!field) throw new Error(`Required Feather column is missing: ${spec.name}`)
    const actualType = logicalType(field)
    if (actualType !== spec.type) {
      throw new Error(`Feather column ${spec.name} has type ${actualType ?? 'unsupported'}; expected ${spec.type}.`)
    }
    const column = table.getChild(spec.name)
    if (!column) throw new Error(`Required Feather column could not be read: ${spec.name}`)
    const values = column.toArray() as FeatherColumnValuesV1
    if (values.length !== table.numRows) {
      throw new Error(`Feather column ${spec.name} has ${values.length} values for ${table.numRows} rows.`)
    }
    outputBytes += columnByteLength(values)
    if (!Number.isSafeInteger(outputBytes) || outputBytes > params.maxOutputBytes) {
      throw new Error(`Feather selected output exceeds limit ${params.maxOutputBytes}.`)
    }
    columns[spec.name] = values
  }
  return { columns, numRows: table.numRows }
}

export async function readFeatherColumnsV1(
  input: File | ArrayBuffer,
  params: FeatherColumnsParamsV1,
  signal?: AbortSignal,
): Promise<DecodedFeatherColumnsV1> {
  throwIfAborted(signal)
  const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer()
  return decodeFeatherColumnsV1(buffer, params, signal)
}

/** Interleave selected numeric Feather columns into the renderer-neutral float layout. */
export function interleaveFeatherNumericColumnsV1(
  decoded: DecodedFeatherColumnsV1,
  attributes: readonly string[],
  signal?: AbortSignal,
): DecodedNumericRecordsV1 {
  if (attributes.length === 0 || attributes.length > 64 || new Set(attributes).size !== attributes.length) {
    throw new Error('Interleaved Feather attributes must contain 1–64 unique names.')
  }
  const selected = attributes.map((name) => {
    const column = decoded.columns[name]
    if (!column) throw new Error(`Selected Feather column is missing: ${name}`)
    return column
  })
  const values = new Float32Array(decoded.numRows * selected.length)
  for (let row = 0; row < decoded.numRows; row += 1) {
    if ((row & 0x3fff) === 0) throwIfAborted(signal)
    for (let column = 0; column < selected.length; column += 1) {
      const value = Number(selected[column][row])
      if (!Number.isFinite(value)) throw new Error(`Non-finite Feather value in ${attributes[column]} at row ${row}.`)
      values[row * selected.length + column] = value
    }
  }
  return {
    values,
    pointCount: decoded.numRows,
    stride: selected.length,
    attributes: [...attributes],
  }
}
