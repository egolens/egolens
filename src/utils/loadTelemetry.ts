/**
 * Load-funnel telemetry.
 *
 * `dataset_load` alone only says someone tried. It cannot distinguish "nobody
 * brings their own data" from "everybody tries and every attempt fails" — two
 * findings that demand opposite responses. These events close that gap.
 *
 * Wired as a subscription to the store's own status transitions rather than as
 * calls sprinkled through the loaders. There are seven failure paths and one
 * success path today; instrumenting each by hand means the next path added is
 * the one that goes unmeasured, and an unmeasured path looks exactly like a
 * path nobody takes.
 */

import { useSceneStore } from '../stores/useSceneStore'
import { getManifest } from '../adapters/registry'
import {
  trackDatasetLoadSuccess,
  trackDatasetLoadError,
  trackFirstFrameRender,
} from './analytics'

/** Emitted once per page: the wait before anything was visible. */
let firstFrameReported = false

export function installLoadTelemetry(): () => void {
  return useSceneStore.subscribe((state, prev) => {
    if (state.status === prev.status) return

    if (state.status === 'ready') {
      trackDatasetLoadSuccess(state.totalFrames)
      if (!firstFrameReported) {
        firstFrameReported = true
        trackFirstFrameRender(getManifest().id)
      }
      return
    }

    if (state.status === 'error') {
      // loadStep still holds the step that was running when it threw; the
      // failing transition does not advance it.
      trackDatasetLoadError(state.errorCode ?? 'UNKNOWN', prev.loadStep)
    }
  })
}

/** Test seam — lets each case observe the once-per-page first-frame event. */
export function resetLoadTelemetryForTests(): void {
  firstFrameReported = false
}
