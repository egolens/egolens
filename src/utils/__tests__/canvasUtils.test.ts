/**
 * Unit tests for canvasUtils — shared HiDPI canvas setup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setupHiDpiCanvas, type CanvasSetupResult } from '../canvasUtils'

// ---------------------------------------------------------------------------
// Mock canvas + context
// ---------------------------------------------------------------------------

function makeCanvas(clientW: number, clientH: number, backingW = 0, backingH = 0) {
  return {
    clientWidth: clientW,
    clientHeight: clientH,
    width: backingW,
    height: backingH,
  } as unknown as HTMLCanvasElement
}

function makeCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    scale: vi.fn(),
  } as unknown as CanvasRenderingContext2D
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setupHiDpiCanvas', () => {
  beforeEach(() => {
    // Provide a minimal `window` global for Node test environment
    vi.stubGlobal('window', { devicePixelRatio: 1 })
  })

  it('returns null for zero-width canvas', () => {
    const canvas = makeCanvas(0, 100)
    const ctx = makeCtx()
    expect(setupHiDpiCanvas(canvas, ctx)).toBeNull()
  })

  it('returns null for zero-height canvas', () => {
    const canvas = makeCanvas(100, 0)
    const ctx = makeCtx()
    expect(setupHiDpiCanvas(canvas, ctx)).toBeNull()
  })

  it('sets backing store size = display × dpr (dpr=1)', () => {
    const canvas = makeCanvas(400, 300)
    const ctx = makeCtx()
    const result = setupHiDpiCanvas(canvas, ctx)!
    expect(result).not.toBeNull()
    expect(result.displayW).toBe(400)
    expect(result.displayH).toBe(300)
    expect(result.backingW).toBe(400)
    expect(result.backingH).toBe(300)
    expect(result.dpr).toBe(1)
    expect(canvas.width).toBe(400)
    expect(canvas.height).toBe(300)
  })

  it('sets backing store size = display × dpr (dpr=2)', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 })
    const canvas = makeCanvas(400, 300)
    const ctx = makeCtx()
    const result = setupHiDpiCanvas(canvas, ctx)!
    expect(result.backingW).toBe(800)
    expect(result.backingH).toBe(600)
    expect(result.dpr).toBe(2)
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(600)
  })

  it('does not resize canvas if backing store already matches', () => {
    const canvas = makeCanvas(400, 300, 400, 300) // already correct
    const ctx = makeCtx()
    setupHiDpiCanvas(canvas, ctx)
    // width/height should remain unchanged (no unnecessary mutation)
    expect(canvas.width).toBe(400)
    expect(canvas.height).toBe(300)
  })

  it('calls setTransform, clearRect, and scale in correct order', () => {
    const canvas = makeCanvas(400, 300)
    const ctx = makeCtx()
    setupHiDpiCanvas(canvas, ctx)
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 400, 300)
    expect(ctx.scale).toHaveBeenCalledWith(1, 1)
  })

  it('scales context by dpr', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2.5 })
    const canvas = makeCanvas(400, 300)
    const ctx = makeCtx()
    setupHiDpiCanvas(canvas, ctx)
    expect(ctx.scale).toHaveBeenCalledWith(2.5, 2.5)
  })

  it('handles fractional DPR (1.5)', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1.5 })
    const canvas = makeCanvas(400, 300)
    const ctx = makeCtx()
    const result = setupHiDpiCanvas(canvas, ctx)!
    expect(result.backingW).toBe(600)
    expect(result.backingH).toBe(450)
  })
})
