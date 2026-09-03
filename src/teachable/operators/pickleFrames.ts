/**
 * Bounded reader for gzip-compressed Python pickles that hold a pandas
 * DataFrame (PandaSet point clouds, cuboids, segmentation). A small pickle
 * virtual machine (protocols 2–5, no code execution: globals become tagged
 * nodes) builds a plain object tree; a pandas interpreter then reads the
 * BlockManager into columns. Object columns must hold strings/numbers/None.
 */

import type { DecodedNumericRecordsV1 } from './binaryReaders'

export interface PickleGlobalV1 {
  readonly __global: string
  args?: unknown[]
  state?: unknown
  kwargs?: Record<string, unknown>
}

export interface PickleNdArrayV1 {
  readonly __ndarray: true
  readonly shape: readonly number[]
  readonly dtype: string
  readonly fortran: boolean
  readonly data: Uint8Array | unknown[]
}

export interface DataFrameColumnV1 {
  readonly name: string
  readonly values: readonly (number | string | boolean | null)[]
}

export interface DataFrameV1 {
  readonly rowCount: number
  readonly columns: readonly DataFrameColumnV1[]
}

export interface PickleLimitsV1 {
  readonly maxExpandedBytes?: number
  readonly maxRows?: number
  readonly maxMemo?: number
}

const DEFAULT_MAX_EXPANDED = 512 * 1024 * 1024
const DEFAULT_MAX_ROWS = 5_000_000
const DEFAULT_MAX_MEMO = 5_000_000

class Mark { readonly mark = true }

function isGlobal(value: unknown): value is PickleGlobalV1 {
  return typeof value === 'object' && value !== null && '__global' in value
}

function isNdArray(value: unknown): value is PickleNdArrayV1 {
  return typeof value === 'object' && value !== null && (value as { __ndarray?: boolean }).__ndarray === true
}

/** Decode one pickle stream into a plain object tree. */
export function parsePickleV1(bytes: Uint8Array, limits: PickleLimitsV1 = {}): unknown {
  const maxMemo = limits.maxMemo ?? DEFAULT_MAX_MEMO
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = new TextDecoder()
  const stack: unknown[] = []
  const memo: unknown[] = []
  let position = 0
  const u8 = () => bytes[position++]!
  const u16 = () => { const value = view.getUint16(position, true); position += 2; return value }
  const u32 = () => { const value = view.getUint32(position, true); position += 4; return value }
  const i32 = () => { const value = view.getInt32(position, true); position += 4; return value }
  const u64 = () => { const value = view.getBigUint64(position, true); position += 8; return Number(value) }
  const take = (length: number) => { const slice = bytes.subarray(position, position + length); position += length; return slice }
  const popMark = () => {
    let index = stack.length - 1
    while (index >= 0 && !(stack[index] instanceof Mark)) index -= 1
    if (index < 0) throw new Error('PICKLE_MALFORMED: missing MARK')
    const items = stack.splice(index + 1)
    stack.pop()
    return items
  }
  const put = (value: unknown) => { if (memo.length >= maxMemo) throw new Error('PICKLE_LIMIT: memo'); memo.push(value) }
  const readLine = () => { const end = bytes.indexOf(0x0a, position); const slice = bytes.subarray(position, end); position = end + 1; return text.decode(slice) }
  const setState = (target: unknown, state: unknown) => {
    if (isGlobal(target)) { target.state = state; return }
    if (typeof target === 'object' && target !== null && typeof state === 'object' && state !== null) Object.assign(target as object, state as object)
  }
  const reduce = (callable: unknown, args: unknown[]): unknown => {
    if (!isGlobal(callable)) throw new Error('PICKLE_MALFORMED: REDUCE on a non-global')
    const name = callable.__global
    if (name === 'builtins.slice') return { __slice: true, start: args[0], stop: args[1], step: args[2] }
    if (name === 'builtins.set' || name === 'builtins.frozenset') return args[0]
    if (name === 'numpy.core.multiarray._reconstruct' || name === 'numpy._core.multiarray._reconstruct') return { __ndarray: true, shape: [], dtype: '', fortran: false, data: [] } as PickleNdArrayV1
    if (name === 'numpy.core.multiarray.scalar' || name === 'numpy._core.multiarray.scalar') {
      const dtype = args[0] as PickleGlobalV1
      const descr = String((dtype.args?.[0] as string) ?? '')
      const raw = args[1] as Uint8Array
      const scalarView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
      if (descr.endsWith('f8')) return scalarView.getFloat64(0, true)
      if (descr.endsWith('f4')) return scalarView.getFloat32(0, true)
      if (descr.endsWith('i8')) return Number(scalarView.getBigInt64(0, true))
      if (descr.endsWith('i4')) return scalarView.getInt32(0, true)
      if (descr.endsWith('b1')) return raw[0] !== 0
      return null
    }
    return { __global: name, args } as PickleGlobalV1
  }
  const proto = { major: 2 }
  while (position < bytes.byteLength) {
    const opcode = u8()
    switch (opcode) {
      case 0x80: proto.major = u8(); break // PROTO
      case 0x95: position += 8; break // FRAME
      case 0x2e: return stack.pop() // STOP
      case 0x28: stack.push(new Mark()); break // MARK
      case 0x4e: stack.push(null); break // NONE
      case 0x88: stack.push(true); break // NEWTRUE
      case 0x89: stack.push(false); break // NEWFALSE
      case 0x4b: stack.push(u8()); break // BININT1
      case 0x4d: stack.push(u16()); break // BININT2
      case 0x4a: stack.push(i32()); break // BININT
      case 0x8a: { const length = u8(); const raw = take(length); let value = 0n; for (let index = raw.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(raw[index]!); if (raw.length > 0 && (raw[raw.length - 1]! & 0x80)) value -= 1n << BigInt(8 * raw.length); stack.push(Number(value)); break } // LONG1
      case 0x47: { stack.push(view.getFloat64(position, false)); position += 8; break } // BINFLOAT (big-endian)
      case 0x8c: stack.push(text.decode(take(u8()))); break // SHORT_BINUNICODE
      case 0x58: stack.push(text.decode(take(u32()))); break // BINUNICODE
      case 0x8d: stack.push(text.decode(take(u64()))); break // BINUNICODE8
      case 0x43: stack.push(take(u8())); break // SHORT_BINBYTES
      case 0x42: stack.push(take(u32())); break // BINBYTES
      case 0x8e: stack.push(take(u64())); break // BINBYTES8
      case 0x96: stack.push(take(u64())); break // BYTEARRAY8
      case 0x29: stack.push([]); (stack[stack.length - 1] as unknown[] & { __tuple?: boolean }).__tuple = true; break // EMPTY_TUPLE
      case 0x85: stack.push([stack.pop()]); break // TUPLE1
      case 0x86: { const b = stack.pop(); const a = stack.pop(); stack.push([a, b]); break } // TUPLE2
      case 0x87: { const c = stack.pop(); const b = stack.pop(); const a = stack.pop(); stack.push([a, b, c]); break } // TUPLE3
      case 0x74: stack.push(popMark()); break // TUPLE
      case 0x5d: stack.push([]); break // EMPTY_LIST
      case 0x6c: stack.push(popMark()); break // LIST
      case 0x61: { const item = stack.pop(); (stack[stack.length - 1] as unknown[]).push(item); break } // APPEND
      case 0x65: { const items = popMark(); (stack[stack.length - 1] as unknown[]).push(...items); break } // APPENDS
      case 0x7d: stack.push({}); break // EMPTY_DICT
      case 0x64: { const items = popMark(); const dict: Record<string, unknown> = {}; for (let index = 0; index < items.length; index += 2) dict[String(items[index])] = items[index + 1]; stack.push(dict); break } // DICT
      case 0x73: { const value = stack.pop(); const key = stack.pop(); (stack[stack.length - 1] as Record<string, unknown>)[String(key)] = value; break } // SETITEM
      case 0x75: { const items = popMark(); const dict = stack[stack.length - 1] as Record<string, unknown>; for (let index = 0; index < items.length; index += 2) dict[String(items[index])] = items[index + 1]; break } // SETITEMS
      case 0x8f: stack.push([]); break // EMPTY_SET
      case 0x90: { const items = popMark(); (stack[stack.length - 1] as unknown[]).push(...items); break } // ADDITEMS
      case 0x91: stack.push(popMark()); break // FROZENSET
      case 0x94: put(stack[stack.length - 1]); break // MEMOIZE
      case 0x71: { const index = u8(); memo[index] = stack[stack.length - 1]; break } // BINPUT
      case 0x72: { const index = u32(); memo[index] = stack[stack.length - 1]; break } // LONG_BINPUT
      case 0x68: stack.push(memo[u8()]); break // BINGET
      case 0x6a: stack.push(memo[u32()]); break // LONG_BINGET
      case 0x93: { const name = stack.pop(); const module = stack.pop(); stack.push({ __global: `${String(module)}.${String(name)}` } as PickleGlobalV1); break } // STACK_GLOBAL
      case 0x63: { const module = readLine(); const name = readLine(); stack.push({ __global: `${module}.${name}` } as PickleGlobalV1); break } // GLOBAL
      case 0x81: { const args = stack.pop() as unknown[]; const cls = stack.pop() as PickleGlobalV1; stack.push({ __global: cls.__global, args } as PickleGlobalV1); break } // NEWOBJ
      case 0x92: { const kwargs = stack.pop() as Record<string, unknown>; const args = stack.pop() as unknown[]; const cls = stack.pop() as PickleGlobalV1; stack.push({ __global: cls.__global, args, kwargs } as PickleGlobalV1); break } // NEWOBJ_EX
      case 0x52: { const args = stack.pop() as unknown[]; const callable = stack.pop(); stack.push(reduce(callable, args)); break } // REDUCE
      case 0x62: { const state = stack.pop(); const target = stack[stack.length - 1]; if (isNdArray(target)) applyNdArrayState(target, state, limits); else setState(target, state); break } // BUILD
      case 0x30: stack.pop(); break // POP
      case 0x31: popMark(); break // POP_MARK
      case 0x32: stack.push(stack[stack.length - 1]); break // DUP
      default: throw new Error(`PICKLE_UNSUPPORTED_OPCODE: 0x${opcode.toString(16)} at ${position - 1}`)
    }
  }
  throw new Error('PICKLE_MALFORMED: no STOP')
}

function dtypeDescr(dtype: unknown): string {
  if (isGlobal(dtype)) return String(dtype.args?.[0] ?? '')
  return String(dtype ?? '')
}

function applyNdArrayState(target: PickleNdArrayV1, state: unknown, limits: PickleLimitsV1): void {
  // (version, shape, dtype, is_fortran, rawdata|list)
  if (!Array.isArray(state) || state.length < 5) throw new Error('PICKLE_MALFORMED: ndarray state')
  const shape = (state[1] as unknown[]).map(Number)
  const elements = shape.reduce((product, value) => product * value, 1)
  if (elements > (limits.maxRows ?? DEFAULT_MAX_ROWS) * 64) throw new Error('PICKLE_LIMIT: ndarray elements')
  const mutable = target as { shape: readonly number[]; dtype: string; fortran: boolean; data: Uint8Array | unknown[] }
  mutable.shape = shape
  mutable.dtype = dtypeDescr(state[2])
  mutable.fortran = state[3] === true
  mutable.data = state[4] as Uint8Array | unknown[]
}

const SCALARS: Readonly<Record<string, { bytes: number; read: (view: DataView, offset: number) => number | boolean }>> = {
  f8: { bytes: 8, read: (view, offset) => view.getFloat64(offset, true) },
  f4: { bytes: 4, read: (view, offset) => view.getFloat32(offset, true) },
  i8: { bytes: 8, read: (view, offset) => Number(view.getBigInt64(offset, true)) },
  i4: { bytes: 4, read: (view, offset) => view.getInt32(offset, true) },
  i2: { bytes: 2, read: (view, offset) => view.getInt16(offset, true) },
  i1: { bytes: 1, read: (view, offset) => view.getInt8(offset) },
  u8: { bytes: 8, read: (view, offset) => Number(view.getBigUint64(offset, true)) },
  u4: { bytes: 4, read: (view, offset) => view.getUint32(offset, true) },
  u2: { bytes: 2, read: (view, offset) => view.getUint16(offset, true) },
  u1: { bytes: 1, read: (view, offset) => view.getUint8(offset) },
  b1: { bytes: 1, read: (view, offset) => view.getUint8(offset) !== 0 },
}

function ndarrayValues(array: PickleNdArrayV1): (number | string | boolean | null)[][] {
  // Returns [row][column] for a 2-D array (or [row][0] for 1-D).
  const rows = array.shape[0] ?? 0
  const columns = array.shape.length > 1 ? array.shape[1]! : 1
  if (Array.isArray(array.data)) {
    const flat = array.data as (number | string | boolean | null)[]
    return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (__, column) => flat[array.fortran ? column * rows + row : row * columns + column] ?? null))
  }
  const descr = array.dtype.replace(/^[<>|=]/u, '')
  const scalar = SCALARS[descr]
  if (!scalar) throw new Error(`PICKLE_UNSUPPORTED_DTYPE: ${array.dtype}`)
  const bytes = array.data
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = (row: number, column: number) => scalar.read(view, (array.fortran ? column * rows + row : row * columns + column) * scalar.bytes)
  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (__, column) => at(row, column)))
}

function findNdArray(value: unknown, depth = 0): PickleNdArrayV1 | null {
  if (isNdArray(value)) return value
  if (depth > 3) return null
  if (Array.isArray(value)) { for (const entry of value) { const found = findNdArray(entry, depth + 1); if (found) return found } }
  else if (isGlobal(value)) return findNdArray(value.state ?? value.args, depth + 1)
  return null
}

function indexLabels(index: unknown): string[] {
  // _new_Index(Index, {data: ndarray|StringArray, name}) or RangeIndex
  if (isGlobal(index)) {
    const args = index.args ?? []
    const payload = args[1] as Record<string, unknown> | undefined
    const data = payload?.data
    if (isNdArray(data)) return ndarrayValues(data).map((row) => String(row[0]))
    if (isGlobal(data)) {
      // __pyx_unpickle_NDArrayBacked(StringArray, checksum, state) → state holds (dtype, ndarray) in some order
      const inner = findNdArray(data.state ?? data.args?.[2])
      if (inner) return ndarrayValues(inner).map((row) => String(row[0]))
    }
    if (Array.isArray(data)) return data.map((entry) => String(entry))
  }
  if (Array.isArray(index)) return index.map((entry) => String(entry))
  throw new Error('PICKLE_DATAFRAME_INVALID: column index')
}

function placementIndices(placement: unknown, count: number): number[] {
  if (typeof placement === 'object' && placement !== null && '__slice' in placement) {
    const slice = placement as unknown as { start: number; stop: number; step: number }
    const step = Number(slice.step ?? 1) || 1
    const out: number[] = []
    for (let index = Number(slice.start ?? 0); step > 0 ? index < Number(slice.stop) : index > Number(slice.stop); index += step) out.push(index)
    return out
  }
  if (isGlobal(placement)) {
    // BlockPlacement → its state/args hold a slice or an ndarray
    const inner = placement.state ?? placement.args?.[0]
    return placementIndices(inner, count)
  }
  if (isNdArray(placement)) return ndarrayValues(placement).map((row) => Number(row[0]))
  if (Array.isArray(placement)) return placement.map(Number)
  return Array.from({ length: count }, (_, index) => index)
}

/** Block values as [blockColumn][row]: 2-D arrays are [nBlockColumns, nRows]; a 1-D extension array is one column. */
function blockValues(values: unknown): (number | string | boolean | null)[][] {
  const array = isNdArray(values) ? values : isGlobal(values) ? findNdArray(values.state ?? values.args?.[2] ?? values.args?.[0]) : null
  if (!array) throw new Error('PICKLE_DATAFRAME_INVALID: block values')
  const table = ndarrayValues(array)
  return array.shape.length === 1 ? [table.map((row) => row[0] ?? null)] : table
}

/** Interpret a parsed pickle tree as a pandas DataFrame. */
export function dataFrameFromPickleV1(tree: unknown, limits: PickleLimitsV1 = {}): DataFrameV1 {
  if (!isGlobal(tree) || !/(?:^|\.)DataFrame$/u.test(tree.__global)) throw new Error('PICKLE_DATAFRAME_INVALID: not a DataFrame')
  const state = tree.state as Record<string, unknown> | unknown[] | undefined
  const manager = Array.isArray(state) ? state[0] : (state as Record<string, unknown> | undefined)?._mgr ?? (state as Record<string, unknown> | undefined)?._data
  if (!isGlobal(manager)) throw new Error('PICKLE_DATAFRAME_INVALID: block manager')
  const managerState = (manager.state ?? manager.args) as unknown[]
  // BlockManager args: (blocks tuple, axes list) [modern]; state may also be a tuple (axes, blocks, …)
  let blocks: unknown[] = []
  let axes: unknown[] = []
  if (Array.isArray(managerState)) {
    const candidates = managerState.filter(Array.isArray) as unknown[][]
    for (const candidate of candidates) {
      if (candidate.some((entry) => isGlobal(entry) && /_unpickle_block|Block$/u.test(entry.__global))) blocks = candidate
      else if (candidate.some((entry) => isGlobal(entry) && /Index$|_new_Index/u.test(entry.__global))) axes = candidate
    }
  }
  if (blocks.length === 0 || axes.length === 0) throw new Error('PICKLE_DATAFRAME_INVALID: blocks or axes missing')
  const names = indexLabels(axes[0])
  const columns: (number | string | boolean | null)[][] = names.map(() => [])
  let rowCount = -1
  for (const block of blocks) {
    if (!isGlobal(block)) continue
    const args = block.args ?? []
    const values = blockValues(args[0])
    const placement = placementIndices(args[1], values.length)
    // values are [nBlockColumns][nRows] (2-D) → transpose into columns
    placement.forEach((columnIndex, blockColumn) => {
      const row = values[blockColumn] ?? []
      columns[columnIndex] = row
      rowCount = rowCount < 0 ? row.length : rowCount
      if (row.length !== rowCount) throw new Error('PICKLE_DATAFRAME_INVALID: ragged blocks')
    })
  }
  if (rowCount > (limits.maxRows ?? DEFAULT_MAX_ROWS)) throw new Error('PICKLE_LIMIT: rows')
  return { rowCount: Math.max(0, rowCount), columns: names.map((name, index) => ({ name, values: columns[index] ?? [] })) }
}

async function gunzip(bytes: Uint8Array, maxExpanded: number): Promise<Uint8Array> {
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  if (!isGzip) return bytes
  if (typeof DecompressionStream !== 'function') throw new Error('PICKLE_GZIP_UNSUPPORTED: no DecompressionStream in this runtime')
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxExpanded) { await reader.cancel(); throw new Error(`PICKLE_LIMIT: expanded bytes exceed ${maxExpanded}`) }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out
}

/** gzip (optional) + pickle → DataFrame. */
export async function decodePickleDataFrameV1(buffer: ArrayBuffer | Uint8Array, limits: PickleLimitsV1 = {}): Promise<DataFrameV1> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const expanded = await gunzip(bytes, limits.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED)
  return dataFrameFromPickleV1(parsePickleV1(expanded, limits), limits)
}

export interface PickleRecordsParamsV1 extends PickleLimitsV1 {
  /** DataFrame columns to expose as numeric attributes, in stride order. */
  readonly columns: readonly string[]
  /** Optional attribute names, one per column (defaults to the column names). */
  readonly attributes?: readonly string[]
}

/** Decode a gzip+pickle DataFrame into interleaved float records (one attribute per selected column). */
export async function decodePickleRecordsV1(
  buffer: ArrayBuffer | Uint8Array,
  params: PickleRecordsParamsV1,
  signal?: AbortSignal,
): Promise<DecodedNumericRecordsV1> {
  if (!Array.isArray(params.columns) || params.columns.length === 0) throw new Error('pickle records need at least one column.')
  if (params.attributes && params.attributes.length !== params.columns.length) throw new Error('pickle records attributes must match columns.')
  const frame = await decodePickleDataFrameV1(buffer, params)
  if (signal?.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
  const stride = params.columns.length
  const selected = params.columns.map((name) => {
    const column = frame.columns.find((entry) => entry.name === name)
    if (!column) throw new Error(`PICKLE_COLUMN_MISSING: ${name} (available: ${frame.columns.map((entry) => entry.name).join(', ')})`)
    return column.values
  })
  const values = new Float32Array(frame.rowCount * stride)
  for (let row = 0; row < frame.rowCount; row += 1) {
    for (let index = 0; index < stride; index += 1) {
      const value = selected[index][row]
      values[row * stride + index] = typeof value === 'number' ? value : typeof value === 'boolean' ? (value ? 1 : 0) : Number.NaN
    }
  }
  return { values, pointCount: frame.rowCount, stride, attributes: params.attributes ?? params.columns }
}
