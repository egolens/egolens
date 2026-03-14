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
