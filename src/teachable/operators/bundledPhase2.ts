import type { CoreOperatorDescriptor, OperatorJsonSchema } from './registry'
import { OperatorRegistry } from './registry'

const objectContract: OperatorJsonSchema = {
  type: 'object',
}

const paramsContract: OperatorJsonSchema = {
  type: 'object',
  additionalProperties: true,
}

const workerOperators = [
  'archive.npz_array',
  'binary.interleaved_records',
  'binary.pcd_records',
  'feather.columns',
  'geometry.normalize_boxes2d',
  'geometry.normalize_boxes3d',
  'geometry.normalize_keypoints',
  'geometry.range_image_to_cartesian',
  'geometry.relative_poses',
  'image.bind_camera_frame',
  'image.encoded_bytes',
  'json.records',
  'labels.attach_by_point_index',
  'labels.decode_camera_mask',
  'labels.panoptic_split',
  'parquet.columns',
  'records.select',
  'relations.composite_key_join',
  'relations.token_join',
  'timeline.join',
  'timeline.sort',
  'tracks.derive_trajectories',
] as const

/**
 * Compile-time descriptors for the generic operators referenced by bundled
 * Phase 2 recipes. Runtime execution is connected dataset-by-dataset in later
 * phases; recipe compilation never treats a missing implementation as an
 * implicit dataset-specific escape hatch.
 */
export const BUNDLED_PHASE2_OPERATOR_DESCRIPTORS: readonly CoreOperatorDescriptor[] =
  workerOperators.map((name) => ({
    name,
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: objectContract,
    paramsContract,
    outputContract: objectContract,
    execution: 'worker',
    deterministic: true,
  }))

export const bundledPhase2OperatorRegistry = new OperatorRegistry(
  BUNDLED_PHASE2_OPERATOR_DESCRIPTORS,
)
