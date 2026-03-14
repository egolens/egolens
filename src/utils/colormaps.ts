/**
 * Colormap definitions, palettes, and color utility functions.
 *
 * Shared by PointCloud (3D renderer), LidarProjectionOverlay (camera overlay),
 * LidarViewer (legend), and future segmentation overlays.
 *
 * Extracted from PointCloud.tsx to avoid a React component exporting pure utilities.
 */

import type { ColormapMode } from '../stores/useSceneStore'

// ---------------------------------------------------------------------------
// Colormap gradient stops  (each array = 6 evenly-spaced RGB stops [0..1])
// ---------------------------------------------------------------------------

/** Cool-tinted white ramp for intensity (dark navy → near-white) */
const INTENSITY_STOPS: [number, number, number][] = [
  [0.08, 0.09, 0.16],  // 0.0 — near-black (dark navy)
  [0.16, 0.20, 0.32],  // ~0.2 — dark slate
  [0.30, 0.38, 0.52],  // ~0.4 — cool gray
  [0.52, 0.60, 0.72],  // ~0.6 — silver blue
  [0.78, 0.84, 0.90],  // ~0.8 — light gray
  [0.95, 0.97, 1.00],  // 1.0 — near-white
]

/** Warm ramp for range (dark → amber → bright yellow) */
const RANGE_STOPS: [number, number, number][] = [
  [0.06, 0.04, 0.12],  // 0.0 — near-black
  [0.28, 0.08, 0.26],  // 0.2 — dark magenta
  [0.60, 0.15, 0.20],  // 0.4 — crimson
  [0.88, 0.40, 0.10],  // 0.6 — orange
  [0.98, 0.72, 0.15],  // 0.8 — amber
  [1.00, 0.98, 0.60],  // 1.0 — bright yellow
]

/** Green ramp for elongation (dark → emerald → bright lime) */
const ELONGATION_STOPS: [number, number, number][] = [
  [0.04, 0.06, 0.10],  // 0.0 — near-black
  [0.06, 0.18, 0.22],  // 0.2 — dark teal
  [0.08, 0.38, 0.30],  // 0.4 — forest
  [0.20, 0.62, 0.35],  // 0.6 — emerald
  [0.50, 0.84, 0.40],  // 0.8 — lime-green
  [0.80, 0.98, 0.55],  // 1.0 — bright lime
]

/**
 * Viridis-inspired ramp for distance (ego center → world).
 * Dark purple (close) → teal → yellow-green (far).
 */
const DISTANCE_STOPS: [number, number, number][] = [
  [0.27, 0.00, 0.33],  // 0.0 — dark purple (close to ego)
  [0.28, 0.17, 0.50],  // 0.2 — indigo
  [0.13, 0.37, 0.56],  // 0.4 — teal blue
  [0.15, 0.56, 0.46],  // 0.6 — teal green
  [0.48, 0.76, 0.24],  // 0.8 — lime green
  [0.99, 0.91, 0.14],  // 1.0 — bright yellow (far from ego)
]

/** All colormap gradient stops indexed by mode.
 *  Modes that use direct palette lookup (segment, panoptic, camera)
 *  still have a placeholder entry so the Record is exhaustive. */
export const COLORMAP_STOPS: Record<ColormapMode, [number, number, number][]> = {
  intensity: INTENSITY_STOPS,
  range: RANGE_STOPS,
  elongation: ELONGATION_STOPS,
  distance: DISTANCE_STOPS,
  segment: INTENSITY_STOPS,  // placeholder — segment mode uses its own palette
  panoptic: INTENSITY_STOPS, // placeholder — panoptic mode uses its own palette
  camera: INTENSITY_STOPS,   // placeholder — camera mode uses per-point RGB
}

// ---------------------------------------------------------------------------
// Attribute extraction helpers
// ---------------------------------------------------------------------------

/** Offset within the POINT_STRIDE-sized record for each attribute.
 *  -1 means the value is computed from xyz (not stored in the buffer). */
export const ATTR_OFFSET: Record<ColormapMode, number> = {
  intensity: 3,   // positions[src + 3]
  range: 4,       // positions[src + 4]
  elongation: 5,  // positions[src + 5]
  distance: -1,   // computed: sqrt(x² + y² + z²)
  segment: -2,    // uses segLabels array (not from positions buffer)
  panoptic: -3,   // uses panopticLabels array (not from positions buffer)
  camera: -4,     // uses cameraRgb array (not from positions buffer)
}

/** Normalization ranges per attribute (min, max) for mapping to 0..1 */
export const ATTR_RANGE: Record<ColormapMode, [number, number]> = {
  intensity: [0, 1],        // already 0..1 in Waymo data
  range: [0, 75],           // meters (max useful range ~75m for visualization)
  elongation: [0, 1],       // already 0..1 in Waymo data
  distance: [0, 50],        // meters from ego center
  segment: [0, 31],         // unused — segment mode uses direct palette lookup
  panoptic: [0, 31],        // unused — panoptic uses direct instance coloring
  camera: [0, 1],           // unused — camera mode uses direct RGB
}

// ---------------------------------------------------------------------------
// nuScenes lidarseg 32-class palette (matches devkit colors)
// ---------------------------------------------------------------------------

/** RGB [0..1] palette indexed by lidarseg label (0–31). Based on nuScenes devkit color_map.py. */
export const LIDARSEG_PALETTE: [number, number, number][] = [
  [0.00, 0.00, 0.00],  //  0 noise (black)
  [0.44, 0.29, 0.00],  //  1 animal
  [0.85, 0.33, 0.10],  //  2 human.pedestrian.adult
  [0.85, 0.55, 0.20],  //  3 human.pedestrian.child
  [1.00, 0.60, 0.00],  //  4 human.pedestrian.construction_worker
  [0.80, 0.32, 0.33],  //  5 human.pedestrian.personal_mobility
  [0.00, 0.53, 0.80],  //  6 human.pedestrian.police_officer
  [0.58, 0.40, 0.11],  //  7 human.pedestrian.stroller
  [0.42, 0.27, 0.07],  //  8 human.pedestrian.wheelchair
  [0.47, 0.47, 0.47],  //  9 movable_object.barrier
  [0.26, 0.20, 0.00],  // 10 movable_object.debris
  [0.39, 0.25, 0.65],  // 11 movable_object.pushable_pullable
  [1.00, 0.58, 0.25],  // 12 movable_object.trafficcone
  [0.87, 0.87, 0.00],  // 13 static_object.bicycle_rack
  [1.00, 0.00, 0.00],  // 14 vehicle.bicycle
  [0.00, 0.00, 0.90],  // 15 vehicle.bus.bendy
  [0.00, 0.00, 0.70],  // 16 vehicle.bus.rigid
  [1.00, 0.62, 0.00],  // 17 vehicle.car
  [0.93, 0.57, 0.13],  // 18 vehicle.construction
  [0.85, 0.10, 0.10],  // 19 vehicle.emergency.ambulance
  [0.00, 0.00, 0.55],  // 20 vehicle.emergency.police
  [0.00, 0.46, 0.86],  // 21 vehicle.motorcycle
  [0.50, 0.35, 0.00],  // 22 vehicle.trailer
  [0.60, 0.00, 1.00],  // 23 vehicle.truck
  [0.63, 0.63, 0.78],  // 24 flat.driveable_surface
  [0.55, 0.42, 0.35],  // 25 flat.other
  [0.47, 0.47, 0.62],  // 26 flat.sidewalk
  [0.40, 0.55, 0.26],  // 27 flat.terrain
  [0.35, 0.35, 0.35],  // 28 static.manmade
  [0.20, 0.20, 0.20],  // 29 static.other
  [0.00, 0.68, 0.12],  // 30 static.vegetation
  [0.64, 0.00, 0.00],  // 31 vehicle.ego
]

/** Short display names for legend (last segment of dotted name) */
export const LIDARSEG_LABELS: string[] = [
  'noise', 'animal', 'adult', 'child', 'constr. worker', 'pers. mobility',
  'police', 'stroller', 'wheelchair', 'barrier', 'debris', 'pushable',
  'traffic cone', 'bike rack', 'bicycle', 'bus (bendy)', 'bus (rigid)',
  'car', 'construction', 'ambulance', 'police car', 'motorcycle',
  'trailer', 'truck', 'driveable', 'other flat', 'sidewalk', 'terrain',
  'manmade', 'other static', 'vegetation', 'ego',
]

// ---------------------------------------------------------------------------
// Colormap interpolation
// ---------------------------------------------------------------------------

/** Interpolate through a gradient stop array. t is clamped to [0, 1]. */
export function colormapColor(stops: [number, number, number][], t: number): [number, number, number] {
  const tc = Math.max(0, Math.min(1, t))
  const idx = tc * (stops.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.min(lo + 1, stops.length - 1)
  const f = idx - lo
  return [
    stops[lo][0] + f * (stops[hi][0] - stops[lo][0]),
    stops[lo][1] + f * (stops[hi][1] - stops[lo][1]),
    stops[lo][2] + f * (stops[hi][2] - stops[lo][2]),
  ]
}

// ---------------------------------------------------------------------------
// Color space conversions
// ---------------------------------------------------------------------------

/** RGB → HSL conversion (r,g,b in [0,1]) → returns [h,s,l] in [0,1] */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]  // achromatic
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

/** HSL → RGB conversion (h,s,l in [0,1]) → returns [r,g,b] in [0,1] */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h * 6) % 2 - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  const sector = Math.floor(h * 6) % 6
  if (sector === 0) { r = c; g = x; b = 0 }
  else if (sector === 1) { r = x; g = c; b = 0 }
  else if (sector === 2) { r = 0; g = c; b = x }
  else if (sector === 3) { r = 0; g = x; b = c }
  else if (sector === 4) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  return [r + m, g + m, b + m]
}

/** sRGB → linear conversion (inverse of the sRGB OETF).
 *  Camera JPEG pixels are sRGB but Three.js vertex colors are linear. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

// ---------------------------------------------------------------------------
// Panoptic instance coloring
// ---------------------------------------------------------------------------

/** Pre-computed HSL values for each semantic class (derived from LIDARSEG_PALETTE). */
const LIDARSEG_HSL: [number, number, number][] = LIDARSEG_PALETTE.map(
  ([r, g, b]) => rgbToHsl(r, g, b),
)

/**
 * Instance-aware coloring: keeps the semantic class hue from the palette,
 * but varies lightness per instance so each object is distinguishable
 * while remaining visually linked to its class color in the legend.
 */
export function instanceColor(semanticLabel: number, instanceId: number): [number, number, number] {
  const base = LIDARSEG_PALETTE[semanticLabel] ?? LIDARSEG_PALETTE[0]
  if (instanceId === 0) {
    // "Stuff" classes (no instance) — use semantic palette directly
    return base
  }
  // "Thing" classes — same hue as palette, vary lightness per instance
  const [h, s] = LIDARSEG_HSL[semanticLabel] ?? LIDARSEG_HSL[0]
  // Golden ratio spread across lightness range [0.30 .. 0.80]
  const GOLDEN_RATIO = 0.618033988749895
  const spread = (instanceId * GOLDEN_RATIO) % 1.0
  const lit = 0.30 + spread * 0.50
  // Boost saturation slightly to keep colors vivid at varying lightness
  const sat = Math.min(1.0, s * 1.2 + 0.1)
  return hslToRgb(h, sat, lit)
}
