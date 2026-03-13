/**
 * Unit tests for the Waymo metadata loader and MetadataBundle contract.
 *
 * Since loadWaymoMetadata() requires real Parquet files (hyparquet),
 * these tests focus on:
 * 1. MetadataBundle structural contract
 * 2. Matrix math helpers (exported via re-test of identical functions)
 * 3. Bundle field type validation helper
 */

import { describe, it, expect } from 'vitest'
import type { MetadataBundle } from '../../types/dataset'

// ---------------------------------------------------------------------------
// Matrix helpers — identical to those in metadata.ts (pure math, testable)
// ---------------------------------------------------------------------------

function multiplyRowMajor4x4(a: number[], b: number[]): number[] {
  const r = new Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      r[i * 4 + j] =
        a[i * 4 + 0] * b[0 * 4 + j] +
        a[i * 4 + 1] * b[1 * 4 + j] +
        a[i * 4 + 2] * b[2 * 4 + j] +
        a[i * 4 + 3] * b[3 * 4 + j]
    }
  }
  return r
}

function invertRowMajor4x4(m: number[]): number[] {
  const r00 = m[0], r01 = m[1], r02 = m[2], tx = m[3]
  const r10 = m[4], r11 = m[5], r12 = m[6], ty = m[7]
  const r20 = m[8], r21 = m[9], r22 = m[10], tz = m[11]
  return [
    r00, r10, r20, -(r00 * tx + r10 * ty + r20 * tz),
    r01, r11, r21, -(r01 * tx + r11 * ty + r21 * tz),
    r02, r12, r22, -(r02 * tx + r12 * ty + r22 * tz),
    0, 0, 0, 1,
  ]
}

// ---------------------------------------------------------------------------
// Matrix math tests
// ---------------------------------------------------------------------------

describe('matrix helpers (used by metadata loader)', () => {
  const identity = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]

  it('multiply by identity returns same matrix', () => {
    const m = [
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 11, 12,
      0, 0, 0, 1,
    ]
    expect(multiplyRowMajor4x4(m, identity)).toEqual(m)
    expect(multiplyRowMajor4x4(identity, m)).toEqual(m)
  })

  it('invert identity returns identity', () => {
    const inv = invertRowMajor4x4(identity)
    for (let i = 0; i < 16; i++) {
      expect(inv[i]).toBeCloseTo(identity[i], 10)
    }
  })

  it('invert a pure translation', () => {
    const t = [
      1, 0, 0, 5,
      0, 1, 0, -3,
      0, 0, 1, 7,
      0, 0, 0, 1,
    ]
    const inv = invertRowMajor4x4(t)
    expect(inv[3]).toBeCloseTo(-5)
    expect(inv[7]).toBeCloseTo(3)
    expect(inv[11]).toBeCloseTo(-7)
  })

  it('M × inv(M) ≈ identity for rigid body transform', () => {
    // 90° rotation around Z + translation
    const m = [
      0, -1, 0, 10,
      1, 0, 0, 20,
      0, 0, 1, 30,
      0, 0, 0, 1,
    ]
    const inv = invertRowMajor4x4(m)
    const product = multiplyRowMajor4x4(m, inv)
    for (let i = 0; i < 16; i++) {
      expect(product[i]).toBeCloseTo(identity[i], 10)
    }
  })

  it('multiply two translations adds offsets', () => {
    const t1 = [1, 0, 0, 3, 0, 1, 0, 4, 0, 0, 1, 5, 0, 0, 0, 1]
    const t2 = [1, 0, 0, 7, 0, 1, 0, 8, 0, 0, 1, 9, 0, 0, 0, 1]
    const result = multiplyRowMajor4x4(t1, t2)
    expect(result[3]).toBeCloseTo(10)  // 3 + 7
    expect(result[7]).toBeCloseTo(12)  // 4 + 8
    expect(result[11]).toBeCloseTo(14) // 5 + 9
  })

  it('worldOriginInverse pattern: inv(pose0) × poseN at frame 0 = identity', () => {
    const pose0 = [
      0, -1, 0, 100,
      1, 0, 0, 200,
      0, 0, 1, 300,
      0, 0, 0, 1,
    ]
    const inv0 = invertRowMajor4x4(pose0)
    const relative = multiplyRowMajor4x4(inv0, pose0)
    for (let i = 0; i < 16; i++) {
      expect(relative[i]).toBeCloseTo(identity[i], 10)
    }
  })
})

// ---------------------------------------------------------------------------
// MetadataBundle contract validation
// ---------------------------------------------------------------------------

describe('MetadataBundle contract', () => {
  /** Create an empty but structurally valid bundle */
  function createEmptyBundle(): MetadataBundle {
    return {
      timestamps: [],
      timestampToFrame: new Map(),
      vehiclePoseByFrame: new Map(),
      worldOriginInverse: null,
      poseByFrameIndex: new Map(),
      lidarCalibrations: new Map(),
      cameraCalibrations: [],
      lidarBoxByFrame: new Map(),
      cameraBoxByFrame: new Map(),
      objectTrajectories: new Map(),
      assocCamToLaser: new Map(),
      assocLaserToCams: new Map(),
      hasBoxData: false,
      segmentMeta: null,
    }
  }

  /** Create a bundle with realistic mock data */
  function createMockBundle(): MetadataBundle {
    const ts1 = 1000n
    const ts2 = 2000n
    const ts3 = 3000n
    return {
      timestamps: [ts1, ts2, ts3],
      timestampToFrame: new Map([[ts1, 0], [ts2, 1], [ts3, 2]]),
      vehiclePoseByFrame: new Map([
        [ts1, [{ 'key.frame_timestamp_micros': ts1, pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]],
      ]),
      worldOriginInverse: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      poseByFrameIndex: new Map([[0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]]]),
      lidarCalibrations: new Map([[1, { laserName: 1, beamInclinations: [], extrinsic: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]]),
      cameraCalibrations: [{ 'key.camera_name': 1, intrinsic: [1, 2, 3] }],
      lidarBoxByFrame: new Map([[ts1, [{ 'key.laser_object_id': 'obj1', type: 1 }]]]),
      cameraBoxByFrame: new Map([[ts1, [{ 'key.camera_object_id': 'cam_obj1' }]]]),
      objectTrajectories: new Map([['obj1', [{ frameIndex: 0, x: 1, y: 2, z: 3, type: 1 }]]]),
      assocCamToLaser: new Map([['cam_obj1', 'obj1']]),
      assocLaserToCams: new Map([['obj1', new Set(['cam_obj1'])]]),
      hasBoxData: true,
      segmentMeta: {
        segmentId: 'test-segment',
        timeOfDay: 'Day',
        location: 'location_sf',
        weather: 'sunny',
        objectCounts: { 1: 5, 2: 3 },
      },
    }
  }

  it('empty bundle has all required fields', () => {
    const bundle = createEmptyBundle()
    expect(bundle.timestamps).toEqual([])
    expect(bundle.timestampToFrame).toBeInstanceOf(Map)
    expect(bundle.vehiclePoseByFrame).toBeInstanceOf(Map)
    expect(bundle.worldOriginInverse).toBeNull()
    expect(bundle.poseByFrameIndex).toBeInstanceOf(Map)
    expect(bundle.lidarCalibrations).toBeInstanceOf(Map)
    expect(Array.isArray(bundle.cameraCalibrations)).toBe(true)
    expect(bundle.lidarBoxByFrame).toBeInstanceOf(Map)
    expect(bundle.cameraBoxByFrame).toBeInstanceOf(Map)
    expect(bundle.objectTrajectories).toBeInstanceOf(Map)
    expect(bundle.assocCamToLaser).toBeInstanceOf(Map)
    expect(bundle.assocLaserToCams).toBeInstanceOf(Map)
    expect(bundle.hasBoxData).toBe(false)
    expect(bundle.segmentMeta).toBeNull()
  })

  it('mock bundle has consistent timestamps and frame mapping', () => {
    const bundle = createMockBundle()
    expect(bundle.timestamps).toHaveLength(3)
    // Every timestamp maps to a unique frame index
    for (let i = 0; i < bundle.timestamps.length; i++) {
      expect(bundle.timestampToFrame.get(bundle.timestamps[i])).toBe(i)
    }
  })

  it('mock bundle trajectories reference valid frame indices', () => {
    const bundle = createMockBundle()
    for (const trail of bundle.objectTrajectories.values()) {
      for (const pt of trail) {
        expect(pt.frameIndex).toBeGreaterThanOrEqual(0)
        expect(pt.frameIndex).toBeLessThan(bundle.timestamps.length)
      }
    }
  })

  it('mock bundle associations are bidirectionally consistent', () => {
    const bundle = createMockBundle()
    // For every camToLaser entry, the reverse mapping should contain it
    for (const [camId, laserId] of bundle.assocCamToLaser) {
      const camSet = bundle.assocLaserToCams.get(laserId)
      expect(camSet).toBeDefined()
      expect(camSet!.has(camId)).toBe(true)
    }
    // And vice versa
    for (const [laserId, camSet] of bundle.assocLaserToCams) {
      for (const camId of camSet) {
        expect(bundle.assocCamToLaser.get(camId)).toBe(laserId)
      }
    }
  })

  it('mock bundle segmentMeta has required fields', () => {
    const bundle = createMockBundle()
    expect(bundle.segmentMeta).not.toBeNull()
    expect(bundle.segmentMeta!.segmentId).toBeTypeOf('string')
    expect(bundle.segmentMeta!.timeOfDay).toBeTypeOf('string')
    expect(bundle.segmentMeta!.location).toBeTypeOf('string')
    expect(bundle.segmentMeta!.weather).toBeTypeOf('string')
    expect(bundle.segmentMeta!.objectCounts).toBeTypeOf('object')
  })

  it('worldOriginInverse is a 16-element array when set', () => {
    const bundle = createMockBundle()
    expect(bundle.worldOriginInverse).toHaveLength(16)
  })
})
