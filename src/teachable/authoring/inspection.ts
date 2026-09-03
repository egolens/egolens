import { tableFromIPC } from '@uwdata/flechette'
import { featherLogicalTypeV1, type FeatherLogicalTypeV1, type FlechetteFieldLike } from '../operators/featherColumns'
import { openParquetFile } from '../../utils/parquet'
import { decodePickleDataFrameV1 } from '../operators/pickleFrames'
import type { SourceInventoryEntryV1 } from './SourceInventory'
import { SourceInventoryV1 } from './SourceInventory'

export const INSPECTION_LIMITS_V1 = Object.freeze({
  maxResultEntries: 2_000,
  maxBytes: 64 * 1024,
  maxTextCharacters: 32 * 1024,
  maxJsonValues: 512,
  maxJsonDepth: 12,
  maxHexBytes: 4 * 1024,
  /** A pickled DataFrame has no footer or leading schema; the whole stream is decoded, bounded by this. */
  maxPickleBytes: 64 * 1024 * 1024,
})

function isPickleEntry(path: string, extension: string): boolean {
  return extension === '.pkl' || extension === '.pickle' || /\.(?:pkl|pickle)\.gz$/u.test(path)
}

export type SourceInspectionModeV1 = 'inventory' | 'metadata' | 'bytes' | 'text' | 'json' | 'json-sample' | 'table-schema'

export interface SourceInspectionRequestV1 {
  readonly mode: SourceInspectionModeV1
  readonly path?: string
  readonly maxBytes?: number
  readonly maxValues?: number
}

export interface SourceInspectionResultV1 {
  readonly mode: SourceInspectionModeV1
  readonly sessionId: string
  readonly path?: string
  readonly truncated: boolean
  readonly data: unknown
}

function boundedInteger(requested: number | undefined, fallback: number, maximum: number, name: string): number {
  const value = requested ?? fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`)
  }
  return value
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Inspection was aborted.', 'AbortError')
}

function schemaOfJson(value: unknown, depth = 0): unknown {
  if (depth >= 4) return typeof value
  if (Array.isArray(value)) {
    const samples = value.slice(0, 8).map((entry) => schemaOfJson(entry, depth + 1))
    return { type: 'array', length: value.length, samples }
  }
  if (value !== null && typeof value === 'object') {
    return {
      type: 'object',
      fields: Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, entry]) => [key, schemaOfJson(entry, depth + 1)])),
    }
  }
  return value === null ? 'null' : typeof value
}

function boundedJson(value: unknown, maximum: number): { readonly value: unknown; readonly count: number; readonly truncated: boolean } {
  let count = 0
  let truncated = false
  const visit = (entry: unknown, depth: number): unknown => {
    if (count >= maximum || depth > INSPECTION_LIMITS_V1.maxJsonDepth) {
      truncated = true
      return '[truncated]'
    }
    count += 1
    if (Array.isArray(entry)) {
      const result: unknown[] = []
      for (const item of entry) {
        if (count >= maximum) {
          truncated = true
          break
        }
        result.push(visit(item, depth + 1))
      }
      return result
    }
    if (entry !== null && typeof entry === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(entry)) {
        if (count >= maximum) {
          truncated = true
          break
        }
        result[key] = visit(item, depth + 1)
      }
      return result
    }
    if (typeof entry === 'bigint') return entry.toString()
    return entry
  }
  return { value: visit(value, 0), count, truncated }
}

function numericSummary(value: unknown): Readonly<Record<string, number | null>> {
  let count = 0
  let finiteCount = 0
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  let sum = 0
  let visited = 0
  const visit = (entry: unknown, depth = 0): void => {
    if (visited >= 4096 || depth > INSPECTION_LIMITS_V1.maxJsonDepth) return
    visited += 1
    if (typeof entry === 'number') {
      count += 1
      if (Number.isFinite(entry)) {
        finiteCount += 1
        minimum = Math.min(minimum, entry)
        maximum = Math.max(maximum, entry)
        sum += entry
      }
    } else if (Array.isArray(entry)) entry.forEach((item) => visit(item, depth + 1))
    else if (entry !== null && typeof entry === 'object') Object.values(entry).forEach((item) => visit(item, depth + 1))
  }
  visit(value)
  return {
    count,
    finiteCount,
    minimum: finiteCount ? minimum : null,
    maximum: finiteCount ? maximum : null,
    mean: finiteCount ? sum / finiteCount : null,
  }
}

function metadata(entry: SourceInventoryEntryV1): SourceInventoryEntryV1 {
  return entry
}

const ARROW_FILE_MAGIC = 'ARROW1'

/** Decodes only the leading Arrow IPC schema message from a bounded file prefix. */
export function featherSchemaFromPrefixV1(prefix: Uint8Array, maxBytes: number): readonly {
  readonly name: string
  readonly logicalType: FeatherLogicalTypeV1 | null
  readonly arrowTypeId: number
  readonly nullable: boolean
}[] {
  let offset = 0
  if (prefix.length >= 8 && new TextDecoder().decode(prefix.subarray(0, ARROW_FILE_MAGIC.length)) === ARROW_FILE_MAGIC) offset = 8
  if (prefix.length < offset + 8) throw new Error('Feather schema inspection needs at least the leading IPC message header.')
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength)
  let metadataLength = view.getInt32(offset, true)
  let metadataOffset = offset + 4
  if (metadataLength === -1) {
    metadataLength = view.getInt32(offset + 4, true)
    metadataOffset = offset + 8
  }
  const end = metadataOffset + metadataLength
  if (metadataLength <= 0 || end > prefix.length) {
    throw new Error(`Feather schema message does not fit within maxBytes (${maxBytes}); raise maxBytes for this file.`)
  }
  const table = tableFromIPC(prefix.subarray(offset, end), { useProxy: false })
  return (table.schema.fields as readonly FlechetteFieldLike[]).map((field) => ({
    name: field.name,
    logicalType: featherLogicalTypeV1(field),
    arrowTypeId: field.type.typeId,
    nullable: field.nullable !== false,
  }))
}

/**
 * Extracts complete leading elements of a top-level JSON array from a text
 * prefix. Strings and escapes are respected; an element cut off by the prefix
 * boundary is dropped and reported through `complete: false`.
 */
export function leadingJsonArrayRecordsV1(text: string, maximum: number): { readonly records: unknown[]; readonly complete: boolean } {
  const start = text.indexOf('[')
  if (start < 0) throw new Error('json-sample inspection requires a top-level JSON array.')
  const records: unknown[] = []
  let depth = 0, inString = false, escaped = false, elementStart = -1
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; if (depth === 0 && elementStart < 0) elementStart = index; continue }
    if (char === '{' || char === '[') { if (depth === 0 && elementStart < 0) elementStart = index; depth += 1; continue }
    if (char === '}' || char === ']') {
      if (depth === 0 && char === ']') {
        if (elementStart >= 0) records.push(JSON.parse(text.slice(elementStart, index)))
        return { records, complete: true }
      }
      depth -= 1
      continue
    }
    if (depth === 0 && elementStart < 0 && !/[\s,]/u.test(char)) elementStart = index
    if (depth === 0 && (char === ',' ) && elementStart >= 0) {
      records.push(JSON.parse(text.slice(elementStart, index)))
      elementStart = -1
      if (records.length >= maximum) return { records, complete: false }
    }
  }
  return { records, complete: false }
}

export async function inspectSourceInventoryV1(
  inventory: SourceInventoryV1,
  request: SourceInspectionRequestV1,
  signal?: AbortSignal,
): Promise<SourceInspectionResultV1> {
  abortIfNeeded(signal)
  if (request.mode === 'inventory') {
    const snapshot = inventory.snapshot()
    const entries = snapshot.entries.slice(0, INSPECTION_LIMITS_V1.maxResultEntries)
    return {
      mode: request.mode,
      sessionId: inventory.sessionId,
      truncated: snapshot.truncated || entries.length < snapshot.entries.length,
      data: { entries, totalEntries: snapshot.entries.length },
    }
  }
  if (!request.path) throw new Error(`${request.mode} inspection requires an exact inventory path.`)
  const entry = inventory.entry(request.path)
  if (!entry) throw new Error(`Inventory path is not authorized: ${request.path}`)
  if (request.mode === 'metadata') {
    return { mode: request.mode, sessionId: inventory.sessionId, path: entry.path, truncated: false, data: metadata(entry) }
  }

  const byteSource = inventory.resolveAuthorizedSource()
  const maxBytes = boundedInteger(request.maxBytes, 16 * 1024, INSPECTION_LIMITS_V1.maxBytes, 'maxBytes')
  if (request.mode === 'table-schema' && entry.extension === '.parquet') {
    const parquet = await openParquetFile(entry.path, await byteSource.asyncBuffer(entry.path))
    abortIfNeeded(signal)
    const schema = (parquet.metadata.schema as unknown as readonly Record<string, unknown>[]).map((column) => ({
      name: column.name,
      type: column.type,
      convertedType: column.converted_type,
      repetitionType: column.repetition_type,
      numChildren: column.num_children,
    }))
    return {
      mode: request.mode,
      sessionId: inventory.sessionId,
      path: entry.path,
      truncated: false,
      data: { numRows: parquet.numRows, rowGroups: parquet.rowGroups, schema },
    }
  }
  if (request.mode === 'table-schema' && entry.extension === '.feather') {
    // Arrow IPC (file or stream): the schema is the first message, so a
    // bounded prefix is enough; the record batches are never read here.
    const prefix = new Uint8Array(await byteSource.read(entry.path, { end: Math.min(entry.size, maxBytes), signal }))
    abortIfNeeded(signal)
    return {
      mode: request.mode,
      sessionId: inventory.sessionId,
      path: entry.path,
      truncated: false,
      data: { byteLength: entry.size, schema: featherSchemaFromPrefixV1(prefix, maxBytes) },
    }
  }
  if (request.mode === 'table-schema' && isPickleEntry(entry.path, entry.extension)) {
    // pandas DataFrame pickles (optionally gzip): the column index precedes the
    // block values but the stream cannot be parsed partially, so the whole file
    // is decoded under maxPickleBytes and only names, types, samples, and the
    // row count are returned.
    if (entry.size > INSPECTION_LIMITS_V1.maxPickleBytes) throw new Error(`Pickle exceeds ${INSPECTION_LIMITS_V1.maxPickleBytes} bytes.`)
    const bytes = new Uint8Array(await byteSource.read(entry.path, { end: entry.size, signal }))
    abortIfNeeded(signal)
    const frame = await decodePickleDataFrameV1(bytes, { maxExpandedBytes: INSPECTION_LIMITS_V1.maxPickleBytes })
    const schema = frame.columns.map((column) => {
      const first = column.values.find((value) => value !== null && value !== undefined)
      return { name: column.name, type: first === undefined ? 'null' : typeof first, sample: column.values.slice(0, 2) }
    })
    return {
      mode: request.mode,
      sessionId: inventory.sessionId,
      path: entry.path,
      truncated: false,
      data: { byteLength: entry.size, numRows: frame.rowCount, schema },
    }
  }
  if (request.mode === 'table-schema') {
    throw new Error(`CAPABILITY_GAP: table schema inspection does not support ${entry.extension || 'this file type'} yet.`)
  }
  if (request.mode === 'json-sample') {
    // Leading records of a large JSON array without reading the whole file.
    const prefix = new Uint8Array(await byteSource.read(entry.path, { end: Math.min(entry.size, maxBytes), signal }))
    abortIfNeeded(signal)
    const maximum = boundedInteger(request.maxValues, 8, 64, 'maxValues')
    const sample = leadingJsonArrayRecordsV1(new TextDecoder('utf-8').decode(prefix), maximum)
    return {
      mode: request.mode,
      sessionId: inventory.sessionId,
      path: entry.path,
      truncated: sample.complete === false || entry.size > prefix.length,
      data: { byteLength: entry.size, recordCount: sample.records.length, schema: schemaOfJson(sample.records), records: sample.records },
    }
  }
  if ((request.mode === 'json' || request.mode === 'text') && entry.size > maxBytes) {
    throw new Error(`${request.mode} inspection requires the complete file to fit within maxBytes (${entry.size} > ${maxBytes}).`)
  }
  const bytes = new Uint8Array(await byteSource.read(entry.path, {
    end: Math.min(entry.size, maxBytes),
    signal,
  }))
  abortIfNeeded(signal)
  if (request.mode === 'bytes') {
    const shown = bytes.slice(0, Math.min(bytes.length, INSPECTION_LIMITS_V1.maxHexBytes))
    return {
      mode: request.mode,
      sessionId: inventory.sessionId,
      path: entry.path,
      truncated: shown.length < entry.size,
      data: { byteLength: entry.size, hex: [...shown].map((value) => value.toString(16).padStart(2, '0')).join('') },
    }
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (request.mode === 'text') {
    const shown = text.slice(0, INSPECTION_LIMITS_V1.maxTextCharacters)
    return { mode: request.mode, sessionId: inventory.sessionId, path: entry.path, truncated: shown.length < text.length, data: { text: shown } }
  }
  const parsed: unknown = JSON.parse(text)
  const bounded = boundedJson(parsed, boundedInteger(request.maxValues, 128, INSPECTION_LIMITS_V1.maxJsonValues, 'maxValues'))
  return {
    mode: request.mode,
    sessionId: inventory.sessionId,
    path: entry.path,
    truncated: bounded.truncated,
    data: { schema: schemaOfJson(parsed), numeric: numericSummary(parsed), sample: bounded.value, valueCount: bounded.count },
  }
}
