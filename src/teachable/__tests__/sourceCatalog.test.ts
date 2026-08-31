import { describe, expect, it, vi } from 'vitest'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import {
  generateSourceCatalogV1,
  sourceCatalogHashV1,
  sourceManifestHashV1,
  validateSourceCatalogV1,
  type SourceCatalogV1,
} from '../source/SourceCatalog'
import { IncrementalSha256V1, sha256DigestV1, sha256HexBytesV1 } from '../source/sha256'

const encoder = new TextEncoder()

function withHash(entries: SourceCatalogV1['entries']): SourceCatalogV1 {
  const payload = { schema: 'egolens-source-catalog-v1' as const, entries }
  return { ...payload, catalogHash: sourceCatalogHashV1(payload) }
}

describe('incremental SHA-256', () => {
  it('matches the FIPS empty and abc vectors', () => {
    expect(sha256HexBytesV1(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256HexBytesV1(encoder.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('is independent of update boundaries and matches WebCrypto', async () => {
    const input = new Uint8Array(256_019)
    for (let index = 0; index < input.length; index += 1) input[index] = (index * 31 + 7) & 0xff
    const hasher = new IncrementalSha256V1()
    for (let offset = 0; offset < input.length; offset += 137) hasher.update(input.subarray(offset, offset + 137))
    const incremental = [...hasher.digest()].map((value) => value.toString(16).padStart(2, '0')).join('')
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))]
      .map((value) => value.toString(16).padStart(2, '0')).join('')
    expect(incremental).toBe(expected)
    expect(() => hasher.update(input)).toThrow(/SHA256_ALREADY_FINALIZED/u)
    expect(() => hasher.digest()).toThrow(/SHA256_ALREADY_FINALIZED/u)
  })
})

describe('Source Catalog v1', () => {
  it('generates canonical sorted full-file and fixed-chunk digests', async () => {
    const large = new Uint8Array(70_000)
    large.fill(3)
    const inventory = new SourceInventoryV1([
      ['z/empty.bin', new File([], 'empty.bin', { type: 'application/octet-stream', lastModified: 9 })],
      ['a/data.bin', new File([large], 'data.bin', { type: 'application/custom', lastModified: 7 })],
    ])
    const progress = vi.fn()
    const result = await generateSourceCatalogV1(inventory, { transportChunkSize: 65_536, onProgress: progress })

    expect(result.catalog.entries.map((entry) => entry.path)).toEqual(['a/data.bin', 'z/empty.bin'])
    expect(result.catalog.entries[0]).toMatchObject({
      size: 70_000,
      sha256: sha256DigestV1(large),
      mediaType: 'application/custom',
      chunks: {
        size: 65_536,
        digests: [
          sha256DigestV1(large.subarray(0, 65_536)),
          sha256DigestV1(large.subarray(65_536)),
        ],
      },
    })
    expect(result.catalog.entries[1]?.sha256).toBe(sha256DigestV1(new Uint8Array()))
    expect(result.catalog.entries[1]?.chunks?.digests).toEqual([])
    expect(result.catalogHash).toBe(sourceCatalogHashV1(result.catalog))
    expect(result.sourceManifestHash).toBe(sourceManifestHashV1(result.manifestEntries))
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ bytesHashed: 70_000, totalBytes: 70_000 }))
  })

  it('keeps manifest identity independent of media metadata, chunks, and File metadata', async () => {
    const bytes = encoder.encode('transport independent')
    const left = await generateSourceCatalogV1(new SourceInventoryV1([
      ['same.bin', new File([bytes], 'left.bin', { type: 'application/a', lastModified: 1 })],
    ]), { transportChunkSize: null })
    const right = await generateSourceCatalogV1(new SourceInventoryV1([
      ['same.bin', new File([bytes], 'right.bin', { type: 'application/b', lastModified: 2 })],
    ]), { transportChunkSize: 65_536 })

    expect(left.sourceManifestHash).toBe(right.sourceManifestHash)
    expect(left.catalogHash).not.toBe(right.catalogHash)
  })

  it('validates expected catalog and manifest identities', () => {
    const entry = { path: 'a.bin', size: 1, sha256: sha256DigestV1(new Uint8Array([1])) }
    const catalog = withHash([entry])
    const validated = validateSourceCatalogV1(catalog)
    expect(validateSourceCatalogV1(catalog, validated)).toEqual(validated)
    expect(() => validateSourceCatalogV1(catalog, { catalogHash: `sha256:${'0'.repeat(64)}` }))
      .toThrow(/SOURCE_CATALOG_HASH_MISMATCH/u)
    expect(() => validateSourceCatalogV1(catalog, { sourceManifestHash: `sha256:${'0'.repeat(64)}` }))
      .toThrow(/SOURCE_MANIFEST_HASH_MISMATCH/u)
  })

  it('returns a deeply frozen copy that cannot be changed after validation', () => {
    const mutable = withHash([{
      path: 'a.bin', size: 1, sha256: sha256DigestV1(new Uint8Array([1])),
      chunks: { size: 65_536, digests: [sha256DigestV1(new Uint8Array([1]))] },
    }])
    const validated = validateSourceCatalogV1(mutable)
    const attacker = mutable as unknown as { entries: Array<{ chunks: { digests: string[] } }> }
    attacker.entries[0]!.chunks.digests[0] = `sha256:${'0'.repeat(64)}`
    expect(validated.catalog.entries[0]?.chunks?.digests[0]).toBe(sha256DigestV1(new Uint8Array([1])))
    expect(Object.isFrozen(validated.catalog.entries[0]?.chunks?.digests)).toBe(true)
  })

  it.each([
    ['unknown field', () => ({ ...withHash([]), extra: true })],
    ['absolute path', () => withHash([{ path: '/a.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()) }])],
    ['traversal path', () => withHash([{ path: 'a/../b.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()) }])],
    ['backslash path', () => withHash([{ path: 'a\\b.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()) }])],
    ['unsorted entries', () => withHash([
      { path: 'b.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()) },
      { path: 'a.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()) },
    ])],
    ['duplicate entries', () => withHash([
      { path: 'a.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()) },
      { path: 'a.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()) },
    ])],
    ['wrong chunk count', () => withHash([{
      path: 'a.bin', size: 1, sha256: sha256DigestV1(new Uint8Array([1])),
      chunks: { size: 65_536, digests: [] },
    }])],
    ['uppercase digest', () => withHash([{
      path: 'a.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()).toUpperCase(),
    }])],
  ])('rejects a non-canonical catalog: %s', (_label, create) => {
    expect(() => validateSourceCatalogV1(create())).toThrow()
  })

  it('rejects stale self hashes, truncated inventories, revocation, and cancellation', async () => {
    const catalog = withHash([{ path: 'a.bin', size: 0, sha256: sha256DigestV1(new Uint8Array()) }])
    expect(() => validateSourceCatalogV1({ ...catalog, catalogHash: `sha256:${'0'.repeat(64)}` }))
      .toThrow(/SOURCE_CATALOG_HASH_MISMATCH/u)
    await expect(generateSourceCatalogV1(new SourceInventoryV1([], { truncated: true })))
      .rejects.toThrow(/SOURCE_INVENTORY_TRUNCATED/u)
    const revoked = new SourceInventoryV1([])
    revoked.revoke()
    await expect(generateSourceCatalogV1(revoked)).rejects.toThrow(/SOURCE_INVENTORY_REVOKED/u)
    const controller = new AbortController()
    controller.abort()
    await expect(generateSourceCatalogV1(new SourceInventoryV1([
      ['a.bin', new File(['a'], 'a.bin')],
    ]), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
