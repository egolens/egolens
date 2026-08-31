import { recipeHashV1 } from '../authoring/hashes'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import type { OperatorRegistry } from '../operators/registry'
import { compileRecipeV1, type CompiledRecipeV1 } from '../recipe/compiler'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import { MAX_RECIPE_BYTES_V1, assertValidRecipeV1 } from '../schema/validateSchema'
import { validateRemoteUrlV1 } from '../source/RemoteByteSource'

export type RemoteRecipeErrorCodeV1 =
  | 'REMOTE_RECIPE_AUTHORIZATION_FAILED'
  | 'REMOTE_RECIPE_CORS'
  | 'REMOTE_RECIPE_CREDENTIAL_LEAKAGE'
  | 'REMOTE_RECIPE_FETCH_FAILED'
  | 'REMOTE_RECIPE_HASH_MISMATCH'
  | 'REMOTE_RECIPE_INVALID'
  | 'REMOTE_RECIPE_REDIRECT_FORBIDDEN'
  | 'REMOTE_RECIPE_TOO_LARGE'
  | 'REMOTE_RECIPE_URL_INVALID'

export class RemoteRecipeErrorV1 extends Error {
  readonly code: RemoteRecipeErrorCodeV1
  readonly url?: string
  readonly status?: number

  constructor(
    code: RemoteRecipeErrorCodeV1,
    detail: string,
    context: { readonly url?: string; readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(`${code}: ${detail}`, context.cause === undefined ? undefined : { cause: context.cause })
    this.name = 'RemoteRecipeErrorV1'
    this.code = code
    this.url = context.url
    this.status = context.status
  }
}

export interface VerifiedRemoteRecipeV1 {
  readonly recipeHash: string
  readonly recipe: EgoLensAdapterRecipeV1
  readonly compiledRecipe: CompiledRecipeV1
}

function freezeRecipe<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const member of Object.values(value as Record<string, unknown>)) freezeRecipe(member)
  }
  return value
}

/** Bounded LRU. Only fully validated, compiled, hash-verified recipes enter it. */
export class VerifiedRecipeCacheV1 {
  readonly #entries = new Map<string, EgoLensAdapterRecipeV1>()
  readonly #maxEntries: number

  constructor(maxEntries = 32) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > 1024) {
      throw new RangeError('REMOTE_RECIPE_CACHE_LIMIT_INVALID')
    }
    this.#maxEntries = maxEntries
  }

  get size(): number {
    return this.#entries.size
  }

  get(recipeHash: string): EgoLensAdapterRecipeV1 | null {
    const value = this.#entries.get(recipeHash)
    if (!value) return null
    this.#entries.delete(recipeHash)
    this.#entries.set(recipeHash, value)
    return value
  }

  promote(value: VerifiedRemoteRecipeV1): void {
    if (value.recipeHash !== value.recipeHash.toLowerCase() || !/^sha256:[0-9a-f]{64}$/u.test(value.recipeHash)) return
    this.#entries.delete(value.recipeHash)
    this.#entries.set(value.recipeHash, freezeRecipe(structuredClone(value.recipe)))
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  clear(): void {
    this.#entries.clear()
  }
}

export const sharedVerifiedRecipeCacheV1 = new VerifiedRecipeCacheV1()

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const REDIRECT = new Set([301, 302, 303, 307, 308])
const SENSITIVE_QUERY_NAME = /(?:^|[-_])(?:access[-_]?key|api[-_]?key|auth|authorization|bearer|code|credential|jwt|key|password|policy|secret|session(?:id)?|sig|signature|token)(?:$|[-_])/iu

function recipeUrl(raw: string): URL {
  let url: URL
  try {
    url = validateRemoteUrlV1(raw)
  } catch (cause) {
    throw new RemoteRecipeErrorV1('REMOTE_RECIPE_URL_INVALID', 'Recipe URL must be absolute HTTPS (HTTP is loopback-only).', { url: raw, cause })
  }
  if (url.hash) throw new RemoteRecipeErrorV1('REMOTE_RECIPE_URL_INVALID', 'Recipe URL cannot contain a fragment.', { url: raw })
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase()
    if (SENSITIVE_QUERY_NAME.test(key) || lower.startsWith('x-amz-') || lower.startsWith('x-goog-')) {
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_CREDENTIAL_LEAKAGE', 'Recipe URL contains a credential-like query parameter.', { url: raw })
    }
  }
  return url
}

function credentialsFor(url: URL, grant: { readonly origin: string } | undefined): RequestCredentials {
  if (!grant) return 'omit'
  if (grant.origin !== url.origin) {
    throw new RemoteRecipeErrorV1('REMOTE_RECIPE_URL_INVALID', 'Credential grant must exactly equal the recipe origin.', { url: url.href })
  }
  return 'include'
}

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* best effort */ }
}

async function readAtMost(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_RECIPE_BYTES_V1) {
      await cancel(response)
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_TOO_LARGE', `Recipe exceeds ${MAX_RECIPE_BYTES_V1} bytes.`)
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RECIPE_BYTES_V1) throw new RemoteRecipeErrorV1('REMOTE_RECIPE_TOO_LARGE', `Recipe exceeds ${MAX_RECIPE_BYTES_V1} bytes.`)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Recipe request was aborted.', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RECIPE_BYTES_V1) throw new RemoteRecipeErrorV1('REMOTE_RECIPE_TOO_LARGE', `Recipe exceeds ${MAX_RECIPE_BYTES_V1} bytes.`)
      chunks.push(value)
    }
  } catch (cause) {
    await reader.cancel().catch(() => {})
    throw cause
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export interface FetchRemoteRecipeOptionsV1 {
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly credentialGrant?: { readonly origin: string }
  readonly cache?: VerifiedRecipeCacheV1
  readonly operators?: OperatorRegistry
}

/**
 * Fetch a recipe artifact and pass it through the exact local-import schema,
 * semantic compiler, registered dependency boundary, and semantic hash gate.
 */
export async function fetchRemoteRecipeV1(
  rawUrl: string,
  expectedRecipeHash: string,
  options: FetchRemoteRecipeOptionsV1 = {},
): Promise<VerifiedRemoteRecipeV1> {
  if (!SHA256.test(expectedRecipeHash)) {
    throw new RemoteRecipeErrorV1('REMOTE_RECIPE_HASH_MISMATCH', 'Expected recipeHash must be lowercase sha256.')
  }
  // Validate the current request before consulting cache. A cached artifact
  // must never make an insecure or credential-bearing reference acceptable.
  const initial = recipeUrl(rawUrl)
  const credentials = credentialsFor(initial, options.credentialGrant)
  const cache = options.cache ?? sharedVerifiedRecipeCacheV1
  const cached = cache.get(expectedRecipeHash)
  if (cached) {
    // Compilation is intentionally repeated against the caller's current
    // registered operator set. A cache created in a wider environment cannot
    // smuggle an unavailable extension/operator into this one.
    try {
      const compiledRecipe = compileRecipeV1(cached, options.operators ?? bundledPhase2OperatorRegistry)
      if (await recipeHashV1(cached) !== expectedRecipeHash) {
        throw new RemoteRecipeErrorV1('REMOTE_RECIPE_HASH_MISMATCH', 'Cached recipe no longer matches its identity.')
      }
      return Object.freeze({ recipeHash: expectedRecipeHash, recipe: cached, compiledRecipe })
    } catch (cause) {
      if (cause instanceof RemoteRecipeErrorV1) throw cause
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_INVALID', 'Cached recipe dependencies are unavailable in the current operator registry.', {
        url: initial.href, cause,
      })
    }
  }

  const initialOrigin = initial.origin
  const fetcher = options.fetch ?? fetch
  let current = initial
  let response: Response | null = null
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    try {
      response = await fetcher(current, {
        method: 'GET', signal: options.signal, redirect: 'manual', cache: 'no-store',
        credentials, referrerPolicy: 'no-referrer',
      })
    } catch (cause) {
      if (options.signal?.aborted) throw cause
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_CORS', 'Recipe fetch failed; check CORS and connectivity.', { url: current.href, cause })
    }
    if (response.type === 'opaqueredirect') {
      await cancel(response)
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_REDIRECT_FORBIDDEN', 'Opaque redirects cannot be confined.', { url: current.href })
    }
    if (!REDIRECT.has(response.status)) break
    if (redirects === 5) {
      await cancel(response)
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_REDIRECT_FORBIDDEN', 'Recipe redirect limit exceeded.', { url: current.href })
    }
    const location = response.headers.get('location')
    if (!location) {
      await cancel(response)
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_REDIRECT_FORBIDDEN', 'Recipe redirect omitted Location.', { url: current.href })
    }
    const next = recipeUrl(new URL(location, current).href)
    if (next.origin !== initialOrigin) {
      await cancel(response)
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_REDIRECT_FORBIDDEN', 'Cross-origin recipe redirect was rejected.', { url: next.href })
    }
    await cancel(response)
    current = next
  }
  if (!response) throw new RemoteRecipeErrorV1('REMOTE_RECIPE_FETCH_FAILED', 'Recipe fetch returned no response.', { url: initial.href })
  if (response.status === 401 || response.status === 403) {
    await cancel(response)
    throw new RemoteRecipeErrorV1('REMOTE_RECIPE_AUTHORIZATION_FAILED', `Recipe fetch returned HTTP ${response.status}.`, {
      url: current.href, status: response.status,
    })
  }
  if (!response.ok || response.type === 'opaque' || response.type === 'opaqueredirect') {
    await cancel(response)
    throw new RemoteRecipeErrorV1(response.type === 'opaque' ? 'REMOTE_RECIPE_CORS' : 'REMOTE_RECIPE_FETCH_FAILED',
      `Recipe fetch returned HTTP ${response.status}.`, { url: current.href, status: response.status })
  }
  if (response.url) {
    const final = recipeUrl(response.url)
    if (final.origin !== initialOrigin) {
      await cancel(response)
      throw new RemoteRecipeErrorV1('REMOTE_RECIPE_REDIRECT_FORBIDDEN', 'Final recipe response changed origin.', { url: final.href })
    }
  }

  const bytes = await readAtMost(response, options.signal)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new RemoteRecipeErrorV1('REMOTE_RECIPE_INVALID', 'Recipe is not valid UTF-8.', { url: current.href, cause })
  }

  let recipe: EgoLensAdapterRecipeV1
  let compiledRecipe: CompiledRecipeV1
  try {
    recipe = assertValidRecipeV1(text)
    compiledRecipe = compileRecipeV1(recipe, options.operators ?? bundledPhase2OperatorRegistry)
  } catch (cause) {
    throw new RemoteRecipeErrorV1('REMOTE_RECIPE_INVALID', 'Recipe schema, semantics, or registered dependencies are invalid.', {
      url: current.href, cause,
    })
  }
  const actualRecipeHash = await recipeHashV1(recipe)
  if (actualRecipeHash !== expectedRecipeHash || (recipe.hashes?.recipeHash && recipe.hashes.recipeHash !== actualRecipeHash)) {
    throw new RemoteRecipeErrorV1('REMOTE_RECIPE_HASH_MISMATCH', `Expected ${expectedRecipeHash}, received ${actualRecipeHash}.`, { url: current.href })
  }
  const verified = Object.freeze({ recipeHash: actualRecipeHash, recipe: freezeRecipe(recipe), compiledRecipe })
  cache.promote(verified)
  return verified
}
