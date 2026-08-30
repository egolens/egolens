/**
 * Unit tests for nuScenes index.json scene discovery.
 *
 * Sharded hosting (scripts/shard_nuscenes.py) publishes an index.json at the
 * root; absence of the index means the URL is a classic single version dir
 * and discovery must return null so the caller falls back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  detectNuScenesVersionRoot,
  fetchNuScenesIndex,
  discoverNuScenesScenes,
  type NuScenesIndex,
} from '../remote'
import { DataLoadError } from '../../../utils/errors'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

const BASE = 'https://data.egolens.org/nuscenes-full/'

const SAMPLE_INDEX: NuScenesIndex = {
  version: 1,
  dataset: 'nuscenes',
  split: 'v1.0-trainval',
  scenes: [
    { name: 'scene-0001', num_samples: 39, thumbnail: 'scene-0001/thumbnail.jpg' },
    { name: 'scene-0002', num_samples: 40 },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  }
}

describe('fetchNuScenesIndex', () => {
  it('fetches and parses a valid index.json', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_INDEX))
    const index = await fetchNuScenesIndex(BASE)
    expect(index!.scenes).toHaveLength(2)
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE}index.json`,
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it('returns null on 404 and 403 (absent index)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404))
    expect(await fetchNuScenesIndex(BASE)).toBeNull()
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 403))
    expect(await fetchNuScenesIndex(BASE)).toBeNull()
  })

  it('treats a 200 non-JSON response as absent (SPA-fallback hosts)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    })
    expect(await fetchNuScenesIndex(BASE)).toBeNull()
  })

  it('throws DataLoadError on other HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))
    await expect(fetchNuScenesIndex(BASE)).rejects.toThrow(DataLoadError)
  })

  it('throws on schema-invalid index', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: 1, dataset: 'nuscenes' }))
    await expect(fetchNuScenesIndex(BASE)).rejects.toThrow(/Invalid index\.json/)
  })

  it('throws on wrong dataset', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ version: 1, dataset: 'argoverse2', scenes: [] }),
    )
    await expect(fetchNuScenesIndex(BASE)).rejects.toThrow(/Expected dataset "nuscenes"/)
  })
})

describe('discoverNuScenesScenes', () => {
  it('builds scene entries with shard URLs and thumbnails', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_INDEX))
    const scenes = await discoverNuScenesScenes(BASE)
    expect(scenes).toEqual([
      {
        name: 'scene-0001',
        sceneUrl: `${BASE}scene-0001/`,
        thumbnailUrl: `${BASE}scene-0001/thumbnail.jpg`,
      },
      { name: 'scene-0002', sceneUrl: `${BASE}scene-0002/`, thumbnailUrl: undefined },
    ])
  })

  it('returns null when there is no index (single-directory fallback)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404))
    expect(await discoverNuScenesScenes(BASE)).toBeNull()
  })

  it('appends a trailing slash to the base URL when missing', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_INDEX))
    await discoverNuScenesScenes('https://data.egolens.org/nuscenes-full')
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}index.json`)
  })
})

describe('detectNuScenesVersionRoot', () => {
  it.each([
    'v1.0-mini',
    'v1.0-trainval',
    'v1.0-test',
  ] as const)('selects %s in URL mode only when every required file exists', async (expected) => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      expect(options).toEqual({ method: 'HEAD' })
      return Promise.resolve(jsonResponse({}, url.includes(`/${expected}/`) ? 200 : 404))
    })
    expect(await detectNuScenesVersionRoot(BASE)).toBe(expected)
    expect(mockFetch).toHaveBeenCalledTimes(18)
  })

  it('rejects multiple viable URL roots deterministically', async () => {
    mockFetch.mockImplementation((url: string) => Promise.resolve(
      jsonResponse({}, url.includes('/v1.0-test/') ? 404 : 200),
    ))
    await expect(detectNuScenesVersionRoot(BASE)).rejects.toMatchObject({
      code: 'VERSION_ROOT_AMBIGUOUS',
    })
  })

  it('ignores 200 HTML SPA fallbacks during root probing', async () => {
    mockFetch.mockImplementation((url: string) => Promise.resolve(
      url.includes('/v1.0-mini/')
        ? jsonResponse({}, 200)
        : { ...jsonResponse({}, 200), headers: new Headers({ 'content-type': 'text/html' }) },
    ))
    expect(await detectNuScenesVersionRoot(BASE)).toBe('v1.0-mini')
  })

  it('rejects a candidate with only a partial metadata root', async () => {
    mockFetch.mockImplementation((url: string) => Promise.resolve(
      jsonResponse({}, url.endsWith('/scene.json') ? 200 : 404),
    ))
    await expect(detectNuScenesVersionRoot(BASE)).rejects.toMatchObject({
      code: 'VERSION_ROOT_MISSING',
    })
  })
})
