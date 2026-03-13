/**
 * Dataset adapter registry.
 *
 * Maintains a list of known dataset manifests and provides:
 * - `detectDataset()`: inspects directory entry names to identify the dataset
 * - `getManifest()` / `setManifest()`: active manifest singleton
 * - `getAllKnownComponents()`: union of all manifests' knownComponents (for folder scanning)
 */

import type { DatasetManifest } from '../types/dataset'
import { waymoManifest } from './waymo/manifest'
import { nuScenesManifest } from './nuscenes/manifest'

// ---------------------------------------------------------------------------
// Registry — all known dataset manifests
// ---------------------------------------------------------------------------

/** Ordered list of all registered manifests. First match wins in detectDataset(). */
const manifests: DatasetManifest[] = [
  waymoManifest,
  nuScenesManifest,
]

// ---------------------------------------------------------------------------
// Active manifest singleton
// ---------------------------------------------------------------------------

let activeManifest: DatasetManifest = waymoManifest

/** Get the currently active dataset manifest. */
export function getManifest(): DatasetManifest {
  return activeManifest
}

/** Switch the active manifest (called during dataset load). */
export function setManifest(m: DatasetManifest): void {
  activeManifest = m
}

// ---------------------------------------------------------------------------
// Dataset detection
// ---------------------------------------------------------------------------

/**
 * Detect which dataset a set of directory entries belongs to.
 *
 * Checks each registered manifest's `requiredComponents` against the provided
 * entry names. Returns the first manifest where ALL required components are
 * present, or `null` if no match.
 *
 * @param entryNames - top-level directory names found in the scanned folder
 *                     (e.g. ['vehicle_pose', 'lidar', 'camera_image', 'stats'])
 */
export function detectDataset(entryNames: string[]): DatasetManifest | null {
  const entrySet = new Set(entryNames)
  for (const manifest of manifests) {
    const allRequired = manifest.requiredComponents.every((c) => entrySet.has(c))
    if (allRequired) return manifest
  }
  return null
}

// ---------------------------------------------------------------------------
// Aggregated component set (for folder scanning)
// ---------------------------------------------------------------------------

/** Cached union of all knownComponents across all registered manifests. */
let _allKnownComponents: Set<string> | null = null

/**
 * Return the union of `knownComponents` from all registered manifests.
 * Used by `folderScan.ts` to decide which subdirectories to accept,
 * replacing the old hard-coded `KNOWN_COMPONENTS` set.
 */
export function getAllKnownComponents(): Set<string> {
  if (!_allKnownComponents) {
    _allKnownComponents = new Set<string>()
    for (const m of manifests) {
      for (const c of m.knownComponents) {
        _allKnownComponents.add(c)
      }
    }
  }
  return _allKnownComponents
}
