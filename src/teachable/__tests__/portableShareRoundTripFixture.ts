import { expect } from 'vitest'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import { recipeHashV1 } from '../authoring/hashes'
import {
  encodeInlineShareUrlV1,
  encodeReferencedShareUrlV1,
  shareDescriptorHashV1,
  validateShareDescriptorV1,
} from '../share/ShareDescriptor'
import { sharedVerifiedRecipeCacheV1 } from '../share/RecipeTransport'
import {
  createActiveConformanceScene,
  currentPortableShareDescriptorV1,
  getActiveConformanceDescriptor,
  useSceneStore,
} from '../../stores/useSceneStore'
import { remoteTransportFixtureV1 } from './remoteTransportFixture'
import type { ByteSourceBackingV1 } from '../source/ByteSource'
import { installPerformanceProbe, performanceSnapshotV1 } from '../runtime/performanceProbe'

/** Counted empty-profile browser/store round trip shared by all shipped recipes. */
export async function expectPortableShareRoundTripV1(input: {
  readonly entries: Iterable<readonly [string, ByteSourceBackingV1]>
  readonly compiledRecipe: CompiledRecipeV1
  readonly sceneId: string
  readonly referenced?: boolean
  readonly cameraPresentation?: boolean
}): Promise<void> {
  const hosted = await remoteTransportFixtureV1(input.entries)
  sharedVerifiedRecipeCacheV1.clear()
  useSceneStore.getState().actions.reset()
  try {
    installPerformanceProbe(true)
    const markCountBeforeLoad = performanceSnapshotV1().marks.length
    const recipeHash = await recipeHashV1(input.compiledRecipe.recipe)
    const recipeUrl = hosted.hostJson('recipe.json', input.compiledRecipe.recipe)
    const pointSensors = input.compiledRecipe.normalizedManifest.sensors
      .filter((sensor) => sensor.modality !== 'camera')
      .map((sensor) => sensor.id)
      .sort()
    const camera = input.cameraPresentation !== false
      && input.compiledRecipe.normalizedManifest.capabilities.has('cameraImages')
      ? input.compiledRecipe.normalizedManifest.sensors.find((sensor) => sensor.modality === 'camera')
      : undefined
    const descriptor = validateShareDescriptorV1({
      schema: 'egolens-share-v1',
      source: {
        rootUrl: hosted.remote.rootUrl,
        catalogUrl: hosted.catalogUrl,
        catalogHash: hosted.catalogHash,
        sourceManifestHash: hosted.sourceManifestHash,
      },
      recipe: { url: recipeUrl, recipeHash },
      view: { sceneId: input.sceneId, frameIndex: 0 },
      presentation: {
        cameraStrip: camera !== undefined,
        coordinateMode: 'world',
        visibleSensorIds: pointSensors,
        activeCameraId: camera?.id ?? null,
        colormap: input.compiledRecipe.normalizedManifest.pointLayout.colorModes[0] ?? 'distance',
        boxMode: 'off',
        trailLength: 7,
        pointSize: 0.12,
        pointOpacity: 0.7,
        overlays: {
          lidarProjection: false,
          keypoints3d: false,
          keypoints2d: false,
          cameraSegmentation: false,
        },
        playbackSpeed: 2,
        followCamera: true,
        cameraPose: { position: [8, -3, 5], target: [1, 2, 0], azimuth: 0.75, distance: 9.5 },
        theme: 'light',
        accent: '0A1B2C',
      },
    })
    const shareUrl = input.referenced
      ? encodeReferencedShareUrlV1(
          hosted.url('viewer'),
          hosted.hostJson('share.json', descriptor),
          shareDescriptorHashV1(descriptor),
        )
      : encodeInlineShareUrlV1(hosted.url('viewer'), descriptor)
    const resolved = await useSceneStore.getState().actions.loadPortableShare(shareUrl, true)
    expect(resolved, useSceneStore.getState().error ?? 'portable share failed').not.toBeNull()

    const loadMarks = performanceSnapshotV1().marks.slice(markCountBeforeLoad)
    expect(loadMarks.some((mark) => mark.name.startsWith('egolens:scene-load-start:'))).toBe(true)
    expect(loadMarks.some((mark) => mark.name.startsWith('egolens:dataset-ready:'))).toBe(true)

    const state = useSceneStore.getState()
    expect(state.status).toBe('ready')
    expect(state.currentSegment).toBe(input.sceneId)
    expect(state.currentFrameIndex).toBe(0)
    expect(state.currentFrame).not.toBeNull()
    expect(state.isPlaying).toBe(false)
    expect(state.cameraStripVisible).toBe(camera !== undefined)
    expect(state.worldMode).toBe(true)
    expect(state.trailLength).toBe(7)
    expect(state.pointSize).toBe(0.12)
    expect(state.pointOpacity).toBe(0.7)
    expect(state.playbackSpeed).toBe(2)
    expect(state.followCam).toBe(true)
    expect(state.theme).toBe('light')
    expect(state.visibleSensors).toEqual(new Set(input.compiledRecipe.normalizedManifest.sensors
      .filter((sensor) => sensor.modality !== 'camera')
      .map((sensor) => sensor.rendererId)))
    expect(state.activeCam).toBe(camera?.rendererId ?? null)
    expect(hosted.requests.map((request) => request.path)).toEqual(expect.arrayContaining([
      '/recipe.json', '/catalog.json',
    ]))

    const active = getActiveConformanceDescriptor()
    expect(active).toMatchObject({
      datasetId: input.compiledRecipe.normalizedManifest.id,
      sceneId: input.sceneId,
      frameCount: state.totalFrames,
    })
    const isolated = await createActiveConformanceScene()
    expect(isolated.manifest.id).toBe(input.compiledRecipe.normalizedManifest.id)
    await expect(isolated.loadFrame(0, { capabilities: isolated.manifest.capabilities }))
      .resolves.toMatchObject({ index: 0 })
    isolated.dispose()

    const rebuilt = currentPortableShareDescriptorV1(descriptor.presentation.cameraPose)
    expect(rebuilt?.source).toEqual(descriptor.source)
    expect(rebuilt?.recipe).toEqual(descriptor.recipe)
    expect(rebuilt?.presentation.visibleSensorIds).toEqual(pointSensors)
    expect(rebuilt?.view.frameIndex).toBe(0)
  } finally {
    useSceneStore.getState().actions.reset()
    sharedVerifiedRecipeCacheV1.clear()
    await hosted.dispose()
  }
}
