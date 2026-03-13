/**
 * nuScenes metadata loader — reads JSON metadata files and builds a
 * dataset-agnostic MetadataBundle for the store.
 *
 * Strategy:
 * 1. Parse all JSON tables once (small enough to fit in memory)
 * 2. Build token-based lookup Maps
 * 3. On scene selection: walk the linked list from scene.first_sample_token,
 *    resolve sensor data, ego poses, annotations, and calibrations.
 *
 * The output MetadataBundle matches the same shape as Waymo's, so the store
 * unpacks it identically without knowing which adapter produced it.
 */

import type { MetadataBundle, TrajectoryPoint } from '../../types/dataset'
import type {
  NuScenesScene,
  NuScenesSample,
  NuScenesSampleData,
  NuScenesEgoPose,
  NuScenesSampleAnnotation,
  NuScenesInstance,
  NuScenesCategory,
  NuScenesCalibratedSensor,
  NuScenesSensor,
} from '../../types/nuscenes'
import { NUSCENES_CATEGORY_MAP } from '../../types/nuscenes'
import { NUSCENES_CHANNEL_TO_ID, nuScenesManifest } from './manifest'
import { quaternionToMatrix4x4 } from '../../utils/quaternion'
import { multiplyRowMajor4x4, invertRowMajor4x4 } from '../../utils/matrix'

// ---------------------------------------------------------------------------
// Parsed database — built once, reused across scene switches
// ---------------------------------------------------------------------------

export interface NuScenesDatabase {
  scenes: NuScenesScene[]
  sampleByToken: Map<string, NuScenesSample>
  sampleDataByToken: Map<string, NuScenesSampleData>
  egoPoseByToken: Map<string, NuScenesEgoPose>
  annotationByToken: Map<string, NuScenesSampleAnnotation>
  calibratedSensorByToken: Map<string, NuScenesCalibratedSensor>
  sensorByToken: Map<string, NuScenesSensor>
  instanceByToken: Map<string, NuScenesInstance>
  categoryByToken: Map<string, NuScenesCategory>

  /** sample_token → annotations for that sample */
  annotationsBySample: Map<string, NuScenesSampleAnnotation[]>
  /** sample_token → sample_data entries (keyframe only) for that sample */
  sampleDataBySample: Map<string, NuScenesSampleData[]>
  /** instance_token → category name */
  instanceCategoryName: Map<string, string>
}

// ---------------------------------------------------------------------------
// JSON reading helpers
// ---------------------------------------------------------------------------

/**
 * Read a JSON file from a FileSystemDirectoryHandle or fetch from URL.
 * `root` is a Map of filename → File (from drag-and-drop) or a base URL string.
 */
export async function readJsonFile<T>(
  jsonFiles: Map<string, File>,
  filename: string,
): Promise<T[]> {
  const file = jsonFiles.get(filename)
  if (!file) {
    console.warn(`[nuScenes] JSON file not found: ${filename}`)
    return []
  }
  const text = await file.text()
  return JSON.parse(text) as T[]
}

// ---------------------------------------------------------------------------
// Database construction
// ---------------------------------------------------------------------------

/**
 * Parse all nuScenes JSON tables into an indexed database.
 * Called once when the dataset root is first opened.
 */
export async function buildNuScenesDatabase(
  jsonFiles: Map<string, File>,
): Promise<NuScenesDatabase> {
  // Parse all JSON tables in parallel
  const [
    scenes,
    samples,
    sampleDatas,
    egoPoses,
    annotations,
    calibratedSensors,
    sensors,
    instances,
    categories,
  ] = await Promise.all([
    readJsonFile<NuScenesScene>(jsonFiles, 'scene.json'),
    readJsonFile<NuScenesSample>(jsonFiles, 'sample.json'),
    readJsonFile<NuScenesSampleData>(jsonFiles, 'sample_data.json'),
    readJsonFile<NuScenesEgoPose>(jsonFiles, 'ego_pose.json'),
    readJsonFile<NuScenesSampleAnnotation>(jsonFiles, 'sample_annotation.json'),
    readJsonFile<NuScenesCalibratedSensor>(jsonFiles, 'calibrated_sensor.json'),
    readJsonFile<NuScenesSensor>(jsonFiles, 'sensor.json'),
    readJsonFile<NuScenesInstance>(jsonFiles, 'instance.json'),
    readJsonFile<NuScenesCategory>(jsonFiles, 'category.json'),
  ])

  // Build token → entry maps
  const sampleByToken = new Map(samples.map((s) => [s.token, s]))
  const sampleDataByToken = new Map(sampleDatas.map((sd) => [sd.token, sd]))
  const egoPoseByToken = new Map(egoPoses.map((ep) => [ep.token, ep]))
  const annotationByToken = new Map(annotations.map((a) => [a.token, a]))
  const calibratedSensorByToken = new Map(calibratedSensors.map((cs) => [cs.token, cs]))
  const sensorByToken = new Map(sensors.map((s) => [s.token, s]))
  const instanceByToken = new Map(instances.map((i) => [i.token, i]))
  const categoryByToken = new Map(categories.map((c) => [c.token, c]))

  // Build sample_token → annotations index
  const annotationsBySample = new Map<string, NuScenesSampleAnnotation[]>()
  for (const ann of annotations) {
    let list = annotationsBySample.get(ann.sample_token)
    if (!list) {
      list = []
      annotationsBySample.set(ann.sample_token, list)
    }
    list.push(ann)
  }

  // Build sample_token → keyframe sample_data index
  const sampleDataBySample = new Map<string, NuScenesSampleData[]>()
  for (const sd of sampleDatas) {
    if (!sd.is_key_frame) continue
    let list = sampleDataBySample.get(sd.sample_token)
    if (!list) {
      list = []
      sampleDataBySample.set(sd.sample_token, list)
    }
    list.push(sd)
  }

  // Build instance_token → category name lookup
  const instanceCategoryName = new Map<string, string>()
  for (const inst of instances) {
    const cat = categoryByToken.get(inst.category_token)
    if (cat) {
      instanceCategoryName.set(inst.token, cat.name)
    }
  }

  return {
    scenes,
    sampleByToken,
    sampleDataByToken,
    egoPoseByToken,
    annotationByToken,
    calibratedSensorByToken,
    sensorByToken,
    instanceByToken,
    categoryByToken,
    annotationsBySample,
    sampleDataBySample,
    instanceCategoryName,
  }
}

// ---------------------------------------------------------------------------
// Scene metadata loader → MetadataBundle
// ---------------------------------------------------------------------------

/**
 * Load metadata for a specific nuScenes scene.
 * Walks the sample linked list and resolves all sensor data, poses, and annotations.
 */
export function loadNuScenesSceneMetadata(
  db: NuScenesDatabase,
  sceneToken: string,
): MetadataBundle {
  const scene = db.scenes.find((s) => s.token === sceneToken)
  if (!scene) throw new Error(`Scene not found: ${sceneToken}`)

  // 1. Walk sample linked list to get ordered keyframe samples
  const orderedSamples: NuScenesSample[] = []
  let currentToken = scene.first_sample_token
  while (currentToken) {
    const sample = db.sampleByToken.get(currentToken)
    if (!sample) break
    orderedSamples.push(sample)
    currentToken = sample.next
  }

  // 2. Build timestamp list (microseconds → bigint for compatibility with Waymo)
  const timestamps: bigint[] = orderedSamples.map((s) => BigInt(s.timestamp))
  const timestampToFrame = new Map<bigint, number>()
  for (let i = 0; i < timestamps.length; i++) {
    timestampToFrame.set(timestamps[i], i)
  }

  // 3. Build ego poses
  //    For each sample, find the LIDAR_TOP sample_data (keyframe) to get the ego_pose_token.
  //    nuScenes ego_pose is in global frame; we compute relative poses like Waymo.
  const poseByFrameIndex = new Map<number, number[]>()
  let worldOriginInverse: number[] | null = null

  for (let fi = 0; fi < orderedSamples.length; fi++) {
    const sample = orderedSamples[fi]
    const sampleDatas = db.sampleDataBySample.get(sample.token) ?? []

    // Find LIDAR_TOP keyframe sample_data for this sample (ego_pose reference)
    const lidarSd = sampleDatas.find((sd) => {
      const cs = db.calibratedSensorByToken.get(sd.calibrated_sensor_token)
      if (!cs) return false
      const sensor = db.sensorByToken.get(cs.sensor_token)
      return sensor?.channel === 'LIDAR_TOP'
    })

    if (!lidarSd) continue

    const egoPose = db.egoPoseByToken.get(lidarSd.ego_pose_token)
    if (!egoPose) continue

    const poseMatrix = quaternionToMatrix4x4(egoPose.rotation, egoPose.translation)

    if (fi === 0) {
      worldOriginInverse = invertRowMajor4x4(poseMatrix)
    }

    if (worldOriginInverse) {
      poseByFrameIndex.set(fi, multiplyRowMajor4x4(worldOriginInverse, poseMatrix))
    } else {
      poseByFrameIndex.set(fi, poseMatrix)
    }
  }

  // 4. Build lidar + radar calibrations
  //    Both LiDAR and radar sensors need extrinsics for sensor→ego transform.
  const lidarCalibrations = new Map<number, { laserName: number; extrinsic: number[] }>()
  for (const cs of db.calibratedSensorByToken.values()) {
    const sensor = db.sensorByToken.get(cs.sensor_token)
    if (!sensor || (sensor.modality !== 'lidar' && sensor.modality !== 'radar')) continue
    const sensorId = NUSCENES_CHANNEL_TO_ID[sensor.channel]
    if (sensorId === undefined) continue
    lidarCalibrations.set(sensorId, {
      laserName: sensorId,
      extrinsic: quaternionToMatrix4x4(cs.rotation, cs.translation),
    })
  }

  // 5. Build camera calibrations (keyed to match parseCameraCalibrations expectations)
  const CAM_PREFIX = '[CameraCalibrationComponent]'
  const cameraCalibrations: Record<string, unknown>[] = []
  for (const cs of db.calibratedSensorByToken.values()) {
    const sensor = db.sensorByToken.get(cs.sensor_token)
    if (!sensor || sensor.modality !== 'camera') continue
    const sensorId = NUSCENES_CHANNEL_TO_ID[sensor.channel]
    if (sensorId === undefined) continue
    // Find matching manifest entry for width/height
    const camDef = nuScenesManifest.cameraSensors.find(c => c.id === sensorId)
    const intrinsic = cs.camera_intrinsic // 3×3 row-major
    const f_u = intrinsic?.[0]?.[0] ?? 0
    const f_v = intrinsic?.[1]?.[1] ?? 0
    cameraCalibrations.push({
      'key.camera_name': sensorId,
      [`${CAM_PREFIX}.extrinsic.transform`]: quaternionToMatrix4x4(cs.rotation, cs.translation),
      [`${CAM_PREFIX}.width`]: camDef?.width ?? 1600,
      [`${CAM_PREFIX}.height`]: camDef?.height ?? 900,
      [`${CAM_PREFIX}.intrinsic.f_u`]: f_u,
      [`${CAM_PREFIX}.intrinsic.f_v`]: f_v,
      '__isOpticalFrame': true, // nuScenes sensor frame is already optical convention
    })
  }

  // 6. Build 3D boxes + trajectories from annotations
  //    Annotations are in global frame → transform to vehicle frame.
  const objectTrajectories = new Map<string, TrajectoryPoint[]>()
  const lidarBoxByFrame = new Map<bigint, Record<string, unknown>[]>()

  for (let fi = 0; fi < orderedSamples.length; fi++) {
    const sample = orderedSamples[fi]
    const ts = timestamps[fi]
    const anns = db.annotationsBySample.get(sample.token) ?? []
    const egoPoseMatrix = poseByFrameIndex.get(fi)
    // For box transform we need inv(ego_pose_global) to go from global → vehicle
    // But poseByFrameIndex already has inv(pose0) × poseN, so we need the raw ego pose
    // Let's get the raw ego pose for this frame
    const sampleDatas = db.sampleDataBySample.get(sample.token) ?? []
    const lidarSd = sampleDatas.find((sd) => {
      const cs = db.calibratedSensorByToken.get(sd.calibrated_sensor_token)
      if (!cs) return false
      const sensor = db.sensorByToken.get(cs.sensor_token)
      return sensor?.channel === 'LIDAR_TOP'
    })
    const egoPose = lidarSd ? db.egoPoseByToken.get(lidarSd.ego_pose_token) : null
    const rawEgoPoseMatrix = egoPose
      ? quaternionToMatrix4x4(egoPose.rotation, egoPose.translation)
      : null
    const invEgoPose = rawEgoPoseMatrix ? invertRowMajor4x4(rawEgoPoseMatrix) : null

    const boxRows: Record<string, unknown>[] = []

    for (const ann of anns) {
      const categoryName = db.instanceCategoryName.get(ann.instance_token) ?? ''
      const boxType = NUSCENES_CATEGORY_MAP[categoryName] ?? 0

      // Box center and rotation in global frame
      const boxGlobalMatrix = quaternionToMatrix4x4(ann.rotation, ann.translation)

      // Transform to vehicle (ego) frame: inv(ego_pose) × box_global
      let cx: number, cy: number, cz: number, heading: number
      if (invEgoPose) {
        const boxVehicle = multiplyRowMajor4x4(invEgoPose, boxGlobalMatrix)
        cx = boxVehicle[3]
        cy = boxVehicle[7]
        cz = boxVehicle[11]
        // Row-major 4×4: r10=matrix[4], r00=matrix[0] → atan2(sin θ, cos θ)
        heading = Math.atan2(boxVehicle[4], boxVehicle[0])
      } else {
        cx = ann.translation[0]
        cy = ann.translation[1]
        cz = ann.translation[2]
        heading = 2 * Math.atan2(ann.rotation[3], ann.rotation[0])
      }

      // nuScenes size is [width, length, height]
      const [width, length, height] = ann.size

      // Object ID for tracking — use instance_token for cross-frame tracking
      const objectId = ann.instance_token

      // Build box row compatible with store's box parsing
      boxRows.push({
        'key.laser_object_id': objectId,
        '[LiDARBoxComponent].box.center.x': cx,
        '[LiDARBoxComponent].box.center.y': cy,
        '[LiDARBoxComponent].box.center.z': cz,
        '[LiDARBoxComponent].box.size.x': length,   // Waymo: length
        '[LiDARBoxComponent].box.size.y': width,     // Waymo: width
        '[LiDARBoxComponent].box.size.z': height,    // Waymo: height
        '[LiDARBoxComponent].box.heading': heading,
        '[LiDARBoxComponent].type': boxType,
      })

      // Trajectory — use vehicle-frame position for consistency
      let trail = objectTrajectories.get(objectId)
      if (!trail) {
        trail = []
        objectTrajectories.set(objectId, trail)
      }
      trail.push({ frameIndex: fi, x: cx, y: cy, z: cz, type: boxType })
    }

    if (boxRows.length > 0) {
      lidarBoxByFrame.set(ts, boxRows)
    }
  }

  // Sort trajectories by frame index
  for (const trail of objectTrajectories.values()) {
    trail.sort((a, b) => a.frameIndex - b.frameIndex)
  }

  // 7. Build sensor file paths per frame (for workers to fetch)
  //    Store sample_data grouped by sample for later use by workers.
  //    This is stored as vehiclePoseByFrame (repurposed) keyed by timestamp.
  const vehiclePoseByFrame = new Map<bigint, Record<string, unknown>[]>()
  for (let fi = 0; fi < orderedSamples.length; fi++) {
    const sample = orderedSamples[fi]
    const ts = timestamps[fi]
    const sampleDatas = db.sampleDataBySample.get(sample.token) ?? []

    const sensorFiles: Record<string, unknown>[] = []
    for (const sd of sampleDatas) {
      const cs = db.calibratedSensorByToken.get(sd.calibrated_sensor_token)
      if (!cs) continue
      const sensor = db.sensorByToken.get(cs.sensor_token)
      if (!sensor) continue
      const sensorId = NUSCENES_CHANNEL_TO_ID[sensor.channel]
      if (sensorId === undefined) continue

      sensorFiles.push({
        channel: sensor.channel,
        sensorId,
        modality: sensor.modality,
        filename: sd.filename,
        ego_pose_token: sd.ego_pose_token,
      })
    }
    vehiclePoseByFrame.set(ts, sensorFiles)
  }

  // 8. Build scene metadata
  const sceneMeta = {
    segmentId: scene.name,
    timeOfDay: 'Unknown',
    location: 'Unknown',
    weather: 'Unknown',
    objectCounts: {} as Record<number, number>,
  }

  // Count average objects per frame by type
  const typeCounts: Record<number, number[]> = {}
  for (const [, rows] of lidarBoxByFrame) {
    const frameCounts: Record<number, number> = {}
    for (const row of rows) {
      const t = row['[LiDARBoxComponent].type'] as number
      frameCounts[t] = (frameCounts[t] ?? 0) + 1
    }
    for (const [t, c] of Object.entries(frameCounts)) {
      if (!typeCounts[Number(t)]) typeCounts[Number(t)] = []
      typeCounts[Number(t)].push(c)
    }
  }
  for (const [t, arr] of Object.entries(typeCounts)) {
    sceneMeta.objectCounts[Number(t)] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
  }

  return {
    timestamps,
    timestampToFrame,
    vehiclePoseByFrame: vehiclePoseByFrame as Map<unknown, Record<string, unknown>[]>,
    worldOriginInverse,
    poseByFrameIndex,
    lidarCalibrations: lidarCalibrations as Map<number, { laserName: number; extrinsic: number[] }>,
    cameraCalibrations,
    lidarBoxByFrame: lidarBoxByFrame as Map<unknown, Record<string, unknown>[]>,
    cameraBoxByFrame: new Map(),  // nuScenes doesn't have separate 2D camera boxes
    objectTrajectories,
    assocCamToLaser: new Map(),   // nuScenes doesn't have explicit cam↔lidar box association
    assocLaserToCams: new Map(),
    hasBoxData: lidarBoxByFrame.size > 0,
    segmentMeta: sceneMeta,
  }
}
