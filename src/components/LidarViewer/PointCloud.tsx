/**
 * PointCloud renderer — single draw call for ~168K points.
 *
 * Supports per-sensor visibility toggle via store's visibleSensors set.
 * Always merges from per-sensor clouds in useFrame (no pre-merged buffer
 * is cached, saving ~772 MB for a 199-frame segment — see OPT-004).
 *
 * Colormap modes: intensity (default), range, elongation.
 * When sensors are filtered, per-sensor coloring overrides colormap.
 */

import { useRef, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useSceneStore } from '../../stores/useSceneStore'
import type { ColormapMode } from '../../stores/useSceneStore'
import { getManifest } from '../../adapters/registry'
import { parseCameraCalibrations } from '../../utils/cameraCalibration'

// ---------------------------------------------------------------------------
// Colormaps
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
 * Matches nuScenes devkit's default distance-based coloring.
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

const COLORMAP_STOPS: Record<ColormapMode, [number, number, number][]> = {
  intensity: INTENSITY_STOPS,
  range: RANGE_STOPS,
  elongation: ELONGATION_STOPS,
  distance: DISTANCE_STOPS,
  segment: INTENSITY_STOPS, // placeholder — segment mode uses its own palette
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

function colormapColor(stops: [number, number, number][], t: number): [number, number, number] {
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
// Attribute extraction helpers
// ---------------------------------------------------------------------------

/** Offset within the POINT_STRIDE-sized record for each attribute.
 *  -1 means the value is computed from xyz (not stored in the buffer). */
const ATTR_OFFSET: Record<ColormapMode, number> = {
  intensity: 3,   // positions[src + 3]
  range: 4,       // positions[src + 4]
  elongation: 5,  // positions[src + 5]
  distance: -1,   // computed: sqrt(x² + y² + z²)
  segment: -2,    // uses segLabels array (not from positions buffer)
}

/** Normalization ranges per attribute (min, max) for mapping to 0..1 */
const ATTR_RANGE: Record<ColormapMode, [number, number]> = {
  intensity: [0, 1],        // already 0..1 in Waymo data
  range: [0, 75],           // meters (max useful range ~75m for visualization)
  elongation: [0, 1],       // already 0..1 in Waymo data
  distance: [0, 50],        // meters from ego center (devkit uses ~50m typical urban range)
  segment: [0, 31],         // 32 classes (unused — segment mode uses direct palette lookup)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Maximum points we'll ever allocate buffers for (avoids realloc). */
const MAX_POINTS = 400_000
/** Maximum radar points (5 sensors × ~100 pts each). */
const MAX_RADAR_POINTS = 2_000
/** Radar sensor IDs start at 10 (see nuScenes manifest). */
const RADAR_SENSOR_ID_MIN = 10

/** Velocity colormap: blue (static, 0 m/s) → cyan → green → yellow → red (fast, 15+ m/s) */
const VELOCITY_STOPS: [number, number, number][] = [
  [0.15, 0.30, 0.80],  // 0.0 — blue (static)
  [0.10, 0.70, 0.85],  // 0.25 — cyan
  [0.20, 0.85, 0.35],  // 0.5 — green
  [0.95, 0.85, 0.15],  // 0.75 — yellow
  [0.95, 0.25, 0.15],  // 1.0 — red (fast)
]
/** Max speed for normalization (m/s). ~15 m/s ≈ 54 km/h covers most urban traffic. */
const VELOCITY_MAX = 15

// ---------------------------------------------------------------------------
// POV frustum culling — hide points inside the active camera's view cone
// ---------------------------------------------------------------------------

/** Precomputed inverse camera transform + frustum half-tangents for fast per-point test */
interface FrustumCuller {
  /** 3×3 inverse rotation matrix (vehicle → camera optical frame), row-major */
  invR: [number, number, number, number, number, number, number, number, number]
  /** Camera position in vehicle frame */
  cx: number; cy: number; cz: number
  /** Half-tangent of horizontal & vertical FOV */
  tanH: number; tanV: number
}

/** Minimum Z in camera space to start culling (avoids clipping points behind camera) */
const CULL_NEAR = 0.5
/** Maximum Z — only cull nearby points so distant scenery stays visible during POV */
const CULL_FAR = 20

/** Build culler from a CameraCalib. Returns null if activeCam is null. */
function buildFrustumCuller(
  cameraCalibrations: any[],
  activeCam: number | null,
): FrustumCuller | null {
  if (activeCam === null || cameraCalibrations.length === 0) return null
  const calibMap = parseCameraCalibrations(cameraCalibrations)
  const calib = calibMap.get(activeCam)
  if (!calib) return null

  // Inverse quaternion: camera optical → vehicle  ⇒  vehicle → camera optical
  const qInv = calib.quaternion.clone().invert()
  const m = new THREE.Matrix4().makeRotationFromQuaternion(qInv)
  const e = m.elements // column-major
  const invR: FrustumCuller['invR'] = [
    e[0], e[4], e[8],
    e[1], e[5], e[9],
    e[2], e[6], e[10],
  ]

  return {
    invR,
    cx: calib.position.x, cy: calib.position.y, cz: calib.position.z,
    tanH: Math.tan(calib.hFov / 2),
    tanV: Math.tan(calib.vFov / 2),
  }
}

/** Returns true if point (px,py,pz) in vehicle frame is inside the camera frustum */
function insideFrustum(c: FrustumCuller, px: number, py: number, pz: number): boolean {
  // Translate to camera origin
  const dx = px - c.cx
  const dy = py - c.cy
  const dz = pz - c.cz
  // Rotate to camera optical frame (X=right, Y=down, Z=forward)
  const camZ = c.invR[6] * dx + c.invR[7] * dy + c.invR[8] * dz
  if (camZ < CULL_NEAR || camZ > CULL_FAR) return false
  const camX = c.invR[0] * dx + c.invR[1] * dy + c.invR[2] * dz
  if (Math.abs(camX) > camZ * c.tanH) return false
  const camY = c.invR[3] * dx + c.invR[4] * dy + c.invR[5] * dz
  if (Math.abs(camY) > camZ * c.tanV) return false
  return true
}

export default function PointCloud() {
  const pointOpacity = useSceneStore((s) => s.pointOpacity)
  const geometryRef = useRef<THREE.BufferGeometry>(null)
  const radarGeometryRef = useRef<THREE.BufferGeometry>(null)

  // Pre-allocate position & color buffers once (LiDAR)
  const { posAttr, colorAttr } = useMemo(() => {
    const pos = new THREE.Float32BufferAttribute(new Float32Array(MAX_POINTS * 3), 3)
    const col = new THREE.Float32BufferAttribute(new Float32Array(MAX_POINTS * 3), 3)
    pos.setUsage(THREE.DynamicDrawUsage)
    col.setUsage(THREE.DynamicDrawUsage)
    return { posAttr: pos, colorAttr: col }
  }, [])

  // Pre-allocate radar buffers (separate for larger point rendering)
  const { radarPosAttr, radarColorAttr } = useMemo(() => {
    const pos = new THREE.Float32BufferAttribute(new Float32Array(MAX_RADAR_POINTS * 3), 3)
    const col = new THREE.Float32BufferAttribute(new Float32Array(MAX_RADAR_POINTS * 3), 3)
    pos.setUsage(THREE.DynamicDrawUsage)
    col.setUsage(THREE.DynamicDrawUsage)
    return { radarPosAttr: pos, radarColorAttr: col }
  }, [])

  // Dirty flag — set synchronously by Zustand subscribe (no React timing dependency)
  const dirtyRef = useRef(true)

  useEffect(() => {
    // Track previous values to detect relevant changes only
    const s0 = useSceneStore.getState()
    const prev = {
      frame: s0.currentFrame,
      sensors: s0.visibleSensors,
      cmap: s0.colormapMode,
      world: s0.worldMode,
      cam: s0.activeCam,
    }
    return useSceneStore.subscribe((state) => {
      if (state.currentFrame !== prev.frame ||
          state.visibleSensors !== prev.sensors ||
          state.colormapMode !== prev.cmap ||
          state.worldMode !== prev.world ||
          state.activeCam !== prev.cam) {
        dirtyRef.current = true
        prev.frame = state.currentFrame
        prev.sensors = state.visibleSensors
        prev.cmap = state.colormapMode
        prev.world = state.worldMode
        prev.cam = state.activeCam
      }
    })
  }, [])

  // Apply buffer updates inside the Three.js render loop
  useFrame(() => {
    if (!dirtyRef.current) return
    dirtyRef.current = false

    // Always read latest state from store (no stale closure)
    const { currentFrame: curFrame, visibleSensors: visSensors,
            colormapMode: cmap, worldMode: wmode, activeCam: aCam } =
      useSceneStore.getState()

    const geom = geometryRef.current
    const radarGeom = radarGeometryRef.current
    if (!curFrame) {
      if (geom) geom.setDrawRange(0, 0)
      if (radarGeom) radarGeom.setDrawRange(0, 0)
      return
    }

    const sensorClouds = curFrame.sensorClouds
    if (!sensorClouds || sensorClouds.size === 0) {
      if (geom) geom.setDrawRange(0, 0)
      if (radarGeom) radarGeom.setDrawRange(0, 0)
      return
    }

    const posArr = posAttr.array as Float32Array
    const colArr = colorAttr.array as Float32Array
    const radarPosArr = radarPosAttr.array as Float32Array
    const radarColArr = radarColorAttr.array as Float32Array
    const stops = COLORMAP_STOPS[cmap]
    const attrOff = ATTR_OFFSET[cmap]
    const manifest = getManifest()
    // Intensity range differs per dataset (Waymo: 0–1, nuScenes: 0–255)
    const [attrMin, attrMax] = cmap === 'intensity' && manifest.intensityRange
      ? manifest.intensityRange
      : ATTR_RANGE[cmap]
    const attrSpan = attrMax - attrMin

    const stride = manifest.pointStride

    // POV frustum culling: hide points inside the active camera's view cone
    const culler = buildFrustumCuller(curFrame.cameraCalibrations, aCam)

    let lidarTotal = 0
    let radarTotal = 0
    for (const [laserName, cloud] of sensorClouds) {
      if (!visSensors.has(laserName)) continue
      const { positions } = cloud
      const isRadar = laserName >= RADAR_SENSOR_ID_MIN

      if (isRadar) {
        // Radar: velocity-based colormap, stride=5 (x,y,z,speedComp,speedRaw)
        const RADAR_STRIDE = 5
        // World mode → speedComp (offset 3): true object velocity
        // Vehicle mode → speedRaw (offset 4): velocity relative to ego
        const speedOffset = wmode ? 3 : 4
        const count = Math.min(cloud.pointCount, MAX_RADAR_POINTS - radarTotal)
        for (let i = 0; i < count; i++) {
          const src = i * RADAR_STRIDE
          const dst = (radarTotal + i) * 3
          radarPosArr[dst] = positions[src]
          radarPosArr[dst + 1] = positions[src + 1]
          radarPosArr[dst + 2] = positions[src + 2]
          // Color by speed: 0 m/s → blue (static), 15+ m/s → red (fast)
          const speed = positions[src + speedOffset]
          const t = Math.min(speed / VELOCITY_MAX, 1)
          const [r, g, b] = colormapColor(VELOCITY_STOPS, t)
          radarColArr[dst] = r
          radarColArr[dst + 1] = g
          radarColArr[dst + 2] = b
        }
        radarTotal += count
      } else {
        // LiDAR: colormap-based
        const maxCount = Math.min(cloud.pointCount, MAX_POINTS - lidarTotal)

        // Segment mode: use per-point label → palette lookup
        const isSegMode = cmap === 'segment'
        const segLabels = cloud.segLabels
        const segLabelCount = segLabels ? segLabels.length : 0

        let written = 0
        for (let i = 0; i < maxCount; i++) {
          const src = i * stride
          const px = positions[src]
          const py = positions[src + 1]
          const pz = positions[src + 2]

          // POV frustum culling: skip points inside the camera's view cone
          if (culler && insideFrustum(culler, px, py, pz)) continue

          const dst = (lidarTotal + written) * 3
          posArr[dst] = px
          posArr[dst + 1] = py
          posArr[dst + 2] = pz

          let r: number, g: number, b: number
          if (isSegMode) {
            // Segment coloring: palette lookup from uint8 label
            const label = i < segLabelCount && segLabels ? segLabels[i] : 0
            const c = LIDARSEG_PALETTE[label] ?? LIDARSEG_PALETTE[0]
            r = c[0]; g = c[1]; b = c[2]
          } else {
            // Standard colormap: distance computes from xyz, others from buffer
            const raw = attrOff === -1
              ? Math.sqrt(px * px + py * py + pz * pz)
              : (attrOff < stride ? positions[src + attrOff] : 0)
            const t = (raw - attrMin) / attrSpan
            ;[r, g, b] = colormapColor(stops, t)
          }

          colArr[dst] = r
          colArr[dst + 1] = g
          colArr[dst + 2] = b
          written++
        }
        lidarTotal += written
      }
    }

    if (geom) {
      posAttr.needsUpdate = true
      colorAttr.needsUpdate = true
      geom.setDrawRange(0, lidarTotal)
      geom.computeBoundingSphere()
    }
    if (radarGeom) {
      radarPosAttr.needsUpdate = true
      radarColorAttr.needsUpdate = true
      radarGeom.setDrawRange(0, radarTotal)
      radarGeom.computeBoundingSphere()
    }
  })

  return (
    <>
      {/* LiDAR points — small, dense */}
      <points frustumCulled={false}>
        <bufferGeometry ref={geometryRef}>
          <primitive object={posAttr} attach="attributes-position" />
          <primitive object={colorAttr} attach="attributes-color" />
        </bufferGeometry>
        <pointsMaterial
          size={0.08}
          sizeAttenuation
          vertexColors
          transparent
          opacity={pointOpacity}
          depthWrite={false}
        />
      </points>
      {/* Radar points — larger, sparse, sensor-colored */}
      <points frustumCulled={false}>
        <bufferGeometry ref={radarGeometryRef}>
          <primitive object={radarPosAttr} attach="attributes-position" />
          <primitive object={radarColorAttr} attach="attributes-color" />
        </bufferGeometry>
        <pointsMaterial
          size={0.5}
          sizeAttenuation
          vertexColors
          transparent
          opacity={pointOpacity}
          depthWrite={false}
        />
      </points>
    </>
  )
}
