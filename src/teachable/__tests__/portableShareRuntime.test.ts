import { describe, expect, it, vi } from 'vitest'
import waymoRecipeJson from '../../adapters/recipes/waymo.egolens-adapter.json'
import type { MetadataBundle } from '../../types/dataset'
import { recipeHashV1 } from '../authoring/hashes'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { compileRecipeV1 } from '../recipe/compiler'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import type { BoundRemoteRecipeSceneV1 } from '../runtime/bindRecipeScene'
import type { NormalizedFrameV1, NormalizedSceneV1 } from '../runtime/normalizedScene'
import {
  canonicalShareDescriptorV1,
  decodePortableShareRequestV1,
  encodeReferencedShareUrlV1,
  shareDescriptorHashV1,
  validateShareDescriptorV1,
  type ShareDescriptorV1,
} from '../share/ShareDescriptor'
import { resolvePortableShareRequestV1 } from '../share/PortableShareRuntime'
import type { VerifiedRemoteRecipeV1 } from '../share/RecipeTransport'
import type { ValidatedSourceCatalogV1 } from '../source/SourceCatalog'

const recipe = waymoRecipeJson as EgoLensAdapterRecipeV1
const compiledRecipe = compileRecipeV1(recipe, bundledPhase2OperatorRegistry)

function emptyFrame(): NormalizedFrameV1 {
  return {
    index: 0, timestampMicros: 1n, worldFromEgo: null,
    pointClouds: [], radarPointClouds: [], cameraImages: [], boxes3d: [], boxes2d: [],
    keypoints3d: [], keypoints2d: [], lidarSegmentation: [], cameraSegmentation: [],
  }
}

function scene(dispose = vi.fn()): NormalizedSceneV1 {
  return {
    manifest: compiledRecipe.normalizedManifest,
    index: { timestampsMicros: [1n], segments: [{ id: 'scene', firstFrame: 0, frameCount: 1 }] },
    relations: { staticTransforms: [], cameraCalibrations: new Map(), trajectories: new Map(), box2dToBox3d: new Map() },
    loadFrame: async () => emptyFrame(),
    dispose,
  }
}

function metadata(): MetadataBundle {
  return {
    timestamps: [1n], timestampToFrame: new Map([[1n, 0]]),
    vehiclePoseByFrame: new Map(), worldOriginInverse: null, poseByFrameIndex: new Map(),
    lidarCalibrations: new Map(), cameraCalibrations: [], lidarBoxByFrame: new Map(),
    cameraBoxByFrame: new Map(), objectTrajectories: new Map(), assocCamToLaser: new Map(),
    assocLaserToCams: new Map(), hasBoxData: false,
  }
}

function binding(dispose = vi.fn()): BoundRemoteRecipeSceneV1 {
  return {
    scene: scene(dispose), diagnostics: [], metadata: metadata(), availableSegments: [{ id: 'scene', groupId: 'scene' }],
    source: { dispose: vi.fn() } as unknown as BoundRemoteRecipeSceneV1['source'],
    catalogHash: `sha256:${'a'.repeat(64)}`,
    sourceManifestHash: `sha256:${'b'.repeat(64)}`,
  }
}

function catalog(): ValidatedSourceCatalogV1 {
  const catalogHash = `sha256:${'a'.repeat(64)}`
  const sourceManifestHash = `sha256:${'b'.repeat(64)}`
  return {
    catalog: { schema: 'egolens-source-catalog-v1', entries: [], catalogHash },
    catalogHash, sourceManifestHash, manifestEntries: [],
  }
}

async function descriptor(): Promise<ShareDescriptorV1> {
  const point = compiledRecipe.normalizedManifest.sensors.find((sensor) => sensor.modality !== 'camera')!
  return validateShareDescriptorV1({
    schema: 'egolens-share-v1',
    source: {
      rootUrl: 'https://data.example/source/', catalogUrl: 'https://data.example/catalog.json',
      catalogHash: `sha256:${'a'.repeat(64)}`, sourceManifestHash: `sha256:${'b'.repeat(64)}`,
    },
    recipe: { url: 'https://recipes.example/waymo.json', recipeHash: await recipeHashV1(recipe) },
    view: { sceneId: 'scene', frameIndex: 0 },
    presentation: {
      cameraStrip: false, coordinateMode: 'ego', visibleSensorIds: [point.id, 'zzz-unknown'].sort(),
      activeCameraId: 'unknown-camera', colormap: 'intensity', boxMode: 'off', trailLength: 0,
      pointSize: 0.08, pointOpacity: 1,
      overlays: { lidarProjection: false, keypoints3d: false, keypoints2d: false, cameraSegmentation: false },
      playbackSpeed: 1, followCamera: false,
      cameraPose: { position: [1, 2, 3], target: [0, 0, 0], azimuth: 0, distance: 4 },
      theme: 'light', accent: null,
    },
  })
}

describe('portable share empty-profile resolver', () => {
  it('verifies the referenced descriptor before starting recipe or catalog fetches', async () => {
    const value = await descriptor()
    const events: string[] = []
    const descriptorText = canonicalShareDescriptorV1(value)
    const url = encodeReferencedShareUrlV1(
      'https://viewer.example/', 'https://share.example/view.json', shareDescriptorHashV1(value),
    )
    const request = decodePortableShareRequestV1(url)!
    const verifiedRecipe: VerifiedRemoteRecipeV1 = {
      recipeHash: value.recipe.recipeHash, recipe, compiledRecipe,
    }
    const result = await resolvePortableShareRequestV1(request, {
      fetch: vi.fn(async () => {
        events.push('descriptor')
        return new Response(descriptorText, { status: 200 })
      }) as unknown as typeof fetch,
      fetchRecipe: async () => { events.push('recipe'); return verifiedRecipe },
      fetchCatalog: async () => { events.push('catalog'); return catalog() },
      bindRemote: async () => { events.push('bind'); return binding() },
    })

    expect(events[0]).toBe('descriptor')
    expect(events.indexOf('bind')).toBeGreaterThan(events.indexOf('recipe'))
    expect(events.indexOf('bind')).toBeGreaterThan(events.indexOf('catalog'))
    expect(result.effectiveDescriptor.presentation.visibleSensorIds).toHaveLength(1)
    expect(result.effectiveDescriptor.presentation.activeCameraId).toBeNull()
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'SHARE_SENSOR_ID_UNKNOWN', 'SHARE_ACTIVE_CAMERA_ID_UNKNOWN',
    ]))
    result.binding.scene.dispose()
  })

  it('fails counted restoration on unknown stable presentation IDs and disposes the binding', async () => {
    const value = await descriptor()
    const dispose = vi.fn()
    const verifiedRecipe: VerifiedRemoteRecipeV1 = {
      recipeHash: value.recipe.recipeHash, recipe, compiledRecipe,
    }
    await expect(resolvePortableShareRequestV1({ mode: 'inline', descriptor: value, envelope: {} }, {
      counted: true,
      fetchRecipe: async () => verifiedRecipe,
      fetchCatalog: async () => catalog(),
      bindRemote: async () => binding(dispose),
    })).rejects.toMatchObject({ code: 'SHARE_PRESENTATION_INCOMPATIBLE' })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
