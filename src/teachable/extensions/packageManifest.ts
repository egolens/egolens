import type { OperatorJsonSchema } from '../operators/registry'

export interface ExtensionOperatorResourceLimits {
  readonly timeoutMs: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxAllocationBytes: number
  readonly maxTransferables: number
}

export interface ExtensionOperatorManifest {
  readonly name: string
  readonly majorVersion: number
  readonly inputContract: OperatorJsonSchema
  readonly paramsContract: OperatorJsonSchema
  readonly outputContract: OperatorJsonSchema
  readonly execution: 'worker'
  readonly resources: ExtensionOperatorResourceLimits
}

export interface EgoLensOperatorPackageManifest {
  readonly packageId: string
  readonly version: string
  readonly engineRange: string
  readonly integrity: string
  readonly operators: readonly ExtensionOperatorManifest[]
}

const PACKAGE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SHA256 = /^sha256-[0-9a-f]{64}$/u
const OPERATOR_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer.`)
}

/** Strict validation for packages admitted by the build-time allowlist. */
export function assertValidOperatorPackageManifest(manifest: EgoLensOperatorPackageManifest): void {
  if (!PACKAGE_ID.test(manifest.packageId)) throw new Error(`Invalid extension package id: ${manifest.packageId}`)
  if (!SEMVER.test(manifest.version)) throw new Error(`Invalid extension package version: ${manifest.version}`)
  if (!manifest.engineRange.trim()) throw new Error('Extension package engineRange must not be empty.')
  if (!SHA256.test(manifest.integrity)) throw new Error(`Invalid extension package integrity: ${manifest.integrity}`)
  if (manifest.operators.length === 0) throw new Error('Extension package must declare at least one operator.')

  const keys = new Set<string>()
  for (const operator of manifest.operators) {
    if (!OPERATOR_NAME.test(operator.name)) throw new Error(`Invalid operator name: ${operator.name}`)
    positiveInteger(operator.majorVersion, `${operator.name}.majorVersion`)
    if (operator.execution !== 'worker') throw new Error(`Extension operator ${operator.name} must execute in a worker.`)
    const key = `${operator.name}@${operator.majorVersion}`
    if (keys.has(key)) throw new Error(`Duplicate extension operator: ${key}`)
    keys.add(key)
    positiveInteger(operator.resources.timeoutMs, `${key}.resources.timeoutMs`)
    positiveInteger(operator.resources.maxInputBytes, `${key}.resources.maxInputBytes`)
    positiveInteger(operator.resources.maxOutputBytes, `${key}.resources.maxOutputBytes`)
    positiveInteger(operator.resources.maxAllocationBytes, `${key}.resources.maxAllocationBytes`)
    positiveInteger(operator.resources.maxTransferables, `${key}.resources.maxTransferables`)
  }
}
