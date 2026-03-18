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

/** User loaded a dataset (URL or local files) */
export function trackDatasetLoad(dataset: string, source: 'url' | 'local' | 'preset') {
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
