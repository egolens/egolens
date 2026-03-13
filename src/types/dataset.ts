/**
 * Dataset-agnostic type definitions.
 *
 * Every dataset adapter produces a DatasetManifest that tells the UI
 * how many sensors exist, what they're called, and how to color them.
 * Components read the manifest instead of hard-coding sensor lists.
 */

// ---------------------------------------------------------------------------
// Sensor definitions
// ---------------------------------------------------------------------------

export interface SensorDef {
  /** Numeric ID used as map key throughout the pipeline */
  id: number
  /** Short display label (e.g. "TOP", "FRONT") */
  label: string
  /** CSS color for per-sensor coloring in 3D view and UI toggles */
  color: string
}

export interface CameraSensorDef extends SensorDef {
  /** Native image width in pixels */
  width: number
  /** Native image height in pixels */
  height: number
  /** Relative flex weight for panel sizing (larger = wider panel) */
  flex?: number
}

export interface BoxTypeDef {
  id: number
  label: string
  color: string
}

// ---------------------------------------------------------------------------
// Trajectory point (used by both adapters)
// ---------------------------------------------------------------------------

export interface TrajectoryPoint {
  frameIndex: number
  x: number
  y: number
  z: number
  type: number
}

// ---------------------------------------------------------------------------
// Metadata bundle — unified output of any adapter's loadMetadata()
// ---------------------------------------------------------------------------

/**
 * Everything a dataset adapter loads during the "startup data" phase.
 * The store unpacks this into its internal structures without knowing
 * which Parquet columns, JSON tables, or file formats were used.
 */
export interface MetadataBundle {
  /** Sorted frame timestamps (master frame list) */
  timestamps: bigint[]
  /** Reverse lookup: timestamp → frame index */
  timestampToFrame: Map<bigint, number>

  /** Vehicle pose rows grouped by timestamp */
  vehiclePoseByFrame: Map<unknown, import('../utils/merge').ParquetRow[]>
  /** Inverse of frame 0's world_from_vehicle matrix */
  worldOriginInverse: number[] | null
  /** Relative pose per frame index (inv(pose0) × poseN) */
  poseByFrameIndex: Map<number, number[]>

  /** LiDAR calibrations keyed by sensor ID */
  lidarCalibrations: Map<number, import('../utils/rangeImage').LidarCalibration>
  /** Camera calibration rows (raw — consumed by parseCameraCalibrations) */
  cameraCalibrations: import('../utils/merge').ParquetRow[]

  /** 3D lidar boxes grouped by timestamp */
  lidarBoxByFrame: Map<unknown, import('../utils/merge').ParquetRow[]>
  /** 2D camera boxes grouped by timestamp */
  cameraBoxByFrame: Map<unknown, import('../utils/merge').ParquetRow[]>

  /** Object trajectory index: objectId → sorted positions */
  objectTrajectories: Map<string, TrajectoryPoint[]>

  /** Association: camera_object_id → laser_object_id */
  assocCamToLaser: Map<string, string>
  /** Association: laser_object_id → Set<camera_object_id> */
  assocLaserToCams: Map<string, Set<string>>

  /** Whether box data is available (false for test sets) */
  hasBoxData: boolean
  /** Segment metadata (time of day, location, weather, counts) */
  segmentMeta: import('../types/waymo').SegmentMeta | null
}

// ---------------------------------------------------------------------------
// Dataset manifest
// ---------------------------------------------------------------------------

export interface DatasetManifest {
  /** Machine identifier: 'waymo' | 'nuscenes' | ... */
  id: string
  /** Human-readable name shown in the header */
  name: string

  // -- Dataset detection --------------------------------------------------

  /**
   * All component directory names recognized by this dataset format.
   * Used by folder scanning to accept directories (replaces hard-coded lists).
   * e.g. Waymo: ['vehicle_pose', 'lidar', 'camera_image', ...]
   * e.g. nuScenes: ['samples', 'sweeps', 'v1.0-mini', ...]
   */
  knownComponents: string[]

  /**
   * Minimum set of components that MUST be present to identify this dataset.
   * `detectDataset()` checks that every required component exists in the
   * scanned directory entries before declaring a match.
   */
  requiredComponents: string[]

  // -- Sensor / UI config -------------------------------------------------

  /** LiDAR sensors available in this dataset */
  lidarSensors: SensorDef[]
  /** Camera sensors available in this dataset */
  cameraSensors: CameraSensorDef[]
  /** Object class types with display colors */
  boxTypes: BoxTypeDef[]
  /** Nominal frame rate in Hz (10 for Waymo keyframes, 2 for nuScenes) */
  frameRate: number
  /** Per-sensor colormap for 3D frustum / UI accents (cameraId → color) */
  cameraColors: Record<number, string>
  /** POV label shown when a camera is active (cameraId → short name) */
  cameraPovLabels: Record<number, string>

  // -- Parquet column mapping -----------------------------------------------

  /**
   * Maps logical field names to actual Parquet column paths.
   * The store and workers reference these keys instead of hard-coding
   * dataset-specific column names like '[VehiclePoseComponent].world_from_vehicle.transform'.
   */
  columnMap: {
    /** Frame timestamp key (used across all components) */
    frameTimestamp: string
    /** LiDAR sensor ID key */
    laserName: string
    /** Range image shape column */
    rangeImageShape: string
    /** Range image values column */
    rangeImageValues: string
    /** Vehicle pose (4×4 row-major transform) column */
    vehiclePose: string
  }
}
