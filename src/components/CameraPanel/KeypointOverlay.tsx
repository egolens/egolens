/**
 * KeypointOverlay — Canvas 2D overlay for camera keypoints (Waymo camera_hkp).
 *
 * Draws per-joint colored circles + per-bone colored line segments on top of
 * camera image panels. Follows the same imperative Canvas draw pattern as
 * BBoxOverlayCanvas for zero DOM churn during frame scrubbing.
 *
 * Data source: camera_hkp parquet → cameraKeypointsByFrame in internal store.
 *
 * IMPORTANT: Each parquet row is ONE pedestrian object, with arrays of joints:
 *   - `[CameraHumanKeypointsComponent].camera_keypoints[*].type` — proto enum ints
 *   - `[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.{x,y}`
 *   - `[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.visibility.is_occluded`
 */

import { useRef, useEffect, useCallback } from 'react'
import { useSceneStore } from '../../stores/useSceneStore'
import { CAMERA_RESOLUTION } from '../../types/waymo'
import { computeTransform } from './BBoxOverlayCanvas'
import { setupHiDpiCanvas } from '../../utils/canvasUtils'
import {
  WAYMO_SKELETON_BONES,
  WAYMO_KEYPOINT_COLORS,
  WAYMO_BONE_COLORS,
} from '../../utils/waymoSemanticClasses'
import type { ParquetRow } from '../../utils/merge'

// ---------------------------------------------------------------------------
// Parquet column names (v2.0 camera_hkp schema)
// ---------------------------------------------------------------------------

const COL_CAMERA_NAME = 'key.camera_name'
const COL_TYPE = '[CameraHumanKeypointsComponent].camera_keypoints[*].type'
const COL_PX_X = '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.x'
const COL_PX_Y = '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.location_px.y'
const COL_OCCLUDED = '[CameraHumanKeypointsComponent].camera_keypoints[*].keypoint_2d.visibility.is_occluded'

// ---------------------------------------------------------------------------
// Drawing constants
// ---------------------------------------------------------------------------

const JOINT_RADIUS = 8        // display pixels
const BONE_LINE_WIDTH = 5     // display pixels
const OCCLUDED_ALPHA = 0.3
const DEFAULT_COLOR: [number, number, number] = [0.8, 1.0, 0.0]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CameraKeypointJoint {
  type: number
  x: number
  y: number
  occluded: boolean
}

interface CameraKeypointObject {
  joints: CameraKeypointJoint[]
}

// ---------------------------------------------------------------------------
// Module-level data reference (shared from store)
// ---------------------------------------------------------------------------

let _cameraKeypointsByFrame: Map<bigint, ParquetRow[]> = new Map()

export function setCameraKeypointsByFrameRef(map: Map<bigint, ParquetRow[]>) {
  _cameraKeypointsByFrame = map
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse camera keypoint rows for a specific camera into CameraKeypointObject[].
 */
export function parseCameraKeypointRows(
  rows: ParquetRow[],
  cameraName: number,
): CameraKeypointObject[] {
  const result: CameraKeypointObject[] = []

  for (const row of rows) {
    const camName = row[COL_CAMERA_NAME] as number | undefined
    if (camName !== cameraName) continue

    const types = row[COL_TYPE] as number[] | undefined
    const pxXs = row[COL_PX_X] as number[] | undefined
    const pxYs = row[COL_PX_Y] as number[] | undefined
    const occluded = row[COL_OCCLUDED] as boolean[] | undefined

    if (!types || !pxXs || !pxYs) continue
    const n = Math.min(types.length, pxXs.length, pxYs.length)
    if (n === 0) continue

    const joints: CameraKeypointJoint[] = []
    for (let i = 0; i < n; i++) {
      joints.push({
        type: types[i],
        x: pxXs[i],
        y: pxYs[i],
        occluded: occluded ? occluded[i] ?? false : false,
      })
    }
    result.push({ joints })
  }

  return result
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface KeypointOverlayProps {
  cameraName: number
}

export default function KeypointOverlay({ cameraName }: KeypointOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const res = CAMERA_RESOLUTION[cameraName] ?? { width: 1920, height: 1280 }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const setup = setupHiDpiCanvas(canvas, ctx)
    if (!setup) return

    const { displayW, displayH } = setup
    const t = computeTransform(displayW, displayH, res.width, res.height)

    // Get current frame timestamp
    const currentFrame = useSceneStore.getState().currentFrame
    if (!currentFrame) return

    const rows = _cameraKeypointsByFrame.get(currentFrame.timestamp)
    if (!rows || rows.length === 0) return

    const objects = parseCameraKeypointRows(rows, cameraName)
    if (objects.length === 0) return

    // Draw each object
    for (const obj of objects) {
      // Build type→joint map for bone lookups
      const jointByType = new Map<number, CameraKeypointJoint>()
      for (const j of obj.joints) {
        jointByType.set(j.type, j)
      }

      // --- Draw bones first (behind joints) ---
      for (const [fromType, toType] of WAYMO_SKELETON_BONES) {
        const from = jointByType.get(fromType)
        const to = jointByType.get(toType)
        if (!from || !to) continue

        const boneKey = `${fromType}-${toType}`
        const rgb = WAYMO_BONE_COLORS[boneKey] ?? DEFAULT_COLOR
        const bothOccluded = from.occluded && to.occluded
        const anyOccluded = from.occluded || to.occluded

        const x1 = from.x * t.scale + t.offsetX
        const y1 = from.y * t.scale + t.offsetY
        const x2 = to.x * t.scale + t.offsetX
        const y2 = to.y * t.scale + t.offsetY

        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.strokeStyle = `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${bothOccluded ? OCCLUDED_ALPHA : anyOccluded ? 0.55 : 0.9})`
        ctx.lineWidth = BONE_LINE_WIDTH * t.scale
        if (anyOccluded) {
          ctx.setLineDash([4 * t.scale, 3 * t.scale])
        } else {
          ctx.setLineDash([])
        }
        ctx.stroke()
      }

      // Reset line dash
      ctx.setLineDash([])

      // --- Draw joints on top ---
      for (const j of obj.joints) {
        const rgb = WAYMO_KEYPOINT_COLORS[j.type] ?? DEFAULT_COLOR
        const px = j.x * t.scale + t.offsetX
        const py = j.y * t.scale + t.offsetY
        const r = JOINT_RADIUS * t.scale

        ctx.beginPath()
        ctx.arc(px, py, r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${j.occluded ? OCCLUDED_ALPHA : 1.0})`
        ctx.fill()

        // White outline for visibility against any background
        ctx.strokeStyle = `rgba(255, 255, 255, ${j.occluded ? 0.2 : 0.6})`
        ctx.lineWidth = 1.0 * t.scale
        ctx.stroke()
      }
    }
  }, [cameraName, res.width, res.height])

  // Subscribe to frame changes imperatively (same pattern as BBoxOverlayCanvas)
  useEffect(() => {
    let prevFrame = useSceneStore.getState().currentFrame
    const unsub = useSceneStore.subscribe((s) => {
      const nextFrame = s.currentFrame
      if (nextFrame !== prevFrame) {
        prevFrame = nextFrame
        draw()
      }
    })
    return () => unsub()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw])

  // ResizeObserver — update canvas dimensions + redraw
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver(() => { draw() })
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
