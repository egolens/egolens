import type { NuScenesDatabase } from '../../adapters/nuscenes/metadata'
import { loadNuScenesSceneMetadata } from '../../adapters/nuscenes/metadata'
import type { MetadataBundle } from '../../types/dataset'
import { NUSCENES_CHANNEL_TO_ID } from '../../adapters/nuscenes/manifest'
import { quaternionToMatrix4x4 } from '../../utils/quaternion'
import { resolveFileEntry } from '../../workers/fetchHelper'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import {
  decodeInterleavedRecordsV1,
  decodeNpzUint16V1,
  decodePcdRecordsV1,
  transformInterleavedXyzV1,
  type InterleavedRecordsParamsV1,
  type NpzUint16ParamsV1,
  type PcdRecordsParamsV1,
} from '../operators/binaryReaders'
import type {
  FrameCapabilityRequest,
  NormalizedBox2dV1,
  NormalizedBox3dV1,
  NormalizedCameraCalibrationV1,
  NormalizedCapabilityV1,
  NormalizedFrameV1,
  NormalizedPointCloudV1,
  NormalizedRelationsV1,
  NormalizedSceneV1,
  NormalizedTrackPointV1,
  NormalizedTransformV1,
} from './normalizedScene'
import { projectBox3dPinholeV1 } from '../operators/sceneGeometry'

export interface NuScenesRecipeSceneInputV1 {
  readonly compiledRecipe: CompiledRecipeV1
  readonly database: NuScenesDatabase
  readonly sceneToken: string
  readonly files: ReadonlyMap<string, File | string>
  readonly metadataBundle?: MetadataBundle
}

export interface BoundNuScenesRecipeSceneV1 {
  readonly scene: NormalizedSceneV1
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly metadata: MetadataBundle
}

interface FrameSensorFile {
  readonly channel: string
  readonly sensorId: number
  readonly modality: 'lidar' | 'radar' | 'camera'
  readonly filename: string
  readonly lidarsegFile?: string
  readonly panopticFile?: string
}

const emptyFrameCollections = {
  keypoints3d: [],
  keypoints2d: [],
  cameraSegmentation: [],
} as const

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Scene frame load was aborted.', 'AbortError')
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid normalized ${label}.`)
  return value
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

/**
 * Bind the compiled nuScenes recipe to the dataset-neutral scene contract.
 * Dataset tables choose records; all byte decoding is delegated to generic,
 * versioned operators.
 */
export function bindNuScenesRecipeSceneV1(input: NuScenesRecipeSceneInputV1): BoundNuScenesRecipeSceneV1 {
  const bundle = input.metadataBundle ?? loadNuScenesSceneMetadata(input.database, input.sceneToken)
  if (bundle.timestamps.length === 0) throw new Error('TIMELINE_BINDING_EMPTY: nuScenes scene has no frames.')
  const recipe = input.compiledRecipe.recipe
  const pointSensorsByRendererId = new Map(
    recipe.scene.sensors.filter((sensor) => sensor.modality !== 'camera').map((sensor) => [sensor.rendererId, sensor]),
  )
  const cameraSensorsByRendererId = new Map(
    recipe.scene.sensors.filter((sensor) => sensor.modality === 'camera').map((sensor) => [sensor.rendererId, sensor]),
  )
  const objectTaxonomy = recipe.scene.taxonomies.find((taxonomy) => taxonomy.role === 'objects')
  const classIdByRendererId = new Map(objectTaxonomy?.classes.map((entry) => [entry.rendererId, entry.id]) ?? [])

  const frameFiles = bundle.timestamps.map((timestamp) =>
    (bundle.vehiclePoseByFrame.get(timestamp) ?? []) as unknown as FrameSensorFile[],
  )
  const hasFile = (file?: string): boolean => file !== undefined && input.files.has(file)
  const evidence: Partial<Record<NormalizedCapabilityV1, boolean>> = {
    timeline: true,
    egoPoses: bundle.poseByFrameIndex.size > 0,
    pointClouds: frameFiles.some((files) => files.some((file) => file.modality === 'lidar' && hasFile(file.filename))),
    radarPointClouds: frameFiles.some((files) => files.some((file) => file.modality === 'radar' && hasFile(file.filename))),
    cameraImages: frameFiles.some((files) => files.some((file) => file.modality === 'camera' && hasFile(file.filename))),
    boxes3d: bundle.hasBoxData,
    boxes2d: bundle.hasBoxData && bundle.cameraCalibrations.length > 0
      && frameFiles.some((files) => files.some((file) => file.modality === 'camera' && hasFile(file.filename))),
    trajectories: bundle.objectTrajectories.size > 0,
    lidarSegmentation: frameFiles.some((files) => files.some((file) => hasFile(file.lidarsegFile) || hasFile(file.panopticFile))),
    segmentMetadata: bundle.segmentMeta !== null,
  }
  const capabilities = new Set<NormalizedCapabilityV1>()
  const diagnostics: AdapterDiagnostic[] = []
  for (const capability of input.compiledRecipe.capabilities) {
    if (evidence[capability]) capabilities.add(capability)
    else diagnostics.push(capabilityDiagnostic(capability))
  }

  const staticTransforms: NormalizedTransformV1[] = []
  const cameraCalibrations = new Map<string, NormalizedCameraCalibrationV1>()
  const extrinsicBySensorId = new Map<string, readonly number[]>()
  for (const calibrated of input.database.calibratedSensorByToken.values()) {
    const sourceSensor = input.database.sensorByToken.get(calibrated.sensor_token)
    if (!sourceSensor) continue
    const rendererId = NUSCENES_CHANNEL_TO_ID[sourceSensor.channel]
    const sensor = sourceSensor.modality === 'camera'
      ? cameraSensorsByRendererId.get(rendererId)
      : pointSensorsByRendererId.get(rendererId)
    if (!sensor) continue
    const transform = quaternionToMatrix4x4(calibrated.rotation, calibrated.translation)
    extrinsicBySensorId.set(sensor.id, transform)
    staticTransforms.push({
      parentFrameId: 'ego',
      childFrameId: sensor.frameId,
      parentFromChild: new Float64Array(transform),
    })
    if (sensor.modality === 'camera' && sensor.image) {
      const intrinsics = calibrated.camera_intrinsic
      cameraCalibrations.set(sensor.id, {
        sensorId: sensor.id,
        frameId: sensor.frameId,
        width: sensor.image.width,
        height: sensor.image.height,
        intrinsics: [
          intrinsics?.[0]?.[0] ?? 0,
          intrinsics?.[1]?.[1] ?? 0,
          intrinsics?.[0]?.[2] ?? sensor.image.width / 2,
          intrinsics?.[1]?.[2] ?? sensor.image.height / 2,
        ],
        distortionModel: 'none',
        distortion: [],
        egoFromCamera: new Float64Array(transform),
      })
    }
  }

  const trajectories = new Map<string, readonly NormalizedTrackPointV1[]>()
  for (const [objectId, points] of bundle.objectTrajectories) {
    trajectories.set(objectId, points.map((point) => ({
      frameIndex: point.frameIndex,
      position: [point.x, point.y, point.z],
      classId: classIdByRendererId.get(point.type) ?? 'unknown',
    })))
  }
  const box2dToBox3d = new Map<string, string>()
  const relations: NormalizedRelationsV1 = {
    staticTransforms,
    cameraCalibrations,
    trajectories,
    box2dToBox3d,
  }

  const lidarParams = recipe.sources.lidarRecords.params as unknown as InterleavedRecordsParamsV1
  const radarParams = recipe.sources.radarRecords.params as unknown as PcdRecordsParamsV1
  const panopticParams = recipe.sources.panopticLabels.params as unknown as NpzUint16ParamsV1
  const segment = input.database.scenes.find((candidate) => candidate.token === input.sceneToken)!
  let disposed = false

  const loadPointCloud = async (
    file: FrameSensorFile,
    signal?: AbortSignal,
  ): Promise<{ cloud: NormalizedPointCloudV1; segmentation: NormalizedFrameV1['lidarSegmentation'] }> => {
    const sensor = pointSensorsByRendererId.get(file.sensorId)
    if (!sensor) throw new Error(`Unknown point sensor renderer ID: ${file.sensorId}`)
    const entry = input.files.get(file.filename)
    if (!entry) throw new Error(`Bound point-cloud file is missing: ${file.filename}`)
    throwIfAborted(signal)
    const bytes = await resolveFileEntry(entry)
    throwIfAborted(signal)
    const decoded = transformInterleavedXyzV1(
      file.modality === 'radar'
        ? decodePcdRecordsV1(bytes, radarParams, signal)
        : decodeInterleavedRecordsV1(bytes, lidarParams, signal),
      extrinsicBySensorId.get(sensor.id) ?? null,
    )
    let semanticLabels: Uint8Array | undefined
    let panopticLabels: Uint16Array | undefined
    if (file.lidarsegFile && hasFile(file.lidarsegFile)) {
      const labels = await resolveFileEntry(input.files.get(file.lidarsegFile)!)
      semanticLabels = new Uint8Array(labels)
    }
    if (file.panopticFile && hasFile(file.panopticFile)) {
      const labels = await resolveFileEntry(input.files.get(file.panopticFile)!)
      panopticLabels = await decodeNpzUint16V1(labels, panopticParams, signal)
      if (!semanticLabels) semanticLabels = Uint8Array.from(panopticLabels, (label) => Math.floor(label / 1000))
    }
    if (semanticLabels && semanticLabels.length !== decoded.pointCount) {
      throw new Error(`POINT_LABEL_COUNT_MISMATCH: ${semanticLabels.length} labels for ${decoded.pointCount} points.`)
    }
    if (panopticLabels && panopticLabels.length !== decoded.pointCount) {
      throw new Error(`POINT_LABEL_COUNT_MISMATCH: ${panopticLabels.length} panoptic labels for ${decoded.pointCount} points.`)
    }
    const cloud: NormalizedPointCloudV1 = {
      sensorId: sensor.id,
      frameId: 'ego',
      values: decoded.values,
      pointCount: decoded.pointCount,
      stride: decoded.stride,
      attributes: decoded.attributes,
      semanticLabels,
      panopticLabels,
    }
    const segmentation: NormalizedFrameV1['lidarSegmentation'] = semanticLabels ? [{
      sensorId: sensor.id,
      taxonomyId: 'nuscenes-lidar-semantics',
      labels: panopticLabels ?? semanticLabels,
      divisor: panopticLabels ? 1000 : undefined,
      encoding: 'point-index',
    }] : []
    return { cloud, segmentation }
  }

  const scene: NormalizedSceneV1 = {
    manifest: { ...input.compiledRecipe.normalizedManifest, capabilities },
    index: {
      timestampsMicros: bundle.timestamps,
      segments: [{
        id: segment.name,
        label: segment.description,
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
      const files = frameFiles[index]
      const pointClouds: NormalizedPointCloudV1[] = []
      const radarPointClouds: NormalizedPointCloudV1[] = []
      const lidarSegmentation: NormalizedFrameV1['lidarSegmentation'][number][] = []
      if (requested.has('pointClouds') || requested.has('radarPointClouds') || requested.has('lidarSegmentation')) {
        for (const file of files) {
          if (file.modality === 'camera') continue
          const sensor = pointSensorsByRendererId.get(file.sensorId)
          if (request.sensorIds && sensor && !request.sensorIds.has(sensor.id)) continue
          if (file.modality === 'lidar' && !requested.has('pointClouds') && !requested.has('lidarSegmentation')) continue
          if (file.modality === 'radar' && !requested.has('radarPointClouds')) continue
          if (!hasFile(file.filename)) continue
          const loaded = await loadPointCloud(file, request.signal)
          if (file.modality === 'radar') radarPointClouds.push(loaded.cloud)
          else pointClouds.push(loaded.cloud)
          if (requested.has('lidarSegmentation')) lidarSegmentation.push(...loaded.segmentation)
        }
      }

      const cameraImages: NormalizedFrameV1['cameraImages'][number][] = []
      if (requested.has('cameraImages')) {
        for (const file of files.filter((candidate) => candidate.modality === 'camera')) {
          const sensor = cameraSensorsByRendererId.get(file.sensorId)
          if (!sensor || !sensor.image || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          const entry = input.files.get(file.filename)
          if (!entry) continue
          const encodedBytes = await resolveFileEntry(entry)
          throwIfAborted(request.signal)
          cameraImages.push({
            sensorId: sensor.id,
            timestampMicros: bundle.timestamps[index],
            encodedBytes,
            mimeType: file.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
            width: sensor.image.width,
            height: sensor.image.height,
            calibrationId: sensor.id,
          })
        }
      }

      const boxes3d: NormalizedBox3dV1[] = []
      if (requested.has('boxes3d') || requested.has('boxes2d')) {
        for (const row of bundle.lidarBoxByFrame.get(bundle.timestamps[index]) ?? []) {
          const heading = asFiniteNumber(row['[LiDARBoxComponent].box.heading'], 'box heading')
          boxes3d.push({
            id: String(row['key.laser_object_id']),
            objectId: String(row['key.laser_object_id']),
            classId: classIdByRendererId.get(asFiniteNumber(row['[LiDARBoxComponent].type'], 'box class')) ?? 'unknown',
            frameId: 'ego',
            center: [
              asFiniteNumber(row['[LiDARBoxComponent].box.center.x'], 'box x'),
              asFiniteNumber(row['[LiDARBoxComponent].box.center.y'], 'box y'),
              asFiniteNumber(row['[LiDARBoxComponent].box.center.z'], 'box z'),
            ],
            dimensions: [
              asFiniteNumber(row['[LiDARBoxComponent].box.size.x'], 'box length'),
              asFiniteNumber(row['[LiDARBoxComponent].box.size.y'], 'box width'),
              asFiniteNumber(row['[LiDARBoxComponent].box.size.z'], 'box height'),
            ],
            orientation: [Math.cos(heading / 2), 0, 0, Math.sin(heading / 2)],
            heading,
          })
        }
      }
      const boxes2d: NormalizedBox2dV1[] = []
      if (requested.has('boxes2d')) {
        for (const box of boxes3d) {
          for (const calibration of cameraCalibrations.values()) {
            if (request.sensorIds && !request.sensorIds.has(calibration.sensorId)) continue
            const projected = projectBox3dPinholeV1(box, calibration)
            if (!projected) continue
            boxes2d.push(projected)
            box2dToBox3d.set(projected.id, box.id)
          }
        }
      }

      return {
        index,
        timestampMicros: bundle.timestamps[index],
        worldFromEgo: bundle.poseByFrameIndex.has(index)
          ? new Float64Array(bundle.poseByFrameIndex.get(index)!)
          : null,
        pointClouds,
        radarPointClouds,
        cameraImages,
        boxes3d,
        boxes2d,
        ...emptyFrameCollections,
        lidarSegmentation,
      }
    },
    dispose(): void {
      disposed = true
      box2dToBox3d.clear()
    },
  }
  return { scene, diagnostics, metadata: bundle }
}
