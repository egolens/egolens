import type { AV2LogDatabase } from '../../adapters/argoverse2/metadata'
import type { NuScenesDatabase } from '../../adapters/nuscenes/metadata'
import type { WaymoParquetFile } from '../../utils/parquet'
import { bindAV2RecipeSceneV1 } from './AV2RecipeScene'
import { bindNuScenesRecipeSceneV1 } from './NuScenesRecipeScene'
import {
  RecipeExecutorV1,
  type BoundRecipeSceneV1,
  type RecipeExecutionInputV1,
  type RecipeProviderResultV1,
  type RecipeRuntimeProviderV1,
} from './RecipeExecutor'
import { bindWaymoRecipeSceneV1 } from './WaymoRecipeScene'

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

class TokenRelationsPreparationV1 implements RecipeRuntimePreparationV1 {
  readonly [preparationBrand] = true as const
  readonly database: NuScenesDatabase
  constructor(database: NuScenesDatabase) {
    this.database = database
  }
}

class FeatherTimelinePreparationV1 implements RecipeRuntimePreparationV1 {
  readonly [preparationBrand] = true as const
  readonly database: AV2LogDatabase
  constructor(database: AV2LogDatabase) {
    this.database = database
  }
}

export function prepareParquetColumnsRuntimeV1(
  parquetFiles: ReadonlyMap<string, WaymoParquetFile>,
): RecipeRuntimePreparationV1 {
  return new ParquetColumnsPreparationV1(parquetFiles)
}

export function prepareTokenRelationsRuntimeV1(
  database: NuScenesDatabase,
): RecipeRuntimePreparationV1 {
  return new TokenRelationsPreparationV1(database)
}

export function prepareFeatherTimelineRuntimeV1(
  database: AV2LogDatabase,
): RecipeRuntimePreparationV1 {
  return new FeatherTimelinePreparationV1(database)
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

function assertTokenPreparation(
  preparation: object | undefined,
  profile: string,
): TokenRelationsPreparationV1 {
  if (!(preparation instanceof TokenRelationsPreparationV1)) {
    throw new Error(`RECIPE_RUNTIME_PREPARATION_INVALID: ${profile}`)
  }
  return preparation
}

function assertFeatherPreparation(
  preparation: object | undefined,
  profile: string,
): FeatherTimelinePreparationV1 {
  if (!(preparation instanceof FeatherTimelinePreparationV1)) {
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

const tokenRelationsProvider: RecipeRuntimeProviderV1 = {
  id: 'core/token-relations@1',
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
  execute(input): RecipeProviderResultV1 {
    const prepared = assertTokenPreparation(input.preparation, this.id)
    const selected = prepared.database.scenes.find((scene) =>
      scene.token === input.sceneId || scene.name === input.sceneId)
      ?? (input.sceneId === undefined && prepared.database.scenes.length === 1
        ? prepared.database.scenes[0]
        : undefined)
    if (!selected) throw new Error(`RECIPE_SCENE_NOT_FOUND: ${input.sceneId ?? '(sceneId required)'}`)
    return bindNuScenesRecipeSceneV1({
      compiledRecipe: input.compiledRecipe,
      database: prepared.database,
      sceneToken: selected.token,
      source: input.source,
      metadataBundle: input.metadataBundle,
    })
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
  execute(input): RecipeProviderResultV1 {
    const prepared = assertFeatherPreparation(input.preparation, this.id)
    return bindAV2RecipeSceneV1({
      compiledRecipe: input.compiledRecipe,
      database: prepared.database,
      source: input.source,
      metadataBundle: input.metadataBundle,
    })
  },
}

export const coreRecipeExecutorV1 = new RecipeExecutorV1([
  parquetRangeImageProvider,
  tokenRelationsProvider,
  featherTimelineProvider,
])

/** Common production, local-import, and conformance binding entry point. */
export async function bindRecipeSceneV1(
  input: RecipeExecutionInputV1 & { readonly preparation: RecipeRuntimePreparationV1 },
): Promise<BoundRecipeSceneV1> {
  return await coreRecipeExecutorV1.execute(input)
}

export type { BoundRecipeSceneV1, RecipeExecutionInputV1 }
