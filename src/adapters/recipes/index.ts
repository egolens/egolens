import { bundledOperatorRegistry } from '../../teachable/operators/bundledRegistry'
import { RecipeBackedDatasetAdapter } from '../../teachable/runtime/RecipeBackedDatasetAdapter'
import { assertValidRecipeV1 } from '../../teachable/schema/validateSchema'
import argoverse2Json from './argoverse2.egolens-adapter.json'
import nuScenesJson from './nuscenes.egolens-adapter.json'
import waymoJson from './waymo.egolens-adapter.json'

export const waymoRecipe = assertValidRecipeV1(waymoJson)
export const nuScenesRecipe = assertValidRecipeV1(nuScenesJson)
export const argoverse2Recipe = assertValidRecipeV1(argoverse2Json)

export const waymoRecipeAdapter = new RecipeBackedDatasetAdapter(waymoRecipe, bundledOperatorRegistry)
export const nuScenesRecipeAdapter = new RecipeBackedDatasetAdapter(nuScenesRecipe, bundledOperatorRegistry)
export const argoverse2RecipeAdapter = new RecipeBackedDatasetAdapter(argoverse2Recipe, bundledOperatorRegistry)

export const bundledRecipeAdapters = [
  waymoRecipeAdapter,
  nuScenesRecipeAdapter,
  argoverse2RecipeAdapter,
] as const
