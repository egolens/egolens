import { sha256CanonicalJsonV1 } from '../conformance/oracleArtifacts'
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
  const digest = await sha256CanonicalJsonV1({ version: 1, operators } as JsonValue)
  return `sha256:${digest.slice('sha256-'.length)}`
}
