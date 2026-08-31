import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020'
import { getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser'
import shareSchema from '../schema/egolens-share-v1.schema.json'
import { canonicalizeJson } from '../recipe/canonicalize'
import type { JsonValue } from '../recipe/types'
import { sha256DigestV1 } from '../source/sha256'
import { validateRemoteUrlV1 } from '../source/RemoteByteSource'

export const SHARE_DESCRIPTOR_SCHEMA_V1 = 'egolens-share-v1' as const
export const MAX_SHARE_DESCRIPTOR_BYTES_V1 = 64 * 1024

export type ShareCoordinateModeV1 = 'ego' | 'world'
export type ShareColormapV1 = 'distance' | 'intensity' | 'range' | 'elongation' | 'segment' | 'panoptic' | 'camera'
export type ShareBoxModeV1 = 'off' | 'box' | 'model'
export type ShareThemeV1 = 'light' | 'dark'
export type ShareVector3V1 = readonly [number, number, number]

export interface ShareDescriptorV1 {
  readonly schema: typeof SHARE_DESCRIPTOR_SCHEMA_V1
  readonly source: {
    readonly rootUrl: string
    readonly catalogUrl: string
    readonly catalogHash: string
    readonly sourceManifestHash: string
  }
  readonly recipe: {
    readonly url: string
    readonly recipeHash: string
  }
  readonly view: {
    readonly sceneId: string
    readonly frameIndex: number
    readonly t0?: string
    readonly t1?: string
  }
  readonly presentation: {
    readonly cameraStrip: boolean
    readonly coordinateMode: ShareCoordinateModeV1
    readonly visibleSensorIds: readonly string[]
    readonly activeCameraId: string | null
    readonly colormap: ShareColormapV1
    readonly boxMode: ShareBoxModeV1
    readonly trailLength: number
    readonly pointSize: number
    readonly pointOpacity: number
    readonly overlays: {
      readonly lidarProjection: boolean
      readonly keypoints3d: boolean
      readonly keypoints2d: boolean
      readonly cameraSegmentation: boolean
    }
    readonly playbackSpeed: number
    readonly followCamera: boolean
    readonly cameraPose: {
      readonly position: ShareVector3V1
      readonly target: ShareVector3V1
      readonly azimuth: number
      readonly distance: number
    }
    readonly theme: ShareThemeV1
    readonly accent: string | null
  }
}

export type ShareDescriptorErrorCodeV1 =
  | 'SHARE_CREDENTIAL_LEAKAGE'
  | 'SHARE_DESCRIPTOR_AMBIGUOUS'
  | 'SHARE_DESCRIPTOR_FETCH_FAILED'
  | 'SHARE_DESCRIPTOR_HASH_MISMATCH'
  | 'SHARE_DESCRIPTOR_INVALID'
  | 'SHARE_DESCRIPTOR_TOO_LARGE'
  | 'SHARE_INLINE_INVALID'
  | 'SHARE_URL_INVALID'

export class ShareDescriptorErrorV1 extends Error {
  readonly code: ShareDescriptorErrorCodeV1

  constructor(code: ShareDescriptorErrorCodeV1, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, cause === undefined ? undefined : { cause })
    this.name = 'ShareDescriptorErrorV1'
    this.code = code
  }
}

const validator = new Ajv2020({ allErrors: true, strict: true }).compile(
  shareSchema,
) as ValidateFunction<ShareDescriptorV1>

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const SIGNED_INT64_MIN = -(1n << 63n)
const SIGNED_INT64_MAX = (1n << 63n) - 1n
const SENSITIVE_QUERY_NAME = /(?:^|[-_])(?:access[-_]?key|api[-_]?key|auth|authorization|bearer|code|credential|jwt|key|password|policy|secret|session(?:id)?|sig|signature|token)(?:$|[-_])/iu

const INLINE_IDENTITY_AND_VIEW_KEYS = [
  'shareVersion', 'data', 'catalog', 'catalogHash', 'sourceHash',
  'recipe', 'recipeHash', 'scene', 'frame', 't0', 't1',
] as const
const PRESENTATION_KEYS = [
  'cameras', 'colormap', 'box', 'world', 'sensors', 'ps', 'opacity', 'cam',
  'trail', 'lidar2d', 'kp3d', 'kp2d', 'camseg', 'speed', 'follow', 'cp', 'ct',
  'az', 'cd', 'theme', 'accent',
] as const
const PAGE_ENVELOPE_KEYS = ['embed', 'controls', 'origin'] as const
const INLINE_REQUIRED_KEYS = [
  'shareVersion', 'data', 'catalog', 'catalogHash', 'sourceHash', 'recipe',
  'recipeHash', 'scene', 'frame', ...PRESENTATION_KEYS,
] as const
const INLINE_ALLOWED = new Set([...INLINE_REQUIRED_KEYS, 't0', 't1', ...PAGE_ENVELOPE_KEYS])

function errorText(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`).join('; ')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member)
  }
  return value
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assertInt64(value: string, field: string): void {
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch (cause) {
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', `${field} is not a decimal int64.`, cause)
  }
  if (parsed < SIGNED_INT64_MIN || parsed > SIGNED_INT64_MAX) {
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', `${field} is outside signed int64 range.`)
  }
}

function assertSafeRemoteUrl(value: string, field: string, root = false): void {
  let url: URL
  try {
    url = validateRemoteUrlV1(value)
  } catch (cause) {
    throw new ShareDescriptorErrorV1('SHARE_URL_INVALID', `${field} must be an absolute HTTPS URL (HTTP is loopback-only).`, cause)
  }
  if (url.hash) throw new ShareDescriptorErrorV1('SHARE_URL_INVALID', `${field} cannot contain a fragment.`)
  if (root && url.search) throw new ShareDescriptorErrorV1('SHARE_URL_INVALID', `${field} cannot contain a query.`)
  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_NAME.test(name) || name.toLowerCase().startsWith('x-amz-') || name.toLowerCase().startsWith('x-goog-')) {
      throw new ShareDescriptorErrorV1('SHARE_CREDENTIAL_LEAKAGE', `${field} contains a credential-like query parameter.`)
    }
  }
}

/** Validate, normalize through JSON, and freeze the complete closed descriptor. */
export function validateShareDescriptorV1(value: unknown): ShareDescriptorV1 {
  if (!validator(value)) {
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', errorText(validator.errors))
  }
  const descriptor = cloneJson(value as ShareDescriptorV1)
  assertSafeRemoteUrl(descriptor.source.rootUrl, 'source.rootUrl', true)
  assertSafeRemoteUrl(descriptor.source.catalogUrl, 'source.catalogUrl')
  assertSafeRemoteUrl(descriptor.recipe.url, 'recipe.url')
  if (!SHA256.test(descriptor.source.catalogHash)
    || !SHA256.test(descriptor.source.sourceManifestHash)
    || !SHA256.test(descriptor.recipe.recipeHash)) {
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'All identities must use lowercase sha256: digests.')
  }
  if (descriptor.view.t0 !== undefined && descriptor.view.t1 !== undefined) {
    assertInt64(descriptor.view.t0, 'view.t0')
    assertInt64(descriptor.view.t1, 'view.t1')
    if (BigInt(descriptor.view.t0) > BigInt(descriptor.view.t1)) {
      throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'view.t0 must not exceed view.t1.')
    }
  }
  return deepFreeze(descriptor)
}

export function canonicalShareDescriptorV1(value: ShareDescriptorV1): string {
  return canonicalizeJson(validateShareDescriptorV1(value) as unknown as JsonValue)
}

export function shareDescriptorHashV1(value: ShareDescriptorV1): string {
  return sha256DigestV1(new TextEncoder().encode(canonicalShareDescriptorV1(value)))
}

function parseStrictJson(text: string): unknown {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true })
  if (!root || errors.length > 0) {
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'Descriptor is not strict JSON.')
  }
  const visit = (node: Node): void => {
    if (node.type === 'object') {
      const seen = new Set<string>()
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value
        if (typeof key === 'string' && seen.has(key)) {
          throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', `Descriptor contains duplicate key "${key}".`)
        }
        if (typeof key === 'string') seen.add(key)
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return getNodeValue(root)
}

function finiteString(value: number): string {
  if (!Number.isFinite(value)) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'Presentation number is not finite.')
  return Object.is(value, -0) ? '0' : String(value)
}

function vectorString(value: ShareVector3V1): string {
  return value.map(finiteString).join(',')
}

function pageUrl(raw: string): URL {
  try {
    const url = new URL(raw)
    url.search = ''
    url.hash = ''
    return url
  } catch (cause) {
    throw new ShareDescriptorErrorV1('SHARE_URL_INVALID', 'Page URL must be absolute.', cause)
  }
}

export interface SharePageEnvelopeV1 {
  readonly embed?: string
  readonly controls?: string
  readonly origin?: string
}

function appendEnvelope(params: URLSearchParams, envelope: SharePageEnvelopeV1): void {
  for (const key of PAGE_ENVELOPE_KEYS) {
    const value = envelope[key]
    if (value !== undefined) params.set(key, value)
  }
}

export function encodeInlineShareUrlV1(
  rawPageUrl: string,
  value: ShareDescriptorV1,
  envelope: SharePageEnvelopeV1 = {},
): string {
  const descriptor = validateShareDescriptorV1(value)
  const params = new URLSearchParams()
  params.set('shareVersion', '1')
  params.set('data', descriptor.source.rootUrl)
  params.set('catalog', descriptor.source.catalogUrl)
  params.set('catalogHash', descriptor.source.catalogHash)
  params.set('sourceHash', descriptor.source.sourceManifestHash)
  params.set('recipe', descriptor.recipe.url)
  params.set('recipeHash', descriptor.recipe.recipeHash)
  params.set('scene', descriptor.view.sceneId)
  params.set('frame', String(descriptor.view.frameIndex))
  if (descriptor.view.t0 !== undefined && descriptor.view.t1 !== undefined) {
    params.set('t0', descriptor.view.t0)
    params.set('t1', descriptor.view.t1)
  }
  const presentation = descriptor.presentation
  params.set('cameras', presentation.cameraStrip ? '1' : '0')
  params.set('colormap', presentation.colormap)
  params.set('box', presentation.boxMode)
  params.set('world', presentation.coordinateMode === 'world' ? '1' : '0')
  params.set('sensors', presentation.visibleSensorIds.length > 0 ? [...presentation.visibleSensorIds].sort().join(',') : 'none')
  params.set('ps', finiteString(presentation.pointSize))
  params.set('opacity', finiteString(presentation.pointOpacity))
  params.set('cam', presentation.activeCameraId ?? 'none')
  params.set('trail', String(presentation.trailLength))
  params.set('lidar2d', presentation.overlays.lidarProjection ? '1' : '0')
  params.set('kp3d', presentation.overlays.keypoints3d ? '1' : '0')
  params.set('kp2d', presentation.overlays.keypoints2d ? '1' : '0')
  params.set('camseg', presentation.overlays.cameraSegmentation ? '1' : '0')
  params.set('speed', finiteString(presentation.playbackSpeed))
  params.set('follow', presentation.followCamera ? '1' : '0')
  params.set('cp', vectorString(presentation.cameraPose.position))
  params.set('ct', vectorString(presentation.cameraPose.target))
  params.set('az', finiteString(presentation.cameraPose.azimuth))
  params.set('cd', finiteString(presentation.cameraPose.distance))
  params.set('theme', presentation.theme)
  params.set('accent', presentation.accent ?? 'default')
  appendEnvelope(params, envelope)
  const url = pageUrl(rawPageUrl)
  url.search = params.toString()
  return url.href
}

export function encodeReferencedShareUrlV1(
  rawPageUrl: string,
  descriptorUrl: string,
  shareHash: string,
  envelope: SharePageEnvelopeV1 = {},
): string {
  assertSafeRemoteUrl(descriptorUrl, 'share')
  if (!SHA256.test(shareHash)) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'shareHash must be lowercase sha256.')
  const params = new URLSearchParams()
  params.set('share', descriptorUrl)
  params.set('shareHash', shareHash)
  appendEnvelope(params, envelope)
  const url = pageUrl(rawPageUrl)
  url.search = params.toString()
  return url.href
}

function exactlyOne(params: URLSearchParams, key: string): string {
  const values = params.getAll(key)
  if (values.length !== 1) throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `${key} must appear exactly once.`)
  return values[0]
}

function flag(params: URLSearchParams, key: string): boolean {
  const value = exactlyOne(params, key)
  if (value === '0') return false
  if (value === '1') return true
  throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `${key} must be 0 or 1.`)
}

function decimal(params: URLSearchParams, key: string): number {
  const raw = exactlyOne(params, key)
  if (raw.trim() !== raw || raw === '') throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `${key} is not a canonical decimal.`)
  const value = Number(raw)
  if (!Number.isFinite(value) || finiteString(value) !== raw) {
    throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `${key} is not the shortest finite decimal.`)
  }
  return value
}

function integer(params: URLSearchParams, key: string): number {
  const raw = exactlyOne(params, key)
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `${key} must be a canonical non-negative integer.`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `${key} is outside the safe integer range.`)
  return value
}

function vector(params: URLSearchParams, key: string): ShareVector3V1 {
  const parts = exactlyOne(params, key).split(',')
  if (parts.length !== 3) throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `${key} must contain three decimals.`)
  const values = parts.map((raw) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || finiteString(parsed) !== raw) {
      throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `${key} contains a non-canonical decimal.`)
    }
    return parsed
  })
  return [values[0], values[1], values[2]]
}

export interface InlineShareRequestV1 {
  readonly mode: 'inline'
  readonly descriptor: ShareDescriptorV1
  readonly envelope: SharePageEnvelopeV1
}

export interface ReferencedShareRequestV1 {
  readonly mode: 'referenced'
  readonly descriptorUrl: string
  readonly shareHash: string
  readonly envelope: SharePageEnvelopeV1
}

export type PortableShareRequestV1 = InlineShareRequestV1 | ReferencedShareRequestV1

function envelopeFrom(params: URLSearchParams): SharePageEnvelopeV1 {
  const envelope: { embed?: string; controls?: string; origin?: string } = {}
  for (const key of PAGE_ENVELOPE_KEYS) {
    const values = params.getAll(key)
    if (values.length > 1) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_AMBIGUOUS', `${key} is duplicated.`)
    if (values[0] !== undefined) envelope[key] = values[0]
  }
  return envelope
}

/** Decode v1 only. Legacy URLs deliberately remain with the existing parser. */
export function decodePortableShareRequestV1(rawUrl: string): PortableShareRequestV1 | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch (cause) {
    throw new ShareDescriptorErrorV1('SHARE_URL_INVALID', 'Share page URL must be absolute.', cause)
  }
  const params = url.searchParams
  const hasReference = params.has('share') || params.has('shareHash')
  if (hasReference) {
    for (const key of params.keys()) {
      if (key !== 'share' && key !== 'shareHash' && !(PAGE_ENVELOPE_KEYS as readonly string[]).includes(key)) {
        throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_AMBIGUOUS', `Referenced descriptor mode cannot mix ${key}.`)
      }
    }
    const descriptorUrl = exactlyOne(params, 'share')
    const shareHash = exactlyOne(params, 'shareHash')
    assertSafeRemoteUrl(descriptorUrl, 'share')
    if (!SHA256.test(shareHash)) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'shareHash must be lowercase sha256.')
    return { mode: 'referenced', descriptorUrl, shareHash, envelope: envelopeFrom(params) }
  }
  if (!params.has('shareVersion')) return null
  if (exactlyOne(params, 'shareVersion') !== '1') {
    throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', 'Only shareVersion=1 is supported.')
  }
  for (const key of params.keys()) {
    if (!INLINE_ALLOWED.has(key)) throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', `Unknown inline parameter ${key}.`)
  }
  for (const key of INLINE_REQUIRED_KEYS) exactlyOne(params, key)
  if (params.has('t0') !== params.has('t1')) throw new ShareDescriptorErrorV1('SHARE_INLINE_INVALID', 't0 and t1 must appear together.')

  const sensorsRaw = exactlyOne(params, 'sensors')
  const visibleSensorIds = sensorsRaw === 'none' ? [] : sensorsRaw.split(',')
  const activeRaw = exactlyOne(params, 'cam')
  const accentRaw = exactlyOne(params, 'accent')
  const descriptor = validateShareDescriptorV1({
    schema: SHARE_DESCRIPTOR_SCHEMA_V1,
    source: {
      rootUrl: exactlyOne(params, 'data'),
      catalogUrl: exactlyOne(params, 'catalog'),
      catalogHash: exactlyOne(params, 'catalogHash'),
      sourceManifestHash: exactlyOne(params, 'sourceHash'),
    },
    recipe: { url: exactlyOne(params, 'recipe'), recipeHash: exactlyOne(params, 'recipeHash') },
    view: {
      sceneId: exactlyOne(params, 'scene'),
      frameIndex: integer(params, 'frame'),
      ...(params.has('t0') ? { t0: exactlyOne(params, 't0'), t1: exactlyOne(params, 't1') } : {}),
    },
    presentation: {
      cameraStrip: flag(params, 'cameras'),
      coordinateMode: flag(params, 'world') ? 'world' : 'ego',
      visibleSensorIds,
      activeCameraId: activeRaw === 'none' ? null : activeRaw,
      colormap: exactlyOne(params, 'colormap'),
      boxMode: exactlyOne(params, 'box'),
      trailLength: integer(params, 'trail'),
      pointSize: decimal(params, 'ps'),
      pointOpacity: decimal(params, 'opacity'),
      overlays: {
        lidarProjection: flag(params, 'lidar2d'),
        keypoints3d: flag(params, 'kp3d'),
        keypoints2d: flag(params, 'kp2d'),
        cameraSegmentation: flag(params, 'camseg'),
      },
      playbackSpeed: decimal(params, 'speed'),
      followCamera: flag(params, 'follow'),
      cameraPose: {
        position: vector(params, 'cp'), target: vector(params, 'ct'),
        azimuth: decimal(params, 'az'), distance: decimal(params, 'cd'),
      },
      theme: exactlyOne(params, 'theme'),
      accent: accentRaw === 'default' ? null : accentRaw,
    },
  })
  return { mode: 'inline', descriptor, envelope: envelopeFrom(params) }
}

function credentialMode(url: URL, grant: { readonly origin: string } | undefined): RequestCredentials {
  if (!grant) return 'omit'
  if (grant.origin !== url.origin) throw new ShareDescriptorErrorV1('SHARE_URL_INVALID', 'Credential grant must exactly match descriptor origin.')
  return 'include'
}

async function readAtMost(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^(0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel()
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_TOO_LARGE', `Descriptor exceeds ${maxBytes} bytes.`)
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_TOO_LARGE', `Descriptor exceeds ${maxBytes} bytes.`)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Descriptor fetch aborted.', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_TOO_LARGE', `Descriptor exceeds ${maxBytes} bytes.`)
      chunks.push(value)
    }
  } catch (cause) {
    await reader.cancel().catch(() => {})
    throw cause
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

/** Fetch and verify the canonical descriptor before any source or recipe request. */
export async function fetchShareDescriptorV1(
  rawUrl: string,
  expectedShareHash: string,
  options: {
    readonly fetch?: typeof fetch
    readonly signal?: AbortSignal
    readonly credentialGrant?: { readonly origin: string }
  } = {},
): Promise<ShareDescriptorV1> {
  if (!SHA256.test(expectedShareHash)) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'shareHash must be lowercase sha256.')
  let current: URL
  try {
    assertSafeRemoteUrl(rawUrl, 'share')
    current = new URL(rawUrl)
  } catch (cause) {
    if (cause instanceof ShareDescriptorErrorV1) throw cause
    throw new ShareDescriptorErrorV1('SHARE_URL_INVALID', 'Descriptor URL is invalid.', cause)
  }
  const initialOrigin = current.origin
  const fetcher = options.fetch ?? fetch
  let response: Response | null = null
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    try {
      response = await fetcher(current, {
        method: 'GET', signal: options.signal, redirect: 'manual', cache: 'no-store',
        credentials: credentialMode(current, options.credentialGrant), referrerPolicy: 'no-referrer',
      })
    } catch (cause) {
      if (options.signal?.aborted) throw cause
      throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_FETCH_FAILED', 'Descriptor fetch failed; check CORS and connectivity.', cause)
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    if (redirects === 5 || response.type === 'opaqueredirect') {
      await response.body?.cancel()
      throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_FETCH_FAILED', 'Descriptor redirect could not be confined.')
    }
    const location = response.headers.get('location')
    if (!location) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_FETCH_FAILED', 'Descriptor redirect omitted Location.')
    const next = new URL(location, current)
    assertSafeRemoteUrl(next.href, 'share')
    if (next.origin !== initialOrigin) throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_FETCH_FAILED', 'Cross-origin descriptor redirect is forbidden.')
    await response.body?.cancel()
    current = next
  }
  if (!response || !response.ok || response.type === 'opaque' || response.type === 'opaqueredirect') {
    await response?.body?.cancel()
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_FETCH_FAILED', `Descriptor fetch returned HTTP ${response?.status ?? 0}.`)
  }
  if (response.url) {
    const final = new URL(response.url)
    assertSafeRemoteUrl(final.href, 'share')
    if (final.origin !== initialOrigin) {
      await response.body?.cancel()
      throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_FETCH_FAILED', 'Final descriptor response changed origin.')
    }
  }
  const bytes = await readAtMost(response, MAX_SHARE_DESCRIPTOR_BYTES_V1, options.signal)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'Descriptor is not UTF-8.', cause)
  }
  const raw = parseStrictJson(text)
  let canonical: string
  try {
    canonical = canonicalizeJson(raw as JsonValue)
  } catch (cause) {
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_INVALID', 'Descriptor cannot be canonicalized.', cause)
  }
  const actualHash = sha256DigestV1(new TextEncoder().encode(canonical))
  if (actualHash !== expectedShareHash) {
    throw new ShareDescriptorErrorV1('SHARE_DESCRIPTOR_HASH_MISMATCH', `Expected ${expectedShareHash}, received ${actualHash}.`)
  }
  return validateShareDescriptorV1(raw)
}

export async function resolveShareRequestDescriptorV1(
  request: PortableShareRequestV1,
  options: Parameters<typeof fetchShareDescriptorV1>[2] = {},
): Promise<ShareDescriptorV1> {
  return request.mode === 'inline'
    ? request.descriptor
    : await fetchShareDescriptorV1(request.descriptorUrl, request.shareHash, options)
}

/** Exported for closed-mode ambiguity tests and browser routing. */
export const SHARE_INLINE_IDENTITY_AND_VIEW_KEYS_V1: readonly string[] = INLINE_IDENTITY_AND_VIEW_KEYS
