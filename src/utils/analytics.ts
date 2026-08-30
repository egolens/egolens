/**
 * Lightweight GA4 event helper.
 * Calls gtag() if available, otherwise silently no-ops.
 */

import { classifyDataHost } from './dataHost'
import { getDeployment } from './analyticsBootstrap'

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
    dataLayer?: unknown[]
  }
}

function track(event: string, params?: Record<string, string | number | boolean>) {
  if (typeof window === 'undefined' || !window.gtag) return
  // Every event carries where it came from. Without it, a clone running locally
  // and the hosted build are one undifferentiated blob — and local runs are the
  // larger half.
  window.gtag('event', event, { ...params, deployment: getDeployment() })
}

/**
 * Where the data a user opened came from.
 *
 * The split that matters is "our data" versus "their data": someone browsing a
 * preset is evaluating the tool, someone pointing it at their own bucket is
 * using it. Everything downstream — whether to build the BYO adapter, whether
 * it worked — reads this field, so the values must stay mutually exclusive.
 */
export type DataSource =
  /** Landing-page preset — data we host or curate */
  | 'preset'
  /** A URL the user supplied themselves */
  | 'url_manual'
  /** Arrived through a Share View link (carries view params) */
  | 'url_shared'
  /** Arrived at a ?dataset&data URL with no view params — embed or bookmark */
  | 'url_direct'
  /** Local folder, dropped or picked */
  | 'local'

/**
 * A load attempt and everything the outcome events need to describe it.
 *
 * Success and failure are reported by a store subscription that has no idea how
 * the load was started, so the origin is parked here rather than threaded
 * through every call site. Only one load runs at a time, so a single slot is
 * enough.
 */
let pendingLoad: { dataset: string; source: DataSource; startedAt: number } | null = null

/** User started loading a dataset. Always paired with a success or error event. */
export function trackDatasetLoad(dataset: string, source: DataSource, dataUrl?: string | null) {
  pendingLoad = { dataset, source, startedAt: performance.now() }
  track('dataset_load', {
    dataset,
    source,
    data_host_kind: classifyDataHost(dataUrl),
  })
}

/**
 * The scene became viewable.
 *
 * `load_ms` measures the attempt, not the page: it is how long this data source
 * took to open, which is the number that says whether someone's own bucket is
 * usable with EgoLens.
 */
export function trackDatasetLoadSuccess(frameCount: number) {
  if (!pendingLoad) return
  track('dataset_load_success', {
    dataset: pendingLoad.dataset,
    source: pendingLoad.source,
    load_ms: Math.round(performance.now() - pendingLoad.startedAt),
    frame_count: frameCount,
  })
  pendingLoad = null
}

/**
 * The load failed.
 *
 * `error_stage` is the pipeline step it died in, which separates "your URL is
 * wrong" from "your server refuses range requests" from "the data parsed but
 * the frames would not decode" — three failures that need three different fixes
 * and are indistinguishable in the message alone.
 */
export function trackDatasetLoadError(errorCode: string, errorStage: string) {
  track('dataset_load_error', {
    dataset: pendingLoad?.dataset ?? 'unknown',
    source: pendingLoad?.source ?? 'unknown',
    error_code: errorCode,
    error_stage: errorStage,
    load_ms: pendingLoad ? Math.round(performance.now() - pendingLoad.startedAt) : 0,
  })
  pendingLoad = null
}

/**
 * First frame painted, timed from navigation start rather than from the load
 * attempt — bundle download, worker startup and all.
 *
 * This is the wait the visitor actually experiences and the one that predicts
 * whether they stay, which `load_ms` alone would understate.
 */
export function trackFirstFrameRender(dataset: string) {
  track('first_frame_render', {
    dataset,
    ttfr_ms: Math.round(performance.now()),
  })
}

/** Test seam — clears the in-flight load so cases do not leak into each other. */
export function resetPendingLoadForTests() {
  pendingLoad = null
}

/** User clicked Share View */
export function trackShareView(dataset: string) {
  track('share_view', { dataset })
}

/** User clicked a preset (Try nuScenes / Try AV2) */
export function trackPresetClick(dataset: string) {
  track('preset_click', { dataset })
}

/** User switched segment */
export function trackSegmentSwitch(dataset: string) {
  track('segment_switch', { dataset })
}

/** User changed colormap mode */
export function trackColormapChange(mode: string) {
  track('colormap_change', { mode })
}

/** User switched to POV camera or back to orbit */
export function trackPovSwitch(camera: string) {
  track('pov_switch', { camera })
}

/** A URL configured the initial theme/accent. Values stay deliberately low-cardinality. */
export function trackThemeConfig(theme: string | null, accent: string | null) {
  track('theme_config', {
    theme: theme ?? 'default',
    custom_accent: accent !== null,
  })
}

/** User or embed host switched the UI theme. `theme` is the resolved theme. */
export function trackThemeChange(theme: string, source: 'toggle' | 'embed' = 'toggle', accent?: string | null) {
  track('theme_change', {
    theme,
    source,
    ...(accent === undefined ? {} : { custom_accent: accent !== null }),
  })
}

/** User toggled an overlay (keypoints, segmentation, boxes, etc.) */
export function trackOverlayToggle(overlay: string, enabled: boolean) {
  track('overlay_toggle', { overlay, enabled })
}

/**
 * Which layout surfaced the star prompt.
 *
 * Named `placement`, not `source`: GA4 custom dimensions are keyed by parameter
 * name across all events, so reusing `source` here would blend 'mobile' and
 * 'desktop' into the same column as the dataset origins above and make the
 * adoption metric unreadable.
 */
export type StarPlacement = 'mobile' | 'desktop'

/** User opened the GitHub star modal */
export function trackStarModalOpen(placement: StarPlacement) {
  track('star_modal_open', { placement })
}

/** User clicked "Star us on GitHub" in the modal */
export function trackStarClick(placement: StarPlacement) {
  track('star_click', { placement })
}

/** User dismissed the star modal without clicking */
export function trackStarDismiss(placement: StarPlacement) {
  track('star_dismiss', { placement })
}

/** Camera settled after WASD/IJKL movement (2s idle) */
export function trackCameraSettle(params: {
  px: number; py: number; pz: number
  tx: number; ty: number; tz: number
  worldMode: boolean
  segment: string
  frame: number
}) {
  track('camera_settle', {
    px: Math.round(params.px * 10) / 10,
    py: Math.round(params.py * 10) / 10,
    pz: Math.round(params.pz * 10) / 10,
    tx: Math.round(params.tx * 10) / 10,
    ty: Math.round(params.ty * 10) / 10,
    tz: Math.round(params.tz * 10) / 10,
    world_mode: params.worldMode,
    segment: params.segment,
    frame: params.frame,
  })
}

/** User pressed a keyboard shortcut */
export function trackKeyboardShortcut(key: string) {
  track('keyboard_shortcut', { key })
}

/**
 * An uncaught error was caught by a boundary or a global handler.
 *
 * Send through `reportError` in errorReporting.ts rather than calling this
 * directly — it deduplicates, which matters because a broken render throws once
 * per frame. `description` is clipped to GA4's 100-character parameter limit.
 */
export function trackException(params: { description: string; feature: string; fatal: boolean }) {
  track('exception', {
    description: params.description.slice(0, 100),
    feature: params.feature,
    fatal: params.fatal,
  })
}

/**
 * A dropped or picked folder contained no recognisable dataset.
 *
 * This is the one failure the funnel could not see: it happens before any load
 * attempt, so it looked identical to a visitor who simply never tried. Roughly
 * 43% of visitors reach the page and never fire `dataset_load`, and until now
 * there was no way to tell how many of them were trying and failing.
 *
 * Reports shape, not names. `knownNames` is restricted upstream to published
 * dataset-layout directories; a folder named after a company or an unreleased
 * project contributes only to the count. That keeps the answer to "what are
 * people dropping?" available without collecting anything about who they are.
 */
export function trackFolderRejected(rejection: {
  knownNames: string[]
  dirCount: number
  looksLikeArchiveRoot: boolean
}) {
  track('folder_rejected', {
    dir_count: rejection.dirCount,
    known_names: rejection.knownNames.join(',') || 'none',
    archive_root: rejection.looksLikeArchiveRoot,
  })
}
