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
      const frames = await Promise.all(sampled.map(async (frame) => await binding.scene.loadFrame(
        frame, { capabilities: binding.scene.manifest.capabilities, signal },
      )))
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
      let committed = false
      return {
        diagnostics: binding.diagnostics,
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
