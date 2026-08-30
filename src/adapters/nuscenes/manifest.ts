/**
 * nuScenes compatibility data projected from its bundled v1 recipe.
 */

import { nuScenesCompiledRecipe } from '../recipes/bundled'

export const nuScenesRecipe = nuScenesCompiledRecipe.recipe
export const nuScenesManifest = nuScenesCompiledRecipe.compatibilityManifest

/** Dataset-native sensor channel → renderer ID, derived from recipe sensors. */
export const NUSCENES_CHANNEL_TO_ID: Record<string, number> = Object.fromEntries(
  nuScenesRecipe.scene.sensors.map((sensor) => [sensor.id, sensor.rendererId]),
)
