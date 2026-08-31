import type { CoreOperatorDescriptor, OperatorJsonSchema } from './registry'
import { OperatorRegistry } from './registry'

const objectContract: OperatorJsonSchema = {
  type: 'object',
  additionalProperties: true,
}

function coreOperator(name: string, execution: 'main' | 'worker' = 'worker'): CoreOperatorDescriptor {
  return {
    name,
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: objectContract,
    paramsContract: objectContract,
    outputContract: objectContract,
    execution,
    deterministic: true,
  }
}

/**
 * Compile-time descriptors for the bounded operators used by bundled recipes.
 * Phase 2 locks their names and contracts; later migration phases connect the
 * same descriptors to the existing worker implementations.
 */
export const BUNDLED_CORE_OPERATORS: readonly CoreOperatorDescriptor[] = [
  coreOperator('binary.interleaved_records'),
  coreOperator('feather.columns'),
  coreOperator('image.bind_camera_frame'),
  coreOperator('image.encoded_bytes'),
  coreOperator('json.records'),
  coreOperator('labels.attach_by_point_index'),
  coreOperator('labels.decode_camera_mask'),
  coreOperator('parquet.columns'),
  coreOperator('records.select'),
  coreOperator('relations.composite_key_join'),
  coreOperator('relations.token_join'),
  coreOperator('timeline.from_records'),
  coreOperator('tracks.derive_trajectories'),
  coreOperator('geometry.normalize_boxes2d'),
  coreOperator('geometry.normalize_boxes3d'),
  coreOperator('geometry.normalize_keypoints'),
  coreOperator('geometry.range_image_to_cartesian'),
  coreOperator('geometry.relative_poses'),
] as const

export const bundledOperatorRegistry = new OperatorRegistry(BUNDLED_CORE_OPERATORS)
