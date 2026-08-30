/**
 * Embed mode URL parameter parser.
 *
 * When the app is loaded with `&embed=true`, it enters "embed mode":
 * - No header, no landing page, no credit bar
 * - Data auto-loads from `&dataset=` + `&data=` params
 * - Controls visibility configurable via `&controls=`
 * - Initial state (frame, camera, colormap, etc.) configurable via params
 *
 * Usage (iframe):
 *   <iframe src="https://studio.example.com/?dataset=argoverse2&data=https://...&embed=true&autoplay=true">
 *
 * @module embedParams
 */

import type { ColormapMode } from '../stores/useSceneStore'
import { parseAccent, parseThemePreference, type ThemePreference } from './themeParams'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmbedControlsMode = 'full' | 'minimal' | 'none'

export interface EmbedParams {
  /** Whether embed mode is active */
  embed: boolean
  /** Controls visibility: 'full' (default), 'minimal' (play/pause + frame counter), 'none' (view-only) */
  controls: EmbedControlsMode
  /** Initial frame index (0-based) */
  frame: number | null
  /** Initial camera POV (e.g., 'ring_front_center', 'FRONT') */
  camera: string | null
  /** Auto-play on load */
  autoplay: boolean
  /** Initial colormap mode */
  colormap: ColormapMode | null
  /** Chrome theme. `auto` resolves from the operating-system preference. */
  theme: ThemePreference | null
  /** Chrome accent color (`RRGGBB`, without `#`). */
  accent: string | null
  /** Allowed origin for postMessage (derived from &origin= or document.referrer) */
  origin: string | null
}

// Valid colormap values
const VALID_COLORMAPS: ReadonlySet<string> = new Set([
  'intensity', 'range', 'elongation', 'distance', 'segment', 'panoptic', 'camera',
])

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse embed-related URL parameters from the current location.
 * Returns a fully-resolved EmbedParams object with defaults applied.
 *
 * @param search - URL search string (defaults to window.location.search)
 */
export function parseEmbedParams(search?: string): EmbedParams {
  // The store reads these to decide whether camera images are needed, and it
  // is exercised in a node environment by the store tests
  const live = typeof window === 'undefined' ? '' : window.location.search
  const params = new URLSearchParams(search ?? live)

  const embed = params.get('embed') === 'true'

  // Controls mode
  let controls: EmbedControlsMode = 'full'
  const controlsRaw = params.get('controls')
  if (controlsRaw === 'minimal' || controlsRaw === 'false' || controlsRaw === 'none') {
    controls = controlsRaw === 'false' ? 'none' : controlsRaw
  }

  // Initial frame
  let frame: number | null = null
  const frameRaw = params.get('frame')
  if (frameRaw !== null) {
    const n = parseInt(frameRaw, 10)
    if (Number.isFinite(n) && n >= 0) frame = n
  }

  // Camera
  const camera = params.get('camera') ?? null

  // Autoplay
  const autoplay = params.get('autoplay') === 'true'

  // Colormap
  let colormap: ColormapMode | null = null
  const colormapRaw = params.get('colormap')
  if (colormapRaw && VALID_COLORMAPS.has(colormapRaw)) {
    colormap = colormapRaw as ColormapMode
  }

  const theme = parseThemePreference(params.toString())
  const accent = parseAccent(params.toString())

  // Origin for postMessage validation
  let origin: string | null = params.get('origin') ?? null
  if (!origin && typeof document !== 'undefined' && document.referrer) {
    try {
      origin = new URL(document.referrer).origin
    } catch {
      // Invalid referrer — leave null
    }
  }

  return { embed, controls, frame, camera, autoplay, colormap, theme, accent, origin }
}

/**
 * Singleton — parsed once on module load, reused everywhere.
 * In tests, use `parseEmbedParams(search)` directly.
 */
let _cached: EmbedParams | null = null

export function getEmbedParams(): EmbedParams {
  if (!_cached) {
    _cached = parseEmbedParams()
  }
  return _cached
}

/** Reset cached params (for testing) */
export function _resetEmbedParamsCache(): void {
  _cached = null
}
