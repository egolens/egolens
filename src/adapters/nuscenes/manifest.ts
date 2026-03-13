/**
 * nuScenes dataset manifest.
 *
 * Sensor configuration, category mapping, and detection parameters
 * for nuScenes v1.0 (mini / trainval / test).
 *
 * nuScenes has 6 cameras, 1 LiDAR, and 5 radars.
 * Keyframe rate is 2 Hz; sweep support is deferred.
 */

import { colors } from '../../theme'
import type { DatasetManifest } from '../../types/dataset'

/**
 * Numeric IDs for nuScenes cameras.
 * Assigned to match the visual layout order (left → front → right → back).
 */
const CAM = {
  FRONT_LEFT: 1,
  FRONT: 2,
  FRONT_RIGHT: 3,
  BACK_LEFT: 4,
  BACK: 5,
  BACK_RIGHT: 6,
} as const

/** Numeric ID for nuScenes LiDAR (only LIDAR_TOP exists). */
const LIDAR = {
  TOP: 1,
} as const

/**
 * Numeric IDs for nuScenes radars.
 * IDs 10–14 to avoid collision with LiDAR (1) and cameras (1–6).
 */
const RADAR = {
  FRONT: 10,
  FRONT_LEFT: 11,
  FRONT_RIGHT: 12,
  BACK_LEFT: 13,
  BACK_RIGHT: 14,
} as const

/**
 * Maps nuScenes sensor channel strings → numeric IDs used in the pipeline.
 * Channel strings come from sensor.json / sample_data filenames.
 */
export const NUSCENES_CHANNEL_TO_ID: Record<string, number> = {
  'CAM_FRONT_LEFT': CAM.FRONT_LEFT,
  'CAM_FRONT': CAM.FRONT,
  'CAM_FRONT_RIGHT': CAM.FRONT_RIGHT,
  'CAM_BACK_LEFT': CAM.BACK_LEFT,
  'CAM_BACK': CAM.BACK,
  'CAM_BACK_RIGHT': CAM.BACK_RIGHT,
  'LIDAR_TOP': LIDAR.TOP,
  'RADAR_FRONT': RADAR.FRONT,
  'RADAR_FRONT_LEFT': RADAR.FRONT_LEFT,
  'RADAR_FRONT_RIGHT': RADAR.FRONT_RIGHT,
  'RADAR_BACK_LEFT': RADAR.BACK_LEFT,
  'RADAR_BACK_RIGHT': RADAR.BACK_RIGHT,
}

export const nuScenesManifest: DatasetManifest = {
  id: 'nuscenes',
  name: 'nuScenes',

  // Top-level directories recognized in a nuScenes dataset root
  knownComponents: [
    'samples', 'sweeps', 'maps',
    'v1.0-mini', 'v1.0-trainval', 'v1.0-test',
    'LICENSE',
  ],

  // Minimum directories needed to identify a folder as nuScenes data
  requiredComponents: ['samples', 'v1.0-mini'],

  lidarSensors: [
    { id: LIDAR.TOP,        label: 'LIDAR TOP',    color: colors.sensorTop },
    { id: RADAR.FRONT,      label: 'RADAR FRONT',  color: colors.radarFront },
    { id: RADAR.FRONT_LEFT, label: 'RADAR FL',     color: colors.radarFrontLeft },
    { id: RADAR.FRONT_RIGHT,label: 'RADAR FR',     color: colors.radarFrontRight },
    { id: RADAR.BACK_LEFT,  label: 'RADAR BL',     color: colors.radarBackLeft },
    { id: RADAR.BACK_RIGHT, label: 'RADAR BR',     color: colors.radarBackRight },
  ],

  cameraSensors: [
    { id: CAM.BACK_LEFT,    label: 'BACK LEFT',    color: colors.camSideLeft,   width: 1600, height: 900, flex: 1 },
    { id: CAM.FRONT_LEFT,   label: 'FRONT LEFT',   color: colors.camFrontLeft,  width: 1600, height: 900, flex: 1 },
    { id: CAM.FRONT,        label: 'FRONT',         color: colors.camFront,      width: 1600, height: 900, flex: 1.3 },
    { id: CAM.FRONT_RIGHT,  label: 'FRONT RIGHT',  color: colors.camFrontRight, width: 1600, height: 900, flex: 1 },
    { id: CAM.BACK_RIGHT,   label: 'BACK RIGHT',   color: colors.camSideRight,  width: 1600, height: 900, flex: 1 },
    { id: CAM.BACK,         label: 'BACK',          color: colors.accentBlue,    width: 1600, height: 900, flex: 1 },
  ],

  boxTypes: [
    { id: 0, label: 'Unknown', color: '#6B7280' },
    { id: 1, label: 'Vehicle', color: '#FF9E00' },
    { id: 2, label: 'Pedestrian', color: '#CCFF00' },
    { id: 3, label: 'Sign', color: '#FF44FF' },
    { id: 4, label: 'Cyclist', color: '#DC143C' },
  ],

  frameRate: 2,   // nuScenes keyframe rate
  pointStride: 4, // x, y, z, intensity
  colormapModes: ['intensity'], // nuScenes LiDAR only has intensity (no range/elongation)

  cameraColors: {
    [CAM.FRONT]: colors.camFront,
    [CAM.FRONT_LEFT]: colors.camFrontLeft,
    [CAM.FRONT_RIGHT]: colors.camFrontRight,
    [CAM.BACK_LEFT]: colors.camSideLeft,
    [CAM.BACK]: colors.accentBlue,
    [CAM.BACK_RIGHT]: colors.camSideRight,
  },

  cameraPovLabels: {
    [CAM.FRONT]: 'FRONT',
    [CAM.FRONT_LEFT]: 'FL',
    [CAM.FRONT_RIGHT]: 'FR',
    [CAM.BACK_LEFT]: 'BL',
    [CAM.BACK]: 'BACK',
    [CAM.BACK_RIGHT]: 'BR',
  },

  // nuScenes doesn't use Parquet — these are placeholder empty strings.
  // The nuScenes metadata loader reads JSON files directly.
  columnMap: {
    frameTimestamp: '',
    laserName: '',
    rangeImageShape: '',
    rangeImageValues: '',
    vehiclePose: '',
  },
}
