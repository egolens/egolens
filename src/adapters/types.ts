import type { DatasetManifest } from '../types/dataset'

/** Evidence available before any dataset file body is read. */
export interface DatasetDetectionEvidence {
  readonly entryNames: readonly string[]
}

/**
 * The stable strategy boundary used by detection and scene-load orchestration.
 *
 * Every registered dataset is recipe-backed. Bundled and learned recipes use
 * this same strategy surface and the same prepared plan shape.
 */
export interface DatasetAdapter<TPrepared extends PreparedDatasetAdapter = PreparedDatasetAdapter> {
  readonly id: string
  readonly kind: 'recipe'
  readonly manifest: DatasetManifest
  matches(evidence: DatasetDetectionEvidence): boolean
  prepare(): TPrepared
}

export interface PreparedDatasetAdapter {
  readonly kind: 'recipe'
  readonly adapterId: string
  readonly manifest: DatasetManifest
  readonly compiledRecipe: unknown
}
