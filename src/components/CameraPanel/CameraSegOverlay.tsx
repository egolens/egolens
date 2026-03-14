/**
 * CameraSegOverlay — Canvas 2D overlay for camera panoptic segmentation.
 *
 * Decodes uint16 PNG panoptic labels via UPNG.decode(), extracts semantic
 * class per pixel using `semantic_class = pixel_value / divisor | 0`, then
 * renders a semi-transparent colored overlay using WAYMO_CAMERA_SEG_PALETTE.
 *
 * Data source: camera_segmentation parquet → cameraSeg in internal store.
 *
 * IMPORTANT: UPNG.decode().data may contain W×H×2 + H bytes (one trailing
 * byte per row from defilter). We use stride = W × 2 to skip them safely.
 *
 * Performance: ~22ms per 1920×1280 PNG decode + ~5ms for RGBA overlay build.
 * 5 cameras sequentially = ~135ms — acceptable for frame transitions.
 */

import { useRef, useEffect, useCallback } from 'react'
import UPNG from 'upng-js'
import { useSceneStore } from '../../stores/useSceneStore'
import { CAMERA_RESOLUTION } from '../../types/waymo'
import { computeTransform } from './BBoxOverlayCanvas'
import { setupHiDpiCanvas } from '../../utils/canvasUtils'
import { WAYMO_CAMERA_SEG_PALETTE } from '../../utils/waymoSemanticClasses'

// ---------------------------------------------------------------------------
// Module-level data reference (shared from store)
// ---------------------------------------------------------------------------

type CameraSegMap = Map<bigint, Map<number, { panopticLabel: ArrayBuffer; divisor: number }>>

let _cameraSegByFrame: CameraSegMap = new Map()

export function setCameraSegByFrameRef(map: CameraSegMap) {
  _cameraSegByFrame = map
}

// ---------------------------------------------------------------------------
// Drawing constants
// ---------------------------------------------------------------------------

const OVERLAY_ALPHA = 0.35

// Pre-build a Uint8Array lookup table from the palette (29 classes × 4 channels)
const PALETTE_RGBA = buildPaletteRGBA()

function buildPaletteRGBA(): Uint8Array {
  const n = WAYMO_CAMERA_SEG_PALETTE.length
  const lut = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const [r, g, b] = WAYMO_CAMERA_SEG_PALETTE[i]
    lut[i * 4] = Math.round(r * 255)
    lut[i * 4 + 1] = Math.round(g * 255)
    lut[i * 4 + 2] = Math.round(b * 255)
    lut[i * 4 + 3] = Math.round(OVERLAY_ALPHA * 255)
  }
  // Class 0 (Undefined) should be fully transparent
  lut[3] = 0
  return lut
}

// ---------------------------------------------------------------------------
// Decode helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Decode a panoptic PNG into an RGBA ImageData suitable for drawImage.
 *
 * The PNG is uint16 grayscale. Each pixel value encodes:
 *   panoptic_value = semantic_class * divisor + instance_id
 *
 * We only need semantic_class = (panoptic_value / divisor) | 0.
 * The resulting RGBA uses WAYMO_CAMERA_SEG_PALETTE colors.
 */
export function decodePanopticToRGBA(
  pngBuffer: ArrayBuffer,
  divisor: number,
): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  try {
    const img = UPNG.decode(pngBuffer)
    if (img.depth !== 16 || img.ctype !== 0) {
      // Not uint16 grayscale — unexpected format
      console.warn('[CameraSegOverlay] Unexpected PNG format:', img.depth, img.ctype)
      return null
    }

    const W = img.width
    const H = img.height
    const data = new DataView(img.data)
    const rgba = new Uint8ClampedArray(W * H * 4)
    const numClasses = WAYMO_CAMERA_SEG_PALETTE.length

    // UPNG.decode().data may have trailing bytes per row.
    // Actual stride = W * 2 bytes per row (uint16 grayscale, big-endian).
    // Total useful bytes = W * H * 2. We read sequentially.
    const stride = W * 2
    const totalBytes = data.byteLength

    for (let y = 0; y < H; y++) {
      const rowOffset = y * stride
      if (rowOffset + stride > totalBytes) break
      for (let x = 0; x < W; x++) {
        const bytePos = rowOffset + x * 2
        const panopticValue = data.getUint16(bytePos, false) // big-endian
        const semanticClass = (panopticValue / divisor) | 0
        const pixIdx = (y * W + x) * 4
        if (semanticClass > 0 && semanticClass < numClasses) {
          const lutIdx = semanticClass * 4
          rgba[pixIdx] = PALETTE_RGBA[lutIdx]
          rgba[pixIdx + 1] = PALETTE_RGBA[lutIdx + 1]
          rgba[pixIdx + 2] = PALETTE_RGBA[lutIdx + 2]
          rgba[pixIdx + 3] = PALETTE_RGBA[lutIdx + 3]
        }
        // else: semanticClass 0 or out of range → leave transparent (0,0,0,0)
      }
    }

    return { width: W, height: H, rgba }
  } catch (e) {
    console.warn('[CameraSegOverlay] PNG decode error:', e)
    return null
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CameraSegOverlayProps {
  cameraName: number
}

export default function CameraSegOverlay({ cameraName }: CameraSegOverlayProps) {
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

    // Get current frame timestamp
    const currentFrame = useSceneStore.getState().currentFrame
    if (!currentFrame) return

    const frameMap = _cameraSegByFrame.get(currentFrame.timestamp)
    if (!frameMap) return

    const entry = frameMap.get(cameraName)
    if (!entry) return

    // Decode panoptic PNG → RGBA
    const decoded = decodePanopticToRGBA(entry.panopticLabel, entry.divisor)
    if (!decoded) return

    // Create ImageData and draw it scaled to fit
    const imgData = new ImageData(decoded.rgba, decoded.width, decoded.height)

    // Use an offscreen canvas to hold the decoded image, then draw scaled
    const offscreen = new OffscreenCanvas(decoded.width, decoded.height)
    const offCtx = offscreen.getContext('2d')
    if (!offCtx) return
    offCtx.putImageData(imgData, 0, 0)

    // Apply the same xMidYMid slice transform as bbox/keypoint overlays
    const t = computeTransform(displayW, displayH, res.width, res.height)
    ctx.drawImage(
      offscreen,
      0, 0, decoded.width, decoded.height,
      t.offsetX, t.offsetY,
      res.width * t.scale, res.height * t.scale,
    )
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
