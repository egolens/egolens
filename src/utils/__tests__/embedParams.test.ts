import { describe, it, expect } from 'vitest'
import { parseEmbedParams } from '../embedParams'

describe('parseEmbedParams', () => {
  it('returns defaults when no params present', () => {
    const p = parseEmbedParams('')
    expect(p.embed).toBe(false)
    expect(p.controls).toBe('full')
    expect(p.frame).toBeNull()
    expect(p.camera).toBeNull()
    expect(p.autoplay).toBe(false)
    expect(p.colormap).toBeNull()
    expect(p.bgcolor).toBeNull()
  })

  it('parses embed=true', () => {
    const p = parseEmbedParams('?embed=true')
    expect(p.embed).toBe(true)
  })

  it('embed=false stays false', () => {
    const p = parseEmbedParams('?embed=false')
    expect(p.embed).toBe(false)
  })

  // Controls
  it('controls=minimal', () => {
    const p = parseEmbedParams('?controls=minimal')
    expect(p.controls).toBe('minimal')
  })

  it('controls=none', () => {
    const p = parseEmbedParams('?controls=none')
    expect(p.controls).toBe('none')
  })

  it('controls=false maps to none', () => {
    const p = parseEmbedParams('?controls=false')
    expect(p.controls).toBe('none')
  })

  it('controls=invalid defaults to full', () => {
    const p = parseEmbedParams('?controls=banana')
    expect(p.controls).toBe('full')
  })

  // Frame
  it('frame=42 parses correctly', () => {
    const p = parseEmbedParams('?frame=42')
    expect(p.frame).toBe(42)
  })

  it('frame=0 is valid', () => {
    const p = parseEmbedParams('?frame=0')
    expect(p.frame).toBe(0)
  })

  it('frame=-1 is rejected', () => {
    const p = parseEmbedParams('?frame=-1')
    expect(p.frame).toBeNull()
  })

  it('frame=abc is rejected', () => {
    const p = parseEmbedParams('?frame=abc')
    expect(p.frame).toBeNull()
  })

  // Camera
  it('camera=FRONT passes through', () => {
    const p = parseEmbedParams('?camera=FRONT')
    expect(p.camera).toBe('FRONT')
  })

  it('camera=ring_front_center passes through', () => {
    const p = parseEmbedParams('?camera=ring_front_center')
    expect(p.camera).toBe('ring_front_center')
  })

  // Autoplay
  it('autoplay=true', () => {
    const p = parseEmbedParams('?autoplay=true')
    expect(p.autoplay).toBe(true)
  })

  it('autoplay absent defaults to false', () => {
    const p = parseEmbedParams('?embed=true')
    expect(p.autoplay).toBe(false)
  })

  // Colormap
  it('colormap=distance is valid', () => {
    const p = parseEmbedParams('?colormap=distance')
    expect(p.colormap).toBe('distance')
  })

  it('colormap=camera is valid', () => {
    const p = parseEmbedParams('?colormap=camera')
    expect(p.colormap).toBe('camera')
  })

  it('colormap=invalid is rejected', () => {
    const p = parseEmbedParams('?colormap=rainbow')
    expect(p.colormap).toBeNull()
  })

  // Background color
  it('bgcolor=000000 is valid (6 hex)', () => {
    const p = parseEmbedParams('?bgcolor=000000')
    expect(p.bgcolor).toBe('000000')
  })

  it('bgcolor=fff is valid (3 hex)', () => {
    const p = parseEmbedParams('?bgcolor=fff')
    expect(p.bgcolor).toBe('fff')
  })

  it('bgcolor=1a1f35ff is valid (8 hex with alpha)', () => {
    const p = parseEmbedParams('?bgcolor=1a1f35ff')
    expect(p.bgcolor).toBe('1a1f35ff')
  })

  it('bgcolor=zzzzzz is rejected', () => {
    const p = parseEmbedParams('?bgcolor=zzzzzz')
    expect(p.bgcolor).toBeNull()
  })

  it('bgcolor=#000000 (with hash) is rejected', () => {
    // The # gets URL-encoded, but even if not, we reject it
    const p = parseEmbedParams('?bgcolor=%23000000')
    expect(p.bgcolor).toBeNull()
  })

  // Origin
  it('origin param is read', () => {
    const p = parseEmbedParams('?origin=https://example.com')
    expect(p.origin).toBe('https://example.com')
  })

  // Combined
  it('parses all params together', () => {
    const p = parseEmbedParams(
      '?embed=true&controls=minimal&frame=10&camera=FRONT&autoplay=true&colormap=range&bgcolor=1a1f35&origin=https://host.com'
    )
    expect(p.embed).toBe(true)
    expect(p.controls).toBe('minimal')
    expect(p.frame).toBe(10)
    expect(p.camera).toBe('FRONT')
    expect(p.autoplay).toBe(true)
    expect(p.colormap).toBe('range')
    expect(p.bgcolor).toBe('1a1f35')
    expect(p.origin).toBe('https://host.com')
  })
})
