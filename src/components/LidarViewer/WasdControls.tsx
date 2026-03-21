/**
 * WasdControls — keyboard-driven camera movement for trackpad/laptop users.
 *
 * Runs inside the R3F Canvas as a sibling to OrbitControls.
 * Moves both camera.position and orbitControls.target together so
 * the orbit center follows the camera (no unexpected rotation).
 *
 * Uses e.code (physical key position) so it works regardless of
 * keyboard layout or IME input mode (e.g. Korean/Japanese).
 *
 * Keybindings:
 *   W     — dolly forward (toward look direction)
 *   S     — dolly backward
 *   A     — strafe left
 *   D     — strafe right
 *   Q     — move down
 *   E     — move up
 *   I     — rotate up (tilt camera upward)
 *   K     — rotate down (tilt camera downward)
 *   J     — rotate left (pan camera left)
 *   L     — rotate right (pan camera right)
 *   Shift — 3× speed boost while held
 */

import { useEffect, useRef, useCallback } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { trackCameraSettle } from '../../utils/analytics'
import { useSceneStore } from '../../stores/useSceneStore'

// Reusable vectors (allocated once, never GC'd)
const _forward = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3(0, 0, 1) // Waymo: Z-up
const _delta = new THREE.Vector3()
const _offset = new THREE.Vector3()

/** Speed in world-units per second */
const BASE_SPEED = 20
/** Rotation speed in radians per second */
const ROTATE_SPEED = 1.5
const SHIFT_MULTIPLIER = 3

/** Physical key codes we care about */
const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'KeyI', 'KeyJ', 'KeyK', 'KeyL',
  'ShiftLeft', 'ShiftRight',
])

interface WasdControlsProps {
  /** OrbitControls ref — target is moved alongside camera */
  orbitRef: React.RefObject<any>
  /** Disable keyboard movement (e.g. during POV animation) */
  enabled?: boolean
  /** Called when WASD movement starts — used to disable follow-cam */
  onMoveStart?: () => void
}

/** Settle timeout: log camera position after 2s idle */
const SETTLE_MS = 2000

export default function WasdControls({ orbitRef, enabled = true, onMoveStart }: WasdControlsProps) {
  const { camera } = useThree()
  const keys = useRef<Set<string>>(new Set())
  const onMoveStartRef = useRef(onMoveStart)
  onMoveStartRef.current = onMoveStart
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasMoving = useRef(false)

  const fireSettle = useCallback(() => {
    const oc = orbitRef.current
    if (!oc) return
    const { worldMode, currentSegment, currentFrameIndex } = useSceneStore.getState()
    trackCameraSettle({
      px: camera.position.x, py: camera.position.y, pz: camera.position.z,
      tx: oc.target.x, ty: oc.target.y, tz: oc.target.z,
      worldMode,
      segment: currentSegment ?? '',
      frame: currentFrameIndex,
    })
  }, [camera, orbitRef])

  // Track pressed keys by physical code
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      // Ignore when typing in an input/textarea/select
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (MOVE_CODES.has(e.code)) {
        keys.current.add(e.code)
      }
    }
    const onUp = (e: KeyboardEvent) => {
      keys.current.delete(e.code)
    }
    const onBlur = () => {
      keys.current.clear()
    }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useFrame((_, dt) => {
    // Check settle even when no keys pressed (user just released)
    if (!enabled || keys.current.size === 0) {
      if (wasMoving.current) {
        wasMoving.current = false
        if (settleTimer.current) clearTimeout(settleTimer.current)
        settleTimer.current = setTimeout(fireSettle, SETTLE_MS)
      }
      return
    }
    const oc = orbitRef.current
    if (!oc) return

    const k = keys.current
    const shift = k.has('ShiftLeft') || k.has('ShiftRight')
    const speed = BASE_SPEED * (shift ? SHIFT_MULTIPLIER : 1) * dt
    const rotSpeed = ROTATE_SPEED * (shift ? SHIFT_MULTIPLIER : 1) * dt

    let moved = false

    // ── Translation (WASD + QE) ──

    // Forward = camera look direction projected onto XY plane (Z-up world)
    camera.getWorldDirection(_forward)
    _forward.z = 0
    _forward.normalize()

    // Right = up × forward (Z-up world: gives correct right-hand direction)
    _right.crossVectors(_up, _forward).normalize()

    _delta.set(0, 0, 0)

    // Forward / backward
    if (k.has('KeyW')) _delta.addScaledVector(_forward, speed)
    if (k.has('KeyS')) _delta.addScaledVector(_forward, -speed)

    // Strafe left / right
    if (k.has('KeyA')) _delta.addScaledVector(_right, speed)
    if (k.has('KeyD')) _delta.addScaledVector(_right, -speed)

    // Up / down (world Z)
    if (k.has('KeyE')) _delta.z += speed
    if (k.has('KeyQ')) _delta.z -= speed

    if (_delta.lengthSq() > 0) {
      camera.position.add(_delta)
      oc.target.add(_delta)
      moved = true
    }

    // ── Rotation (IJKL) — orbit camera around target using axis-angle ──
    // Uses world Z-up axis for horizontal, camera right axis for vertical.
    // This avoids THREE.Spherical which assumes Y-up and produces wrong axes.

    _offset.copy(camera.position).sub(oc.target)

    // J/L = horizontal rotation around world Z axis
    if (k.has('KeyJ') || k.has('KeyL')) {
      const angle = k.has('KeyJ') ? rotSpeed : -rotSpeed
      _offset.applyAxisAngle(_up, angle)
      moved = true
    }

    // I/K = vertical rotation around camera's right axis
    if (k.has('KeyI') || k.has('KeyK')) {
      const angle = k.has('KeyI') ? -rotSpeed : rotSpeed
      // Compute camera right vector for vertical rotation axis
      camera.getWorldDirection(_forward)
      _right.crossVectors(_up, _forward).normalize()

      // Clamp: don't let camera go past directly above or below target
      const newOffset = _offset.clone().applyAxisAngle(_right, angle)
      const dotUp = newOffset.normalize().dot(_up)
      if (Math.abs(dotUp) < 0.98) {
        _offset.applyAxisAngle(_right, angle)
        moved = true
      }
    }

    if (moved) {
      camera.position.copy(oc.target).add(_offset)
    }

    if (moved) {
      // Notify parent (e.g. to disable follow-cam)
      onMoveStartRef.current?.()
      oc.update()

      // Reset settle timer — user is still moving
      wasMoving.current = true
      if (settleTimer.current) clearTimeout(settleTimer.current)
      settleTimer.current = null
    } else if (wasMoving.current) {
      // Movement just stopped — start settle countdown
      wasMoving.current = false
      if (settleTimer.current) clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(fireSettle, SETTLE_MS)
    }
  })

  return null
}
