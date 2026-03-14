/**
 * Unit tests for KeypointSkeleton parsing logic and skeleton bone connectivity.
 *
 * Uses the REAL Waymo v2.0 lidar_hkp parquet schema:
 *   - Each row = one pedestrian object (not one joint!)
 *   - type/x/y/z columns are ARRAYS of 14 values per row
 *   - KeypointType uses Waymo proto enum values (1,5-10,13-20), NOT 0-indexed
 */

import { describe, it, expect } from 'vitest'
import { parseKeypointRows, type KeypointObject } from '../KeypointSkeleton'
import { WAYMO_SKELETON_BONES, KP, WAYMO_KEYPOINT_LABELS } from '../../../utils/waymoSemanticClasses'
import type { ParquetRow } from '../../../utils/merge'

// ---------------------------------------------------------------------------
// Parquet column name constants (must match KeypointSkeleton.tsx)
// ---------------------------------------------------------------------------

const COL_OBJ = 'key.laser_object_id'
const COL_TS = 'key.frame_timestamp_micros'
const COL_TYPE = '[LiDARHumanKeypointsComponent].lidar_keypoints[*].type'
const COL_X = '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.x'
const COL_Y = '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.y'
const COL_Z = '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.z'

// ---------------------------------------------------------------------------
// Helper: create a mock lidar_hkp row (one object with all joints in arrays)
// ---------------------------------------------------------------------------

/** Full 14-joint proto types in the order they appear in real data */
const ALL_JOINT_TYPES = [
  KP.NOSE, KP.L_SHOULDER, KP.L_ELBOW, KP.L_WRIST, KP.L_HIP, KP.L_KNEE, KP.L_ANKLE,
  KP.R_SHOULDER, KP.R_ELBOW, KP.R_WRIST, KP.R_HIP, KP.R_KNEE, KP.R_ANKLE, KP.HEAD_CENTER,
]

function makeObjectRow(
  objectId: string,
  types: number[],
  xs: number[],
  ys: number[],
  zs: number[],
  ts: bigint = 1000n,
): ParquetRow {
  return {
    [COL_TS]: ts,
    [COL_OBJ]: objectId,
    [COL_TYPE]: types,
    [COL_X]: xs,
    [COL_Y]: ys,
    [COL_Z]: zs,
  }
}

function makeFullObjectRow(objectId: string, ts: bigint = 1000n): ParquetRow {
  return makeObjectRow(
    objectId,
    ALL_JOINT_TYPES,
    ALL_JOINT_TYPES.map((_, i) => i * 0.1),
    ALL_JOINT_TYPES.map((_, i) => i * 0.2),
    ALL_JOINT_TYPES.map((_, i) => i * 0.05 + 1.0),
    ts,
  )
}

// ---------------------------------------------------------------------------
// Tests: parseKeypointRows
// ---------------------------------------------------------------------------

describe('parseKeypointRows', () => {
  it('returns empty array for empty input', () => {
    expect(parseKeypointRows([])).toEqual([])
  })

  it('parses a single object with all 14 joints', () => {
    const rows = [makeFullObjectRow('obj-1')]
    const result = parseKeypointRows(rows)
    expect(result).toHaveLength(1)
    expect(result[0].objectId).toBe('obj-1')
    expect(result[0].joints).toHaveLength(14)
  })

  it('correctly extracts proto enum type values', () => {
    const rows = [makeFullObjectRow('obj-1')]
    const result = parseKeypointRows(rows)
    const types = new Set(result[0].joints.map(j => j.type))
    // Should contain all proto enum values
    for (const t of ALL_JOINT_TYPES) {
      expect(types.has(t)).toBe(true)
    }
  })

  it('parses joint coordinates correctly', () => {
    const rows = [makeObjectRow(
      'obj-1',
      [KP.NOSE, KP.HEAD_CENTER],
      [1.5, 2.5],
      [3.5, 4.5],
      [5.5, 6.5],
    )]
    const result = parseKeypointRows(rows)
    expect(result[0].joints[0]).toEqual({ type: KP.NOSE, x: 1.5, y: 3.5, z: 5.5 })
    expect(result[0].joints[1]).toEqual({ type: KP.HEAD_CENTER, x: 2.5, y: 4.5, z: 6.5 })
  })

  it('handles multiple objects (rows) in one frame', () => {
    const rows = [
      makeFullObjectRow('ped-A'),
      makeFullObjectRow('ped-B'),
      makeFullObjectRow('ped-C'),
    ]
    const result = parseKeypointRows(rows)
    expect(result).toHaveLength(3)
    expect(result.map(o => o.objectId)).toEqual(['ped-A', 'ped-B', 'ped-C'])
  })

  it('skips rows with missing objectId', () => {
    const rows: ParquetRow[] = [{
      [COL_TS]: 1000n,
      // no objectId
      [COL_TYPE]: [KP.NOSE],
      [COL_X]: [1.0],
      [COL_Y]: [2.0],
      [COL_Z]: [3.0],
    }]
    expect(parseKeypointRows(rows)).toEqual([])
  })

  it('skips rows with missing type array', () => {
    const rows: ParquetRow[] = [{
      [COL_TS]: 1000n,
      [COL_OBJ]: 'obj-1',
      // no type array
      [COL_X]: [1.0],
      [COL_Y]: [2.0],
      [COL_Z]: [3.0],
    }]
    expect(parseKeypointRows(rows)).toEqual([])
  })

  it('skips rows with missing coordinate arrays', () => {
    const rows: ParquetRow[] = [{
      [COL_TS]: 1000n,
      [COL_OBJ]: 'obj-1',
      [COL_TYPE]: [KP.NOSE],
      [COL_X]: [1.0],
      // missing Y and Z
    }]
    expect(parseKeypointRows(rows)).toEqual([])
  })

  it('handles partial skeleton (fewer than 14 joints)', () => {
    const rows = [makeObjectRow(
      'ped-partial',
      [KP.NOSE, KP.HEAD_CENTER],
      [1.0, 2.0],
      [3.0, 4.0],
      [5.0, 6.0],
    )]
    const result = parseKeypointRows(rows)
    expect(result).toHaveLength(1)
    expect(result[0].joints).toHaveLength(2)
  })

  it('handles mismatched array lengths (takes minimum)', () => {
    const rows = [makeObjectRow(
      'obj-1',
      [KP.NOSE, KP.L_SHOULDER, KP.R_SHOULDER], // 3 types
      [1.0, 2.0],                               // only 2 x values
      [3.0, 4.0],                               // only 2 y values
      [5.0, 6.0],                               // only 2 z values
    )]
    const result = parseKeypointRows(rows)
    expect(result[0].joints).toHaveLength(2) // min(3, 2, 2, 2) = 2
  })
})

// ---------------------------------------------------------------------------
// Tests: Skeleton bone connectivity (using proto enum values)
// ---------------------------------------------------------------------------

describe('WAYMO_SKELETON_BONES', () => {
  it('has 15 bone connections (14 body + 1 head-center→nose)', () => {
    expect(WAYMO_SKELETON_BONES).toHaveLength(15)
  })

  it('all bone indices use valid KeypointType enum values', () => {
    const validTypes = new Set(Object.values(KP))
    for (const [from, to] of WAYMO_SKELETON_BONES) {
      expect(validTypes.has(from)).toBe(true)
      expect(validTypes.has(to)).toBe(true)
    }
  })

  it('connects Nose → Left Shoulder and Nose → Right Shoulder', () => {
    const noseBones = WAYMO_SKELETON_BONES.filter(([f]) => f === KP.NOSE)
    expect(noseBones).toHaveLength(2)
    const targets = noseBones.map(([, t]) => t).sort((a, b) => a - b)
    expect(targets).toEqual([KP.L_SHOULDER, KP.R_SHOULDER])
  })

  it('connects Head Center → Nose', () => {
    const headBone = WAYMO_SKELETON_BONES.find(([f, t]) => f === KP.HEAD_CENTER && t === KP.NOSE)
    expect(headBone).toBeDefined()
  })

  it('forms complete left arm chain: Shoulder→Elbow→Wrist', () => {
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.L_SHOULDER && t === KP.L_ELBOW)).toBe(true)
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.L_ELBOW && t === KP.L_WRIST)).toBe(true)
  })

  it('forms complete right arm chain: Shoulder→Elbow→Wrist', () => {
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.R_SHOULDER && t === KP.R_ELBOW)).toBe(true)
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.R_ELBOW && t === KP.R_WRIST)).toBe(true)
  })

  it('forms complete left leg chain: Hip→Knee→Ankle', () => {
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.L_HIP && t === KP.L_KNEE)).toBe(true)
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.L_KNEE && t === KP.L_ANKLE)).toBe(true)
  })

  it('forms complete right leg chain: Hip→Knee→Ankle', () => {
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.R_HIP && t === KP.R_KNEE)).toBe(true)
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.R_KNEE && t === KP.R_ANKLE)).toBe(true)
  })

  it('has torso connections (shoulders, hips, and cross)', () => {
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.L_SHOULDER && t === KP.R_SHOULDER)).toBe(true)
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.L_HIP && t === KP.R_HIP)).toBe(true)
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.L_SHOULDER && t === KP.L_HIP)).toBe(true)
    expect(WAYMO_SKELETON_BONES.some(([f, t]) => f === KP.R_SHOULDER && t === KP.R_HIP)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: KP enum values match Waymo proto
// ---------------------------------------------------------------------------

describe('KP proto enum constants', () => {
  it('NOSE = 1 (matches keypoint.proto)', () => {
    expect(KP.NOSE).toBe(1)
  })

  it('LEFT body parts use values 5-10', () => {
    expect(KP.L_SHOULDER).toBe(5)
    expect(KP.L_ELBOW).toBe(6)
    expect(KP.L_WRIST).toBe(7)
    expect(KP.L_HIP).toBe(8)
    expect(KP.L_KNEE).toBe(9)
    expect(KP.L_ANKLE).toBe(10)
  })

  it('RIGHT body parts use values 13-18', () => {
    expect(KP.R_SHOULDER).toBe(13)
    expect(KP.R_ELBOW).toBe(14)
    expect(KP.R_WRIST).toBe(15)
    expect(KP.R_HIP).toBe(16)
    expect(KP.R_KNEE).toBe(17)
    expect(KP.R_ANKLE).toBe(18)
  })

  it('HEAD_CENTER = 20, FOREHEAD = 19', () => {
    expect(KP.FOREHEAD).toBe(19)
    expect(KP.HEAD_CENTER).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Tests: Bone generation with partial joints
// ---------------------------------------------------------------------------

describe('bone generation with partial joints', () => {
  it('generates all 15 bones when all 14 joints present', () => {
    const rows = [makeFullObjectRow('ped-full')]
    const objects = parseKeypointRows(rows)
    const obj = objects[0]

    const jointByType = new Map<number, { x: number; y: number; z: number }>()
    for (const j of obj.joints) jointByType.set(j.type, j)

    let boneCount = 0
    for (const [fromType, toType] of WAYMO_SKELETON_BONES) {
      if (jointByType.has(fromType) && jointByType.has(toType)) boneCount++
    }
    expect(boneCount).toBe(15)
  })

  it('skips bones when joints are missing (occluded)', () => {
    // Only Nose and Head Center — only HEAD_CENTER→NOSE bone possible
    const rows = [makeObjectRow(
      'ped-head-only',
      [KP.NOSE, KP.HEAD_CENTER],
      [0, 0],
      [0, 0],
      [2, 2.2],
    )]
    const objects = parseKeypointRows(rows)
    const obj = objects[0]

    const jointByType = new Map<number, { x: number; y: number; z: number }>()
    for (const j of obj.joints) jointByType.set(j.type, j)

    let boneCount = 0
    for (const [fromType, toType] of WAYMO_SKELETON_BONES) {
      if (jointByType.has(fromType) && jointByType.has(toType)) boneCount++
    }
    // HEAD_CENTER→NOSE = 1 bone
    expect(boneCount).toBe(1)
  })

  it('generates upper body bones with arms but no legs', () => {
    // Joints: Nose, L_Shoulder, R_Shoulder, L_Elbow, R_Elbow
    const types = [KP.NOSE, KP.L_SHOULDER, KP.R_SHOULDER, KP.L_ELBOW, KP.R_ELBOW]
    const rows = [makeObjectRow(
      'ped-upper',
      types,
      [0, -0.2, 0.2, -0.4, 0.4],
      [0, 0, 0, 0, 0],
      [2, 1.5, 1.5, 1.2, 1.2],
    )]
    const objects = parseKeypointRows(rows)
    const obj = objects[0]

    const jointByType = new Map<number, { x: number; y: number; z: number }>()
    for (const j of obj.joints) jointByType.set(j.type, j)

    let boneCount = 0
    for (const [fromType, toType] of WAYMO_SKELETON_BONES) {
      if (jointByType.has(fromType) && jointByType.has(toType)) boneCount++
    }
    // Nose→L_Shoulder, Nose→R_Shoulder, L_Shoulder→L_Elbow, R_Shoulder→R_Elbow, L_Shoulder→R_Shoulder
    expect(boneCount).toBe(5)
  })
})
