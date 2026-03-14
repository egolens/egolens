/**
 * ObjectModels — 3D models for Waymo perception object types.
 *
 * VEHICLE, PEDESTRIAN, SIGN load external GLB assets from public/models/.
 * CYCLIST uses procedural THREE.js geometry (no GLB yet).
 *
 * Each model is normalized to fill a unit cube [-0.5, 0.5]³ per-axis.
 * The parent group in BoundingBoxes scales by [box.sx, box.sy, box.sz]
 * to match actual detection dimensions.
 *
 * Waymo frame: X=forward, Y=left, Z=up.
 */

import { useMemo, useRef, useEffect, Suspense } from 'react'
import * as THREE from 'three'
import { useLoader } from '@react-three/fiber'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// ============================================================================
// Axis correction: GLB (Y-up, -Z-forward) → Waymo (Z-up, X-forward)
// ============================================================================
//
// GLB/glTF convention: X=right, Y=up, -Z=forward  (right-handed)
// Waymo vehicle frame: X=forward, Y=left, Z=up     (right-handed)
//
// Axis mapping:
//   GLB X (right)   → Waymo -Y (right = −left)
//   GLB Y (up)      → Waymo  Z (up)
//   GLB Z (back)    → Waymo -X (back, since −Z=fwd → X=fwd)
//
const GLB_TO_WAYMO_QUAT = (() => {
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, -1, 0),  // GLB X → Waymo −Y
    new THREE.Vector3(0, 0, 1),   // GLB Y → Waymo +Z
    new THREE.Vector3(-1, 0, 0),  // GLB Z → Waymo −X
  )
  return new THREE.Quaternion().setFromRotationMatrix(m)
})()

// ============================================================================
// Shared GLB model loader — axis-correct + normalize to unit cube
// ============================================================================

function GLBModel({ url, color, opacity, yawOffset = 0, preserveDepth = false }: {
  url: string; color: string; opacity: number
  /** Extra yaw rotation (radians) around GLB's Y-up axis, applied before axis correction.
   *  Use Math.PI to flip a model that faces +Z instead of -Z. */
  yawOffset?: number
  /** When true, X-axis (depth/forward) scales proportionally with Y/Z instead of
   *  stretching to fill the bounding box. Good for flat objects like signs. */
  preserveDepth?: boolean
}) {
  const gltf = useLoader(GLTFLoader, url)
  const groupRef = useRef<THREE.Group>(null)

  const built = useMemo(() => {
    const scene = gltf.scene.clone(true)

    // Apply uniform color material (fully opaque for 3D models)
    // Also remove rig helper meshes (e.g. CSH.Cube from Blender custom shapes)
    const mat = new THREE.MeshPhongMaterial({
      color,
      flatShading: true,
    })
    const toRemove: THREE.Object3D[] = []
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (child.name.startsWith('CSH.') || child.parent?.name.startsWith('CSH.')) {
          toRemove.push(child)
        } else {
          child.material = mat
        }
      }
    })
    toRemove.forEach((obj) => obj.parent?.remove(obj))

    // Pre-rotation: fix model-specific facing direction in GLB space (Y-up)
    if (yawOffset !== 0) {
      scene.rotation.y = yawOffset
    }

    // Rotation group: GLB Y-up → Waymo Z-up + forward alignment
    const rotGroup = new THREE.Group()
    rotGroup.quaternion.copy(GLB_TO_WAYMO_QUAT)
    rotGroup.add(scene)
    rotGroup.updateMatrixWorld(true)

    // Compute world-space bounding box (post-rotation)
    const bbox = new THREE.Box3().setFromObject(rotGroup)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    bbox.getSize(size)
    bbox.getCenter(center)

    // Per-axis normalization: stretch to fill unit cube [-0.5, 0.5]³
    // so the parent's scale=[box.sx, box.sy, box.sz] matches detection dims
    const sy = size.y > 0.001 ? 1 / size.y : 1
    const sz = size.z > 0.001 ? 1 / size.z : 1
    // For flat objects (signs), keep X proportional to Y/Z to avoid depth distortion
    const sx = preserveDepth
      ? (sy + sz) / 2
      : (size.x > 0.001 ? 1 / size.x : 1)

    const wrapper = new THREE.Group()
    wrapper.scale.set(sx, sy, sz)
    wrapper.position.set(-center.x * sx, -center.y * sy, -center.z * sz)
    wrapper.add(rotGroup)

    return wrapper
  }, [gltf, color, opacity])

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.clear()
      groupRef.current.add(built)
    }
  }, [built])

  return <group ref={groupRef} />
}

/** Simple box fallback while GLB is loading */
function FallbackBox({ color, opacity }: { color: string; opacity: number }) {
  return (
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color={color} transparent opacity={opacity * 0.5} depthWrite={false} />
    </mesh>
  )
}

// ============================================================================
// Vehicle — public/models/car.glb
// ============================================================================

export function VehicleModel({ color, opacity }: { color: string; opacity: number }) {
  return (
    <Suspense fallback={<FallbackBox color={color} opacity={opacity} />}>
      <GLBModel url={`${import.meta.env.BASE_URL}models/car.glb`} color={color} opacity={opacity} yawOffset={Math.PI} />
    </Suspense>
  )
}

// ============================================================================
// Pedestrian — public/models/person.glb
// ============================================================================

export function PedestrianModel({ color, opacity }: { color: string; opacity: number }) {
  return (
    <Suspense fallback={<FallbackBox color={color} opacity={opacity} />}>
      <GLBModel url={`${import.meta.env.BASE_URL}models/person.glb`} color={color} opacity={opacity} />
    </Suspense>
  )
}

// ============================================================================
// Sign — public/models/sign.glb
// ============================================================================

export function SignModel({ color, opacity }: { color: string; opacity: number }) {
  return (
    <Suspense fallback={<FallbackBox color={color} opacity={opacity} />}>
      <GLBModel url={`${import.meta.env.BASE_URL}models/sign.glb`} color={color} opacity={opacity} preserveDepth />
    </Suspense>
  )
}

// ============================================================================
// Cyclist — public/models/cyclist.glb
// ============================================================================

export function CyclistModel({ color, opacity }: { color: string; opacity: number }) {
  return (
    <Suspense fallback={<FallbackBox color={color} opacity={opacity} />}>
      <GLBModel url={`${import.meta.env.BASE_URL}models/cyclist.glb`} color={color} opacity={opacity} yawOffset={Math.PI / 2} />
    </Suspense>
  )
}

// ============================================================================
// Traffic Cone — public/models/cone.glb
// ============================================================================

export function TrafficConeModel({ color, opacity }: { color: string; opacity: number }) {
  return (
    <Suspense fallback={<FallbackBox color={color} opacity={opacity} />}>
      <GLBModel url={`${import.meta.env.BASE_URL}models/cone.glb`} color={color} opacity={opacity} />
    </Suspense>
  )
}

// ============================================================================
// Barrier — public/models/barrier.glb
// ============================================================================

export function BarrierModel({ color, opacity }: { color: string; opacity: number }) {
  return (
    <Suspense fallback={<FallbackBox color={color} opacity={opacity} />}>
      <GLBModel url={`${import.meta.env.BASE_URL}models/barrier.glb`} color={color} opacity={opacity} />
    </Suspense>
  )
}

// ============================================================================
// Bicycle — public/models/bicycle.glb
// ============================================================================

export function BicycleModel({ color, opacity }: { color: string; opacity: number }) {
  return (
    <Suspense fallback={<FallbackBox color={color} opacity={opacity} />}>
      <GLBModel url={`${import.meta.env.BASE_URL}models/bicycle.glb`} color={color} opacity={opacity} yawOffset={Math.PI} />
    </Suspense>
  )
}

// ============================================================================
// Motorcycle — public/models/motorcycle.glb
// ============================================================================

export function MotorcycleModel({ color, opacity }: { color: string; opacity: number }) {
  return (
    <Suspense fallback={<FallbackBox color={color} opacity={opacity} />}>
      <GLBModel url={`${import.meta.env.BASE_URL}models/motorcycle.glb`} color={color} opacity={opacity} yawOffset={Math.PI} />
    </Suspense>
  )
}
