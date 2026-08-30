import type { AV2LogDatabase } from '../../adapters/argoverse2/metadata'
import type { NuScenesDatabase } from '../../adapters/nuscenes/metadata'
import type { WaymoParquetFile } from '../../utils/parquet'
import type { MetadataBundle } from '../../types/dataset'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import type { NormalizedSceneV1 } from './normalizedScene'
import { bindAV2RecipeSceneV1 } from './AV2RecipeScene'
import { bindNuScenesRecipeSceneV1 } from './NuScenesRecipeScene'
import { bindWaymoRecipeSceneV1 } from './WaymoRecipeScene'

export interface BoundRecipeSceneV1 {
  readonly scene: NormalizedSceneV1
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly metadata: MetadataBundle
}

interface CommonBindingV1 {
  readonly compiledRecipe: CompiledRecipeV1
  readonly metadataBundle?: MetadataBundle
}

export type RecipeSceneBindingV1 =
  | (CommonBindingV1 & {
    readonly sourceFamily: 'parquet-components'
    readonly parquetFiles: ReadonlyMap<string, WaymoParquetFile>
  })
  | (CommonBindingV1 & {
    readonly sourceFamily: 'token-tables'
    readonly database: NuScenesDatabase
    readonly sceneToken: string
    readonly files: ReadonlyMap<string, File | string>
  })
  | (CommonBindingV1 & {
    readonly sourceFamily: 'feather-log'
    readonly database: AV2LogDatabase
    readonly files: ReadonlyMap<string, File | string>
  })

function assertReaderFamily(compiledRecipe: CompiledRecipeV1, expectedReader: string): void {
  const readers = new Set(Object.values(compiledRecipe.recipe.sources).map((source) => source.reader))
  if (!readers.has(expectedReader)) {
    throw new Error(`READER_FAMILY_MISMATCH: recipe does not bind ${expectedReader}.`)
  }
}

/**
 * Single production binding seam for bundled and learned recipes.
 *
 * Source families select reusable reader plumbing; dataset identity never
 * selects an alternate runtime or cache owner. The family implementations
 * only construct normalized metadata/relations. ManagedNormalizedScene owns
 * worker scheduling and all heavyweight frame/image buffers after binding.
 */
export async function bindRecipeSceneV1(input: RecipeSceneBindingV1): Promise<BoundRecipeSceneV1> {
  switch (input.sourceFamily) {
    case 'parquet-components':
      assertReaderFamily(input.compiledRecipe, 'parquet.columns')
      return bindWaymoRecipeSceneV1(input)
    case 'token-tables':
      assertReaderFamily(input.compiledRecipe, 'json.records')
      return bindNuScenesRecipeSceneV1(input)
    case 'feather-log':
      assertReaderFamily(input.compiledRecipe, 'feather.columns')
      return bindAV2RecipeSceneV1(input)
  }
}
