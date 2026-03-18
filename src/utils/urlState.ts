/**
 * URL state management for EgoLens.
 *
 * Two levels of URL synchronization:
 *   1. Auto (replaceState) — dataset, data URL, and segment ID only.
 *      Updated on segment switch. Lightweight, no history pollution.
 *   2. Share — full view state snapshot encoded as URL params.
 *      Triggered by explicit Share button. Includes frame, colormap,
 *      sensors, overlays, point settings, etc.
 */

// ---------------------------------------------------------------------------
// Auto URL sync (segment changes only)
// ---------------------------------------------------------------------------

/** Source info stored when loading from URL — needed for replaceState */
let sourceDataset: string | null = null
let sourceBaseUrl: string | null = null
/** Whether we've already pushed one history entry for this session */
let historyPushed = false
/** Snapshot of the initial URL search string — captured before replaceState overwrites it */
let initialSearch: string | null = null

export function setUrlSource(dataset: string, baseUrl: string) {
  sourceDataset = dataset
  sourceBaseUrl = baseUrl

  // Capture initial URL search before any replaceState overwrites it.
  // This preserves view params (colormap, box, frame, etc.) from shared URLs.
  if (initialSearch === null) {
    initialSearch = window.location.search
  }

  // Push one history entry so browser back returns to the landing page.
  // Only push once — subsequent segment switches use replaceState.
  if (!historyPushed) {
    historyPushed = true
    const params = new URLSearchParams()
    params.set('dataset', dataset)
    params.set('data', baseUrl)
    window.history.pushState({ egolens: true }, '', `${window.location.pathname}?${params}`)
  }
}

export function clearUrlSource() {
  sourceDataset = null
  sourceBaseUrl = null
  historyPushed = false
  initialSearch = null
}

/** Check whether data was loaded from a URL (not drag & drop) */
export function hasUrlSource(): boolean {
  return sourceDataset != null && sourceBaseUrl != null
}

/** Get the current URL source info */
export function getUrlSource(): { dataset: string; baseUrl: string } | null {
  if (!sourceDataset || !sourceBaseUrl) return null
  return { dataset: sourceDataset, baseUrl: sourceBaseUrl }
}

/** Get the initial URL search string captured before replaceState overwrites */
export function getInitialSearch(): string | null {
  return initialSearch
}

/**
 * Update the browser URL with the current dataset + segment.
 * Uses replaceState to avoid polluting history.
 */
export function syncSegmentToUrl(segmentId: string) {
  // Only sync if we loaded from a URL (not drag & drop)
  if (!sourceDataset || !sourceBaseUrl) return

  const params = new URLSearchParams()
  params.set('dataset', sourceDataset)
  params.set('data', sourceBaseUrl)
  params.set('scene', segmentId)

  const newUrl = `${window.location.pathname}?${params}`
  window.history.replaceState(null, '', newUrl)
}

// ---------------------------------------------------------------------------
// Share URL — full view state snapshot
// ---------------------------------------------------------------------------

export interface ShareableState {
  dataset?: string
  baseUrl?: string
  scene?: string
  frame?: number
  colormap?: string
  boxMode?: string
  worldMode?: boolean
  sensors?: number[]
  pointSize?: number
  pointOpacity?: number
  activeCam?: number | null
  trailLength?: number
  lidarOverlay?: boolean
  keypoints3D?: boolean
  keypoints2D?: boolean
  cameraSeg?: boolean
  speed?: number
}

/**
 * Build a shareable URL encoding the full view state.
 */
export function buildShareUrl(state: ShareableState): string {
  const params = new URLSearchParams()

  if (state.dataset) params.set('dataset', state.dataset)
  if (state.baseUrl) params.set('data', state.baseUrl)
  if (state.scene) params.set('scene', state.scene)
  if (state.frame != null && state.frame > 0) params.set('frame', String(state.frame))
  if (state.colormap && state.colormap !== 'intensity') params.set('colormap', state.colormap)
  if (state.boxMode && state.boxMode !== 'box') params.set('box', state.boxMode)
  if (state.worldMode === false) params.set('world', '0')
  if (state.sensors) {
    // Only encode if not all 5 sensors are on
    const sorted = [...state.sensors].sort()
    if (sorted.length < 5) params.set('sensors', sorted.join(','))
  }
  if (state.pointSize != null && state.pointSize !== 0.08) params.set('ps', String(state.pointSize))
  if (state.pointOpacity != null && state.pointOpacity !== 0.85) params.set('opacity', String(state.pointOpacity))
  if (state.activeCam != null) params.set('cam', String(state.activeCam))
  if (state.trailLength != null && state.trailLength !== 10) params.set('trail', String(state.trailLength))
  if (state.lidarOverlay) params.set('lidar2d', '1')
  if (state.keypoints3D) params.set('kp3d', '1')
  if (state.keypoints2D) params.set('kp2d', '1')
  if (state.cameraSeg) params.set('camseg', '1')
  if (state.speed != null && state.speed !== 1) params.set('speed', String(state.speed))

  const qs = params.toString()
  return `${window.location.origin}${window.location.pathname}${qs ? '?' + qs : ''}`
}

// ---------------------------------------------------------------------------
// Parse URL params into restorable state
// ---------------------------------------------------------------------------

export function parseViewParams(search?: string): Partial<ShareableState> {
  const params = new URLSearchParams(search ?? window.location.search)
  const state: Partial<ShareableState> = {}

  const frame = params.get('frame')
  if (frame) { const n = parseInt(frame, 10); if (n >= 0) state.frame = n }

  const colormap = params.get('colormap')
  if (colormap) state.colormap = colormap

  const box = params.get('box')
  if (box && ['off', 'box', 'model'].includes(box)) state.boxMode = box

  const world = params.get('world')
  if (world === '0') state.worldMode = false

  const sensors = params.get('sensors')
  if (sensors) {
    state.sensors = sensors.split(',').map(Number).filter(n => !isNaN(n))
  }

  const ps = params.get('ps')
  if (ps) { const n = parseFloat(ps); if (n > 0) state.pointSize = n }

  const opacity = params.get('opacity')
  if (opacity) { const n = parseFloat(opacity); if (n >= 0 && n <= 1) state.pointOpacity = n }

  const cam = params.get('cam')
  if (cam) { const n = parseInt(cam, 10); if (!isNaN(n)) state.activeCam = n }

  const trail = params.get('trail')
  if (trail) { const n = parseInt(trail, 10); if (n >= 0) state.trailLength = n }

  if (params.get('lidar2d') === '1') state.lidarOverlay = true
  if (params.get('kp3d') === '1') state.keypoints3D = true
  if (params.get('kp2d') === '1') state.keypoints2D = true
  if (params.get('camseg') === '1') state.cameraSeg = true

  const speed = params.get('speed')
  if (speed) { const n = parseFloat(speed); if (n > 0) state.speed = n }

  return state
}
