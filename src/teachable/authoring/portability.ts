import { MAX_RECIPE_BYTES_V1, assertValidRecipeV1 } from '../schema/validateSchema'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'

export async function readRecipeArtifactFileV1(file: File): Promise<EgoLensAdapterRecipeV1> {
  if (file.size > MAX_RECIPE_BYTES_V1) {
    throw new Error(`Adapter artifact exceeds ${MAX_RECIPE_BYTES_V1} bytes.`)
  }
  return assertValidRecipeV1(await file.text())
}

export function serializeRecipeArtifactV1(recipe: EgoLensAdapterRecipeV1): string {
  const text = `${JSON.stringify(recipe, null, 2)}\n`
  if (new TextEncoder().encode(text).byteLength > MAX_RECIPE_BYTES_V1) {
    throw new Error(`Adapter artifact exceeds ${MAX_RECIPE_BYTES_V1} bytes.`)
  }
  assertValidRecipeV1(text)
  return text
}

export function downloadRecipeArtifactV1(recipe: EgoLensAdapterRecipeV1): void {
  const text = serializeRecipeArtifactV1(recipe)
  const slug = recipe.identity.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80) || 'adapter'
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${slug}.egolens-adapter.json`
  link.click()
  queueMicrotask(() => URL.revokeObjectURL(url))
}
