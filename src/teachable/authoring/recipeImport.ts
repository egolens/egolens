import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { compileRecipeV1 } from '../recipe/compiler'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import { assertValidRecipeV1 } from '../schema/validateSchema'
import { verifyArtifactHashesV1, verifySuppliedHashesV1 } from './hashes'
import type { SourceInventoryV1 } from './SourceInventory'

/** Consumption preserves the author's provenance and never creates a revision. */
export async function validateRecipeImportV1(input: unknown): Promise<EgoLensAdapterRecipeV1> {
  const recipe = assertValidRecipeV1(input)
  compileRecipeV1(recipe, bundledPhase2OperatorRegistry)
  const errors = await verifyArtifactHashesV1(recipe)
  if (errors.length) throw new Error(`The adapter file failed its integrity check: ${errors.join(', ')}. Obtain the original exported recipe and try again.`)
  return recipe
}

export async function validateRecipeSourceV1(recipe: EgoLensAdapterRecipeV1, inventory: SourceInventoryV1): Promise<void> {
  const source = inventory.snapshot()
  if (source.revoked || source.entries.length === 0) throw new Error('Select a dataset folder before rendering.')
  if (source.truncated) throw new Error('This folder could not be read completely. Select a smaller dataset folder and try again.')
  const errors = await verifySuppliedHashesV1(recipe, inventory)
  if (errors.includes('FORMAT_FINGERPRINT_MISMATCH')) {
    throw new Error('This folder layout differs from the one used to export the adapter. Select the matching dataset folder, or choose another recipe.')
  }
  if (errors.length) throw new Error(`The adapter failed its integrity check: ${errors.join(', ')}.`)
}
