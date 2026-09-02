import { invertRowMajor4x4, multiplyRowMajor4x4 } from '../../utils/matrix'
import { quaternionToMatrix4x4 } from '../../utils/quaternion'
import type { ParquetRow } from '../../utils/merge'
import { openParquetFile } from '../../utils/parquet'
import type { LidarCalibration } from '../../utils/rangeImage'
import type {
  GraphBinaryCollectionV1,
  GraphBinaryPointCloudPlanV1,
  GraphBoxesV1,
  GraphCameraPlanV1,
  GraphCameraSegmentationV1,
  GraphDecodedBinaryV1,
  GraphEncodedCollectionV1,
  GraphPointCloudPlanV1,
  GraphParquetCameraPlanV1,
  GraphParquetCollectionV1,
  GraphPoseTimelineV1,
  GraphRangeImagePointCloudPlanV1,
  GraphRangeImageSegmentationPlanV1,
  GraphRecordsV1,
  GraphSegmentIndexV1,
  GraphSegmentationPlanV1,
  GraphTableCollectionV1,
  GraphTimelineV1,
  GraphBoxes2dV1,
  GraphBoxRelationsV1,
  GraphKeypointsV1,
} from '../runtime/GraphValues'
import type {
  NormalizedBox2dV1,
  NormalizedBox3dV1,
  NormalizedCameraCalibrationV1,
  NormalizedKeypointSetV1,
  NormalizedSegmentationV1,
  NormalizedTrackPointV1,
} from '../runtime/normalizedScene'
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
import { readParquetColumnsV1 } from './parquetColumns'
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

function isParquet(value: unknown): value is GraphParquetCollectionV1 {
  return typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'parquet-collection'
}

function list(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error(`GRAPH_ARRAY_INVALID: ${label}`)
  }
  return value
}

function binaryBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value.slice(0)
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return copy.buffer
  }
  return null
}

function valueBytes(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength
  if (typeof value === 'number' || typeof value === 'bigint') return 8
  if (typeof value === 'boolean') return 1
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + valueBytes(entry), 0)
  return 0
}

function rowsBytes(rows: readonly ParquetRow[]): number {
  return rows.reduce(
    (sum, row) => sum + Object.values(row).reduce<number>((rowSum, value) => rowSum + valueBytes(value), 0),
    0,
  )
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

export async function loadGraphParquetFileV1(
  collection: GraphParquetCollectionV1,
  path: string,
  requestSignal?: AbortSignal,
) {
  let pending = collection.fileCache.get(path)
  if (!pending) {
    pending = (async () => {
      const source = await collection.context.asyncBuffer(path, requestSignal)
      return await openParquetFile(path, source, { cache: false })
    })()
    collection.fileCache.set(path, pending)
    void pending.catch(() => collection.fileCache.delete(path))
  }
  return await pending
}

export async function loadGraphParquetRowsV1(
  collection: GraphParquetCollectionV1,
  requestSignal?: AbortSignal,
): Promise<readonly ParquetRow[]> {
  const rows: ParquetRow[] = []
  for (const file of collection.files) {
    let pending = collection.cache.get(file.path)
    if (!pending) {
      pending = (async () => {
        const parquet = await loadGraphParquetFileV1(collection, file.path, requestSignal)
        const decoded = await readParquetColumnsV1(parquet, collection.params, { signal: requestSignal })
        collection.retainedReleases.set(`full:${file.path}`, collection.context.resources.allocate(rowsBytes(decoded)))
        return decoded
      })()
      collection.cache.set(file.path, pending)
      void pending.catch(() => collection.cache.delete(file.path))
    }
    rows.push(...await pending)
  }
  return rows
}

async function loadGraphParquetColumnV1(
  collection: GraphParquetCollectionV1,
  columnName: string,
  requestSignal?: AbortSignal,
): Promise<readonly ParquetRow[]> {
  const column = collection.params.columns.find((entry) => entry.name === columnName)
  if (!column) throw new Error(`GRAPH_PARQUET_COLUMN_UNDECLARED: ${columnName}`)
  const rows: ParquetRow[] = []
  for (const file of collection.files) {
    const cacheKey = `${file.path}\u0000${columnName}`
    let pending = collection.projectionCache.get(cacheKey)
    if (!pending) {
      pending = (async () => {
        const parquet = await loadGraphParquetFileV1(collection, file.path, requestSignal)
        const decoded = await readParquetColumnsV1(parquet, {
          ...collection.params,
          columns: [column],
          maxOutputBytes: Math.min(collection.params.maxOutputBytes, Math.max(8, collection.params.maxRows * 8)),
        }, { signal: requestSignal })
        collection.retainedReleases.set(`projection:${cacheKey}`, collection.context.resources.allocate(rowsBytes(decoded)))
        return decoded
      })()
      collection.projectionCache.set(cacheKey, pending)
      void pending.catch(() => collection.projectionCache.delete(cacheKey))
    }
    rows.push(...await pending)
  }
  return rows
}

export async function loadGraphParquetFrameRowsV1(
  collection: GraphParquetCollectionV1,
  timestampField: string,
  timestamp: bigint,
  requestSignal?: AbortSignal,
): Promise<readonly ParquetRow[]> {
  const signal = linkedSignal(collection.context.signal, requestSignal)
  if (signal.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
  const rows: ParquetRow[] = []
  for (const file of collection.files) {
    const frameCacheKey = `${file.path}\u0000${timestampField}\u0000${timestamp}`
    let frameRows = collection.frameRowsCache.get(frameCacheKey)
    if (frameRows) {
      rows.push(...await frameRows)
      if (signal.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
      continue
    }
    const parquet = await loadGraphParquetFileV1(collection, file.path, requestSignal)
    const cacheKey = `${file.path}\u0000${timestampField}`
    let index = collection.frameIndexCache.get(cacheKey)
    if (!index) {
      index = (async () => {
        const timestampColumn = collection.params.columns.find((entry) => entry.name === timestampField)
        if (!timestampColumn || (timestampColumn.type !== 'bigint' && timestampColumn.type !== 'integer')) {
          throw new Error(`GRAPH_PARQUET_TIMESTAMP_COLUMN_INVALID: ${timestampField}`)
        }
        const timestampRows = await readParquetColumnsV1(parquet, {
          columns: [timestampColumn],
          maxInputBytes: collection.params.maxInputBytes,
          maxRows: collection.params.maxRows,
          maxOutputBytes: Math.max(8, collection.params.maxRows * 8),
        }, { signal: requestSignal })
        const byTimestamp = new Map<bigint, { rowStart: number; rowEnd: number }>()
        let previousTimestamp: bigint | undefined
        timestampRows.forEach((row, rowIndex) => {
          const value = integerTimestamp(row[timestampField], timestampField)
          const existing = byTimestamp.get(value)
          if (existing) {
            if (previousTimestamp !== value) throw new Error(`GRAPH_PARQUET_TIMESTAMP_NONCONTIGUOUS: ${timestampField}`)
            existing.rowEnd = rowIndex + 1
          }
          else byTimestamp.set(value, { rowStart: rowIndex, rowEnd: rowIndex + 1 })
          previousTimestamp = value
        })
        collection.retainedReleases.set(`index:${cacheKey}`, collection.context.resources.allocate(timestampRows.length * 24))
        return byTimestamp
      })()
      collection.frameIndexCache.set(cacheKey, index)
      void index.catch(() => collection.frameIndexCache.delete(cacheKey))
    }
    const range = (await index).get(timestamp)
    if (range) {
      frameRows = (async () => {
        const decoded = await readParquetColumnsV1(parquet, collection.params, { ...range, signal: requestSignal })
        collection.retainedReleases.set(`frame:${frameCacheKey}`, collection.context.resources.allocate(rowsBytes(decoded)))
        return decoded
      })()
      collection.frameRowsCache.set(frameCacheKey, frameRows)
      void frameRows.catch(() => collection.frameRowsCache.delete(frameCacheKey))
      rows.push(...await frameRows)
    }
    if (signal.aborted) throw new DOMException('Operator execution was aborted.', 'AbortError')
  }
  return rows
}

async function materialize(value: unknown): Promise<readonly Readonly<Record<string, unknown>>[]> {
  if (isRecords(value)) return value.rows
  if (isTable(value)) return await tableRows(value)
  if (isParquet(value)) return await loadGraphParquetRowsV1(value)
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

const parquetColumns: CoreOperatorImplementationV1 = (inputs, params, context) => {
  if (!Array.isArray(inputs.files)) throw new Error('GRAPH_READER_FILES_INVALID')
  return {
    rows: {
      kind: 'parquet-collection', files: inputs.files, params, context,
      fileCache: new Map(), cache: new Map(), projectionCache: new Map(), frameIndexCache: new Map(),
      frameRowsCache: new Map(), retainedReleases: new Map(),
    } as unknown as GraphParquetCollectionV1,
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
  } else if (isRecords(candidate) || isParquet(candidate)) {
    const records = isRecords(candidate) ? candidate.rows : await loadGraphParquetRowsV1(candidate)
    const field = String(params.timestampField ?? '')
    const keyField = typeof params.keyField === 'string' ? params.keyField : null
    const groupField = typeof params.groupField === 'string' ? params.groupField : null
    frames = records.map((row) => ({
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

const relativePoses: CoreOperatorImplementationV1 = async (inputs, params) => {
  const rows = await materialize(inputs.rows)
  const timestampField = String(params.timestampField)
  const matrixField = String(params.matrixField)
  const absolute = new Map<bigint, number[]>()
  for (const row of rows) {
    const matrix = list(row[matrixField], matrixField)
    if (matrix.length !== 16) throw new Error(`GRAPH_MATRIX_INVALID: ${matrixField}`)
    absolute.set(integerTimestamp(row[timestampField], timestampField), matrix)
  }
  const timestamps = [...absolute.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const first = timestamps.length > 0 ? absolute.get(timestamps[0]) : undefined
  const originInverse = first ? invertRowMajor4x4(first) : null
  const worldFromEgoByTimestamp = new Map<bigint, Float64Array>()
  if (originInverse) {
    for (const timestamp of timestamps) {
      worldFromEgoByTimestamp.set(
        timestamp,
        new Float64Array(multiplyRowMajor4x4(originInverse, absolute.get(timestamp)!)),
      )
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

const rangeImageToCartesian: CoreOperatorImplementationV1 = async (inputs, params) => {
  if (!isParquet(inputs.rangeImages) || !isParquet(inputs.calibration)) {
    throw new Error('GRAPH_RANGE_IMAGE_INPUT_INVALID')
  }
  const sensorField = String(params.sensorField)
  const extrinsicField = String(params.extrinsicField)
  const inclinationValuesField = String(params.inclinationValuesField)
  const inclinationMinField = String(params.inclinationMinField)
  const inclinationMaxField = String(params.inclinationMaxField)
  const calibrations = new Map<number, LidarCalibration>()
  for (const row of await loadGraphParquetRowsV1(inputs.calibration)) {
    const laserName = finite(row[sensorField], sensorField)
    const extrinsic = list(row[extrinsicField], extrinsicField)
    if (extrinsic.length !== 16) throw new Error(`GRAPH_MATRIX_INVALID: ${extrinsicField}`)
    const rawInclinations = row[inclinationValuesField]
    calibrations.set(laserName, {
      laserName,
      extrinsic,
      beamInclinationValues: Array.isArray(rawInclinations) && rawInclinations.length > 0
        ? list(rawInclinations, inclinationValuesField)
        : null,
      beamInclinationMin: Number(row[inclinationMinField] ?? 0),
      beamInclinationMax: Number(row[inclinationMaxField] ?? 0),
    })
  }
  return {
    pointClouds: {
      kind: 'range-image-point-cloud-plan', rows: inputs.rangeImages, calibrations,
      timestampField: String(params.timestampField), sensorField,
      shapeField: String(params.shapeField), valuesField: String(params.valuesField),
      frameId: String(params.outputFrame),
    } satisfies GraphRangeImagePointCloudPlanV1,
  }
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
  if (params.mode === 'segment-stats') {
    const rows = await materialize(inputs.rows)
    if (rows.length === 0) return { segments: { kind: 'segment-index', segments: [] } satisfies GraphSegmentIndexV1 }
    const idField = String(params.idField)
    const typesField = String(params.objectTypesField)
    const countsField = String(params.objectCountsField)
    const perType = new Map<number, number[]>()
    for (const row of rows) {
      const types = list(row[typesField] ?? [], typesField)
      const counts = list(row[countsField] ?? [], countsField)
      types.forEach((type, index) => {
        const values = perType.get(type) ?? []
        values.push(counts[index] ?? 0)
        perType.set(type, values)
      })
    }
    const objectCounts: Record<number, number> = {}
    for (const [type, values] of perType) {
      objectCounts[type] = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    }
    const first = rows[0]
    const id = String(first[idField])
    return {
      segments: {
        kind: 'segment-index',
        segments: [{
          groupId: id, id, label: id, objectCounts,
          metadata: {
            location: String(first[String(params.locationField)] ?? 'Unknown'),
            timeOfDay: String(first[String(params.timeOfDayField)] ?? 'Unknown'),
            weather: String(first[String(params.weatherField)] ?? 'Unknown'),
          },
        }],
      } satisfies GraphSegmentIndexV1,
    }
  }
  const fields = Array.isArray(params.fields) ? params.fields.map(String) : []
  if (isTable(inputs.rows) && typeof params.frameId === 'string') {
    return { pointClouds: { kind: 'point-cloud-plan', tables: inputs.rows, fields, frameId: params.frameId } satisfies GraphPointCloudPlanV1 }
  }
  const materialized = await materialize(inputs.rows)
  const predicates = Array.isArray(params.where) ? params.where as readonly Record<string, unknown>[] : []
  const aliases = typeof params.aliases === 'object' && params.aliases !== null
    ? params.aliases as Readonly<Record<string, unknown>>
    : {}
  const segmentIdentity = typeof params.segmentIdentity === 'object' && params.segmentIdentity !== null
    ? params.segmentIdentity as Readonly<Record<string, unknown>>
    : null
  const metadataKey = segmentIdentity?.metadataKey === undefined
    ? undefined
    : String(segmentIdentity.metadataKey)
  if (metadataKey !== undefined && (metadataKey.length === 0 || metadataKey.length > 128)) {
    throw new Error('GRAPH_SEGMENT_IDENTITY_INVALID')
  }
  return {
    records: {
      kind: 'records',
      rows: materialized
        .filter((row) => predicates.every((predicate) => row[String(predicate.field)] === predicate.equals))
        .map((row) => ({
          ...Object.fromEntries(fields.map((field) => [field, row[field]])),
          ...Object.fromEntries(Object.entries(aliases).map(([target, source]) => [target, row[String(source)]])),
        })),
      ...(segmentIdentity ? {
        segmentIdentity: {
          labelFromSceneId: segmentIdentity.labelFromSceneId === true,
          ...(metadataKey === undefined ? {} : { metadataKey }),
        },
      } : {}),
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
  const sensorTransforms: { sensorId: string; egoFromSensor: Float64Array }[] = []
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
    if (!sensor) continue
    const sensorId = String(sensor[sensorIdField])
    const rotation = finiteTuple(calibration[quaternionField], 4, quaternionField) as [number, number, number, number]
    const translation = finiteTuple(calibration[translationField], 3, translationField) as [number, number, number]
    const egoFromSensor = new Float64Array(quaternionToMatrix4x4(rotation, translation))
    sensorTransforms.push({ sensorId, egoFromSensor })
    if (String(sensor[modalityField]) !== cameraModality) continue
    const matrix = calibration[intrinsicMatrixField]
    if (!Array.isArray(matrix)) continue
    const row0 = finiteTuple(matrix[0], 3, `${intrinsicMatrixField}[0]`)
    const row1 = finiteTuple(matrix[1], 3, `${intrinsicMatrixField}[1]`)
    const [width, height] = dimensionsByCalibration.get(key) ?? [Number(params.defaultWidth), Number(params.defaultHeight)]
    calibrations.set(sensorId, {
      sensorId, frameId: `${sensorId}${String(params.frameIdSuffix)}`, width, height,
      intrinsics: [row0[0], row1[1], row0[2], row1[2]], distortionModel: 'none', distortion: [],
      egoFromCamera: egoFromSensor,
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
  return { kind: 'camera-plan', encoded, calibrations, sensorTransforms, maxDelta: 0n, bindings }
}

async function parquetCameraPlan(
  rows: GraphParquetCollectionV1,
  calibrationRows: GraphParquetCollectionV1,
  params: Readonly<Record<string, unknown>>,
): Promise<GraphParquetCameraPlanV1> {
  const sensorField = String(params.sensorField)
  const extrinsicField = String(params.extrinsicField)
  const widthField = String(params.widthField)
  const heightField = String(params.heightField)
  const intrinsicFields = fieldList(params, 'intrinsicFields', [])
  if (intrinsicFields.length !== 4) throw new Error('GRAPH_CAMERA_INTRINSICS_INVALID')
  const distortionFields = fieldList(params, 'distortionFields', [])
  const opticalToSensor = list(params.opticalToSensor, 'opticalToSensor')
  if (opticalToSensor.length !== 16) throw new Error('GRAPH_MATRIX_INVALID: opticalToSensor')
  const calibrations = new Map<string, NormalizedCameraCalibrationV1>()
  for (const row of await loadGraphParquetRowsV1(calibrationRows)) {
    const sensorId = String(row[sensorField])
    const rawExtrinsic = list(row[extrinsicField], extrinsicField)
    if (rawExtrinsic.length !== 16) throw new Error(`GRAPH_MATRIX_INVALID: ${extrinsicField}`)
    const width = finite(row[widthField], widthField)
    const height = finite(row[heightField], heightField)
    const distortion = distortionFields.map((field) => Number(row[field] ?? 0))
    calibrations.set(sensorId, {
      sensorId,
      frameId: `${sensorId}${String(params.frameIdSuffix)}`,
      width,
      height,
      intrinsics: [
        finite(row[intrinsicFields[0]], intrinsicFields[0]),
        finite(row[intrinsicFields[1]], intrinsicFields[1]),
        finite(row[intrinsicFields[2]] ?? width / 2, intrinsicFields[2]),
        finite(row[intrinsicFields[3]] ?? height / 2, intrinsicFields[3]),
      ],
      distortionModel: distortion.some((value) => value !== 0) ? 'brown-conrady' : 'none',
      distortion,
      egoFromCamera: new Float64Array(multiplyRowMajor4x4(rawExtrinsic, opticalToSensor)),
    })
  }
  return {
    kind: 'parquet-camera-plan', rows, calibrations,
    timestampField: String(params.timestampField), sensorField,
    imageField: String(params.imageField), mimeType: String(params.mimeType) as GraphParquetCameraPlanV1['mimeType'],
  }
}

const bindCameraFrame: CoreOperatorImplementationV1 = async (inputs, params) => {
  if (isParquet(inputs.rows) && isParquet(inputs.calibration)) {
    return { images: await parquetCameraPlan(inputs.rows, inputs.calibration, params) }
  }
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
  if (poses?.kind !== 'pose-timeline') {
    throw new Error('GRAPH_RELATIONAL_BOX_POSE_INVALID: the relational geometry.normalize_boxes3d form requires inputs.poses bound to a relations.token_join result with output "pose-timeline"')
  }
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
  const candidate = inputs.rows ?? inputs.annotations
  if (!isTable(candidate) && !isParquet(candidate)) throw new Error('GRAPH_BOX_INPUT_INVALID')
  const timestampField = String(params.timestampField ?? 'timestamp_ns')
  const classField = String(params.classField ?? 'category')
  const objectIdField = String(params.objectIdField ?? 'track_uuid')
  const quaternion = fieldList(params, 'quaternionFields', ['qw', 'qx', 'qy', 'qz'])
  const center = fieldList(params, 'centerFields', ['tx_m', 'ty_m', 'tz_m'])
  const dimensions = fieldList(params, 'dimensionFields', ['length_m', 'width_m', 'height_m'])
  const classMap = typeof params.classMap === 'object' && params.classMap !== null
    ? params.classMap as Readonly<Record<string, unknown>>
    : {}
  const headingField = typeof params.headingField === 'string' ? params.headingField : null
  const byTimestamp = new Map<bigint, NormalizedBox3dV1[]>()
  for (const row of await materialize(candidate)) {
    const timestamp = integerTimestamp(row[timestampField], timestampField)
    const heading = headingField ? finite(row[headingField], headingField) : null
    const orientation: [number, number, number, number] = heading === null
      ? [finite(row[quaternion[0]], quaternion[0]), finite(row[quaternion[1]], quaternion[1]), finite(row[quaternion[2]], quaternion[2]), finite(row[quaternion[3]], quaternion[3])]
      : [Math.cos(heading / 2), 0, 0, Math.sin(heading / 2)]
    const id = String(row[objectIdField])
    const box: NormalizedBox3dV1 = {
      id, objectId: id, classId: String(classMap[String(row[classField])] ?? row[classField]), frameId: String(params.frameId),
      center: [finite(row[center[0]], center[0]), finite(row[center[1]], center[1]), finite(row[center[2]], center[2])],
      dimensions: [finite(row[dimensions[0]], dimensions[0]), finite(row[dimensions[1]], dimensions[1]), finite(row[dimensions[2]], dimensions[2])],
      orientation, heading: heading ?? headingFromQuaternionWxyzV1(orientation),
    }
    const list = byTimestamp.get(timestamp) ?? []
    list.push(box)
    byTimestamp.set(timestamp, list)
  }
  return { boxes: { kind: 'boxes3d', byTimestamp } satisfies GraphBoxesV1 }
}

const normalizeBoxes2d: CoreOperatorImplementationV1 = async (inputs, params) => {
  const boxes = inputs.boxes3d as GraphBoxesV1
  const cameras = inputs.cameraImages as GraphCameraPlanV1
  if (boxes?.kind === 'boxes3d' && cameras?.kind === 'camera-plan') {
    return { boxes: { kind: 'projected-boxes2d', boxes, cameras } }
  }
  const rows = await materialize(inputs.rows)
  const timestampField = String(params.timestampField)
  const sensorField = String(params.sensorField)
  const objectIdField = String(params.objectIdField)
  const classField = String(params.classField)
  const centerFields = fieldList(params, 'centerFields', [])
  const dimensionFields = fieldList(params, 'dimensionFields', [])
  const classMap = typeof params.classMap === 'object' && params.classMap !== null
    ? params.classMap as Readonly<Record<string, unknown>>
    : {}
  if (centerFields.length !== 2 || dimensionFields.length !== 2) throw new Error('GRAPH_BOX2D_FIELDS_INVALID')
  const byTimestamp = new Map<bigint, NormalizedBox2dV1[]>()
  for (const row of rows) {
    const timestamp = integerTimestamp(row[timestampField], timestampField)
    const objectId = String(row[objectIdField])
    const box: NormalizedBox2dV1 = {
      id: objectId, objectId,
      classId: String(classMap[String(row[classField])] ?? row[classField]),
      cameraId: String(row[sensorField]), presentation: 'rectangle',
      center: [finite(row[centerFields[0]], centerFields[0]), finite(row[centerFields[1]], centerFields[1])],
      dimensions: [finite(row[dimensionFields[0]], dimensionFields[0]), finite(row[dimensionFields[1]], dimensionFields[1])],
    }
    const entries = byTimestamp.get(timestamp) ?? []
    entries.push(box)
    byTimestamp.set(timestamp, entries)
  }
  return { boxes: { kind: 'boxes2d', byTimestamp } satisfies GraphBoxes2dV1 }
}

const deriveTrajectories: CoreOperatorImplementationV1 = (inputs) => {
  const boxes = inputs.boxes as GraphBoxesV1
  if (boxes?.kind !== 'boxes3d') throw new Error('GRAPH_TRAJECTORY_INPUT_INVALID')
  if (boxes.byFrameKey) return { trajectories: { kind: 'trajectory-plan', boxes } }
  const tracks = new Map<string, NormalizedTrackPointV1[]>()
  let frameIndex = 0
  const timestamps = [...boxes.byTimestamp.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  for (const timestamp of timestamps) {
    const frameBoxes = boxes.byTimestamp.get(timestamp) ?? []
    for (const box of frameBoxes) {
      const points = tracks.get(box.objectId) ?? []
      points.push({ frameIndex, position: box.center, classId: box.classId })
      tracks.set(box.objectId, points)
    }
    frameIndex += 1
  }
  return { trajectories: { kind: 'trajectories', tracks } }
}

const compositeKeyJoin: CoreOperatorImplementationV1 = async (inputs, params) => {
  const boxes2d = inputs.boxes2d as GraphBoxes2dV1
  const boxes3d = inputs.boxes3d as GraphBoxesV1
  if (boxes2d?.kind !== 'boxes2d' || boxes3d?.kind !== 'boxes3d') {
    throw new Error('GRAPH_COMPOSITE_JOIN_INPUT_INVALID')
  }
  const associations = await materialize(inputs.associations)
  const cameraObjectField = String(params.cameraObjectField)
  const lidarObjectField = String(params.lidarObjectField)
  const cameraObjects = new Set([...boxes2d.byTimestamp.values()].flat().map((box) => box.objectId))
  const lidarObjects = new Set([
    ...[...boxes3d.byTimestamp.values()].flat().map((box) => box.objectId),
    ...[...(boxes3d.byFrameKey?.values() ?? [])].flat().map((box) => box.objectId),
  ])
  const box2dToBox3d = new Map<string, string>()
  for (const row of associations) {
    const cameraId = row[cameraObjectField]
    const lidarId = row[lidarObjectField]
    if (cameraId === undefined || lidarId === undefined) continue
    const cameraObjectId = String(cameraId)
    const lidarObjectId = String(lidarId)
    if (cameraObjects.has(cameraObjectId) && lidarObjects.has(lidarObjectId)) {
      box2dToBox3d.set(cameraObjectId, lidarObjectId)
    }
  }
  return { relations: { kind: 'box-relations', box2dToBox3d } satisfies GraphBoxRelationsV1 }
}

const normalizeKeypoints: CoreOperatorImplementationV1 = async (inputs, params) => {
  const rows = await materialize(inputs.rows)
  const dimensions = Number(params.dimensions) as 2 | 3
  const timestampField = String(params.timestampField)
  const objectIdField = String(params.objectIdField)
  const typeField = String(params.typeField)
  const coordinateFields = fieldList(params, 'coordinateFields', [])
  const labels = Array.isArray(params.labels) ? params.labels.map(String) : []
  const sensorField = typeof params.sensorField === 'string' ? params.sensorField : null
  const occludedField = typeof params.occludedField === 'string' ? params.occludedField : null
  if (coordinateFields.length !== dimensions) throw new Error('GRAPH_KEYPOINT_FIELDS_INVALID')
  const byTimestamp = new Map<bigint, NormalizedKeypointSetV1[]>()
  const sourceRowsByTimestamp = new Map<bigint, ParquetRow[]>()
  for (const [rowIndex, row] of rows.entries()) {
    const timestamp = integerTimestamp(row[timestampField], timestampField)
    const types = list(row[typeField], typeField)
    const coordinates = coordinateFields.map((field) => list(row[field], field))
    const occluded = occludedField && Array.isArray(row[occludedField]) ? row[occludedField] as boolean[] : []
    const count = Math.min(types.length, ...coordinates.map((values) => values.length))
    const cameraId = sensorField ? String(row[sensorField]) : undefined
    const keypoints: NormalizedKeypointSetV1 = {
      objectId: String(row[objectIdField] ?? `${cameraId ?? 'object'}-${rowIndex}`),
      schemaId: String(params.schemaId), frameId: dimensions === 3 ? String(params.frameId) : `${cameraId}${String(params.frameIdSuffix)}`,
      ...(cameraId ? { cameraId } : {}),
      points: Array.from({ length: count }, (_, index) => ({
        name: labels[types[index]] ?? `Keypoint ${types[index]}`,
        position: dimensions === 3
          ? [coordinates[0][index], coordinates[1][index], coordinates[2][index]] as [number, number, number]
          : [coordinates[0][index], coordinates[1][index]] as [number, number],
        visibility: dimensions === 2 ? (occluded[index] ? 'occluded' : 'visible') : 'unknown',
      })),
    }
    const entries = byTimestamp.get(timestamp) ?? []
    entries.push(keypoints)
    byTimestamp.set(timestamp, entries)
    const sourceRows = sourceRowsByTimestamp.get(timestamp) ?? []
    sourceRows.push(row as ParquetRow)
    sourceRowsByTimestamp.set(timestamp, sourceRows)
  }
  return { keypoints: { kind: 'keypoints', dimensions, byTimestamp, sourceRowsByTimestamp } satisfies GraphKeypointsV1 }
}

const decodeCameraMask: CoreOperatorImplementationV1 = async (inputs, params) => {
  const rows = await materialize(inputs.rows)
  const timestampField = String(params.timestampField)
  const sensorField = String(params.sensorField)
  const labelField = String(params.labelField)
  const divisorField = String(params.divisorField)
  const byTimestamp = new Map<bigint, NormalizedSegmentationV1[]>()
  for (const row of rows) {
    const labels = binaryBuffer(row[labelField])
    if (!labels) continue
    const timestamp = integerTimestamp(row[timestampField], timestampField)
    const entries = byTimestamp.get(timestamp) ?? []
    entries.push({
      sensorId: String(row[sensorField]), taxonomyId: String(params.taxonomy), labels,
      divisor: Number(row[divisorField] ?? params.panopticDivisor ?? 1000), encoding: 'png-uint16',
    })
    byTimestamp.set(timestamp, entries)
  }
  return { segmentation: { kind: 'camera-segmentation', byTimestamp } satisfies GraphCameraSegmentationV1 }
}

const attachLabels: CoreOperatorImplementationV1 = async (inputs, params) => {
  const pointClouds = inputs.pointClouds as GraphBinaryPointCloudPlanV1 | GraphRangeImagePointCloudPlanV1
  if (pointClouds?.kind === 'range-image-point-cloud-plan' && isParquet(inputs.labels)) {
    const timestampField = String(params.timestampField)
    const labelRows = await loadGraphParquetColumnV1(inputs.labels, timestampField)
    return {
      segmentation: {
        kind: 'range-image-segmentation-plan', pointClouds, labels: inputs.labels,
        timestampField, sensorField: String(params.sensorField),
        shapeField: String(params.shapeField), valuesField: String(params.valuesField),
        taxonomyId: String(params.taxonomy), panopticDivisor: Number(params.panopticDivisor ?? 1000),
        availableTimestamps: new Set(labelRows.map((row) => integerTimestamp(row[timestampField], timestampField))),
      } satisfies GraphRangeImageSegmentationPlanV1,
    }
  }
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
  // Selected label files that never reach a bound point-cloud record are an
  // authoring mistake (wrong index, key field, or path field), not an absent
  // capability: fail the sample with the two keys that had to agree.
  if ((availableSemantic.size > 0 || availablePanoptic.size > 0)
    && !pointClouds.bindings.some((binding) => semanticPathByRecordKey.has(binding.recordKey)
      || panopticPathByRecordKey.has(binding.recordKey))) {
    const indexRow = semanticIndex[0] ?? panopticIndex[0]
    const indexKey = indexRow ? `"${String(indexRow[keyField])}" (path "${String(indexRow[pathField])}")` : 'none (labelIndex is missing or empty)'
    const recordKey = pointClouds.bindings[0] ? `"${pointClouds.bindings[0].recordKey}"` : 'none (no point-cloud bindings)'
    throw new Error(`GRAPH_LABEL_INDEX_UNMATCHED: no label file maps to a bound point-cloud record; inputs.labelIndex rows must carry the record key in params.indexRecordKeyField ("${keyField}") and the label file path in params.indexPathField ("${pathField}"). First index key: ${indexKey}; first point-cloud record key: ${recordKey}.`)
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
  'parquet.columns': parquetColumns,
  'image.encoded_bytes': encodedBytes,
  'json.records': jsonRecords,
  'timeline.sort': timelineSort,
  'geometry.relative_poses': relativePoses,
  'geometry.range_image_to_cartesian': rangeImageToCartesian,
  'relations.token_join': tokenJoin,
  'timeline.join': timelineJoin,
  'records.select': recordsSelect,
  'image.bind_camera_frame': bindCameraFrame,
  'geometry.normalize_boxes3d': normalizeBoxes3d,
  'geometry.normalize_boxes2d': normalizeBoxes2d,
  'relations.composite_key_join': compositeKeyJoin,
  'tracks.derive_trajectories': deriveTrajectories,
  'labels.attach_by_point_index': attachLabels,
  'labels.decode_camera_mask': decodeCameraMask,
  'geometry.normalize_keypoints': normalizeKeypoints,
}

export { interleaveFeatherNumericColumnsV1, loadTable as loadGraphTableV1, numericPath as graphNumericPathV1 }
