import { describe, expect, it } from 'vitest'
import type { ExtensionWorkerLike } from '../extensions/ExtensionOperatorExecutor'
import { DedicatedWorkerExtensionExecutor } from '../extensions/ExtensionOperatorExecutor'
import { executeExtensionWorkerRequest } from '../extensions/extensionWorkerRuntime'
import type { ExtensionExecutionRequest, ExtensionExecutionResponse } from '../extensions/protocol'
import { ExtensionOperatorError } from '../extensions/protocol'
import { registerBuiltInExtensionPackagesV1 } from '../extensions/registeredPackages'
import {
  TEST_EXTENSION_PACKAGE_ID,
  TEST_EXTENSION_PACKAGE_INTEGRITY,
  TEST_EXTENSION_PACKAGE_MANIFEST,
  TEST_EXTENSION_PACKAGE_VERSION,
} from '../extensions/testExtensionManifest'
import { OperatorRegistry, type CoreOperatorDescriptor } from '../operators/registry'
import { compileRecipeV1 } from '../recipe/compiler'
import { AdapterCompileError } from '../recipe/diagnostics'
import { operatorSetFingerprintV1 } from '../recipe/fingerprints'
import type { EgoLensAdapterRecipeV1, ExtensionOperatorDependencyV1 } from '../recipe/types'
import { assertValidRecipeV1 } from '../schema/validateSchema'
import minimalJson from '../__fixtures__/minimal.egolens-adapter.json'

const contract = { type: 'object' } as const
const coreOperators: readonly CoreOperatorDescriptor[] = [{
  name: 'json.records',
  majorVersion: 1,
  provider: 'core',
  tier: 1,
  inputContract: contract,
  paramsContract: contract,
  outputContract: contract,
  execution: 'worker',
  deterministic: true,
}]

const extensionDependency: ExtensionOperatorDependencyV1 = {
  major: 1,
  provider: 'extension',
  package: {
    id: TEST_EXTENSION_PACKAGE_ID,
    version: TEST_EXTENSION_PACKAGE_VERSION,
    integrity: TEST_EXTENSION_PACKAGE_INTEGRITY,
  },
}

class InProcessWorker implements ExtensionWorkerLike {
  onmessage: ((event: MessageEvent<ExtensionExecutionResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false

  postMessage(message: ExtensionExecutionRequest): void {
    queueMicrotask(() => {
      void executeExtensionWorkerRequest(message).then(({ response }) => {
        this.onmessage?.({ data: response } as MessageEvent<ExtensionExecutionResponse>)
      }).catch((error: unknown) => {
        this.onerror?.({ message: error instanceof Error ? error.message : String(error) } as ErrorEvent)
      })
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

function extensionRecipe(dependency: ExtensionOperatorDependencyV1 = extensionDependency): EgoLensAdapterRecipeV1 {
  const candidate = structuredClone(minimalJson) as unknown as EgoLensAdapterRecipeV1
  const mutable = candidate as unknown as {
    engine: { requiredOperators: Record<string, unknown> }
    pipelines: Record<string, unknown>
  }
  mutable.engine.requiredOperators = {
    'json.records': { major: 1, provider: 'core' },
    'testing.bounded_echo': dependency,
  }
  mutable.pipelines.timeline = {
    nodes: [{
      id: 'echoTimeline',
      op: 'testing.bounded_echo',
      version: 1,
      inputs: { value: 'frames.rows' },
      params: {},
    }],
    result: 'echoTimeline.value',
  }
  return assertValidRecipeV1(candidate)
}

function executableRegistry(workers: InProcessWorker[] = []): OperatorRegistry {
  const executor = new DedicatedWorkerExtensionExecutor(() => {
    const worker = new InProcessWorker()
    workers.push(worker)
    return worker
  })
  const registry = new OperatorRegistry(coreOperators, { extensionExecutor: executor })
  registerBuiltInExtensionPackagesV1(registry)
  return registry
}

async function expectCode(promise: Promise<unknown>, code: ExtensionOperatorError['code']): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'ExtensionOperatorError', code })
}

describe('Phase 7 registered extension boundary', () => {
  it('compiles and executes the exact build-registered package through a fresh dedicated worker', async () => {
    const workers: InProcessWorker[] = []
    const registry = executableRegistry(workers)
    const compiled = compileRecipeV1(extensionRecipe(), registry)

    expect(compiled.operators.get('testing.bounded_echo@1')).toMatchObject({
      provider: 'extension',
      package: {
        id: TEST_EXTENSION_PACKAGE_ID,
        version: TEST_EXTENSION_PACKAGE_VERSION,
        integrity: TEST_EXTENSION_PACKAGE_INTEGRITY,
      },
      execution: 'worker',
    })
    await expect(registry.execute('testing.bounded_echo', extensionDependency, { value: 'first' }, {}))
      .resolves.toEqual({ value: 'first' })
    await expect(registry.execute('testing.bounded_echo', extensionDependency, { value: 'second' }, {}))
      .resolves.toEqual({ value: 'second' })
    expect(workers).toHaveLength(2)
    expect(workers.every((worker) => worker.terminated)).toBe(true)
  })

  it('reports exact absent and integrity-mismatched identities before execution can begin', () => {
    const workers: InProcessWorker[] = []
    const registry = executableRegistry(workers)
    const wrongIntegrity = {
      ...extensionDependency,
      package: { ...extensionDependency.package, integrity: `sha256-${'0'.repeat(64)}` },
    }

    expect(() => compileRecipeV1(extensionRecipe(wrongIntegrity), registry)).toThrow(AdapterCompileError)
    try {
      compileRecipeV1(extensionRecipe(wrongIntegrity), registry)
    } catch (error) {
      const diagnostic = (error as AdapterCompileError).diagnostics.find((item) => item.code === 'OPERATOR_MISSING')
      expect(diagnostic?.hint).toContain(TEST_EXTENSION_PACKAGE_ID)
      expect(diagnostic?.hint).toContain(TEST_EXTENSION_PACKAGE_VERSION)
      expect(diagnostic?.hint).toContain(wrongIntegrity.package.integrity)
    }
    expect(workers).toHaveLength(0)
  })

  it('never registers or evaluates code as a side effect of importing a recipe', () => {
    const registry = new OperatorRegistry(coreOperators)
    const countBefore = registry.list().length
    expect(() => compileRecipeV1(extensionRecipe(), registry)).toThrow(AdapterCompileError)
    expect(registry.list()).toHaveLength(countBefore)
    expect(registry.resolve('testing.bounded_echo', extensionDependency)).toBeNull()
  })

  it('enforces input, allocation, output, transferable, timeout, and cancellation limits', async () => {
    const workers: InProcessWorker[] = []
    const registry = executableRegistry(workers)

    await expectCode(registry.execute('testing.bounded_echo', extensionDependency, { value: 'too large' }, {}, {
      resources: { maxInputBytes: 4 },
    }), 'RESOURCE_LIMIT_EXCEEDED')
    expect(workers).toHaveLength(0)

    await expectCode(registry.execute('testing.bounded_echo', extensionDependency, { value: 1 }, { allocationBytes: 16 }, {
      resources: { maxAllocationBytes: 8 },
    }), 'RESOURCE_LIMIT_EXCEEDED')
    await expectCode(registry.execute('testing.bounded_echo', extensionDependency, { value: 1 }, { outputBytes: 64 }, {
      resources: { maxOutputBytes: 32 },
    }), 'RESOURCE_LIMIT_EXCEEDED')
    await expectCode(registry.execute('testing.bounded_echo', extensionDependency, { value: 1 }, { transferableCount: 2 }, {
      resources: { maxTransferables: 1 },
    }), 'RESOURCE_LIMIT_EXCEEDED')
    await expectCode(registry.execute('testing.bounded_echo', extensionDependency, { value: 1 }, { delayMs: 30 }, {
      resources: { timeoutMs: 5 },
    }), 'OPERATOR_TIMEOUT')

    const controller = new AbortController()
    const cancelled = registry.execute('testing.bounded_echo', extensionDependency, { value: 1 }, { delayMs: 30 }, { signal: controller.signal })
    controller.abort()
    await expectCode(cancelled, 'OPERATOR_CANCELLED')
    expect(workers.every((worker) => worker.terminated)).toBe(true)
  })

  it('rechecks package hard limits and exact identity inside the worker runtime', async () => {
    const resources = TEST_EXTENSION_PACKAGE_MANIFEST.operators[0].resources
    const base: ExtensionExecutionRequest = {
      kind: 'egolens-extension-execute',
      requestId: 'direct',
      operator: {
        name: 'testing.bounded_echo',
        majorVersion: 1,
        packageId: TEST_EXTENSION_PACKAGE_ID,
        packageVersion: TEST_EXTENSION_PACKAGE_VERSION,
        packageIntegrity: TEST_EXTENSION_PACKAGE_INTEGRITY,
      },
      inputs: { value: true },
      params: {},
      resources,
    }
    const inflated = await executeExtensionWorkerRequest({
      ...base,
      resources: { ...resources, maxOutputBytes: resources.maxOutputBytes + 1 },
    })
    expect(inflated.response).toMatchObject({ kind: 'egolens-extension-error', error: { code: 'RESOURCE_LIMIT_EXCEEDED' } })

    const missing = await executeExtensionWorkerRequest({
      ...base,
      operator: { ...base.operator, packageIntegrity: `sha256-${'f'.repeat(64)}` },
    })
    expect(missing.response).toMatchObject({ kind: 'egolens-extension-error', error: { code: 'OPERATOR_MISSING' } })
  })

  it('includes extension identity and integrity in the stable operator-set fingerprint', async () => {
    const first = await operatorSetFingerprintV1({
      'testing.bounded_echo': extensionDependency,
      'json.records': { major: 1, provider: 'core' },
    })
    const reordered = await operatorSetFingerprintV1({
      'json.records': { major: 1, provider: 'core' },
      'testing.bounded_echo': extensionDependency,
    })
    const changed = await operatorSetFingerprintV1({
      'json.records': { major: 1, provider: 'core' },
      'testing.bounded_echo': {
        ...extensionDependency,
        package: { ...extensionDependency.package, integrity: `sha256-${'1'.repeat(64)}` },
      },
    })

    expect(first).toBe(reordered)
    expect(first).not.toBe(changed)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })
})
