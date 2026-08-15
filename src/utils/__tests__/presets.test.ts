/**
 * Unit tests for presets.ts.
 *
 * isPresetUrl decides whether a load counts as "evaluating EgoLens" or
 * "using EgoLens on real data" — the one number the adoption plan turns on.
 * Getting it wrong is worse than not measuring, because the answer still looks
 * authoritative. These tests pin the boundary cases that would silently skew it.
 */

import { describe, it, expect } from 'vitest'
import { PRESETS, isPresetUrl } from '../presets'

describe('PRESETS', () => {
  it('every preset has a usable absolute URL', () => {
    expect(PRESETS.length).toBeGreaterThan(0)
    for (const preset of PRESETS) {
      expect(() => new URL(preset.url)).not.toThrow()
      expect(preset.url.startsWith('https://')).toBe(true)
      expect(preset.label.length).toBeGreaterThan(0)
    }
  })

  it('recognises each of its own URLs, including split chips', () => {
    for (const preset of PRESETS) {
      expect(isPresetUrl(preset.url)).toBe(true)
      for (const split of preset.splits ?? []) {
        expect(isPresetUrl(split.url)).toBe(true)
      }
    }
  })
})

describe('isPresetUrl', () => {
  const nuscenes = 'https://data.egolens.org/nuscenes/'

  it('ignores a trailing slash', () => {
    // Share links, the URL form, and the preset button each normalise
    // differently; a slash must not flip the classification.
    expect(isPresetUrl(nuscenes)).toBe(true)
    expect(isPresetUrl(nuscenes.replace(/\/$/, ''))).toBe(true)
    expect(isPresetUrl(`${nuscenes}//`)).toBe(true)
  })

  it('ignores surrounding whitespace from a paste', () => {
    expect(isPresetUrl(`  ${nuscenes}  `)).toBe(true)
  })

  it('rejects a user’s own bucket', () => {
    expect(isPresetUrl('https://my-company-bucket.s3.amazonaws.com/logs/')).toBe(false)
    expect(isPresetUrl('http://localhost:8000/waymo_data/')).toBe(false)
  })

  it('rejects a different dataset in a bucket a preset happens to live in', () => {
    // The Argoverse bucket is public and holds more than the sensor dataset.
    // Someone browsing the lidar dataset brought their own target and must not
    // be counted as a demo visit, which is why the match is exact rather than
    // a prefix.
    expect(isPresetUrl('https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/lidar/train/')).toBe(false)
    expect(isPresetUrl('https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/')).toBe(false)
  })

  it('rejects a preset URL extended with a specific log', () => {
    expect(
      isPresetUrl('https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/val/02678d04-cc9f-3148-9f95-1ba66347dff9/'),
    ).toBe(false)
  })

  it('handles empty and junk input without throwing', () => {
    expect(isPresetUrl('')).toBe(false)
    expect(isPresetUrl('   ')).toBe(false)
    expect(isPresetUrl('not a url')).toBe(false)
  })
})
