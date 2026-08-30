/**
 * nuScenes Remote Discovery — index.json-based multi-scene loading.
 *
 * Full trainval metadata is too large for the browser (sample_data.json is
 * ~600MB), so hosted full nuScenes is sharded per scene: each scene is a tiny
 * self-contained version dir (see scripts/shard_nuscenes.py), and a split-level
 * index.json lists them. This module fetches that index; the store loads
 * individual shards through the existing single-directory path.
 */

import { DataLoadError, classifyFetchError, classifyHttpError } from '../../utils/errors'
import { selectVersionRootV1 } from '../../teachable/runtime/versionRoot'
import { nuScenesRecipe } from './manifest'

/** One scene entry in a split-level index.json. */
export interface NuScenesIndexScene {
  name: string
  num_samples?: number
  description?: string
  /** Path relative to the index root (e.g. "scene-0001/thumbnail.jpg") */
  thumbnail?: string
}

export interface NuScenesIndex {
  version: number
  dataset: string
  split?: string
  scenes: NuScenesIndexScene[]
}

/** A discovered scene: name, shard base URL, and optional direct thumbnail URL. */
export interface NuScenesDiscoveredScene {
  name: string
  sceneUrl: string
  thumbnailUrl?: string
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** Probe every allowlisted root so an ambiguous remote drop cannot be merged. */
export async function detectNuScenesVersionRoot(baseUrl: string): Promise<string> {
  const policy = nuScenesRecipe.match.versionRoot
  if (!policy) throw new Error('The bundled nuScenes recipe has no version-root policy.')
  const base = ensureTrailingSlash(baseUrl)
  const probes = await Promise.all(policy.candidates.map(async (root) => {
    const requiredFiles = await Promise.all(policy.requiredFiles.map(async (file) => {
      try {
        const response = await fetch(`${base}${root}/${file}`, { method: 'HEAD' })
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
        // SPA hosts often answer a missing JSON path with 200 + index.html.
        return response.ok && contentType.includes('json')
      } catch {
        return false
      }
    }))
    return requiredFiles.every(Boolean) ? root : null
  }))
  return selectVersionRootV1(policy, probes.filter((root): root is string => root !== null))
}

/**
 * Try to fetch and validate index.json from a nuScenes root URL.
 * Returns null on 404/403 (absent — caller falls back to the
 * single-directory flow). Throws on other HTTP/network errors.
 */
export async function fetchNuScenesIndex(baseUrl: string): Promise<NuScenesIndex | null> {
  const url = `${ensureTrailingSlash(baseUrl)}index.json`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })

    if (!res.ok) {
      if (res.status === 404 || res.status === 403) return null
      throw classifyHttpError(res.status, url)
    }

    // SPA-fallback hosts answer missing files with 200 + index.html — for a
    // self-hosted classic directory that must mean "no index", not a failure
    let index: NuScenesIndex
    try {
      index = await res.json() as NuScenesIndex
    } catch {
      console.warn(`[fetchNuScenesIndex] ${url} returned non-JSON — treating as absent`)
      return null
    }

    if (!index.version || !Array.isArray(index.scenes)) {
      throw new DataLoadError(
        'Invalid index.json format. Expected { version, dataset, scenes }.',
        'MANIFEST', url,
      )
    }
    if (index.dataset !== 'nuscenes') {
      throw new DataLoadError(
        `Expected dataset "nuscenes" in index.json, got "${index.dataset}".`,
        'MANIFEST', url,
      )
    }

    return index
  } catch (err) {
    if (err instanceof DataLoadError) throw err
    throw classifyFetchError(err, url)
  }
}

/**
 * Discover sharded scenes under a nuScenes root URL.
 * Returns null when there is no index.json — the URL is then treated as a
 * classic single version directory (v1.0-mini style).
 */
export async function discoverNuScenesScenes(
  baseUrl: string,
): Promise<NuScenesDiscoveredScene[] | null> {
  const base = ensureTrailingSlash(baseUrl)
  const index = await fetchNuScenesIndex(base)
  if (!index) return null

  return index.scenes.map((scene) => ({
    name: scene.name,
    sceneUrl: `${base}${scene.name}/`,
    thumbnailUrl: scene.thumbnail ? `${base}${scene.thumbnail}` : undefined,
  }))
}
