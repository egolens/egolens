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

function normalizeLogicalPath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) throw new Error(`Invalid inventory path: ${path}`)
  return normalized
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
  #files: Map<string, File>
  #entries: readonly SourceInventoryEntryV1[]
  #revoked = false

  constructor(
    files: Iterable<readonly [string, File]>,
    options: { readonly sessionId?: string; readonly truncated?: boolean } = {},
  ) {
    this.sessionId = options.sessionId ?? createSessionId()
    this.truncated = options.truncated ?? false
    const sorted = [...files]
      .map(([path, file]) => [normalizeLogicalPath(path), file] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    if (sorted.length > MAX_SOURCE_INVENTORY_ENTRIES_V1) {
      throw new Error(`Source inventory exceeds ${MAX_SOURCE_INVENTORY_ENTRIES_V1} files.`)
    }
    this.#files = new Map()
    const entries: SourceInventoryEntryV1[] = []
    for (const [path, file] of sorted) {
      if (this.#files.has(path)) throw new Error(`Duplicate inventory path: ${path}`)
      this.#files.set(path, file)
      entries.push(Object.freeze({
        path,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        extension: extensionOf(path),
      }))
    }
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
    const normalized = normalizeLogicalPath(path)
    return this.#entries.find((entry) => entry.path === normalized) ?? null
  }

  /** Internal command-layer access; callers still need an exact allowlisted path. */
  resolveAuthorizedFile(path: string): File {
    this.#assertActive()
    const normalized = normalizeLogicalPath(path)
    const file = this.#files.get(normalized)
    if (!file) throw new Error(`Inventory path is not authorized: ${normalized}`)
    return file
  }

  revoke(): void {
    this.#revoked = true
    this.#files.clear()
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
