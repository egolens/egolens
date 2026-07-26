/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the load-funnel events in analytics.ts.
 *
 * The funnel's whole value is that an attempt is always followed by exactly one
 * outcome. If a failure can go unreported, the success rate reads high and a
 * broken data path looks like an unpopular one — the specific confusion this
 * instrumentation exists to prevent.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  trackDatasetLoad,
  trackDatasetLoadSuccess,
  trackDatasetLoadError,
  trackFirstFrameRender,
  resetPendingLoadForTests,
} from '../analytics'

let events: { name: string; params: Record<string, unknown> }[] = []

function eventsNamed(name: string) {
  return events.filter((e) => e.name === name)
}

beforeEach(() => {
  events = []
  resetPendingLoadForTests()
  ;(window as unknown as { gtag: (...a: unknown[]) => void }).gtag = (
    _kind: unknown,
    name: unknown,
    params: unknown,
  ) => {
    events.push({ name: name as string, params: (params ?? {}) as Record<string, unknown> })
  }
})

describe('load funnel', () => {
  it('carries source and host family on the attempt', () => {
    trackDatasetLoad('argoverse2', 'url_manual', 'https://my-bucket.s3.amazonaws.com/logs/')

    const [attempt] = eventsNamed('dataset_load')
    expect(attempt.params.dataset).toBe('argoverse2')
    expect(attempt.params.source).toBe('url_manual')
    expect(attempt.params.data_host_kind).toBe('aws_s3')
  })

  it('reports local loads with no host', () => {
    trackDatasetLoad('waymo', 'local')
    expect(eventsNamed('dataset_load')[0].params.data_host_kind).toBe('none')
  })

  it('attributes success back to the origin that started the load', () => {
    // The store subscription that reports success has no idea how the load
    // began, so the attempt's source must survive to the outcome.
    trackDatasetLoad('nuscenes', 'url_manual', 'https://storage.googleapis.com/b/')
    trackDatasetLoadSuccess(199)

    const [success] = eventsNamed('dataset_load_success')
    expect(success.params.source).toBe('url_manual')
    expect(success.params.dataset).toBe('nuscenes')
    expect(success.params.frame_count).toBe(199)
    expect(typeof success.params.load_ms).toBe('number')
    expect(success.params.load_ms as number).toBeGreaterThanOrEqual(0)
  })

  it('attributes failure back to the origin, with cause and stage', () => {
    trackDatasetLoad('waymo', 'url_manual', 'https://av.internal.example/logs/')
    trackDatasetLoadError('CORS', 'opening')

    const [failure] = eventsNamed('dataset_load_error')
    expect(failure.params.source).toBe('url_manual')
    expect(failure.params.dataset).toBe('waymo')
    expect(failure.params.error_code).toBe('CORS')
    expect(failure.params.error_stage).toBe('opening')
  })

  it('emits exactly one outcome per attempt', () => {
    trackDatasetLoad('argoverse2', 'preset', 'https://argoverse.s3.us-east-1.amazonaws.com/x/')
    trackDatasetLoadSuccess(157)
    // A late duplicate — a second 'ready' transition, say — must not double-count.
    trackDatasetLoadSuccess(157)

    expect(eventsNamed('dataset_load_success')).toHaveLength(1)
  })

  it('never reports an outcome for an attempt that never happened', () => {
    trackDatasetLoadSuccess(10)
    expect(eventsNamed('dataset_load_success')).toHaveLength(0)
  })

  it('still reports a failure that arrives with no attempt on record', () => {
    // Losing the attempt is bad; silently losing the failure too would make a
    // broken path indistinguishable from an unused one.
    trackDatasetLoadError('NOT_FOUND', 'parsing')

    const [failure] = eventsNamed('dataset_load_error')
    expect(failure.params.error_code).toBe('NOT_FOUND')
    expect(failure.params.source).toBe('unknown')
  })

  it('separates consecutive loads', () => {
    trackDatasetLoad('nuscenes', 'preset', 'https://data.egolens.org/nuscenes/')
    trackDatasetLoadSuccess(40)
    trackDatasetLoad('waymo', 'local')
    trackDatasetLoadError('PARSE', 'workers')

    expect(eventsNamed('dataset_load_success')[0].params.source).toBe('preset')
    expect(eventsNamed('dataset_load_error')[0].params.source).toBe('local')
  })

  it('times the first frame from navigation start, not from the attempt', () => {
    trackFirstFrameRender('argoverse2')

    const [render] = eventsNamed('first_frame_render')
    expect(render.params.dataset).toBe('argoverse2')
    // performance.now() is relative to navigation start by definition, which is
    // what makes this the wait the visitor felt rather than the fetch duration.
    expect(typeof render.params.ttfr_ms).toBe('number')
    expect(render.params.ttfr_ms as number).toBeGreaterThanOrEqual(0)
  })
})
