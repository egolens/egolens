/**
 * CameraPanel — displays all 5 Waymo camera images in a horizontal strip.
 *
 * Layout: SIDE_LEFT | FRONT_LEFT | FRONT | FRONT_RIGHT | SIDE_RIGHT
 * The FRONT camera is slightly larger (primary view).
 *
 * Images are preloaded via new Image() before swapping src to prevent
 * broken-image icons during fast timeline scrubbing.
 *
 * Each camera has a POV button overlay that switches the 3D view
 * to that camera's perspective.
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import { useSceneStore } from '../../stores/useSceneStore'
import type { ParquetRow } from '../../utils/merge'
import { colors, fonts, radius, shadows } from '../../theme'
import { getManifest } from '../../adapters/registry'
import BBoxOverlayCanvas from './BBoxOverlayCanvas'
import LidarProjectionOverlay from './LidarProjectionOverlay'
import BoxProjectionOverlay from './BoxProjectionOverlay'
import KeypointOverlay from './KeypointOverlay'
import CameraSegOverlay from './CameraSegOverlay'
import { trackKeyboardShortcut } from '../../utils/analytics'

/** Height of the camera strip in pixels */
const STRIP_HEIGHT = 160
const STRIP_HEIGHT_MOBILE = 100

function useIsMobile(breakpoint = 600) {
  const [m, setM] = useState(() => window.innerWidth < breakpoint)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const h = (e: MediaQueryListEvent) => setM(e.matches)
    mq.addEventListener('change', h)
    setM(mq.matches)
    return () => mq.removeEventListener('change', h)
  }, [breakpoint])
  return m
}

export default function CameraPanel() {
  const cameraImages = useSceneStore((s) => s.currentFrame?.cameraImages)
  const cameraBoxes = useSceneStore((s) => s.currentFrame?.cameraBoxes)
  const boxMode = useSceneStore((s) => s.boxMode)
  const showLidarOverlay = useSceneStore((s) => s.showLidarOverlay)
  const activeCam = useSceneStore((s) => s.activeCam)
  const toggleActiveCam = useSceneStore((s) => s.actions.toggleActiveCam)
  const setHoveredCam = useSceneStore((s) => s.actions.setHoveredCam)

  // Group camera boxes by camera name (only when boxMode is not 'off')
  const boxesByCamera = useMemo(() => {
    const map = new Map<number, ParquetRow[]>()
    if (boxMode === 'off' || !cameraBoxes) return map
    for (const row of cameraBoxes) {
      const camName = row['key.camera_name'] as number
      let arr = map.get(camName)
      if (!arr) {
        arr = []
        map.set(camName, arr)
      }
      arr.push(row)
    }
    return map
  }, [cameraBoxes, boxMode])

  const isMobile = useIsMobile()
  const cameras = getManifest().cameraSensors

  // Number key shortcuts: 1–9 toggle camera POV
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // Digit1..Digit9 → index 0..8
      const match = e.code.match(/^Digit([1-9])$/)
      if (!match) return
      const idx = parseInt(match[1], 10) - 1
      if (idx < cameras.length) {
        e.preventDefault()
        toggleActiveCam(cameras[idx].id)
        trackKeyboardShortcut(`${idx + 1}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cameras, toggleActiveCam])

  // Mobile: two rows — FRONT-labeled cameras on top, everything else on bottom
  // Top row: only cameras with "FRONT" in the label (FL, F, FR)
  // Bottom row: SIDE + BACK/REAR cameras
  // Within each row: LEFT → center → RIGHT
  // If no bottom row cameras (shouldn't happen), fall back to single row
  if (isMobile) {
    const isFront = (l: string) => l.includes('FRONT')
    const sortLR = (a: typeof cameras[0], b: typeof cameras[0]) => {
      // BACK/REAR on outer edges, SIDE in middle: RL · SL · SR · RR
      const order = (l: string) => {
        if (l.includes('REAR L') || l.includes('BACK L')) return 0
        if (l.includes('LEFT')) return 1
        if (l.includes('REAR R') || l.includes('BACK R')) return 4
        if (l.includes('RIGHT')) return 3
        return 2
      }
      return order(a.label) - order(b.label)
    }
    const topRow = cameras.filter(c => isFront(c.label)).sort(sortLR)
    const bottomRow = cameras.filter(c => !isFront(c.label)).sort(sortLR)
    const twoRows = bottomRow.length > 0
    const rows = twoRows ? [topRow, bottomRow] : [topRow]
    const rowHeight = STRIP_HEIGHT_MOBILE

    return (
      <div style={{
        height: twoRows ? rowHeight * 2 + 4 : rowHeight + 6,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '3px 4px',
        backgroundColor: colors.bgDeep,
        borderTop: `1px solid ${colors.borderSubtle}`,
        overflow: 'hidden',
      }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', gap: '3px', flex: 1, minHeight: 0 }}>
            {row.map(({ id, label }) => (
              <CameraView
                key={id}
                cameraName={id}
                label={label}
                imageBuffer={cameraImages?.get(id) ?? null}
                boxes={boxesByCamera.get(id) ?? EMPTY_BOXES}
                boxMode={boxMode}
                showLidarOverlay={showLidarOverlay}
                active={activeCam === id}
                onTogglePov={toggleActiveCam}
                onHover={setHoveredCam}
                shortcutKey={cameras.findIndex(c => c.id === id) + 1}
              />
            ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{
      height: STRIP_HEIGHT,
      flexShrink: 0,
      display: 'flex',
      gap: '6px',
      padding: '6px 8px',
      backgroundColor: colors.bgDeep,
      borderTop: `1px solid ${colors.borderSubtle}`,
      overflow: 'hidden',
    }}>
      {cameras.map(({ id, label }, idx) => (
        <CameraView
          key={id}
          cameraName={id}
          label={label}
          imageBuffer={cameraImages?.get(id) ?? null}
          boxes={boxesByCamera.get(id) ?? EMPTY_BOXES}
          boxMode={boxMode}
          showLidarOverlay={showLidarOverlay}
          active={activeCam === id}
          onTogglePov={toggleActiveCam}
          onHover={setHoveredCam}
          shortcutKey={idx + 1}
        />
      ))}
    </div>
  )
}

const EMPTY_BOXES: ParquetRow[] = []

// ---------------------------------------------------------------------------
// Single camera view
// ---------------------------------------------------------------------------

interface CameraViewProps {
  cameraName: number
  label: string
  imageBuffer: ArrayBuffer | null
  boxes: ParquetRow[]
  boxMode: string
  showLidarOverlay: boolean
  active: boolean
  onTogglePov: (cameraName: number) => void
  onHover: (cameraName: number | null) => void
  /** Keyboard shortcut number (1-9) shown on label */
  shortcutKey?: number
}

function CameraView({ cameraName, label, imageBuffer, boxes, boxMode, showLidarOverlay, active, onTogglePov, onHover, shortcutKey }: CameraViewProps) {
  const showKeypoints2D = useSceneStore((s) => s.showKeypoints2D)
  const hasKeypoints = useSceneStore((s) => s.hasKeypoints)
  const showCameraSeg = useSceneStore((s) => s.showCameraSeg)
  const hasCameraSeg = useSceneStore((s) => s.hasCameraSegmentation)
  /** The URL currently displayed (kept until a new image fully loads) */
  const [displayUrl, setDisplayUrl] = useState<string | null>(null)
  /** The newest blob URL being loaded (may not be visible yet) */
  const pendingUrlRef = useRef<string | null>(null)
  /** The blob URL currently shown on screen (for cleanup) */
  const activeUrlRef = useRef<string | null>(null)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (!imageBuffer) return // keep showing the last good image

    // Create blob URL for the new frame
    const blob = new Blob([imageBuffer], { type: 'image/jpeg' })
    const newUrl = URL.createObjectURL(blob)
    pendingUrlRef.current = newUrl

    // Preload: only swap when the browser has the image decoded
    const img = new Image()
    img.onload = () => {
      // Only apply if this is still the most recent request
      if (pendingUrlRef.current !== newUrl) {
        URL.revokeObjectURL(newUrl)
        return
      }
      // Revoke the previously displayed URL
      if (activeUrlRef.current) URL.revokeObjectURL(activeUrlRef.current)
      activeUrlRef.current = newUrl
      setDisplayUrl(newUrl)
    }
    img.onerror = () => {
      // Corrupted frame — discard, keep previous image
      URL.revokeObjectURL(newUrl)
      if (pendingUrlRef.current === newUrl) pendingUrlRef.current = null
    }
    img.src = newUrl

    return () => {
      // If a newer effect fires before this image loaded, clean up
      if (pendingUrlRef.current === newUrl) pendingUrlRef.current = null
    }
  }, [imageBuffer])

  // Derive flex and color from manifest
  const manifest = getManifest()
  const camDef = manifest.cameraSensors.find(c => c.id === cameraName)
  const flex = camDef?.flex ?? 1
  const accentColor = manifest.cameraColors[cameraName] ?? '#888'

  return (
    <div
      style={{
        flex,
        position: 'relative',
        backgroundColor: colors.bgBase,
        borderRadius: radius.md,
        overflow: 'hidden',
        minWidth: 0,
        cursor: 'pointer',
        border: active ? `2px solid ${accentColor}` : hovered ? '2px solid rgba(255,255,255,0.45)' : `2px solid ${colors.borderSubtle}`,
        boxShadow: active ? `0 0 12px ${accentColor}33` : shadows.card,
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
      onClick={() => onTogglePov(cameraName)}
      onMouseEnter={() => { setHovered(true); onHover(cameraName) }}
      onMouseLeave={() => { setHovered(false); onHover(null) }}
    >
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={label}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textDim,
          fontSize: '11px',
          fontFamily: fonts.sans,
        }}>
          No image
        </div>
      )}

      {/* Camera segmentation overlay (below lidar/bbox overlays) */}
      {showCameraSeg && hasCameraSeg && (
        <CameraSegOverlay cameraName={cameraName} />
      )}

      {/* LiDAR point projection overlay (separate toggle) */}
      {showLidarOverlay && (
        <LidarProjectionOverlay cameraName={cameraName} />
      )}

      {/* 3D box → camera wireframe projection (only when no native 2D boxes — AV2/nuScenes) */}
      {boxMode !== 'off' && boxes.length === 0 && (
        <BoxProjectionOverlay cameraName={cameraName} />
      )}

      {/* Native 2D bounding box overlay (Waymo — has pre-associated camera_box data) */}
      {boxes.length > 0 && (
        <BBoxOverlayCanvas cameraName={cameraName} boxes={boxes} />
      )}

      {/* 2D keypoint skeleton overlay (Waymo camera_hkp) */}
      {showKeypoints2D && hasKeypoints && (
        <KeypointOverlay cameraName={cameraName} />
      )}

      {/* Label overlay — abbreviate on mobile to avoid two-line wrap */}
      <div style={{
        position: 'absolute',
        bottom: 4,
        left: 4,
        fontSize: '9px',
        fontFamily: fonts.sans,
        fontWeight: 500,
        color: 'rgba(255, 255, 255, 0.75)',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        padding: '2px 5px',
        borderRadius: radius.sm,
        pointerEvents: 'none',
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}>
        {window.innerWidth < 600
          ? (label.includes(' ') ? label.split(' ').map(w => w[0]).join('') : label)
          : label}
        {shortcutKey != null && (
          <span style={{ opacity: 0.5, marginLeft: 4, fontSize: '8px' }}>{shortcutKey}</span>
        )}
      </div>

      {/* Active dot indicator */}
      {active && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: accentColor,
          boxShadow: `0 0 8px ${accentColor}`,
        }} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2D Bounding Box SVG Overlay
