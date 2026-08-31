import { sourceSelectorMatchesV1 } from '../authoring/sourceSelectors'
import type { OperatorRegistry } from '../operators/registry'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import type { NormalizedCapabilityV1 } from './normalizedScene'
import type { ByteSourceV1 } from '../source/ByteSource'
import {
  GraphResourceAccountV1,
  type CoreOperatorExecutionContextV1,
  type GraphExecutionLimitsV1,
  type GraphResourceSnapshotV1,
  type GraphSourceFileV1,
} from './GraphValues'

export interface RecipeInventoryEntryV1 {
  readonly path: string
  readonly size?: number | null
}

export interface GraphExecutionResultV1 {
  readonly outputs: ReadonlyMap<NormalizedCapabilityV1, unknown>
  readonly resources: GraphResourceSnapshotV1
  readonly abortController: AbortController
  dispose(): void
}

const DEFAULT_LIMITS: GraphExecutionLimitsV1 = {
  maxNodes: 10_000,
  maxSourceBytes: 512 * 1024 * 1024,
  maxAllocationBytes: 512 * 1024 * 1024,
}

function linkedSignal(lifecycle: AbortSignal, request?: AbortSignal): AbortSignal {
  if (!request) return lifecycle
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([lifecycle, request]) : lifecycle
}

function numericPathCompare(left: string, right: string): number {
  const number = (path: string) => /(?:^|\/)(\d+)(?:\.[^/.]+)?$/u.exec(path)?.[1]
  const a = number(left)
  const b = number(right)
  if (a && b) {
    const aa = BigInt(a)
    const bb = BigInt(b)
    if (aa !== bb) return aa < bb ? -1 : 1
  }
  return left < right ? -1 : left > right ? 1 : 0
}

function resolve(reference: string, local: ReadonlyMap<string, Readonly<Record<string, unknown>>>, global: ReadonlyMap<string, Readonly<Record<string, unknown>>>): unknown {
  const [root, ...path] = reference.split('.')
  let value: unknown = local.get(root) ?? global.get(root)
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !(key in value)) throw new Error(`GRAPH_REFERENCE_UNRESOLVED: ${reference}`)
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function pipelineOrder(compiled: CompiledRecipeV1): readonly string[] {
  const ids = [...compiled.pipelines.keys()].sort()
  const dependencies = new Map(ids.map((id) => [id, new Set<string>()]))
  for (const [id, pipeline] of compiled.pipelines) {
    for (const node of pipeline.nodes) {
      for (const reference of Object.values(node.inputs ?? {})) {
        const root = reference.split('.')[0]
        if (root !== id && compiled.pipelines.has(root)) dependencies.get(id)!.add(root)
      }
    }
  }
  const result: string[] = []
  const remaining = new Set(ids)
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => [...dependencies.get(id)!].every((dependency) => !remaining.has(dependency))).sort()
    if (ready.length === 0) throw new Error(`GRAPH_PIPELINE_CYCLE: ${[...remaining].sort().join(', ')}`)
    for (const id of ready) {
      result.push(id)
      remaining.delete(id)
    }
  }
  return result
}

export class ExecutableGraphKernelV1 {
  readonly #registry: OperatorRegistry

  constructor(registry: OperatorRegistry) {
    this.#registry = registry
  }

  async execute(input: {
    readonly compiledRecipe: CompiledRecipeV1
    readonly source: ByteSourceV1
    readonly inventory: readonly RecipeInventoryEntryV1[]
    readonly signal?: AbortSignal
    readonly limits?: Partial<GraphExecutionLimitsV1>
  }): Promise<GraphExecutionResultV1> {
    const abortController = new AbortController()
    const signal = linkedSignal(abortController.signal, input.signal)
    const limits = { ...DEFAULT_LIMITS, ...input.limits }
    const resources = new GraphResourceAccountV1(limits)
    const context: CoreOperatorExecutionContextV1 = {
      signal,
      source: input.source,
      resources,
      throwIfAborted() {
        if (signal.aborted) throw new DOMException('Graph execution was aborted.', 'AbortError')
      },
      async read(path) {
        this.throwIfAborted()
        const bytes = await input.source.read(path, { signal })
        resources.sourceBytes(bytes.byteLength)
        this.throwIfAborted()
        return bytes
      },
    }
    const global = new Map<string, Readonly<Record<string, unknown>>>()
    for (const sourceId of Object.keys(input.compiledRecipe.recipe.sources).sort()) {
      context.throwIfAborted()
      const recipeSource = input.compiledRecipe.recipe.sources[sourceId]
      const files: GraphSourceFileV1[] = input.inventory
        .filter((entry) => sourceSelectorMatchesV1(input.compiledRecipe, recipeSource, entry.path))
        .map((entry) => ({ path: entry.path, size: entry.size ?? input.source.byteLength(entry.path) }))
      if (recipeSource.files.order === 'numeric-path') files.sort((left, right) => numericPathCompare(left.path, right.path))
      else if (recipeSource.files.order !== 'none') files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      const minimum = recipeSource.files.minCount ?? 1
      const maximum = recipeSource.files.maxCount ?? Number.POSITIVE_INFINITY
      if (files.length < minimum || files.length > maximum) {
        throw new Error(`SOURCE_FILE_COUNT_INVALID: ${sourceId} matched ${files.length}; expected ${minimum}-${Number.isFinite(maximum) ? maximum : 'unbounded'}`)
      }
      const dependency = input.compiledRecipe.recipe.engine.requiredOperators[recipeSource.reader]
      resources.node()
      global.set(sourceId, await this.#registry.executeCore(recipeSource.reader, dependency, { files }, recipeSource.params ?? {}, context))
    }
    for (const pipelineId of pipelineOrder(input.compiledRecipe)) {
      const pipeline = input.compiledRecipe.pipelines.get(pipelineId)!
      const local = new Map<string, Readonly<Record<string, unknown>>>()
      for (const node of pipeline.nodes) {
        const dependency = input.compiledRecipe.recipe.engine.requiredOperators[node.op]
        const nodeInputs = Object.fromEntries(Object.entries(node.inputs ?? {}).map(([name, reference]) => [name, resolve(reference, local, global)]))
        resources.node()
        local.set(node.id, await this.#registry.executeCore(node.op, dependency, nodeInputs, node.params ?? {}, context))
      }
      global.set(pipelineId, { result: resolve(pipeline.result, local, global) })
    }
    const outputs = new Map<NormalizedCapabilityV1, unknown>()
    for (const [capability, reference] of Object.entries(input.compiledRecipe.recipe.outputs)) {
      outputs.set(capability as NormalizedCapabilityV1, resolve(reference, new Map(), global))
    }
    let disposed = false
    return {
      outputs,
      get resources() { return resources.snapshot() },
      abortController,
      dispose() {
        if (disposed) return
        disposed = true
        abortController.abort()
        for (const value of global.values()) {
          for (const nested of Object.values(value)) {
            if (typeof nested === 'object' && nested !== null && 'cache' in nested && (nested as { cache?: unknown }).cache instanceof Map) {
              (nested as { cache: Map<unknown, unknown> }).cache.clear()
              if ('retainedReleases' in nested && (nested as { retainedReleases?: unknown }).retainedReleases instanceof Map) {
                for (const release of (nested as { retainedReleases: Map<unknown, () => void> }).retainedReleases.values()) release()
                ;(nested as { retainedReleases: Map<unknown, unknown> }).retainedReleases.clear()
              }
            }
          }
        }
      },
    }
  }
}
