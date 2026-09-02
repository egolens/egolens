#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  phase10HashV1,
  phase10VerifierBindingV1,
  phase9AdapterAmnesiaBindingV1,
  loadPhase10ProductionTrustV1,
  phase10ReviewedCoverageV1,
  validateDatasetBaselineEvidenceV1,
  validatePreflightModeObservationSemanticsV1,
  validateSourceCaseManifestSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function args(argv) {
  const allowed = new Set([
    'source-case', 'local', 'remote', 'share', 'phase9-attestation', 'phase9-gate',
    'phase9-receipt', 'expected-commit', 'output',
  ])
  const result = { 'phase9-receipt': [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`)
    if (name === 'phase9-receipt') result[name].push(argv[++index])
    else {
      if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
      result[name] = argv[++index]
    }
  }
  return result
}

async function json(filename) {
  return JSON.parse(await readFile(path.resolve(filename), 'utf8'))
}

const options = args(process.argv.slice(2))
for (const name of [
  'source-case', 'local', 'remote', 'share',
  'phase9-attestation', 'phase9-gate', 'expected-commit', 'output',
]) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (options['phase9-receipt'].length !== 3) throw new Error('Exactly three --phase9-receipt files are required')
const [sourceCase, local, remote, share, phase9Attestation, phase9Gate, trust, ...phase9Receipts] = await Promise.all([
  json(options['source-case']), json(options.local), json(options.remote), json(options.share),
  json(options['phase9-attestation']), json(options['phase9-gate']), loadPhase10ProductionTrustV1(),
  ...options['phase9-receipt'].map(json),
])
const requirements = trust.phase10Requirements
const verifierBinding = phase10VerifierBindingV1(trust)
const phase9Binding = phase9AdapterAmnesiaBindingV1(
  phase9Attestation,
  phase9Gate,
  phase9Receipts,
  options['expected-commit'],
  trust,
)
await validatePhase10SchemaV1(sourceCase)
validateSourceCaseManifestSemanticsV1(sourceCase)
if (phase10HashV1(sourceCase.verifierBinding) !== phase10HashV1(verifierBinding)) {
  throw new Error('Source case verifier binding does not match the external operator anchor')
}
for (const observation of [local, remote, share]) {
  await validatePhase10SchemaV1(observation)
  validatePreflightModeObservationSemanticsV1(observation)
  if (phase10HashV1(observation.verifierBinding) !== phase10HashV1(verifierBinding)) {
    throw new Error(`${observation.mode}: verifier binding does not match the external operator anchor`)
  }
}
if (local.mode !== 'local' || remote.mode !== 'remote' || share.mode !== 'share') {
  throw new Error('Preflight assembly requires local, remote, and share observations in their named inputs')
}
const requirement = requirements.datasets?.find((entry) => entry.datasetId === local.datasetId)
if (!requirement) throw new Error('Dataset is absent from preflight requirements')
const phase9Recipe = phase9Binding.recipeBindings.find((entry) => entry.datasetId === local.datasetId)
if (phase9Recipe?.caseId !== requirement.caseId) {
  throw new Error('Phase 9 signed target does not match the reviewed preflight requirement')
}
const reviewedCoverage = phase10ReviewedCoverageV1(requirement)
for (const observation of [local, remote, share]) {
  if (observation.datasetId !== local.datasetId || observation.caseId !== local.caseId
    || observation.candidateCommit !== options['expected-commit']
    || observation.sourceManifestHash !== sourceCase.sourceManifestHash
    || observation.recipeHash !== phase9Recipe.recipeHash) {
    throw new Error(`${observation.mode}: source, recipe, target, or candidate identity mismatch`)
  }
  if (JSON.stringify(observation.capabilities) !== JSON.stringify([...requirement.requiredCapabilities].sort())) {
    throw new Error(`${observation.mode}: capability coverage does not match requirements`)
  }
  if (JSON.stringify(observation.coverage) !== JSON.stringify(reviewedCoverage)
    || observation.coverageHash !== phase10HashV1(reviewedCoverage)) {
    throw new Error(`${observation.mode}: full reviewed coverage does not match requirements`)
  }
}
if (local.caseId !== requirement.caseId || sourceCase.case.caseId !== requirement.caseId
  || sourceCase.release.datasetId !== local.datasetId) {
  throw new Error('Protected source case does not match the reviewed preflight target')
}

const mode = (observation) => ({
  verifierBinding: observation.verifierBinding,
  mode: observation.mode,
  noAgent: observation.noAgent,
  emptyProfile: observation.emptyProfile,
  sourceTreeHash: observation.sourceTreeHash,
  productionBuildInventoryHash: observation.productionBuildInventoryHash,
  sourceManifestHash: observation.sourceManifestHash,
  catalogHash: observation.catalogHash,
  shareDescriptorHash: observation.shareDescriptorHash,
  recipeHash: observation.recipeHash,
  formatFingerprint: observation.formatFingerprint,
  operatorSetFingerprint: observation.operatorSetFingerprint,
  coverageHash: observation.coverageHash,
  capabilityHash: observation.capabilityHash,
  structuralHash: observation.structuralHash,
  numericHash: observation.numericHash,
  rendererFrameHash: observation.rendererFrameHash,
  perceptualAlgorithm: observation.perceptualAlgorithm,
  perceptualHash: observation.perceptualHash,
  presentationHash: observation.presentationHash,
  performanceHash: observation.performanceHash,
  lifecycleHash: observation.lifecycleHash,
  browserBoundaryHash: observation.browserBoundary.observationHash,
  browserRunHash: observation.browserProcess.evidenceHash,
  paused: observation.paused,
  passed: observation.passed,
})
const payload = {
  verifierBinding,
  datasetId: local.datasetId,
  caseId: local.caseId,
  candidateCommit: options['expected-commit'],
  sourceTreeHash: local.sourceTreeHash,
  productionBuildInventoryHash: local.productionBuildInventoryHash,
  sourceCaseManifestHash: sourceCase.manifestHash,
  sourceManifestHash: local.sourceManifestHash,
  recipeHash: local.recipeHash,
  formatFingerprint: local.formatFingerprint,
  operatorSetFingerprint: local.operatorSetFingerprint,
  coverage: local.coverage,
  coverageHash: local.coverageHash,
  capabilities: local.capabilities,
  local: mode(local),
  remote: mode(remote),
  share: mode(share),
  parityPassed: true,
}
const evidence = { ...payload, evidenceHash: phase10HashV1(payload) }
validateDatasetBaselineEvidenceV1(evidence, options['expected-commit'])
await writeFile(path.resolve(options.output), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify({
  verifierBinding: evidence.verifierBinding,
  datasetId: evidence.datasetId,
  caseId: evidence.caseId,
  candidateCommit: evidence.candidateCommit,
  sourceManifestHash: evidence.sourceManifestHash,
  recipeHash: evidence.recipeHash,
  phase9AttestationHash: phase9Binding.attestationHash,
  phase9GateReportHash: phase9Binding.gateReportHash,
  phase9ReceiptHash: phase9Recipe.receiptHash,
  evidenceHash: evidence.evidenceHash,
  parityPassed: true,
}, null, 2)}\n`)
