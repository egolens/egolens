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
import { setupHiDpiCanvas } from '../../utils/canvasUtils'
import {
  COLORMAP_STOPS,
  ATTR_OFFSET,
  ATTR_RANGE,
  computePointColor,
} from '../../utils/colormaps'
import { getManifest } from '../../adapters/registry'
import type { PointCloud } from '../../utils/rangeImage'

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

    const setup = setupHiDpiCanvas(canvas, ctx)
    if (!setup) return

    const { displayW, displayH } = setup
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

    const [r, g, b] = computePointColor(
      colormapMode, srcIndex, positions, stride,
      stops, attrOff, attrMin, attrSpan,
      segLabels, panopticLabels,
    )

    ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
    ctx.beginPath()
    ctx.arc(dx, dy, dotRadius, 0, Math.PI * 2)
    ctx.fill()
  }
}
