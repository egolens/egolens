import type { NormalizedCapabilityV1 } from '../runtime/normalizedScene'

export type HumanReviewCapabilityV1 =
  | 'pointClouds'
  | 'egoPoses'
  | 'cameraImages'
  | 'boxes3d'
  | 'boxes2d'
  | 'projection'
  | 'segmentation'
  | 'keypoints'
  | 'timeline'

export type HumanReviewIssueV1 =
  | 'upside-down'
  | 'mirrored'
  | 'wrong-scale'
  | 'drift'
  | 'misaligned'
  | 'out-of-sync'
  | 'wrong-labels'
  | 'other'

export const HUMAN_REVIEW_ISSUES_V1: readonly HumanReviewIssueV1[] = Object.freeze([
  'upside-down', 'mirrored', 'wrong-scale', 'drift', 'misaligned', 'out-of-sync', 'wrong-labels', 'other',
])

export interface HumanReviewItemV1 {
  readonly recipeHash: string
  readonly capability: HumanReviewCapabilityV1
  readonly frameIndices: readonly number[]
  readonly verdict: 'accepted' | 'rejected'
  readonly issue?: HumanReviewIssueV1
  /** Local-only unless the user explicitly copies it. */
  readonly note?: string
}

export function requiredHumanReviewCapabilitiesV1(
  capabilities: ReadonlySet<NormalizedCapabilityV1>,
): readonly HumanReviewCapabilityV1[] {
  const required = new Set<HumanReviewCapabilityV1>()
  if (capabilities.has('timeline')) required.add('timeline')
  if (capabilities.has('egoPoses')) required.add('egoPoses')
  if (capabilities.has('pointClouds') || capabilities.has('radarPointClouds')) required.add('pointClouds')
  if (capabilities.has('cameraImages')) required.add('cameraImages')
  if (capabilities.has('boxes3d')) required.add('boxes3d')
  if (capabilities.has('boxes2d')) required.add('boxes2d')
  if (capabilities.has('boxAssociations') || (capabilities.has('pointClouds') && capabilities.has('cameraImages'))) required.add('projection')
  if (capabilities.has('lidarSegmentation') || capabilities.has('cameraSegmentation')) required.add('segmentation')
  if (capabilities.has('keypoints3d') || capabilities.has('keypoints2d')) required.add('keypoints')
  return [...required]
}

export function reviewReceiptV1(items: readonly HumanReviewItemV1[]): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    items: items.map(({ recipeHash, capability, frameIndices, verdict, issue }) => ({
      recipeHash,
      capability,
      frameIndices: [...frameIndices],
      verdict,
      ...(issue ? { issue } : {}),
    })),
  }
}
