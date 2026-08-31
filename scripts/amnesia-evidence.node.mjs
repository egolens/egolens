import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  AMNESIA_DENIED_RESOURCES,
  AMNESIA_PUBLIC_TOOLS,
  recipeSemanticHash,
  verifyAmnesiaAttestation,
} from './lib/amnesia-evidence.mjs'
import { judgeBundle, sha256Canonical, signReceipt } from './lib/oracle-receipts.mjs'

const PRODUCER_COMMIT = 'a42f658e27fce118789d3648e2612f5d25b99488'
const CANDIDATE_COMMIT = '1d34b6f000000000000000000000000000000000'
const SOURCE_FINGERPRINT = `sha256-${'a'.repeat(64)}`

function recipe(datasetId) {
  return {
    kind: 'egolens-adapter', schemaVersion: 1,
    identity: { name: datasetId }, provenance: { author: 'codex' },
    engine: { minimumVersion: '1.0.0', requiredOperators: {} },
    scene: { formatId: datasetId }, sources: {}, pipelines: {}, outputs: {}, validation: {}, match: {},
  }
}

function artifact(datasetId, recipeHash, generatorCommit = CANDIDATE_COMMIT) {
  const payload = {
    kind: 'egolens-scene-conformance', schemaVersion: 1,
    provenance: {
      generatorCommit,
      runtimeId: generatorCommit === PRODUCER_COMMIT
        ? 'fixture-legacy-runtime'
        : `egolens-amnesia-${generatorCommit}-${recipeHash}`,
      sourceFingerprint: SOURCE_FINGERPRINT,
      capturedAt: '2026-08-30T00:00:00.000Z',
    },
    target: { datasetId, caseId: `${datasetId}-fixture` },
    coverage: {
      requiredCapabilities: ['pointClouds', 'timeline'],
      frameIndices: [0], completeTimeline: true, perceptualReferenceIds: [],
    },
    structural: { frameCount: 1 }, numeric: { point: 1 }, perceptual: [],
    summaryHash: sha256Canonical({ structural: { frameCount: 1 }, numeric: { point: 1 }, perceptual: [] }),
  }
  return { ...payload, artifactHash: sha256Canonical(payload) }
}

function bundle(candidate) {
  const payload = {
    kind: 'egolens-hidden-oracle', schemaVersion: 1,
    provenance: {
      generatorCommit: PRODUCER_COMMIT,
      legacyRuntimeId: 'fixture-legacy-runtime',
      sourceFingerprint: SOURCE_FINGERPRINT,
      generatedAt: '2026-08-30T00:00:00.000Z',
    }, artifact: candidate,
  }
  return { ...payload, bundleHash: sha256Canonical(payload) }
}

test('attests the exact public-only Adapter Amnesia boundary', () => {
  const candidates = ['waymo', 'nuscenes', 'argoverse2'].map((datasetId) => ({
    datasetId, authoredBy: 'codex', recipeHash: recipeSemanticHash(recipe(datasetId)),
  }))
  const payload = {
    kind: 'egolens-adapter-amnesia-attestation', schemaVersion: 1,
    candidateCommit: CANDIDATE_COMMIT,
    authoringRuntimeId: 'egolens-adapter-amnesia-author-v1',
    publicContract: { recipeSchemaVersion: 1, recipeEngineVersion: '1.0.0', normalizedSceneVersion: 1 },
    publicTools: [...AMNESIA_PUBLIC_TOOLS], deniedResources: [...AMNESIA_DENIED_RESOURCES],
    networkEgress: false, interactiveJudgeAccess: false,
    mounts: [
      { name: 'application', access: 'read-only', contents: 'amnesia-author-browser-build' },
      { name: 'dataset', access: 'read-only', contents: 'held-out-source-case' },
      { name: 'candidate-output', access: 'write-only', contents: 'recipe-and-conformance-artifacts' },
    ], candidates,
  }
  const attestation = { ...payload, attestationHash: sha256Canonical(payload) }
  assert.equal(verifyAmnesiaAttestation(attestation, CANDIDATE_COMMIT), true)
  assert.equal(verifyAmnesiaAttestation({ ...attestation, interactiveJudgeAccess: true }, CANDIDATE_COMMIT), false)
  assert.equal(verifyAmnesiaAttestation(attestation, 'f'.repeat(40)), false)
})

test('reviewed Phase 9 recipe hashes and coverage cannot drift silently', () => {
  const phase6 = JSON.parse(readFileSync('benchmarks/oracle/phase6-requirements.json', 'utf8'))
  const phase9 = JSON.parse(readFileSync('benchmarks/oracle/phase9-requirements.json', 'utf8'))
  const phase6ByDataset = new Map(phase6.targets.map((target) => [target.datasetId, target]))
  for (const target of phase9.targets) {
    const authored = JSON.parse(readFileSync(`src/adapters/recipes/${target.datasetId}.egolens-adapter.json`, 'utf8'))
    assert.equal(target.recipeHash, recipeSemanticHash(authored))
    assert.deepEqual(target.coverage, phase6ByDataset.get(target.datasetId).coverage)
  }
})

test('judges and gates three exact-head Amnesia candidates', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'egolens-amnesia-gate-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePath = join(directory, 'private.pem')
  const publicPath = join(directory, 'public.pem')
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }))

  const recipes = new Map()
  const targets = []
  const evidence = new Map()
  for (const datasetId of ['waymo', 'nuscenes', 'argoverse2']) {
    const value = recipe(datasetId)
    const recipePath = join(directory, `${datasetId}.recipe.json`)
    writeFileSync(recipePath, `${JSON.stringify(value)}\n`)
    recipes.set(datasetId, { recipePath, recipeHash: recipeSemanticHash(value) })
  }
  const attestationPath = join(directory, 'attestation.json')
  const create = spawnSync(process.execPath, [
    'scripts/phase9-create-amnesia-attestation.mjs',
    '--candidate-commit', CANDIDATE_COMMIT,
    ...[...recipes].flatMap(([datasetId, value]) => [`--${datasetId}-recipe`, value.recipePath]),
    '--output', attestationPath,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(create.status, 0, create.stderr)
  const attestation = JSON.parse(readFileSync(attestationPath, 'utf8'))
  assert.equal(verifyAmnesiaAttestation(attestation, CANDIDATE_COMMIT), true)

  const receiptPaths = []
  for (const datasetId of ['waymo', 'nuscenes', 'argoverse2']) {
    const recipeHash = recipes.get(datasetId).recipeHash
    const candidate = artifact(datasetId, recipeHash)
    const oracle = bundle(artifact(datasetId, recipeHash, PRODUCER_COMMIT))
    const oraclePath = join(directory, `${datasetId}.oracle.json`)
    const candidatePath = join(directory, `${datasetId}.candidate.json`)
    const receiptPath = join(directory, `${datasetId}.receipt.json`)
    const reportPath = join(directory, `${datasetId}.trusted.json`)
    writeFileSync(oraclePath, `${JSON.stringify(oracle)}\n`)
    writeFileSync(candidatePath, `${JSON.stringify(candidate)}\n`)
    evidence.set(datasetId, { oraclePath, candidatePath })
    targets.push({ ...candidate.target, recipeHash, coverage: candidate.coverage })
    const judge = spawnSync(process.execPath, [
      'scripts/phase9-oracle-judge.mjs',
      '--oracle', oraclePath, '--candidate', candidatePath,
      '--attestation', attestationPath,
      '--private-key', privatePath, '--key-id', 'test-key', '--judge-version', 'phase9-test-v1',
      '--expected-candidate-commit', CANDIDATE_COMMIT,
      '--output', receiptPath, '--trusted-report', reportPath,
    ], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(judge.status, 0, judge.stderr)
    receiptPaths.push(receiptPath)
  }
  const requirementsPath = join(directory, 'requirements.json')
  writeFileSync(requirementsPath, `${JSON.stringify({
    kind: 'egolens-adapter-amnesia-gate-requirements', schemaVersion: 1, targets,
  })}\n`)
  const gate = spawnSync(process.execPath, [
    'scripts/phase9-oracle-receipt-gate.mjs',
    ...receiptPaths.flatMap((receiptPath) => ['--receipt', receiptPath]),
    '--requirements', requirementsPath, '--attestation', attestationPath,
    '--public-key', publicPath, '--key-id', 'test-key',
    '--expected-generator-commit', PRODUCER_COMMIT,
    '--expected-candidate-commit', CANDIDATE_COMMIT,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(gate.status, 0, gate.stderr)
  assert.equal(JSON.parse(gate.stdout).passed, true)

  const stage = spawnSync(process.execPath, [
    'scripts/phase9-stage-amnesia-evidence.mjs',
    '--environment', 'fixture', '--requirements', requirementsPath, '--attestation', attestationPath,
    '--expected-producer-commit', PRODUCER_COMMIT, '--expected-candidate-commit', CANDIDATE_COMMIT,
    ...[...evidence].flatMap(([datasetId, value]) => [
      `--${datasetId}-oracle`, value.oraclePath, `--${datasetId}-candidate`, value.candidatePath,
    ]), '--dry-run',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(stage.status, 0, stage.stderr)
  assert.equal(JSON.parse(stage.stdout).staged, false)

  const stale = spawnSync(process.execPath, [
    'scripts/phase9-oracle-receipt-gate.mjs',
    ...receiptPaths.flatMap((receiptPath) => ['--receipt', receiptPath]),
    '--requirements', requirementsPath, '--attestation', attestationPath,
    '--public-key', publicPath, '--key-id', 'test-key',
    '--expected-generator-commit', PRODUCER_COMMIT,
    '--expected-candidate-commit', 'f'.repeat(40),
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.notEqual(stale.status, 0)
})
