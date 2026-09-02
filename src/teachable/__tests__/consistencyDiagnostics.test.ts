import { describe, expect, it } from 'vitest'
import {
  boxPointDensityDiagnosticsV1, cameraProjectionDiagnosticsV1, consistencyDiagnosticsV1,
  egoPoseContinuityDiagnosticsV1, timelineSpacingDiagnosticsV1,
} from '../authoring/consistencyDiagnostics'
import type { NormalizedCameraCalibrationV1, NormalizedFrameV1, NormalizedPointCloudV1 } from '../runtime/normalizedScene'

const forwardCamera: NormalizedCameraCalibrationV1 = {
  sensorId: 'cam', frameId: 'cam-frame', width: 400, height: 200, intrinsics: [100, 100, 200, 100],
  distortionModel: 'none', distortion: [], egoFromCamera: new Float64Array([0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1]),
}
// Same camera but translated 500 m ahead: every point falls behind it.
const displacedCamera: NormalizedCameraCalibrationV1 = { ...forwardCamera, egoFromCamera: new Float64Array([0, 0, 1, 500, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1]) }

function cloud(count: number, spread = 5): NormalizedPointCloudV1 {
  const values = new Float32Array(count * 3)
  for (let index = 0; index < count; index += 1) { values[index * 3] = 10 + (index % 40) * 0.5; values[index * 3 + 1] = ((index % 11) - 5) * spread / 5; values[index * 3 + 2] = (index % 3) - 1 }
  return { sensorId: 'lidar', frameId: 'ego', values, pointCount: count, stride: 3, attributes: ['x', 'y', 'z'] } as NormalizedPointCloudV1
}
function frame(index: number, overrides: Partial<NormalizedFrameV1> = {}): NormalizedFrameV1 {
  return {
    index, timestampMicros: BigInt(index) * 100_000n, worldFromEgo: null,
    pointClouds: [cloud(2000)], radarPointClouds: [], cameraImages: [{ sensorId: 'cam', calibrationId: 'cam', encodedBytes: new ArrayBuffer(0), mimeType: 'image/png', width: 400, height: 200, timestampMicros: 0n }],
    boxes3d: [], boxes2d: [], keypoints3d: [], keypoints2d: [], lidarSegmentation: [], cameraSegmentation: [],
    ...overrides,
  } as NormalizedFrameV1
}
const timestamps = (count: number, gapAt?: number) => Array.from({ length: count }, (_, index) => BigInt(index) * 100_000n + (gapAt !== undefined && index >= gapAt ? 5_000_000n : 0n))

describe('self-consistency diagnostics', () => {
  it('flags a camera that receives none of the lidar points and stays quiet for a plausible one', () => {
    const input = { frames: [frame(0), frame(1)], timestampsMicros: timestamps(2) }
    expect(cameraProjectionDiagnosticsV1({ ...input, cameraCalibrations: new Map([['cam', forwardCamera]]) })).toEqual([])
    const flagged = cameraProjectionDiagnosticsV1({ ...input, cameraCalibrations: new Map([['cam', displacedCamera]]) })
    expect(flagged).toMatchObject([{ code: 'CAMERA_PROJECTION_EMPTY', severity: 'warning' }])
    expect(flagged[0]!.hint).toMatch(/camera "cam" on frames 0, 1/u)
  })

  it('flags an irregular timeline gap relative to the typical spacing', () => {
    const base = { frames: [], cameraCalibrations: new Map() }
    expect(timelineSpacingDiagnosticsV1({ ...base, timestampsMicros: timestamps(10) })).toEqual([])
    const flagged = timelineSpacingDiagnosticsV1({ ...base, timestampsMicros: timestamps(10, 6) })
    expect(flagged).toMatchObject([{ code: 'TIMELINE_SPACING_IRREGULAR' }])
    expect(flagged[0]!.hint).toMatch(/frame 6 \(\+5100\.0 ms\)/u)
  })

  it('flags boxes that contain no points when most of them are empty', () => {
    const onPoints = { id: 'a', objectId: 'a', classId: 'car', frameId: 'ego', center: [15, 0, 0], dimensions: [4, 2, 2], orientation: [1, 0, 0, 0] }
    const offPoints = { ...onPoints, id: 'b', center: [15, 80, 0] }
    const good = frame(0, { boxes3d: [onPoints, onPoints, onPoints, onPoints] as never })
    const bad = frame(0, { boxes3d: [offPoints, offPoints, offPoints, onPoints] as never })
    const base = { cameraCalibrations: new Map(), timestampsMicros: timestamps(1) }
    expect(boxPointDensityDiagnosticsV1({ ...base, frames: [good] })).toEqual([])
    expect(boxPointDensityDiagnosticsV1({ ...base, frames: [bad] })).toMatchObject([{ code: 'BOX_POINT_DENSITY_LOW' }])
  })

  it('flags an ego pose that jumps faster than a vehicle can move', () => {
    const pose = (x: number) => new Float64Array([1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const base = { cameraCalibrations: new Map(), timestampsMicros: timestamps(3) }
    expect(egoPoseContinuityDiagnosticsV1({ ...base, frames: [frame(0, { worldFromEgo: pose(0) }), frame(1, { worldFromEgo: pose(2) })] })).toEqual([])
    const flagged = egoPoseContinuityDiagnosticsV1({ ...base, frames: [frame(0, { worldFromEgo: pose(0) }), frame(1, { worldFromEgo: pose(50) })] })
    expect(flagged).toMatchObject([{ code: 'EGO_POSE_JUMP' }])
    expect(flagged[0]!.hint).toMatch(/frames 0→1 \(500 m\/s\)/u)
  })

  it('combines every check into warnings only', () => {
    const all = consistencyDiagnosticsV1({ frames: [frame(0), frame(1)], cameraCalibrations: new Map([['cam', displacedCamera]]), timestampsMicros: timestamps(10, 6) })
    expect(all.map((item) => item.code)).toEqual(['CAMERA_PROJECTION_EMPTY', 'TIMELINE_SPACING_IRREGULAR'])
    expect(all.every((item) => item.severity === 'warning')).toBe(true)
  })
})
