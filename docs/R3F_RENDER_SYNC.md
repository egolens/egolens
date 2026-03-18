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

## Verification (v2)

- World mode scrub (ArrowRight/ArrowLeft): smooth movement, no jitter
- Play mode: no regression, behavior unchanged
- Vehicle mode: no regression (matrix is identity regardless)
- INP: 58ms (processing: 0.1ms)
- Build: clean (`npm run build` + `npm test` pass)

---

### v3: React subscription + ref (final fix)

v2 fixed arrow-key jitter but introduced two separate desync issues, both rooted in the same cause: `getState()` racing ahead of React's commit cycle.

#### Issue 1: Box/model jitter with Follow Camera OFF

**Symptom:** Timeline scrubbing in world mode with Follow Camera OFF caused boxes/models to vibrate — rendering briefly in the wrong orientation then snapping back on every frame change.

**Key observation:** The jitter was invisible with Follow Camera ON, because the camera moves with the ego vehicle, making the relative box positions appear correct despite the absolute desync. With Follow Camera OFF the camera is fixed in world space, exposing the absolute position error.

**Root cause:** The subscribe callback and `useFrame` both used `getState()` to read `vehiclePose`. `getState()` always returns the **latest** Zustand store value — but BoundingBoxes receives `currentFrame?.boxes` via a **React subscription**, which only updates after React commits. During rapid scrubbing:

1. `set()` fires → subscriber updates matrix to **frame N's pose** (via `getState()`)
2. React has NOT yet committed → BoundingBoxes still renders **frame N-1's box positions**
3. THREE.js renders: `pose_N × boxes_N-1` = wrong world positions (1-frame jitter)
4. React commits → BoundingBoxes updates to `boxes_N`
5. Next render: `pose_N × boxes_N` = correct

```
Zustand set()        subscribe callback       React commit (pending)     THREE.js render
─────────────        ──────────────────       ─────────────────────      ──────────────
currentFrame=N+1     group.matrix=pose_N+1    (not yet committed)        pose_N+1 × boxes_N ← WRONG!
                     ↑ reads getState()        BoundingBoxes=boxes_N     ↑ one-frame jitter
                       which is already N+1    (still old)
```

**Fix (WorldPoseSync):** Replace `getState()` reads with **React subscriptions** for both `worldMode` and `vehiclePose`, stored in refs for `useFrame` access:

```tsx
function WorldPoseSync({ groupRef }) {
  // React subscriptions — update in the SAME commit cycle as BoundingBoxes
  const worldMode = useSceneStore((s) => s.worldMode)
  const vehiclePose = useSceneStore((s) => s.currentFrame?.vehiclePose ?? null)
  const poseRef = useRef(vehiclePose)
  const worldModeRef = useRef(worldMode)
  poseRef.current = vehiclePose
  worldModeRef.current = worldMode

  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    if (worldModeRef.current && poseRef.current) {
      _poseMatrix.fromArray(poseRef.current).transpose()
      group.matrix.copy(_poseMatrix)
    } else {
      group.matrix.identity()
    }
    group.matrixWorldNeedsUpdate = true
  })

  return null
}
```

#### Issue 2: Environment jitter with Follow Camera ON

**Symptom:** After fixing Issue 1, Follow Camera ON revealed a previously masked jitter — the surrounding environment (point cloud, boxes, road) appeared to shift first, then the camera caught up one frame later, producing a "double render" shake on every frame change.

**Root cause:** `WorldFollowCamera` still used a Zustand subscriber to move the camera. The subscriber fired synchronously during `set()`, moving the camera to the new position immediately. But with the v3 fix, scene content (matrix, boxes) now only updates after React commits + useFrame. This created the inverse desync:

1. `set()` fires → `WorldFollowCamera` subscriber moves camera to frame N's position
2. React hasn't committed → scene still shows frame N-1 content
3. THREE.js renders: **new camera position** looking at **old scene** = environment appears to lurch
4. React commits + useFrame → scene updates to frame N
5. Next render: camera and scene both at frame N = correct

```
Zustand set()        WFC subscriber           React commit (pending)     THREE.js render
─────────────        ──────────────────       ─────────────────────      ──────────────
currentFrame=N+1     camera → pos_N+1         (not yet committed)        camera_N+1 looking at scene_N ← LURCH!
                     ↑ fires immediately       scene still at N           ↑ environment jitters
```

**Why this was invisible before v3:** In v2, both the scene matrix (subscriber) and camera (subscriber) updated simultaneously during `set()`. They were both "too early" relative to React, but at least they were in sync with *each other*. v3 fixed the scene timing but left the camera on the old subscriber path, splitting them apart.

**Fix (WorldFollowCamera):** Same pattern — replace Zustand subscribers with React subscriptions + refs, move camera update logic into `useFrame`:

```tsx
function WorldFollowCamera({ orbitRef, enabled, returningRef }) {
  // React subscriptions — commit-synced with WorldPoseSync and BoundingBoxes
  const frameIndex = useSceneStore((s) => s.currentFrameIndex)
  const vehiclePose = useSceneStore((s) => s.currentFrame?.vehiclePose ?? null)
  const worldMode = useSceneStore((s) => s.worldMode)
  const activeCam = useSceneStore((s) => s.activeCam)

  // Refs bridge React commit → useFrame
  const frameIndexRef = useRef(frameIndex)
  const vehiclePoseRef = useRef(vehiclePose)
  // ... (other refs)

  const prevFrameIndexRef = useRef(frameIndex)

  useFrame(() => {
    const fi = frameIndexRef.current
    if (fi === prevFrameIndexRef.current) return  // no frame change
    prevFrameIndexRef.current = fi

    // ... camera delta logic (same as before, but reading from refs)
  })

  return null
}
```

### Why This Works

All three consumers now read from the same React commit cycle:

```
Zustand set()     React commit (atomic)                             useFrame (single tick)
─────────────     ──────────────────────                            ──────────────────────
currentFrame=N+1  WorldPoseSync: poseRef=pose_N+1                   1. matrix=pose_N+1
                  BoundingBoxes: boxes=boxes_N+1                    2. camera += delta_N+1
                  WorldFollowCamera: vehiclePoseRef=pose_N+1        3. THREE.js render
                  ↑ all committed atomically                        ↑ all read from same refs
                                                                    → scene + camera ALWAYS IN SYNC
```

The ref acts as a bridge between React's commit timing and R3F's imperative render loop. No subscriber, no `getState()` race — all scene-affecting updates are gated on the same React commit.

### v2 vs v3 Comparison

| Aspect | v2 (subscribe + useFrame) | v3 (React subscription + ref) |
|--------|---------------------------|-------------------------------|
| Pose read mechanism | `getState()` (always latest) | React subscription (commit-synced) |
| Sync guarantee | Matrix precedes React commit | Matrix matches React commit |
| Camera follow mechanism | Zustand subscriber (immediate) | useFrame (commit-synced) |
| Failure mode | scene vs boxes desync; camera vs scene desync | None — atomic commit |
| Complexity | 3 layers (subscribe × 2 + useFrame) | 1 layer (useFrame only, fed by refs) |
| Follow Camera OFF scrub | Jitters | Smooth |
| Follow Camera ON scrub | Masked jitter (camera + scene split) | Smooth |

## Verification (v3)

- World mode scrub with Follow OFF: smooth, no jitter
- World mode scrub with Follow ON: smooth, no double-render shake
- Play mode: no regression
- Vehicle mode: no regression (matrix is identity)
- Build: clean (`npx tsc --noEmit` + `npm test` 526 pass)

## General Lessons

### 1. useEffect vs useFrame vs subscribe vs React subscription

| Mechanism | When it fires | Use for |
|-----------|--------------|---------|
| `useEffect` | After React commit, after paint | DOM side effects, subscriptions, cleanup |
| `useFrame` | During R3F render loop (rAF) | Per-frame animations, buffer writes |
| `store.subscribe()` | Synchronously during `set()` | Imperative updates that must precede React — **but risks racing ahead of sibling React subscriptions** |
| React subscription + ref | During React commit | Syncing imperative code (useFrame) with React-rendered siblings |

### 2. getState() vs React Subscription: The Core Tradeoff

`getState()` gives you the **latest** store value — always fresh, never stale. But if **other parts of the scene** consume the same data through React subscriptions, `getState()` can race ahead of them. The result: parent transform and child positions reference different frames.

**Rule of thumb:** When a parent transform and child positions must be in sync, read both through the same mechanism. If children use React subscriptions, the parent transform should too.

### 3. React Lanes Still Matter — But Differently

v2's insight about SyncLane vs DefaultLane remains valid — but v3 sidesteps the issue entirely. By reading pose through React subscriptions, the matrix update is always gated on React's commit, regardless of which lane triggered the update. The ref-in-useFrame pattern works correctly under both SyncLane (arrow keys) and DefaultLane (playback).

### 4. Pattern: React Subscription + Ref for Synced Imperative Updates

```tsx
// BAD: getState() in useFrame — races ahead of React siblings
useFrame(() => {
  const pose = useSceneStore.getState().currentFrame?.vehiclePose
  applyPose(pose) // may not match what BoundingBoxes has rendered
})

// BAD: subscribe — also races ahead of React siblings
useEffect(() => {
  return useSceneStore.subscribe((state) => {
    applyToThreeJsObject(state.data) // fires before React commit
  })
}, [])

// GOOD: React subscription + ref — synced with sibling components
const data = useSceneStore((s) => s.data)        // commits with siblings
const dataRef = useRef(data)
dataRef.current = data                            // bridge to imperative world
useFrame(() => {
  applyToThreeJsObject(dataRef.current)           // always matches siblings
})
```

This pattern guarantees that imperative Three.js updates in `useFrame` always reference the same data version that React has committed to sibling components.
