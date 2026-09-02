import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { phase10BytesHashV1 } from './phase10-evidence.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PHASE10_SCHEMA_DIRECTORY = path.resolve(HERE, '../../benchmarks/phase10/schemas')
export const PHASE10_SCHEMA_FILES = Object.freeze({
  'egolens-source-case-manifest-v1': 'egolens-source-case-manifest-v1.schema.json',
  'egolens-case-reserve-manifest-v1': 'egolens-case-reserve-manifest-v1.schema.json',
  'egolens-generalization-attempt-v1': 'egolens-generalization-attempt-v1.schema.json',
  'egolens-first-failure-v1': 'egolens-first-failure-v1.schema.json',
  'egolens-decision-ledger-entry-v1': 'egolens-decision-ledger-entry-v1.schema.json',
  'egolens-preflight-mode-observation-v1': 'egolens-preflight-mode-observation-v1.schema.json',
  'egolens-phase10-baseline-freeze-v1': 'egolens-phase10-baseline-freeze-v1.schema.json',
  'egolens-phase10-build-boundary-report-v1': 'egolens-phase10-build-boundary-report-v1.schema.json',
  'egolens-phase10-negative-gate-report-v1': 'egolens-phase10-negative-gate-report-v1.schema.json',
  'egolens-phase10-regression-gate-report-v1': 'egolens-phase10-regression-gate-report-v1.schema.json',
  'egolens-phase10-evidence-harness-gate-report-v1': 'egolens-phase10-evidence-harness-gate-report-v1.schema.json',
})

let cached

export async function loadPhase10SchemasV1() {
  if (!cached) {
    cached = (async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: true })
      addFormats(ajv)
      const validators = new Map()
      const schemaHashes = []
      for (const [schemaId, filename] of Object.entries(PHASE10_SCHEMA_FILES)) {
        const bytes = await readFile(path.join(PHASE10_SCHEMA_DIRECTORY, filename))
        const schema = JSON.parse(bytes.toString('utf8'))
        validators.set(schemaId, ajv.compile(schema))
        schemaHashes.push(phase10BytesHashV1(bytes))
      }
      return Object.freeze({ validators, schemaHashes: Object.freeze(schemaHashes.sort()) })
    })()
  }
  return cached
}

export async function validatePhase10SchemaV1(value) {
  const schemaId = value?.schema
  const { validators } = await loadPhase10SchemasV1()
  const validator = validators.get(schemaId)
  if (!validator) throw new Error(`Unknown Phase 10 schema: ${String(schemaId)}`)
  if (!validator(value)) {
    const details = (validator.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ')
    throw new Error(`${schemaId} schema invalid: ${details}`)
  }
  return true
}
