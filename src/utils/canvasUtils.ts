/**
 * Shared Canvas 2D utilities for HiDPI overlay rendering.
 *
 * Used by BBoxOverlayCanvas, LidarProjectionOverlay, and BoxProjectionOverlay
 * to avoid duplicating DPR-aware canvas setup code.
 */

export interface CanvasSetupResult {
  /** Device pixel ratio used */
  dpr: number
  /** CSS display width */
  displayW: number
  /** CSS display height */
  displayH: number
  /** Backing store width (display × dpr) */
  backingW: number
  /** Backing store height (display × dpr) */
  backingH: number
}

/**
 * Set up a canvas for HiDPI rendering:
 *  1. Compute DPR-aware backing store size
 *  2. Resize canvas backing store if needed (avoids unnecessary resizes)
 *  3. Reset transform, clear, and apply DPR scale
 *
 * @returns Setup result, or null if canvas has zero display dimensions
 */
export function setupHiDpiCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): CanvasSetupResult | null {
  const dpr = window.devicePixelRatio || 1
  const displayW = canvas.clientWidth
  const displayH = canvas.clientHeight
  if (displayW === 0 || displayH === 0) return null

  const backingW = Math.round(displayW * dpr)
  const backingH = Math.round(displayH * dpr)
  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW
    canvas.height = backingH
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, backingW, backingH)
  ctx.scale(dpr, dpr)

  return { dpr, displayW, displayH, backingW, backingH }
}
