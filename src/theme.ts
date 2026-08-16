/**
 * EgoLens design tokens
 *
 * Color palette: teal accent on dark blue backgrounds
 * - Dark backgrounds with subtle blue undertones
 * - High-contrast teal accent for interactive elements
 *
 * Tokens fall into three groups, and the distinction is load-bearing:
 *
 *   CHROME  panels, text, borders, buttons — the UI around the view. A theme
 *           may change these freely.
 *   SCENE   grid, gizmo, vehicle marker — 3D orientation aids. A theme may
 *           change these, but they are consumed by THREE.Color, which cannot
 *           parse `var()` or `rgba()`; they must stay literal hex.
 *   DATA    sensor, radar and camera identities. A theme must NOT change
 *           these: they encode which sensor a point came from, and the same
 *           colour has to mean the same thing across screenshots and docs.
 *
 * Object class colours are not here at all — they live in each adapter's
 * manifest (`boxTypes[].color`), which is the right place for the same reason.
 */

// ---------------------------------------------------------------------------
// Core palette
// ---------------------------------------------------------------------------

const ACCENT = '#00E89D'
const ACCENT_BLUE = '#00C9DB'

/**
 * An alpha variant of a token colour.
 *
 * Hand-written `rgba()` literals do not follow the token they were copied
 * from. Six sites had drifted to `rgba(0, 200, 219, …)` against an
 * `accentBlue` of `#00C9DB` — off by one in green — and one of them sat in the
 * same declaration as the correct token.
 */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

export const colors = {
  // -- CHROME ---------------------------------------------------------------

  /** Primary accent — teal */
  accent: ACCENT,
  accentDim: alpha(ACCENT, 0.3),
  accentGlow: alpha(ACCENT, 0.15),

  /** Secondary accent — blue */
  accentBlue: ACCENT_BLUE,

  /** Failure states. Shares a hex with radarFront today; separate on purpose,
   *  so a theme can move one without moving the other. */
  danger: '#FF6B6B',

  /** Background tiers */
  bgDeep: '#0C0F1A',      // deepest layer (canvas, 3D scene)
  bgBase: '#111628',       // main app background
  bgSurface: '#1A1F35',    // header, footer, cards
  bgOverlay: '#232940',    // buttons, overlays
  bgHover: '#2D3350',      // hover states

  /** Borders */
  border: '#2A3050',
  borderSubtle: '#1E2440',

  /** Text */
  textPrimary: '#E8ECF4',
  textSecondary: '#8892A8',
  textDim: '#5A6378',

  // -- DATA -----------------------------------------------------------------

  /** Semantic — sensor LiDAR (cool-tone family) */
  sensorTop: '#00E89D',       // teal (primary)
  sensorFront: '#00C9DB',     // cyan
  sensorSideL: '#4DA8FF',     // sky blue
  sensorSideR: '#7B6FFF',     // indigo
  sensorRear: '#B490FF',      // lavender

  /** Semantic — radar sensors (warm-tone family to distinguish from LiDAR) */
  radarFront: '#FF6B6B',       // coral red
  radarFrontLeft: '#FF9F43',   // orange
  radarFrontRight: '#FECA57',  // yellow
  radarBackLeft: '#FF6348',    // tomato
  radarBackRight: '#EE5A24',   // vermilion

  /** Semantic — cameras (harmonized with sensors) */
  camFront: '#FFFFFF',
  camFrontLeft: '#00E89D',
  camFrontRight: '#00C9DB',
  camSideLeft: '#4DA8FF',
  camSideRight: '#B490FF',

  // Object class colours used to live here as box{Vehicle,Pedestrian,Sign,
  // Cyclist,Unknown}. They were superseded by each adapter's
  // `manifest.boxTypes[].color` — which is correct, since the class set differs
  // per dataset — and then sat unreferenced. Removed rather than left to rot.

  // -- SCENE ----------------------------------------------------------------
  // Consumed by THREE.Color. Literal hex only: `var()` throws and `rgba()`
  // silently loses the alpha.

  /** 3D scene — subtle so LiDAR points dominate */
  gridMajor: '#2E3550',
  gridMinor: '#252B42',
  vehicleMarker: '#00E89D',

  /** Gizmo */
  gizmoX: '#FF5757',
  gizmoY: '#00E89D',
  gizmoZ: '#4DA8FF',
} as const

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const fonts = {
  /** UI labels, headers, body text — system font stack (GT-Walsheim-like geometric sans) */
  sans: "-apple-system, 'system-ui', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'",
  /** Data values, technical readouts */
  mono: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
} as const

// ---------------------------------------------------------------------------
// Spacing & Radii
// ---------------------------------------------------------------------------

export const radius = {
  sm: '4px',
  md: '8px',
  lg: '12px',
  pill: '999px',
} as const

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

export const shadows = {
  card: '0 2px 8px rgba(0, 0, 0, 0.3)',
  glow: `0 0 12px ${colors.accentGlow}`,
  glowStrong: `0 0 20px ${alpha(ACCENT, 0.25)}`,
} as const

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

export const gradients = {
  /** Timeline progress bar */
  accent: `linear-gradient(90deg, ${colors.accent}, ${colors.accentBlue})`,
  /** Subtle header/footer background */
  surface: `linear-gradient(180deg, ${colors.bgSurface} 0%, ${colors.bgBase} 100%)`,
} as const
