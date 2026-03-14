/**
 * LidarProjectionOverlay — Canvas overlay that renders LiDAR point cloud
 * projected onto a camera image.
 *
 * Reads LiDAR points from the current frame's sensorClouds, projects them
 * into the camera's image plane using calibration data, and draws colored
 * dots. Color always matches the currently selected colormapMode in the 3D
 * viewer (intensity/range/elongation/distance/segment/panoptic) by reusing
 * the same colormap stops, attribute offsets, and normalization ranges.
 *
 * Imperative draw pattern (same as BBoxOverlayCanvas): zero DOM churn,
 * updates via Zustand subscribe + ResizeObserver.
 */

import { useRef, useEffect, useCallback, useMemo } from 'react'
import { useSceneStore } from '../../stores/useSceneStore'
import type { ColormapMode } from '../../stores/useSceneStore'
import {
  buildCameraProjectors,
  projectPointsToCamera,
} from '../../utils/lidarProjection'
import { computeTransform } from './BBoxOverlayCanvas'
import {
  LIDARSEG_PALETTE,
  COLORMAP_STOPS,
  ATTR_OFFSET,
  ATTR_RANGE,
  colormapColor,
} from '../LidarViewer/PointCloud'
import { getManifest } from '../../adapters/registry'
import type { PointCloud } from '../../utils/rangeImage'

// ---------------------------------------------------------------------------
// Panoptic instance coloring (same logic as PointCloud)
// ---------------------------------------------------------------------------

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h * 6) % 2 - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  const sector = Math.floor(h * 6) % 6
  if (sector === 0) { r = c; g = x }
  else if (sector === 1) { r = x; g = c }
  else if (sector === 2) { g = c; b = x }
  else if (sector === 3) { g = x; b = c }
  else if (sector === 4) { r = x; b = c }
  else { r = c; b = x }
  return [r + m, g + m, b + m]
}

const LIDARSEG_HSL: [number, number, number][] = LIDARSEG_PALETTE.map(
  ([r, g, b]) => rgbToHsl(r, g, b),
)

function instanceColor(sem: number, inst: number): [number, number, number] {
  const base = LIDARSEG_PALETTE[sem] ?? LIDARSEG_PALETTE[0]
  if (inst === 0) return base
  const [h, s] = LIDARSEG_HSL[sem] ?? LIDARSEG_HSL[0]
  const spread = (inst * 0.618033988749895) % 1.0
  const lit = 0.30 + spread * 0.50
  const sat = Math.min(1.0, s * 1.2 + 0.1)
  return hslToRgb(h, sat, lit)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Point radius in image pixels (before display scaling) */
const POINT_RADIUS = 4

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface LidarProjectionOverlayProps {
  cameraName: number
}

export default function LidarProjectionOverlay({ cameraName }: LidarProjectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Build projectors from camera calibrations (stable across frames)
  const cameraCalibrations = useSceneStore((s) => s.cameraCalibrations)
  const projectors = useMemo(
    () => buildCameraProjectors(cameraCalibrations),
    [cameraCalibrations],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const projector = projectors.get(cameraName)
    if (!projector) return

    const dpr = window.devicePixelRatio || 1
    const displayW = canvas.clientWidth
    const displayH = canvas.clientHeight
    if (displayW === 0 || displayH === 0) return

    // Set backing store size
    const backingW = Math.round(displayW * dpr)
    const backingH = Math.round(displayH * dpr)
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW
      canvas.height = backingH
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, backingW, backingH)
    ctx.scale(dpr, dpr)

    // Image→display transform (xMidYMid slice, same as BBoxOverlayCanvas)
    const t = computeTransform(displayW, displayH, projector.width, projector.height)

    // Get current frame data
    const state = useSceneStore.getState()
    const frame = state.currentFrame
    if (!frame) return

    const cmap = state.colormapMode
    const visibleSensors = state.visibleSensors
    const manifest = getManifest()
    const stride = manifest.pointStride

    // Resolve colormap stops, attribute offset, and normalization range
    const stops = COLORMAP_STOPS[cmap]
    const attrOff = ATTR_OFFSET[cmap]
    // Intensity range may be overridden per-dataset
    const [attrMin, attrMax] = cmap === 'intensity' && manifest.intensityRange
      ? manifest.intensityRange
      : ATTR_RANGE[cmap]
    const attrSpan = attrMax - attrMin

    // Project + draw only for visible (toggled-on) sensors
    for (const [laserName, cloud] of frame.sensorClouds) {
      if (!visibleSensors.has(laserName)) continue
      const projected = projectPointsToCamera(
        cloud.positions,
        cloud.pointCount,
        stride,
        projector,
      )

      drawProjectedPoints(
        ctx, projected, cloud, stride, t, cmap,
        stops, attrOff, attrMin, attrSpan,
      )
    }
  }, [cameraName, projectors])

  // Subscribe to relevant store changes
  useEffect(() => {
    let prevFrame = useSceneStore.getState().currentFrame
    let prevCmap = useSceneStore.getState().colormapMode
    let prevSensors = useSceneStore.getState().visibleSensors
    const unsub = useSceneStore.subscribe((s) => {
      if (s.currentFrame !== prevFrame || s.colormapMode !== prevCmap || s.visibleSensors !== prevSensors) {
        prevFrame = s.currentFrame
        prevCmap = s.colormapMode
        prevSensors = s.visibleSensors
        draw()
      }
    })
    return () => unsub()
  }, [draw])

  // ResizeObserver
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => draw())
    ro.observe(container)
    draw()
    return () => ro.disconnect()
  }, [draw])

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Draw helpers
// ---------------------------------------------------------------------------

interface DisplayTransform {
  scale: number
  offsetX: number
  offsetY: number
}

function drawProjectedPoints(
  ctx: CanvasRenderingContext2D,
  projected: ReturnType<typeof projectPointsToCamera>,
  cloud: PointCloud,
  stride: number,
  t: DisplayTransform,
  colormapMode: ColormapMode,
  stops: [number, number, number][],
  attrOff: number,
  attrMin: number,
  attrSpan: number,
) {
  const { positions, segLabels, panopticLabels } = cloud
  const dotRadius = POINT_RADIUS * t.scale

  // Sort back-to-front: draw far points first so near points occlude them
  projected.sort((a, b) => b.depth - a.depth)

  for (const pt of projected) {
    const { u, v, srcIndex } = pt

    // Map image-space → display-space
    const dx = u * t.scale + t.offsetX
    const dy = v * t.scale + t.offsetY

    // Compute color — same logic as PointCloud.tsx
    let r: number, g: number, b: number

    if (colormapMode === 'panoptic') {
      const panLabel = panopticLabels ? panopticLabels[srcIndex] ?? 0 : 0
      const sem = Math.floor(panLabel / 1000)
      const inst = panLabel % 1000
      ;[r, g, b] = instanceColor(sem, inst)
    } else if (colormapMode === 'segment') {
      const label = segLabels ? segLabels[srcIndex] ?? 0 : 0
      const c = LIDARSEG_PALETTE[label] ?? LIDARSEG_PALETTE[0]
      r = c[0]; g = c[1]; b = c[2]
    } else {
      // Standard colormap: distance computes from xyz, others read from buffer
      const src = srcIndex * stride
      const px = positions[src]
      const py = positions[src + 1]
      const pz = positions[src + 2]
      const raw = attrOff === -1
        ? Math.sqrt(px * px + py * py + pz * pz)  // distance
        : (attrOff < stride ? positions[src + attrOff] : 0)
      const tNorm = Math.max(0, Math.min(1, (raw - attrMin) / attrSpan))
      ;[r, g, b] = colormapColor(stops, tNorm)
    }

    ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
    ctx.beginPath()
    ctx.arc(dx, dy, dotRadius, 0, Math.PI * 2)
    ctx.fill()
  }
}
