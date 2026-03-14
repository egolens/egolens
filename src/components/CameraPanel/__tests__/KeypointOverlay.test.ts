/**
 * Unit tests for KeypointOverlay parsing logic.
 *
 * Uses the REAL Waymo v2.0 camera_hkp parquet schema:
 *   - Each row = one pedestrian object (per camera)
 *   - type/x/y/occluded columns are ARRAYS of joints per row
 *   - KeypointType uses Waymo proto enum values (1,5-10,13-20)
 *   - key.camera_name determines which camera the row belongs to
 */

import { describe, it, expect } from 'vitest'
import { parseCameraKeypointRows } from '../KeypointOverlay'
import { KP } from '../../../utils/waymoSemanticClasses'
import type { ParquetRow } from '../../../utils/merge'

// ---------------------------------------------------------------------------
// Column name constants (must match KeypointOverlay.tsx)
// ---------------------------------------------------------------------------

const COL_CAM = 'key.camera_name'
const COL_OBJ = 'key.camera_object_id'
const COL_TYPE = '[CameraHumanKeypointsComponent].camera_keypoints[*].type'
const COL_PX_X = '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.x'
const COL_PX_Y = '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.y'
const COL_OCCLUDED = '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.visibility.is_occluded'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(
  cameraName: number,
  types: number[],
  xs: number[],
  ys: number[],
  occluded?: boolean[],
  objectId = 'test-obj',
): ParquetRow {
  const row: ParquetRow = {
    [COL_CAM]: cameraName,
    [COL_OBJ]: objectId,
    [COL_TYPE]: types,
    [COL_PX_X]: xs,
    [COL_PX_Y]: ys,
  }
  if (occluded) row[COL_OCCLUDED] = occluded
  return row
}

// ---------------------------------------------------------------------------
// Tests: parseCameraKeypointRows
// ---------------------------------------------------------------------------

describe('parseCameraKeypointRows', () => {
  it('returns empty for empty input', () => {
    expect(parseCameraKeypointRows([], 1)).toEqual([])
  })

  it('filters by camera name', () => {
    const rows = [
      makeRow(1, [KP.NOSE], [100], [200]),
      makeRow(2, [KP.NOSE], [300], [400]),
      makeRow(1, [KP.HEAD_CENTER], [150], [250]),
    ]
    const result = parseCameraKeypointRows(rows, 1)
    expect(result).toHaveLength(2)
  })

  it('returns empty when no rows match camera', () => {
    const rows = [makeRow(3, [KP.NOSE], [100], [200])]
    expect(parseCameraKeypointRows(rows, 1)).toEqual([])
  })

  it('parses full 14-joint object', () => {
    const types = [KP.NOSE, KP.L_SHOULDER, KP.R_SHOULDER, KP.L_ELBOW, KP.R_ELBOW,
      KP.L_WRIST, KP.R_WRIST, KP.L_HIP, KP.R_HIP, KP.L_KNEE, KP.R_KNEE,
      KP.L_ANKLE, KP.R_ANKLE, KP.HEAD_CENTER]
    const xs = types.map((_, i) => i * 50)
    const ys = types.map((_, i) => i * 30)
    const rows = [makeRow(1, types, xs, ys)]

    const result = parseCameraKeypointRows(rows, 1)
    expect(result).toHaveLength(1)
    expect(result[0].joints).toHaveLength(14)
    expect(result[0].joints[0]).toEqual({ type: KP.NOSE, x: 0, y: 0, occluded: false })
  })

  it('handles partial skeleton (fewer joints)', () => {
    const rows = [makeRow(1, [KP.NOSE, KP.HEAD_CENTER], [100, 120], [200, 210])]
    const result = parseCameraKeypointRows(rows, 1)
    expect(result[0].joints).toHaveLength(2)
  })

  it('extracts occluded flag per joint', () => {
    const rows = [makeRow(
      1,
      [KP.NOSE, KP.L_SHOULDER, KP.R_SHOULDER],
      [100, 200, 300],
      [100, 200, 300],
      [false, true, false],
    )]
    const result = parseCameraKeypointRows(rows, 1)
    expect(result[0].joints[0].occluded).toBe(false)
    expect(result[0].joints[1].occluded).toBe(true)
    expect(result[0].joints[2].occluded).toBe(false)
  })

  it('defaults occluded to false when column is missing', () => {
    const rows = [makeRow(1, [KP.NOSE], [100], [200])] // no occluded
    const result = parseCameraKeypointRows(rows, 1)
    expect(result[0].joints[0].occluded).toBe(false)
  })

  it('skips rows with missing type array', () => {
    const rows: ParquetRow[] = [{
      [COL_CAM]: 1,
      [COL_PX_X]: [100],
      [COL_PX_Y]: [200],
    }]
    expect(parseCameraKeypointRows(rows, 1)).toEqual([])
  })

  it('skips rows with missing coordinate arrays', () => {
    const rows: ParquetRow[] = [{
      [COL_CAM]: 1,
      [COL_TYPE]: [KP.NOSE],
      // missing px_x and px_y
    }]
    expect(parseCameraKeypointRows(rows, 1)).toEqual([])
  })

  it('handles mismatched array lengths (takes minimum)', () => {
    const rows = [makeRow(
      1,
      [KP.NOSE, KP.L_SHOULDER, KP.R_SHOULDER], // 3
      [100, 200],                                // 2
      [100, 200],                                // 2
    )]
    const result = parseCameraKeypointRows(rows, 1)
    expect(result[0].joints).toHaveLength(2) // min(3,2,2)
  })

  it('handles multiple objects for same camera', () => {
    const rows = [
      makeRow(1, [KP.NOSE], [100], [200], undefined, 'ped-A'),
      makeRow(1, [KP.NOSE], [500], [600], undefined, 'ped-B'),
    ]
    const result = parseCameraKeypointRows(rows, 1)
    expect(result).toHaveLength(2)
  })

  it('uses proto enum type values correctly', () => {
    const rows = [makeRow(1, [KP.NOSE, KP.HEAD_CENTER, KP.L_ANKLE], [0, 0, 0], [0, 0, 0])]
    const result = parseCameraKeypointRows(rows, 1)
    const types = result[0].joints.map(j => j.type)
    expect(types).toEqual([1, 20, 10]) // proto values, not 0-indexed
  })
})
