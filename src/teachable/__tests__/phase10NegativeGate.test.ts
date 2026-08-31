import { describe, expect, it, vi } from 'vitest'
import waymoRecipe from '../../adapters/recipes/waymo.egolens-adapter.json'
import { recipeHashV1 } from '../authoring/hashes'
import { OperatorRegistry } from '../operators/registry'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import {
  decodePortableShareRequestV1,
  fetchShareDescriptorV1,
} from '../share/ShareDescriptor'
import {
  fetchRemoteRecipeV1,
  VerifiedRecipeCacheV1,
} from '../share/RecipeTransport'
import {
  fetchSourceCatalogV1,
  RemoteByteSourceV1,
} from '../source/RemoteByteSource'
import {
  sourceCatalogHashV1,
  sourceManifestHashV1,
  type SourceCatalogV1,
} from '../source/SourceCatalog'
import { sha256DigestV1 } from '../source/sha256'

const recipe = waymoRecipe as EgoLensAdapterRecipeV1

function catalog(bytes: Uint8Array, chunks = false): SourceCatalogV1 {
  const entry = {
    path: 'frames/data.bin', size: bytes.byteLength, sha256: sha256DigestV1(bytes),
    ...(chunks ? { chunks: { size: 65_536, digests: [sha256DigestV1(bytes)] } } : {}),
  }
  const payload = { schema: 'egolens-source-catalog-v1' as const, entries: [entry] }
  return { ...payload, catalogHash: sourceCatalogHashV1(payload) }
}

function response(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(bytes.slice().buffer, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
    ...init,
  })
}

describe('Phase 10 required negative gates', () => {
  it('catalog-traversal', () => {
    const bytes = new Uint8Array([1])
    const invalid = catalog(bytes) as unknown as { entries: Array<{ path: string }>; catalogHash: string }
    invalid.entries[0]!.path = '../escape.bin'
    expect(() => new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: invalid,
    })).toThrowError(/REMOTE_CATALOG_INVALID/u)
  })

  it('cors-denial', async () => {
    const bytes = new Uint8Array([1])
    const source = new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: catalog(bytes),
      fetch: vi.fn<typeof fetch>(async () => { throw new TypeError('CORS blocked') }),
      limits: { maxRetries: 0 },
    })
    await expect(source.read('frames/data.bin')).rejects.toMatchObject({ code: 'REMOTE_CORS' })
  })

  it('credential-isolation', async () => {
    const bytes = new Uint8Array([1])
    const omitted = vi.fn<typeof fetch>(async () => response(bytes))
    await new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: catalog(bytes), fetch: omitted,
    }).read('frames/data.bin')
    expect(omitted).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      credentials: 'omit', referrerPolicy: 'no-referrer',
    }))
    expect(() => new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: catalog(bytes),
      credentialGrant: { origin: 'https://other.example.test' },
    })).toThrowError(/exactly equal/u)
  })

  it('redirect-confinement', async () => {
    const bytes = new Uint8Array([1])
    const source = new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: catalog(bytes),
      fetch: vi.fn<typeof fetch>(async () => new Response(null, {
        status: 302, headers: { location: 'https://evil.example.test/data.bin' },
      })),
    })
    await expect(source.read('frames/data.bin')).rejects.toMatchObject({ code: 'REMOTE_REDIRECT_FORBIDDEN' })
  })

  it('source-tampering', async () => {
    const bytes = new Uint8Array([1])
    const source = new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: catalog(bytes),
      fetch: vi.fn<typeof fetch>(async () => response(new Uint8Array([2]))),
    })
    await expect(source.read('frames/data.bin')).rejects.toMatchObject({ code: 'REMOTE_DIGEST_MISMATCH' })
  })

  it('oversized-response', async () => {
    const bytes = new Uint8Array([1])
    const value = catalog(bytes)
    await expect(fetchSourceCatalogV1('https://data.example.test/catalog.json', {
      expectedCatalogHash: value.catalogHash,
      maxBytes: 16,
      fetch: vi.fn<typeof fetch>(async () => new Response('{}', {
        status: 200, headers: { 'content-length': '17' },
      })),
    })).rejects.toMatchObject({ code: 'REMOTE_OBJECT_LIMIT_EXCEEDED' })
  })

  it('abort-propagation', async () => {
    const bytes = new Uint8Array([1])
    const pending = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const source = new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: catalog(bytes), fetch: pending,
    })
    const controller = new AbortController()
    const read = source.read('frames/data.bin', { signal: controller.signal })
    controller.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('missing-range-support', async () => {
    const bytes = new Uint8Array(65_536).fill(4)
    const source = new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: catalog(bytes, true),
      fetch: vi.fn<typeof fetch>(async () => response(bytes)),
      limits: { maxFullObjectBytes: 1024 },
    })
    await expect(source.read('frames/data.bin', { start: 1, end: 2 }))
      .rejects.toMatchObject({ code: 'REMOTE_RANGE_REQUIRED' })
  })

  it('source-hash-mismatch', () => {
    const bytes = new Uint8Array([1])
    const value = catalog(bytes)
    expect(() => new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog: value,
      expectedSourceManifestHash: `sha256:${'0'.repeat(64)}`,
    })).toThrowError(/REMOTE_CATALOG_INVALID/u)
    expect(sourceManifestHashV1(value.entries)).not.toBe(`sha256:${'0'.repeat(64)}`)
  })

  it('recipe-hash-mismatch', async () => {
    await expect(fetchRemoteRecipeV1(
      'https://recipes.example.test/waymo.json', `sha256:${'0'.repeat(64)}`,
      {
        cache: new VerifiedRecipeCacheV1(),
        fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(recipe))),
      },
    )).rejects.toMatchObject({ code: 'REMOTE_RECIPE_HASH_MISMATCH' })
  })

  it('descriptor-hash-mismatch', async () => {
    await expect(fetchShareDescriptorV1(
      'https://share.example.test/view.json', `sha256:${'0'.repeat(64)}`,
      { fetch: vi.fn<typeof fetch>(async () => new Response('{}')) },
    )).rejects.toMatchObject({ code: 'SHARE_DESCRIPTOR_HASH_MISMATCH' })
  })

  it('ambiguous-share-form', () => {
    expect(() => decodePortableShareRequestV1(
      `https://viewer.example.test/?share=https%3A%2F%2Fshare.example.test%2Fview.json&shareHash=sha256%3A${'a'.repeat(64)}&scene=smuggled`,
    )).toThrowError(/SHARE_DESCRIPTOR_AMBIGUOUS/u)
  })

  it('unavailable-registered-extension', async () => {
    const expected = await recipeHashV1(recipe)
    await expect(fetchRemoteRecipeV1('https://recipes.example.test/waymo.json', expected, {
      cache: new VerifiedRecipeCacheV1(),
      fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(recipe))),
      operators: new OperatorRegistry(),
    })).rejects.toMatchObject({ code: 'REMOTE_RECIPE_INVALID' })
  })
})
