import type { MetadataBundle, TrajectoryPoint } from '../../types/dataset'
import { invertRowMajor4x4, multiplyRowMajor4x4 } from '../../utils/matrix'
import { convertAllSensors, type LidarCalibration, type RangeImage } from '../../utils/rangeImage'
import { transformInterleavedXyzV1 } from '../operators/binaryReaders'
import { alignNearestTimestampV1 } from '../operators/temporal'
import {
  interleaveFeatherNumericColumnsV1,
  loadGraphBinaryV1,
  loadGraphParquetFrameRowsV1,
  loadGraphTableV1,
} from '../operators/coreGraphOperators'
import { projectBox3dPinholeV1 } from '../operators/sceneGeometry'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import type {
  GraphBinaryPointCloudBindingV1,
  GraphBinaryPointCloudPlanV1,
  GraphBoxRelationsV1,
  GraphBoxesV1,
  GraphBoxes2dV1,
  GraphCameraPlanV1,
  GraphCameraSegmentationV1,
  GraphKeypointsV1,
  GraphParquetCameraPlanV1,
  GraphPointCloudPlanV1,
  GraphPoseTimelineV1,
  GraphProjectedBoxesV1,
  GraphRangeImagePointCloudPlanV1,
  GraphRangeImageSegmentationPlanV1,
  GraphRecordsV1,
  GraphSegmentDescriptorV1,
  GraphSegmentIndexV1,
  GraphSegmentationPlanV1,
  GraphTimelineFrameV1,
  GraphTimelineV1,
  GraphTrajectoriesV1,
  GraphTrajectoryPlanV1,
} from './GraphValues'
import type { GraphExecutionResultV1 } from './GraphKernel'
import type {
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

function micros(timestamp: bigint, unit: GraphTimelineV1['unit']): bigint {
  if (unit === 'ns') return timestamp / 1_000n
  if (unit === 'us') return timestamp
  if (unit === 'ms') return timestamp * 1_000n
  return timestamp * 1_000_000n
}

function kind<T extends { readonly kind: string }>(value: unknown, expected: T['kind']): T | null {
  return typeof value === 'object' && value !== null && (value as { kind?: string }).kind === expected ? value as T : null
}

function sensorForId(
  recipe: CompiledRecipeV1,
  sensorId: string,
  modality?: CompiledRecipeV1['recipe']['scene']['sensors'][number]['modality'],
) {
  return recipe.recipe.scene.sensors.find((sensor) => (
    (!modality || sensor.modality === modality) &&
    sensor.id === sensorId
    || ((!modality || sensor.modality === modality) && String(sensor.rendererId) === sensorId)
    || ((!modality || sensor.modality === modality) && sensor.image?.aliases?.includes(sensorId))
  ))
}

function numericList(value: unknown, label: string, length?: number): number[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)
    || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
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

function cameraSensorForPath(recipe: CompiledRecipeV1, path: string) {
  const parts = new Set(path.split('/'))
  return recipe.recipe.scene.sensors.find((sensor) => sensor.modality === 'camera' && (
    parts.has(sensor.id) || sensor.image?.aliases?.some((alias) => parts.has(alias))
  ))
}

function emptyFrame(index: number, timestampMicros: bigint, worldFromEgo: Float64Array | null): NormalizedFrameV1 {
  return {
    index, timestampMicros, worldFromEgo,
    pointClouds: [], radarPointClouds: [], cameraImages: [], boxes3d: [], boxes2d: [],
    keypoints3d: [], keypoints2d: [], lidarSegmentation: [], cameraSegmentation: [],
  }
}

function capabilityDiagnostic(capability: NormalizedCapabilityV1): AdapterDiagnostic {
  return {
    stage: 'bind', severity: 'info', code: 'OPTIONAL_OUTPUT_UNBOUND', jsonPointer: `/outputs/${capability}`,
    hint: `The ${capability} output has no complete source binding and was disabled.`,
  }
}

function selectedTimeline(
  timeline: GraphTimelineV1,
  segmentIndex: GraphSegmentIndexV1 | null,
  requestedId?: string,
  segmentIdentity?: GraphRecordsV1['segmentIdentity'],
): { readonly frames: readonly GraphTimelineFrameV1[]; readonly segment: GraphSegmentDescriptorV1 } {
  const descriptors = segmentIndex?.segments ?? []
  let segment = requestedId
    ? descriptors.find((entry) => entry.id === requestedId || entry.groupId === requestedId)
    : descriptors[0]
  if (!segment) {
    const groupId = requestedId ?? timeline.frames[0]?.group ?? 'segment'
    const id = requestedId ?? groupId
    segment = {
      groupId,
      id,
      ...(segmentIdentity?.labelFromSceneId ? { label: id } : {}),
      ...(segmentIdentity?.metadataKey ? { metadata: { [segmentIdentity.metadataKey]: id } } : {}),
    }
  }
  const hasGroups = timeline.frames.some((frame) => frame.group !== undefined)
  const frames = hasGroups ? timeline.frames.filter((frame) => frame.group === segment.groupId) : timeline.frames
  if (frames.length === 0) throw new Error(`RECIPE_SCENE_NOT_FOUND: ${requestedId ?? segment.id}`)
  return { frames, segment }
}

function selectedTrajectories(
  value: GraphTrajectoriesV1 | GraphTrajectoryPlanV1 | null,
  frames: readonly GraphTimelineFrameV1[],
): ReadonlyMap<string, readonly NormalizedTrackPointV1[]> {
  if (!value) return new Map()
  if (value.kind === 'trajectories') return value.tracks
  const tracks = new Map<string, NormalizedTrackPointV1[]>()
  frames.forEach((frame, frameIndex) => {
    for (const box of value.boxes.byFrameKey?.get(frame.key ?? '') ?? []) {
      const points = tracks.get(box.objectId) ?? []
      points.push({ frameIndex, position: box.center, classId: box.classId })
      tracks.set(box.objectId, points)
    }
  })
  return tracks
}

function boxesForFrame(
  boxes: GraphBoxesV1 | null,
  frame: GraphTimelineFrameV1,
): readonly NormalizedBox3dV1[] {
  if (!boxes) return []
  return frame.key ? boxes.byFrameKey?.get(frame.key) ?? boxes.byTimestamp.get(frame.timestamp) ?? [] : boxes.byTimestamp.get(frame.timestamp) ?? []
}

function bindingsForFrame(
  plan: GraphBinaryPointCloudPlanV1 | null,
  frame: GraphTimelineFrameV1,
): readonly GraphBinaryPointCloudBindingV1[] {
  if (!plan || !frame.key) return []
  return plan.bindings.filter((binding) => binding.frameKey === frame.key)
}

async function loadBinaryPointCloud(
  binding: GraphBinaryPointCloudBindingV1,
  plan: GraphBinaryPointCloudPlanV1,
  segmentation: GraphSegmentationPlanV1 | null,
  signal?: AbortSignal,
  egoFromSensor: Float64Array | null = binding.egoFromSensor,
): Promise<{ readonly cloud: NormalizedPointCloudV1; readonly segmentation: NormalizedFrameV1['lidarSegmentation'] }> {
  const raw = await loadGraphBinaryV1(plan.records, binding.path, signal)
  if (raw instanceof Uint16Array) throw new Error('GRAPH_POINT_RECORDS_INVALID')
  const decoded = transformInterleavedXyzV1(raw, egoFromSensor ? [...egoFromSensor] : null)
  let semanticLabels: Uint8Array | undefined
  let panopticLabels: Uint16Array | undefined
  const semanticPath = segmentation?.semanticPathByRecordKey.get(binding.recordKey)
  const panopticPath = segmentation?.panopticPathByRecordKey.get(binding.recordKey)
  if (semanticPath && segmentation?.semantic) {
    const labels = await loadGraphBinaryV1(segmentation.semantic, semanticPath, signal)
    if (labels instanceof Uint16Array) semanticLabels = Uint8Array.from(labels)
    else semanticLabels = Uint8Array.from(labels.values)
  }
  if (panopticPath && segmentation?.panoptic) {
    const labels = await loadGraphBinaryV1(segmentation.panoptic, panopticPath, signal)
    if (!(labels instanceof Uint16Array)) throw new Error('GRAPH_PANOPTIC_RECORDS_INVALID')
    panopticLabels = labels
    if (!semanticLabels) semanticLabels = Uint8Array.from(labels, (label) => Math.floor(label / segmentation.panopticDivisor))
  }
  if (semanticLabels && semanticLabels.length !== decoded.pointCount) {
    throw new Error(`POINT_LABEL_COUNT_MISMATCH: ${semanticLabels.length} labels for ${decoded.pointCount} points.`)
  }
  if (panopticLabels && panopticLabels.length !== decoded.pointCount) {
    throw new Error(`POINT_LABEL_COUNT_MISMATCH: ${panopticLabels.length} panoptic labels for ${decoded.pointCount} points.`)
  }
  const cloud: NormalizedPointCloudV1 = {
    sensorId: binding.sensorId, frameId: binding.frameId,
    values: decoded.values, pointCount: decoded.pointCount, stride: decoded.stride, attributes: decoded.attributes,
    semanticLabels, panopticLabels,
  }
  return {
    cloud,
    segmentation: semanticLabels && segmentation ? [{
      sensorId: binding.sensorId, taxonomyId: segmentation.taxonomyId,
      labels: panopticLabels ?? semanticLabels, divisor: panopticLabels ? segmentation.panopticDivisor : undefined,
      encoding: 'point-index',
    }] : [],
  }
}

function attachRangeImageLabels(
  cloud: NormalizedPointCloudV1,
  row: Readonly<Record<string, unknown>> | undefined,
  plan: GraphRangeImageSegmentationPlanV1,
): { readonly semanticLabels?: Uint8Array; readonly panopticLabels?: Uint16Array } {
  if (!row || !cloud.sourceIndices) return {}
  const shape = numericList(row[plan.shapeField], plan.shapeField)
  const values = numericList(row[plan.valuesField], plan.valuesField)
  const channels = shape.length >= 3 ? shape[2] : 1
  const semanticLabels = new Uint8Array(cloud.pointCount)
  const panopticLabels = new Uint16Array(cloud.pointCount)
  for (let index = 0; index < cloud.pointCount; index += 1) {
    const sourceIndex = cloud.sourceIndices[index]
    const instance = Math.max(0, values[sourceIndex * channels] ?? 0)
    const semantic = channels >= 2 ? values[sourceIndex * channels + 1] ?? 0 : instance
    semanticLabels[index] = semantic
    panopticLabels[index] = semantic * plan.panopticDivisor + instance
  }
  return { semanticLabels, panopticLabels }
}

export interface AssembledGraphSceneV1 {
  readonly scene: NormalizedSceneV1
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly metadata: MetadataBundle
  readonly availableSegments: readonly GraphSegmentDescriptorV1[]
}

export function assembleGraphSceneV1(input: {
  readonly compiledRecipe: CompiledRecipeV1
  readonly graph: GraphExecutionResultV1
  readonly sceneId?: string
}): AssembledGraphSceneV1 {
  const timeline = kind<GraphTimelineV1>(input.graph.outputs.get('timeline'), 'timeline')
  if (!timeline) throw new Error('GRAPH_TIMELINE_OUTPUT_INVALID')
  const segmentIndex = kind<GraphSegmentIndexV1>(input.graph.outputs.get('segmentMetadata'), 'segment-index')
  const segmentRecords = kind<GraphRecordsV1>(input.graph.outputs.get('segmentMetadata'), 'records')
  const selected = selectedTimeline(timeline, segmentIndex, input.sceneId, segmentRecords?.segmentIdentity)
  const frames = selected.frames
  const timestamps = frames.map((frame) => frame.timestamp)
  const timestampsMicros = timestamps.map((timestamp) => micros(timestamp, timeline.unit))
  const frameKeys = new Set(frames.map((frame) => frame.key).filter((key): key is string => key !== undefined))
  const poses = kind<GraphPoseTimelineV1>(input.graph.outputs.get('egoPoses'), 'pose-timeline')
  const tablePointPlan = kind<GraphPointCloudPlanV1>(input.graph.outputs.get('pointClouds'), 'point-cloud-plan')
  const binaryPointPlan = kind<GraphBinaryPointCloudPlanV1>(input.graph.outputs.get('pointClouds'), 'binary-point-cloud-plan')
  const rangeImagePlan = kind<GraphRangeImagePointCloudPlanV1>(input.graph.outputs.get('pointClouds'), 'range-image-point-cloud-plan')
  const radarPlan = kind<GraphBinaryPointCloudPlanV1>(input.graph.outputs.get('radarPointClouds'), 'binary-point-cloud-plan')
  const cameraPlan = kind<GraphCameraPlanV1>(input.graph.outputs.get('cameraImages'), 'camera-plan')
  const parquetCameraPlan = kind<GraphParquetCameraPlanV1>(input.graph.outputs.get('cameraImages'), 'parquet-camera-plan')
  const boxes = kind<GraphBoxesV1>(input.graph.outputs.get('boxes3d'), 'boxes3d')
  const projected = kind<GraphProjectedBoxesV1>(input.graph.outputs.get('boxes2d'), 'projected-boxes2d')
  const directBoxes2d = kind<GraphBoxes2dV1>(input.graph.outputs.get('boxes2d'), 'boxes2d')
  const boxRelations = kind<GraphBoxRelationsV1>(input.graph.outputs.get('boxAssociations'), 'box-relations')
  const trajectoriesValue = kind<GraphTrajectoriesV1>(input.graph.outputs.get('trajectories'), 'trajectories')
    ?? kind<GraphTrajectoryPlanV1>(input.graph.outputs.get('trajectories'), 'trajectory-plan')
  const trajectories = selectedTrajectories(trajectoriesValue, frames)
  const segmentation = kind<GraphSegmentationPlanV1>(input.graph.outputs.get('lidarSegmentation'), 'segmentation-plan')
  const rangeSegmentation = kind<GraphRangeImageSegmentationPlanV1>(input.graph.outputs.get('lidarSegmentation'), 'range-image-segmentation-plan')
  const cameraSegmentationPlan = kind<GraphCameraSegmentationV1>(input.graph.outputs.get('cameraSegmentation'), 'camera-segmentation')
  const keypoints3dPlan = kind<GraphKeypointsV1>(input.graph.outputs.get('keypoints3d'), 'keypoints')
  const keypoints2dPlan = kind<GraphKeypointsV1>(input.graph.outputs.get('keypoints2d'), 'keypoints')
  const taxonomy = input.compiledRecipe.recipe.scene.taxonomies.find((entry) => entry.role === 'objects')
  const classIds = new Set(taxonomy?.classes.map((entry) => entry.id) ?? [])
  const fallbackClassId = classIds.has('unknown') ? 'unknown' : taxonomy?.classes[0]?.id ?? 'unknown'
  const classRendererIds = new Map(taxonomy?.classes.map((entry) => [entry.id, entry.rendererId]) ?? [])

  let worldOriginInverse = poses?.worldOriginInverse ? new Float64Array(poses.worldOriginInverse) : null
  const worldFromEgoByTimestamp = new Map<bigint, Float64Array>(poses?.worldFromEgoByTimestamp ?? [])
  if (poses?.absoluteWorldFromEgoByFrameKey) {
    const firstFrameKey = frames[0]?.key
    const firstAbsolute = firstFrameKey ? poses.absoluteWorldFromEgoByFrameKey.get(firstFrameKey) : undefined
    worldOriginInverse = firstAbsolute ? new Float64Array(invertRowMajor4x4([...firstAbsolute])) : null
    if (worldOriginInverse) {
      for (const frame of frames) {
        const absolute = frame.key ? poses.absoluteWorldFromEgoByFrameKey.get(frame.key) : undefined
        if (absolute) worldFromEgoByTimestamp.set(frame.timestamp, new Float64Array(multiplyRowMajor4x4([...worldOriginInverse], [...absolute])))
      }
    }
  }

  const pointSensorForBinding = (binding: GraphBinaryPointCloudBindingV1, modality: 'lidar' | 'radar') => {
    const sensor = sensorForId(input.compiledRecipe, binding.sensorId, modality)
    return sensor?.modality === modality ? sensor : null
  }
  const selectedBoxes = frames.some((frame) => boxesForFrame(boxes, frame).length > 0)
  const selectedCameraBindings = cameraPlan?.bindings?.filter((binding) => (
    frameKeys.has(binding.frameKey)
    && sensorForId(input.compiledRecipe, binding.sensorId, 'camera')
    && cameraPlan.calibrations.has(binding.sensorId)
  )) ?? []
  const selectedPointBindings = binaryPointPlan?.bindings.filter((binding) => (
    frameKeys.has(binding.frameKey) && pointSensorForBinding(binding, 'lidar')
  )) ?? []
  const selectedRadarBindings = radarPlan?.bindings.filter((binding) => (
    frameKeys.has(binding.frameKey) && pointSensorForBinding(binding, 'radar')
  )) ?? []
  const hasCameraFiles = Boolean(cameraPlan && (cameraPlan.bindings
    ? selectedCameraBindings.length
    : cameraPlan.encoded.files.some((file) => {
      const sensor = cameraSensorForPath(input.compiledRecipe, file.path)
      return sensor ? cameraPlan.calibrations.has(sensor.id) : false
    })))
  const hasSegmentation = selectedPointBindings.some((binding) => (
    segmentation?.semanticPathByRecordKey.has(binding.recordKey) || segmentation?.panopticPathByRecordKey.has(binding.recordKey)
  ))
  const hasRangePoints = Boolean(rangeImagePlan?.rows.files.length && rangeImagePlan.calibrations.size)
  const hasParquetCameraFiles = Boolean(parquetCameraPlan?.rows.files.length && parquetCameraPlan.calibrations.size)
  const hasDirectBoxes2d = frames.some((frame) => (directBoxes2d?.byTimestamp.get(frame.timestamp)?.length ?? 0) > 0)
  const evidence: Partial<Record<NormalizedCapabilityV1, boolean>> = {
    timeline: timestamps.length > 0,
    egoPoses: worldFromEgoByTimestamp.size > 0,
    pointClouds: Boolean(tablePointPlan?.tables.files.length || selectedPointBindings.length || hasRangePoints),
    radarPointClouds: selectedRadarBindings.length > 0,
    cameraImages: hasCameraFiles || hasParquetCameraFiles,
    boxes3d: selectedBoxes,
    boxes2d: Boolean((projected && selectedBoxes && hasCameraFiles) || hasDirectBoxes2d),
    boxAssociations: Boolean(boxRelations?.box2dToBox3d.size),
    trajectories: trajectories.size > 0,
    lidarSegmentation: hasSegmentation || Boolean(rangeSegmentation?.availableTimestamps.size && hasRangePoints),
    cameraSegmentation: Boolean(cameraSegmentationPlan?.byTimestamp.size),
    keypoints3d: Boolean(keypoints3dPlan?.dimensions === 3 && keypoints3dPlan.byTimestamp.size),
    keypoints2d: Boolean(keypoints2dPlan?.dimensions === 2 && keypoints2dPlan.byTimestamp.size),
    segmentMetadata: Boolean(segmentIndex?.segments.length || segmentRecords?.rows.length),
  }
  const capabilities = new Set<NormalizedCapabilityV1>()
  const diagnostics: AdapterDiagnostic[] = []
  for (const capability of input.compiledRecipe.capabilities) {
    if (evidence[capability]) capabilities.add(capability)
    else diagnostics.push(capabilityDiagnostic(capability))
  }

  const cameraCalibrations = new Map<string, NormalizedCameraCalibrationV1>()
  for (const calibration of [...(cameraPlan?.calibrations.values() ?? []), ...(parquetCameraPlan?.calibrations.values() ?? [])]) {
    const sensor = sensorForId(input.compiledRecipe, calibration.sensorId, 'camera')
    if (sensor?.modality !== 'camera') continue
    cameraCalibrations.set(sensor.id, { ...calibration, sensorId: sensor.id, frameId: sensor.frameId })
  }
  const sensorTransformById = new Map<string, Float64Array>()
  const relationalStaticTransforms: NormalizedTransformV1[] = []
  for (const transform of cameraPlan?.sensorTransforms ?? []) {
    const sensor = sensorForId(input.compiledRecipe, transform.sensorId)
    if (!sensor) continue
    sensorTransformById.set(sensor.id, transform.egoFromSensor)
    relationalStaticTransforms.push({
      parentFrameId: 'ego',
      childFrameId: sensor.frameId,
      parentFromChild: transform.egoFromSensor,
    })
  }
  const transformsByChild = new Map<string, NormalizedTransformV1>()
  const addPointTransforms = (
    bindings: readonly GraphBinaryPointCloudBindingV1[],
    modality: 'lidar' | 'radar',
  ) => {
    for (const binding of bindings) {
      const sensor = pointSensorForBinding(binding, modality)
      if (!sensor || !binding.egoFromSensor) continue
      transformsByChild.set(sensor.frameId, { parentFrameId: 'ego', childFrameId: sensor.frameId, parentFromChild: binding.egoFromSensor })
    }
  }
  addPointTransforms(selectedPointBindings, 'lidar')
  addPointTransforms(selectedRadarBindings, 'radar')
  for (const [rendererId, calibration] of rangeImagePlan?.calibrations ?? []) {
    const sensor = sensorForId(input.compiledRecipe, String(rendererId), 'lidar')
    if (!sensor || calibration.extrinsic.length !== 16) continue
    transformsByChild.set(sensor.frameId, {
      parentFrameId: 'ego', childFrameId: sensor.frameId,
      parentFromChild: new Float64Array(calibration.extrinsic),
    })
  }
  if (tablePointPlan) {
    const sensor = input.compiledRecipe.recipe.scene.sensors.find((entry) => entry.modality === 'lidar')
    if (sensor) transformsByChild.set(sensor.frameId, {
      parentFrameId: 'ego', childFrameId: sensor.frameId,
      parentFromChild: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })
  }
  for (const calibration of cameraCalibrations.values()) {
    transformsByChild.set(calibration.frameId, { parentFrameId: 'ego', childFrameId: calibration.frameId, parentFromChild: calibration.egoFromCamera })
  }
  const uniqueStaticTransforms = tablePointPlan
    ? input.compiledRecipe.recipe.scene.sensors.flatMap((sensor) => {
      const transform = transformsByChild.get(sensor.frameId)
      return transform ? [transform] : []
    })
    : [...transformsByChild.values()]
  const box2dToBox3d = new Map(boxRelations?.box2dToBox3d ?? [])
  const relations: NormalizedRelationsV1 = {
    staticTransforms: relationalStaticTransforms.length > 0 ? relationalStaticTransforms : uniqueStaticTransforms,
    cameraCalibrations, trajectories, box2dToBox3d,
  }

  const cameraPaths = new Map<string, { timestamps: bigint[]; byTimestamp: Map<bigint, string> }>()
  if (cameraPlan && !cameraPlan.bindings) {
    for (const file of cameraPlan.encoded.files) {
      const sensor = cameraSensorForPath(input.compiledRecipe, file.path)
      const match = /(?:^|\/)(\d+)\.[^/.]+$/u.exec(file.path)
      if (!sensor || !match) continue
      const entry = cameraPaths.get(sensor.id) ?? { timestamps: [] as bigint[], byTimestamp: new Map<bigint, string>() }
      const timestamp = BigInt(match[1])
      entry.timestamps.push(timestamp)
      entry.byTimestamp.set(timestamp, file.path)
      cameraPaths.set(sensor.id, entry)
    }
    for (const entry of cameraPaths.values()) entry.timestamps.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  }

  let disposed = false
  const scene: NormalizedSceneV1 = {
    manifest: { ...input.compiledRecipe.normalizedManifest, capabilities },
    index: {
      timestampsMicros,
      segments: [{
        id: selected.segment.id, label: selected.segment.label,
        firstFrame: 0, frameCount: frames.length, metadata: selected.segment.metadata,
      }],
    },
    relations,
    async loadFrame(index, request) {
      if (disposed) throw new Error('Normalized scene has been disposed.')
      if (!Number.isSafeInteger(index) || index < 0 || index >= frames.length) throw new RangeError(`Frame index ${index} is out of range.`)
      if (request.signal?.aborted) throw new DOMException('Scene frame load was aborted.', 'AbortError')
      const timelineFrame = frames[index]
      const frame = emptyFrame(index, timestampsMicros[index], worldFromEgoByTimestamp.get(timelineFrame.timestamp) ?? null)
      const requested = new Set([...request.capabilities].filter((capability) => capabilities.has(capability)))
      if (requested.has('pointClouds') && tablePointPlan) {
        const sensor = input.compiledRecipe.recipe.scene.sensors.find((entry) => entry.modality === 'lidar')
        if (sensor && (!request.sensorIds || request.sensorIds.has(sensor.id))) {
          const file = tablePointPlan.tables.files.find((entry) => /(?:^|\/)(\d+)\.[^/.]+$/u.exec(entry.path)?.[1] === timelineFrame.timestamp.toString())
          if (file) {
            const decoded = await loadGraphTableV1(tablePointPlan.tables, file.path, request.signal)
            const cloud = interleaveFeatherNumericColumnsV1(decoded, tablePointPlan.fields, request.signal)
            ;(frame.pointClouds as NormalizedPointCloudV1[]).push({ sensorId: sensor.id, frameId: tablePointPlan.frameId, ...cloud })
          }
        }
      }
      if ((requested.has('pointClouds') || requested.has('lidarSegmentation')) && binaryPointPlan) {
        for (const binding of bindingsForFrame(binaryPointPlan, timelineFrame)) {
          const sensor = pointSensorForBinding(binding, 'lidar')
          if (!sensor || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          const loaded = await loadBinaryPointCloud(
            binding,
            binaryPointPlan,
            segmentation,
            request.signal,
            sensorTransformById.get(sensor.id) ?? binding.egoFromSensor,
          )
          ;(frame.pointClouds as NormalizedPointCloudV1[]).push({ ...loaded.cloud, sensorId: sensor.id })
          if (requested.has('lidarSegmentation')) {
            ;(frame.lidarSegmentation as NormalizedFrameV1['lidarSegmentation'][number][]).push(
              ...loaded.segmentation.map((labels) => ({ ...labels, sensorId: sensor.id })),
            )
          }
        }
      }
      if ((requested.has('pointClouds') || requested.has('lidarSegmentation')) && rangeImagePlan) {
        const rows = await loadGraphParquetFrameRowsV1(
          rangeImagePlan.rows, rangeImagePlan.timestampField, timelineFrame.timestamp, request.signal,
        )
        const rangeImages = new Map<number, RangeImage>()
        for (const row of rows) {
          const rendererId = Number(row[rangeImagePlan.sensorField])
          const sensor = sensorForId(input.compiledRecipe, String(rendererId), 'lidar')
          if (sensor?.modality !== 'lidar' || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          rangeImages.set(rendererId, {
            shape: numericList(row[rangeImagePlan.shapeField], rangeImagePlan.shapeField, 3) as [number, number, number],
            values: numericList(row[rangeImagePlan.valuesField], rangeImagePlan.valuesField),
          })
        }
        const labelRows = rangeSegmentation?.availableTimestamps.has(timelineFrame.timestamp)
          ? await loadGraphParquetFrameRowsV1(
            rangeSegmentation.labels, rangeSegmentation.timestampField, timelineFrame.timestamp, request.signal,
          )
          : []
        const labelBySensor = new Map(labelRows.map((row) => [String(row[rangeSegmentation!.sensorField]), row]))
        for (const [rendererId, cloud] of convertAllSensors(rangeImages, new Map(rangeImagePlan.calibrations)).perSensor) {
          const sensor = sensorForId(input.compiledRecipe, String(rendererId), 'lidar')
          if (sensor?.modality !== 'lidar') continue
          const normalized: NormalizedPointCloudV1 = {
            sensorId: sensor.id, frameId: rangeImagePlan.frameId,
            values: cloud.positions, pointCount: cloud.pointCount, stride: 6,
            attributes: ['x', 'y', 'z', 'intensity', 'range', 'elongation'], sourceIndices: cloud.validIndices,
          }
          const labels = rangeSegmentation
            ? attachRangeImageLabels(normalized, labelBySensor.get(String(rendererId)), rangeSegmentation)
            : {}
          if (requested.has('pointClouds')) {
            ;(frame.pointClouds as NormalizedPointCloudV1[]).push({ ...normalized, ...labels })
          }
          if (requested.has('lidarSegmentation') && labels.semanticLabels && rangeSegmentation) {
            ;(frame.lidarSegmentation as NormalizedFrameV1['lidarSegmentation'][number][]).push({
              sensorId: sensor.id, taxonomyId: rangeSegmentation.taxonomyId,
              labels: labels.panopticLabels ?? labels.semanticLabels,
              divisor: labels.panopticLabels ? rangeSegmentation.panopticDivisor : undefined,
              encoding: 'point-index',
            })
          }
        }
      }
      if (requested.has('radarPointClouds') && radarPlan) {
        for (const binding of bindingsForFrame(radarPlan, timelineFrame)) {
          const sensor = pointSensorForBinding(binding, 'radar')
          if (!sensor || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          const loaded = await loadBinaryPointCloud(
            binding,
            radarPlan,
            null,
            request.signal,
            sensorTransformById.get(sensor.id) ?? binding.egoFromSensor,
          )
          ;(frame.radarPointClouds as NormalizedPointCloudV1[]).push({ ...loaded.cloud, sensorId: sensor.id })
        }
      }
      if (requested.has('cameraImages') && cameraPlan) {
        if (cameraPlan.bindings) {
          for (const binding of cameraPlan.bindings.filter((entry) => entry.frameKey === timelineFrame.key)) {
            if (request.sensorIds && !request.sensorIds.has(binding.sensorId)) continue
            const calibration = cameraCalibrations.get(binding.sensorId)
            const sensor = sensorForId(input.compiledRecipe, binding.sensorId, 'camera')
            if (!calibration || sensor?.modality !== 'camera' || !sensor.image) continue
            const encodedBytes = await cameraPlan.encoded.context.read(binding.path, request.signal)
            ;(frame.cameraImages as NormalizedFrameV1['cameraImages'][number][]).push({
              sensorId: binding.sensorId, timestampMicros: timestampsMicros[index], encodedBytes,
              mimeType: cameraPlan.encoded.mimeType,
              width: sensor.image.width,
              height: sensor.image.height,
              calibrationId: binding.sensorId,
            })
          }
        } else {
          for (const [sensorId, entry] of cameraPaths) {
            if (request.sensorIds && !request.sensorIds.has(sensorId)) continue
            const matched = alignNearestTimestampV1(entry.timestamps, timelineFrame.timestamp, cameraPlan.maxDelta)
            if (matched === null) continue
            const path = entry.byTimestamp.get(matched)!
            const calibration = cameraCalibrations.get(sensorId)!
            const sensor = sensorForId(input.compiledRecipe, sensorId, 'camera')
            if (sensor?.modality !== 'camera' || !sensor.image) continue
            const encodedBytes = await cameraPlan.encoded.context.read(path, request.signal)
            ;(frame.cameraImages as NormalizedFrameV1['cameraImages'][number][]).push({
              sensorId, timestampMicros: micros(matched, timeline.unit), encodedBytes,
              mimeType: cameraPlan.encoded.mimeType,
              width: sensor.image.width,
              height: sensor.image.height,
              calibrationId: calibration.sensorId,
            })
          }
        }
      }
      if (requested.has('cameraImages') && parquetCameraPlan) {
        const rows = await loadGraphParquetFrameRowsV1(
          parquetCameraPlan.rows, parquetCameraPlan.timestampField, timelineFrame.timestamp, request.signal,
        )
        for (const row of rows) {
          const sensor = sensorForId(input.compiledRecipe, String(row[parquetCameraPlan.sensorField]), 'camera')
          if (sensor?.modality !== 'camera' || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          const calibration = cameraCalibrations.get(sensor.id)
          const encodedBytes = binaryBuffer(row[parquetCameraPlan.imageField])
          if (!calibration || !encodedBytes) continue
          ;(frame.cameraImages as NormalizedFrameV1['cameraImages'][number][]).push({
            sensorId: sensor.id, timestampMicros: timestampsMicros[index], encodedBytes,
            mimeType: parquetCameraPlan.mimeType, width: calibration.width, height: calibration.height,
            calibrationId: sensor.id,
          })
        }
      }
      if (requested.has('boxes3d') || requested.has('boxes2d')) {
        ;(frame.boxes3d as NormalizedBox3dV1[]).push(...boxesForFrame(boxes, timelineFrame).map((box) => ({
          ...box, classId: classIds.has(box.classId) ? box.classId : fallbackClassId,
        })))
      }
      if (requested.has('boxes2d') && projected) {
        for (const box of frame.boxes3d) {
          for (const calibration of cameraCalibrations.values()) {
            if (request.sensorIds && !request.sensorIds.has(calibration.sensorId)) continue
            const box2d = projectBox3dPinholeV1(box, calibration)
            if (!box2d) continue
            ;(frame.boxes2d as NormalizedBox2dV1[]).push(box2d)
            box2dToBox3d.set(box2d.id, box.id)
          }
        }
      }
      if (requested.has('boxes2d') && directBoxes2d) {
        for (const box of directBoxes2d.byTimestamp.get(timelineFrame.timestamp) ?? []) {
          const sensor = sensorForId(input.compiledRecipe, box.cameraId, 'camera')
          if (sensor?.modality !== 'camera' || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          ;(frame.boxes2d as NormalizedBox2dV1[]).push({
            ...box, cameraId: sensor.id, classId: classIds.has(box.classId) ? box.classId : fallbackClassId,
          })
        }
      }
      const appendKeypoints = (plan: GraphKeypointsV1 | null, target: NormalizedKeypointSetV1[]) => {
        for (const keypoints of plan?.byTimestamp.get(timelineFrame.timestamp) ?? []) {
          const sensor = keypoints.cameraId ? sensorForId(input.compiledRecipe, keypoints.cameraId, 'camera') : null
          if (sensor && request.sensorIds && !request.sensorIds.has(sensor.id)) continue
          target.push(sensor ? { ...keypoints, cameraId: sensor.id, frameId: sensor.frameId } : keypoints)
        }
      }
      if (requested.has('keypoints3d')) appendKeypoints(keypoints3dPlan, frame.keypoints3d as NormalizedKeypointSetV1[])
      if (requested.has('keypoints2d')) appendKeypoints(keypoints2dPlan, frame.keypoints2d as NormalizedKeypointSetV1[])
      if (requested.has('cameraSegmentation') && cameraSegmentationPlan) {
        for (const segmentationEntry of cameraSegmentationPlan.byTimestamp.get(timelineFrame.timestamp) ?? []) {
          const sensor = sensorForId(input.compiledRecipe, segmentationEntry.sensorId, 'camera')
          if (sensor?.modality !== 'camera' || (request.sensorIds && !request.sensorIds.has(sensor.id))) continue
          ;(frame.cameraSegmentation as NormalizedFrameV1['cameraSegmentation'][number][]).push({
            ...segmentationEntry, sensorId: sensor.id,
            labels: segmentationEntry.labels instanceof ArrayBuffer ? segmentationEntry.labels.slice(0) : segmentationEntry.labels.slice(),
          })
        }
      }
      if (request.signal?.aborted) throw new DOMException('Scene frame load was aborted.', 'AbortError')
      return frame
    },
    dispose() {
      if (disposed) return
      disposed = true
      box2dToBox3d.clear()
      input.graph.dispose()
    },
  }

  const timestampToFrame = new Map(timestamps.map((timestamp, index) => [timestamp, index]))
  const poseByFrameIndex = new Map<number, number[]>()
  timestamps.forEach((timestamp, index) => {
    const matrix = worldFromEgoByTimestamp.get(timestamp)
    if (matrix) poseByFrameIndex.set(index, [...matrix])
  })
  const vehiclePoseByFrame = new Map<bigint, Record<string, unknown>[]>()
  frames.forEach((timelineFrame, index) => {
    const files: Record<string, unknown>[] = []
    if (tablePointPlan) {
      const sensor = input.compiledRecipe.recipe.scene.sensors.find((entry) => entry.modality === 'lidar')
      const path = tablePointPlan.tables.files.find((entry) => /(?:^|\/)(\d+)\.[^/.]+$/u.exec(entry.path)?.[1] === timelineFrame.timestamp.toString())?.path
      if (sensor && path) files.push({ modality: 'lidar', sensorId: sensor.rendererId, filename: path })
    }
    for (const [plan, modality] of [[binaryPointPlan, 'lidar'], [radarPlan, 'radar']] as const) {
      for (const binding of bindingsForFrame(plan, timelineFrame)) {
        const sensor = pointSensorForBinding(binding, modality)
        if (!sensor) continue
        const entry: Record<string, unknown> = { modality, channel: sensor.id, sensorId: sensor.rendererId, filename: binding.path }
        const semanticPath = segmentation?.semanticPathByRecordKey.get(binding.recordKey)
        const panopticPath = segmentation?.panopticPathByRecordKey.get(binding.recordKey)
        if (semanticPath) entry.lidarsegFile = semanticPath
        if (panopticPath) entry.panopticFile = panopticPath
        files.push(entry)
      }
    }
    if (cameraPlan?.bindings) {
      for (const binding of cameraPlan.bindings.filter((entry) => entry.frameKey === timelineFrame.key)) {
        const sensor = sensorForId(input.compiledRecipe, binding.sensorId, 'camera')
        if (sensor) files.push({ modality: 'camera', channel: sensor.id, sensorId: sensor.rendererId, filename: binding.path })
      }
    } else {
      for (const [sensorId, entry] of cameraPaths) {
        const matched = cameraPlan ? alignNearestTimestampV1(entry.timestamps, timelineFrame.timestamp, cameraPlan.maxDelta) : null
        const sensor = sensorForId(input.compiledRecipe, sensorId, 'camera')
        if (matched !== null && sensor) files.push({ modality: 'camera', channel: sensor.id, sensorId: sensor.rendererId, filename: entry.byTimestamp.get(matched)! })
      }
    }
    vehiclePoseByFrame.set(timestamps[index], files)
  })

  const lidarCalibrations = new Map<number, LidarCalibration>()
  const addLidarCalibrations = (
    bindings: readonly GraphBinaryPointCloudBindingV1[],
    modality: 'lidar' | 'radar',
  ) => {
    for (const binding of bindings) {
      const sensor = pointSensorForBinding(binding, modality)
      if (!sensor || lidarCalibrations.has(sensor.rendererId)) continue
      const egoFromSensor = sensorTransformById.get(sensor.id) ?? binding.egoFromSensor
      lidarCalibrations.set(sensor.rendererId, {
        laserName: sensor.rendererId,
        extrinsic: egoFromSensor ? [...egoFromSensor] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        beamInclinationValues: null, beamInclinationMin: 0, beamInclinationMax: 0,
      })
    }
  }
  addLidarCalibrations(selectedPointBindings, 'lidar')
  addLidarCalibrations(selectedRadarBindings, 'radar')
  if (tablePointPlan) {
    const sensor = input.compiledRecipe.recipe.scene.sensors.find((entry) => entry.modality === 'lidar')
    if (sensor) lidarCalibrations.set(sensor.rendererId, {
      laserName: sensor.rendererId, extrinsic: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      beamInclinationValues: null, beamInclinationMin: 0, beamInclinationMax: 0,
    })
  }
  for (const [rendererId, calibration] of rangeImagePlan?.calibrations ?? []) {
    lidarCalibrations.set(rendererId, {
      ...calibration,
      extrinsic: [...calibration.extrinsic],
      beamInclinationValues: calibration.beamInclinationValues ? [...calibration.beamInclinationValues] : null,
    })
  }
  const rendererCameraCalibrations = [...cameraCalibrations.values()].map((calibration) => {
    const rendererId = sensorForId(input.compiledRecipe, calibration.sensorId, 'camera')?.rendererId ?? 0
    return {
      'key.camera_name': rendererId,
      '[CameraCalibrationComponent].extrinsic.transform': [...calibration.egoFromCamera],
      '[CameraCalibrationComponent].width': calibration.width,
      '[CameraCalibrationComponent].height': calibration.height,
      '[CameraCalibrationComponent].intrinsic.f_u': calibration.intrinsics[0],
      '[CameraCalibrationComponent].intrinsic.f_v': calibration.intrinsics[1],
      '[CameraCalibrationComponent].intrinsic.c_u': calibration.intrinsics[2],
      '[CameraCalibrationComponent].intrinsic.c_v': calibration.intrinsics[3],
      '__isOpticalFrame': true,
    }
  })
  const lidarBoxByFrame = new Map<bigint, Record<string, unknown>[]>()
  const cameraBoxByFrame = new Map<bigint, Record<string, unknown>[]>()
  const objectTrajectories = new Map<string, TrajectoryPoint[]>()
  const objectCounts: Record<number, number> = {}
  const perTypeCounts = new Map<number, number[]>()
  frames.forEach((timelineFrame, index) => {
    const frameBoxes = boxesForFrame(boxes, timelineFrame)
    if (frameBoxes.length === 0) return
    const frameCounts = new Map<number, number>()
    lidarBoxByFrame.set(timestamps[index], frameBoxes.map((box) => ({
      'key.laser_object_id': box.id,
      '[LiDARBoxComponent].box.center.x': box.center[0], '[LiDARBoxComponent].box.center.y': box.center[1], '[LiDARBoxComponent].box.center.z': box.center[2],
      '[LiDARBoxComponent].box.size.x': box.dimensions[0], '[LiDARBoxComponent].box.size.y': box.dimensions[1], '[LiDARBoxComponent].box.size.z': box.dimensions[2],
      '[LiDARBoxComponent].box.heading': box.heading ?? 0, '[LiDARBoxComponent].type': classRendererIds.get(box.classId) ?? 0,
    })))
    for (const box of frameBoxes) {
      const type = classRendererIds.get(box.classId) ?? 0
      frameCounts.set(type, (frameCounts.get(type) ?? 0) + 1)
    }
    for (const [type, count] of frameCounts) {
      const counts = perTypeCounts.get(type) ?? []
      counts.push(count)
      perTypeCounts.set(type, counts)
    }
  })
  frames.forEach((timelineFrame, index) => {
    const frameBoxes = directBoxes2d?.byTimestamp.get(timelineFrame.timestamp) ?? []
    if (frameBoxes.length === 0) return
    cameraBoxByFrame.set(timestamps[index], frameBoxes.flatMap((box) => {
      const sensor = sensorForId(input.compiledRecipe, box.cameraId, 'camera')
      if (!sensor) return []
      return [{
        'key.camera_name': sensor.rendererId, 'key.camera_object_id': box.objectId,
        '[CameraBoxComponent].type': classRendererIds.get(box.classId) ?? 0,
        '[CameraBoxComponent].box.center.x': box.center[0], '[CameraBoxComponent].box.center.y': box.center[1],
        '[CameraBoxComponent].box.size.x': box.dimensions[0], '[CameraBoxComponent].box.size.y': box.dimensions[1],
      }]
    }))
  })
  for (const [type, counts] of perTypeCounts) objectCounts[type] = Math.round(counts.reduce((sum, count) => sum + count, 0) / counts.length)
  Object.assign(objectCounts, selected.segment.objectCounts ?? {})
  for (const [objectId, points] of trajectories) objectTrajectories.set(objectId, points.map((point) => ({
    frameIndex: point.frameIndex, x: point.position[0], y: point.position[1], z: point.position[2], type: classRendererIds.get(point.classId) ?? 0,
  })))
  const segmentMetadata = selected.segment.metadata ?? {}
  const assocCamToLaser = new Map(box2dToBox3d)
  const assocLaserToCams = new Map<string, Set<string>>()
  for (const [cameraId, lidarId] of assocCamToLaser) {
    const entries = assocLaserToCams.get(lidarId) ?? new Set<string>()
    entries.add(cameraId)
    assocLaserToCams.set(lidarId, entries)
  }
  const keypointsByFrame = keypoints3dPlan
    ? new Map([...keypoints3dPlan.sourceRowsByTimestamp].map(([timestamp, rows]) => [timestamp, [...rows]]))
    : undefined
  const cameraKeypointsByFrame = keypoints2dPlan
    ? new Map([...keypoints2dPlan.sourceRowsByTimestamp].map(([timestamp, rows]) => [timestamp, [...rows]]))
    : undefined
  const cameraSeg = cameraSegmentationPlan ? new Map([...cameraSegmentationPlan.byTimestamp].map(([timestamp, entries]) => [
    timestamp,
    new Map(entries.flatMap((entry) => {
      const sensor = sensorForId(input.compiledRecipe, entry.sensorId, 'camera')
      const labels = entry.labels instanceof ArrayBuffer ? entry.labels : entry.labels.buffer.slice(
        entry.labels.byteOffset,
        entry.labels.byteOffset + entry.labels.byteLength,
      ) as ArrayBuffer
      return sensor && labels instanceof ArrayBuffer
        ? [[sensor.rendererId, { panopticLabel: labels, divisor: entry.divisor ?? 1000 }] as const]
        : []
    })),
  ] as const)) : undefined
  const frameSet = (timestampsSet: ReadonlySet<bigint>) => new Set(
    [...timestampsSet].flatMap((timestamp) => {
      const frameIndex = timestampToFrame.get(timestamp)
      return frameIndex === undefined ? [] : [frameIndex]
    }),
  )
  const metadata: MetadataBundle = {
    timestamps: [...timestamps], timestampToFrame, vehiclePoseByFrame,
    worldOriginInverse: worldOriginInverse ? [...worldOriginInverse] : null, poseByFrameIndex,
    lidarCalibrations, cameraCalibrations: rendererCameraCalibrations, lidarBoxByFrame, cameraBoxByFrame, objectTrajectories,
    assocCamToLaser, assocLaserToCams, hasBoxData: lidarBoxByFrame.size > 0,
    hasSegmentation: capabilities.has('lidarSegmentation'),
    hasKeypoints: capabilities.has('keypoints3d') || capabilities.has('keypoints2d'),
    hasCameraSegmentation: capabilities.has('cameraSegmentation'),
    segLabelFrames: rangeSegmentation ? frameSet(rangeSegmentation.availableTimestamps) : undefined,
    keypointFrames: keypoints3dPlan ? frameSet(new Set(keypoints3dPlan.byTimestamp.keys())) : undefined,
    cameraKeypointFrames: keypoints2dPlan ? frameSet(new Set(keypoints2dPlan.byTimestamp.keys())) : undefined,
    cameraSegFrames: cameraSegmentationPlan ? frameSet(new Set(cameraSegmentationPlan.byTimestamp.keys())) : undefined,
    keypointsByFrame, cameraKeypointsByFrame, cameraSeg,
    segmentMeta: {
      segmentId: selected.segment.id,
      timeOfDay: String(segmentMetadata.timeOfDay ?? ''), location: String(segmentMetadata.location ?? ''),
      weather: String(segmentMetadata.weather ?? ''), objectCounts,
    },
  }
  return { scene, diagnostics, metadata, availableSegments: segmentIndex?.segments ?? [selected.segment] }
}
