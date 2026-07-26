/**
 * @vitest-environment happy-dom
 *
 * Integration tests for loadTelemetry.ts against the real store.
 *
 * The funnel is wired as a subscription rather than as calls inside each
 * loader, which buys coverage of paths nobody remembered to instrument but
 * moves the risk into the subscription itself: if it watches the wrong
 * transition, every load reports nothing and the dashboard reads as "no one
 * loads anything". So these drive actual store transitions rather than calling
 * the reporters directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useSceneStore } from '../../stores/useSceneStore'
import { installLoadTelemetry, resetLoadTelemetryForTests } from '../loadTelemetry'
import { trackDatasetLoad, resetPendingLoadForTests } from '../analytics'

let events: { name: string; params: Record<string, unknown> }[] = []
let uninstall: (() => void) | null = null

function eventsNamed(name: string) {
  return events.filter((e) => e.name === name)
}

beforeEach(() => {
  events = []
  resetPendingLoadForTests()
  resetLoadTelemetryForTests()
  ;(window as unknown as { gtag: (...a: unknown[]) => void }).gtag = (
    _kind: unknown,
    name: unknown,
    params: unknown,
  ) => {
    events.push({ name: name as string, params: (params ?? {}) as Record<string, unknown> })
  }
  useSceneStore.setState({ status: 'idle', errorCode: null, loadStep: 'opening', totalFrames: 0 })
  uninstall = installLoadTelemetry()
})

afterEach(() => {
  uninstall?.()
  uninstall = null
})

describe('installLoadTelemetry', () => {
  it('reports success when the store becomes ready', () => {
    trackDatasetLoad('argoverse2', 'url_manual', 'https://my-bucket.s3.amazonaws.com/logs/')
    useSceneStore.setState({ status: 'loading' })
    useSceneStore.setState({ status: 'ready', totalFrames: 157 })

    const [success] = eventsNamed('dataset_load_success')
    expect(success).toBeDefined()
    expect(success.params.frame_count).toBe(157)
    expect(success.params.source).toBe('url_manual')
  })

  it('reports the failure cause and the step it died in', () => {
    trackDatasetLoad('waymo', 'url_manual', 'https://av.internal.example/logs/')
    useSceneStore.setState({ status: 'loading', loadStep: 'parsing' })
    useSceneStore.setState({ status: 'error', errorCode: 'CORS' })

    const [failure] = eventsNamed('dataset_load_error')
    expect(failure).toBeDefined()
    expect(failure.params.error_code).toBe('CORS')
    // The step that was running when it threw, not the one after.
    expect(failure.params.error_stage).toBe('parsing')
    expect(failure.params.source).toBe('url_manual')
  })

  it('falls back to UNKNOWN when a path fails without classifying itself', () => {
    trackDatasetLoad('nuscenes', 'local')
    useSceneStore.setState({ status: 'loading', loadStep: 'workers' })
    useSceneStore.setState({ status: 'error', errorCode: null })

    expect(eventsNamed('dataset_load_error')[0].params.error_code).toBe('UNKNOWN')
  })

  it('ignores state changes that are not status transitions', () => {
    trackDatasetLoad('argoverse2', 'preset', 'https://argoverse.s3.us-east-1.amazonaws.com/x/')
    useSceneStore.setState({ status: 'loading' })
    // Frame scrubbing, toggles, progress ticks — none of these end a load.
    useSceneStore.setState({ loadProgress: 0.5 })
    useSceneStore.setState({ currentFrameIndex: 12 })
    useSceneStore.setState({ loadStep: 'first-frame' })

    expect(eventsNamed('dataset_load_success')).toHaveLength(0)
    expect(eventsNamed('dataset_load_error')).toHaveLength(0)
  })

  it('reports time-to-first-frame once per page, not once per scene', () => {
    trackDatasetLoad('argoverse2', 'preset', 'https://argoverse.s3.us-east-1.amazonaws.com/x/')
    useSceneStore.setState({ status: 'loading' })
    useSceneStore.setState({ status: 'ready', totalFrames: 157 })

    // Switching scenes loads again, but the visitor already saw a frame.
    trackDatasetLoad('argoverse2', 'preset', 'https://argoverse.s3.us-east-1.amazonaws.com/x/')
    useSceneStore.setState({ status: 'loading' })
    useSceneStore.setState({ status: 'ready', totalFrames: 200 })

    expect(eventsNamed('first_frame_render')).toHaveLength(1)
    expect(eventsNamed('dataset_load_success')).toHaveLength(2)
  })

  it('stops reporting once uninstalled', () => {
    uninstall?.()
    uninstall = null

    trackDatasetLoad('waymo', 'local')
    useSceneStore.setState({ status: 'loading' })
    useSceneStore.setState({ status: 'ready', totalFrames: 5 })

    expect(events).toHaveLength(1) // only the attempt, which is not subscription-driven
  })
})
