import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020'
import sourceCatalogSchema from '../schema/egolens-source-catalog-v1.schema.json'
import { canonicalizeJson } from '../recipe/canonicalize'
import type { JsonValue } from '../recipe/types'
import type { SourceInventoryV1 } from '../authoring/SourceInventory'
import { normalizeSourcePathV1 } from './ByteSource'
import { IncrementalSha256V1, sha256DigestV1 } from './sha256'

export const SOURCE_CATALOG_SCHEMA_V1 = 'egolens-source-catalog-v1' as const
export const DEFAULT_TRANSPORT_CHUNK_SIZE_V1 = 1024 * 1024
export const MAX_SOURCE_CATALOG_ENTRIES_V1 = 20_000
export const MAX_SOURCE_CATALOG_BYTES_V1 = 16 * 1024 * 1024

const SHA256 = /^sha256:[0-9a-f]{64}$/u

export interface SourceCatalogChunksV1 {
  readonly size: number
  readonly digests: readonly string[]
}

export interface SourceCatalogEntryV1 {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly mediaType?: string
  readonly chunks?: SourceCatalogChunksV1
}

export interface SourceCatalogV1 {
  readonly schema: typeof SOURCE_CATALOG_SCHEMA_V1
  readonly entries: readonly SourceCatalogEntryV1[]
  readonly catalogHash: string
}

export interface SourceManifestEntryV1 {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

export interface ValidatedSourceCatalogV1 {
  readonly catalog: SourceCatalogV1
  readonly catalogHash: string
  readonly sourceManifestHash: string
  readonly manifestEntries: readonly SourceManifestEntryV1[]
}

const validator = new Ajv2020({ allErrors: true, strict: true }).compile(
  sourceCatalogSchema,
) as ValidateFunction<SourceCatalogV1>

function schemaErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`).join('; ')
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function catalogPayload(catalog: Pick<SourceCatalogV1, 'schema' | 'entries'>): JsonValue {
  return json({ schema: catalog.schema, entries: catalog.entries })
}

export function sourceCatalogHashV1(catalog: Pick<SourceCatalogV1, 'schema' | 'entries'>): string {
  return sha256DigestV1(new TextEncoder().encode(canonicalizeJson(catalogPayload(catalog))))
}

export function sourceManifestHashV1(entries: readonly SourceManifestEntryV1[]): string {
  const canonicalEntries = entries.map(({ path, size, sha256 }) => ({ path, size, sha256 }))
  return sha256DigestV1(new TextEncoder().encode(canonicalizeJson(json({
    version: 1,
    entries: canonicalEntries,
  }))))
}

function assertCanonicalEntries(entries: readonly SourceCatalogEntryV1[]): void {
  if (entries.length > MAX_SOURCE_CATALOG_ENTRIES_V1) throw new Error('SOURCE_CATALOG_ENTRY_LIMIT_EXCEEDED')
  let previous = ''
  const paths = new Set<string>()
  for (const entry of entries) {
    const normalized = normalizeSourcePathV1(entry.path)
    if (normalized !== entry.path || entry.path.includes('\\')) throw new Error(`SOURCE_CATALOG_PATH_NONCANONICAL: ${entry.path}`)
    if (paths.has(entry.path)) throw new Error(`SOURCE_CATALOG_PATH_DUPLICATE: ${entry.path}`)
    if (previous && previous >= entry.path) throw new Error('SOURCE_CATALOG_ENTRIES_UNSORTED')
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`SOURCE_CATALOG_SIZE_INVALID: ${entry.path}`)
    if (!SHA256.test(entry.sha256)) throw new Error(`SOURCE_CATALOG_DIGEST_INVALID: ${entry.path}`)
    if (entry.mediaType !== undefined && entry.mediaType.trim() !== entry.mediaType) {
      throw new Error(`SOURCE_CATALOG_MEDIA_TYPE_NONCANONICAL: ${entry.path}`)
    }
    if (entry.chunks) {
      const count = entry.size === 0 ? 0 : Math.ceil(entry.size / entry.chunks.size)
      if (entry.chunks.digests.length !== count) throw new Error(`SOURCE_CATALOG_CHUNK_COUNT_INVALID: ${entry.path}`)
    }
    paths.add(entry.path)
    previous = entry.path
  }
}

export function validateSourceCatalogV1(
  value: unknown,
  expected: { readonly catalogHash?: string; readonly sourceManifestHash?: string } = {},
): ValidatedSourceCatalogV1 {
  if (!validator(value)) throw new Error(`SOURCE_CATALOG_SCHEMA_INVALID: ${schemaErrors(validator.errors)}`)
  const received = value as SourceCatalogV1
  const serializedBytes = new TextEncoder().encode(JSON.stringify(received)).byteLength
  if (serializedBytes > MAX_SOURCE_CATALOG_BYTES_V1) throw new Error('SOURCE_CATALOG_BYTE_LIMIT_EXCEEDED')
  assertCanonicalEntries(received.entries)
  const catalogHash = sourceCatalogHashV1(received)
  if (received.catalogHash !== catalogHash || (expected.catalogHash && expected.catalogHash !== catalogHash)) {
    throw new Error('SOURCE_CATALOG_HASH_MISMATCH')
  }
  const entries = received.entries.map((entry) => Object.freeze({
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
    ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
    ...(entry.chunks === undefined ? {} : {
      chunks: Object.freeze({ size: entry.chunks.size, digests: Object.freeze([...entry.chunks.digests]) }),
    }),
  }))
  const catalog: SourceCatalogV1 = Object.freeze({
    schema: SOURCE_CATALOG_SCHEMA_V1,
    entries: Object.freeze(entries),
    catalogHash,
  })
  const manifestEntries = entries.map(({ path, size, sha256 }) => Object.freeze({ path, size, sha256 }))
  const sourceManifestHash = sourceManifestHashV1(manifestEntries)
  if (expected.sourceManifestHash && expected.sourceManifestHash !== sourceManifestHash) {
    throw new Error('SOURCE_MANIFEST_HASH_MISMATCH')
  }
  return Object.freeze({ catalog, catalogHash, sourceManifestHash, manifestEntries: Object.freeze(manifestEntries) })
}

export async function generateSourceCatalogV1(
  inventory: SourceInventoryV1,
  options: {
    readonly transportChunkSize?: number | null
    readonly signal?: AbortSignal
    readonly onProgress?: (progress: {
      readonly path: string
      readonly entryIndex: number
      readonly entryCount: number
      readonly bytesHashed: number
      readonly totalBytes: number
    }) => void
  } = {},
): Promise<ValidatedSourceCatalogV1> {
  const snapshot = inventory.snapshot()
  if (snapshot.revoked) throw new Error('SOURCE_INVENTORY_REVOKED')
  if (snapshot.truncated) throw new Error('SOURCE_INVENTORY_TRUNCATED')
  const chunkSize = options.transportChunkSize === undefined
    ? DEFAULT_TRANSPORT_CHUNK_SIZE_V1
    : options.transportChunkSize
  if (chunkSize !== null && (!Number.isSafeInteger(chunkSize) || chunkSize < 65_536 || chunkSize > 67_108_864)) {
    throw new Error('SOURCE_CATALOG_CHUNK_SIZE_INVALID')
  }
  const totalBytes = snapshot.entries.reduce((total, entry) => total + entry.size, 0)
  if (!Number.isSafeInteger(totalBytes)) throw new Error('SOURCE_MANIFEST_SIZE_INVALID')
  let bytesHashed = 0
  const entries: SourceCatalogEntryV1[] = []
  for (const [entryIndex, entry] of snapshot.entries.entries()) {
    if (options.signal?.aborted) throw new DOMException('Source catalog generation was aborted.', 'AbortError')
    const hasher = new IncrementalSha256V1()
    const digests: string[] = []
    const readSize = chunkSize ?? DEFAULT_TRANSPORT_CHUNK_SIZE_V1
    for (let start = 0; start < entry.size; start += readSize) {
      const end = Math.min(entry.size, start + readSize)
      const chunk = await inventory.readAuthorizedBytes(entry.path, { start, end, signal: options.signal })
      if (chunk.byteLength !== end - start) throw new Error(`SOURCE_MANIFEST_READ_LENGTH_MISMATCH: ${entry.path}`)
      hasher.update(chunk)
      if (chunkSize !== null) digests.push(sha256DigestV1(chunk))
      bytesHashed += chunk.byteLength
      options.onProgress?.({ path: entry.path, entryIndex, entryCount: snapshot.entries.length, bytesHashed, totalBytes })
    }
    const digest = `sha256:${[...hasher.digest()].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
    entries.push(Object.freeze({
      path: entry.path,
      size: entry.size,
      sha256: digest,
      ...(entry.type ? { mediaType: entry.type } : {}),
      ...(chunkSize === null ? {} : { chunks: Object.freeze({ size: chunkSize, digests: Object.freeze(digests) }) }),
    }))
  }
  const withoutHash = { schema: SOURCE_CATALOG_SCHEMA_V1, entries: Object.freeze(entries) }
  const catalog: SourceCatalogV1 = Object.freeze({ ...withoutHash, catalogHash: sourceCatalogHashV1(withoutHash) })
  return validateSourceCatalogV1(catalog)
}

export function sourceCatalogInventoryEntriesV1(catalog: SourceCatalogV1): readonly { readonly path: string; readonly size: number }[] {
  return catalog.entries.map((entry) => ({ path: entry.path, size: entry.size }))
}
