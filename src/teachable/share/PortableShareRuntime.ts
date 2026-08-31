import type { AdapterDiagnostic } from '../recipe/diagnostics'
import { bindRemoteRecipeSceneV1, type BoundRemoteRecipeSceneV1 } from '../runtime/bindRecipeScene'
import type { NormalizedCapabilityV1, NormalizedManifestV1 } from '../runtime/normalizedScene'
import { resolveWindowToFrames } from '../../utils/playbackWindow'
import { fetchSourceCatalogV1 } from '../source/RemoteByteSource'
import type { ValidatedSourceCatalogV1 } from '../source/SourceCatalog'
import {
  decodePortableShareRequestV1,
  resolveShareRequestDescriptorV1,
  validateShareDescriptorV1,
  type PortableShareRequestV1,
  type ShareDescriptorV1,
} from './ShareDescriptor'
import {
  fetchRemoteRecipeV1,
  type FetchRemoteRecipeOptionsV1,
  type VerifiedRemoteRecipeV1,
  type VerifiedRecipeCacheV1,
} from './RecipeTransport'

export type PortableShareRuntimeErrorCodeV1 =
  | 'SHARE_FRAME_OUT_OF_RANGE'
  | 'SHARE_NOT_PRESENT'
  | 'SHARE_PRESENTATION_INCOMPATIBLE'
  | 'SHARE_WINDOW_OUT_OF_RANGE'

export class PortableShareRuntimeErrorV1 extends Error {
  readonly code: PortableShareRuntimeErrorCodeV1

  constructor(code: PortableShareRuntimeErrorCodeV1, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, cause === undefined ? undefined : { cause })
    this.name = 'PortableShareRuntimeErrorV1'
    this.code = code
  }
}

export interface ShareRestoreDiagnosticV1 {
  readonly stage: 'presentation'
  readonly severity: 'warning'
  readonly code:
    | 'SHARE_ACTIVE_CAMERA_ID_UNKNOWN'
    | 'SHARE_COLORMAP_UNAVAILABLE'
    | 'SHARE_OVERLAY_UNAVAILABLE'
    | 'SHARE_SENSOR_ID_UNKNOWN'
  readonly value: string
  readonly hint: string
}

export interface ResolvedPortableShareV1 {
  /** Original hash-bound descriptor. */
  readonly descriptor: ShareDescriptorV1
  /** Capability-compatible presentation used by ordinary partial restore. */
  readonly effectiveDescriptor: ShareDescriptorV1
  readonly request: PortableShareRequestV1
  readonly recipe: VerifiedRemoteRecipeV1
  readonly catalog: ValidatedSourceCatalogV1
  readonly binding: BoundRemoteRecipeSceneV1
  readonly diagnostics: readonly (AdapterDiagnostic | ShareRestoreDiagnosticV1)[]
}

export interface ResolvePortableShareOptionsV1 {
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  readonly counted?: boolean
  readonly recipeCache?: VerifiedRecipeCacheV1
  /** Browser-held grants are state, never serialized into a descriptor. */
  readonly credentialGrantForOrigin?: (origin: string) => { readonly origin: string } | undefined
  readonly fetchRecipe?: (
    url: string,
    recipeHash: string,
    options: FetchRemoteRecipeOptionsV1,
  ) => Promise<VerifiedRemoteRecipeV1>
  readonly fetchCatalog?: typeof fetchSourceCatalogV1
  readonly bindRemote?: typeof bindRemoteRecipeSceneV1
}

function grantFor(rawUrl: string, options: ResolvePortableShareOptionsV1): { readonly origin: string } | undefined {
  return options.credentialGrantForOrigin?.(new URL(rawUrl).origin)
}

function warning(
  code: ShareRestoreDiagnosticV1['code'],
  value: string,
  hint: string,
): ShareRestoreDiagnosticV1 {
  return { stage: 'presentation', severity: 'warning', code, value, hint }
}

function requireOrWarn(
  diagnostic: ShareRestoreDiagnosticV1,
  diagnostics: ShareRestoreDiagnosticV1[],
  counted: boolean,
): void {
  if (counted) {
    throw new PortableShareRuntimeErrorV1('SHARE_PRESENTATION_INCOMPATIBLE', `${diagnostic.code}: ${diagnostic.value}`)
  }
  diagnostics.push(diagnostic)
}

function supportsOverlay(manifest: NormalizedManifestV1, overlay: keyof ShareDescriptorV1['presentation']['overlays']): boolean {
  const capabilities = manifest.capabilities
  if (overlay === 'lidarProjection') return capabilities.has('pointClouds') && capabilities.has('cameraImages')
  const capability: NormalizedCapabilityV1 = overlay === 'cameraSegmentation' ? 'cameraSegmentation' : overlay
  return capabilities.has(capability)
}

function compatibleDescriptor(
  descriptor: ShareDescriptorV1,
  manifest: NormalizedManifestV1,
  counted: boolean,
): { readonly descriptor: ShareDescriptorV1; readonly diagnostics: readonly ShareRestoreDiagnosticV1[] } {
  const diagnostics: ShareRestoreDiagnosticV1[] = []
  const pointSensors = new Map(manifest.sensors
    .filter((sensor) => sensor.modality !== 'camera')
    .map((sensor) => [sensor.id, sensor]))
  const cameras = new Map(manifest.sensors
    .filter((sensor) => sensor.modality === 'camera')
    .map((sensor) => [sensor.id, sensor]))
  const visibleSensorIds = descriptor.presentation.visibleSensorIds.filter((id) => {
    if (pointSensors.has(id)) return true
    requireOrWarn(warning('SHARE_SENSOR_ID_UNKNOWN', id, 'The sensor is absent from the bound point-sensor manifest and was not restored.'), diagnostics, counted)
    return false
  })
  let activeCameraId = descriptor.presentation.activeCameraId
  if (activeCameraId !== null && (!cameras.has(activeCameraId) || !manifest.capabilities.has('cameraImages'))) {
    requireOrWarn(warning('SHARE_ACTIVE_CAMERA_ID_UNKNOWN', activeCameraId, 'The camera or its image capability is absent; orbital view was restored.'), diagnostics, counted)
    activeCameraId = null
  }
  let cameraStrip = descriptor.presentation.cameraStrip
  if (cameraStrip && !manifest.capabilities.has('cameraImages')) {
    requireOrWarn(warning('SHARE_OVERLAY_UNAVAILABLE', 'cameraStrip', 'Camera images are unavailable and the camera strip was hidden.'), diagnostics, counted)
    cameraStrip = false
  }
  let colormap = descriptor.presentation.colormap
  if (!manifest.pointLayout.colorModes.includes(colormap)) {
    requireOrWarn(warning('SHARE_COLORMAP_UNAVAILABLE', colormap, 'The colormap is unavailable for this recipe; the first declared mode was restored.'), diagnostics, counted)
    colormap = manifest.pointLayout.colorModes[0] ?? 'distance'
  }
  const overlays = { ...descriptor.presentation.overlays }
  for (const name of Object.keys(overlays) as (keyof typeof overlays)[]) {
    if (overlays[name] && !supportsOverlay(manifest, name)) {
      requireOrWarn(warning('SHARE_OVERLAY_UNAVAILABLE', name, 'The overlay capability is unavailable and was disabled.'), diagnostics, counted)
      overlays[name] = false
    }
  }
  let boxMode = descriptor.presentation.boxMode
  if (boxMode !== 'off' && !manifest.capabilities.has('boxes3d')) {
    requireOrWarn(warning('SHARE_OVERLAY_UNAVAILABLE', `boxMode:${boxMode}`, '3D boxes are unavailable and were disabled.'), diagnostics, counted)
    boxMode = 'off'
  }
  return {
    descriptor: validateShareDescriptorV1({
      ...descriptor,
      presentation: {
        ...descriptor.presentation,
        cameraStrip,
        visibleSensorIds,
        activeCameraId,
        colormap,
        boxMode,
        overlays,
      },
    }),
    diagnostics,
  }
}

/**
 * Empty-profile resolver. Identity order is descriptor -> recipe/catalog ->
 * remote bind. No dataset registry or prior import participates.
 */
export async function resolvePortableShareRequestV1(
  request: PortableShareRequestV1,
  options: ResolvePortableShareOptionsV1 = {},
): Promise<ResolvedPortableShareV1> {
  const descriptor = await resolveShareRequestDescriptorV1(request, {
    fetch: options.fetch,
    signal: options.signal,
    credentialGrant: request.mode === 'referenced' ? grantFor(request.descriptorUrl, options) : undefined,
  })
  const fetchRecipe = options.fetchRecipe ?? fetchRemoteRecipeV1
  const fetchCatalog = options.fetchCatalog ?? fetchSourceCatalogV1
  const [recipe, catalog] = await Promise.all([
    fetchRecipe(descriptor.recipe.url, descriptor.recipe.recipeHash, {
      fetch: options.fetch,
      signal: options.signal,
      credentialGrant: grantFor(descriptor.recipe.url, options),
      cache: options.recipeCache,
    }),
    fetchCatalog(descriptor.source.catalogUrl, {
      expectedCatalogHash: descriptor.source.catalogHash,
      expectedSourceManifestHash: descriptor.source.sourceManifestHash,
      fetch: options.fetch,
      signal: options.signal,
      credentialGrant: grantFor(descriptor.source.catalogUrl, options),
    }),
  ])
  const bindRemote = options.bindRemote ?? bindRemoteRecipeSceneV1
  const binding = await bindRemote({
    compiledRecipe: recipe.compiledRecipe,
    sceneId: descriptor.view.sceneId,
    signal: options.signal,
    remote: {
      rootUrl: descriptor.source.rootUrl,
      catalog: catalog.catalog,
      expectedCatalogHash: descriptor.source.catalogHash,
      expectedSourceManifestHash: descriptor.source.sourceManifestHash,
      fetch: options.fetch,
      credentialGrant: grantFor(descriptor.source.rootUrl, options),
    },
  })
  try {
    if (descriptor.view.frameIndex >= binding.scene.index.timestampsMicros.length) {
      throw new PortableShareRuntimeErrorV1(
        'SHARE_FRAME_OUT_OF_RANGE',
        `Frame ${descriptor.view.frameIndex} is outside 0..${Math.max(0, binding.scene.index.timestampsMicros.length - 1)}.`,
      )
    }
    if (descriptor.view.t0 !== undefined && descriptor.view.t1 !== undefined
      && !resolveWindowToFrames(binding.metadata.timestamps, descriptor.view.t0, descriptor.view.t1)) {
      throw new PortableShareRuntimeErrorV1(
        'SHARE_WINDOW_OUT_OF_RANGE',
        `Window ${descriptor.view.t0}..${descriptor.view.t1} does not overlap the bound scene.`,
      )
    }
    const compatible = compatibleDescriptor(descriptor, binding.scene.manifest, options.counted === true)
    return Object.freeze({
      descriptor,
      effectiveDescriptor: compatible.descriptor,
      request,
      recipe,
      catalog,
      binding,
      diagnostics: Object.freeze([...binding.diagnostics, ...compatible.diagnostics]),
    })
  } catch (cause) {
    binding.scene.dispose()
    throw cause
  }
}

export async function resolvePortableShareUrlV1(
  rawUrl: string,
  options: ResolvePortableShareOptionsV1 = {},
): Promise<ResolvedPortableShareV1> {
  const request = decodePortableShareRequestV1(rawUrl)
  if (!request) throw new PortableShareRuntimeErrorV1('SHARE_NOT_PRESENT', 'URL does not contain a portable v1 share.')
  return await resolvePortableShareRequestV1(request, options)
}
