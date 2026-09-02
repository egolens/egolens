#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PHASE10_REQUIRED_NEGATIVE_CASES,
  loadPhase10ProductionTrustV1,
  phase6OracleBindingV1,
  phase10HashV1,
  phase10VerifierBindingV1,
  phase9AdapterAmnesiaBindingV1,
  validateDecisionLedgerV1,
  validatePhase10BaselineFreezeSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { loadPhase10SchemasV1, validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

const GIT_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
})

function git(repository, argv) {
  return execFileSync('/usr/bin/git', [
    '-c', 'core.hooksPath=/dev/null', '-C', repository, ...argv,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: GIT_ENVIRONMENT,
  }).trim()
}

function parseArgs(argv) {
  const allowed = new Set([
    'freeze', 'negative', 'regression', 'harness',
    'phase9-attestation', 'phase9-gate', 'phase9-receipt',
    'phase6-gate', 'phase6-receipt',
    'candidate-repository', 'expected-commit', 'ledger', 'output',
  ])
  const result = { 'phase9-receipt': [], 'phase6-receipt': [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const next = argv[index + 1]
    const value = next && !next.startsWith('--') ? argv[++index] : true
    const name = key.slice(2)
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`)
    if (name === 'phase9-receipt' || name === 'phase6-receipt') result[name].push(value)
    else {
      if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
      result[name] = value
    }
  }
  return result
}

const options = parseArgs(process.argv.slice(2))
for (const name of [
  'freeze', 'negative', 'regression', 'harness',
  'phase9-attestation', 'phase9-gate', 'phase6-gate',
  'candidate-repository', 'expected-commit',
]) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (options['phase9-receipt'].length !== 3) throw new Error('Exactly three --phase9-receipt files are required')
if (options['phase6-receipt'].length !== 3) throw new Error('Exactly three --phase6-receipt files are required')
const expectedCommit = String(options['expected-commit'])
const freeze = JSON.parse(await readFile(path.resolve(String(options.freeze)), 'utf8'))
const phase9Attestation = JSON.parse(await readFile(path.resolve(String(options['phase9-attestation'])), 'utf8'))
const phase9Gate = JSON.parse(await readFile(path.resolve(String(options['phase9-gate'])), 'utf8'))
const phase6Gate = JSON.parse(await readFile(path.resolve(String(options['phase6-gate'])), 'utf8'))
const [trust, ...allReceipts] = await Promise.all([
  loadPhase10ProductionTrustV1(),
  ...options['phase9-receipt'].map((filename) => readFile(path.resolve(String(filename)), 'utf8').then(JSON.parse)),
  ...options['phase6-receipt'].map((filename) => readFile(path.resolve(String(filename)), 'utf8').then(JSON.parse)),
])
const phase9Receipts = allReceipts.slice(0, 3)
const phase6Receipts = allReceipts.slice(3)
const requirements = trust.phase10Requirements
const verifierBinding = phase10VerifierBindingV1(trust)
const phase9Binding = phase9AdapterAmnesiaBindingV1(
  phase9Attestation,
  phase9Gate,
  phase9Receipts,
  expectedCommit,
  trust,
)
const phase6Binding = phase6OracleBindingV1(
  phase6Gate,
  phase6Receipts,
  expectedCommit,
  trust,
)
await validatePhase10SchemaV1(freeze)
validatePhase10BaselineFreezeSemanticsV1(freeze, expectedCommit)
if (freeze.requirementsHash !== phase10HashV1(requirements)) throw new Error('Baseline requirementsHash mismatch')
if (phase10HashV1(freeze.phase9Binding) !== phase10HashV1(phase9Binding)) {
  throw new Error('Baseline Phase 9 binding does not match the supplied signed gate and attestation')
}
if (phase10HashV1(freeze.phase6Binding) !== phase10HashV1(phase6Binding)
  || phase10HashV1(freeze.verifierBinding) !== phase10HashV1(verifierBinding)
  || freeze.gates.oracleReceipts.evidenceHash !== phase6Binding.gateReportHash) {
  throw new Error('Baseline trust does not match the supplied Phase 6 receipts and external verifier anchor')
}
const { schemaHashes } = await loadPhase10SchemasV1()
if (JSON.stringify([...freeze.gates.evidenceHarness.schemaHashes].sort()) !== JSON.stringify([...schemaHashes].sort())) {
  throw new Error('Baseline evidence schema hashes do not match this checkout')
}
// The freeze's self-hash is not evidence for the test gates. Re-verify the
// three reviewed-runner reports independently and require the freeze's gate
// entries to name exactly those reports.
const gateReport = async (name, schema) => {
  const report = JSON.parse(await readFile(path.resolve(String(options[name])), 'utf8'))
  const { reportHash, ...payload } = report
  if (phase10HashV1(payload) !== reportHash) throw new Error(`${name} gate report integrity hash mismatch`)
  await validatePhase10SchemaV1(report)
  if (report.schema !== schema || report.candidateCommit !== expectedCommit || report.passed !== true
    || phase10HashV1(report.verifierBinding) !== phase10HashV1(verifierBinding)) {
    throw new Error(`${name} gate report is not a passing report for this candidate and verifier`)
  }
  return report
}
const [negative, regression, harness] = await Promise.all([
  gateReport('negative', 'egolens-phase10-negative-gate-report-v1'),
  gateReport('regression', 'egolens-phase10-regression-gate-report-v1'),
  gateReport('harness', 'egolens-phase10-evidence-harness-gate-report-v1'),
])
if (JSON.stringify(negative.cases.map((entry) => entry.id).sort())
    !== JSON.stringify([...PHASE10_REQUIRED_NEGATIVE_CASES].sort())
  || JSON.stringify(freeze.gates.negativeCases) !== JSON.stringify(negative.cases)) {
  throw new Error('Baseline negative cases do not match the supplied negative gate report')
}
if (freeze.gates.regression.evidenceHash !== regression.reportHash
  || freeze.gates.regression.passed !== true) {
  throw new Error('Baseline regression gate does not match the supplied regression gate report')
}
if (freeze.gates.evidenceHarness.evidenceHash !== harness.reportHash
  || freeze.gates.evidenceHarness.passed !== true
  || harness.freshProcessSelfTest !== true
  || JSON.stringify([...harness.schemaHashes].sort()) !== JSON.stringify([...schemaHashes].sort())) {
  throw new Error('Baseline evidence-harness gate does not match the supplied harness gate report')
}
const candidateRepository = await realpath(path.resolve(String(options['candidate-repository'])))
const verifierRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (candidateRepository === verifierRoot
  || candidateRepository.startsWith(`${verifierRoot}${path.sep}`)
  || verifierRoot.startsWith(`${candidateRepository}${path.sep}`)) {
  throw new Error('Candidate repository and separately reviewed verifier checkout must be disjoint')
}
const repositoryRoot = git(candidateRepository, ['rev-parse', '--show-toplevel'])
if (path.resolve(repositoryRoot) !== candidateRepository) {
  throw new Error('--candidate-repository must be the exact repository root')
}
const head = git(candidateRepository, ['rev-parse', 'HEAD'])
const dirty = git(candidateRepository, ['status', '--porcelain', '--untracked-files=all'])
if (head !== expectedCommit || dirty) throw new Error('Baseline gate requires a clean exact candidate checkout')
const cleanHeadVerified = true
const buildBoundaryScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'phase10-build-boundary.mjs')
const reproducedBuild = JSON.parse(execFileSync(process.execPath, [
  buildBoundaryScript,
  '--candidate-repository', candidateRepository,
  '--production', path.join(candidateRepository, 'dist'),
  '--author', path.join(candidateRepository, 'dist-amnesia-author'),
  '--expected-commit', expectedCommit,
], {
  cwd: candidateRepository,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024,
}))
await validatePhase10SchemaV1(reproducedBuild)
if (phase10HashV1(Object.fromEntries(
  Object.entries(reproducedBuild).filter(([key]) => key !== 'reportHash'),
)) !== reproducedBuild.reportHash
  || reproducedBuild.reportHash !== freeze.buildBoundaryReportHash
  || phase10HashV1(reproducedBuild.verifierBinding) !== phase10HashV1(verifierBinding)
  || reproducedBuild.sourceTreeHash !== freeze.sourceTreeHash
  || reproducedBuild.production.inventoryHash !== freeze.productionBuildInventoryHash
  || reproducedBuild.author.inventoryHash !== freeze.authorBuildInventoryHash
  || freeze.gates.productionBuild.evidenceHash !== reproducedBuild.production.inventoryHash
  || freeze.gates.authorBuild.evidenceHash !== reproducedBuild.author.inventoryHash
  || freeze.gates.productionBoundary.evidenceHash !== reproducedBuild.reportHash
  || freeze.gates.authorBoundary.evidenceHash !== reproducedBuild.reportHash) {
  throw new Error('Baseline freeze does not match the freshly reproduced detached build')
}
const postBuildHead = git(candidateRepository, ['rev-parse', 'HEAD'])
const postBuildDirty = git(candidateRepository, ['status', '--porcelain', '--untracked-files=all'])
if (postBuildHead !== expectedCommit || postBuildDirty) {
  throw new Error('Candidate checkout changed while reproducing the final baseline build')
}
let ledger = null
if (options.ledger) {
  const lines = (await readFile(path.resolve(String(options.ledger)), 'utf8')).trimEnd().split('\n').filter(Boolean)
  const entries = lines.map((line) => JSON.parse(line))
  for (const entry of entries) await validatePhase10SchemaV1(entry)
  ledger = validateDecisionLedgerV1(entries)
  if (entries.some((entry) => phase10HashV1(entry.verifierBinding) !== phase10HashV1(verifierBinding))) {
    throw new Error('Decision ledger does not match the external operator-pinned verifier')
  }
  const frozenEntry = entries.find((entry) => entry.event === 'baseline-frozen' && entry.detailsHash === freeze.freezeHash)
  if (!frozenEntry) throw new Error('Decision ledger does not bind this baseline freeze')
}
const reportPayload = {
  schema: 'egolens-phase10-baseline-gate-report-v1',
  candidateCommit: freeze.candidateCommit,
  requirementsHash: freeze.requirementsHash,
  freezeHash: freeze.freezeHash,
  sourceTreeHash: freeze.sourceTreeHash,
  productionBuildInventoryHash: freeze.productionBuildInventoryHash,
  buildBoundaryReportHash: freeze.buildBoundaryReportHash,
  phase9AttestationHash: freeze.phase9Binding.attestationHash,
  phase9GateReportHash: freeze.phase9Binding.gateReportHash,
  phase6GateReportHash: freeze.phase6Binding.gateReportHash,
  phase6ReceiptHashes: freeze.phase6Binding.receipts.map((entry) => entry.receiptHash),
  negativeGateReportHash: negative.reportHash,
  regressionGateReportHash: regression.reportHash,
  evidenceHarnessGateReportHash: harness.reportHash,
  verifierBinding: freeze.verifierBinding,
  cleanHeadVerified,
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
