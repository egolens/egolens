import { describe, expect, it, vi } from 'vitest'
import waymoRecipe from '../../adapters/recipes/waymo.egolens-adapter.json'
import { recipeHashV1 } from '../authoring/hashes'
import { OperatorRegistry } from '../operators/registry'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import {
  fetchRemoteRecipeV1,
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
