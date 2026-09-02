#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { verifyAmnesiaBoundaryBinding } from './lib/amnesia-evidence.mjs'
import { verifyBoundaryCaseArtifact } from './lib/phase9-counted-author-boundary.mjs'
import { canonicalize, verifyArtifact, verifyBundle } from './lib/oracle-receipts.mjs'

const DATASETS = ['waymo', 'nuscenes', 'argoverse2']
const CHUNK_BYTES = 40_000
const MAX_CHUNKS = 24
const REQUIREMENTS_KIND = 'egolens-adapter-amnesia-gate-requirements'
const RECIPE_BINDING = 'author-attestation'

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

async function jsonFile(filename) {
  return JSON.parse(await readFile(path.resolve(String(filename)), 'utf8'))
}

function runGh(args, input) {
  const result = spawnSync('gh', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh ${args.join(' ')} failed`)
}

function validateRequirements(requirements) {
  if (requirements?.kind !== REQUIREMENTS_KIND
    || requirements.schemaVersion !== 2
    || requirements.recipeBinding !== RECIPE_BINDING
    || !Array.isArray(requirements.targets)
    || requirements.targets.length !== DATASETS.length) {
    throw new Error('Invalid Adapter Amnesia requirements document')
  }
  const targetKeys = requirements.targets.map((target) => `${target?.datasetId}\u0000${target?.caseId}`)
  const datasets = requirements.targets.map((target) => target?.datasetId).sort()
  if (new Set(targetKeys).size !== targetKeys.length
    || canonicalize(datasets) !== canonicalize([...DATASETS].sort())
    || requirements.targets.some((target) => typeof target?.caseId !== 'string'
      || target.caseId.length === 0
      || !target.coverage
      || typeof target.coverage !== 'object'
      || Array.isArray(target.coverage)
      || Object.hasOwn(target, 'recipeHash'))) {
    throw new Error('Requirements must contain unique reviewed targets and coverage for all three datasets')
  }
}

const REQUIRED_OPTIONS = Object.freeze([
  'environment', 'requirements', 'attestation', 'boundary-report',
  'expected-producer-commit', 'expected-candidate-commit',
  ...DATASETS.flatMap((dataset) => ['oracle', 'candidate', 'boundary-case'].map((kind) => `${dataset}-${kind}`)),
])
const options = argumentsByName(
  process.argv.slice(2),
  new Set([...REQUIRED_OPTIONS, 'dry-run']),
  new Set(['dry-run']),
)
for (const required of REQUIRED_OPTIONS) {
  if (!options[required]) throw new Error(`Missing --${required}`)
}

const [requirements, attestation, boundaryReport] = await Promise.all([
  jsonFile(options.requirements),
  jsonFile(options.attestation),
  jsonFile(options['boundary-report']),
])
validateRequirements(requirements)
if (!verifyAmnesiaBoundaryBinding(
  attestation,
  boundaryReport,
  String(options['expected-candidate-commit']),
)) {
  throw new Error('Invalid Adapter Amnesia authoring attestation or protected boundary report')
}
const requirementByDataset = new Map(requirements.targets?.map((target) => [target.datasetId, target]) ?? [])
const attestationByDataset = new Map(attestation.candidates.map((candidate) => [candidate.datasetId, candidate]))
const boundaryByDataset = new Map(boundaryReport.cases.map((entry) => [entry.datasetId, entry]))
if (requirementByDataset.size !== DATASETS.length || attestationByDataset.size !== DATASETS.length) {
  throw new Error('Requirements and attestation must contain exactly one target per dataset')
}

const envelope = {
  schemaVersion: 3,
  attestation,
  boundaryReport,
  boundaryCaseArtifacts: {},
  datasets: {},
}
for (const dataset of DATASETS) {
  const [oracle, candidate, boundaryCaseArtifact] = await Promise.all([
    jsonFile(options[`${dataset}-oracle`]),
    jsonFile(options[`${dataset}-candidate`]),
    jsonFile(options[`${dataset}-boundary-case`]),
  ])
  const requirement = requirementByDataset.get(dataset)
  const authored = attestationByDataset.get(dataset)
  const boundaryCase = boundaryByDataset.get(dataset)
  if (!verifyBundle(oracle) || !verifyArtifact(candidate)) throw new Error(`${dataset}: invalid oracle or candidate integrity`)
  if (oracle.provenance.generatorCommit !== String(options['expected-producer-commit'])) {
    throw new Error(`${dataset}: unexpected oracle producer commit`)
  }
  if (candidate.provenance.generatorCommit !== String(options['expected-candidate-commit'])) {
    throw new Error(`${dataset}: unexpected candidate commit`)
  }
  if (authored.caseId !== requirement?.caseId) {
    throw new Error(`${dataset}: author attestation does not cover the reviewed case`)
  }
  if (boundaryCase?.caseId !== requirement?.caseId
    || boundaryCase.recipeHash !== authored.recipeHash
    || candidate.provenance.sourceFingerprint !== boundaryCase.sourceFingerprint) {
    throw new Error(`${dataset}: candidate is not bound to the counted author source and recipe export`)
  }
  if (!verifyBoundaryCaseArtifact(boundaryCaseArtifact, String(options['expected-candidate-commit']))
    || canonicalize(boundaryCaseArtifact.boundaryCase) !== canonicalize(boundaryCase)
    || boundaryCaseArtifact.boundaryCase.sourceCommit !== String(options['expected-candidate-commit'])
    || boundaryCaseArtifact.boundaryCase.applicationBuildHash !== boundaryCase.applicationBuildHash
    || boundaryCaseArtifact.boundaryCase.recipeHash !== authored.recipeHash) {
    throw new Error(`${dataset}: protected boundary-case artifact does not prove the reported counted run`)
  }
  const expectedRuntimeId = `egolens-amnesia-${options['expected-candidate-commit']}-${authored.recipeHash}`
  if (candidate.provenance.runtimeId !== expectedRuntimeId) {
    throw new Error(`${dataset}: candidate did not run with the author-attested recipe hash`)
  }
  if (canonicalize(oracle.artifact.target) !== canonicalize({
    datasetId: requirement?.datasetId,
    caseId: requirement?.caseId,
  })) throw new Error(`${dataset}: oracle target does not match requirements`)
  if (canonicalize(candidate.target) !== canonicalize(oracle.artifact.target)
    || canonicalize(candidate.coverage) !== canonicalize(requirement.coverage)
    || canonicalize(oracle.artifact.coverage) !== canonicalize(requirement.coverage)
    || candidate.provenance.sourceFingerprint !== oracle.provenance.sourceFingerprint) {
    throw new Error(`${dataset}: target, source, or reviewed coverage mismatch`)
  }
  envelope.boundaryCaseArtifacts[dataset] = boundaryCaseArtifact
  envelope.datasets[dataset] = { oracle, candidate }
}

const compressed = gzipSync(Buffer.from(JSON.stringify(envelope)), { level: 9 })
const encoded = compressed.toString('base64')
const chunks = []
for (let offset = 0; offset < encoded.length; offset += CHUNK_BYTES) {
  chunks.push(encoded.slice(offset, offset + CHUNK_BYTES))
}
if (chunks.length > MAX_CHUNKS) throw new Error(`Evidence archive requires ${chunks.length} chunks; maximum is ${MAX_CHUNKS}`)
const archiveHash = `sha256-${createHash('sha256').update(compressed).digest('hex')}`

if (!options['dry-run']) {
  for (const [index, chunk] of chunks.entries()) {
    const name = `PHASE9_AMNESIA_EVIDENCE_${String(index + 1).padStart(2, '0')}`
    runGh(['secret', 'set', name, '--env', String(options.environment)], chunk)
  }
  runGh(['variable', 'set', 'PHASE9_AMNESIA_EVIDENCE_PARTS', '--env', String(options.environment), '--body', String(chunks.length)])
  runGh(['variable', 'set', 'PHASE9_AMNESIA_EVIDENCE_ARCHIVE_SHA256', '--env', String(options.environment), '--body', archiveHash])
}

process.stdout.write(`${JSON.stringify({
  staged: !options['dry-run'],
  environment: options.environment,
  attestationHash: attestation.attestationHash,
  datasets: DATASETS,
  compressedBytes: compressed.byteLength,
  encodedBytes: encoded.length,
  chunks: chunks.length,
  chunkBytes: CHUNK_BYTES,
  archiveHash,
}, null, 2)}\n`)
