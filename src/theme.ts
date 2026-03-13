/**
 * Waymo-inspired design tokens
 *
 * Color palette derived from Waymo's brand language:
 * - Caribbean Green teal-to-blue gradient
 * - Dark backgrounds with subtle blue undertones
 * - "Pure, flow, balance, contrast" design principles
 */

// ---------------------------------------------------------------------------
// Core palette
// ---------------------------------------------------------------------------

export const colors = {
  /** Primary accent — Waymo teal */
  accent: '#00E89D',
  accentDim: 'rgba(0, 232, 157, 0.3)',
  accentGlow: 'rgba(0, 232, 157, 0.15)',

  /** Secondary accent — Waymo blue */
  accentBlue: '#00C9DB',

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

  /** Semantic — detection object types (nuScenes convention) */
  boxVehicle: '#FF9E00',
  boxPedestrian: '#CCFF00',
  boxSign: '#FF44FF',
  boxCyclist: '#DC143C',
  boxUnknown: '#6B7280',

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
  glowStrong: `0 0 20px rgba(0, 232, 157, 0.25)`,
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
