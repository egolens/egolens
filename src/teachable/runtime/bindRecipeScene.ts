import type { MetadataBundle } from '../../types/dataset'
import type { SourceInventoryV1 } from '../authoring/SourceInventory'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { ByteSourceV1 } from '../source/ByteSource'
import { ExecutableGraphKernelV1, type RecipeInventoryEntryV1 } from './GraphKernel'
import { assembleGraphSceneV1 } from './GraphSceneAssembler'
import type { GraphSegmentDescriptorV1 } from './GraphValues'
import type { NormalizedSceneV1 } from './normalizedScene'

export interface RecipeExecutionInputV1 {
  readonly compiledRecipe: CompiledRecipeV1
  readonly source: ByteSourceV1
  readonly inventory?: SourceInventoryV1
  /** Transport-neutral inventory supplied by production/local import paths. */
  readonly inventoryEntries?: readonly RecipeInventoryEntryV1[]
  readonly sceneId?: string
  readonly signal?: AbortSignal
}

export interface BoundRecipeSceneV1 {
  readonly scene: NormalizedSceneV1
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly metadata: MetadataBundle
  readonly availableSegments?: readonly GraphSegmentDescriptorV1[]
}

/**
 * Common production, local-import, authoring-preview, and conformance entry
 * point. Every compiled recipe executes through the same graph kernel and
 * normalized-scene assembler; recipe identity and reader/operator profiles do
 * not participate in runtime dispatch.
 */
export async function bindRecipeSceneV1(
  input: RecipeExecutionInputV1,
): Promise<BoundRecipeSceneV1> {
  const inventory = input.inventoryEntries
    ?? input.inventory?.snapshot().entries.map((entry) => ({ path: entry.path, size: entry.size }))
  if (!inventory) throw new Error('RECIPE_SOURCE_INVENTORY_REQUIRED')
  const graph = await new ExecutableGraphKernelV1(bundledPhase2OperatorRegistry).execute({
    compiledRecipe: input.compiledRecipe,
    source: input.source,
    inventory,
    signal: input.signal,
  })
  try {
    return assembleGraphSceneV1({ compiledRecipe: input.compiledRecipe, graph, sceneId: input.sceneId })
  } catch (error) {
    graph.dispose()
    throw error
  }
}
