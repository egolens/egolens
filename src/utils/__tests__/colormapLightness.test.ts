/**
 * Colormap ramps must stay visible against the viewport they are drawn on.
 *
 * Every ramp used to begin at L* 3.8–15 against a background of L* 3.8.
 * `elongation`'s lowest stop was 1.00:1 — to the eye, the background. A weak
 * LiDAR return should be quiet, not absent, and nothing was checking.
 *
 * The ceiling exists for the same reason at the other end, and follows
 * Kovesi's advice to keep a map's lightness inside its background rather than
 * running to the extremes (https://arxiv.org/abs/1509.03700).
 */

import { describe, it, expect } from 'vitest'
import { COLORMAP_STOPS } from '../colormaps'
import { colors } from '../../theme'

/** Relative luminance, per WCAG. */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function lightness(rgb: [number, number, number]): number {
  const y = luminance(rgb)
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y
}

function contrast(rgb: [number, number, number], bg: [number, number, number]): number {
  const [a, b] = [luminance(rgb), luminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
]

/** The gradient ramps. segment/panoptic/camera alias intensity as placeholders. */
const RAMPS = ['intensity', 'range', 'elongation', 'distance'] as const

const FLOOR = 30
const CEILING = 92.5

describe.each(RAMPS)('%s ramp', (mode) => {
  const stops = COLORMAP_STOPS[mode]

  it('has every stop inside the lightness band', () => {
    const out = stops
      .map((s, i) => ({ i, L: +lightness(s).toFixed(1) }))
      .filter(({ L }) => L < FLOOR || L > CEILING)
    expect(out, `stops outside L* [${FLOOR}, ${CEILING}]`).toEqual([])
  })

  it('rises monotonically in lightness, so the ordering cue survives', () => {
    const Ls = stops.map(lightness)
    for (let i = 1; i < Ls.length; i++) {
      expect(Ls[i], `stop ${i} is darker than stop ${i - 1}`).toBeGreaterThan(Ls[i - 1])
    }
  })

  it('is visible against the default viewport background', () => {
    // Not a WCAG text threshold — 3:1 is unreachable at both ends at once (see
    // the note in colormaps.ts). This asserts "distinguishable from the
    // background", which is what 1.00:1 was not.
    const bg = hexToRgb(colors.bgDeep)
    const worst = Math.min(...stops.map((s) => contrast(s, bg)))
    expect(worst).toBeGreaterThan(1.9)
  })
})

describe('intensity carries its signal in hue, not luminance', () => {
  // The old ramp was a cool greyscale: on a background flip, the whole scale
  // collapsed. Chroma is what makes it survive.
  const chroma = (rgb: [number, number, number]) => Math.max(...rgb) - Math.min(...rgb)

  it('is not a greyscale', () => {
    const mean = COLORMAP_STOPS.intensity.reduce((s, c) => s + chroma(c), 0)
      / COLORMAP_STOPS.intensity.length
    expect(mean).toBeGreaterThan(0.4)
  })

  it('sweeps hue rather than repeating one', () => {
    const hue = (rgb: [number, number, number]) => {
      const [r, g, b] = rgb
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
      if (d === 0) return 0
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      return (h * 60 + 360) % 360
    }
    const hues = COLORMAP_STOPS.intensity.map(hue)
    expect(new Set(hues.map((h) => Math.round(h / 40))).size).toBeGreaterThanOrEqual(4)
  })
})
