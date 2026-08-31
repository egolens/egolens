import type { ExtensionOperatorIdentity } from './protocol'
import type { ExtensionOperatorResourceLimits } from './packageManifest'
import { TEST_EXTENSION_PACKAGE_INTEGRITY, TEST_EXTENSION_PACKAGE_MANIFEST, TEST_EXTENSION_PACKAGE_VERSION } from './testExtensionManifest'

export interface ExtensionOperatorContext {
  readonly signal: AbortSignal
  allocate(byteLength: number): Uint8Array
  reserve(byteLength: number): void
}

export type ExtensionOperatorImplementation = (
  inputs: unknown,
  params: unknown,
  context: ExtensionOperatorContext,
) => unknown | Promise<unknown>

const boundedEcho: ExtensionOperatorImplementation = async (inputs, params, context) => {
  const typedInputs = inputs as { value: unknown }
  const typedParams = params as { allocationBytes?: number; outputBytes?: number; transferableCount?: number; delayMs?: number }
  if (typedParams.allocationBytes) context.allocate(typedParams.allocationBytes)
  if (typedParams.delayMs) await new Promise((resolve) => setTimeout(resolve, typedParams.delayMs))
  if (context.signal.aborted) throw context.signal.reason
  return {
    value: typedInputs.value,
    ...(typedParams.outputBytes ? { padding: context.allocate(typedParams.outputBytes) } : {}),
    ...(typedParams.transferableCount ? {
      padding: Array.from({ length: typedParams.transferableCount }, () => context.allocate(1)),
    } : {}),
  }
}

export interface RegisteredWorkerOperator {
  readonly implementation: ExtensionOperatorImplementation
  readonly resources: ExtensionOperatorResourceLimits
}

const implementations = new Map<string, RegisteredWorkerOperator>([
  [`org.egolens.test-extension@${TEST_EXTENSION_PACKAGE_VERSION}#${TEST_EXTENSION_PACKAGE_INTEGRITY}:testing.bounded_echo@1`, {
    implementation: boundedEcho,
    resources: TEST_EXTENSION_PACKAGE_MANIFEST.operators[0].resources,
  }],
])

function implementationKey(identity: ExtensionOperatorIdentity): string {
  return `${identity.packageId}@${identity.packageVersion}#${identity.packageIntegrity}:${identity.name}@${identity.majorVersion}`
}

export function resolveWorkerOperator(identity: ExtensionOperatorIdentity): RegisteredWorkerOperator | null {
  return implementations.get(implementationKey(identity)) ?? null
}
