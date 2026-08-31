import type { WaymoParquetFile } from '../../utils/parquet'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import {
  RecipeExecutorV1,
  type BoundRecipeSceneV1,
  type RecipeExecutionInputV1,
  type RecipeProviderResultV1,
  type RecipeRuntimeProviderV1,
} from './RecipeExecutor'
import { bindWaymoRecipeSceneV1 } from './WaymoRecipeScene'
import { ExecutableGraphKernelV1 } from './GraphKernel'
import { assembleGraphSceneV1 } from './GraphSceneAssembler'

const preparationBrand = Symbol('RecipeRuntimePreparationV1')

export interface RecipeRuntimePreparationV1 {
  readonly [preparationBrand]: true
}

class ParquetColumnsPreparationV1 implements RecipeRuntimePreparationV1 {
  readonly [preparationBrand] = true as const
  readonly parquetFiles: ReadonlyMap<string, WaymoParquetFile>
  constructor(parquetFiles: ReadonlyMap<string, WaymoParquetFile>) {
    this.parquetFiles = parquetFiles
  }
}

export function prepareParquetColumnsRuntimeV1(
  parquetFiles: ReadonlyMap<string, WaymoParquetFile>,
): RecipeRuntimePreparationV1 {
  return new ParquetColumnsPreparationV1(parquetFiles)
}

function assertParquetPreparation(
  preparation: object | undefined,
  profile: string,
): ParquetColumnsPreparationV1 {
  if (!(preparation instanceof ParquetColumnsPreparationV1)) {
    throw new Error(`RECIPE_RUNTIME_PREPARATION_INVALID: ${profile}`)
  }
  return preparation
}

const parquetRangeImageProvider: RecipeRuntimeProviderV1 = {
  id: 'core/parquet-range-image@1',
  readers: ['parquet.columns@1'],
  operators: [
    'geometry.normalize_boxes2d@1',
    'geometry.normalize_boxes3d@1',
    'geometry.normalize_keypoints@1',
    'geometry.range_image_to_cartesian@1',
    'geometry.relative_poses@1',
    'image.bind_camera_frame@1',
    'labels.attach_by_point_index@1',
    'labels.decode_camera_mask@1',
    'records.select@1',
    'relations.composite_key_join@1',
    'timeline.sort@1',
    'tracks.derive_trajectories@1',
  ],
  async execute(input): Promise<RecipeProviderResultV1> {
    const prepared = assertParquetPreparation(input.preparation, this.id)
    return await bindWaymoRecipeSceneV1({
      compiledRecipe: input.compiledRecipe,
      parquetFiles: prepared.parquetFiles,
      metadataBundle: input.metadataBundle,
    })
  },
}

const relationalGraphProvider: RecipeRuntimeProviderV1 = {
  id: 'core/relational-graph@1',
  readers: [
    'archive.npz_array@1',
    'binary.interleaved_records@1',
    'binary.pcd_records@1',
    'image.encoded_bytes@1',
    'json.records@1',
  ],
  operators: [
    'geometry.normalize_boxes2d@1',
    'geometry.normalize_boxes3d@1',
    'image.bind_camera_frame@1',
    'labels.attach_by_point_index@1',
    'records.select@1',
    'relations.token_join@1',
    'timeline.join@1',
    'timeline.sort@1',
    'tracks.derive_trajectories@1',
  ],
  async execute(input): Promise<RecipeProviderResultV1> {
    const inventory = input.inventoryEntries
      ?? input.inventory?.snapshot().entries.map((entry) => ({ path: entry.path, size: entry.size }))
    if (!inventory) throw new Error('RECIPE_SOURCE_INVENTORY_REQUIRED: core/relational-graph@1')
    const graph = await new ExecutableGraphKernelV1(bundledPhase2OperatorRegistry).execute({
      compiledRecipe: input.compiledRecipe,
      source: input.source,
      inventory,
    })
    try {
      return assembleGraphSceneV1({ compiledRecipe: input.compiledRecipe, graph, sceneId: input.sceneId })
    } catch (error) {
      graph.dispose()
      throw error
    }
  },
}

const featherTimelineProvider: RecipeRuntimeProviderV1 = {
  id: 'core/feather-timeline@1',
  readers: ['feather.columns@1', 'image.encoded_bytes@1'],
  operators: [
    'geometry.normalize_boxes2d@1',
    'geometry.normalize_boxes3d@1',
    'image.bind_camera_frame@1',
    'records.select@1',
    'timeline.join@1',
    'timeline.sort@1',
    'tracks.derive_trajectories@1',
  ],
  async execute(input): Promise<RecipeProviderResultV1> {
    const inventory = input.inventoryEntries
      ?? input.inventory?.snapshot().entries.map((entry) => ({ path: entry.path, size: entry.size }))
    if (!inventory) throw new Error('RECIPE_SOURCE_INVENTORY_REQUIRED: core/feather-timeline@1')
    const graph = await new ExecutableGraphKernelV1(bundledPhase2OperatorRegistry).execute({
      compiledRecipe: input.compiledRecipe,
      source: input.source,
      inventory,
    })
    try {
      return assembleGraphSceneV1({ compiledRecipe: input.compiledRecipe, graph, sceneId: input.sceneId })
    } catch (error) {
      graph.dispose()
      throw error
    }
  },
}

const jsonTimelineProvider: RecipeRuntimeProviderV1 = {
  id: 'core/executable-graph@1',
  readers: ['json.records@1'],
  operators: ['timeline.sort@1'],
  async execute(input): Promise<RecipeProviderResultV1> {
    const inventory = input.inventoryEntries
      ?? input.inventory?.snapshot().entries.map((entry) => ({ path: entry.path, size: entry.size }))
    if (!inventory) throw new Error('RECIPE_SOURCE_INVENTORY_REQUIRED: core/executable-graph@1')
    const graph = await new ExecutableGraphKernelV1(bundledPhase2OperatorRegistry).execute({
      compiledRecipe: input.compiledRecipe, source: input.source, inventory,
    })
    try {
      return assembleGraphSceneV1({ compiledRecipe: input.compiledRecipe, graph, sceneId: input.sceneId })
    } catch (error) {
      graph.dispose()
      throw error
    }
  },
}

export const coreRecipeExecutorV1 = new RecipeExecutorV1([
  parquetRangeImageProvider,
  relationalGraphProvider,
  featherTimelineProvider,
  jsonTimelineProvider,
])

/** Common production, local-import, and conformance binding entry point. */
export async function bindRecipeSceneV1(
  input: RecipeExecutionInputV1,
): Promise<BoundRecipeSceneV1> {
  return await coreRecipeExecutorV1.execute(input)
}

export type { BoundRecipeSceneV1, RecipeExecutionInputV1 }
