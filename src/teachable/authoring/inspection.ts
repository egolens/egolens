import { openParquetFile } from '../../utils/parquet'
import type { SourceInventoryEntryV1 } from './SourceInventory'
import { SourceInventoryV1 } from './SourceInventory'

export const INSPECTION_LIMITS_V1 = Object.freeze({
  maxResultEntries: 2_000,
  maxBytes: 64 * 1024,
  maxTextCharacters: 32 * 1024,
  maxJsonValues: 512,
  maxJsonDepth: 12,
  maxHexBytes: 4 * 1024,
})

export type SourceInspectionModeV1 = 'inventory' | 'metadata' | 'bytes' | 'text' | 'json' | 'table-schema'

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

  const file = inventory.resolveAuthorizedFile(entry.path)
  const maxBytes = boundedInteger(request.maxBytes, 16 * 1024, INSPECTION_LIMITS_V1.maxBytes, 'maxBytes')
  if (request.mode === 'table-schema' && entry.extension === '.parquet') {
    const parquet = await openParquetFile(entry.path, file)
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
  if (request.mode === 'table-schema') {
    throw new Error(`CAPABILITY_GAP: table schema inspection does not support ${entry.extension || 'this file type'} yet.`)
  }
  if ((request.mode === 'json' || request.mode === 'text') && file.size > maxBytes) {
    throw new Error(`${request.mode} inspection requires the complete file to fit within maxBytes (${file.size} > ${maxBytes}).`)
  }
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, maxBytes)).arrayBuffer())
  abortIfNeeded(signal)
  if (request.mode === 'bytes') {
    const shown = bytes.slice(0, Math.min(bytes.length, INSPECTION_LIMITS_V1.maxHexBytes))
    return {
      mode: request.mode,
      sessionId: inventory.sessionId,
      path: entry.path,
      truncated: shown.length < file.size,
      data: { byteLength: file.size, hex: [...shown].map((value) => value.toString(16).padStart(2, '0')).join('') },
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
