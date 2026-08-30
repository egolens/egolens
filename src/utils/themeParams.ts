import type { ThemeName } from '../theme'

export type ThemePreference = ThemeName | 'auto'

const ACCENT_RE = /^[0-9a-fA-F]{6}$/

/** Parse the public theme URL value. Invalid values fall back to normal resolution. */
export function parseThemePreference(search: string): ThemePreference | null {
  const value = new URLSearchParams(search).get('theme')
  return value === 'dark' || value === 'light' || value === 'auto' ? value : null
}

/** Parse and canonicalize the public accent URL value (`RRGGBB`, without `#`). */
export function parseAccent(search: string): string | null {
  const value = new URLSearchParams(search).get('accent')
  return value && ACCENT_RE.test(value) ? value.toUpperCase() : null
}

export function isAccent(value: unknown): value is string {
  return typeof value === 'string' && ACCENT_RE.test(value)
}

export function systemTheme(): ThemeName {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveThemePreference(preference: ThemePreference): ThemeName {
  return preference === 'auto' ? systemTheme() : preference
}
