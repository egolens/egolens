/**
 * @vitest-environment happy-dom
 */
/**
 * Theme token contract.
 *
 * Two delivery mechanisms coexist and each has a way of failing silently:
 *
 *   Chrome is `var(--el-*)`. A hand-written copy of a token does not follow
 *   it, so the copy stays dark when the theme flips. Six had already drifted
 *   by one in green before anything was watching.
 *
 *   Scene colours must be literal hex, because they reach THREE.Color through
 *   JSX props. THREE does not throw on `var(--x)` — the material renders
 *   black. That is the failure these tests exist to prevent.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  colors, alpha, applyTheme, cssVarName, sceneColors, viewportBg,
  CHROME_PALETTES, CHROME_KEYS, initialTheme, type ThemeName,
} from '../theme'

const SRC = join(__dirname, '..')
const THEMES: ThemeName[] = ['dark', 'light']

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') sourceFiles(path, out)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}
const files = sourceFiles(SRC).filter((f) => !f.endsWith('theme.ts'))
const rel = (f: string) => f.slice(SRC.length + 1)
const HEX = /^#[0-9A-Fa-f]{6}$/

describe('the two palettes stay in step', () => {
  it('carry exactly the same keys', () => {
    expect(Object.keys(CHROME_PALETTES.light).sort())
      .toEqual(Object.keys(CHROME_PALETTES.dark).sort())
  })

  it('differ in every key — a token identical in both is probably DATA', () => {
    const same = CHROME_KEYS.filter((k) => CHROME_PALETTES.dark[k] === CHROME_PALETTES.light[k])
    expect(same).toEqual([])
  })

  it('light chrome text is legible on light chrome backgrounds', () => {
    const lum = (hex: string) => {
      const f = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      const [r, g, b] = [1, 3, 5].map((i) => f(parseInt(hex.slice(i, i + 2), 16) / 255))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)]
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
    }
    for (const theme of THEMES) {
      const p = CHROME_PALETTES[theme]
      expect(ratio(p.textPrimary, p.bgBase), `${theme} textPrimary`).toBeGreaterThan(7)
      expect(ratio(p.textSecondary, p.bgBase), `${theme} textSecondary`).toBeGreaterThan(4)
      // The accent carries small text and active-state labels.
      expect(ratio(p.accent, p.bgBase), `${theme} accent`).toBeGreaterThan(3)
    }
  })
})

describe('chrome is delivered as custom properties', () => {
  it.each(CHROME_KEYS)('%s is a var() with a dark fallback', (key) => {
    const value = (colors as Record<string, string>)[key]
    expect(value).toBe(`var(${cssVarName(key)}, ${CHROME_PALETTES.dark[key]})`)
  })

  it('applyTheme writes every key, plus the shadow', () => {
    for (const theme of THEMES) {
      const root = { style: { setProperty: (k: string, v: string) => { seen[k] = v }, colorScheme: '' }, dataset: {} } as unknown as HTMLElement
      const seen: Record<string, string> = {}
      applyTheme(theme, root)
      for (const key of CHROME_KEYS) {
        expect(seen[cssVarName(key)], `${theme}/${key}`).toBe(CHROME_PALETTES[theme][key])
      }
      expect(seen['--el-shadow-card']).toBeTruthy()
      expect(root.dataset.theme).toBe(theme)
    }
  })

  it('cssVarName kebab-cases', () => {
    expect(cssVarName('bgDeep')).toBe('--el-bg-deep')
    expect(cssVarName('accent')).toBe('--el-accent')
  })
})

describe('scene colours never become var()', () => {
  // THREE.Color renders var(--x) as black without complaining. Nothing in the
  // type system distinguishes the two strings, so this is the only guard.
  it.each(THEMES)('%s scene palette is literal hex throughout', (theme) => {
    for (const [k, v] of Object.entries(sceneColors(theme))) {
      expect(v, `${theme}.${k}`).toMatch(HEX)
    }
  })

  it.each(THEMES)('%s viewport background is literal hex', (theme) => {
    expect(viewportBg(theme)).toMatch(HEX)
  })

  it('no setClearColor or THREE colour prop is handed a chrome token', () => {
    // colors.* is a var() string now; these call sites need viewportBg()/sceneColors().
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        if (/setClearColor\(|new THREE\.Color\(/.test(line) && /colors\.\w+/.test(line)) {
          offenders.push(`${rel(f)}:${i + 1}`)
        }
      }
    }
    expect(offenders, 'use viewportBg(theme) or sceneColors(theme)').toEqual([])
  })
})

describe('no source file holds a copy of a themed colour', () => {
  const themed = [
    ...new Set(THEMES.flatMap((t) => [
      ...Object.values(CHROME_PALETTES[t]),
      ...Object.values(sceneColors(t)),
    ])),
  ]

  // Pure white and black are too generic to be evidence of a copy, and a line
  // marked `theme-exempt` is asserting it deliberately holds a literal — the
  // viewport background presets do, because they are not a UI theme.
  const GENERIC = new Set(['#FFFFFF', '#000000'])
  /** A marker exempts its own line and the one after it, since the note
   *  usually sits above the code it is explaining. */
  const exemptAt = (lines: string[], i: number) =>
    lines[i].includes('theme-exempt') || (i > 0 && lines[i - 1].includes('theme-exempt'))

  it('no hex literal duplicates a themed value', () => {
    const values = themed.filter((v) => HEX.test(v) && !GENERIC.has(v.toUpperCase()))
    const offenders: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      for (const [i, line] of lines.entries()) {
        if (exemptAt(lines, i)) continue
        for (const v of values) {
          if (new RegExp(v, 'i').test(line)) offenders.push(`${rel(f)}:${i + 1} holds ${v}`)
        }
      }
    }
    expect(offenders, 'import the token instead').toEqual([])
  })

  it('no hand-rolled rgba() duplicates a themed value, within ±1 per channel', () => {
    const channels = (v: string) => {
      const m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
      if (m) return [+m[1], +m[2], +m[3]]
      if (!HEX.test(v)) return null
      const n = parseInt(v.slice(1), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const targets = themed.map(channels).filter(Boolean) as number[][]
    const rx = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g
    const offenders: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      for (const [i, line] of lines.entries()) {
        if (exemptAt(lines, i)) continue
        for (const m of line.matchAll(rx)) {
          const got = [+m[1], +m[2], +m[3]]
          if (targets.some((t) => t.every((c, j) => Math.abs(c - got[j]) <= 1))) {
            offenders.push(`${rel(f)}:${i + 1} ${m[0]})`)
          }
        }
      }
    }
    expect(offenders, 'use alpha(colors.<token>, a)').toEqual([])
  })
})

describe('alpha survives a custom property', () => {
  it('emits color-mix, which resolves against var()', () => {
    expect(alpha(colors.accent, 0.12))
      .toBe(`color-mix(in srgb, ${colors.accent} 12.0%, transparent)`)
  })

  it('works on a literal too', () => {
    expect(alpha('#00C9DB', 0.3)).toBe('color-mix(in srgb, #00C9DB 30.0%, transparent)')
  })
})

describe('the palette itself', () => {
  it('carries no object-class colours — those belong to the adapter manifests', () => {
    expect(Object.keys(colors).filter((k) => /^box[A-Z]/.test(k))).toEqual([])
  })

  it('exposes no scene colours, so they cannot leak into an inline style', () => {
    for (const k of ['gridMajor', 'gridMinor', 'gizmoX', 'vehicleMarker']) {
      expect(colors).not.toHaveProperty(k)
    }
  })

  it('keeps DATA colours literal — a sensor identity is not themed', () => {
    for (const k of ['sensorTop', 'radarFront', 'camFront']) {
      expect((colors as Record<string, string>)[k]).toMatch(HEX)
    }
  })
})

describe('initialTheme', () => {
  it('returns a valid theme name', () => {
    expect(THEMES).toContain(initialTheme())
  })
})

describe('the theme= URL parameter', () => {
  const withSearch = (search: string) => {
    window.history.replaceState({}, '', `/${search}`)
    return initialTheme()
  }

  it('wins over everything else', () => {
    try { localStorage.setItem('egolens-theme', 'dark') } catch { /* private mode */ }
    expect(withSearch('?theme=light')).toBe('light')
    expect(withSearch('?theme=dark')).toBe('dark')
  })

  it('falls through to the stored choice when absent', () => {
    try { localStorage.setItem('egolens-theme', 'light') } catch { /* private mode */ }
    expect(withSearch('?dataset=nuscenes')).toBe('light')
  })

  it('warns and falls through on a value it does not recognise', () => {
    // Whether the fallthrough lands on the stored choice or the OS depends on
    // the environment; what matters is that the bogus value is not adopted.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const got = withSearch('?theme=solarized')
    expect(THEMES).toContain(got)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0].join(' ')).toContain('solarized')
    warn.mockRestore()
  })
})
