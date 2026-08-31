import type { MetadataBundle, TrajectoryPoint } from '../../types/dataset'
import type { LidarCalibration } from '../../utils/rangeImage'
import { alignNearestTimestampV1 } from '../operators/temporal'
import { interleaveFeatherNumericColumnsV1, loadGraphTableV1 } from '../operators/coreGraphOperators'
import { projectBox3dPinholeV1 } from '../operators/sceneGeometry'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { CompiledRecipeV1 } from '../recipe/compiler'
import type {
  GraphBoxesV1,
  GraphCameraPlanV1,
  GraphPointCloudPlanV1,
  GraphPoseTimelineV1,
  GraphProjectedBoxesV1,
  GraphTimelineV1,
  GraphTrajectoriesV1,
} from './GraphValues'
import type { GraphExecutionResultV1 } from './GraphKernel'
import type {
  NormalizedBox2dV1,
  NormalizedCapabilityV1,
  NormalizedFrameV1,
  NormalizedRelationsV1,
  NormalizedSceneV1,
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

export function assembleGraphSceneV1(input: {
  readonly compiledRecipe: CompiledRecipeV1
  readonly graph: GraphExecutionResultV1
  readonly sceneId?: string
}): { readonly scene: NormalizedSceneV1; readonly diagnostics: readonly AdapterDiagnostic[]; readonly metadata: MetadataBundle } {
  const timeline = kind<GraphTimelineV1>(input.graph.outputs.get('timeline'), 'timeline')
  if (!timeline) throw new Error('GRAPH_TIMELINE_OUTPUT_INVALID')
  const poses = kind<GraphPoseTimelineV1>(input.graph.outputs.get('egoPoses'), 'pose-timeline')
  const pointPlan = kind<GraphPointCloudPlanV1>(input.graph.outputs.get('pointClouds'), 'point-cloud-plan')
  const cameraPlan = kind<GraphCameraPlanV1>(input.graph.outputs.get('cameraImages'), 'camera-plan')
  const boxes = kind<GraphBoxesV1>(input.graph.outputs.get('boxes3d'), 'boxes3d')
  const projected = kind<GraphProjectedBoxesV1>(input.graph.outputs.get('boxes2d'), 'projected-boxes2d')
  const trajectories = kind<GraphTrajectoriesV1>(input.graph.outputs.get('trajectories'), 'trajectories')
  const timestamps = timeline.frames.map((frame) => frame.timestamp)
  const timestampsMicros = timestamps.map((timestamp) => micros(timestamp, timeline.unit))
  const taxonomy = input.compiledRecipe.recipe.scene.taxonomies.find((entry) => entry.role === 'objects')
  const classIds = new Set(taxonomy?.classes.map((entry) => entry.id) ?? [])
  const classRendererIds = new Map(taxonomy?.classes.map((entry) => [entry.id, entry.rendererId]) ?? [])
  const capabilities = new Set<NormalizedCapabilityV1>()
  const diagnostics: AdapterDiagnostic[] = []
  const evidence: Partial<Record<NormalizedCapabilityV1, boolean>> = {
    timeline: timestamps.length > 0,
    egoPoses: Boolean(poses && poses.worldFromEgoByTimestamp.size > 0),
    pointClouds: Boolean(pointPlan && pointPlan.tables.files.length > 0),
    cameraImages: Boolean(cameraPlan && cameraPlan.encoded.files.length > 0 && cameraPlan.calibrations.size > 0),
    boxes3d: Boolean(boxes && boxes.byTimestamp.size > 0),
    boxes2d: Boolean(projected && boxes?.byTimestamp.size && cameraPlan?.calibrations.size),
    trajectories: Boolean(trajectories && trajectories.tracks.size > 0),
    segmentMetadata: input.graph.outputs.has('segmentMetadata'),
  }
  for (const capability of input.compiledRecipe.capabilities) {
    if (evidence[capability]) capabilities.add(capability)
    else diagnostics.push(capabilityDiagnostic(capability))
  }
  const pointSensor = input.compiledRecipe.recipe.scene.sensors.find((sensor) => sensor.modality === 'lidar')
  const staticTransforms: NormalizedTransformV1[] = []
  if (pointSensor) staticTransforms.push({
    parentFrameId: 'ego', childFrameId: pointSensor.frameId,
    parentFromChild: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  })
  for (const calibration of cameraPlan?.calibrations.values() ?? []) {
    staticTransforms.push({ parentFrameId: 'ego', childFrameId: calibration.frameId, parentFromChild: calibration.egoFromCamera })
  }
  const box2dToBox3d = new Map<string, string>()
  const relations: NormalizedRelationsV1 = {
    staticTransforms,
    cameraCalibrations: cameraPlan?.calibrations ?? new Map(),
    trajectories: trajectories?.tracks ?? new Map(),
    box2dToBox3d,
  }
  const cameraPaths = new Map<string, { timestamps: bigint[]; byTimestamp: Map<bigint, string> }>()
  for (const file of cameraPlan?.encoded.files ?? []) {
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
  let disposed = false
  const scene: NormalizedSceneV1 = {
    manifest: { ...input.compiledRecipe.normalizedManifest, capabilities },
    index: {
      timestampsMicros,
      segments: [{ id: input.sceneId ?? input.compiledRecipe.normalizedManifest.id, label: input.sceneId, firstFrame: 0, frameCount: timestamps.length }],
    },
    relations,
    async loadFrame(index, request) {
      if (disposed) throw new Error('Normalized scene has been disposed.')
      if (!Number.isSafeInteger(index) || index < 0 || index >= timestamps.length) throw new RangeError(`Frame index ${index} is out of range.`)
      if (request.signal?.aborted) throw new DOMException('Scene frame load was aborted.', 'AbortError')
      const timestamp = timestamps[index]
      const frame = emptyFrame(index, timestampsMicros[index], poses?.worldFromEgoByTimestamp.get(timestamp) ?? null)
      const requested = new Set([...request.capabilities].filter((capability) => capabilities.has(capability)))
      if (requested.has('pointClouds') && pointPlan && pointSensor && (!request.sensorIds || request.sensorIds.has(pointSensor.id))) {
        const file = pointPlan.tables.files.find((entry) => /(?:^|\/)(\d+)\.[^/.]+$/u.exec(entry.path)?.[1] === timestamp.toString())
        if (file) {
          const decoded = await loadGraphTableV1(pointPlan.tables, file.path, request.signal)
          const cloud = interleaveFeatherNumericColumnsV1(decoded, pointPlan.fields, request.signal)
          ;(frame.pointClouds as Array<unknown>).push({ sensorId: pointSensor.id, frameId: pointPlan.frameId, ...cloud })
        }
      }
      if (requested.has('cameraImages') && cameraPlan) {
        for (const [sensorId, entry] of cameraPaths) {
          if (request.sensorIds && !request.sensorIds.has(sensorId)) continue
          const matched = alignNearestTimestampV1(entry.timestamps, timestamp, cameraPlan.maxDelta)
          if (matched === null) continue
          const path = entry.byTimestamp.get(matched)!
          const calibration = cameraPlan.calibrations.get(sensorId)!
          const encodedBytes = await cameraPlan.encoded.context.read(path)
          ;(frame.cameraImages as Array<unknown>).push({
            sensorId, timestampMicros: micros(matched, timeline.unit), encodedBytes,
            mimeType: cameraPlan.encoded.mimeType, width: calibration.width, height: calibration.height, calibrationId: sensorId,
          })
        }
      }
      if ((requested.has('boxes3d') || requested.has('boxes2d')) && boxes) {
        ;(frame.boxes3d as Array<unknown>).push(...(boxes.byTimestamp.get(timestamp) ?? []).map((box) => ({
          ...box, classId: classIds.has(box.classId) ? box.classId : 'UNKNOWN',
        })))
      }
      if (requested.has('boxes2d') && projected) {
        for (const box of frame.boxes3d) {
          for (const calibration of projected.cameras.calibrations.values()) {
            if (request.sensorIds && !request.sensorIds.has(calibration.sensorId)) continue
            const box2d = projectBox3dPinholeV1(box, calibration)
            if (!box2d) continue
            ;(frame.boxes2d as NormalizedBox2dV1[]).push(box2d)
            box2dToBox3d.set(box2d.id, box.id)
          }
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
    const matrix = poses?.worldFromEgoByTimestamp.get(timestamp)
    if (matrix) poseByFrameIndex.set(index, [...matrix])
  })
  const vehiclePoseByFrame = new Map<bigint, Record<string, unknown>[]>()
  timestamps.forEach((timestamp) => {
    const files: Record<string, unknown>[] = []
    const lidarPath = timeline.frames.find((frame) => frame.timestamp === timestamp)?.path
    if (pointSensor && lidarPath) files.push({ modality: 'lidar', sensorId: pointSensor.rendererId, filename: lidarPath })
    for (const [sensorId, entry] of cameraPaths) {
      const matched = cameraPlan ? alignNearestTimestampV1(entry.timestamps, timestamp, cameraPlan.maxDelta) : null
      const sensor = input.compiledRecipe.recipe.scene.sensors.find((candidate) => candidate.id === sensorId)
      if (matched !== null && sensor) files.push({ modality: 'camera', sensorId: sensor.rendererId, filename: entry.byTimestamp.get(matched)! })
    }
    vehiclePoseByFrame.set(timestamp, files)
  })
  const lidarCalibrations = new Map<number, LidarCalibration>()
  if (pointSensor) lidarCalibrations.set(pointSensor.rendererId, {
    laserName: pointSensor.rendererId,
    extrinsic: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    beamInclinationValues: null, beamInclinationMin: 0, beamInclinationMax: 0,
  })
  const cameraCalibrations = [...(cameraPlan?.calibrations.values() ?? [])].map((calibration) => {
    const rendererId = input.compiledRecipe.recipe.scene.sensors.find((sensor) => sensor.id === calibration.sensorId)?.rendererId ?? 0
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
  const objectTrajectories = new Map<string, TrajectoryPoint[]>()
  const objectCounts: Record<number, number> = {}
  const perTypeCounts = new Map<number, number[]>()
  for (const [timestamp, frameBoxes] of boxes?.byTimestamp ?? []) {
    const frameCounts = new Map<number, number>()
    lidarBoxByFrame.set(timestamp, frameBoxes.map((box) => ({
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
  }
  for (const [type, counts] of perTypeCounts) objectCounts[type] = Math.round(counts.reduce((sum, count) => sum + count, 0) / counts.length)
  for (const [objectId, points] of trajectories?.tracks ?? []) objectTrajectories.set(objectId, points.map((point) => ({
    frameIndex: point.frameIndex, x: point.position[0], y: point.position[1], z: point.position[2], type: classRendererIds.get(point.classId) ?? 0,
  })))
  const metadata: MetadataBundle = {
    timestamps: [...timestamps], timestampToFrame, vehiclePoseByFrame,
    worldOriginInverse: poses?.worldOriginInverse ? [...poses.worldOriginInverse] : null,
    poseByFrameIndex,
    lidarCalibrations, cameraCalibrations, lidarBoxByFrame, cameraBoxByFrame: new Map(), objectTrajectories,
    assocCamToLaser: new Map(), assocLaserToCams: new Map(), hasBoxData: lidarBoxByFrame.size > 0,
    segmentMeta: { segmentId: input.sceneId ?? input.compiledRecipe.normalizedManifest.id, timeOfDay: '', location: '', weather: '', objectCounts },
  }
  return { scene, diagnostics, metadata }
}
