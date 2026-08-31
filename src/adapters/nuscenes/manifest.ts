/** nuScenes compatibility exports projected from the bundled v1 recipe. */

import type { DatasetManifest } from '../../types/dataset'
import { nuScenesRecipe, nuScenesRecipeAdapter } from '../recipes'

export const NUSCENES_CHANNEL_TO_ID: Record<string, number> = Object.fromEntries(
  nuScenesRecipe.scene.sensors.map((sensor) => [sensor.id, sensor.rendererId]),
)

export const nuScenesManifest: DatasetManifest = nuScenesRecipeAdapter.manifest
