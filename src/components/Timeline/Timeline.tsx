/**
 * Timeline — frame scrubber with play/pause, buffer bar, and playhead.
 *
 * Shows a YouTube-style buffer bar indicating which frames are loaded,
 * a gradient progress bar for the current position, and a draggable scrubber.
 *
 * Extracted from App.tsx for maintainability — this component will grow
 * with annotation frame markers (segmentation, keypoints).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSceneStore } from '../../stores/useSceneStore'
import { colors, fonts, radius, gradients } from '../../theme'

// ---------------------------------------------------------------------------
// Buffer segment computation (pure function, exported for testing)
// ---------------------------------------------------------------------------

export interface BufferSegment {
  start: number
  end: number
}

/**
 * Compute continuous ranges from a sorted array of cached frame indices.
 * e.g. [0,1,2, 5,6,7] → [{start:0,end:2}, {start:5,end:7}]
 */
export function computeBufferSegments(cachedFrames: number[], totalFrames: number): BufferSegment[] {
  if (totalFrames <= 1) return []
  const segments: BufferSegment[] = []
  let segStart = -1
  for (let i = 0; i < cachedFrames.length; i++) {
    const f = cachedFrames[i]
    if (segStart === -1) {
      segStart = f
    }
    const next = cachedFrames[i + 1]
    if (next === undefined || next !== f + 1) {
      segments.push({ start: segStart, end: f })
      segStart = -1
    }
  }
  return segments
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const windowChipButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  background: 'none',
  border: '1px solid rgba(0, 201, 219, 0.4)',
  borderRadius: radius.pill,
  color: colors.accentBlue,
  fontSize: '10px',
  fontFamily: fonts.sans,
  cursor: 'pointer',
  padding: '2px 8px',
  lineHeight: 1.5,
  whiteSpace: 'nowrap',
}

export default function Timeline({ minimal = false }: { minimal?: boolean } = {}) {
  const status = useSceneStore((s) => s.status)
  const currentFrameIndex = useSceneStore((s) => s.currentFrameIndex)
  const totalFrames = useSceneStore((s) => s.totalFrames)
  const isPlaying = useSceneStore((s) => s.isPlaying)
  const cachedFrames = useSceneStore((s) => s.cachedFrames)
  const cameraCachedFrames = useSceneStore((s) => s.cameraCachedFrames)
  const playbackWindow = useSceneStore((s) => s.playbackWindow)
  const actions = useSceneStore((s) => s.actions)

  // Ghost handles (no active window) appear only while hovering the track —
  // idle affordance without idle noise. Active-window handles always show:
  // they ARE the window's boundary marks.
  const [trackHovered, setTrackHovered] = useState(false)

  const disabled = status !== 'ready'
  const maxFrame = Math.max(totalFrames - 1, 0)

  /** Reflect the current window into the URL so reload/share see what's on screen. */
  const syncWindowParams = useCallback((win: { t0: string; t1: string } | null) => {
    const params = new URLSearchParams(window.location.search)
    if (win) {
      params.set('t0', win.t0)
      params.set('t1', win.t1)
    } else {
      params.delete('t0')
      params.delete('t1')
    }
    const qs = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? '?' + qs : ''}`)
  }, [])

  const clearWindow = useCallback(() => {
    actions.setPlaybackWindow(null)
    syncWindowParams(null)
  }, [actions, syncWindowParams])

  // ── Handle dragging (full-controls mode only) ──
  const trackRef = useRef<HTMLDivElement>(null)
  const dragEdgeRef = useRef<'f0' | 'f1' | null>(null)


  const frameFromClientX = useCallback((clientX: number, max: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    const ratio = (clientX - rect.left) / rect.width
    return Math.round(Math.max(0, Math.min(1, ratio)) * max)
  }, [])

  const dragStartXRef = useRef(0)
  const dragMovedRef = useRef(false)

  const onHandlePointerDown = useCallback((edge: 'f0' | 'f1') => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragEdgeRef.current = edge
    dragStartXRef.current = e.clientX
    dragMovedRef.current = false
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onHandlePointerMove = useCallback((e: React.PointerEvent) => {
    const edge = dragEdgeRef.current
    if (!edge) return
    // Click jitter must not create or move a range — the handles sit exactly
    // where people click to seek to the recording edges. Only a deliberate
    // drag (≥6px) engages.
    if (!dragMovedRef.current && Math.abs(e.clientX - dragStartXRef.current) < 6) return
    dragMovedRef.current = true
    const state = useSceneStore.getState()
    const max = Math.max(state.totalFrames - 1, 0)
    // No window yet: the handles rest at the recording edges, and dragging
    // one inward creates the window (Foxglove idiom)
    const win = state.playbackWindow ?? { f0: 0, f1: max }
    const frame = frameFromClientX(e.clientX, max)
    if (edge === 'f0') {
      const f0 = Math.min(frame, win.f1)
      if (f0 !== state.playbackWindow?.f0) actions.setPlaybackWindowFrames(f0, win.f1)
    } else {
      const f1 = Math.max(frame, win.f0)
      if (f1 !== state.playbackWindow?.f1) actions.setPlaybackWindowFrames(win.f0, f1)
    }
  }, [actions, frameFromClientX])

  const onHandlePointerUp = useCallback(() => {
    if (!dragEdgeRef.current) return
    dragEdgeRef.current = null
    const state = useSceneStore.getState()
    const max = Math.max(state.totalFrames - 1, 0)
    if (!dragMovedRef.current) {
      // A plain click on a handle was almost certainly an edge-seek the
      // handle intercepted — forward it instead of swallowing it
      void state.actions.seekFrame(frameFromClientX(dragStartXRef.current, max))
      return
    }
    const win = state.playbackWindow
    if (win && win.f0 === 0 && win.f1 === max) {
      // Spanning the whole recording is the same as no window
      state.actions.setPlaybackWindow(null)
      syncWindowParams(null)
      return
    }
    syncWindowParams(win)
  }, [syncWindowParams, frameFromClientX])

  // Foxglove's exact trim shortcuts: Cmd/Ctrl+Shift+← snaps the window start
  // to the playhead, Cmd/Ctrl+Shift+→ snaps the end. With no window active,
  // the other bound is the recording edge.
  useEffect(() => {
    if (minimal || disabled) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      const s = useSceneStore.getState()
      if (s.totalFrames === 0) return
      const max = s.totalFrames - 1
      const cur = s.currentFrameIndex
      const win = s.playbackWindow
      if (e.key === 'ArrowLeft') {
        s.actions.setPlaybackWindowFrames(cur, win ? Math.max(win.f1, cur) : max)
      } else {
        s.actions.setPlaybackWindowFrames(win ? Math.min(win.f0, cur) : 0, cur)
      }
      syncWindowParams(useSceneStore.getState().playbackWindow)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [minimal, disabled, syncWindowParams])

  // Annotation frame markers
  const colormapMode = useSceneStore((s) => s.colormapMode)
  const showKeypoints3D = useSceneStore((s) => s.showKeypoints3D)
  const showKeypoints2D = useSceneStore((s) => s.showKeypoints2D)
  const showCameraSeg = useSceneStore((s) => s.showCameraSeg)
  const hasCameraSegmentation = useSceneStore((s) => s.hasCameraSegmentation)
  const segLabelFrames = useSceneStore((s) => s.segLabelFrames)
  const keypointFrames = useSceneStore((s) => s.keypointFrames)
  const cameraKeypointFrames = useSceneStore((s) => s.cameraKeypointFrames)
  const cameraSegFrames = useSceneStore((s) => s.cameraSegFrames)



  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const target = parseInt(e.target.value, 10)
    actions.seekFrame(target)
  }, [actions])

  // Build active annotation lanes (only visible features)
  interface AnnotationLane { key: string; color: string; frames: Set<number> }
  const activeLanes = useMemo(() => {
    const lanes: AnnotationLane[] = []
    if (colormapMode === 'segment' && segLabelFrames.size > 0)
      lanes.push({ key: 'seg', color: '#00CCFF', frames: segLabelFrames })
    if (showKeypoints3D && keypointFrames.size > 0)
      lanes.push({ key: 'kp3d', color: '#CCFF00', frames: keypointFrames })
    if (showKeypoints2D && cameraKeypointFrames.size > 0)
      lanes.push({ key: 'kp2d', color: '#88DDFF', frames: cameraKeypointFrames })
    if (showCameraSeg && hasCameraSegmentation && cameraSegFrames.size > 0)
      lanes.push({ key: 'cseg', color: '#FF44FF', frames: cameraSegFrames })
    return lanes
  }, [colormapMode, segLabelFrames, showKeypoints3D, keypointFrames, showKeypoints2D, cameraKeypointFrames, showCameraSeg, hasCameraSegmentation, cameraSegFrames])

  // Compute buffer bar segments (continuous ranges of cached frames)
  const bufferSegments = useMemo(
    () => computeBufferSegments(cachedFrames, totalFrames),
    [cachedFrames, totalFrames],
  )

  // Camera buffer segments (may lag behind LiDAR)
  const cameraBufferSegments = useMemo(
    () => computeBufferSegments(cameraCachedFrames, totalFrames),
    [cameraCachedFrames, totalFrames],
  )

  // Show camera lane only when camera is loading behind lidar
  const showCameraBuffer = cameraCachedFrames.length > 0 && cameraCachedFrames.length < cachedFrames.length

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '14px', fontSize: '13px' }}>
      <button
        onClick={() => actions.togglePlayback()}
        disabled={disabled || cachedFrames.length === 0}
        style={{
          width: '28px',
          height: '28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'none',
          border: 'none',
          color: (disabled || cachedFrames.length === 0) ? colors.textDim : colors.textPrimary,
          cursor: (disabled || cachedFrames.length === 0) ? 'default' : 'pointer',
          fontSize: '16px',
          borderRadius: radius.sm,
          transition: 'color 0.15s',
        }}
      >
        {isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <rect x="1" y="1" width="4" height="12" rx="1" />
            <rect x="9" y="1" width="4" height="12" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <path d="M2.5 1.2a1 1 0 0 1 1.5-.86l9 5.5a1 1 0 0 1 0 1.72l-9 5.5A1 1 0 0 1 2.5 12.2V1.2z" />
          </svg>
        )}
      </button>

      {/* Custom slider with buffer bar + annotation lanes */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Main track area — outer container keeps full width for hit area */}
        <div onMouseEnter={() => setTrackHovered(true)} onMouseLeave={() => setTrackHovered(false)} style={{ position: 'relative', height: '24px', display: 'flex', alignItems: 'center' }}>
          {/* Inset track container — padded by dot radius so playhead fits at 0% and 100% */}
          <div ref={trackRef} style={{ position: 'absolute', left: 6, right: 6, top: 0, bottom: 0, display: 'flex', alignItems: 'center' }}>
            {/* Track background */}
            <div style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: '6px',
              backgroundColor: colors.bgOverlay,
              borderRadius: radius.pill,
              pointerEvents: 'none',
            }} />

            {/* Buffer segments — loaded frames */}
            {bufferSegments.map((seg, i) => {
              const left = maxFrame > 0 ? (seg.start / maxFrame) * 100 : 0
              const width = maxFrame > 0 ? ((seg.end - seg.start + 1) / maxFrame) * 100 : 0
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: `${left}%`,
                    width: `${Math.min(width, 100 - left)}%`,
                    height: '6px',
                    backgroundColor: colors.accentDim,
                    borderRadius: radius.pill,
                    pointerEvents: 'none',
                  }}
                />
              )
            })}

            {/* Played progress (gradient bar) */}
            <div style={{
              position: 'absolute',
              left: 0,
              width: `${maxFrame > 0 ? (currentFrameIndex / maxFrame) * 100 : 0}%`,
              height: '6px',
              background: gradients.accent,
              borderRadius: radius.pill,
              pointerEvents: 'none',
              boxShadow: `0 0 8px ${colors.accentGlow}`,
            }} />

            {/* Playhead dot — at 0% center is at left edge, at 100% center is at right edge */}
            {maxFrame > 0 && (
              <div style={{
                position: 'absolute',
                left: `${(currentFrameIndex / maxFrame) * 100}%`,
                top: '50%',
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                backgroundColor: colors.accent,
                transform: 'translate(-50%, -50%)',
                boxShadow: `0 0 6px ${colors.accentDim}`,
                pointerEvents: 'none',
              }} />
            )}

            {/* Time window — dim everything outside [f0, f1]; the window keeps
                the track's own colors (Perfetto/DevTools brush idiom) */}
            {playbackWindow && maxFrame > 0 && (() => {
              const leftPct = (playbackWindow.f0 / maxFrame) * 100
              const rightPct = (playbackWindow.f1 / maxFrame) * 100
              return (
                <>
                  {playbackWindow.f0 > 0 && (
                    <div style={{
                      position: 'absolute',
                      left: 0,
                      width: `${leftPct}%`,
                      height: '16px',
                      backgroundColor: 'rgba(10, 13, 26, 0.72)',
                      borderRadius: `${radius.pill} 0 0 ${radius.pill}`,
                      pointerEvents: 'none',
                    }} />
                  )}
                  {playbackWindow.f1 < maxFrame && (
                    <div style={{
                      position: 'absolute',
                      left: `${rightPct}%`,
                      right: 0,
                      height: '16px',
                      backgroundColor: 'rgba(10, 13, 26, 0.72)',
                      borderRadius: `0 ${radius.pill} ${radius.pill} 0`,
                      pointerEvents: 'none',
                    }} />
                  )}
                  {minimal && (
                    // Minimal/embed: boundary ticks only — the window is host-controlled
                    <>
                      <div style={{ position: 'absolute', left: `${leftPct}%`, width: '1.5px', height: '16px', backgroundColor: colors.accentBlue, transform: 'translateX(-50%)', pointerEvents: 'none' }} />
                      <div style={{ position: 'absolute', left: `${rightPct}%`, width: '1.5px', height: '16px', backgroundColor: colors.accentBlue, transform: 'translateX(-50%)', pointerEvents: 'none' }} />
                    </>
                  )}
                </>
              )
            })()}

            {/* In/out handles — always present in full-controls mode. With no
                window they rest at the recording edges; dragging one inward
                creates the window (Foxglove idiom). */}
            {!minimal && !disabled && maxFrame > 0 && (
              <>
                <div
                  onPointerDown={onHandlePointerDown('f0')}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  title={playbackWindow ? 'Window start — drag to adjust' : 'Drag inward to set a playback window'}
                  style={{
                    position: 'absolute',
                    left: `${((playbackWindow?.f0 ?? 0) / maxFrame) * 100}%`,
                    width: '6px',
                    height: '18px',
                    backgroundColor: playbackWindow ? colors.accentBlue : 'rgba(0, 201, 219, 0.45)',
                    borderRadius: '2px',
                    transform: 'translateX(-50%)',
                    cursor: 'ew-resize',
                    zIndex: 2,
                    touchAction: 'none',
                    opacity: playbackWindow || trackHovered ? 1 : 0,
                    pointerEvents: playbackWindow || trackHovered ? 'auto' : 'none',
                    transition: 'opacity 0.15s',
                  }}
                />
                <div
                  onPointerDown={onHandlePointerDown('f1')}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  title={playbackWindow ? 'Window end — drag to adjust' : 'Drag inward to set a playback window'}
                  style={{
                    position: 'absolute',
                    left: `${((playbackWindow?.f1 ?? maxFrame) / maxFrame) * 100}%`,
                    width: '6px',
                    height: '18px',
                    backgroundColor: playbackWindow ? colors.accentBlue : 'rgba(0, 201, 219, 0.45)',
                    borderRadius: '2px',
                    transform: 'translateX(-50%)',
                    cursor: 'ew-resize',
                    zIndex: 2,
                    touchAction: 'none',
                    opacity: playbackWindow || trackHovered ? 1 : 0,
                    pointerEvents: playbackWindow || trackHovered ? 'auto' : 'none',
                    transition: 'opacity 0.15s',
                  }}
                />
              </>
            )}
          </div>

          {/* Invisible range input — matches inset track area */}
          <input
            type="range"
            min={0}
            max={maxFrame}
            value={currentFrameIndex}
            onChange={handleSliderChange}
            disabled={disabled}
            style={{
              position: 'absolute',
              left: 6,
              right: 6,
              width: 'calc(100% - 12px)',
              height: '24px',
              opacity: 0,
              cursor: disabled ? 'default' : 'pointer',
              margin: 0,
              WebkitAppearance: 'none',
              appearance: 'none' as React.CSSProperties['appearance'],
            }}
          />
        </div>

        {/* Camera buffer lane — shown while camera loading lags behind LiDAR */}
        {!minimal && showCameraBuffer && (
          <div style={{ position: 'relative', height: '3px', marginTop: '2px', marginLeft: 6, marginRight: 6 }}>
            {cameraBufferSegments.map((seg, i) => {
              const left = maxFrame > 0 ? (seg.start / maxFrame) * 100 : 0
              const width = maxFrame > 0 ? ((seg.end - seg.start + 1) / maxFrame) * 100 : 0
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: `${left}%`,
                    width: `${Math.min(width, 100 - left)}%`,
                    height: '3px',
                    backgroundColor: '#FF9E00',
                    opacity: 0.6,
                    borderRadius: '1px',
                    pointerEvents: 'none',
                  }}
                />
              )
            })}
          </div>
        )}

        {/* Annotation lanes — each active feature gets its own thin lane (hidden in minimal mode) */}
        {!minimal && activeLanes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', paddingTop: '2px', marginLeft: 6, marginRight: 6 }}>
            {activeLanes.map(({ key, color, frames }) => (
              <div key={key} style={{ position: 'relative', height: '3px' }}>
                {maxFrame > 0 && [...frames].map((fi) => (
                  <div
                    key={fi}
                    style={{
                      position: 'absolute',
                      left: `${(fi / maxFrame) * 100}%`,
                      width: '2px',
                      height: '3px',
                      backgroundColor: color,
                      opacity: 0.85,
                      pointerEvents: 'none',
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Floating overlay — takes no layout space, so its appearance can
          never reflow the track under a mid-drag cursor, and costs nothing
          when idle */}
      {playbackWindow && !minimal && (
        <button
          onClick={clearWindow}
          title="Reset playback range — play the full recording"
          style={{
            ...windowChipButtonStyle,
            position: 'absolute',
            right: 0,
            top: '-26px',
            backgroundColor: 'rgba(15, 19, 38, 0.85)',
            backdropFilter: 'blur(4px)',
          }}
        >
          range <span aria-hidden="true">✕</span>
        </button>
      )}

      <span style={{
        fontFamily: fonts.mono,
        fontSize: '11px',
        color: colors.textSecondary,
        minWidth: '64px',
        textAlign: 'right',
      }}>
        {currentFrameIndex + 1} / {totalFrames}
      </span>
    </div>
  )
}
