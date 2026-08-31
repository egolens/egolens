import { ExtensionOperatorError } from './protocol'

const textEncoder = new TextEncoder()

function fail(path: string, reason: string): never {
  throw new ExtensionOperatorError('RESOURCE_LIMIT_EXCEEDED', `${path}: ${reason}`)
}

/** Estimate structured-clone payload bytes while rejecting executable/host objects. */
export function measureClonePayload(value: unknown, path = '$', seen = new Set<object>(), depth = 0): number {
  if (depth > 64) fail(path, 'payload nesting exceeds 64 levels')
  if (value === null || value === undefined) return 0
  if (typeof value === 'boolean') return 4
  if (typeof value === 'number' || typeof value === 'bigint') return 8
  if (typeof value === 'string') return textEncoder.encode(value).byteLength
  if (typeof value === 'function' || typeof value === 'symbol') fail(path, `unsupported ${typeof value} value`)
  if (typeof value !== 'object') return 0
  if (seen.has(value)) fail(path, 'cyclic values are not allowed')
  seen.add(value)
  try {
    if (value instanceof ArrayBuffer) return value.byteLength
    if (ArrayBuffer.isView(value)) {
      if (!(value.buffer instanceof ArrayBuffer)) fail(path, 'shared buffers are not allowed')
      return value.byteLength
    }
    if (Array.isArray(value)) return value.reduce((size, entry, index) => size + measureClonePayload(entry, `${path}[${index}]`, seen, depth + 1), 0)
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      fail(path, `unsupported host object ${value.constructor?.name ?? 'Object'}`)
    }
    return Object.entries(value).reduce(
      (size, [key, entry]) => size + textEncoder.encode(key).byteLength + measureClonePayload(entry, `${path}.${key}`, seen, depth + 1),
      0,
    )
  } finally {
    seen.delete(value)
  }
}

export function assertPayloadWithin(value: unknown, maximum: number, label: 'input' | 'output'): number {
  const actual = measureClonePayload(value)
  if (actual > maximum) {
    throw new ExtensionOperatorError('RESOURCE_LIMIT_EXCEEDED', `Extension ${label} is ${actual} bytes; limit is ${maximum} bytes.`, {
      resource: `${label}Bytes`, actual, maximum,
    })
  }
  return actual
}

export function collectTransferableBuffers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  const visit = (entry: unknown): void => {
    if (entry instanceof ArrayBuffer) buffers.add(entry)
    else if (ArrayBuffer.isView(entry) && entry.buffer instanceof ArrayBuffer) buffers.add(entry.buffer)
    else if (Array.isArray(entry)) entry.forEach(visit)
    else if (entry && typeof entry === 'object' && (Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null)) {
      Object.values(entry).forEach(visit)
    }
  }
  visit(value)
  return [...buffers]
}
