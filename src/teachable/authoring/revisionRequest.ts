import type { AdapterDiagnostic } from '../recipe/diagnostics'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import type { HumanReviewItemV1 } from './review'
import { declaredSensorSummaryV1, type SensorConfigurationV1 } from './sensorConfiguration'

export interface RevisionRequestInputV1 {
  readonly reviews: readonly HumanReviewItemV1[]
  readonly diagnostics: readonly AdapterDiagnostic[]
  readonly currentArtifact: EgoLensAdapterRecipeV1 | null
  readonly sensorConfiguration: SensorConfigurationV1 | null
  readonly sensorSamples?: Readonly<Record<string, readonly number[]>>
}

/**
 * The text a reviewer pastes into the Codex chat: every rejected capability
 * with its issue, sensors that are declared but never bound, layout
 * mismatches, and open self-consistency warnings. Nothing private.
 */
export function revisionRequestTextV1(input: RevisionRequestInputV1): string {
  const lines: string[] = ['Revise the adapter using my Teachable Lens review:']
  const rejected = input.reviews.filter((review) => review.verdict === 'rejected')
  for (const review of rejected) {
    lines.push(`- ${review.capability}: rejected on frames ${review.frameIndices.join(', ')}${review.issue ? ` (${review.issue})` : ''}.`)
  }
  if (input.sensorConfiguration && input.currentArtifact) {
    for (const { modality, ids } of declaredSensorSummaryV1(input.currentArtifact)) {
      const expected = input.sensorConfiguration[modality]
      if (ids.length !== expected) lines.push(`- ${modality}: ${expected} sensors are expected, ${ids.length} declared.`)
    }
  }
  for (const [sensorId, samples] of Object.entries(input.sensorSamples ?? {})) {
    if (samples.every((value) => value === 0)) lines.push(`- ${sensorId}: declared but no data reached any sampled frame.`)
  }
  for (const diagnostic of input.diagnostics.filter((item) => item.severity === 'warning')) {
    lines.push(`- ${diagnostic.code}: ${diagnostic.hint}`)
  }
  if (lines.length === 1) lines.push('- Every reviewed capability was accepted; keep the recipe and finalize.')
  return lines.join('\n')
}
