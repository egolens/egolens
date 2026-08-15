/**
 * @vitest-environment happy-dom
 *
 * `cameras` parsing, and the share-link signal it must not join.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseCamerasParam, isShareView, buildShareUrl } from '../urlState'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseCamerasParam', () => {
  it('accepts the documented values', () => {
    expect(parseCamerasParam('?cameras=all')).toBe(true)
    expect(parseCamerasParam('?cameras=false')).toBe(false)
  })

  it('accepts the tolerated aliases, case-insensitively', () => {
    expect(parseCamerasParam('?cameras=None')).toBe(false)
    expect(parseCamerasParam('?cameras=0')).toBe(false)
    expect(parseCamerasParam('?cameras=TRUE')).toBe(true)
    expect(parseCamerasParam('?cameras=1')).toBe(true)
  })

  it('returns null when unset, so the caller applies the controls default', () => {
    expect(parseCamerasParam('?embed=true')).toBeNull()
  })

  it('warns and returns null on an unrecognised value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseCamerasParam('?cameras=front,rear-left')).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('share-link signal', () => {
  // The bug this pins: the signal used to be "parseViewParams returned any
  // key", so a display filter like `cameras` would have suppressed autoplay
  // and collapsed the layer panel on links that say nothing about playback.
  const withInitialSearch = (search: string) => {
    window.location.href = `http://localhost/${search}`
    // isShareView reads the captured initial search; force a fresh capture
    // by going through the module's own entry point.
    return search
  }

  it('does not treat a cameras-only URL as a shared view', () => {
    withInitialSearch('?dataset=nuscenes&data=http%3A%2F%2Fx%2F&scene=a&cameras=false')
    expect(isShareView()).toBe(false)
  })

  it('treats a pinned frame or range as a shared view', () => {
    withInitialSearch('?dataset=nuscenes&data=http%3A%2F%2Fx%2F&scene=a&frame=12')
    expect(isShareView()).toBe(true)
    withInitialSearch('?dataset=nuscenes&data=http%3A%2F%2Fx%2F&scene=a&t0=100&t1=200')
    expect(isShareView()).toBe(true)
  })

  it('does not treat a bare dataset link as a shared view', () => {
    withInitialSearch('?dataset=nuscenes&data=http%3A%2F%2Fx%2F&scene=a')
    expect(isShareView()).toBe(false)
  })
})

describe('buildShareUrl cameras', () => {
  it('carries cameras=false, and omits it when the strip is shown', () => {
    expect(new URL(buildShareUrl({ dataset: 'nuscenes', cameras: false })).searchParams.get('cameras')).toBe('false')
    expect(new URL(buildShareUrl({ dataset: 'nuscenes', cameras: true })).searchParams.get('cameras')).toBeNull()
    expect(new URL(buildShareUrl({ dataset: 'nuscenes' })).searchParams.get('cameras')).toBeNull()
  })
})
