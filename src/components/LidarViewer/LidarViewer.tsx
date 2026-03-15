/**
 * LidarViewer — R3F Canvas wrapper for 3D point cloud visualization.
 *
 * Renders the Waymo LiDAR point cloud with OrbitControls.
 * Camera starts from a bird's-eye-ish angle looking down at the vehicle.
 * Waymo vehicle frame: X = forward, Y = left, Z = up.
 *
 * Includes camera frustum visualization — click a frustum to switch
 * to that camera's POV. Press ESC or click the button to return.
 */

import { useEffect, useRef, useMemo, useState } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei'
import * as THREE from 'three'
import PointCloud from './PointCloud'
import { LIDARSEG_PALETTE, LIDARSEG_LABELS } from '../../utils/colormaps'
import BoundingBoxes, { TrajectoryTrails } from './BoundingBoxes'
import KeypointSkeleton from './KeypointSkeleton'
import CameraFrustums from './CameraFrustums'
import { BevMinimapRenderer, BEV_ZOOM_LEVELS } from './BevMinimap'
import BevOverlay from './BevOverlay'
import { useSceneStore, BG_PRESETS } from '../../stores/useSceneStore'
import type { ColormapMode } from '../../stores/useSceneStore'
import { parseCameraCalibrations, type CameraCalib } from '../../utils/cameraCalibration'
import { colors, fonts, radius } from '../../theme'
import { getManifest } from '../../adapters/registry'

// ---------------------------------------------------------------------------
// Chase-cam defaults + reusable temp objects
// ---------------------------------------------------------------------------
const CHASE_CAM_POSITION = new THREE.Vector3(-15, 0, 12)
const CHASE_CAM_TARGET = new THREE.Vector3(5, 0, 0)
// Temp objects for follow/reset (avoid allocation in hot path)
const _followCurrPos = new THREE.Vector3()
const _followDelta = new THREE.Vector3()
const _resetPos = new THREE.Vector3()
const _resetTarget = new THREE.Vector3()
const _resetPoseMat = new THREE.Matrix4()

/** Sensor info — read dynamically inside components via getManifest().lidarSensors */

// ---------------------------------------------------------------------------
// POV Camera Controller — animates the camera to a Waymo camera's viewpoint
// ---------------------------------------------------------------------------

/** Lerp speed — higher = faster snap (0..1 per frame) */
const LERP_SPEED = 0.08

/**
 * Flip from optical camera convention (+Z forward, -Y up) to
 * Three.js camera convention (-Z forward, +Y up): 180° around X.
 */
const OPTICAL_TO_THREEJS_CAM = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI,
)

/** Distance threshold to consider the return animation "done" */
const SNAP_THRESHOLD = 0.05

/** Reusable temp objects for PovController world-mode transform (avoids allocation in useFrame) */
const _povPoseMat = new THREE.Matrix4()
const _povWorldPos = new THREE.Vector3()
const _povPoseQuat = new THREE.Quaternion()
const _povWorldQuat = new THREE.Quaternion()
const _povVehicleQuat = new THREE.Quaternion()

/** Temp vector for return animation direction */
const _returnDir = new THREE.Vector3()

function PovController({
  targetCalib,
  orbitRef,
  returningRef,
}: {
  targetCalib: CameraCalib | null
  orbitRef: React.RefObject<any>
  /** Shared ref so parent can disable OrbitControls during return animation */
  returningRef: React.MutableRefObject<boolean>
}) {
  const { camera } = useThree()
  const savedState = useRef<{ pos: THREE.Vector3; fov: number; target: THREE.Vector3 } | null>(null)
  /** When non-null we're animating back to the saved orbital view */
  const returnTarget = useRef<{ pos: THREE.Vector3; fov: number; target: THREE.Vector3 } | null>(null)
  /** Intermediate lookAt point — lerped each frame for smooth orientation */
  const returnLookAt = useRef<THREE.Vector3 | null>(null)
  /** True while entry/camera-switch animation is running (not on frame changes) */
  const enteringPov = useRef(false)
  /** Track which camera ID is active to detect camera switches vs frame changes */
  const prevCameraId = useRef<number | null>(null)

  // Save orbital camera state when entering POV
  useEffect(() => {
    if (targetCalib) {
      // If we were returning to orbital view, save that destination as orbital state
      // instead — so the user can seamlessly switch between cameras
      if (returnTarget.current) {
        savedState.current = returnTarget.current
        returnTarget.current = null
        returnLookAt.current = null
        returningRef.current = false
      }
      // First POV entry — save current orbital camera state
      if (!savedState.current) {
        savedState.current = {
          pos: camera.position.clone(),
          fov: (camera as THREE.PerspectiveCamera).fov,
          target: orbitRef.current?.target?.clone() ?? new THREE.Vector3(),
        }
      }
      // Animate only on initial entry or camera switch (not frame changes)
      const cameraChanged = prevCameraId.current !== targetCalib.cameraName
      if (cameraChanged) {
        enteringPov.current = true
      }
      prevCameraId.current = targetCalib.cameraName
    } else {
      prevCameraId.current = null
    }
  }, [targetCalib, camera, orbitRef, returningRef])

  // Start return animation when leaving POV
  useEffect(() => {
    if (!targetCalib && savedState.current) {
      const { worldMode, currentFrame } = useSceneStore.getState()
      const pose = currentFrame?.vehiclePose ?? null

      // In world mode, return to chase-cam relative to current vehicle pose
      // (not the stale saved position from before POV entry)
      if (worldMode && pose) {
        _povPoseMat.fromArray(pose).transpose()
        returnTarget.current = {
          pos: CHASE_CAM_POSITION.clone().applyMatrix4(_povPoseMat),
          fov: savedState.current.fov,
          target: CHASE_CAM_TARGET.clone().applyMatrix4(_povPoseMat),
        }
      } else {
        returnTarget.current = savedState.current
      }

      // Initialize intermediate lookAt from camera's current forward direction.
      // This ensures the orientation lerp starts from where the camera is actually
      // looking, avoiding jarring quaternion slerp artifacts.
      camera.getWorldDirection(_returnDir)
      const dist = returnTarget.current.pos.distanceTo(returnTarget.current.target)
      returnLookAt.current = camera.position.clone().add(_returnDir.multiplyScalar(Math.max(dist, 5)))

      returningRef.current = true
      savedState.current = null
    }
  }, [targetCalib, camera, returningRef])

  // Animate: either toward POV target or back to orbital view
  useFrame(() => {
    const pc = camera as THREE.PerspectiveCamera

    // Keep OrbitControls disabled during POV & return animation
    if (orbitRef.current && (targetCalib || returnTarget.current)) {
      orbitRef.current.enabled = false
    }

    if (targetCalib) {
      // ---- Entering / holding POV ----
      // Calibration position/quaternion are in vehicle frame.
      // In world mode, transform them to world frame so the camera
      // matches the scene group's world-transformed frustum position.
      _povVehicleQuat.copy(targetCalib.quaternion).multiply(OPTICAL_TO_THREEJS_CAM)

      const { worldMode, currentFrame } = useSceneStore.getState()
      const pose = currentFrame?.vehiclePose ?? null

      // Compute target position & quaternion
      let targetPos: THREE.Vector3
      let targetQuat: THREE.Quaternion
      if (worldMode && pose) {
        _povPoseMat.fromArray(pose).transpose()
        _povWorldPos.copy(targetCalib.position).applyMatrix4(_povPoseMat)
        _povPoseQuat.setFromRotationMatrix(_povPoseMat)
        _povWorldQuat.copy(_povVehicleQuat).premultiply(_povPoseQuat)
        targetPos = _povWorldPos
        targetQuat = _povWorldQuat
      } else {
        targetPos = targetCalib.position
        targetQuat = _povVehicleQuat
      }

      const targetFov = THREE.MathUtils.radToDeg(targetCalib.vFov)

      if (enteringPov.current) {
        // Smooth entry animation
        camera.position.lerp(targetPos, LERP_SPEED)
        camera.quaternion.slerp(targetQuat, LERP_SPEED)
        pc.fov = THREE.MathUtils.lerp(pc.fov, targetFov, LERP_SPEED)
        // Snap once close enough
        if (camera.position.distanceTo(targetPos) < SNAP_THRESHOLD) {
          enteringPov.current = false
        }
      } else {
        // Locked to camera — instant follow
        camera.position.copy(targetPos)
        camera.quaternion.copy(targetQuat)
        pc.fov = targetFov
      }
      pc.updateProjectionMatrix()
      return
    }

    if (returnTarget.current && returnLookAt.current) {
      // ---- Animating back to orbital view ----
      const rt = returnTarget.current

      // In world mode, continuously recompute return target relative to
      // the current vehicle pose — the vehicle keeps moving during playback.
      const { worldMode: wm, currentFrame: cf } = useSceneStore.getState()
      const returnPose = cf?.vehiclePose ?? null
      if (wm && returnPose) {
        _povPoseMat.fromArray(returnPose).transpose()
        rt.pos.copy(CHASE_CAM_POSITION).applyMatrix4(_povPoseMat)
        rt.target.copy(CHASE_CAM_TARGET).applyMatrix4(_povPoseMat)
      }

      camera.position.lerp(rt.pos, LERP_SPEED)
      pc.fov = THREE.MathUtils.lerp(pc.fov, rt.fov, LERP_SPEED)
      pc.updateProjectionMatrix()

      // Lerp the intermediate lookAt toward the final orbit target, then
      // orient the camera via lookAt — smooth and gimbal-lock-free.
      returnLookAt.current.lerp(rt.target, LERP_SPEED)
      camera.lookAt(returnLookAt.current)

      // Check if close enough to snap and finish
      const dist = camera.position.distanceTo(rt.pos)
      if (dist < SNAP_THRESHOLD) {
        camera.position.copy(rt.pos)
        camera.lookAt(rt.target)
        pc.fov = rt.fov
        pc.updateProjectionMatrix()
        if (orbitRef.current) {
          orbitRef.current.target.copy(rt.target)
          orbitRef.current.update()
          orbitRef.current.enabled = true
        }
        returnTarget.current = null
        returnLookAt.current = null
        returningRef.current = false
      }
    }
  })

  return null
}

// ---------------------------------------------------------------------------
// World-mode helpers
// ---------------------------------------------------------------------------

/** Reusable temp matrix — avoids allocation in useFrame hot path */
const _poseMatrix = new THREE.Matrix4()

/**
 * WorldPoseSync — keeps the scene group matrix in sync with the vehicle pose.
 *
 * Two-layer approach:
 *   1. useSceneStore.subscribe() — fires synchronously during Zustand set(),
 *      BEFORE React re-renders. This ensures the group matrix is already correct
 *      when R3F's reconciler updates BoundingBoxes' Three.js objects.
 *      Without this, arrow-key scrubbing causes visible jitter: React flushes
 *      BoundingBoxes (new positions) synchronously, but useFrame hasn't run yet,
 *      so the group matrix still holds the old pose for one render.
 *   2. useFrame() — safety-net that re-applies the matrix every render tick,
 *      covering edge cases (initial mount, external matrix modifications).
 *
 * See docs/R3F_RENDER_SYNC.md for the full analysis.
 */
function WorldPoseSync({ groupRef }: { groupRef: React.RefObject<THREE.Group | null> }) {
  // Synchronous matrix update via store subscription.
  // Fires BEFORE React reconciles BoundingBoxes, eliminating the
  // one-frame desync between box positions and group transform.
  useEffect(() => {
    const applyPose = (wm: boolean, pose: number[] | null) => {
      const group = groupRef.current
      if (!group) return
      if (wm && pose) {
        _poseMatrix.fromArray(pose).transpose() // Waymo row-major → Three.js column-major
        group.matrix.copy(_poseMatrix)
      } else {
        group.matrix.identity()
      }
      group.matrixWorldNeedsUpdate = true
    }

    // Apply current state immediately (handles initial mount)
    const s = useSceneStore.getState()
    applyPose(s.worldMode, s.currentFrame?.vehiclePose ?? null)

    // Subscribe — fires synchronously during set(), before React re-render
    return useSceneStore.subscribe((state, prev) => {
      if (state.currentFrame !== prev.currentFrame || state.worldMode !== prev.worldMode) {
        applyPose(state.worldMode, state.currentFrame?.vehiclePose ?? null)
      }
    })
  }, [groupRef])

  // Safety-net: re-apply in useFrame for continuous correctness
  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    const { worldMode, currentFrame } = useSceneStore.getState()
    const pose = currentFrame?.vehiclePose ?? null
    if (worldMode && pose) {
      _poseMatrix.fromArray(pose).transpose()
      group.matrix.copy(_poseMatrix)
    } else {
      group.matrix.identity()
    }
    group.matrixWorldNeedsUpdate = true
  })

  return null
}

// ---------------------------------------------------------------------------
// InitialCameraSetup — one-time orbit target setup for chase-cam
// ---------------------------------------------------------------------------
function InitialCameraSetup({ orbitRef }: { orbitRef: React.RefObject<any> }) {
  const initialized = useRef(false)
  useFrame(() => {
    if (!initialized.current && orbitRef.current) {
      orbitRef.current.target.copy(CHASE_CAM_TARGET)
      orbitRef.current.update()
      initialized.current = true
    }
  })
  return null
}

// ---------------------------------------------------------------------------
// WorldFollowCamera — delta-based camera follow in world mode
// ---------------------------------------------------------------------------
function WorldFollowCamera({ orbitRef, enabled, returningRef }: {
  orbitRef: React.RefObject<any>
  enabled: boolean
  returningRef: React.MutableRefObject<boolean>
}) {
  const prevPos = useRef<THREE.Vector3 | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    return useSceneStore.subscribe((state, prev) => {
      // Only act on frame changes
      if (state.currentFrameIndex === prev.currentFrameIndex) return
      // Skip during POV mode
      if (state.activeCam !== null) return
      // Skip during POV return animation (PovController still owns the camera)
      if (returningRef.current) return
      // Only in world mode
      if (!state.worldMode) return

      const pose = state.currentFrame?.vehiclePose ?? null
      if (!pose) return

      _followCurrPos.set(pose[3], pose[7], pose[11])

      if (enabledRef.current && prevPos.current && orbitRef.current) {
        _followDelta.copy(_followCurrPos).sub(prevPos.current)

        // Large jump (rewind, scrub, segment switch) → snap to chase-cam.
        // Normal driving delta is <2m/frame; threshold 100 = 10m squared.
        if (_followDelta.lengthSq() > 100) {
          _resetPoseMat.fromArray(pose).transpose()
          _resetPos.copy(CHASE_CAM_POSITION).applyMatrix4(_resetPoseMat)
          _resetTarget.copy(CHASE_CAM_TARGET).applyMatrix4(_resetPoseMat)
          orbitRef.current.object.position.copy(_resetPos)
          orbitRef.current.target.copy(_resetTarget)
        } else {
          orbitRef.current.object.position.add(_followDelta)
          orbitRef.current.target.add(_followDelta)
        }
        orbitRef.current.update()
      }

      if (!prevPos.current) prevPos.current = new THREE.Vector3()
      prevPos.current.copy(_followCurrPos)
    })
  }, [orbitRef, returningRef])

  // Reset tracking when leaving world mode or exiting POV
  useEffect(() => {
    return useSceneStore.subscribe((state, prev) => {
      if (state.worldMode !== prev.worldMode && !state.worldMode) {
        prevPos.current = null
      }
      if (state.activeCam !== prev.activeCam && state.activeCam === null) {
        prevPos.current = null
      }
    })
  }, [])

  return null
}

// ---------------------------------------------------------------------------
// ResetViewController — smoothly animates camera back to chase-cam
// ---------------------------------------------------------------------------
function ResetViewController({
  orbitRef,
  resetRequestedRef,
}: {
  orbitRef: React.RefObject<any>
  resetRequestedRef: React.MutableRefObject<boolean>
}) {
  const animating = useRef(false)

  useFrame(() => {
    if (resetRequestedRef.current && !animating.current) {
      animating.current = true
      resetRequestedRef.current = false

      // Compute target position/target based on mode
      const { worldMode, currentFrame } = useSceneStore.getState()
      const pose = currentFrame?.vehiclePose ?? null

      if (worldMode && pose) {
        _resetPoseMat.fromArray(pose).transpose()
        _resetPos.copy(CHASE_CAM_POSITION).applyMatrix4(_resetPoseMat)
        _resetTarget.copy(CHASE_CAM_TARGET).applyMatrix4(_resetPoseMat)
      } else {
        _resetPos.copy(CHASE_CAM_POSITION)
        _resetTarget.copy(CHASE_CAM_TARGET)
      }
    }

    if (!animating.current || !orbitRef.current) return

    const cam = orbitRef.current.object
    cam.position.lerp(_resetPos, LERP_SPEED)
    orbitRef.current.target.lerp(_resetTarget, LERP_SPEED)
    orbitRef.current.update()

    const dist = cam.position.distanceTo(_resetPos)
    if (dist < SNAP_THRESHOLD) {
      cam.position.copy(_resetPos)
      orbitRef.current.target.copy(_resetTarget)
      orbitRef.current.update()
      animating.current = false
    }
  })

  return null
}

// ---------------------------------------------------------------------------
// BgColorSync — updates Canvas clear color when bgPreset changes
// ---------------------------------------------------------------------------

function BgColorSync() {
  const { gl } = useThree()
  const bgPreset = useSceneStore((s) => s.bgPreset)
  useEffect(() => {
    const hex = BG_PRESETS.find(p => p.id === bgPreset)?.color ?? '#0C0F1A'
    gl.setClearColor(hex)
  }, [gl, bgPreset])
  return null
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LidarViewer() {
  const visibleSensors = useSceneStore((s) => s.visibleSensors)
  const toggleSensor = useSceneStore((s) => s.actions.toggleSensor)
  const sensorClouds = useSceneStore((s) => s.currentFrame?.sensorClouds)
  const boxRows = useSceneStore((s) => s.currentFrame?.boxes)
  const boxMode = useSceneStore((s) => s.boxMode)
  const setBoxMode = useSceneStore((s) => s.actions.setBoxMode)
  const trailLength = useSceneStore((s) => s.trailLength)
  const setTrailLength = useSceneStore((s) => s.actions.setTrailLength)
  const pointOpacity = useSceneStore((s) => s.pointOpacity)
  const setPointOpacity = useSceneStore((s) => s.actions.setPointOpacity)
  const colormapMode = useSceneStore((s) => s.colormapMode)
  const setColormapMode = useSceneStore((s) => s.actions.setColormapMode)
  const hasBoxData = useSceneStore((s) => s.hasBoxData)
  const hasSegmentation = useSceneStore((s) => s.hasSegmentation)
  const hasKeypoints = useSceneStore((s) => s.hasKeypoints)
  const showKeypoints3D = useSceneStore((s) => s.showKeypoints3D)
  const showKeypoints2D = useSceneStore((s) => s.showKeypoints2D)
  const toggleKeypoints3D = useSceneStore((s) => s.actions.toggleKeypoints3D)
  const toggleKeypoints2D = useSceneStore((s) => s.actions.toggleKeypoints2D)
  const hasCameraSegmentation = useSceneStore((s) => s.hasCameraSegmentation)
  const showCameraSeg = useSceneStore((s) => s.showCameraSeg)
  const toggleCameraSeg = useSceneStore((s) => s.actions.toggleCameraSeg)
  const showLidarOverlay = useSceneStore((s) => s.showLidarOverlay)
  const toggleLidarOverlay = useSceneStore((s) => s.actions.toggleLidarOverlay)
  const cameraCalibrations = useSceneStore((s) => s.cameraCalibrations)
  const activeCam = useSceneStore((s) => s.activeCam)
  const setActiveCam = useSceneStore((s) => s.actions.setActiveCam)
  const worldMode = useSceneStore((s) => s.worldMode)
  const toggleWorldMode = useSceneStore((s) => s.actions.toggleWorldMode)
  // Display settings
  const bgPreset = useSceneStore((s) => s.bgPreset)
  const setBgPreset = useSceneStore((s) => s.actions.setBgPreset)
  const pointShape = useSceneStore((s) => s.pointShape)
  const setPointShape = useSceneStore((s) => s.actions.setPointShape)
  const pointSize = useSceneStore((s) => s.pointSize)
  const setPointSize = useSceneStore((s) => s.actions.setPointSize)
  const orbitRef = useRef<any>(null)
  const sceneGroupRef = useRef<THREE.Group>(null)
  const returningRef = useRef(false)
  const resetRequestedRef = useRef(false)
  const bevCanvasRef = useRef<HTMLCanvasElement>(null)
  const [bevZoom, setBevZoom] = useState(1)
  const [followCam, setFollowCam] = useState(true)
  const [panelOpen, setPanelOpen] = useState(true)

  // Parse calibrations once
  const calibMap = useMemo(
    () => parseCameraCalibrations(cameraCalibrations),
    [cameraCalibrations],
  )
  const activeCalib = activeCam !== null ? calibMap.get(activeCam) ?? null : null

  // ESC to exit POV
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeCam !== null) setActiveCam(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeCam, setActiveCam])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        camera={{
          position: [-15, 0, 12],
          fov: 60,
          near: 0.1,
          far: 500,
          up: [0, 0, 1],
        }}
        gl={{ antialias: false }}
        raycaster={{ params: { Line: { threshold: 0.15 } } as never }}
        style={{ width: '100%', height: '100%' }}
        onCreated={({ gl }) => {
          gl.setClearColor(BG_PRESETS.find(p => p.id === bgPreset)?.color ?? colors.bgDeep)
        }}
      >
        <BgColorSync />
        <ambientLight intensity={0.3} />
        <directionalLight position={[50, -30, 80]} intensity={1.0} />
        <directionalLight position={[-30, 40, 20]} intensity={0.4} />

        {/* Sync scene group matrix with vehicle pose in the render loop */}
        <WorldPoseSync groupRef={sceneGroupRef} />

        {/* Scene group: transformed by vehiclePose in world mode */}
        <group ref={sceneGroupRef} matrixAutoUpdate={false}>
          <PointCloud />
          <BoundingBoxes />
          <KeypointSkeleton />
          <CameraFrustums activeCam={activeCam} />
          {/* Vehicle origin marker (moves with vehicle in world mode) */}
          <mesh position={[0, 0, 0]}>
            <sphereGeometry args={[0.3, 16, 16]} />
            <meshBasicMaterial color={colors.vehicleMarker} />
          </mesh>
        </group>

        {/* Trajectory trails — outside scene group (handles own world transforms) */}
        <TrajectoryTrails />

        {/* POV animation controller */}
        <PovController targetCalib={activeCalib} orbitRef={orbitRef} returningRef={returningRef} />

        {/* Chase-cam initial setup + world follow + reset */}
        <InitialCameraSetup orbitRef={orbitRef} />
        <WorldFollowCamera orbitRef={orbitRef} enabled={followCam} returningRef={returningRef} />
        <ResetViewController orbitRef={orbitRef} resetRequestedRef={resetRequestedRef} />

        {/* Ground grid (XY plane, Z=0) — stays at world origin */}
        <gridHelper
          args={[200, 40, colors.gridMajor, colors.gridMinor]}
          rotation={[Math.PI / 2, 0, 0]}
        />

        <OrbitControls
          ref={orbitRef}
          makeDefault
          enableDamping
          dampingFactor={0.1}
          minDistance={5}
          maxDistance={200}
          enablePan={!(worldMode && followCam)}
          /* enabled is controlled imperatively by PovController via orbitRef */
        />

        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport
            axisColors={[colors.gizmoX, colors.gizmoY, colors.gizmoZ]}
            labelColor="white"
          />
        </GizmoHelper>

        {/* BEV minimap: reads scene ref, renders into external canvas */}
        <BevMinimapRenderer canvasRef={bevCanvasRef} zoomIndex={bevZoom} />
      </Canvas>

      {/* BEV minimap overlay (circular canvas + radar decorations) */}
      <BevOverlay
        canvasRef={bevCanvasRef}
        zoomIndex={bevZoom}
        onToggleZoom={() => setBevZoom((z) => (z + 1) % BEV_ZOOM_LEVELS.length)}
      />

      {/* Camera controls — hidden during POV */}
      {activeCam === null && (
        <div style={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: 4,
          backgroundColor: 'rgba(26, 31, 53, 0.75)',
          borderRadius: radius.md,
          backdropFilter: 'blur(12px)',
          border: `1px solid ${colors.border}`,
          pointerEvents: 'auto',
        }}>
          {/* Follow toggle — world mode only */}
          {worldMode && (
            <button
              onClick={() => {
                const next = !followCam
                setFollowCam(next)
                if (next) resetRequestedRef.current = true
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                border: 'none',
                borderRadius: radius.sm,
                cursor: 'pointer',
                backgroundColor: followCam ? 'rgba(0, 200, 219, 0.12)' : 'transparent',
                transition: 'background-color 0.15s',
              }}
            >
              {followCam ? (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <rect x="3" y="7" width="10" height="7" rx="1.5" fill={colors.accentBlue} />
                  <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke={colors.accentBlue} strokeWidth="1.5" fill="none" strokeLinecap="round" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <rect x="3" y="7" width="10" height="7" rx="1.5" fill={colors.textDim} />
                  <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0" stroke={colors.textDim} strokeWidth="1.5" fill="none" strokeLinecap="round" />
                </svg>
              )}
              <span style={{
                fontSize: '10px',
                fontFamily: fonts.sans,
                fontWeight: 500,
                color: followCam ? colors.accentBlue : colors.textDim,
                transition: 'color 0.15s',
              }}>
                Follow
              </span>
            </button>
          )}

          {/* Reset View */}
          <button
            onClick={() => { resetRequestedRef.current = true }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              border: 'none',
              borderRadius: radius.sm,
              cursor: 'pointer',
              backgroundColor: 'transparent',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 8a6 6 0 0 1 10.24-4.24L14 2v5h-5l1.76-1.76A4 4 0 1 0 12 8h2a6 6 0 0 1-12 0z"
                fill={colors.textSecondary}
              />
            </svg>
            <span style={{
              fontSize: '10px',
              fontFamily: fonts.sans,
              fontWeight: 500,
              color: colors.textSecondary,
            }}>
              Reset
            </span>
          </button>
        </div>
      )}

      {/* Layer control overlay */}
      <div style={{
        position: 'absolute',
        top: 12,
        left: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        pointerEvents: 'auto',
        width: panelOpen ? 172 : 'auto',
        padding: 6,
        backgroundColor: 'rgba(26, 31, 53, 0.75)',
        borderRadius: radius.md,
        backdropFilter: 'blur(12px)',
        border: `1px solid ${colors.border}`,
      }}>

        {/* ── Collapsed: compact status bar ── */}
        {!panelOpen && (
          <button
            onClick={() => setPanelOpen(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 4px',
              border: 'none',
              borderRadius: radius.sm,
              cursor: 'pointer',
              backgroundColor: 'transparent',
            }}
          >
            {[
              worldMode ? 'World' : 'Vehicle',
              (() => {
                const active = getManifest().lidarSensors.filter(s => visibleSensors.has(s.id))
                if (active.length === 0) return 'None'
                if (active.length === 1) return active[0].label
                return `${active[0].label}+${active.length - 1}`
              })(),
              ...((getManifest().colormapModes?.length ?? 3) > 1
                ? [{ distance: 'Dist', intensity: 'Int', range: 'Range', elongation: 'Elong', segment: 'Seg', panoptic: 'Pan', camera: 'Cam' }[colormapMode]]
                : []),
              ...(hasBoxData ? [{ off: 'Off', box: 'Boxes', model: 'Models' }[boxMode]] : []),
              ...(showLidarOverlay ? ['LiDAR→Cam'] : []),
              ...(showKeypoints3D ? ['KP 3D'] : []),
              ...(showKeypoints2D ? ['KP 2D'] : []),
              ...(showCameraSeg ? ['CamSeg'] : []),
            ].map((text, i, arr) => (
              <span key={i} style={{
                fontSize: '10px',
                fontFamily: fonts.sans,
                fontWeight: 500,
                color: colors.textSecondary,
              }}>
                {text}{i < arr.length - 1 && <span style={{ color: colors.textDim, margin: '0 1px' }}> · </span>}
              </span>
            ))}
            <span style={{ fontSize: '8px', color: colors.textDim, lineHeight: 1, marginLeft: 2 }}>▼</span>
          </button>
        )}

        {/* ── Expanded panel ── */}
        {panelOpen && <>
          {/* ── COORDINATE section ── */}
          <button
            onClick={() => setPanelOpen(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '2px 4px',
              border: 'none',
              borderRadius: radius.sm,
              cursor: 'pointer',
              backgroundColor: 'transparent',
            }}
          >
            <span style={{
              fontSize: '9px', fontFamily: fonts.sans, fontWeight: 600,
              color: colors.textDim, letterSpacing: '1.2px', textTransform: 'uppercase',
            }}>
              Coordinate
            </span>
            <span style={{ fontSize: '8px', color: colors.textDim, lineHeight: 1 }}>▲</span>
          </button>

          <div style={{
            display: 'flex',
            borderRadius: radius.sm,
            overflow: 'hidden',
            backgroundColor: 'rgba(255,255,255,0.04)',
          }}>
            {([true, false] as const).map((isWorld) => {
              const active = worldMode === isWorld
              return (
                <button
                  key={isWorld ? 'world' : 'vehicle'}
                  onClick={active ? undefined : () => { toggleWorldMode(); resetRequestedRef.current = true }}
                  style={{
                    flex: 1, padding: '4px 0', fontSize: '10px',
                    fontFamily: fonts.sans, fontWeight: active ? 600 : 400,
                    border: 'none', cursor: active ? 'default' : 'pointer',
                    backgroundColor: active ? 'rgba(0, 200, 219, 0.15)' : 'transparent',
                    color: active ? colors.accentBlue : colors.textDim,
                    transition: 'all 0.15s', letterSpacing: '0.3px',
                  }}
                >
                  {isWorld ? 'World' : 'Vehicle'}
                </button>
              )
            })}
          </div>

          {/* ── SENSOR section ── */}
          <div style={{ height: '1px', backgroundColor: colors.border, margin: '4px 4px' }} />
          <div style={{
            fontSize: '9px', fontFamily: fonts.sans, fontWeight: 600,
            color: colors.textDim, letterSpacing: '1.2px', textTransform: 'uppercase',
            padding: '2px 4px 2px',
          }}>
            Sensor
          </div>

          {getManifest().lidarSensors.map(({ id, label, color }) => {
            const active = visibleSensors.has(id)
            const cloud = sensorClouds?.get(id)
            const pts = cloud ? cloud.pointCount.toLocaleString() : '—'
            return (
              <button
                key={id}
                onClick={() => toggleSensor(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '4px 8px', fontSize: '11px', fontFamily: fonts.sans, fontWeight: 500,
                  border: 'none', borderRadius: radius.sm, cursor: 'pointer',
                  backgroundColor: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                  color: active ? colors.textPrimary : colors.textDim,
                  opacity: active ? 1 : 0.6,
                  transition: 'opacity 0.15s, background-color 0.15s',
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  backgroundColor: active ? color : colors.textDim,
                  display: 'inline-block', flexShrink: 0,
                  boxShadow: active ? `0 0 6px ${color}` : 'none',
                }} />
                {label}
                <span style={{
                  color: colors.textSecondary, marginLeft: 'auto', paddingLeft: 8,
                  fontFamily: fonts.mono, fontSize: '10px',
                }}>
                  {pts}
                </span>
              </button>
            )
          })}

          {/* Opacity slider — hidden when all sensors off */}
          {visibleSensors.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' }}>
              <span style={{ fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500, color: colors.textSecondary, whiteSpace: 'nowrap' }}>
                Opacity
              </span>
              <input
                type="range" min={10} max={100}
                value={Math.round(pointOpacity * 100)}
                onChange={(e) => setPointOpacity(Number(e.target.value) / 100)}
                style={{ width: 52, height: 2, accentColor: colors.accent }}
              />
              <span style={{
                fontSize: '10px', fontFamily: fonts.mono, color: colors.textPrimary,
                minWidth: 24, textAlign: 'right',
              }}>
                {Math.round(pointOpacity * 100)}%
              </span>
            </div>
          )}

          {/* Colormap — hide when dataset only supports one mode */}
          {(() => {
            const allModes: [ColormapMode, string][] = [['distance', 'Dist'], ['intensity', 'Int'], ['range', 'Range'], ['elongation', 'Elong'], ['segment', 'Seg'], ['panoptic', 'Pan'], ['camera', 'Cam']]
            const manifest = getManifest()
            const availableModes = (manifest.colormapModes
              ? allModes.filter(([mode]) => manifest.colormapModes!.includes(mode))
              : allModes
            ).filter(([mode]) => {
              // Gate 'segment' mode on actual data availability
              if (mode === 'segment') return hasSegmentation
              if (mode === 'panoptic') return hasSegmentation
              return true
            })
            if (availableModes.length <= 1) return null
            return (
              <>
                <div style={{
                  fontSize: '9px', fontFamily: fonts.sans, fontWeight: 600,
                  color: colors.textDim, letterSpacing: '1.2px', textTransform: 'uppercase',
                  padding: '2px 4px 2px',
                }}>
                  Colormap
                </div>
                <div style={{
                  display: 'flex', borderRadius: radius.sm, overflow: 'hidden',
                  backgroundColor: 'rgba(255,255,255,0.04)',
                }}>
                  {availableModes.map(([mode, label]) => {
                    const active = colormapMode === mode
                    return (
                      <button
                        key={mode}
                        onClick={() => setColormapMode(mode)}
                        style={{
                          flex: 1, padding: '4px 0', fontSize: '10px',
                          fontFamily: fonts.sans, fontWeight: active ? 600 : 400,
                          border: 'none', cursor: 'pointer',
                          backgroundColor: active ? 'rgba(0, 200, 219, 0.15)' : 'transparent',
                          color: active ? colors.accentBlue : colors.textDim,
                          transition: 'all 0.15s', letterSpacing: '0.3px',
                        }}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </>
            )
          })()}

          {/* Semantic segmentation legend — visible only in segment mode */}
          {colormapMode === 'segment' && (() => {
            // Show only classes present in the current frame's segLabels
            const presentClasses = new Set<number>()
            const clouds = sensorClouds
            if (clouds) {
              for (const [, cloud] of clouds) {
                const labels = cloud.segLabels
                if (!labels) continue
                for (let i = 0; i < labels.length; i++) {
                  presentClasses.add(labels[i])
                }
              }
            }
            // Remove noise (0) and ego (31) from legend — they're uninteresting
            presentClasses.delete(0)
            presentClasses.delete(31)
            // Filter to only known classes (seg extraction may inject out-of-range values — Phase B fix)
            const numClasses = (getManifest().semanticLabels ?? LIDARSEG_LABELS).length
            for (const cls of presentClasses) {
              if (cls >= numClasses) presentClasses.delete(cls)
            }
            if (presentClasses.size === 0) return (
              <div style={{ padding: '4px 8px' }}>
                <span style={{ fontSize: '8px', fontFamily: fonts.sans, color: colors.textDim, fontStyle: 'italic' }}>
                  No seg data this frame
                </span>
              </div>
            )
            const sorted = [...presentClasses].sort((a, b) => a - b)
            const manifest = getManifest()
            const palette = manifest.semanticPalette ?? LIDARSEG_PALETTE
            const labels = manifest.semanticLabels ?? LIDARSEG_LABELS
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 6px', padding: '4px 8px' }}>
                {sorted.map((cls) => {
                  const [r, g, b] = palette[cls] ?? [0.5, 0.5, 0.5]
                  const cssColor = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
                  return (
                    <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '1px',
                        backgroundColor: cssColor,
                        display: 'inline-block', flexShrink: 0,
                      }} />
                      <span style={{ fontSize: '8px', fontFamily: fonts.sans, color: colors.textSecondary }}>
                        {labels[cls] ?? cls}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })()}

          {/* Panoptic segmentation legend — visible only in panoptic mode */}
          {colormapMode === 'panoptic' && (() => {
            // Count unique instances per semantic class
            const classCounts = new Map<number, Set<number>>()
            const clouds = sensorClouds
            if (clouds) {
              for (const [, cloud] of clouds) {
                const labels = cloud.panopticLabels
                if (!labels) continue
                for (let i = 0; i < labels.length; i++) {
                  const sem = Math.floor(labels[i] / 1000)
                  const inst = labels[i] % 1000
                  if (sem === 0 || sem === 31) continue  // Skip noise + ego
                  let set = classCounts.get(sem)
                  if (!set) { set = new Set<number>(); classCounts.set(sem, set) }
                  if (inst > 0) set.add(inst)
                }
              }
            }
            // Filter out-of-range classes
            const numClasses = (getManifest().semanticLabels ?? LIDARSEG_LABELS).length
            for (const cls of classCounts.keys()) {
              if (cls >= numClasses) classCounts.delete(cls)
            }
            if (classCounts.size === 0) return (
              <div style={{ padding: '4px 8px' }}>
                <span style={{ fontSize: '8px', fontFamily: fonts.sans, color: colors.textDim, fontStyle: 'italic' }}>
                  No seg data this frame
                </span>
              </div>
            )
            const manifest = getManifest()
            const palette = manifest.semanticPalette ?? LIDARSEG_PALETTE
            const labels = manifest.semanticLabels ?? LIDARSEG_LABELS
            const sorted = [...classCounts.entries()].sort((a, b) => a[0] - b[0])
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 6px', padding: '4px 8px' }}>
                {sorted.map(([cls, instances]) => {
                  const [r, g, b] = palette[cls] ?? [0.5, 0.5, 0.5]
                  const cssColor = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
                  const label = labels[cls] ?? String(cls)
                  const count = instances.size
                  return (
                    <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '1px',
                        backgroundColor: cssColor,
                        display: 'inline-block', flexShrink: 0,
                      }} />
                      <span style={{ fontSize: '8px', fontFamily: fonts.sans, color: colors.textSecondary }}>
                        {label}{count > 0 ? ` (${count})` : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })()}

          {/* ── PERCEPTION section (hidden when no box data) ── */}
          {hasBoxData && <>
            <div style={{ height: '1px', backgroundColor: colors.border, margin: '4px 4px' }} />
            <div style={{
              fontSize: '9px', fontFamily: fonts.sans, fontWeight: 600,
              color: colors.textDim, letterSpacing: '1.2px', textTransform: 'uppercase',
              padding: '2px 4px 2px',
            }}>
              Perception
            </div>

            {/* Segmented control: Off | Boxes | Models */}
            <div style={{
              display: 'flex', borderRadius: radius.sm, overflow: 'hidden',
              backgroundColor: 'rgba(255,255,255,0.04)',
            }}>
              {([['off', 'Off'], ['box', 'Boxes'], ['model', 'Models']] as const).map(([mode, label]) => {
                const active = boxMode === mode
                const isOn = mode !== 'off'
                return (
                  <button
                    key={mode}
                    onClick={() => setBoxMode(mode)}
                    style={{
                      flex: 1, padding: '4px 0', fontSize: '10px',
                      fontFamily: fonts.sans, fontWeight: active ? 600 : 400,
                      border: 'none', cursor: 'pointer',
                      backgroundColor: active
                        ? (isOn ? 'rgba(0, 200, 219, 0.15)' : 'rgba(255,255,255,0.06)')
                        : 'transparent',
                      color: active
                        ? (isOn ? colors.accentBlue : colors.textPrimary)
                        : colors.textDim,
                      transition: 'all 0.15s', letterSpacing: '0.3px',
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            {/* LiDAR → Camera projection toggle */}
            <button
              onClick={toggleLidarOverlay}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                width: '100%', padding: '4px 8px',
                fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500,
                border: 'none', cursor: 'pointer',
                backgroundColor: showLidarOverlay ? 'rgba(0, 200, 219, 0.1)' : 'transparent',
                color: showLidarOverlay ? colors.accentBlue : colors.textDim,
                transition: 'all 0.15s', textAlign: 'left',
              }}
            >
              <span style={{
                width: 8, height: 8, borderRadius: '2px',
                border: `1.5px solid ${showLidarOverlay ? colors.accentBlue : colors.textDim}`,
                backgroundColor: showLidarOverlay ? colors.accentBlue : 'transparent',
                display: 'inline-block', flexShrink: 0,
                transition: 'all 0.15s',
              }} />
              LiDAR → Camera
            </button>

            {/* Keypoints 3D toggle */}
            {hasKeypoints && (
              <button
                onClick={toggleKeypoints3D}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  width: '100%', padding: '4px 8px',
                  fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500,
                  border: 'none', cursor: 'pointer',
                  backgroundColor: showKeypoints3D ? 'rgba(204, 255, 0, 0.1)' : 'transparent',
                  color: showKeypoints3D ? '#CCFF00' : colors.textDim,
                  transition: 'all 0.15s', textAlign: 'left',
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '2px',
                  border: `1.5px solid ${showKeypoints3D ? '#CCFF00' : colors.textDim}`,
                  backgroundColor: showKeypoints3D ? '#CCFF00' : 'transparent',
                  display: 'inline-block', flexShrink: 0,
                  transition: 'all 0.15s',
                }} />
                Keypoints 3D
              </button>
            )}
            {/* Keypoints 2D toggle */}
            {hasKeypoints && (
              <button
                onClick={toggleKeypoints2D}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  width: '100%', padding: '4px 8px',
                  fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500,
                  border: 'none', cursor: 'pointer',
                  backgroundColor: showKeypoints2D ? 'rgba(136, 221, 255, 0.1)' : 'transparent',
                  color: showKeypoints2D ? '#88DDFF' : colors.textDim,
                  transition: 'all 0.15s', textAlign: 'left',
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '2px',
                  border: `1.5px solid ${showKeypoints2D ? '#88DDFF' : colors.textDim}`,
                  backgroundColor: showKeypoints2D ? '#88DDFF' : 'transparent',
                  display: 'inline-block', flexShrink: 0,
                  transition: 'all 0.15s',
                }} />
                Keypoints 2D
              </button>
            )}
            {/* Camera Segmentation toggle */}
            {hasCameraSegmentation && (
              <button
                onClick={toggleCameraSeg}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  width: '100%', padding: '4px 8px',
                  fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500,
                  border: 'none', cursor: 'pointer',
                  backgroundColor: showCameraSeg ? 'rgba(255, 68, 255, 0.1)' : 'transparent',
                  color: showCameraSeg ? '#FF44FF' : colors.textDim,
                  transition: 'all 0.15s', textAlign: 'left',
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '2px',
                  border: `1.5px solid ${showCameraSeg ? '#FF44FF' : colors.textDim}`,
                  backgroundColor: showCameraSeg ? '#FF44FF' : 'transparent',
                  display: 'inline-block', flexShrink: 0,
                  transition: 'all 0.15s',
                }} />
                Cam Seg
              </button>
            )}

            {boxMode !== 'off' && (<>
              {/* Class legend — only types present in current frame */}
              {(() => {
                const presentTypes = new Set<number>()
                if (boxRows) {
                  for (const row of boxRows) {
                    const t = (row['[LiDARBoxComponent].type'] as number) ?? 0
                    presentTypes.add(t)
                  }
                }
                // Remove unknown (0) from legend — not informative
                presentTypes.delete(0)
                if (presentTypes.size === 0) return null
                const manifest = getManifest()
                // Sort by manifest order (preserves logical grouping)
                const sorted = manifest.boxTypes.filter(bt => presentTypes.has(bt.id))
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', padding: '4px 8px' }}>
                    {sorted.map(({ id, label, color }) => (
                      <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{
                          width: 6, height: 6, borderRadius: '1px',
                          backgroundColor: color,
                          display: 'inline-block', flexShrink: 0,
                        }} />
                        <span style={{ fontSize: '9px', fontFamily: fonts.sans, color: colors.textSecondary }}>
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })()}

              {/* Trail slider — only in world mode */}
              {worldMode && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' }}>
                  <span style={{ fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500, color: colors.textSecondary, whiteSpace: 'nowrap' }}>
                    Trail
                  </span>
                  <input
                    type="range" min={0} max={50}
                    value={trailLength}
                    onChange={(e) => setTrailLength(Number(e.target.value))}
                    style={{ width: 52, height: 2, accentColor: colors.accentBlue }}
                  />
                  <span style={{
                    fontSize: '10px', fontFamily: fonts.mono, color: colors.textPrimary,
                    minWidth: 16, textAlign: 'right',
                  }}>
                    {trailLength}
                  </span>
                </div>
              )}

            </>)}
          </>}

          {/* ── DISPLAY section (rendering style) ── */}
          <div style={{ height: '1px', backgroundColor: colors.border, margin: '4px 4px' }} />
          <div style={{
            fontSize: '9px', fontFamily: fonts.sans, fontWeight: 600,
            color: colors.textDim, letterSpacing: '1.2px', textTransform: 'uppercase',
            padding: '2px 4px 2px',
          }}>
            Display
          </div>

          {/* Background color swatches */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px' }}>
            <span style={{ fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500, color: colors.textSecondary, whiteSpace: 'nowrap' }}>
              BG
            </span>
            <div style={{ display: 'flex', gap: '3px' }}>
              {BG_PRESETS.map((p) => (
                <button
                  key={p.id}
                  title={p.label}
                  onClick={() => setBgPreset(p.id)}
                  style={{
                    width: 14, height: 14, borderRadius: '3px', padding: 0,
                    border: bgPreset === p.id
                      ? `2px solid ${colors.accentBlue}`
                      : `1px solid ${p.color === '#ffffff' ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)'}`,
                    backgroundColor: p.color,
                    cursor: 'pointer',
                    transition: 'border-color 0.15s',
                  }}
                />
              ))}
            </div>
          </div>

          {/* Point shape toggle */}
          <div style={{
            display: 'flex', borderRadius: radius.sm, overflow: 'hidden',
            backgroundColor: 'rgba(255,255,255,0.04)',
          }}>
            {([['square', 'Square'], ['circle', 'Circle']] as const).map(([shape, label]) => {
              const active = pointShape === shape
              return (
                <button
                  key={shape}
                  onClick={() => setPointShape(shape)}
                  style={{
                    flex: 1, padding: '4px 0', fontSize: '10px',
                    fontFamily: fonts.sans, fontWeight: active ? 600 : 400,
                    border: 'none', cursor: 'pointer',
                    backgroundColor: active ? 'rgba(0, 200, 219, 0.15)' : 'transparent',
                    color: active ? colors.accentBlue : colors.textDim,
                    transition: 'all 0.15s', letterSpacing: '0.3px',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>

          {/* Point size slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' }}>
            <span style={{ fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500, color: colors.textSecondary, whiteSpace: 'nowrap' }}>
              Size
            </span>
            <input
              type="range" min={2} max={30}
              value={Math.round(pointSize * 100)}
              onChange={(e) => setPointSize(Number(e.target.value) / 100)}
              style={{ width: 52, height: 2, accentColor: colors.accentBlue }}
            />
            <span style={{
              fontSize: '10px', fontFamily: fonts.mono, color: colors.textPrimary,
              minWidth: 24, textAlign: 'right',
            }}>
              {pointSize.toFixed(2)}
            </span>
          </div>

        </>}
      </div>

      {/* POV mode indicator + exit button */}
      {activeCam !== null && (
        <div style={{
          position: 'absolute',
          top: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          pointerEvents: 'auto',
        }}>
          <span style={{
            fontSize: '12px',
            fontFamily: fonts.sans,
            fontWeight: 500,
            color: colors.textPrimary,
            backgroundColor: 'rgba(26, 31, 53, 0.9)',
            padding: '5px 12px',
            borderRadius: radius.sm,
            backdropFilter: 'blur(8px)',
          }}>
            CAM {getManifest().cameraPovLabels[activeCam] ?? activeCam}
          </span>
          <button
            onClick={() => setActiveCam(null)}
            style={{
              padding: '5px 12px',
              fontSize: '11px',
              fontFamily: fonts.sans,
              fontWeight: 600,
              border: 'none',
              borderRadius: radius.sm,
              cursor: 'pointer',
              backgroundColor: 'rgba(255, 107, 138, 0.8)',
              color: '#fff',
              backdropFilter: 'blur(8px)',
              transition: 'background-color 0.15s',
            }}
          >
            ESC
          </button>
        </div>
      )}

    </div>
  )
}
