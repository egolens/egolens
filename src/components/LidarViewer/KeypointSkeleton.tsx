/**
 * KeypointSkeleton — 3D human skeleton renderer for Waymo LiDAR keypoints.
 *
 * Renders 14-joint skeletons (spheres for joints, lines for bones) for each
 * pedestrian in the current frame.
 *
 * Data source: lidar_hkp parquet → keypointsByFrame in internal store.
 *
 * IMPORTANT: Each parquet row is ONE pedestrian object, with arrays of 14 joints:
 *   - `[LiDARHumanKeypointsComponent].lidar_keypoints[*].type` — array of proto enum ints
 *   - `[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.{x,y,z}`
 *
 * Joint type values are Waymo proto KeypointType enum (sparse: 1,5-10,13-20),
 * NOT 0-indexed sequential. See waymoSemanticClasses.ts for the mapping.
 *
 * Bones: defined in WAYMO_SKELETON_BONES using proto enum values.
 * Colors: per-joint and per-bone colors from WAYMO_KEYPOINT_COLORS / WAYMO_BONE_COLORS.
 */

import { useRef, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useSceneStore } from '../../stores/useSceneStore'
import {
  WAYMO_SKELETON_BONES,
  WAYMO_KEYPOINT_COLORS,
  WAYMO_BONE_COLORS,
} from '../../utils/waymoSemanticClasses'
import type { ParquetRow } from '../../utils/merge'

// ---------------------------------------------------------------------------
// Parquet column names (v2.0 lidar_hkp schema)
// ---------------------------------------------------------------------------

const COL_OBJECT_ID = 'key.laser_object_id'
const COL_TYPE = '[LiDARHumanKeypointsComponent].lidar_keypoints[*].type'
const COL_X = '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.x'
const COL_Y = '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.y'
const COL_Z = '[LiDARHumanKeypointsComponent].lidar_keypoints[*].keypoint_3d.location_m.z'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeypointJoint {
  type: number
  x: number
  y: number
  z: number
}

export interface KeypointObject {
  objectId: string
  joints: KeypointJoint[]
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse raw Parquet rows from lidar_hkp into structured KeypointObject[].
 *
 * Each row = one pedestrian object.  The type/x/y/z columns are **arrays**
 * of 14 values (one per joint).  We unzip them into KeypointJoint[].
 */
export function parseKeypointRows(rows: ParquetRow[]): KeypointObject[] {
  const result: KeypointObject[] = []

  for (const row of rows) {
    const objectId = row[COL_OBJECT_ID] as string | undefined
    if (!objectId) continue

    const types = row[COL_TYPE] as number[] | undefined
    const xs = row[COL_X] as number[] | undefined
    const ys = row[COL_Y] as number[] | undefined
    const zs = row[COL_Z] as number[] | undefined

    if (!types || !xs || !ys || !zs) continue
    const n = Math.min(types.length, xs.length, ys.length, zs.length)
    if (n === 0) continue

    const joints: KeypointJoint[] = []
    for (let i = 0; i < n; i++) {
      joints.push({ type: types[i], x: xs[i], y: ys[i], z: zs[i] })
    }
    result.push({ objectId, joints })
  }

  return result
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JOINT_RADIUS = 0.08
const JOINT_SEGMENTS = 8
const DEFAULT_JOINT_COLOR: [number, number, number] = [0.8, 1.0, 0.0] // lime fallback

// Max joints = 30 pedestrians × 15 joints = 450 (generous upper bound)
const MAX_JOINTS = 512

// Shared geometry (created once)
const jointGeometry = new THREE.SphereGeometry(JOINT_RADIUS, JOINT_SEGMENTS, JOINT_SEGMENTS)

// Temp objects for InstancedMesh matrix setup
const _matrix = new THREE.Matrix4()
const _color = new THREE.Color()

// ---------------------------------------------------------------------------
// Module-level keypoint data reference
// ---------------------------------------------------------------------------

let _keypointsByFrame: Map<bigint, ParquetRow[]> = new Map()

/** Called by store during unpackMetadata to share the keypointsByFrame reference */
export function setKeypointsByFrameRef(map: Map<bigint, ParquetRow[]>) {
  _keypointsByFrame = map
}

function getKeypointRowsForTimestamp(timestamp: bigint): ParquetRow[] | undefined {
  return _keypointsByFrame.get(timestamp)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function KeypointSkeleton() {
  const currentFrame = useSceneStore((s) => s.currentFrame)
  const showKeypoints = useSceneStore((s) => s.showKeypoints)
  const hasKeypoints = useSceneStore((s) => s.hasKeypoints)

  const meshRef = useRef<THREE.InstancedMesh>(null)
  const boneGroupRef = useRef<THREE.Group>(null)

  // Parse keypoint objects for current frame
  const objects = useMemo(() => {
    if (!showKeypoints || !hasKeypoints || !currentFrame) return []
    const rows = getKeypointRowsForTimestamp(currentFrame.timestamp)
    if (!rows || rows.length === 0) return []
    return parseKeypointRows(rows)
  }, [showKeypoints, hasKeypoints, currentFrame])

  // Update InstancedMesh + bone geometry when objects change
  useEffect(() => {
    const mesh = meshRef.current
    const boneGroup = boneGroupRef.current
    if (!mesh || !boneGroup) return

    // --- Joints: InstancedMesh with per-instance color ---
    let jointCount = 0
    // Collect all bone segments for batch creation
    const boneSegments: { from: THREE.Vector3; to: THREE.Vector3; color: [number, number, number] }[] = []

    for (const obj of objects) {
      // Build type→position map for bone lookups
      const jointByType = new Map<number, { x: number; y: number; z: number }>()

      for (const j of obj.joints) {
        if (jointCount < MAX_JOINTS) {
          _matrix.makeTranslation(j.x, j.y, j.z)
          mesh.setMatrixAt(jointCount, _matrix)

          // Per-joint color
          const rgb = WAYMO_KEYPOINT_COLORS[j.type] ?? DEFAULT_JOINT_COLOR
          _color.setRGB(rgb[0], rgb[1], rgb[2])
          mesh.setColorAt(jointCount, _color)

          jointCount++
        }
        jointByType.set(j.type, j)
      }

      // Build bone line segments
      for (const [fromType, toType] of WAYMO_SKELETON_BONES) {
        const from = jointByType.get(fromType)
        const to = jointByType.get(toType)
        if (from && to) {
          const boneKey = `${fromType}-${toType}`
          const rgb = WAYMO_BONE_COLORS[boneKey] ?? DEFAULT_JOINT_COLOR
          boneSegments.push({
            from: new THREE.Vector3(from.x, from.y, from.z),
            to: new THREE.Vector3(to.x, to.y, to.z),
            color: rgb,
          })
        }
      }
    }

    // Update instanced mesh count
    mesh.count = jointCount
    if (jointCount > 0) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }

    // --- Bones: rebuild per-bone colored line segments ---
    // Clear previous bone children
    while (boneGroup.children.length > 0) {
      const child = boneGroup.children[0]
      boneGroup.remove(child)
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose()
        ;(child.material as THREE.Material).dispose()
      }
    }

    if (boneSegments.length > 0) {
      // Group bone segments by color to reduce draw calls
      const byColor = new Map<string, number[]>()
      for (const seg of boneSegments) {
        const key = seg.color.join(',')
        let arr = byColor.get(key)
        if (!arr) {
          arr = []
          byColor.set(key, arr)
        }
        arr.push(seg.from.x, seg.from.y, seg.from.z)
        arr.push(seg.to.x, seg.to.y, seg.to.z)
      }

      for (const [colorKey, positions] of byColor) {
        const [r, g, b] = colorKey.split(',').map(Number)
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        const mat = new THREE.LineBasicMaterial({
          color: new THREE.Color(r, g, b),
          linewidth: 2,
        })
        const lines = new THREE.LineSegments(geo, mat)
        lines.frustumCulled = false
        boneGroup.add(lines)
      }
    }
  }, [objects])

  if (!showKeypoints || !hasKeypoints) return null

  return (
    <group>
      {/* Joints: InstancedMesh — allocate MAX_JOINTS, set count dynamically */}
      <instancedMesh
        ref={meshRef}
        args={[jointGeometry, undefined, MAX_JOINTS]}
        frustumCulled={false}
      >
        <meshBasicMaterial vertexColors={false} toneMapped={false} />
      </instancedMesh>

      {/* Bones: group of per-color LineSegments, rebuilt each frame */}
      <group ref={boneGroupRef} />
    </group>
  )
}
