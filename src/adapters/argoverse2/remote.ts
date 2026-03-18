/**
 * Argoverse 2 Remote Loading — URL-based data loading for AV2 logs.
 *
 * Entry point: `loadAV2FromUrl(baseUrl)` fetches metadata feather files,
 * builds an AV2LogDatabase, and constructs URL-based fileEntries for
 * worker pools.
 *
 * Frame discovery strategy (in order):
 *   1. manifest.json — fast, single request, full camera matching
 *   2. S3 ListObjectsV2 — fallback, auto-discovers files from bucket listing
 *   3. Error — neither available
 *
 * NOTE: Manifest types (AV2Manifest, AV2ManifestFrame) and
 * discoverAV2FramesFromManifest() live in metadata.ts to avoid circular
 * imports (remote.ts → metadata.ts → remote.ts). They are re-exported
 * from here for convenience.
 */

import { DataLoadError, classifyFetchError, classifyHttpError } from '../../utils/errors'
import {
  buildAV2LogDatabase,
  type AV2LogDatabase,
  type AV2Manifest,
  type AV2ManifestFrame,
} from './metadata'

// Re-export manifest types so existing imports from './remote' still work
export type { AV2Manifest, AV2ManifestFrame }

// Re-export discovery function for test access
export { discoverAV2FramesFromManifest } from './metadata'

// ---------------------------------------------------------------------------
// Manifest fetch (optional — returns null on 404)
// ---------------------------------------------------------------------------

/**
 * Try to fetch and validate manifest.json from a base URL.
 * Returns null if 404 (allows S3 listing fallback).
 * Throws on CORS / network / other errors.
 */
export async function fetchAV2Manifest(baseUrl: string): Promise<AV2Manifest | null> {
  const url = `${baseUrl}manifest.json`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      if (res.status === 404) return null
      throw classifyHttpError(res.status, url)
    }

    const manifest = await res.json() as AV2Manifest

    // Basic validation
    if (!manifest.version || !manifest.dataset || !manifest.frames) {
      throw new DataLoadError(
        'Invalid manifest.json format. Expected { version, dataset, log_id, frames }.',
        'MANIFEST', url,
      )
    }
    if (manifest.dataset !== 'argoverse2') {
      throw new DataLoadError(
        `Expected dataset "argoverse2" in manifest, got "${manifest.dataset}".`,
        'MANIFEST', url,
      )
    }

    return manifest
  } catch (err) {
    if (err instanceof DataLoadError) throw err
    throw classifyFetchError(err, url)
  }
}

// ---------------------------------------------------------------------------
// S3 ListObjectsV2 fallback
// ---------------------------------------------------------------------------

/**
 * Parse an S3-style base URL into bucket endpoint + prefix.
 *
 * Supports:
 *   https://bucket.s3.region.amazonaws.com/prefix/path/
 *   https://bucket.s3.amazonaws.com/prefix/path/
 *   https://s3.region.amazonaws.com/bucket/prefix/path/
 *
 * Returns null if the URL is not recognizable as S3.
 */
export function parseS3Url(baseUrl: string): { bucketEndpoint: string; prefix: string } | null {
  try {
    const u = new URL(baseUrl)
    const host = u.hostname

    // Pattern 1: bucket.s3[.region].amazonaws.com
    const virtualHosted = host.match(/^(.+?)\.s3[.-](.+\.)?amazonaws\.com$/)
    if (virtualHosted) {
      // bucketEndpoint = scheme + host (no path prefix)
      const bucketEndpoint = `${u.protocol}//${u.hostname}`
      // prefix = path without leading slash, keep trailing slash
      const prefix = u.pathname.slice(1) // remove leading /
      return { bucketEndpoint, prefix }
    }

    // Pattern 2: s3[.region].amazonaws.com/bucket/prefix
    const pathStyle = host.match(/^s3[.-](.+\.)?amazonaws\.com$/)
    if (pathStyle) {
      const pathParts = u.pathname.slice(1).split('/')
      const bucket = pathParts[0]
      const prefix = pathParts.slice(1).join('/')
      const bucketEndpoint = `${u.protocol}//${bucket}.${u.hostname}`
      return { bucketEndpoint, prefix }
    }

    return null
  } catch {
    return null
  }
}

/** Single page of S3 ListObjectsV2 response. */
interface S3ListPage {
  keys: string[]
  isTruncated: boolean
  nextContinuationToken?: string
}

/**
 * Fetch one page of S3 ListObjectsV2 results.
 */
async function fetchS3ListPage(
  bucketEndpoint: string,
  prefix: string,
  continuationToken?: string,
): Promise<S3ListPage> {
  const params = new URLSearchParams({
    'list-type': '2',
    'prefix': prefix,
    'max-keys': '2000',
  })
  if (continuationToken) params.set('continuation-token', continuationToken)

  const url = `${bucketEndpoint}/?${params}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })

  if (!res.ok) {
    if (res.status === 403) {
      throw new DataLoadError(
        'S3 bucket listing is not publicly accessible (403 Forbidden). ' +
        'Either enable public ListBucket access, or provide a manifest.json.',
        'CORS', url,
      )
    }
    throw classifyHttpError(res.status, url)
  }

  const xml = await res.text()
  return parseS3ListXml(xml)
}

/**
 * Parse S3 ListObjectsV2 XML response.
 */
export function parseS3ListXml(xml: string): S3ListPage {
  const keys: string[] = []

  // Extract <Key>...</Key> values
  const keyRegex = /<Key>(.*?)<\/Key>/g
  let m: RegExpExecArray | null
  while ((m = keyRegex.exec(xml)) !== null) {
    keys.push(m[1])
  }

  // Check truncation
  const truncMatch = xml.match(/<IsTruncated>(.*?)<\/IsTruncated>/)
  const isTruncated = truncMatch?.[1] === 'true'

  // Next token
  const tokenMatch = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)

  return {
    keys,
    isTruncated,
    nextContinuationToken: tokenMatch?.[1],
  }
}

/**
 * Discover AV2 frames by listing S3 objects under sensors/lidar/ and sensors/cameras/.
 *
 * Builds the same data structure as discoverAV2FramesFromManifest (manifest) or
 * the local file-key scanning path — so buildAV2LogDatabase works identically.
 *
 * Returns a synthetic file key map for buildAV2LogDatabase to scan,
 * plus the discovered logId.
 */
export async function discoverAV2FramesFromS3(
  baseUrl: string,
  onProgress?: (progress: number) => void,
): Promise<{ fileKeys: string[]; logId: string }> {
  const s3 = parseS3Url(baseUrl)
  if (!s3) {
    throw new DataLoadError(
      'Cannot auto-discover files: URL is not a recognized S3 endpoint. ' +
      'Provide a manifest.json at the URL root.',
      'MANIFEST', baseUrl,
    )
  }

  // Extract logId from prefix (last non-empty segment)
  const segments = s3.prefix.replace(/\/$/, '').split('/')
  const logId = segments[segments.length - 1] || 'unknown'

  // List all objects under the prefix (paginated)
  const allKeys: string[] = []
  let continuationToken: string | undefined
  let pageCount = 0

  do {
    const page = await fetchS3ListPage(s3.bucketEndpoint, s3.prefix, continuationToken)
    allKeys.push(...page.keys)
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
    pageCount++
    onProgress?.(Math.min(0.05 * pageCount, 0.2))
  } while (continuationToken && pageCount < 20) // safety cap

  // Strip the prefix to get relative paths (same format as local file keys)
  const fileKeys = allKeys
    .map(k => k.startsWith(s3.prefix) ? k.slice(s3.prefix.length) : k)
    .filter(k => k.length > 0)

  if (fileKeys.length === 0) {
    throw new DataLoadError(
      'S3 listing returned no objects under this prefix. Check the URL path.',
      'NOT_FOUND', baseUrl,
    )
  }

  return { fileKeys, logId }
}

// ---------------------------------------------------------------------------
// Multi-log discovery (parent directory listing)
// ---------------------------------------------------------------------------

/** Single page of S3 ListObjectsV2 with delimiter — returns CommonPrefixes (subdirectories). */
interface S3PrefixListPage {
  prefixes: string[]
  isTruncated: boolean
  nextContinuationToken?: string
}

/**
 * Fetch one page of S3 subdirectories using delimiter='/'.
 * Returns CommonPrefixes (folder names) instead of individual file keys.
 */
async function fetchS3PrefixPage(
  bucketEndpoint: string,
  prefix: string,
  continuationToken?: string,
): Promise<S3PrefixListPage> {
  const params = new URLSearchParams({
    'list-type': '2',
    'prefix': prefix,
    'delimiter': '/',
    'max-keys': '1000',
  })
  if (continuationToken) params.set('continuation-token', continuationToken)

  const url = `${bucketEndpoint}/?${params}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })

  if (!res.ok) {
    if (res.status === 403) {
      throw new DataLoadError(
        'S3 bucket listing is not publicly accessible (403 Forbidden).',
        'CORS', url,
      )
    }
    throw classifyHttpError(res.status, url)
  }

  const xml = await res.text()

  // Extract <Prefix>...</Prefix> inside <CommonPrefixes> blocks
  const prefixes: string[] = []
  const prefixRegex = /<CommonPrefixes>\s*<Prefix>(.*?)<\/Prefix>/g
  let m: RegExpExecArray | null
  while ((m = prefixRegex.exec(xml)) !== null) {
    prefixes.push(m[1])
  }

  const truncMatch = xml.match(/<IsTruncated>(.*?)<\/IsTruncated>/)
  const isTruncated = truncMatch?.[1] === 'true'
  const tokenMatch = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)

  return {
    prefixes,
    isTruncated,
    nextContinuationToken: tokenMatch?.[1],
  }
}

/**
 * Detect if a URL points to a split directory (e.g. .../train/) rather than a specific log.
 * Heuristic: if the last path segment is 'train', 'val', or 'test',
 * it's a parent directory containing logs.
 */
export function isAV2ParentUrl(baseUrl: string): boolean {
  const path = new URL(baseUrl).pathname.replace(/\/$/, '')
  const lastSegment = path.split('/').pop() || ''
  return ['train', 'val', 'test'].includes(lastSegment)
}

/**
 * Discover AV2 log IDs from a split-level S3 directory (e.g. .../train/).
 *
 * Uses delimiter='/' for efficient subdirectory-only listing.
 * Each split (train/val/test) should be entered as a separate URL —
 * keeps logic simple and decoupled.
 *
 * @param baseUrl - Split URL with trailing slash (e.g. ".../sensor/train/")
 * @param maxLogs - Maximum number of logs to discover (default 700)
 * @returns Array of { logId, logUrl } entries
 */
export async function discoverAV2LogsFromS3(
  baseUrl: string,
  maxLogs = 700,
): Promise<{ logId: string; logUrl: string }[]> {
  const s3 = parseS3Url(baseUrl)
  if (!s3) {
    throw new DataLoadError(
      'Cannot discover logs: URL is not a recognized S3 endpoint.',
      'MANIFEST', baseUrl,
    )
  }

  return discoverAV2LogsInSplit(s3.bucketEndpoint, s3.prefix, maxLogs)
}

/**
 * Discover log IDs within a single AV2 split directory.
 */
async function discoverAV2LogsInSplit(
  bucketEndpoint: string,
  prefix: string,
  maxLogs: number,
): Promise<{ logId: string; logUrl: string }[]> {
  const logs: { logId: string; logUrl: string }[] = []
  let continuationToken: string | undefined
  let pageCount = 0

  do {
    const page = await fetchS3PrefixPage(bucketEndpoint, prefix, continuationToken)

    for (const pfx of page.prefixes) {
      // pfx looks like "datasets/av2/sensor/train/00a6ffc1-.../""
      const segments = pfx.replace(/\/$/, '').split('/')
      const logId = segments[segments.length - 1]
      if (logId) {
        const logUrl = `${bucketEndpoint}/${pfx}`
        logs.push({ logId, logUrl })
      }
      if (logs.length >= maxLogs) break
    }

    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
    pageCount++
  } while (continuationToken && logs.length < maxLogs && pageCount < 10)

  return logs
}

// ---------------------------------------------------------------------------
// Buffer fetch helper
// ---------------------------------------------------------------------------

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw classifyHttpError(res.status, url)
  return res.arrayBuffer()
}

// ---------------------------------------------------------------------------
// Main URL loader
// ---------------------------------------------------------------------------

export interface AV2UrlLoadResult {
  /** Parsed AV2 log database (same type as local mode) */
  db: AV2LogDatabase
  /** URL-based file entries for worker pools: [relative_filename, full_url][] */
  fileEntries: [string, string][]
}

/**
 * Load an AV2 log from a base URL.
 *
 * Frame discovery: manifest-first, S3-listing fallback.
 *   1. If manifest provided → use manifest for frame discovery
 *   2. If manifest is null → use S3 ListObjectsV2 to discover file keys
 *
 * Then fetches metadata feather files, builds AV2LogDatabase,
 * and constructs URL-based file entries for workers.
 *
 * @param baseUrl - Base URL with trailing slash (e.g. "https://s3.../log_id/")
 * @param manifest - Pre-fetched manifest.json, or null for S3 listing fallback
 * @param onProgress - Optional progress callback (0-1)
 */
export async function loadAV2FromUrl(
  baseUrl: string,
  manifest: AV2Manifest | null,
  onProgress?: (progress: number) => void,
): Promise<AV2UrlLoadResult> {
  // S3 listing fallback: discover file keys if no manifest
  let s3FileKeys: string[] | null = null
  let logId: string

  if (manifest) {
    logId = manifest.log_id
  } else {
    const discovery = await discoverAV2FramesFromS3(baseUrl, onProgress)
    s3FileKeys = discovery.fileKeys
    logId = discovery.logId
    onProgress?.(0.05)
  }

  // 1. Fetch metadata feather files in parallel
  const [extrinsicsBuf, intrinsicsBuf, posesBuf, annotationsBuf] = await Promise.all([
    fetchBuffer(`${baseUrl}calibration/egovehicle_SE3_sensor.feather`),
    fetchBuffer(`${baseUrl}calibration/intrinsics.feather`),
    fetchBuffer(`${baseUrl}city_SE3_egovehicle.feather`),
    fetchBuffer(`${baseUrl}annotations.feather`).catch(() => null), // optional
  ])
  onProgress?.(0.1)

  // 2. Build metadata map (same keys as local mode, but ArrayBuffer values)
  const metadataFiles = new Map<string, File | ArrayBuffer>()
  metadataFiles.set('calibration/egovehicle_SE3_sensor.feather', extrinsicsBuf)
  metadataFiles.set('calibration/intrinsics.feather', intrinsicsBuf)
  metadataFiles.set('city_SE3_egovehicle.feather', posesBuf)
  if (annotationsBuf) {
    metadataFiles.set('annotations.feather', annotationsBuf)
  }

  // For S3 fallback: inject discovered file keys into the metadata map
  // (as dummy values — buildAV2LogDatabase only scans the keys for frame discovery)
  if (s3FileKeys) {
    for (const key of s3FileKeys) {
      if (!metadataFiles.has(key)) {
        metadataFiles.set(key, new ArrayBuffer(0)) // placeholder — only key is scanned
      }
    }
  }
  onProgress?.(0.15)

  // 3. Build database
  //    - manifest mode: uses manifest for frame discovery
  //    - S3 fallback: uses file key scanning (local-mode logic in buildAV2LogDatabase)
  const db = await buildAV2LogDatabase(metadataFiles, logId, manifest ?? undefined)
  onProgress?.(0.2)

  // 4. Build URL-based file entries for workers (deduplicating as we go)
  const seen = new Set<string>()
  const fileEntries: [string, string][] = []

  // LiDAR files
  for (const ts of db.lidarTimestamps) {
    const filename = `sensors/lidar/${ts}.feather`
    if (!seen.has(filename)) {
      seen.add(filename)
      fileEntries.push([filename, `${baseUrl}${filename}`])
    }
  }

  // Camera files
  for (const [, images] of db.cameraFilesByFrame) {
    for (const { filename } of images) {
      if (!seen.has(filename)) {
        seen.add(filename)
        fileEntries.push([filename, `${baseUrl}${filename}`])
      }
    }
  }

  return { db, fileEntries }
}
