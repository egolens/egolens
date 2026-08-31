import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import UPNG from 'upng-js'
import {
  judgeBundle,
  sha256Canonical,
  signReceipt,
  verifyBundle,
  verifySignedReceipt,
} from './lib/oracle-receipts.mjs'
import { perceptualRasterSha256V1 } from './lib/perceptual-raster.mjs'

const PRODUCER_COMMIT = 'a42f658e27fce118789d3648e2612f5d25b99488'
const CANDIDATE_COMMIT = '1d34b6f000000000000000000000000000000000'
const SOURCE_FINGERPRINT = `sha256-${'a'.repeat(64)}`

test('matches the browser canonical hash contract', () => {
  assert.equal(
    sha256Canonical({ z: [3, '한글', true], a: { n: null, value: 1.25 } }),
    'sha256-9fd43762a11e86d2c326684ff7e8bb29beaf2b394d60315a84b4fd6dbd37b991',
  )
})

function png(width, height, pixel) {
  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) rgba.set([...pixel, 255], index * 4)
  return Buffer.from(UPNG.encode([rgba.buffer], width, height, 0))
}

test('perceptual raster hash ignores isolated compositor rounding but catches visible drift', () => {
  const baseline = png(64, 64, [80, 81, 87])
  const roundingNoise = Buffer.from(baseline)
  const decoded = UPNG.decode(roundingNoise.buffer.slice(roundingNoise.byteOffset, roundingNoise.byteOffset + roundingNoise.byteLength))
  const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0])
  rgba[0] += 1
  const noisy = Buffer.from(UPNG.encode([rgba.buffer], 64, 64, 0))
  const drift = png(64, 64, [120, 81, 87])

  assert.equal(perceptualRasterSha256V1(baseline), perceptualRasterSha256V1(noisy))
  assert.notEqual(perceptualRasterSha256V1(baseline), perceptualRasterSha256V1(drift))
})

function artifact(value = 1, datasetId = 'waymo', generatorCommit = CANDIDATE_COMMIT) {
  const payload = {
    kind: 'egolens-scene-conformance',
    schemaVersion: 1,
    provenance: {
      generatorCommit,
      runtimeId: generatorCommit === PRODUCER_COMMIT ? 'fixture-runtime' : 'candidate-runtime',
      sourceFingerprint: SOURCE_FINGERPRINT,
      capturedAt: '2026-08-30T00:00:00.000Z',
    },
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

function bundle(candidate = artifact(1, 'waymo', PRODUCER_COMMIT)) {
  const payload = {
    kind: 'egolens-hidden-oracle',
    schemaVersion: 1,
    provenance: {
      generatorCommit: PRODUCER_COMMIT,
      legacyRuntimeId: 'fixture-runtime',
      sourceFingerprint: SOURCE_FINGERPRINT,
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
  assert.equal(signed.candidateGeneratorCommit, CANDIDATE_COMMIT)
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

test('rejects a candidate artifact from a different source case', () => {
  const hidden = bundle()
  const candidate = artifact()
  candidate.provenance.sourceFingerprint = `sha256-${'b'.repeat(64)}`
  candidate.artifactHash = sha256Canonical((({ artifactHash: _, ...payload }) => payload)(candidate))
  const receipt = judgeBundle(hidden, candidate, {
    judgeVersion: 'test-v1',
    judgedAt: '2026-08-30T01:00:00.000Z',
  })
  assert.equal(receipt.checks.find((check) => check.name === 'target').passed, false)
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
  const evidencePaths = new Map()
  const receiptPaths = ['waymo', 'nuscenes', 'argoverse2'].map((datasetId) => {
    const candidate = artifact(1, datasetId)
    const oracle = bundle(artifact(1, datasetId, PRODUCER_COMMIT))
    targets.push({ ...candidate.target, coverage: candidate.coverage })
    const oraclePath = join(directory, `${datasetId}.oracle.json`)
    const candidatePath = join(directory, `${datasetId}.candidate.json`)
    const receiptPath = join(directory, `${datasetId}.json`)
    writeFileSync(oraclePath, `${JSON.stringify(oracle)}\n`)
    writeFileSync(candidatePath, `${JSON.stringify(candidate)}\n`)
    evidencePaths.set(datasetId, { oraclePath, candidatePath })
    const judgeResult = spawnSync(process.execPath, [
      'scripts/phase6-oracle-judge.mjs',
      '--oracle', oraclePath,
      '--candidate', candidatePath,
      '--private-key', privatePath,
      '--key-id', 'test-key',
      '--judge-version', 'test-v1',
      '--expected-candidate-commit', CANDIDATE_COMMIT,
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
    '--expected-generator-commit', PRODUCER_COMMIT,
    '--expected-candidate-commit', CANDIDATE_COMMIT,
    '--output', reportPath,
  ], { cwd: process.cwd(), encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).passed, true)

  const stageResult = spawnSync(process.execPath, [
    'scripts/phase6-stage-oracle-evidence.mjs',
    '--environment', 'fixture-environment',
    '--requirements', requirementsPath,
    '--expected-producer-commit', PRODUCER_COMMIT,
    '--expected-candidate-commit', CANDIDATE_COMMIT,
    ...['waymo', 'nuscenes', 'argoverse2'].flatMap((datasetId) => {
      const paths = evidencePaths.get(datasetId)
      return [
        `--${datasetId}-oracle`, paths.oraclePath,
        `--${datasetId}-candidate`, paths.candidatePath,
      ]
    }),
    '--dry-run',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(stageResult.status, 0, stageResult.stderr)
  const staged = JSON.parse(stageResult.stdout)
  assert.equal(staged.staged, false)
  assert.equal(staged.environment, 'fixture-environment')
  assert.deepEqual(staged.datasets, ['waymo', 'nuscenes', 'argoverse2'])
  assert.ok(staged.compressedBytes > 0)
  assert.equal(staged.encodedBytes, Math.ceil(staged.compressedBytes / 3) * 4)
  assert.equal(staged.chunks, 1)
  assert.equal(staged.chunkBytes, 40000)
  assert.match(staged.archiveHash, /^sha256-[0-9a-f]{64}$/u)

  const staleCandidateResult = spawnSync(process.execPath, [
    'scripts/phase6-oracle-receipt-gate.mjs',
    ...receiptPaths.flatMap((receiptPath) => ['--receipt', receiptPath]),
    '--requirements', requirementsPath,
    '--public-key', publicPath,
    '--key-id', 'test-key',
    '--expected-generator-commit', PRODUCER_COMMIT,
    '--expected-candidate-commit', 'ffffffffffffffffffffffffffffffffffffffff',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(staleCandidateResult.status, 1)

  const duplicateResult = spawnSync(process.execPath, [
    'scripts/phase6-oracle-receipt-gate.mjs',
    '--receipt', receiptPaths[0],
    '--receipt', receiptPaths[0],
    '--receipt', receiptPaths[0],
    '--requirements', requirementsPath,
    '--public-key', publicPath,
    '--key-id', 'test-key',
    '--expected-generator-commit', PRODUCER_COMMIT,
    '--expected-candidate-commit', CANDIDATE_COMMIT,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(duplicateResult.status, 1)
})
