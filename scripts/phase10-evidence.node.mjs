import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  PHASE10_PUBLIC_TOOLS,
  PHASE10_REQUIRED_NEGATIVE_CASES,
  createDecisionLedgerEntryV1,
  humanReviewPayloadV1,
  phase10HashV1,
  publicSafetyViolationsV1,
  sourceManifestHashFromFilesV1,
  validateCaseReserveManifestSemanticsV1,
  validateDecisionLedgerV1,
  validateFirstFailureSemanticsV1,
  validateGeneralizationAttemptSemanticsV1,
  validatePhase10BaselineFreezeSemanticsV1,
  validateSourceCaseManifestSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { loadPhase10SchemasV1, validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'
import { sha256Canonical } from './lib/oracle-receipts.mjs'
import {
  closeFreshProcessWorkspaceV1,
  createFreshProcessWorkspaceV1,
  validateFreshProcessEvidenceSetV1,
} from './lib/fresh-process-evidence.mjs'

const COMMIT = 'a'.repeat(40)
const hash = (label) => phase10HashV1({ label })

function sourceCase(role, order, reserveFor = null) {
  const files = [{ path: `${String(order).padStart(2, '0')}/source.bin`, size: 3, sha256: hash(`file-${order}`) }]
  const payload = {
    schema: 'egolens-source-case-manifest-v1',
    release: {
      datasetId: 'fixture-dataset', releaseId: 'official-v1',
      officialSourceUrl: 'https://data.example.test/release', officialArchiveChecksum: null,
    },
    case: {
      caseId: `case-${role.toLowerCase()}-${order}`, role, reserveFor, order,
      originalForm: 'complete-official-subtree', unchangedOriginal: true,
      archiveExtractionOnly: false, declaredCapabilities: ['pointClouds', 'timeline'],
    },
    files,
    aggregate: { fileCount: files.length, totalBytes: 3 },
    sourceManifestHash: sourceManifestHashFromFilesV1(files),
  }
  return { ...payload, manifestHash: phase10HashV1(payload) }
}

function reserveManifest() {
  const cases = [sourceCase('D', 0), sourceCase('A', 1), sourceCase('B', 2), sourceCase('reserve', 3, 'A')]
  const payload = {
    schema: 'egolens-case-reserve-manifest-v1', rung: 1,
    datasetId: 'fixture-dataset', releaseId: 'official-v1',
    officialSourceUrl: 'https://data.example.test/release', frozenBeforeInspection: true,
    cases: cases.map((entry) => ({
      order: entry.case.order, role: entry.case.role, reserveFor: entry.case.reserveFor,
      caseId: entry.case.caseId, sourceCaseManifestHash: entry.manifestHash,
      sourceManifestHash: entry.sourceManifestHash,
      fileCount: entry.aggregate.fileCount, totalBytes: entry.aggregate.totalBytes,
    })),
  }
  return { ...payload, manifestHash: phase10HashV1(payload) }
}

function humanReview() {
  const payload = {
    rejectedRecipeHash: hash('rejected'), correctedRecipeHash: hash('corrected'),
    preservedRecipeHash: hash('preserved'), reviewedCapabilities: ['boxes3d', 'pointClouds'],
    reviewedFrames: [0, 2], defectClass: 'calibration', findingHash: hash('finding'),
    lastGoodScenePreserved: true,
  }
  return { ...payload, receiptHash: phase10HashV1(humanReviewPayloadV1(payload)) }
}

function attemptA() {
  const review = humanReview()
  const payload = {
    schema: 'egolens-generalization-attempt-v1', attemptId: 'attempt-a-001',
    application: { commit: COMMIT, deployedUrlIdentity: 'https://app.example.test/build-a', buildHash: hash('build') },
    browserProcess: {
      processNonce: '123e4567-e89b-42d3-a456-426614174000',
      profileNonce: '123e4567-e89b-42d3-a456-426614174001', profileMode: 'empty',
      browserVersion: 'Chrome 140.0', platform: 'darwin-arm64',
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      startedAt: '2026-08-31T00:00:00.000Z', stoppedAt: '2026-08-31T00:01:00.000Z',
      processExitObserved: true, userDataDirectoryCreatedFresh: true, userDataDirectoryRemoved: true,
    },
    sourceCase: {
      datasetId: 'fixture-dataset', releaseId: 'official-v1', caseId: 'case-a-1',
      sourceCaseManifestHash: hash('case-a'), sourceManifestHash: hash('source-a'),
      unopenedAtStart: true, unchangedOriginal: true, requiredModalitiesRetained: true,
      egolensSidecarPresent: false,
    },
    phase: 'A',
    transport: { mode: 'local', catalogHash: null, shareDescriptorHash: null, shareUrlHash: null },
    isolation: {
      agentCalls: 1, publicTools: [...PHASE10_PUBLIC_TOOLS],
      toolCalls: PHASE10_PUBLIC_TOOLS.map((toolId) => ({ toolId, count: 1 })),
      networkPolicy: { mode: 'disabled', allowedOrigins: [] },
      mounts: [
        { name: 'application', access: 'read-only', contents: 'candidate-browser-build' },
        { name: 'dataset', access: 'read-only', contents: 'original-source-case' },
        { name: 'candidate-output', access: 'write-only', contents: 'public-safe-evidence' },
      ],
      developerConsoleUsed: false, repositoryMounted: false,
      referenceLoaderMounted: false, sourceMutationObserved: false,
    },
    fingerprints: {
      recipeHash: review.correctedRecipeHash, artifactHash: hash('artifact'),
      formatFingerprint: hash('format'), datasetFingerprint: hash('dataset'),
      operatorSetFingerprint: hash('operators'),
    },
    revisionLineage: [
      { revisionId: 'revision-0', parentRevisionId: null, recipeHash: review.preservedRecipeHash, status: 'accepted', semanticChange: true },
      { revisionId: 'revision-1', parentRevisionId: 'revision-0', recipeHash: review.rejectedRecipeHash, status: 'rejected', semanticChange: true },
      { revisionId: 'revision-2', parentRevisionId: 'revision-0', recipeHash: review.correctedRecipeHash, status: 'finalized', semanticChange: true },
    ],
    capabilities: { declared: ['boxes3d', 'pointClouds'], bound: ['boxes3d', 'pointClouds'] },
    diagnostics: [], firstFailure: null, humanReview: review,
    observations: {
      structuralHash: hash('structural'), numericHash: hash('numeric'),
      crossOutputHash: hash('cross-output'), perceptualHashes: [hash('perceptual')],
      performanceHash: hash('performance'), lifecycleHash: hash('lifecycle'),
    },
    result: { passed: true, reasonCode: 'PASS' },
  }
  return { ...payload, attemptHash: phase10HashV1(payload) }
}

function modeEvidence(datasetId, mode, shared) {
  return {
    mode, noAgent: true, emptyProfile: true,
    sourceManifestHash: shared.sourceManifestHash,
    catalogHash: mode === 'local' ? null : shared.catalogHash,
    shareDescriptorHash: mode === 'share' ? hash(`${datasetId}-descriptor`) : null,
    recipeHash: shared.recipeHash, formatFingerprint: shared.formatFingerprint,
    operatorSetFingerprint: shared.operatorSetFingerprint,
    capabilityHash: shared.capabilityHash, structuralHash: shared.structuralHash,
    numericHash: shared.numericHash,
    perceptualAlgorithm: 'egolens-perceptual-raster-v2', perceptualHash: shared.perceptualHash,
    presentationHash: shared.presentationHash,
    performanceHash: hash(`${datasetId}-${mode}-performance`),
    lifecycleHash: hash(`${datasetId}-${mode}-lifecycle`),
    browserRunHash: hash(`${datasetId}-${mode}-browser`), paused: true, passed: true,
  }
}

function datasetEvidence(datasetId) {
  const shared = {
    sourceManifestHash: hash(`${datasetId}-source`), catalogHash: hash(`${datasetId}-catalog`),
    recipeHash: hash(`${datasetId}-recipe`), formatFingerprint: hash(`${datasetId}-format`),
    operatorSetFingerprint: hash('operator-set'), capabilityHash: hash(`${datasetId}-capabilities`),
    structuralHash: hash(`${datasetId}-structural`), numericHash: hash(`${datasetId}-numeric`),
    perceptualHash: hash(`${datasetId}-perceptual`), presentationHash: hash(`${datasetId}-presentation`),
  }
  const payload = {
    datasetId, caseId: `${datasetId}-case`, candidateCommit: COMMIT,
    sourceCaseManifestHash: hash(`${datasetId}-case-manifest`),
    sourceManifestHash: shared.sourceManifestHash, recipeHash: shared.recipeHash,
    formatFingerprint: shared.formatFingerprint, operatorSetFingerprint: shared.operatorSetFingerprint,
    capabilities: ['pointClouds', 'timeline'],
    local: modeEvidence(datasetId, 'local', shared),
    remote: modeEvidence(datasetId, 'remote', shared),
    share: modeEvidence(datasetId, 'share', shared),
    parityPassed: true,
  }
  return { ...payload, evidenceHash: phase10HashV1(payload) }
}

async function baselineFreeze(requirements = { fixture: true }) {
  const { schemaHashes } = await loadPhase10SchemasV1()
  const gate = (name) => ({ passed: true, evidenceHash: hash(name) })
  const payload = {
    schema: 'egolens-phase10-baseline-freeze-v1', candidateCommit: COMMIT,
    requirementsHash: phase10HashV1(requirements), frozenAt: '2026-08-31T00:02:00.000Z',
    heldOutState: {
      semanticInspectionStarted: false, contentBlindManifestFreezeStarted: false, sourceMounted: false,
    },
    datasets: ['waymo', 'nuscenes', 'argoverse2'].map(datasetEvidence),
    gates: {
      regression: gate('regression'), productionBuild: gate('production-build'),
      authorBuild: gate('author-build'), productionBoundary: gate('production-boundary'),
      authorBoundary: gate('author-boundary'), adapterAmnesia: gate('amnesia'),
      oracleReceipts: gate('oracle'), performanceLifecycle: gate('performance-lifecycle'),
      negativeCases: PHASE10_REQUIRED_NEGATIVE_CASES.map((id) => ({ id, passed: true, evidenceHash: hash(id) })),
      evidenceHarness: {
        passed: true, evidenceHash: hash('harness'), schemaHashes,
        freshProcessSelfTest: true,
      },
    },
    allPassed: true,
  }
  return { ...payload, freezeHash: phase10HashV1(payload) }
}

test('closed schemas and semantic validators bind source, reserve, attempt, failure, and ledger identities', async () => {
  for (const entry of [sourceCase('A', 1), reserveManifest(), attemptA()]) {
    await validatePhase10SchemaV1(entry)
  }
  assert.equal(validateSourceCaseManifestSemanticsV1(sourceCase('A', 1)), true)
  assert.equal(validateCaseReserveManifestSemanticsV1(reserveManifest()), true)
  assert.equal(validateGeneralizationAttemptSemanticsV1(attemptA()), true)

  const failurePayload = {
    schema: 'egolens-first-failure-v1', artifactId: 'failure-001', attemptId: 'attempt-d-001',
    applicationCommit: COMMIT, phase: 'D', sourceCaseManifestHash: hash('case-d'),
    sourceManifestHash: hash('source-d'), observedAt: '2026-08-31T00:00:00.000Z',
    terminalCode: 'CAPABILITY_GAP', diagnosticHash: hash('diagnostic'),
    boundedInspectionHash: hash('inspection'), classification: 'unclassified',
  }
  const failure = { ...failurePayload, artifactHash: phase10HashV1(failurePayload) }
  await validatePhase10SchemaV1(failure)
  assert.equal(validateFirstFailureSemanticsV1(failure), true)

  const first = createDecisionLedgerEntryV1([], {
    ledgerId: 'phase10-ledger', event: 'first-failure', occurredAt: '2026-08-31T00:00:01.000Z',
    sourceCaseManifestHash: failure.sourceCaseManifestHash, firstFailureHash: failure.artifactHash,
    detailsHash: hash('first-failure-details'),
  })
  const second = createDecisionLedgerEntryV1([first], {
    event: 'failure-classified', occurredAt: '2026-08-31T00:00:02.000Z',
    sourceCaseManifestHash: failure.sourceCaseManifestHash, firstFailureHash: failure.artifactHash,
    classification: 'generic-reader-operator-gap', detailsHash: hash('classification-details'),
  })
  for (const entry of [first, second]) await validatePhase10SchemaV1(entry)
  assert.deepEqual(validateDecisionLedgerV1([first, second]), {
    ledgerId: 'phase10-ledger', length: 2, ledgerHash: second.entryHash,
  })
})

test('attempt gate enforces real semantic correction, full capabilities, cold B, and public safety', async () => {
  const attempt = attemptA()
  const cosmeticPayload = {
    ...attempt.humanReview,
    correctedRecipeHash: attempt.humanReview.rejectedRecipeHash,
  }
  cosmeticPayload.receiptHash = phase10HashV1(humanReviewPayloadV1(cosmeticPayload))
  const invalid = { ...attempt, humanReview: cosmeticPayload }
  invalid.attemptHash = phase10HashV1(Object.fromEntries(Object.entries(invalid).filter(([key]) => key !== 'attemptHash')))
  assert.throws(() => validateGeneralizationAttemptSemanticsV1(invalid), /must change/u)

  assert.ok(publicSafetyViolationsV1({ absolutePath: '/private/source', url: 'https://x.test/?token=secret' }).length >= 2)
  await assert.rejects(validatePhase10SchemaV1({ ...attempt, unexpected: true }), /additional properties/u)
})

test('baseline freeze requires exact three-dataset parity, all negatives, schema hashes, and a single commit', async () => {
  const freeze = await baselineFreeze()
  await validatePhase10SchemaV1(freeze)
  assert.equal(validatePhase10BaselineFreezeSemanticsV1(freeze, COMMIT), true)

  const missing = structuredClone(freeze)
  missing.gates.negativeCases.pop()
  missing.freezeHash = phase10HashV1(Object.fromEntries(Object.entries(missing).filter(([key]) => key !== 'freezeHash')))
  assert.throws(() => validatePhase10BaselineFreezeSemanticsV1(missing, COMMIT), /negative coverage/u)

  const drift = structuredClone(freeze)
  drift.datasets[0].remote.structuralHash = hash('drift')
  drift.datasets[0].evidenceHash = phase10HashV1(Object.fromEntries(Object.entries(drift.datasets[0]).filter(([key]) => key !== 'evidenceHash')))
  drift.freezeHash = phase10HashV1(Object.fromEntries(Object.entries(drift).filter(([key]) => key !== 'freezeHash')))
  assert.throws(() => validatePhase10BaselineFreezeSemanticsV1(drift, COMMIT), /parity failed/u)
})

test('checked-in conformance captures stay synchronized with the reviewed preflight matrix', () => {
  const requirements = JSON.parse(readFileSync('benchmarks/phase10/preflight-requirements.json', 'utf8'))
  for (const requirement of requirements.datasets) {
    const config = JSON.parse(readFileSync(
      `benchmarks/phase10/conformance/${requirement.datasetId}.json`,
      'utf8',
    ))
    assert.equal(config.datasetId, requirement.datasetId)
    assert.equal(config.caseId, requirement.caseId)
    assert.equal(config.sourceFingerprint, requirement.datasetId === 'waymo'
      ? 'sha256-dc9b8680e1500c4305b01a5129b484bd827b6b50f8ec993786f7b7b2cca2e7a5'
      : requirement.datasetId === 'nuscenes'
        ? 'sha256-277ea9f12350c1d8c00e4fe4582a487a23829c905ed847f7e9b5f987d7fa02cf'
        : 'sha256-9f786d49304d1025d42e9c86d324706d96cf9428db4bf5a930d99c2c93c64789')
    assert.deepEqual([...config.requiredCapabilities].sort(), [...requirement.requiredCapabilities].sort())
    assert.deepEqual(config.frameIndices, requirement.frameIndices)
    assert.deepEqual(
      config.perceptualCaptures.map((capture) => capture.id).sort(),
      [...requirement.perceptualReferenceIds].sort(),
    )
  }
})

test('content-blind manifest and reserve CLIs retain protected paths only in the protected artifact', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-manifest-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source')
  const { status: mkdirStatus } = spawnSync('mkdir', ['-p', path.join(source, 'nested')])
  assert.equal(mkdirStatus, 0)
  writeFileSync(path.join(source, 'nested', 'frame.bin'), Buffer.from([1, 2, 3]))
  const protectedPath = path.join(directory, 'protected.json')
  const publicPath = path.join(directory, 'public.json')
  const result = spawnSync(process.execPath, [
    'scripts/phase10-source-case-manifest.mjs',
    '--root', source, '--dataset-id', 'fixture-dataset', '--release-id', 'official-v1',
    '--official-source-url', 'https://data.example.test/release', '--case-id', 'case-d-0',
    '--role', 'D', '--order', '0', '--original-form', 'complete-official-subtree',
    '--capability', 'pointClouds', '--output', protectedPath, '--public-output', publicPath,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const protectedManifest = JSON.parse(readFileSync(protectedPath, 'utf8'))
  const publicSummary = JSON.parse(readFileSync(publicPath, 'utf8'))
  assert.equal(protectedManifest.files[0].path, 'nested/frame.bin')
  assert.equal(JSON.stringify(publicSummary).includes('nested/frame.bin'), false)
  assert.equal(publicSummary.sourceCaseManifestHash, protectedManifest.manifestHash)
})

test('baseline gate fails closed on requirements or schema drift and emits a hash-bound public report', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-gate-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const requirements = { fixture: true }
  const freeze = await baselineFreeze(requirements)
  const freezePath = path.join(directory, 'freeze.json')
  const requirementsPath = path.join(directory, 'requirements.json')
  writeFileSync(freezePath, JSON.stringify(freeze))
  writeFileSync(requirementsPath, JSON.stringify(requirements))
  const result = spawnSync(process.execPath, [
    'scripts/phase10-baseline-gate.mjs', '--freeze', freezePath,
    '--requirements', requirementsPath, '--expected-commit', COMMIT,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.passed, true)
  assert.equal(report.candidateCommit, COMMIT)
  assert.equal(report.datasetEvidence.length, 3)

  writeFileSync(requirementsPath, JSON.stringify({ fixture: false }))
  const stale = spawnSync(process.execPath, [
    'scripts/phase10-baseline-gate.mjs', '--freeze', freezePath,
    '--requirements', requirementsPath, '--expected-commit', COMMIT,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.notEqual(stale.status, 0)
})

test('fresh-process harness observes distinct process exits and removes every empty profile', async () => {
  const evidence = []
  for (let index = 0; index < 2; index += 1) {
    const workspace = await createFreshProcessWorkspaceV1('egolens-phase10-self-test-')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    evidence.push(await closeFreshProcessWorkspaceV1(workspace, child))
  }
  assert.equal(validateFreshProcessEvidenceSetV1(evidence), true)
  assert.notEqual(evidence[0].processNonce, evidence[1].processNonce)
  assert.notEqual(evidence[0].profileNonce, evidence[1].profileNonce)
})

test('catalog, preparation, and Range host bind byte-identical source without publishing paths', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-host-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source')
  mkdirSync(path.join(source, 'vehicle_pose'), { recursive: true })
  writeFileSync(path.join(source, 'vehicle_pose', 'segment.parquet'), Buffer.from([1, 2, 3, 4]))
  const sourceCasePath = path.join(directory, 'source-case.json')
  const sourceSummaryPath = path.join(directory, 'source-summary.json')
  const capabilities = [
    'boxes2d', 'boxes3d', 'cameraImages', 'cameraSegmentation', 'egoPoses',
    'lidarSegmentation', 'pointClouds', 'segmentMetadata', 'timeline', 'trajectories',
  ]
  const sourceResult = spawnSync(process.execPath, [
    'scripts/phase10-source-case-manifest.mjs', '--root', source,
    '--dataset-id', 'waymo', '--release-id', 'fixture-official-v1',
    '--official-source-url', 'https://data.example.test/waymo',
    '--case-id', 'phase6-waymo-rich-001', '--role', 'D', '--order', '0',
    '--original-form', 'complete-official-subtree',
    ...capabilities.flatMap((capability) => ['--capability', capability]),
    '--output', sourceCasePath, '--public-output', sourceSummaryPath,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(sourceResult.status, 0, sourceResult.stderr)
  const catalogPath = path.join(directory, 'catalog.json')
  const catalogSummaryPath = path.join(directory, 'catalog-summary.json')
  const catalogResult = spawnSync(process.execPath, [
    'scripts/phase10-source-catalog.mjs', '--root', source, '--source-case', sourceCasePath,
    '--chunk-size', '65536', '--output', catalogPath, '--public-output', catalogSummaryPath,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(catalogResult.status, 0, catalogResult.stderr)
  assert.equal(JSON.stringify(JSON.parse(readFileSync(catalogSummaryPath))).includes('vehicle_pose'), false)

  const port = 18_000 + Math.floor(Math.random() * 1_000)
  const outputDirectory = path.join(directory, 'prepared')
  const prepare = spawnSync(process.execPath, [
    'scripts/phase10-prepare-preflight.mjs', '--source-case', sourceCasePath,
    '--catalog', catalogPath, '--recipe', 'src/adapters/recipes/waymo.egolens-adapter.json',
    '--requirements', 'benchmarks/phase10/preflight-requirements.json', '--dataset-id', 'waymo',
    '--host-origin', `http://127.0.0.1:${port}/`, '--app-url', 'http://127.0.0.1:4173/',
    '--scene', 'segment', '--output-dir', outputDirectory,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(prepare.status, 0, prepare.stderr)
  const runtime = JSON.parse(readFileSync(path.join(outputDirectory, 'runtime.json')))
  assert.match(runtime.remoteUrl, /shareVersion=1/u)
  assert.match(runtime.shareUrl, /shareHash=sha256%3A/u)

  const host = spawn(process.execPath, [
    'scripts/phase10-range-host.mjs', '--root', source, '--catalog', catalogPath,
    '--recipe', 'src/adapters/recipes/waymo.egolens-adapter.json',
    '--descriptor', path.join(outputDirectory, 'descriptor.json'), '--port', String(port),
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  context.after(() => { if (host.exitCode === null) host.kill('SIGTERM') })
  await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error('Range host did not start')), 5_000)
    host.stdout.on('data', (chunk) => {
      output += chunk.toString()
      if (output.includes('\n')) { clearTimeout(timeout); resolve() }
    })
    host.once('error', reject)
    host.once('exit', (code) => { if (code !== 0) reject(new Error(`Range host exited ${code}`)) })
  })
  const response = await fetch(`http://127.0.0.1:${port}/source/vehicle_pose/segment.parquet`, {
    headers: { Range: 'bytes=1-2' },
  })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 1-2/4')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3])
  host.kill('SIGTERM')
  await new Promise((resolve) => host.once('exit', resolve))
})

test('negative gate accepts only the exact named passing matrix', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-negative-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const report = {
    success: true,
    numFailedTests: 0,
    numPassedTests: PHASE10_REQUIRED_NEGATIVE_CASES.length,
    testResults: [{ assertionResults: PHASE10_REQUIRED_NEGATIVE_CASES.map((title) => ({
      title, status: 'passed', ancestorTitles: ['Phase 10 required negative gates'],
    })) }],
  }
  const input = path.join(directory, 'vitest.json')
  const output = path.join(directory, 'gate.json')
  writeFileSync(input, JSON.stringify(report))
  const result = spawnSync(process.execPath, [
    'scripts/phase10-negative-gate.mjs', '--vitest-report', input,
    '--expected-commit', COMMIT, '--output', output,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const gate = JSON.parse(readFileSync(output))
  assert.equal(gate.cases.length, PHASE10_REQUIRED_NEGATIVE_CASES.length)
  assert.equal(gate.passed, true)
})

test('preflight record and dataset assembler prove actual runtime identity and three fresh modes', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-preflight-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const requirement = JSON.parse(readFileSync('benchmarks/phase10/preflight-requirements.json'))
    .datasets.find((entry) => entry.datasetId === 'waymo')
  const files = [{ path: 'vehicle_pose/segment.parquet', size: 4, sha256: hash('source-file') }]
  const sourcePayload = {
    schema: 'egolens-source-case-manifest-v1',
    release: { datasetId: 'waymo', releaseId: 'fixture-official-v1', officialSourceUrl: 'https://data.example.test/waymo', officialArchiveChecksum: null },
    case: { caseId: requirement.caseId, role: 'D', reserveFor: null, order: 0, originalForm: 'complete-official-subtree', unchangedOriginal: true, archiveExtractionOnly: false, declaredCapabilities: [...requirement.requiredCapabilities].sort() },
    files, aggregate: { fileCount: 1, totalBytes: 4 }, sourceManifestHash: sourceManifestHashFromFilesV1(files),
  }
  const sourceCase = { ...sourcePayload, manifestHash: phase10HashV1(sourcePayload) }
  const sourceCasePath = path.join(directory, 'source-case.json')
  writeFileSync(sourceCasePath, JSON.stringify(sourceCase))
  const shared = {
    sourceManifestHash: sourceCase.sourceManifestHash,
    recipeHash: requirement.recipeHash,
    formatFingerprint: hash('format'),
    operatorSetFingerprint: hash('operators'),
    catalogHash: hash('catalog'),
    shareDescriptorHash: hash('descriptor'),
  }
  const processEvidence = (index) => {
    const payload = {
      processNonce: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      profileNonce: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      profileMode: 'empty', startedAt: '2026-08-31T00:00:00.000Z', stoppedAt: '2026-08-31T00:00:01.000Z',
      processExitObserved: true, userDataDirectoryCreatedFresh: true, userDataDirectoryRemoved: true,
    }
    return { ...payload, evidenceHash: phase10HashV1(payload) }
  }
  const conformancePayload = {
    kind: 'egolens-scene-conformance', schemaVersion: 1,
    target: { datasetId: 'waymo', caseId: requirement.caseId },
    coverage: { requiredCapabilities: [...requirement.requiredCapabilities].sort() },
    structural: { frameCount: 5 }, numeric: { finite: true }, perceptual: { references: [] },
    provenance: { generatorCommit: COMMIT, runtimeId: `egolens-recipe-${COMMIT}`, sourceFingerprint: `sha256-${'1'.repeat(64)}`, capturedAt: '2026-08-31T00:00:00.000Z' },
  }
  conformancePayload.summaryHash = sha256Canonical({ structural: conformancePayload.structural, numeric: conformancePayload.numeric, perceptual: conformancePayload.perceptual })
  const conformance = { ...conformancePayload, artifactHash: sha256Canonical(conformancePayload) }
  const conformancePath = path.join(directory, 'conformance.json')
  writeFileSync(conformancePath, JSON.stringify(conformance))
  const initialPresentation = {
    view: { sceneId: 'segment', frameIndex: 0, t0: null, t1: null },
    presentation: { playing: false },
  }
  const makeBenchmark = (capture, firstProcess, identity) => {
    const runtimeIdentity = Object.fromEntries(Object.entries(identity)
      .filter(([key]) => key !== 'datasetId' && key !== 'caseId'))
    const runs = Array.from({ length: capture ? 1 : 6 }, (_, index) => ({
      browserProcess: processEvidence(firstProcess + index),
      preflight: { datasetId: identity.datasetId, sceneId: 'segment', identity: runtimeIdentity, presentation: initialPresentation },
      traceCollection: { complete: true, truncated: false },
      snapshots: { afterDisposeSettle: { app: { scene: null, resources: { liveObjectUrls: 0, liveImageBitmaps: 0 } }, liveWorkerTargets: [] } },
      ...(capture ? { conformance: capture } : {}),
    }))
    return {
      scenario: { warmupRuns: capture ? 0 : 1, measuredRuns: capture ? 1 : 5, seeks: capture ? 0 : 100, sceneSwitches: capture ? 0 : 20, playbackLoops: capture ? 0 : 2, traceEnabled: true, browserIsolation: 'per-run', freshProcessEvidence: 'egolens-fresh-browser-process-v1' },
      environment: { commit: COMMIT, dirty: false },
      warmups: capture ? [] : [runs[0]], samples: capture ? runs : runs.slice(1),
      summary: { runSummaries: capture ? [] : Array.from({ length: 5 }, () => ({ datasetReadyMs: 1, firstUsableFrameMs: 2, frameLatencyP95Ms: 3, frameLatencySamples: 4 })) },
    }
  }
  const observations = []
  for (const [modeIndex, mode] of ['local', 'remote', 'share'].entries()) {
    const identity = {
      datasetId: 'waymo', caseId: requirement.caseId, sourceManifestHash: shared.sourceManifestHash,
      catalogHash: mode === 'local' ? null : shared.catalogHash,
      shareDescriptorHash: mode === 'share' ? shared.shareDescriptorHash : null,
      recipeHash: shared.recipeHash, formatFingerprint: shared.formatFingerprint,
      operatorSetFingerprint: shared.operatorSetFingerprint,
    }
    const capture = {
      target: conformance.target, coverage: conformance.coverage, artifactHash: conformance.artifactHash,
      generatorCommit: COMMIT, runtimeId: conformance.provenance.runtimeId, recipeHash: shared.recipeHash,
      identity: Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'datasetId' && key !== 'caseId')),
      presentation: initialPresentation,
      perceptualParity: { algorithm: 'egolens-perceptual-raster-v2', references: [] },
    }
    const capturePath = path.join(directory, `${mode}-capture.json`)
    const performancePath = path.join(directory, `${mode}-performance.json`)
    const identityPath = path.join(directory, `${mode}-identity.json`)
    const observationPath = path.join(directory, `${mode}-observation.json`)
    writeFileSync(capturePath, JSON.stringify(makeBenchmark(capture, 10 + modeIndex * 10, identity)))
    writeFileSync(performancePath, JSON.stringify(makeBenchmark(null, 11 + modeIndex * 10, identity)))
    writeFileSync(identityPath, JSON.stringify(identity))
    const result = spawnSync(process.execPath, [
      'scripts/phase10-record-preflight-mode.mjs', '--mode', mode, '--identity', identityPath,
      '--capture', capturePath, '--conformance', conformancePath, '--performance', performancePath,
      '--lifecycle', performancePath, '--expected-commit', COMMIT, '--output', observationPath,
    ], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    observations.push(observationPath)
  }
  const assembledPath = path.join(directory, 'dataset.json')
  const assembled = spawnSync(process.execPath, [
    'scripts/phase10-assemble-preflight.mjs', '--source-case', sourceCasePath,
    '--local', observations[0], '--remote', observations[1], '--share', observations[2],
    '--requirements', 'benchmarks/phase10/preflight-requirements.json',
    '--expected-commit', COMMIT, '--output', assembledPath,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(assembled.status, 0, assembled.stderr)
  assert.equal(JSON.parse(readFileSync(assembledPath)).parityPassed, true)
})
