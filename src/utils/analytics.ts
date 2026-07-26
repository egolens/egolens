/**
 * Lightweight GA4 event helper.
 * Calls gtag() if available, otherwise silently no-ops.
 */

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

function track(event: string, params?: Record<string, string | number | boolean>) {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', event, params)
  }
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

/** User loaded a dataset */
export function trackDatasetLoad(dataset: string, source: DataSource) {
  track('dataset_load', { dataset, source })
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
