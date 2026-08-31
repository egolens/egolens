import { invertRowMajor4x4, multiplyRowMajor4x4 } from '../../utils/matrix'
import { quaternionToMatrix4x4 } from '../../utils/quaternion'
import type {
  GraphBoxesV1,
  GraphCameraPlanV1,
  GraphEncodedCollectionV1,
  GraphPointCloudPlanV1,
  GraphPoseTimelineV1,
  GraphRecordsV1,
  GraphTableCollectionV1,
  GraphTimelineV1,
} from '../runtime/GraphValues'
import type { NormalizedBox3dV1, NormalizedCameraCalibrationV1, NormalizedTrackPointV1 } from '../runtime/normalizedScene'
import { decodeFeatherColumnsV1, interleaveFeatherNumericColumnsV1 } from './featherColumns'
import { decodeJsonRecordsV1 } from './jsonRecords'
import type { CoreOperatorImplementationV1 } from './registry'
import { headingFromQuaternionWxyzV1 } from './sceneGeometry'

function numericPath(path: string): bigint {
  const match = /(?:^|\/)(\d+)(?:\.[^/.]+)?$/u.exec(path)
  if (!match) throw new Error(`NUMERIC_PATH_TIMESTAMP_MISSING: ${path}`)
  return BigInt(match[1])
}

function finite(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`GRAPH_VALUE_NONFINITE: ${label}`)
  return number
}

function integerTimestamp(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value)
  throw new Error(`GRAPH_TIMESTAMP_INVALID: ${label}`)
}

function fieldList(params: Readonly<Record<string, unknown>>, key: string, fallback: readonly string[]): readonly string[] {
  const value = params[key]
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : fallback
}

function isTable(value: unknown): value is GraphTableCollectionV1 {
  return typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'table-collection'
}

function isRecords(value: unknown): value is GraphRecordsV1 {
  return typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'records'
}

function linkedSignal(lifecycle: AbortSignal, request?: AbortSignal): AbortSignal {
  if (!request) return lifecycle
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([lifecycle, request])
  const controller = new AbortController()
  const abort = () => controller.abort()
  lifecycle.addEventListener('abort', abort, { once: true })
  request.addEventListener('abort', abort, { once: true })
  if (lifecycle.aborted || request.aborted) controller.abort()
  return controller.signal
}

async function loadTable(collection: GraphTableCollectionV1, path: string, requestSignal?: AbortSignal) {
  let pending = collection.cache.get(path)
  if (!pending) {
    pending = (async () => {
      const signal = linkedSignal(collection.context.signal, requestSignal)
      if (signal.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
      const bytes = await collection.context.source.read(path, { signal })
      collection.context.resources.sourceBytes(bytes.byteLength)
      const decoded = decodeFeatherColumnsV1(bytes, collection.params, signal)
      collection.retainedReleases.set(path, collection.context.resources.allocate(bytes.byteLength))
      return decoded
    })()
    collection.cache.set(path, pending)
    void pending.catch(() => collection.cache.delete(path))
  }
  return await pending
}

async function tableRows(collection: GraphTableCollectionV1): Promise<Readonly<Record<string, unknown>>[]> {
  const rows: Readonly<Record<string, unknown>>[] = []
  for (const file of collection.files) {
    collection.context.throwIfAborted()
    const decoded = await loadTable(collection, file.path)
    for (let index = 0; index < decoded.numRows; index += 1) {
      const row: Record<string, unknown> = {}
      for (const [name, values] of Object.entries(decoded.columns)) row[name] = values[index]
      rows.push(row)
    }
  }
  return rows
}

const featherColumns: CoreOperatorImplementationV1 = (inputs, params, context) => {
  if (!Array.isArray(inputs.files)) throw new Error('GRAPH_READER_FILES_INVALID')
  return {
    rows: {
      kind: 'table-collection', files: inputs.files, params, context, cache: new Map(), retainedReleases: new Map(),
    } as unknown as GraphTableCollectionV1,
  }
}

const encodedBytes: CoreOperatorImplementationV1 = (inputs, params, context) => {
  const mimeType = params.mimeType
  if (!Array.isArray(inputs.files) || !['image/jpeg', 'image/png', 'image/webp'].includes(String(mimeType))) {
    throw new Error('GRAPH_ENCODED_SOURCE_INVALID')
  }
  return { bytes: { kind: 'encoded-collection', files: inputs.files, mimeType, context } as GraphEncodedCollectionV1 }
}

const jsonRecords: CoreOperatorImplementationV1 = async (inputs, _params, context) => {
  if (!Array.isArray(inputs.files)) throw new Error('GRAPH_READER_FILES_INVALID')
  const rows: Readonly<Record<string, unknown>>[] = []
  for (const file of inputs.files as readonly { path: string }[]) {
    const bytes = await context.read(file.path)
    rows.push(...decodeJsonRecordsV1<Record<string, unknown>>(new TextDecoder().decode(bytes), {
      maxInputBytes: 16 * 1024 * 1024,
      maxRecords: 1_000_000,
      maxDepth: 16,
      maxRecordKeys: 256,
    }))
  }
  return { rows: { kind: 'records', rows } satisfies GraphRecordsV1 }
}

const timelineSort: CoreOperatorImplementationV1 = async (inputs, params) => {
  const candidate = inputs.lidar ?? inputs.rows ?? inputs.samples
  const unit = String(params.timestampUnit ?? 'us') as GraphTimelineV1['unit']
  let frames: GraphTimelineV1['frames']
  if (isTable(candidate)) {
    frames = candidate.files.map((file) => ({ timestamp: numericPath(file.path), path: file.path }))
  } else if (isRecords(candidate)) {
    const field = String(params.timestampField ?? '')
    frames = candidate.rows.map((row) => ({ timestamp: integerTimestamp(row[field], field) }))
  } else {
    throw new Error('GRAPH_TIMELINE_INPUT_INVALID')
  }
  frames = [...frames].sort((left, right) => left.timestamp < right.timestamp ? -1 : left.timestamp > right.timestamp ? 1 : 0)
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].timestamp <= frames[index - 1].timestamp) throw new Error('TIMESTAMPS_NOT_STRICTLY_INCREASING')
  }
  if (frames.length === 0) throw new Error('TIMELINE_BINDING_EMPTY')
  return { frames: { kind: 'timeline', unit, frames } satisfies GraphTimelineV1 }
}

const timelineJoin: CoreOperatorImplementationV1 = async (inputs, params) => {
  const timeline = inputs.timeline as GraphTimelineV1
  const poses = inputs.poses
  if (timeline?.kind !== 'timeline' || !isTable(poses)) throw new Error('GRAPH_TIMELINE_JOIN_INPUT_INVALID')
  const rows = await tableRows(poses)
  const field = String(params.timestampField ?? 'timestamp_ns')
  const quaternion = fieldList(params, 'quaternionFields', ['qw', 'qx', 'qy', 'qz'])
  const translation = fieldList(params, 'translationFields', ['tx_m', 'ty_m', 'tz_m'])
  const absolute = new Map<bigint, number[]>()
  for (const row of rows) {
    absolute.set(integerTimestamp(row[field], field), quaternionToMatrix4x4(
      [finite(row[quaternion[0]], quaternion[0]), finite(row[quaternion[1]], quaternion[1]), finite(row[quaternion[2]], quaternion[2]), finite(row[quaternion[3]], quaternion[3])],
      [finite(row[translation[0]], translation[0]), finite(row[translation[1]], translation[1]), finite(row[translation[2]], translation[2])],
    ))
  }
  const first = timeline.frames.map((frame) => absolute.get(frame.timestamp)).find(Boolean)
  const originInverse = first ? invertRowMajor4x4(first) : null
  const worldFromEgoByTimestamp = new Map<bigint, Float64Array>()
  if (originInverse) {
    for (const frame of timeline.frames) {
      const matrix = absolute.get(frame.timestamp)
      if (matrix) worldFromEgoByTimestamp.set(frame.timestamp, new Float64Array(multiplyRowMajor4x4(originInverse, matrix)))
    }
  }
  return {
    poses: {
      kind: 'pose-timeline',
      worldOriginInverse: originInverse ? new Float64Array(originInverse) : null,
      worldFromEgoByTimestamp,
    } satisfies GraphPoseTimelineV1,
  }
}

const recordsSelect: CoreOperatorImplementationV1 = async (inputs, params) => {
  const fields = Array.isArray(params.fields) ? params.fields.map(String) : []
  if (isTable(inputs.rows) && typeof params.frameId === 'string') {
    return {
      pointClouds: {
        kind: 'point-cloud-plan', tables: inputs.rows, fields, frameId: params.frameId,
      } satisfies GraphPointCloudPlanV1,
    }
  }
  const materialized = isTable(inputs.rows) ? await tableRows(inputs.rows) : isRecords(inputs.rows) ? inputs.rows.rows : []
  return {
    records: {
      kind: 'records',
      rows: materialized.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))),
    } satisfies GraphRecordsV1,
  }
}

const bindCameraFrame: CoreOperatorImplementationV1 = async (inputs, params) => {
  const encoded = inputs.bytes as GraphEncodedCollectionV1
  if (encoded?.kind !== 'encoded-collection' || !isTable(inputs.intrinsics) || !isTable(inputs.extrinsics)) {
    throw new Error('GRAPH_CAMERA_INPUT_INVALID')
  }
  const intrinsics = await tableRows(inputs.intrinsics)
  const sensorField = String(params.sensorField ?? 'sensor_name')
  const intrinsic = fieldList(params, 'intrinsicFields', ['fx_px', 'fy_px', 'cx_px', 'cy_px', 'k1', 'k2', 'k3', 'width_px', 'height_px'])
  const quaternion = fieldList(params, 'extrinsicQuaternionFields', ['qw', 'qx', 'qy', 'qz'])
  const translation = fieldList(params, 'extrinsicTranslationFields', ['tx_m', 'ty_m', 'tz_m'])
  const extrinsics = new Map((await tableRows(inputs.extrinsics)).map((row) => [String(row[sensorField]), row]))
  const calibrations = new Map<string, NormalizedCameraCalibrationV1>()
  for (const row of intrinsics) {
    const sensorId = String(row[sensorField])
    const extrinsic = extrinsics.get(sensorId)
    if (!extrinsic) continue
    calibrations.set(sensorId, {
      sensorId,
      frameId: `${sensorId}-frame`,
      width: finite(row[intrinsic[7]], intrinsic[7]),
      height: finite(row[intrinsic[8]], intrinsic[8]),
      intrinsics: [finite(row[intrinsic[0]], intrinsic[0]), finite(row[intrinsic[1]], intrinsic[1]), finite(row[intrinsic[2]], intrinsic[2]), finite(row[intrinsic[3]], intrinsic[3])],
      distortionModel: 'brown-conrady',
      distortion: [finite(row[intrinsic[4]], intrinsic[4]), finite(row[intrinsic[5]], intrinsic[5]), 0, 0, finite(row[intrinsic[6]], intrinsic[6])],
      egoFromCamera: new Float64Array(quaternionToMatrix4x4(
        [finite(extrinsic[quaternion[0]], quaternion[0]), finite(extrinsic[quaternion[1]], quaternion[1]), finite(extrinsic[quaternion[2]], quaternion[2]), finite(extrinsic[quaternion[3]], quaternion[3])],
        [finite(extrinsic[translation[0]], translation[0]), finite(extrinsic[translation[1]], translation[1]), finite(extrinsic[translation[2]], translation[2])],
      )),
    })
  }
  return {
    images: {
      kind: 'camera-plan', encoded, calibrations, maxDelta: BigInt(Number(params.maxDeltaNs ?? 0)),
    } satisfies GraphCameraPlanV1,
  }
}

const normalizeBoxes3d: CoreOperatorImplementationV1 = async (inputs, params) => {
  if (!isTable(inputs.annotations)) throw new Error('GRAPH_BOX_INPUT_INVALID')
  const timestampField = String(params.timestampField ?? 'timestamp_ns')
  const classField = String(params.classField ?? 'category')
  const objectIdField = String(params.objectIdField ?? 'track_uuid')
  const quaternion = fieldList(params, 'quaternionFields', ['qw', 'qx', 'qy', 'qz'])
  const center = fieldList(params, 'centerFields', ['tx_m', 'ty_m', 'tz_m'])
  const dimensions = fieldList(params, 'dimensionFields', ['length_m', 'width_m', 'height_m'])
  const byTimestamp = new Map<bigint, NormalizedBox3dV1[]>()
  for (const row of await tableRows(inputs.annotations)) {
    const timestamp = integerTimestamp(row[timestampField], timestampField)
    const orientation: [number, number, number, number] = [finite(row[quaternion[0]], quaternion[0]), finite(row[quaternion[1]], quaternion[1]), finite(row[quaternion[2]], quaternion[2]), finite(row[quaternion[3]], quaternion[3])]
    const id = String(row[objectIdField])
    const box: NormalizedBox3dV1 = {
      id, objectId: id, classId: String(row[classField]), frameId: String(params.frameId),
      center: [finite(row[center[0]], center[0]), finite(row[center[1]], center[1]), finite(row[center[2]], center[2])],
      dimensions: [finite(row[dimensions[0]], dimensions[0]), finite(row[dimensions[1]], dimensions[1]), finite(row[dimensions[2]], dimensions[2])],
      orientation,
      heading: headingFromQuaternionWxyzV1(orientation),
    }
    const list = byTimestamp.get(timestamp) ?? []
    list.push(box)
    byTimestamp.set(timestamp, list)
  }
  return { boxes: { kind: 'boxes3d', byTimestamp } satisfies GraphBoxesV1 }
}

const normalizeBoxes2d: CoreOperatorImplementationV1 = (inputs) => {
  const boxes = inputs.boxes3d as GraphBoxesV1
  const cameras = inputs.cameraImages as GraphCameraPlanV1
  if (boxes?.kind !== 'boxes3d' || cameras?.kind !== 'camera-plan') throw new Error('GRAPH_PROJECTED_BOX_INPUT_INVALID')
  return { boxes: { kind: 'projected-boxes2d', boxes, cameras } }
}

const deriveTrajectories: CoreOperatorImplementationV1 = (inputs) => {
  const boxes = inputs.boxes as GraphBoxesV1
  if (boxes?.kind !== 'boxes3d') throw new Error('GRAPH_TRAJECTORY_INPUT_INVALID')
  const tracks = new Map<string, NormalizedTrackPointV1[]>()
  let frameIndex = 0
  for (const frameBoxes of boxes.byTimestamp.values()) {
    for (const box of frameBoxes) {
      const points = tracks.get(box.objectId) ?? []
      points.push({ frameIndex, position: box.center, classId: box.classId })
      tracks.set(box.objectId, points)
    }
    frameIndex += 1
  }
  return { trajectories: { kind: 'trajectories', tracks } }
}

export const coreGraphOperatorImplementationsV1: Readonly<Record<string, CoreOperatorImplementationV1>> = {
  'feather.columns': featherColumns,
  'image.encoded_bytes': encodedBytes,
  'json.records': jsonRecords,
  'timeline.sort': timelineSort,
  'timeline.join': timelineJoin,
  'records.select': recordsSelect,
  'image.bind_camera_frame': bindCameraFrame,
  'geometry.normalize_boxes3d': normalizeBoxes3d,
  'geometry.normalize_boxes2d': normalizeBoxes2d,
  'tracks.derive_trajectories': deriveTrajectories,
}

export { interleaveFeatherNumericColumnsV1, loadTable as loadGraphTableV1, numericPath as graphNumericPathV1 }
