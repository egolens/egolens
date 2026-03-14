/**
 * BBoxOverlayCanvas — Canvas 2D bounding box overlay for camera panels.
 *
 * Replaces the SVG-based BBoxOverlay to eliminate DOM attribute mutations
 * during frame scrubbing. Instead of React-diffing ~131 <rect> elements
 * (350+ DOM mutations per scrub), this component does a single clearRect
 * + loop of strokeRect calls per camera — zero DOM churn.
 *
 * Props are identical to the SVG version for drop-in swap.
 */

import { useRef, useEffect, useCallback } from 'react'
import { useSceneStore } from '../../stores/useSceneStore'
import { BoxType, CAMERA_RESOLUTION, HIGHLIGHT_COLOR } from '../../types/waymo'
import { getManifest } from '../../adapters/registry'
import { setupHiDpiCanvas } from '../../utils/canvasUtils'
import type { ParquetRow } from '../../utils/merge'

const BBOX_STROKE_WIDTH = 4
const BBOX_STROKE_WIDTH_HIGHLIGHT = 7

interface BBoxOverlayCanvasProps {
  cameraName: number
  boxes: ParquetRow[]
}

/** Image-space → display-space transform (matches SVG preserveAspectRatio="xMidYMid slice") */
interface Transform {
  scale: number
  offsetX: number
  offsetY: number
}

/** Exported for testing — maps image pixels → display pixels (xMidYMid slice) */
export function computeTransform(
  displayW: number,
  displayH: number,
  imgW: number,
  imgH: number,
): Transform {
  const scale = Math.max(displayW / imgW, displayH / imgH)
  const offsetX = (displayW - imgW * scale) / 2
  const offsetY = (displayH - imgH * scale) / 2
  return { scale, offsetX, offsetY }
}

export default function BBoxOverlayCanvas({ cameraName, boxes }: BBoxOverlayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const transformRef = useRef<Transform>({ scale: 1, offsetX: 0, offsetY: 0 })
  const hitIdRef = useRef<string | null>(null)

  // Keep latest values in refs for imperative callbacks (ResizeObserver, mousemove)
  const boxesRef = useRef(boxes)
  boxesRef.current = boxes

  const res = CAMERA_RESOLUTION[cameraName] ?? { width: 1920, height: 1280 }

  // Store subscriptions (stable selectors — no re-render churn)
  const highlightRef = useRef(useSceneStore.getState().highlightedCameraBoxIds)
  const hoveredRef = useRef(useSceneStore.getState().hoveredBoxId)
  const setHoveredBox = useSceneStore((s) => s.actions.setHoveredBox)

  // Subscribe to highlight/hover changes imperatively
  useEffect(() => {
    let prevHighlight = highlightRef.current
    let prevHovered = hoveredRef.current
    const unsub = useSceneStore.subscribe((s) => {
      const nextHighlight = s.highlightedCameraBoxIds
      const nextHovered = s.hoveredBoxId
      if (nextHighlight !== prevHighlight || nextHovered !== prevHovered) {
        prevHighlight = nextHighlight
        prevHovered = nextHovered
        highlightRef.current = nextHighlight
        hoveredRef.current = nextHovered
        draw()
      }
    })
    return () => unsub()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const setup = setupHiDpiCanvas(canvas, ctx)
    if (!setup) return

    const { displayW, displayH } = setup
    const t = computeTransform(displayW, displayH, res.width, res.height)
    transformRef.current = t

    const currentBoxes = boxesRef.current
    const highlighted = highlightRef.current
    const hovered = hoveredRef.current

    for (const row of currentBoxes) {
      const cx = row['[CameraBoxComponent].box.center.x'] as number
      const cy = row['[CameraBoxComponent].box.center.y'] as number
      const w = row['[CameraBoxComponent].box.size.x'] as number
      const h = row['[CameraBoxComponent].box.size.y'] as number
      const type = (row['[CameraBoxComponent].type'] as number) ?? 0
      const camObjectId = (row['key.camera_object_id'] as string) ?? ''

      const isHighlighted = hovered === camObjectId || highlighted.has(camObjectId)
      const btDef = getManifest().boxTypes.find((bt) => bt.id === type)
      const color = isHighlighted ? HIGHLIGHT_COLOR : (btDef?.color ?? '#6B7280')
      const strokeW = isHighlighted ? BBOX_STROKE_WIDTH_HIGHLIGHT : BBOX_STROKE_WIDTH

      // Map image-space → display-space
      const x = (cx - w / 2) * t.scale + t.offsetX
      const y = (cy - h / 2) * t.scale + t.offsetY
      const rw = w * t.scale
      const rh = h * t.scale
      const sw = strokeW * t.scale

      ctx.strokeStyle = color
      ctx.lineWidth = sw
      ctx.globalAlpha = isHighlighted ? 1.0 : 0.85
      ctx.strokeRect(x, y, rw, rh)
    }

    ctx.globalAlpha = 1.0
  }, [res.width, res.height])

  // Redraw when boxes change
  useEffect(() => {
    draw()
  }, [boxes, draw])

  // ResizeObserver — update canvas dimensions + redraw
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver(() => { draw() })
    ro.observe(container)
    // Initial draw
    draw()
    return () => ro.disconnect()
  }, [draw])

  // Hit-testing: inverse-transform mouse coords → image space, loop interactive boxes
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const t = transformRef.current
    // Display → image space
    const imgX = (mx - t.offsetX) / t.scale
    const imgY = (my - t.offsetY) / t.scale

    let hitId: string | null = null

    const currentBoxes = boxesRef.current
    for (const row of currentBoxes) {
      const type = (row['[CameraBoxComponent].type'] as number) ?? 0
      // Only pedestrian/cyclist have associations → only they are interactive
      if (type !== BoxType.TYPE_PEDESTRIAN && type !== BoxType.TYPE_CYCLIST) continue

      const camObjectId = (row['key.camera_object_id'] as string) ?? ''
      if (!camObjectId) continue

      const cx = row['[CameraBoxComponent].box.center.x'] as number
      const cy = row['[CameraBoxComponent].box.center.y'] as number
      const w = row['[CameraBoxComponent].box.size.x'] as number
      const h = row['[CameraBoxComponent].box.size.y'] as number

      const x0 = cx - w / 2
      const y0 = cy - h / 2
      if (imgX >= x0 && imgX <= x0 + w && imgY >= y0 && imgY <= y0 + h) {
        hitId = camObjectId
        break
      }
    }

    // Avoid redundant store calls when mouse moves within same box
    if (hitId !== hitIdRef.current) {
      hitIdRef.current = hitId
      setHoveredBox(hitId, hitId ? 'camera' : null)
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
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  )
}
