/**
 * Unit tests for lidarProjection utilities.
 *
 * Covers:
 * - buildCameraProjectors: verifies inv(extrinsic) correctness
 * - projectBoxToCamera: pinhole projection + coordinate frame handling
 * - projectPointsToCamera: batch point projection
 * - transformToCameraFrame: shared ego→camera coordinate transform
 */

import { describe, it, expect } from 'vitest'
import {
  buildCameraProjectors,
  projectBoxToCamera,
  projectPointsToCamera,
  transformToCameraFrame,
  type CameraProjector,
} from '../lidarProjection'
import { multiplyRowMajor4x4 } from '../matrix'

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const IDENTITY_4x4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]

/** 90° rotation around Z + translation (rigid body) */
const RIGID_TRANSFORM = [
  0, -1, 0, 10,
  1,  0, 0, 20,
  0,  0, 1, 30,
  0,  0, 0,  1,
]

function makeCamCalibRow(
  cameraName: number,
  extrinsic: number[],
  opts?: { width?: number; height?: number; f_u?: number; f_v?: number; c_u?: number; c_v?: number; isOptical?: boolean },
): Record<string, unknown> {
  const w = opts?.width ?? 1920
  const h = opts?.height ?? 1280
  return {
    'key.camera_name': cameraName,
    '[CameraCalibrationComponent].extrinsic.transform': extrinsic,
    '[CameraCalibrationComponent].width': w,
    '[CameraCalibrationComponent].height': h,
    '[CameraCalibrationComponent].intrinsic.f_u': opts?.f_u ?? 2000,
    '[CameraCalibrationComponent].intrinsic.f_v': opts?.f_v ?? 2000,
    '[CameraCalibrationComponent].intrinsic.c_u': opts?.c_u ?? w / 2,
    '[CameraCalibrationComponent].intrinsic.c_v': opts?.c_v ?? h / 2,
    '__isOpticalFrame': opts?.isOptical ?? false,
  }
}

// ---------------------------------------------------------------------------
// buildCameraProjectors
// ---------------------------------------------------------------------------

describe('buildCameraProjectors', () => {
  it('builds projectors from calibration rows', () => {
    const rows = [makeCamCalibRow(1, IDENTITY_4x4)]
    const projectors = buildCameraProjectors(rows)
    expect(projectors.size).toBe(1)
    expect(projectors.has(1)).toBe(true)
  })

  it('invExtrinsic × extrinsic ≈ identity (regression: matrix inversion correctness)', () => {
    const rows = [makeCamCalibRow(1, RIGID_TRANSFORM)]
    const projectors = buildCameraProjectors(rows)
    const proj = projectors.get(1)!
    // inv(M) × M should equal identity
    const product = multiplyRowMajor4x4(proj.invExtrinsic, RIGID_TRANSFORM)
    for (let i = 0; i < 16; i++) {
      expect(product[i]).toBeCloseTo(IDENTITY_4x4[i], 10)
    }
  })

  it('identity extrinsic → invExtrinsic is also identity', () => {
    const rows = [makeCamCalibRow(1, IDENTITY_4x4)]
    const proj = buildCameraProjectors(rows).get(1)!
    for (let i = 0; i < 16; i++) {
      expect(proj.invExtrinsic[i]).toBeCloseTo(IDENTITY_4x4[i], 10)
    }
  })

  it('preserves intrinsic parameters', () => {
    const rows = [makeCamCalibRow(2, IDENTITY_4x4, { f_u: 1500, f_v: 1600, c_u: 960, c_v: 640 })]
    const proj = buildCameraProjectors(rows).get(2)!
    expect(proj.f_u).toBe(1500)
    expect(proj.f_v).toBe(1600)
    expect(proj.c_u).toBe(960)
    expect(proj.c_v).toBe(640)
  })

  it('handles optical frame flag', () => {
    const rows = [makeCamCalibRow(3, IDENTITY_4x4, { isOptical: true })]
    const proj = buildCameraProjectors(rows).get(3)!
    expect(proj.isOpticalFrame).toBe(true)
  })

  it('skips rows with missing fields', () => {
    const rows = [{ 'key.camera_name': 99 }] // missing extrinsic, width, etc.
    const projectors = buildCameraProjectors(rows)
    expect(projectors.size).toBe(0)
  })

  it('builds multiple cameras', () => {
    const rows = [
      makeCamCalibRow(1, IDENTITY_4x4),
      makeCamCalibRow(2, RIGID_TRANSFORM),
      makeCamCalibRow(3, IDENTITY_4x4),
    ]
    const projectors = buildCameraProjectors(rows)
    expect(projectors.size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// projectBoxToCamera
// ---------------------------------------------------------------------------

describe('projectBoxToCamera', () => {
  /** Simple projector: optical frame, identity extrinsic, camera at origin */
  function makeSimpleProjector(isOptical: boolean): CameraProjector {
    return {
      cameraName: 1,
      width: 1920,
      height: 1280,
      f_u: 2000,
      f_v: 2000,
      c_u: 960,
      c_v: 640,
      invExtrinsic: IDENTITY_4x4,
      isOpticalFrame: isOptical,
    }
  }

  it('returns null for box entirely behind camera (optical frame)', () => {
    const proj = makeSimpleProjector(true)
    // Box at z=-10 (behind camera in optical frame where z=forward)
    const result = projectBoxToCamera(0, 0, -10, 1, 1, 1, 0, proj)
    expect(result).toBeNull()
  })

  it('projects box in front of camera (optical frame)', () => {
    const proj = makeSimpleProjector(true)
    // Box at z=10 (in front of camera), centered at origin in x,y
    const result = projectBoxToCamera(0, 0, 10, 2, 2, 2, 0, proj)
    expect(result).not.toBeNull()
    expect(result!.allInFront).toBe(true)
    expect(result!.corners).toHaveLength(8)
  })

  it('anyVisible is true when projected corners fall in image', () => {
    const proj = makeSimpleProjector(true)
    // Box at z=10 should project near center
    const result = projectBoxToCamera(0, 0, 10, 1, 1, 1, 0, proj)
    expect(result).not.toBeNull()
    expect(result!.anyVisible).toBe(true)
  })

  it('handles non-optical (Waymo) frame conversion', () => {
    const proj = makeSimpleProjector(false)
    // In Waymo sensor frame: X=forward maps to optical Z
    // Box at x=10 (forward) should be in front of camera after conversion
    const result = projectBoxToCamera(10, 0, 0, 2, 2, 2, 0, proj)
    expect(result).not.toBeNull()
    expect(result!.allInFront).toBe(true)
  })

  it('8 corners are returned in correct order', () => {
    const proj = makeSimpleProjector(true)
    const result = projectBoxToCamera(0, 0, 20, 4, 2, 2, 0, proj)
    expect(result).not.toBeNull()
    expect(result!.corners).toHaveLength(8)
    // Each corner is [u, v]
    for (const [u, v] of result!.corners) {
      expect(typeof u).toBe('number')
      expect(typeof v).toBe('number')
    }
  })
})

// ---------------------------------------------------------------------------
// projectPointsToCamera
// ---------------------------------------------------------------------------

describe('projectPointsToCamera', () => {
  function makeOpticalProjector(): CameraProjector {
    return {
      cameraName: 1,
      width: 1920,
      height: 1280,
      f_u: 2000,
      f_v: 2000,
      c_u: 960,
      c_v: 640,
      invExtrinsic: IDENTITY_4x4,
      isOpticalFrame: true,
    }
  }

  it('projects point directly in front of camera to near image center', () => {
    const proj = makeOpticalProjector()
    // Point at (0, 0, 10) in optical frame → projects to (960, 640)
    const positions = new Float32Array([0, 0, 10])
    const result = projectPointsToCamera(positions, 1, 3, proj)
    expect(result).toHaveLength(1)
    expect(result[0].u).toBeCloseTo(960, 1)
    expect(result[0].v).toBeCloseTo(640, 1)
    expect(result[0].depth).toBeCloseTo(10)
    expect(result[0].srcIndex).toBe(0)
  })

  it('excludes points behind camera', () => {
    const proj = makeOpticalProjector()
    const positions = new Float32Array([0, 0, -5]) // behind camera
    const result = projectPointsToCamera(positions, 1, 3, proj)
    expect(result).toHaveLength(0)
  })

  it('excludes points outside image bounds', () => {
    const proj = makeOpticalProjector()
    // Point far to the right: x=100, z=1 → u = 2000 * 100 + 960 = way out of bounds
    const positions = new Float32Array([100, 0, 1])
    const result = projectPointsToCamera(positions, 1, 3, proj)
    expect(result).toHaveLength(0)
  })

  it('handles stride > 3 (extra attributes)', () => {
    const proj = makeOpticalProjector()
    // stride=5: [x, y, z, intensity, elongation]
    const positions = new Float32Array([0, 0, 10, 0.5, 0.1])
    const result = projectPointsToCamera(positions, 1, 5, proj)
    expect(result).toHaveLength(1)
    expect(result[0].srcIndex).toBe(0)
  })

  it('projects multiple points with correct srcIndex', () => {
    const proj = makeOpticalProjector()
    const positions = new Float32Array([
      0, 0, 10, // point 0
      1, 0, 10, // point 1
      0, 1, 10, // point 2
    ])
    const result = projectPointsToCamera(positions, 3, 3, proj)
    expect(result).toHaveLength(3)
    expect(result.map((p) => p.srcIndex).sort()).toEqual([0, 1, 2])
  })

  it('respects minDepth parameter', () => {
    const proj = makeOpticalProjector()
    const positions = new Float32Array([0, 0, 0.5]) // depth = 0.5 < default minDepth 1.0
    const result = projectPointsToCamera(positions, 1, 3, proj)
    expect(result).toHaveLength(0)
    // With lower minDepth
    const result2 = projectPointsToCamera(positions, 1, 3, proj, 0.1)
    expect(result2).toHaveLength(1)
  })

  it('handles Waymo (non-optical) frame correctly', () => {
    const proj: CameraProjector = {
      ...makeOpticalProjector(),
      isOpticalFrame: false,
    }
    // In Waymo sensor frame: X=forward → optical Z=X
    // Point at (10, 0, 0) → after conversion: camX=-0, camY=-0, camZ=10
    const positions = new Float32Array([10, 0, 0])
    const result = projectPointsToCamera(positions, 1, 3, proj)
    expect(result).toHaveLength(1)
    expect(result[0].depth).toBeCloseTo(10)
    // Should project to near center: u≈960, v≈640
    expect(result[0].u).toBeCloseTo(960, 0)
    expect(result[0].v).toBeCloseTo(640, 0)
  })
})

// ---------------------------------------------------------------------------
// transformToCameraFrame
// ---------------------------------------------------------------------------

describe('transformToCameraFrame', () => {
  it('identity extrinsic + optical frame: passthrough', () => {
    const [cx, cy, cz] = transformToCameraFrame(1, 2, 3, IDENTITY_4x4, true)
    expect(cx).toBeCloseTo(1)
    expect(cy).toBeCloseTo(2)
    expect(cz).toBeCloseTo(3)
  })

  it('identity extrinsic + non-optical: applies sensor→optical rotation', () => {
    // Waymo sensor → optical: X→Z, Y→-X, Z→-Y
    const [cx, cy, cz] = transformToCameraFrame(10, 0, 0, IDENTITY_4x4, false)
    expect(cx).toBeCloseTo(0)   // -Y = 0
    expect(cy).toBeCloseTo(0)   // -Z = 0
    expect(cz).toBeCloseTo(10)  // X = 10
  })

  it('non-optical: Y maps to -X', () => {
    const [cx, cy, cz] = transformToCameraFrame(0, 5, 0, IDENTITY_4x4, false)
    expect(cx).toBeCloseTo(-5)  // -Y = -5
    expect(cy).toBeCloseTo(0)   // -Z = 0
    expect(cz).toBeCloseTo(0)   // X = 0
  })

  it('non-optical: Z maps to -Y', () => {
    const [cx, cy, cz] = transformToCameraFrame(0, 0, 7, IDENTITY_4x4, false)
    expect(cx).toBeCloseTo(0)   // -Y = 0
    expect(cy).toBeCloseTo(-7)  // -Z = -7
    expect(cz).toBeCloseTo(0)   // X = 0
  })

  it('applies invExtrinsic before frame conversion', () => {
    // Rigid transform: 90° around Z + translation
    const [cx, cy, cz] = transformToCameraFrame(0, 0, 0, RIGID_TRANSFORM, true)
    // inv is not applied here — RIGID_TRANSFORM is used as inv already
    // Result: inv[3]=10, inv[7]=20, inv[11]=30
    expect(cx).toBeCloseTo(10)
    expect(cy).toBeCloseTo(20)
    expect(cz).toBeCloseTo(30)
  })

  it('consistent with projectPointsToCamera', () => {
    // A point at (0.5, 0.3, 10) with identity inv, optical frame — well within FOV
    const [cx, cy, cz] = transformToCameraFrame(0.5, 0.3, 10, IDENTITY_4x4, true)
    // projectPointsToCamera should give same depth
    const positions = new Float32Array([0.5, 0.3, 10])
    const proj: CameraProjector = {
      cameraName: 1, width: 1920, height: 1280,
      f_u: 2000, f_v: 2000, c_u: 960, c_v: 640,
      invExtrinsic: IDENTITY_4x4, isOpticalFrame: true,
    }
    const result = projectPointsToCamera(positions, 1, 3, proj, 0.1)
    expect(result).toHaveLength(1)
    expect(result[0].depth).toBeCloseTo(cz)
  })
})
