/**
 * Waymo Open Dataset v2.0 — 23 semantic segmentation classes.
 *
 * Used by both lidar_segmentation (per-point labels) and camera_segmentation
 * (per-pixel panoptic labels). Class IDs are defined by the Waymo spec and
 * cannot change. Colors are chosen to be visually distinct and consistent
 * with the existing box-type palette where classes overlap (e.g. Car = orange,
 * Pedestrian = lime).
 *
 * This file is the Waymo counterpart of the nuScenes LIDARSEG_PALETTE in
 * colormaps.ts. The correct palette is selected via manifest.semanticPalette.
 */

// ---------------------------------------------------------------------------
// 23-class palette — RGB [0..1], indexed by semantic class ID
// ---------------------------------------------------------------------------

export const WAYMO_SEG_PALETTE: [number, number, number][] = [
  [0.25, 0.25, 0.25],  //  0  Undefined         — dark gray
  [1.00, 0.62, 0.00],  //  1  Car               — orange (matches Vehicle box)
  [0.90, 0.47, 0.00],  //  2  Truck             — darker orange
  [1.00, 0.84, 0.00],  //  3  Bus               — gold
  [0.65, 0.43, 0.15],  //  4  Other Vehicle     — brown
  [0.70, 0.00, 0.15],  //  5  Motorcyclist      — dark crimson
  [0.86, 0.08, 0.24],  //  6  Bicyclist         — crimson (matches Cyclist box)
  [0.80, 1.00, 0.00],  //  7  Pedestrian        — lime (matches Pedestrian box)
  [1.00, 0.27, 1.00],  //  8  Sign              — magenta (matches Sign box)
  [0.00, 0.90, 0.90],  //  9  Traffic Light     — cyan
  [0.60, 0.30, 0.90],  // 10  Pole              — purple
  [1.00, 0.40, 0.70],  // 11  Construction Cone — hot pink
  [1.00, 0.42, 0.62],  // 12  Bicycle           — pink-red
  [0.85, 0.10, 0.10],  // 13  Motorcycle        — red
  [0.45, 0.55, 0.70],  // 14  Building          — steel blue
  [0.10, 0.72, 0.20],  // 15  Vegetation        — green
  [0.35, 0.50, 0.20],  // 16  Tree Trunk        — olive
  [0.50, 0.50, 0.50],  // 17  Curb              — medium gray
  [0.40, 0.40, 0.55],  // 18  Road              — blue-gray
  [0.55, 0.70, 1.00],  // 19  Lane Marker       — light blue
  [0.60, 0.55, 0.40],  // 20  Other Ground      — earth gray
  [0.82, 0.75, 0.60],  // 21  Walkable          — tan
  [0.55, 0.55, 0.65],  // 22  Sidewalk          — cool gray
]

// ---------------------------------------------------------------------------
// Human-readable labels indexed by class ID
// ---------------------------------------------------------------------------

export const WAYMO_SEG_LABELS: string[] = [
  'Undefined',         //  0
  'Car',               //  1
  'Truck',             //  2
  'Bus',               //  3
  'Other Vehicle',     //  4
  'Motorcyclist',      //  5
  'Bicyclist',         //  6
  'Pedestrian',        //  7
  'Sign',              //  8
  'Traffic Light',     //  9
  'Pole',              // 10
  'Construction Cone', // 11
  'Bicycle',           // 12
  'Motorcycle',        // 13
  'Building',          // 14
  'Vegetation',        // 15
  'Tree Trunk',        // 16
  'Curb',              // 17
  'Road',              // 18
  'Lane Marker',       // 19
  'Other Ground',      // 20
  'Walkable',          // 21
  'Sidewalk',          // 22
]

// ---------------------------------------------------------------------------
// 29-class Camera Segmentation palette — RGB [0..1], indexed by class ID
// Camera segmentation uses a DIFFERENT class scheme than LiDAR (29 vs 23).
// See: waymo.proto CameraSegmentation.Type
// ---------------------------------------------------------------------------

export const WAYMO_CAMERA_SEG_PALETTE: [number, number, number][] = [
  [0.25, 0.25, 0.25],  //  0  Undefined           — dark gray
  [1.00, 0.62, 0.00],  //  1  Car                 — orange (matches Vehicle box)
  [1.00, 0.84, 0.00],  //  2  Bus                 — gold
  [0.90, 0.47, 0.00],  //  3  Truck               — darker orange
  [0.65, 0.43, 0.15],  //  4  Other Large Vehicle — brown
  [0.75, 0.55, 0.25],  //  5  Trailer             — tan-brown
  [0.40, 0.40, 0.40],  //  6  Ego Vehicle         — medium gray
  [0.85, 0.10, 0.10],  //  7  Motorcycle          — red
  [1.00, 0.42, 0.62],  //  8  Bicycle             — pink-red
  [0.80, 1.00, 0.00],  //  9  Pedestrian          — lime (matches Pedestrian box)
  [0.70, 0.00, 0.15],  // 10  Motorcyclist        — dark crimson
  [0.86, 0.08, 0.24],  // 11  Bicyclist           — crimson
  [0.45, 0.80, 0.20],  // 12  Ground Animal       — forest green
  [0.60, 0.85, 0.95],  // 13  Bird                — sky blue
  [0.40, 0.40, 0.55],  // 14  Road                — blue-gray
  [0.55, 0.70, 1.00],  // 15  Lane Marker         — light blue
  [0.50, 0.50, 0.50],  // 16  Curb                — medium gray
  [0.82, 0.75, 0.60],  // 17  Walkable            — tan
  [0.55, 0.55, 0.65],  // 18  Sidewalk            — cool gray
  [0.45, 0.55, 0.70],  // 19  Building            — steel blue
  [0.60, 0.30, 0.90],  // 20  Pole                — purple
  [1.00, 0.27, 1.00],  // 21  Sign                — magenta
  [0.00, 0.90, 0.90],  // 22  Traffic Light       — cyan
  [1.00, 0.40, 0.70],  // 23  Construction Cone   — hot pink
  [0.10, 0.72, 0.20],  // 24  Vegetation          — green
  [0.70, 0.85, 0.95],  // 25  Sky                 — pale sky blue (camera-only!)
  [0.50, 0.45, 0.35],  // 26  Ground              — earth brown
  [0.35, 0.35, 0.45],  // 27  Static              — dark blue-gray
  [0.75, 0.60, 0.45],  // 28  Dynamic             — warm tan
]

export const WAYMO_CAMERA_SEG_LABELS: string[] = [
  'Undefined',           //  0
  'Car',                 //  1
  'Bus',                 //  2
  'Truck',               //  3
  'Other Large Vehicle', //  4
  'Trailer',             //  5
  'Ego Vehicle',         //  6
  'Motorcycle',          //  7
  'Bicycle',             //  8
  'Pedestrian',          //  9
  'Motorcyclist',        // 10
  'Bicyclist',           // 11
  'Ground Animal',       // 12
  'Bird',                // 13
  'Road',                // 14
  'Lane Marker',         // 15
  'Curb',                // 16
  'Walkable',            // 17
  'Sidewalk',            // 18
  'Building',            // 19
  'Pole',                // 20
  'Sign',                // 21
  'Traffic Light',       // 22
  'Construction Cone',   // 23
  'Vegetation',          // 24
  'Sky',                 // 25
  'Ground',              // 26
  'Static',              // 27
  'Dynamic',             // 28
]

// ---------------------------------------------------------------------------
// 14 keypoint types + skeleton bone connections
// Values from keypoint.proto: waymo.open_dataset.keypoints.KeypointType
// ---------------------------------------------------------------------------

/**
 * Waymo KeypointType proto enum → human-readable label.
 * Sparse map because proto enum values are NOT contiguous (0,1,5-10,13-20).
 */
export const WAYMO_KEYPOINT_LABELS: Record<number, string> = {
  0:  'Unspecified',
  1:  'Nose',
  5:  'Left Shoulder',
  6:  'Left Elbow',
  7:  'Left Wrist',
  8:  'Left Hip',
  9:  'Left Knee',
  10: 'Left Ankle',
  13: 'Right Shoulder',
  14: 'Right Elbow',
  15: 'Right Wrist',
  16: 'Right Hip',
  17: 'Right Knee',
  18: 'Right Ankle',
  19: 'Forehead',
  20: 'Head Center',
}

/** Proto enum constants for KeypointType */
export const KP = {
  NOSE: 1,
  L_SHOULDER: 5,
  L_ELBOW: 6,
  L_WRIST: 7,
  L_HIP: 8,
  L_KNEE: 9,
  L_ANKLE: 10,
  R_SHOULDER: 13,
  R_ELBOW: 14,
  R_WRIST: 15,
  R_HIP: 16,
  R_KNEE: 17,
  R_ANKLE: 18,
  FOREHEAD: 19,
  HEAD_CENTER: 20,
} as const

/**
 * Per-joint colors for colorful skeleton rendering (Waymo reference style).
 * Returns [r, g, b] in 0..1 range.
 */
export const WAYMO_KEYPOINT_COLORS: Record<number, [number, number, number]> = {
  [KP.NOSE]:        [0.00, 1.00, 0.00],  // green
  [KP.HEAD_CENTER]: [0.00, 0.80, 0.80],  // cyan
  [KP.FOREHEAD]:    [0.00, 0.90, 0.70],  // teal
  [KP.L_SHOULDER]:  [1.00, 0.85, 0.00],  // yellow
  [KP.R_SHOULDER]:  [0.00, 0.60, 1.00],  // blue
  [KP.L_ELBOW]:     [1.00, 0.55, 0.00],  // orange
  [KP.R_ELBOW]:     [0.20, 0.40, 1.00],  // dark blue
  [KP.L_WRIST]:     [1.00, 0.30, 0.00],  // dark orange
  [KP.R_WRIST]:     [0.40, 0.20, 1.00],  // indigo
  [KP.L_HIP]:       [0.80, 1.00, 0.00],  // lime-yellow
  [KP.R_HIP]:       [1.00, 0.00, 1.00],  // magenta
  [KP.L_KNEE]:      [0.60, 0.90, 0.00],  // yellow-green
  [KP.R_KNEE]:      [1.00, 0.00, 0.60],  // hot pink
  [KP.L_ANKLE]:     [0.40, 0.80, 0.00],  // green
  [KP.R_ANKLE]:     [1.00, 0.20, 0.40],  // red-pink
}

/**
 * Per-bone colors — each bone inherits a blend or uses the "from" joint color.
 */
export const WAYMO_BONE_COLORS: Record<string, [number, number, number]> = {
  // Head
  [`${KP.NOSE}-${KP.L_SHOULDER}`]:  [0.50, 0.93, 0.00],
  [`${KP.NOSE}-${KP.R_SHOULDER}`]:  [0.00, 0.80, 0.50],
  [`${KP.HEAD_CENTER}-${KP.NOSE}`]: [0.00, 0.90, 0.40],
  // Left arm — warm
  [`${KP.L_SHOULDER}-${KP.L_ELBOW}`]: [1.00, 0.70, 0.00],
  [`${KP.L_ELBOW}-${KP.L_WRIST}`]:   [1.00, 0.42, 0.00],
  // Right arm — cool
  [`${KP.R_SHOULDER}-${KP.R_ELBOW}`]: [0.10, 0.50, 1.00],
  [`${KP.R_ELBOW}-${KP.R_WRIST}`]:   [0.30, 0.30, 1.00],
  // Torso — pink/purple
  [`${KP.L_SHOULDER}-${KP.R_SHOULDER}`]: [0.50, 0.50, 1.00],
  [`${KP.L_SHOULDER}-${KP.L_HIP}`]:     [0.90, 0.90, 0.00],
  [`${KP.R_SHOULDER}-${KP.R_HIP}`]:     [0.50, 0.00, 1.00],
  [`${KP.L_HIP}-${KP.R_HIP}`]:          [0.90, 0.00, 0.80],
  // Left leg — warm
  [`${KP.L_HIP}-${KP.L_KNEE}`]:   [0.70, 0.95, 0.00],
  [`${KP.L_KNEE}-${KP.L_ANKLE}`]: [0.50, 0.85, 0.00],
  // Right leg — cool
  [`${KP.R_HIP}-${KP.R_KNEE}`]:   [1.00, 0.00, 0.80],
  [`${KP.R_KNEE}-${KP.R_ANKLE}`]: [1.00, 0.10, 0.50],
}

/**
 * Skeleton bone connections as [fromType, toType] pairs.
 * Uses Waymo proto KeypointType enum values directly.
 */
export const WAYMO_SKELETON_BONES: [number, number][] = [
  // Head → shoulders
  [KP.NOSE, KP.L_SHOULDER],       // Nose → Left Shoulder
  [KP.NOSE, KP.R_SHOULDER],       // Nose → Right Shoulder
  [KP.HEAD_CENTER, KP.NOSE],      // Head Center → Nose
  // Left arm
  [KP.L_SHOULDER, KP.L_ELBOW],    // Left Shoulder → Left Elbow
  [KP.L_ELBOW, KP.L_WRIST],       // Left Elbow → Left Wrist
  // Right arm
  [KP.R_SHOULDER, KP.R_ELBOW],    // Right Shoulder → Right Elbow
  [KP.R_ELBOW, KP.R_WRIST],       // Right Elbow → Right Wrist
  // Torso
  [KP.L_SHOULDER, KP.R_SHOULDER], // Left Shoulder → Right Shoulder
  [KP.L_SHOULDER, KP.L_HIP],      // Left Shoulder → Left Hip
  [KP.R_SHOULDER, KP.R_HIP],      // Right Shoulder → Right Hip
  [KP.L_HIP, KP.R_HIP],           // Left Hip → Right Hip (pelvis)
  // Left leg
  [KP.L_HIP, KP.L_KNEE],          // Left Hip → Left Knee
  [KP.L_KNEE, KP.L_ANKLE],        // Left Knee → Left Ankle
  // Right leg
  [KP.R_HIP, KP.R_KNEE],          // Right Hip → Right Knee
  [KP.R_KNEE, KP.R_ANKLE],        // Right Knee → Right Ankle
]

/** Kept for backwards compatibility with tests — maps 0-based index to label */
export const WAYMO_KEYPOINT_TYPES: string[] = [
  'Nose', 'Left Shoulder', 'Right Shoulder', 'Left Elbow', 'Right Elbow',
  'Left Wrist', 'Right Wrist', 'Left Hip', 'Right Hip', 'Left Knee',
  'Right Knee', 'Left Ankle', 'Right Ankle', 'Head Center',
]
