import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { ExtensionExecutionBackend, ExtensionExecutionOptions } from '../extensions/ExtensionOperatorExecutor'
import { ExtensionOperatorError } from '../extensions/protocol'
import type { EgoLensOperatorPackageManifest, ExtensionOperatorResourceLimits } from '../extensions/packageManifest'
import { assertValidOperatorPackageManifest } from '../extensions/packageManifest'
import type { OperatorDependencyV1 } from '../recipe/types'
import type { CoreOperatorExecutionContextV1 } from '../runtime/GraphValues'

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

export type CoreOperatorImplementationV1 = (
  inputs: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
  context: CoreOperatorExecutionContextV1,
) => Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>

export interface CoreOperatorDescriptor extends OperatorDescriptorBase {
  readonly provider: 'core'
  readonly tier: 1 | 2
  /** Trusted implementation selected only through this exact versioned descriptor. */
  readonly execute?: CoreOperatorImplementationV1
}

export interface ExtensionOperatorDescriptor extends OperatorDescriptorBase {
  readonly provider: 'extension'
  readonly tier: 3
  readonly package: {
    readonly id: string
    readonly version: string
    readonly integrity: string
  }
  readonly resources: ExtensionOperatorResourceLimits
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
  readonly #outputValidators = new Map<string, ValidateFunction>()
  readonly #contractCompiler = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
  readonly #extensionExecutor?: ExtensionExecutionBackend
  readonly #engineVersion: string

  constructor(
    operators: readonly CoreOperatorDescriptor[] = [],
    options: { readonly extensionExecutor?: ExtensionExecutionBackend; readonly engineVersion?: string } = {},
  ) {
    this.#extensionExecutor = options.extensionExecutor
    this.#engineVersion = options.engineVersion ?? '1.0.0'
    for (const operator of operators) this.register(operator)
  }

  register(operator: CoreOperatorDescriptor): void {
    if (operator.provider !== 'core') throw new Error('Extension operators must be admitted through a package manifest.')
    this.#registerDescriptor(operator)
  }

  #registerDescriptor(operator: RecipeOperatorDescriptor): void {
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
    const outputValidator = this.#contractCompiler.compile(operator.outputContract)
    this.#operators.set(key, Object.freeze(operator))
    this.#paramsValidators.set(key, paramsValidator)
    this.#inputValidators.set(key, inputValidator)
    this.#outputValidators.set(key, outputValidator)
  }

  registerExtensionPackage(manifest: EgoLensOperatorPackageManifest): void {
    assertValidOperatorPackageManifest(manifest)
    if (!this.#extensionExecutor) {
      throw new Error(`Extension package ${manifest.packageId}@${manifest.version} requires a registered worker execution backend.`)
    }
    if (!engineRangeIncludes(manifest.engineRange, this.#engineVersion)) {
      throw new Error(`Extension package ${manifest.packageId}@${manifest.version} does not support engine ${this.#engineVersion}.`)
    }
    for (const operator of manifest.operators) {
      this.#registerDescriptor({
        ...operator,
        provider: 'extension',
        tier: 3,
        deterministic: true,
        package: { id: manifest.packageId, version: manifest.version, integrity: manifest.integrity },
      })
    }
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

  validateOutput(name: string, dependency: OperatorDependencyV1, output: unknown): readonly ErrorObject[] {
    if (!this.resolve(name, dependency)) return []
    const validator = this.#outputValidators.get(registryKey(name, dependency.major))
    if (!validator || validator(output)) return []
    return validator.errors ?? []
  }

  async execute(
    name: string,
    dependency: OperatorDependencyV1,
    inputs: unknown,
    params: unknown,
    options?: ExtensionExecutionOptions,
  ): Promise<unknown> {
    const operator = this.resolve(name, dependency)
    if (!operator || operator.provider !== 'extension') {
      throw new ExtensionOperatorError('OPERATOR_MISSING', `Registered extension operator ${name}@${dependency.major} is unavailable or incompatible.`)
    }
    if (!this.#extensionExecutor) {
      throw new ExtensionOperatorError('OPERATOR_MISSING', `No extension execution backend is registered for ${name}@${dependency.major}.`)
    }
    const inputErrors = this.validateInputs(name, dependency, inputs)
    if (inputErrors.length > 0) throw new ExtensionOperatorError('OPERATOR_INPUT_INVALID', inputErrors.map(formatValidationError).join('; '))
    const parameterErrors = this.validateParams(name, dependency, params)
    if (parameterErrors.length > 0) throw new ExtensionOperatorError('OPERATOR_PARAMS_INVALID', parameterErrors.map(formatValidationError).join('; '))
    const output = await this.#extensionExecutor.execute(operator, inputs, params, options)
    const outputErrors = this.validateOutput(name, dependency, output)
    if (outputErrors.length > 0) throw new ExtensionOperatorError('OPERATOR_OUTPUT_INVALID', outputErrors.map(formatValidationError).join('; '))
    return output
  }

  async executeCore(
    name: string,
    dependency: OperatorDependencyV1,
    inputs: Readonly<Record<string, unknown>>,
    params: Readonly<Record<string, unknown>>,
    context: CoreOperatorExecutionContextV1,
  ): Promise<Readonly<Record<string, unknown>>> {
    const operator = this.resolve(name, dependency)
    if (!operator || operator.provider !== 'core' || !operator.execute) {
      throw new Error(`CORE_OPERATOR_IMPLEMENTATION_MISSING: ${name}@${dependency.major}`)
    }
    context.throwIfAborted()
    const output = await operator.execute(inputs, params, context)
    context.throwIfAborted()
    const outputErrors = this.validateOutput(name, dependency, output)
    if (outputErrors.length > 0) {
      throw new Error(`CORE_OPERATOR_OUTPUT_INVALID: ${name}@${dependency.major}: ${outputErrors.map(formatValidationError).join('; ')}`)
    }
    return output
  }

  list(): readonly RecipeOperatorDescriptor[] {
    return [...this.#operators.values()]
  }
}

function formatValidationError(error: ErrorObject | OperatorParameterValidationError): string {
  return `${error.instancePath ?? ''} ${error.message ?? 'is invalid'}`.trim()
}

function parseVersion(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function engineRangeIncludes(range: string, version: string): boolean {
  const candidate = parseVersion(version)
  if (!candidate) return false
  const trimmed = range.trim()
  const exact = parseVersion(trimmed)
  if (exact && /^\d+\.\d+\.\d+$/u.test(trimmed)) return compareVersion(candidate, exact) === 0
  if (trimmed.startsWith('^')) {
    const minimum = parseVersion(trimmed.slice(1))
    return minimum !== null && compareVersion(candidate, minimum) >= 0 && candidate[0] === minimum[0]
  }
  return trimmed.split(/\s+/u).every((clause) => {
    const match = /^(>=|>|<=|<)(\d+\.\d+\.\d+)$/u.exec(clause)
    if (!match) return false
    const boundary = parseVersion(match[2])!
    const comparison = compareVersion(candidate, boundary)
    return match[1] === '>=' ? comparison >= 0 : match[1] === '>' ? comparison > 0 : match[1] === '<=' ? comparison <= 0 : comparison < 0
  })
}
