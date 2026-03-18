import { useState, useEffect, useCallback, useRef } from 'react'
import { useSceneStore } from './stores/useSceneStore'
import LidarViewer from './components/LidarViewer/LidarViewer'
import CameraPanel from './components/CameraPanel/CameraPanel'
import Timeline from './components/Timeline/Timeline'
import { colors, fonts, radius, gradients } from './theme'
import { LOCATION_LABELS } from './types/waymo'
import { getManifest } from './adapters/registry'
import { scanDataTransfer, pickAndScanFolder, hasDirectoryPicker } from './utils/folderScan'
import { normalizeBaseUrl } from './utils/urlValidation'
import { buildShareUrl, parseViewParams, hasUrlSource, getUrlSource, getInitialSearch, clearUrlSource, type ShareableState } from './utils/urlState'
import { getCameraPose, setPendingCameraPose } from './components/LidarViewer/LidarViewer'
import { trackDatasetLoad, trackShareView, trackPresetClick } from './utils/analytics'
import { getEmbedParams, type EmbedParams } from './utils/embedParams'
import { initEmbedApi } from './utils/embedApi'
import MemoryOverlay from './components/MemoryOverlay'
import SearchableSelect, { type SelectItem } from './components/SearchableSelect'


// ---------------------------------------------------------------------------
// Segment discovery: fetch available segments from Vite API, auto-load if 1
// ---------------------------------------------------------------------------

/** Guard against double-invocation from React StrictMode */
let discoveryStarted = false

function useSegmentDiscovery() {
  const availableSegments = useSceneStore((s) => s.availableSegments)
  const actions = useSceneStore((s) => s.actions)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (availableSegments.length > 0) return // already discovered
    if (discoveryStarted) return
    discoveryStarted = true

    fetch('/api/segments')
      .then((r) => r.json())
      .then(({ segments }: { segments: string[] }) => {
        if (segments.length === 0) return
        actions.setAvailableSegments(segments)

        // Auto-load first segment
        actions.selectSegment(segments[0])
      })
      .catch(() => {
        discoveryStarted = false
      })
  }, [availableSegments.length, actions])
}

// ---------------------------------------------------------------------------
// URL parameter auto-load: ?dataset=argoverse2&data=https://...
// Also handles embed mode: ?embed=true&dataset=...&data=...
// ---------------------------------------------------------------------------

const SUPPORTED_URL_DATASETS = ['argoverse2', 'nuscenes', 'waymo'] as const
type UrlDataset = typeof SUPPORTED_URL_DATASETS[number]

/** Guard against double-invocation from React StrictMode */
let urlAutoLoadStarted = false

function useUrlAutoLoad() {
  const status = useSceneStore((s) => s.status)
  const loadFromUrl = useSceneStore((s) => s.actions.loadFromUrl)

  useEffect(() => {
    if (urlAutoLoadStarted) return
    if (status !== 'idle') return

    const params = new URLSearchParams(window.location.search)
    const dataset = params.get('dataset')
    const dataUrl = params.get('data')
    const scene = params.get('scene') || undefined

    if (!dataset || !dataUrl) return
    if (!SUPPORTED_URL_DATASETS.includes(dataset as UrlDataset)) return

    urlAutoLoadStarted = true

    try {
      const baseUrl = normalizeBaseUrl(dataUrl)
      const hasView = new URLSearchParams(window.location.search).has('frame')
      trackDatasetLoad(dataset, hasView ? 'url' : 'preset')
      loadFromUrl(dataset, baseUrl, scene)
    } catch {
      // Invalid URL — silently ignore, user will see the landing page
      urlAutoLoadStarted = false
    }
  }, [status, loadFromUrl])
}

// ---------------------------------------------------------------------------
// URL view restore: apply shared view state params once data is ready
// ---------------------------------------------------------------------------

/** Guard against double-invocation */
let urlViewRestoreApplied = false

function useUrlViewRestore() {
  const status = useSceneStore((s) => s.status)

  useEffect(() => {
    if (urlViewRestoreApplied) return
    if (status !== 'ready') return

    // Use initial search (captured before replaceState overwrites view params)
    const viewParams = parseViewParams(getInitialSearch() ?? undefined)
    // Only restore if there are view params beyond dataset/data/scene
    if (Object.keys(viewParams).length === 0) return

    urlViewRestoreApplied = true
    const actions = useSceneStore.getState().actions
    const state = useSceneStore.getState()

    if (viewParams.frame != null) {
      const f = Math.min(viewParams.frame, state.totalFrames - 1)
      actions.seekFrame(f)
    }
    if (viewParams.colormap) {
      actions.setColormapMode(viewParams.colormap as typeof state.colormapMode)
    }
    if (viewParams.boxMode) {
      actions.setBoxMode(viewParams.boxMode as typeof state.boxMode)
    }
    if (viewParams.worldMode === false && state.worldMode) {
      actions.toggleWorldMode()
    }
    if (viewParams.sensors) {
      // Set exact sensor selection by toggling off all, then toggling on specified ones
      const allSensorIds = new Set(state.visibleSensors)
      const targetIds = new Set(viewParams.sensors)
      for (const id of allSensorIds) {
        if (!targetIds.has(id)) actions.toggleSensor(id)
      }
      for (const id of targetIds) {
        if (!allSensorIds.has(id)) actions.toggleSensor(id)
      }
    }
    if (viewParams.pointSize != null) actions.setPointSize(viewParams.pointSize)
    if (viewParams.pointOpacity != null) actions.setPointOpacity(viewParams.pointOpacity)
    if (viewParams.activeCam != null) actions.setActiveCam(viewParams.activeCam)
    if (viewParams.trailLength != null) actions.setTrailLength(viewParams.trailLength)
    if (viewParams.lidarOverlay && !state.showLidarOverlay) actions.toggleLidarOverlay()
    if (viewParams.keypoints3D && !state.showKeypoints3D) actions.toggleKeypoints3D()
    if (viewParams.keypoints2D && !state.showKeypoints2D) actions.toggleKeypoints2D()
    if (viewParams.cameraSeg && !state.showCameraSeg) actions.toggleCameraSeg()
    if (viewParams.speed != null) actions.setPlaybackSpeed(viewParams.speed)
    if (viewParams.followCam === false) actions.setFollowCam(false)
    if (viewParams.cameraPos && viewParams.cameraTarget) {
      setPendingCameraPose(viewParams.cameraPos, viewParams.cameraTarget, viewParams.cameraAzimuth, viewParams.cameraDistance)
    }
  }, [status])
}

// ---------------------------------------------------------------------------
// Embed mode: apply initial params once data is ready
// ---------------------------------------------------------------------------

function useEmbedInitialState(embedParams: EmbedParams) {
  const status = useSceneStore((s) => s.status)
  const appliedRef = useRef(false)

  useEffect(() => {
    if (!embedParams.embed || status !== 'ready' || appliedRef.current) return
    appliedRef.current = true

    const actions = useSceneStore.getState().actions

    // Apply initial frame
    if (embedParams.frame !== null) {
      const { totalFrames } = useSceneStore.getState()
      const f = Math.min(embedParams.frame, totalFrames - 1)
      actions.seekFrame(f)
    }

    // Apply colormap
    if (embedParams.colormap) {
      actions.setColormapMode(embedParams.colormap)
    }

    // Apply autoplay
    if (embedParams.autoplay) {
      actions.togglePlayback()
    }
  }, [embedParams, status])
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [embedParams] = useState(() => getEmbedParams())
  useSegmentDiscovery()
  useUrlAutoLoad()
  useUrlViewRestore()
  useEmbedInitialState(embedParams)

  // Initialize embed postMessage API when in embed mode
  useEffect(() => {
    if (!embedParams.embed) return
    const cleanup = initEmbedApi(embedParams)
    return cleanup
  }, [embedParams])

  // Browser back button: return to landing page when navigating back
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search)
      if (!params.has('data')) {
        // No data param = landing page — full reset including segments
        const store = useSceneStore.getState()
        store.actions.reset()
        // reset() preserves segments for segment switching — clear them for landing
        useSceneStore.setState({
          availableSegments: [],
          currentSegment: null,
          segmentMetas: new Map(),
        })
        clearUrlSource()
        // Reset guards so forward-navigation can re-trigger auto-load
        urlAutoLoadStarted = false
        urlViewRestoreApplied = false
      } else {
        // Forward navigation — URL has data params, re-trigger load
        const { status: st } = useSceneStore.getState()
        if (st === 'idle' || st === 'ready') {
          // Reset state + guards, then re-load from URL
          if (st === 'ready') {
            const store = useSceneStore.getState()
            store.actions.reset()
            useSceneStore.setState({
              availableSegments: [],
              currentSegment: null,
              segmentMetas: new Map(),
            })
          }
          urlAutoLoadStarted = false
          urlViewRestoreApplied = false
          const dataset = params.get('dataset')!
          const dataUrl = params.get('data')!
          const scene = params.get('scene') || undefined
          if (SUPPORTED_URL_DATASETS.includes(dataset as UrlDataset)) {
            urlAutoLoadStarted = true
            try {
              const baseUrl = normalizeBaseUrl(dataUrl)
              useSceneStore.getState().actions.loadFromUrl(dataset, baseUrl, scene)
            } catch {
              urlAutoLoadStarted = false
            }
          }
        }
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  const status = useSceneStore((s) => s.status)
  const availableSegments = useSceneStore((s) => s.availableSegments)
  const togglePlayback = useSceneStore((s) => s.actions.togglePlayback)
  const loadFromFiles = useSceneStore((s) => s.actions.loadFromFiles)

  const seekFrame = useSceneStore((s) => s.actions.seekFrame)
  const nextFrame = useSceneStore((s) => s.actions.nextFrame)
  const prevFrame = useSceneStore((s) => s.actions.prevFrame)

  const selectSegment = useSceneStore((s) => s.actions.selectSegment)

  // Global keyboard shortcuts:
  //   Space        = play/pause
  //   ← →          = ±1 frame
  //   J / L        = ±10 frames
  //   Shift+← / →  = prev/next segment
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const tag = el?.tagName
      // Block shortcuts only for text-like inputs; allow range/checkbox/radio
      if (tag === 'TEXTAREA' || tag === 'SELECT') return
      if (tag === 'INPUT' && (el as HTMLInputElement).type !== 'range') return
      // Blur focused buttons so Space doesn't re-click them
      if (tag === 'BUTTON') (el as HTMLButtonElement).blur()

      // Shift+Arrow: segment navigation (works even during loading)
      if (e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault()
        const { availableSegments: segs, currentSegment: cur, status: st } = useSceneStore.getState()
        if (st === 'loading' || !cur || segs.length <= 1) return
        const idx = segs.indexOf(cur)
        if (e.code === 'ArrowLeft' && idx > 0) selectSegment(segs[idx - 1])
        if (e.code === 'ArrowRight' && idx < segs.length - 1) selectSegment(segs[idx + 1])
        return
      }

      if (status !== 'ready') return

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          togglePlayback()
          break
        case 'ArrowRight':
          e.preventDefault()
          nextFrame()
          break
        case 'ArrowLeft':
          e.preventDefault()
          prevFrame()
          break
        case 'KeyL': {
          e.preventDefault()
          const { currentFrameIndex, totalFrames } = useSceneStore.getState()
          seekFrame(Math.min(currentFrameIndex + 10, totalFrames - 1))
          break
        }
        case 'KeyJ': {
          e.preventDefault()
          const { currentFrameIndex } = useSceneStore.getState()
          seekFrame(Math.max(currentFrameIndex - 10, 0))
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, togglePlayback, nextFrame, prevFrame, seekFrame, selectSegment])

  // Show drop zone when no data loaded (idle + no segments)
  const showDropZone = status === 'idle' && availableSegments.length === 0
  const isEmbed = embedParams.embed
  const showTimeline = !showDropZone && (!isEmbed || embedParams.controls !== 'none')

  // Embed mode: custom background color
  const bgColor = isEmbed && embedParams.bgcolor
    ? `#${embedParams.bgcolor}`
    : colors.bgBase

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: bgColor,
      color: colors.textPrimary,
      fontFamily: fonts.sans,
      overflow: 'hidden',
    }}>
      {/* Memory debug overlay (enable: localStorage.setItem('waymo-memory-log','true') or press M) */}
      {!isEmbed && <MemoryOverlay />}

      {/* Header — hidden in embed mode */}
      {!isEmbed && <Header />}

      {/* Main Content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        {showDropZone && !isEmbed ? (
          <DropZone onFilesLoaded={loadFromFiles} />
        ) : (
          <SensorView embedControls={isEmbed ? embedParams.controls : 'full'} />
        )}
      </main>

      {/* Timeline — hidden in embed controls=none */}
      {showTimeline && (
        <footer style={{
          padding: isEmbed && embedParams.controls === 'minimal' ? '6px 12px' : '10px 20px',
          background: colors.bgSurface,
          borderTop: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}>
          <Timeline minimal={isEmbed && embedParams.controls === 'minimal'} />
        </footer>
      )}

      {/* Credit bar — hidden in embed mode */}
      {!isEmbed && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          padding: '4px 0',
          fontSize: '10px',
          fontFamily: fonts.sans,
          color: colors.textDim,
          background: colors.bgDeep,
          borderTop: `1px solid ${colors.borderSubtle}`,
          flexShrink: 0,
        }}>
          <span>
            Built by{' '}
            <a href="https://happyhj.github.io/" target="_blank" rel="noopener noreferrer"
              style={{ color: colors.textSecondary, textDecoration: 'none', transition: 'color 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = colors.textPrimary }}
              onMouseLeave={(e) => { e.currentTarget.style.color = colors.textSecondary }}
            >Heejae Kim</a>
          </span>
          <span style={{ opacity: 0.4 }}>·</span>
          <a href="https://www.linkedin.com/in/heejaekm/" target="_blank" rel="noopener noreferrer"
            style={{ color: colors.textDim, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3, transition: 'color 0.15s' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = colors.textSecondary }}
            onMouseLeave={(e) => { e.currentTarget.style.color = colors.textDim }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
            LinkedIn
          </a>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header() {
  const status = useSceneStore((s) => s.status)

  const availableSegments = useSceneStore((s) => s.availableSegments)
  const currentSegment = useSceneStore((s) => s.currentSegment)
  const segmentMetas = useSceneStore((s) => s.segmentMetas)
  const actions = useSceneStore((s) => s.actions)
  const [shareCopied, setShareCopied] = useState<string | false>(false)

  // Sync document title with active dataset + segment
  useEffect(() => {
    if (status === 'ready' && currentSegment) {
      const datasetName = getManifest().name
      const shortSeg = currentSegment.length > 20
        ? `${currentSegment.slice(0, 8)}…${currentSegment.slice(-8)}`
        : currentSegment
      document.title = `${shortSeg} — ${datasetName} · EgoLens`
    } else {
      document.title = 'EgoLens'
    }
  }, [status, currentSegment])

  const handleShare = useCallback(() => {
    const s = useSceneStore.getState()
    const src = getUrlSource()
    const cam = getCameraPose()
    const state: ShareableState = {
      dataset: src?.dataset,
      baseUrl: src?.baseUrl,
      scene: s.currentSegment ?? undefined,
      frame: s.currentFrameIndex,
      colormap: s.colormapMode,
      boxMode: s.boxMode,
      worldMode: s.worldMode,
      sensors: [...s.visibleSensors],
      pointSize: s.pointSize,
      pointOpacity: s.pointOpacity,
      activeCam: s.activeCam,
      trailLength: s.trailLength,
      lidarOverlay: s.showLidarOverlay,
      keypoints3D: s.showKeypoints3D,
      keypoints2D: s.showKeypoints2D,
      cameraSeg: s.showCameraSeg,
      speed: s.playbackSpeed,
      followCam: s.followCam,
      cameraPos: cam.position,
      cameraTarget: cam.target,
      cameraAzimuth: cam.azimuth,
      cameraDistance: cam.distance || undefined,
    }
    const url = buildShareUrl(state)

    // Build a human-readable summary of what's captured
    const parts: string[] = [`Frame ${s.currentFrameIndex}`, s.colormapMode]
    const overlayCount = [s.showLidarOverlay, s.showKeypoints3D, s.showKeypoints2D, s.showCameraSeg].filter(Boolean).length
    if (overlayCount > 0) parts.push(`${overlayCount} overlay${overlayCount > 1 ? 's' : ''}`)
    if (s.activeCam != null) parts.push('POV cam')
    const summary = parts.join(' · ')

    trackShareView(src?.dataset ?? 'unknown')
    navigator.clipboard.writeText(url).then(() => {
      setShareCopied(summary)
      setTimeout(() => setShareCopied(false), 3000)
    })
  }, [])

  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 24px',
      background: colors.bgSurface,
      borderBottom: `1px solid ${colors.border}`,
      flexShrink: 0,
      gap: '16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <h1
          style={{
            margin: 0,
            fontSize: '15px',
            fontWeight: 600,
            fontFamily: fonts.sans,
            letterSpacing: '-0.01em',
            color: colors.textPrimary,
            display: 'flex',
            alignItems: 'baseline',
            gap: '6px',
          }}
        >
          <span
            onClick={() => { window.location.href = window.location.pathname }}
            style={{ cursor: 'pointer' }}
            title="Back to home"
          >EgoLens</span>
          {status === 'ready' && <span style={{ fontWeight: 400, opacity: 0.4, fontSize: '12px' }}>{getManifest().name}</span>}
        </h1>
      </div>

      {/* Segment selector — only shown when multiple segments available */}
      {availableSegments.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <button
          onClick={() => {
            const idx = availableSegments.indexOf(currentSegment ?? '')
            if (idx > 0) actions.selectSegment(availableSegments[idx - 1])
          }}
          disabled={status === 'loading' || !currentSegment || availableSegments.indexOf(currentSegment) <= 0}
          style={{
            padding: '4px 6px',
            fontSize: '12px',
            backgroundColor: 'transparent',
            color: colors.textSecondary,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.sm,
            cursor: status === 'loading' ? 'not-allowed' : 'pointer',
            opacity: (!currentSegment || availableSegments.indexOf(currentSegment) <= 0) ? 0.3 : 1,
            lineHeight: 1,
          }}
          title="Previous segment"
        >&#9664;</button>
        <SearchableSelect
          items={availableSegments.map((seg, i): SelectItem => {
            const meta = segmentMetas.get(seg)
            // Show full ID always — SearchableSelect handles overflow with ellipsis
            const displayId = seg
            const parts = [`#${i + 1}`, displayId]
            if (meta) {
              const loc = LOCATION_LABELS[meta.location] ?? meta.location
              if (loc) parts.push(loc)
              if (meta.timeOfDay) parts.push(meta.timeOfDay)
            }
            return { value: seg, label: parts.join(' · ') }
          })}
          value={currentSegment}
          onChange={(val) => actions.selectSegment(val)}
          disabled={status === 'loading'}
          placeholder="-- select segment --"
          title={currentSegment ?? undefined}
        />
        <button
          onClick={() => {
            const idx = availableSegments.indexOf(currentSegment ?? '')
            if (idx >= 0 && idx < availableSegments.length - 1) actions.selectSegment(availableSegments[idx + 1])
          }}
          disabled={status === 'loading' || !currentSegment || availableSegments.indexOf(currentSegment) >= availableSegments.length - 1}
          style={{
            padding: '4px 6px',
            fontSize: '12px',
            backgroundColor: 'transparent',
            color: colors.textSecondary,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.sm,
            cursor: status === 'loading' ? 'not-allowed' : 'pointer',
            opacity: (!currentSegment || availableSegments.indexOf(currentSegment) >= availableSegments.length - 1) ? 0.3 : 1,
            lineHeight: 1,
          }}
          title="Next segment"
        >&#9654;</button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Share View button — only in URL mode (local files can't be shared) */}
        {status === 'ready' && hasUrlSource() && (
          <button
            onClick={handleShare}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              padding: '4px 10px',
              fontSize: '11px',
              fontFamily: fonts.sans,
              color: shareCopied ? colors.accent : colors.textDim,
              backgroundColor: 'transparent',
              border: `1px solid ${shareCopied ? colors.accent : colors.border}`,
              borderRadius: radius.sm,
              cursor: 'pointer',
              transition: 'color 0.15s, border-color 0.15s',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              if (!shareCopied) {
                e.currentTarget.style.color = colors.textSecondary
                e.currentTarget.style.borderColor = colors.textDim
              }
            }}
            onMouseLeave={(e) => {
              if (!shareCopied) {
                e.currentTarget.style.color = colors.textDim
                e.currentTarget.style.borderColor = colors.border
              }
            }}
            title="Copy link with current view state (frame, colormap, overlays, sensors…)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            {shareCopied ? `Copied — ${shareCopied}` : 'Share View'}
          </button>
        )}
        <a
          href="https://github.com/egolens/egolens"
          target="_blank"
          rel="noopener noreferrer"
          title="Star on GitHub"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            fontSize: '11px',
            fontFamily: fonts.sans,
            fontWeight: 500,
            color: colors.textDim,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.sm,
            textDecoration: 'none',
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#FFD43B'; e.currentTarget.style.borderColor = 'rgba(255, 212, 59, 0.4)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = colors.textDim; e.currentTarget.style.borderColor = colors.border }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#FFD43B" stroke="#FFD43B" strokeWidth="1">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          Star on GitHub
        </a>
      </div>
    </header>
  )
}


// ---------------------------------------------------------------------------
// Drop Zone — shown when no data is loaded
// ---------------------------------------------------------------------------

function DropZone({ onFilesLoaded }: { onFilesLoaded: (segments: Map<string, Map<string, File>>) => Promise<void> }) {
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const dragCounter = useRef(0)

  // URL loading state
  const [urlDataset, setUrlDataset] = useState<string>('argoverse2')
  const [urlInput, setUrlInput] = useState('')
  const [urlSegment, setUrlSegment] = useState('')
  const [urlLoading, setUrlLoading] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)
  const loadFromUrl = useSceneStore((s) => s.actions.loadFromUrl)

  const handleFiles = useCallback(async (segments: Map<string, Map<string, File>>) => {
    if (segments.size === 0) {
      setError('No dataset found. Drop a Waymo, nuScenes, or Argoverse 2 dataset folder.')
      setScanning(false)
      return
    }
    // nuScenes sentinel key — pass directly (store handles validation)
    if (segments.has('__nuscenes__')) {
      setError(null)
      await onFilesLoaded(segments)
      return
    }
    // Argoverse 2 sentinel key — pass directly (store handles validation)
    if (segments.has('__argoverse2__')) {
      setError(null)
      await onFilesLoaded(segments)
      return
    }
    // Waymo: check that at least one segment has vehicle_pose (required)
    const valid = [...segments.entries()].filter(([, m]) => m.has('vehicle_pose'))
    if (valid.length === 0) {
      setError('No valid segments found. Each segment needs at least a vehicle_pose parquet file.')
      setScanning(false)
      return
    }
    setError(null)
    await onFilesLoaded(new Map(valid))
  }, [onFilesLoaded])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    dragCounter.current = 0
    setScanning(true)
    setError(null)
    try {
      const segments = await scanDataTransfer(e.dataTransfer.items)
      await handleFiles(segments)
    } catch (err) {
      setError(`Failed to scan folder: ${err instanceof Error ? err.message : String(err)}`)
      setScanning(false)
    }
  }, [handleFiles])

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    setDragging(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current <= 0) {
      setDragging(false)
      dragCounter.current = 0
    }
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const onPickFolder = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      const segments = await pickAndScanFolder()
      await handleFiles(segments)
    } catch (err) {
      // User cancelled picker — not an error
      if (err instanceof DOMException && err.name === 'AbortError') {
        setScanning(false)
        return
      }
      setError(`Failed to scan folder: ${err instanceof Error ? err.message : String(err)}`)
      setScanning(false)
    }
  }, [handleFiles])

  return (
    <div
      className="dropzone-scroll"
      onDrop={onDrop}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'safe center',
        gap: '24px',
        padding: '40px',
        overflow: 'auto',
        transition: 'background-color 0.2s',
        backgroundColor: dragging ? 'rgba(0, 232, 157, 0.05)' : 'transparent',
      }}
    >
      <style>{`
        .dropzone-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
        .dropzone-scroll::-webkit-scrollbar-track { background: transparent; }
        .dropzone-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        .dropzone-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        .dropzone-scroll { scrollbar-color: rgba(255,255,255,0.15) transparent; scrollbar-width: thin; }
      `}</style>
      {/* Safari warning */}
      {/^((?!chrome|android).)*safari/i.test(navigator.userAgent) && (
        <div style={{
          maxWidth: '520px',
          width: '100%',
          padding: '8px 14px',
          fontSize: '11px',
          fontFamily: fonts.sans,
          color: '#FFB347',
          backgroundColor: 'rgba(255, 179, 71, 0.08)',
          border: '1px solid rgba(255, 179, 71, 0.2)',
          borderRadius: radius.sm,
          textAlign: 'center',
          lineHeight: 1.5,
        }}>
          Safari may crash on large datasets due to memory limits. <strong>Chrome or Edge</strong> is recommended.
        </div>
      )}

      {/* Intro */}
      <div style={{
        maxWidth: '520px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        <div style={{
          fontSize: '20px',
          fontWeight: 700,
          fontFamily: fonts.sans,
          color: colors.textPrimary,
        }}>
          EgoLens
        </div>
        <div style={{
          fontSize: '13px',
          fontFamily: fonts.sans,
          color: colors.textSecondary,
          lineHeight: 1.7,
        }}>
          Visualize point clouds, cameras, and 3D annotations in your browser<br />
          — straight from the most widely used autonomous driving datasets.<br />
          No conversion, no preprocessing.
        </div>
        {/* Dataset badges — outlined, info only */}
        <div style={{
          display: 'flex',
          gap: '8px',
          alignSelf: 'center',
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}>
          {[
            { label: 'Waymo v2', color: '#4285F4', href: 'https://waymo.com/open/download/' },
            { label: 'nuScenes', color: '#00B4D8', href: 'https://www.nuscenes.org/' },
            { label: 'Argoverse 2', color: '#FF6F00', href: 'https://www.argoverse.org/av2.html' },
          ].map(({ label, color, href }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                padding: '3px 10px',
                fontSize: '11px',
                fontFamily: fonts.sans,
                fontWeight: 600,
                color: color,
                backgroundColor: 'transparent',
                border: `1px solid ${color}`,
                borderRadius: '4px',
                textDecoration: 'none',
                letterSpacing: '0.02em',
                opacity: 0.7,
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7' }}
            >
              {label}
            </a>
          ))}
        </div>

        {/* Quick start — try with hosted data */}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '8px' }}>
          {([
            { dataset: 'nuscenes', label: 'Try nuScenes mini', url: 'https://data.egolens.org/nuscenes/', note: 'Hosted by EgoLens · 10 scenes' },
            { dataset: 'argoverse2', label: 'Try Argoverse 2', url: 'https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/val/', note: 'Via Argoverse S3 · validation split' },
          ] as const).map((preset) => {
            const isActive = urlDataset === preset.dataset && urlInput === preset.url
            return (
              <button
                key={preset.dataset}
                onClick={() => {
                  trackPresetClick(preset.dataset)
                  setUrlDataset(preset.dataset)
                  setUrlInput(preset.url)
                  setUrlSegment('')
                  setUrlError(null)
                }}
                disabled={urlLoading}
                title={preset.note}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '2px',
                  padding: '10px 20px',
                  fontSize: '13px',
                  fontFamily: fonts.sans,
                  fontWeight: 600,
                  color: isActive ? '#000' : colors.textPrimary,
                  backgroundColor: isActive ? colors.accent : colors.bgOverlay,
                  border: `1px solid ${isActive ? colors.accent : colors.border}`,
                  borderRadius: radius.md,
                  cursor: urlLoading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s',
                  opacity: urlLoading ? 0.5 : 1,
                  minWidth: '180px',
                }}
                onMouseEnter={(e) => {
                  if (!urlLoading && !isActive) {
                    e.currentTarget.style.borderColor = colors.accent
                    e.currentTarget.style.backgroundColor = 'rgba(0, 232, 157, 0.08)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.borderColor = colors.border
                    e.currentTarget.style.backgroundColor = colors.bgOverlay
                  }
                }}
              >
                {preset.label}
                <span style={{
                  fontSize: '10px',
                  fontWeight: 400,
                  color: isActive ? 'rgba(0,0,0,0.6)' : colors.textDim,
                }}>{preset.note}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── or load your own data ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        width: '100%',
        maxWidth: '520px',
      }}>
        <div style={{ flex: 1, height: '1px', background: colors.border }} />
        <span style={{
          fontSize: '11px',
          fontFamily: fonts.sans,
          color: colors.textDim,
          textTransform: 'uppercase' as const,
          letterSpacing: '0.08em',
          whiteSpace: 'nowrap',
        }}>or load your own data</span>
        <div style={{ flex: 1, height: '1px', background: colors.border }} />
      </div>

      {/* URL input section */}
      <div style={{
        width: '100%',
        maxWidth: '520px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}>
        {/* Dataset selector */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', fontFamily: fonts.sans, color: colors.textSecondary, whiteSpace: 'nowrap' }}>
            Dataset
          </label>
          <select
            value={urlDataset}
            onChange={(e) => { setUrlDataset(e.target.value); setUrlInput(''); setUrlSegment(''); setUrlError(null) }}
            disabled={urlLoading}
            style={{
              flex: 1,
              padding: '7px 10px',
              fontSize: '12px',
              fontFamily: fonts.sans,
              backgroundColor: colors.bgOverlay,
              color: colors.textPrimary,
              border: `1px solid ${colors.border}`,
              borderRadius: radius.sm,
              outline: 'none',
              cursor: urlLoading ? 'not-allowed' : 'pointer',
            }}
          >
            <option value="argoverse2">Argoverse 2</option>
            <option value="nuscenes">nuScenes</option>
            <option value="waymo">Waymo</option>
          </select>
        </div>

        {/* URL input + Load button */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="url"
            value={urlInput}
            onChange={(e) => { setUrlInput(e.target.value); setUrlError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && urlInput.trim() && !urlLoading) {
                handleUrlLoad()
              }
            }}
            disabled={urlLoading}
            placeholder={
              urlDataset === 'nuscenes'
                ? 'https://your-server.com/nuscenes/'
                : urlDataset === 'waymo'
                  ? 'https://your-server.com/waymo_data/'
                  : 'https://your-server.com/av2/sensor/train/'
            }
            style={{
              flex: 1,
              padding: '8px 12px',
              fontSize: '12px',
              fontFamily: fonts.mono,
              backgroundColor: colors.bgOverlay,
              color: colors.textPrimary,
              border: `1px solid ${urlError ? '#FF6B6B' : colors.border}`,
              borderRadius: radius.sm,
              outline: 'none',
              transition: 'border-color 0.15s',
            }}
            onFocus={(e) => {
              if (!urlError) e.currentTarget.style.borderColor = colors.accent
            }}
            onBlur={(e) => {
              if (!urlError) e.currentTarget.style.borderColor = colors.border
            }}
          />
          <button
            onClick={handleUrlLoad}
            disabled={!urlInput.trim() || urlLoading}
            style={{
              padding: '8px 20px',
              fontSize: '12px',
              fontFamily: fonts.sans,
              fontWeight: 600,
              backgroundColor: !urlInput.trim() || urlLoading ? colors.bgOverlay : colors.accent,
              color: !urlInput.trim() || urlLoading ? colors.textDim : '#000',
              border: 'none',
              borderRadius: radius.sm,
              cursor: !urlInput.trim() || urlLoading ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s',
              whiteSpace: 'nowrap',
              minWidth: '72px',
            }}
          >
            {urlLoading ? '…' : 'Load'}
          </button>
        </div>

        {/* Hint: what URL to provide */}
        <div style={{
          fontSize: '11px',
          fontFamily: fonts.sans,
          color: colors.textDim,
          lineHeight: 1.4,
          padding: '0 2px',
        }}>
          {urlDataset === 'nuscenes' && 'Point to a folder that contains v1.0-mini/ or v1.0-trainval/ with JSON metadata and sample data.'}
          {urlDataset === 'waymo' && 'Point to a folder that contains Waymo v2 component directories (vehicle_pose/, lidar/, camera_image/, …).'}
          {urlDataset === 'argoverse2' && 'Point to an AV2 log folder, or a parent directory (e.g. .../sensor/train/) to discover all logs.'}
          {' '}Works with any static file server, S3 bucket, or localhost.
        </div>

        {/* Optional scene/segment ID for direct access (all datasets) */}
        <input
          type="text"
          value={urlSegment}
          onChange={(e) => { setUrlSegment(e.target.value); setUrlError(null) }}
          disabled={urlLoading}
          placeholder={
            urlDataset === 'waymo'
              ? 'Segment ID (optional — e.g. 10455472356147194054_1560_000_1580_000)'
              : urlDataset === 'nuscenes'
                ? 'Scene name (optional — e.g. scene-0061)'
                : 'Log ID (optional — e.g. 00a6ffc1-6ce9-3bc3-a060-6006e9893a1a)'
          }
          style={{
            padding: '8px 12px',
            fontSize: '12px',
            fontFamily: fonts.mono,
            backgroundColor: colors.bgOverlay,
            color: colors.textPrimary,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.sm,
            outline: 'none',
            transition: 'border-color 0.15s',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = colors.accent }}
          onBlur={(e) => { e.currentTarget.style.borderColor = colors.border }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && urlInput.trim() && !urlLoading) {
              handleUrlLoad()
            }
          }}
        />

        {/* URL error */}
        {urlError && (
          <div style={{
            fontSize: '11px',
            fontFamily: fonts.sans,
            color: '#FF6B6B',
            padding: '6px 10px',
            backgroundColor: 'rgba(255, 107, 107, 0.1)',
            borderRadius: radius.sm,
            lineHeight: 1.5,
          }}>
            {urlError}
          </div>
        )}

        {/* Hint */}
        <div style={{
          fontSize: '11px',
          fontFamily: fonts.sans,
          color: colors.textDim,
          textAlign: 'center',
          lineHeight: 1.6,
        }}>
          URL only: auto-discovers all segments. URL + ID: loads a specific segment directly.
        </div>

      </div>

      {/* ── or divider ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        maxWidth: '520px',
        width: '100%',
        margin: '4px 0',
      }}>
        <div style={{ flex: 1, height: '1px', backgroundColor: colors.border }} />
        <span style={{ fontSize: '11px', fontFamily: fonts.sans, color: colors.textDim, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          or drop local files
        </span>
        <div style={{ flex: 1, height: '1px', backgroundColor: colors.border }} />
      </div>

      {/* Drop area */}
      <div style={{
        width: '100%',
        maxWidth: '520px',
        padding: '32px 40px',
        borderRadius: '16px',
        border: `2px dashed ${dragging ? colors.accent : colors.border}`,
        backgroundColor: dragging ? 'rgba(0, 232, 157, 0.08)' : colors.bgSurface,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '16px',
        transition: 'all 0.2s',
      }}>
        {scanning ? (
          <div style={{
            fontSize: '14px',
            fontFamily: fonts.sans,
            color: colors.textSecondary,
          }}>
            Scanning folder for segments…
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={dragging ? colors.accent : colors.textDim} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <polyline points="9 14 12 11 15 14" />
              </svg>
              <span style={{
                fontSize: '14px',
                fontWeight: 600,
                fontFamily: fonts.sans,
                color: colors.textPrimary,
              }}>
                Drop a dataset folder here
              </span>
              {hasDirectoryPicker() && (
                <>
                  <span style={{ fontSize: '12px', fontFamily: fonts.sans, color: colors.textDim }}>or</span>
                  <button
                    onClick={onPickFolder}
                    style={{
                      padding: '5px 14px',
                      fontSize: '12px',
                      fontFamily: fonts.sans,
                      fontWeight: 500,
                      backgroundColor: 'transparent',
                      color: colors.accent,
                      border: `1px solid ${colors.accent}`,
                      borderRadius: radius.sm,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'rgba(0, 232, 157, 0.1)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent'
                    }}
                  >
                    Select Folder
                  </button>
                </>
              )}
            </div>
            <div style={{
              fontSize: '12px',
              fontFamily: fonts.sans,
              color: colors.textSecondary,
            }}>
              Waymo, nuScenes, or Argoverse 2 — auto-detected
            </div>

            {error && (
              <div style={{
                fontSize: '12px',
                fontFamily: fonts.sans,
                color: '#FF6B6B',
                textAlign: 'center',
                padding: '8px 16px',
                backgroundColor: 'rgba(255, 107, 107, 0.1)',
                borderRadius: radius.sm,
              }}>
                {error}
              </div>
            )}

            {/* Hint — expected folder structures */}
            <div style={{
              fontSize: '10px',
              fontFamily: fonts.mono,
              color: colors.textDim,
              textAlign: 'left',
              lineHeight: 1.5,
              display: 'flex',
              gap: '24px',
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}>
              <pre style={{ margin: 0, fontFamily: 'inherit' }}>{
`Waymo (drop this) 📂
├── vehicle_pose/
├── lidar/
├── camera_image/
└── …/*.parquet`
              }</pre>
              <pre style={{ margin: 0, fontFamily: 'inherit' }}>{
`nuScenes (drop this) 📂
├── v1.0-{mini,trainval,test}/
├── samples/
├── sweeps/
└── lidarseg/`
              }</pre>
              <pre style={{ margin: 0, fontFamily: 'inherit' }}>{
`AV2 log (drop this) 📂
├── sensors/
├── calibration/
├── city_SE3_egovehicle…
└── annotations.feather`
              }</pre>
            </div>
          </>
        )}
      </div>
    </div>
  )

  async function handleUrlLoad() {
    if (!urlInput.trim() || urlLoading) return
    setUrlLoading(true)
    setUrlError(null)

    try {
      const baseUrl = normalizeBaseUrl(urlInput)
      const scene = urlSegment.trim() || undefined
      trackDatasetLoad(urlDataset, 'url')
      await loadFromUrl(urlDataset, baseUrl, scene)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setUrlError(msg)
      setUrlLoading(false)
    }
  }
}

// ---------------------------------------------------------------------------
// Loading Skeleton
// ---------------------------------------------------------------------------

const LOAD_STEP_LABELS: Record<string, string> = {
  'opening': 'Opening data files…',
  'parsing': 'Loading metadata…',
  'workers': 'Initializing workers…',
  'first-frame': 'Decoding first frame…',
}

const LOAD_STEPS = ['opening', 'parsing', 'workers', 'first-frame'] as const

/** Shimmer keyframes — injected once */
const shimmerStyle = `
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
`

/** Minimum time (ms) each step stays visible before advancing */
const STEP_MIN_MS = 400

function LoadingSkeleton() {
  const loadProgress = useSceneStore((s) => s.loadProgress)
  const loadStep = useSceneStore((s) => s.loadStep)
  const realStepIdx = LOAD_STEPS.indexOf(loadStep as typeof LOAD_STEPS[number])

  // Visual step trails behind the real step with a minimum display time
  const [displayStepIdx, setDisplayStepIdx] = useState(0)
  const [displayProgress, setDisplayProgress] = useState(0)
  const stepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (realStepIdx > displayStepIdx) {
      // Queue the next visual step with a delay
      if (stepTimerRef.current) clearTimeout(stepTimerRef.current)
      stepTimerRef.current = setTimeout(() => {
        setDisplayStepIdx((prev) => Math.min(prev + 1, realStepIdx))
      }, STEP_MIN_MS)
    }
    return () => { if (stepTimerRef.current) clearTimeout(stepTimerRef.current) }
  }, [realStepIdx, displayStepIdx])

  // Smooth out progress bar — interpolate towards real value
  useEffect(() => {
    const target = loadProgress
    const step = () => {
      setDisplayProgress((prev) => {
        const diff = target - prev
        if (Math.abs(diff) < 0.005) return target
        return prev + diff * 0.15
      })
    }
    const id = setInterval(step, 30)
    return () => clearInterval(id)
  }, [loadProgress])

  const currentStepIdx = displayStepIdx

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      backgroundColor: colors.bgDeep,
      gap: '16px',
      padding: '40px',
    }}>
      {/* Progress bar + steps — no fake card */}
      <div style={{ width: '240px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{
          height: '4px',
          backgroundColor: colors.bgOverlay,
          borderRadius: radius.pill,
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.round(displayProgress * 100)}%`,
            background: gradients.accent,
            borderRadius: radius.pill,
            transition: 'width 0.3s ease-out',
          }} />
        </div>

        {/* Step indicators */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {LOAD_STEPS.map((step, i) => {
            const isCurrent = i === currentStepIdx
            const isDone = i < currentStepIdx
            return (
              <div key={step} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '11px',
                fontFamily: fonts.mono,
                color: isCurrent ? colors.accent : isDone ? colors.textDim : colors.bgOverlay,
                transition: 'color 0.3s',
              }}>
                <span style={{ width: '14px', textAlign: 'center' }}>
                  {isDone ? '✓' : isCurrent ? '›' : '·'}
                </span>
                {LOAD_STEP_LABELS[step]}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Camera strip skeleton — matches real CameraPanel layout exactly */
function CameraStripSkeleton() {
  const shimmerBg = `linear-gradient(90deg, ${colors.bgOverlay} 25%, ${colors.bgSurface} 50%, ${colors.bgOverlay} 75%)`
  return (
    <div style={{
      height: 160,
      flexShrink: 0,
      display: 'flex',
      gap: '6px',
      padding: '6px 8px',
      backgroundColor: colors.bgDeep,
      borderTop: `1px solid ${colors.borderSubtle}`,
      overflow: 'hidden',
    }}>
      <style>{shimmerStyle}</style>
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} style={{
          flex: 1,
          borderRadius: radius.sm,
          background: shimmerBg,
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s ease-in-out infinite',
          animationDelay: `${i * 0.15}s`,
          opacity: 0.3,
        }} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Views
// ---------------------------------------------------------------------------

function ShortcutHints() {
  const [visible, setVisible] = useState(true)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    // Toggle with ? key
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const tag = el?.tagName
      if (tag === 'TEXTAREA' || tag === 'SELECT') return
      if (tag === 'INPUT' && (el as HTMLInputElement).type !== 'range') return
      if (e.key === '?') {
        e.preventDefault()
        setVisible((v) => !v)
        setFading(false)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Auto-hide: fade after 5s, remove after transition
  useEffect(() => {
    if (!visible || fading) return
    const timer = setTimeout(() => setFading(true), 5000)
    const hideOnInteract = (e: KeyboardEvent) => {
      if (e.key === '?') return // let toggle handler deal with it
      setFading(true)
    }
    const hideOnMouse = () => setFading(true)
    window.addEventListener('keydown', hideOnInteract)
    window.addEventListener('mousedown', hideOnMouse)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', hideOnInteract)
      window.removeEventListener('mousedown', hideOnMouse)
    }
  }, [visible, fading])

  // After fade animation, hide completely
  useEffect(() => {
    if (!fading) return
    const timer = setTimeout(() => setVisible(false), 300)
    return () => clearTimeout(timer)
  }, [fading])

  if (!visible) return null

  const keys = [
    { key: '← →', desc: 'frame' },
    { key: 'J L', desc: '±10' },
    { key: 'Space', desc: 'play/pause' },
    { key: 'Shift+← →', desc: 'segment' },
    { key: '?', desc: 'shortcuts' },
  ]

  return (
    <div style={{
      position: 'absolute',
      bottom: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '16px',
      padding: '6px 14px',
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      borderRadius: radius.pill,
      backdropFilter: 'blur(8px)',
      zIndex: 10,
      opacity: fading ? 0 : 1,
      transition: 'opacity 0.3s ease-out',
      animation: 'shortcutFadeIn 0.3s ease-out',
    }}>
      <style>{`
        @keyframes shortcutFadeIn { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
      `}</style>
      {keys.map(({ key, desc }, i) => (
        <span key={i} style={{
          fontSize: '10px',
          fontFamily: fonts.mono,
          color: colors.textDim,
          whiteSpace: 'nowrap',
        }}>
          <span style={{ color: colors.textSecondary }}>{key}</span> {desc}
        </span>
      ))}
    </div>
  )
}

function SensorView({ embedControls = 'full' }: { embedControls?: 'full' | 'minimal' | 'none' }) {
  const status = useSceneStore((s) => s.status)
  const hideOverlays = embedControls === 'none'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* LiDAR 3D View — main area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0 }}>
          {status === 'ready' ? (
            <>
              <LidarViewer hideControls={hideOverlays} />
              {!hideOverlays && <ShortcutHints />}
            </>
          ) : status === 'loading' ? (
            <LoadingSkeleton />
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              backgroundColor: colors.bgDeep,
              color: colors.textDim,
              fontFamily: fonts.sans,
              fontSize: '14px',
            }}>
              3D LiDAR View
            </div>
          )}
        </div>
      </div>

      {/* Camera Image Strip — bottom (hidden when controls=none) */}
      {status === 'ready' && !hideOverlays && <CameraPanel />}
      {status === 'loading' && !hideOverlays && <CameraStripSkeleton />}
    </div>
  )
}

export default App
