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
// Dataset manifest
// ---------------------------------------------------------------------------

export interface DatasetManifest {
  /** Machine identifier: 'waymo' | 'nuscenes' | ... */
  id: string
  /** Human-readable name shown in the header */
  name: string
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
}
