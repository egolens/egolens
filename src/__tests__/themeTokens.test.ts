/**
 * Token hygiene — colours must come from the token, not from a copy of it.
 *
 * A hand-written literal does not follow the token it was copied from. Six
 * sites had drifted to `rgba(0, 200, 219, …)` against an `accentBlue` of
 * `#00C9DB`, off by one in green, and one of them sat in the same declaration
 * as the correct token. Nothing caught it because nothing was looking.
 *
 * This matters beyond tidiness: a light theme changes what the tokens are, and
 * any site holding a copy stays dark.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { colors, alpha } from '../theme'

const SRC = join(__dirname, '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      sourceFiles(path, out)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

const files = sourceFiles(SRC).filter((f) => !f.endsWith('theme.ts'))
const rel = (f: string) => f.slice(SRC.length + 1)

describe('alpha', () => {
  it('derives an rgba string from a hex token', () => {
    expect(alpha('#00C9DB', 0.12)).toBe('rgba(0, 201, 219, 0.12)')
    expect(alpha('#00E89D', 0.3)).toBe('rgba(0, 232, 157, 0.3)')
  })

  it('round-trips the channels exactly', () => {
    expect(alpha('#000000', 1)).toBe('rgba(0, 0, 0, 1)')
    expect(alpha('#FFFFFF', 0)).toBe('rgba(255, 255, 255, 0)')
  })
})

describe('no source file holds a copy of a token colour', () => {
  // DATA tokens are excluded: adapters and manifests legitimately repeat those
  // hexes, and a theme must not move them anyway.
  const CHROME_AND_SCENE = [
    'accent', 'accentBlue', 'danger',
    'bgDeep', 'bgBase', 'bgSurface', 'bgOverlay', 'bgHover',
    'border', 'borderSubtle',
    'textPrimary', 'textSecondary', 'textDim',
    'gridMajor', 'gridMinor', 'vehicleMarker',
  ] as const

  it.each(CHROME_AND_SCENE)('%s is not duplicated as a hex literal', (token) => {
    const hex = (colors as Record<string, string>)[token]
    expect(hex, `${token} is missing from the palette`).toMatch(/^#[0-9A-Fa-f]{6}$/)

    const offenders = files.filter((f) =>
      new RegExp(hex, 'i').test(readFileSync(f, 'utf8')),
    )
    expect(
      offenders.map(rel),
      `use colors.${token} instead of the literal ${hex}`,
    ).toEqual([])
  })

  it('has no hand-rolled rgba() of an accent colour', () => {
    // These are the ones that drift. alpha(colors.x, a) is the replacement.
    const channelsOf = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const offenders: string[] = []
    for (const token of ['accent', 'accentBlue'] as const) {
      const [r, g, b] = channelsOf(colors[token])
      // Match the exact channels and near-misses of ±1 per channel, which is
      // how the original drift looked.
      const near = (v: number) => `(?:${v - 1}|${v}|${v + 1})`
      const re = new RegExp(`rgba\\(\\s*${near(r)},\\s*${near(g)},\\s*${near(b)}\\s*,`)
      for (const f of files) {
        if (re.test(readFileSync(f, 'utf8'))) offenders.push(`${rel(f)} (${token})`)
      }
    }
    expect(offenders, 'use alpha(colors.<token>, a)').toEqual([])
  })
})

describe('the palette itself', () => {
  it('carries no object-class colours — those belong to the adapter manifests', () => {
    const leftovers = Object.keys(colors).filter((k) => /^box[A-Z]/.test(k))
    expect(leftovers).toEqual([])
  })

  it('keeps danger separate from radarFront even though they share a hex', () => {
    // Same value today; different meaning, so a theme can move one alone.
    expect(colors.danger).toBe(colors.radarFront)
    expect(Object.keys(colors)).toContain('danger')
  })
})
