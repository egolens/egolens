import { asyncBufferFromUrl, type AsyncBuffer } from 'hyparquet'
import { resolveFileEntry } from '../../workers/fetchHelper'

export interface ByteSourceReadOptionsV1 {
  /** Inclusive byte offset. Defaults to zero. */
  readonly start?: number
  /** Exclusive byte offset. Defaults to the end of the object. */
  readonly end?: number
  readonly signal?: AbortSignal
}

/**
 * Transport-neutral, non-enumerating access to authorized source bytes.
 *
 * Enumeration and metadata belong to SourceInventoryV1. Readers only receive
 * normalized logical paths and this bounded byte interface, so no reader can
 * branch on File versus URL or recover a host filesystem path.
 */
export interface ByteSourceV1 {
  has(path: string): boolean
  byteLength(path: string): number | null
  read(path: string, options?: ByteSourceReadOptionsV1): Promise<ArrayBuffer>
  asyncBuffer(path: string): Promise<AsyncBuffer>
}

export type ByteSourceBackingV1 = File | string | AsyncBuffer

function normalizeSourcePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) throw new Error(`SOURCE_PATH_INVALID: ${path}`)
  return normalized
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Source byte read was aborted.', 'AbortError')
}

function rangeForLength(
  length: number,
  options: ByteSourceReadOptionsV1 | undefined,
): readonly [number, number] {
  const start = options?.start ?? 0
  const end = options?.end ?? length
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
    || end > length
  ) throw new RangeError(`SOURCE_RANGE_INVALID: requested [${start}, ${end}) for ${length} bytes.`)
  return [start, end]
}

function isAsyncBuffer(value: ByteSourceBackingV1): value is AsyncBuffer {
  return typeof value !== 'string' && 'byteLength' in value && typeof value.byteLength === 'number'
}

/**
 * Compatibility implementation for existing File, URL, and AsyncBuffer maps.
 * URL catalog validation is deliberately outside this first local-source slice.
 */
export class MappedByteSourceV1 implements ByteSourceV1 {
  protected readonly entries = new Map<string, ByteSourceBackingV1>()
  protected revoked = false

  constructor(entries: Iterable<readonly [string, ByteSourceBackingV1]>) {
    for (const [rawPath, backing] of entries) {
      const path = normalizeSourcePath(rawPath)
      if (this.entries.has(path)) throw new Error(`SOURCE_PATH_DUPLICATE: ${path}`)
      this.entries.set(path, backing)
    }
  }

  has(rawPath: string): boolean {
    this.assertActive()
    return this.entries.has(normalizeSourcePath(rawPath))
  }

  byteLength(rawPath: string): number | null {
    const backing = this.resolve(rawPath)
    if (typeof backing === 'string') return null
    return isAsyncBuffer(backing) ? backing.byteLength : backing.size
  }

  async read(rawPath: string, options?: ByteSourceReadOptionsV1): Promise<ArrayBuffer> {
    const backing = this.resolve(rawPath)
    throwIfAborted(options?.signal)
    if (typeof backing === 'string') {
      const complete = await resolveFileEntry(backing)
      throwIfAborted(options?.signal)
      const [start, end] = rangeForLength(complete.byteLength, options)
      return complete.slice(start, end)
    }
    const length = isAsyncBuffer(backing) ? backing.byteLength : backing.size
    const [start, end] = rangeForLength(length, options)
    const bytes = isAsyncBuffer(backing)
      ? await backing.slice(start, end)
      : await backing.slice(start, end).arrayBuffer()
    throwIfAborted(options?.signal)
    return bytes
  }

  async asyncBuffer(rawPath: string): Promise<AsyncBuffer> {
    const path = normalizeSourcePath(rawPath)
    const backing = this.resolve(path)
    if (typeof backing === 'string') return await asyncBufferFromUrl({ url: backing })
    if (isAsyncBuffer(backing)) return backing
    return {
      byteLength: backing.size,
      slice: (start, end) => this.read(path, { start, end }),
    }
  }

  revoke(): void {
    this.revoked = true
    this.entries.clear()
  }

  protected assertActive(): void {
    if (this.revoked) throw new Error('BYTE_SOURCE_REVOKED: select the dataset folder again.')
  }

  private resolve(rawPath: string): ByteSourceBackingV1 {
    this.assertActive()
    const path = normalizeSourcePath(rawPath)
    const backing = this.entries.get(path)
    if (!backing) throw new Error(`SOURCE_PATH_UNAVAILABLE: ${path}`)
    return backing
  }
}

/** Local drag-and-drop implementation. File stays below the ByteSource seam. */
export class LocalFileByteSourceV1 extends MappedByteSourceV1 {
  constructor(files: Iterable<readonly [string, File]>) {
    super(files)
  }
}

/** Restrict an existing capability to the paths selected by recipe binding. */
export function scopedByteSourceV1(
  source: ByteSourceV1,
  paths: Iterable<string>,
): ByteSourceV1 {
  const allowed = new Set([...paths].map(normalizeSourcePath))
  const authorize = (rawPath: string): string => {
    const path = normalizeSourcePath(rawPath)
    if (!allowed.has(path)) throw new Error(`SOURCE_PATH_UNAVAILABLE: ${path}`)
    return path
  }
  return {
    has(rawPath) {
      const path = normalizeSourcePath(rawPath)
      return allowed.has(path) && source.has(path)
    },
    byteLength(rawPath) {
      return source.byteLength(authorize(rawPath))
    },
    async read(rawPath, options) {
      return await source.read(authorize(rawPath), options)
    },
    async asyncBuffer(rawPath) {
      return await source.asyncBuffer(authorize(rawPath))
    },
  }
}
