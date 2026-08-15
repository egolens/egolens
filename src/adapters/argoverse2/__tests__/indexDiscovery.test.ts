/**
 * Unit tests for index.json-based multi-log discovery.
 *
 * R2 public domains (and nginx, CDNs, …) cannot answer ListObjectsV2, so
 * mirrors publish index.json at the split root. These tests cover:
 * - fetchAV2Index: parsing, absence (404/403 → null), validation, HTTP errors
 * - discoverAV2Logs: index-first path, S3-listing fallback, maxLogs cap
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchAV2Index,
  discoverAV2Logs,
  discoverAV2AllSplits,
  splitFromUrl,
  isAV2SensorRootUrl,
  type AV2Index,
} from '../remote'
import { DataLoadError } from '../../../utils/errors'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

const BASE = 'https://data.egolens.org/av2/sensor/val/'

const SAMPLE_INDEX: AV2Index = {
  version: 1,
  dataset: 'argoverse2',
  split: 'val',
  logs: [
    { log_id: 'log-aaa', num_frames: 157, thumbnail: 'log-aaa/thumbnail.jpg' },
    { log_id: 'log-bbb', num_frames: 150 },
    { log_id: 'log-ccc' },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('fetchAV2Index', () => {
  it('fetches and parses a valid index.json', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_INDEX))

    const index = await fetchAV2Index(BASE)
    expect(index).not.toBeNull()
    expect(index!.logs).toHaveLength(3)
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE}index.json`,
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it('appends a trailing slash to the base URL when missing', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_INDEX))

    await fetchAV2Index('https://data.egolens.org/av2/sensor/val')
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}index.json`)
  })

  it('returns null on 404 (absent index)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404))
    expect(await fetchAV2Index(BASE)).toBeNull()
  })

  it('returns null on 403 (S3 reports missing keys as AccessDenied)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 403))
    expect(await fetchAV2Index(BASE)).toBeNull()
  })

  it('throws DataLoadError on other HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500))
    await expect(fetchAV2Index(BASE)).rejects.toThrow(DataLoadError)
  })

  it('throws on schema-invalid index (missing logs array)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ version: 1, dataset: 'argoverse2' }))
    await expect(fetchAV2Index(BASE)).rejects.toThrow(/Invalid index\.json/)
  })

  it('throws on wrong dataset', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ version: 1, dataset: 'nuscenes', logs: [] }),
    )
    await expect(fetchAV2Index(BASE)).rejects.toThrow(/Expected dataset "argoverse2"/)
  })

  it('wraps network errors as DataLoadError', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(fetchAV2Index(BASE)).rejects.toThrow(DataLoadError)
  })
})

describe('discoverAV2Logs', () => {
  it('builds log entries from index.json, resolving thumbnails against the split root', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_INDEX))

    const logs = await discoverAV2Logs(BASE)
    expect(logs).toEqual([
      {
        logId: 'log-aaa',
        logUrl: `${BASE}log-aaa/`,
        thumbnailUrl: `${BASE}log-aaa/thumbnail.jpg`,
        split: 'val',
      },
      { logId: 'log-bbb', logUrl: `${BASE}log-bbb/`, thumbnailUrl: undefined, split: 'val' },
      { logId: 'log-ccc', logUrl: `${BASE}log-ccc/`, thumbnailUrl: undefined, split: 'val' },
    ])
    // index path needs exactly one request
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('caps results at maxLogs', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_INDEX))

    const logs = await discoverAV2Logs(BASE, 2)
    expect(logs.map((l) => l.logId)).toEqual(['log-aaa', 'log-bbb'])
  })

  it('falls back to S3 listing when index.json is absent on an S3 URL', async () => {
    const s3Base = 'https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/val/'
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404)) // index.json miss
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        `<?xml version="1.0"?><ListBucketResult>
          <IsTruncated>false</IsTruncated>
          <CommonPrefixes><Prefix>datasets/av2/sensor/val/log-s3-one/</Prefix></CommonPrefixes>
          <CommonPrefixes><Prefix>datasets/av2/sensor/val/log-s3-two/</Prefix></CommonPrefixes>
        </ListBucketResult>`,
    })

    const logs = await discoverAV2Logs(s3Base)
    expect(logs.map((l) => l.logId)).toEqual(['log-s3-one', 'log-s3-two'])
    expect(logs[0].logUrl).toBe(
      'https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/val/log-s3-one/',
    )
  })

  it('throws a helpful error when there is no index and the host is not S3', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404))
    await expect(discoverAV2Logs(BASE)).rejects.toThrow(/index\.json/)
  })

  it('tags each log with the split from the URL', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_INDEX))
    const logs = await discoverAV2Logs(BASE)
    expect(logs.every((l) => l.split === 'val')).toBe(true)
  })
})

describe('splitFromUrl / isAV2SensorRootUrl', () => {
  it('extracts the split from split-level URLs', () => {
    expect(splitFromUrl('https://x.com/av2/sensor/train/')).toBe('train')
    expect(splitFromUrl('https://x.com/av2/sensor/val')).toBe('val')
    expect(splitFromUrl('https://x.com/av2/sensor/test/')).toBe('test')
    expect(splitFromUrl('https://x.com/av2/sensor/')).toBeNull()
    expect(splitFromUrl('https://x.com/av2/sensor/some-log-id/')).toBeNull()
  })

  it('detects sensor-dataset roots', () => {
    expect(isAV2SensorRootUrl('https://x.com/datasets/av2/sensor/')).toBe(true)
    expect(isAV2SensorRootUrl('https://x.com/datasets/av2/sensor')).toBe(true)
    expect(isAV2SensorRootUrl('https://x.com/datasets/av2/sensor/val/')).toBe(false)
    expect(isAV2SensorRootUrl('not a url')).toBe(false)
  })
})

describe('discoverAV2AllSplits', () => {
  const ROOT = 'https://data.egolens.org/av2/sensor/'

  const indexFor = (split: string, ids: string[]): AV2Index => ({
    version: 1,
    dataset: 'argoverse2',
    split,
    logs: ids.map((id) => ({ log_id: id })),
  })

  it('merges logs from every split, each tagged with its split', async () => {
    // One index.json fetch per split, resolved by URL (parallel-safe)
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/train/')) return jsonResponse(indexFor('train', ['t1', 't2']))
      if (url.includes('/val/')) return jsonResponse(indexFor('val', ['v1']))
      if (url.includes('/test/')) return jsonResponse(indexFor('test', ['x1']))
      return jsonResponse({}, 404)
    })

    const logs = await discoverAV2AllSplits(ROOT)
    expect(logs.map((l) => `${l.split}:${l.logId}`)).toEqual([
      'train:t1', 'train:t2', 'val:v1', 'test:x1',
    ])
    expect(logs[0].logUrl).toBe(`${ROOT}train/t1/`)
  })

  it('tolerates a missing split (partial mirror)', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/val/')) return jsonResponse(indexFor('val', ['v1']))
      return jsonResponse({}, 404) // train/test absent, non-S3 host → those splits fail
    })

    const logs = await discoverAV2AllSplits(ROOT)
    expect(logs.map((l) => l.logId)).toEqual(['v1'])
  })

  it('fails loudly when every split is empty', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({}, 404))
    await expect(discoverAV2AllSplits(ROOT)).rejects.toThrow(DataLoadError)
  })
})
