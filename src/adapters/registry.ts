/**
 * Dataset adapter registry.
 *
 * Maintains a list of known dataset manifests and provides:
 * - `detectDataset()`: inspects directory entry names to identify the dataset
 * - `getAdapter()` / `setAdapter()`: active strategy
 * - `getManifest()` / `setManifest()`: compatibility accessors during migration
 * - `getAllKnownComponents()`: union of all manifests' knownComponents (for folder scanning)
 */

import type { DatasetManifest } from '../types/dataset'
import { waymoManifest } from './waymo/manifest'
import { argoverse2Manifest } from './argoverse2/manifest'
import { LegacyDatasetAdapter } from './legacy'
import type { DatasetAdapter } from './types'
import { RecipeBackedDatasetAdapter } from '../teachable/runtime/RecipeBackedDatasetAdapter'
import { bundledPhase2OperatorRegistry } from '../teachable/operators/bundledPhase2'
import { nuScenesCompiledRecipe } from './recipes/bundled'

// ---------------------------------------------------------------------------
// Registry — all known dataset manifests
// ---------------------------------------------------------------------------

/** Ordered list of adapter strategies. First match wins during detection. */
const adapters: DatasetAdapter[] = [
  new LegacyDatasetAdapter(waymoManifest),
  new RecipeBackedDatasetAdapter(
    nuScenesCompiledRecipe.recipe,
    bundledPhase2OperatorRegistry,
    nuScenesCompiledRecipe,
  ),
  new LegacyDatasetAdapter(argoverse2Manifest),
]

// ---------------------------------------------------------------------------
// Active manifest singleton
// ---------------------------------------------------------------------------

let activeAdapter: DatasetAdapter = adapters[0]

/** Get the currently active adapter strategy. */
export function getAdapter(): DatasetAdapter {
  return activeAdapter
}

/** Switch the active adapter strategy. */
export function setAdapter(adapter: DatasetAdapter): void {
  activeAdapter = adapter
}

/** Resolve a registered adapter by stable dataset id. */
export function getAdapterById(id: string): DatasetAdapter | null {
  return adapters.find((adapter) => adapter.id === id) ?? null
}

/** Get the currently active dataset manifest. */
export function getManifest(): DatasetManifest {
  return activeAdapter.manifest
}

/** Switch the active manifest (called during dataset load). */
export function setManifest(m: DatasetManifest): void {
  activeAdapter = getAdapterById(m.id) ?? new LegacyDatasetAdapter(m)
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
  return detectDatasetAdapter(entryNames)?.manifest ?? null
}

/** Detect the adapter strategy without reading file bodies. */
export function detectDatasetAdapter(entryNames: readonly string[]): DatasetAdapter | null {
  const evidence = { entryNames }
  return adapters.find((adapter) => adapter.matches(evidence)) ?? null
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
    for (const adapter of adapters) {
      for (const c of adapter.manifest.knownComponents) {
        _allKnownComponents.add(c)
      }
    }
  }
  return _allKnownComponents
}
