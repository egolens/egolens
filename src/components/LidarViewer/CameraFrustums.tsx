/**
 * CameraFrustums — renders 5 Waymo camera frustums in the 3D scene.
 *
 * Each frustum is a wireframe pyramid showing the camera's field of view.
 * Frustums highlight when the corresponding camera image is hovered.
 */

import { useMemo } from 'react'
import { useSceneStore } from '../../stores/useSceneStore'
import { parseCameraCalibrations, buildFrustumBase, buildFrustumEdges, type CameraCalib } from '../../utils/cameraCalibration'
import { getManifest } from '../../adapters/registry'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRUSTUM_FAR = 2

// ---------------------------------------------------------------------------
// Single frustum
// ---------------------------------------------------------------------------

function CameraFrustum({
  calib,
  active,
  hovered,
}: {
  calib: CameraCalib
  active: boolean
  hovered: boolean
}) {
  const color = getManifest().cameraColors[calib.cameraName] ?? '#888888'

  const basePositions = useMemo(
    () => buildFrustumBase(calib.hFov, calib.vFov, FRUSTUM_FAR),
    [calib.hFov, calib.vFov],
  )
  const edgePositions = useMemo(
    () => buildFrustumEdges(calib.hFov, calib.vFov, FRUSTUM_FAR),
    [calib.hFov, calib.vFov],
  )

  const highlighted = hovered || active
  const lineColor = highlighted ? (hovered ? '#ffffff' : color) : color
  const lineOpacity = highlighted ? 1.0 : 0.6

  return (
    <group
      position={calib.position}
      quaternion={calib.quaternion}
    >
      {/* Base rectangle — always visible */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[basePositions, 3]}
          />
        </bufferGeometry>
        <lineBasicMaterial color={lineColor} transparent opacity={lineOpacity} />
      </lineSegments>

      {/* Pyramid edges — always mounted, toggle visibility to avoid re-creating meshes */}
      <lineSegments visible={highlighted}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[edgePositions, 3]}
          />
        </bufferGeometry>
        <lineBasicMaterial color={lineColor} />
      </lineSegments>
    </group>
  )
}

// ---------------------------------------------------------------------------
// All frustums
// ---------------------------------------------------------------------------

export default function CameraFrustums({
  activeCam,
}: {
  activeCam: number | null
}) {
  const cameraCalibrations = useSceneStore((s) => s.cameraCalibrations)
  const hoveredCam = useSceneStore((s) => s.hoveredCam)

  const calibMap = useMemo(
    () => parseCameraCalibrations(cameraCalibrations),
    [cameraCalibrations],
  )

  if (calibMap.size === 0 || activeCam !== null) return null

  return (
    <group>
      {[...calibMap.values()].map((calib) => (
        <CameraFrustum
          key={calib.cameraName}
          calib={calib}
          active={activeCam === calib.cameraName}
          hovered={hoveredCam === calib.cameraName}
        />
      ))}
    </group>
  )
}
