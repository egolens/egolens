export interface JsonRecordsParamsV1 {
  readonly maxInputBytes?: number
  readonly maxRecords?: number
  readonly maxDepth?: number
  readonly maxRecordKeys?: number
}

const encoder = new TextEncoder()

function inspectValue(value: unknown, depth: number, maxDepth: number, maxKeys: number): void {
  if (depth > maxDepth) throw new Error(`JSON value exceeds depth limit ${maxDepth}.`)
  if (Array.isArray(value)) {
    for (const item of value) inspectValue(item, depth + 1, maxDepth, maxKeys)
    return
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length > maxKeys) throw new Error(`JSON record exceeds key limit ${maxKeys}.`)
    for (const [, item] of entries) inspectValue(item, depth + 1, maxDepth, maxKeys)
  }
}

/** Parse a bounded JSON array without revivers, object materialization hooks, or executable values. */
export function decodeJsonRecordsV1<T>(text: string, params: JsonRecordsParamsV1 = {}): T[] {
  const maxInputBytes = params.maxInputBytes ?? 400 * 1024 * 1024
  const maxRecords = params.maxRecords ?? 5_000_000
  const maxDepth = params.maxDepth ?? 32
  const maxRecordKeys = params.maxRecordKeys ?? 512
  const byteLength = encoder.encode(text).byteLength
  if (byteLength > maxInputBytes) throw new Error(`JSON input size ${byteLength} exceeds limit ${maxInputBytes}.`)
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error(`expected a JSON array, got ${typeof parsed}`)
  if (parsed.length > maxRecords) throw new Error(`JSON record count ${parsed.length} exceeds limit ${maxRecords}.`)
  for (const row of parsed) inspectValue(row, 0, maxDepth, maxRecordKeys)
  return parsed as T[]
}
