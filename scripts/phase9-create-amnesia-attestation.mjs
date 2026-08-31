#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AMNESIA_DENIED_RESOURCES,
  AMNESIA_PUBLIC_TOOLS,
  recipeSemanticHash,
} from './lib/amnesia-evidence.mjs'
import { sha256Canonical } from './lib/oracle-receipts.mjs'

function argumentsByName(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const next = argv[index + 1]
    result[key.slice(2)] = next && !next.startsWith('--') ? argv[++index] : true
  }
  return result
}

const options = argumentsByName(process.argv.slice(2))
for (const required of ['candidate-commit', 'waymo-recipe', 'nuscenes-recipe', 'argoverse2-recipe', 'output']) {
  if (!options[required]) throw new Error(`Missing --${required}`)
}
if (!/^[0-9a-f]{40}$/u.test(String(options['candidate-commit']))) {
  throw new Error('--candidate-commit must be a full Git SHA')
}

const candidates = []
for (const datasetId of ['waymo', 'nuscenes', 'argoverse2']) {
  const recipe = JSON.parse(await readFile(path.resolve(String(options[`${datasetId}-recipe`])), 'utf8'))
  if (recipe.provenance?.author !== 'codex') throw new Error(`${datasetId}: Adapter Amnesia recipe must be authored by Codex`)
  candidates.push({ datasetId, authoredBy: 'codex', recipeHash: recipeSemanticHash(recipe) })
}
const payload = {
  kind: 'egolens-adapter-amnesia-attestation',
  schemaVersion: 1,
  candidateCommit: String(options['candidate-commit']),
  authoringRuntimeId: 'egolens-adapter-amnesia-author-v1',
  publicContract: {
    recipeSchemaVersion: 1,
    recipeEngineVersion: '1.0.0',
    normalizedSceneVersion: 1,
  },
  publicTools: [...AMNESIA_PUBLIC_TOOLS],
  deniedResources: [...AMNESIA_DENIED_RESOURCES],
  networkEgress: false,
  interactiveJudgeAccess: false,
  mounts: [
    { name: 'application', access: 'read-only', contents: 'amnesia-author-browser-build' },
    { name: 'dataset', access: 'read-only', contents: 'held-out-source-case' },
    { name: 'candidate-output', access: 'write-only', contents: 'recipe-and-conformance-artifacts' },
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
