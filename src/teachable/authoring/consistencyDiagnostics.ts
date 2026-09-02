import type { AdapterDiagnostic } from '../recipe/diagnostics'
import { headingFromQuaternionWxyzV1 } from '../operators/sceneGeometry'
import type { NormalizedCameraCalibrationV1, NormalizedFrameV1 } from '../runtime/normalizedScene'
import { projectPointsToCameraV1 } from './reviewThumbnails'

/**
 * Self-consistency checks over the sampled frames. They catch the mistakes a
 * reviewer cannot see in a thumbnail (units, frames, synchronization) and are
 * reported as warnings: the author and the reviewer decide, the run continues.
 */
export interface ConsistencyInputV1 {
  readonly frames: readonly NormalizedFrameV1[]
  readonly cameraCalibrations: ReadonlyMap<string, NormalizedCameraCalibrationV1>
  readonly timestampsMicros: readonly bigint[]
}

const CAMERA_MIN_POINTS = 1000
const CAMERA_MIN_COVERAGE = 0.01
const TIMELINE_GAP_FACTOR = 5
const BOX_EMPTY_FRACTION = 0.5
const EGO_MAX_SPEED_M_PER_S = 60

function warning(code: string, hint: string, jsonPointer?: string): AdapterDiagnostic {
  return { stage: 'sample', severity: 'warning', code, hint, jsonPointer }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!
}

function egoPointCount(frame: NormalizedFrameV1): number {
  return frame.pointClouds.reduce((total, cloud) => total + (cloud.frameId === 'ego' ? cloud.pointCount : 0), 0)
}

export function cameraProjectionDiagnosticsV1(input: ConsistencyInputV1): AdapterDiagnostic[] {
  const diagnostics: AdapterDiagnostic[] = []
  const emptyCameras = new Map<string, number[]>()
  const depthSuspects = new Map<string, number[]>()
  for (const frame of input.frames) {
    const points = egoPointCount(frame)
    if (points < CAMERA_MIN_POINTS) continue
    for (const image of frame.cameraImages) {
      const calibration = input.cameraCalibrations.get(image.calibrationId) ?? input.cameraCalibrations.get(image.sensorId)
      if (!calibration) continue
      const projected = projectPointsToCameraV1(frame.pointClouds, calibration, 4000)
      const sampled = Math.min(points, 4000)
      if (projected.count < sampled * CAMERA_MIN_COVERAGE) {
        emptyCameras.set(image.sensorId, [...(emptyCameras.get(image.sensorId) ?? []), frame.index])
        continue
      }
      const depth = median([...projected.depth])
      if (depth < 1 || depth > 200) depthSuspects.set(image.sensorId, [...(depthSuspects.get(image.sensorId) ?? []), frame.index])
    }
  }
  for (const [sensorId, frames] of emptyCameras) {
    diagnostics.push(warning('CAMERA_PROJECTION_EMPTY', `Fewer than ${CAMERA_MIN_COVERAGE * 100}% of the ego-frame lidar points project into camera "${sensorId}" on frame${frames.length === 1 ? '' : 's'} ${frames.join(', ')}. Check that camera's extrinsic rotation/translation, the optical-frame convention (x right, y down, z forward), and the point-cloud frame.`, '/scene/sensors'))
  }
  for (const [sensorId, frames] of depthSuspects) {
    diagnostics.push(warning('CAMERA_PROJECTION_DEPTH_SUSPECT', `Points projected into camera "${sensorId}" have a median depth below 1 m or above 200 m on frame${frames.length === 1 ? '' : 's'} ${frames.join(', ')}; the point units or the camera translation are probably wrong.`, '/scene/sensors'))
  }
  return diagnostics
}

export function timelineSpacingDiagnosticsV1(input: ConsistencyInputV1): AdapterDiagnostic[] {
  const timestamps = input.timestampsMicros
  if (timestamps.length < 4) return []
  const deltas: number[] = []
  for (let index = 1; index < timestamps.length; index += 1) deltas.push(Number(timestamps[index]! - timestamps[index - 1]!))
  const typical = median(deltas)
  if (!(typical > 0)) return []
  const gaps = deltas.map((delta, index) => ({ delta, index: index + 1 })).filter((entry) => entry.delta > typical * TIMELINE_GAP_FACTOR)
  if (gaps.length === 0) return []
  const shown = gaps.slice(0, 5).map((gap) => `frame ${gap.index} (+${(gap.delta / 1000).toFixed(1)} ms)`).join(', ')
  return [warning('TIMELINE_SPACING_IRREGULAR', `${gaps.length} frame gap${gaps.length === 1 ? '' : 's'} exceed ${TIMELINE_GAP_FACTOR}× the typical spacing of ${(typical / 1000).toFixed(1)} ms: ${shown}. Check the timestamp unit and whether frames from several streams were merged into one timeline.`, '/pipelines')]
}

function pointsInsideBox(frame: NormalizedFrameV1, box: NormalizedFrameV1['boxes3d'][number]): number {
  const heading = box.heading ?? headingFromQuaternionWxyzV1(box.orientation)
  const cos = Math.cos(-heading)
  const sin = Math.sin(-heading)
  const [cx, cy, cz] = box.center
  const [length, width, height] = box.dimensions
  let inside = 0
  for (const cloud of frame.pointClouds) {
    if (cloud.frameId !== 'ego') continue
    const step = Math.max(1, Math.ceil(cloud.pointCount / 20000))
    for (let index = 0; index < cloud.pointCount; index += step) {
      const base = index * cloud.stride
      const dx = cloud.values[base]! - cx
      const dy = cloud.values[base + 1]! - cy
      const dz = cloud.values[base + 2]! - cz
      const lx = cos * dx - sin * dy
      const ly = sin * dx + cos * dy
      if (Math.abs(lx) <= length / 2 && Math.abs(ly) <= width / 2 && Math.abs(dz) <= height / 2) inside += 1
    }
  }
  return inside
}

export function boxPointDensityDiagnosticsV1(input: ConsistencyInputV1): AdapterDiagnostic[] {
  let boxes = 0
  let empty = 0
  for (const frame of input.frames) {
    if (egoPointCount(frame) < CAMERA_MIN_POINTS) continue
    for (const box of frame.boxes3d) {
      if (box.frameId !== 'ego') continue
      boxes += 1
      if (pointsInsideBox(frame, box) === 0) empty += 1
    }
  }
  if (boxes < 4 || empty / boxes < BOX_EMPTY_FRACTION) return []
  return [warning('BOX_POINT_DENSITY_LOW', `${empty} of ${boxes} ego-frame 3D boxes on the sampled frames contain no lidar points. Check the box center/dimension units, the heading convention, and whether boxes and points share the ego frame and timestamp.`, '/pipelines')]
}

export function egoPoseContinuityDiagnosticsV1(input: ConsistencyInputV1): AdapterDiagnostic[] {
  const jumps: string[] = []
  for (let index = 1; index < input.frames.length; index += 1) {
    const previous = input.frames[index - 1]!
    const current = input.frames[index]!
    if (!previous.worldFromEgo || !current.worldFromEgo) continue
    const dt = Number(current.timestampMicros - previous.timestampMicros) / 1e6
    if (!(dt > 0)) continue
    const dx = current.worldFromEgo[3]! - previous.worldFromEgo[3]!
    const dy = current.worldFromEgo[7]! - previous.worldFromEgo[7]!
    const dz = current.worldFromEgo[11]! - previous.worldFromEgo[11]!
    const speed = Math.hypot(dx, dy, dz) / dt
    if (speed > EGO_MAX_SPEED_M_PER_S) jumps.push(`frames ${previous.index}→${current.index} (${speed.toFixed(0)} m/s)`)
  }
  if (jumps.length === 0) return []
  return [warning('EGO_POSE_JUMP', `The ego pose moves faster than ${EGO_MAX_SPEED_M_PER_S} m/s between sampled frames: ${jumps.slice(0, 5).join(', ')}. Check the pose translation units, the timestamp unit, or whether poses were joined to the wrong frames.`, '/pipelines')]
}

export function consistencyDiagnosticsV1(input: ConsistencyInputV1): readonly AdapterDiagnostic[] {
  return [
    ...cameraProjectionDiagnosticsV1(input),
    ...timelineSpacingDiagnosticsV1(input),
    ...boxPointDensityDiagnosticsV1(input),
    ...egoPoseContinuityDiagnosticsV1(input),
  ]
}
