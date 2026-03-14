/**
 * Unit tests for colormaps.ts — color utilities, palettes, and interpolation.
 *
 * Covers: colormapColor, rgbToHsl, hslToRgb, srgbToLinear, instanceColor,
 *         palette integrity, and ATTR_OFFSET / ATTR_RANGE completeness.
 */

import { describe, it, expect } from 'vitest'
import {
  COLORMAP_STOPS,
  ATTR_OFFSET,
  ATTR_RANGE,
  LIDARSEG_PALETTE,
  LIDARSEG_LABELS,
  colormapColor,
  rgbToHsl,
  hslToRgb,
  srgbToLinear,
  instanceColor,
} from '../colormaps'
import type { ColormapMode } from '../../stores/useSceneStore'

// ---------------------------------------------------------------------------
// colormapColor — gradient interpolation
// ---------------------------------------------------------------------------

describe('colormapColor', () => {
  const SIMPLE_STOPS: [number, number, number][] = [
    [0, 0, 0],
    [1, 1, 1],
  ]

  it('returns first stop at t=0', () => {
    expect(colormapColor(SIMPLE_STOPS, 0)).toEqual([0, 0, 0])
  })

  it('returns last stop at t=1', () => {
    expect(colormapColor(SIMPLE_STOPS, 1)).toEqual([1, 1, 1])
  })

  it('interpolates midpoint', () => {
    const [r, g, b] = colormapColor(SIMPLE_STOPS, 0.5)
    expect(r).toBeCloseTo(0.5, 5)
    expect(g).toBeCloseTo(0.5, 5)
    expect(b).toBeCloseTo(0.5, 5)
  })

  it('clamps t < 0 to first stop', () => {
    expect(colormapColor(SIMPLE_STOPS, -1)).toEqual([0, 0, 0])
  })

  it('clamps t > 1 to last stop', () => {
    expect(colormapColor(SIMPLE_STOPS, 2)).toEqual([1, 1, 1])
  })

  it('works with multi-stop gradients', () => {
    const stops: [number, number, number][] = [
      [0, 0, 0],
      [0.5, 0.5, 0.5],
      [1, 1, 1],
    ]
    const [r] = colormapColor(stops, 0.25)
    expect(r).toBeCloseTo(0.25, 5)
  })
})

// ---------------------------------------------------------------------------
// Color space conversions
// ---------------------------------------------------------------------------

describe('rgbToHsl / hslToRgb roundtrip', () => {
  const cases: [number, number, number][] = [
    [1, 0, 0],       // pure red
    [0, 1, 0],       // pure green
    [0, 0, 1],       // pure blue
    [0.5, 0.5, 0.5], // gray
    [0, 0, 0],       // black
    [1, 1, 1],       // white
    [0.85, 0.33, 0.10], // nuScenes adult pedestrian color
  ]

  for (const [r, g, b] of cases) {
    it(`roundtrips (${r}, ${g}, ${b})`, () => {
      const [h, s, l] = rgbToHsl(r, g, b)
      const [r2, g2, b2] = hslToRgb(h, s, l)
      expect(r2).toBeCloseTo(r, 4)
      expect(g2).toBeCloseTo(g, 4)
      expect(b2).toBeCloseTo(b, 4)
    })
  }

  it('gray produces zero saturation', () => {
    const [, s] = rgbToHsl(0.5, 0.5, 0.5)
    expect(s).toBe(0)
  })

  it('pure red has hue ~0', () => {
    const [h] = rgbToHsl(1, 0, 0)
    expect(h).toBeCloseTo(0, 5)
  })
})

describe('srgbToLinear', () => {
  it('maps 0 → 0', () => {
    expect(srgbToLinear(0)).toBe(0)
  })

  it('maps 1 → 1', () => {
    expect(srgbToLinear(1)).toBeCloseTo(1, 6)
  })

  it('low values use linear segment (c / 12.92)', () => {
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 6)
  })

  it('mid values use gamma curve', () => {
    const mid = srgbToLinear(0.5)
    // sRGB 0.5 → linear ~0.214
    expect(mid).toBeCloseTo(0.214, 2)
  })

  it('is monotonically increasing', () => {
    let prev = 0
    for (let i = 1; i <= 100; i++) {
      const v = srgbToLinear(i / 100)
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
  })
})

// ---------------------------------------------------------------------------
// instanceColor
// ---------------------------------------------------------------------------

describe('instanceColor', () => {
  it('returns base palette color for instance 0 (stuff classes)', () => {
    const color = instanceColor(17, 0) // vehicle.car
    expect(color).toEqual(LIDARSEG_PALETTE[17])
  })

  it('returns varied color for non-zero instance (thing classes)', () => {
    const base = instanceColor(2, 0)  // adult pedestrian, instance 0
    const inst1 = instanceColor(2, 1) // adult pedestrian, instance 1
    // Should differ (different lightness)
    const diff = Math.abs(base[0] - inst1[0]) + Math.abs(base[1] - inst1[1]) + Math.abs(base[2] - inst1[2])
    expect(diff).toBeGreaterThan(0.01)
  })

  it('different instances get different colors', () => {
    const a = instanceColor(17, 1)
    const b = instanceColor(17, 2)
    const diff = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
    expect(diff).toBeGreaterThan(0.01)
  })

  it('falls back to palette[0] for out-of-range label', () => {
    const color = instanceColor(999, 0)
    expect(color).toEqual(LIDARSEG_PALETTE[0])
  })

  it('returns RGB values in [0, 1] range', () => {
    for (let label = 0; label < 32; label++) {
      for (const inst of [0, 1, 5, 100]) {
        const [r, g, b] = instanceColor(label, inst)
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThanOrEqual(1)
        expect(g).toBeGreaterThanOrEqual(0)
        expect(g).toBeLessThanOrEqual(1)
        expect(b).toBeGreaterThanOrEqual(0)
        expect(b).toBeLessThanOrEqual(1)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Palette & lookup table integrity
// ---------------------------------------------------------------------------

describe('palette integrity', () => {
  it('LIDARSEG_PALETTE has 32 entries', () => {
    expect(LIDARSEG_PALETTE).toHaveLength(32)
  })

  it('LIDARSEG_LABELS has 32 entries', () => {
    expect(LIDARSEG_LABELS).toHaveLength(32)
  })

  it('all palette entries are valid RGB in [0, 1]', () => {
    for (const [r, g, b] of LIDARSEG_PALETTE) {
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(1)
    }
  })
})

describe('COLORMAP_STOPS / ATTR_OFFSET / ATTR_RANGE completeness', () => {
  const ALL_MODES: ColormapMode[] = ['intensity', 'range', 'elongation', 'distance', 'segment', 'panoptic', 'camera']

  it('COLORMAP_STOPS has entry for every ColormapMode', () => {
    for (const mode of ALL_MODES) {
      expect(COLORMAP_STOPS[mode]).toBeDefined()
      expect(COLORMAP_STOPS[mode].length).toBeGreaterThanOrEqual(2)
    }
  })

  it('ATTR_OFFSET has entry for every ColormapMode', () => {
    for (const mode of ALL_MODES) {
      expect(ATTR_OFFSET[mode]).toBeDefined()
    }
  })

  it('ATTR_RANGE has entry for every ColormapMode', () => {
    for (const mode of ALL_MODES) {
      expect(ATTR_RANGE[mode]).toBeDefined()
      const [min, max] = ATTR_RANGE[mode]
      expect(max).toBeGreaterThan(min)
    }
  })
})
