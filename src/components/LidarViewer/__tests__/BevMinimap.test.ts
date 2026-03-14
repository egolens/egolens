/**
 * Unit tests for BevMinimap scheduling behaviour.
 *
 * The BEV minimap subscribes to Zustand store changes and renders the scene
 * via a separate WebGLRenderer.  After switching to a double-rAF schedule
 * (to let R3F reconcile the scene graph before the BEV captures it), these
 * tests verify:
 *
 *   1. Store subscription fires on each relevant state key.
 *   2. The render callback is invoked after exactly TWO rAF ticks (double-rAF).
 *   3. Rapid successive state changes are coalesced (only one render).
 *   4. Cleanup cancels pending rAF and unsubscribes from the store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSceneStore } from '../../../stores/useSceneStore'

// ---------------------------------------------------------------------------
// Manual rAF mock — tracks nested calls
// ---------------------------------------------------------------------------

/** Queued rAF callbacks, each tagged with an id */
let rafQueue: { id: number; cb: FrameRequestCallback }[] = []
let rafCounter = 0
let cancelledIds = new Set<number>()

function mockRAF(cb: FrameRequestCallback): number {
  const id = ++rafCounter
  rafQueue.push({ id, cb })
  return id
}

function mockCancelRAF(id: number) {
  cancelledIds.add(id)
  rafQueue = rafQueue.filter((entry) => entry.id !== id)
}

/** Flush ONE tick of rAF callbacks (executes all currently queued, not recursively added) */
function flushOneRAFTick() {
  const batch = [...rafQueue]
  rafQueue = []
  for (const { id, cb } of batch) {
    if (!cancelledIds.has(id)) cb(performance.now())
  }
}

// ---------------------------------------------------------------------------
// Recreate the BEV subscription + scheduling logic in isolation
// (extracted from BevMinimapRenderer's useEffect)
// ---------------------------------------------------------------------------

interface BevScheduler {
  unsub: () => void
  renderCount: number
  /** Expose for assertions */
  rafId: number
}

/**
 * Mimics the scheduling logic inside BevMinimapRenderer's store-subscription
 * useEffect, but without React/R3F dependencies.
 */
function createBevScheduler(): BevScheduler {
  const state: BevScheduler = { unsub: () => {}, renderCount: 0, rafId: 0 }

  const render = () => {
    state.renderCount++
  }

  const scheduleRender = () => {
    cancelAnimationFrame(state.rafId)
    state.rafId = requestAnimationFrame(() => {
      state.rafId = requestAnimationFrame(render)
    })
  }

  // Initial render
  scheduleRender()

  // Subscribe to store — mirrors BevMinimap.tsx lines 119-131
  const unsub = useSceneStore.subscribe((s, prev) => {
    if (
      s.currentFrame !== prev.currentFrame ||
      s.worldMode !== prev.worldMode ||
      s.visibleSensors !== prev.visibleSensors ||
      s.boxMode !== prev.boxMode ||
      s.colormapMode !== prev.colormapMode ||
      s.pointOpacity !== prev.pointOpacity ||
      s.trailLength !== prev.trailLength
    ) {
      scheduleRender()
    }
  })

  state.unsub = () => {
    unsub()
    cancelAnimationFrame(state.rafId)
  }

  return state
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BevMinimap scheduling (double-rAF)', () => {
  beforeEach(() => {
    rafQueue = []
    rafCounter = 0
    cancelledIds = new Set()
    vi.stubGlobal('requestAnimationFrame', mockRAF)
    vi.stubGlobal('cancelAnimationFrame', mockCancelRAF)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does NOT render after a single rAF tick', () => {
    const sched = createBevScheduler()
    // After creation, one scheduleRender() call is pending
    flushOneRAFTick() // first rAF — should queue the second
    expect(sched.renderCount).toBe(0) // not rendered yet!
    sched.unsub()
  })

  it('renders after exactly two rAF ticks (double-rAF)', () => {
    const sched = createBevScheduler()
    flushOneRAFTick() // first rAF → queues second rAF
    flushOneRAFTick() // second rAF → calls render()
    expect(sched.renderCount).toBe(1)
    sched.unsub()
  })

  it('triggers render on boxMode change', () => {
    const sched = createBevScheduler()
    // Drain initial scheduleRender
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(1)

    // Change boxMode
    useSceneStore.setState({ boxMode: 'model' })
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(2)

    sched.unsub()
    // Reset
    useSceneStore.setState({ boxMode: 'box' })
  })

  it('triggers render on colormapMode change', () => {
    const sched = createBevScheduler()
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(1)

    useSceneStore.setState({ colormapMode: 'range' })
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(2)

    sched.unsub()
    useSceneStore.setState({ colormapMode: 'intensity' })
  })

  it('triggers render on worldMode change', () => {
    const sched = createBevScheduler()
    flushOneRAFTick()
    flushOneRAFTick()

    const prev = useSceneStore.getState().worldMode
    useSceneStore.setState({ worldMode: !prev })
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(2)

    sched.unsub()
    useSceneStore.setState({ worldMode: prev })
  })

  it('triggers render on pointOpacity change', () => {
    const sched = createBevScheduler()
    flushOneRAFTick()
    flushOneRAFTick()

    useSceneStore.setState({ pointOpacity: 0.5 })
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(2)

    sched.unsub()
    useSceneStore.setState({ pointOpacity: 1.0 })
  })

  it('triggers render on trailLength change', () => {
    const sched = createBevScheduler()
    flushOneRAFTick()
    flushOneRAFTick()

    useSceneStore.setState({ trailLength: 25 })
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(2)

    sched.unsub()
    useSceneStore.setState({ trailLength: 10 })
  })

  it('coalesces rapid successive state changes into one render', () => {
    const sched = createBevScheduler()
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(1)

    // Fire multiple store changes before any rAF tick
    useSceneStore.setState({ boxMode: 'model' })
    useSceneStore.setState({ colormapMode: 'range' })
    useSceneStore.setState({ pointOpacity: 0.3 })

    // Each setState triggers scheduleRender() which cancels prev rAF,
    // so only the LAST schedule survives
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(2) // only one extra render

    sched.unsub()
    useSceneStore.setState({ boxMode: 'box', colormapMode: 'intensity', pointOpacity: 1.0 })
  })

  it('does NOT render on irrelevant state changes', () => {
    const sched = createBevScheduler()
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(1)

    // activeCam is NOT in the subscription filter
    useSceneStore.setState({ activeCam: 1 })
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(1) // no extra render

    sched.unsub()
    useSceneStore.setState({ activeCam: null })
  })

  it('cleanup cancels pending rAF and stops subscription', () => {
    const sched = createBevScheduler()
    // Don't flush — leave the initial rAF pending
    sched.unsub()

    // The pending rAF should be cancelled
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(0)

    // Store changes should not trigger render either
    useSceneStore.setState({ boxMode: 'model' })
    flushOneRAFTick()
    flushOneRAFTick()
    expect(sched.renderCount).toBe(0)

    useSceneStore.setState({ boxMode: 'box' })
  })
})
