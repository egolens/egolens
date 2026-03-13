/**
 * Waymo Open Dataset v2.0 — dataset manifest.
 *
 * Single source of truth for Waymo sensor configuration, box types,
 * and display parameters. UI components read this instead of hard-coding
 * sensor names and camera layouts.
 */

import { colors } from '../../theme'
import type { DatasetManifest } from '../../types/dataset'

export const waymoManifest: DatasetManifest = {
  id: 'waymo',
  name: 'Waymo Open Dataset',

  // All Waymo v2 component directory names (accepted during folder scan)
  knownComponents: [
    'vehicle_pose', 'lidar_calibration', 'camera_calibration',
    'lidar_box', 'lidar', 'camera_image', 'stats',
    'lidar_pose', 'lidar_camera_projection', 'camera_box',
    'projected_lidar_box', 'lidar_segmentation', 'camera_segmentation',
    'lidar_hkp', 'camera_hkp', 'lidar_camera_synced_box',
    'camera_to_lidar_box_association',
  ],

  // Minimum components needed to identify a folder as Waymo data
  requiredComponents: ['vehicle_pose', 'lidar', 'camera_image'],

  lidarSensors: [
    { id: 1, label: 'TOP', color: colors.sensorTop },
    { id: 2, label: 'FRONT', color: colors.sensorFront },
    { id: 3, label: 'SIDE_L', color: colors.sensorSideL },
    { id: 4, label: 'SIDE_R', color: colors.sensorSideR },
    { id: 5, label: 'REAR', color: colors.sensorRear },
  ],

  cameraSensors: [
    { id: 4, label: 'SIDE LEFT', color: colors.camSideLeft, width: 1920, height: 886, flex: 1 },
    { id: 2, label: 'FRONT LEFT', color: colors.camFrontLeft, width: 1920, height: 1280, flex: 1 },
    { id: 1, label: 'FRONT', color: colors.camFront, width: 1920, height: 1280, flex: 1.3 },
    { id: 3, label: 'FRONT RIGHT', color: colors.camFrontRight, width: 1920, height: 1280, flex: 1 },
    { id: 5, label: 'SIDE RIGHT', color: colors.camSideRight, width: 1920, height: 886, flex: 1 },
  ],

  boxTypes: [
    { id: 0, label: 'Unknown', color: '#6B7280' },
    { id: 1, label: 'Vehicle', color: '#FF9E00' },
    { id: 2, label: 'Pedestrian', color: '#CCFF00' },
    { id: 3, label: 'Sign', color: '#FF44FF' },
    { id: 4, label: 'Cyclist', color: '#DC143C' },
  ],

  frameRate: 10,
  pointStride: 6, // x, y, z, intensity, range, elongation
  colormapModes: ['intensity', 'range', 'elongation'],

  cameraColors: {
    1: colors.camFront,
    2: colors.camFrontLeft,
    3: colors.camFrontRight,
    4: colors.camSideLeft,
    5: colors.camSideRight,
  },

  cameraPovLabels: {
    1: 'FRONT',
    2: 'FL',
    3: 'FR',
    4: 'SL',
    5: 'SR',
  },

  columnMap: {
    frameTimestamp: 'key.frame_timestamp_micros',
    laserName: 'key.laser_name',
    rangeImageShape: '[LiDARComponent].range_image_return1.shape',
    rangeImageValues: '[LiDARComponent].range_image_return1.values',
    vehiclePose: '[VehiclePoseComponent].world_from_vehicle.transform',
  },
}
