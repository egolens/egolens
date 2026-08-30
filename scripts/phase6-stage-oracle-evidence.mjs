#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import {
  canonicalize,
  verifyArtifact,
  verifyBundle,
} from './lib/oracle-receipts.mjs'

const DATASETS = ['waymo', 'nuscenes', 'argoverse2']
const CHUNK_BYTES = 40_000
const MAX_CHUNKS = 24

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

const options = argumentsByName(process.argv.slice(2))
for (const required of ['environment', 'requirements', 'expected-producer-commit', 'expected-candidate-commit']) {
  if (!options[required]) throw new Error(`Missing --${required}`)
}
for (const dataset of DATASETS) {
  for (const kind of ['oracle', 'candidate']) {
    if (!options[`${dataset}-${kind}`]) throw new Error(`Missing --${dataset}-${kind}`)
  }
}

const requirements = await jsonFile(options.requirements)
const requirementByDataset = new Map(requirements.targets?.map((target) => [target.datasetId, target]) ?? [])
if (requirementByDataset.size !== DATASETS.length) throw new Error('Requirements must contain exactly one target per dataset')

const envelope = { schemaVersion: 1, datasets: {} }
for (const dataset of DATASETS) {
  const oracle = await jsonFile(options[`${dataset}-oracle`])
  const candidate = await jsonFile(options[`${dataset}-candidate`])
  const requirement = requirementByDataset.get(dataset)
  if (!verifyBundle(oracle) || !verifyArtifact(candidate)) throw new Error(`${dataset}: invalid oracle or candidate integrity`)
  if (oracle.provenance.generatorCommit !== String(options['expected-producer-commit'])) {
    throw new Error(`${dataset}: unexpected oracle producer commit`)
  }
  if (candidate.provenance.generatorCommit !== String(options['expected-candidate-commit'])) {
    throw new Error(`${dataset}: unexpected candidate commit`)
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
  envelope.datasets[dataset] = { oracle, candidate }
}

const compressed = gzipSync(Buffer.from(JSON.stringify(envelope)), { level: 9 })
const encoded = compressed.toString('base64')
const chunks = []
for (let offset = 0; offset < encoded.length; offset += CHUNK_BYTES) {
  chunks.push(encoded.slice(offset, offset + CHUNK_BYTES))
}
if (chunks.length > MAX_CHUNKS) {
  throw new Error(`Evidence archive requires ${chunks.length} chunks; maximum is ${MAX_CHUNKS}`)
}
const archiveHash = `sha256-${createHash('sha256').update(compressed).digest('hex')}`

if (!options['dry-run']) {
  for (const [index, chunk] of chunks.entries()) {
    const name = `PHASE6_ORACLE_EVIDENCE_${String(index + 1).padStart(2, '0')}`
    runGh(['secret', 'set', name, '--env', String(options.environment)], chunk)
  }
  runGh([
    'variable', 'set', 'PHASE6_ORACLE_EVIDENCE_PARTS',
    '--env', String(options.environment), '--body', String(chunks.length),
  ])
  runGh([
    'variable', 'set', 'PHASE6_ORACLE_EVIDENCE_ARCHIVE_SHA256',
    '--env', String(options.environment), '--body', archiveHash,
  ])
}

process.stdout.write(`${JSON.stringify({
  staged: !options['dry-run'],
  environment: options.environment,
  datasets: DATASETS,
  compressedBytes: compressed.byteLength,
  encodedBytes: encoded.length,
  chunks: chunks.length,
  chunkBytes: CHUNK_BYTES,
  archiveHash,
}, null, 2)}\n`)
