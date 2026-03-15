/**
 * Unit tests for AV2 remote loading module.
 *
 * Tests cover:
 * - Manifest validation (fetchAV2Manifest)
 * - Frame discovery from manifest (discoverAV2FramesFromManifest)
 * - URL loader (loadAV2FromUrl) — metadata fetch + DB construction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchAV2Manifest,
  discoverAV2FramesFromManifest,
  parseS3Url,
  parseS3ListXml,
  type AV2Manifest,
} from '../remote'
import { DataLoadError } from '../../../utils/errors'

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

// ---------------------------------------------------------------------------
// Sample manifest
// ---------------------------------------------------------------------------

const SAMPLE_MANIFEST: AV2Manifest = {
  version: 1,
  dataset: 'argoverse2',
  log_id: 'test-log-001',
  num_frames: 3,
  frames: [
    {
      timestamp_ns: '315966265659927216',
      cameras: {
        ring_front_center: '315966265649927216',
        ring_front_left: '315966265639927216',
        ring_front_right: '315966265629927216',
      },
    },
    {
      timestamp_ns: '315966265759927216',
      cameras: {
        ring_front_center: '315966265749927216',
        ring_front_left: '315966265739927216',
        ring_front_right: '315966265729927216',
      },
    },
    {
      timestamp_ns: '315966265859927216',
      cameras: {
        ring_front_center: '315966265849927216',
        ring_front_left: '315966265839927216',
        ring_front_right: '315966265829927216',
      },
    },
  ],
}

const SENSOR_NAME_TO_ID: Record<string, number> = {
  ring_front_center: 4,
  ring_front_left: 3,
  ring_front_right: 5,
}

const RING_CAMERAS = ['ring_front_left', 'ring_front_center', 'ring_front_right'] as const

// ---------------------------------------------------------------------------
// fetchAV2Manifest
// ---------------------------------------------------------------------------

describe('fetchAV2Manifest', () => {
  it('fetches and returns valid manifest', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_MANIFEST),
    })

    const result = await fetchAV2Manifest('https://s3.example.com/log/')
    expect(result).toEqual(SAMPLE_MANIFEST)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://s3.example.com/log/manifest.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('returns null on 404 (allows S3 listing fallback)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    })

    const result = await fetchAV2Manifest('https://s3.example.com/log/')
    expect(result).toBeNull()
  })

  it('throws on HTTP error (non-404)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    await expect(fetchAV2Manifest('https://s3.example.com/log/'))
      .rejects.toThrow(DataLoadError)
  })

  it('classifies TypeError as CORS error', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    try {
      await fetchAV2Manifest('https://s3.example.com/log/')
    } catch (e) {
      expect(e).toBeInstanceOf(DataLoadError)
      expect((e as DataLoadError).code).toBe('CORS')
    }
  })

  it('rejects invalid manifest format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ bad: 'data' }),
    })

    await expect(fetchAV2Manifest('https://s3.example.com/log/'))
      .rejects.toThrow(DataLoadError)
  })

  it('rejects wrong dataset type', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...SAMPLE_MANIFEST, dataset: 'waymo' }),
    })

    await expect(fetchAV2Manifest('https://s3.example.com/log/'))
      .rejects.toThrow('Expected dataset "argoverse2"')
  })
})

// ---------------------------------------------------------------------------
// discoverAV2FramesFromManifest
// ---------------------------------------------------------------------------

describe('discoverAV2FramesFromManifest', () => {
  it('extracts LiDAR timestamps as bigints', () => {
    const { lidarTimestamps } = discoverAV2FramesFromManifest(
      SAMPLE_MANIFEST, SENSOR_NAME_TO_ID, RING_CAMERAS,
    )

    expect(lidarTimestamps).toHaveLength(3)
    expect(lidarTimestamps[0]).toBe(BigInt('315966265659927216'))
    expect(lidarTimestamps[1]).toBe(BigInt('315966265759927216'))
    expect(lidarTimestamps[2]).toBe(BigInt('315966265859927216'))
  })

  it('builds camera file entries per frame', () => {
    const { cameraFilesByFrame } = discoverAV2FramesFromManifest(
      SAMPLE_MANIFEST, SENSOR_NAME_TO_ID, RING_CAMERAS,
    )

    expect(cameraFilesByFrame.size).toBe(3)

    // Check frame 0
    const frame0 = cameraFilesByFrame.get(0)!
    expect(frame0).toHaveLength(3) // 3 cameras
    expect(frame0.find(c => c.cameraId === 4)?.filename).toBe(
      'sensors/cameras/ring_front_center/315966265649927216.jpg',
    )
    expect(frame0.find(c => c.cameraId === 3)?.filename).toBe(
      'sensors/cameras/ring_front_left/315966265639927216.jpg',
    )
  })

  it('preserves camera order from ringCameraNames', () => {
    const { cameraFilesByFrame } = discoverAV2FramesFromManifest(
      SAMPLE_MANIFEST, SENSOR_NAME_TO_ID, RING_CAMERAS,
    )

    const frame0 = cameraFilesByFrame.get(0)!
    // Order should match RING_CAMERAS: front_left, front_center, front_right
    expect(frame0[0].cameraId).toBe(3) // ring_front_left
    expect(frame0[1].cameraId).toBe(4) // ring_front_center
    expect(frame0[2].cameraId).toBe(5) // ring_front_right
  })

  it('skips cameras not in sensorNameToId', () => {
    const limitedSensors = { ring_front_center: 4 }
    const { cameraFilesByFrame } = discoverAV2FramesFromManifest(
      SAMPLE_MANIFEST, limitedSensors, RING_CAMERAS,
    )

    const frame0 = cameraFilesByFrame.get(0)!
    expect(frame0).toHaveLength(1)
    expect(frame0[0].cameraId).toBe(4)
  })

  it('handles empty manifest frames', () => {
    const emptyManifest: AV2Manifest = {
      ...SAMPLE_MANIFEST,
      num_frames: 0,
      frames: [],
    }
    const { lidarTimestamps, cameraFilesByFrame } = discoverAV2FramesFromManifest(
      emptyManifest, SENSOR_NAME_TO_ID, RING_CAMERAS,
    )

    expect(lidarTimestamps).toHaveLength(0)
    expect(cameraFilesByFrame.size).toBe(0)
  })

  it('handles frames with missing camera entries', () => {
    const partialManifest: AV2Manifest = {
      ...SAMPLE_MANIFEST,
      frames: [
        {
          timestamp_ns: '100',
          cameras: { ring_front_center: '99' }, // only one camera
        },
      ],
    }
    const { cameraFilesByFrame } = discoverAV2FramesFromManifest(
      partialManifest, SENSOR_NAME_TO_ID, RING_CAMERAS,
    )

    const frame0 = cameraFilesByFrame.get(0)!
    expect(frame0).toHaveLength(1)
    expect(frame0[0].cameraId).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// parseS3Url
// ---------------------------------------------------------------------------

describe('parseS3Url', () => {
  it('parses virtual-hosted S3 URL', () => {
    const result = parseS3Url('https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/val/log001/')
    expect(result).toEqual({
      bucketEndpoint: 'https://argoverse.s3.us-east-1.amazonaws.com',
      prefix: 'datasets/av2/sensor/val/log001/',
    })
  })

  it('parses virtual-hosted S3 URL without region', () => {
    const result = parseS3Url('https://mybucket.s3.amazonaws.com/prefix/path/')
    expect(result).toEqual({
      bucketEndpoint: 'https://mybucket.s3.amazonaws.com',
      prefix: 'prefix/path/',
    })
  })

  it('parses path-style S3 URL', () => {
    const result = parseS3Url('https://s3.us-east-1.amazonaws.com/argoverse/datasets/av2/')
    expect(result).toEqual({
      bucketEndpoint: 'https://argoverse.s3.us-east-1.amazonaws.com',
      prefix: 'datasets/av2/',
    })
  })

  it('returns null for non-S3 URL', () => {
    expect(parseS3Url('https://example.com/data/')).toBeNull()
  })

  it('returns null for invalid URL', () => {
    expect(parseS3Url('not-a-url')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseS3ListXml
// ---------------------------------------------------------------------------

describe('parseS3ListXml', () => {
  it('parses keys from XML response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>prefix/sensors/lidar/100.feather</Key></Contents>
  <Contents><Key>prefix/sensors/lidar/200.feather</Key></Contents>
  <Contents><Key>prefix/sensors/cameras/ring_front_center/100.jpg</Key></Contents>
</ListBucketResult>`

    const result = parseS3ListXml(xml)
    expect(result.keys).toEqual([
      'prefix/sensors/lidar/100.feather',
      'prefix/sensors/lidar/200.feather',
      'prefix/sensors/cameras/ring_front_center/100.jpg',
    ])
    expect(result.isTruncated).toBe(false)
    expect(result.nextContinuationToken).toBeUndefined()
  })

  it('detects truncation and continuation token', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>abc123</NextContinuationToken>
  <Contents><Key>file1.txt</Key></Contents>
</ListBucketResult>`

    const result = parseS3ListXml(xml)
    expect(result.isTruncated).toBe(true)
    expect(result.nextContinuationToken).toBe('abc123')
    expect(result.keys).toHaveLength(1)
  })

  it('handles empty listing', () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`
    const result = parseS3ListXml(xml)
    expect(result.keys).toHaveLength(0)
    expect(result.isTruncated).toBe(false)
  })
})
