/**
 * Argoverse 2 Sensor Dataset manifest.
 *
 * Sensor configuration, category mapping, and detection parameters
 * for Argoverse 2 Sensor Dataset (train / val / test).
 *
 * Argoverse 2 has 7 ring cameras, 2 stereo cameras, and 2 stacked LiDARs
 * (up_lidar + down_lidar, combined into a single sweep in ego frame).
 * LiDAR rate is 10 Hz; ring cameras are 20 fps; stereo cameras are 20 fps.
 */

import { colors } from '../../theme'
import type { DatasetManifest } from '../../types/dataset'

/**
 * Numeric IDs for AV2 cameras.
 * 7 ring cameras + 2 stereo cameras = 9 total.
 * Assigned to match a reasonable visual layout order.
 */
const CAM = {
  RING_REAR_LEFT: 1,
  RING_SIDE_LEFT: 2,
  RING_FRONT_LEFT: 3,
  RING_FRONT_CENTER: 4,
  RING_FRONT_RIGHT: 5,
  RING_SIDE_RIGHT: 6,
  RING_REAR_RIGHT: 7,
  // Stereo cameras (rarely visualized, but included)
  // STEREO_FRONT_LEFT: 8,
  // STEREO_FRONT_RIGHT: 9,
} as const

/** Numeric ID for AV2 LiDAR (up + down combined as single sweep). */
const LIDAR = {
  COMBINED: 1,
} as const

/**
 * Maps Argoverse 2 sensor name strings → numeric IDs used in the pipeline.
 */
export const AV2_SENSOR_NAME_TO_ID: Record<string, number> = {
  'ring_rear_left': CAM.RING_REAR_LEFT,
  'ring_side_left': CAM.RING_SIDE_LEFT,
  'ring_front_left': CAM.RING_FRONT_LEFT,
  'ring_front_center': CAM.RING_FRONT_CENTER,
  'ring_front_right': CAM.RING_FRONT_RIGHT,
  'ring_side_right': CAM.RING_SIDE_RIGHT,
  'ring_rear_right': CAM.RING_REAR_RIGHT,
  // 'stereo_front_left': 8,
  // 'stereo_front_right': 9,
}

/** All ring camera names in visual layout order */
export const AV2_RING_CAMERA_NAMES = [
  'ring_rear_left',
  'ring_side_left',
  'ring_front_left',
  'ring_front_center',
  'ring_front_right',
  'ring_side_right',
  'ring_rear_right',
] as const

export const argoverse2Manifest: DatasetManifest = {
  id: 'argoverse2',
  name: 'Argoverse 2',

  // Top-level directories recognized inside a single AV2 log
  knownComponents: [
    'sensors', 'calibration', 'map',
    'annotations.feather', 'city_SE3_egovehicle.feather',
  ],

  // Minimum entries to identify an AV2 log directory
  // We look for the 'sensors' directory AND 'calibration' directory
  requiredComponents: ['sensors', 'calibration'],

  lidarSensors: [
    { id: LIDAR.COMBINED, label: 'LIDAR', color: colors.sensorTop },
  ],

  cameraSensors: [
    { id: CAM.RING_REAR_LEFT,    label: 'REAR LEFT',    color: colors.sensorRear,   width: 1550, height: 2048, flex: 0.8 },
    { id: CAM.RING_SIDE_LEFT,    label: 'SIDE LEFT',    color: colors.camSideLeft,  width: 1550, height: 2048, flex: 0.8 },
    { id: CAM.RING_FRONT_LEFT,   label: 'FRONT LEFT',   color: colors.camFrontLeft, width: 1550, height: 2048, flex: 0.8 },
    { id: CAM.RING_FRONT_CENTER, label: 'FRONT',        color: colors.camFront,     width: 1550, height: 2048, flex: 1.0 },
    { id: CAM.RING_FRONT_RIGHT,  label: 'FRONT RIGHT',  color: colors.camFrontRight,width: 1550, height: 2048, flex: 0.8 },
    { id: CAM.RING_SIDE_RIGHT,   label: 'SIDE RIGHT',   color: colors.camSideRight, width: 1550, height: 2048, flex: 0.8 },
    { id: CAM.RING_REAR_RIGHT,   label: 'REAR RIGHT',   color: colors.sensorSideR,  width: 1550, height: 2048, flex: 0.8 },
  ],

  boxTypes: [
    // AV2 has 30 categories — map to common types with 3D models
    { id: 0,  label: 'Unknown',         color: '#6B7280' },
    { id: 1,  label: 'Regular Vehicle', color: '#FF9E00', model: 'vehicle' },
    { id: 2,  label: 'Pedestrian',      color: '#CCFF00', model: 'pedestrian' },
    { id: 3,  label: 'Bicyclist',       color: '#FF6B9D', model: 'bicycle' },
    { id: 4,  label: 'Motorcyclist',    color: '#FF2D55', model: 'motorcycle' },
    { id: 5,  label: 'Wheeled Rider',   color: '#FF44FF', model: 'bicycle' },
    { id: 6,  label: 'Bollard',         color: '#8B9DC3' },
    { id: 7,  label: 'Constr. Cone',    color: '#FF44FF', model: 'cone' },
    { id: 8,  label: 'Sign',            color: '#FF44FF', model: 'sign' },
    { id: 9,  label: 'Constr. Barrel',  color: '#CC7A00' },
    { id: 10, label: 'Stop Sign',       color: '#FF4444', model: 'sign' },
    { id: 11, label: 'Bicycle',         color: '#FF6B9D', model: 'bicycle' },
    { id: 12, label: 'Large Vehicle',   color: '#E67700', model: 'vehicle' },
    { id: 13, label: 'Bus',             color: '#FFD600', model: 'vehicle' },
    { id: 14, label: 'Box Truck',       color: '#D4A574', model: 'vehicle' },
    { id: 15, label: 'Truck',           color: '#E67700', model: 'vehicle' },
    { id: 16, label: 'Motorcycle',      color: '#FF2D55', model: 'motorcycle' },
    { id: 17, label: 'Vehicular Trailer', color: '#D4A574', model: 'vehicle' },
    { id: 18, label: 'Truck Cab',       color: '#CC7A00', model: 'vehicle' },
    { id: 19, label: 'School Bus',      color: '#FFD600', model: 'vehicle' },
    { id: 20, label: 'Articulated Bus', color: '#FFD600', model: 'vehicle' },
    { id: 21, label: 'Msg Board',       color: '#8B9DC3' },
    { id: 22, label: 'Traffic Lt Trailer', color: '#8B9DC3' },
    { id: 23, label: 'Stroller',        color: '#00CED1' },
    { id: 24, label: 'Wheelchair',      color: '#00CED1' },
    { id: 25, label: 'Wheeled Device',  color: '#00CED1' },
    { id: 26, label: 'Animal',          color: '#00CED1' },
    { id: 27, label: 'Dog',             color: '#00CED1' },
    { id: 28, label: 'Official Signal', color: '#CCFF00', model: 'pedestrian' },
    { id: 29, label: 'Mob Ped Sign',    color: '#8B9DC3', model: 'sign' },
    { id: 30, label: 'Railed Vehicle',  color: '#D4A574', model: 'vehicle' },
  ],

  frameRate: 10, // 10 Hz LiDAR
  pointStride: 4, // x, y, z, intensity (after worker transformation)
  colormapModes: ['distance', 'intensity', 'camera'],
  intensityRange: [0, 255], // AV2 intensity is uint8-like

  cameraColors: {
    [CAM.RING_FRONT_CENTER]: colors.camFront,
    [CAM.RING_FRONT_LEFT]: colors.camFrontLeft,
    [CAM.RING_FRONT_RIGHT]: colors.camFrontRight,
    [CAM.RING_SIDE_LEFT]: colors.camSideLeft,
    [CAM.RING_SIDE_RIGHT]: colors.camSideRight,
    [CAM.RING_REAR_LEFT]: colors.sensorRear,
    [CAM.RING_REAR_RIGHT]: colors.sensorSideR,
  },

  cameraPovLabels: {
    [CAM.RING_FRONT_CENTER]: 'FC',
    [CAM.RING_FRONT_LEFT]: 'FL',
    [CAM.RING_FRONT_RIGHT]: 'FR',
    [CAM.RING_SIDE_LEFT]: 'SL',
    [CAM.RING_SIDE_RIGHT]: 'SR',
    [CAM.RING_REAR_LEFT]: 'RL',
    [CAM.RING_REAR_RIGHT]: 'RR',
  },

  // AV2 doesn't use Parquet — Feather files parsed separately
  columnMap: {
    frameTimestamp: '',
    laserName: '',
    rangeImageShape: '',
    rangeImageValues: '',
    vehiclePose: '',
  },
}

/**
 * Maps Argoverse 2 category strings to numeric box type IDs.
 */
export const AV2_CATEGORY_TO_BOX_TYPE: Record<string, number> = {
  'REGULAR_VEHICLE': 1,
  'PEDESTRIAN': 2,
  'BICYCLIST': 3,
  'MOTORCYCLIST': 4,
  'WHEELED_RIDER': 5,
  'BOLLARD': 6,
  'CONSTRUCTION_CONE': 7,
  'SIGN': 8,
  'CONSTRUCTION_BARREL': 9,
  'STOP_SIGN': 10,
  'BICYCLE': 11,
  'LARGE_VEHICLE': 12,
  'BUS': 13,
  'BOX_TRUCK': 14,
  'TRUCK': 15,
  'MOTORCYCLE': 16,
  'VEHICULAR_TRAILER': 17,
  'TRUCK_CAB': 18,
  'SCHOOL_BUS': 19,
  'ARTICULATED_BUS': 20,
  'MESSAGE_BOARD_TRAILER': 21,
  'TRAFFIC_LIGHT_TRAILER': 22,
  'STROLLER': 23,
  'WHEELCHAIR': 24,
  'WHEELED_DEVICE': 25,
  'ANIMAL': 26,
  'DOG': 27,
  'OFFICIAL_SIGNALER': 28,
  'MOBILE_PEDESTRIAN_CROSSING_SIGN': 29,
  'RAILED_VEHICLE': 30,
}
