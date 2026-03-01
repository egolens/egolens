/**
 * PointCloud renderer — single draw call for ~168K points.
 *
 * Supports per-sensor visibility toggle via store's visibleSensors set.
 * Always merges from per-sensor clouds in useFrame (no pre-merged buffer
 * is cached, saving ~772 MB for a 199-frame segment — see OPT-004).
 *
 * Colormap modes: intensity (default), height (Z), range, elongation.
 * When sensors are filtered, per-sensor coloring overrides colormap.
 */

import { useRef, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useSceneStore } from '../../stores/useSceneStore'
import type { ColormapMode } from '../../stores/useSceneStore'
import { POINT_STRIDE } from '../../utils/rangeImage'

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

/** Turbo-like colormap for height (blue → cyan → green → yellow → red) */
const HEIGHT_STOPS: [number, number, number][] = [
  [0.19, 0.07, 0.23],  // 0.0 — deep purple
  [0.12, 0.39, 0.72],  // 0.2 — blue
  [0.06, 0.72, 0.60],  // 0.4 — teal
  [0.47, 0.87, 0.26],  // 0.6 — green-yellow
  [0.94, 0.73, 0.14],  // 0.8 — amber
  [0.84, 0.18, 0.15],  // 1.0 — red
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

const COLORMAP_STOPS: Record<ColormapMode, [number, number, number][]> = {
  intensity: INTENSITY_STOPS,
  height: HEIGHT_STOPS,
  range: RANGE_STOPS,
  elongation: ELONGATION_STOPS,
}

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

// Sensor color map for per-sensor coloring mode (cool-tone Waymo palette)
const SENSOR_COLORS: Record<number, [number, number, number]> = {
  1: [0.0, 0.91, 0.62],  // TOP — teal (#00E89D)
  2: [0.0, 0.79, 0.86],  // FRONT — cyan (#00C9DB)
  3: [0.30, 0.66, 1.0],  // SIDE_LEFT — sky blue (#4DA8FF)
  4: [0.48, 0.44, 1.0],  // SIDE_RIGHT — indigo (#7B6FFF)
  5: [0.71, 0.56, 1.0],  // REAR — lavender (#B490FF)
}

// ---------------------------------------------------------------------------
// Attribute extraction helpers
// ---------------------------------------------------------------------------

/** Offset within the POINT_STRIDE-sized record for each attribute */
const ATTR_OFFSET: Record<ColormapMode, number> = {
  intensity: 3,   // positions[src + 3]
  height: 2,      // positions[src + 2] = z
  range: 4,       // positions[src + 4]
  elongation: 5,  // positions[src + 5]
}

/** Normalization ranges per attribute (min, max) for mapping to 0..1 */
const ATTR_RANGE: Record<ColormapMode, [number, number]> = {
  intensity: [0, 1],        // already 0..1 in Waymo data
  height: [-3, 8],          // z: typical ground=-2m, top of trucks ~5m
  range: [0, 75],           // meters (max useful range ~75m for visualization)
  elongation: [0, 1],       // already 0..1 in Waymo data
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Maximum points we'll ever allocate buffers for (avoids realloc). */
const MAX_POINTS = 200_000

export default function PointCloud() {
  const currentFrame = useSceneStore((s) => s.currentFrame)
  const currentFrameIndex = useSceneStore((s) => s.currentFrameIndex)
  const visibleSensors = useSceneStore((s) => s.visibleSensors)
  const pointOpacity = useSceneStore((s) => s.pointOpacity)
  const colormapMode = useSceneStore((s) => s.colormapMode)
  const geometryRef = useRef<THREE.BufferGeometry>(null)

  // Pre-allocate position & color buffers once
  const { posAttr, colorAttr } = useMemo(() => {
    const pos = new THREE.Float32BufferAttribute(new Float32Array(MAX_POINTS * 3), 3)
    const col = new THREE.Float32BufferAttribute(new Float32Array(MAX_POINTS * 3), 3)
    pos.setUsage(THREE.DynamicDrawUsage)
    col.setUsage(THREE.DynamicDrawUsage)
    return { posAttr: pos, colorAttr: col }
  }, [])

  // Mark dirty when any input changes — actual buffer update happens in useFrame
  // to avoid R3F reconciler resetting needsUpdate between useEffect and render.
  const dirtyRef = useRef(true)
  useEffect(() => { dirtyRef.current = true }, [currentFrame, visibleSensors, colormapMode])

  // Apply buffer updates inside the Three.js render loop
  useFrame(() => {
    if (!dirtyRef.current) return
    dirtyRef.current = false

    const geom = geometryRef.current
    if (!geom || !currentFrame) {
      if (geom) geom.setDrawRange(0, 0)
      return
    }

    const sensorClouds = currentFrame.sensorClouds
    if (!sensorClouds || sensorClouds.size === 0) {
      geom.setDrawRange(0, 0)
      return
    }

    const posArr = posAttr.array as Float32Array
    const colArr = colorAttr.array as Float32Array
    const stops = COLORMAP_STOPS[colormapMode]
    const attrOff = ATTR_OFFSET[colormapMode]
    const [attrMin, attrMax] = ATTR_RANGE[colormapMode]
    const attrSpan = attrMax - attrMin

    let total = 0
    for (const [laserName, cloud] of sensorClouds) {
      if (!visibleSensors.has(laserName)) continue
      const count = Math.min(cloud.pointCount, MAX_POINTS - total)
      const { positions } = cloud

      for (let i = 0; i < count; i++) {
        const src = i * POINT_STRIDE
        const dst = (total + i) * 3
        posArr[dst] = positions[src]
        posArr[dst + 1] = positions[src + 1]
        posArr[dst + 2] = positions[src + 2]
        const raw = positions[src + attrOff]
        const t = (raw - attrMin) / attrSpan
        const [r, g, b] = colormapColor(stops, t)
        colArr[dst] = r
        colArr[dst + 1] = g
        colArr[dst + 2] = b
      }
      total += count
    }

    posAttr.needsUpdate = true
    colorAttr.needsUpdate = true
    geom.setDrawRange(0, total)
    geom.computeBoundingSphere()
  })

  return (
    <points frustumCulled={false}>
      <bufferGeometry ref={geometryRef}>
        <bufferAttribute attach="attributes-position" {...posAttr} />
        <bufferAttribute attach="attributes-color" {...colorAttr} />
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
  )
}
