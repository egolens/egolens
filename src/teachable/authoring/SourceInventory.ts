import type { ByteSourceReadOptionsV1, ByteSourceV1 } from '../source/ByteSource'
import { LocalFileByteSourceV1, normalizeSourcePathV1 } from '../source/ByteSource'

export const MAX_SOURCE_INVENTORY_ENTRIES_V1 = 20_000

export interface SourceInventoryEntryV1 {
  readonly path: string
  readonly size: number
  readonly type: string
  readonly lastModified: number
  readonly extension: string
}

export interface SourceInventorySnapshotV1 {
  readonly sessionId: string
  readonly entries: readonly SourceInventoryEntryV1[]
  readonly truncated: boolean
  readonly revoked: boolean
}

function normalizeInventoryPath(path: string): string {
  try {
    return normalizeSourcePathV1(path)
  } catch (cause) {
    throw new Error(`Invalid inventory path: ${path}`, { cause })
  }
}

function extensionOf(path: string): string {
  const leaf = path.split('/').at(-1) ?? ''
  const index = leaf.lastIndexOf('.')
  return index > 0 ? leaf.slice(index).toLowerCase() : ''
}

function createSessionId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `inventory-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Session-only capability over files explicitly selected by the user. */
export class SourceInventoryV1 {
  readonly sessionId: string
  readonly truncated: boolean
  #source: LocalFileByteSourceV1
  #entries: readonly SourceInventoryEntryV1[]
  #revoked = false

  constructor(
    files: Iterable<readonly [string, File]>,
    options: { readonly sessionId?: string; readonly truncated?: boolean } = {},
  ) {
    this.sessionId = options.sessionId ?? createSessionId()
    this.truncated = options.truncated ?? false
    const sorted = [...files]
      .map(([path, file]) => [normalizeInventoryPath(path), file] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    if (sorted.length > MAX_SOURCE_INVENTORY_ENTRIES_V1) {
      throw new Error(`Source inventory exceeds ${MAX_SOURCE_INVENTORY_ENTRIES_V1} files.`)
    }
    const normalizedFiles = new Map<string, File>()
    const entries: SourceInventoryEntryV1[] = []
    for (const [path, file] of sorted) {
      if (normalizedFiles.has(path)) throw new Error(`Duplicate inventory path: ${path}`)
      normalizedFiles.set(path, file)
      entries.push(Object.freeze({
        path,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        extension: extensionOf(path),
      }))
    }
    this.#source = new LocalFileByteSourceV1(normalizedFiles)
    this.#entries = Object.freeze(entries)
  }

  get revoked(): boolean {
    return this.#revoked
  }

  snapshot(): SourceInventorySnapshotV1 {
    return {
      sessionId: this.sessionId,
      entries: this.#revoked ? [] : this.#entries,
      truncated: this.truncated,
      revoked: this.#revoked,
    }
  }

  paths(): readonly string[] {
    this.#assertActive()
    return this.#entries.map((entry) => entry.path)
  }

  entry(path: string): SourceInventoryEntryV1 | null {
    this.#assertActive()
    const normalized = normalizeInventoryPath(path)
    return this.#entries.find((entry) => entry.path === normalized) ?? null
  }

  /** Capability used by readers after inventory matching; File never crosses it. */
  resolveAuthorizedSource(): ByteSourceV1 {
    this.#assertActive()
    return this.#source
  }

  readAuthorizedBytes(path: string, options?: ByteSourceReadOptionsV1): Promise<ArrayBuffer> {
    this.#assertActive()
    const normalized = normalizeInventoryPath(path)
    if (!this.#entries.some((entry) => entry.path === normalized)) {
      throw new Error(`Inventory path is not authorized: ${normalized}`)
    }
    return this.#source.read(normalized, options)
  }

  revoke(): void {
    this.#revoked = true
    this.#source.revoke()
  }

  #assertActive(): void {
    if (this.#revoked) throw new Error('SOURCE_INVENTORY_REVOKED: select the dataset folder again.')
  }
}

export function sourceInventoryFromFilesV1(
  files: Iterable<readonly [string, File]>,
  options?: { readonly truncated?: boolean },
): SourceInventoryV1 {
  return new SourceInventoryV1(files, options)
}
