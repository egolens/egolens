/**
 * Dataset-neutral text readers for the formats that raw drives ship as plain
 * text: whitespace/CSV tables (OXTS rows, per-frame sensor tables), key-value
 * calibration files (`P0: 7.1 0 6.0 ...`), and one-value-per-line lists
 * (timestamps). Every layout yields plain records.
 */
export type TextTableLayoutV1 = 'delimited' | 'key-values' | 'lines'

export interface TextTableParamsV1 {
  readonly layout: TextTableLayoutV1
  /** 'whitespace' (default) or a literal delimiter such as ',' for delimited/key-values value splitting. */
  readonly delimiter?: string
  /** delimited: column names; without them, columns are named c0, c1, … */
  readonly columns?: readonly string[]
  /** delimited: skip the first line (or use it as column names when columns are absent). */
  readonly header?: boolean
  /** lines: the field name for each line's value (default 'value'). */
  readonly field?: string
  /** key-values: separator between key and values (default ':'). */
  readonly keySeparator?: string
  /** Convert numeric-looking values to numbers (default true). */
  readonly numeric?: boolean
  /** Add the 0-based line index under this field. */
  readonly indexField?: string
  readonly maxRows?: number
  readonly maxColumns?: number
}

const DEFAULT_MAX_ROWS = 2_000_000
const DEFAULT_MAX_COLUMNS = 512

function splitValues(line: string, delimiter: string | undefined): string[] {
  if (!delimiter || delimiter === 'whitespace') return line.trim().split(/\s+/u).filter((part) => part.length > 0)
  return line.split(delimiter).map((part) => part.trim())
}

function coerce(value: string, numeric: boolean): string | number {
  if (!numeric) return value
  if (value.length === 0) return value
  const number = Number(value)
  return Number.isFinite(number) && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/iu.test(value) ? number : value
}

export function decodeTextTableV1(text: string, params: TextTableParamsV1): Record<string, unknown>[] {
  const numeric = params.numeric !== false
  const maxRows = params.maxRows ?? DEFAULT_MAX_ROWS
  const maxColumns = params.maxColumns ?? DEFAULT_MAX_COLUMNS
  const lines = text.split(/\r?\n/u)
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop()
  const rows: Record<string, unknown>[] = []
  const stamp = (row: Record<string, unknown>, index: number) => (params.indexField ? { ...row, [params.indexField]: index } : row)
  if (params.layout === 'lines') {
    const field = params.field ?? 'value'
    lines.forEach((line, index) => {
      if (line.trim().length === 0) return
      if (rows.length >= maxRows) throw new Error(`text table exceeds maxRows ${maxRows}`)
      rows.push(stamp({ [field]: coerce(line.trim(), numeric) }, index))
    })
    return rows
  }
  if (params.layout === 'key-values') {
    const separator = params.keySeparator ?? ':'
    const row: Record<string, unknown> = {}
    for (const line of lines) {
      const at = line.indexOf(separator)
      if (at <= 0) continue
      const key = line.slice(0, at).trim()
      const values = splitValues(line.slice(at + separator.length), params.delimiter).map((value) => coerce(value, numeric))
      if (values.length > maxColumns) throw new Error(`key "${key}" has more than maxColumns ${maxColumns} values`)
      row[key] = values.length === 1 ? values[0] : values
    }
    return [row]
  }
  let columns = params.columns ? [...params.columns] : null
  let start = 0
  if (params.header) {
    const headerLine = lines.find((line) => line.trim().length > 0)
    if (headerLine === undefined) return []
    start = lines.indexOf(headerLine) + 1
    if (!columns) columns = splitValues(headerLine, params.delimiter)
  }
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim().length === 0) continue
    const values = splitValues(line, params.delimiter)
    if (values.length > maxColumns) throw new Error(`line ${index} has more than maxColumns ${maxColumns} values`)
    if (rows.length >= maxRows) throw new Error(`text table exceeds maxRows ${maxRows}`)
    const names = columns ?? values.map((_, column) => `c${column}`)
    const row: Record<string, unknown> = {}
    values.forEach((value, column) => { const name = names[column] ?? `c${column}`; row[name] = coerce(value, numeric) })
    rows.push(stamp(row, index - start))
  }
  return rows
}
