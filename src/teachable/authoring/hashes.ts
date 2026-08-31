import { canonicalizeArtifact, canonicalizeJson, canonicalizeRecipeSemantics } from '../recipe/canonicalize'
import { operatorSetFingerprintV1 } from '../recipe/fingerprints'
import type { EgoLensAdapterRecipeV1, JsonValue } from '../recipe/types'
import type { SourceInventoryV1 } from './SourceInventory'

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function pathTemplate(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, '{uuid}')
    .replace(/\b[0-9a-f]{16,}\b/giu, '{hex}')
    .replace(/\d{6,}/gu, '{number}')
}

export async function recipeHashV1(recipe: EgoLensAdapterRecipeV1): Promise<string> {
  return await sha256Text(canonicalizeRecipeSemantics(recipe))
}

export async function artifactHashV1(recipe: EgoLensAdapterRecipeV1): Promise<string> {
  return await sha256Text(canonicalizeArtifact(recipe))
}

export async function formatFingerprintV1(
  recipe: EgoLensAdapterRecipeV1,
  inventory: SourceInventoryV1,
): Promise<string> {
  const entries = inventory.snapshot().entries.map((entry) => ({
    path: pathTemplate(entry.path),
    extension: entry.extension,
  }))
  const readers = Object.values(recipe.sources).map((source) => source.reader).sort()
  return await sha256Text(canonicalizeJson({ version: 1, entries, readers } as JsonValue))
}

export async function datasetFingerprintV1(inventory: SourceInventoryV1, signal?: AbortSignal): Promise<string> {
  const entries = inventory.snapshot().entries
  const sampled: JsonValue[] = []
  const sampleIndices = new Set<number>()
  const limit = Math.min(entries.length, 32)
  for (let index = 0; index < limit; index += 1) {
    sampleIndices.add(limit === 1 ? 0 : Math.round(index * (entries.length - 1) / (limit - 1)))
  }
  for (const index of [...sampleIndices].sort((left, right) => left - right)) {
    if (signal?.aborted) throw new DOMException('Fingerprinting was aborted.', 'AbortError')
    const entry = entries[index]
    const file = inventory.resolveAuthorizedFile(entry.path)
    const head = new Uint8Array(await file.slice(0, Math.min(64, file.size)).arrayBuffer())
    const tailStart = Math.max(0, file.size - 64)
    const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer())
    sampled.push({
      path: pathTemplate(entry.path),
      size: entry.size,
      head: [...head].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      tail: [...tail].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    })
  }
  return await sha256Text(canonicalizeJson({ version: 1, totalEntries: entries.length, sampled } as JsonValue))
}

export interface ComputedRecipeIdentityV1 {
  readonly recipeHash: string
  readonly formatFingerprint: string
  readonly datasetFingerprint: string
  readonly operatorSetFingerprint: string
}

export async function computeRecipeHashesV1(
  recipe: EgoLensAdapterRecipeV1,
  inventory: SourceInventoryV1,
  signal?: AbortSignal,
): Promise<ComputedRecipeIdentityV1> {
  const [recipeHash, formatFingerprint, datasetFingerprint, operatorSetFingerprint] = await Promise.all([
    recipeHashV1(recipe),
    formatFingerprintV1(recipe, inventory),
    datasetFingerprintV1(inventory, signal),
    operatorSetFingerprintV1(recipe.engine.requiredOperators),
  ])
  return { recipeHash, formatFingerprint, datasetFingerprint, operatorSetFingerprint }
}

export async function withComputedArtifactHashesV1(
  recipe: EgoLensAdapterRecipeV1,
  inventory: SourceInventoryV1,
  signal?: AbortSignal,
): Promise<EgoLensAdapterRecipeV1> {
  const identity = await computeRecipeHashesV1(recipe, inventory, signal)
  const withoutArtifact: EgoLensAdapterRecipeV1 = {
    ...recipe,
    hashes: {
      recipeHash: identity.recipeHash,
      formatFingerprint: identity.formatFingerprint,
      operatorSetFingerprint: identity.operatorSetFingerprint,
    },
    provenance: {
      author: recipe.provenance?.author ?? 'imported',
      createdAt: recipe.provenance?.createdAt ?? new Date().toISOString(),
      ...recipe.provenance,
      datasetFingerprint: identity.datasetFingerprint,
    },
  }
  return {
    ...withoutArtifact,
    hashes: { ...withoutArtifact.hashes, artifactHash: await artifactHashV1(withoutArtifact) },
  }
}

export async function verifySuppliedHashesV1(
  recipe: EgoLensAdapterRecipeV1,
  inventory: SourceInventoryV1,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const errors: string[] = []
  const supplied = recipe.hashes
  if (!supplied) return errors
  if (supplied.recipeHash && supplied.recipeHash !== await recipeHashV1(recipe)) errors.push('RECIPE_HASH_MISMATCH')
  if (supplied.operatorSetFingerprint && supplied.operatorSetFingerprint !== await operatorSetFingerprintV1(recipe.engine.requiredOperators)) errors.push('OPERATOR_SET_FINGERPRINT_MISMATCH')
  if (supplied.formatFingerprint && supplied.formatFingerprint !== await formatFingerprintV1(recipe, inventory)) errors.push('FORMAT_FINGERPRINT_MISMATCH')
  if (supplied.artifactHash && supplied.artifactHash !== await artifactHashV1(recipe)) errors.push('ARTIFACT_HASH_MISMATCH')
  if (signal?.aborted) throw new DOMException('Hash verification was aborted.', 'AbortError')
  return errors
}
