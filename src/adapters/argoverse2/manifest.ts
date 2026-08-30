/**
 * Argoverse 2 compatibility data projected from its bundled v1 recipe.
 */

import { argoverse2CompiledRecipe } from '../recipes/bundled'

export const argoverse2Recipe = argoverse2CompiledRecipe.recipe
export const argoverse2Manifest = argoverse2CompiledRecipe.rendererManifest

const cameraSensors = argoverse2Recipe.scene.sensors.filter(
  (sensor) => sensor.modality === 'camera',
)

/** Dataset-native sensor name → renderer ID, derived from recipe sensors. */
export const AV2_SENSOR_NAME_TO_ID: Record<string, number> = Object.fromEntries(
  cameraSensors.map((sensor) => [sensor.id, sensor.rendererId]),
)

/** Ring camera names remain in the recipe's semantic panel order. */
export const AV2_RING_CAMERA_NAMES: readonly string[] = cameraSensors.map(
  (sensor) => sensor.id,
)

/** Dataset category → renderer box type, derived from the object taxonomy. */
export const AV2_CATEGORY_TO_BOX_TYPE: Record<string, number> = Object.fromEntries(
  (argoverse2Recipe.scene.taxonomies.find((taxonomy) => taxonomy.role === 'objects')?.classes ?? [])
    .filter((entry) => entry.rendererId !== 0)
    .map((entry) => [entry.id, entry.rendererId]),
)
