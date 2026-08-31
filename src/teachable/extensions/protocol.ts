import type { ExtensionOperatorResourceLimits } from './packageManifest'

export type ExtensionOperatorErrorCode =
  | 'OPERATOR_MISSING'
  | 'OPERATOR_INPUT_INVALID'
  | 'OPERATOR_PARAMS_INVALID'
  | 'OPERATOR_OUTPUT_INVALID'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'OPERATOR_TIMEOUT'
  | 'OPERATOR_CANCELLED'
  | 'WORKER_PROTOCOL_ERROR'
  | 'OPERATOR_EXECUTION_FAILED'

export class ExtensionOperatorError extends Error {
  readonly code: ExtensionOperatorErrorCode
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: ExtensionOperatorErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'ExtensionOperatorError'
    this.code = code
    this.details = details
  }
}

export interface ExtensionOperatorIdentity {
  readonly name: string
  readonly majorVersion: number
  readonly packageId: string
  readonly packageVersion: string
  readonly packageIntegrity: string
}

export interface ExtensionExecutionRequest {
  readonly kind: 'egolens-extension-execute'
  readonly requestId: string
  readonly operator: ExtensionOperatorIdentity
  readonly inputs: unknown
  readonly params: unknown
  readonly resources: ExtensionOperatorResourceLimits
}

export type ExtensionExecutionResponse =
  | {
      readonly kind: 'egolens-extension-result'
      readonly requestId: string
      readonly output: unknown
    }
  | {
      readonly kind: 'egolens-extension-error'
      readonly requestId: string
      readonly error: {
        readonly code: ExtensionOperatorErrorCode
        readonly message: string
        readonly details?: Readonly<Record<string, unknown>>
      }
    }

export function serializeExtensionError(error: unknown): Extract<ExtensionExecutionResponse, { kind: 'egolens-extension-error' }>['error'] {
  if (error instanceof ExtensionOperatorError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return {
    code: 'OPERATOR_EXECUTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}
