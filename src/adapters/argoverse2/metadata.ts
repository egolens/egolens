/**
 * Argoverse 2 Sensor Dataset metadata loader.
 *
 * Reads Feather files (calibration, poses, annotations) and produces
 * a dataset-agnostic MetadataBundle for the store.
 *
 * AV2 data layout per log:
 *   {log_id}/
 *   ├── annotations.feather
 *   ├── city_SE3_egovehicle.feather
 *   ├── calibration/
 *   │   ├── egovehicle_SE3_sensor.feather
 *   │   └── intrinsics.feather
 *   ├── sensors/
 *   │   ├── lidar/{timestamp_ns}.feather
 *   │   └── cameras/{cam_name}/{timestamp_ns}.jpg
 *   └── map/
 *
 * LiDAR sweeps are already in the ego frame (no sensor→ego transform needed
 * for visualization, but extrinsic is stored for completeness).
 * Annotations are also in the ego frame at the corresponding lidar timestamp.
 */

import type { MetadataBundle, TrajectoryPoint } from '../../types/dataset'
import type { LidarCalibration } from '../../utils/rangeImage'
import { readFeatherFile, readFeatherColumns } from '../../utils/feather'
import { quaternionToMatrix4x4 } from '../../utils/quaternion'
import { multiplyRowMajor4x4, invertRowMajor4x4 } from '../../utils/matrix'
import {
  AV2_CATEGORY_TO_BOX_TYPE,
  AV2_SENSOR_NAME_TO_ID,
  AV2_RING_CAMERA_NAMES,
  argoverse2Manifest,
} from './manifest'

// ---------------------------------------------------------------------------
// Manifest types (shared with remote.ts — defined here to avoid circular imports)
// ---------------------------------------------------------------------------

export interface AV2Manifest {
  version: 1
  dataset: 'argoverse2'
  log_id: string
  num_frames: number
  frames: AV2ManifestFrame[]
}

export interface AV2ManifestFrame {
  /** LiDAR timestamp in nanoseconds (string — JSON can't represent int64) */
  timestamp_ns: string
  /** Per-camera image timestamps (ns), keyed by camera name */
  cameras: Record<string, string>
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AV2LogDatabase {
  /** Log ID (directory name) */
  logId: string
  /** All LiDAR timestamps (ns, sorted) */
  lidarTimestamps: bigint[]
  /** Camera images per camera per LiDAR timestamp (approximate nearest match) */
  cameraFilesByFrame: Map<number, { cameraId: number; filename: string }[]>
  /** Annotation rows grouped by lidar timestamp */
  annotationsByTimestamp: Map<bigint, Record<string, unknown>[]>
  /** Ego poses keyed by timestamp_ns → quaternion + translation */
  posesByTimestamp: Map<bigint, { qw: number; qx: number; qy: number; qz: number; tx: number; ty: number; tz: number }>
  /** Camera intrinsics per sensor name */
  intrinsicsBySensor: Map<string, { fx: number; fy: number; cx: number; cy: number; width: number; height: number }>
  /** Sensor extrinsics (egovehicle_SE3_sensor) per sensor name → 4x4 row-major */
  extrinsicsBySensor: Map<string, number[]>
}

// ---------------------------------------------------------------------------
// Frame discovery from manifest (URL mode)
// ---------------------------------------------------------------------------

/**
 * Build frame discovery maps from manifest.json.
 * Replaces local file-key scanning for URL mode.
 *
 * Returns:
 * - lidarTimestamps: sorted bigint array
 * - cameraFilesByFrame: per-frame camera image descriptors (same shape as local mode)
 */
export function discoverAV2FramesFromManifest(
  manifest: AV2Manifest,
  sensorNameToId: Record<string, number>,
  ringCameraNames: readonly string[],
): {
  lidarTimestamps: bigint[]
  cameraFilesByFrame: Map<number, { cameraId: number; filename: string }[]>
} {
  const lidarTimestamps = manifest.frames.map(f => BigInt(f.timestamp_ns))
  // manifest.frames are already sorted by generation script

  const cameraFilesByFrame = new Map<number, { cameraId: number; filename: string }[]>()
  for (let fi = 0; fi < manifest.frames.length; fi++) {
    const frame = manifest.frames[fi]
    const images: { cameraId: number; filename: string }[] = []

    for (const camName of ringCameraNames) {
      const camId = sensorNameToId[camName]
      if (camId === undefined) continue
      const camTs = frame.cameras[camName]
      if (!camTs) continue
      images.push({
        cameraId: camId,
        filename: `sensors/cameras/${camName}/${camTs}.jpg`,
      })
    }

    cameraFilesByFrame.set(fi, images)
  }

  return { lidarTimestamps, cameraFilesByFrame }
}

// ---------------------------------------------------------------------------
// Database construction
// ---------------------------------------------------------------------------

/**
 * Build a database from AV2 log files.
 * Called once when the log is opened.
 *
 * @param logFiles - Map of relative path → File or ArrayBuffer (URL mode pre-fetches metadata as ArrayBuffers)
 * @param logId - log directory name
 * @param manifest - Optional manifest.json for URL mode frame discovery (replaces file-key scanning)
 */
export async function buildAV2LogDatabase(
  logFiles: Map<string, File | ArrayBuffer>,
  logId: string,
  manifest?: AV2Manifest,
): Promise<AV2LogDatabase> {
  console.time('[AV2] buildDatabase')
  // 1. Read calibration files (small — row objects OK)
  const extrinsicsFile = logFiles.get('calibration/egovehicle_SE3_sensor.feather')
  const intrinsicsFile = logFiles.get('calibration/intrinsics.feather')

  const extrinsicsBySensor = new Map<string, number[]>()
  if (extrinsicsFile) {
    const rows = await readFeatherFile(extrinsicsFile)
    for (const row of rows) {
      const sensorName = row['sensor_name'] as string
      const qw = row['qw'] as number
      const qx = row['qx'] as number
      const qy = row['qy'] as number
      const qz = row['qz'] as number
      const tx = row['tx_m'] as number
      const ty = row['ty_m'] as number
      const tz = row['tz_m'] as number
      extrinsicsBySensor.set(sensorName, quaternionToMatrix4x4([qw, qx, qy, qz], [tx, ty, tz]))
    }
  }

  const intrinsicsBySensor = new Map<string, { fx: number; fy: number; cx: number; cy: number; width: number; height: number }>()
  if (intrinsicsFile) {
    const rows = await readFeatherFile(intrinsicsFile)
    for (const row of rows) {
      const sensorName = row['sensor_name'] as string
      intrinsicsBySensor.set(sensorName, {
        fx: row['fx_px'] as number,
        fy: row['fy_px'] as number,
        cx: row['cx_px'] as number,
        cy: row['cy_px'] as number,
        width: row['width_px'] as number,
        height: row['height_px'] as number,
      })
    }
  }

  // 2. Read poses (columnar — much faster than row objects for 2689+ rows)
  const posesFile = logFiles.get('city_SE3_egovehicle.feather')
  const posesByTimestamp = new Map<bigint, { qw: number; qx: number; qy: number; qz: number; tx: number; ty: number; tz: number }>()
  if (posesFile) {
    console.time('[AV2] poses')
    const { columns: pc, numRows: pn } = await readFeatherColumns(posesFile)
    const tsArr = pc['timestamp_ns'] ?? []
    const qwArr = pc['qw'] ?? []
    const qxArr = pc['qx'] ?? []
    const qyArr = pc['qy'] ?? []
    const qzArr = pc['qz'] ?? []
    const txArr = pc['tx_m'] ?? []
    const tyArr = pc['ty_m'] ?? []
    const tzArr = pc['tz_m'] ?? []
    for (let i = 0; i < pn; i++) {
      const ts = BigInt(tsArr[i] as number | bigint)
      posesByTimestamp.set(ts, {
        qw: qwArr[i] as number, qx: qxArr[i] as number,
        qy: qyArr[i] as number, qz: qzArr[i] as number,
        tx: txArr[i] as number, ty: tyArr[i] as number, tz: tzArr[i] as number,
      })
    }
    console.timeEnd('[AV2] poses')
  }

  // 3. Read annotations (columnar for 12637+ rows)
  const annotationsFile = logFiles.get('annotations.feather')
  const annotationsByTimestamp = new Map<bigint, Record<string, unknown>[]>()
  if (annotationsFile) {
    console.time('[AV2] annotations')
    const { columns: ac, numRows: an } = await readFeatherColumns(annotationsFile)
    const atsArr = ac['timestamp_ns'] ?? []
    const catArr = ac['category'] ?? []
    const trackArr = ac['track_uuid'] ?? []
    const aqwArr = ac['qw'] ?? []
    const aqxArr = ac['qx'] ?? []
    const aqyArr = ac['qy'] ?? []
    const aqzArr = ac['qz'] ?? []
    const atxArr = ac['tx_m'] ?? []
    const atyArr = ac['ty_m'] ?? []
    const atzArr = ac['tz_m'] ?? []
    const alArr = ac['length_m'] ?? []
    const awArr = ac['width_m'] ?? []
    const ahArr = ac['height_m'] ?? []
    const aniArr = ac['num_interior_pts'] ?? []
    for (let i = 0; i < an; i++) {
      const ts = BigInt(atsArr[i] as number | bigint)
      let list = annotationsByTimestamp.get(ts)
      if (!list) {
        list = []
        annotationsByTimestamp.set(ts, list)
      }
      list.push({
        timestamp_ns: ts,
        category: catArr[i],
        track_uuid: trackArr[i],
        qw: aqwArr[i], qx: aqxArr[i], qy: aqyArr[i], qz: aqzArr[i],
        tx_m: atxArr[i], ty_m: atyArr[i], tz_m: atzArr[i],
        length_m: alArr[i], width_m: awArr[i], height_m: ahArr[i],
        num_interior_pts: aniArr[i],
      })
    }
    console.timeEnd('[AV2] annotations')
  }

  // 4-5. Frame discovery: from manifest.json (URL mode) or file-key scanning (local mode)
  let lidarTimestamps: bigint[]
  let cameraFilesByFrame: Map<number, { cameraId: number; filename: string }[]>

  if (manifest) {
    // URL mode: use manifest.json for frame discovery (no file keys to scan)
    const discovery = discoverAV2FramesFromManifest(manifest, AV2_SENSOR_NAME_TO_ID, AV2_RING_CAMERA_NAMES)
    lidarTimestamps = discovery.lidarTimestamps
    cameraFilesByFrame = discovery.cameraFilesByFrame
  } else {
    // Local mode: scan file keys (original logic)
    lidarTimestamps = []
    for (const path of logFiles.keys()) {
      const match = path.match(/^sensors\/lidar\/(\d+)\.feather$/)
      if (match) {
        lidarTimestamps.push(BigInt(match[1]))
      }
    }
    lidarTimestamps.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    // Discover camera images and match to nearest LiDAR timestamp
    const cameraTimestampsByCam = new Map<string, bigint[]>()
    const cameraFilenameByCamAndTs = new Map<string, string>()
    for (const path of logFiles.keys()) {
      const match = path.match(/^sensors\/cameras\/([^/]+)\/(\d+)\.jpg$/)
      if (match) {
        const camName = match[1]
        const ts = BigInt(match[2])
        let arr = cameraTimestampsByCam.get(camName)
        if (!arr) {
          arr = []
          cameraTimestampsByCam.set(camName, arr)
        }
        arr.push(ts)
        cameraFilenameByCamAndTs.set(`${camName}:${ts}`, path)
      }
    }

    for (const arr of cameraTimestampsByCam.values()) {
      arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    }

    cameraFilesByFrame = new Map<number, { cameraId: number; filename: string }[]>()
    for (let fi = 0; fi < lidarTimestamps.length; fi++) {
      const lidarTs = lidarTimestamps[fi]
      const images: { cameraId: number; filename: string }[] = []

      for (const camName of AV2_RING_CAMERA_NAMES) {
        const camId = AV2_SENSOR_NAME_TO_ID[camName]
        if (camId === undefined) continue
        const camTimestamps = cameraTimestampsByCam.get(camName)
        if (!camTimestamps || camTimestamps.length === 0) continue

        const closestTs = findClosestTimestamp(camTimestamps, lidarTs)
        const filename = cameraFilenameByCamAndTs.get(`${camName}:${closestTs}`)
        if (filename) {
          images.push({ cameraId: camId, filename })
        }
      }

      cameraFilesByFrame.set(fi, images)
    }
  }

  console.timeEnd('[AV2] buildDatabase')
  console.log('[AV2] %d frames, %d poses, %d annotation frames',
    lidarTimestamps.length, posesByTimestamp.size, annotationsByTimestamp.size)
  return {
    logId,
    lidarTimestamps,
    cameraFilesByFrame,
    annotationsByTimestamp,
    posesByTimestamp,
    intrinsicsBySensor,
    extrinsicsBySensor,
  }
}

// ---------------------------------------------------------------------------
// MetadataBundle construction
// ---------------------------------------------------------------------------

/**
 * Build MetadataBundle from an AV2 log database.
 */
export function loadAV2LogMetadata(db: AV2LogDatabase): MetadataBundle {
  const timestamps = db.lidarTimestamps
  const timestampToFrame = new Map<bigint, number>()
  for (let i = 0; i < timestamps.length; i++) {
    timestampToFrame.set(timestamps[i], i)
  }

  // 1. Build ego poses (relative to frame 0)
  const poseByFrameIndex = new Map<number, number[]>()
  let worldOriginInverse: number[] | null = null

  for (let fi = 0; fi < timestamps.length; fi++) {
    const ts = timestamps[fi]
    const pose = db.posesByTimestamp.get(ts)
    if (!pose) continue

    const poseMatrix = quaternionToMatrix4x4(
      [pose.qw, pose.qx, pose.qy, pose.qz],
      [pose.tx, pose.ty, pose.tz],
    )

    if (fi === 0) {
      worldOriginInverse = invertRowMajor4x4(poseMatrix)
    }

    if (worldOriginInverse) {
      poseByFrameIndex.set(fi, multiplyRowMajor4x4(worldOriginInverse, poseMatrix))
    } else {
      poseByFrameIndex.set(fi, poseMatrix)
    }
  }

  // 2. Build LiDAR calibration
  //    AV2 LiDAR data is already in ego frame, so the "extrinsic" is identity for rendering.
  //    But we store the actual sensor→ego transform for reference.
  const lidarCalibrations = new Map<number, LidarCalibration>()
  lidarCalibrations.set(1, {
    laserName: 1,
    extrinsic: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], // Identity — data already in ego frame
    beamInclinationValues: null,
    beamInclinationMin: 0,
    beamInclinationMax: 0,
  })

  // 3. Build camera calibrations
  const CAM_PREFIX = '[CameraCalibrationComponent]'
  const cameraCalibrations: Record<string, unknown>[] = []
  for (const camName of AV2_RING_CAMERA_NAMES) {
    const camId = AV2_SENSOR_NAME_TO_ID[camName]
    if (camId === undefined) continue
    const intrinsics = db.intrinsicsBySensor.get(camName)
    const extrinsic = db.extrinsicsBySensor.get(camName)
    if (!intrinsics || !extrinsic) continue

    const camDef = argoverse2Manifest.cameraSensors.find(c => c.id === camId)

    cameraCalibrations.push({
      'key.camera_name': camId,
      [`${CAM_PREFIX}.extrinsic.transform`]: extrinsic,
      [`${CAM_PREFIX}.width`]: intrinsics.width || camDef?.width || 1550,
      [`${CAM_PREFIX}.height`]: intrinsics.height || camDef?.height || 2048,
      [`${CAM_PREFIX}.intrinsic.f_u`]: intrinsics.fx,
      [`${CAM_PREFIX}.intrinsic.f_v`]: intrinsics.fy,
      [`${CAM_PREFIX}.intrinsic.c_u`]: intrinsics.cx,
      [`${CAM_PREFIX}.intrinsic.c_v`]: intrinsics.cy,
      '__isOpticalFrame': true, // AV2 camera sensor frame is optical convention (X=right, Y=down, Z=forward)
    })
  }

  // 4. Build 3D boxes + trajectories from annotations
  //    AV2 annotations are in the ego frame at the corresponding lidar timestamp
  //    (unlike nuScenes which is in global frame). So no transform needed.
  const objectTrajectories = new Map<string, TrajectoryPoint[]>()
  const lidarBoxByFrame = new Map<bigint, Record<string, unknown>[]>()

  for (let fi = 0; fi < timestamps.length; fi++) {
    const ts = timestamps[fi]
    const anns = db.annotationsByTimestamp.get(ts) ?? []
    const boxRows: Record<string, unknown>[] = []

    for (const ann of anns) {
      const category = ann['category'] as string
      const boxType = AV2_CATEGORY_TO_BOX_TYPE[category] ?? 0

      // Position is already in ego frame
      const cx = ann['tx_m'] as number
      const cy = ann['ty_m'] as number
      const cz = ann['tz_m'] as number

      // Orientation: quaternion → heading angle
      const qw = ann['qw'] as number
      const qx = ann['qx'] as number
      const qy = ann['qy'] as number
      const qz = ann['qz'] as number
      // Convert quaternion to yaw heading: atan2(2(wz+xy), 1-2(yy+zz))
      const heading = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz))

      // Dimensions
      const length = ann['length_m'] as number
      const width = ann['width_m'] as number
      const height = ann['height_m'] as number

      // Object ID for tracking
      const objectId = ann['track_uuid'] as string

      boxRows.push({
        'key.laser_object_id': objectId,
        '[LiDARBoxComponent].box.center.x': cx,
        '[LiDARBoxComponent].box.center.y': cy,
        '[LiDARBoxComponent].box.center.z': cz,
        '[LiDARBoxComponent].box.size.x': length,
        '[LiDARBoxComponent].box.size.y': width,
        '[LiDARBoxComponent].box.size.z': height,
        '[LiDARBoxComponent].box.heading': heading,
        '[LiDARBoxComponent].type': boxType,
      })

      // Trajectory
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

  // Sort trajectories
  for (const trail of objectTrajectories.values()) {
    trail.sort((a, b) => a.frameIndex - b.frameIndex)
  }

  // 5. Build sensor file paths per frame (stored in vehiclePoseByFrame, as nuScenes does)
  const vehiclePoseByFrame = new Map<bigint, Record<string, unknown>[]>()
  for (let fi = 0; fi < timestamps.length; fi++) {
    const ts = timestamps[fi]
    const sensorFiles: Record<string, unknown>[] = []

    // LiDAR file
    sensorFiles.push({
      modality: 'lidar',
      sensorId: 1,
      filename: `sensors/lidar/${ts}.feather`,
    })

    // Camera files
    const camFiles = db.cameraFilesByFrame.get(fi) ?? []
    for (const { cameraId, filename } of camFiles) {
      sensorFiles.push({
        modality: 'camera',
        sensorId: cameraId,
        filename,
      })
    }

    vehiclePoseByFrame.set(ts, sensorFiles)
  }

  // 6. Build scene metadata
  //    AV2 doesn't provide explicit location/timeOfDay in its feather files.
  //    Leave them empty so the UI can show a clean label without "Unknown Unknown".
  const sceneMeta = {
    segmentId: db.logId,
    timeOfDay: '',
    location: '',
    weather: '',
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
    lidarCalibrations,
    cameraCalibrations,
    lidarBoxByFrame: lidarBoxByFrame as Map<unknown, Record<string, unknown>[]>,
    cameraBoxByFrame: new Map(),
    objectTrajectories,
    assocCamToLaser: new Map(),
    assocLaserToCams: new Map(),
    hasBoxData: lidarBoxByFrame.size > 0,
    segmentMeta: sceneMeta,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Binary search for closest timestamp in a sorted array. */
function findClosestTimestamp(sorted: bigint[], target: bigint): bigint {
  let lo = 0
  let hi = sorted.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid
  }
  // Check neighbors
  if (lo > 0) {
    const diffLo = target - sorted[lo - 1]
    const diffHi = sorted[lo] - target
    if (diffLo < diffHi) return sorted[lo - 1]
  }
  return sorted[lo]
}
