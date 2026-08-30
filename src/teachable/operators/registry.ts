import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { OperatorDependencyV1 } from '../recipe/types'

export type OperatorJsonSchema = Readonly<Record<string, unknown>>

export interface OperatorParameterValidationError {
  readonly message: string
  readonly instancePath?: string
}

interface OperatorDescriptorBase {
  readonly name: string
  readonly majorVersion: number
  readonly inputContract: OperatorJsonSchema
  readonly paramsContract: OperatorJsonSchema
  readonly outputContract: OperatorJsonSchema
  readonly execution: 'main' | 'worker'
  readonly deterministic: true
  /** Trusted core-side validation for relationships JSON Schema cannot express. */
  readonly validateParams?: (params: unknown) => readonly OperatorParameterValidationError[]
}

export interface CoreOperatorDescriptor extends OperatorDescriptorBase {
  readonly provider: 'core'
  readonly tier: 1 | 2
}

export interface ExtensionOperatorDescriptor extends OperatorDescriptorBase {
  readonly provider: 'extension'
  readonly tier: 3
  readonly package: {
    readonly id: string
    readonly version: string
    readonly integrity: string
  }
}

export type RecipeOperatorDescriptor = CoreOperatorDescriptor | ExtensionOperatorDescriptor

function registryKey(name: string, majorVersion: number): string {
  return `${name}@${majorVersion}`
}

/** Versioned allowlist. Recipes can resolve descriptors but cannot register code. */
export class OperatorRegistry {
  readonly #operators = new Map<string, RecipeOperatorDescriptor>()
  readonly #paramsValidators = new Map<string, ValidateFunction>()
  readonly #inputValidators = new Map<string, ValidateFunction>()
  readonly #contractCompiler = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })

  constructor(operators: readonly RecipeOperatorDescriptor[] = []) {
    for (const operator of operators) this.register(operator)
  }

  register(operator: RecipeOperatorDescriptor): void {
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(operator.name)) {
      throw new Error(`Invalid operator name: ${operator.name}`)
    }
    if (!Number.isSafeInteger(operator.majorVersion) || operator.majorVersion < 1) {
      throw new Error(`Invalid operator major version: ${operator.majorVersion}`)
    }
    const key = registryKey(operator.name, operator.majorVersion)
    if (this.#operators.has(key)) throw new Error(`Operator already registered: ${key}`)
    const paramsValidator = this.#contractCompiler.compile(operator.paramsContract)
    const inputValidator = this.#contractCompiler.compile(operator.inputContract)
    this.#contractCompiler.compile(operator.outputContract)
    this.#operators.set(key, Object.freeze(operator))
    this.#paramsValidators.set(key, paramsValidator)
    this.#inputValidators.set(key, inputValidator)
  }

  resolve(name: string, dependency: OperatorDependencyV1): RecipeOperatorDescriptor | null {
    const operator = this.#operators.get(registryKey(name, dependency.major))
    if (!operator || operator.provider !== dependency.provider) return null
    if (operator.provider === 'extension' && dependency.provider === 'extension') {
      if (
        operator.package.id !== dependency.package.id
        || operator.package.version !== dependency.package.version
        || operator.package.integrity !== dependency.package.integrity
      ) return null
    }
    return operator
  }

  has(name: string, dependency: OperatorDependencyV1): boolean {
    return this.resolve(name, dependency) !== null
  }

  validateParams(name: string, dependency: OperatorDependencyV1, params: unknown): readonly (ErrorObject | OperatorParameterValidationError)[] {
    const operator = this.resolve(name, dependency)
    if (!operator) return []
    const validator = this.#paramsValidators.get(registryKey(name, dependency.major))
    if (!validator || !validator(params)) return validator?.errors ?? []
    return operator.validateParams?.(params) ?? []
  }

  validateInputs(name: string, dependency: OperatorDependencyV1, inputs: unknown): readonly ErrorObject[] {
    if (!this.resolve(name, dependency)) return []
    const validator = this.#inputValidators.get(registryKey(name, dependency.major))
    if (!validator || validator(inputs)) return []
    return validator.errors ?? []
  }

  list(): readonly RecipeOperatorDescriptor[] {
    return [...this.#operators.values()]
  }
}
