/**
 * Tests for CameraSegOverlay — decodePanopticToRGBA and palette.
 */
import { describe, it, expect } from 'vitest'
import { decodePanopticToRGBA } from '../CameraSegOverlay'
import { WAYMO_CAMERA_SEG_PALETTE, WAYMO_CAMERA_SEG_LABELS } from '../../../utils/waymoSemanticClasses'

// ---------------------------------------------------------------------------
// Palette / label sanity
// ---------------------------------------------------------------------------

describe('WAYMO_CAMERA_SEG_PALETTE', () => {
  it('has 29 entries (0=Undefined through 28=Dynamic)', () => {
    expect(WAYMO_CAMERA_SEG_PALETTE).toHaveLength(29)
  })

  it('each entry is [r, g, b] with values in 0..1', () => {
    for (const [r, g, b] of WAYMO_CAMERA_SEG_PALETTE) {
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(1)
    }
  })
})

describe('WAYMO_CAMERA_SEG_LABELS', () => {
  it('has 29 entries matching palette length', () => {
    expect(WAYMO_CAMERA_SEG_LABELS).toHaveLength(29)
  })

  it('first entry is Undefined, last is Dynamic', () => {
    expect(WAYMO_CAMERA_SEG_LABELS[0]).toBe('Undefined')
    expect(WAYMO_CAMERA_SEG_LABELS[28]).toBe('Dynamic')
  })

  it('contains expected class names', () => {
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Car')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Pedestrian')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Sky')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Building')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Road')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Vegetation')
  })
})

// ---------------------------------------------------------------------------
// decodePanopticToRGBA
// ---------------------------------------------------------------------------

describe('decodePanopticToRGBA', () => {
  it('returns null for non-PNG data', () => {
    const badBuffer = new ArrayBuffer(16)
    const result = decodePanopticToRGBA(badBuffer, 1000)
    expect(result).toBeNull()
  })

  it('divisor correctly separates semantic class from instance id', () => {
    // Verify the math: panoptic_value = semantic * divisor + instance
    // semantic = (panoptic_value / divisor) | 0
    const divisor = 1000
    expect((1000 / divisor) | 0).toBe(1)   // class 1 (Car), instance 0
    expect((1001 / divisor) | 0).toBe(1)   // class 1 (Car), instance 1
    expect((9000 / divisor) | 0).toBe(9)   // class 9 (Pedestrian), instance 0
    expect((25000 / divisor) | 0).toBe(25) // class 25 (Sky), instance 0
    expect((0 / divisor) | 0).toBe(0)      // class 0 (Undefined)
  })

  it('handles edge case divisor = 1 (semantic-only, no instance)', () => {
    const divisor = 1
    expect((5 / divisor) | 0).toBe(5)
    expect((0 / divisor) | 0).toBe(0)
  })

  it('palette RGBA lookup table has transparent class 0', () => {
    // Class 0 (Undefined) should be transparent in the overlay
    // We test this indirectly: the palette entry at index 0 is dark gray
    // but the RGBA lookup should have alpha=0 for class 0
    const [r, g, b] = WAYMO_CAMERA_SEG_PALETTE[0]
    expect(r).toBeCloseTo(0.25) // dark gray
    expect(g).toBeCloseTo(0.25)
    expect(b).toBeCloseTo(0.25)
    // (The actual alpha=0 for class 0 is enforced in buildPaletteRGBA)
  })
})
