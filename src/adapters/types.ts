import type { DatasetManifest } from '../types/dataset'

/** Evidence available before any dataset file body is read. */
export interface DatasetDetectionEvidence {
  readonly entryNames: readonly string[]
}

/**
 * The stable strategy boundary used by detection and scene-load orchestration.
 *
 * Phase 1 deliberately keeps legacy execution behind a prepared legacy plan.
 * Recipe-backed strategies return a compiled plan through this same method;
 * later migration phases replace the legacy plans one dataset at a time.
 */
export interface DatasetAdapter<TPrepared extends PreparedDatasetAdapter = PreparedDatasetAdapter> {
  readonly id: string
  readonly kind: 'legacy' | 'recipe'
  readonly manifest: DatasetManifest
  matches(evidence: DatasetDetectionEvidence): boolean
  prepare(): TPrepared
}

export interface PreparedLegacyDatasetAdapter {
  readonly kind: 'legacy'
  readonly adapterId: string
  readonly manifest: DatasetManifest
}

export interface PreparedRecipeDatasetAdapter {
  readonly kind: 'recipe'
  readonly adapterId: string
  readonly manifest: DatasetManifest
  readonly compiledRecipe: unknown
}

export type PreparedDatasetAdapter =
  | PreparedLegacyDatasetAdapter
  | PreparedRecipeDatasetAdapter
