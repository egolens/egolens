/**
 * BevOverlay — Circular HTML container for the BEV minimap.
 *
 * Holds the raw <canvas> element that BevMinimapRenderer draws into.
 * Provides radar ring decorations, zoom label, and click-to-zoom toggle.
 * Styled to match the frosted glass panels used elsewhere in the UI.
 */

import { useState } from 'react'
import { colors, fonts, alpha } from '../../theme'
import { BEV_SIZE, BEV_ZOOM_LABELS } from './BevMinimap'

const MARGIN_TOP = 12
const MARGIN_RIGHT = 12

export default function BevOverlay({
  canvasRef,
  zoomIndex,
  onToggleZoom,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  zoomIndex: number
  onToggleZoom: () => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onToggleZoom}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        top: MARGIN_TOP,
        right: MARGIN_RIGHT,
        width: BEV_SIZE,
        height: BEV_SIZE,
        borderRadius: '50%',
        overflow: 'hidden',
        pointerEvents: 'auto',
        cursor: 'pointer',
        border: `1px solid ${hovered ? colors.accentBlue : colors.border}`,
        boxShadow: hovered
          ? `0 2px 12px ${alpha(colors.accentBlue, 0.25)}, 0 0 0 1px ${colors.accentBlue}`
          : '0 2px 8px rgba(0, 0, 0, 0.3)',
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
    >
      {/* The actual WebGL canvas */}
      <canvas
        ref={canvasRef}
        width={BEV_SIZE * Math.min(window.devicePixelRatio, 2)}
        height={BEV_SIZE * Math.min(window.devicePixelRatio, 2)}
        style={{ width: BEV_SIZE, height: BEV_SIZE, display: 'block' }}
      />

      {/* Zoom level label */}
      <div style={{
        position: 'absolute', bottom: 12, left: '50%',
        transform: 'translateX(-50%)', pointerEvents: 'none',
      }}>
        <span style={{
          fontSize: '9px', fontFamily: fonts.mono, fontWeight: 500,
          color: hovered ? colors.textPrimary : colors.textDim,
          transition: 'color 0.2s',
        }}>
          {BEV_ZOOM_LABELS[zoomIndex]}
        </span>
      </div>
    </div>
  )
}
