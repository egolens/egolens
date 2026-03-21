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

/** User opened the GitHub star modal */
export function trackStarModalOpen(source: 'mobile' | 'desktop') {
  track('star_modal_open', { source })
}

/** User clicked "Star us on GitHub" in the modal */
export function trackStarClick(source: 'mobile' | 'desktop') {
  track('star_click', { source })
}

/** User dismissed the star modal without clicking */
export function trackStarDismiss(source: 'mobile' | 'desktop') {
  track('star_dismiss', { source })
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
