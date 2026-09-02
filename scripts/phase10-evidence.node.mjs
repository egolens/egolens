import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  chmodSync, constants as fsConstants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  AMNESIA_BOUNDARY_REPORT_KIND,
  AMNESIA_BOUNDARY_RUNTIME_ID,
  AMNESIA_DENIED_RESOURCES,
  AMNESIA_PUBLIC_TOOLS,
  amnesiaBoundaryWitness,
} from './lib/amnesia-evidence.mjs'
import { loadConfigFromFile } from 'vite'
import {
  PHASE9_EXPECTED_JUDGE_VERSION,
  PHASE9_EXPECTED_PRODUCER_COMMIT,
  PHASE9_EXPECTED_PUBLIC_KEY_HASH,
  PHASE9_EXPECTED_SIGNING_KEY_ID,
  PHASE10_PUBLIC_TOOLS,
  PHASE10_REQUIRED_NEGATIVE_CASES,
  PHASE6_EXPECTED_JUDGE_VERSION,
  PHASE6_EXPECTED_REQUIREMENTS_HASH,
  phase6OracleBindingV1,
  createDecisionLedgerEntryV1,
  humanReviewPayloadV1,
  loadPhase10ProductionTrustV1,
  phase10BytesHashV1,
  phase10HashV1,
  phase10PreflightSourceModeV1,
  phase10ProtectedConformanceConfigV1,
  phase10ReviewedCoverageV1,
  phase10VerifierDependencyClosureV1,
  phase9AdapterAmnesiaBindingV1,
  publicSafetyViolationsV1,
  sourceManifestHashFromFilesV1,
  validateCaseReserveManifestSemanticsV1,
  validateDecisionLedgerV1,
  validateFirstFailureSemanticsV1,
  validateGeneralizationAttemptSemanticsV1,
  validateDatasetBaselineEvidenceV1,
  validatePhase10BaselineFreezeSemanticsV1,
  validateSourceCaseManifestSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { loadPhase10SchemasV1, validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'
import { phase10ReviewedViteBuildInvocationV1 } from './lib/phase10-build-policy.mjs'
import { sha256Canonical, signReceipt } from './lib/oracle-receipts.mjs'
import {
  closeFreshProcessWorkspaceV1,
  createFreshProcessWorkspaceV1,
  validateFreshProcessEvidenceSetV1,
} from './lib/fresh-process-evidence.mjs'
import {
  boundaryHashV1,
  COUNTED_BROWSER_CHROME_REQUIREMENT,
  COUNTED_BROWSER_REQUIRED_CHECKS,
  makeBoundaryEnvironmentV1,
  makeBoundaryRunEvidenceV1,
  requestAuditV1,
} from './lib/phase10-counted-browser-boundary.mjs'

const COMMIT = 'a'.repeat(40)
const hash = (label) => phase10HashV1({ label })
const DATASETS = Object.freeze(['waymo', 'nuscenes', 'argoverse2'])
const PHASE9_REQUIREMENTS = JSON.parse(readFileSync('benchmarks/oracle/phase9-requirements.json', 'utf8'))
const PHASE6_REQUIREMENTS = JSON.parse(readFileSync('benchmarks/oracle/phase6-requirements.json', 'utf8'))
const PHASE10_REQUIREMENTS = JSON.parse(readFileSync('benchmarks/phase10/preflight-requirements.json', 'utf8'))
const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } = generateKeyPairSync('ed25519')
const TEST_PRIVATE_PEM = TEST_PRIVATE_KEY.export({ type: 'pkcs8', format: 'pem' })
const TEST_PUBLIC_PEM = TEST_PUBLIC_KEY.export({ type: 'spki', format: 'pem' })
let trustedToolFixtureValue

function officialChromeIdentityFixture() {
  const payload = {
    schema: 'egolens-official-chrome-identity-v1',
    bundleIdentifier: 'com.google.Chrome',
    teamIdentifier: 'EQHXZ8M8AV',
    designatedRequirement: COUNTED_BROWSER_CHROME_REQUIREMENT,
    signatureVerification: 'codesign-deep-requirement-valid',
    codeDirectoryHash: 'd'.repeat(40),
    executableHash: hash('official-chrome-executable'),
    executableSize: 1024,
  }
  return { ...payload, identityHash: boundaryHashV1(payload) }
}

function trustedToolFixture() {
  if (trustedToolFixtureValue) return trustedToolFixtureValue
  const canonicalTemp = realpathSync(tmpdir())
  const root = mkdtempSync(path.join(canonicalTemp, 'egolens-phase10-test-tool-'))
  chmodSync(root, 0o700)
  const listed = spawnSync('/usr/bin/git', [
    '-C', process.cwd(), 'ls-files', '-co', '--exclude-standard', '-z',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(listed.status, 0, listed.stderr?.toString())
  for (const relative of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const source = path.join(process.cwd(), relative)
    if (!statSync(source).isFile()) continue
    const destination = path.join(root, relative)
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  // verbatimSymlinks keeps node_modules/.bin links relative. Without it
  // cpSync rewrites them to absolute paths into this checkout, so a nested
  // sandboxed copy of the snapshot would canonicalize into a denied root and
  // abort the process.
  cpSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    mode: fsConstants.COPYFILE_FICLONE,
  })
  const gitEnv = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  }
  for (const argv of [
    ['init', root],
    ['-C', root, 'add', '-A'],
    ['-C', root, '-c', 'user.name=Phase10 Test', '-c', 'user.email=phase10@test.invalid',
      'commit', '-m', 'test verifier snapshot'],
  ]) {
    const result = spawnSync('/usr/bin/git', argv, { encoding: 'utf8', env: gitEnv })
    assert.equal(result.status, 0, result.stderr)
  }
  const commitResult = spawnSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: gitEnv })
  assert.equal(commitResult.status, 0, commitResult.stderr)
  const commit = commitResult.stdout.trim()
  const anchorRoot = mkdtempSync(path.join(canonicalTemp, 'egolens-phase10-test-anchor-'))
  chmodSync(anchorRoot, 0o700)
  const manifestPath = path.join(anchorRoot, 'verifier-trust.json')
  const created = spawnSync(process.execPath, [
    path.join(root, 'scripts/phase10-create-verifier-trust-manifest.mjs'),
    '--review-id', 'phase10-test-reviewed-snapshot',
    '--approved-at', '2026-08-31T00:00:00.000Z',
    '--expected-commit', commit,
    '--output', manifestPath,
  ], { cwd: root, encoding: 'utf8', env: gitEnv })
  assert.equal(created.status, 0, created.stderr)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  trustedToolFixtureValue = {
    root,
    env: {
      ...process.env,
      PHASE10_VERIFIER_TRUST_MANIFEST: manifestPath,
      PHASE10_EXPECTED_VERIFIER_TRUST_MANIFEST_HASH: manifest.manifestHash,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
      rmSync(anchorRoot, { recursive: true, force: true })
    },
  }
  process.once('exit', trustedToolFixtureValue.cleanup)
  return trustedToolFixtureValue
}

function phase10Requirements() {
  return structuredClone(PHASE10_REQUIREMENTS)
}

function testVerifierBinding() {
  const trust = phase9Trust()
  return {
    verifierId: 'egolens-phase10-p7-reviewed-verifier-v1',
    verifierToolCommit: trust.verifierToolCommit,
    verifierSourceTreeHash: trust.verifierSourceTreeHash,
    verifierClosureHash: trust.verifierClosureHash,
    verifierClosureVersion: trust.verifierClosureVersion,
    verifierDependencyClosureHash: trust.verifierDependencyClosureHash,
    verifierNodeRuntimeHash: trust.verifierNodeRuntimeHash,
    verifierTrustManifestHash: trust.verifierTrustManifestHash,
    verifierTrustReviewId: trust.verifierTrustReviewId,
    verifierRequirement: 'external-reviewed-tool-checkout-required',
  }
}

function phase9Trust(overrides = {}) {
  return {
    phase9Requirements: structuredClone(PHASE9_REQUIREMENTS),
    phase6Requirements: structuredClone(PHASE6_REQUIREMENTS),
    phase10Requirements: phase10Requirements(),
    phase9PublicKey: TEST_PUBLIC_PEM,
    expectedProducerCommit: PHASE9_EXPECTED_PRODUCER_COMMIT,
    expectedSigningKeyId: PHASE9_EXPECTED_SIGNING_KEY_ID,
    expectedPublicKeyHash: phase10BytesHashV1(Buffer.from(TEST_PUBLIC_PEM)),
    verifierToolCommit: 'f'.repeat(40),
    verifierToolClean: true,
    verifierSourceTreeHash: hash('verifier-source-tree'),
    verifierClosureHash: hash('verifier-closure'),
    verifierClosureVersion: 2,
    verifierDependencyClosureHash: hash('verifier-dependency-closure'),
    verifierNodeRuntimeHash: hash('verifier-node-runtime'),
    verifierTrustManifestHash: hash('verifier-trust-manifest'),
    verifierTrustReviewId: 'phase10-test-review',
    testOnly: true,
    ...overrides,
  }
}

function phase9Evidence({ recipeHashes = {}, caseIds = {} } = {}) {
  const trust = phase9Trust()
  const requirementByDataset = new Map(trust.phase9Requirements.targets.map((entry) => [entry.datasetId, entry]))
  const resolvedRecipeHashes = Object.fromEntries(DATASETS.map((datasetId) => [
    datasetId,
    recipeHashes[datasetId] ?? hash(`${datasetId}-recipe`),
  ]))
  const boundaryPayload = {
    kind: AMNESIA_BOUNDARY_REPORT_KIND,
    schemaVersion: 1,
    candidateCommit: COMMIT,
    enforcement: {
      platform: 'macos-seatbelt',
      coordinatorRuntimeId: AMNESIA_BOUNDARY_RUNTIME_ID,
    },
    controller: {
      datasetAccess: false,
      applicationAccess: false,
      candidateOutputAccess: false,
      toolNetwork: 'loopback-only',
      modelControlPlane: 'exact-controller-process-only',
    },
    cases: DATASETS.map((datasetId, index) => {
      const root = `/fixture/phase10-${datasetId}-${index}`
      return {
        datasetId,
        caseId: caseIds[datasetId] ?? requirementByDataset.get(datasetId).caseId,
        runId: `phase10-fixture-${datasetId}`,
        sourceCommit: COMMIT,
        applicationBuildHash: hash('phase9-application-build'),
        recipeHash: resolvedRecipeHashes[datasetId],
        sourceFingerprint: `sha256-${String(index + 1).repeat(64)}`,
        sourceContentHash: `sha256-${String(index + 4).repeat(64)}`,
        policyHash: hash(`${datasetId}-policy`),
        negativeProbeReportHash: hash(`${datasetId}-negative-probe`),
        sourceCount: 1,
        controllerDatasetAccess: false,
        externalToolNetworkDenied: true,
        loopbackOnly: true,
        outputReadDenied: true,
        datasetWriteDenied: true,
        forbiddenResourceReadDenied: true,
        oneSourceAtATime: true,
        publicTools: [...AMNESIA_PUBLIC_TOOLS],
        mounts: [
          { name: 'application', access: 'read-only', canonicalPath: `${root}/application` },
          { name: 'dataset', access: 'read-only', canonicalPath: `${root}/dataset` },
          { name: 'candidate-output', access: 'write-only', canonicalPath: `${root}/output` },
        ],
        browserProfile: {
          canonicalPath: `${root}/browser-profile`, fresh: true, emptyBefore: true, destroyedAfter: true,
        },
        runtimeScratch: {
          canonicalPath: `${root}/runtime-scratch`, fresh: true, emptyBefore: true, destroyedAfter: true,
        },
      }
    }),
    passed: true,
  }
  const boundaryReport = { ...boundaryPayload, reportHash: sha256Canonical(boundaryPayload) }
  const boundaryWitness = amnesiaBoundaryWitness(boundaryReport)
  const attestationPayload = {
    kind: 'egolens-adapter-amnesia-attestation',
    schemaVersion: 2,
    candidateCommit: COMMIT,
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
    candidates: DATASETS.map((datasetId) => ({
      datasetId,
      caseId: caseIds[datasetId] ?? requirementByDataset.get(datasetId).caseId,
      authoredBy: 'codex',
      recipeHash: resolvedRecipeHashes[datasetId],
    })),
  }
  const attestation = { ...attestationPayload, attestationHash: sha256Canonical(attestationPayload) }
  const receipts = DATASETS.map((datasetId) => {
    const requirement = requirementByDataset.get(datasetId)
    const target = { datasetId, caseId: requirement.caseId }
    const payload = {
      kind: 'egolens-oracle-judge-receipt',
      schemaVersion: 1,
      target,
      oracleBundleHash: sha256Canonical({ datasetId, fixture: 'oracle' }),
      oracleGeneratorCommit: PHASE9_EXPECTED_PRODUCER_COMMIT,
      oracleLegacyRuntimeId: `phase9-fixture-${datasetId}`,
      oracleCoverage: structuredClone(requirement.coverage),
      candidateArtifactHash: sha256Canonical({ datasetId, fixture: 'candidate' }),
      candidateGeneratorCommit: COMMIT,
      candidateRuntimeId: `egolens-amnesia-${COMMIT}-${resolvedRecipeHashes[datasetId]}`,
      judgeVersion: PHASE9_EXPECTED_JUDGE_VERSION,
      judgeToolCommit: trust.verifierToolCommit,
      judgedAt: '2026-08-31T00:00:00.000Z',
      checks: ['integrity', 'target', 'coverage', 'structural', 'numeric', 'perceptual']
        .map((name) => ({ name, passed: true, mismatchPaths: [] })),
      passed: true,
      candidateRecipeHash: resolvedRecipeHashes[datasetId],
      amnesiaAttestationHash: attestation.attestationHash,
      amnesiaBoundaryReportHash: boundaryReport.reportHash,
      amnesiaBoundaryCaseArtifactHash: sha256Canonical(
        boundaryReport.cases.find((entry) => entry.datasetId === datasetId),
      ),
      amnesiaBoundarySourceMatched: true,
    }
    return signReceipt(
      { ...payload, receiptHash: sha256Canonical(payload) },
      TEST_PRIVATE_PEM,
      PHASE9_EXPECTED_SIGNING_KEY_ID,
    )
  })
  const gate = {
    kind: 'egolens-adapter-amnesia-gate-report',
    schemaVersion: 1,
    passed: true,
    expectedGeneratorCommit: PHASE9_EXPECTED_PRODUCER_COMMIT,
    expectedCandidateCommit: COMMIT,
    judgeVersion: PHASE9_EXPECTED_JUDGE_VERSION,
    judgeToolCommit: trust.verifierToolCommit,
    amnesiaAttestationHash: attestation.attestationHash,
    amnesiaBoundaryReportHash: boundaryReport.reportHash,
    signingKeyId: PHASE9_EXPECTED_SIGNING_KEY_ID,
    requirementsHash: sha256Canonical(trust.phase9Requirements),
    checks: receipts.map((receipt) => ({
      datasetId: receipt.target.datasetId,
      caseId: receipt.target.caseId,
      passed: true,
      receiptHash: receipt.receiptHash,
      candidateRecipeHash: receipt.candidateRecipeHash,
      boundaryReportHash: receipt.amnesiaBoundaryReportHash,
      boundaryCaseArtifactHash: receipt.amnesiaBoundaryCaseArtifactHash,
    })),
  }
  return {
    attestation,
    boundaryReport,
    gate,
    receipts,
    trust,
    binding: phase9AdapterAmnesiaBindingV1(attestation, gate, receipts, COMMIT, trust),
  }
}

function resignPhase9Receipt(receipt, changes) {
  const {
    signingKeyId: _signingKeyId,
    signatureAlgorithm: _signatureAlgorithm,
    signature: _signature,
    receiptHash: _receiptHash,
    ...unsigned
  } = receipt
  const payload = { ...unsigned, ...changes }
  return signReceipt(
    { ...payload, receiptHash: sha256Canonical(payload) },
    TEST_PRIVATE_PEM,
    PHASE9_EXPECTED_SIGNING_KEY_ID,
  )
}

function gateChecksFromReceipts(receipts) {
  return receipts.map((receipt) => ({
    datasetId: receipt.target.datasetId,
    caseId: receipt.target.caseId,
    passed: true,
    receiptHash: receipt.receiptHash,
    candidateRecipeHash: receipt.candidateRecipeHash,
    boundaryReportHash: receipt.amnesiaBoundaryReportHash,
    boundaryCaseArtifactHash: receipt.amnesiaBoundaryCaseArtifactHash,
  }))
}

function phase6Evidence() {
  const trust = phase9Trust()
  const requirementByDataset = new Map(trust.phase6Requirements.targets.map((entry) => [entry.datasetId, entry]))
  const receipts = DATASETS.map((datasetId) => {
    const requirement = requirementByDataset.get(datasetId)
    const payload = {
      kind: 'egolens-oracle-judge-receipt',
      schemaVersion: 1,
      target: { datasetId, caseId: requirement.caseId },
      oracleBundleHash: sha256Canonical({ datasetId, fixture: 'phase6-oracle' }),
      oracleGeneratorCommit: PHASE9_EXPECTED_PRODUCER_COMMIT,
      oracleLegacyRuntimeId: `phase6-fixture-${datasetId}`,
      oracleCoverage: structuredClone(requirement.coverage),
      candidateArtifactHash: sha256Canonical({ datasetId, fixture: 'phase6-candidate' }),
      candidateGeneratorCommit: COMMIT,
      candidateRuntimeId: `phase6-candidate-${datasetId}`,
      judgeVersion: PHASE6_EXPECTED_JUDGE_VERSION,
      judgedAt: '2026-08-31T00:00:00.000Z',
      checks: ['integrity', 'target', 'coverage', 'structural', 'numeric', 'perceptual']
        .map((name) => ({ name, passed: true, mismatchPaths: [] })),
      passed: true,
    }
    return signReceipt(
      { ...payload, receiptHash: sha256Canonical(payload) },
      TEST_PRIVATE_PEM,
      PHASE9_EXPECTED_SIGNING_KEY_ID,
    )
  })
  const gate = {
    schemaVersion: 1,
    passed: true,
    expectedGeneratorCommit: PHASE9_EXPECTED_PRODUCER_COMMIT,
    expectedCandidateCommit: COMMIT,
    signingKeyId: PHASE9_EXPECTED_SIGNING_KEY_ID,
    requirementsHash: PHASE6_EXPECTED_REQUIREMENTS_HASH,
    checks: receipts.map((receipt) => ({
      datasetId: receipt.target.datasetId,
      caseId: receipt.target.caseId,
      passed: true,
      receiptHash: receipt.receiptHash,
      oracleGeneratorCommit: receipt.oracleGeneratorCommit,
      candidateGeneratorCommit: receipt.candidateGeneratorCommit,
    })),
  }
  return {
    trust,
    receipts,
    gate,
    binding: phase6OracleBindingV1(gate, receipts, COMMIT, trust),
  }
}

function sourceCase(role, order, reserveFor = null) {
  const files = [{ path: `${String(order).padStart(2, '0')}/source.bin`, size: 3, sha256: hash(`file-${order}`) }]
  const payload = {
    schema: 'egolens-source-case-manifest-v1',
    verifierBinding: testVerifierBinding(),
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
    verifierBinding: testVerifierBinding(),
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
    verifierBinding: testVerifierBinding(),
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
    verifierBinding: testVerifierBinding(),
    mode, noAgent: true, emptyProfile: true,
    sourceTreeHash: shared.sourceTreeHash,
    productionBuildInventoryHash: shared.productionBuildInventoryHash,
    sourceManifestHash: shared.sourceManifestHash,
    catalogHash: mode === 'local' ? null : shared.catalogHash,
    shareDescriptorHash: mode === 'share' ? hash(`${datasetId}-descriptor`) : null,
    recipeHash: shared.recipeHash, formatFingerprint: shared.formatFingerprint,
    operatorSetFingerprint: shared.operatorSetFingerprint,
    coverageHash: shared.coverageHash,
    capabilityHash: shared.capabilityHash, structuralHash: shared.structuralHash,
    numericHash: shared.numericHash, rendererFrameHash: hash(`${datasetId}-renderer-frame`),
    perceptualAlgorithm: 'egolens-perceptual-raster-v2', perceptualHash: shared.perceptualHash,
    presentationHash: shared.presentationHash,
    performanceHash: hash(`${datasetId}-${mode}-performance`),
    lifecycleHash: hash(`${datasetId}-${mode}-lifecycle`),
    browserBoundaryHash: hash(`${datasetId}-${mode}-browser-boundary`),
    browserRunHash: hash(`${datasetId}-${mode}-browser`), paused: true, passed: true,
  }
}

function datasetEvidence(datasetId) {
  const requirement = PHASE10_REQUIREMENTS.datasets.find((entry) => entry.datasetId === datasetId)
  const coverage = phase10ReviewedCoverageV1(requirement)
  const shared = {
    sourceTreeHash: hash('source-tree'),
    productionBuildInventoryHash: hash('production-build'),
    sourceManifestHash: hash(`${datasetId}-source`), catalogHash: hash(`${datasetId}-catalog`),
    recipeHash: hash(`${datasetId}-recipe`), formatFingerprint: hash(`${datasetId}-format`),
    operatorSetFingerprint: hash('operator-set'), capabilityHash: hash(`${datasetId}-capabilities`),
    coverageHash: phase10HashV1(coverage),
    structuralHash: hash(`${datasetId}-structural`), numericHash: hash(`${datasetId}-numeric`),
    perceptualHash: hash(`${datasetId}-perceptual`), presentationHash: hash(`${datasetId}-presentation`),
  }
  const payload = {
    verifierBinding: testVerifierBinding(),
    datasetId, caseId: requirement.caseId, candidateCommit: COMMIT,
    sourceTreeHash: shared.sourceTreeHash,
    productionBuildInventoryHash: shared.productionBuildInventoryHash,
    sourceCaseManifestHash: hash(`${datasetId}-case-manifest`),
    sourceManifestHash: shared.sourceManifestHash, recipeHash: shared.recipeHash,
    formatFingerprint: shared.formatFingerprint, operatorSetFingerprint: shared.operatorSetFingerprint,
    coverage, coverageHash: shared.coverageHash, capabilities: coverage.requiredCapabilities,
    local: modeEvidence(datasetId, 'local', shared),
    remote: modeEvidence(datasetId, 'remote', shared),
    share: modeEvidence(datasetId, 'share', shared),
    parityPassed: true,
  }
  return { ...payload, evidenceHash: phase10HashV1(payload) }
}

async function baselineFreeze(requirements = phase10Requirements()) {
  const { schemaHashes } = await loadPhase10SchemasV1()
  const gate = (name) => ({ passed: true, evidenceHash: hash(name) })
  const phase9 = phase9Evidence()
  const phase6 = phase6Evidence()
  const verifierBinding = {
    verifierId: phase9.binding.verifierId,
    verifierToolCommit: phase9.binding.verifierToolCommit,
    verifierSourceTreeHash: phase9.binding.verifierSourceTreeHash,
    verifierClosureHash: phase9.binding.verifierClosureHash,
    verifierClosureVersion: phase9.binding.verifierClosureVersion,
    verifierDependencyClosureHash: phase9.binding.verifierDependencyClosureHash,
    verifierNodeRuntimeHash: phase9.binding.verifierNodeRuntimeHash,
    verifierTrustManifestHash: phase9.binding.verifierTrustManifestHash,
    verifierTrustReviewId: phase9.binding.verifierTrustReviewId,
    verifierRequirement: phase9.binding.verifierRequirement,
  }
  const payload = {
    schema: 'egolens-phase10-baseline-freeze-v1', candidateCommit: COMMIT,
    requirementsHash: phase10HashV1(requirements),
    sourceTreeHash: hash('source-tree'),
    productionBuildInventoryHash: hash('production-build'),
    authorBuildInventoryHash: hash('author-build'),
    buildBoundaryReportHash: hash('build-boundary'),
    frozenAt: '2026-08-31T00:02:00.000Z',
    verifierBinding,
    phase6Binding: { ...phase6.binding, publicKeyHash: PHASE9_EXPECTED_PUBLIC_KEY_HASH },
    phase9Binding: { ...phase9.binding, publicKeyHash: PHASE9_EXPECTED_PUBLIC_KEY_HASH },
    heldOutState: {
      semanticInspectionStarted: false, contentBlindManifestFreezeStarted: false, sourceMounted: false,
    },
    datasets: ['waymo', 'nuscenes', 'argoverse2'].map(datasetEvidence),
    gates: {
      regression: gate('regression'), productionBuild: gate('production-build'),
      authorBuild: gate('author-build'),
      productionBoundary: gate('build-boundary'), authorBoundary: gate('build-boundary'),
      adapterAmnesia: { passed: true, evidenceHash: phase9.binding.gateReportHash },
      oracleReceipts: { passed: true, evidenceHash: phase6.binding.gateReportHash },
      performanceLifecycle: gate('performance-lifecycle'),
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
    verifierBinding: testVerifierBinding(),
    applicationCommit: COMMIT, phase: 'D', sourceCaseManifestHash: hash('case-d'),
    sourceManifestHash: hash('source-d'), observedAt: '2026-08-31T00:00:00.000Z',
    terminalCode: 'CAPABILITY_GAP', diagnosticHash: hash('diagnostic'),
    boundedInspectionHash: hash('inspection'), classification: 'unclassified',
  }
  const failure = { ...failurePayload, artifactHash: phase10HashV1(failurePayload) }
  await validatePhase10SchemaV1(failure)
  assert.equal(validateFirstFailureSemanticsV1(failure), true)

  const first = createDecisionLedgerEntryV1([], {
    verifierBinding: testVerifierBinding(),
    ledgerId: 'phase10-ledger', event: 'first-failure', occurredAt: '2026-08-31T00:00:01.000Z',
    sourceCaseManifestHash: failure.sourceCaseManifestHash, firstFailureHash: failure.artifactHash,
    detailsHash: hash('first-failure-details'),
  })
  const second = createDecisionLedgerEntryV1([first], {
    verifierBinding: testVerifierBinding(),
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

test('baseline freeze and Phase 9 binding reject unsigned, boundary, duplicate, and coverage downgrade paths', async () => {
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

  const phase9Drift = structuredClone(freeze)
  phase9Drift.phase9Binding.recipeBindings[0].recipeHash = hash('unattested-recipe')
  phase9Drift.freezeHash = phase10HashV1(Object.fromEntries(
    Object.entries(phase9Drift).filter(([key]) => key !== 'freezeHash'),
  ))
  assert.throws(
    () => validatePhase10BaselineFreezeSemanticsV1(phase9Drift, COMMIT),
    /not bound to its Phase 9 signed receipt/u,
  )

  const { attestation, gate, receipts, trust } = phase9Evidence()
  const forgedGate = structuredClone(gate)
  forgedGate.checks[0].candidateRecipeHash = hash('forged-signed-recipe')
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(attestation, forgedGate, receipts, COMMIT, trust),
    /does not match the three verified signed receipts/u,
  )

  const forgedReceipts = structuredClone(receipts)
  forgedReceipts[0].candidateRecipeHash = hash('coordinated-forgery')
  const coordinatedGate = { ...gate, checks: gateChecksFromReceipts(forgedReceipts) }
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(attestation, coordinatedGate, forgedReceipts, COMMIT, trust),
    /invalid signed Phase 9 receipt/u,
  )

  const boundaryDowngrade = structuredClone(receipts)
  boundaryDowngrade[0] = resignPhase9Receipt(boundaryDowngrade[0], {
    amnesiaBoundarySourceMatched: false,
  })
  const boundaryGate = { ...gate, checks: gateChecksFromReceipts(boundaryDowngrade) }
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(attestation, boundaryGate, boundaryDowngrade, COMMIT, trust),
    /invalid signed Phase 9 receipt/u,
  )

  // A receipt signed by any checkout other than the pinned verifier commit, a
  // non-reviewed judge version, or a gate that names a different judge commit
  // is not Phase 10 evidence even when every signature verifies.
  const foreignJudge = structuredClone(receipts)
  foreignJudge[0] = resignPhase9Receipt(foreignJudge[0], { judgeToolCommit: 'e'.repeat(40) })
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(
      attestation, { ...gate, checks: gateChecksFromReceipts(foreignJudge) }, foreignJudge, COMMIT, trust,
    ),
    /invalid signed Phase 9 receipt/u,
  )
  const forgedVersion = structuredClone(receipts)
  forgedVersion[0] = resignPhase9Receipt(forgedVersion[0], { judgeVersion: 'spec013-phase9-v0' })
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(
      attestation, { ...gate, checks: gateChecksFromReceipts(forgedVersion) }, forgedVersion, COMMIT, trust,
    ),
    /invalid signed Phase 9 receipt/u,
  )
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(attestation, { ...gate, judgeToolCommit: 'e'.repeat(40) }, receipts, COMMIT, trust),
    /Invalid or stale Phase 9 Adapter Amnesia gate report/u,
  )
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(attestation, { ...gate, judgeVersion: 'spec013-v1' }, receipts, COMMIT, trust),
    /Invalid or stale Phase 9 Adapter Amnesia gate report/u,
  )
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(
      attestation, gate, receipts, COMMIT, phase9Trust({ verifierToolCommit: 'e'.repeat(40) }),
    ),
    /Invalid or stale Phase 9 Adapter Amnesia gate report/u,
  )
  assert.equal(phase9Evidence().binding.judgeToolCommit, phase9Trust().verifierToolCommit)
  assert.equal(phase9Evidence().binding.judgeVersion, PHASE9_EXPECTED_JUDGE_VERSION)
  const judgeDrift = structuredClone(freeze)
  judgeDrift.phase9Binding.judgeToolCommit = 'e'.repeat(40)
  judgeDrift.freezeHash = phase10HashV1(Object.fromEntries(
    Object.entries(judgeDrift).filter(([key]) => key !== 'freezeHash'),
  ))
  assert.throws(
    () => validatePhase10BaselineFreezeSemanticsV1(judgeDrift, COMMIT),
    /not bound to one exact Phase 9 signed gate/u,
  )

  const duplicate = structuredClone(freeze)
  duplicate.phase9Binding.recipeBindings[1].receiptHash = duplicate.phase9Binding.recipeBindings[0].receiptHash
  duplicate.freezeHash = phase10HashV1(Object.fromEntries(
    Object.entries(duplicate).filter(([key]) => key !== 'freezeHash'),
  ))
  assert.throws(
    () => validatePhase10BaselineFreezeSemanticsV1(duplicate, COMMIT),
    /not bound to one exact Phase 9 signed gate/u,
  )
  const duplicateBoundaryArtifact = structuredClone(freeze)
  duplicateBoundaryArtifact.phase9Binding.recipeBindings[1].boundaryCaseArtifactHash =
    duplicateBoundaryArtifact.phase9Binding.recipeBindings[0].boundaryCaseArtifactHash
  duplicateBoundaryArtifact.freezeHash = phase10HashV1(Object.fromEntries(
    Object.entries(duplicateBoundaryArtifact).filter(([key]) => key !== 'freezeHash'),
  ))
  assert.throws(
    () => validatePhase10BaselineFreezeSemanticsV1(duplicateBoundaryArtifact, COMMIT),
    /not bound to one exact Phase 9 signed gate/u,
  )

  const reducedCoverage = structuredClone(freeze)
  const reducedDataset = reducedCoverage.datasets[0]
  reducedDataset.coverage.frameIndices = [reducedDataset.coverage.frameIndices[0]]
  reducedDataset.coverageHash = phase10HashV1(reducedDataset.coverage)
  for (const mode of [reducedDataset.local, reducedDataset.remote, reducedDataset.share]) {
    mode.coverageHash = reducedDataset.coverageHash
  }
  reducedDataset.evidenceHash = phase10HashV1(Object.fromEntries(
    Object.entries(reducedDataset).filter(([key]) => key !== 'evidenceHash'),
  ))
  reducedCoverage.freezeHash = phase10HashV1(Object.fromEntries(
    Object.entries(reducedCoverage).filter(([key]) => key !== 'freezeHash'),
  ))
  assert.throws(
    () => validatePhase10BaselineFreezeSemanticsV1(reducedCoverage, COMMIT),
    /does not contain exact reviewed coverage/u,
  )

  const coverageTrust = phase9Trust()
  coverageTrust.phase9Requirements.targets[0].coverage.frameIndices = [999]
  const coverageGate = {
    ...gate,
    requirementsHash: sha256Canonical(coverageTrust.phase9Requirements),
  }
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(attestation, coverageGate, receipts, COMMIT, coverageTrust),
    /Invalid Phase 9 production trust anchors/u,
  )

  const phase6 = phase6Evidence()
  const unsignedPhase6 = structuredClone(phase6.receipts)
  delete unsignedPhase6[0].signature
  assert.throws(
    () => phase6OracleBindingV1(phase6.gate, unsignedPhase6, COMMIT, phase6.trust),
    /invalid original signed Phase 6 receipt/u,
  )
  const forgedPassingCheck = structuredClone(phase6.receipts)
  forgedPassingCheck[0] = resignPhase9Receipt(forgedPassingCheck[0], {
    checks: forgedPassingCheck[0].checks.map((check, index) => index === 0
      ? { ...check, mismatchPaths: ['/integrity'] }
      : check),
  })
  assert.throws(
    () => phase6OracleBindingV1(phase6.gate, forgedPassingCheck, COMMIT, phase6.trust),
    /invalid original signed Phase 6 receipt/u,
  )
  const substitutedPhase6 = structuredClone(phase6.receipts)
  substitutedPhase6[0] = substitutedPhase6[1]
  const substitutedGate = {
    ...phase6.gate,
    checks: substitutedPhase6.map((receipt) => ({
      datasetId: receipt.target.datasetId,
      caseId: receipt.target.caseId,
      passed: true,
      receiptHash: receipt.receiptHash,
      oracleGeneratorCommit: receipt.oracleGeneratorCommit,
      candidateGeneratorCommit: receipt.candidateGeneratorCommit,
    })),
  }
  assert.throws(
    () => phase6OracleBindingV1(substitutedGate, substitutedPhase6, COMMIT, phase6.trust),
    /canonically match/u,
  )
  const fabricatedAggregate = structuredClone(phase6.gate)
  fabricatedAggregate.checks[0].receiptHash = sha256Canonical({ fabricated: true })
  assert.throws(
    () => phase6OracleBindingV1(fabricatedAggregate, phase6.receipts, COMMIT, phase6.trust),
    /canonically match/u,
  )
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
    assert.equal(Object.hasOwn(config, 'sourceFingerprint'), false)
    const protectedConfig = phase10ProtectedConformanceConfigV1(config, requirement, hash('private-source'))
    assert.equal(protectedConfig.sourceFingerprint, hash('private-source').replace('sha256:', 'sha256-'))
    assert.equal(Object.hasOwn(config, 'sourceFingerprint'), false)
    assert.deepEqual([...config.requiredCapabilities].sort(), [...requirement.requiredCapabilities].sort())
    assert.deepEqual(config.frameIndices, requirement.frameIndices)
    assert.deepEqual(
      config.perceptualCaptures.map((capture) => capture.id).sort(),
      [...requirement.perceptualReferenceIds].sort(),
    )
    for (const capture of config.perceptualCaptures) {
      if (capture.selector === '[data-egolens-capture-region="viewport"]') {
        assert.deepEqual(capture.parityViewport, { width: 1440, height: 600 })
      } else {
        assert.equal(capture.parityViewport, undefined)
      }
    }
  }
})

test('content-blind manifest and reserve CLIs retain protected paths only in the protected artifact', (context) => {
  const trustedTool = trustedToolFixture()
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-manifest-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source')
  const { status: mkdirStatus } = spawnSync('mkdir', ['-p', path.join(source, 'nested')])
  assert.equal(mkdirStatus, 0)
  writeFileSync(path.join(source, 'nested', 'frame.bin'), Buffer.from([1, 2, 3]))
  const protectedPath = path.join(directory, 'protected.json')
  const publicPath = path.join(directory, 'public.json')
  const result = spawnSync(process.execPath, [
    path.join(trustedTool.root, 'scripts/phase10-source-case-manifest.mjs'),
    '--root', source, '--dataset-id', 'fixture-dataset', '--release-id', 'official-v1',
    '--official-source-url', 'https://data.example.test/release', '--case-id', 'case-d-0',
    '--role', 'D', '--order', '0', '--original-form', 'complete-official-subtree',
    '--capability', 'pointClouds', '--output', protectedPath, '--public-output', publicPath,
  ], { cwd: trustedTool.root, encoding: 'utf8', env: trustedTool.env })
  assert.equal(result.status, 0, result.stderr)
  const protectedManifest = JSON.parse(readFileSync(protectedPath, 'utf8'))
  const publicSummary = JSON.parse(readFileSync(publicPath, 'utf8'))
  assert.equal(protectedManifest.files[0].path, 'nested/frame.bin')
  assert.equal(JSON.stringify(publicSummary).includes('nested/frame.bin'), false)
  assert.equal(publicSummary.sourceCaseManifestHash, protectedManifest.manifestHash)
})

test('production Phase 10 trust is fixed and the final gate has no requirements/key or dirty-head downgrade', async (context) => {
  const phase9 = phase9Evidence()
  await assert.rejects(
    loadPhase10ProductionTrustV1({ trustManifestPath: '', expectedManifestHash: '' }),
    /owner-pinned|manifest/u,
  )
  const anchorDirectory = mkdtempSync(path.join(realpathSync(tmpdir()), 'egolens-phase10-fake-anchor-'))
  chmodSync(anchorDirectory, 0o700)
  context.after(() => rmSync(anchorDirectory, { recursive: true, force: true }))
  const fakePayload = {
    schema: 'egolens-phase10-verifier-trust-v1',
    verifierId: 'egolens-phase10-p7-reviewed-verifier-v1',
    verifierCommit: 'f'.repeat(40),
    verifierSourceTreeHash: hash('fake-verifier-tree'),
    verifierClosureHash: hash('fake-verifier-closure'),
    verifierDependencyClosureHash: hash('fake-verifier-dependency-closure'),
    verifierNodeRuntimeHash: hash('fake-verifier-node-runtime'),
    reviewId: 'self-authored-fixture',
    approvedAt: '2026-08-31T00:00:00.000Z',
  }
  const fakeManifest = { ...fakePayload, manifestHash: phase10HashV1(fakePayload) }
  const fakePath = path.join(anchorDirectory, 'trust.json')
  writeFileSync(fakePath, JSON.stringify(fakeManifest), { mode: 0o600 })
  chmodSync(fakePath, 0o600)
  const weakAnchorDirectory = mkdtempSync(path.join(realpathSync(tmpdir()), 'egolens-phase10-weak-anchor-'))
  context.after(() => rmSync(weakAnchorDirectory, { recursive: true, force: true }))
  chmodSync(weakAnchorDirectory, 0o755)
  const weakPath = path.join(weakAnchorDirectory, 'trust.json')
  writeFileSync(weakPath, JSON.stringify(fakeManifest), { mode: 0o600 })
  await assert.rejects(
    loadPhase10ProductionTrustV1({
      trustManifestPath: weakPath,
      expectedManifestHash: fakeManifest.manifestHash,
    }),
    /parent must be a canonical non-symlink owner-only directory/u,
  )
  const symlinkAnchorRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'egolens-phase10-symlink-anchor-'))
  context.after(() => rmSync(symlinkAnchorRoot, { recursive: true, force: true }))
  chmodSync(symlinkAnchorRoot, 0o700)
  const symlinkParent = path.join(symlinkAnchorRoot, 'linked-anchor')
  symlinkSync(anchorDirectory, symlinkParent, 'dir')
  await assert.rejects(
    loadPhase10ProductionTrustV1({
      trustManifestPath: path.join(symlinkParent, 'trust.json'),
      expectedManifestHash: fakeManifest.manifestHash,
    }),
    /parent must be a canonical non-symlink owner-only directory/u,
  )
  await assert.rejects(
    loadPhase10ProductionTrustV1({
      trustManifestPath: fakePath,
      expectedManifestHash: hash('operator-approved-different-manifest'),
    }),
    /(?:operator-pinned manifest hash|outside the verifier checkout)/u,
  )
  assert.throws(
    () => phase9AdapterAmnesiaBindingV1(
      phase9.attestation,
      phase9.gate,
      phase9.receipts,
      COMMIT,
      { ...phase9.trust, productionTrust: true, testOnly: false },
    ),
    /Invalid Phase 9 production trust anchors/u,
  )

  const rejectedOverride = spawnSync(process.execPath, [
    'scripts/phase10-baseline-gate.mjs', '--requirements', 'caller-controlled.json',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.notEqual(rejectedOverride.status, 0)
  assert.match(rejectedOverride.stderr, /Unknown option: --requirements/u)

  const gateSource = readFileSync('scripts/phase10-baseline-gate.mjs', 'utf8')
  assert.match(gateSource, /'status', '--porcelain'/u)
  assert.match(gateSource, /phase10-build-boundary\.mjs/u)
  assert.match(gateSource, /candidate-repository/u)
  assert.match(gateSource, /cleanHeadVerified = true/u)
  assert.doesNotMatch(gateSource, /require-clean-head/u)
})

test('verifier dependency closure resolves and hashes the exact nested installed package', async (context) => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'egolens-phase10-nested-deps-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  chmodSync(directory, 0o700)
  const modules = path.join(directory, 'node_modules')
  const writePackage = (relative, metadata, body) => {
    const root = path.join(modules, relative)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(metadata))
    writeFileSync(path.join(root, 'index.js'), body)
  }
  writePackage('fixture-a', { name: 'fixture-a', version: '1.0.0', dependencies: { 'fixture-b': '^2.0.0' } }, 'a')
  writePackage('fixture-a/node_modules/fixture-b', { name: 'fixture-b', version: '2.0.0' }, 'nested-v2')
  writePackage('fixture-b', { name: 'fixture-b', version: '1.0.0' }, 'top-v1')
  const first = await phase10VerifierDependencyClosureV1(modules, { rootPackages: ['fixture-a'] })
  writeFileSync(path.join(modules, 'fixture-b', 'index.js'), 'top-v1-tampered-but-unresolved')
  const unrelated = await phase10VerifierDependencyClosureV1(modules, { rootPackages: ['fixture-a'] })
  assert.equal(unrelated.closureHash, first.closureHash)
  writeFileSync(path.join(modules, 'fixture-a', 'node_modules', 'fixture-b', 'index.js'), 'nested-v2-tampered')
  const nested = await phase10VerifierDependencyClosureV1(modules, { rootPackages: ['fixture-a'] })
  assert.notEqual(nested.closureHash, first.closureHash)
  assert.equal(first.packageCount, 2)
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

test('catalog and Range host bind byte-identical source while preparation rejects caller-controlled trust', async (context) => {
  const trustedTool = trustedToolFixture()
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
    path.join(trustedTool.root, 'scripts/phase10-source-case-manifest.mjs'), '--root', source,
    '--dataset-id', 'waymo', '--release-id', 'fixture-official-v1',
    '--official-source-url', 'https://data.example.test/waymo',
    '--case-id', 'phase6-waymo-rich-001', '--role', 'D', '--order', '0',
    '--original-form', 'complete-official-subtree',
    ...capabilities.flatMap((capability) => ['--capability', capability]),
    '--output', sourceCasePath, '--public-output', sourceSummaryPath,
  ], { cwd: trustedTool.root, encoding: 'utf8', env: trustedTool.env })
  assert.equal(sourceResult.status, 0, sourceResult.stderr)
  const catalogPath = path.join(directory, 'catalog.json')
  const catalogSummaryPath = path.join(directory, 'catalog-summary.json')
  const catalogResult = spawnSync(process.execPath, [
    path.join(trustedTool.root, 'scripts/phase10-source-catalog.mjs'), '--root', source, '--source-case', sourceCasePath,
    '--chunk-size', '65536', '--output', catalogPath, '--public-output', catalogSummaryPath,
  ], { cwd: trustedTool.root, encoding: 'utf8', env: trustedTool.env })
  assert.equal(catalogResult.status, 0, catalogResult.stderr)
  assert.equal(JSON.stringify(JSON.parse(readFileSync(catalogSummaryPath))).includes('vehicle_pose'), false)

  const port = 18_000 + Math.floor(Math.random() * 1_000)
  const outputDirectory = path.join(directory, 'prepared')
  const rejectedPrepareOverride = spawnSync(process.execPath, [
    'scripts/phase10-prepare-preflight.mjs', '--requirements', 'caller-controlled.json',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.notEqual(rejectedPrepareOverride.status, 0)
  assert.match(rejectedPrepareOverride.stderr, /Unknown option: --requirements/u)
  mkdirSync(outputDirectory)
  const capability = 'b'.repeat(64)
  const protectedRoot = `http://127.0.0.1:${port}/access/${capability}/`
  writeFileSync(path.join(outputDirectory, 'descriptor.json'), JSON.stringify({
    schema: 'fixture-share',
    source: {
      rootUrl: `${protectedRoot}source/`,
      catalogUrl: `${protectedRoot}catalog.json`,
    },
    recipe: { url: `${protectedRoot}recipe.json` },
  }))

  const host = spawn(process.execPath, [
    path.join(trustedTool.root, 'scripts/phase10-range-host.mjs'), '--root', source, '--catalog', catalogPath,
    '--recipe', 'src/adapters/recipes/waymo.egolens-adapter.json',
    '--descriptor', path.join(outputDirectory, 'descriptor.json'), '--port', String(port),
  ], { cwd: trustedTool.root, env: trustedTool.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const untrusted = await fetch(`${protectedRoot}source/vehicle_pose/segment.parquet`, {
    headers: { Range: 'bytes=1-2' },
  })
  assert.equal(untrusted.status, 403)
  const response = await fetch(`${protectedRoot}source/vehicle_pose/segment.parquet`, {
    headers: { Origin: 'http://127.0.0.1:4173', Range: 'bytes=1-2' },
  })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 1-2/4')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3])
  host.kill('SIGTERM')
  await new Promise((resolve) => host.once('exit', resolve))
})

test('reproducible build boundary ignores caller PATH shadows', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-path-shadow-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, 'bin')
  const marker = path.join(directory, 'shadow-invoked')
  mkdirSync(bin)
  for (const name of ['git', 'npm']) {
    const filename = path.join(bin, name)
    writeFileSync(filename, `#!/bin/sh\ntouch "${marker}"\nexit 99\n`)
    chmodSync(filename, 0o755)
  }
  const missingRepository = path.join(directory, 'not-a-repository')
  mkdirSync(missingRepository)
  const result = spawnSync(process.execPath, [
    'scripts/phase10-build-boundary.mjs',
    '--candidate-repository', missingRepository,
    '--production', path.join(missingRepository, 'dist'),
    '--author', path.join(missingRepository, 'dist-amnesia-author'),
    '--expected-commit', COMMIT,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PATH: bin },
  })
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(marker), false)
})

test('trusted benchmark invocation rejects a served app inventory mismatch before Chrome starts', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-app-build-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const build = path.join(directory, 'dist')
  mkdirSync(build)
  writeFileSync(path.join(build, 'index.html'), '<!doctype html><script src="/app.js"></script>')
  writeFileSync(path.join(build, 'app.js'), 'globalThis.fixture = true')
  const result = spawnSync(process.execPath, [
    path.resolve('scripts/phase6-cdp-benchmark.mjs'),
    '--url', 'http://127.0.0.1:4173/',
    '--output', path.join(directory, 'benchmark.json'),
    '--app-build-root', build,
    '--expected-app-build-inventory-hash', hash('different-build'),
  ], { cwd: directory, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match the reproduced production build/u)
  assert.equal(existsSync(path.join(directory, 'benchmark.json')), false)
})

// macOS refuses to apply a deny-default Seatbelt profile from a process that is
// already sandboxed (`sandbox_apply: Operation not permitted`), so this test
// cannot run inside the evidence-harness gate's own containment. The harness
// gate requires exactly this one skip with this reason; the negative gate is
// always executed as its own outer gate.
const NESTED_SEATBELT_SKIP = typeof process.env.EGOLENS_BUILD_CONTAINMENT_TOKEN === 'string'
  ? 'nested deny-default Seatbelt profiles are not permitted; the negative gate runs as its own outer gate'
  : false

test('negative gate executes the exact reviewed matrix and rejects caller-supplied reports', { skip: NESTED_SEATBELT_SKIP }, (context) => {
  const trustedTool = trustedToolFixture()
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'egolens-phase10-negative-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const candidate = path.join(directory, 'candidate')
  const cloned = spawnSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', trustedTool.root, candidate], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  assert.equal(cloned.status, 0, cloned.stderr)
  const candidateCommit = spawnSync('/usr/bin/git', ['-C', candidate, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim()
  const fabricated = path.join(directory, 'fabricated.json')
  writeFileSync(fabricated, JSON.stringify({
    success: true, numFailedTests: 0, numPassedTests: PHASE10_REQUIRED_NEGATIVE_CASES.length,
  }))
  const output = path.join(directory, 'gate.json')
  const rejected = spawnSync(process.execPath, [
    path.join(trustedTool.root, 'scripts/phase10-negative-gate.mjs'),
    '--candidate-repository', candidate, '--vitest-report', fabricated,
    '--expected-commit', candidateCommit, '--output', output,
  ], { cwd: directory, encoding: 'utf8', env: trustedTool.env })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /Caller-supplied Vitest reports are forbidden/u)
  const result = spawnSync(process.execPath, [
    path.join(trustedTool.root, 'scripts/phase10-negative-gate.mjs'),
    '--candidate-repository', candidate, '--expected-commit', candidateCommit, '--output', output,
  ], { cwd: directory, encoding: 'utf8', env: trustedTool.env, timeout: 10 * 60 * 1000 })
  assert.equal(result.status, 0, result.stderr)
  const gate = JSON.parse(readFileSync(output))
  assert.equal(gate.cases.length, PHASE10_REQUIRED_NEGATIVE_CASES.length)
  assert.equal(gate.passed, true)
  assert.equal(gate.candidateCommit, candidateCommit)
  assert.equal(gate.execution.detachedChildExecDenied, true)
  assert.equal(gate.execution.externalNetworkDenied, true)
  assert.equal(gate.execution.residualProcessCount, 0)
})

test('preflight recorder and dataset semantics prove full reviewed coverage and three fresh modes', async (context) => {
  const trustedTool = trustedToolFixture()
  const directory = mkdtempSync(path.join(tmpdir(), 'egolens-phase10-preflight-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const requirements = JSON.parse(readFileSync('benchmarks/phase10/preflight-requirements.json'))
  const trustedEvidenceModule = await import(
    `${pathToFileURL(path.join(trustedTool.root, 'scripts/lib/phase10-evidence.mjs')).href}?trusted-fixture=1`
  )
  const productionTrust = await trustedEvidenceModule.loadPhase10ProductionTrustV1({
    trustManifestPath: trustedTool.env.PHASE10_VERIFIER_TRUST_MANIFEST,
    expectedManifestHash: trustedTool.env.PHASE10_EXPECTED_VERIFIER_TRUST_MANIFEST_HASH,
  })
  const productionVerifierBinding = trustedEvidenceModule.phase10VerifierBindingV1(productionTrust)
  const requirement = requirements.datasets.find((entry) => entry.datasetId === 'waymo')
  const phase9 = phase9Evidence({
    caseIds: Object.fromEntries(requirements.datasets.map((entry) => [entry.datasetId, entry.caseId])),
  })
  const files = [{ path: 'vehicle_pose/segment.parquet', size: 4, sha256: hash('source-file') }]
  const sourcePayload = {
    schema: 'egolens-source-case-manifest-v1',
    verifierBinding: productionVerifierBinding,
    release: { datasetId: 'waymo', releaseId: 'fixture-official-v1', officialSourceUrl: 'https://data.example.test/waymo', officialArchiveChecksum: null },
    case: { caseId: requirement.caseId, role: 'D', reserveFor: null, order: 0, originalForm: 'complete-official-subtree', unchangedOriginal: true, archiveExtractionOnly: false, declaredCapabilities: [...requirement.requiredCapabilities].sort() },
    files, aggregate: { fileCount: 1, totalBytes: 4 }, sourceManifestHash: sourceManifestHashFromFilesV1(files),
  }
  const sourceCase = { ...sourcePayload, manifestHash: phase10HashV1(sourcePayload) }
  const sourceCasePath = path.join(directory, 'source-case.json')
  writeFileSync(sourceCasePath, JSON.stringify(sourceCase))
  const shared = {
    sourceTreeHash: hash('preflight-source-tree'),
    productionBuildInventoryHash: hash('preflight-production-build'),
    sourceManifestHash: sourceCase.sourceManifestHash,
    recipeHash: phase9.binding.recipeBindings.find((entry) => entry.datasetId === 'waymo').recipeHash,
    formatFingerprint: hash('format'),
    operatorSetFingerprint: hash('operators'),
    catalogHash: hash('catalog'),
    shareDescriptorHash: hash('descriptor'),
  }
  const buildPayload = {
    schema: 'egolens-phase10-build-boundary-report-v1',
    candidateCommit: COMMIT,
    sourceTreeHash: shared.sourceTreeHash,
    cleanHeadVerified: true,
    detachedCheckoutVerified: true,
    ignoredInputsExcluded: true,
    sanitizedEnvironmentVerified: true,
    dependencyInstall: 'reviewed-verifier-node-modules-closure',
    dependencyManifestHash: hash('preflight-dependency-manifest'),
    reviewedBuildInputManifestHash: hash('preflight-reviewed-build-inputs'),
    verifierBinding: productionVerifierBinding,
    sandbox: {
      platform: 'macos-seatbelt-deny-default',
      sandboxProfileHash: hash('sandbox-profile'), reviewedDriverHash: hash('reviewed-driver'),
      nodeRuntimeHash: hash('node-runtime'), dependencyEntryHash: hash('dependency-entry'),
      productionSourceStageHash: hash('production-source-stage'),
      authorSourceStageHash: hash('author-source-stage'), authorSourceGraphHash: hash('author-source-graph'),
      candidatePreSourceTreeHash: shared.sourceTreeHash,
      candidatePostSourceTreeHash: shared.sourceTreeHash,
      verifierPreSourceTreeHash: productionVerifierBinding.verifierSourceTreeHash,
      verifierPostSourceTreeHash: productionVerifierBinding.verifierSourceTreeHash,
      candidateScriptsInvoked: false, gitHistoryAbsent: true,
      authorAllowlistedStage: true, authorPinnedGraphPolicy: true,
      reviewedExecutableConfigsOnly: true, detachedChildCleanupVerified: true,
      residualProcessAuditPassed: true, dependencyClosureUnchanged: true,
      networkDenied: true, protectedRootsDenied: true, trackedSourceWriteDenied: true,
      processGroupCleanup: true, candidateRepositoryUnchanged: true,
      verifierCheckoutUnchanged: true, sourceUnchanged: true, passed: true,
    },
    production: {
      name: 'production', fileCount: 1, totalBytes: 1,
      inventoryHash: shared.productionBuildInventoryHash,
      phase9ContentHash: hash('preflight-production-content'),
      sourceMaps: 0, deniedMarkers: 0, exactCommitEmbedded: true, passed: true,
    },
    author: {
      name: 'author', fileCount: 1, totalBytes: 1,
      inventoryHash: hash('preflight-author-build'),
      phase9ContentHash: phase9.binding.authorApplicationBuildHash,
      sourceMaps: 0, deniedMarkers: 0, exactCommitEmbedded: true, passed: true,
    },
    passed: true,
  }
  const buildBoundary = { ...buildPayload, reportHash: phase10HashV1(buildPayload) }
  const buildBoundaryPath = path.join(directory, 'build-boundary.json')
  writeFileSync(buildBoundaryPath, JSON.stringify(buildBoundary))
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
    coverage: phase10ReviewedCoverageV1(requirement),
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
  const renderedFrame = { frameIndex: 0, timestampMicros: '1', sensors: [] }
  const makeBenchmark = (capture, firstProcess, identity) => {
    const runtimeIdentity = Object.fromEntries(Object.entries(identity)
      .filter(([key]) => key !== 'datasetId' && key !== 'caseId'))
    const mode = identity.catalogHash === null ? 'local' : identity.shareDescriptorHash === null ? 'remote' : 'share'
    const capability = 'c'.repeat(64)
    const countedUrl = mode === 'local'
      ? 'http://127.0.0.1:4173/'
      : mode === 'remote'
        ? `http://127.0.0.1:4173/?shareVersion=1&data=http%3A%2F%2F127.0.0.1%3A18000%2Faccess%2F${capability}%2Fsource%2F&catalog=http%3A%2F%2F127.0.0.1%3A18000%2Faccess%2F${capability}%2Fcatalog.json&recipe=http%3A%2F%2F127.0.0.1%3A18000%2Faccess%2F${capability}%2Frecipe.json`
        : `http://127.0.0.1:4173/?share=http%3A%2F%2F127.0.0.1%3A18000%2Faccess%2F${capability}%2Fshare.json&shareHash=${shared.shareDescriptorHash}`
    const sourceMode = phase10PreflightSourceModeV1(countedUrl, mode === 'local')
    const browserBoundary = makeBoundaryEnvironmentV1({
      profileTemplateHash: hash('counted-browser-profile'),
      sourceMode,
      appOrigin: 'http://127.0.0.1:4173',
      sourceOrigin: mode === 'local' ? null : 'http://127.0.0.1:18000',
      localSourceRootCommitment: hash(mode === 'local' ? 'local-source-root' : 'no-local-source-root'),
      browserBinary: officialChromeIdentityFixture(),
    })
    const runs = Array.from({ length: capture ? 1 : 6 }, (_, index) => {
      const preflight = {
        datasetId: identity.datasetId, sceneId: 'segment', identity: runtimeIdentity,
        buildCommit: COMMIT, sourceTreeHash: shared.sourceTreeHash,
        presentation: initialPresentation, renderedFrame,
        agentActivity: { modelContextAvailable: false, agentEngaged: false },
      }
      const requestAudit = requestAuditV1([], browserBoundary)
      const browserBoundaryRun = makeBoundaryRunEvidenceV1({
        boundary: browserBoundary,
        parametersHash: hash(`boundary-parameters-${firstProcess + index}`),
        debugPort: 20_000 + firstProcess + index,
        checks: COUNTED_BROWSER_REQUIRED_CHECKS.map((name) => ({ name, passed: true, evidence: 'fixture' })),
        requestAudit,
        browserBinaryIdentityHashBefore: browserBoundary.browserBinary.identityHash,
        browserBinaryIdentityHashAfter: browserBoundary.browserBinary.identityHash,
      })
      return {
        browserProcess: processEvidence(firstProcess + index),
        browserBoundary: browserBoundaryRun,
        appBuild: {
          immutableSnapshotServed: true,
          loopbackOnly: true,
          servedInventoryHash: shared.productionBuildInventoryHash,
          preRunInventoryHash: shared.productionBuildInventoryHash,
          postRunInventoryHash: shared.productionBuildInventoryHash,
        },
        preflight,
        postSoakPreflight: structuredClone(preflight),
        traceCollection: { complete: true, truncated: false },
        snapshots: { afterDisposeSettle: { app: { scene: null, resources: { liveObjectUrls: 0, liveImageBitmaps: 0 } }, liveWorkerTargets: [] } },
        ...(capture ? { conformance: capture } : {}),
      }
    })
    return {
      scenario: {
        warmupRuns: capture ? 0 : 1, measuredRuns: capture ? 1 : 5,
        seeks: capture ? 0 : 100, sceneSwitches: capture ? 0 : 20,
        playbackLoops: capture ? 0 : 2, traceEnabled: true,
        browserIsolation: 'per-run', freshProcessEvidence: 'egolens-fresh-browser-process-v1',
        countedBrowserBoundary: 'egolens-counted-browser-boundary-v1',
        sourceMode,
        preflightRecipeHash: mode === 'local' ? identity.recipeHash : null,
      },
      environment: {
        commit: COMMIT, dirty: false, sourceTreeHash: shared.sourceTreeHash,
        candidateIdentitySource: 'reviewed-build-boundary-inputs',
        verifierToolCommit: productionTrust.verifierToolCommit,
        verifierToolClean: true,
        verifierSourceTreeHash: productionTrust.verifierSourceTreeHash,
        verifierBinding: productionVerifierBinding,
        servedBuildInventoryHash: shared.productionBuildInventoryHash,
        appBuildInitialDiskHash: shared.productionBuildInventoryHash,
        appBuildFinalDiskHash: shared.productionBuildInventoryHash,
        immutableAppBuildSnapshotServed: true,
        appBuildLoopbackOnly: true,
        browserBoundary,
      },
      warmups: capture ? [] : [runs[0]], samples: capture ? runs : runs.slice(1),
      summary: { runSummaries: capture ? [] : Array.from({ length: 5 }, () => ({ datasetReadyMs: 1, firstUsableFrameMs: 2, frameLatencyP95Ms: 3, frameLatencySamples: 4 })) },
    }
  }
  const observations = []
  const perceptualReferences = requirement.perceptualReferenceIds.map((id, index) => ({
    id,
    sha256: `sha256-${String(index + 1).repeat(64)}`,
    width: id.startsWith('viewport-') ? 1440 : 100,
    height: id.startsWith('viewport-') ? 600 : 100,
  }))
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
      buildCommit: COMMIT, sourceTreeHash: shared.sourceTreeHash,
      identity: Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'datasetId' && key !== 'caseId')),
      presentation: initialPresentation,
      perceptualParity: { algorithm: 'egolens-perceptual-raster-v2', references: perceptualReferences },
    }
    const capturePath = path.join(directory, `${mode}-capture.json`)
    const performancePath = path.join(directory, `${mode}-performance.json`)
    const lifecyclePath = path.join(directory, `${mode}-lifecycle.json`)
    const identityPath = path.join(directory, `${mode}-identity.json`)
    const observationPath = path.join(directory, `${mode}-observation.json`)
    writeFileSync(capturePath, JSON.stringify(makeBenchmark(capture, 10 + modeIndex * 10, identity)))
    writeFileSync(performancePath, JSON.stringify(makeBenchmark(null, 11 + modeIndex * 10, identity)))
    writeFileSync(lifecyclePath, JSON.stringify(makeBenchmark(null, 17 + modeIndex * 10, identity)))
    writeFileSync(identityPath, JSON.stringify(identity))
    const result = spawnSync(process.execPath, [
      path.join(trustedTool.root, 'scripts/phase10-record-preflight-mode.mjs'), '--mode', mode, '--identity', identityPath,
      '--capture', capturePath, '--conformance', conformancePath, '--performance', performancePath,
      '--lifecycle', lifecyclePath, '--build-boundary', buildBoundaryPath,
      '--expected-commit', COMMIT, '--output', observationPath,
    ], { cwd: trustedTool.root, encoding: 'utf8', env: trustedTool.env })
    assert.equal(result.status, 0, result.stderr)
    if (mode === 'local') {
      const driftedPerformance = JSON.parse(readFileSync(performancePath, 'utf8'))
      driftedPerformance.samples[0].appBuild.postRunInventoryHash = hash('mutated-served-dist')
      const driftedPerformancePath = path.join(directory, 'local-performance-drifted.json')
      writeFileSync(driftedPerformancePath, JSON.stringify(driftedPerformance))
      const rejectedOutput = path.join(directory, 'local-drifted-observation.json')
      const rejected = spawnSync(process.execPath, [
        path.join(trustedTool.root, 'scripts/phase10-record-preflight-mode.mjs'), '--mode', mode, '--identity', identityPath,
        '--capture', capturePath, '--conformance', conformancePath,
        '--performance', driftedPerformancePath, '--lifecycle', lifecyclePath,
        '--build-boundary', buildBoundaryPath, '--expected-commit', COMMIT,
        '--output', rejectedOutput,
      ], { cwd: trustedTool.root, encoding: 'utf8', env: trustedTool.env })
      assert.notEqual(rejected.status, 0)
      assert.match(rejected.stderr, /unchanged served production bytes/u)
    }
    observations.push(observationPath)
  }
  const [local, remote, share] = observations.map((filename) => JSON.parse(readFileSync(filename, 'utf8')))
  const projectMode = (observation) => ({
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
  const datasetPayload = {
    verifierBinding: productionVerifierBinding,
    datasetId: local.datasetId,
    caseId: local.caseId,
    candidateCommit: COMMIT,
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
    local: projectMode(local),
    remote: projectMode(remote),
    share: projectMode(share),
    parityPassed: true,
  }
  const dataset = { ...datasetPayload, evidenceHash: phase10HashV1(datasetPayload) }
  assert.equal(validateDatasetBaselineEvidenceV1(dataset, COMMIT), undefined)

  const drifted = structuredClone(dataset)
  drifted.remote.recipeHash = hash('unattested-observation-recipe')
  drifted.evidenceHash = phase10HashV1(Object.fromEntries(
    Object.entries(drifted).filter(([key]) => key !== 'evidenceHash'),
  ))
  assert.throws(() => validateDatasetBaselineEvidenceV1(drifted, COMMIT), /identity drift/u)
})

function fixtureOutputText(root) {
  const texts = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(filename)
      else texts.push(readFileSync(filename, 'utf8'))
    }
  }
  visit(root)
  return texts.join('\n')
}

test('reviewed Vite configs ignore candidate-controlled env, PostCSS, and Babel auto-discovery', async (context) => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'egolens-phase10-vite-discovery-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'candidate-root')
  const postcssMarker = path.join(directory, 'postcss-config-executed')
  const babelMarker = path.join(directory, 'babel-config-executed')
  mkdirSync(root)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hostile-candidate-fixture', private: true }))
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><script type="module" src="/main.ts"></script>')
  writeFileSync(path.join(root, 'main.ts'), [
    "import './style.css'",
    "console.log('ENV:' + String(import.meta.env.VITE_HOSTILE) + ':' + String(import.meta.env.HOSTILE_SECRET))",
    '',
  ].join('\n'))
  writeFileSync(path.join(root, 'style.css'), 'body{color:red}\n')
  writeFileSync(path.join(root, '.env'), 'VITE_HOSTILE=HOSTILE_ENV_LEAKED\nHOSTILE_SECRET=HOSTILE_SECRET_LEAKED\n')
  writeFileSync(path.join(root, '.env.production'), 'VITE_HOSTILE=HOSTILE_ENV_LEAKED\n')
  writeFileSync(path.join(root, 'postcss.config.cjs'), [
    `require('node:fs').writeFileSync(${JSON.stringify(postcssMarker)}, 'executed')`,
    'module.exports = { plugins: [{ postcssPlugin: "hostile", Once(cssRoot) { cssRoot.append(".hostile-postcss{color:blue}") } }] }',
    '',
  ].join('\n'))
  writeFileSync(path.join(root, 'babel.config.cjs'), [
    `require('node:fs').writeFileSync(${JSON.stringify(babelMarker)}, 'executed')`,
    'module.exports = {}',
    '',
  ].join('\n'))
  writeFileSync(path.join(root, '.babelrc'), '{}')
  const controlConfig = path.join(directory, 'control.vite.config.mjs')
  writeFileSync(controlConfig, 'export default {}\n')
  const safeCwd = path.join(directory, 'driver-build-home')
  mkdirSync(safeCwd)
  const environment = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C', CI: 'true',
    EGOLENS_GIT_COMMIT: COMMIT, EGOLENS_SOURCE_TREE_HASH: hash('fixture-source-tree'),
  }
  const build = ({ command, cwd }, outDir) => spawnSync(command[0], [
    ...command.slice(1), '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error',
  ], { cwd, encoding: 'utf8', env: environment, timeout: 5 * 60 * 1000 })
  const nodeModules = path.resolve('node_modules')
  const naiveInvocation = (configFile) => ({
    cwd: root,
    command: [process.execPath, path.join(nodeModules, 'vite/bin/vite.js'), 'build', root,
      '--config', configFile, '--configLoader', 'runner'],
  })

  // Control 1: an unhardened config proves the hostile fixture is effective.
  const controlOut = path.join(directory, 'dist-control')
  const control = build(naiveInvocation(controlConfig), controlOut)
  assert.equal(control.status, 0, control.stderr)
  const controlText = fixtureOutputText(controlOut)
  assert.match(controlText, /HOSTILE_ENV_LEAKED/u)
  assert.match(controlText, /hostile-postcss/u)
  assert.equal(existsSync(postcssMarker), true)
  rmSync(postcssMarker)

  // Control 2: even the reviewed config executes a candidate PostCSS config
  // when the runner loader's process cwd is the candidate root, which is why
  // the reviewed driver never runs Vite from inside a candidate stage.
  const cwdLeakOut = path.join(directory, 'dist-cwd-leak')
  const cwdLeak = build(naiveInvocation(path.resolve('vite.config.ts')), cwdLeakOut)
  assert.equal(cwdLeak.status, 0, cwdLeak.stderr)
  assert.equal(existsSync(postcssMarker), true)
  rmSync(postcssMarker)
  assert.throws(
    () => phase10ReviewedViteBuildInvocationV1({
      node: process.execPath, nodeModules, configFile: path.resolve('vite.config.ts'), sourceRoot: root, cwd: root,
    }),
    /disjoint from the candidate source stage/u,
  )

  // Reviewed invocation shape (same helper as the sandboxed build driver):
  // the hostile tree can neither influence nor execute during the build.
  const reviewedOut = path.join(directory, 'dist-reviewed')
  const reviewed = build(phase10ReviewedViteBuildInvocationV1({
    node: process.execPath, nodeModules, configFile: path.resolve('vite.config.ts'), sourceRoot: root, cwd: safeCwd,
  }), reviewedOut)
  assert.equal(reviewed.status, 0, reviewed.stderr)
  const reviewedText = fixtureOutputText(reviewedOut)
  assert.doesNotMatch(reviewedText, /HOSTILE_ENV_LEAKED|HOSTILE_SECRET_LEAKED/u)
  assert.doesNotMatch(reviewedText, /hostile-postcss/u)
  assert.match(reviewedText, /color:\s*red/u)
  assert.equal(existsSync(postcssMarker), false)
  assert.equal(existsSync(babelMarker), false)
  assert.deepEqual(readdirSync(safeCwd), [], 'the reviewed build cwd must stay free of generated files')

  // Every reviewed config resolves to the same closed env/PostCSS settings.
  process.env.PHASE9_AUTHOR_GRAPH_REPORT = path.join(directory, 'author-graph.json')
  process.env.PHASE9_SOURCE_COMMIT = COMMIT
  try {
    for (const configFile of [
      'vite.config.ts', 'vite.amnesia.config.ts', 'scripts/phase9-counted-author-vite.config.ts',
    ]) {
      const loaded = await loadConfigFromFile(
        { command: 'build', mode: 'production' }, path.resolve(configFile), process.cwd(), 'error', undefined, 'runner',
      )
      assert.ok(loaded, configFile)
      assert.equal(loaded.config.envDir, false, configFile)
      assert.deepEqual(loaded.config.css?.postcss, { plugins: [] }, configFile)
    }
  } finally {
    delete process.env.PHASE9_AUTHOR_GRAPH_REPORT
    delete process.env.PHASE9_SOURCE_COMMIT
  }
})
