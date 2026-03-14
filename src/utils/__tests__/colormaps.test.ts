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
  computePointColor,
} from '../colormaps'
import { WAYMO_SEG_PALETTE } from '../waymoSemanticClasses'
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

  it('uses custom palette when provided (Waymo)', () => {
    const color = instanceColor(1, 0, WAYMO_SEG_PALETTE) // Waymo class 1 = Car
    expect(color).toEqual(WAYMO_SEG_PALETTE[1])
  })

  it('varies lightness per instance with custom palette', () => {
    const base = instanceColor(10, 0, WAYMO_SEG_PALETTE)  // Waymo Pedestrian, inst 0
    const inst1 = instanceColor(10, 1, WAYMO_SEG_PALETTE)  // Waymo Pedestrian, inst 1
    const diff = Math.abs(base[0] - inst1[0]) + Math.abs(base[1] - inst1[1]) + Math.abs(base[2] - inst1[2])
    expect(diff).toBeGreaterThan(0.01)
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

// ---------------------------------------------------------------------------
// computePointColor — unified color computation
// ---------------------------------------------------------------------------

describe('computePointColor', () => {
  const SIMPLE_STOPS: [number, number, number][] = [[0, 0, 0], [1, 1, 1]]
  const stride = 6 // x, y, z, intensity, range, elongation

  /** Helper: create positions buffer for one point */
  function makePositions(x: number, y: number, z: number, intensity = 0.5, range = 20, elongation = 0.3): Float32Array {
    return new Float32Array([x, y, z, intensity, range, elongation])
  }

  it('segment mode: looks up palette by label', () => {
    const pos = makePositions(1, 2, 3)
    const segLabels = new Uint8Array([17]) // vehicle.car
    const [r, g, b] = computePointColor('segment', 0, pos, stride, SIMPLE_STOPS, -2, 0, 31, segLabels)
    expect(r).toBeCloseTo(LIDARSEG_PALETTE[17][0])
    expect(g).toBeCloseTo(LIDARSEG_PALETTE[17][1])
    expect(b).toBeCloseTo(LIDARSEG_PALETTE[17][2])
  })

  it('segment mode: falls back to label 0 for missing segLabels', () => {
    const pos = makePositions(1, 2, 3)
    const [r, g, b] = computePointColor('segment', 0, pos, stride, SIMPLE_STOPS, -2, 0, 31, null)
    expect(r).toBe(LIDARSEG_PALETTE[0][0])
    expect(g).toBe(LIDARSEG_PALETTE[0][1])
    expect(b).toBe(LIDARSEG_PALETTE[0][2])
  })

  it('panoptic mode: stuff class (inst=0) returns palette color', () => {
    const pos = makePositions(1, 2, 3)
    const panopticLabels = new Int32Array([17000]) // sem=17, inst=0
    const [r, g, b] = computePointColor('panoptic', 0, pos, stride, SIMPLE_STOPS, -3, 0, 31, null, panopticLabels)
    expect(r).toBeCloseTo(LIDARSEG_PALETTE[17][0])
    expect(g).toBeCloseTo(LIDARSEG_PALETTE[17][1])
    expect(b).toBeCloseTo(LIDARSEG_PALETTE[17][2])
  })

  it('panoptic mode: thing class (inst>0) varies from palette', () => {
    const pos = makePositions(1, 2, 3)
    const panopticLabels = new Int32Array([17005]) // sem=17, inst=5
    const [r, g, b] = computePointColor('panoptic', 0, pos, stride, SIMPLE_STOPS, -3, 0, 31, null, panopticLabels)
    const base = LIDARSEG_PALETTE[17]
    const diff = Math.abs(r - base[0]) + Math.abs(g - base[1]) + Math.abs(b - base[2])
    expect(diff).toBeGreaterThan(0.01)
  })

  it('intensity mode: reads attribute at offset 3', () => {
    // intensity = 0.5 → t = (0.5 - 0) / 1 = 0.5
    const pos = makePositions(0, 0, 10, 0.5)
    const stops = COLORMAP_STOPS['intensity']
    const [attrMin, attrMax] = ATTR_RANGE['intensity']
    const [r, g, b] = computePointColor('intensity', 0, pos, stride, stops, 3, attrMin, attrMax - attrMin)
    // Should return midpoint of intensity gradient
    const expected = colormapColor(stops, 0.5)
    expect(r).toBeCloseTo(expected[0], 5)
    expect(g).toBeCloseTo(expected[1], 5)
    expect(b).toBeCloseTo(expected[2], 5)
  })

  it('distance mode: computes sqrt(x²+y²+z²)', () => {
    // Point at (3, 4, 0) → distance = 5
    const pos = makePositions(3, 4, 0)
    const stops = COLORMAP_STOPS['distance']
    const [attrMin, attrMax] = ATTR_RANGE['distance']
    const [r, g, b] = computePointColor('distance', 0, pos, stride, stops, -1, attrMin, attrMax - attrMin)
    const expected = colormapColor(stops, 5 / 50)
    expect(r).toBeCloseTo(expected[0], 5)
    expect(g).toBeCloseTo(expected[1], 5)
    expect(b).toBeCloseTo(expected[2], 5)
  })

  it('clamps normalized value to [0, 1]', () => {
    // Very far point → distance > 50 → should clamp
    const pos = makePositions(100, 0, 0)
    const stops = COLORMAP_STOPS['distance']
    const [r, g, b] = computePointColor('distance', 0, pos, stride, stops, -1, 0, 50)
    const expected = colormapColor(stops, 1)
    expect(r).toBeCloseTo(expected[0], 5)
    expect(g).toBeCloseTo(expected[1], 5)
    expect(b).toBeCloseTo(expected[2], 5)
  })

  it('returns values in [0, 1] range for all modes', () => {
    const pos = makePositions(5, 5, 5, 0.7, 30, 0.4)
    for (const mode of ['intensity', 'range', 'elongation', 'distance', 'segment', 'panoptic'] as const) {
      const stops = COLORMAP_STOPS[mode]
      const off = ATTR_OFFSET[mode]
      const [min, max] = ATTR_RANGE[mode]
      const [r, g, b] = computePointColor(mode, 0, pos, stride, stops, off, min, max - min)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(1)
    }
  })

  it('segment mode: uses custom palette (Waymo) when provided', () => {
    const pos = makePositions(1, 2, 3)
    const segLabels = new Uint8Array([1]) // Waymo class 1 = Car
    const [r, g, b] = computePointColor(
      'segment', 0, pos, stride, SIMPLE_STOPS, -2, 0, 31,
      segLabels, null, WAYMO_SEG_PALETTE,
    )
    expect(r).toBeCloseTo(WAYMO_SEG_PALETTE[1][0])
    expect(g).toBeCloseTo(WAYMO_SEG_PALETTE[1][1])
    expect(b).toBeCloseTo(WAYMO_SEG_PALETTE[1][2])
  })

  it('panoptic mode: uses custom palette (Waymo) when provided', () => {
    const pos = makePositions(1, 2, 3)
    const panopticLabels = new Int32Array([1000]) // Waymo sem=1 (Car), inst=0
    const [r, g, b] = computePointColor(
      'panoptic', 0, pos, stride, SIMPLE_STOPS, -3, 0, 31,
      null, panopticLabels, WAYMO_SEG_PALETTE,
    )
    expect(r).toBeCloseTo(WAYMO_SEG_PALETTE[1][0])
    expect(g).toBeCloseTo(WAYMO_SEG_PALETTE[1][1])
    expect(b).toBeCloseTo(WAYMO_SEG_PALETTE[1][2])
  })

  it('segment mode without palette falls back to LIDARSEG_PALETTE (backward compat)', () => {
    const pos = makePositions(1, 2, 3)
    const segLabels = new Uint8Array([17]) // nuScenes vehicle.car
    const [r, g, b] = computePointColor('segment', 0, pos, stride, SIMPLE_STOPS, -2, 0, 31, segLabels)
    expect(r).toBeCloseTo(LIDARSEG_PALETTE[17][0])
    expect(g).toBeCloseTo(LIDARSEG_PALETTE[17][1])
    expect(b).toBeCloseTo(LIDARSEG_PALETTE[17][2])
  })
})

// ---------------------------------------------------------------------------

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
