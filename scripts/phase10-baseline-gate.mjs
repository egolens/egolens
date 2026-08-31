#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  phase10HashV1,
  validateDecisionLedgerV1,
  validatePhase10BaselineFreezeSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { loadPhase10SchemasV1, validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const next = argv[index + 1]
    const value = next && !next.startsWith('--') ? argv[++index] : true
    const name = key.slice(2)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = value
  }
  return result
}

const options = parseArgs(process.argv.slice(2))
for (const name of ['freeze', 'requirements', 'expected-commit']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
const expectedCommit = String(options['expected-commit'])
const freeze = JSON.parse(await readFile(path.resolve(String(options.freeze)), 'utf8'))
const requirements = JSON.parse(await readFile(path.resolve(String(options.requirements)), 'utf8'))
await validatePhase10SchemaV1(freeze)
validatePhase10BaselineFreezeSemanticsV1(freeze, expectedCommit)
if (freeze.requirementsHash !== phase10HashV1(requirements)) throw new Error('Baseline requirementsHash mismatch')
const { schemaHashes } = await loadPhase10SchemasV1()
if (JSON.stringify([...freeze.gates.evidenceHarness.schemaHashes].sort()) !== JSON.stringify([...schemaHashes].sort())) {
  throw new Error('Baseline evidence schema hashes do not match this checkout')
}
if (options['require-clean-head'] === true) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  if (head !== expectedCommit || dirty) throw new Error('Baseline gate requires a clean exact candidate checkout')
}
let ledger = null
if (options.ledger) {
  const lines = (await readFile(path.resolve(String(options.ledger)), 'utf8')).trimEnd().split('\n').filter(Boolean)
  const entries = lines.map((line) => JSON.parse(line))
  for (const entry of entries) await validatePhase10SchemaV1(entry)
  ledger = validateDecisionLedgerV1(entries)
  const frozenEntry = entries.find((entry) => entry.event === 'baseline-frozen' && entry.detailsHash === freeze.freezeHash)
  if (!frozenEntry) throw new Error('Decision ledger does not bind this baseline freeze')
}
const reportPayload = {
  schema: 'egolens-phase10-baseline-gate-report-v1',
  candidateCommit: freeze.candidateCommit,
  requirementsHash: freeze.requirementsHash,
  freezeHash: freeze.freezeHash,
  datasetEvidence: freeze.datasets.map((dataset) => ({
    datasetId: dataset.datasetId,
    evidenceHash: dataset.evidenceHash,
  })).sort((left, right) => left.datasetId.localeCompare(right.datasetId)),
  negativeCaseCount: freeze.gates.negativeCases.length,
  ledgerHash: ledger?.ledgerHash ?? null,
  passed: true,
}
const report = { ...reportPayload, reportHash: phase10HashV1(reportPayload) }
if (options.output) {
  await writeFile(path.resolve(String(options.output)), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
