import { invertRowMajor4x4, multiplyRowMajor4x4 } from '../../utils/matrix'
import { quaternionToMatrix4x4 } from '../../utils/quaternion'
import type {
  GraphBinaryCollectionV1,
  GraphBinaryPointCloudPlanV1,
  GraphBoxesV1,
  GraphCameraPlanV1,
  GraphDecodedBinaryV1,
  GraphEncodedCollectionV1,
  GraphPointCloudPlanV1,
  GraphPoseTimelineV1,
  GraphRecordsV1,
  GraphSegmentIndexV1,
  GraphSegmentationPlanV1,
  GraphTableCollectionV1,
  GraphTimelineV1,
} from '../runtime/GraphValues'
import type { NormalizedBox3dV1, NormalizedCameraCalibrationV1, NormalizedTrackPointV1 } from '../runtime/normalizedScene'
import {
  decodeInterleavedRecordsV1,
  decodeNpzUint16V1,
  decodePcdRecordsV1,
  type InterleavedRecordsParamsV1,
  type NpzUint16ParamsV1,
  type PcdRecordsParamsV1,
} from './binaryReaders'
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

function finiteTuple(value: unknown, length: number, label: string): number[] {
  if (!Array.isArray(value) || value.length < length) throw new Error(`GRAPH_ARRAY_INVALID: ${label}`)
  return value.slice(0, length).map((entry, index) => finite(entry, `${label}[${index}]`))
}

function isTable(value: unknown): value is GraphTableCollectionV1 {
  return typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'table-collection'
}

function isRecords(value: unknown): value is GraphRecordsV1 {
  return typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'records'
}

function isBinary(value: unknown): value is GraphBinaryCollectionV1 {
  return typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'binary-collection'
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
      const bytes = await collection.context.read(path, signal)
      const decoded = decodeFeatherColumnsV1(bytes, collection.params, signal)
      collection.retainedReleases.set(path, collection.context.resources.allocate(bytes.byteLength))
      return decoded
    })()
    collection.cache.set(path, pending)
    void pending.catch(() => collection.cache.delete(path))
  }
  return await pending
}

export async function loadGraphBinaryV1(
  collection: GraphBinaryCollectionV1,
  path: string,
  requestSignal?: AbortSignal,
): Promise<GraphDecodedBinaryV1> {
  let pending = collection.cache.get(path)
  if (!pending) {
    pending = (async () => {
      const signal = linkedSignal(collection.context.signal, requestSignal)
      if (signal.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
      const bytes = await collection.context.read(path, signal)
      const decoded = collection.decoder.kind === 'interleaved'
        ? decodeInterleavedRecordsV1(bytes, collection.decoder.params, signal)
        : collection.decoder.kind === 'pcd'
          ? decodePcdRecordsV1(bytes, collection.decoder.params, signal)
          : await decodeNpzUint16V1(bytes, collection.decoder.params, signal)
      const retainedBytes = decoded instanceof Uint16Array ? decoded.byteLength : decoded.values.byteLength
      collection.retainedReleases.set(path, collection.context.resources.allocate(retainedBytes))
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

async function materialize(value: unknown): Promise<readonly Readonly<Record<string, unknown>>[]> {
  if (isRecords(value)) return value.rows
  if (isTable(value)) return await tableRows(value)
  throw new Error('GRAPH_RECORDS_INPUT_INVALID')
}

function binaryCollection(
  inputs: Readonly<Record<string, unknown>>,
  context: Parameters<CoreOperatorImplementationV1>[2],
  decoder: GraphBinaryCollectionV1['decoder'],
): GraphBinaryCollectionV1 {
  if (!Array.isArray(inputs.files)) throw new Error('GRAPH_READER_FILES_INVALID')
  return {
    kind: 'binary-collection', files: inputs.files, decoder, context,
    cache: new Map(), retainedReleases: new Map(),
  } as GraphBinaryCollectionV1
}

const featherColumns: CoreOperatorImplementationV1 = (inputs, params, context) => {
  if (!Array.isArray(inputs.files)) throw new Error('GRAPH_READER_FILES_INVALID')
  return {
    rows: {
      kind: 'table-collection', files: inputs.files, params, context, cache: new Map(), retainedReleases: new Map(),
    } as unknown as GraphTableCollectionV1,
  }
}

const interleavedRecords: CoreOperatorImplementationV1 = (inputs, params, context) => ({
  records: binaryCollection(inputs, context, { kind: 'interleaved', params: params as unknown as InterleavedRecordsParamsV1 }),
})

const pcdRecords: CoreOperatorImplementationV1 = (inputs, params, context) => ({
  records: binaryCollection(inputs, context, { kind: 'pcd', params: params as unknown as PcdRecordsParamsV1 }),
})

const npzArray: CoreOperatorImplementationV1 = (inputs, params, context) => ({
  values: binaryCollection(inputs, context, { kind: 'npz-uint16', params: params as unknown as NpzUint16ParamsV1 }),
})

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
    try {
      rows.push(...decodeJsonRecordsV1<Record<string, unknown>>(new TextDecoder().decode(bytes)))
    } catch (error) {
      throw new Error(
        `GRAPH_JSON_DECODE_FAILED: ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
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
    const keyField = typeof params.keyField === 'string' ? params.keyField : null
    const groupField = typeof params.groupField === 'string' ? params.groupField : null
    frames = candidate.rows.map((row) => ({
      timestamp: integerTimestamp(row[field], field),
      key: keyField ? String(row[keyField]) : undefined,
      group: groupField ? String(row[groupField]) : undefined,
    }))
  } else {
    throw new Error('GRAPH_TIMELINE_INPUT_INVALID')
  }
  frames = [...frames].sort((left, right) => {
    const leftGroup = String(left.group ?? '')
    const rightGroup = String(right.group ?? '')
    const group = leftGroup < rightGroup ? -1 : leftGroup > rightGroup ? 1 : 0
    if (group !== 0) return group
    return left.timestamp < right.timestamp ? -1 : left.timestamp > right.timestamp ? 1 : 0
  })
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].group === frames[index - 1].group && frames[index].timestamp <= frames[index - 1].timestamp) {
      throw new Error('TIMESTAMPS_NOT_STRICTLY_INCREASING')
    }
  }
  if (frames.length === 0) throw new Error('TIMELINE_BINDING_EMPTY')
  return { frames: { kind: 'timeline', unit, frames } satisfies GraphTimelineV1 }
}

function poseTimelineFromTokenRelations(
  inputs: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
): GraphPoseTimelineV1 {
  if (!isRecords(inputs.sampleData) || !isRecords(inputs.poses) || !isRecords(inputs.calibration) || !isRecords(inputs.sensors)) {
    throw new Error('GRAPH_TOKEN_POSE_INPUT_INVALID')
  }
  const sampleDataKey = String(params.sampleDataCalibrationKeyField)
  const calibrationKey = String(params.calibrationKeyField)
  const calibrationSensorKey = String(params.calibrationSensorKeyField)
  const sensorKey = String(params.sensorKeyField)
  const sensorIdField = String(params.sensorIdField)
  const preferredSensorId = String(params.preferredSensorId)
  const poseReferenceField = String(params.poseReferenceField)
  const poseKeyField = String(params.poseKeyField)
  const frameKeyField = String(params.frameKeyField)
  const keyframeField = String(params.keyframeField)
  const quaternionField = String(params.quaternionField)
  const translationField = String(params.translationField)
  const calibration = new Map(inputs.calibration.rows.map((row) => [String(row[calibrationKey]), row]))
  const sensors = new Map(inputs.sensors.rows.map((row) => [String(row[sensorKey]), row]))
  const poses = new Map(inputs.poses.rows.map((row) => [String(row[poseKeyField]), row]))
  const absoluteWorldFromEgoByFrameKey = new Map<string, Float64Array>()
  for (const row of inputs.sampleData.rows) {
    if (row[keyframeField] !== true) continue
    const calibrated = calibration.get(String(row[sampleDataKey]))
    const sensor = calibrated ? sensors.get(String(calibrated[calibrationSensorKey])) : undefined
    if (!sensor || String(sensor[sensorIdField]) !== preferredSensorId) continue
    const pose = poses.get(String(row[poseReferenceField]))
    if (!pose) continue
    const rotation = finiteTuple(pose[quaternionField], 4, quaternionField) as [number, number, number, number]
    const translation = finiteTuple(pose[translationField], 3, translationField) as [number, number, number]
    absoluteWorldFromEgoByFrameKey.set(
      String(row[frameKeyField]),
      new Float64Array(quaternionToMatrix4x4(rotation, translation)),
    )
  }
  return {
    kind: 'pose-timeline', worldOriginInverse: null, worldFromEgoByTimestamp: new Map(),
    absoluteWorldFromEgoByFrameKey,
  }
}

const tokenJoin: CoreOperatorImplementationV1 = async (inputs, params) => {
  if (params.output === 'pose-timeline') return { poses: poseTimelineFromTokenRelations(inputs, params) }
  const left = await materialize(inputs.left ?? inputs.sampleData)
  const right = await materialize(inputs.right ?? inputs.poses)
  const leftKey = String(params.leftKey)
  const rightKey = String(params.rightKey)
  const join = params.join === 'left' ? 'left' : 'inner'
  const rightFields = typeof params.rightFields === 'object' && params.rightFields !== null
    ? params.rightFields as Readonly<Record<string, unknown>>
    : {}
  const rightByKey = new Map(right.map((row) => [String(row[rightKey]), row]))
  const rows: Readonly<Record<string, unknown>>[] = []
  for (const row of left) {
    const match = rightByKey.get(String(row[leftKey]))
    if (!match && join !== 'left') continue
    const merged: Record<string, unknown> = { ...row }
    for (const [target, source] of Object.entries(rightFields)) merged[target] = match?.[String(source)]
    rows.push(merged)
  }
  return { rows: { kind: 'records', rows } satisfies GraphRecordsV1 }
}

function relationalPointCloudPlan(
  inputs: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
): GraphBinaryPointCloudPlanV1 {
  if (!isBinary(inputs.records) || !isRecords(inputs.sampleData) || !isRecords(inputs.calibration) || !isRecords(inputs.sensors)) {
    throw new Error('GRAPH_POINT_RELATION_INPUT_INVALID')
  }
  const pathField = String(params.pathField)
  const frameKeyField = String(params.frameKeyField)
  const recordKeyField = String(params.recordKeyField)
  const timestampField = String(params.timestampField)
  const recordCalibrationKeyField = String(params.recordCalibrationKeyField)
  const calibrationKeyField = String(params.calibrationKeyField)
  const calibrationSensorKeyField = String(params.calibrationSensorKeyField)
  const sensorKeyField = String(params.sensorKeyField)
  const sensorIdField = String(params.sensorIdField)
  const keyframeField = String(params.keyframeField)
  const quaternionField = String(params.quaternionField)
  const translationField = String(params.translationField)
  const frameId = String(params.outputFrame)
  const files = new Set(inputs.records.files.map((file) => file.path))
  const calibrations = new Map(inputs.calibration.rows.map((row) => [String(row[calibrationKeyField]), row]))
  const sensors = new Map(inputs.sensors.rows.map((row) => [String(row[sensorKeyField]), row]))
  const bindings: GraphBinaryPointCloudPlanV1['bindings'][number][] = []
  for (const row of inputs.sampleData.rows) {
    const path = String(row[pathField])
    if (!files.has(path) || row[keyframeField] !== true) continue
    const calibration = calibrations.get(String(row[recordCalibrationKeyField]))
    const sensor = calibration ? sensors.get(String(calibration[calibrationSensorKeyField])) : undefined
    if (!calibration || !sensor) continue
    const rotation = finiteTuple(calibration[quaternionField], 4, quaternionField) as [number, number, number, number]
    const translation = finiteTuple(calibration[translationField], 3, translationField) as [number, number, number]
    bindings.push({
      frameKey: String(row[frameKeyField]), recordKey: String(row[recordKeyField]),
      timestamp: integerTimestamp(row[timestampField], timestampField), path,
      sensorId: String(sensor[sensorIdField]), frameId,
      egoFromSensor: new Float64Array(quaternionToMatrix4x4(rotation, translation)),
    })
  }
  return { kind: 'binary-point-cloud-plan', records: inputs.records, bindings }
}

const timelineJoin: CoreOperatorImplementationV1 = async (inputs, params) => {
  if (params.mode === 'token' && isBinary(inputs.records)) return { pointClouds: relationalPointCloudPlan(inputs, params) }
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
      kind: 'pose-timeline', worldOriginInverse: originInverse ? new Float64Array(originInverse) : null,
      worldFromEgoByTimestamp,
    } satisfies GraphPoseTimelineV1,
  }
}

function titleCaseDelimited(value: unknown): string {
  return String(value ?? '').split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function timeBucketFromDelimited(value: unknown, delimiter: string, index: number): string {
  const hour = Number.parseInt(String(value ?? '').split(delimiter)[index] ?? '', 10)
  if (!Number.isFinite(hour)) return 'Unknown'
  if (hour >= 6 && hour < 8) return 'Dawn/Dusk'
  if (hour >= 8 && hour < 17) return 'Day'
  if (hour >= 17 && hour < 19) return 'Dawn/Dusk'
  return 'Night'
}

function selectSegments(inputs: Readonly<Record<string, unknown>>, params: Readonly<Record<string, unknown>>): GraphSegmentIndexV1 {
  if (!isRecords(inputs.scenes) || !isRecords(inputs.logs)) throw new Error('GRAPH_SEGMENT_INPUT_INVALID')
  const sceneLogField = String(params.sceneLogField)
  const logKeyField = String(params.logKeyField)
  const groupField = String(params.groupField)
  const idField = String(params.idField)
  const labelField = String(params.labelField)
  const weatherField = String(params.weatherField)
  const locationField = String(params.locationField)
  const timeSourceField = String(params.timeSourceField)
  const logs = new Map(inputs.logs.rows.map((row) => [String(row[logKeyField]), row]))
  return {
    kind: 'segment-index',
    segments: inputs.scenes.rows.map((scene) => {
      const log = logs.get(String(scene[sceneLogField]))
      return {
        groupId: String(scene[groupField]), id: String(scene[idField]), label: String(scene[labelField] ?? ''),
        metadata: {
          location: log ? titleCaseDelimited(log[locationField]) : 'Unknown',
          timeOfDay: log ? timeBucketFromDelimited(log[timeSourceField], String(params.timeDelimiter), Number(params.timePartIndex)) : 'Unknown',
          weather: String(scene[weatherField] ?? ''),
        },
      }
    }),
  }
}

const recordsSelect: CoreOperatorImplementationV1 = async (inputs, params) => {
  if (params.mode === 'segments') return { segments: selectSegments(inputs, params) }
  const fields = Array.isArray(params.fields) ? params.fields.map(String) : []
  if (isTable(inputs.rows) && typeof params.frameId === 'string') {
    return { pointClouds: { kind: 'point-cloud-plan', tables: inputs.rows, fields, frameId: params.frameId } satisfies GraphPointCloudPlanV1 }
  }
  const materialized = await materialize(inputs.rows)
  const predicates = Array.isArray(params.where) ? params.where as readonly Record<string, unknown>[] : []
  const aliases = typeof params.aliases === 'object' && params.aliases !== null
    ? params.aliases as Readonly<Record<string, unknown>>
    : {}
  return {
    records: {
      kind: 'records',
      rows: materialized
        .filter((row) => predicates.every((predicate) => row[String(predicate.field)] === predicate.equals))
        .map((row) => ({
          ...Object.fromEntries(fields.map((field) => [field, row[field]])),
          ...Object.fromEntries(Object.entries(aliases).map(([target, source]) => [target, row[String(source)]])),
        })),
    } satisfies GraphRecordsV1,
  }
}

function relationalCameraPlan(
  encoded: GraphEncodedCollectionV1,
  inputs: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
): GraphCameraPlanV1 {
  if (!isRecords(inputs.sampleData) || !isRecords(inputs.calibration) || !isRecords(inputs.sensors)) {
    throw new Error('GRAPH_CAMERA_RELATION_INPUT_INVALID')
  }
  const calibrationKeyField = String(params.calibrationKeyField)
  const calibrationSensorKeyField = String(params.calibrationSensorKeyField)
  const sensorKeyField = String(params.sensorKeyField)
  const sensorIdField = String(params.sensorIdField)
  const modalityField = String(params.modalityField)
  const cameraModality = String(params.cameraModality)
  const recordCalibrationKeyField = String(params.recordCalibrationKeyField)
  const pathField = String(params.pathField)
  const frameKeyField = String(params.frameKeyField)
  const timestampField = String(params.timestampField)
  const keyframeField = String(params.keyframeField)
  const widthField = String(params.widthField)
  const heightField = String(params.heightField)
  const intrinsicMatrixField = String(params.intrinsicMatrixField)
  const quaternionField = String(params.quaternionField)
  const translationField = String(params.translationField)
  const sensors = new Map(inputs.sensors.rows.map((row) => [String(row[sensorKeyField]), row]))
  const calibrations = new Map<string, NormalizedCameraCalibrationV1>()
  const calibrationByKey = new Map(inputs.calibration.rows.map((row) => [String(row[calibrationKeyField]), row]))
  const dimensionsByCalibration = new Map<string, readonly [number, number]>()
  for (const row of inputs.sampleData.rows) {
    if (row[keyframeField] !== true) continue
    dimensionsByCalibration.set(String(row[recordCalibrationKeyField]), [
      Number(row[widthField]) || Number(params.defaultWidth), Number(row[heightField]) || Number(params.defaultHeight),
    ])
  }
  for (const [key, calibration] of calibrationByKey) {
    const sensor = sensors.get(String(calibration[calibrationSensorKeyField]))
    if (!sensor || String(sensor[modalityField]) !== cameraModality) continue
    const sensorId = String(sensor[sensorIdField])
    const matrix = calibration[intrinsicMatrixField]
    if (!Array.isArray(matrix)) continue
    const row0 = finiteTuple(matrix[0], 3, `${intrinsicMatrixField}[0]`)
    const row1 = finiteTuple(matrix[1], 3, `${intrinsicMatrixField}[1]`)
    const [width, height] = dimensionsByCalibration.get(key) ?? [Number(params.defaultWidth), Number(params.defaultHeight)]
    const rotation = finiteTuple(calibration[quaternionField], 4, quaternionField) as [number, number, number, number]
    const translation = finiteTuple(calibration[translationField], 3, translationField) as [number, number, number]
    calibrations.set(sensorId, {
      sensorId, frameId: `${sensorId}${String(params.frameIdSuffix)}`, width, height,
      intrinsics: [row0[0], row1[1], row0[2], row1[2]], distortionModel: 'none', distortion: [],
      egoFromCamera: new Float64Array(quaternionToMatrix4x4(rotation, translation)),
    })
  }
  const files = new Set(encoded.files.map((file) => file.path))
  const bindings = inputs.sampleData.rows.flatMap((row) => {
    const path = String(row[pathField])
    const calibration = calibrationByKey.get(String(row[recordCalibrationKeyField]))
    const sensor = calibration ? sensors.get(String(calibration[calibrationSensorKeyField])) : undefined
    if (!files.has(path) || row[keyframeField] !== true || !sensor || String(sensor[modalityField]) !== cameraModality) return []
    return [{
      frameKey: String(row[frameKeyField]), timestamp: integerTimestamp(row[timestampField], timestampField),
      path, sensorId: String(sensor[sensorIdField]),
    }]
  })
  return { kind: 'camera-plan', encoded, calibrations, maxDelta: 0n, bindings }
}

const bindCameraFrame: CoreOperatorImplementationV1 = async (inputs, params) => {
  const encoded = inputs.bytes as GraphEncodedCollectionV1
  if (encoded?.kind !== 'encoded-collection') throw new Error('GRAPH_CAMERA_INPUT_INVALID')
  if (isRecords(inputs.sampleData)) return { images: relationalCameraPlan(encoded, inputs, params) }
  if (!isTable(inputs.intrinsics) || !isTable(inputs.extrinsics)) throw new Error('GRAPH_CAMERA_INPUT_INVALID')
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
      sensorId, frameId: `${sensorId}-frame`, width: finite(row[intrinsic[7]], intrinsic[7]), height: finite(row[intrinsic[8]], intrinsic[8]),
      intrinsics: [finite(row[intrinsic[0]], intrinsic[0]), finite(row[intrinsic[1]], intrinsic[1]), finite(row[intrinsic[2]], intrinsic[2]), finite(row[intrinsic[3]], intrinsic[3])],
      distortionModel: 'brown-conrady', distortion: [finite(row[intrinsic[4]], intrinsic[4]), finite(row[intrinsic[5]], intrinsic[5]), 0, 0, finite(row[intrinsic[6]], intrinsic[6])],
      egoFromCamera: new Float64Array(quaternionToMatrix4x4(
        [finite(extrinsic[quaternion[0]], quaternion[0]), finite(extrinsic[quaternion[1]], quaternion[1]), finite(extrinsic[quaternion[2]], quaternion[2]), finite(extrinsic[quaternion[3]], quaternion[3])],
        [finite(extrinsic[translation[0]], translation[0]), finite(extrinsic[translation[1]], translation[1]), finite(extrinsic[translation[2]], translation[2])],
      )),
    })
  }
  return { images: { kind: 'camera-plan', encoded, calibrations, maxDelta: BigInt(Number(params.maxDeltaNs ?? 0)) } satisfies GraphCameraPlanV1 }
}

function relationalBoxes(
  inputs: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
): GraphBoxesV1 {
  if (!isRecords(inputs.annotations) || !isRecords(inputs.instances) || !isRecords(inputs.categories)) {
    throw new Error('GRAPH_RELATIONAL_BOX_INPUT_INVALID')
  }
  const poses = inputs.poses as GraphPoseTimelineV1
  if (poses?.kind !== 'pose-timeline') throw new Error('GRAPH_RELATIONAL_BOX_POSE_INVALID')
  const frameKeyField = String(params.frameKeyField)
  const instanceReferenceField = String(params.instanceReferenceField)
  const instanceKeyField = String(params.instanceKeyField)
  const instanceCategoryField = String(params.instanceCategoryField)
  const categoryKeyField = String(params.categoryKeyField)
  const classField = String(params.classField)
  const quaternionField = String(params.quaternionField)
  const centerField = String(params.centerField)
  const dimensionField = String(params.dimensionField)
  const classMap = typeof params.classMap === 'object' && params.classMap !== null
    ? params.classMap as Readonly<Record<string, unknown>>
    : {}
  const order = Array.isArray(params.dimensionOrder) ? params.dimensionOrder.map(Number) : [0, 1, 2]
  const instances = new Map(inputs.instances.rows.map((row) => [String(row[instanceKeyField]), row]))
  const categories = new Map(inputs.categories.rows.map((row) => [String(row[categoryKeyField]), row]))
  const byFrameKey = new Map<string, NormalizedBox3dV1[]>()
  for (const row of inputs.annotations.rows) {
    const frameKey = String(row[frameKeyField])
    const objectId = String(row[instanceReferenceField])
    const instance = instances.get(objectId)
    const category = instance ? categories.get(String(instance[instanceCategoryField])) : undefined
    const rawClass = String(category?.[classField] ?? '')
    const rotation = finiteTuple(row[quaternionField], 4, quaternionField) as [number, number, number, number]
    const center = finiteTuple(row[centerField], 3, centerField) as [number, number, number]
    const dimensions = finiteTuple(row[dimensionField], 3, dimensionField)
    const boxInWorld = quaternionToMatrix4x4(rotation, center)
    const worldFromEgo = poses.absoluteWorldFromEgoByFrameKey?.get(frameKey)
    const boxInEgo = worldFromEgo ? multiplyRowMajor4x4(invertRowMajor4x4([...worldFromEgo]), boxInWorld) : boxInWorld
    const heading = Math.atan2(boxInEgo[4], boxInEgo[0])
    const box: NormalizedBox3dV1 = {
      id: objectId, objectId, classId: String(classMap[rawClass] ?? params.fallbackClassId), frameId: String(params.frameId),
      center: [boxInEgo[3], boxInEgo[7], boxInEgo[11]], dimensions: [dimensions[order[0]], dimensions[order[1]], dimensions[order[2]]],
      orientation: [Math.cos(heading / 2), 0, 0, Math.sin(heading / 2)], heading,
    }
    const boxes = byFrameKey.get(frameKey) ?? []
    boxes.push(box)
    byFrameKey.set(frameKey, boxes)
  }
  return { kind: 'boxes3d', byTimestamp: new Map(), byFrameKey }
}

const normalizeBoxes3d: CoreOperatorImplementationV1 = async (inputs, params) => {
  if (isRecords(inputs.annotations)) return { boxes: relationalBoxes(inputs, params) }
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
      orientation, heading: headingFromQuaternionWxyzV1(orientation),
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
  if (boxes.byFrameKey) return { trajectories: { kind: 'trajectory-plan', boxes } }
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

const attachLabels: CoreOperatorImplementationV1 = (inputs, params) => {
  const pointClouds = inputs.pointClouds as GraphBinaryPointCloudPlanV1
  if (pointClouds?.kind !== 'binary-point-cloud-plan') throw new Error('GRAPH_LABEL_POINT_INPUT_INVALID')
  const semantic = isBinary(inputs.labels) ? inputs.labels : undefined
  const panoptic = isBinary(inputs.panoptic) ? inputs.panoptic : undefined
  const semanticIndex = isRecords(inputs.labelIndex) ? inputs.labelIndex.rows : []
  const panopticIndex = isRecords(inputs.panopticIndex) ? inputs.panopticIndex.rows : []
  const keyField = String(params.indexRecordKeyField)
  const pathField = String(params.indexPathField)
  const availableSemantic = new Set(semantic?.files.map((file) => file.path) ?? [])
  const availablePanoptic = new Set(panoptic?.files.map((file) => file.path) ?? [])
  const semanticPathByRecordKey = new Map<string, string>()
  const panopticPathByRecordKey = new Map<string, string>()
  for (const row of semanticIndex) {
    const path = String(row[pathField])
    if (availableSemantic.has(path)) semanticPathByRecordKey.set(String(row[keyField]), path)
  }
  for (const row of panopticIndex) {
    const path = String(row[pathField])
    if (availablePanoptic.has(path)) panopticPathByRecordKey.set(String(row[keyField]), path)
  }
  return {
    segmentation: {
      kind: 'segmentation-plan', pointClouds, semantic, panoptic, semanticPathByRecordKey, panopticPathByRecordKey,
      taxonomyId: String(params.taxonomy), panopticDivisor: Number(params.panopticDivisor ?? 1000),
    } satisfies GraphSegmentationPlanV1,
  }
}

export const coreGraphOperatorImplementationsV1: Readonly<Record<string, CoreOperatorImplementationV1>> = {
  'archive.npz_array': npzArray,
  'binary.interleaved_records': interleavedRecords,
  'binary.pcd_records': pcdRecords,
  'feather.columns': featherColumns,
  'image.encoded_bytes': encodedBytes,
  'json.records': jsonRecords,
  'timeline.sort': timelineSort,
  'relations.token_join': tokenJoin,
  'timeline.join': timelineJoin,
  'records.select': recordsSelect,
  'image.bind_camera_frame': bindCameraFrame,
  'geometry.normalize_boxes3d': normalizeBoxes3d,
  'geometry.normalize_boxes2d': normalizeBoxes2d,
  'tracks.derive_trajectories': deriveTrajectories,
  'labels.attach_by_point_index': attachLabels,
}

export { interleaveFeatherNumericColumnsV1, loadTable as loadGraphTableV1, numericPath as graphNumericPathV1 }
