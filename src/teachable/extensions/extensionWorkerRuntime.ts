import { assertPayloadWithin, collectTransferableBuffers } from './resourceLimits'
import { ExtensionOperatorError, type ExtensionExecutionRequest, type ExtensionExecutionResponse, serializeExtensionError } from './protocol'
import { resolveWorkerOperator, type ExtensionOperatorContext } from './workerPackages'

export interface WorkerRuntimeResult {
  readonly response: ExtensionExecutionResponse
  readonly transfer: readonly ArrayBuffer[]
}

export async function executeExtensionWorkerRequest(request: ExtensionExecutionRequest): Promise<WorkerRuntimeResult> {
  try {
    if (request.kind !== 'egolens-extension-execute') {
      throw new ExtensionOperatorError('WORKER_PROTOCOL_ERROR', 'Unknown extension worker request.')
    }
    const registration = resolveWorkerOperator(request.operator)
    if (!registration) {
      throw new ExtensionOperatorError(
        'OPERATOR_MISSING',
        `Worker has no exact implementation for ${request.operator.name}@${request.operator.majorVersion} from ${request.operator.packageId}@${request.operator.packageVersion} (${request.operator.packageIntegrity}).`,
      )
    }
    for (const [resource, hardMaximum] of Object.entries(registration.resources)) {
      const requested = request.resources[resource as keyof typeof request.resources]
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > hardMaximum) {
        throw new ExtensionOperatorError('RESOURCE_LIMIT_EXCEEDED', `Worker rejected ${resource} limit ${requested}; package maximum is ${hardMaximum}.`)
      }
    }
    assertPayloadWithin({ inputs: request.inputs, params: request.params }, request.resources.maxInputBytes, 'input')
    let allocatedBytes = 0
    const context: ExtensionOperatorContext = {
      signal: new AbortController().signal,
      reserve(byteLength) {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
          throw new ExtensionOperatorError('RESOURCE_LIMIT_EXCEEDED', `Invalid allocation request: ${byteLength}.`)
        }
        allocatedBytes += byteLength
        if (allocatedBytes > request.resources.maxAllocationBytes) {
          throw new ExtensionOperatorError('RESOURCE_LIMIT_EXCEEDED', `Extension allocation is ${allocatedBytes} bytes; limit is ${request.resources.maxAllocationBytes} bytes.`, {
            resource: 'allocationBytes', actual: allocatedBytes, maximum: request.resources.maxAllocationBytes,
          })
        }
      },
      allocate(byteLength) {
        this.reserve(byteLength)
        return new Uint8Array(byteLength)
      },
    }
    const output = await registration.implementation(request.inputs, request.params, context)
    assertPayloadWithin(output, request.resources.maxOutputBytes, 'output')
    const transfer = collectTransferableBuffers(output)
    if (transfer.length > request.resources.maxTransferables) {
      throw new ExtensionOperatorError('RESOURCE_LIMIT_EXCEEDED', `Extension returned ${transfer.length} transferables; limit is ${request.resources.maxTransferables}.`, {
        resource: 'transferables', actual: transfer.length, maximum: request.resources.maxTransferables,
      })
    }
    return {
      response: { kind: 'egolens-extension-result', requestId: request.requestId, output },
      transfer,
    }
  } catch (error) {
    return {
      response: { kind: 'egolens-extension-error', requestId: request.requestId, error: serializeExtensionError(error) },
      transfer: [],
    }
  }
}
