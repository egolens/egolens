import { describe, expect, it, vi } from 'vitest'
import {
  canonicalShareDescriptorV1,
  decodePortableShareRequestV1,
  encodeInlineShareUrlV1,
  encodeReferencedShareUrlV1,
  fetchShareDescriptorV1,
  ShareDescriptorErrorV1,
  shareDescriptorHashV1,
  validateShareDescriptorV1,
  type ShareDescriptorV1,
} from '../share/ShareDescriptor'
import { sha256DigestV1 } from '../source/sha256'
import { canonicalizeJson } from '../recipe/canonicalize'
import type { JsonValue } from '../recipe/types'

const A = `sha256:${'a'.repeat(64)}`
const B = `sha256:${'b'.repeat(64)}`
const C = `sha256:${'c'.repeat(64)}`

function descriptor(): ShareDescriptorV1 {
  return {
    schema: 'egolens-share-v1',
    source: {
      rootUrl: 'https://data.example/source/',
      catalogUrl: 'https://data.example/catalog.json',
      catalogHash: A,
      sourceManifestHash: B,
    },
    recipe: { url: 'https://recipes.example/waymo.json', recipeHash: C },
    view: { sceneId: 'scene/one', frameIndex: 0, t0: '100', t1: '200' },
    presentation: {
      cameraStrip: true,
      coordinateMode: 'ego',
      visibleSensorIds: ['lidar-front', 'lidar-top'],
      activeCameraId: null,
      colormap: 'intensity',
      boxMode: 'box',
      trailLength: 10,
      pointSize: 0.08,
      pointOpacity: 0.85,
      overlays: {
        lidarProjection: false,
        keypoints3d: false,
        keypoints2d: true,
        cameraSegmentation: false,
      },
      playbackSpeed: 1,
      followCamera: false,
      cameraPose: {
        position: [1.25, -2, 3],
        target: [0, 0, 0],
        azimuth: -0.5,
        distance: 3.25,
      },
      theme: 'dark',
      accent: 'FF6F00',
    },
  }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error('Expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(ShareDescriptorErrorV1)
    expect((error as ShareDescriptorErrorV1).code).toBe(code)
  }
}

describe('ShareDescriptorV1', () => {
  it('canonicalizes and hashes the complete closed descriptor', () => {
    const value = validateShareDescriptorV1(descriptor())
    expect(Object.isFrozen(value.presentation.overlays)).toBe(true)
    expect(canonicalShareDescriptorV1(value)).toBe(canonicalizeJson(value as unknown as JsonValue))
    expect(shareDescriptorHashV1(value)).toMatch(/^sha256:[0-9a-f]{64}$/u)

    expectCode(() => validateShareDescriptorV1({ ...descriptor(), surprise: true }), 'SHARE_DESCRIPTOR_INVALID')
    expectCode(() => validateShareDescriptorV1({
      ...descriptor(),
      source: { ...descriptor().source, rootUrl: 'https://user:secret@data.example/' },
    }), 'SHARE_URL_INVALID')
    expectCode(() => validateShareDescriptorV1({
      ...descriptor(),
      recipe: { ...descriptor().recipe, url: 'https://recipes.example/r.json?token=secret' },
    }), 'SHARE_CREDENTIAL_LEAKAGE')
  })

  it('accepts JSON sensor order while the URL encoder canonicalizes it, and validates int64 windows', () => {
    const unsorted = validateShareDescriptorV1({
      ...descriptor(),
      presentation: { ...descriptor().presentation, visibleSensorIds: ['lidar-top', 'lidar-front'] },
    })
    expect(new URL(encodeInlineShareUrlV1('https://viewer.example/', unsorted)).searchParams.get('sensors'))
      .toBe('lidar-front,lidar-top')
    expectCode(() => validateShareDescriptorV1({
      ...descriptor(),
      view: { sceneId: 'scene', frameIndex: 0, t0: '1' },
    }), 'SHARE_DESCRIPTOR_INVALID')
    expectCode(() => validateShareDescriptorV1({
      ...descriptor(),
      view: { sceneId: 'scene', frameIndex: 0, t0: '9223372036854775808', t1: '9223372036854775808' },
    }), 'SHARE_DESCRIPTOR_INVALID')
  })

  it('round-trips every inline value, including explicit defaults and frame zero', () => {
    const original = descriptor()
    const encoded = encodeInlineShareUrlV1('https://viewer.example/app?legacy=1#ignored', original, {
      embed: 'true', controls: 'minimal', origin: 'https://host.example',
    })
    const url = new URL(encoded)
    expect(url.searchParams.get('frame')).toBe('0')
    expect(url.searchParams.get('cameras')).toBe('1')
    expect(url.searchParams.get('world')).toBe('0')
    expect(url.searchParams.get('cam')).toBe('none')
    expect(url.searchParams.get('lidar2d')).toBe('0')
    expect(url.searchParams.get('kp2d')).toBe('1')
    expect(url.searchParams.get('cp')).toBe('1.25,-2,3')
    expect(url.searchParams.get('theme')).toBe('dark')
    expect(url.hash).toBe('')
    expect(decodePortableShareRequestV1(encoded)).toEqual({
      mode: 'inline', descriptor: validateShareDescriptorV1(original),
      envelope: { embed: 'true', controls: 'minimal', origin: 'https://host.example' },
    })
  })

  it('encodes empty selections and default accent explicitly', () => {
    const value = {
      ...descriptor(),
      view: { sceneId: 'scene', frameIndex: 0 },
      presentation: { ...descriptor().presentation, visibleSensorIds: [], accent: null },
    }
    const encoded = encodeInlineShareUrlV1('https://viewer.example/', value)
    expect(new URL(encoded).searchParams.get('sensors')).toBe('none')
    expect(new URL(encoded).searchParams.get('accent')).toBe('default')
    const decoded = decodePortableShareRequestV1(encoded)
    expect(decoded?.mode === 'inline' && decoded.descriptor).toEqual(validateShareDescriptorV1(value))
  })

  it('rejects noncanonical or incomplete inline forms and reference mixing', () => {
    const encoded = new URL(encodeInlineShareUrlV1('https://viewer.example/', descriptor()))
    encoded.searchParams.set('ps', '0.080')
    expectCode(() => decodePortableShareRequestV1(encoded.href), 'SHARE_INLINE_INVALID')

    const missing = new URL(encodeInlineShareUrlV1('https://viewer.example/', descriptor()))
    missing.searchParams.delete('frame')
    expectCode(() => decodePortableShareRequestV1(missing.href), 'SHARE_INLINE_INVALID')

    const reference = `${encodeReferencedShareUrlV1('https://viewer.example/', 'https://share.example/v.json', A)}&scene=x`
    expectCode(() => decodePortableShareRequestV1(reference), 'SHARE_DESCRIPTOR_AMBIGUOUS')
    expect(decodePortableShareRequestV1('https://viewer.example/?dataset=waymo&frame=2')).toBeNull()
  })

  it('verifies a referenced descriptor hash before schema validation', async () => {
    const malformed = { schema: 'wrong', secretExtra: true }
    const text = JSON.stringify(malformed)
    const actual = sha256DigestV1(new TextEncoder().encode(canonicalizeJson(malformed as unknown as JsonValue)))
    const fetcher = vi.fn(async () => new Response(text, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(text.length) },
    })) as unknown as typeof fetch

    await expect(fetchShareDescriptorV1('https://share.example/view.json', A, { fetch: fetcher }))
      .rejects.toMatchObject({ code: 'SHARE_DESCRIPTOR_HASH_MISMATCH' })
    await expect(fetchShareDescriptorV1('https://share.example/view.json', actual, { fetch: fetcher }))
      .rejects.toMatchObject({ code: 'SHARE_DESCRIPTOR_INVALID' })
  })

  it('fetches a referenced descriptor with omit/no-referrer and a bounded body', async () => {
    const value = descriptor()
    const text = canonicalShareDescriptorV1(value)
    const fetcher = vi.fn(async () => new Response(text, {
      status: 200,
      headers: { 'content-length': String(new TextEncoder().encode(text).byteLength) },
    })) as unknown as typeof fetch
    await expect(fetchShareDescriptorV1(
      'https://share.example/view.json', shareDescriptorHashV1(value), { fetch: fetcher },
    )).resolves.toEqual(validateShareDescriptorV1(value))
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual',
    }))
  })
})
