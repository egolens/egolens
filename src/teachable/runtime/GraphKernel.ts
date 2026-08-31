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
  // Source bytes are cumulative I/O, not retained memory. A complete shipped
  // Waymo case is just under 512 MiB and legitimately rereads bounded Parquet
  // footer/range metadata while traversing the full optional perception
  // surface. Keep a finite session budget while leaving that overhead room.
  maxSourceBytes: 1024 * 1024 * 1024,
  maxAllocationBytes: 512 * 1024 * 1024,
}

function linkedSignal(lifecycle: AbortSignal, request?: AbortSignal): AbortSignal {
  if (!request) return lifecycle
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([lifecycle, request])
  const controller = new AbortController()
  const abort = () => controller.abort()
  lifecycle.addEventListener('abort', abort, { once: true })
  request.addEventListener('abort', abort, { once: true })
  if (lifecycle.aborted || request.aborted) controller.abort()
  return controller.signal
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

function releaseGraphValue(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  if ('retainedReleases' in value && (value as { retainedReleases?: unknown }).retainedReleases instanceof Map) {
    const collection = value as {
      retainedReleases: Map<unknown, () => void>
      cache?: Map<unknown, unknown>
      fileCache?: Map<unknown, unknown>
      projectionCache?: Map<unknown, unknown>
      frameIndexCache?: Map<unknown, unknown>
      frameRowsCache?: Map<unknown, unknown>
    }
    for (const release of collection.retainedReleases.values()) release()
    collection.retainedReleases.clear()
    collection.cache?.clear()
    collection.fileCache?.clear()
    collection.projectionCache?.clear()
    collection.frameIndexCache?.clear()
    collection.frameRowsCache?.clear()
    return
  }
  if (value instanceof Map) {
    if ([...value.values()].every((entry) => typeof entry === 'function')) {
      for (const release of value.values()) (release as () => void)()
    } else {
      for (const entry of value.values()) releaseGraphValue(entry, seen)
    }
    value.clear()
    return
  }
  if (value instanceof Set) {
    value.clear()
    return
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return
  for (const nested of Object.values(value)) releaseGraphValue(nested, seen)
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
      async read(path, requestSignal) {
        this.throwIfAborted()
        const bytes = await input.source.read(path, { signal: linkedSignal(signal, requestSignal) })
        resources.sourceBytes(bytes.byteLength)
        this.throwIfAborted()
        return bytes
      },
      async asyncBuffer(path, requestSignal) {
        this.throwIfAborted()
        const backing = await input.source.asyncBuffer(path)
        const readSignal = linkedSignal(signal, requestSignal)
        return {
          byteLength: backing.byteLength,
          async slice(start, end) {
            if (readSignal.aborted) throw new DOMException('Graph execution was aborted.', 'AbortError')
            // Route every lazy slice back through ByteSourceV1 so remote range
            // verification and request-level cancellation cannot be bypassed by
            // a transport's AsyncBuffer implementation.
            const bytes = await input.source.read(path, { start, end, signal: readSignal })
            resources.sourceBytes(bytes.byteLength)
            if (readSignal.aborted) throw new DOMException('Graph execution was aborted.', 'AbortError')
            return bytes
          },
        }
      },
    }
    const global = new Map<string, Readonly<Record<string, unknown>>>()
    const roots: object[] = []
    const release = () => {
      const seen = new WeakSet<object>()
      for (const value of roots) releaseGraphValue(value, seen)
      roots.length = 0
      global.clear()
    }
    try {
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
        const result = await this.#registry.executeCore(recipeSource.reader, dependency, { files }, recipeSource.params ?? {}, context)
        roots.push(result)
        global.set(sourceId, result)
      }
      for (const pipelineId of pipelineOrder(input.compiledRecipe)) {
        const pipeline = input.compiledRecipe.pipelines.get(pipelineId)!
        const local = new Map<string, Readonly<Record<string, unknown>>>()
        for (const node of pipeline.nodes) {
          const dependency = input.compiledRecipe.recipe.engine.requiredOperators[node.op]
          const nodeInputs = Object.fromEntries(Object.entries(node.inputs ?? {}).map(([name, reference]) => [name, resolve(reference, local, global)]))
          resources.node()
          const result = await this.#registry.executeCore(node.op, dependency, nodeInputs, node.params ?? {}, context)
          roots.push(result)
          local.set(node.id, result)
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
          release()
        },
      }
    } catch (error) {
      abortController.abort()
      release()
      throw error
    }
  }
}
