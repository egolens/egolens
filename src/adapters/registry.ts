/**
 * Dataset adapter registry.
 *
 * For now, Waymo is the only adapter. The active manifest is a module-level
 * singleton so that any component can import it without prop-drilling.
 *
 * When nuScenes (or other) adapters are added, this module will gain a
 * `detectDataset()` function that inspects the dropped files / URL structure
 * and sets the active manifest accordingly.
 */

import type { DatasetManifest } from '../types/dataset'
import { waymoManifest } from './waymo/manifest'

let activeManifest: DatasetManifest = waymoManifest

/** Get the currently active dataset manifest. */
export function getManifest(): DatasetManifest {
  return activeManifest
}

/** Switch the active manifest (called during dataset load). */
export function setManifest(m: DatasetManifest): void {
  activeManifest = m
}
