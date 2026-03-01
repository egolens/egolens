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
import BoundingBoxes, { TrajectoryTrails } from './BoundingBoxes'
import CameraFrustums from './CameraFrustums'
import { useSceneStore } from '../../stores/useSceneStore'
import { parseCameraCalibrations, type CameraCalib } from '../../utils/cameraCalibration'
import { BOX_TYPE_COLORS, BoxType } from '../../types/waymo'
import type { ColormapMode, BoxRenderer } from '../../stores/useSceneStore'
import { colors, fonts, radius } from '../../theme'

const SENSOR_INFO: { id: number; label: string; color: string }[] = [
  { id: 1, label: 'TOP', color: colors.sensorTop },
  { id: 2, label: 'FRONT', color: colors.sensorFront },
  { id: 3, label: 'SIDE_L', color: colors.sensorSideL },
  { id: 4, label: 'SIDE_R', color: colors.sensorSideR },
  { id: 5, label: 'REAR', color: colors.sensorRear },
]

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
  const savedState = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion; fov: number; target: THREE.Vector3 } | null>(null)
  /** When non-null we're animating back to the saved orbital view */
  const returnTarget = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion; fov: number; target: THREE.Vector3 } | null>(null)

  // Save orbital camera state when entering POV
  useEffect(() => {
    if (targetCalib) {
      // If we were returning to orbital view, save that destination as orbital state
      // instead — so the user can seamlessly switch between cameras
      if (returnTarget.current) {
        savedState.current = returnTarget.current
        returnTarget.current = null
        returningRef.current = false
      }
      // First POV entry — save current orbital camera state (including quaternion!)
      if (!savedState.current) {
        savedState.current = {
          pos: camera.position.clone(),
          quat: camera.quaternion.clone(),
          fov: (camera as THREE.PerspectiveCamera).fov,
          target: orbitRef.current?.target?.clone() ?? new THREE.Vector3(),
        }
      }
    }
  }, [targetCalib, camera, orbitRef, returningRef])

  // Start return animation when leaving POV
  useEffect(() => {
    if (!targetCalib && savedState.current) {
      returnTarget.current = savedState.current
      returningRef.current = true
      savedState.current = null
    }
  }, [targetCalib, returningRef])

  // Animate: either toward POV target or back to orbital view
  useFrame(() => {
    const pc = camera as THREE.PerspectiveCamera

    // Keep OrbitControls disabled during POV & return animation
    if (orbitRef.current && (targetCalib || returnTarget.current)) {
      orbitRef.current.enabled = false
    }

    if (targetCalib) {
      // ---- Entering / holding POV ----
      camera.position.lerp(targetCalib.position, LERP_SPEED)

      const povQuat = targetCalib.quaternion.clone().multiply(OPTICAL_TO_THREEJS_CAM)
      camera.quaternion.slerp(povQuat, LERP_SPEED)

      const targetFov = THREE.MathUtils.radToDeg(targetCalib.vFov)
      pc.fov = THREE.MathUtils.lerp(pc.fov, targetFov, LERP_SPEED)
      pc.updateProjectionMatrix()
      return
    }

    if (returnTarget.current) {
      // ---- Animating back to orbital view ----
      const rt = returnTarget.current

      camera.position.lerp(rt.pos, LERP_SPEED)
      pc.fov = THREE.MathUtils.lerp(pc.fov, rt.fov, LERP_SPEED)
      pc.updateProjectionMatrix()

      // Slerp directly to saved quaternion — no lookAt, no gimbal lock
      camera.quaternion.slerp(rt.quat, LERP_SPEED)

      // Check if close enough to snap and finish
      const dist = camera.position.distanceTo(rt.pos)
      if (dist < SNAP_THRESHOLD) {
        camera.position.copy(rt.pos)
        camera.quaternion.copy(rt.quat)
        pc.fov = rt.fov
        pc.updateProjectionMatrix()
        if (orbitRef.current) {
          orbitRef.current.target.copy(rt.target)
          orbitRef.current.update()
          orbitRef.current.enabled = true
        }
        returnTarget.current = null
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
// Main component
// ---------------------------------------------------------------------------

export default function LidarViewer() {
  const visibleSensors = useSceneStore((s) => s.visibleSensors)
  const toggleSensor = useSceneStore((s) => s.actions.toggleSensor)
  const sensorClouds = useSceneStore((s) => s.currentFrame?.sensorClouds)
  const boxMode = useSceneStore((s) => s.boxMode)
  const setBoxMode = useSceneStore((s) => s.actions.setBoxMode)
  const trailLength = useSceneStore((s) => s.trailLength)
  const setTrailLength = useSceneStore((s) => s.actions.setTrailLength)
  const pointOpacity = useSceneStore((s) => s.pointOpacity)
  const setPointOpacity = useSceneStore((s) => s.actions.setPointOpacity)
  const colormapMode = useSceneStore((s) => s.colormapMode)
  const setColormapMode = useSceneStore((s) => s.actions.setColormapMode)
  const hasBoxData = useSceneStore((s) => s.hasBoxData)
  const boxRenderer = useSceneStore((s) => s.boxRenderer)
  const setBoxRenderer = useSceneStore((s) => s.actions.setBoxRenderer)
  const cameraCalibrations = useSceneStore((s) => s.cameraCalibrations)
  const activeCam = useSceneStore((s) => s.activeCam)
  const setActiveCam = useSceneStore((s) => s.actions.setActiveCam)
  const worldMode = useSceneStore((s) => s.worldMode)
  const toggleWorldMode = useSceneStore((s) => s.actions.toggleWorldMode)
  const orbitRef = useRef<any>(null)
  const sceneGroupRef = useRef<THREE.Group>(null)
  const returningRef = useRef(false)
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
          position: [-30, -30, 40],
          fov: 60,
          near: 0.1,
          far: 500,
          up: [0, 0, 1],
        }}
        gl={{ antialias: false }}
        raycaster={{ params: { Line: { threshold: 0.15 } } as never }}
        style={{ width: '100%', height: '100%' }}
        onCreated={({ gl }) => {
          gl.setClearColor(colors.bgDeep)
        }}
      >
        <ambientLight intensity={0.3} />
        <directionalLight position={[50, -30, 80]} intensity={1.0} />
        <directionalLight position={[-30, 40, 20]} intensity={0.4} />

        {/* Sync scene group matrix with vehicle pose in the render loop */}
        <WorldPoseSync groupRef={sceneGroupRef} />

        {/* Scene group: transformed by vehiclePose in world mode */}
        <group ref={sceneGroupRef} matrixAutoUpdate={false}>
          <PointCloud />
          <BoundingBoxes />
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
          /* enabled is controlled imperatively by PovController via orbitRef */
        />

        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport
            axisColors={[colors.gizmoX, colors.gizmoY, colors.gizmoZ]}
            labelColor="white"
          />
        </GizmoHelper>
      </Canvas>

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
        {/* ── Header: toggle row ── */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            padding: '2px 4px',
            border: 'none',
            borderRadius: radius.sm,
            cursor: 'pointer',
            backgroundColor: 'transparent',
          }}
          title={panelOpen ? 'Collapse panel' : 'Expand panel'}
        >
          <span style={{
            fontSize: '9px',
            fontFamily: fonts.sans,
            fontWeight: 600,
            color: colors.textDim,
            letterSpacing: '1.2px',
            textTransform: 'uppercase',
          }}>
            Layers
          </span>
          <span style={{
            fontSize: '8px',
            color: colors.textDim,
            lineHeight: 1,
          }}>
            {panelOpen ? '▲' : '▼'}
          </span>
        </button>

        {panelOpen && <>
        {/* ── COORDINATE group ── */}
        <div style={{
          display: 'flex',
          borderRadius: radius.sm,
          overflow: 'hidden',
          backgroundColor: 'rgba(255,255,255,0.04)',
        }}>
          {([false, true] as const).map((isWorld) => {
            const active = worldMode === isWorld
            return (
              <button
                key={isWorld ? 'world' : 'vehicle'}
                onClick={active ? undefined : toggleWorldMode}
                style={{
                  flex: 1,
                  padding: '4px 0',
                  fontSize: '10px',
                  fontFamily: fonts.sans,
                  fontWeight: active ? 600 : 400,
                  border: 'none',
                  cursor: active ? 'default' : 'pointer',
                  backgroundColor: active ? 'rgba(0, 200, 219, 0.15)' : 'transparent',
                  color: active ? colors.accentBlue : colors.textDim,
                  transition: 'all 0.15s',
                  letterSpacing: '0.3px',
                }}
              >
                {isWorld ? 'World' : 'Vehicle'}
              </button>
            )
          })}
        </div>

        {/* ── Divider ── */}
        <div style={{ height: '1px', backgroundColor: colors.border, margin: '4px 4px' }} />

        {SENSOR_INFO.map(({ id, label, color }) => {
          const active = visibleSensors.has(id)
          const cloud = sensorClouds?.get(id)
          const pts = cloud ? cloud.pointCount.toLocaleString() : '—'
          return (
            <button
              key={id}
              onClick={() => toggleSensor(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 8px',
                fontSize: '11px',
                fontFamily: fonts.sans,
                fontWeight: 500,
                border: 'none',
                borderRadius: radius.sm,
                cursor: 'pointer',
                backgroundColor: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                color: active ? colors.textPrimary : colors.textDim,
                opacity: active ? 1 : 0.6,
                transition: 'opacity 0.15s, background-color 0.15s',
              }}
            >
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: active ? color : colors.textDim,
                display: 'inline-block',
                flexShrink: 0,
                boxShadow: active ? `0 0 6px ${color}` : 'none',
              }} />
              {label}
              <span style={{
                color: colors.textSecondary,
                marginLeft: 'auto',
                paddingLeft: 8,
                fontFamily: fonts.mono,
                fontSize: '10px',
              }}>
                {pts}
              </span>
            </button>
          )
        })}

        {/* Opacity slider — hidden when all sensors off */}
        {visibleSensors.size > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 8px',
          }}>
            <span style={{ fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500, color: colors.textSecondary, whiteSpace: 'nowrap' }}>
              Opacity
            </span>
            <input
              type="range"
              min={10}
              max={100}
              value={Math.round(pointOpacity * 100)}
              onChange={(e) => setPointOpacity(Number(e.target.value) / 100)}
              style={{ width: 52, height: 2, accentColor: colors.accent }}
            />
            <span style={{
              fontSize: '10px',
              fontFamily: fonts.mono,
              color: colors.textPrimary,
              minWidth: 24,
              textAlign: 'right',
            }}>
              {Math.round(pointOpacity * 100)}%
            </span>
          </div>
        )}

        {/* ── Divider ── */}
        <div style={{ height: '1px', backgroundColor: colors.border, margin: '4px 4px' }} />

        {/* ── COLORMAP group ── */}
        <div style={{
          fontSize: '9px',
          fontFamily: fonts.sans,
          fontWeight: 600,
          color: colors.textDim,
          letterSpacing: '1.2px',
          textTransform: 'uppercase',
          padding: '2px 4px 2px',
        }}>
          Colormap
        </div>

        <div style={{
          display: 'flex',
          borderRadius: radius.sm,
          overflow: 'hidden',
          backgroundColor: 'rgba(255,255,255,0.04)',
        }}>
          {([['intensity', 'Int'], ['height', 'Z'], ['range', 'Range'], ['elongation', 'Elong']] as [ColormapMode, string][]).map(([mode, label]) => {
            const active = colormapMode === mode
            return (
              <button
                key={mode}
                onClick={() => setColormapMode(mode)}
                style={{
                  flex: 1,
                  padding: '4px 0',
                  fontSize: '10px',
                  fontFamily: fonts.sans,
                  fontWeight: active ? 600 : 400,
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: active ? 'rgba(0, 200, 219, 0.15)' : 'transparent',
                  color: active ? colors.accentBlue : colors.textDim,
                  transition: 'all 0.15s',
                  letterSpacing: '0.3px',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {/* ── PERCEPTION group (hidden when no box data) ── */}
        {hasBoxData && <>
          {/* Divider */}
          <div style={{ height: '1px', backgroundColor: colors.border, margin: '4px 4px' }} />

          <div style={{
            fontSize: '9px',
            fontFamily: fonts.sans,
            fontWeight: 600,
            color: colors.textDim,
            letterSpacing: '1.2px',
            textTransform: 'uppercase',
            padding: '2px 4px 2px',
          }}>
            Perception
          </div>

          {/* Segmented control: Off | Boxes | Models */}
          <div style={{
            display: 'flex',
            borderRadius: radius.sm,
            overflow: 'hidden',
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
                    flex: 1,
                    padding: '4px 0',
                    fontSize: '10px',
                    fontFamily: fonts.sans,
                    fontWeight: active ? 600 : 400,
                    border: 'none',
                    cursor: 'pointer',
                    backgroundColor: active
                      ? (isOn ? 'rgba(0, 200, 219, 0.15)' : 'rgba(255,255,255,0.06)')
                      : 'transparent',
                    color: active
                      ? (isOn ? colors.accentBlue : colors.textPrimary)
                      : colors.textDim,
                    transition: 'all 0.15s',
                    letterSpacing: '0.3px',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>

          {boxMode !== 'off' && (<>
            {/* Class legend */}
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '2px 8px',
              padding: '4px 8px',
            }}>
              {([
                [BoxType.TYPE_VEHICLE, 'Vehicle'],
                [BoxType.TYPE_PEDESTRIAN, 'Pedestrian'],
                [BoxType.TYPE_CYCLIST, 'Cyclist'],
                [BoxType.TYPE_SIGN, 'Sign'],
              ] as const).map(([type, label]) => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '1px',
                    backgroundColor: BOX_TYPE_COLORS[type],
                    display: 'inline-block',
                    flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: '9px',
                    fontFamily: fonts.sans,
                    color: colors.textSecondary,
                  }}>
                    {label}
                  </span>
                </div>
              ))}
            </div>

            {/* 2D overlay renderer toggle */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 8px',
            }}>
              <span style={{ fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500, color: colors.textSecondary, whiteSpace: 'nowrap' }}>
                2D
              </span>
              <div style={{
                display: 'flex',
                borderRadius: radius.sm,
                overflow: 'hidden',
                backgroundColor: 'rgba(255,255,255,0.04)',
              }}>
                {([['svg', 'SVG'], ['canvas', 'Canvas']] as [BoxRenderer, string][]).map(([mode, label]) => {
                  const active = boxRenderer === mode
                  return (
                    <button
                      key={mode}
                      onClick={() => setBoxRenderer(mode)}
                      style={{
                        padding: '2px 8px',
                        fontSize: '9px',
                        fontFamily: fonts.sans,
                        fontWeight: active ? 600 : 400,
                        border: 'none',
                        cursor: active ? 'default' : 'pointer',
                        backgroundColor: active ? 'rgba(0, 200, 219, 0.15)' : 'transparent',
                        color: active ? colors.accentBlue : colors.textDim,
                        transition: 'all 0.15s',
                        letterSpacing: '0.3px',
                        textTransform: 'uppercase',
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Trail slider */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 8px',
            }}>
              <span style={{ fontSize: '10px', fontFamily: fonts.sans, fontWeight: 500, color: colors.textSecondary, whiteSpace: 'nowrap' }}>
                Trail
              </span>
              <input
                type="range"
                min={0}
                max={50}
                value={trailLength}
                onChange={(e) => setTrailLength(Number(e.target.value))}
                style={{ width: 52, height: 2, accentColor: colors.accentBlue }}
              />
              <span style={{
                fontSize: '10px',
                fontFamily: fonts.mono,
                color: colors.textPrimary,
                minWidth: 16,
                textAlign: 'right',
              }}>
                {trailLength}
              </span>
            </div>
          </>)}
        </>}
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
            CAM {['', 'FRONT', 'FL', 'FR', 'SL', 'SR'][activeCam] ?? activeCam}
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
