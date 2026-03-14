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
  [0.85, 0.10, 0.10],  //  5  Motorcycle        — red
  [1.00, 0.42, 0.62],  //  6  Bicycle           — pink-red
  [0.25, 0.25, 0.25],  //  7  (reserved)        — dark gray
  [0.70, 0.00, 0.15],  //  8  Motorcyclist      — dark crimson
  [0.86, 0.08, 0.24],  //  9  Bicyclist         — crimson (matches Cyclist box)
  [0.80, 1.00, 0.00],  // 10  Pedestrian        — lime (matches Pedestrian box)
  [1.00, 0.27, 1.00],  // 11  Sign              — magenta (matches Sign box)
  [0.00, 0.90, 0.90],  // 12  Traffic Light     — cyan
  [0.50, 0.50, 0.50],  // 13  Curb              — medium gray
  [0.40, 0.40, 0.55],  // 14  Road              — blue-gray
  [0.55, 0.70, 1.00],  // 15  Lane Marker       — light blue
  [0.60, 0.30, 0.90],  // 16  Pole              — purple
  [1.00, 0.40, 0.70],  // 17  Construction Cone — hot pink
  [0.45, 0.55, 0.70],  // 18  Building          — steel blue
  [0.10, 0.72, 0.20],  // 19  Vegetation        — green
  [0.35, 0.50, 0.20],  // 20  Tree Trunk        — olive
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
  'Motorcycle',        //  5
  'Bicycle',           //  6
  '(reserved)',        //  7
  'Motorcyclist',      //  8
  'Bicyclist',         //  9
  'Pedestrian',        // 10
  'Sign',              // 11
  'Traffic Light',     // 12
  'Curb',              // 13
  'Road',              // 14
  'Lane Marker',       // 15
  'Pole',              // 16
  'Construction Cone', // 17
  'Building',          // 18
  'Vegetation',        // 19
  'Tree Trunk',        // 20
  'Walkable',          // 21
  'Sidewalk',          // 22
]

// ---------------------------------------------------------------------------
// 14 keypoint types + skeleton bone connections
// ---------------------------------------------------------------------------

export const WAYMO_KEYPOINT_TYPES: string[] = [
  'Nose',           //  0
  'Left Shoulder',  //  1
  'Right Shoulder', //  2
  'Left Elbow',     //  3
  'Right Elbow',    //  4
  'Left Wrist',     //  5
  'Right Wrist',    //  6
  'Left Hip',       //  7 — note: plan doc has inconsistent ordering, using Waymo spec
  'Right Hip',      //  8
  'Left Knee',      //  9
  'Right Knee',     // 10
  'Left Ankle',     // 11
  'Right Ankle',    // 12
  'Head Center',    // 13
]

/**
 * Skeleton bone connections as [fromIndex, toIndex] pairs.
 * Defines the human body topology for rendering lines between keypoints.
 */
export const WAYMO_SKELETON_BONES: [number, number][] = [
  // Head → shoulders
  [0, 1],   // Nose → Left Shoulder
  [0, 2],   // Nose → Right Shoulder
  // Left arm
  [1, 3],   // Left Shoulder → Left Elbow
  [3, 5],   // Left Elbow → Left Wrist
  // Right arm
  [2, 4],   // Right Shoulder → Right Elbow
  [4, 6],   // Right Elbow → Right Wrist
  // Torso
  [1, 2],   // Left Shoulder → Right Shoulder
  [1, 7],   // Left Shoulder → Left Hip
  [2, 8],   // Right Shoulder → Right Hip
  [7, 8],   // Left Hip → Right Hip (pelvis)
  // Left leg
  [7, 9],   // Left Hip → Left Knee
  [9, 11],  // Left Knee → Left Ankle
  // Right leg
  [8, 10],  // Right Hip → Right Knee
  [10, 12], // Right Knee → Right Ankle
]
