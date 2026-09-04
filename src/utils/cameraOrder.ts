import type { CameraSensorDef, CameraViewV1 } from '../types/dataset'
import type { ParquetRow } from './merge'

const CAM_PREFIX = '[CameraCalibrationComponent]'

/** Mounting yaw (radians, ego frame, +left) of a camera from its ego ← camera extrinsic. */
export function cameraYawFromExtrinsic(extrinsic: readonly number[], isOpticalFrame: boolean): number {
  // Row-major 4×4: the camera's forward axis in ego coordinates is column 2 (optical z)
  // or column 0 (Waymo-style x-forward camera frame).
  const column = isOpticalFrame ? 2 : 0
  return Math.atan2(extrinsic[4 + column] ?? 0, extrinsic[column] ?? 1)
}

/**
 * Order camera tiles the way a person turns their head: a left-to-right sweep
 * that starts at the leftmost forward-facing camera and continues around the
 * right side to the rear. Cameras with (near) identical yaw keep their given
 * order, so a stereo rig stays left, right. Cameras without a calibration row
 * are appended in their given order.
 */
/** Mounting yaw per camera id from calibration rows (radians, +left). */
export function cameraYawsFromRowsV1(calibrationRows: readonly ParquetRow[]): Map<number, number> {
  const yawById = new Map<number, number>()
  for (const row of calibrationRows) {
    const id = row['key.camera_name']
    const extrinsic = row[`${CAM_PREFIX}.extrinsic.transform`]
    if (typeof id !== 'number' || !Array.isArray(extrinsic) || extrinsic.length !== 16) continue
    yawById.set(id, cameraYawFromExtrinsic(extrinsic as number[], Boolean(row.__isOpticalFrame)))
  }
  return yawById
}

/**
 * Two-row layout for narrow screens: the forward hemisphere on top (left → right,
 * so the front camera sits in the middle) and the rest below as seen from above
 * (left side, rear, right side, so the rear camera sits in the middle). Returns
 * null when fewer than two cameras have a calibration.
 */
export function splitCamerasIntoRowsV1(cameras: readonly CameraSensorDef[], calibrationRows: readonly ParquetRow[]): [CameraSensorDef[], CameraSensorDef[]] | null {
  if (allHaveViews(cameras)) {
    const forward = cameras.filter((camera) => FORWARD_VIEWS.includes(camera.view)).sort((a, b) => FORWARD_VIEWS.indexOf(a.view) - FORWARD_VIEWS.indexOf(b.view) || cameras.indexOf(a) - cameras.indexOf(b))
    const rest = cameras.filter((camera) => !FORWARD_VIEWS.includes(camera.view)).sort((a, b) => REAR_ROW.indexOf(a.view) - REAR_ROW.indexOf(b.view) || cameras.indexOf(a) - cameras.indexOf(b))
    return [forward, rest]
  }
  const yawById = cameraYawsFromRowsV1(calibrationRows)
  const known = cameras.filter((camera) => yawById.has(camera.id))
  if (known.length < 2) return null
  const degrees = (camera: CameraSensorDef) => (yawById.get(camera.id)! * 180) / Math.PI
  const forward = known.filter((camera) => Math.abs(degrees(camera)) < 85)
  const rest = [...known.filter((camera) => Math.abs(degrees(camera)) >= 85), ...cameras.filter((camera) => !yawById.has(camera.id))]
  const byYawDesc = (left: CameraSensorDef, right: CameraSensorDef) => Math.round(degrees(right) / 5) - Math.round(degrees(left) / 5) || known.indexOf(left) - known.indexOf(right)
  const lateral = (camera: CameraSensorDef) => (yawById.has(camera.id) ? Math.sin(yawById.get(camera.id)!) : 0)
  const byLateralDesc = (left: CameraSensorDef, right: CameraSensorDef) => Math.round((lateral(right) - lateral(left)) * 20) || cameras.indexOf(left) - cameras.indexOf(right)
  return [forward.sort(byYawDesc), rest.sort(byLateralDesc)]
}


/**
 * Head-turn sweep by declared view: left side → front-left → front → front-right →
 * right side → rear-right → rear → rear-left. A recipe author (or the agent, when a
 * person asks) controls tile order through `image.view`; yaw is the fallback.
 */
const VIEW_SWEEP: readonly CameraViewV1[] = ['side-left', 'front-left', 'front', 'front-right', 'side-right', 'rear-right', 'rear', 'rear-left']
const FORWARD_VIEWS: readonly CameraViewV1[] = ['front-left', 'front', 'front-right']
/** Rear row as seen from above, left → right: left side, rear-left, rear, rear-right, right side. */
const REAR_ROW: readonly CameraViewV1[] = ['side-left', 'rear-left', 'rear', 'rear-right', 'side-right']

function allHaveViews(cameras: readonly CameraSensorDef[]): cameras is readonly (CameraSensorDef & { view: CameraViewV1 })[] {
  return cameras.length > 1 && cameras.every((camera) => camera.view !== undefined)
}

export function orderCamerasByViewV1(cameras: readonly (CameraSensorDef & { view: CameraViewV1 })[]): CameraSensorDef[] {
  return [...cameras].sort((left, right) => VIEW_SWEEP.indexOf(left.view) - VIEW_SWEEP.indexOf(right.view) || cameras.indexOf(left) - cameras.indexOf(right))
}

export function orderCamerasByYawV1(cameras: readonly CameraSensorDef[], calibrationRows: readonly ParquetRow[]): CameraSensorDef[] {
  if (allHaveViews(cameras)) return orderCamerasByViewV1(cameras)
  const yawById = new Map<number, number>()
  for (const row of calibrationRows) {
    const id = row['key.camera_name']
    const extrinsic = row[`${CAM_PREFIX}.extrinsic.transform`]
    if (typeof id !== 'number' || !Array.isArray(extrinsic) || extrinsic.length !== 16) continue
    yawById.set(id, cameraYawFromExtrinsic(extrinsic as number[], Boolean(row.__isOpticalFrame)))
  }
  const known = cameras.filter((camera) => yawById.has(camera.id))
  const unknown = cameras.filter((camera) => !yawById.has(camera.id))
  if (known.length < 2) return [...cameras]
  const degrees = (camera: CameraSensorDef) => (yawById.get(camera.id)! * 180) / Math.PI
  const bucket = (camera: CameraSensorDef) => Math.round(degrees(camera) / 5) // 5° buckets keep stereo pairs stable
  const sorted = [...known].sort((left, right) => bucket(right) - bucket(left) || known.indexOf(left) - known.indexOf(right))
  // Start the sweep at the leftmost camera that still looks forward-ish (≤ 120° from forward).
  const startIndex = sorted.findIndex((camera) => degrees(camera) <= 120)
  const rotated = startIndex > 0 ? [...sorted.slice(startIndex), ...sorted.slice(0, startIndex)] : sorted
  return [...rotated, ...unknown]
}

const LABEL_WORDS: Record<string, string> = { FRONT: 'F', BACK: 'B', REAR: 'B', LEFT: 'L', RIGHT: 'R', SIDE: 'S', CENTER: '', CENTRE: '', CAMERA: '', CAM: '' }

/**
 * Short camera label for narrow tiles: "FRONT-LEFT CAMERA" → "FL", "BACK CAMERA" → "B",
 * "SIDE LEFT" → "SL". Unknown words keep their initial so custom names stay distinct.
 */
export function abbreviateCameraLabelV1(label: string): string {
  const words = label.toUpperCase().split(/[\s_-]+/u).filter(Boolean)
  if (words.length < 2 && !LABEL_WORDS[words[0] ?? '']) return label
  const short = words.map((word) => LABEL_WORDS[word] ?? word[0] ?? '').join('')
  return short.length > 0 ? short : label
}
