import argoverse2RecipeJson from './argoverse2.egolens-adapter.json'
import nuScenesRecipeJson from './nuscenes.egolens-adapter.json'
import waymoRecipeJson from './waymo.egolens-adapter.json'
import { bundledPhase2OperatorRegistry } from '../../teachable/operators/bundledPhase2'
import { compileRecipeV1 } from '../../teachable/recipe/compiler'

export const waymoCompiledRecipe = compileRecipeV1(
  waymoRecipeJson,
  bundledPhase2OperatorRegistry,
)

export const nuScenesCompiledRecipe = compileRecipeV1(
  nuScenesRecipeJson,
  bundledPhase2OperatorRegistry,
)

export const argoverse2CompiledRecipe = compileRecipeV1(
  argoverse2RecipeJson,
  bundledPhase2OperatorRegistry,
)

export const bundledCompiledRecipes = [
  waymoCompiledRecipe,
  nuScenesCompiledRecipe,
  argoverse2CompiledRecipe,
] as const
