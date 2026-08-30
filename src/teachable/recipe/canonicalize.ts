import type { EgoLensAdapterRecipeV1, JsonValue } from './types'

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError('JCS rejects unpaired UTF-16 surrogates')
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('JCS rejects unpaired UTF-16 surrogates')
    }
  }
}

/** RFC 8785 JSON Canonicalization Scheme serialization. */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    assertUnicodeScalarString(value)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`

  const entries = Object.keys(value).sort().map((key) => {
    assertUnicodeScalarString(key)
    const member = value[key]
    if (member === undefined) throw new TypeError('JCS rejects undefined values')
    return `${JSON.stringify(key)}:${canonicalizeJson(member)}`
  })
  return `{${entries.join(',')}}`
}

export function canonicalizeRecipeSemantics(recipe: EgoLensAdapterRecipeV1): string {
  const semantic = structuredClone(recipe) as unknown as Record<string, unknown>
  delete semantic.identity
  delete semantic.provenance
  delete semantic.hashes
  return canonicalizeJson(semantic as JsonValue)
}

export function canonicalizeArtifact(recipe: EgoLensAdapterRecipeV1): string {
  const artifact = structuredClone(recipe) as unknown as Record<string, unknown>
  if (artifact.hashes && typeof artifact.hashes === 'object') {
    const hashes = { ...artifact.hashes as Record<string, unknown> }
    delete hashes.artifactHash
    artifact.hashes = hashes
  }
  return canonicalizeJson(artifact as JsonValue)
}
