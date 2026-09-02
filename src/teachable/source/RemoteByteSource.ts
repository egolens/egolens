import type { AsyncBuffer } from 'hyparquet'
import { normalizeSourcePathV1, type ByteSourceReadOptionsV1, type ByteSourceV1 } from './ByteSource'
import {
  MAX_SOURCE_CATALOG_BYTES_V1,
  validateSourceCatalogV1,
  type SourceCatalogEntryV1,
  type SourceCatalogV1,
  type ValidatedSourceCatalogV1,
} from './SourceCatalog'
import { sha256DigestV1 } from './sha256'

export type RemoteSourceErrorCodeV1 =
  | 'REMOTE_AUTHORIZATION_FAILED'
  | 'REMOTE_BYTE_BUDGET_EXCEEDED'
  | 'REMOTE_CATALOG_INVALID'
  | 'REMOTE_CORS'
  | 'REMOTE_DIGEST_MISMATCH'
  | 'REMOTE_LENGTH_MISMATCH'
  | 'REMOTE_OBJECT_LIMIT_EXCEEDED'
  | 'REMOTE_RANGE_REQUIRED'
  | 'REMOTE_RANGE_RESPONSE_INVALID'
  | 'REMOTE_REDIRECT_FORBIDDEN'
  | 'REMOTE_RESPONSE_READ_FAILED'
  | 'REMOTE_RETRY_EXHAUSTED'
  | 'REMOTE_ROOT_ESCAPE'
  | 'REMOTE_SOURCE_DISPOSED'
  | 'REMOTE_SOURCE_NOT_FOUND'
  | 'REMOTE_URL_INVALID'

export class RemoteSourceErrorV1 extends Error {
  readonly code: RemoteSourceErrorCodeV1
  readonly path?: string
  readonly url?: string
  readonly status?: number

  constructor(
    code: RemoteSourceErrorCodeV1,
    detail: string,
    context: { readonly path?: string; readonly url?: string; readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(`${code}: ${detail}`, context.cause === undefined ? undefined : { cause: context.cause })
    this.name = 'RemoteSourceErrorV1'
    this.code = code
    this.path = context.path
    this.url = context.url
    this.status = context.status
  }
}

export interface RemoteByteSourceLimitsV1 {
  readonly maxTotalResponseBytes: number
  readonly maxFullObjectBytes: number
  readonly maxRangeResponseBytes: number
  readonly maxCacheBytes: number
  readonly maxRetries: number
  readonly retryBaseDelayMs: number
  readonly maxRedirects: number
}

export const DEFAULT_REMOTE_BYTE_SOURCE_LIMITS_V1: RemoteByteSourceLimitsV1 = Object.freeze({
  // Cumulative verified transport I/O. The shipped Waymo case is about
  // 488 MiB and legitimately rereads bounded Parquet metadata/projections.
  maxTotalResponseBytes: 1024 * 1024 * 1024,
  maxFullObjectBytes: 64 * 1024 * 1024,
  // A Waymo camera-image Parquet column chunk is about 88 MiB; verified
  // ranges expand to fixed catalog chunk boundaries before decode.
  maxRangeResponseBytes: 128 * 1024 * 1024,
  maxCacheBytes: 64 * 1024 * 1024,
  maxRetries: 3,
  retryBaseDelayMs: 100,
  maxRedirects: 5,
})

interface CacheEntryV1 {
  readonly bytes: Uint8Array
  readonly size: number
}

/** Bounded LRU cache containing verified bytes only. */
export class VerifiedSourceCacheV1 {
  readonly #entries = new Map<string, CacheEntryV1>()
  readonly #maxBytes: number
  #bytes = 0

  constructor(maxBytes = DEFAULT_REMOTE_BYTE_SOURCE_LIMITS_V1.maxCacheBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('REMOTE_CACHE_LIMIT_INVALID')
    this.#maxBytes = maxBytes
  }

  get sizeBytes(): number {
    return this.#bytes
  }

  get(key: string): Uint8Array | null {
    const entry = this.#entries.get(key)
    if (!entry) return null
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.bytes.slice()
  }

  set(key: string, value: Uint8Array): void {
    const digest = key.slice(key.lastIndexOf('\u0000') + 1)
    if (sha256DigestV1(value) !== digest) return
    if (value.byteLength > this.#maxBytes) return
    const previous = this.#entries.get(key)
    if (previous) {
      this.#entries.delete(key)
      this.#bytes -= previous.size
    }
    const bytes = value.slice()
    this.#entries.set(key, { bytes, size: bytes.byteLength })
    this.#bytes += bytes.byteLength
    while (this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.entries().next().value as [string, CacheEntryV1] | undefined
      if (!oldest) break
      this.#entries.delete(oldest[0])
      this.#bytes -= oldest[1].size
    }
  }

  delete(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#entries.delete(key)
    this.#bytes -= entry.size
  }

  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }
}

export interface RemoteByteSourceOptionsV1 {
  readonly rootUrl: string
  readonly catalog: unknown
  readonly expectedCatalogHash?: string
  readonly expectedSourceManifestHash?: string
  readonly fetch?: typeof fetch
  readonly limits?: Partial<RemoteByteSourceLimitsV1>
  readonly credentialGrant?: { readonly origin: string }
  readonly cache?: VerifiedSourceCacheV1
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])

function isLoopback(hostname: string): boolean {
  const name = hostname.toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
}

export function validateRemoteUrlV1(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch (cause) {
    throw new RemoteSourceErrorV1('REMOTE_URL_INVALID', 'URL must be absolute.', { url: raw, cause })
  }
  if (url.username || url.password) {
    throw new RemoteSourceErrorV1('REMOTE_URL_INVALID', 'URL user-info is forbidden.', { url: raw })
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new RemoteSourceErrorV1('REMOTE_URL_INVALID', 'HTTPS is required outside loopback development.', { url: raw })
  }
  return url
}

function rootUrl(raw: string): URL {
  const url = validateRemoteUrlV1(raw)
  if (url.search || url.hash) {
    throw new RemoteSourceErrorV1('REMOTE_URL_INVALID', 'Source root cannot contain query or fragment.', { url: raw })
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function credentialsForGrant(
  url: URL,
  grant: { readonly origin: string } | undefined,
): RequestCredentials {
  if (!grant) return 'omit'
  let granted: URL
  try {
    granted = new URL(grant.origin)
  } catch (cause) {
    throw new RemoteSourceErrorV1('REMOTE_URL_INVALID', 'Credential grant origin is invalid.', { cause })
  }
  if (granted.origin !== grant.origin || granted.origin !== url.origin) {
    throw new RemoteSourceErrorV1('REMOTE_URL_INVALID', 'Credential grant must exactly equal the request origin.')
  }
  return 'include'
}

function isUnderRoot(candidate: URL, root: URL): boolean {
  return candidate.origin === root.origin && candidate.pathname.startsWith(root.pathname)
}

function entryUrl(root: URL, path: string): URL {
  const encoded = normalizeSourcePathV1(path).split('/').map(encodeURIComponent).join('/')
  const resolved = new URL(encoded, root)
  if (!isUnderRoot(resolved, root)) {
    throw new RemoteSourceErrorV1('REMOTE_ROOT_ESCAPE', 'Source path escaped its declared root.', {
      path,
      url: resolved.href,
    })
  }
  return resolved
}

function redirectTarget(current: URL, location: string): URL {
  try {
    return validateRemoteUrlV1(new URL(location, current).href)
  } catch (cause) {
    throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Redirect target URL is invalid or insecure.', {
      url: current.href, cause,
    })
  }
}

function checkedLimits(overrides: Partial<RemoteByteSourceLimitsV1> | undefined): RemoteByteSourceLimitsV1 {
  const limits = { ...DEFAULT_REMOTE_BYTE_SOURCE_LIMITS_V1, ...overrides }
  for (const key of ['maxTotalResponseBytes', 'maxFullObjectBytes', 'maxRangeResponseBytes', 'maxCacheBytes', 'maxRetries', 'retryBaseDelayMs', 'maxRedirects'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new RangeError(`REMOTE_LIMIT_INVALID: ${key}`)
  }
  if (limits.maxRetries > 10 || limits.maxRedirects > 10 || limits.retryBaseDelayMs > 60_000) {
    throw new RangeError('REMOTE_LIMIT_INVALID: retry/redirect bounds')
  }
  return Object.freeze(limits)
}

function checkedRange(length: number, options?: ByteSourceReadOptionsV1): readonly [number, number] {
  const start = options?.start ?? 0
  const end = options?.end ?? length
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > length) {
    throw new RangeError(`SOURCE_RANGE_INVALID: requested [${start}, ${end}) for ${length} bytes.`)
  }
  return [start, end]
}

function cacheKey(sourceManifestHash: string, path: string, digest: string): string {
  return `${sourceManifestHash}\u0000${path}\u0000${digest}`
}

function parseContentLength(response: Response): number | null {
  const value = response.headers.get('content-length')
  if (value === null) return null
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return Number.NaN
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN
}

function parseContentRange(value: string | null): { readonly start: number; readonly end: number; readonly size: number } | null {
  const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/u.exec(value ?? '')
  if (!match) return null
  const [, rawStart, rawEnd, rawSize] = match
  const start = Number(rawStart)
  const inclusiveEnd = Number(rawEnd)
  const size = Number(rawSize)
  if (![start, inclusiveEnd, size].every(Number.isSafeInteger) || inclusiveEnd < start) return null
  return { start, end: inclusiveEnd + 1, size }
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The primary deterministic diagnostic wins over transport cleanup noise.
  }
}

async function readResponseAtMost(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const declared = parseContentLength(response)
  if (Number.isNaN(declared) || (declared !== null && declared > maxBytes)) {
    await cancelResponse(response)
    throw new RemoteSourceErrorV1('REMOTE_OBJECT_LIMIT_EXCEEDED', 'Response exceeds its byte limit.', {
      url: response.url || undefined,
    })
  }
  const chunks: Uint8Array[] = []
  let received = 0
  if (response.body) {
    const reader = response.body.getReader()
    while (true) {
      if (signal?.aborted) {
        await reader.cancel()
        throw abortError('Remote response was aborted.')
      }
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (cause) {
        if (signal?.aborted) throw abortError('Remote response was aborted.')
        throw new RemoteSourceErrorV1('REMOTE_RESPONSE_READ_FAILED', 'Response body stream failed.', {
          url: response.url || undefined, cause,
        })
      }
      if (next.done) break
      received += next.value.byteLength
      if (received > maxBytes) {
        await reader.cancel()
        throw new RemoteSourceErrorV1('REMOTE_OBJECT_LIMIT_EXCEEDED', 'Response exceeds its byte limit.', {
          url: response.url || undefined,
        })
      }
      chunks.push(next.value)
    }
  } else {
    const chunk = new Uint8Array(await response.arrayBuffer())
    received = chunk.byteLength
    if (received > maxBytes) {
      throw new RemoteSourceErrorV1('REMOTE_OBJECT_LIMIT_EXCEEDED', 'Response exceeds its byte limit.', {
        url: response.url || undefined,
      })
    }
    chunks.push(chunk)
  }
  const joined = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError('Remote source request was aborted.')
  if (ms === 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError('Remote source request was aborted.'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class RemoteByteSourceV1 implements ByteSourceV1 {
  readonly rootUrl: string
  readonly catalog: SourceCatalogV1
  readonly catalogHash: string
  readonly sourceManifestHash: string
  readonly #root: URL
  readonly #entries = new Map<string, SourceCatalogEntryV1>()
  readonly #fetch: typeof fetch
  readonly #limits: RemoteByteSourceLimitsV1
  readonly #cache: VerifiedSourceCacheV1
  readonly #ownsCache: boolean
  readonly #credentials: RequestCredentials
  readonly #requests = new Set<AbortController>()
  #responseBytes = 0
  #disposed = false

  constructor(options: RemoteByteSourceOptionsV1) {
    this.#root = rootUrl(options.rootUrl)
    this.rootUrl = this.#root.href
    let validated: ValidatedSourceCatalogV1
    try {
      validated = validateSourceCatalogV1(options.catalog, {
        catalogHash: options.expectedCatalogHash,
        sourceManifestHash: options.expectedSourceManifestHash,
      })
    } catch (cause) {
      throw new RemoteSourceErrorV1('REMOTE_CATALOG_INVALID', 'Source catalog validation failed.', { cause })
    }
    this.catalog = validated.catalog
    this.catalogHash = validated.catalogHash
    this.sourceManifestHash = validated.sourceManifestHash
    for (const entry of this.catalog.entries) this.#entries.set(entry.path, entry)
    // Window.fetch is a Web IDL method in Chromium. Storing it in a class
    // field and invoking `this.#fetch(...)` otherwise supplies the
    // RemoteByteSource instance as its receiver and fails with
    // `TypeError: Illegal invocation` before any request is sent.
    this.#fetch = (options.fetch ?? globalThis.fetch).bind(globalThis)
    this.#limits = checkedLimits(options.limits)
    this.#cache = options.cache ?? new VerifiedSourceCacheV1(this.#limits.maxCacheBytes)
    this.#ownsCache = options.cache === undefined
    this.#credentials = credentialsForGrant(this.#root, options.credentialGrant)
  }

  get responseBytes(): number {
    return this.#responseBytes
  }

  has(rawPath: string): boolean {
    this.#assertActive()
    return this.#entries.has(normalizeSourcePathV1(rawPath))
  }

  byteLength(rawPath: string): number | null {
    return this.#entry(rawPath).size
  }

  async asyncBuffer(rawPath: string): Promise<AsyncBuffer> {
    const entry = this.#entry(rawPath)
    return {
      byteLength: entry.size,
      slice: async (start, end) => await this.read(entry.path, { start, end }),
    }
  }

  async read(rawPath: string, options?: ByteSourceReadOptionsV1): Promise<ArrayBuffer> {
    const entry = this.#entry(rawPath)
    const [start, end] = checkedRange(entry.size, options)
    const request = this.#requestController(options?.signal)
    const controller = request.controller
    try {
      if (controller.signal.aborted) throw abortError('Remote source request was aborted.')
      if (start === 0 && end === entry.size) {
        const bytes = await this.#readFull(entry, controller.signal)
        if (controller.signal.aborted) throw abortError('Remote source request was aborted.')
        return bytes.slice().buffer
      }
      if (start === end) return new ArrayBuffer(0)
      const bytes = entry.chunks
        ? await this.#readVerifiedChunks(entry, start, end, controller.signal)
        : await this.#readFull(entry, controller.signal)
      if (controller.signal.aborted) throw abortError('Remote source request was aborted.')
      const offset = entry.chunks ? 0 : start
      const selected = entry.chunks ? bytes : bytes.subarray(offset, end)
      return selected.slice().buffer
    } finally {
      request.release()
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const controller of this.#requests) controller.abort()
    this.#requests.clear()
    if (this.#ownsCache) this.#cache.clear()
  }

  revoke(): void {
    this.dispose()
  }

  async #readFull(entry: SourceCatalogEntryV1, signal: AbortSignal): Promise<Uint8Array> {
    const key = cacheKey(this.sourceManifestHash, entry.path, entry.sha256)
    const cached = this.#verifiedCached(key, entry.sha256, entry.size)
    if (cached) return cached
    if (entry.size > this.#limits.maxFullObjectBytes) {
      throw new RemoteSourceErrorV1('REMOTE_OBJECT_LIMIT_EXCEEDED', 'Full object exceeds the configured limit.', { path: entry.path })
    }
    const response = await this.#request(entry, null, signal)
    if (response.status !== 200) {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_RANGE_RESPONSE_INVALID', `Expected status 200, received ${response.status}.`, {
        path: entry.path, url: response.url || undefined, status: response.status,
      })
    }
    const bytes = await this.#responseBody(response, entry.size, this.#limits.maxFullObjectBytes, entry.path, signal)
    this.#verifyDigest(bytes, entry.sha256, entry.path)
    this.#cache.set(key, bytes)
    return bytes
  }

  async #readVerifiedChunks(
    entry: SourceCatalogEntryV1,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const chunks = entry.chunks
    if (!chunks) throw new Error('REMOTE_INTERNAL_CHUNKS_MISSING')
    const complete = this.#verifiedCached(
      cacheKey(this.sourceManifestHash, entry.path, entry.sha256), entry.sha256, entry.size,
    )
    if (complete) return complete.subarray(start, end)
    const firstChunk = Math.floor(start / chunks.size)
    const lastChunk = Math.floor((end - 1) / chunks.size)
    const pieces: Uint8Array[] = []
    let allCached = true
    for (let index = firstChunk; index <= lastChunk; index += 1) {
      const digest = chunks.digests[index]
      const chunkLength = Math.min(chunks.size, entry.size - index * chunks.size)
      const cached = digest
        ? this.#verifiedCached(cacheKey(this.sourceManifestHash, entry.path, digest), digest, chunkLength)
        : null
      if (!cached) {
        allCached = false
        break
      }
      pieces.push(cached)
    }
    if (!allCached) {
      pieces.length = 0
      const rangeStart = firstChunk * chunks.size
      const rangeEnd = Math.min(entry.size, (lastChunk + 1) * chunks.size)
      const rangeLength = rangeEnd - rangeStart
      if (rangeLength > this.#limits.maxRangeResponseBytes) {
        throw new RemoteSourceErrorV1('REMOTE_OBJECT_LIMIT_EXCEEDED', 'Expanded verified range exceeds the configured limit.', { path: entry.path })
      }
      const response = await this.#request(entry, { start: rangeStart, end: rangeEnd }, signal)
      if (response.status === 200) {
        if (entry.size > this.#limits.maxFullObjectBytes) {
          await cancelResponse(response)
          throw new RemoteSourceErrorV1('REMOTE_RANGE_REQUIRED', 'Server ignored Range for an object above the full-object limit.', {
            path: entry.path, url: response.url || undefined, status: response.status,
          })
        }
        const full = await this.#responseBody(response, entry.size, this.#limits.maxFullObjectBytes, entry.path, signal)
        this.#verifyDigest(full, entry.sha256, entry.path)
        this.#cache.set(cacheKey(this.sourceManifestHash, entry.path, entry.sha256), full)
        return full.subarray(start, end)
      }
      if (response.status !== 206) {
        await cancelResponse(response)
        throw new RemoteSourceErrorV1('REMOTE_RANGE_RESPONSE_INVALID', `Expected status 206, received ${response.status}.`, {
          path: entry.path, url: response.url || undefined, status: response.status,
        })
      }
      const contentRange = parseContentRange(response.headers.get('content-range'))
      if (!contentRange || contentRange.start !== rangeStart || contentRange.end !== rangeEnd || contentRange.size !== entry.size) {
        await cancelResponse(response)
        throw new RemoteSourceErrorV1('REMOTE_RANGE_RESPONSE_INVALID', 'Content-Range is absent or inconsistent with the catalog.', {
          path: entry.path, url: response.url || undefined, status: response.status,
        })
      }
      const received = await this.#responseBody(response, rangeLength, this.#limits.maxRangeResponseBytes, entry.path, signal)
      for (let index = firstChunk; index <= lastChunk; index += 1) {
        const chunkStart = index * chunks.size
        const relativeStart = chunkStart - rangeStart
        const chunkLength = Math.min(chunks.size, entry.size - chunkStart)
        const piece = received.subarray(relativeStart, relativeStart + chunkLength)
        const digest = chunks.digests[index]
        if (!digest) throw new RemoteSourceErrorV1('REMOTE_CATALOG_INVALID', 'Chunk digest is missing.', { path: entry.path })
        this.#verifyDigest(piece, digest, entry.path)
        this.#cache.set(cacheKey(this.sourceManifestHash, entry.path, digest), piece)
        pieces.push(piece)
      }
    }
    const rangeStart = firstChunk * chunks.size
    const joinedLength = pieces.reduce((total, piece) => total + piece.byteLength, 0)
    const joined = new Uint8Array(joinedLength)
    let offset = 0
    for (const piece of pieces) {
      joined.set(piece, offset)
      offset += piece.byteLength
    }
    return joined.subarray(start - rangeStart, end - rangeStart)
  }

  async #request(
    entry: SourceCatalogEntryV1,
    range: { readonly start: number; readonly end: number } | null,
    signal: AbortSignal,
  ): Promise<Response> {
    const initial = entryUrl(this.#root, entry.path)
    let lastStatus: number | undefined
    for (let attempt = 0; attempt <= this.#limits.maxRetries; attempt += 1) {
      if (attempt > 0) await delay(this.#limits.retryBaseDelayMs * (2 ** (attempt - 1)), signal)
      try {
        const response = await this.#fetchRedirects(initial, range, signal)
        lastStatus = response.status
        if (RETRY_STATUSES.has(response.status)) {
          await cancelResponse(response)
          if (attempt < this.#limits.maxRetries) continue
          throw new RemoteSourceErrorV1('REMOTE_RETRY_EXHAUSTED', `HTTP ${response.status} persisted after retries.`, {
            path: entry.path, url: response.url || initial.href, status: response.status,
          })
        }
        if (response.status === 401 || response.status === 403) {
          await cancelResponse(response)
          throw new RemoteSourceErrorV1('REMOTE_AUTHORIZATION_FAILED', `HTTP ${response.status}.`, {
            path: entry.path, url: response.url || initial.href, status: response.status,
          })
        }
        if (response.status === 404 || response.status === 410) {
          await cancelResponse(response)
          throw new RemoteSourceErrorV1('REMOTE_SOURCE_NOT_FOUND', `HTTP ${response.status}.`, {
            path: entry.path, url: response.url || initial.href, status: response.status,
          })
        }
        if (response.type === 'opaque') {
          await cancelResponse(response)
          throw new RemoteSourceErrorV1('REMOTE_CORS', 'The response is opaque; required CORS access was not granted.', {
            path: entry.path, url: initial.href,
          })
        }
        return response
      } catch (cause) {
        if (signal.aborted) throw abortError('Remote source request was aborted.')
        if (cause instanceof RemoteSourceErrorV1) throw cause
        if (attempt === this.#limits.maxRetries) {
          throw new RemoteSourceErrorV1('REMOTE_CORS', 'Fetch failed after retries; check CORS and connectivity.', {
            path: entry.path, url: initial.href, status: lastStatus, cause,
          })
        }
      }
    }
    throw new RemoteSourceErrorV1('REMOTE_RETRY_EXHAUSTED', 'Request retry loop terminated unexpectedly.', { path: entry.path })
  }

  async #fetchRedirects(
    initial: URL,
    range: { readonly start: number; readonly end: number } | null,
    signal: AbortSignal,
  ): Promise<Response> {
    let current = initial
    for (let redirectCount = 0; redirectCount <= this.#limits.maxRedirects; redirectCount += 1) {
      const headers = new Headers()
      if (range) headers.set('Range', `bytes=${range.start}-${range.end - 1}`)
      const response = await this.#fetch(current, {
        method: 'GET', headers, signal, redirect: 'manual', cache: 'no-store',
        credentials: this.#credentials, referrerPolicy: 'no-referrer',
      })
      if (response.type === 'opaqueredirect') {
        await cancelResponse(response)
        throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Opaque redirects cannot be confined.', { url: current.href })
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (response.url) {
          const final = validateRemoteUrlV1(response.url)
          if (!isUnderRoot(final, this.#root)) {
            await cancelResponse(response)
            throw new RemoteSourceErrorV1('REMOTE_ROOT_ESCAPE', 'Final response URL escaped the declared root.', { url: final.href })
          }
        }
        return response
      }
      if (redirectCount === this.#limits.maxRedirects) {
        await cancelResponse(response)
        throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Redirect limit exceeded.', { url: current.href })
      }
      const location = response.headers.get('location')
      if (!location) {
        await cancelResponse(response)
        throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Redirect response omitted Location.', { url: current.href })
      }
      const next = redirectTarget(current, location)
      if (!isUnderRoot(next, this.#root)) {
        await cancelResponse(response)
        throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Cross-origin or cross-root redirect was rejected.', { url: next.href })
      }
      await cancelResponse(response)
      current = next
    }
    throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Redirect limit exceeded.', { url: initial.href })
  }

  async #responseBody(
    response: Response,
    expectedLength: number,
    requestLimit: number,
    path: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const declared = parseContentLength(response)
    if (Number.isNaN(declared) || (declared !== null && declared !== expectedLength)) {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_LENGTH_MISMATCH', 'Content-Length is invalid or differs from the catalog/range.', {
        path, url: response.url || undefined, status: response.status,
      })
    }
    if (expectedLength > requestLimit) {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_OBJECT_LIMIT_EXCEEDED', 'Expected response exceeds its configured request limit.', { path })
    }
    if (expectedLength > this.#limits.maxTotalResponseBytes - this.#responseBytes) {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_BYTE_BUDGET_EXCEEDED', 'Expected response exceeds the remaining source byte budget.', { path })
    }
    const chunks: Uint8Array[] = []
    let received = 0
    if (response.body) {
      const reader = response.body.getReader()
      while (true) {
        if (signal.aborted) {
          await reader.cancel()
          throw abortError('Remote source response was aborted.')
        }
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await reader.read()
        } catch (cause) {
          if (signal.aborted) throw abortError('Remote source response was aborted.')
          throw new RemoteSourceErrorV1('REMOTE_RESPONSE_READ_FAILED', 'Response body stream failed.', {
            path, url: response.url || undefined, status: response.status, cause,
          })
        }
        if (next.done) break
        const chunk = next.value
        received += chunk.byteLength
        this.#responseBytes += chunk.byteLength
        if (received > expectedLength) {
          await reader.cancel()
          throw new RemoteSourceErrorV1('REMOTE_LENGTH_MISMATCH', 'Response exceeded its declared length.', { path })
        }
        if (received > requestLimit) {
          await reader.cancel()
          throw new RemoteSourceErrorV1('REMOTE_OBJECT_LIMIT_EXCEEDED', 'Response exceeded its configured request limit.', { path })
        }
        if (this.#responseBytes > this.#limits.maxTotalResponseBytes) {
          await reader.cancel()
          throw new RemoteSourceErrorV1('REMOTE_BYTE_BUDGET_EXCEEDED', 'Source response byte budget was exceeded.', { path })
        }
        chunks.push(chunk)
      }
    } else {
      const chunk = new Uint8Array(await response.arrayBuffer())
      received = chunk.byteLength
      this.#responseBytes += received
      chunks.push(chunk)
    }
    if (received !== expectedLength) {
      throw new RemoteSourceErrorV1('REMOTE_LENGTH_MISMATCH', `Expected ${expectedLength} bytes, received ${received}.`, { path })
    }
    const joined = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return joined
  }

  #verifyDigest(bytes: Uint8Array, expected: string, path: string): void {
    if (sha256DigestV1(bytes) !== expected) {
      throw new RemoteSourceErrorV1('REMOTE_DIGEST_MISMATCH', 'Received bytes do not match the catalog digest.', { path })
    }
  }

  #verifiedCached(key: string, expectedDigest: string, expectedLength: number): Uint8Array | null {
    const bytes = this.#cache.get(key)
    if (!bytes) return null
    if (bytes.byteLength !== expectedLength || !key.endsWith(`\u0000${expectedDigest}`)) {
      this.#cache.delete(key)
      return null
    }
    return bytes
  }

  #entry(rawPath: string): SourceCatalogEntryV1 {
    this.#assertActive()
    const path = normalizeSourcePathV1(rawPath)
    const entry = this.#entries.get(path)
    if (!entry) throw new RemoteSourceErrorV1('REMOTE_SOURCE_NOT_FOUND', 'Path is absent from the source catalog.', { path })
    return entry
  }

  #assertActive(): void {
    if (this.#disposed) throw new RemoteSourceErrorV1('REMOTE_SOURCE_DISPOSED', 'Remote source has been disposed.')
  }

  #requestController(signal?: AbortSignal): { readonly controller: AbortController; release(): void } {
    this.#assertActive()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    this.#requests.add(controller)
    return {
      controller,
      release: () => {
        signal?.removeEventListener('abort', onAbort)
        this.#requests.delete(controller)
      },
    }
  }
}

export async function fetchSourceCatalogV1(
  rawUrl: string,
  options: {
    readonly expectedCatalogHash: string
    readonly expectedSourceManifestHash?: string
    readonly fetch?: typeof fetch
    readonly signal?: AbortSignal
    readonly maxBytes?: number
    readonly credentialGrant?: { readonly origin: string }
  },
): Promise<ValidatedSourceCatalogV1> {
  const url = validateRemoteUrlV1(rawUrl)
  const credentials = credentialsForGrant(url, options.credentialGrant)
  const maxBytes = options.maxBytes ?? MAX_SOURCE_CATALOG_BYTES_V1
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SOURCE_CATALOG_BYTES_V1) {
    throw new RangeError('REMOTE_CATALOG_LIMIT_INVALID')
  }
  const fetcher = options.fetch ?? fetch
  let current = url
  let response: Response | null = null
  for (let redirects = 0; redirects <= DEFAULT_REMOTE_BYTE_SOURCE_LIMITS_V1.maxRedirects; redirects += 1) {
    try {
      response = await fetcher(current, {
        method: 'GET', signal: options.signal, redirect: 'manual', cache: 'no-store',
        credentials, referrerPolicy: 'no-referrer',
      })
    } catch (cause) {
      if (options.signal?.aborted) throw abortError('Source catalog request was aborted.')
      throw new RemoteSourceErrorV1('REMOTE_CORS', 'Catalog fetch failed; check CORS and connectivity.', { url: current.href, cause })
    }
    if (response.type === 'opaqueredirect') {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Opaque catalog redirects cannot be confined.', { url: current.href })
    }
    if (!REDIRECT_STATUSES.has(response.status)) break
    if (redirects === DEFAULT_REMOTE_BYTE_SOURCE_LIMITS_V1.maxRedirects) {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Catalog redirect limit exceeded.', { url: current.href })
    }
    const location = response.headers.get('location')
    if (!location) {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Catalog redirect omitted Location.', { url: current.href })
    }
    const next = redirectTarget(current, location)
    if (next.origin !== url.origin) {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Cross-origin catalog redirect was rejected.', { url: next.href })
    }
    await cancelResponse(response)
    current = next
  }
  if (!response) throw new RemoteSourceErrorV1('REMOTE_CATALOG_INVALID', 'Catalog fetch returned no response.', { url: url.href })
  if (response.url) {
    const final = validateRemoteUrlV1(response.url)
    if (final.origin !== url.origin) {
      await cancelResponse(response)
      throw new RemoteSourceErrorV1('REMOTE_REDIRECT_FORBIDDEN', 'Final catalog response changed origin.', { url: final.href })
    }
  }
  if (response.status === 401 || response.status === 403) {
    await cancelResponse(response)
    throw new RemoteSourceErrorV1('REMOTE_AUTHORIZATION_FAILED', `Catalog fetch returned HTTP ${response.status}.`, {
      url: url.href, status: response.status,
    })
  }
  if (!response.ok || response.type === 'opaque' || response.type === 'opaqueredirect') {
    await cancelResponse(response)
    throw new RemoteSourceErrorV1(response.type === 'opaque' ? 'REMOTE_CORS' : 'REMOTE_CATALOG_INVALID',
      `Catalog fetch returned HTTP ${response.status}.`, { url: url.href, status: response.status })
  }
  const bytes = await readResponseAtMost(response, maxBytes, options.signal)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw new RemoteSourceErrorV1('REMOTE_CATALOG_INVALID', 'Catalog is not valid UTF-8 JSON.', { url: url.href, cause })
  }
  try {
    return validateSourceCatalogV1(value, {
      catalogHash: options.expectedCatalogHash,
      sourceManifestHash: options.expectedSourceManifestHash,
    })
  } catch (cause) {
    throw new RemoteSourceErrorV1('REMOTE_CATALOG_INVALID', 'Catalog schema or identity validation failed.', { url: url.href, cause })
  }
}
