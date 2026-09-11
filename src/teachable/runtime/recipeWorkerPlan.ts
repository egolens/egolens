import type { CompiledRecipeV1 } from '../recipe/compiler'
import type { ByteSourceV1 } from '../source/ByteSource'
import type { CoreOperatorExecutionContextV1 } from './GraphValues'
import type { GraphExecutionResultV1, RecipeInventoryEntryV1 } from './GraphKernel'

export interface RecipeWorkerPlanV1 {
  readonly compiledRecipe: CompiledRecipeV1
  readonly graph: GraphExecutionResultV1
  readonly source: ByteSourceV1
  readonly inventory: readonly RecipeInventoryEntryV1[]
  readonly sceneId?: string
}

const CACHE_KEYS = new Set(['cache', 'fileCache', 'projectionCache', 'frameIndexCache', 'frameRowsCache', 'retainedReleases'])
/** Copy the prepared graph, preserving shared references but excluding runtime owners. */
export function mapRecipeWorkerGraphV1(value: unknown, context?: CoreOperatorExecutionContextV1, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') throw new Error('RECIPE_WORKER_PLAN_NOT_CLONEABLE')
    return value
  }
  if ('throwIfAborted' in value || '__recipeWorkerContext' in value) return context ?? { __recipeWorkerContext: true }
  if (seen.has(value)) return seen.get(value)
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
  if (value instanceof Promise) throw new Error('RECIPE_WORKER_PLAN_HAS_PROMISE')
  if (value instanceof Map) {
    const result = new Map(); seen.set(value, result)
    for (const [key, entry] of value) result.set(mapRecipeWorkerGraphV1(key, context, seen), mapRecipeWorkerGraphV1(entry, context, seen))
    return result
  }
  if (value instanceof Set) return new Set([...value].map(entry => mapRecipeWorkerGraphV1(entry, context, seen)))
  if (Array.isArray(value)) {
    const result: unknown[] = []; seen.set(value, result)
    for (const entry of value) result.push(mapRecipeWorkerGraphV1(entry, context, seen))
    return result
  }
  const result: Record<string, unknown> = {}; seen.set(value, result)
  const collection = 'kind' in value && typeof value.kind === 'string' && value.kind.endsWith('-collection')
  for (const [key, entry] of Object.entries(value)) result[key] = collection && CACHE_KEYS.has(key) ? new Map() : mapRecipeWorkerGraphV1(entry, context, seen)
  return result
}

/** Transfer only cloned frame buffers; graph metadata and caches keep their originals. */
export function frameTransferBuffersV1(value: unknown, buffers = new Set<ArrayBuffer>(), seen = new Set<object>()): ArrayBuffer[] {
  if (value === null || typeof value !== 'object' || seen.has(value)) return [...buffers]
  seen.add(value)
  if (value instanceof ArrayBuffer) buffers.add(value)
  else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer)
  else for (const entry of value instanceof Map || value instanceof Set ? value.values() : Object.values(value)) frameTransferBuffersV1(entry, buffers, seen)
  return [...buffers]
}
