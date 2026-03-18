/**
 * PointCloud renderer — single draw call for ~168K points.
 *
 * Supports per-sensor visibility toggle via store's visibleSensors set.
 * Always merges from per-sensor clouds in useFrame (no pre-merged buffer
 * is cached, saving ~772 MB for a 199-frame segment — see OPT-004).
 *
 * Colormap modes: intensity (default), range, elongation, segment, panoptic.
 * Camera mode: GPU-accelerated — projects LiDAR→camera in vertex shader,
 * samples camera textures in fragment shader. Zero CPU overhead per frame.
 */

import { useRef, useEffect, useMemo, useCallback } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useSceneStore } from '../../stores/useSceneStore'
import type { FrameData } from '../../stores/useSceneStore'
import { getManifest } from '../../adapters/registry'
import { buildCameraProjectors, type CameraProjector } from '../../utils/lidarProjection'
import {
  COLORMAP_STOPS,
  ATTR_OFFSET,
  ATTR_RANGE,
  colormapColor,
  computePointColor,
} from '../../utils/colormaps'
import {
  createCameraColorMaterial,
  decodeCameraTextures,
  updateCameraUniforms,
  disposeCameraTextures,
  type ShaderCameraInfo,
} from './CameraColorMaterial'

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
  const { gl } = useThree()
  const geometryRef = useRef<THREE.BufferGeometry>(null)
  const radarGeometryRef = useRef<THREE.BufferGeometry>(null)
  const lidarPointsRef = useRef<THREE.Points>(null)

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

  // Materials — created once, swapped imperatively in useFrame
  const normalMat = useMemo(() => {
    const mat = new THREE.PointsMaterial({
      size: 0.08,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    })
    // Inject circle discard into built-in points fragment shader
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (uCircle > 0.5) {
          vec2 cxy = 2.0 * gl_PointCoord - 1.0;
          if (dot(cxy, cxy) > 1.0) discard;
        }`,
      )
      shader.fragmentShader = 'uniform float uCircle;\n' + shader.fragmentShader
      shader.uniforms.uCircle = { value: 1.0 }
      // Store ref for runtime toggling
      ;(mat as unknown as Record<string, unknown>)._circleUniform = shader.uniforms.uCircle
    }
    return mat
  }, [])
  const cameraMat = useMemo(() => createCameraColorMaterial(), [])

  // ---------------------------------------------------------------------------
  // React subscriptions — commit-synced with WorldPoseSync & BoundingBoxes.
  //
  // Reading currentFrame via React subscription (not getState()) ensures
  // PointCloud's position buffer updates in the SAME commit cycle as the
  // scene group matrix. Without this, getState() races ahead of React,
  // causing 1-frame position/matrix desync in world mode (same root cause
  // as the box jitter documented in R3F_RENDER_SYNC.md §v3).
  // ---------------------------------------------------------------------------
  const currentFrame = useSceneStore((s) => s.currentFrame)
  const visibleSensors = useSceneStore((s) => s.visibleSensors)
  const colormapMode = useSceneStore((s) => s.colormapMode)
  const worldMode = useSceneStore((s) => s.worldMode)
  const pointOpacity = useSceneStore((s) => s.pointOpacity)
  const pointSize = useSceneStore((s) => s.pointSize)

  // Refs bridge React commit → useFrame (same pattern as WorldPoseSync)
  const frameRef = useRef<FrameData | null>(currentFrame)
  const sensorsRef = useRef(visibleSensors)
  const cmapRef = useRef(colormapMode)
  const worldRef = useRef(worldMode)
  const opacityRef = useRef(pointOpacity)
  const sizeRef = useRef(pointSize)
  frameRef.current = currentFrame
  sensorsRef.current = visibleSensors
  cmapRef.current = colormapMode
  worldRef.current = worldMode
  opacityRef.current = pointOpacity
  sizeRef.current = pointSize

  // Track last-processed values for dirty detection in useFrame
  const lastFrameRef = useRef<FrameData | null>(null)
  const lastSensorsRef = useRef(visibleSensors)
  const lastCmapRef = useRef(colormapMode)
  const lastWorldRef = useRef(worldMode)
  const lastOpacityRef = useRef(pointOpacity)
  const lastSizeRef = useRef(pointSize)

  /** Extra dirty flag for async events (bitmap decode, etc.) */
  const extraDirtyRef = useRef(false)

  // ---------------------------------------------------------------------------
  // Camera shader state (replaces old CPU camera RGB pipeline)
  // ---------------------------------------------------------------------------

  /** Cached decoded canvases for the current frame (for GPU texture upload) */
  const bitmapCacheRef = useRef<{ timestamp: bigint; bitmaps: Map<number, OffscreenCanvas> } | null>(null)
  /** Timestamp of in-flight bitmap decode (prevents duplicate work) */
  const bitmapPendingRef = useRef<bigint | null>(null)
  /** Camera calibration data formatted for shader uniforms (built once) */
  const shaderCamerasRef = useRef<ShaderCameraInfo[] | null>(null)
  /** CameraProjector map (for building ShaderCameraInfo) */
  const projectorsRef = useRef<Map<number, CameraProjector> | null>(null)

  /** Build ShaderCameraInfo[] from camera calibration (once per segment) */
  const ensureShaderCameras = useCallback((): ShaderCameraInfo[] | null => {
    if (shaderCamerasRef.current) return shaderCamerasRef.current
    if (!projectorsRef.current) {
      const calRows = useSceneStore.getState().cameraCalibrations
      if (!calRows || calRows.length === 0) return null
      projectorsRef.current = buildCameraProjectors(calRows)
    }
    const projectors = projectorsRef.current
    if (projectors.size === 0) return null

    const cameras: ShaderCameraInfo[] = []
    for (const [, proj] of projectors) {
      cameras.push({
        cameraName: proj.cameraName,
        invExtrinsic: proj.invExtrinsic,
        f_u: proj.f_u,
        f_v: proj.f_v,
        c_u: proj.c_u,
        c_v: proj.c_v,
        width: proj.width,
        height: proj.height,
        isOpticalFrame: proj.isOpticalFrame,
      })
    }
    shaderCamerasRef.current = cameras
    return cameras
  }, [])

  /** Trigger async bitmap decode for camera textures (non-blocking) */
  const triggerBitmapDecode = useCallback((timestamp: bigint, cameraImages: Map<number, ArrayBuffer>) => {
    if (bitmapCacheRef.current?.timestamp === timestamp) return  // already cached
    if (bitmapPendingRef.current === timestamp) return            // already in flight
    if (cameraImages.size === 0) return

    bitmapPendingRef.current = timestamp
    decodeCameraTextures(cameraImages).then(bitmaps => {
      bitmapCacheRef.current = { timestamp, bitmaps }
      extraDirtyRef.current = true
      bitmapPendingRef.current = null
    }).catch(() => {
      bitmapPendingRef.current = null
    })
  }, [])

  // Reset shader state on segment switch
  useEffect(() => {
    return useSceneStore.subscribe((state, prev) => {
      if (state.currentSegment !== prev.currentSegment) {
        shaderCamerasRef.current = null
        projectorsRef.current = null
        bitmapCacheRef.current = null
        bitmapPendingRef.current = null
        disposeCameraTextures()
      }
    })
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      normalMat.dispose()
      cameraMat.dispose()
      disposeCameraTextures()
    }
  }, [normalMat, cameraMat])

  // Apply buffer updates inside the Three.js render loop
  useFrame(() => {
    // Dirty detection: compare React-committed refs with last-processed values.
    // This replaces the old Zustand subscriber approach, keeping PointCloud's
    // data reads in sync with WorldPoseSync's React subscription cycle.
    const curFrame = frameRef.current
    const visSensors = sensorsRef.current
    const cmap = cmapRef.current
    const wmode = worldRef.current
    const pOpacity = opacityRef.current
    const pSize = sizeRef.current

    const dirty = curFrame !== lastFrameRef.current
      || visSensors !== lastSensorsRef.current
      || cmap !== lastCmapRef.current
      || wmode !== lastWorldRef.current
      || pOpacity !== lastOpacityRef.current
      || pSize !== lastSizeRef.current
      || extraDirtyRef.current

    if (!dirty) return
    extraDirtyRef.current = false

    const geom = geometryRef.current
    const radarGeom = radarGeometryRef.current
    const pts = lidarPointsRef.current
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

    const isCameraMode = cmap === 'camera'

    // ---------------------------------------------------------------------------
    // Material swap + opacity + point shape/size
    // ---------------------------------------------------------------------------
    if (pts) {
      if (isCameraMode) {
        if (pts.material !== cameraMat) pts.material = cameraMat
        cameraMat.uniforms.uOpacity.value = pOpacity
        cameraMat.uniforms.uCircle.value = 1.0
        // Size attenuation: compute scale from canvas height
        const canvasH = gl.domElement.height || 1080
        cameraMat.uniforms.uPointSize.value = pSize * canvasH * 0.5
      } else {
        if (pts.material !== normalMat) pts.material = normalMat
        normalMat.opacity = pOpacity
        normalMat.size = pSize
        // Circle shape: always on
        const circleU = (normalMat as unknown as Record<string, unknown>)._circleUniform as { value: number } | undefined
        if (circleU) circleU.value = 1.0
      }
    }

    // ---------------------------------------------------------------------------
    // Camera shader: decode textures + position/texture sync gate
    //
    // Camera textures are decoded asynchronously (2-5ms). If we update point
    // positions before the matching textures are ready, the vertex shader
    // projects new ego-frame positions into UV coords that don't match the
    // old texture content — causing visible color vibration.
    //
    // Fix: in camera mode, defer position buffer updates until textures for
    // the current frame are decoded. The old consistent frame (positions +
    // textures from the same timestamp) stays visible during decode, which
    // is imperceptible at ~2-5ms.
    // ---------------------------------------------------------------------------
    if (isCameraMode) {
      const cameras = ensureShaderCameras()
      if (cameras && cameras.length > 0) {
        // Always kick off decode for the current frame
        triggerBitmapDecode(curFrame.timestamp, curFrame.cameraImages)

        const cached = bitmapCacheRef.current
        if (!cached || cached.timestamp !== curFrame.timestamp) {
          // Textures not ready for this frame — keep showing the previous
          // consistent frame (old positions + old textures). Skip position
          // buffer update and retry next useFrame tick.
          extraDirtyRef.current = true
          return
        }
        updateCameraUniforms(cameraMat, cameras, cached.bitmaps)
      }
    }

    // ---------------------------------------------------------------------------
    // Position + color buffer update
    // ---------------------------------------------------------------------------
    const posArr = posAttr.array as Float32Array
    const colArr = colorAttr.array as Float32Array
    const radarPosArr = radarPosAttr.array as Float32Array
    const radarColArr = radarColorAttr.array as Float32Array

    // Non-camera colormap data
    const stops = COLORMAP_STOPS[cmap]
    const attrOff = ATTR_OFFSET[cmap]
    const manifest = getManifest()
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
        const speedOffset = wmode ? 3 : 4
        const count = Math.min(cloud.pointCount, MAX_RADAR_POINTS - radarTotal)
        for (let i = 0; i < count; i++) {
          const src = i * RADAR_STRIDE
          const dst = (radarTotal + i) * 3
          radarPosArr[dst] = positions[src]
          radarPosArr[dst + 1] = positions[src + 1]
          radarPosArr[dst + 2] = positions[src + 2]
          const speed = positions[src + speedOffset]
          const t = Math.min(speed / VELOCITY_MAX, 1)
          const [r, g, b] = colormapColor(VELOCITY_STOPS, t)
          radarColArr[dst] = r
          radarColArr[dst + 1] = g
          radarColArr[dst + 2] = b
        }
        radarTotal += count
      } else {
        // LiDAR: positions always updated; colors only for non-camera modes
        const maxCount = Math.min(cloud.pointCount, MAX_POINTS - lidarTotal)

        if (isCameraMode) {
          // Camera mode: only copy positions (shader handles coloring on GPU)
          for (let i = 0; i < maxCount; i++) {
            const src = i * stride
            const dst = (lidarTotal + i) * 3
            posArr[dst] = positions[src]
            posArr[dst + 1] = positions[src + 1]
            posArr[dst + 2] = positions[src + 2]
          }
          lidarTotal += maxCount
        } else {
          // Non-camera: copy positions + compute CPU vertex colors
          const segLabels = cloud.segLabels
          const panopticLabels = cloud.panopticLabels

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
            if ((cmap === 'segment' || cmap === 'panoptic') && !segLabels) {
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
    }

    if (geom) {
      posAttr.needsUpdate = true
      if (!isCameraMode) colorAttr.needsUpdate = true
      geom.setDrawRange(0, lidarTotal)
      geom.computeBoundingSphere()
    }
    if (radarGeom) {
      radarPosAttr.needsUpdate = true
      radarColorAttr.needsUpdate = true
      radarGeom.setDrawRange(0, radarTotal)
      radarGeom.computeBoundingSphere()
    }

    // Mark this state as processed (for dirty detection on next tick)
    lastFrameRef.current = curFrame
    lastSensorsRef.current = visSensors
    lastCmapRef.current = cmap
    lastWorldRef.current = wmode
    lastOpacityRef.current = pOpacity
    lastSizeRef.current = pSize
  })

  return (
    <>
      {/* LiDAR points — small, dense */}
      <points ref={lidarPointsRef} frustumCulled={false}>
        <bufferGeometry ref={geometryRef}>
          <primitive object={posAttr} attach="attributes-position" />
          <primitive object={colorAttr} attach="attributes-color" />
        </bufferGeometry>
        <primitive object={normalMat} attach="material" />
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
          opacity={normalMat.opacity}
          depthWrite={false}
        />
      </points>
    </>
  )
}
