import { describe, expect, it, vi } from 'vitest'
import { sourceCatalogHashV1, sourceManifestHashV1, type SourceCatalogV1 } from '../source/SourceCatalog'
import {
  fetchSourceCatalogV1,
  RemoteByteSourceV1,
  VerifiedSourceCacheV1,
} from '../source/RemoteByteSource'
import { sha256DigestV1 } from '../source/sha256'

function catalogFor(path: string, bytes: Uint8Array, chunkSize: number | null = 65_536): SourceCatalogV1 {
  const entry = {
    path,
    size: bytes.byteLength,
    sha256: sha256DigestV1(bytes),
    ...(chunkSize === null ? {} : {
      chunks: {
        size: chunkSize,
        digests: Array.from({ length: Math.ceil(bytes.byteLength / chunkSize) }, (_, index) =>
          sha256DigestV1(bytes.subarray(index * chunkSize, Math.min(bytes.byteLength, (index + 1) * chunkSize)))),
      },
    }),
  }
  const payload = { schema: 'egolens-source-catalog-v1' as const, entries: [entry] }
  return { ...payload, catalogHash: sourceCatalogHashV1(payload) }
}

function rangeFetch(
  bytes: Uint8Array,
  options: { readonly ignoreRange?: boolean; readonly tamper?: boolean; readonly contentRange?: string | null } = {},
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const range = new Headers(init?.headers).get('range')
    if (range && !options.ignoreRange) {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range)
      if (!match) return new Response(null, { status: 416 })
      const start = Number(match[1])
      const end = Number(match[2]) + 1
      const body = bytes.slice(start, end)
      if (options.tamper && body.length > 0) body[0] ^= 0xff
      const headers = new Headers({ 'content-length': String(body.byteLength) })
      if (options.contentRange !== null) {
        headers.set('content-range', options.contentRange ?? `bytes ${start}-${end - 1}/${bytes.byteLength}`)
      }
      return new Response(body.buffer, { status: 206, headers })
    }
    const body = bytes.slice()
    if (options.tamper && body.length > 0) body[0] ^= 0xff
    return new Response(body.buffer, { status: 200, headers: { 'content-length': String(body.byteLength) } })
  })
}

function makeSource(
  bytes: Uint8Array,
  options: ConstructorParameters<typeof RemoteByteSourceV1>[0] & { readonly rootUrl: string },
  chunkSize: number | null = 65_536,
): RemoteByteSourceV1 {
  return new RemoteByteSourceV1({ catalog: catalogFor('frames/data.bin', bytes, chunkSize), ...options })
}

describe('RemoteByteSourceV1 verified transport', () => {
  it('expands ranges to transport chunks, verifies them, and reuses verified cache bytes', async () => {
    const bytes = new Uint8Array(140_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index & 0xff
    const request = rangeFetch(bytes)
    const source = makeSource(bytes, { rootUrl: 'http://127.0.0.1:8123/root/', fetch: request })

    await expect(source.read('frames/data.bin', { start: 100, end: 66_000 }))
      .resolves.toEqual(bytes.slice(100, 66_000).buffer)
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('range')).toBe('bytes=0-131071')
    expect(source.responseBytes).toBe(131_072)

    await expect(source.read('frames/data.bin', { start: 65_000, end: 70_000 }))
      .resolves.toEqual(bytes.slice(65_000, 70_000).buffer)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses bounded full-object verification when chunk digests are absent', async () => {
    const bytes = new TextEncoder().encode('complete object verification')
    const request = rangeFetch(bytes)
    const source = makeSource(bytes, { rootUrl: 'https://data.example.test/source/', fetch: request }, null)

    await expect(source.read('frames/data.bin', { start: 9, end: 15 }))
      .resolves.toEqual(bytes.slice(9, 15).buffer)
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('range')).toBeNull()
    expect(source.responseBytes).toBe(bytes.byteLength)
  })

  it('accepts a server ignoring Range only for a bounded, fully verified object', async () => {
    const bytes = new Uint8Array(70_000).fill(4)
    const accepted = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: rangeFetch(bytes, { ignoreRange: true }),
      limits: { maxFullObjectBytes: 80_000 },
    })
    await expect(accepted.read('frames/data.bin', { start: 1, end: 3 })).resolves.toEqual(bytes.slice(1, 3).buffer)

    const rejected = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: rangeFetch(bytes, { ignoreRange: true }),
      limits: { maxFullObjectBytes: 65_536 },
    })
    await expect(rejected.read('frames/data.bin', { start: 1, end: 3 })).rejects.toMatchObject({ code: 'REMOTE_RANGE_REQUIRED' })
  })

  it('fails closed on tampering, invalid range headers, and length mismatch', async () => {
    const bytes = new Uint8Array(70_000).fill(8)
    const tampered = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: rangeFetch(bytes, { tamper: true }),
    })
    await expect(tampered.read('frames/data.bin', { start: 1, end: 3 })).rejects.toMatchObject({ code: 'REMOTE_DIGEST_MISMATCH' })

    const noHeader = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: rangeFetch(bytes, { contentRange: null }),
    })
    await expect(noHeader.read('frames/data.bin', { start: 1, end: 3 })).rejects.toMatchObject({ code: 'REMOTE_RANGE_RESPONSE_INVALID' })

    const badLength = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1]).buffer, {
      status: 200, headers: { 'content-length': '2' },
    }))
    const source = makeSource(new Uint8Array([1]), {
      rootUrl: 'https://data.example.test/root/', fetch: badLength,
    }, null)
    await expect(source.read('frames/data.bin')).rejects.toMatchObject({ code: 'REMOTE_LENGTH_MISMATCH' })
  })

  it('does not promote failed bytes into a shared verified cache', async () => {
    const bytes = new Uint8Array(70_000).fill(9)
    const catalog = catalogFor('frames/data.bin', bytes)
    const cache = new VerifiedSourceCacheV1(200_000)
    const badFetch = rangeFetch(bytes, { tamper: true })
    const bad = new RemoteByteSourceV1({ rootUrl: 'https://one.example.test/root/', catalog, fetch: badFetch, cache })
    await expect(bad.read('frames/data.bin', { start: 1, end: 3 })).rejects.toMatchObject({ code: 'REMOTE_DIGEST_MISMATCH' })
    expect(cache.sizeBytes).toBe(0)

    const goodFetch = rangeFetch(bytes)
    const good = new RemoteByteSourceV1({ rootUrl: 'https://two.example.test/elsewhere/', catalog, fetch: goodFetch, cache })
    await expect(good.read('frames/data.bin', { start: 1, end: 3 })).resolves.toEqual(bytes.slice(1, 3).buffer)
    expect(goodFetch).toHaveBeenCalledTimes(1)

    const neverFetch = vi.fn<typeof fetch>()
    const reused = new RemoteByteSourceV1({ rootUrl: 'https://three.example.test/new/', catalog, fetch: neverFetch, cache })
    await expect(reused.read('frames/data.bin', { start: 5, end: 8 })).resolves.toEqual(bytes.slice(5, 8).buffer)
    expect(neverFetch).not.toHaveBeenCalled()
  })

  it('revalidates externally shared cache entries before trusting them', async () => {
    const bytes = new Uint8Array(70_000).fill(6)
    const catalog = catalogFor('frames/data.bin', bytes)
    const sourceHash = sourceManifestHashV1(catalog.entries)
    const chunkDigest = catalog.entries[0]?.chunks?.digests[0]
    expect(chunkDigest).toBeDefined()
    const cache = new VerifiedSourceCacheV1(200_000)
    cache.set(`${sourceHash}\u0000frames/data.bin\u0000${chunkDigest}`, new Uint8Array(65_536).fill(99))
    const request = rangeFetch(bytes)
    const source = new RemoteByteSourceV1({
      rootUrl: 'https://data.example.test/root/', catalog, fetch: request, cache,
    })

    await expect(source.read('frames/data.bin', { start: 1, end: 3 }))
      .resolves.toEqual(bytes.slice(1, 3).buffer)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('retries transient responses and distinguishes retry, auth, missing, and CORS failures', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const success = rangeFetch(bytes)
    const retryThenSuccess = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(success)
    const recovered = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: retryThenSuccess,
      limits: { retryBaseDelayMs: 0, maxRetries: 1 },
    }, null)
    await expect(recovered.read('frames/data.bin')).resolves.toEqual(bytes.buffer)

    for (const [status, code] of [[503, 'REMOTE_RETRY_EXHAUSTED'], [401, 'REMOTE_AUTHORIZATION_FAILED'], [404, 'REMOTE_SOURCE_NOT_FOUND']] as const) {
      const source = makeSource(bytes, {
        rootUrl: 'https://data.example.test/root/',
        fetch: vi.fn<typeof fetch>(async () => new Response(null, { status })),
        limits: { retryBaseDelayMs: 0, maxRetries: 1 },
      }, null)
      await expect(source.read('frames/data.bin')).rejects.toMatchObject({ code })
    }
    const cors = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/',
      fetch: vi.fn<typeof fetch>(async () => { throw new TypeError('blocked') }),
      limits: { retryBaseDelayMs: 0, maxRetries: 1 },
    }, null)
    await expect(cors.read('frames/data.bin')).rejects.toMatchObject({ code: 'REMOTE_CORS' })
  })

  it('confines source roots and every redirect', async () => {
    const bytes = new Uint8Array([1])
    expect(() => makeSource(bytes, { rootUrl: 'http://data.example.test/root/', fetch: rangeFetch(bytes) }, null))
      .toThrow(/REMOTE_URL_INVALID/u)
    expect(() => makeSource(bytes, { rootUrl: 'https://user:secret@data.example.test/root/', fetch: rangeFetch(bytes) }, null))
      .toThrow(/REMOTE_URL_INVALID/u)
    expect(() => makeSource(bytes, { rootUrl: 'https://data.example.test/root/?token=secret', fetch: rangeFetch(bytes) }, null))
      .toThrow(/REMOTE_URL_INVALID/u)

    const redirected = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/',
      fetch: vi.fn<typeof fetch>(async () => new Response(null, {
        status: 302, headers: { location: 'https://evil.example.test/root/data.bin' },
      })),
    }, null)
    await expect(redirected.read('frames/data.bin')).rejects.toMatchObject({ code: 'REMOTE_REDIRECT_FORBIDDEN' })

    const crossRoot = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/',
      fetch: vi.fn<typeof fetch>(async () => new Response(null, {
        status: 302, headers: { location: 'https://data.example.test/private/data.bin' },
      })),
    }, null)
    await expect(crossRoot.read('frames/data.bin')).rejects.toMatchObject({ code: 'REMOTE_REDIRECT_FORBIDDEN' })

    const finalFetch = rangeFetch(bytes)
    const sameRootFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '../redirected.bin' } }))
      .mockImplementation(finalFetch)
    const sameRoot = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: sameRootFetch,
    }, null)
    await expect(sameRoot.read('frames/data.bin')).resolves.toEqual(bytes.buffer)
    expect(sameRootFetch).toHaveBeenCalledTimes(2)
  })

  it('omits credentials by default and includes them only for an exact-origin grant', async () => {
    const bytes = new Uint8Array([1])
    const omittedFetch = rangeFetch(bytes)
    await makeSource(bytes, { rootUrl: 'https://data.example.test/root/', fetch: omittedFetch }, null).read('frames/data.bin')
    expect(omittedFetch.mock.calls[0]?.[1]?.credentials).toBe('omit')
    expect(omittedFetch.mock.calls[0]?.[1]?.referrerPolicy).toBe('no-referrer')

    const includedFetch = rangeFetch(bytes)
    await makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: includedFetch,
      credentialGrant: { origin: 'https://data.example.test' },
    }, null).read('frames/data.bin')
    expect(includedFetch.mock.calls[0]?.[1]?.credentials).toBe('include')
    expect(() => makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: rangeFetch(bytes),
      credentialGrant: { origin: 'https://other.example.test' },
    }, null)).toThrow(/exactly equal/u)
  })

  it('enforces cumulative byte budgets, cancellation, and idempotent disposal', async () => {
    const bytes = new Uint8Array(70_000).fill(2)
    const budgeted = makeSource(bytes, {
      rootUrl: 'https://data.example.test/root/', fetch: rangeFetch(bytes),
      limits: { maxTotalResponseBytes: 10 },
    })
    await expect(budgeted.read('frames/data.bin', { start: 1, end: 3 })).rejects.toMatchObject({ code: 'REMOTE_BYTE_BUDGET_EXCEEDED' })

    const pendingFetch = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const pending = makeSource(bytes, { rootUrl: 'https://data.example.test/root/', fetch: pendingFetch })
    const externalController = new AbortController()
    const externalRead = pending.read('frames/data.bin', { start: 1, end: 3, signal: externalController.signal })
    externalController.abort()
    await expect(externalRead).rejects.toMatchObject({ name: 'AbortError' })

    const read = pending.read('frames/data.bin', { start: 1, end: 3 })
    pending.dispose()
    pending.dispose()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pending.read('frames/data.bin')).rejects.toMatchObject({ code: 'REMOTE_SOURCE_DISPOSED' })
  })

  it('validates bounded fetched catalogs before returning them', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const catalog = catalogFor('frames/data.bin', bytes)
    const sourceHash = sourceManifestHashV1(catalog.entries)
    const body = new TextEncoder().encode(JSON.stringify(catalog))
    const catalogFetch = vi.fn<typeof fetch>(async () => new Response(body.buffer, {
      status: 200, headers: { 'content-length': String(body.byteLength) },
    }))
    const fetched = await fetchSourceCatalogV1('https://data.example.test/catalog.json', {
      expectedCatalogHash: catalog.catalogHash,
      expectedSourceManifestHash: sourceHash,
      fetch: catalogFetch,
    })
    expect(fetched.sourceManifestHash).toBe(sourceHash)
    expect(catalogFetch.mock.calls[0]?.[1]?.credentials).toBe('omit')

    const privateFetch = vi.fn<typeof fetch>(async () => new Response(body.buffer, {
      status: 200, headers: { 'content-length': String(body.byteLength) },
    }))
    await fetchSourceCatalogV1('https://data.example.test/catalog.json', {
      expectedCatalogHash: catalog.catalogHash,
      fetch: privateFetch,
      credentialGrant: { origin: 'https://data.example.test' },
    })
    expect(privateFetch.mock.calls[0]?.[1]?.credentials).toBe('include')
    await expect(fetchSourceCatalogV1('https://data.example.test/catalog.json', {
      expectedCatalogHash: catalog.catalogHash,
      fetch: privateFetch,
      credentialGrant: { origin: 'https://other.example.test' },
    })).rejects.toMatchObject({ code: 'REMOTE_URL_INVALID' })

    await expect(fetchSourceCatalogV1('https://data.example.test/catalog.json', {
      expectedCatalogHash: catalog.catalogHash,
      fetch: vi.fn<typeof fetch>(async () => new Response(body.buffer, {
        status: 200, headers: { 'content-length': String(body.byteLength + 1) },
      })),
      maxBytes: body.byteLength,
    })).rejects.toMatchObject({ code: 'REMOTE_OBJECT_LIMIT_EXCEEDED' })

    await expect(fetchSourceCatalogV1('https://data.example.test/catalog.json', {
      expectedCatalogHash: catalog.catalogHash,
      fetch: vi.fn<typeof fetch>(async () => new Response(null, {
        status: 302, headers: { location: 'https://evil.example.test/catalog.json' },
      })),
    })).rejects.toMatchObject({ code: 'REMOTE_REDIRECT_FORBIDDEN' })
  })
})
