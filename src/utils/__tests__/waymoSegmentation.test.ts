/**
 * Unit tests for Waymo segmentation — covers the three critical bugs discovered
 * during Phase A/B1 implementation:
 *
 * Bug 1: Seg channel order — Waymo stores [instance_id, semantic_class] per pixel,
 *         NOT [semantic, instance] as initially assumed. Reading channel 0 as
 *         semantic produced instance IDs (often -1) instead of class labels.
 *
 * Bug 2: Class ID mapping — The 23-class palette/labels array was ordered wrong
 *         (Motorcycle at 5 instead of Motorcyclist, Pedestrian at 10 instead of
 *         Pole, etc.). The correct order is from segmentation.proto.
 *
 * Bug 3: Non-TOP sensor fallback — Only the TOP sensor (laser_name=1) has seg
 *         labels. Other sensors must render as dim gray in segment/panoptic mode.
 */

import { describe, it, expect } from 'vitest'
import {
  WAYMO_SEG_PALETTE,
  WAYMO_SEG_LABELS,
  WAYMO_CAMERA_SEG_PALETTE,
  WAYMO_CAMERA_SEG_LABELS,
} from '../waymoSemanticClasses'
import { computePointColor } from '../colormaps'

// ---------------------------------------------------------------------------
// Bug 1: Seg range image channel order — [instance, semantic]
// ---------------------------------------------------------------------------

describe('Waymo seg range image channel order', () => {
  /**
   * Simulates the seg label extraction logic from waymoLidarWorker.ts.
   * This is the exact algorithm the worker uses — extracted here for testability.
   */
  function extractSegLabels(
    segValues: number[],
    shape: number[],
    validIndices: Uint32Array,
    pointCount: number,
  ): { segLabels: Uint8Array; panopticLabels: Uint16Array } {
    const C = shape.length >= 3 ? shape[2] : 1
    const segLabels = new Uint8Array(pointCount)
    const panopticLabels = new Uint16Array(pointCount)

    for (let i = 0; i < pointCount; i++) {
      const ri = validIndices[i]
      // Channel 0 = instance_id, Channel 1 = semantic_class
      const instId = segValues[ri * C] ?? 0
      const semClass = C >= 2 ? (segValues[ri * C + 1] ?? 0) : (segValues[ri * C] ?? 0)
      segLabels[i] = semClass
      panopticLabels[i] = semClass * 1000 + (instId >= 0 ? instId : 0)
    }
    return { segLabels, panopticLabels }
  }

  it('reads semantic class from channel 1, instance from channel 0', () => {
    // Simulate Waymo seg data: [inst, sem, inst, sem, ...]
    // Pixel 0: inst=-1, sem=14 (Building)
    // Pixel 1: inst=3,  sem=1  (Car)
    // Pixel 2: inst=-1, sem=18 (Road)
    const segValues = [-1, 14, 3, 1, -1, 18]
    const shape = [1, 3, 2] // H=1, W=3, C=2
    const validIndices = new Uint32Array([0, 1, 2])

    const { segLabels, panopticLabels } = extractSegLabels(segValues, shape, validIndices, 3)

    expect(segLabels[0]).toBe(14) // Building
    expect(segLabels[1]).toBe(1)  // Car
    expect(segLabels[2]).toBe(18) // Road

    // Panoptic = sem * 1000 + inst (inst=-1 clamped to 0)
    expect(panopticLabels[0]).toBe(14000) // Building, no instance
    expect(panopticLabels[1]).toBe(1003)  // Car, instance 3
    expect(panopticLabels[2]).toBe(18000) // Road, no instance
  })

  it('handles instance_id = -1 (no instance) gracefully', () => {
    // All pixels have inst=-1 (stuff classes like Road, Vegetation)
    const segValues = [-1, 18, -1, 15, -1, 17]
    const shape = [1, 3, 2]
    const validIndices = new Uint32Array([0, 1, 2])

    const { segLabels, panopticLabels } = extractSegLabels(segValues, shape, validIndices, 3)

    expect(segLabels[0]).toBe(18) // Road
    expect(segLabels[1]).toBe(15) // Vegetation
    expect(segLabels[2]).toBe(17) // Curb

    // inst=-1 clamped to 0 → panoptic = sem*1000+0
    expect(panopticLabels[0]).toBe(18000)
    expect(panopticLabels[1]).toBe(15000)
    expect(panopticLabels[2]).toBe(17000)
  })

  it('BUG REGRESSION: reading channel 0 as semantic would give instance IDs', () => {
    // This was the original bug — channel 0 has instance IDs
    const segValues = [-1, 14, 3, 1, -1, 18]
    const shape = [1, 3, 2]
    const validIndices = new Uint32Array([0, 1, 2])

    // WRONG: reading channel 0 as semantic (the old buggy code)
    const C = shape[2]
    const wrongSem0 = segValues[0 * C]     // -1 (instance!) — NOT a valid class
    const wrongSem1 = segValues[1 * C]     // 3  (instance!) — would show as "Bus"
    const wrongSem2 = segValues[2 * C]     // -1 (instance!)

    expect(wrongSem0).toBe(-1) // Not a valid semantic class
    expect(wrongSem1).toBe(3)  // Instance ID 3, but would be misread as "Bus"

    // CORRECT: reading channel 1 as semantic
    const { segLabels } = extractSegLabels(segValues, shape, validIndices, 3)
    expect(segLabels[0]).toBe(14) // Building ✓
    expect(segLabels[1]).toBe(1)  // Car ✓
    expect(segLabels[2]).toBe(18) // Road ✓
  })

  it('handles sparse validIndices (not every pixel is valid)', () => {
    // H=2, W=4, C=2 → 16 values
    // Only pixels 1, 5, 7 have range > 0
    const segValues = [
      -1, 0,   -1, 14,   -1, 0,   -1, 15,  // row 0: Undefined, Building, Undefined, Vegetation
      -1, 0,   2, 1,     -1, 18,  -1, 7,    // row 1: Undefined, Car(inst=2), Road, Pedestrian
    ]
    const shape = [2, 4, 2]
    const validIndices = new Uint32Array([1, 5, 7]) // pixels (0,1), (1,1), (1,3)

    const { segLabels } = extractSegLabels(segValues, shape, validIndices, 3)

    expect(segLabels[0]).toBe(14) // pixel (0,1) = Building
    expect(segLabels[1]).toBe(1)  // pixel (1,1) = Car
    expect(segLabels[2]).toBe(7)  // pixel (1,3) = Pedestrian
  })

  it('handles shape with C=1 fallback (single channel)', () => {
    const segValues = [14, 1, 18]
    const shape = [1, 3] // No C dimension
    const validIndices = new Uint32Array([0, 1, 2])

    const { segLabels } = extractSegLabels(segValues, shape, validIndices, 3)

    // With C=1, the single value is treated as semantic
    expect(segLabels[0]).toBe(14)
    expect(segLabels[1]).toBe(1)
    expect(segLabels[2]).toBe(18)
  })

  it('matches real Waymo data pattern: alternating -1 and valid classes', () => {
    // Actual raw data from diagnostic: -1, 15, -1, 15, -1, 15, -1, 14, -1, 14
    const segValues = [-1, 15, -1, 15, -1, 15, -1, 14, -1, 14]
    const shape = [1, 5, 2]
    const validIndices = new Uint32Array([0, 1, 2, 3, 4])

    const { segLabels } = extractSegLabels(segValues, shape, validIndices, 5)

    expect(segLabels[0]).toBe(15) // Vegetation
    expect(segLabels[1]).toBe(15) // Vegetation
    expect(segLabels[2]).toBe(15) // Vegetation
    expect(segLabels[3]).toBe(14) // Building
    expect(segLabels[4]).toBe(14) // Building

    // No -1 should leak into segLabels
    for (let i = 0; i < 5; i++) {
      expect(segLabels[i]).toBeGreaterThanOrEqual(0)
      expect(segLabels[i]).toBeLessThanOrEqual(22)
    }
  })
})

// ---------------------------------------------------------------------------
// Bug 2: Class ID mapping — must match segmentation.proto enum order
// ---------------------------------------------------------------------------

describe('Waymo seg class ID mapping (segmentation.proto)', () => {
  it('has exactly 23 classes (0–22)', () => {
    expect(WAYMO_SEG_PALETTE).toHaveLength(23)
    expect(WAYMO_SEG_LABELS).toHaveLength(23)
  })

  // Verify critical class IDs that were wrong before the fix
  const PROTO_MAPPING: [number, string][] = [
    [0, 'Undefined'],
    [1, 'Car'],
    [2, 'Truck'],
    [3, 'Bus'],
    [4, 'Other Vehicle'],
    [5, 'Motorcyclist'],      // was wrongly 'Motorcycle'
    [6, 'Bicyclist'],         // was wrongly 'Bicycle'
    [7, 'Pedestrian'],        // was wrongly '(reserved)'
    [8, 'Sign'],              // was wrongly 'Motorcyclist'
    [9, 'Traffic Light'],     // was wrongly 'Bicyclist'
    [10, 'Pole'],             // was wrongly 'Pedestrian' — the bug that showed poles as lime
    [11, 'Construction Cone'],
    [12, 'Bicycle'],          // was wrongly 'Traffic Light'
    [13, 'Motorcycle'],       // was wrongly 'Curb'
    [14, 'Building'],         // was wrongly 'Road'
    [15, 'Vegetation'],       // was wrongly 'Lane Marker'
    [16, 'Tree Trunk'],       // was wrongly 'Pole'
    [17, 'Curb'],             // was wrongly 'Construction Cone'
    [18, 'Road'],             // was wrongly 'Building'
    [19, 'Lane Marker'],      // was wrongly 'Vegetation'
    [20, 'Other Ground'],     // was wrongly 'Tree Trunk'
    [21, 'Walkable'],
    [22, 'Sidewalk'],
  ]

  it.each(PROTO_MAPPING)(
    'class %i = "%s" (matches segmentation.proto)',
    (id, expectedLabel) => {
      expect(WAYMO_SEG_LABELS[id]).toBe(expectedLabel)
    },
  )

  it('Pedestrian is at index 7, NOT 10', () => {
    // This was the most visible bug — lime-colored poles
    expect(WAYMO_SEG_LABELS[7]).toBe('Pedestrian')
    expect(WAYMO_SEG_LABELS[10]).toBe('Pole')
    expect(WAYMO_SEG_LABELS[10]).not.toBe('Pedestrian')
  })

  it('palette and labels arrays have matching length', () => {
    expect(WAYMO_SEG_PALETTE.length).toBe(WAYMO_SEG_LABELS.length)
  })

  it('all palette entries are valid RGB triplets in [0, 1]', () => {
    for (let i = 0; i < WAYMO_SEG_PALETTE.length; i++) {
      const [r, g, b] = WAYMO_SEG_PALETTE[i]
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(1)
    }
  })

  it('Pedestrian color is lime (matches box palette)', () => {
    const [r, g, b] = WAYMO_SEG_PALETTE[7] // Pedestrian
    expect(r).toBeCloseTo(0.80)
    expect(g).toBeCloseTo(1.00)
    expect(b).toBeCloseTo(0.00)
  })

  it('Car color is orange (matches box palette)', () => {
    const [r, g, b] = WAYMO_SEG_PALETTE[1] // Car
    expect(r).toBeCloseTo(1.00)
    expect(g).toBeCloseTo(0.62)
    expect(b).toBeCloseTo(0.00)
  })
})

// ---------------------------------------------------------------------------
// Camera seg palette (29-class) — separate class scheme
// ---------------------------------------------------------------------------

describe('Waymo camera seg palette', () => {
  it('has exactly 29 classes (0–28)', () => {
    expect(WAYMO_CAMERA_SEG_PALETTE).toHaveLength(29)
    expect(WAYMO_CAMERA_SEG_LABELS).toHaveLength(29)
  })

  it('includes camera-only classes not in lidar seg', () => {
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Sky')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Ground Animal')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Bird')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Trailer')
    expect(WAYMO_CAMERA_SEG_LABELS).toContain('Ego Vehicle')

    // These should NOT be in lidar seg
    expect(WAYMO_SEG_LABELS).not.toContain('Sky')
    expect(WAYMO_SEG_LABELS).not.toContain('Ground Animal')
  })
})

// ---------------------------------------------------------------------------
// Bug 3: Non-TOP sensor fallback in segment/panoptic mode
// ---------------------------------------------------------------------------

describe('Non-TOP sensor fallback in segment mode', () => {
  const stride = 6
  const stops: [number, number, number][] = [[0, 0, 0], [1, 1, 1]]

  function makePositions(...xyz: number[]): Float32Array {
    const arr = new Float32Array(stride)
    arr[0] = xyz[0]; arr[1] = xyz[1]; arr[2] = xyz[2]
    arr[3] = 0.5; arr[4] = 10; arr[5] = 0
    return arr
  }

  it('segment mode with segLabels uses palette color', () => {
    const pos = makePositions(1, 2, 3)
    const segLabels = new Uint8Array([1]) // Car
    const [r, g, b] = computePointColor(
      'segment', 0, pos, stride, stops, -2, 0, 31,
      segLabels, null, WAYMO_SEG_PALETTE,
    )
    // Should be Car color (orange), not gray
    expect(r).toBeCloseTo(WAYMO_SEG_PALETTE[1][0])
    expect(g).toBeCloseTo(WAYMO_SEG_PALETTE[1][1])
    expect(b).toBeCloseTo(WAYMO_SEG_PALETTE[1][2])
  })

  it('segment mode without segLabels falls back to palette[0] (Undefined)', () => {
    const pos = makePositions(1, 2, 3)
    // No segLabels → computePointColor gets null → label = 0 (Undefined)
    const [r, g, b] = computePointColor(
      'segment', 0, pos, stride, stops, -2, 0, 31,
      null, null, WAYMO_SEG_PALETTE,
    )
    // Falls back to label=0 → palette[0] color (dark gray)
    expect(r).toBeCloseTo(WAYMO_SEG_PALETTE[0][0])
    expect(g).toBeCloseTo(WAYMO_SEG_PALETTE[0][1])
    expect(b).toBeCloseTo(WAYMO_SEG_PALETTE[0][2])
  })

  it('panoptic mode without panopticLabels falls back to palette[0]', () => {
    const pos = makePositions(1, 2, 3)
    const [r, g, b] = computePointColor(
      'panoptic', 0, pos, stride, stops, -3, 0, 31,
      null, null, WAYMO_SEG_PALETTE,
    )
    expect(r).toBeCloseTo(WAYMO_SEG_PALETTE[0][0])
    expect(g).toBeCloseTo(WAYMO_SEG_PALETTE[0][1])
    expect(b).toBeCloseTo(WAYMO_SEG_PALETTE[0][2])
  })

  it('computePointColor correctly maps all 23 Waymo classes', () => {
    const pos = makePositions(1, 2, 3)
    for (let cls = 0; cls < 23; cls++) {
      const segLabels = new Uint8Array([cls])
      const [r, g, b] = computePointColor(
        'segment', 0, pos, stride, stops, -2, 0, 31,
        segLabels, null, WAYMO_SEG_PALETTE,
      )
      expect(r).toBeCloseTo(WAYMO_SEG_PALETTE[cls][0])
      expect(g).toBeCloseTo(WAYMO_SEG_PALETTE[cls][1])
      expect(b).toBeCloseTo(WAYMO_SEG_PALETTE[cls][2])
    }
  })
})
