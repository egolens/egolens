import type { MetadataBundle } from '../../types/dataset'
import type { SourceInventoryV1 } from '../authoring/SourceInventory'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { ByteSourceV1 } from '../source/ByteSource'
import type { NormalizedSceneV1 } from './normalizedScene'
import type { RecipeInventoryEntryV1 } from './GraphKernel'

export interface RecipeExecutionInputV1 {
  readonly compiledRecipe: CompiledRecipeV1
  readonly source: ByteSourceV1
  readonly inventory?: SourceInventoryV1
  /** Transport-neutral inventory supplied by production/local import paths. */
  readonly inventoryEntries?: readonly RecipeInventoryEntryV1[]
  readonly sceneId?: string
  readonly preparation?: object
  readonly metadataBundle?: MetadataBundle
}

export interface RecipeProviderResultV1 {
  readonly scene: NormalizedSceneV1
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly metadata: MetadataBundle
}

export interface BoundRecipeSceneV1 extends RecipeProviderResultV1 {
  /** Public operator-profile ID selected from the compiled graph. */
  readonly executionProfile: string
}

export interface RecipeRuntimeProviderV1 {
  readonly id: string
  /** Exact set of versioned public reader IDs supported by this profile. */
  readonly readers: readonly string[]
  /** Exact set of versioned public pipeline operator IDs supported by this profile. */
  readonly operators: readonly string[]
  execute(input: RecipeExecutionInputV1): Promise<RecipeProviderResultV1> | RecipeProviderResultV1
}

export interface RecipeOperatorGraphV1 {
  readonly readers: ReadonlySet<string>
  readonly operators: ReadonlySet<string>
}

/** Derive dispatch inputs exclusively from versioned, compiler-validated IDs. */
export function recipeOperatorGraphV1(compiledRecipe: CompiledRecipeV1): RecipeOperatorGraphV1 {
  const requirements = compiledRecipe.recipe.engine.requiredOperators
  const readers = new Set<string>()
  for (const source of Object.values(compiledRecipe.recipe.sources)) {
    const dependency = requirements[source.reader]
    if (!dependency) throw new Error(`RECIPE_READER_REQUIREMENT_MISSING: ${source.reader}`)
    readers.add(`${source.reader}@${dependency.major}`)
  }
  const operators = new Set<string>()
  for (const pipeline of compiledRecipe.pipelines.values()) {
    for (const node of pipeline.nodes) operators.add(`${node.op}@${node.version}`)
  }
  return { readers, operators }
}

function sameIds(actual: ReadonlySet<string>, supported: readonly string[]): boolean {
  const uniqueSupported = new Set(supported)
  return actual.size === uniqueSupported.size && [...actual].every((id) => uniqueSupported.has(id))
}

function matchesProvider(graph: RecipeOperatorGraphV1, provider: RecipeRuntimeProviderV1): boolean {
  return sameIds(graph.readers, provider.readers) && sameIds(graph.operators, provider.operators)
}

/**
 * Shared recipe-to-NormalizedScene executor.
 *
 * Provider selection cannot observe recipe identity, format ID, scene ID,
 * logical filenames, prepared state, inventory transport, or source transport.
 */
export class RecipeExecutorV1 {
  readonly #providers: readonly RecipeRuntimeProviderV1[]

  constructor(providers: Iterable<RecipeRuntimeProviderV1>) {
    const byId = new Map<string, RecipeRuntimeProviderV1>()
    for (const provider of providers) {
      if (byId.has(provider.id)) throw new Error(`RECIPE_RUNTIME_PROVIDER_DUPLICATE: ${provider.id}`)
      if (provider.readers.length === 0 && provider.operators.length === 0) {
        throw new Error(`RECIPE_RUNTIME_PROVIDER_UNBOUNDED: ${provider.id}`)
      }
      byId.set(provider.id, Object.freeze(provider))
    }
    this.#providers = Object.freeze([...byId.values()])
  }

  async execute(input: RecipeExecutionInputV1): Promise<BoundRecipeSceneV1> {
    const graph = recipeOperatorGraphV1(input.compiledRecipe)
    const matches = this.#providers.filter((provider) => matchesProvider(graph, provider))
    if (matches.length === 0) {
      throw new Error(
        `RECIPE_RUNTIME_MISSING: no provider matches readers [${[...graph.readers].sort().join(', ')}] `
        + `and operators [${[...graph.operators].sort().join(', ')}].`,
      )
    }
    if (matches.length > 1) {
      throw new Error(`RECIPE_RUNTIME_AMBIGUOUS: ${matches.map((provider) => provider.id).sort().join(', ')}`)
    }
    const provider = matches[0]
    const result = await provider.execute(input)
    return { ...result, executionProfile: provider.id }
  }
}
