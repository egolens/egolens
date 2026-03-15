/**
 * Unit tests for URL validation and normalization utility.
 */

import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl } from '../urlValidation'
import { DataLoadError } from '../errors'

describe('normalizeBaseUrl', () => {
  it('adds trailing slash to HTTPS URL', () => {
    expect(normalizeBaseUrl('https://example.com/data'))
      .toBe('https://example.com/data/')
  })

  it('preserves existing trailing slash', () => {
    expect(normalizeBaseUrl('https://example.com/data/'))
      .toBe('https://example.com/data/')
  })

  it('strips query string and hash', () => {
    expect(normalizeBaseUrl('https://example.com/data?key=val#section'))
      .toBe('https://example.com/data/')
  })

  it('trims whitespace', () => {
    expect(normalizeBaseUrl('  https://example.com/data  '))
      .toBe('https://example.com/data/')
  })

  it('allows http://localhost for dev', () => {
    expect(normalizeBaseUrl('http://localhost:3000/waymo_data'))
      .toBe('http://localhost:3000/waymo_data/')
  })

  it('allows http://127.0.0.1 for dev', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8080/data'))
      .toBe('http://127.0.0.1:8080/data/')
  })

  it('strips query from localhost URLs', () => {
    expect(normalizeBaseUrl('http://localhost:3000/data?foo=bar#hash'))
      .toBe('http://localhost:3000/data/')
  })

  it('throws DataLoadError on empty input', () => {
    expect(() => normalizeBaseUrl('')).toThrow(DataLoadError)
    expect(() => normalizeBaseUrl('   ')).toThrow(DataLoadError)
  })

  it('throws DataLoadError on HTTP (non-localhost)', () => {
    expect(() => normalizeBaseUrl('http://example.com/data')).toThrow(DataLoadError)
    try {
      normalizeBaseUrl('http://example.com/data')
    } catch (e) {
      expect(e).toBeInstanceOf(DataLoadError)
      expect((e as DataLoadError).code).toBe('UNKNOWN')
      expect((e as DataLoadError).message).toContain('https://')
    }
  })

  it('throws DataLoadError on invalid URL', () => {
    expect(() => normalizeBaseUrl('not-a-url')).toThrow(DataLoadError)
  })

  it('handles S3-style URLs correctly', () => {
    const url = 'https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/val/01bb304d/'
    expect(normalizeBaseUrl(url)).toBe(url)
  })

  it('normalizes URL with redundant path segments', () => {
    expect(normalizeBaseUrl('https://example.com:443/data'))
      .toBe('https://example.com/data/')
  })
})
