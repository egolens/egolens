import type { AV2LogDatabase } from '../../adapters/argoverse2/metadata'
import { loadAV2LogMetadata } from '../../adapters/argoverse2/metadata'
import type { MetadataBundle } from '../../types/dataset'
import { resolveFileEntry } from '../../workers/fetchHelper'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import {
  decodeFeatherColumnsV1,
  interleaveFeatherNumericColumnsV1,
  type FeatherColumnsParamsV1,
} from '../operators/featherColumns'
import { headingFromQuaternionWxyzV1, projectBox3dPinholeV1 } from '../operators/sceneGeometry'
import { normalizeNanosecondTimelineV1 } from '../operators/temporal'
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

export interface AV2RecipeSceneInputV1 {
  readonly compiledRecipe: CompiledRecipeV1
  readonly database: AV2LogDatabase
  readonly files: ReadonlyMap<string, File | string>
  readonly metadataBundle?: MetadataBundle
}

export interface BoundAV2RecipeSceneV1 {
  readonly scene: NormalizedSceneV1
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly metadata: MetadataBundle
}

interface FrameSensorFile {
  readonly modality: 'lidar' | 'camera'
  readonly sensorId: number
  readonly filename: string
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Scene frame load was aborted.', 'AbortError')
}

function finite(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Invalid normalized ${label}.`)
  return number
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

function cameraTimestampMicros(filename: string, fallback: bigint): bigint {
  const match = filename.match(/\/(\d+)\.[^.]+$/u)
  return match ? BigInt(match[1]) / 1000n : fallback
}

/** Bind AV2 tables and bytes through the same normalized scene boundary as nuScenes. */
export function bindAV2RecipeSceneV1(input: AV2RecipeSceneInputV1): BoundAV2RecipeSceneV1 {
  const bundle = input.metadataBundle ?? loadAV2LogMetadata(input.database)
  if (bundle.timestamps.length === 0) throw new Error('TIMELINE_BINDING_EMPTY: Argoverse 2 log has no frames.')
  const recipe = input.compiledRecipe.recipe
  const pointSensor = recipe.scene.sensors.find((sensor) => sensor.modality === 'lidar')
  if (!pointSensor) throw new Error('SENSOR_BINDING_MISSING: Argoverse 2 recipe has no LiDAR sensor.')
  const cameraSensorsByRendererId = new Map(
    recipe.scene.sensors.filter((sensor) => sensor.modality === 'camera').map((sensor) => [sensor.rendererId, sensor]),
  )
  const objectTaxonomy = recipe.scene.taxonomies.find((taxonomy) => taxonomy.role === 'objects')
  const classIds = new Set(objectTaxonomy?.classes.map((entry) => entry.id) ?? [])
  const classIdByRendererId = new Map(objectTaxonomy?.classes.map((entry) => [entry.rendererId, entry.id]) ?? [])
  const frameFiles = bundle.timestamps.map((timestamp) =>
    (bundle.vehiclePoseByFrame.get(timestamp) ?? []) as unknown as FrameSensorFile[],
  )
  const hasFile = (filename?: string): boolean => filename !== undefined && input.files.has(filename)
  const hasCameraCalibration = input.database.intrinsicsBySensor.size > 0 && input.database.extrinsicsBySensor.size > 0
  const evidence: Partial<Record<NormalizedCapabilityV1, boolean>> = {
    timeline: true,
    egoPoses: bundle.poseByFrameIndex.size > 0,
    pointClouds: frameFiles.some((files) => files.some((file) => file.modality === 'lidar' && hasFile(file.filename))),
    cameraImages: hasCameraCalibration
      && frameFiles.some((files) => files.some((file) => file.modality === 'camera' && hasFile(file.filename))),
    boxes3d: input.database.annotationsByTimestamp.size > 0,
    boxes2d: input.database.annotationsByTimestamp.size > 0 && hasCameraCalibration
      && frameFiles.some((files) => files.some((file) => file.modality === 'camera' && hasFile(file.filename))),
    trajectories: bundle.objectTrajectories.size > 0,
    segmentMetadata: true,
  }
  const capabilities = new Set<NormalizedCapabilityV1>()
  const diagnostics: AdapterDiagnostic[] = []
  for (const capability of input.compiledRecipe.capabilities) {
    if (evidence[capability]) capabilities.add(capability)
    else diagnostics.push(capabilityDiagnostic(capability))
  }

  const staticTransforms: NormalizedTransformV1[] = [{
    parentFrameId: 'ego',
    childFrameId: pointSensor.frameId,
    parentFromChild: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  }]
  const cameraCalibrations = new Map<string, NormalizedCameraCalibrationV1>()
  for (const sensor of recipe.scene.sensors.filter((candidate) => candidate.modality === 'camera')) {
    const intrinsics = input.database.intrinsicsBySensor.get(sensor.id)
    const egoFromCamera = input.database.extrinsicsBySensor.get(sensor.id)
    if (!sensor.image || !intrinsics || !egoFromCamera) continue
    staticTransforms.push({
      parentFrameId: 'ego',
      childFrameId: sensor.frameId,
      parentFromChild: new Float64Array(egoFromCamera),
    })
    cameraCalibrations.set(sensor.id, {
      sensorId: sensor.id,
      frameId: sensor.frameId,
      width: intrinsics.width || sensor.image.width,
      height: intrinsics.height || sensor.image.height,
      intrinsics: [intrinsics.fx, intrinsics.fy, intrinsics.cx, intrinsics.cy],
      distortionModel: 'brown-conrady',
      distortion: [intrinsics.k1, intrinsics.k2, 0, 0, intrinsics.k3],
      egoFromCamera: new Float64Array(egoFromCamera),
    })
  }

  const trajectories = new Map<string, readonly NormalizedTrackPointV1[]>()
  for (const [objectId, points] of bundle.objectTrajectories) {
    trajectories.set(objectId, points.map((point) => ({
      frameIndex: point.frameIndex,
      position: [point.x, point.y, point.z],
      classId: classIdByRendererId.get(point.type) ?? 'UNKNOWN',
    })))
  }
  const box2dToBox3d = new Map<string, string>()
  const relations: NormalizedRelationsV1 = { staticTransforms, cameraCalibrations, trajectories, box2dToBox3d }
  const lidarParams = recipe.sources.lidarFrames.params as unknown as FeatherColumnsParamsV1
  const normalizedTimestamps = normalizeNanosecondTimelineV1(bundle.timestamps)
  let disposed = false

  const scene: NormalizedSceneV1 = {
    manifest: { ...input.compiledRecipe.normalizedManifest, capabilities },
    index: {
      timestampsMicros: normalizedTimestamps,
      segments: [{
        id: input.database.logId,
        label: input.database.logId,
        firstFrame: 0,
        frameCount: bundle.timestamps.length,
        metadata: { logId: input.database.logId },
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
      const sourceTimestamp = bundle.timestamps[index]
      const timestampMicros = normalizedTimestamps[index]
      const files = frameFiles[index]
      const pointClouds: NormalizedPointCloudV1[] = []
      if (requested.has('pointClouds') && (!request.sensorIds || request.sensorIds.has(pointSensor.id))) {
        const lidarFile = files.find((file) => file.modality === 'lidar' && hasFile(file.filename))
        if (lidarFile) {
          const encoded = await resolveFileEntry(input.files.get(lidarFile.filename)!)
          throwIfAborted(request.signal)
          const decoded = interleaveFeatherNumericColumnsV1(
            decodeFeatherColumnsV1(encoded, lidarParams, request.signal),
            recipe.scene.pointLayout.interleavedAttributes,
            request.signal,
          )
          pointClouds.push({
            sensorId: pointSensor.id,
            frameId: 'ego',
            values: decoded.values,
            pointCount: decoded.pointCount,
            stride: decoded.stride,
            attributes: decoded.attributes,
          })
        }
      }

      const cameraImages: NormalizedFrameV1['cameraImages'][number][] = []
      if (requested.has('cameraImages')) {
        for (const file of files.filter((candidate) => candidate.modality === 'camera')) {
          const sensor = cameraSensorsByRendererId.get(file.sensorId)
          if (!sensor?.image || !hasFile(file.filename) || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          const encodedBytes = await resolveFileEntry(input.files.get(file.filename)!)
          throwIfAborted(request.signal)
          cameraImages.push({
            sensorId: sensor.id,
            timestampMicros: cameraTimestampMicros(file.filename, timestampMicros),
            encodedBytes,
            mimeType: 'image/jpeg',
            width: sensor.image.width,
            height: sensor.image.height,
            calibrationId: sensor.id,
          })
        }
      }

      const boxes3d: NormalizedBox3dV1[] = []
      if (requested.has('boxes3d') || requested.has('boxes2d')) {
        for (const annotation of input.database.annotationsByTimestamp.get(sourceTimestamp) ?? []) {
          const quaternion: [number, number, number, number] = [
            finite(annotation.qw, 'box qw'),
            finite(annotation.qx, 'box qx'),
            finite(annotation.qy, 'box qy'),
            finite(annotation.qz, 'box qz'),
          ]
          const category = String(annotation.category)
          const objectId = String(annotation.track_uuid)
          boxes3d.push({
            id: objectId,
            objectId,
            classId: classIds.has(category) ? category : 'UNKNOWN',
            frameId: 'ego',
            center: [finite(annotation.tx_m, 'box x'), finite(annotation.ty_m, 'box y'), finite(annotation.tz_m, 'box z')],
            dimensions: [
              finite(annotation.length_m, 'box length'),
              finite(annotation.width_m, 'box width'),
              finite(annotation.height_m, 'box height'),
            ],
            orientation: quaternion,
            heading: headingFromQuaternionWxyzV1(quaternion),
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
        timestampMicros,
        worldFromEgo: bundle.poseByFrameIndex.has(index)
          ? new Float64Array(bundle.poseByFrameIndex.get(index)!)
          : null,
        pointClouds,
        radarPointClouds: [],
        cameraImages,
        boxes3d,
        boxes2d,
        keypoints3d: [],
        keypoints2d: [],
        lidarSegmentation: [],
        cameraSegmentation: [],
      }
    },
    dispose(): void {
      disposed = true
      box2dToBox3d.clear()
    },
  }
  return { scene, diagnostics, metadata: bundle }
}
