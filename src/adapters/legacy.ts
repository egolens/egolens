import type { DatasetManifest } from '../types/dataset'
import type {
  DatasetAdapter,
  DatasetDetectionEvidence,
  PreparedLegacyDatasetAdapter,
} from './types'

/** Keeps current dataset loaders operational behind the new strategy seam. */
export class LegacyDatasetAdapter implements DatasetAdapter<PreparedLegacyDatasetAdapter> {
  readonly kind = 'legacy' as const
  readonly manifest: DatasetManifest

  constructor(manifest: DatasetManifest) {
    this.manifest = manifest
  }

  get id(): string {
    return this.manifest.id
  }

  matches(evidence: DatasetDetectionEvidence): boolean {
    const entries = new Set(evidence.entryNames)
    return this.manifest.requiredComponents.every((component) => entries.has(component))
  }

  prepare(): PreparedLegacyDatasetAdapter {
    return {
      kind: 'legacy',
      adapterId: this.id,
      manifest: this.manifest,
    }
  }
}
