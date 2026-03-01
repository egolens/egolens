# R3F Render Synchronization: useFrame vs useEffect

## Problem

In world coordinate mode, scrubbing to a new frame caused a visible "double render" jitter — the scene appeared to lurch/stutter instead of moving smoothly. The effect was a single-frame spatial pop where the point cloud jumped to the wrong position and snapped back.

## Root Cause

The scene group's world-pose matrix was updated via `useEffect`, while the point cloud buffer was updated via `useFrame`. These run in **different phases** of the render cycle:

- `useEffect` fires **after** React commits (after paint)
- `useFrame` fires **during** the next Three.js render loop (`requestAnimationFrame`)

This timing gap meant the group matrix and point buffer could be out of sync for one rendered frame.

### Desync Timeline

```
Zustand set()          React re-render         useEffect (after paint)    useFrame (next rAF)
─────────────────      ─────────────────       ──────────────────────     ──────────────────
currentFrame = N+1     BoundingBoxes re-render  sceneGroup.matrix =       PointCloud buffer =
currentFrameIndex++    with boxes_N+1           pose_N+1                  cloud_N+1
                       (immediate JSX)          (too late for this paint) (finally in sync)
```

### The Jittery Frame

```
Frame N (correct)       Intermediate (jitter!)        Frame N+1 (correct)
─────────────────       ──────────────────────        ─────────────────
Points:  cloud_N        Points:  cloud_N    (stale)   Points:  cloud_N+1
Pose:    pose_N         Pose:    pose_N     (stale)   Pose:    pose_N+1
Boxes:   boxes_N        Boxes:   boxes_N+1  (new!)    Boxes:   boxes_N+1
                        ↑ boxes jumped, rest lagged
```

For one paint cycle, BoundingBoxes (React JSX, synchronous) showed new positions while the group matrix and point buffer still held old data. This manifested as boxes snapping ahead of the cloud.

### Why Invisible in Vehicle Mode

In vehicle mode, the scene group matrix is always identity. Since `identity == identity` regardless of frame, the one-frame lag has no visual effect — there's no spatial offset to notice.

In world mode, consecutive frames have different poses (the vehicle moves through the world), so the desync produces a visible spatial discontinuity.

## Fix (v1 → v2)

### v1: useEffect → useFrame (partial fix)

Initially replaced the `useEffect` with a `useFrame`-only approach. This fixed the useEffect-after-paint desync but a subtler jitter remained during arrow-key scrubbing (not visible during playback).

### v2: Zustand subscribe + useFrame (complete fix)

**Root cause of remaining jitter:** Arrow-key handlers trigger React's SyncLane, causing synchronous React reconciliation. BoundingBoxes updates its Three.js objects (new box positions) during this synchronous commit. But `useFrame` hasn't run yet — it only fires on the next rAF tick. So R3F renders intermediate frames where boxes have new positions but the group matrix still holds the old pose.

This wasn't visible during playback because `setInterval` callbacks use React's DefaultLane (concurrent), which defers reconciliation to after the next rAF tick — by which time `useFrame` has already updated the matrix.

**Fix:** Use `useSceneStore.subscribe()` to update the group matrix **synchronously during Zustand's `set()`**, before React even starts re-rendering:

```tsx
function WorldPoseSync({ groupRef }) {
  // Layer 1: synchronous update via store subscription
  useEffect(() => {
    const applyPose = (wm, pose) => {
      const group = groupRef.current
      if (!group) return
      if (wm && pose) {
        _poseMatrix.fromArray(pose).transpose()
        group.matrix.copy(_poseMatrix)
      } else {
        group.matrix.identity()
      }
      group.matrixWorldNeedsUpdate = true
    }

    // Apply current state (handles mount)
    const s = useSceneStore.getState()
    applyPose(s.worldMode, s.currentFrame?.vehiclePose ?? null)

    // Subscribe — fires synchronously during set(), before React re-render
    return useSceneStore.subscribe((state, prev) => {
      if (state.currentFrame !== prev.currentFrame || state.worldMode !== prev.worldMode) {
        applyPose(state.worldMode, state.currentFrame?.vehiclePose ?? null)
      }
    })
  }, [groupRef])

  // Layer 2: safety-net in useFrame for continuous correctness
  useFrame(() => {
    const { worldMode, currentFrame } = useSceneStore.getState()
    applyPose(worldMode, currentFrame?.vehiclePose ?? null)
  })

  return null
}
```

### Timeline After Fix

```
Zustand set()       subscribe callback      React SyncLane commit      useFrame (next rAF)
─────────────       ──────────────────      ─────────────────────      ──────────────────
currentFrame=N+1    group.matrix=pose_N+1   BoundingBoxes=boxes_N+1   (matrix already correct)
                    ↑ BEFORE React renders  ↑ matrix already in sync   ↑ safety-net re-apply
```

### Why Arrow Keys Jittered But Play Didn't

| Trigger | React Lane | Reconciliation timing | Matrix update timing | Result |
|---------|-----------|----------------------|---------------------|--------|
| Arrow key (keydown) | SyncLane | Synchronous (immediate) | useFrame (next rAF) | Desync! |
| Play (setInterval) | DefaultLane | Deferred (next microtask) | useFrame (next rAF) | In sync |

With SyncLane, React flushes the commit synchronously during the event handler. BoundingBoxes' Three.js objects update immediately, but `useFrame` hasn't run yet. With DefaultLane, React defers the commit, so `useFrame` runs first on the next rAF tick.

The subscribe approach eliminates this timing dependency entirely — the matrix is always updated before React touches anything.

## Verification

- World mode scrub (ArrowRight/ArrowLeft): smooth movement, no jitter
- Play mode: no regression, behavior unchanged
- Vehicle mode: no regression (matrix is identity regardless)
- INP: 58ms (processing: 0.1ms)
- Build: clean (`npm run build` + `npm test` pass)

## General Lessons

### 1. useEffect vs useFrame vs subscribe

| Mechanism | When it fires | Use for |
|-----------|--------------|---------|
| `useEffect` | After React commit, after paint | DOM side effects, subscriptions, cleanup |
| `useFrame` | During R3F render loop (next rAF) | Per-frame animations, buffer writes |
| `store.subscribe()` | Synchronously during `set()` | Imperative updates that must precede React reconciliation |

### 2. React Lanes Matter for R3F

Synchronous event handlers (keydown, click) can cause React to flush renders immediately via SyncLane. If your Three.js scene has mixed update strategies (some React JSX, some `useFrame`), SyncLane will expose the desync. The subscribe pattern avoids this by running before React's scheduler.

### 3. Pattern: Zustand Subscribe for Imperative Three.js Updates

```tsx
// BAD: useFrame-only — desync with SyncLane React commits
useFrame(() => {
  const pose = useSceneStore.getState().currentFrame?.vehiclePose
  applyPose(pose)
})

// GOOD: subscribe (pre-React) + useFrame (safety-net)
useEffect(() => {
  return useSceneStore.subscribe((state, prev) => {
    if (state.relevantData !== prev.relevantData) {
      applyToThreeJsObject(state.relevantData)
    }
  })
}, [])
useFrame(() => {
  applyToThreeJsObject(useSceneStore.getState().relevantData)
})
```

This two-layer approach guarantees correctness regardless of React's scheduling behavior.
