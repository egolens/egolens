/**
 * Tests for Pin Camera race condition fix.
 *
 * When LidarViewer remounts (Canvas destroyed/recreated during segment switch),
 * PinCameraSync must NOT overwrite the saved camera pose before
 * InitialCameraSetup has had a chance to restore it.
 *
 * The fix uses:
 * - A module-level `_pinnedSnapshot` that survives unmount/remount
 * - A shared `initializedRef` so PinCameraSync waits for InitialCameraSetup
 *
 * These tests verify the ordering guarantees without needing R3F/Canvas.
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Simulate the core logic extracted from LidarViewer.tsx
// ---------------------------------------------------------------------------

/** Module-level snapshot (mirrors _pinnedSnapshot in LidarViewer) */
let pinnedSnapshot: { position: [number, number, number]; target: [number, number, number] } | null = null

/** Simulates PinCameraSync's useFrame callback */
function pinCameraSyncTick(
  pinEnabled: boolean,
  initialized: boolean,
  cameraPosition: [number, number, number],
  orbitTarget: [number, number, number],
) {
  if (!pinEnabled || !initialized) return
  pinnedSnapshot = { position: [...cameraPosition], target: [...orbitTarget] }
}

/** Simulates InitialCameraSetup's useFrame callback (runs once) */
function initialCameraSetupTick(
  pinEnabled: boolean,
): { position: [number, number, number]; target: [number, number, number] } | 'chase-cam' {
  if (pinEnabled && pinnedSnapshot) {
    return { position: [...pinnedSnapshot.position], target: [...pinnedSnapshot.target] }
  }
  return 'chase-cam'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pin Camera race condition', () => {
  const SAVED_POS: [number, number, number] = [50, 30, 80]
  const SAVED_TARGET: [number, number, number] = [10, 5, 0]
  const DEFAULT_POS: [number, number, number] = [-15, 0, 12]
  const DEFAULT_TARGET: [number, number, number] = [5, 0, 0]

  beforeEach(() => {
    pinnedSnapshot = null
  })

  it('should preserve pinned snapshot across simulated unmount/remount', () => {
    // Phase 1: user is in LidarViewer with pin ON, PinCameraSync saves pose
    pinnedSnapshot = { position: SAVED_POS, target: SAVED_TARGET }

    // Phase 2: segment switch → LidarViewer unmounts (Canvas destroyed)
    // _pinnedSnapshot is module-level, survives unmount
    expect(pinnedSnapshot).not.toBeNull()

    // Phase 3: new LidarViewer mounts with fresh Canvas (default camera position)
    const initialized = false // InitialCameraSetup hasn't run yet

    // PinCameraSync ticks BEFORE InitialCameraSetup (race condition scenario)
    pinCameraSyncTick(true, initialized, DEFAULT_POS, DEFAULT_TARGET)

    // Snapshot should NOT be overwritten because initialized = false
    expect(pinnedSnapshot!.position).toEqual(SAVED_POS)
    expect(pinnedSnapshot!.target).toEqual(SAVED_TARGET)
  })

  it('should restore pinned pose in InitialCameraSetup', () => {
    pinnedSnapshot = { position: SAVED_POS, target: SAVED_TARGET }

    // InitialCameraSetup reads the preserved snapshot
    const result = initialCameraSetupTick(true)
    expect(result).not.toBe('chase-cam')
    if (result !== 'chase-cam') {
      expect(result.position).toEqual(SAVED_POS)
      expect(result.target).toEqual(SAVED_TARGET)
    }
  })

  it('should fall back to chase-cam when pin is off', () => {
    pinnedSnapshot = { position: SAVED_POS, target: SAVED_TARGET }

    const result = initialCameraSetupTick(false)
    expect(result).toBe('chase-cam')
  })

  it('should fall back to chase-cam when no snapshot exists', () => {
    pinnedSnapshot = null

    const result = initialCameraSetupTick(true)
    expect(result).toBe('chase-cam')
  })

  it('should allow PinCameraSync to save AFTER initialization', () => {
    pinnedSnapshot = { position: SAVED_POS, target: SAVED_TARGET }

    // InitialCameraSetup runs and sets initialized = true
    initialCameraSetupTick(true)
    const initialized = true

    // Now PinCameraSync should be allowed to save new poses
    const NEW_POS: [number, number, number] = [100, 200, 300]
    const NEW_TARGET: [number, number, number] = [0, 0, 0]
    pinCameraSyncTick(true, initialized, NEW_POS, NEW_TARGET)

    expect(pinnedSnapshot!.position).toEqual(NEW_POS)
    expect(pinnedSnapshot!.target).toEqual(NEW_TARGET)
  })

  it('should not save when pin is disabled even if initialized', () => {
    pinnedSnapshot = { position: SAVED_POS, target: SAVED_TARGET }

    pinCameraSyncTick(false, true, DEFAULT_POS, DEFAULT_TARGET)

    // Should not overwrite — pin is off
    expect(pinnedSnapshot!.position).toEqual(SAVED_POS)
  })

  it('should simulate full segment switch cycle correctly', () => {
    // 1. User has pin ON, camera at custom position
    pinnedSnapshot = { position: SAVED_POS, target: SAVED_TARGET }

    // 2. Segment switch → unmount (snapshot survives)
    // 3. Remount — new Canvas with default camera
    let initialized = false

    // 4. PinCameraSync fires first (race!) — blocked by initialized check
    pinCameraSyncTick(true, initialized, DEFAULT_POS, DEFAULT_TARGET)
    expect(pinnedSnapshot!.position).toEqual(SAVED_POS) // still preserved!

    // 5. InitialCameraSetup fires — reads and restores saved pose
    const restored = initialCameraSetupTick(true)
    expect(restored).not.toBe('chase-cam')
    if (restored !== 'chase-cam') {
      expect(restored.position).toEqual(SAVED_POS)
    }
    initialized = true

    // 6. Now PinCameraSync can save the (restored) position
    pinCameraSyncTick(true, initialized, SAVED_POS, SAVED_TARGET)
    expect(pinnedSnapshot!.position).toEqual(SAVED_POS)
  })
})
