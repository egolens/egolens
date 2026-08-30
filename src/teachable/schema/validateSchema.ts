import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser'
import schema from './egolens-adapter-v1.schema.json'
import type { EgoLensAdapterRecipeV1 } from '../recipe/types'
import type { AdapterDiagnostic } from '../recipe/diagnostics'
import { AdapterValidationError } from '../recipe/diagnostics'

export const MAX_RECIPE_BYTES_V1 = 256 * 1024
const MAX_JSON_DEPTH_V1 = 32
const MAX_JSON_ARRAY_ITEMS_V1 = 4096
const MAX_JSON_STRING_LENGTH_V1 = 64 * 1024

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
addFormats(ajv)
const validate: ValidateFunction = ajv.compile(schema)

export interface RecipeValidationResult {
  readonly ok: boolean
  readonly recipe?: EgoLensAdapterRecipeV1
  readonly diagnostics: readonly AdapterDiagnostic[]
}

function parseDiagnostic(error: ParseError): AdapterDiagnostic {
  return {
    stage: 'parse',
    severity: 'error',
    code: 'INVALID_JSON',
    jsonPointer: `#offset=${error.offset}`,
    got: error.error,
    hint: 'The adapter must be strict UTF-8 JSON without comments or trailing commas.',
  }
}

function schemaDiagnostic(error: ErrorObject): AdapterDiagnostic {
  return {
    stage: 'schema',
    severity: 'error',
    code: error.keyword === 'additionalProperties' ? 'UNKNOWN_PROPERTY' : 'SCHEMA_INVALID',
    jsonPointer: error.instancePath || '/',
    expected: error.schema,
    got: error.data,
    hint: error.message ?? 'The adapter does not match EgoLensAdapterRecipeV1.',
  }
}

function inspectNode(node: Node, depth: number, diagnostics: AdapterDiagnostic[]): void {
  if (depth > MAX_JSON_DEPTH_V1) {
    diagnostics.push({
      stage: 'parse',
      severity: 'error',
      code: 'RESOURCE_LIMIT_DEPTH',
      hint: `JSON nesting may not exceed ${MAX_JSON_DEPTH_V1} levels.`,
    })
    return
  }
  if (node.type === 'string' && typeof node.value === 'string' && node.value.length > MAX_JSON_STRING_LENGTH_V1) {
    diagnostics.push({
      stage: 'parse',
      severity: 'error',
      code: 'RESOURCE_LIMIT_STRING',
      hint: `JSON strings may not exceed ${MAX_JSON_STRING_LENGTH_V1} characters.`,
    })
  }
  if (node.type === 'array' && (node.children?.length ?? 0) > MAX_JSON_ARRAY_ITEMS_V1) {
    diagnostics.push({
      stage: 'parse',
      severity: 'error',
      code: 'RESOURCE_LIMIT_ARRAY',
      hint: `JSON arrays may not exceed ${MAX_JSON_ARRAY_ITEMS_V1} items.`,
    })
  }
  if (node.type === 'object') {
    const seen = new Set<string>()
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0]
      const key = keyNode?.value
      if (typeof key === 'string') {
        if (seen.has(key)) {
          diagnostics.push({
            stage: 'parse',
            severity: 'error',
            code: 'DUPLICATE_JSON_KEY',
            got: key,
            hint: `Duplicate property "${key}" is not allowed.`,
          })
        }
        seen.add(key)
      }
    }
  }
  for (const child of node.children ?? []) inspectNode(child, depth + 1, diagnostics)
}

function inspectExecutableValues(value: unknown, path: string, diagnostics: AdapterDiagnostic[]): void {
  if (typeof value === 'string') {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(value)) {
      diagnostics.push({
        stage: 'parse',
        severity: 'error',
        code: 'NETWORK_URL_FORBIDDEN',
        jsonPointer: path,
        got: value,
        hint: 'Recipe execution inputs cannot contain network URLs.',
      })
    } else if (/^(?:\/|[A-Za-z]:[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)) {
      diagnostics.push({
        stage: 'parse',
        severity: 'error',
        code: 'PATH_OUTSIDE_ROOT',
        jsonPointer: path,
        got: value,
        hint: 'Recipe execution paths must remain relative to the authorized dataset root.',
      })
    } else if (/javascript:|<script\b|\bfunction\s*\(|=>|\bimport\s*\(/iu.test(value)) {
      diagnostics.push({
        stage: 'parse',
        severity: 'error',
        code: 'EXECUTABLE_SOURCE_FORBIDDEN',
        jsonPointer: path,
        hint: 'JavaScript and dynamic imports cannot appear in recipe execution parameters.',
      })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectExecutableValues(item, `${path}/${index}`, diagnostics))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      inspectExecutableValues(item, `${path}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`, diagnostics)
    }
  }
}

function validateObject(value: unknown): RecipeValidationResult {
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const diagnostics: AdapterDiagnostic[] = []
    inspectExecutableValues(object.sources, '/sources', diagnostics)
    inspectExecutableValues(object.pipelines, '/pipelines', diagnostics)
    if (diagnostics.length > 0) return { ok: false, diagnostics }
  }
  if (validate(value)) {
    return { ok: true, recipe: value as EgoLensAdapterRecipeV1, diagnostics: [] }
  }
  return {
    ok: false,
    diagnostics: (validate.errors ?? []).map(schemaDiagnostic),
  }
}

export function validateRecipeV1(input: string | unknown): RecipeValidationResult {
  if (typeof input !== 'string') return validateObject(input)
  const byteLength = new TextEncoder().encode(input).byteLength
  if (byteLength > MAX_RECIPE_BYTES_V1) {
    return {
      ok: false,
      diagnostics: [{
        stage: 'parse',
        severity: 'error',
        code: 'RESOURCE_LIMIT_ARTIFACT_SIZE',
        got: byteLength,
        expected: MAX_RECIPE_BYTES_V1,
        hint: `Adapter artifacts may not exceed ${MAX_RECIPE_BYTES_V1} bytes.`,
      }],
    }
  }

  const parseErrors: ParseError[] = []
  const root = parseTree(input, parseErrors, { allowTrailingComma: false, disallowComments: true })
  if (!root || parseErrors.length > 0) {
    return { ok: false, diagnostics: parseErrors.map(parseDiagnostic) }
  }
  const diagnostics: AdapterDiagnostic[] = []
  inspectNode(root, 1, diagnostics)
  const value = getNodeValue(root)
  if (diagnostics.length > 0) return { ok: false, diagnostics }
  return validateObject(value)
}

export function assertValidRecipeV1(input: string | unknown): EgoLensAdapterRecipeV1 {
  const result = validateRecipeV1(input)
  if (!result.ok || !result.recipe) throw new AdapterValidationError(result.diagnostics)
  return result.recipe
}
