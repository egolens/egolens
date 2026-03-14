/**
 * BoxProjectionOverlay — Canvas overlay that renders 3D bounding boxes
 * projected onto camera images as wireframes.
 *
 * Replicates nuScenes devkit Box.render() style:
 *   - Front face (first 4 corners): class color
 *   - Rear face (last 4 corners): class color (dimmed)
 *   - Side edges: class color (semi-transparent)
 *   - Front direction indicator line on bottom face
 *
 * Supports bidirectional hover highlighting:
 *   - Hover a projected wireframe → highlights linked 3D box in LiDAR view
 *   - Hover a 3D box in LiDAR view → highlights projected wireframe here
 *
 * Uses the same imperative draw pattern as BBoxOverlayCanvas / LidarProjectionOverlay
 * for zero DOM churn.
 */

import { useRef, useEffect, useCallback, useMemo } from 'react'
import { useSceneStore } from '../../stores/useSceneStore'
import {
  buildCameraProjectors,
  projectBoxToCamera,
  type CameraProjector,
  type ProjectedBox,
} from '../../utils/lidarProjection'
import { computeTransform } from './BBoxOverlayCanvas'
import { setupHiDpiCanvas } from '../../utils/canvasUtils'
import { getManifest } from '../../adapters/registry'
import { HIGHLIGHT_COLOR } from '../../types/waymo'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BoxProjectionOverlayProps {
  cameraName: number
}

/** Cached projected box for hit-testing */
interface ProjectedBoxEntry {
  objectId: string
  type: number
  projected: ProjectedBox
  /** Axis-aligned bounding rect in display coords for fast hit-test */
  displayBounds: { x0: number; y0: number; x1: number; y1: number }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse hex color to [r,g,b] 0–255 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

/** Build type→color map from manifest */
function getBoxColorMap(): Map<number, string> {
  const map = new Map<number, string>()
  for (const bt of getManifest().boxTypes) map.set(bt.id, bt.color)
  return map
}

const HIGHLIGHT_RGB = hexToRgb(HIGHLIGHT_COLOR)

// ---------------------------------------------------------------------------
// Box corner edge indices (matching nuScenes devkit Box.render())
// ---------------------------------------------------------------------------

/** Front face edges: corners 0→1→2→3→0 */
const FRONT_EDGES: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0]]
/** Rear face edges: corners 4→5→6→7→4 */
const REAR_EDGES: [number, number][] = [[4, 5], [5, 6], [6, 7], [7, 4]]
/** Side edges connecting front to rear */
const SIDE_EDGES: [number, number][] = [[0, 4], [1, 5], [2, 6], [3, 7]]

const LINE_WIDTH_NORMAL = 2
const LINE_WIDTH_HIGHLIGHT = 4

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BoxProjectionOverlay({ cameraName }: BoxProjectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const transformRef = useRef<{ scale: number; offsetX: number; offsetY: number }>({ scale: 1, offsetX: 0, offsetY: 0 })
  /** Cached projected boxes for hit-testing (updated on each draw) */
  const projectedRef = useRef<ProjectedBoxEntry[]>([])
  const hitIdRef = useRef<string | null>(null)

  const cameraCalibrations = useSceneStore((s) => s.cameraCalibrations)
  const setHoveredBox = useSceneStore((s) => s.actions.setHoveredBox)
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
    const t = computeTransform(displayW, displayH, projector.width, projector.height)
    transformRef.current = t

    const state = useSceneStore.getState()
    const frame = state.currentFrame
    if (!frame) { projectedRef.current = []; return }

    const boxes = frame.boxes
    if (!boxes || boxes.length === 0) { projectedRef.current = []; return }

    const hoveredBoxId = state.hoveredBoxId
    const colorMap = getBoxColorMap()
    const entries: ProjectedBoxEntry[] = []

    // First pass: project all boxes and cache
    for (const row of boxes) {
      const entry = projectRow(row, projector, t)
      if (entry) entries.push(entry)
    }
    projectedRef.current = entries

    // Second pass: draw non-highlighted first, then highlighted on top
    ctx.lineJoin = 'round'

    for (const entry of entries) {
      if (entry.objectId === hoveredBoxId) continue
      drawBoxWireframe(ctx, entry, t, colorMap, false)
    }
    // Draw highlighted box last (on top)
    for (const entry of entries) {
      if (entry.objectId === hoveredBoxId) {
        drawBoxWireframe(ctx, entry, t, colorMap, true)
      }
    }
  }, [cameraName, projectors])

  // Subscribe to relevant store changes
  useEffect(() => {
    let prevFrame = useSceneStore.getState().currentFrame
    let prevBoxMode = useSceneStore.getState().boxMode
    let prevHovered = useSceneStore.getState().hoveredBoxId
    const unsub = useSceneStore.subscribe((s) => {
      if (s.currentFrame !== prevFrame || s.boxMode !== prevBoxMode || s.hoveredBoxId !== prevHovered) {
        prevFrame = s.currentFrame
        prevBoxMode = s.boxMode
        prevHovered = s.hoveredBoxId
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

  // ---------------------------------------------------------------------------
  // Hit-testing: mousemove → find box under cursor → setHoveredBox
  // ---------------------------------------------------------------------------

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    let hitId: string | null = null

    // Check projected boxes (iterate in reverse so topmost drawn = first hit)
    const entries = projectedRef.current
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      const b = entry.displayBounds
      if (mx >= b.x0 && mx <= b.x1 && my >= b.y0 && my <= b.y1) {
        hitId = entry.objectId
        break
      }
    }

    if (hitId !== hitIdRef.current) {
      hitIdRef.current = hitId
      setHoveredBox(hitId, hitId ? 'laser' : null)
      canvas.style.cursor = hitId ? 'pointer' : 'default'
    }
  }, [setHoveredBox])

  const onMouseLeave = useCallback(() => {
    if (hitIdRef.current !== null) {
      hitIdRef.current = null
      setHoveredBox(null, null)
    }
    if (canvasRef.current) {
      canvasRef.current.style.cursor = 'default'
    }
  }, [setHoveredBox])

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Projection helper
// ---------------------------------------------------------------------------

function projectRow(
  row: Record<string, unknown>,
  projector: CameraProjector,
  t: { scale: number; offsetX: number; offsetY: number },
): ProjectedBoxEntry | null {
  const cx = row['[LiDARBoxComponent].box.center.x'] as number | undefined
  const cy = row['[LiDARBoxComponent].box.center.y'] as number | undefined
  const cz = row['[LiDARBoxComponent].box.center.z'] as number | undefined
  const sx = row['[LiDARBoxComponent].box.size.x'] as number | undefined
  const sy = row['[LiDARBoxComponent].box.size.y'] as number | undefined
  const sz = row['[LiDARBoxComponent].box.size.z'] as number | undefined
  const heading = row['[LiDARBoxComponent].box.heading'] as number | undefined
  const type = (row['[LiDARBoxComponent].type'] as number) ?? 0
  const objectId = (row['key.laser_object_id'] as string) ?? ''

  if (cx == null || cy == null || cz == null ||
      sx == null || sy == null || sz == null || heading == null) return null

  const projected = projectBoxToCamera(cx, cy, cz, sx, sy, sz, heading, projector)
  if (!projected || !projected.anyVisible) return null

  // Compute display-space AABB for hit testing
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [u, v] of projected.corners) {
    const dx = u * t.scale + t.offsetX
    const dy = v * t.scale + t.offsetY
    if (dx < x0) x0 = dx
    if (dy < y0) y0 = dy
    if (dx > x1) x1 = dx
    if (dy > y1) y1 = dy
  }

  return {
    objectId,
    type,
    projected,
    displayBounds: { x0, y0, x1, y1 },
  }
}

// ---------------------------------------------------------------------------
// Draw helpers
// ---------------------------------------------------------------------------

function drawBoxWireframe(
  ctx: CanvasRenderingContext2D,
  entry: ProjectedBoxEntry,
  t: { scale: number; offsetX: number; offsetY: number },
  colorMap: Map<number, string>,
  isHighlighted: boolean,
) {
  const dc = entry.projected.corners.map(
    ([u, v]) => [u * t.scale + t.offsetX, v * t.scale + t.offsetY] as [number, number],
  )

  const [r, g, b] = isHighlighted
    ? HIGHLIGHT_RGB
    : hexToRgb(colorMap.get(entry.type) ?? '#00ff00')

  const lineWidth = (isHighlighted ? LINE_WIDTH_HIGHLIGHT : LINE_WIDTH_NORMAL) * t.scale

  ctx.lineWidth = lineWidth

  // Front face (full opacity)
  ctx.strokeStyle = `rgba(${r},${g},${b},1.0)`
  drawEdges(ctx, dc, FRONT_EDGES)

  // Rear face (dimmed)
  ctx.strokeStyle = `rgba(${r},${g},${b},${isHighlighted ? 0.8 : 0.5})`
  drawEdges(ctx, dc, REAR_EDGES)

  // Side edges
  ctx.strokeStyle = `rgba(${r},${g},${b},${isHighlighted ? 0.7 : 0.35})`
  drawEdges(ctx, dc, SIDE_EDGES)

  // Front direction indicator
  const centerBottomForward = midpoint(dc[2], dc[3])
  const centerBottom = midpoint(midpoint(dc[2], dc[3]), midpoint(dc[6], dc[7]))
  ctx.strokeStyle = `rgba(${r},${g},${b},1.0)`
  ctx.beginPath()
  ctx.moveTo(centerBottom[0], centerBottom[1])
  ctx.lineTo(centerBottomForward[0], centerBottomForward[1])
  ctx.stroke()
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  corners: [number, number][],
  edges: [number, number][],
) {
  for (const [a, b] of edges) {
    ctx.beginPath()
    ctx.moveTo(corners[a][0], corners[a][1])
    ctx.lineTo(corners[b][0], corners[b][1])
    ctx.stroke()
  }
}

function midpoint(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}
