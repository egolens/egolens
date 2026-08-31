/** Waymo compatibility manifest projected from the bundled v1 recipe. */

import type { DatasetManifest } from '../../types/dataset'
import { waymoRecipeAdapter } from '../recipes'

export const waymoManifest: DatasetManifest = waymoRecipeAdapter.manifest
