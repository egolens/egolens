/**
 * Hosted datasets offered on the landing page.
 *
 * Kept out of App.tsx so the "is this our data or theirs?" test is a plain unit
 * test rather than one that has to mount the whole app.
 *
 * That distinction is the point: someone opening a preset is evaluating
 * EgoLens, someone pointing it at their own bucket is using it. The landing
 * page and the load handler share one list so the two can never disagree.
 */

export interface Preset {
  dataset: 'nuscenes' | 'argoverse2' | 'waymo'
  label: string
  url: string
  note: string
  shortNote: string
}

export const PRESETS: readonly Preset[] = [
  {
    dataset: 'nuscenes',
    label: 'Try nuScenes mini',
    url: 'https://data.egolens.org/nuscenes/',
    note: 'Hosted by EgoLens · 10 scenes',
    shortNote: '10 scenes',
  },
  {
    dataset: 'argoverse2',
    label: 'Try Argoverse 2',
    url: 'https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/sensor/val/',
    note: 'Via Argoverse S3 · validation split',
    shortNote: 'validation split',
  },
]

/** Trailing slashes and surrounding space vary by how a URL reached us. */
function canonical(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * True when a URL points at data we host or curate rather than the user's own.
 *
 * Deliberately an exact match: a preset's bucket may host other people's data
 * too (the Argoverse S3 bucket is public), and a prefix match would misreport
 * someone browsing a different split of it as a preset visitor.
 */
export function isPresetUrl(url: string): boolean {
  const target = canonical(url)
  return PRESETS.some((preset) => canonical(preset.url) === target)
}
