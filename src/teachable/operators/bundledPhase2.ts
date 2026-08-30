import type { CoreOperatorDescriptor, OperatorJsonSchema } from './registry'
import { OperatorRegistry } from './registry'
import { assertValidInterleavedRecordsParamsV1 } from './binaryReaders'
import { assertValidFeatherColumnsParamsV1 } from './featherColumns'

const objectContract: OperatorJsonSchema = {
  type: 'object',
}

const paramsContract: OperatorJsonSchema = {
  type: 'object',
  additionalProperties: true,
}

const byteInputContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    buffer: { type: 'object' },
  },
  required: ['buffer'],
  additionalProperties: false,
}

const numericRecordsOutputContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    values: { type: 'object' },
    pointCount: { type: 'integer', minimum: 0 },
    stride: { type: 'integer', minimum: 1, maximum: 64 },
    attributes: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: { type: 'string' },
    },
  },
  required: ['values', 'pointCount', 'stride', 'attributes'],
  additionalProperties: false,
}

const positiveLimit = { type: 'integer', minimum: 1 }

const interleavedParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    strideBytes: { type: 'integer', minimum: 1, maximum: 4096 },
    littleEndian: { type: 'boolean' },
    fields: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,95}$' },
          type: { enum: ['float32', 'float64', 'uint8', 'uint16', 'uint32', 'int8', 'int16', 'int32'] },
          offsetBytes: { type: 'integer', minimum: 0, maximum: 4095 },
        },
        required: ['name', 'type', 'offsetBytes'],
        additionalProperties: false,
      },
    },
    maxRecords: positiveLimit,
    maxOutputBytes: positiveLimit,
  },
  required: ['strideBytes', 'littleEndian', 'fields'],
  additionalProperties: false,
}

const pcdParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    data: { const: 'binary' },
    trailingPadding: { const: 'zero' },
    maxTrailingBytes: { type: 'integer', minimum: 1, maximum: 65536 },
    fields: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,95}$' },
    },
    maxHeaderBytes: positiveLimit,
    maxPoints: positiveLimit,
    maxOutputBytes: positiveLimit,
  },
  required: ['data', 'fields'],
  additionalProperties: false,
}

const npzParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    arrayName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,95}$' },
    maxEntries: positiveLimit,
    maxExpandedBytes: positiveLimit,
    maxCompressionRatio: { type: 'number', exclusiveMinimum: 0 },
    maxElements: positiveLimit,
    maxRank: { type: 'integer', minimum: 1, maximum: 16 },
  },
  required: ['arrayName'],
  additionalProperties: false,
}

const featherParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    columns: {
      type: 'array',
      minItems: 1,
      maxItems: 128,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,95}$' },
          type: { enum: ['float16', 'float32', 'float64', 'uint8', 'uint16', 'uint32', 'int8', 'int16', 'int32', 'int64', 'utf8'] },
        },
        required: ['name', 'type'],
        additionalProperties: false,
      },
    },
    maxInputBytes: positiveLimit,
    maxRows: positiveLimit,
    maxOutputBytes: positiveLimit,
  },
  required: ['columns', 'maxInputBytes', 'maxRows', 'maxOutputBytes'],
  additionalProperties: false,
}

const emptyParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

function closedParams(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): OperatorJsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

function recordContract(fields: readonly string[]): OperatorJsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((field) => [field, {}])),
    required: fields,
    additionalProperties: false,
  }
}

const strictGraphOperators: readonly CoreOperatorDescriptor[] = [
  ['geometry.normalize_boxes2d', {
    oneOf: [
      recordContract(['rows']),
      recordContract(['boxes3d', 'cameraImages', 'calibration']),
      recordContract(['boxes3d', 'cameraImages', 'intrinsics', 'extrinsics']),
    ],
  }, {
    oneOf: [
      closedParams({ source: { const: 'projected-box3d' }, clipToImage: { type: 'boolean' } }, ['source', 'clipToImage']),
      closedParams({ geometry: { const: 'center-size-pixels' } }, ['geometry']),
    ],
  }, recordContract(['boxes'])],
  ['geometry.normalize_boxes3d', {
    oneOf: [
      recordContract(['rows']),
      recordContract(['annotations']),
      recordContract(['annotations', 'instances', 'categories']),
    ],
  }, closedParams({
    quaternionOrder: { const: 'wxyz' },
    frameId: { type: 'string', minLength: 1, maxLength: 96 },
  }, ['frameId']), recordContract(['boxes'])],
  ['image.bind_camera_frame', {
    oneOf: [
      recordContract(['rows', 'calibration']),
      recordContract(['bytes', 'sampleData', 'calibration']),
      recordContract(['bytes', 'intrinsics', 'extrinsics']),
    ],
  }, {
    oneOf: [
      closedParams({ timestampField: { type: 'string', minLength: 1, maxLength: 256 } }, ['timestampField']),
      closedParams({
        timestampFrom: { const: 'numeric-path' },
        maxDeltaNs: positiveLimit,
      }, ['timestampFrom', 'maxDeltaNs']),
      closedParams({ encoding: { const: 'jpeg' } }, ['encoding']),
    ],
  }, recordContract(['images'])],
  ['image.encoded_bytes', byteInputContract, closedParams({
    mimeType: { enum: ['image/jpeg', 'image/png', 'image/webp'] },
  }, ['mimeType']), recordContract(['bytes'])],
  ['json.records', byteInputContract, emptyParamsContract, recordContract(['rows'])],
  ['labels.attach_by_point_index', recordContract(['pointClouds', 'labels']), closedParams({
    taxonomy: { type: 'string', minLength: 1, maxLength: 96 },
  }, ['taxonomy']), recordContract(['segmentation'])],
  ['records.select', recordContract(['rows']), closedParams({
    fields: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } },
    frameId: { type: 'string', minLength: 1, maxLength: 96 },
  }, ['fields']), recordContract(['records'])],
  ['relations.token_join', recordContract(['sampleData', 'poses']), closedParams({
    leftKey: { type: 'string', minLength: 1, maxLength: 256 },
    rightKey: { type: 'string', minLength: 1, maxLength: 256 },
  }, ['leftKey', 'rightKey']), recordContract(['rows'])],
  ['timeline.join', {
    oneOf: [
      recordContract(['records', 'sampleData', 'calibration']),
      recordContract(['timeline', 'poses']),
    ],
  }, {
    oneOf: [
      closedParams({ mode: { const: 'token' }, timestampField: { type: 'string', minLength: 1, maxLength: 256 } }, ['mode']),
      closedParams({
        mode: { const: 'nearest' },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        maxDeltaNs: positiveLimit,
      }, ['mode', 'timestampField', 'maxDeltaNs']),
    ],
  }, recordContract(['pointClouds'])],
  ['timeline.sort', {
    oneOf: [recordContract(['samples']), recordContract(['rows']), recordContract(['lidar'])],
  }, {
    oneOf: [
      closedParams({ timestampField: { type: 'string', minLength: 1, maxLength: 256 } }, ['timestampField']),
      closedParams({
        timestampFrom: { const: 'numeric-path' },
        timestampUnit: { enum: ['ns', 'us', 'ms', 's'] },
      }, ['timestampFrom', 'timestampUnit']),
    ],
  }, recordContract(['frames'])],
  ['tracks.derive_trajectories', recordContract(['boxes']), closedParams({
    objectIdField: { type: 'string', minLength: 1, maxLength: 256 },
  }, ['objectIdField']), recordContract(['trajectories'])],
].map(([name, inputContract, operatorParamsContract, outputContract]): CoreOperatorDescriptor => ({
  name: name as string,
  majorVersion: 1,
  provider: 'core',
  tier: 1,
  inputContract: inputContract as OperatorJsonSchema,
  paramsContract: operatorParamsContract as OperatorJsonSchema,
  outputContract: outputContract as OperatorJsonSchema,
  execution: 'worker',
  deterministic: true,
}))

const strictBinaryOperators: readonly CoreOperatorDescriptor[] = [
  {
    name: 'archive.npz_array',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: npzParamsContract,
    outputContract: {
      type: 'object',
      properties: { values: { type: 'object' } },
      required: ['values'],
      additionalProperties: false,
    },
    execution: 'worker',
    deterministic: true,
  },
  {
    name: 'binary.interleaved_records',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: interleavedParamsContract,
    outputContract: numericRecordsOutputContract,
    validateParams: (params) => {
      try {
        assertValidInterleavedRecordsParamsV1(params as never)
        return []
      } catch (error) {
        return [{ message: error instanceof Error ? error.message : String(error) }]
      }
    },
    execution: 'worker',
    deterministic: true,
  },
  {
    name: 'binary.pcd_records',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: pcdParamsContract,
    outputContract: numericRecordsOutputContract,
    execution: 'worker',
    deterministic: true,
  },
]

const strictFeatherOperator: CoreOperatorDescriptor = {
  name: 'feather.columns',
  majorVersion: 1,
  provider: 'core',
  tier: 1,
  inputContract: byteInputContract,
  paramsContract: featherParamsContract,
  outputContract: {
    type: 'object',
    properties: {
      columns: { type: 'object' },
      numRows: { type: 'integer', minimum: 0 },
    },
    required: ['columns', 'numRows'],
    additionalProperties: false,
  },
  validateParams: (params) => {
    try {
      assertValidFeatherColumnsParamsV1(params as never)
      return []
    } catch (error) {
      return [{ message: error instanceof Error ? error.message : String(error) }]
    }
  },
  execution: 'worker',
  deterministic: true,
}

const workerOperators = [
  'geometry.normalize_keypoints',
  'geometry.range_image_to_cartesian',
  'geometry.relative_poses',
  'labels.decode_camera_mask',
  'labels.panoptic_split',
  'parquet.columns',
  'relations.composite_key_join',
] as const

/**
 * Compile-time descriptors for the generic operators referenced by bundled
 * Phase 2 recipes. Runtime execution is connected dataset-by-dataset in later
 * phases; recipe compilation never treats a missing implementation as an
 * implicit dataset-specific escape hatch.
 */
export const BUNDLED_PHASE2_OPERATOR_DESCRIPTORS: readonly CoreOperatorDescriptor[] = [
  ...strictBinaryOperators,
  strictFeatherOperator,
  ...strictGraphOperators,
  ...workerOperators.map((name): CoreOperatorDescriptor => ({
    name,
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: objectContract,
    paramsContract,
    outputContract: objectContract,
    execution: 'worker',
    deterministic: true,
  })),
]

export const bundledPhase2OperatorRegistry = new OperatorRegistry(
  BUNDLED_PHASE2_OPERATOR_DESCRIPTORS,
)
