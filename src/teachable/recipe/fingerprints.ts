import { canonicalizeJson } from './canonicalize'
import type { JsonValue, OperatorDependencyV1 } from './types'

/** Stable identity of the exact core/extension operator set required by a recipe. */
export async function operatorSetFingerprintV1(
  requiredOperators: Readonly<Record<string, OperatorDependencyV1>>,
): Promise<string> {
  const operators = Object.entries(requiredOperators)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, dependency]) => dependency.provider === 'core'
      ? { name, major: dependency.major, provider: dependency.provider }
      : {
          name,
          major: dependency.major,
          provider: dependency.provider,
          package: {
            id: dependency.package.id,
            version: dependency.package.version,
            integrity: dependency.package.integrity,
          },
        })
  const bytes = new TextEncoder().encode(canonicalizeJson({ version: 1, operators } as JsonValue))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
