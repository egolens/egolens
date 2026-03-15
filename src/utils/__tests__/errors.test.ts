/**
 * Unit tests for DataLoadError type system.
 *
 * Covers: DataLoadError construction, classifyFetchError, classifyHttpError.
 */

import { describe, it, expect } from 'vitest'
import {
  DataLoadError,
  classifyFetchError,
  classifyHttpError,
} from '../errors'

describe('DataLoadError', () => {
  it('extends Error with code and url fields', () => {
    const err = new DataLoadError('test message', 'CORS', 'https://example.com', true)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(DataLoadError)
    expect(err.name).toBe('DataLoadError')
    expect(err.message).toBe('test message')
    expect(err.code).toBe('CORS')
    expect(err.url).toBe('https://example.com')
    expect(err.retryable).toBe(true)
  })

  it('defaults retryable to false', () => {
    const err = new DataLoadError('msg', 'NOT_FOUND')
    expect(err.retryable).toBe(false)
    expect(err.url).toBeUndefined()
  })
})

describe('classifyFetchError', () => {
  it('classifies TypeError("Failed to fetch") as CORS', () => {
    const err = classifyFetchError(new TypeError('Failed to fetch'), 'https://s3.example.com/data')
    expect(err.code).toBe('CORS')
    expect(err.retryable).toBe(true)
    expect(err.url).toBe('https://s3.example.com/data')
  })

  it('classifies TypeError with "network" as CORS', () => {
    const err = classifyFetchError(new TypeError('A network error occurred'), 'https://example.com')
    expect(err.code).toBe('CORS')
    expect(err.retryable).toBe(true)
  })

  it('classifies AbortError as TIMEOUT', () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError')
    const err = classifyFetchError(abortErr, 'https://example.com/big.parquet')
    expect(err.code).toBe('TIMEOUT')
    expect(err.retryable).toBe(true)
  })

  it('classifies other Error as UNKNOWN', () => {
    const err = classifyFetchError(new Error('Something weird'), 'https://example.com')
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toBe('Something weird')
  })

  it('classifies non-Error values as UNKNOWN', () => {
    const err = classifyFetchError('string error', 'https://example.com')
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toBe('string error')
  })
})

describe('classifyHttpError', () => {
  it('classifies 404 as NOT_FOUND', () => {
    const err = classifyHttpError(404, 'https://example.com/missing.feather')
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toContain('missing.feather')
    expect(err.retryable).toBe(false)
  })

  it('classifies 403 as CORS', () => {
    const err = classifyHttpError(403, 'https://example.com/secret')
    expect(err.code).toBe('CORS')
    expect(err.retryable).toBe(false)
  })

  it('classifies 416 as RANGE', () => {
    const err = classifyHttpError(416, 'https://example.com/data.parquet')
    expect(err.code).toBe('RANGE')
  })

  it('classifies 500 as UNKNOWN retryable', () => {
    const err = classifyHttpError(500, 'https://example.com/api')
    expect(err.code).toBe('UNKNOWN')
    expect(err.retryable).toBe(true)
  })

  it('classifies 400 as UNKNOWN non-retryable', () => {
    const err = classifyHttpError(400, 'https://example.com/bad')
    expect(err.code).toBe('UNKNOWN')
    expect(err.retryable).toBe(false)
  })
})
