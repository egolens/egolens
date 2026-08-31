import type { ExtensionOperatorDescriptor } from '../operators/registry'
import type { ExtensionOperatorResourceLimits } from './packageManifest'
import { assertPayloadWithin, collectTransferableBuffers } from './resourceLimits'
import { ExtensionOperatorError, type ExtensionExecutionRequest, type ExtensionExecutionResponse } from './protocol'

export interface ExtensionWorkerLike {
  onmessage: ((event: MessageEvent<ExtensionExecutionResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: ExtensionExecutionRequest): void
  terminate(): void
}

export type ExtensionWorkerFactory = () => ExtensionWorkerLike

export interface ExtensionExecutionOptions {
  readonly signal?: AbortSignal
  /** Per-call limits may only tighten the package manifest's hard limits. */
  readonly resources?: Partial<ExtensionOperatorResourceLimits>
}

export interface ExtensionExecutionBackend {
  execute(
    operator: ExtensionOperatorDescriptor,
    inputs: unknown,
    params: unknown,
    options?: ExtensionExecutionOptions,
  ): Promise<unknown>
}

function defaultWorkerFactory(): ExtensionWorkerLike {
  return new Worker(new URL('./extensionWorker.ts', import.meta.url), { type: 'module', name: 'egolens-extension' }) as ExtensionWorkerLike
}

let nextRequestId = 1

function effectiveLimits(
  hard: ExtensionOperatorResourceLimits,
  requested: Partial<ExtensionOperatorResourceLimits> | undefined,
): ExtensionOperatorResourceLimits {
  const entries = Object.entries(hard).map(([name, maximum]) => {
    const requestedValue = requested?.[name as keyof ExtensionOperatorResourceLimits]
    if (requestedValue === undefined) return [name, maximum]
    if (!Number.isSafeInteger(requestedValue) || requestedValue < 1 || requestedValue > maximum) {
      throw new ExtensionOperatorError('RESOURCE_LIMIT_EXCEEDED', `Requested ${name} limit ${requestedValue} must be between 1 and package maximum ${maximum}.`)
    }
    return [name, requestedValue]
  })
  return Object.fromEntries(entries) as unknown as ExtensionOperatorResourceLimits
}

export class DedicatedWorkerExtensionExecutor implements ExtensionExecutionBackend {
  readonly #createWorker: ExtensionWorkerFactory

  constructor(createWorker: ExtensionWorkerFactory = defaultWorkerFactory) {
    this.#createWorker = createWorker
  }

  async execute(
    operator: ExtensionOperatorDescriptor,
    inputs: unknown,
    params: unknown,
    options: ExtensionExecutionOptions = {},
  ): Promise<unknown> {
    const resources = effectiveLimits(operator.resources, options.resources)
    assertPayloadWithin({ inputs, params }, resources.maxInputBytes, 'input')
    if (options.signal?.aborted) throw new ExtensionOperatorError('OPERATOR_CANCELLED', 'Extension execution was cancelled before dispatch.')

    const worker = this.#createWorker()
    const requestId = `extension-${nextRequestId++}`
    const request: ExtensionExecutionRequest = {
      kind: 'egolens-extension-execute',
      requestId,
      operator: {
        name: operator.name,
        majorVersion: operator.majorVersion,
        packageId: operator.package.id,
        packageVersion: operator.package.version,
        packageIntegrity: operator.package.integrity,
      },
      inputs,
      params,
      resources,
    }

    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', cancel)
        worker.terminate()
        callback()
      }
      const cancel = (): void => finish(() => reject(new ExtensionOperatorError('OPERATOR_CANCELLED', 'Extension execution was cancelled.')))
      const timeout = setTimeout(() => finish(() => reject(new ExtensionOperatorError('OPERATOR_TIMEOUT', `Extension operator exceeded ${resources.timeoutMs} ms.`))), resources.timeoutMs)
      options.signal?.addEventListener('abort', cancel, { once: true })
      worker.onerror = (event) => finish(() => reject(new ExtensionOperatorError('OPERATOR_EXECUTION_FAILED', event.message || 'Extension worker failed.')))
      worker.onmessage = (event) => {
        const response = event.data
        if (!response || response.requestId !== requestId) {
          finish(() => reject(new ExtensionOperatorError('WORKER_PROTOCOL_ERROR', 'Extension worker returned an invalid request id.')))
          return
        }
        if (response.kind === 'egolens-extension-error') {
          finish(() => reject(new ExtensionOperatorError(response.error.code, response.error.message, response.error.details)))
          return
        }
        if (response.kind !== 'egolens-extension-result') {
          finish(() => reject(new ExtensionOperatorError('WORKER_PROTOCOL_ERROR', 'Extension worker returned an unknown response.')))
          return
        }
        try {
          assertPayloadWithin(response.output, resources.maxOutputBytes, 'output')
          const transferableCount = collectTransferableBuffers(response.output).length
          if (transferableCount > resources.maxTransferables) {
            throw new ExtensionOperatorError('RESOURCE_LIMIT_EXCEEDED', `Extension returned ${transferableCount} transferables; limit is ${resources.maxTransferables}.`, {
              resource: 'transferables', actual: transferableCount, maximum: resources.maxTransferables,
            })
          }
          finish(() => resolve(response.output))
        } catch (error) {
          finish(() => reject(error))
        }
      }
      try {
        worker.postMessage(request)
      } catch (error) {
        finish(() => reject(new ExtensionOperatorError(
          'WORKER_PROTOCOL_ERROR',
          error instanceof Error ? error.message : 'Extension request could not be cloned.',
        )))
      }
    })
  }
}
