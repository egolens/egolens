#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PHASE10_REQUIRED_NEGATIVE_CASES,
  PHASE10_SHIPPED_DATASETS,
  assertPublicSafeV1,
  loadPhase10ProductionTrustV1,
  phase6OracleBindingV1,
  phase10HashV1,
  phase10VerifierBindingV1,
  phase9AdapterAmnesiaBindingV1,
  validateDatasetBaselineEvidenceV1,
  validatePhase10BaselineFreezeSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { loadPhase10SchemasV1, validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function args(argv) {
  const allowed = new Set([
    'dataset', 'build-boundary', 'negative', 'regression', 'harness', 'phase9-gate',
    'phase9-attestation', 'phase9-receipt', 'phase6-gate', 'phase6-receipt', 'expected-commit',
    'frozen-at', 'output',
  ])
  const result = { dataset: [], 'phase9-receipt': [], 'phase6-receipt': [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`)
    if (name === 'dataset' || name === 'phase9-receipt' || name === 'phase6-receipt') result[name].push(argv[++index])
    else {
      if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
      result[name] = argv[++index]
    }
  }
  return result
}

const json = async (filename) => JSON.parse(await readFile(path.resolve(filename), 'utf8'))
const integrity = (value, key, label) => {
  const { [key]: received, ...payload } = value
  if (received !== phase10HashV1(payload)) throw new Error(`${label} integrity failed`)
}
const exactChecks = (report, kind, commit) => {
  if (kind && report.kind !== kind) throw new Error(`${kind} report kind mismatch`)
  if (!report.passed || report.expectedCandidateCommit !== commit || report.checks?.length !== 3
    || report.checks.some((check) => !check.passed)
    || JSON.stringify(report.checks.map((check) => check.datasetId).sort())
      !== JSON.stringify([...PHASE10_SHIPPED_DATASETS].sort())) {
    throw new Error(`${kind ?? 'oracle'} report does not prove exact three-dataset coverage`)
  }
}

const options = args(process.argv.slice(2))
for (const name of [
  'build-boundary', 'negative', 'regression', 'harness',
  'phase9-gate', 'phase9-attestation', 'phase6-gate',
  'expected-commit', 'frozen-at', 'output',
]) if (!options[name]) throw new Error(`Missing --${name}`)
if (options.dataset.length !== 3) throw new Error('Exactly three --dataset evidence files are required')
if (options['phase9-receipt'].length !== 3) throw new Error('Exactly three --phase9-receipt files are required')
if (options['phase6-receipt'].length !== 3) throw new Error('Exactly three --phase6-receipt files are required')
if (!/^[0-9a-f]{40}$/u.test(options['expected-commit'])) throw new Error('--expected-commit must be a full Git SHA')
if (!Number.isFinite(Date.parse(options['frozen-at']))) throw new Error('--frozen-at must be an RFC 3339 timestamp')
const [build, negative, regression, harness, amnesia, amnesiaAttestation, phase6Gate, trust, ...evidence] = await Promise.all([
  json(options['build-boundary']), json(options.negative), json(options.regression),
  json(options.harness), json(options['phase9-gate']), json(options['phase9-attestation']),
  json(options['phase6-gate']), loadPhase10ProductionTrustV1(),
  ...options['phase9-receipt'].map(json), ...options['phase6-receipt'].map(json), ...options.dataset.map(json),
])
const phase9Receipts = evidence.slice(0, 3)
const phase6Receipts = evidence.slice(3, 6)
const datasets = evidence.slice(6)
const requirements = trust.phase10Requirements
const verifierBinding = phase10VerifierBindingV1(trust)
const phase9Binding = phase9AdapterAmnesiaBindingV1(
  amnesiaAttestation,
  amnesia,
  phase9Receipts,
  options['expected-commit'],
  trust,
)
const phase6Binding = phase6OracleBindingV1(
  phase6Gate,
  phase6Receipts,
  options['expected-commit'],
  trust,
)
for (const dataset of datasets) validateDatasetBaselineEvidenceV1(dataset, options['expected-commit'])
if (JSON.stringify(datasets.map((entry) => entry.datasetId).sort()) !== JSON.stringify([...PHASE10_SHIPPED_DATASETS].sort())) {
  throw new Error('Dataset baseline evidence coverage is incomplete or duplicated')
}
integrity(build, 'reportHash', 'build boundary')
await validatePhase10SchemaV1(build)
if (build.schema !== 'egolens-phase10-build-boundary-report-v1'
  || build.candidateCommit !== options['expected-commit'] || !build.passed
  || !build.cleanHeadVerified || !build.detachedCheckoutVerified
  || !build.ignoredInputsExcluded || !build.sanitizedEnvironmentVerified
  || build.sandbox?.platform !== 'macos-seatbelt-deny-default'
  || build.sandbox?.candidateScriptsInvoked !== false || !build.sandbox?.networkDenied
  || !build.sandbox?.protectedRootsDenied || !build.sandbox?.trackedSourceWriteDenied
  || !build.sandbox?.processGroupCleanup || !build.sandbox?.sourceUnchanged || !build.sandbox?.passed
  || phase10HashV1(build.verifierBinding) !== phase10HashV1(verifierBinding)
  || build.author?.phase9ContentHash !== phase9Binding.authorApplicationBuildHash
  || !build.production?.passed || !build.author?.passed) throw new Error('Build boundary report is invalid')
for (const dataset of datasets) {
  if (dataset.sourceTreeHash !== build.sourceTreeHash
    || dataset.productionBuildInventoryHash !== build.production.inventoryHash) {
    throw new Error(`${dataset.datasetId}: evidence is not bound to the reproduced production build`)
  }
}
integrity(negative, 'reportHash', 'negative gate')
await validatePhase10SchemaV1(negative)
if (negative.schema !== 'egolens-phase10-negative-gate-report-v1'
  || negative.candidateCommit !== options['expected-commit'] || !negative.passed
  || phase10HashV1(negative.verifierBinding) !== phase10HashV1(verifierBinding)
  || JSON.stringify(negative.cases.map((entry) => entry.id).sort())
    !== JSON.stringify([...PHASE10_REQUIRED_NEGATIVE_CASES].sort())) throw new Error('Negative gate report is invalid')
integrity(regression, 'reportHash', 'regression gate')
await validatePhase10SchemaV1(regression)
if (regression.schema !== 'egolens-phase10-regression-gate-report-v1'
  || regression.candidateCommit !== options['expected-commit'] || !regression.passed
  || phase10HashV1(regression.verifierBinding) !== phase10HashV1(verifierBinding)) throw new Error('Regression gate report is invalid')
integrity(harness, 'reportHash', 'harness gate')
await validatePhase10SchemaV1(harness)
const { schemaHashes } = await loadPhase10SchemasV1()
if (harness.schema !== 'egolens-phase10-evidence-harness-gate-report-v1'
  || harness.candidateCommit !== options['expected-commit'] || !harness.passed || !harness.freshProcessSelfTest
  || phase10HashV1(harness.verifierBinding) !== phase10HashV1(verifierBinding)
  || JSON.stringify([...harness.schemaHashes].sort()) !== JSON.stringify([...schemaHashes].sort())) {
  throw new Error('Evidence harness gate report is invalid or stale')
}
exactChecks(amnesia, 'egolens-adapter-amnesia-gate-report', options['expected-commit'])
const phase9ByDataset = new Map(phase9Binding.recipeBindings.map((entry) => [entry.datasetId, entry]))
for (const dataset of datasets) {
  const binding = phase9ByDataset.get(dataset.datasetId)
  if (binding?.caseId !== dataset.caseId || binding.recipeHash !== dataset.recipeHash) {
    throw new Error(`${dataset.datasetId}: baseline evidence does not use its Phase 9 author-attested recipe`)
  }
}
const gate = (evidenceHash) => ({ passed: true, evidenceHash })
const payload = {
  schema: 'egolens-phase10-baseline-freeze-v1',
  candidateCommit: options['expected-commit'],
  requirementsHash: phase10HashV1(requirements),
  sourceTreeHash: build.sourceTreeHash,
  productionBuildInventoryHash: build.production.inventoryHash,
  authorBuildInventoryHash: build.author.inventoryHash,
  buildBoundaryReportHash: build.reportHash,
  verifierBinding,
  phase6Binding,
  phase9Binding,
  frozenAt: options['frozen-at'],
  heldOutState: {
    semanticInspectionStarted: false,
    contentBlindManifestFreezeStarted: false,
    sourceMounted: false,
  },
  datasets: datasets.sort((left, right) => left.datasetId.localeCompare(right.datasetId, 'en')),
  gates: {
    regression: gate(regression.reportHash),
    productionBuild: gate(build.production.inventoryHash),
    authorBuild: gate(build.author.inventoryHash),
    productionBoundary: gate(build.reportHash),
    authorBoundary: gate(build.reportHash),
    adapterAmnesia: gate(phase9Binding.gateReportHash),
    oracleReceipts: gate(phase6Binding.gateReportHash),
    performanceLifecycle: gate(phase10HashV1(datasets.flatMap((dataset) => [
      dataset.local.performanceHash, dataset.local.lifecycleHash,
      dataset.remote.performanceHash, dataset.remote.lifecycleHash,
      dataset.share.performanceHash, dataset.share.lifecycleHash,
    ]))),
    negativeCases: negative.cases,
    evidenceHarness: {
      passed: true,
      evidenceHash: harness.reportHash,
      schemaHashes,
      freshProcessSelfTest: true,
    },
  },
  allPassed: true,
}
const freeze = { ...payload, freezeHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(freeze)
validatePhase10BaselineFreezeSemanticsV1(freeze, options['expected-commit'])
assertPublicSafeV1(freeze, 'baseline freeze')
await writeFile(path.resolve(options.output), `${JSON.stringify(freeze, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify({
  schema: freeze.schema,
  candidateCommit: freeze.candidateCommit,
  frozenAt: freeze.frozenAt,
  freezeHash: freeze.freezeHash,
  phase9AttestationHash: freeze.phase9Binding.attestationHash,
  phase9GateReportHash: freeze.phase9Binding.gateReportHash,
  datasets: freeze.datasets.map(({ datasetId, evidenceHash }) => ({ datasetId, evidenceHash })),
  allPassed: true,
}, null, 2)}\n`)
