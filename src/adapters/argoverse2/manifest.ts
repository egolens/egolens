/** Argoverse 2 compatibility exports projected from the bundled v1 recipe. */

import type { DatasetManifest } from '../../types/dataset'
import { argoverse2Recipe, argoverse2RecipeAdapter } from '../recipes'

const cameras = argoverse2Recipe.scene.sensors.filter((sensor) => sensor.modality === 'camera')
const objectClasses = argoverse2Recipe.scene.taxonomies.find((taxonomy) => taxonomy.role === 'objects')?.classes ?? []

export const AV2_SENSOR_NAME_TO_ID: Record<string, number> = Object.fromEntries(
  cameras.map((sensor) => [sensor.id, sensor.rendererId]),
)

export const AV2_RING_CAMERA_NAMES: readonly string[] = cameras.map((sensor) => sensor.id)

export const argoverse2Manifest: DatasetManifest = argoverse2RecipeAdapter.manifest

export const AV2_CATEGORY_TO_BOX_TYPE: Record<string, number> = Object.fromEntries(
  objectClasses
    .filter((category) => category.rendererId !== 0)
    .map((category) => [category.id, category.rendererId]),
)
