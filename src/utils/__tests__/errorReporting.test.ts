/**
 * @vitest-environment happy-dom
 *
 * Unit tests for errorReporting.ts.
 *
 * The behaviour that matters here is not "an event is sent" but "the right
 * number of events are sent". A component that throws during render throws on
 * every frame, so an un-deduplicated reporter turns one bug into thousands of
 * GA4 events and blows the property's quota while adding no information.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reportError, installGlobalErrorHandlers, resetErrorReportingForTests } from '../errorReporting'

/** Captured gtag('event', name, params) calls */
let events: { name: string; params: Record<string, unknown> }[] = []

beforeEach(() => {
  events = []
  resetErrorReportingForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(window as unknown as { gtag: (...a: unknown[]) => void }).gtag = (
    _kind: unknown,
    name: unknown,
    params: unknown,
  ) => {
    events.push({ name: name as string, params: (params ?? {}) as Record<string, unknown> })
  }
})

describe('reportError', () => {
  it('sends an exception event carrying feature, fatality, and message', () => {
    reportError(new TypeError('Cannot read properties of undefined'), 'LidarProjectionOverlay', false)

    expect(events).toHaveLength(1)
    expect(events[0].name).toBe('exception')
    expect(events[0].params.feature).toBe('LidarProjectionOverlay')
    expect(events[0].params.fatal).toBe(false)
    expect(events[0].params.description).toContain('TypeError')
    expect(events[0].params.description).toContain('Cannot read properties of undefined')
  })

  it('reports a repeated failure only once', () => {
    // A render that throws does so every frame — this is the realistic shape.
    for (let i = 0; i < 100; i++) {
      reportError(new TypeError('same failure'), 'LidarProjectionOverlay', false)
    }
    expect(events).toHaveLength(1)
  })

  it('keeps distinct failures distinct', () => {
    reportError(new TypeError('failure A'), 'LidarProjectionOverlay', false)
    reportError(new TypeError('failure B'), 'LidarProjectionOverlay', false)
    reportError(new TypeError('failure A'), 'CameraSegOverlay', false)

    expect(events).toHaveLength(3)
  })

  it('stops reporting past the per-page cap', () => {
    for (let i = 0; i < 200; i++) {
      reportError(new Error(`distinct failure ${i}`), 'stress', false)
    }
    expect(events.length).toBeLessThanOrEqual(20)
    expect(events.length).toBeGreaterThan(0)
  })

  it('clips description to GA4’s 100-character parameter limit', () => {
    reportError(new Error('x'.repeat(500)), 'longmessage', true)
    expect((events[0].params.description as string).length).toBe(100)
  })

  it('handles thrown values that are not Errors', () => {
    reportError('a bare string', 'stringThrow', false)
    reportError({ weird: true }, 'objectThrow', false)
    reportError(undefined, 'undefinedThrow', false)

    expect(events).toHaveLength(3)
    for (const event of events) {
      expect(typeof event.params.description).toBe('string')
      expect((event.params.description as string).length).toBeGreaterThan(0)
    }
  })

  it('marks fatal separately so crashes can be split from degraded subtrees', () => {
    reportError(new Error('lost the app'), 'LidarViewer', true)
    reportError(new Error('lost one overlay'), 'KeypointOverlay', false)

    expect(events[0].params.fatal).toBe(true)
    expect(events[1].params.fatal).toBe(false)
  })
})

describe('installGlobalErrorHandlers', () => {
  it('reports uncaught errors that never reach a React boundary', () => {
    installGlobalErrorHandlers()

    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('from a worker callback'), message: 'boom' }),
    )

    expect(events).toHaveLength(1)
    expect(events[0].params.feature).toBe('window')
    expect(events[0].params.fatal).toBe(true)
  })

  it('ignores error events with no error object (img/script 404s)', () => {
    installGlobalErrorHandlers()

    // Failed subresource loads fire 'error' on window but are not app crashes.
    window.dispatchEvent(new ErrorEvent('error', { message: 'failed to load image' }))

    expect(events).toHaveLength(0)
  })

  it('reports unhandled promise rejections as non-fatal', () => {
    installGlobalErrorHandlers()

    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error('a fetch nobody awaited')
    window.dispatchEvent(event)

    expect(events).toHaveLength(1)
    expect(events[0].params.feature).toBe('promise')
    expect(events[0].params.fatal).toBe(false)
  })
})
