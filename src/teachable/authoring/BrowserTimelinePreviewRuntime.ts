import { decodeJsonRecordsV1 } from '../operators/jsonRecords'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import type { JsonObject } from '../recipe/types'
import type { ByteSourceV1 } from '../source/ByteSource'
import type { PreparedAuthoringRevisionV1 } from './AuthoringSession'
import type { AuthoringPreviewRuntimeV1 } from './InventoryBindingEvaluator'
import type { SourceInventoryV1 } from './SourceInventory'
import { authoringPreviewStoreV1, type AuthoringTimelinePreviewV1 } from './previewStore'
import { sourceSelectorMatchesV1 } from './sourceSelectors'

const MAX_TIMELINE_JSON_BYTES = 16 * 1024 * 1024
const MAX_TIMELINE_RECORDS = 1_000_000

function capabilityGap(hint: string, jsonPointer?: string): PreparedAuthoringRevisionV1 {
  const diagnostic: AdapterDiagnostic = { stage: 'sample', severity: 'error', code: 'CAPABILITY_GAP', hint, jsonPointer }
  return {
    diagnostics: [diagnostic],
    capabilities: new Set(),
    presentedFrames: new Map(),
    validationSummary: { passed: false, stage: 'sample' },
    observableEffect: 'Last good preview preserved.',
    commit() {},
    dispose() {},
  }
}

function timestampMicros(value: unknown, unit: 'ns' | 'us' | 'ms' | 's'): bigint {
  let numeric: bigint
  if (typeof value === 'bigint') numeric = value
  else if (typeof value === 'number' && Number.isSafeInteger(value)) numeric = BigInt(value)
  else if (typeof value === 'string' && /^-?\d+$/u.test(value)) numeric = BigInt(value)
  else throw new Error(`Timeline timestamp ${String(value)} is not an integer.`)
  if (unit === 'ns') return numeric / 1000n
  if (unit === 'us') return numeric
  if (unit === 'ms') return numeric * 1000n
  return numeric * 1_000_000n
}

function sampleFrames(requested: readonly (number | 'first' | 'middle' | 'last')[], frameCount: number): number[] {
  const resolved = requested.map((frame) => {
    if (frame === 'first') return 0
    if (frame === 'middle') return Math.floor((frameCount - 1) / 2)
    if (frame === 'last') return frameCount - 1
    return frame
  })
  return [...new Set(resolved)].filter((frame) => frame >= 0 && frame < frameCount).sort((a, b) => a - b)
}

/** Real bounded sample path for portable JSON timeline recipes. */
export class BrowserTimelinePreviewRuntimeV1 implements AuthoringPreviewRuntimeV1 {
  async preparePreview(
    compiledRecipe: CompiledRecipeV1,
    byteSource: ByteSourceV1,
    inventory: SourceInventoryV1,
    signal?: AbortSignal,
  ): Promise<PreparedAuthoringRevisionV1> {
    const capabilities = [...compiledRecipe.capabilities]
    if (capabilities.some((capability) => capability !== 'timeline')) {
      return capabilityGap(
        `The browser authoring preview currently needs an additional registered runtime for: ${capabilities.filter((capability) => capability !== 'timeline').join(', ')}.`,
        '/outputs',
      )
    }
    const pipeline = compiledRecipe.pipelines.get('timeline')
    const node = pipeline?.nodes[0]
    if (!pipeline || pipeline.nodes.length !== 1 || node?.op !== 'timeline.sort') {
      return capabilityGap('Timeline preview currently requires one registered timeline.sort node.', '/pipelines/timeline')
    }
    const inputReference = Object.values(node.inputs ?? {})[0]
    const sourceId = inputReference?.split('.')[0]
    const source = sourceId ? compiledRecipe.recipe.sources[sourceId] : undefined
    if (!source || source.reader !== 'json.records') {
      return capabilityGap('Timeline preview currently requires a json.records source.', '/pipelines/timeline/nodes')
    }
    const selected = inventory.snapshot().entries
      .filter((entry) => byteSource.has(entry.path) && sourceSelectorMatchesV1(compiledRecipe, source, entry.path))
    if (selected.length !== 1) return capabilityGap(`Timeline source must resolve to exactly one JSON file; got ${selected.length}.`, `/sources/${sourceId}/files`)
    const entry = selected[0]
    if (entry.size > MAX_TIMELINE_JSON_BYTES) throw new Error(`Timeline JSON exceeds ${MAX_TIMELINE_JSON_BYTES} bytes.`)
    if (signal?.aborted) throw new DOMException('Timeline preview was aborted.', 'AbortError')
    const bytes = await byteSource.read(entry.path, { signal })
    const rows = decodeJsonRecordsV1<Record<string, unknown>>(new TextDecoder().decode(bytes), {
      maxInputBytes: MAX_TIMELINE_JSON_BYTES,
      maxRecords: MAX_TIMELINE_RECORDS,
      maxDepth: 16,
      maxRecordKeys: 256,
    })
    if (rows.length === 0) throw new Error('TIMELINE_BINDING_EMPTY: timeline source contains no records.')
    const timestampField = (node.params as JsonObject | undefined)?.timestampField
    if (typeof timestampField !== 'string') throw new Error('timeline.sort requires timestampField.')
    const timestamps = rows
      .map((row) => timestampMicros(row[timestampField], compiledRecipe.recipe.scene.timeline.timestampUnit))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    for (let index = 1; index < timestamps.length; index += 1) {
      if (timestamps[index] <= timestamps[index - 1]) throw new Error('TIMESTAMPS_NOT_STRICTLY_INCREASING: duplicate or decreasing timestamp.')
    }
    const sampled = sampleFrames(compiledRecipe.recipe.validation.sampleFrames, timestamps.length)
    if (sampled.length === 0) throw new Error('No requested validation frame exists in the timeline.')
    const preview: AuthoringTimelinePreviewV1 = {
      recipeName: compiledRecipe.recipe.identity.name,
      formatId: compiledRecipe.recipe.scene.formatId,
      frameCount: timestamps.length,
      sampledFrames: sampled,
      sampledTimestampsMicros: sampled.map((frame) => timestamps[frame].toString()),
    }
    let committed = false
    return {
      diagnostics: [],
      capabilities: new Set(['timeline']),
      presentedFrames: new Map([['timeline', new Set(sampled)]]),
      validationSummary: {
        passed: true,
        stages: ['schema', 'compile', 'bind', 'sample', 'cross-output'],
        sampleFrames: sampled,
        frameCount: timestamps.length,
      },
      observableEffect: `Rendered a ${timestamps.length}-frame timeline preview.`,
      commit() {
        authoringPreviewStoreV1.commit(preview)
        committed = true
      },
      dispose() {
        if (!committed) return
      },
    }
  }
}
