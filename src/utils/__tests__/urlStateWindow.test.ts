/**
 * @vitest-environment happy-dom
 *
 * Time-window params (t0/t1) round-trip and the embed-param preservation
 * fix in syncSegmentToUrl.
 */
import { describe, it, expect, vi } from 'vitest'
import { parseViewParams, buildShareUrl, syncSegmentToUrl, setUrlSource } from '../urlState'

describe('parseViewParams t0/t1', () => {
  it('parses a digit pair as strings (int64-safe)', () => {
    const state = parseViewParams('?t0=315969909862964000&t1=315969916359611000')
    expect(state.t0).toBe('315969909862964000')
    expect(state.t1).toBe('315969916359611000')
  })

  it('requires both bounds', () => {
    expect(parseViewParams('?t0=315969909862964000').t0).toBeUndefined()
    expect(parseViewParams('?t1=315969916359611000').t1).toBeUndefined()
  })

  it('rejects non-digit values', () => {
    const state = parseViewParams('?t0=12.5&t1=315969916359611000')
    expect(state.t0).toBeUndefined()
    expect(state.t1).toBeUndefined()
  })
})

describe('buildShareUrl t0/t1', () => {
  it('carries the active window', () => {
    const url = buildShareUrl({ dataset: 'argoverse2', t0: '100', t1: '200' })
    const params = new URL(url).searchParams
    expect(params.get('t0')).toBe('100')
    expect(params.get('t1')).toBe('200')
  })

  it('omits a half-open window', () => {
    const url = buildShareUrl({ dataset: 'argoverse2', t0: '100' })
    expect(new URL(url).searchParams.get('t0')).toBeNull()
  })
})

describe('syncSegmentToUrl embed-param preservation', () => {
  it('keeps embed-mode params and drops per-scene ones on scene switch', () => {
    // happy-dom's replaceState doesn't reflect into window.location — set the
    // location directly and capture what the function writes via a spy.
    window.location.href =
      'http://localhost/?dataset=nuscenes&data=http%3A%2F%2Fx%2F&scene=old&embed=true&controls=minimal&t0=100&t1=200'
    expect(window.location.search).toContain('embed=true')
    const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    setUrlSource('nuscenes', 'http://x/')

    syncSegmentToUrl('scene-new')

    expect(spy).toHaveBeenCalledTimes(1)
    const writtenUrl = String(spy.mock.calls[0][2])
    const params = new URLSearchParams(writtenUrl.split('?')[1] ?? '')
    spy.mockRestore()
    expect(params.get('scene')).toBe('scene-new')
    // The page-level embed params survive the sync…
    expect(params.get('embed')).toBe('true')
    expect(params.get('controls')).toBe('minimal')
    // …while the per-scene window does not
    expect(params.get('t0')).toBeNull()
    expect(params.get('t1')).toBeNull()
  })
})
