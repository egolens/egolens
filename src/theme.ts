/**
 * EgoLens design tokens
 *
 * Tokens fall into three groups, and the distinction decides how each one is
 * delivered — not just what a theme may change:
 *
 *   CHROME  panels, text, borders, buttons. Delivered as `var(--el-*)` so a
 *           theme switch repaints with no React re-render and no first-paint
 *           flash. Every consumer is CSS: an inline style, a template string,
 *           or a `style.color =` assignment, all of which resolve `var()`.
 *   SCENE   grid, gizmo, vehicle marker. These reach THREE.Color through JSX
 *           props, and THREE cannot parse `var()` — it would throw or render
 *           black. Delivered as literal hex via `sceneColors(theme)`, which
 *           callers must resolve at render time.
 *   DATA    sensor, radar and camera identity. Never themed: the colour
 *           encodes which sensor a point came from and has to mean the same
 *           thing across screenshots, docs and both themes.
 *
 * Object class colours are not here at all — they live in each adapter's
 * manifest (`boxTypes[].color`), for the same reason as DATA.
 */

import { parseAccent, parseThemePreference, resolveThemePreference, systemTheme } from './utils/themeParams'

export type ThemeName = 'dark' | 'light'

// ---------------------------------------------------------------------------
// Chrome — themed, delivered as CSS custom properties
// ---------------------------------------------------------------------------

/**
 * Both palettes must carry the same keys; `CHROME_KEYS` is derived from dark
 * and a test asserts light matches, so a token added to one cannot be
 * forgotten in the other.
 */
const CHROME_DARK = {
  accent: '#00E89D',
  textOnAccent: '#000000',
  accentBlue: '#00C9DB',
  danger: '#FF6B6B',

  bgDeep: '#0C0F1A',
  bgBase: '#111628',
  bgSurface: '#1A1F35',
  bgOverlay: '#232940',
  bgHover: '#2D3350',

  border: '#2A3050',
  borderSubtle: '#1E2440',

  textPrimary: '#E8ECF4',
  textSecondary: '#8892A8',
  textDim: '#5A6378',

  /** A raised surface, one step from its parent. Lightens on dark, darkens on
   *  light — the eight hand-written `rgba(255,255,255,α)` tints assumed the
   *  first and would have stayed white-on-white. */
  tintRaise: 'rgba(255, 255, 255, 0.06)',
  tintRaiseStrong: 'rgba(255, 255, 255, 0.14)',
  /** A recessed well, e.g. behind a camera label, and the text that sits on
   *  it. They flip together: a dark scrim needs light text and vice versa. */
  tintSink: 'rgba(0, 0, 0, 0.55)',
  tintSinkText: 'rgba(255, 255, 255, 0.82)',
  /** Drop-shadow ink. A black shadow is invisible on dark and heavy on light. */
  shadowInk: 'rgba(0, 0, 0, 0.55)',
  /** Pushes a region back — the timeline outside a playback range. "Recede"
   *  means darker on dark and lighter on light; a black scrim on a light
   *  timeline reads as a bar, not as de-emphasis. Kept short of opaque so the
   *  buffer bar and annotation ticks stay legible underneath. */
  scrimOut: 'rgba(10, 13, 26, 0.72)',
} as const

const CHROME_LIGHT: Record<keyof typeof CHROME_DARK, string> = {
  // Accents are darkened until they carry text on white: the dark-theme teal
  // is 1.6:1 there, which is not a colour, it is a rumour.
  accent: '#008C5E',
  textOnAccent: '#000000',
  accentBlue: '#00808F',
  danger: '#E03131',

  bgDeep: '#FFFFFF',
  bgBase: '#F2F5F9',
  bgSurface: '#FFFFFF',
  bgOverlay: '#E9EEF5',
  bgHover: '#DCE3EC',

  border: '#CBD5E1',
  borderSubtle: '#E2E8F0',

  textPrimary: '#1A2030',
  textSecondary: '#4A5568',
  textDim: '#6B7688',

  tintRaise: 'rgba(15, 23, 42, 0.05)',
  tintRaiseStrong: 'rgba(15, 23, 42, 0.11)',
  tintSink: 'rgba(255, 255, 255, 0.78)',
  tintSinkText: 'rgba(15, 23, 42, 0.86)',
  shadowInk: 'rgba(15, 23, 42, 0.16)',
  scrimOut: 'rgba(248, 250, 252, 0.80)',
}

export const CHROME_PALETTES: Record<ThemeName, Record<string, string>> = {
  dark: CHROME_DARK,
  light: CHROME_LIGHT,
}

export const CHROME_KEYS = Object.keys(CHROME_DARK) as (keyof typeof CHROME_DARK)[]

/** `--el-bg-deep` from `bgDeep`. */
export function cssVarName(token: string): string {
  return `--el-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/** Every chrome token as `var(--el-x, <dark value>)`. The fallback means the
 *  app still renders correctly if the bootstrap never ran. */
const chromeVars = Object.fromEntries(
  CHROME_KEYS.map((k) => [k, `var(${cssVarName(k)}, ${CHROME_DARK[k]})`]),
) as Record<keyof typeof CHROME_DARK, string>

// ---------------------------------------------------------------------------
// Scene — themed, but must stay literal hex for THREE.Color
// ---------------------------------------------------------------------------

const SCENE_PALETTES: Record<ThemeName, Record<string, string>> = {
  dark: {
    gridMajor: '#2E3550',
    gridMinor: '#252B42',
    vehicleMarker: '#00E89D',
    gizmoX: '#FF5757',
    gizmoY: '#00E89D',
    gizmoZ: '#4DA8FF',
  },
  light: {
    gridMajor: '#C2CBD9',
    gridMinor: '#DEE4EC',
    vehicleMarker: '#008C5E',
    gizmoX: '#D32F2F',
    gizmoY: '#008C5E',
    gizmoZ: '#2563EB',
  },
}

/**
 * Scene colours as literal hex.
 *
 * Callers must read the active theme and pass it in, so the value is resolved
 * at render time rather than frozen at import. A `var()` string here would
 * make THREE.Color throw, or silently paint black.
 */
export function sceneColors(theme: ThemeName): Record<string, string> {
  return SCENE_PALETTES[theme]
}

/**
 * The viewport clear colour for a theme, as literal hex.
 * `setClearColor` is a THREE call and cannot take `var()`.
 */
export function viewportBg(theme: ThemeName): string {
  return CHROME_PALETTES[theme].bgDeep
}

/**
 * The palette every component reads.
 *
 * Every entry is chrome and resolves through CSS custom properties. Data
 * colours live in dataColors.ts; scene colours are deliberately absent — see
 * `sceneColors()`.
 */
export const colors = {
  ...chromeVars,
  /** Derived from the accent, so they follow it through a theme switch. */
  get accentDim() { return alpha(chromeVars.accent, 0.3) },
  get accentGlow() { return alpha(chromeVars.accent, 0.15) },
}

// ---------------------------------------------------------------------------
// Applying a theme
// ---------------------------------------------------------------------------

/**
 * Write a theme's chrome tokens onto an element as custom properties.
 *
 * Called once before React mounts so the first paint is already correct, and
 * again on every switch. Nothing re-renders: the browser repaints from the
 * cascade.
 */
export function applyTheme(theme: ThemeName, root: HTMLElement, accent?: string | null): void {
  const palette = CHROME_PALETTES[theme]
  for (const key of CHROME_KEYS) root.style.setProperty(cssVarName(key), palette[key])
  const nextAccent = accent === undefined ? root.dataset.accent ?? null : accent
  if (nextAccent) {
    const hex = `#${nextAccent}`
    root.style.setProperty(cssVarName('accent'), hex)
    root.style.setProperty(cssVarName('textOnAccent'), contrastText(hex))
    root.dataset.accent = nextAccent
  } else {
    delete root.dataset.accent
  }
  // A dark drop shadow is invisible on dark; the two themes need different ones.
  root.style.setProperty('--el-shadow-card', SHADOWS[theme])
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

/**
 * The theme to start in: an explicit choice, else the OS preference.
 *
 * Resolved before React mounts so the first paint is already right — a theme
 * that arrives after mount is a visible flash.
 */
export function initialTheme(): ThemeName {
  if (typeof window === 'undefined') return 'dark'

  // `?theme=` wins, and is read here rather than in embedParams so it applies
  // in normal mode too — a scene link pasted into a paper's supplement wants
  // the same control an iframe does.
  const param = new URLSearchParams(window.location.search).get('theme')
  const preference = parseThemePreference(window.location.search)
  if (preference) return resolveThemePreference(preference)
  if (param) console.warn(`[theme] ignoring theme=${param}; expected "light", "dark", or "auto"`)

  try {
    const saved = localStorage.getItem('egolens-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* private mode */ }
  return systemTheme()
}

/** Custom chrome accent from `?accent=RRGGBB`, or null for the theme default. */
export function initialAccent(): string | null {
  if (typeof window === 'undefined') return null
  return parseAccent(window.location.search)
}

/** Pick whichever of black/white has the stronger WCAG contrast with a hex colour. */
export function contrastText(hex: string): '#000000' | '#FFFFFF' {
  const raw = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16) / 255)
  const linear = channels.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  const blackContrast = (luminance + 0.05) / 0.05
  const whiteContrast = 1.05 / (luminance + 0.05)
  return blackContrast >= whiteContrast ? '#000000' : '#FFFFFF'
}

const SHADOWS: Record<ThemeName, string> = {
  dark: '0 2px 8px rgba(0, 0, 0, 0.3)',
  light: '0 2px 8px rgba(15, 23, 42, 0.10)',
}

// ---------------------------------------------------------------------------
// Alpha variants
// ---------------------------------------------------------------------------

/**
 * An alpha variant of a colour, including a `var()` one.
 *
 * `color-mix` is what makes this work against a custom property — the old
 * implementation parsed a hex, which a `var()` string is not. Hand-written
 * `rgba()` literals are the thing being avoided: they do not follow the token
 * they were copied from, and six had already drifted by one in green.
 */
export function alpha(cssColor: string, a: number): string {
  return `color-mix(in srgb, ${cssColor} ${(a * 100).toFixed(1)}%, transparent)`
}

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
  card: 'var(--el-shadow-card, 0 2px 8px rgba(0, 0, 0, 0.3))',
  glow: `0 0 12px ${alpha(chromeVars.accent, 0.15)}`,
  glowStrong: `0 0 20px ${alpha(chromeVars.accent, 0.25)}`,
} as const

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

export const gradients = {
  /** Timeline progress bar */
  accent: `linear-gradient(90deg, ${chromeVars.accent}, ${chromeVars.accentBlue})`,
  /** Subtle header/footer background */
  surface: `linear-gradient(180deg, ${chromeVars.bgSurface} 0%, ${chromeVars.bgBase} 100%)`,
} as const
