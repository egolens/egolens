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

/**
 * Page-level params (embed mode configuration) that must survive every URL
 * rewrite — they describe the page, not the scene. Losing `embed=true` on a
 * reload would turn an embed back into the full app.
 */
function withPageLevelParams(params: URLSearchParams): URLSearchParams {
  const current = new URLSearchParams(window.location.search)
  for (const key of ['embed', 'controls', 'origin'] as const) {
    const value = current.get(key)
    if (value !== null) params.set(key, value)
  }
  return params
}

/**
 * Reflect the active playback range into the URL so reload and copy-paste
 * carry what is on screen. Null removes the params.
 */
export function syncWindowToUrl(win: { t0: string; t1: string } | null) {
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
}

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
    withPageLevelParams(params)
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
export function syncSegmentToUrl(
  segmentId: string,
  win?: { t0: string; t1: string } | null,
) {
  // Only sync if we loaded from a URL (not drag & drop)
  if (!sourceDataset || !sourceBaseUrl) return

  const params = new URLSearchParams()
  params.set('dataset', sourceDataset)
  params.set('data', sourceBaseUrl)
  params.set('scene', segmentId)
  // The range belongs to the scene being synced: carried when one is active,
  // dropped on a scene switch (which clears the range anyway). Passed in
  // rather than read from the store so this module stays store-agnostic.
  if (win) {
    params.set('t0', win.t0)
    params.set('t1', win.t1)
  }

  withPageLevelParams(params)

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
  /** Playback time window bounds — int64 sensor timestamps as strings */
  t0?: string
  t1?: string
  /** Camera strip visibility; build-only (parsed by parseCamerasParam) */
  cameras?: boolean
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
  followCam?: boolean
  /** Camera position [x,y,z] */
  cameraPos?: [number, number, number]
  /** Camera target/look-at [x,y,z] */
  cameraTarget?: [number, number, number]
  /** Azimuthal angle (theta) — orbit compass direction, fixes BEV gimbal-lock */
  cameraAzimuth?: number
  /** Camera distance to target */
  cameraDistance?: number
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
  if (state.t0 && state.t1) { params.set('t0', state.t0); params.set('t1', state.t1) }
  if (state.cameras === false) params.set('cameras', 'false')
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
  if (state.followCam === false) params.set('follow', '0')
  if (state.cameraPos) params.set('cp', state.cameraPos.map(v => v.toFixed(2)).join(','))
  if (state.cameraTarget) params.set('ct', state.cameraTarget.map(v => v.toFixed(2)).join(','))
  // Azimuthal angle (theta) — the compass direction of the orbit camera.
  // At near-BEV angles, cp/ct have identical x,y after rounding, so
  // OrbitControls can't recover theta from atan2(0,0). Saving theta
  // directly as a single float avoids gimbal-lock entirely.
  if (state.cameraAzimuth != null) params.set('az', state.cameraAzimuth.toFixed(4))
  if (state.cameraDistance != null) params.set('cd', state.cameraDistance.toFixed(2))

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

  // Time window — int64 timestamps stay strings (they exceed 2^53)
  const t0 = params.get('t0')
  const t1 = params.get('t1')
  if (t0 && t1 && /^\d{1,20}$/.test(t0) && /^\d{1,20}$/.test(t1)) {
    state.t0 = t0
    state.t1 = t1
  }

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

  if (params.get('follow') === '0') state.followCam = false

  const cp = params.get('cp')
  if (cp) {
    const nums = cp.split(',').map(Number)
    if (nums.length === 3 && nums.every(n => !isNaN(n))) state.cameraPos = nums as [number, number, number]
  }
  const ct = params.get('ct')
  if (ct) {
    const nums = ct.split(',').map(Number)
    if (nums.length === 3 && nums.every(n => !isNaN(n))) state.cameraTarget = nums as [number, number, number]
  }
  const az = params.get('az')
  if (az) { const n = parseFloat(az); if (!isNaN(n)) state.cameraAzimuth = n }
  const cd = params.get('cd')
  if (cd) { const n = parseFloat(cd); if (n > 0) state.cameraDistance = n }

  return state
}

/**
 * Params that mean "this link is showing you a specific view" — a Share View
 * link, or a deep link that pins a moment. Consumers use this to decide
 * whether to autoplay and whether to start with the layer panel out of the
 * way.
 *
 * Stated as a list on purpose. It used to be "any key `parseViewParams`
 * returned", so every parameter added silently joined it: `t0`/`t1` did, and
 * a display filter like `cameras` would have too, changing autoplay for URLs
 * that say nothing about playback.
 */
const SHARE_VIEW_KEYS = [
  'frame', 't0', 't1', 'colormap', 'box', 'world', 'sensors', 'ps', 'opacity',
  'cam', 'trail', 'lidar2d', 'kp3d', 'kp2d', 'camseg', 'speed', 'follow',
  'cp', 'ct', 'az', 'cd',
] as const

/** True when the initial URL pinned a view (i.e. opened via Share link) */
export function isShareView(): boolean {
  // Falls back to the live search when nothing was captured yet — the old
  // implementation did this via parseViewParams' own default, and callers
  // (the layer panel) can mount before setUrlSource runs.
  const live = typeof window === 'undefined' ? '' : window.location.search
  const params = new URLSearchParams(initialSearch ?? live)
  return SHARE_VIEW_KEYS.some((key) => params.has(key))
}

/**
 * Camera strip visibility (`cameras=all|false`). Parsed on its own rather
 * than through `parseViewParams`, which is a list of post-load actions to
 * replay and doubles as the share-link signal above; this is a render-time
 * display switch and belongs in neither.
 *
 * Returns null when unset, so the caller can apply the `controls`-derived
 * default.
 */
export function parseCamerasParam(search?: string): boolean | null {
  // Runs from the store, which is exercised in a node environment too
  const live = typeof window === 'undefined' ? '' : window.location.search
  const raw = new URLSearchParams(search ?? initialSearch ?? live).get('cameras')
  if (raw === null) return null
  const v = raw.toLowerCase()
  if (v === 'all' || v === 'true' || v === '1') return true
  if (v === 'false' || v === 'none' || v === '0') return false
  console.warn(`[urlState] cameras="${raw}" is not all|false — ignoring`)
  return null
}
