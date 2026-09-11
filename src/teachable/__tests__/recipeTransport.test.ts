import { describe, expect, it, vi } from 'vitest'
import waymoRecipe from '../../adapters/recipes/waymo.egolens-adapter.json'
import { recipeHashV1 } from '../authoring/hashes'
import { OperatorRegistry } from '../operators/registry'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import {
  fetchRemoteRecipeV1,
  fetchRemoteRecipeForImportV1,
  RemoteRecipeErrorV1,
  VerifiedRecipeCacheV1,
} from '../share/RecipeTransport'

const recipe = waymoRecipe as EgoLensAdapterRecipeV1

function response(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    status: 200,
    headers: { 'content-length': String(new TextEncoder().encode(value).byteLength) },
    ...init,
  })
}

describe('remote recipe transport', () => {
  it('imports the current URL contents without a pin even when a previous version is cached', async () => {
    const cache = new VerifiedRecipeCacheV1()
    const updated = { ...recipe, scene: { ...recipe.scene, timeline: { ...recipe.scene.timeline, nominalFrameRate: 20 } } }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(JSON.stringify(recipe)))
      .mockResolvedValueOnce(response(JSON.stringify(updated)))
    const first = await fetchRemoteRecipeForImportV1('https://recipes.example/current.json', { fetch: fetcher, cache })
    const second = await fetchRemoteRecipeForImportV1('https://recipes.example/current.json', { fetch: fetcher, cache })
    expect(first.recipeHash).toBe(await recipeHashV1(recipe))
    expect(second.recipeHash).toBe(await recipeHashV1(updated))
    expect(second.recipeHash).not.toBe(first.recipeHash)
    expect(second.recipe.scene.timeline.nominalFrameRate).toBe(20)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ cache: 'no-store', credentials: 'omit' }))
    expect(cache.size).toBe(2)

    const pinned = await fetchRemoteRecipeV1('https://recipes.example/current.json', first.recipeHash, {
      fetch: fetcher, cache,
    })
    expect(pinned.recipeHash).toBe(first.recipeHash)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('honors an optional import pin and rejects a different recipe without caching it', async () => {
    const cache = new VerifiedRecipeCacheV1()
    const fetcher = vi.fn(async () => response(JSON.stringify(recipe)))
    await expect(fetchRemoteRecipeForImportV1('https://recipes.example/r.json', {
      expectedRecipeHash: `sha256:${'0'.repeat(64)}`, fetch: fetcher, cache,
    })).rejects.toMatchObject({ code: 'REMOTE_RECIPE_HASH_MISMATCH' })
    expect(cache.size).toBe(0)
    const expectedRecipeHash = await recipeHashV1(recipe)
    const imported = await fetchRemoteRecipeForImportV1('https://recipes.example/r.json', { expectedRecipeHash, fetch: fetcher, cache })
    expect(imported.recipeHash).toBe(expectedRecipeHash)
  })

  it.each(['', 'not-a-hash'])('rejects an explicitly invalid import pin (%j) before fetching', async (expectedRecipeHash) => {
    const fetcher = vi.fn()
    await expect(fetchRemoteRecipeForImportV1('https://recipes.example/r.json', { expectedRecipeHash, fetch: fetcher }))
      .rejects.toMatchObject({ code: 'REMOTE_RECIPE_HASH_MISMATCH' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('still requires a pin at runtime for the portable-sharing API', async () => {
    const fetcher = vi.fn()
    await expect(fetchRemoteRecipeV1('https://recipes.example/r.json', undefined as unknown as string, { fetch: fetcher }))
      .rejects.toMatchObject({ code: 'REMOTE_RECIPE_HASH_MISMATCH' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['recipeHash', 'operatorSetFingerprint', 'artifactHash'])('rejects an inconsistent embedded %s without an external pin or cache promotion', async (field) => {
    const cache = new VerifiedRecipeCacheV1()
    const altered = { ...recipe, hashes: { [field]: `sha256:${'0'.repeat(64)}` } }
    await expect(fetchRemoteRecipeForImportV1('https://recipes.example/r.json', {
      fetch: async () => response(JSON.stringify(altered)), cache,
    })).rejects.toMatchObject({ code: 'REMOTE_RECIPE_HASH_MISMATCH' })
    expect(cache.size).toBe(0)
  })

  it('runs schema, compilation, dependency, and semantic hash gates before caching', async () => {
    const hash = await recipeHashV1(recipe)
    const cache = new VerifiedRecipeCacheV1(2)
    const fetcher = vi.fn(async () => response(JSON.stringify(recipe))) as unknown as typeof fetch
    const first = await fetchRemoteRecipeV1('https://recipes.example/waymo.json', hash, { fetch: fetcher, cache })
    expect(first.recipeHash).toBe(hash)
    expect(first.compiledRecipe.normalizedManifest.id).toBe('waymo')
    expect(cache.size).toBe(1)
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual',
    }))

    const second = await fetchRemoteRecipeV1('https://other.example/same.json', hash, {
      fetch: vi.fn(() => { throw new Error('cache miss') }) as unknown as typeof fetch,
      cache,
    })
    expect(second.recipeHash).toBe(first.recipeHash)
    expect(second.compiledRecipe).not.toBe(first.compiledRecipe)
    await expect(fetchRemoteRecipeV1('https://other.example/same.json?token=secret', hash, { cache }))
      .rejects.toMatchObject({ code: 'REMOTE_RECIPE_CREDENTIAL_LEAKAGE' })
  })

  it('does not cache a hash mismatch', async () => {
    const cache = new VerifiedRecipeCacheV1()
    await expect(fetchRemoteRecipeV1(
      'https://recipes.example/waymo.json', `sha256:${'0'.repeat(64)}`,
      { fetch: async () => response(JSON.stringify(recipe)), cache },
    )).rejects.toMatchObject({ code: 'REMOTE_RECIPE_HASH_MISMATCH' })
    expect(cache.size).toBe(0)
  })

  it('cannot fetch missing operator or extension code', async () => {
    const hash = await recipeHashV1(recipe)
    await expect(fetchRemoteRecipeV1('https://recipes.example/waymo.json', hash, {
      fetch: async () => response(JSON.stringify(recipe)),
      cache: new VerifiedRecipeCacheV1(),
      operators: new OperatorRegistry(),
    })).rejects.toMatchObject({ code: 'REMOTE_RECIPE_INVALID' })

    const cache = new VerifiedRecipeCacheV1()
    await fetchRemoteRecipeV1('https://recipes.example/waymo.json', hash, {
      fetch: async () => response(JSON.stringify(recipe)), cache,
    })
    await expect(fetchRemoteRecipeV1('https://recipes.example/cached.json', hash, {
      cache, operators: new OperatorRegistry(),
    })).rejects.toMatchObject({ code: 'REMOTE_RECIPE_INVALID' })
  })

  it('rejects credential leakage, oversized bodies, and cross-origin redirects', async () => {
    const hash = await recipeHashV1(recipe)
    await expect(fetchRemoteRecipeV1(`https://recipes.example/r.json?token=secret`, hash))
      .rejects.toMatchObject({ code: 'REMOTE_RECIPE_CREDENTIAL_LEAKAGE' })

    await expect(fetchRemoteRecipeV1('https://recipes.example/r.json', hash, {
      cache: new VerifiedRecipeCacheV1(),
      fetch: async () => response('', { headers: { 'content-length': String(256 * 1024 + 1) } }),
    })).rejects.toMatchObject({ code: 'REMOTE_RECIPE_TOO_LARGE' })

    await expect(fetchRemoteRecipeV1('https://recipes.example/r.json', hash, {
      cache: new VerifiedRecipeCacheV1(),
      fetch: async () => response('', { status: 302, headers: { location: 'https://evil.example/r.json' } }),
    })).rejects.toMatchObject({ code: 'REMOTE_RECIPE_REDIRECT_FORBIDDEN' })
  })

  it('requires an exact-origin grant before including credentials', async () => {
    const hash = await recipeHashV1(recipe)
    const fetcher = vi.fn(async () => response(JSON.stringify(recipe))) as unknown as typeof fetch
    await fetchRemoteRecipeV1('https://recipes.example/r.json', hash, {
      cache: new VerifiedRecipeCacheV1(), fetch: fetcher,
      credentialGrant: { origin: 'https://recipes.example' },
    })
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ credentials: 'include' }))
    await expect(fetchRemoteRecipeV1('https://recipes.example/r.json', hash, {
      cache: new VerifiedRecipeCacheV1(),
      credentialGrant: { origin: 'https://other.example' },
    })).rejects.toBeInstanceOf(RemoteRecipeErrorV1)
  })
})
