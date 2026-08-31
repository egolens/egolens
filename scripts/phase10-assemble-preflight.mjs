#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  phase10HashV1,
  validateDatasetBaselineEvidenceV1,
  validatePreflightModeObservationSemanticsV1,
  validateSourceCaseManifestSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

async function json(filename) {
  return JSON.parse(await readFile(path.resolve(filename), 'utf8'))
}

const options = args(process.argv.slice(2))
for (const name of ['source-case', 'local', 'remote', 'share', 'requirements', 'expected-commit', 'output']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
const [sourceCase, local, remote, share, requirements] = await Promise.all([
  json(options['source-case']), json(options.local), json(options.remote), json(options.share), json(options.requirements),
])
await validatePhase10SchemaV1(sourceCase)
validateSourceCaseManifestSemanticsV1(sourceCase)
for (const observation of [local, remote, share]) {
  await validatePhase10SchemaV1(observation)
  validatePreflightModeObservationSemanticsV1(observation)
}
if (local.mode !== 'local' || remote.mode !== 'remote' || share.mode !== 'share') {
  throw new Error('Preflight assembly requires local, remote, and share observations in their named inputs')
}
const requirement = requirements.datasets?.find((entry) => entry.datasetId === local.datasetId)
if (!requirement) throw new Error('Dataset is absent from preflight requirements')
for (const observation of [local, remote, share]) {
  if (observation.datasetId !== local.datasetId || observation.caseId !== local.caseId
    || observation.candidateCommit !== options['expected-commit']
    || observation.sourceManifestHash !== sourceCase.sourceManifestHash
    || observation.recipeHash !== requirement.recipeHash) {
    throw new Error(`${observation.mode}: source, recipe, target, or candidate identity mismatch`)
  }
  if (JSON.stringify(observation.capabilities) !== JSON.stringify([...requirement.requiredCapabilities].sort())) {
    throw new Error(`${observation.mode}: capability coverage does not match requirements`)
  }
}
if (local.caseId !== requirement.caseId || sourceCase.case.caseId !== requirement.caseId
  || sourceCase.release.datasetId !== local.datasetId) {
  throw new Error('Protected source case does not match the reviewed preflight target')
}

const mode = (observation) => ({
  mode: observation.mode,
  noAgent: observation.noAgent,
  emptyProfile: observation.emptyProfile,
  sourceManifestHash: observation.sourceManifestHash,
  catalogHash: observation.catalogHash,
  shareDescriptorHash: observation.shareDescriptorHash,
  recipeHash: observation.recipeHash,
  formatFingerprint: observation.formatFingerprint,
  operatorSetFingerprint: observation.operatorSetFingerprint,
  capabilityHash: observation.capabilityHash,
  structuralHash: observation.structuralHash,
  numericHash: observation.numericHash,
  perceptualHash: observation.perceptualHash,
  presentationHash: observation.presentationHash,
  performanceHash: observation.performanceHash,
  lifecycleHash: observation.lifecycleHash,
  browserRunHash: observation.browserProcess.evidenceHash,
  paused: observation.paused,
  passed: observation.passed,
})
const payload = {
  datasetId: local.datasetId,
  caseId: local.caseId,
  candidateCommit: options['expected-commit'],
  sourceCaseManifestHash: sourceCase.manifestHash,
  sourceManifestHash: local.sourceManifestHash,
  recipeHash: local.recipeHash,
  formatFingerprint: local.formatFingerprint,
  operatorSetFingerprint: local.operatorSetFingerprint,
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
  datasetId: evidence.datasetId,
  caseId: evidence.caseId,
  candidateCommit: evidence.candidateCommit,
  sourceManifestHash: evidence.sourceManifestHash,
  evidenceHash: evidence.evidenceHash,
  parityPassed: true,
}, null, 2)}\n`)
