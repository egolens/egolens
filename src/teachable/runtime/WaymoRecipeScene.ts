import type { MetadataBundle } from '../../types/dataset'
import type { ParquetRow } from '../../utils/merge'
import { multiplyRowMajor4x4 } from '../../utils/matrix'
import { buildHeavyFileFrameIndex, type FrameRowIndex, type WaymoParquetFile } from '../../utils/parquet'
import { convertAllSensors, type RangeImage } from '../../utils/rangeImage'
import { WAYMO_KEYPOINT_LABELS } from '../../utils/waymoSemanticClasses'
import { loadWaymoMetadata } from '../../adapters/waymo/metadata'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import { readParquetColumnsV1, type ParquetColumnsParamsV1 } from '../operators/parquetColumns'
import type {
  FrameCapabilityRequest,
  NormalizedBox2dV1,
  NormalizedBox3dV1,
  NormalizedCameraCalibrationV1,
  NormalizedCapabilityV1,
  NormalizedFrameV1,
  NormalizedKeypointSetV1,
  NormalizedPointCloudV1,
  NormalizedRelationsV1,
  NormalizedSceneV1,
  NormalizedTrackPointV1,
  NormalizedTransformV1,
} from './normalizedScene'

export interface WaymoRecipeSceneInputV1 {
  readonly compiledRecipe: CompiledRecipeV1
  readonly parquetFiles: ReadonlyMap<string, WaymoParquetFile>
  readonly metadataBundle?: MetadataBundle
}

export interface BoundWaymoRecipeSceneV1 {
  readonly scene: NormalizedSceneV1
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly metadata: MetadataBundle
}

const OPTICAL_TO_SENSOR = [
  0, 0, 1, 0,
  -1, 0, 0, 0,
  0, -1, 0, 0,
  0, 0, 0, 1,
]

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Scene frame load was aborted.', 'AbortError')
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid normalized ${label}.`)
  return value
}

function numericList(value: unknown, label: string, length?: number): number[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)
    || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error(`Invalid normalized ${label}.`)
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

function capabilityDiagnostic(capability: NormalizedCapabilityV1): AdapterDiagnostic {
  return {
    stage: 'bind',
    severity: 'info',
    code: 'OPTIONAL_OUTPUT_UNBOUND',
    jsonPointer: `/outputs/${capability}`,
    hint: `The ${capability} output has no complete source binding in this dataset and was disabled.`,
  }
}

function groupByTimestampAndSensor(rows: readonly ParquetRow[]): Map<bigint, Map<number, ParquetRow>> {
  const grouped = new Map<bigint, Map<number, ParquetRow>>()
  for (const row of rows) {
    const timestamp = row['key.frame_timestamp_micros'] as bigint
    const sensor = (row['key.laser_name'] ?? row['key.camera_name']) as number
    let frame = grouped.get(timestamp)
    if (!frame) {
      frame = new Map()
      grouped.set(timestamp, frame)
    }
    frame.set(sensor, row)
  }
  return grouped
}

function attachWaymoSegmentation(
  cloud: NormalizedPointCloudV1,
  row: ParquetRow | undefined,
): { semanticLabels?: Uint8Array; panopticLabels?: Uint16Array } {
  if (!row || !cloud.sourceIndices) return {}
  const shape = row['[LiDARSegmentationLabelComponent].range_image_return1.shape'] as number[] | undefined
  const values = row['[LiDARSegmentationLabelComponent].range_image_return1.values'] as number[] | undefined
  if (!shape || !values) return {}
  const channels = shape.length >= 3 ? shape[2] : 1
  const semanticLabels = new Uint8Array(cloud.pointCount)
  const panopticLabels = new Uint16Array(cloud.pointCount)
  for (let index = 0; index < cloud.pointCount; index += 1) {
    const sourceIndex = cloud.sourceIndices[index]
    const instance = Math.max(0, values[sourceIndex * channels] ?? 0)
    const semantic = channels >= 2 ? (values[sourceIndex * channels + 1] ?? 0) : instance
    semanticLabels[index] = semantic
    panopticLabels[index] = semantic * 1000 + instance
  }
  return { semanticLabels, panopticLabels }
}

/** Bind Waymo v2 component Parquet files through the generic recipe-backed scene boundary. */
export async function bindWaymoRecipeSceneV1(input: WaymoRecipeSceneInputV1): Promise<BoundWaymoRecipeSceneV1> {
  const parquetFiles = new Map(input.parquetFiles)
  const bundle = input.metadataBundle ?? await loadWaymoMetadata(parquetFiles)
  if (bundle.timestamps.length === 0) throw new Error('TIMELINE_BINDING_EMPTY: Waymo segment has no frames.')
  const recipe = input.compiledRecipe.recipe
  const sourceParams = (sourceId: keyof typeof recipe.sources): ParquetColumnsParamsV1 =>
    recipe.sources[sourceId].params as unknown as ParquetColumnsParamsV1

  const lidarFile = parquetFiles.get('lidar')
  const cameraFile = parquetFiles.get('camera_image')
  const [lidarIndex, cameraIndex] = await Promise.all([
    lidarFile ? buildHeavyFileFrameIndex(lidarFile) : Promise.resolve<FrameRowIndex | null>(null),
    cameraFile ? buildHeavyFileFrameIndex(cameraFile) : Promise.resolve<FrameRowIndex | null>(null),
  ])
  const lidarSegByTimestamp = bundle.lidarSegmentationByFrame
    ? new Map([...bundle.lidarSegmentationByFrame].map(([timestamp, rows]) => [timestamp, groupByTimestampAndSensor(rows).get(timestamp) ?? new Map()]))
    : new Map<bigint, Map<number, ParquetRow>>()

  const lidarSensors = new Map(recipe.scene.sensors
    .filter((sensor) => sensor.modality === 'lidar')
    .map((sensor) => [sensor.rendererId, sensor]))
  const cameraSensors = new Map(recipe.scene.sensors
    .filter((sensor) => sensor.modality === 'camera')
    .map((sensor) => [sensor.rendererId, sensor]))
  const objects = recipe.scene.taxonomies.find((taxonomy) => taxonomy.role === 'objects')
  const classIdByRendererId = new Map(objects?.classes.map((entry) => [entry.rendererId, entry.id]) ?? [])

  const staticTransforms: NormalizedTransformV1[] = []
  for (const [rendererId, calibration] of bundle.lidarCalibrations) {
    const sensor = lidarSensors.get(rendererId)
    if (!sensor || calibration.extrinsic.length !== 16) continue
    staticTransforms.push({
      parentFrameId: 'ego',
      childFrameId: sensor.frameId,
      parentFromChild: new Float64Array(calibration.extrinsic),
    })
  }
  const cameraCalibrations = new Map<string, NormalizedCameraCalibrationV1>()
  for (const row of bundle.cameraCalibrations) {
    const rendererId = row['key.camera_name'] as number
    const sensor = cameraSensors.get(rendererId)
    if (!sensor?.image) continue
    const rawExtrinsic = numericList(row['[CameraCalibrationComponent].extrinsic.transform'], 'camera extrinsic', 16)
    const egoFromOpticalCamera = multiplyRowMajor4x4(rawExtrinsic, OPTICAL_TO_SENSOR)
    const width = finite(row['[CameraCalibrationComponent].width'], 'camera width')
    const height = finite(row['[CameraCalibrationComponent].height'], 'camera height')
    const distortion = [
      Number(row['[CameraCalibrationComponent].intrinsic.k1'] ?? 0),
      Number(row['[CameraCalibrationComponent].intrinsic.k2'] ?? 0),
      Number(row['[CameraCalibrationComponent].intrinsic.p1'] ?? 0),
      Number(row['[CameraCalibrationComponent].intrinsic.p2'] ?? 0),
      Number(row['[CameraCalibrationComponent].intrinsic.k3'] ?? 0),
    ]
    staticTransforms.push({
      parentFrameId: 'ego',
      childFrameId: sensor.frameId,
      parentFromChild: new Float64Array(egoFromOpticalCamera),
    })
    cameraCalibrations.set(sensor.id, {
      sensorId: sensor.id,
      frameId: sensor.frameId,
      width,
      height,
      intrinsics: [
        finite(row['[CameraCalibrationComponent].intrinsic.f_u'], 'camera fx'),
        finite(row['[CameraCalibrationComponent].intrinsic.f_v'], 'camera fy'),
        finite(row['[CameraCalibrationComponent].intrinsic.c_u'] ?? width / 2, 'camera cx'),
        finite(row['[CameraCalibrationComponent].intrinsic.c_v'] ?? height / 2, 'camera cy'),
      ],
      distortionModel: distortion.some((value) => value !== 0) ? 'brown-conrady' : 'none',
      distortion,
      egoFromCamera: new Float64Array(egoFromOpticalCamera),
    })
  }

  const trajectories = new Map<string, readonly NormalizedTrackPointV1[]>()
  for (const [objectId, points] of bundle.objectTrajectories) {
    trajectories.set(objectId, points.map((point) => ({
      frameIndex: point.frameIndex,
      position: [point.x, point.y, point.z],
      classId: classIdByRendererId.get(point.type) ?? 'unknown',
    })))
  }
  const box2dToBox3d = new Map(bundle.assocCamToLaser)
  const relations: NormalizedRelationsV1 = {
    staticTransforms,
    cameraCalibrations,
    trajectories,
    box2dToBox3d,
  }

  const evidence: Partial<Record<NormalizedCapabilityV1, boolean>> = {
    timeline: true,
    egoPoses: bundle.poseByFrameIndex.size > 0,
    pointClouds: Boolean(lidarFile && lidarIndex && bundle.lidarCalibrations.size > 0),
    cameraImages: Boolean(cameraFile && cameraIndex && cameraCalibrations.size > 0),
    boxes3d: bundle.hasBoxData,
    boxes2d: bundle.cameraBoxByFrame.size > 0,
    boxAssociations: bundle.assocCamToLaser.size > 0,
    trajectories: trajectories.size > 0,
    lidarSegmentation: Boolean(bundle.hasSegmentation && lidarFile && lidarIndex),
    cameraSegmentation: Boolean(bundle.hasCameraSegmentation && bundle.cameraSeg?.size),
    keypoints3d: Boolean(bundle.keypointsByFrame?.size),
    keypoints2d: Boolean(bundle.cameraKeypointsByFrame?.size),
    segmentMetadata: bundle.segmentMeta !== null,
  }
  const capabilities = new Set<NormalizedCapabilityV1>()
  const diagnostics: AdapterDiagnostic[] = []
  for (const capability of input.compiledRecipe.capabilities) {
    if (evidence[capability]) capabilities.add(capability)
    else diagnostics.push(capabilityDiagnostic(capability))
  }

  const readFrameRows = async (
    file: WaymoParquetFile,
    frameIndex: FrameRowIndex,
    timestamp: bigint,
    params: ParquetColumnsParamsV1,
    signal?: AbortSignal,
  ): Promise<ParquetRow[]> => {
    const range = frameIndex.byTimestamp.get(timestamp)
    if (!range) return []
    return readParquetColumnsV1(file, params, { ...range, signal })
  }

  let disposed = false
  const scene: NormalizedSceneV1 = {
    manifest: { ...input.compiledRecipe.normalizedManifest, capabilities },
    index: {
      timestampsMicros: bundle.timestamps,
      segments: [{
        id: bundle.segmentMeta?.segmentId ?? 'waymo-segment',
        label: bundle.segmentMeta?.segmentId,
        firstFrame: 0,
        frameCount: bundle.timestamps.length,
        metadata: bundle.segmentMeta ? {
          location: bundle.segmentMeta.location,
          timeOfDay: bundle.segmentMeta.timeOfDay,
          weather: bundle.segmentMeta.weather,
        } : undefined,
      }],
    },
    relations,
    async loadFrame(index: number, request: FrameCapabilityRequest): Promise<NormalizedFrameV1> {
      if (disposed) throw new Error('Normalized scene has been disposed.')
      if (!Number.isSafeInteger(index) || index < 0 || index >= bundle.timestamps.length) {
        throw new RangeError(`Frame index ${index} is out of range.`)
      }
      throwIfAborted(request.signal)
      const requested = new Set([...request.capabilities].filter((capability) => capabilities.has(capability)))
      const timestampMicros = bundle.timestamps[index]
      const pointClouds: NormalizedPointCloudV1[] = []
      const lidarSegmentation: NormalizedFrameV1['lidarSegmentation'][number][] = []
      if ((requested.has('pointClouds') || requested.has('lidarSegmentation')) && lidarFile && lidarIndex) {
        const rows = await readFrameRows(lidarFile, lidarIndex, timestampMicros, sourceParams('lidarRows'), request.signal)
        const rangeImages = new Map<number, RangeImage>()
        for (const row of rows) {
          const rendererId = row['key.laser_name'] as number
          const sensor = lidarSensors.get(rendererId)
          if (!sensor || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          rangeImages.set(rendererId, {
            shape: numericList(row['[LiDARComponent].range_image_return1.shape'], 'range image shape', 3) as [number, number, number],
            values: numericList(row['[LiDARComponent].range_image_return1.values'], 'range image values'),
          })
        }
        for (const [rendererId, cloud] of convertAllSensors(rangeImages, bundle.lidarCalibrations).perSensor) {
          const sensor = lidarSensors.get(rendererId)!
          const normalized: NormalizedPointCloudV1 = {
            sensorId: sensor.id,
            frameId: 'ego',
            values: cloud.positions,
            pointCount: cloud.pointCount,
            stride: 6,
            attributes: ['x', 'y', 'z', 'intensity', 'range', 'elongation'],
            sourceIndices: cloud.validIndices,
          }
          const labels = attachWaymoSegmentation(normalized, lidarSegByTimestamp.get(timestampMicros)?.get(rendererId))
          const labeled = { ...normalized, ...labels }
          if (requested.has('pointClouds')) pointClouds.push(labeled)
          if (requested.has('lidarSegmentation') && labels.semanticLabels) {
            lidarSegmentation.push({
              sensorId: sensor.id,
              taxonomyId: 'waymo-lidar-semantics',
              labels: labels.panopticLabels ?? labels.semanticLabels,
              divisor: labels.panopticLabels ? 1000 : undefined,
              encoding: 'point-index',
            })
          }
        }
      }

      const cameraImages: NormalizedFrameV1['cameraImages'][number][] = []
      if (requested.has('cameraImages') && cameraFile && cameraIndex) {
        const rows = await readFrameRows(cameraFile, cameraIndex, timestampMicros, sourceParams('cameraImageRows'), request.signal)
        for (const row of rows) {
          const sensor = cameraSensors.get(row['key.camera_name'] as number)
          const calibration = sensor && cameraCalibrations.get(sensor.id)
          const encodedBytes = binaryBuffer(row['[CameraImageComponent].image'])
          if (!sensor?.image || !calibration || !encodedBytes || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          cameraImages.push({
            sensorId: sensor.id,
            timestampMicros,
            encodedBytes,
            mimeType: 'image/jpeg',
            width: calibration.width,
            height: calibration.height,
            calibrationId: sensor.id,
          })
        }
      }

      const boxes3d: NormalizedBox3dV1[] = []
      if (requested.has('boxes3d')) {
        for (const row of bundle.lidarBoxByFrame.get(timestampMicros) ?? []) {
          const objectId = String(row['key.laser_object_id'])
          const heading = finite(row['[LiDARBoxComponent].box.heading'], 'box heading')
          boxes3d.push({
            id: objectId,
            objectId,
            classId: classIdByRendererId.get(finite(row['[LiDARBoxComponent].type'], 'box class')) ?? 'unknown',
            frameId: 'ego',
            center: [
              finite(row['[LiDARBoxComponent].box.center.x'], 'box x'),
              finite(row['[LiDARBoxComponent].box.center.y'], 'box y'),
              finite(row['[LiDARBoxComponent].box.center.z'], 'box z'),
            ],
            dimensions: [
              finite(row['[LiDARBoxComponent].box.size.x'], 'box length'),
              finite(row['[LiDARBoxComponent].box.size.y'], 'box width'),
              finite(row['[LiDARBoxComponent].box.size.z'], 'box height'),
            ],
            orientation: [Math.cos(heading / 2), 0, 0, Math.sin(heading / 2)],
            heading,
          })
        }
      }

      const boxes2d: NormalizedBox2dV1[] = []
      if (requested.has('boxes2d')) {
        for (const row of bundle.cameraBoxByFrame.get(timestampMicros) ?? []) {
          const camera = cameraSensors.get(row['key.camera_name'] as number)
          if (!camera || (request.sensorIds && !request.sensorIds.has(camera.id))) continue
          const objectId = String(row['key.camera_object_id'])
          boxes2d.push({
            id: objectId,
            objectId,
            classId: classIdByRendererId.get(finite(row['[CameraBoxComponent].type'], 'camera box class')) ?? 'unknown',
            cameraId: camera.id,
            presentation: 'rectangle',
            center: [finite(row['[CameraBoxComponent].box.center.x'], 'camera box x'), finite(row['[CameraBoxComponent].box.center.y'], 'camera box y')],
            dimensions: [finite(row['[CameraBoxComponent].box.size.x'], 'camera box width'), finite(row['[CameraBoxComponent].box.size.y'], 'camera box height')],
          })
        }
      }

      const keypoints3d: NormalizedKeypointSetV1[] = []
      if (requested.has('keypoints3d')) {
        for (const row of bundle.keypointsByFrame?.get(timestampMicros) ?? []) {
          const types = numericList(row['[LiDARHumanKeypointsComponent].lidar_keypoints[*].type'], '3D keypoint types')
          const xs = numericList(row['[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.x'], '3D keypoint x')
          const ys = numericList(row['[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.y'], '3D keypoint y')
          const zs = numericList(row['[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.z'], '3D keypoint z')
          const count = Math.min(types.length, xs.length, ys.length, zs.length)
          keypoints3d.push({
            objectId: String(row['key.laser_object_id']),
            schemaId: 'waymo-human-keypoints-v1',
            frameId: 'ego',
            points: Array.from({ length: count }, (_, pointIndex) => ({
              name: WAYMO_KEYPOINT_LABELS[types[pointIndex]] ?? `Keypoint ${types[pointIndex]}`,
              position: [xs[pointIndex], ys[pointIndex], zs[pointIndex]],
              visibility: 'unknown' as const,
            })),
          })
        }
      }

      const keypoints2d: NormalizedKeypointSetV1[] = []
      if (requested.has('keypoints2d')) {
        for (const [rowIndex, row] of (bundle.cameraKeypointsByFrame?.get(timestampMicros) ?? []).entries()) {
          const camera = cameraSensors.get(row['key.camera_name'] as number)
          if (!camera || (request.sensorIds && !request.sensorIds.has(camera.id))) continue
          const types = numericList(row['[CameraHumanKeypointsComponent].camera_keypoints[*].type'], '2D keypoint types')
          const xs = numericList(row['[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.x'], '2D keypoint x')
          const ys = numericList(row['[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.y'], '2D keypoint y')
          const occluded = row['[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.visibility.is_occluded'] as boolean[] | undefined
          const count = Math.min(types.length, xs.length, ys.length)
          keypoints2d.push({
            objectId: String(row['key.camera_object_id'] ?? `${camera.id}-${rowIndex}`),
            schemaId: 'waymo-human-keypoints-v1',
            frameId: camera.frameId,
            cameraId: camera.id,
            points: Array.from({ length: count }, (_, pointIndex) => ({
              name: WAYMO_KEYPOINT_LABELS[types[pointIndex]] ?? `Keypoint ${types[pointIndex]}`,
              position: [xs[pointIndex], ys[pointIndex]],
              visibility: occluded?.[pointIndex] ? 'occluded' as const : 'visible' as const,
            })),
          })
        }
      }

      const cameraSegmentation: NormalizedFrameV1['cameraSegmentation'][number][] = []
      if (requested.has('cameraSegmentation')) {
        for (const [rendererId, segmentation] of bundle.cameraSeg?.get(timestampMicros) ?? []) {
          const camera = cameraSensors.get(rendererId)
          if (!camera || (request.sensorIds && !request.sensorIds.has(camera.id))) continue
          cameraSegmentation.push({
            sensorId: camera.id,
            taxonomyId: 'waymo-camera-semantics',
            labels: segmentation.panopticLabel.slice(0),
            divisor: segmentation.divisor,
            encoding: 'png-uint16',
          })
        }
      }

      return {
        index,
        timestampMicros,
        worldFromEgo: bundle.poseByFrameIndex.has(index) ? new Float64Array(bundle.poseByFrameIndex.get(index)!) : null,
        pointClouds,
        radarPointClouds: [],
        cameraImages,
        boxes3d,
        boxes2d,
        keypoints3d,
        keypoints2d,
        lidarSegmentation,
        cameraSegmentation,
      }
    },
    dispose(): void {
      disposed = true
      box2dToBox3d.clear()
    },
  }
  return { scene, diagnostics, metadata: bundle }
}
