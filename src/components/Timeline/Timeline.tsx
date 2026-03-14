/**
 * Timeline — frame scrubber with play/pause, buffer bar, and playhead.
 *
 * Shows a YouTube-style buffer bar indicating which frames are loaded,
 * a gradient progress bar for the current position, and a draggable scrubber.
 *
 * Extracted from App.tsx for maintainability — this component will grow
 * with annotation frame markers (segmentation, keypoints).
 */

import { useCallback, useMemo } from 'react'
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

export default function Timeline() {
  const status = useSceneStore((s) => s.status)
  const currentFrameIndex = useSceneStore((s) => s.currentFrameIndex)
  const totalFrames = useSceneStore((s) => s.totalFrames)
  const isPlaying = useSceneStore((s) => s.isPlaying)
  const cachedFrames = useSceneStore((s) => s.cachedFrames)
  const actions = useSceneStore((s) => s.actions)

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

  const disabled = status !== 'ready'
  const maxFrame = Math.max(totalFrames - 1, 0)

  // Clamp slider to the highest cached frame — prevent jumping to unloaded area
  const maxCached = cachedFrames.length > 0 ? cachedFrames[cachedFrames.length - 1] : 0

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const target = parseInt(e.target.value, 10)
    if (target <= maxCached) {
      actions.seekFrame(target)
    }
  }, [actions, maxCached])

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

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '13px' }}>
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
        {isPlaying ? '⏸' : '▶'}
      </button>

      {/* Custom slider with buffer bar + annotation lanes */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* Main track area */}
        <div style={{ position: 'relative', height: '24px', display: 'flex', alignItems: 'center' }}>
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
            const left = (seg.start / maxFrame) * 100
            const width = ((seg.end - seg.start + 1) / maxFrame) * 100
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${left}%`,
                  width: `${width}%`,
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

          {/* Playhead dot */}
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

          {/* Invisible range input on top */}
          <input
            type="range"
            min={0}
            max={maxCached}
            value={currentFrameIndex}
            onChange={handleSliderChange}
            disabled={disabled}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              width: '100%',
              height: '24px',
              opacity: 0,
              cursor: disabled ? 'default' : 'pointer',
              margin: 0,
            }}
          />
        </div>

        {/* Annotation lanes — each active feature gets its own thin lane */}
        {activeLanes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', paddingTop: '2px' }}>
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

      <span style={{
        fontFamily: fonts.mono,
        fontSize: '11px',
        color: colors.textSecondary,
        minWidth: '64px',
        textAlign: 'right',
      }}>
        {currentFrameIndex} / {maxFrame}
      </span>
    </div>
  )
}
