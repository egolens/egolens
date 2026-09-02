import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { ExecutableGraphKernelV1 } from '../runtime/GraphKernel'
import { assembleGraphSceneV1 } from '../runtime/GraphSceneAssembler'
import type { ByteSourceV1 } from '../source/ByteSource'
import type { PreparedAuthoringRevisionV1 } from './AuthoringSession'
import type { AuthoringPreviewRuntimeV1 } from './InventoryBindingEvaluator'
import type { SourceInventoryV1 } from './SourceInventory'
import { authoringPreviewStoreV1, type AuthoringTimelinePreviewV1 } from './previewStore'
import { requiredHumanReviewCapabilitiesV1 } from './review'
import type { NormalizedFrameV1 } from '../runtime/normalizedScene'

function sampleFrames(requested: readonly (number | 'first' | 'middle' | 'last')[], frameCount: number): number[] {
  return [...new Set(requested.map((frame) => {
    if (frame === 'first') return 0
    if (frame === 'middle') return Math.floor((frameCount - 1) / 2)
    if (frame === 'last') return frameCount - 1
    return frame
  }))].filter((frame) => frame >= 0 && frame < frameCount).sort((a, b) => a - b)
}

function failure(error: unknown): PreparedAuthoringRevisionV1 {
  const diagnostic: AdapterDiagnostic = {
    stage: 'sample', severity: 'error', code: 'GRAPH_PREVIEW_FAILED',
    hint: error instanceof Error ? error.message : String(error),
  }
  return {
    diagnostics: [diagnostic], capabilities: new Set(), presentedFrames: new Map(),
    validationSummary: { passed: false, stage: 'sample' }, observableEffect: 'Last good preview preserved.',
    commit() {}, dispose() {},
  }
}

function toMicros(timestamp: bigint, unit: 'ns' | 'us' | 'ms' | 's'): bigint {
  if (unit === 'ns') return timestamp / 1_000n
  if (unit === 'us') return timestamp
  if (unit === 'ms') return timestamp * 1_000n
  return timestamp * 1_000_000n
}

/**
 * Timestamps on which a graph output actually carries records, read from the
 * cheap per-output indexes the graph already built (no payload decoding).
 * Returns null when the value kind does not expose an index.
 */
export function graphOutputTimestampsV1(value: unknown): ReadonlySet<bigint> | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { readonly availableTimestamps?: unknown; readonly byTimestamp?: unknown }
  if (candidate.availableTimestamps instanceof Set) return candidate.availableTimestamps as ReadonlySet<bigint>
  if (candidate.byTimestamp instanceof Map) {
    return new Set([...(candidate.byTimestamp as ReadonlyMap<bigint, readonly unknown[]>)]
      .filter(([, records]) => !Array.isArray(records) || records.length > 0)
      .map(([timestamp]) => timestamp))
  }
  return null
}

export const SPARSE_OUTPUT_EXAMPLE_FRAMES = 12

/**
 * When a bound output produced nothing on every sampled frame, tell the author
 * which timeline frames do carry it. Sparse annotation families (segmentation
 * every few frames, keypoints on some frames only) are otherwise invisible to
 * a first/middle/last sample, and the only alternative is an expensive
 * brute-force validation sweep.
 */
export function sparseOutputDiagnosticsV1(input: {
  readonly outputs: ReadonlyMap<string, unknown>
  readonly timelineUnit: 'ns' | 'us' | 'ms' | 's'
  readonly timestampsMicros: readonly bigint[]
  readonly sampledFrames: readonly number[]
  readonly capabilitySamples: Readonly<Record<string, readonly number[]>>
}): AdapterDiagnostic[] {
  const diagnostics: AdapterDiagnostic[] = []
  for (const [capability, samples] of Object.entries(input.capabilitySamples)) {
    if (capability === 'timeline' || capability === 'segmentMetadata' || capability === 'trajectories') continue
    if (samples.length === 0 || samples.some((count) => count > 0)) continue
    const available = graphOutputTimestampsV1(input.outputs.get(capability))
    const sampledList = `[${input.sampledFrames.join(', ')}]`
    if (available === null) {
      diagnostics.push({
        stage: 'sample', severity: 'info', code: 'OUTPUT_ABSENT_ON_SAMPLED_FRAMES', source: capability,
        jsonPointer: '/validation/sampleFrames',
        hint: `${capability} produced no records on sampled frames ${sampledList}; this output kind exposes no timestamp index, so add other frame indices to validation.sampleFrames to locate it.`,
      })
      continue
    }
    const availableMicros = new Set([...available].map((timestamp) => toMicros(timestamp, input.timelineUnit)))
    const presentFrames: number[] = []
    input.timestampsMicros.forEach((timestamp, index) => { if (availableMicros.has(timestamp)) presentFrames.push(index) })
    const examples = presentFrames.slice(0, SPARSE_OUTPUT_EXAMPLE_FRAMES)
    diagnostics.push({
      stage: 'sample', severity: 'info', code: 'OUTPUT_ABSENT_ON_SAMPLED_FRAMES', source: capability,
      jsonPointer: '/validation/sampleFrames',
      hint: presentFrames.length === 0
        ? `${capability} produced no records on sampled frames ${sampledList} and its bound source matches none of the ${input.timestampsMicros.length} timeline frames.`
        : `${capability} produced no records on sampled frames ${sampledList}; its bound source has records on ${presentFrames.length} of ${input.timestampsMicros.length} timeline frames, for example [${examples.join(', ')}]. Add such frame indices to validation.sampleFrames to validate this output.`,
    })
  }
  return diagnostics
}

function frameCount(capability: string, frame: NormalizedFrameV1): number {
  if (capability === 'timeline' || capability === 'segmentMetadata') return 1
  if (capability === 'egoPoses') return frame.worldFromEgo ? 1 : 0
  if (capability === 'pointClouds') return frame.pointClouds.reduce((total, cloud) => total + cloud.pointCount, 0)
  if (capability === 'radarPointClouds') return frame.radarPointClouds.reduce((total, cloud) => total + cloud.pointCount, 0)
  if (capability === 'cameraImages') return frame.cameraImages.length
  if (capability === 'boxes3d') return frame.boxes3d.length
  if (capability === 'boxes2d' || capability === 'boxAssociations') return frame.boxes2d.length
  if (capability === 'lidarSegmentation') return frame.lidarSegmentation.length
  if (capability === 'cameraSegmentation') return frame.cameraSegmentation.length
  if (capability === 'keypoints3d') return frame.keypoints3d.length
  if (capability === 'keypoints2d') return frame.keypoints2d.length
  return 0
}

/** Authoring preview uses the same executable graph and scene assembler as production. */
export class BrowserGraphPreviewRuntimeV1 implements AuthoringPreviewRuntimeV1 {
  async preparePreview(
    compiledRecipe: CompiledRecipeV1,
    source: ByteSourceV1,
    inventory: SourceInventoryV1,
    signal?: AbortSignal,
  ): Promise<PreparedAuthoringRevisionV1> {
    let failedScene: ReturnType<typeof assembleGraphSceneV1>['scene'] | undefined
    try {
      const graph = await new ExecutableGraphKernelV1(bundledPhase2OperatorRegistry).execute({
        compiledRecipe,
        source,
        inventory: inventory.snapshot().entries.map((entry) => ({ path: entry.path, size: entry.size })),
        signal,
      })
      let binding: ReturnType<typeof assembleGraphSceneV1>
      try {
        binding = assembleGraphSceneV1({
          compiledRecipe,
          graph,
        })
        failedScene = binding.scene
      } catch (error) {
        graph.dispose()
        throw error
      }
      const sampled = sampleFrames(compiledRecipe.recipe.validation.sampleFrames, binding.scene.index.timestampsMicros.length)
      if (sampled.length === 0) throw new Error('No requested validation frame exists in the timeline.')
      // Load sampled frames one at a time: a frame read decodes whole Parquet
      // row groups, so concurrent loads multiply the transient peak.
      const frames: NormalizedFrameV1[] = []
      for (const frame of sampled) {
        frames.push(await binding.scene.loadFrame(frame, { capabilities: binding.scene.manifest.capabilities, signal }))
      }
      const capabilitySamples = Object.fromEntries([...binding.scene.manifest.capabilities].map((capability) => [
        capability,
        capability === 'trajectories'
          ? sampled.map(() => binding.scene.relations.trajectories.size)
          : frames.map((frame) => frameCount(capability, frame)),
      ]))
      const preview: AuthoringTimelinePreviewV1 = {
        recipeName: compiledRecipe.recipe.identity.name,
        formatId: compiledRecipe.recipe.scene.formatId,
        frameCount: binding.scene.index.timestampsMicros.length,
        sampledFrames: sampled,
        sampledTimestampsMicros: sampled.map((frame) => binding.scene.index.timestampsMicros[frame].toString()),
        capabilitySamples,
      }
      const presentedFrames = new Map(requiredHumanReviewCapabilitiesV1(binding.scene.manifest.capabilities).map((capability) => [capability, new Set(sampled)]))
      const timeline = graph.outputs.get('timeline') as { readonly unit?: 'ns' | 'us' | 'ms' | 's' } | undefined
      const sparse = sparseOutputDiagnosticsV1({
        outputs: graph.outputs,
        timelineUnit: timeline?.unit ?? 'us',
        timestampsMicros: binding.scene.index.timestampsMicros,
        sampledFrames: sampled,
        capabilitySamples,
      })
      let committed = false
      return {
        diagnostics: [...binding.diagnostics, ...sparse],
        capabilities: binding.scene.manifest.capabilities,
        presentedFrames,
        validationSummary: {
          passed: true, stages: ['schema', 'compile', 'bind', 'sample', 'cross-output'],
          sampleFrames: sampled, frameCount: binding.scene.index.timestampsMicros.length,
        },
        observableEffect: `Rendered ${sampled.length} validation frame${sampled.length === 1 ? '' : 's'} from the executable graph.`,
        commit() {
          authoringPreviewStoreV1.commit(preview)
          committed = true
          failedScene = undefined
        },
        dispose() {
          binding.scene.dispose()
          if (!committed) return
        },
      }
    } catch (error) {
      failedScene?.dispose()
      if (signal?.aborted) throw new DOMException('Graph preview was aborted.', 'AbortError')
      return failure(error)
    }
  }
}
