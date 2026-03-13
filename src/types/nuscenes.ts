/**
 * nuScenes dataset type definitions.
 *
 * Covers the JSON metadata tables shipped with nuScenes (v1.0-mini, trainval, test).
 * Each JSON file is an array of one of these record types, linked by string tokens.
 *
 * Reference: https://www.nuscenes.org/nuscenes#data-format
 */

// ---------------------------------------------------------------------------
// Core metadata tables
// ---------------------------------------------------------------------------

/** A logging session — maps to a physical drive. */
export interface NuScenesLog {
  token: string
  logfile: string
  vehicle: string
  date_captured: string
  location: string
}

/** A 20-second driving scene extracted from a log. */
export interface NuScenesScene {
  token: string
  log_token: string
  nbr_samples: number
  first_sample_token: string
  last_sample_token: string
  name: string          // e.g. "scene-0001"
  description: string
}

/**
 * A keyframe sample (~2 Hz).
 * Contains a linked list via prev/next tokens.
 */
export interface NuScenesSample {
  token: string
  timestamp: number     // microseconds
  prev: string          // "" if first
  next: string          // "" if last
  scene_token: string
}

/** Physical sensor on the vehicle (channel + modality). */
export interface NuScenesSensor {
  token: string
  channel: string       // e.g. "CAM_FRONT", "LIDAR_TOP"
  modality: 'camera' | 'lidar' | 'radar'
}

/**
 * Calibrated sensor — extrinsic + intrinsic for one sensor on one vehicle.
 * Extrinsics are given as translation + quaternion (scalar-first: [w, x, y, z]).
 */
export interface NuScenesCalibratedSensor {
  token: string
  sensor_token: string
  translation: [number, number, number]
  rotation: [number, number, number, number]  // [w, x, y, z]
  camera_intrinsic: number[][]                // 3×3 matrix (empty for non-camera)
}

/**
 * Ego vehicle pose at a specific timestamp.
 * In global (map) frame. Quaternion is scalar-first: [w, x, y, z].
 */
export interface NuScenesEgoPose {
  token: string
  timestamp: number
  translation: [number, number, number]
  rotation: [number, number, number, number]  // [w, x, y, z]
}

/**
 * A single sensor observation (image or point cloud file).
 * Linked list per sensor channel via prev/next.
 */
export interface NuScenesSampleData {
  token: string
  sample_token: string
  ego_pose_token: string
  calibrated_sensor_token: string
  timestamp: number
  fileformat: string            // "jpg", "pcd", "pcd.bin"
  is_key_frame: boolean
  height: number                // image height (0 for non-camera)
  width: number                 // image width (0 for non-camera)
  filename: string              // relative path e.g. "samples/CAM_FRONT/xxx.jpg"
  prev: string
  next: string
}

/**
 * A 3D bounding box annotation for one object in one keyframe sample.
 * Position/rotation are in the **global** (map) frame.
 */
export interface NuScenesSampleAnnotation {
  token: string
  sample_token: string
  instance_token: string
  visibility_token: string
  attribute_tokens: string[]
  translation: [number, number, number]
  size: [number, number, number]              // [width, length, height] in meters
  rotation: [number, number, number, number]  // [w, x, y, z]
  prev: string
  next: string
  num_lidar_pts: number
  num_radar_pts: number
  // Note: category_name is NOT on the raw JSON.
  // Resolved via instance_token → instance → category_token → category.name
}

/** Object instance — links annotations across samples for tracking. */
export interface NuScenesInstance {
  token: string
  category_token: string
  nbr_annotations: number
  first_annotation_token: string
  last_annotation_token: string
}

/** Object category (e.g. "vehicle.car", "human.pedestrian.adult"). */
export interface NuScenesCategory {
  token: string
  name: string
  description: string
  index: number
}

/** Annotation attribute (e.g. "vehicle.moving", "pedestrian.standing"). */
export interface NuScenesAttribute {
  token: string
  name: string
  description: string
}

/** Visibility level. */
export interface NuScenesVisibility {
  token: string
  level: string         // "1" through "4"
  description: string
}

// ---------------------------------------------------------------------------
// Sensor channel enums
// ---------------------------------------------------------------------------

/** nuScenes camera channel names */
export const NuScenesCameraChannel = {
  CAM_FRONT: 'CAM_FRONT',
  CAM_FRONT_LEFT: 'CAM_FRONT_LEFT',
  CAM_FRONT_RIGHT: 'CAM_FRONT_RIGHT',
  CAM_BACK: 'CAM_BACK',
  CAM_BACK_LEFT: 'CAM_BACK_LEFT',
  CAM_BACK_RIGHT: 'CAM_BACK_RIGHT',
} as const
export type NuScenesCameraChannel = (typeof NuScenesCameraChannel)[keyof typeof NuScenesCameraChannel]

/** nuScenes LiDAR channel names */
export const NuScenesLidarChannel = {
  LIDAR_TOP: 'LIDAR_TOP',
} as const
export type NuScenesLidarChannel = (typeof NuScenesLidarChannel)[keyof typeof NuScenesLidarChannel]

// ---------------------------------------------------------------------------
// Category mapping → BoxType int
// ---------------------------------------------------------------------------

/**
 * Maps nuScenes 23 categories → renderer BoxType ints.
 * Matches Waymo's BoxType values: 0=Unknown, 1=Vehicle, 2=Pedestrian, 3=Sign, 4=Cyclist
 */
export const NUSCENES_CATEGORY_MAP: Record<string, number> = {
  // Vehicle types → 1 (TYPE_VEHICLE)
  'vehicle.car': 1,
  'vehicle.truck': 1,
  'vehicle.bus.bendy': 1,
  'vehicle.bus.rigid': 1,
  'vehicle.construction': 1,
  'vehicle.emergency.ambulance': 1,
  'vehicle.emergency.police': 1,
  'vehicle.trailer': 1,
  'vehicle.motorcycle': 4,       // → CYCLIST (closest match)
  'vehicle.bicycle': 4,          // → CYCLIST

  // Pedestrian types → 2 (TYPE_PEDESTRIAN)
  'human.pedestrian.adult': 2,
  'human.pedestrian.child': 2,
  'human.pedestrian.wheelchair': 2,
  'human.pedestrian.stroller': 2,
  'human.pedestrian.personal_mobility': 2,
  'human.pedestrian.police_officer': 2,
  'human.pedestrian.construction_worker': 2,

  // Other → 0 (TYPE_UNKNOWN) or 3 (TYPE_SIGN)
  'animal': 0,
  'movable_object.barrier': 0,
  'movable_object.trafficcone': 3,   // → SIGN (closest visual match)
  'movable_object.pushable_pullable': 0,
  'movable_object.debris': 0,
  'static_object.bicycle_rack': 0,
}

// ---------------------------------------------------------------------------
// Point cloud binary format
// ---------------------------------------------------------------------------

/**
 * nuScenes LiDAR point cloud binary format (.pcd.bin).
 * Each point is 5 × float32 = 20 bytes: [x, y, z, intensity, ring_index].
 */
export const NUSCENES_POINT_STRIDE = 5
export const NUSCENES_POINT_BYTES = NUSCENES_POINT_STRIDE * 4  // 20 bytes
