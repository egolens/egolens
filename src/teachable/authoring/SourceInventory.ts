import type { ByteSourceReadOptionsV1, ByteSourceV1 } from '../source/ByteSource'
import { LocalFileByteSourceV1, normalizeSourcePathV1 } from '../source/ByteSource'
import type { RemoteByteSourceOptionsV1, RemoteByteSourceV1 } from '../source/RemoteByteSource'

// The complete official nuScenes mini extraction contains about 32k source
// objects. Keep enumeration bounded while allowing that shipped baseline to
// remain an unchanged release root instead of a hand-pruned scene subset.
export const MAX_SOURCE_INVENTORY_ENTRIES_V1 = 50_000

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

export interface RemoteSourceInventoryOptionsV1 extends Pick<RemoteByteSourceOptionsV1,
  'rootUrl' | 'expectedSourceManifestHash' | 'fetch' | 'limits' | 'credentialGrant' | 'preferFullObjects'
> {
  readonly catalogUrl: string
  readonly expectedCatalogHash?: string
  /** Cancels initialization only. Revoke the returned inventory to end its session. */
  readonly signal?: AbortSignal
  readonly sessionId?: string
  readonly maxCatalogBytes?: number
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

/** Session-only capability over explicitly selected local files or a remote catalog. */
export class SourceInventoryV1 {
  readonly sessionId: string
  readonly truncated: boolean
  #source: LocalFileByteSourceV1 | RemoteByteSourceV1 | null
  #entries: readonly SourceInventoryEntryV1[]
  #kind: 'local' | 'remote' = 'local'
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

  /**
   * Fetches catalog metadata only; source objects remain lazy, verified reads.
   * Inspection and dataset fingerprinting can expand small reads to catalog
   * chunks (or full objects without chunk digests), under the remote limits.
   */
  static async fromRemote(options: RemoteSourceInventoryOptionsV1): Promise<SourceInventoryV1> {
    const assertNotAborted = () => {
      if (options.signal?.aborted) throw new DOMException('Source inventory initialization was aborted.', 'AbortError')
    }
    assertNotAborted()
    // Keep the remote transport/catalog validator out of local initialization.
    const { fetchSourceCatalogV1, RemoteByteSourceV1 } = await import('../source/RemoteByteSource')
    assertNotAborted()
    const validated = await fetchSourceCatalogV1(options.catalogUrl, {
      expectedCatalogHash: options.expectedCatalogHash,
      expectedSourceManifestHash: options.expectedSourceManifestHash,
      fetch: options.fetch,
      signal: options.signal,
      maxBytes: options.maxCatalogBytes,
      credentialGrant: options.credentialGrant,
    })
    assertNotAborted()
    const inventory = new SourceInventoryV1([], { sessionId: options.sessionId })
    const source = new RemoteByteSourceV1({
      rootUrl: options.rootUrl,
      catalog: validated.catalog,
      expectedCatalogHash: validated.catalogHash,
      expectedSourceManifestHash: validated.sourceManifestHash,
      fetch: options.fetch,
      limits: options.limits,
      preferFullObjects: options.preferFullObjects,
      credentialGrant: options.credentialGrant,
      // Each inventory owns its cache so revocation clears verified bytes.
    })
    inventory.#source!.revoke()
    inventory.#source = source
    inventory.#kind = 'remote'
    inventory.#entries = Object.freeze(source.catalog.entries.map((entry) => Object.freeze({
      path: entry.path,
      size: entry.size,
      type: entry.mediaType ?? '',
      // Catalog v1 has no modification time; zero means unknown, consistently.
      lastModified: 0,
      extension: extensionOf(entry.path),
    })))
    return inventory
  }

  get kind(): 'local' | 'remote' {
    return this.#kind
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
    return this.#source!
  }

  readAuthorizedBytes(path: string, options?: ByteSourceReadOptionsV1): Promise<ArrayBuffer> {
    this.#assertActive()
    const normalized = normalizeInventoryPath(path)
    if (!this.#entries.some((entry) => entry.path === normalized)) {
      throw new Error(`Inventory path is not authorized: ${normalized}`)
    }
    return this.#source!.read(normalized, options)
  }

  revoke(): void {
    if (this.#revoked) return
    this.#revoked = true
    this.#source?.revoke()
    this.#source = null
    this.#entries = Object.freeze([])
  }

  #assertActive(): void {
    if (this.#revoked) throw new Error(this.#kind === 'remote'
      ? 'SOURCE_INVENTORY_REVOKED: select the hosted source again.'
      : 'SOURCE_INVENTORY_REVOKED: select the dataset folder again.')
  }
}

export function sourceInventoryFromFilesV1(
  files: Iterable<readonly [string, File]>,
  options?: { readonly truncated?: boolean },
): SourceInventoryV1 {
  return new SourceInventoryV1(files, options)
}

export async function sourceInventoryFromRemoteV1(
  options: RemoteSourceInventoryOptionsV1,
): Promise<SourceInventoryV1> {
  return await SourceInventoryV1.fromRemote(options)
}
