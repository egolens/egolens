/**
 * Waymo metadata loader — extracts all "startup data" from Waymo Parquet files
 * into a dataset-agnostic MetadataBundle.
 *
 * This was previously embedded in useSceneStore.loadStartupData().
 * Now the store calls this adapter function and unpacks the result.
 */

import { groupIndexBy } from '../../utils/merge'
import {
  readAllRows,
  buildFrameIndex,
  type WaymoParquetFile,
} from '../../utils/parquet'
import { parseLidarCalibration } from '../../utils/rangeImage'
import type { MetadataBundle } from '../../types/dataset'

// ---------------------------------------------------------------------------
// Row-major 4×4 matrix helpers (duplicated from store — could be shared util)
// ---------------------------------------------------------------------------

/** Multiply two row-major 4×4 matrices: result = A * B */
function multiplyRowMajor4x4(a: number[], b: number[]): number[] {
  const r = new Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      r[i * 4 + j] =
        a[i * 4 + 0] * b[0 * 4 + j] +
        a[i * 4 + 1] * b[1 * 4 + j] +
        a[i * 4 + 2] * b[2 * 4 + j] +
        a[i * 4 + 3] * b[3 * 4 + j]
    }
  }
  return r
}

/** Invert a row-major 4×4 rigid-body transform [R|t; 0 0 0 1] → [R^T | -R^T·t] */
function invertRowMajor4x4(m: number[]): number[] {
  const r00 = m[0], r01 = m[1], r02 = m[2], tx = m[3]
  const r10 = m[4], r11 = m[5], r12 = m[6], ty = m[7]
  const r20 = m[8], r21 = m[9], r22 = m[10], tz = m[11]
  return [
    r00, r10, r20, -(r00 * tx + r10 * ty + r20 * tz),
    r01, r11, r21, -(r01 * tx + r11 * ty + r21 * tz),
    r02, r12, r22, -(r02 * tx + r12 * ty + r22 * tz),
    0, 0, 0, 1,
  ]
}

// ---------------------------------------------------------------------------
// Waymo metadata loader
// ---------------------------------------------------------------------------

/**
 * Load all startup metadata from Waymo Parquet files.
 *
 * Reads: vehicle_pose, lidar_calibration, camera_calibration,
 *        lidar_box, camera_box, camera_to_lidar_box_association, stats
 *
 * Returns a MetadataBundle that the store unpacks into internal state.
 */
export async function loadWaymoMetadata(
  parquetFiles: Map<string, WaymoParquetFile>,
): Promise<MetadataBundle> {
  const bundle: MetadataBundle = {
    timestamps: [],
    timestampToFrame: new Map(),
    vehiclePoseByFrame: new Map(),
    worldOriginInverse: null,
    poseByFrameIndex: new Map(),
    lidarCalibrations: new Map(),
    cameraCalibrations: [],
    lidarBoxByFrame: new Map(),
    cameraBoxByFrame: new Map(),
    objectTrajectories: new Map(),
    assocCamToLaser: new Map(),
    assocLaserToCams: new Map(),
    hasBoxData: false,
    segmentMeta: null,
  }

  // -----------------------------------------------------------------------
  // Vehicle pose → master frame list + relative poses
  // -----------------------------------------------------------------------
  const posePf = parquetFiles.get('vehicle_pose')
  if (posePf) {
    const rows = await readAllRows(posePf)
    const index = buildFrameIndex(rows)
    bundle.timestamps = index.timestamps
    bundle.timestampToFrame = index.frameByTimestamp
    bundle.vehiclePoseByFrame = groupIndexBy(rows, 'key.frame_timestamp_micros')

    // Frame 0 pose inverse (world origin)
    const frame0Ts = bundle.timestamps[0]
    const frame0Rows = bundle.vehiclePoseByFrame.get(frame0Ts)
    const frame0Pose = frame0Rows?.[0]?.['[VehiclePoseComponent].world_from_vehicle.transform'] as number[] | undefined
    if (frame0Pose) {
      bundle.worldOriginInverse = invertRowMajor4x4(frame0Pose)
    }

    // Relative poses: inv(pose0) × poseN
    for (const row of rows) {
      const ts = row['key.frame_timestamp_micros'] as bigint
      const fi = bundle.timestampToFrame.get(ts)
      const pose = row['[VehiclePoseComponent].world_from_vehicle.transform'] as number[] | undefined
      if (fi !== undefined && pose) {
        if (bundle.worldOriginInverse) {
          bundle.poseByFrameIndex.set(fi, multiplyRowMajor4x4(bundle.worldOriginInverse, pose))
        } else {
          bundle.poseByFrameIndex.set(fi, pose)
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // LiDAR calibration
  // -----------------------------------------------------------------------
  const lidarCalibPf = parquetFiles.get('lidar_calibration')
  if (lidarCalibPf) {
    const rows = await readAllRows(lidarCalibPf)
    for (const row of rows) {
      const calib = parseLidarCalibration(row)
      bundle.lidarCalibrations.set(calib.laserName, calib)
    }
  }

  // -----------------------------------------------------------------------
  // Camera calibration
  // -----------------------------------------------------------------------
  const cameraCalibPf = parquetFiles.get('camera_calibration')
  if (cameraCalibPf) {
    bundle.cameraCalibrations = await readAllRows(cameraCalibPf)
  }

  // -----------------------------------------------------------------------
  // LiDAR boxes + trajectories
  // -----------------------------------------------------------------------
  const lidarBoxPf = parquetFiles.get('lidar_box')
  if (lidarBoxPf) {
    const rows = await readAllRows(lidarBoxPf)
    bundle.lidarBoxByFrame = groupIndexBy(rows, 'key.frame_timestamp_micros')
    bundle.hasBoxData = rows.length > 0

    // Build object trajectory index
    for (const row of rows) {
      const objectId = row['key.laser_object_id'] as string | undefined
      if (!objectId) continue
      const cx = row['[LiDARBoxComponent].box.center.x'] as number | undefined
      const cy = row['[LiDARBoxComponent].box.center.y'] as number | undefined
      const cz = row['[LiDARBoxComponent].box.center.z'] as number | undefined
      const type = (row['[LiDARBoxComponent].type'] as number) ?? 0
      if (cx == null || cy == null || cz == null) continue

      const ts = row['key.frame_timestamp_micros'] as bigint
      const fi = bundle.timestampToFrame.get(ts)
      if (fi === undefined) continue

      let trail = bundle.objectTrajectories.get(objectId)
      if (!trail) {
        trail = []
        bundle.objectTrajectories.set(objectId, trail)
      }
      trail.push({ frameIndex: fi, x: cx, y: cy, z: cz, type })
    }

    // Sort each trajectory by frame index
    for (const trail of bundle.objectTrajectories.values()) {
      trail.sort((a, b) => a.frameIndex - b.frameIndex)
    }
  }

  // -----------------------------------------------------------------------
  // Camera boxes (2D)
  // -----------------------------------------------------------------------
  const cameraBoxPf = parquetFiles.get('camera_box')
  if (cameraBoxPf) {
    const rows = await readAllRows(cameraBoxPf)
    bundle.cameraBoxByFrame = groupIndexBy(rows, 'key.frame_timestamp_micros')
  }

  // -----------------------------------------------------------------------
  // Camera-to-LiDAR box association
  // -----------------------------------------------------------------------
  const assocPf = parquetFiles.get('camera_to_lidar_box_association')
  if (assocPf) {
    const rows = await readAllRows(assocPf, [
      'key.camera_object_id',
      'key.laser_object_id',
    ])
    for (const row of rows) {
      const camId = row['key.camera_object_id'] as string | undefined
      const laserId = row['key.laser_object_id'] as string | undefined
      if (!camId || !laserId) continue
      bundle.assocCamToLaser.set(camId, laserId)
      let camSet = bundle.assocLaserToCams.get(laserId)
      if (!camSet) {
        camSet = new Set()
        bundle.assocLaserToCams.set(laserId, camSet)
      }
      camSet.add(camId)
    }
  }

  // -----------------------------------------------------------------------
  // Stats (segment metadata)
  // -----------------------------------------------------------------------
  const statsPf = parquetFiles.get('stats')
  if (statsPf) {
    const rows = await readAllRows(statsPf, [
      'key.segment_context_name',
      '[StatsComponent].time_of_day',
      '[StatsComponent].location',
      '[StatsComponent].weather',
      '[StatsComponent].lidar_object_counts.types',
      '[StatsComponent].lidar_object_counts.counts',
    ])
    if (rows.length > 0) {
      const row = rows[0]
      const segmentId = row['key.segment_context_name'] as string
      const types = (row['[StatsComponent].lidar_object_counts.types'] as number[]) ?? []
      const counts = (row['[StatsComponent].lidar_object_counts.counts'] as number[]) ?? []

      // Average object counts across all frames
      const totalCounts: Record<number, number> = {}
      for (let i = 0; i < types.length; i++) {
        totalCounts[types[i]] = (counts[i] ?? 0)
      }
      if (rows.length > 1) {
        const frameCounts: Record<number, number[]> = {}
        for (const r of rows) {
          const ts = (r['[StatsComponent].lidar_object_counts.types'] as number[]) ?? []
          const cs = (r['[StatsComponent].lidar_object_counts.counts'] as number[]) ?? []
          for (let i = 0; i < ts.length; i++) {
            if (!frameCounts[ts[i]]) frameCounts[ts[i]] = []
            frameCounts[ts[i]].push(cs[i] ?? 0)
          }
        }
        for (const [t, arr] of Object.entries(frameCounts)) {
          totalCounts[Number(t)] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
        }
      }

      bundle.segmentMeta = {
        segmentId,
        timeOfDay: (row['[StatsComponent].time_of_day'] as string) ?? 'Unknown',
        location: (row['[StatsComponent].location'] as string) ?? 'Unknown',
        weather: (row['[StatsComponent].weather'] as string) ?? 'Unknown',
        objectCounts: totalCounts,
      }
    }
  }

  return bundle
}
