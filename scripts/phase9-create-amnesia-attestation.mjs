#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AMNESIA_DENIED_RESOURCES,
  AMNESIA_DATASETS,
  AMNESIA_PUBLIC_TOOLS,
  amnesiaBoundaryWitness,
  recipeSemanticHash,
  verifyAmnesiaBoundaryReport,
} from './lib/amnesia-evidence.mjs'
import { sha256Canonical } from './lib/oracle-receipts.mjs'

function argumentsByName(argv, allowed, flags = new Set()) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!allowed.has(name) || result[name] !== undefined) throw new Error(`Invalid option: --${name}`)
    if (flags.has(name)) {
      result[name] = true
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${name}`)
    result[name] = argv[++index]
  }
  return result
}

const REQUIRED_OPTIONS = Object.freeze([
  'candidate-commit',
  'boundary-report',
  'waymo-recipe',
  'nuscenes-recipe',
  'argoverse2-recipe',
  'output',
])
const options = argumentsByName(process.argv.slice(2), new Set(REQUIRED_OPTIONS))
for (const required of REQUIRED_OPTIONS) {
  if (!options[required]) throw new Error(`Missing --${required}`)
}
if (!/^[0-9a-f]{40}$/u.test(String(options['candidate-commit']))) {
  throw new Error('--candidate-commit must be a full Git SHA')
}

const boundaryReport = JSON.parse(await readFile(path.resolve(String(options['boundary-report'])), 'utf8'))
if (!verifyAmnesiaBoundaryReport(boundaryReport, String(options['candidate-commit']))) {
  throw new Error('Invalid Adapter Amnesia OS-boundary report')
}
const boundaryWitness = amnesiaBoundaryWitness(boundaryReport)

const candidates = []
for (const datasetId of AMNESIA_DATASETS) {
  const recipe = JSON.parse(await readFile(path.resolve(String(options[`${datasetId}-recipe`])), 'utf8'))
  if (recipe.provenance?.author !== 'codex') throw new Error(`${datasetId}: Adapter Amnesia recipe must be authored by Codex`)
  const boundaryCase = boundaryReport.cases.find((entry) => entry.datasetId === datasetId)
  const recipeHash = recipeSemanticHash(recipe)
  if (boundaryCase.recipeHash !== recipeHash) {
    throw new Error(`${datasetId}: recipe was not exported by the attested counted author run`)
  }
  candidates.push({
    datasetId,
    caseId: boundaryCase.caseId,
    authoredBy: 'codex',
    recipeHash,
  })
}
const payload = {
  kind: 'egolens-adapter-amnesia-attestation',
  schemaVersion: 2,
  candidateCommit: String(options['candidate-commit']),
  authoringRuntimeId: 'egolens-adapter-amnesia-author-v1',
  publicContract: {
    recipeSchemaVersion: 1,
    recipeEngineVersion: '1.0.0',
    normalizedSceneVersion: 1,
  },
  publicTools: [...AMNESIA_PUBLIC_TOOLS],
  deniedResources: [...AMNESIA_DENIED_RESOURCES],
  externalToolNetworkEgress: false,
  interactiveJudgeAccess: false,
  boundaryReportHash: boundaryReport.reportHash,
  boundaryWitness,
  mounts: [
    { name: 'application', access: 'read-only', contents: 'amnesia-author-browser-build' },
    { name: 'dataset', access: 'read-only', contents: 'held-out-source-case' },
    { name: 'candidate-output', access: 'write-only', contents: 'one-exported-recipe' },
  ],
  candidates,
}
const attestation = { ...payload, attestationHash: sha256Canonical(payload) }
await writeFile(path.resolve(String(options.output)), `${JSON.stringify(attestation, null, 2)}\n`, { flag: 'wx' })
process.stdout.write(`${JSON.stringify({
  candidateCommit: attestation.candidateCommit,
  attestationHash: attestation.attestationHash,
  candidates: attestation.candidates,
}, null, 2)}\n`)
