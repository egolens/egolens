/**
 * BevMinimap — Bird's-eye-view minimap using a separate WebGL renderer.
 *
 * Renders R3F's scene with its own OrthographicCamera into a standalone
 * <canvas> element. Completely decoupled from R3F's render loop — renders
 * only on frame changes via Zustand subscription, not every rAF tick.
 *
 * Must be mounted INSIDE the R3F <Canvas> tree so useThree() works.
 * Returns null (no JSX in the R3F scene graph) but renders a portal
 * into an external DOM element via the companion BevMinimapPortal.
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useSceneStore } from '../../stores/useSceneStore'
import { colors } from '../../theme'

/** CSS size of the minimap (matches the overlay div) */
export const BEV_SIZE = 200
const DPR = Math.min(window.devicePixelRatio, 2)

/** Zoom levels in meters — click to cycle */
export const BEV_ZOOM_LEVELS = [10, 30, 70] as const
export const BEV_ZOOM_LABELS = ['10 m', '30 m', '70 m'] as const

/**
 * R3F-side hook: grabs the scene ref and renders it into the external canvas.
 * Must be a child of <Canvas>.
 */
export function BevMinimapRenderer({
  canvasRef,
  zoomIndex,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  zoomIndex: number
}) {
  const { scene } = useThree()
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const camRef = useRef<THREE.OrthographicCamera | null>(null)
  const zoomRef = useRef(zoomIndex)
  zoomRef.current = zoomIndex

  // Create renderer + camera once, tied to the external canvas element
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const r = BEV_ZOOM_LEVELS[0]
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false })
    renderer.setSize(BEV_SIZE, BEV_SIZE, false)
    renderer.setPixelRatio(DPR)
    renderer.setClearColor(colors.bgDeep)
    rendererRef.current = renderer

    const cam = new THREE.OrthographicCamera(-r, r, r, -r, 0.1, 500)
    cam.up.set(1, 0, 0)
    cam.position.set(0, 0, 200)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
    camRef.current = cam

    return () => {
      renderer.dispose()
      rendererRef.current = null
      camRef.current = null
    }
  }, [canvasRef])

  // Subscribe to store — re-render on any visual state change.
  // Deferred by one rAF so R3F's useFrame has already updated the
  // scene geometry (PointCloud buffers, BoundingBoxes, etc.).
  useEffect(() => {
    let rafId = 0

    const render = () => {
      const gl = rendererRef.current
      const cam = camRef.current
      if (!gl || !cam) return

      const { worldMode, currentFrame } = useSceneStore.getState()
      const pose = currentFrame?.vehiclePose ?? null
      const radius = BEV_ZOOM_LEVELS[zoomRef.current] ?? BEV_ZOOM_LEVELS[0]

      if (!worldMode) {
        cam.position.set(0, 0, 200)
        cam.up.set(1, 0, 0)
      } else if (pose) {
        cam.position.set(pose[3], pose[7], 200)
        const fwdX = pose[0], fwdY = pose[4]
        const len = Math.sqrt(fwdX * fwdX + fwdY * fwdY) || 1
        cam.up.set(fwdX / len, fwdY / len, 0)
      }

      cam.left = -radius
      cam.right = radius
      cam.top = radius
      cam.bottom = -radius
      cam.lookAt(cam.position.x, cam.position.y, 0)
      cam.updateProjectionMatrix()
      gl.render(scene, cam)
    }

    /**
     * Schedule render after TWO rAFs (lets React reconcile + R3F update scene first).
     * A single rAF isn't enough for scene-graph changes (e.g. boxMode toggle
     * unmounts BoxMesh and mounts ModelMesh) because R3F's reconciler may not
     * have committed the new Three.js objects within one animation frame.
     */
    const scheduleRender = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = requestAnimationFrame(render)
      })
    }

    scheduleRender()

    const unsub = useSceneStore.subscribe((state, prev) => {
      if (
        state.currentFrame !== prev.currentFrame ||
        state.worldMode !== prev.worldMode ||
        state.visibleSensors !== prev.visibleSensors ||
        state.boxMode !== prev.boxMode ||
        state.colormapMode !== prev.colormapMode ||
        state.pointOpacity !== prev.pointOpacity ||
        state.trailLength !== prev.trailLength
      ) {
        scheduleRender()
      }
    })

    return () => {
      unsub()
      cancelAnimationFrame(rafId)
    }
  }, [scene, zoomIndex])

  return null
}
