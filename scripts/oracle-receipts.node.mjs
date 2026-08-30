import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  judgeBundle,
  sha256Canonical,
  signReceipt,
  verifyBundle,
  verifySignedReceipt,
} from './lib/oracle-receipts.mjs'

test('matches the browser canonical hash contract', () => {
  assert.equal(
    sha256Canonical({ z: [3, '한글', true], a: { n: null, value: 1.25 } }),
    'sha256-9fd43762a11e86d2c326684ff7e8bb29beaf2b394d60315a84b4fd6dbd37b991',
  )
})

function artifact(value = 1, datasetId = 'waymo') {
  const payload = {
    kind: 'egolens-scene-conformance',
    schemaVersion: 1,
    target: { datasetId, caseId: 'fixture' },
    coverage: {
      requiredCapabilities: ['pointClouds', 'timeline'],
      frameIndices: [0],
      completeTimeline: true,
      perceptualReferenceIds: [],
    },
    structural: { frameCount: 1 },
    numeric: { point: value },
    perceptual: [],
    summaryHash: sha256Canonical({
      structural: { frameCount: 1 },
      numeric: { point: value },
      perceptual: [],
    }),
  }
  return { ...payload, artifactHash: sha256Canonical(payload) }
}

function bundle(candidate = artifact()) {
  const payload = {
    kind: 'egolens-hidden-oracle',
    schemaVersion: 1,
    provenance: {
      generatorCommit: 'a42f658e27fce118789d3648e2612f5d25b99488',
      legacyRuntimeId: 'fixture-runtime',
      sourceFingerprint: `sha256-${'a'.repeat(64)}`,
      generatedAt: '2026-08-30T00:00:00.000Z',
    },
    artifact: candidate,
  }
  return { ...payload, bundleHash: sha256Canonical(payload) }
}

test('signs and verifies a passing one-shot oracle receipt', () => {
  const hidden = bundle()
  assert.equal(verifyBundle(hidden), true)
  const receipt = judgeBundle(hidden, artifact(), {
    judgeVersion: 'test-v1',
    judgedAt: '2026-08-30T01:00:00.000Z',
  })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = signReceipt(
    receipt,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    'test-key',
  )

  assert.equal(signed.passed, true)
  assert.equal(verifySignedReceipt(
    signed,
    publicKey.export({ type: 'spki', format: 'pem' }),
    'test-key',
  ), true)
})

test('rejects altered observations and altered signed receipts', () => {
  const hidden = bundle()
  const drifted = artifact(9)
  const receipt = judgeBundle(hidden, drifted, {
    judgeVersion: 'test-v1',
    judgedAt: '2026-08-30T01:00:00.000Z',
  })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = signReceipt(
    receipt,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    'test-key',
  )

  assert.equal(receipt.passed, false)
  assert.deepEqual(receipt.checks.find((check) => check.name === 'numeric'), {
    name: 'numeric',
    passed: false,
    mismatchPaths: ['/numeric/point'],
  })
  assert.equal(verifySignedReceipt(
    { ...signed, passed: true },
    publicKey.export({ type: 'spki', format: 'pem' }),
    'test-key',
  ), false)
})

test('receipt gate requires one signed receipt for each migrated dataset', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'egolens-oracle-gate-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicPath = join(directory, 'judge-public.pem')
  const privatePath = join(directory, 'judge-private.pem')
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }))
  writeFileSync(privatePath, privatePem)
  const targets = []
  const receiptPaths = ['waymo', 'nuscenes', 'argoverse2'].map((datasetId) => {
    const candidate = artifact(1, datasetId)
    const oracle = bundle(candidate)
    targets.push({ ...candidate.target, coverage: candidate.coverage })
    const oraclePath = join(directory, `${datasetId}.oracle.json`)
    const candidatePath = join(directory, `${datasetId}.candidate.json`)
    const receiptPath = join(directory, `${datasetId}.json`)
    writeFileSync(oraclePath, `${JSON.stringify(oracle)}\n`)
    writeFileSync(candidatePath, `${JSON.stringify(candidate)}\n`)
    const judgeResult = spawnSync(process.execPath, [
      'scripts/phase6-oracle-judge.mjs',
      '--oracle', oraclePath,
      '--candidate', candidatePath,
      '--private-key', privatePath,
      '--key-id', 'test-key',
      '--judge-version', 'test-v1',
      '--output', receiptPath,
    ], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(judgeResult.status, 0, judgeResult.stderr)
    return receiptPath
  })
  const requirementsPath = join(directory, 'requirements.json')
  writeFileSync(requirementsPath, `${JSON.stringify({
    kind: 'egolens-oracle-gate-requirements',
    schemaVersion: 1,
    targets,
  })}\n`)
  const reportPath = join(directory, 'report.json')
  const result = spawnSync(process.execPath, [
    'scripts/phase6-oracle-receipt-gate.mjs',
    ...receiptPaths.flatMap((receiptPath) => ['--receipt', receiptPath]),
    '--requirements', requirementsPath,
    '--public-key', publicPath,
    '--key-id', 'test-key',
    '--expected-generator-commit', 'a42f658e27fce118789d3648e2612f5d25b99488',
    '--output', reportPath,
  ], { cwd: process.cwd(), encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).passed, true)

  const duplicateResult = spawnSync(process.execPath, [
    'scripts/phase6-oracle-receipt-gate.mjs',
    '--receipt', receiptPaths[0],
    '--receipt', receiptPaths[0],
    '--receipt', receiptPaths[0],
    '--requirements', requirementsPath,
    '--public-key', publicPath,
    '--key-id', 'test-key',
    '--expected-generator-commit', 'a42f658e27fce118789d3648e2612f5d25b99488',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(duplicateResult.status, 1)
})
