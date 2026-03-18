/**
 * Waymo Open Dataset — URL-based remote loading.
 *
 * Discovers segments by listing `vehicle_pose/*.parquet` files from an S3 bucket
 * (or manifest.json), then builds component URLs for each segment.
 *
 * Expected URL structure:
 *   {baseUrl}/
 *   ├── vehicle_pose/{segment_id}.parquet
 *   ├── lidar/{segment_id}.parquet
 *   ├── camera_image/{segment_id}.parquet
 *   └── ...
 */

import { DataLoadError } from '../../utils/errors'
import { parseS3Url, parseS3ListXml } from '../argoverse2/remote'
import { waymoManifest } from './manifest'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WaymoRemoteManifest {
  version: number
  dataset: 'waymo'
  segments: string[]          // segment IDs (without .parquet extension)
  components?: string[]       // optional: available component directories
}

// ---------------------------------------------------------------------------
// Manifest fetch (optional fast path)
// ---------------------------------------------------------------------------

export async function fetchWaymoManifest(baseUrl: string): Promise<WaymoRemoteManifest | null> {
  const url = `${baseUrl}manifest.json`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) return null
      return null
    }
    const manifest = await res.json() as WaymoRemoteManifest
    if (manifest.dataset !== 'waymo' || !Array.isArray(manifest.segments)) return null
    return manifest
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Segment discovery — tries S3 listing first, then HTTP directory listing
// ---------------------------------------------------------------------------

/**
 * Discover Waymo segment IDs from a remote URL.
 * Strategy: S3 ListObjectsV2 → HTTP directory listing fallback.
 */
export async function discoverWaymoSegments(
  baseUrl: string,
  maxSegments = 200,
): Promise<string[]> {
  // Try S3 listing first (works for S3-hosted data)
  const s3 = parseS3Url(baseUrl)
  if (s3) {
    return discoverWaymoSegmentsFromS3(s3, maxSegments)
  }

  // Fallback: HTTP directory listing (http-server, nginx, etc.)
  return discoverWaymoSegmentsFromDirectoryListing(baseUrl)
}

/**
 * S3 ListObjectsV2-based segment discovery.
 */
async function discoverWaymoSegmentsFromS3(
  s3: { bucketEndpoint: string; prefix: string },
  maxSegments: number,
): Promise<string[]> {
  const prefix = `${s3.prefix}vehicle_pose/`
  const segmentIds: string[] = []
  let continuationToken: string | undefined

  do {
    const params = new URLSearchParams({
      'list-type': '2',
      'prefix': prefix,
      'max-keys': '1000',
    })
    if (continuationToken) params.set('continuation-token', continuationToken)

    const url = `${s3.bucketEndpoint}/?${params}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })

    if (!res.ok) {
      if (res.status === 403) {
        throw new DataLoadError(
          'S3 bucket listing not accessible (403). Enable public ListBucket access or provide manifest.json.',
          'CORS', url,
        )
      }
      throw new DataLoadError(
        `S3 listing failed with status ${res.status}`,
        'NETWORK', url,
      )
    }

    const xml = await res.text()
    const page = parseS3ListXml(xml)

    for (const key of page.keys) {
      const filename = key.split('/').pop() || ''
      if (filename.endsWith('.parquet')) {
        segmentIds.push(filename.replace(/\.parquet$/, ''))
      }
    }

    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
  } while (continuationToken && segmentIds.length < maxSegments)

  return segmentIds.sort()
}

/**
 * HTTP directory listing fallback — parses the HTML index page
 * returned by http-server, nginx autoindex, Apache, etc.
 * Fetches `{baseUrl}vehicle_pose/` and extracts .parquet filenames from <a> tags.
 */
async function discoverWaymoSegmentsFromDirectoryListing(
  baseUrl: string,
): Promise<string[]> {
  const dirUrl = `${baseUrl}vehicle_pose/`
  const res = await fetch(dirUrl, { signal: AbortSignal.timeout(15_000) })

  if (!res.ok) {
    throw new DataLoadError(
      `Cannot list segments: ${dirUrl} returned ${res.status}. ` +
      'Provide a manifest.json or ensure the server supports directory listing.',
      'NETWORK', dirUrl,
    )
  }

  const html = await res.text()

  // Parse .parquet filenames from <a href="..."> tags
  const segmentIds: string[] = []
  const linkRegex = /href="([^"]*\.parquet)"/gi
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    // href may be full path or just filename
    const href = decodeURIComponent(match[1])
    const filename = href.split('/').pop() || ''
    if (filename.endsWith('.parquet')) {
      segmentIds.push(filename.replace(/\.parquet$/, ''))
    }
  }

  if (segmentIds.length === 0) {
    throw new DataLoadError(
      'No .parquet files found in vehicle_pose/ directory listing. ' +
      'Provide a manifest.json at the URL root.',
      'MANIFEST', dirUrl,
    )
  }

  return segmentIds.sort()
}

// ---------------------------------------------------------------------------
// URL construction for a segment
// ---------------------------------------------------------------------------

/**
 * Build component → URL map for a given segment at a remote base URL.
 * Uses all known Waymo components from the manifest.
 */
export function buildWaymoSegmentUrls(
  baseUrl: string,
  segmentId: string,
): Map<string, string> {
  const sources = new Map<string, string>()
  for (const comp of waymoManifest.knownComponents) {
    sources.set(comp, `${baseUrl}${comp}/${segmentId}.parquet`)
  }
  return sources
}
