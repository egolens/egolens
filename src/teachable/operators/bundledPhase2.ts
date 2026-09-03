import type { CoreOperatorDescriptor, OperatorJsonSchema } from './registry'
import { OperatorRegistry } from './registry'
import { DedicatedWorkerExtensionExecutor } from '../extensions/ExtensionOperatorExecutor'
import { registerBuiltInExtensionPackagesV1 } from '../extensions/registeredPackages'
import { assertValidInterleavedRecordsParamsV1 } from './binaryReaders'
import { assertValidFeatherColumnsParamsV1 } from './featherColumns'
import { assertValidParquetColumnsParamsV1 } from './parquetColumns'
import { coreGraphOperatorImplementationsV1 } from './coreGraphOperators'

/**
 * Input/output semantics that JSON schema cannot express. Shown to agents
 * through get_contract. These describe the vocabulary, never a dataset.
 */
export const OPERATOR_DOCS_V1: Readonly<Record<string, string>> = {
  'archive.pickle_records': 'Streaming point-cloud reader. Output `records` is a binary collection: one entry per matched file, decoded lazily per frame (fields: files[].path). Params: `columns` = DataFrame column names to read in order, `attributes` = names they get in the point layout (x, y, z first). Feed `records` to timeline.join (inputs.records) or labels.attach_by_point_index; never to records operators.',
  'archive.pickle_rows': 'Whole-file row reader for small metadata tables (cuboids, poses): every row of every matched file becomes one record; `pathField` adds the file path, `indexField` the row index. Hard budget 250k rows across all files. Not for point clouds.',
  'json.records': 'Reads JSON files into records. layout "array": each element is a row (indexField adds its index). layout "object-rows": each top-level key is a row (key under keyField). layout "file-row": the whole object is one row (flatten: true turns nested keys into dotted fields). pathField adds the file path.',
  'text.table': 'Reads a text file into rows. layout "delimited" with `delimiter`, `columns` (names), `header` (whether row 1 is a header), `numeric` (parse numbers), `maxRows`/`maxColumns`. A one-line JSON array can be split with delimiter "," into one row of N columns.',
  'records.unpivot': 'Turns columns into rows. `pattern` (regex with groups) matches column names; `keyGroup` is the group that becomes the row key (stored under `keyField`), `fieldGroup` the group that becomes the output field name. Use it to turn 80 columns "00_x, 01_x…" into 80 rows with key 00, 01… and field x.',
  'records.derive': 'Adds fields to each record. Each derivation: `field` (new name), `from` (source field; dotted paths reach nested JSON), optional `pattern`/`replacement` (regex rewrite; `required: true` drops rows that do not match), `pad`/`padChar` (zero-pad), `scale`/`offset`/`integer` (numeric conversion: float seconds → integer microseconds is { scale: 1000000, integer: true }).',
  'relations.token_join': 'Inner or left join of two record sets on `leftKey` = `rightKey`; `rightFields` maps right-hand fields into the left rows ({ outputName: rightField }). Output `rows`.',
  'timeline.sort': 'Builds the timeline from records: `timestampField` (integer, unit = `timestampUnit`), `keyField` (frame key that other tables join on), `groupField` (the scene/segment id; the same constant for every row of one log). Output `frames`.',
  'timeline.join': 'mode "token": binds one point-cloud file per frame. inputs.records = binary collection from a point-cloud reader; inputs.sampleData = records with one row per file carrying `pathField` (path that must equal a records file path), `frameKeyField`, `timestampField` (integer microseconds), `sensorIdField`, and `recordCalibrationKeyField`; inputs.calibration = records keyed by `calibrationKeyField` with the pose (rotationForm identity when points are already in the output frame; quaternion/matrix/axes fields otherwise; `invertPose` when the file stores the inverse); inputs.sensors = records keyed by `sensorKeyField` with `sensorIdField`. One table can serve sampleData, calibration, and sensors. `outputFrame` "world" means the points are in the world frame and EgoLens converts them per frame using egoPoses. Output `pointClouds`.',
  'geometry.relative_poses': 'Builds egoPoses from records: `timestampField` (integer microseconds, must match timeline timestamps) and a `poseChain` of links composed left to right, each { quaternionFields (w,x,y,z) / translationFields } or { quaternion: [w,x,y,z] constant } with optional `invert: true`. Output `poses`.',
  'geometry.normalize_boxes3d': '3D boxes from records: `centerFields` (x,y,z), `dimensionFields` (length, width, height — length must be the axis the heading points along), `headingField` (yaw in radians) or quaternion fields with `quaternionOrder`, `classField` + `classMap` (dataset label → taxonomy class id), `objectIdField`, `timestampField`, `frameId` ("ego", a sensor frame, or "world"). Output `boxes`.',
  'image.bind_camera_frame': 'Binds camera images: inputs.bytes = encoded-bytes collection of the image files; inputs.sampleData = records with `pathField`, `frameKeyField`, `timestampField`, `sensorIdField`, `calibrationKeyField`; inputs.calibration = records keyed by `recordCalibrationKeyField` with `intrinsicFields` (fx, fy, cx, cy) and the camera pose (poseChain or quaternion/translation fields, ego ← camera-optical); inputs.sensors = records with `sensorIdField`, `widthField`/`heightField` (or defaultWidth/defaultHeight). Output `images`.',
  'labels.attach_by_point_index': 'Per-point labels aligned by point index: inputs.pointClouds = the bound point clouds, inputs.labels = binary collection of label files (one column), inputs.labelIndex = records mapping `indexRecordKeyField` (the point-cloud file path) to `indexPathField` (the label file path). `taxonomy` names the lidar-semantics taxonomy id. Output `segmentation`.',
}


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

const npzRecordsParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    arrays: {
      type: 'array', minItems: 1, maxItems: 32,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,95}$' },
          fields: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        required: ['name', 'fields'],
        additionalProperties: false,
      },
    },
    maxEntries: positiveLimit,
    maxExpandedBytes: positiveLimit,
    maxCompressionRatio: { type: 'number', exclusiveMinimum: 0 },
    maxElements: positiveLimit,
    maxRank: { type: 'integer', minimum: 1, maximum: 16 },
  },
  required: ['arrays'],
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

const parquetParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    columns: {
      type: 'array',
      minItems: 1,
      maxItems: 256,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 512 },
          type: { enum: ['bigint', 'integer', 'number', 'utf8', 'boolean', 'binary', 'number-list', 'integer-list', 'boolean-list'] },
          optional: { type: 'boolean' },
          nullable: { type: 'boolean' },
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

function fieldNames(count: number): OperatorJsonSchema {
  return {
    type: 'array', minItems: count, maxItems: count,
    items: { type: 'string', minLength: 1, maxLength: 256 },
  }
}

/** Pose links composed left to right into one ego ← sensor pose; each link reads row fields or holds a constant quaternion. */
const poseChainContract: OperatorJsonSchema = {
  type: 'array', minItems: 1, maxItems: 8,
  items: {
    type: 'object',
    properties: {
      quaternionField: { type: 'string', minLength: 1, maxLength: 256 },
      quaternionFields: fieldNames(4),
      matrixField: { type: 'string', minLength: 1, maxLength: 256 },
      translationField: { type: 'string', minLength: 1, maxLength: 256 },
      translationFields: fieldNames(3),
      quaternion: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
      translation: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
      invert: { type: 'boolean' },
    },
    additionalProperties: false,
  },
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
      closedParams({
        geometry: { const: 'center-size-pixels' },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorField: { type: 'string', minLength: 1, maxLength: 256 },
        objectIdField: { type: 'string', minLength: 1, maxLength: 256 },
        classField: { type: 'string', minLength: 1, maxLength: 256 },
        classMap: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 96 } },
        centerFields: fieldNames(2),
        dimensionFields: fieldNames(2),
      }, ['geometry']),
    ],
  }, recordContract(['boxes'])],
  ['geometry.normalize_boxes3d', {
    oneOf: [
      recordContract(['rows']),
      recordContract(['annotations']),
      // The relational (token-linked) form always needs the ego-pose timeline:
      // annotations are stored in the global frame and must be re-expressed in
      // the ego frame. Declaring it required here rejects the omission at
      // compile time instead of failing the first preview sample.
      recordContract(['annotations', 'instances', 'categories', 'poses']),
    ],
  }, {
    oneOf: [
      closedParams({
        quaternionOrder: { const: 'wxyz' },
        frameId: { type: 'string', minLength: 1, maxLength: 96 },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        classField: { type: 'string', minLength: 1, maxLength: 256 },
        objectIdField: { type: 'string', minLength: 1, maxLength: 256 },
        quaternionFields: fieldNames(4),
        centerFields: fieldNames(3),
        dimensionFields: fieldNames(3),
        classMap: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 96 } },
        headingField: { type: 'string', minLength: 1, maxLength: 256 },
      }, ['frameId']),
      closedParams({
        quaternionOrder: { const: 'wxyz' },
        frameId: { type: 'string', minLength: 1, maxLength: 96 },
        frameKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        instanceReferenceField: { type: 'string', minLength: 1, maxLength: 256 },
        instanceKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        instanceCategoryField: { type: 'string', minLength: 1, maxLength: 256 },
        categoryKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        classField: { type: 'string', minLength: 1, maxLength: 256 },
        classMap: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 96 } },
        fallbackClassId: { type: 'string', minLength: 1, maxLength: 96 },
        quaternionField: { type: 'string', minLength: 1, maxLength: 256 },
        centerField: { type: 'string', minLength: 1, maxLength: 256 },
        dimensionField: { type: 'string', minLength: 1, maxLength: 256 },
        dimensionOrder: { type: 'array', minItems: 3, maxItems: 3, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 2 } },
      }, [
        'quaternionOrder', 'frameId', 'frameKeyField', 'instanceReferenceField', 'instanceKeyField',
        'instanceCategoryField', 'categoryKeyField', 'classField', 'classMap', 'fallbackClassId',
        'quaternionField', 'centerField', 'dimensionField', 'dimensionOrder',
      ]),
    ],
  }, recordContract(['boxes'])],
  ['image.bind_camera_frame', {
    oneOf: [
      recordContract(['rows', 'calibration']),
      recordContract(['bytes', 'sampleData', 'calibration']),
      recordContract(['bytes', 'sampleData', 'calibration', 'sensors']),
      recordContract(['bytes', 'intrinsics', 'extrinsics']),
    ],
  }, {
    oneOf: [
      closedParams({ timestampField: { type: 'string', minLength: 1, maxLength: 256 } }, ['timestampField']),
      closedParams({
        pathField: { type: 'string', minLength: 1, maxLength: 256 },
        frameKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        recordCalibrationKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        calibrationKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        calibrationSensorKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorIdField: { type: 'string', minLength: 1, maxLength: 256 },
        modalityField: { type: 'string', minLength: 1, maxLength: 256 },
        cameraModality: { type: 'string', minLength: 1, maxLength: 96 },
        keyframeField: { type: 'string', minLength: 1, maxLength: 256 },
        widthField: { type: 'string', minLength: 1, maxLength: 256 },
        heightField: { type: 'string', minLength: 1, maxLength: 256 },
        intrinsicMatrixField: { type: 'string', minLength: 1, maxLength: 256 },
        intrinsicFields: fieldNames(4),
        quaternionField: { type: 'string', minLength: 1, maxLength: 256 },
        translationField: { type: 'string', minLength: 1, maxLength: 256 },
        rotationForm: { enum: ['quaternion', 'axes', 'matrix', 'identity'] },
        axisFields: fieldNames(2),
        rotationMatrixField: { type: 'string', minLength: 1, maxLength: 256 },
        rotationMatrixFields: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object',
            properties: { matrixField: { type: 'string', minLength: 1, maxLength: 256 }, translationField: { type: 'string', minLength: 1, maxLength: 256 } },
            required: ['matrixField'],
            additionalProperties: false,
          },
        },
        invertPose: { type: 'boolean' },
        quaternionFields: fieldNames(4),
        translationFields: fieldNames(3),
        poseChain: poseChainContract,
        frameIdSuffix: { type: 'string', minLength: 1, maxLength: 32 },
        defaultWidth: positiveLimit,
        defaultHeight: positiveLimit,
      }, [
        'pathField', 'frameKeyField', 'timestampField', 'recordCalibrationKeyField', 'calibrationKeyField',
        'calibrationSensorKeyField', 'sensorKeyField', 'sensorIdField', 'modalityField', 'cameraModality',
        'widthField', 'heightField', 'frameIdSuffix', 'defaultWidth', 'defaultHeight',
      ]),
      closedParams({
        timestampFrom: { const: 'numeric-path' },
        maxDeltaNs: positiveLimit,
        sensorField: { type: 'string', minLength: 1, maxLength: 256 },
        intrinsicFields: fieldNames(9),
        extrinsicQuaternionFields: fieldNames(4),
        extrinsicTranslationFields: fieldNames(3),
      }, ['timestampFrom', 'maxDeltaNs']),
      closedParams({
        encoding: { const: 'jpeg' },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorField: { type: 'string', minLength: 1, maxLength: 256 },
        imageField: { type: 'string', minLength: 1, maxLength: 256 },
        mimeType: { const: 'image/jpeg' },
        extrinsicField: { type: 'string', minLength: 1, maxLength: 256 },
        widthField: { type: 'string', minLength: 1, maxLength: 256 },
        heightField: { type: 'string', minLength: 1, maxLength: 256 },
        intrinsicFields: fieldNames(4),
        distortionFields: fieldNames(5),
        opticalToSensor: { type: 'array', minItems: 16, maxItems: 16, items: { type: 'number' } },
        frameIdSuffix: { type: 'string', minLength: 1, maxLength: 32 },
      }, [
        'encoding', 'timestampField', 'sensorField', 'imageField', 'mimeType', 'extrinsicField',
        'widthField', 'heightField', 'intrinsicFields', 'distortionFields', 'opticalToSensor', 'frameIdSuffix',
      ]),
    ],
  }, recordContract(['images'])],
  ['image.encoded_bytes', byteInputContract, closedParams({
    mimeType: { enum: ['image/jpeg', 'image/png', 'image/webp'] },
  }, ['mimeType']), recordContract(['bytes'])],
  ['json.records', byteInputContract, closedParams({
    layout: { enum: ['array', 'object-rows', 'file-row'] },
    pathField: { type: 'string', minLength: 1, maxLength: 256 },
    keyField: { type: 'string', minLength: 1, maxLength: 256 },
    rootPath: { type: 'string', minLength: 1, maxLength: 512 },
    flatten: { type: 'boolean' },
    indexField: { type: 'string', minLength: 1, maxLength: 128 },
  }, []), recordContract(['rows'])],
  ['text.table', byteInputContract, closedParams({
    layout: { enum: ['delimited', 'key-values', 'lines'] },
    delimiter: { type: 'string', minLength: 1, maxLength: 16 },
    columns: { type: 'array', minItems: 1, maxItems: 512, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
    header: { type: 'boolean' },
    field: { type: 'string', minLength: 1, maxLength: 128 },
    keySeparator: { type: 'string', minLength: 1, maxLength: 8 },
    numeric: { type: 'boolean' },
    indexField: { type: 'string', minLength: 1, maxLength: 128 },
    pathField: { type: 'string', minLength: 1, maxLength: 256 },
    maxRows: positiveLimit,
    maxColumns: positiveLimit,
  }, ['layout']), recordContract(['rows'])],
  ['xml.records', byteInputContract, closedParams({
    recordPath: { type: 'string', minLength: 1, maxLength: 512 },
    pathField: { type: 'string', minLength: 1, maxLength: 256 },
    numeric: { type: 'boolean' },
    maxRecords: positiveLimit,
    maxDepth: { type: 'integer', minimum: 1, maximum: 256 },
  }, ['recordPath']), recordContract(['rows'])],
  ['records.unpivot', recordContract(['rows']), closedParams({
    pattern: { type: 'string', minLength: 1, maxLength: 512 },
    keyGroup: { type: 'integer', minimum: 1, maximum: 9 },
    fieldGroup: { type: 'integer', minimum: 1, maximum: 9 },
    keyField: { type: 'string', minLength: 1, maxLength: 128 },
  }, ['pattern']), recordContract(['rows'])],
  ['records.explode', recordContract(['rows']), closedParams({
    path: { type: 'string', minLength: 1, maxLength: 256 },
    indexField: { type: 'string', minLength: 1, maxLength: 128 },
    indexOffsetField: { type: 'string', minLength: 1, maxLength: 128 },
    prefix: { type: 'string', maxLength: 64 },
    keepNested: { type: 'boolean' },
  }, ['path']), recordContract(['rows'])],
  ['records.derive', recordContract(['rows']), closedParams({
    derive: {
      type: 'array', minItems: 1, maxItems: 32,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', minLength: 1, maxLength: 256 },
          from: { type: 'string', minLength: 1, maxLength: 256 },
          pattern: { type: 'string', minLength: 1, maxLength: 512 },
          replacement: { type: 'string', maxLength: 512 },
          required: { type: 'boolean' },
          pad: { type: 'integer', minimum: 1, maximum: 64 },
          padChar: { type: 'string', minLength: 1, maxLength: 1 },
          scale: { type: 'number' },
          offset: { type: 'number' },
          integer: { type: 'boolean' },
        },
        required: ['field', 'from'],
        additionalProperties: false,
      },
    },
  }, ['derive']), recordContract(['rows'])],
  ['labels.attach_by_point_index', {
    oneOf: [
      recordContract(['pointClouds', 'labels']),
      // Binary (per-file) labels need an index that maps each label file to
      // the point-cloud record key; panoptic labels are optional on top.
      recordContract(['pointClouds', 'labels', 'labelIndex']),
      recordContract(['pointClouds', 'labels', 'panoptic', 'labelIndex', 'panopticIndex']),
    ],
  }, closedParams({
    taxonomy: { type: 'string', minLength: 1, maxLength: 96 },
    indexRecordKeyField: { type: 'string', minLength: 1, maxLength: 256 },
    indexPathField: { type: 'string', minLength: 1, maxLength: 256 },
    panopticDivisor: { type: 'integer', minimum: 1, maximum: 1000000 },
    timestampField: { type: 'string', minLength: 1, maxLength: 256 },
    sensorField: { type: 'string', minLength: 1, maxLength: 256 },
    shapeField: { type: 'string', minLength: 1, maxLength: 256 },
    valuesField: { type: 'string', minLength: 1, maxLength: 256 },
  }, ['taxonomy']), recordContract(['segmentation'])],
  ['labels.decode_camera_mask', recordContract(['rows']), closedParams({
    encoding: { const: 'png-uint16' },
    taxonomy: { type: 'string', minLength: 1, maxLength: 96 },
    timestampField: { type: 'string', minLength: 1, maxLength: 256 },
    sensorField: { type: 'string', minLength: 1, maxLength: 256 },
    labelField: { type: 'string', minLength: 1, maxLength: 256 },
    divisorField: { type: 'string', minLength: 1, maxLength: 256 },
    panopticDivisor: { type: 'integer', minimum: 1, maximum: 1000000 },
  }, ['encoding', 'taxonomy', 'timestampField', 'sensorField', 'labelField', 'divisorField']), recordContract(['segmentation'])],
  ['geometry.normalize_keypoints', recordContract(['rows']), {
    oneOf: [
      closedParams({
        dimensions: { const: 3 }, frameId: { type: 'string', minLength: 1, maxLength: 96 },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        objectIdField: { type: 'string', minLength: 1, maxLength: 256 },
        typeField: { type: 'string', minLength: 1, maxLength: 256 },
        coordinateFields: fieldNames(3), schemaId: { type: 'string', minLength: 1, maxLength: 96 },
        labels: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string' } },
      }, ['dimensions', 'frameId', 'timestampField', 'objectIdField', 'typeField', 'coordinateFields', 'schemaId', 'labels']),
      closedParams({
        dimensions: { const: 2 }, coordinateSpace: { const: 'pixels' },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorField: { type: 'string', minLength: 1, maxLength: 256 },
        objectIdField: { type: 'string', minLength: 1, maxLength: 256 },
        typeField: { type: 'string', minLength: 1, maxLength: 256 },
        coordinateFields: fieldNames(2), occludedField: { type: 'string', minLength: 1, maxLength: 256 },
        schemaId: { type: 'string', minLength: 1, maxLength: 96 }, frameIdSuffix: { type: 'string', minLength: 1, maxLength: 32 },
        labels: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string' } },
      }, ['dimensions', 'coordinateSpace', 'timestampField', 'sensorField', 'objectIdField', 'typeField', 'coordinateFields', 'occludedField', 'schemaId', 'frameIdSuffix', 'labels']),
    ],
  }, recordContract(['keypoints'])],
  ['geometry.range_image_to_cartesian', recordContract(['rangeImages', 'calibration', 'poses']), closedParams({
    returns: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: [1, 2] } },
    outputFrame: { const: 'ego' },
    timestampField: { type: 'string', minLength: 1, maxLength: 256 },
    sensorField: { type: 'string', minLength: 1, maxLength: 256 },
    shapeField: { type: 'string', minLength: 1, maxLength: 256 },
    valuesField: { type: 'string', minLength: 1, maxLength: 256 },
    extrinsicField: { type: 'string', minLength: 1, maxLength: 256 },
    inclinationValuesField: { type: 'string', minLength: 1, maxLength: 256 },
    inclinationMinField: { type: 'string', minLength: 1, maxLength: 256 },
    inclinationMaxField: { type: 'string', minLength: 1, maxLength: 256 },
  }, ['returns', 'outputFrame', 'timestampField', 'sensorField', 'shapeField', 'valuesField', 'extrinsicField', 'inclinationValuesField', 'inclinationMinField', 'inclinationMaxField']), recordContract(['pointClouds'])],
  ['geometry.relative_poses', recordContract(['rows']), closedParams({
    timestampField: { type: 'string', minLength: 1, maxLength: 256 },
    matrixField: { type: 'string', minLength: 1, maxLength: 512 },
    quaternionField: { type: 'string', minLength: 1, maxLength: 256 },
    quaternionFields: fieldNames(4),
    translationField: { type: 'string', minLength: 1, maxLength: 256 },
    translationFields: fieldNames(3),
    invert: { type: 'boolean' },
    poseChain: poseChainContract,
  }, ['timestampField']), recordContract(['poses'])],
  ['geometry.geodetic_poses', recordContract(['rows']), closedParams({
    timestampField: { type: 'string', minLength: 1, maxLength: 256 },
    latitudeField: { type: 'string', minLength: 1, maxLength: 256 },
    longitudeField: { type: 'string', minLength: 1, maxLength: 256 },
    altitudeField: { type: 'string', minLength: 1, maxLength: 256 },
    rollField: { type: 'string', minLength: 1, maxLength: 256 },
    pitchField: { type: 'string', minLength: 1, maxLength: 256 },
    yawField: { type: 'string', minLength: 1, maxLength: 256 },
    angleUnit: { enum: ['radians', 'degrees'] },
  }, ['timestampField', 'latitudeField', 'longitudeField', 'yawField']), recordContract(['poses'])],
  ['records.select', {
    oneOf: [recordContract(['rows']), recordContract(['scenes', 'logs'])],
  }, {
    oneOf: [
      closedParams({
        fields: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } },
        frameId: { type: 'string', minLength: 1, maxLength: 96 },
        aliases: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 256 } },
        where: { type: 'array', maxItems: 32, items: { type: 'object', properties: { field: { type: 'string' }, equals: {} }, required: ['field', 'equals'], additionalProperties: false } },
        segmentIdentity: {
          type: 'object',
          properties: {
            labelFromSceneId: { type: 'boolean' },
            metadataKey: { type: 'string', minLength: 1, maxLength: 128 },
          },
          required: ['labelFromSceneId'],
          additionalProperties: false,
        },
      }, ['fields']),
      closedParams({
        mode: { const: 'segments' },
        sceneLogField: { type: 'string', minLength: 1, maxLength: 256 },
        logKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        groupField: { type: 'string', minLength: 1, maxLength: 256 },
        idField: { type: 'string', minLength: 1, maxLength: 256 },
        labelField: { type: 'string', minLength: 1, maxLength: 256 },
        weatherField: { type: 'string', minLength: 1, maxLength: 256 },
        locationField: { type: 'string', minLength: 1, maxLength: 256 },
        timeSourceField: { type: 'string', minLength: 1, maxLength: 256 },
        timeDelimiter: { type: 'string', minLength: 1, maxLength: 8 },
        timePartIndex: { type: 'integer', minimum: 0, maximum: 32 },
      }, ['mode', 'sceneLogField', 'logKeyField', 'groupField', 'idField', 'labelField', 'weatherField', 'locationField', 'timeSourceField', 'timeDelimiter', 'timePartIndex']),
      closedParams({
        mode: { const: 'segment-stats' },
        idField: { type: 'string', minLength: 1, maxLength: 256 },
        locationField: { type: 'string', minLength: 1, maxLength: 256 },
        timeOfDayField: { type: 'string', minLength: 1, maxLength: 256 },
        weatherField: { type: 'string', minLength: 1, maxLength: 256 },
        objectTypesField: { type: 'string', minLength: 1, maxLength: 256 },
        objectCountsField: { type: 'string', minLength: 1, maxLength: 256 },
      }, ['mode', 'idField', 'locationField', 'timeOfDayField', 'weatherField', 'objectTypesField', 'objectCountsField']),
    ],
  }, { oneOf: [recordContract(['records']), recordContract(['pointClouds']), recordContract(['segments'])] }],
  ['relations.token_join', {
    oneOf: [
      recordContract(['sampleData', 'poses']),
      recordContract(['sampleData', 'poses', 'calibration', 'sensors']),
      recordContract(['left', 'right']),
    ],
  }, {
    oneOf: [
      closedParams({
        leftKey: { type: 'string', minLength: 1, maxLength: 256 },
        rightKey: { type: 'string', minLength: 1, maxLength: 256 },
        join: { enum: ['inner', 'left'] },
        rightFields: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 256 } },
      }, ['leftKey', 'rightKey']),
      closedParams({
        output: { const: 'pose-timeline' },
        sampleDataCalibrationKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        calibrationKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        calibrationSensorKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorIdField: { type: 'string', minLength: 1, maxLength: 256 },
        preferredSensorId: { type: 'string', minLength: 1, maxLength: 256 },
        poseReferenceField: { type: 'string', minLength: 1, maxLength: 256 },
        poseKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        frameKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        keyframeField: { type: 'string', minLength: 1, maxLength: 256 },
        quaternionField: { type: 'string', minLength: 1, maxLength: 256 },
        translationField: { type: 'string', minLength: 1, maxLength: 256 },
        rotationForm: { enum: ['quaternion', 'axes', 'matrix', 'identity'] },
        axisFields: fieldNames(2),
        rotationMatrixField: { type: 'string', minLength: 1, maxLength: 256 },
        rotationMatrixFields: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object',
            properties: { matrixField: { type: 'string', minLength: 1, maxLength: 256 }, translationField: { type: 'string', minLength: 1, maxLength: 256 } },
            required: ['matrixField'],
            additionalProperties: false,
          },
        },
        invertPose: { type: 'boolean' },
        quaternionFields: fieldNames(4),
        translationFields: fieldNames(3),
        poseChain: poseChainContract,
      }, [
        'output', 'sampleDataCalibrationKeyField', 'calibrationKeyField', 'calibrationSensorKeyField',
        'sensorKeyField', 'sensorIdField', 'preferredSensorId', 'poseReferenceField', 'poseKeyField',
        'frameKeyField',
      ]),
    ],
  }, { oneOf: [recordContract(['rows']), recordContract(['poses'])] }],
  ['relations.composite_key_join', recordContract(['boxes2d', 'boxes3d', 'associations']), closedParams({
    relation: { const: 'camera-object-to-lidar-object' },
    cameraObjectField: { type: 'string', minLength: 1, maxLength: 256 },
    lidarObjectField: { type: 'string', minLength: 1, maxLength: 256 },
  }, ['relation', 'cameraObjectField', 'lidarObjectField']), recordContract(['relations'])],
  ['timeline.join', {
    oneOf: [
      recordContract(['records', 'sampleData', 'calibration']),
      recordContract(['records', 'sampleData', 'calibration', 'sensors']),
      recordContract(['timeline', 'poses']),
    ],
  }, {
    oneOf: [
      closedParams({ mode: { const: 'token' }, timestampField: { type: 'string', minLength: 1, maxLength: 256 } }, ['mode']),
      closedParams({
        mode: { const: 'token' },
        pathField: { type: 'string', minLength: 1, maxLength: 256 },
        frameKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        recordKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        recordCalibrationKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        calibrationKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        calibrationSensorKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorKeyField: { type: 'string', minLength: 1, maxLength: 256 },
        sensorIdField: { type: 'string', minLength: 1, maxLength: 256 },
        keyframeField: { type: 'string', minLength: 1, maxLength: 256 },
        quaternionField: { type: 'string', minLength: 1, maxLength: 256 },
        translationField: { type: 'string', minLength: 1, maxLength: 256 },
        rotationForm: { enum: ['quaternion', 'axes', 'matrix', 'identity'] },
        axisFields: fieldNames(2),
        rotationMatrixField: { type: 'string', minLength: 1, maxLength: 256 },
        rotationMatrixFields: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object',
            properties: { matrixField: { type: 'string', minLength: 1, maxLength: 256 }, translationField: { type: 'string', minLength: 1, maxLength: 256 } },
            required: ['matrixField'],
            additionalProperties: false,
          },
        },
        invertPose: { type: 'boolean' },
        quaternionFields: fieldNames(4),
        translationFields: fieldNames(3),
        poseChain: poseChainContract,
        outputFrame: { type: 'string', minLength: 1, maxLength: 96 },
      }, [
        'mode', 'pathField', 'frameKeyField', 'recordKeyField', 'timestampField', 'recordCalibrationKeyField',
        'calibrationKeyField', 'calibrationSensorKeyField', 'sensorKeyField', 'sensorIdField',
        'outputFrame',
      ]),
      closedParams({
        mode: { const: 'nearest' },
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        maxDeltaNs: positiveLimit,
        quaternionFields: fieldNames(4),
        translationFields: fieldNames(3),
      }, ['mode', 'timestampField', 'maxDeltaNs']),
    ],
  }, { oneOf: [recordContract(['pointClouds']), recordContract(['poses'])] }],
  ['timeline.sort', {
    oneOf: [recordContract(['samples']), recordContract(['rows']), recordContract(['lidar'])],
  }, {
    oneOf: [
      closedParams({ timestampField: { type: 'string', minLength: 1, maxLength: 256 } }, ['timestampField']),
      closedParams({
        timestampField: { type: 'string', minLength: 1, maxLength: 256 },
        timestampUnit: { enum: ['ns', 'us', 'ms', 's'] },
        keyField: { type: 'string', minLength: 1, maxLength: 256 },
        groupField: { type: 'string', minLength: 1, maxLength: 256 },
      }, ['timestampField', 'timestampUnit', 'keyField', 'groupField']),
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
  doc: OPERATOR_DOCS_V1[String(name)],
  name: name as string,
  majorVersion: 1,
  provider: 'core',
  tier: 1,
  inputContract: inputContract as OperatorJsonSchema,
  paramsContract: operatorParamsContract as OperatorJsonSchema,
  outputContract: outputContract as OperatorJsonSchema,
  execution: 'worker',
  deterministic: true,
  execute: coreGraphOperatorImplementationsV1[name as string],
}))

const pickleLimitContracts = {
  maxExpandedBytes: positiveLimit,
  maxRows: positiveLimit,
  maxMemo: positiveLimit,
} as const

const pickleRecordsParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    columns: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
    attributes: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
    ...pickleLimitContracts,
  },
  required: ['columns'],
  additionalProperties: false,
}

const pickleRowsParamsContract: OperatorJsonSchema = {
  type: 'object',
  properties: {
    pathField: { type: 'string', minLength: 1, maxLength: 256 },
    indexField: { type: 'string', minLength: 1, maxLength: 128 },
    ...pickleLimitContracts,
    maxTotalRows: { type: 'integer', minimum: 1, maximum: 250000, description: 'Rows this reader may materialize across all matched files (default and hard cap 250000). It builds one object per row: metadata tables only. Point clouds use archive.pickle_records.' },
  },
  additionalProperties: false,
}

const strictBinaryOperators: readonly CoreOperatorDescriptor[] = [
  {
    name: 'archive.pickle_records',
    doc: OPERATOR_DOCS_V1['archive.pickle_records'],
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: pickleRecordsParamsContract,
    outputContract: recordContract(['records']),
    execution: 'worker',
    deterministic: true,
    execute: coreGraphOperatorImplementationsV1['archive.pickle_records'],
  },
  {
    name: 'archive.pickle_rows',
    doc: OPERATOR_DOCS_V1['archive.pickle_rows'],
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: pickleRowsParamsContract,
    outputContract: recordContract(['rows']),
    execution: 'worker',
    deterministic: true,
    execute: coreGraphOperatorImplementationsV1['archive.pickle_rows'],
  },
  {
    name: 'archive.npz_array',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: npzParamsContract,
    outputContract: recordContract(['values']),
    execution: 'worker',
    deterministic: true,
    execute: coreGraphOperatorImplementationsV1['archive.npz_array'],
  },
  {
    name: 'archive.npz_records',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: npzRecordsParamsContract,
    outputContract: recordContract(['records']),
    execution: 'worker',
    deterministic: true,
    execute: coreGraphOperatorImplementationsV1['archive.npz_records'],
  },
  {
    name: 'binary.interleaved_records',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: interleavedParamsContract,
    outputContract: recordContract(['records']),
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
    execute: coreGraphOperatorImplementationsV1['binary.interleaved_records'],
  },
  {
    name: 'binary.pcd_records',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: byteInputContract,
    paramsContract: pcdParamsContract,
    outputContract: recordContract(['records']),
    execution: 'worker',
    deterministic: true,
    execute: coreGraphOperatorImplementationsV1['binary.pcd_records'],
  },
]

const strictFeatherOperator: CoreOperatorDescriptor = {
  name: 'feather.columns',
  majorVersion: 1,
  provider: 'core',
  tier: 1,
  inputContract: byteInputContract,
  paramsContract: featherParamsContract,
  outputContract: recordContract(['rows']),
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
  execute: coreGraphOperatorImplementationsV1['feather.columns'],
}

const strictParquetOperator: CoreOperatorDescriptor = {
  name: 'parquet.columns',
  majorVersion: 1,
  provider: 'core',
  tier: 1,
  inputContract: byteInputContract,
  paramsContract: parquetParamsContract,
  outputContract: recordContract(['rows']),
  validateParams: (params) => {
    try {
      assertValidParquetColumnsParamsV1(params as never)
      return []
    } catch (error) {
      return [{ message: error instanceof Error ? error.message : String(error) }]
    }
  },
  execution: 'worker',
  deterministic: true,
  execute: coreGraphOperatorImplementationsV1['parquet.columns'],
}

const workerOperators = [
  'labels.panoptic_split',
] as const

/**
 * Compile-time and executable descriptors for the generic operators referenced
 * by bundled recipes. Every body is invoked by the shared graph kernel.
 */
export const BUNDLED_PHASE2_OPERATOR_DESCRIPTORS: readonly CoreOperatorDescriptor[] = [
  ...strictBinaryOperators,
  strictFeatherOperator,
  strictParquetOperator,
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
  { extensionExecutor: new DedicatedWorkerExtensionExecutor() },
)

registerBuiltInExtensionPackagesV1(bundledPhase2OperatorRegistry)
