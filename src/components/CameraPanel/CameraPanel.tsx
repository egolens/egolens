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

/** Height of the camera strip in pixels */
const STRIP_HEIGHT = 160

export default function CameraPanel() {
  const cameraImages = useSceneStore((s) => s.currentFrame?.cameraImages)
  const cameraBoxes = useSceneStore((s) => s.currentFrame?.cameraBoxes)
  const boxMode = useSceneStore((s) => s.boxMode)
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
      {getManifest().cameraSensors.map(({ id, label }) => (
        <CameraView
          key={id}
          cameraName={id}
          label={label}
          imageBuffer={cameraImages?.get(id) ?? null}
          boxes={boxesByCamera.get(id) ?? EMPTY_BOXES}
          boxMode={boxMode}
          active={activeCam === id}
          onTogglePov={toggleActiveCam}
          onHover={setHoveredCam}
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
  active: boolean
  onTogglePov: (cameraName: number) => void
  onHover: (cameraName: number | null) => void
}

function CameraView({ cameraName, label, imageBuffer, boxes, boxMode, active, onTogglePov, onHover }: CameraViewProps) {
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

      {/* LiDAR point projection overlay (visible when Perception is not 'off') */}
      {boxMode !== 'off' && (
        <LidarProjectionOverlay cameraName={cameraName} />
      )}

      {/* 3D box → camera wireframe projection (render_annotation style) */}
      {boxMode !== 'off' && (
        <BoxProjectionOverlay cameraName={cameraName} />
      )}

      {/* 2D bounding box overlay (Waymo only — nuScenes cameraBoxes is empty) */}
      {boxes.length > 0 && (
        <BBoxOverlayCanvas cameraName={cameraName} boxes={boxes} />
      )}

      {/* Label overlay */}
      <div style={{
        position: 'absolute',
        bottom: 6,
        left: 8,
        fontSize: '9px',
        fontFamily: fonts.sans,
        fontWeight: 500,
        color: 'rgba(255, 255, 255, 0.75)',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        padding: '2px 6px',
        borderRadius: radius.sm,
        pointerEvents: 'none',
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
      }}>
        {label}
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
