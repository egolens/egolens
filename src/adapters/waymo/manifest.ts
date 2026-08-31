/**
 * Waymo's compatibility manifest is projected from the bundled v1 recipe.
 * The JSON artifact is the single source of truth for declarative semantics.
 */

import { waymoCompiledRecipe } from '../recipes/bundled'

export const waymoRecipe = waymoCompiledRecipe.recipe
export const waymoManifest = waymoCompiledRecipe.rendererManifest
