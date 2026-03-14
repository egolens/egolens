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

import { useRef, useEffect, useMemo, useCallback } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useSceneStore } from '../../stores/useSceneStore'
import { getManifest } from '../../adapters/registry'
import { buildCameraRgbForFrame } from '../../utils/cameraRgbSampler'
import { buildCameraProjectors, type CameraProjector } from '../../utils/lidarProjection'
import {
  COLORMAP_STOPS,
  ATTR_OFFSET,
  ATTR_RANGE,
  colormapColor,
  computePointColor,
  srgbToLinear,
} from '../../utils/colormaps'

// Re-export palette & labels for consumers that still import from this file
export { LIDARSEG_PALETTE, LIDARSEG_LABELS, COLORMAP_STOPS, ATTR_OFFSET, ATTR_RANGE, colormapColor } from '../../utils/colormaps'

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

  // Camera RGB cache: per-sensor Uint8Array (3 bytes per point), keyed by frame timestamp
  const cameraRgbRef = useRef<{ timestamp: bigint; data: Map<number, Uint8Array> } | null>(null)
  const cameraRgbPendingRef = useRef<bigint | null>(null)
  // Cached CameraProjector map (built once from calibration rows)
  const projectorsRef = useRef<Map<number, CameraProjector> | null>(null)

  // Async camera RGB builder — projects LiDAR points mathematically to camera images
  // using camera calibration (intrinsics + extrinsics), then samples RGB from decoded JPEGs
  const triggerCameraRgbBuild = useCallback(async (
    timestamp: bigint,
    sensorClouds: Map<number, { positions: Float32Array; pointCount: number }>,
    cameraImages: Map<number, ArrayBuffer>,
  ) => {
    // Already have this frame's RGB
    if (cameraRgbRef.current?.timestamp === timestamp) return
    // Already building
    if (cameraRgbPendingRef.current === timestamp) return
    if (cameraImages.size === 0) return

    // Build projectors once from camera calibration data
    if (!projectorsRef.current) {
      const calRows = useSceneStore.getState().cameraCalibrations
      if (!calRows || calRows.length === 0) return
      projectorsRef.current = buildCameraProjectors(calRows)
    }
    const projectors = projectorsRef.current
    if (projectors.size === 0) return

    cameraRgbPendingRef.current = timestamp
    try {
      const rgbMap = await buildCameraRgbForFrame(timestamp, sensorClouds, cameraImages, projectors)
      // Only apply if still the current frame
      const curTs = useSceneStore.getState().currentFrame?.timestamp
      if (curTs === timestamp) {
        cameraRgbRef.current = { timestamp, data: rgbMap }
        dirtyRef.current = true // trigger re-render with RGB data
      }
    } catch (e) {
      console.warn('[PointCloud] Camera RGB build failed:', e)
    }
    cameraRgbPendingRef.current = null
  }, [])

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
            colormapMode: cmap, worldMode: wmode } =
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

    // Camera colormap: trigger async JPEG decode if needed
    const isCameraMode = cmap === 'camera'
    const camRgbData = cameraRgbRef.current?.timestamp === curFrame.timestamp
      ? cameraRgbRef.current.data : null
    if (isCameraMode && !camRgbData) {
      // Kick off async build; will set dirtyRef when done
      triggerCameraRgbBuild(curFrame.timestamp, sensorClouds, curFrame.cameraImages)
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
    const semanticPalette = manifest.semanticPalette ?? null

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

        const segLabels = cloud.segLabels
        const panopticLabels = cloud.panopticLabels
        // Camera RGB: pre-sampled Uint8Array (3 bytes per point)
        const camRgb = isCameraMode && camRgbData ? camRgbData.get(laserName) : null

        let written = 0
        for (let i = 0; i < maxCount; i++) {
          const src = i * stride
          const px = positions[src]
          const py = positions[src + 1]
          const pz = positions[src + 2]

          const dst = (lidarTotal + written) * 3
          posArr[dst] = px
          posArr[dst + 1] = py
          posArr[dst + 2] = pz

          let r: number, g: number, b: number
          if (isCameraMode && camRgb) {
            // Camera coloring: use pre-sampled RGB from decoded camera images
            // Convert sRGB → linear because Three.js vertex colors are in linear space
            const ci = i * 3
            r = srgbToLinear(camRgb[ci] / 255)
            g = srgbToLinear(camRgb[ci + 1] / 255)
            b = srgbToLinear(camRgb[ci + 2] / 255)
          } else if ((cmap === 'segment' || cmap === 'panoptic') && !segLabels) {
            // Non-TOP sensors have no seg labels → dim gray to indicate missing data
            r = 0.15; g = 0.15; b = 0.15
          } else {
            ;[r, g, b] = computePointColor(
              cmap, i, positions, stride,
              stops, attrOff, attrMin, attrSpan,
              segLabels, panopticLabels, semanticPalette,
            )
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
