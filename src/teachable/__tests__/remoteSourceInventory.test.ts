import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceInventoryV1, sourceInventoryFromFilesV1, sourceInventoryFromRemoteV1 } from '../authoring/SourceInventory'
import { openRemoteSourceInventoryV1 } from '../authoring/RemoteSourceInventory'
import { TeachableAuthoringSessionV1 } from '../authoring/AuthoringSession'
import { BrowserGraphPreviewRuntimeV1 } from '../authoring/BrowserGraphPreviewRuntime'
import { InventoryBindingEvaluatorV1, type AuthoringPreviewRuntimeV1 } from '../authoring/InventoryBindingEvaluator'
import { datasetFingerprintV1, formatFingerprintV1 } from '../authoring/hashes'
import { inspectSourceInventoryV1 } from '../authoring/inspection'
import { authoringPreviewStoreV1 } from '../authoring/previewStore'
import { compileRecipeV1 } from '../recipe/compiler'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { assertValidRecipeV1 } from '../schema/validateSchema'
import { generateSourceCatalogV1, sourceCatalogHashV1 } from '../source/SourceCatalog'
import { RemoteByteSourceV1, SourceCacheV1 } from '../source/RemoteByteSource'
import minimalJson from '../__fixtures__/minimal.egolens-adapter.json'
import { remoteTransportFixtureV1 } from './remoteTransportFixture'

const rootUrl = 'https://data.example.test/sample/'
const catalogUrl = 'https://catalog.example.test/sample.json'

async function fixture(
  entries: readonly (readonly [string, File])[] = [
    ['frames.json', new File(['[{"timestamp_us":1},{"timestamp_us":2}]'], 'frames.json', { type: 'application/json', lastModified: 0 })],
  ],
  transportChunkSize: number | null = 65_536,
) {
  const local = new SourceInventoryV1(entries, { sessionId: 'shared-session' })
  const validated = await generateSourceCatalogV1(local, { transportChunkSize })
  const bytesByUrl = new Map(await Promise.all(entries.map(async ([path, file]) => [
    rootUrl + path.split('/').map(encodeURIComponent).join('/'), new Uint8Array(await file.arrayBuffer()),
  ] as const)))
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url === catalogUrl) return Response.json(validated.catalog)
    const bytes = bytesByUrl.get(url)
    if (!bytes) return new Response(null, { status: 404 })
    const range = new Headers(init?.headers).get('range')
    if (!range) return new Response(bytes.slice().buffer, { headers: { 'content-length': String(bytes.length) } })
    const match = /^bytes=(\d+)-(\d+)$/u.exec(range)!
    const start = Number(match[1])
    const end = Number(match[2]) + 1
    return new Response(bytes.slice(start, end).buffer, {
      status: 206,
      headers: { 'content-length': String(end - start), 'content-range': `bytes ${start}-${end - 1}/${bytes.length}` },
    })
  })
  return {
    local,
    validated,
    request,
    options: { rootUrl, catalogUrl, expectedCatalogHash: validated.catalogHash, fetch: request, sessionId: local.sessionId },
  }
}

function pendingResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function timelineRecipe() {
  const recipe = structuredClone(minimalJson)
  return assertValidRecipeV1({
    ...recipe,
    engine: {
      ...recipe.engine,
      requiredOperators: { 'json.records': { major: 1, provider: 'core' }, 'timeline.sort': { major: 1, provider: 'core' } },
    },
    pipelines: {
      timeline: {
        nodes: [{ id: 'sortTimeline', op: 'timeline.sort', version: 1, inputs: { rows: 'frames.rows' }, params: { timestampField: 'timestamp_us' } }],
        result: 'sortTimeline.frames',
      },
    },
  })
}

describe('whole-file transport for hosts without exposed Range metadata', () => {
  it('verifies the full file before slicing and reuses it for later partial reads', async () => {
    const f = await fixture()
    const inventory = await openRemoteSourceInventoryV1({ ...f.options, preferFullObjects: true })
    const bytes = await inventory.readAuthorizedBytes('frames.json', { start: 2, end: 9 })
    expect(bytes).toEqual(await f.local.readAuthorizedBytes('frames.json', { start: 2, end: 9 }))
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(new Headers(f.request.mock.calls[1][1]?.headers).has('range')).toBe(false)
    await inventory.readAuthorizedBytes('frames.json', { start: 9, end: 12 })
    expect(f.request).toHaveBeenCalledTimes(2)
    inventory.revoke()
  })

  it('retains the full-object limit even for a tiny requested slice', async () => {
    const f = await fixture()
    const inventory = await openRemoteSourceInventoryV1({ ...f.options, preferFullObjects: true, limits: { maxFullObjectBytes: 1 } })
    await expect(inventory.readAuthorizedBytes('frames.json', { start: 0, end: 1 })).rejects.toMatchObject({ code: 'REMOTE_OBJECT_LIMIT_EXCEEDED' })
    expect(f.request).toHaveBeenCalledOnce()
    inventory.revoke()
  })

  it('returns same-length payloads without content hashing', async () => {
    const f = await fixture()
    const inventory = await openRemoteSourceInventoryV1({ ...f.options, preferFullObjects: true })
    f.request.mockResolvedValueOnce(new Response(new Uint8Array(f.validated.catalog.entries[0].size)))
    await expect(inventory.readAuthorizedBytes('frames.json', { start: 0, end: 1 })).resolves.toEqual(new Uint8Array(1).buffer)
    inventory.revoke()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  authoringPreviewStoreV1.clear()
})

describe('remote SourceInventoryV1 initialization and metadata', () => {
  it('preserves the local constructor, file factory, metadata, and snapshot shape', () => {
    const file = new File(['hello'], 'Data.BIN', { type: 'application/octet-stream', lastModified: 42 })
    const slice = vi.spyOn(file, 'slice')
    const inventory = new SourceInventoryV1([['./folder\\Data.BIN', file]], { sessionId: 'local', truncated: true })
    expect(inventory.kind).toBe('local')
    expect(sourceInventoryFromFilesV1([]).kind).toBe('local')
    expect(inventory.snapshot()).toEqual({
      sessionId: 'local', truncated: true, revoked: false,
      entries: [{ path: 'folder/Data.BIN', size: 5, type: file.type, lastModified: 42, extension: '.bin' }],
    })
    expect(slice).not.toHaveBeenCalled()
    inventory.revoke()
    expect(inventory.kind).toBe('local')
    expect(inventory.snapshot()).toEqual({ sessionId: 'local', truncated: true, revoked: true, entries: [] })
  })

  it('fetches only the pinned catalog and exposes matching immutable inventory metadata', async () => {
    const f = await fixture([
      ['nested/archive.PKL.GZ', new File(['bytes'], 'archive.PKL.GZ', { type: 'application/gzip', lastModified: 0 })],
      ['.hidden', new File([], '.hidden', { lastModified: 0 })],
      ['README', new File(['read'], 'README', { lastModified: 0 })],
    ])
    const inventory = await sourceInventoryFromRemoteV1({
      ...f.options, expectedSourceManifestHash: f.validated.sourceManifestHash,
    })
    expect(inventory).toBeInstanceOf(SourceInventoryV1)
    expect(inventory.kind).toBe('remote')
    expect(inventory.snapshot()).toEqual(f.local.snapshot())
    expect(Object.keys(inventory.snapshot()).sort()).toEqual(['entries', 'revoked', 'sessionId', 'truncated'])
    expect(Object.isFrozen(inventory.snapshot().entries)).toBe(true)
    expect(inventory.snapshot().entries.every(Object.isFrozen)).toBe(true)
    expect(inventory.paths()).toEqual(['.hidden', 'README', 'nested/archive.PKL.GZ'])
    expect(inventory.entry('./nested\\archive.PKL.GZ')).toMatchObject({ extension: '.gz', lastModified: 0 })
    expect(inventory.entry('absent')).toBeNull()
    await expect(inspectSourceInventoryV1(inventory, { mode: 'metadata', path: 'README' })).resolves.toMatchObject({ path: 'README' })
    await inspectSourceInventoryV1(inventory, { mode: 'inventory' })
    const source = inventory.resolveAuthorizedSource()
    expect(source).toBeInstanceOf(RemoteByteSourceV1)
    expect(source.has('README')).toBe(true)
    expect(source.byteLength('README')).toBe(4)
    expect((await source.asyncBuffer('README')).byteLength).toBe(4)
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(String(f.request.mock.calls[0][0])).toBe(catalogUrl)
    expect(f.request.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer' })
    inventory.revoke()
  })

  it('accepts unpinned catalogs but rejects mismatched pins, invalid catalogs, and byte overruns', async () => {
    const f = await fixture()
    const unpinned = await sourceInventoryFromRemoteV1({ ...f.options, expectedCatalogHash: undefined })
    expect(unpinned.kind).toBe('remote')
    unpinned.revoke()
    await expect(sourceInventoryFromRemoteV1({ ...f.options, expectedCatalogHash: `sha256:${'0'.repeat(64)}` })).rejects.toMatchObject({ code: 'REMOTE_CATALOG_INVALID' })
    await expect(sourceInventoryFromRemoteV1({ ...f.options, expectedSourceManifestHash: `sha256:${'0'.repeat(64)}` })).rejects.toMatchObject({ code: 'REMOTE_CATALOG_INVALID' })
    const invalid = { ...f.validated.catalog, entries: [{ ...f.validated.catalog.entries[0], path: '../escape.json' }] }
    invalid.catalogHash = sourceCatalogHashV1(invalid)
    f.request.mockResolvedValueOnce(Response.json(invalid))
    await expect(sourceInventoryFromRemoteV1({ ...f.options, expectedCatalogHash: invalid.catalogHash })).rejects.toMatchObject({ code: 'REMOTE_CATALOG_INVALID' })
    await expect(sourceInventoryFromRemoteV1({ ...f.options, maxCatalogBytes: 1 })).rejects.toMatchObject({ code: 'REMOTE_OBJECT_LIMIT_EXCEEDED' })
    expect(f.request.mock.calls.every(([url]) => String(url) === catalogUrl)).toBe(true)
  })

  it('honors initialization cancellation before fetch, in flight, and after a late response', async () => {
    const f = await fixture()
    const before = new AbortController()
    before.abort()
    await expect(sourceInventoryFromRemoteV1({ ...f.options, signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.request).not.toHaveBeenCalled()

    const during = new AbortController()
    f.request.mockImplementationOnce(async (_input, init) => await pendingResponse(init?.signal))
    const initialization = sourceInventoryFromRemoteV1({ ...f.options, signal: during.signal })
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1))
    expect(f.request.mock.calls[0][1]?.signal).toBe(during.signal)
    during.abort()
    await expect(initialization).rejects.toMatchObject({ name: 'AbortError' })

    const late = new AbortController()
    const response = new Response(null)
    vi.spyOn(response, 'arrayBuffer').mockImplementation(async () => {
      late.abort()
      return new TextEncoder().encode(JSON.stringify(f.validated.catalog)).buffer
    })
    f.request.mockResolvedValueOnce(response)
    await expect(sourceInventoryFromRemoteV1({ ...f.options, signal: late.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('remote inventory reads, bounds, and revocation', () => {
  it('uses the same inspection path and authorizes only catalog paths under the supplied root', async () => {
    const path = 'original folder/000001 #?.JSON'
    const f = await fixture([[path, new File(['[{"x":2},{"x":4}]'], 'data.json', { lastModified: 0 })]])
    const inventory = await sourceInventoryFromRemoteV1({ ...f.options, rootUrl: rootUrl.slice(0, -1) })
    expect(await inspectSourceInventoryV1(inventory, { mode: 'json', path })).toEqual(
      await inspectSourceInventoryV1(f.local, { mode: 'json', path }),
    )
    expect(String(f.request.mock.calls[1][0])).toBe(rootUrl + 'original%20folder/000001%20%23%3F.JSON')
    expect(f.request.mock.calls[1][1]).toMatchObject({ credentials: 'omit', redirect: 'manual' })
    expect(() => inventory.readAuthorizedBytes('absent')).toThrow(/not authorized/u)
    expect(() => inventory.readAuthorizedBytes('../escape')).toThrow(/Invalid inventory path/u)
    await expect(inventory.resolveAuthorizedSource().read('absent')).rejects.toMatchObject({ code: 'REMOTE_SOURCE_NOT_FOUND' })
    await expect(inventory.readAuthorizedBytes(path, { end: 1_000 })).rejects.toThrow(/SOURCE_RANGE_INVALID/u)
    expect(f.request).toHaveBeenCalledTimes(2)
    inventory.revoke()
  })

  it('caches downloaded bytes and preserves configured transport limits', async () => {
    const f = await fixture()
    const inventory = await sourceInventoryFromRemoteV1(f.options)
    const size = inventory.entry('frames.json')!.size
    f.request.mockResolvedValueOnce(new Response(new Uint8Array(size).buffer))
    await expect(inventory.readAuthorizedBytes('frames.json')).resolves.toEqual(new Uint8Array(size).buffer)
    await expect(inventory.readAuthorizedBytes('frames.json')).resolves.toEqual(new Uint8Array(size).buffer)
    inventory.revoke()

    const limited = await sourceInventoryFromRemoteV1({ ...f.options, limits: { maxFullObjectBytes: 1 } })
    const calls = f.request.mock.calls.length
    await expect(limited.readAuthorizedBytes('frames.json')).rejects.toMatchObject({ code: 'REMOTE_OBJECT_LIMIT_EXCEEDED' })
    expect(f.request).toHaveBeenCalledTimes(calls)
    limited.revoke()
  })

  it('keeps per-read abort independent from inventory lifetime and initialization abort', async () => {
    const f = await fixture()
    const initialization = new AbortController()
    const inventory = await sourceInventoryFromRemoteV1({ ...f.options, signal: initialization.signal })
    initialization.abort()
    expect(inventory.revoked).toBe(false)
    const readController = new AbortController()
    f.request.mockImplementationOnce(async (_input, init) => await pendingResponse(init?.signal))
    const read = inventory.readAuthorizedBytes('frames.json', { signal: readController.signal })
    readController.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(inventory.revoked).toBe(false)
    await expect(inventory.readAuthorizedBytes('frames.json')).resolves.toEqual(await f.local.readAuthorizedBytes('frames.json'))
    inventory.revoke()
  })

  it('revokes retained capabilities, aborts all in-flight reads, and clears its owned cache once', async () => {
    const f = await fixture([
      ['cached.bin', new File(['cached'], 'cached.bin')],
      ['pending.bin', new File(['pending'], 'pending.bin')],
    ])
    const inventory = await sourceInventoryFromRemoteV1(f.options)
    const source = inventory.resolveAuthorizedSource()
    const buffer = await source.asyncBuffer('pending.bin')
    await source.read('cached.bin')
    const clear = vi.spyOn(SourceCacheV1.prototype, 'clear')
    const signals: AbortSignal[] = []
    f.request.mockImplementation(async (_input, init) => {
      signals.push(init!.signal!)
      return await pendingResponse(init?.signal)
    })
    const reads = [inventory.readAuthorizedBytes('pending.bin'), source.read('pending.bin'), buffer.slice(0, 1)]
    const rejected = reads.map((read) => expect(read).rejects.toMatchObject({ name: 'AbortError' }))
    expect(signals).toHaveLength(3)
    inventory.revoke()
    inventory.revoke()
    await Promise.all(rejected)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear.mock.contexts[0]).toBeInstanceOf(SourceCacheV1)
    expect((clear.mock.contexts[0] as SourceCacheV1).sizeBytes).toBe(0)
    expect(inventory.kind).toBe('remote')
    expect(inventory.snapshot()).toEqual({ sessionId: f.local.sessionId, entries: [], revoked: true, truncated: false })
    expect(() => inventory.paths()).toThrow(/SOURCE_INVENTORY_REVOKED/u)
    expect(() => inventory.entry('cached.bin')).toThrow(/SOURCE_INVENTORY_REVOKED/u)
    expect(() => inventory.resolveAuthorizedSource()).toThrow(/SOURCE_INVENTORY_REVOKED/u)
    expect(() => inventory.readAuthorizedBytes('cached.bin')).toThrow(/SOURCE_INVENTORY_REVOKED/u)
    await expect(source.read('cached.bin')).rejects.toMatchObject({ code: 'REMOTE_SOURCE_DISPOSED' })
    await expect(buffer.slice(0, 1)).rejects.toMatchObject({ code: 'REMOTE_SOURCE_DISPOSED' })
  })
})

describe('remote inventory authoring and hash/read costs', () => {
  it.each([65_536, null])('keeps fingerprint identity with local bytes and reuses verified data (chunk size %s)', async (chunkSize) => {
    const bytes = Uint8Array.from({ length: 3 * 65_536 }, (_, index) => Math.floor(index / 65_536) + 1)
    const f = await fixture([['frames/data.bin', new File([bytes], 'data.bin', { lastModified: 0 })]], chunkSize)
    const inventory = await sourceInventoryFromRemoteV1(f.options)
    expect(f.request).toHaveBeenCalledTimes(1)
    const recipe = assertValidRecipeV1(structuredClone(minimalJson))
    expect(await formatFingerprintV1(recipe, inventory)).toBe(await formatFingerprintV1(recipe, f.local))
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(await datasetFingerprintV1(inventory)).toBe(await datasetFingerprintV1(f.local))
    const ranges = f.request.mock.calls.slice(1).map(([, init]) => new Headers(init?.headers).get('range'))
    expect(ranges).toEqual(chunkSize === null ? [null] : ['bytes=0-65535', 'bytes=131072-196607'])
    expect((inventory.resolveAuthorizedSource() as RemoteByteSourceV1).responseBytes).toBe(chunkSize === null ? bytes.length : 2 * 65_536)
    await datasetFingerprintV1(inventory)
    expect(f.request).toHaveBeenCalledTimes(1 + ranges.length)
    inventory.revoke()
  })

  it('binds and scopes selectors without fetching any source object', async () => {
    const f = await fixture([
      ['frames.json', new File(['[{"timestamp_us":1}]'], 'frames.json')],
      ['private.bin', new File(['private'], 'private.bin')],
    ])
    const inventory = await sourceInventoryFromRemoteV1(f.options)
    const compiled = compileRecipeV1(timelineRecipe(), bundledPhase2OperatorRegistry)
    const preparePreview = vi.fn<AuthoringPreviewRuntimeV1['preparePreview']>(async (_recipe, source, selectedInventory) => {
      expect(selectedInventory).toBe(inventory)
      expect(source.has('frames.json')).toBe(true)
      expect(source.has('private.bin')).toBe(false)
      await expect(source.read('private.bin')).rejects.toThrow(/SOURCE_PATH_UNAVAILABLE/u)
      return {
        diagnostics: [], capabilities: new Set<never>(), presentedFrames: new Map(),
        validationSummary: {}, observableEffect: 'Bound selectors.', commit() {}, dispose() {},
      }
    })
    await new InventoryBindingEvaluatorV1({ preparePreview }).prepare(compiled, inventory)
    expect(preparePreview).toHaveBeenCalledTimes(1)
    expect(f.request).toHaveBeenCalledTimes(1)
    inventory.revoke()
  })

  it('runs inspection, graph preview, revision hashing, and session revocation through real HTTP', async () => {
    const f = await remoteTransportFixtureV1([
      ['frames.json', new File(['[{"timestamp_us":1},{"timestamp_us":2}]'], 'frames.json', { type: 'application/json' })],
    ])
    const authoring = new TeachableAuthoringSessionV1(new InventoryBindingEvaluatorV1(new BrowserGraphPreviewRuntimeV1()))
    try {
      const inventory = await openRemoteSourceInventoryV1({ ...f.remote, catalogUrl: f.catalogUrl })
      authoring.start(inventory)
      expect(f.requests).toEqual([{ path: '/catalog.json', range: null }])
      const inspected = await authoring.inspect({ mode: 'json', path: 'frames.json' })
      expect(inspected.data).toMatchObject({ schema: { type: 'array', length: 2 } })
      const recipe = timelineRecipe()
      await expect(authoring.applyRevision(recipe)).resolves.toMatchObject({ ok: true, phase: 'review' })
      expect(authoringPreviewStoreV1.getSnapshot()).toMatchObject({ frameCount: 2, sampledFrames: [0, 1] })
      expect(authoring.getState().currentArtifact?.provenance?.datasetFingerprint).toBe(await datasetFingerprintV1(f.inventory))
      expect(f.requests).toEqual([{ path: '/catalog.json', range: null }, { path: 'frames.json', range: null }])
      const source = inventory.resolveAuthorizedSource()
      authoring.revoke()
      expect(inventory.revoked).toBe(true)
      await expect(source.read('frames.json')).rejects.toMatchObject({ code: 'REMOTE_SOURCE_DISPOSED' })
    } finally {
      authoring.revoke()
      await f.dispose()
    }
  })

  it('recognizes a sealed remote recipe after reopening using only the new catalog', async () => {
    const f = await remoteTransportFixtureV1([
      ['frames.json', new File(['[{"timestamp_us":1},{"timestamp_us":2}]'], 'frames.json', { type: 'application/json' })],
    ])
    const authoring = new TeachableAuthoringSessionV1(new InventoryBindingEvaluatorV1(new BrowserGraphPreviewRuntimeV1()))
    let reopened: SourceInventoryV1 | undefined
    try {
      const inventory = await openRemoteSourceInventoryV1({ ...f.remote, catalogUrl: f.catalogUrl })
      authoring.start(inventory)
      await expect(authoring.applyRevision(timelineRecipe())).resolves.toMatchObject({ ok: true })
      authoring.submitHumanReview({ capability: 'timeline', frameIndices: [0, 1], verdict: 'accepted' })
      const sealed = await authoring.finalize()
      authoring.revoke()

      const requestCount = f.requests.length
      reopened = await openRemoteSourceInventoryV1({ ...f.remote, catalogUrl: f.catalogUrl })
      expect(reopened).not.toBe(inventory)
      expect(await authoring.findSavedRecipes(reopened)).toEqual([sealed])
      expect(f.requests.slice(requestCount)).toEqual([{ path: '/catalog.json', range: null }])
      expect(reopened.revoked).toBe(false)

      const other = new SourceInventoryV1([['unrelated.json', new File(['[]'], 'unrelated.json')]])
      expect(await authoring.findSavedRecipes(other)).toEqual([])
      other.revoke()
    } finally {
      authoring.revoke()
      reopened?.revoke()
      await f.dispose()
    }
  })
})
