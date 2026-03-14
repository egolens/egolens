/**
 * Shared worker message types — dataset-agnostic protocol.
 *
 * Both LiDAR and Camera workers follow the same lifecycle:
 *   main → worker:  init (dataset-specific payload)
 *   worker → main:  ready { numBatches }
 *   main → worker:  loadBatch { batchIndex }
 *   worker → main:  batchReady { frames[] }
 *
 * "Batch" is an abstract unit: Waymo maps it to a Parquet row group (~51 frames),
 * nuScenes will map it to a group of N per-frame files.
 */

// ---------------------------------------------------------------------------
// Base init — common fields shared by all worker init messages
// ---------------------------------------------------------------------------

export interface WorkerInitBase {
  type: 'init'
  /** Worker index within the pool (for logging) */
  workerIndex?: number
  /** Enable memory logging in this worker */
  enableMemLog?: boolean
}

// ---------------------------------------------------------------------------
// LiDAR worker messages
// ---------------------------------------------------------------------------

/** Per-sensor point cloud within a frame */
export interface SensorCloudResult {
  laserName: number
  positions: Float32Array
  pointCount: number
  /** Per-point semantic segmentation labels (uint8, 0–31). nuScenes lidarseg only. */
  segLabels?: Uint8Array
  /** Per-point panoptic labels (uint16, encoded as category_id*1000 + instance_id). nuScenes panoptic only. */
  panopticLabels?: Uint16Array
  /** Per-point camera projection: [camName, pixelX, pixelY] × pointCount. Waymo lidar_camera_projection. */
  cameraProjection?: Int16Array
  /** Per-point range image pixel index (row*W+col). Used for seg label matching in worker. */
  validIndices?: Uint32Array
}

/** A single converted LiDAR frame within a batch */
export interface LidarFrameResult {
  /** bigint timestamp serialized as string (postMessage can't transfer bigint) */
  timestamp: string
  /** Per-sensor point clouds */
  sensorClouds: SensorCloudResult[]
  /** Conversion time in ms (0 if no conversion needed, e.g. nuScenes) */
  convertMs: number
}

export interface LidarBatchRequest {
  type: 'loadBatch'
  requestId: number
  batchIndex: number
}

export interface LidarBatchResult {
  type: 'batchReady'
  requestId: number
  batchIndex: number
  frames: LidarFrameResult[]
  /** Total decompression + conversion time for the entire batch */
  totalMs: number
}

export interface LidarWorkerReady {
  type: 'ready'
  /** Number of batches available (row groups for Waymo, frame groups for nuScenes) */
  numBatches: number
}

export interface LidarWorkerError {
  type: 'error'
  requestId?: number
  message: string
}

export type LidarWorkerResponse = LidarWorkerReady | LidarBatchResult | LidarWorkerError

// ---------------------------------------------------------------------------
// Camera worker messages
// ---------------------------------------------------------------------------

/** A single camera image within a frame */
export interface CameraImageResult {
  cameraName: number
  jpeg: ArrayBuffer
}

/** A single frame's camera images within a batch */
export interface CameraFrameResult {
  /** bigint timestamp serialized as string */
  timestamp: string
  images: CameraImageResult[]
}

export interface CameraBatchRequest {
  type: 'loadBatch'
  requestId: number
  batchIndex: number
}

export interface CameraBatchResult {
  type: 'batchReady'
  requestId: number
  batchIndex: number
  frames: CameraFrameResult[]
  totalMs: number
}

export interface CameraWorkerReady {
  type: 'ready'
  numBatches: number
}

export interface CameraWorkerError {
  type: 'error'
  requestId?: number
  message: string
}

export type CameraWorkerResponse = CameraWorkerReady | CameraBatchResult | CameraWorkerError
