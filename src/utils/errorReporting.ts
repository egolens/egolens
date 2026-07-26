/**
 * Uncaught error reporting.
 *
 * GA4 does not collect JavaScript errors on its own — nothing arrives unless we
 * send an `exception` event ourselves. Without it a crash is indistinguishable
 * from a bored visitor: the session just ends. The LiDAR→Camera whiteout sat in
 * production for four months precisely because nothing here existed.
 *
 * Reports are deduplicated. A throwing overlay throws on every frame, and
 * shipping 30 identical events per second would drown the property and burn the
 * event quota for no extra information.
 */

import { trackException } from './analytics'

/** (feature, message) pairs already sent this page load */
const reported = new Set<string>()

/** Hard cap per page load — a pathological loop must not become a firehose */
const MAX_REPORTS = 20

/**
 * Reduce an unknown thrown value to a single identifying line.
 * GA4 truncates parameter values at 100 characters, so this stays terse and
 * leans on `feature` to say where it happened. The console keeps the full error.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return 'unserializable error'
  }
}

/**
 * Report an uncaught error.
 *
 * @param feature  Where it happened — becomes the GA4 `feature` dimension, so
 *                 use a stable identifier ('LidarProjectionOverlay'), not a
 *                 message. This is what makes crashes groupable.
 * @param fatal    True when the user lost the app or a whole view, false when a
 *                 single subtree was dropped and everything else kept working.
 * @returns        Whether this was a first sighting. Callers with extra context
 *                 to log (a component stack) should gate on it so their output
 *                 is deduplicated too — React's StrictMode double-invoke alone
 *                 would otherwise print everything twice.
 */
export function reportError(error: unknown, feature: string, fatal: boolean): boolean {
  const description = describe(error)
  const key = `${feature}|${description}`
  if (reported.has(key) || reported.size >= MAX_REPORTS) return false
  reported.add(key)

  console.error(`[egolens] uncaught in ${feature}:`, error)
  trackException({ description, feature, fatal })
  return true
}

/**
 * Catch errors that never reach a React boundary — worker callbacks, rAF
 * callbacks, event handlers, and rejected promises.
 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    // Resource load failures (img/script 404) also fire here but carry no
    // `error` object; they are not application crashes.
    if (!event.error) return
    reportError(event.error, 'window', true)
  })

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, 'promise', false)
  })
}

/** Test seam — clears the dedup set so each case starts fresh. */
export function resetErrorReportingForTests(): void {
  reported.clear()
}
