/**
 * Argoverse 2 Remote Loading — URL-based data loading for AV2 logs.
 *
 * Entry point: `loadAV2FromUrl(baseUrl)` fetches manifest.json + metadata
 * feather files, builds an AV2LogDatabase, and constructs URL-based
 * fileEntries for worker pools.
 *
 * manifest.json is required for URL mode — provides frame timestamps and
 * camera-to-lidar matching (replaces local file-key scanning).
 *
 * Generate with: python scripts/generate_av2_manifest.py /path/to/log
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
// Manifest fetch
// ---------------------------------------------------------------------------

/**
 * Fetch and validate manifest.json from a base URL.
 * Also acts as a CORS probe — the first real fetch catches CORS errors.
 */
export async function fetchAV2Manifest(baseUrl: string): Promise<AV2Manifest> {
  const url = `${baseUrl}manifest.json`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      if (res.status === 404) {
        throw new DataLoadError(
          'manifest.json not found at this URL.\n' +
          'Generate with: python scripts/generate_av2_manifest.py /path/to/log',
          'MANIFEST', url,
        )
      }
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
 * 1. Fetches metadata feather files in parallel
 * 2. Builds AV2LogDatabase using manifest for frame discovery
 * 3. Constructs URL-based file entries for workers
 *
 * @param baseUrl - Base URL with trailing slash (e.g. "https://s3.../log_id/")
 * @param manifest - Pre-fetched manifest.json
 * @param onProgress - Optional progress callback (0-1)
 */
export async function loadAV2FromUrl(
  baseUrl: string,
  manifest: AV2Manifest,
  onProgress?: (progress: number) => void,
): Promise<AV2UrlLoadResult> {
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
  onProgress?.(0.15)

  // 3. Build database using manifest for frame discovery
  const db = await buildAV2LogDatabase(metadataFiles, manifest.log_id, manifest)
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
