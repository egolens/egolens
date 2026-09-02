import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  AMNESIA_DENIED_RESOURCES,
  AMNESIA_PUBLIC_TOOLS,
  PHASE9_EXPECTED_JUDGE_VERSION,
  amnesiaBoundaryWitness,
  recipeSemanticHash,
  verifyAmnesiaAttestation,
} from './lib/amnesia-evidence.mjs'
import {
  REQUIRED_PROBE_CHECKS,
  REVIEWED_AUTHOR_SOURCE_PATHS,
  assembleBoundaryReport,
  countedAuthorTypecheckConfigText,
  createBoundaryCaseArtifact,
  createProbeReport,
  createSourceManifestArtifact,
  currentTrustedToolManifest,
  effectivePolicyDescriptor,
  makeBoundaryCase,
  sha256Colon,
} from './lib/phase9-counted-author-boundary.mjs'
import { sha256Canonical, signReceipt } from './lib/oracle-receipts.mjs'

const PRODUCER_COMMIT = 'a42f658e27fce118789d3648e2612f5d25b99488'
const CANDIDATE_COMMIT = '1d34b6f000000000000000000000000000000000'
const DATASETS = ['waymo', 'nuscenes', 'argoverse2']

function sourceFingerprint(datasetId) {
  return `sha256-${String.fromCharCode(97 + DATASETS.indexOf(datasetId)).repeat(64)}`
}

function recipe(datasetId, authoringRun = 'fresh-authoring-run') {
  return {
    kind: 'egolens-adapter', schemaVersion: 1,
    identity: { name: datasetId }, provenance: { author: 'codex' },
    engine: { minimumVersion: '1.0.0', requiredOperators: {} },
    scene: { formatId: datasetId }, sources: {}, pipelines: {}, outputs: {}, validation: {},
    match: { globs: [`${authoringRun}-${datasetId}`] },
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
      sourceFingerprint: sourceFingerprint(datasetId),
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
      sourceFingerprint: sourceFingerprint(candidate.target.datasetId),
      generatedAt: '2026-08-30T00:00:00.000Z',
    }, artifact: candidate,
  }
  return { ...payload, bundleHash: sha256Canonical(payload) }
}

function writeJson(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value)}\n`)
}

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), encoding: 'utf8' })
}

/**
 * The judge and gate sign/verify the commit of their own clean checkout, so
 * the tests run them from a fresh single-commit repository that holds the
 * current judge implementation instead of from this (possibly dirty) tree.
 */
function judgeToolCheckout(context) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'egolens-phase9-judge-tool-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  // The judge re-hashes the reviewed author source closure of its own checkout,
  // so the snapshot carries every tracked and untracked source file (never
  // node_modules or ignored data) exactly as it exists in this tree.
  const listed = spawnSync('/usr/bin/git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: process.cwd(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(listed.status, 0, listed.stderr?.toString())
  for (const relative of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const source = join(process.cwd(), relative)
    if (!statSync(source).isFile()) continue
    mkdirSync(join(root, dirname(relative)), { recursive: true })
    copyFileSync(source, join(root, relative))
  }
  const env = {
    HOME: root, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  }
  const git = (...argv) => {
    const result = spawnSync('/usr/bin/git', ['-C', root, ...argv], { encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=Phase 9 Test', '-c', 'user.email=phase9@test.invalid', 'commit', '-q', '-m', 'judge tool snapshot')
  return {
    root,
    commit: git('rev-parse', 'HEAD'),
    judge: join(root, 'scripts/phase9-oracle-judge.mjs'),
    gate: join(root, 'scripts/phase9-oracle-receipt-gate.mjs'),
  }
}

function boundaryReport(label, recipeHashes = Object.fromEntries(
  DATASETS.map((datasetId) => [datasetId, recipeSemanticHash(recipe(datasetId))]),
)) {
  const payload = {
    kind: 'egolens-adapter-amnesia-boundary-report',
    schemaVersion: 1,
    candidateCommit: CANDIDATE_COMMIT,
    enforcement: {
      platform: 'macos-seatbelt',
      coordinatorRuntimeId: 'egolens-amnesia-boundary-coordinator-v1',
    },
    controller: {
      datasetAccess: false,
      applicationAccess: false,
      candidateOutputAccess: false,
      toolNetwork: 'loopback-only',
      modelControlPlane: 'exact-controller-process-only',
    },
    cases: DATASETS.map((datasetId, index) => ({
      datasetId,
      caseId: `${datasetId}-fixture`,
      runId: `${label}-${datasetId}`,
      sourceCommit: CANDIDATE_COMMIT,
      applicationBuildHash: `sha256:${'a'.repeat(64)}`,
      recipeHash: recipeHashes[datasetId],
      sourceFingerprint: sourceFingerprint(datasetId),
      sourceContentHash: `sha256-${String(index + 4).repeat(64)}`,
      policyHash: `sha256:${String(index + 1).repeat(64)}`,
      negativeProbeReportHash: `sha256:${String(index + 4).repeat(64)}`,
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
        { name: 'application', access: 'read-only', canonicalPath: `/fixture/${label}/${datasetId}/application` },
        { name: 'dataset', access: 'read-only', canonicalPath: `/fixture/${label}/${datasetId}/dataset` },
        { name: 'candidate-output', access: 'write-only', canonicalPath: `/fixture/${label}/${datasetId}/output` },
      ],
      browserProfile: {
        canonicalPath: `/fixture/${label}/${datasetId}/browser`,
        fresh: true,
        emptyBefore: true,
        destroyedAfter: true,
      },
      runtimeScratch: {
        canonicalPath: `/fixture/${label}/${datasetId}/runtime`,
        fresh: true,
        emptyBefore: true,
        destroyedAfter: true,
      },
    })),
    passed: true,
  }
  return { ...payload, reportHash: sha256Canonical(payload) }
}

function contentManifest(name, bytes, digestLabel) {
  return {
    kind: 'egolens-canonical-content-manifest',
    schemaVersion: 1,
    files: [{ path: name, bytes, sha256: sha256Colon(digestLabel) }],
    fileCount: 1,
    totalBytes: bytes,
  }
}

function authoredSourceStageManifest() {
  const trustedFiles = new Map(currentTrustedToolManifest().files
    .map((entry) => [entry.path, entry]))
  const generatedConfig = countedAuthorTypecheckConfigText()
  const files = [
    ...REVIEWED_AUTHOR_SOURCE_PATHS.map((path) => structuredClone(trustedFiles.get(path))),
    {
      path: 'tsconfig.counted-author.json',
      bytes: Buffer.byteLength(generatedConfig),
      sha256: sha256Colon(generatedConfig),
    },
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    kind: 'egolens-canonical-content-manifest',
    schemaVersion: 1,
    files,
    fileCount: files.length,
    totalBytes: files.reduce((total, entry) => total + entry.bytes, 0),
  }
}

function authoredSourceGraph(stageManifest) {
  const modules = stageManifest.files.filter((entry) => [
    'amnesia.html', 'src/AmnesiaAuthorApp.tsx', 'src/amnesia-main.tsx',
  ].includes(entry.path))
  const payload = {
    kind: 'egolens-counted-author-source-graph',
    schemaVersion: 1,
    sourceCommit: CANDIDATE_COMMIT,
    modules,
    moduleCount: modules.length,
    totalBytes: modules.reduce((total, entry) => total + entry.bytes, 0),
    stageContentHash: sha256Colon(stageManifest),
  }
  return { ...payload, graphHash: sha256Colon(payload) }
}

function countedRuntimeManifest() {
  const payload = {
    kind: 'egolens-counted-author-runtime-manifest',
    schemaVersion: 1,
    node: { version: 'v24.19.0', executableHash: sha256Colon('fixture-node') },
    playwright: {
      version: '1.62.1',
      coreVersion: '1.62.1',
      entryHash: sha256Colon('fixture-playwright'),
      corePackageHash: sha256Colon('fixture-playwright-core'),
    },
    chrome: {
      version: 'Google Chrome 152.0.7977.66',
      executableHash: sha256Colon('fixture-chrome'),
    },
    codex: {
      version: 'codex-cli 0.150.0-alpha.12.2',
      executableHash: sha256Colon('fixture-codex'),
    },
  }
  return { ...payload, manifestHash: sha256Colon(payload) }
}

function countedBuildDependencyManifest() {
  const versions = {
    '@esbuild/darwin-arm64': '0.27.3',
    '@rollup/rollup-darwin-arm64': '4.59.0',
    '@vitejs/plugin-react': '5.1.4',
    esbuild: '0.27.3',
    rollup: '4.59.0',
    typescript: '5.9.3',
    vite: '7.3.1',
  }
  const payload = {
    kind: 'egolens-counted-author-build-dependency-manifest',
    schemaVersion: 1,
    packages: Object.entries(versions)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, version]) => ({
        name,
        version,
        contentHash: sha256Colon(`fixture-package-${name}`),
        fileCount: 1,
        totalBytes: 1,
      })),
  }
  return { ...payload, manifestHash: sha256Colon(payload) }
}

async function countedBoundaryFixtures(label, recipeHashes) {
  const applicationContentManifest = contentManifest('amnesia.html', 17, 'fixture-author-build')
  const applicationBuildHash = sha256Colon(applicationContentManifest)
  const nodeRuntimeRoot = '/Users/fixture/.cache/codex-runtimes/codex-primary-runtime/dependencies/node'
  const stageManifest = authoredSourceStageManifest()
  const sourceGraph = authoredSourceGraph(stageManifest)
  const runtimeManifest = countedRuntimeManifest()
  const dependencyManifest = countedBuildDependencyManifest()
  const artifacts = new Map()
  for (const [index, datasetId] of DATASETS.entries()) {
    const runRoot = `/private/tmp/egolens-phase9-counted-${label}-${datasetId}`
    const applicationRoot = `${runRoot}/installed-author-build/dist-amnesia-author`
    const datasetRoot = `${runRoot}/dataset`
    const outputRoot = `${runRoot}/output`
    const browserProfile = `${runRoot}/browser-profile`
    const runtimeScratch = `${runRoot}/runtime-scratch`
    const controlRoot = `${runRoot}/controller`
    const controllerHome = `${runRoot}/controller-home`
    const controllerTemporary = `${runRoot}/controller-tmp`
    const captureConfigFile = `/private/tmp/egolens-phase9-fixture-capture-${label}-${datasetId}.json`
    const evidenceRoot = `/private/tmp/egolens-phase9-fixture-evidence-${label}-${datasetId}`
    const sourceStageRoot = `${runRoot}/author-source-stage`
    const buildHome = `${runRoot}/build-home`
    const nodeModulesRoot = `${runRoot}/detached-source/node_modules`
    const buildOutputRoot = `${sourceStageRoot}/dist-amnesia-author`
    const sourceContentManifest = contentManifest(
      `${datasetId}.bin`,
      index + 1,
      `fixture-source-${label}-${datasetId}`,
    )
    const { descriptor: policyDescriptor, policyHash } = await effectivePolicyDescriptor({
      brokerProfilePath: join(process.cwd(), 'scripts/phase9-counted-author-broker.sb'),
      brokerParameters: {
        NODE_RUNTIME_ROOT: nodeRuntimeRoot,
        PLAYWRIGHT_ROOT: `${nodeRuntimeRoot}/node_modules/playwright`,
        PLAYWRIGHT_CORE_ROOT: `${nodeRuntimeRoot}/node_modules/playwright-core`,
        CHROME_ROOT: '/Applications/Google Chrome.app',
        BROKER_FILE: join(process.cwd(), 'scripts/phase9-counted-author-broker.mjs'),
        PROBE_FILE: join(process.cwd(), 'scripts/phase9-counted-boundary-probe.mjs'),
        APPLICATION_ROOT: applicationRoot,
        APPLICATION_REAL_ROOT: applicationRoot,
        DATASET_ROOT: datasetRoot,
        DATASET_REAL_ROOT: datasetRoot,
        BROWSER_PROFILE: browserProfile,
        BROWSER_PROFILE_REAL: browserProfile,
        RUNTIME_SCRATCH: runtimeScratch,
        RUNTIME_SCRATCH_REAL: runtimeScratch,
        SYSTEM_SOCKET_ROOT: '/var/folders/zz/egolens/T',
        SYSTEM_SOCKET_REAL_ROOT: '/private/var/folders/zz/egolens/T',
        OUTPUT_ROOT: outputRoot,
        OUTPUT_REAL_ROOT: outputRoot,
        LOOPBACK_BIND_ENDPOINT: 'localhost:12345',
        LOOPBACK_REMOTE_ENDPOINT: 'localhost:12345',
      },
      controllerProfilePath: join(process.cwd(), 'scripts/phase9-counted-author-controller.sb'),
      controllerParameters: {
        CODEX_RUNTIME_ROOT: '/Applications/ChatGPT.app',
        CONTROL_ROOT: controlRoot,
        CONTROL_REAL_ROOT: controlRoot,
        CODEX_BINARY: '/Applications/ChatGPT.app/Contents/Resources/codex',
        CODEX_HOME_ROOT: `${controllerHome}/.codex`,
        OPENAI_SUPPORT_ROOT: `${controllerHome}/Library/Application Support/OpenAI`,
        CODEX_SUPPORT_ROOT: `${controllerHome}/Library/Application Support/Codex`,
        SYSTEM_TMP: controllerTemporary,
        BROKER_REMOTE_ENDPOINT: 'localhost:12345',
      },
      buildProfilePath: join(process.cwd(), 'scripts/phase9-counted-author-build.sb'),
      buildParameters: {
        BUILD_HOME: buildHome,
        BUILD_HOME_REAL: buildHome,
        NODE_MODULES_REAL_ROOT: nodeModulesRoot,
        NODE_MODULES_ROOT: nodeModulesRoot,
        NODE_RUNTIME_ROOT: nodeRuntimeRoot,
        OUTPUT_REAL_ROOT: buildOutputRoot,
        OUTPUT_ROOT: buildOutputRoot,
        SOURCE_STAGE_REAL_ROOT: sourceStageRoot,
        SOURCE_STAGE_ROOT: sourceStageRoot,
      },
      authorSourceGraph: sourceGraph,
      authorSourceStageManifest: stageManifest,
      runtimeManifest,
      buildDependencyManifest: dependencyManifest,
      applicationBuild: {
        sourceCommit: CANDIDATE_COMMIT,
        applicationBuildHash,
        fileCount: applicationContentManifest.fileCount,
        totalBytes: applicationContentManifest.totalBytes,
      },
      sourceManifest: {
        sourceFingerprint: sourceFingerprint(datasetId),
        sourceContentHash: sha256Canonical(sourceContentManifest),
        captureConfigHash: sha256Colon({ datasetId, label }),
        fileCount: sourceContentManifest.fileCount,
        totalBytes: sourceContentManifest.totalBytes,
      },
      protectedRoots: { captureConfigFile, evidenceRoot },
      controllerState: {
        authMaterial: 'auth-json-only',
        destroyedAfter: true,
        freshBefore: true,
      },
    })
    const runId = `${label}-${datasetId}`
    const probeReport = createProbeReport({
      candidateCommit: CANDIDATE_COMMIT,
      datasetId,
      caseId: `${datasetId}-fixture`,
      runId,
      policyHash,
      checks: REQUIRED_PROBE_CHECKS.map((id) => ({ id, passed: true, observation: 'fixture-pass' })),
    })
    const boundaryCase = makeBoundaryCase({
      datasetId,
      caseId: `${datasetId}-fixture`,
      runId,
      sourceCommit: CANDIDATE_COMMIT,
      applicationBuildHash,
      recipeHash: recipeHashes[datasetId],
      sourceFingerprint: sourceFingerprint(datasetId),
      sourceContentHash: sha256Canonical(sourceContentManifest),
      policyHash,
      negativeProbeReportHash: probeReport.probeHash,
      applicationRoot,
      datasetRoot,
      outputRoot,
      browserProfile,
      runtimeScratch,
    })
    const sourceManifestArtifact = createSourceManifestArtifact({
      datasetId,
      caseId: `${datasetId}-fixture`,
      sourceFingerprint: sourceFingerprint(datasetId),
      captureConfigHash: sha256Colon({ datasetId, label }),
      sourceContentManifest,
    })
    artifacts.set(datasetId, createBoundaryCaseArtifact({
      candidateCommit: CANDIDATE_COMMIT,
      boundaryCase,
      policyDescriptor,
      probeReport,
      brokerAuditHash: sha256Colon({ datasetId, exported: true }),
      applicationContentManifest,
      sourceManifestArtifact,
    }))
  }
  return {
    artifacts,
    report: assembleBoundaryReport({
      candidateCommit: CANDIDATE_COMMIT,
      caseArtifacts: [...artifacts.values()],
    }),
  }
}

async function createAttestation(directory, label, authoringRun) {
  const recipes = new Map()
  for (const datasetId of DATASETS) {
    const value = recipe(datasetId, authoringRun)
    const recipePath = join(directory, `${label}.${datasetId}.recipe.json`)
    writeJson(recipePath, value)
    recipes.set(datasetId, { recipePath, recipeHash: recipeSemanticHash(value) })
  }
  const counted = await countedBoundaryFixtures(
    label,
    Object.fromEntries([...recipes].map(([datasetId, value]) => [datasetId, value.recipeHash])),
  )
  const boundaryReportPath = join(directory, `${label}.boundary-report.json`)
  writeJson(boundaryReportPath, counted.report)
  const boundaryCasePaths = new Map()
  for (const [datasetId, artifact] of counted.artifacts) {
    const artifactPath = join(directory, `${label}.${datasetId}.boundary-case.json`)
    writeJson(artifactPath, artifact)
    boundaryCasePaths.set(datasetId, artifactPath)
  }
  const attestationPath = join(directory, `${label}.attestation.json`)
  const create = runNode('scripts/phase9-create-amnesia-attestation.mjs', [
    '--candidate-commit', CANDIDATE_COMMIT,
    '--boundary-report', boundaryReportPath,
    ...[...recipes].flatMap(([datasetId, value]) => [`--${datasetId}-recipe`, value.recipePath]),
    '--output', attestationPath,
  ])
  assert.equal(create.status, 0, create.stderr)
  const attestation = JSON.parse(readFileSync(attestationPath, 'utf8'))
  assert.equal(verifyAmnesiaAttestation(attestation, CANDIDATE_COMMIT), true)
  return { attestation, attestationPath, boundaryReportPath, boundaryCasePaths, recipes }
}

function resignReceipt(receipt, changes, privateKey) {
  const {
    signingKeyId: _signingKeyId,
    signatureAlgorithm: _signatureAlgorithm,
    signature: _signature,
    receiptHash: _receiptHash,
    ...payload
  } = receipt
  const changed = { ...payload, ...changes }
  return signReceipt({ ...changed, receiptHash: sha256Canonical(changed) }, privateKey, 'test-key')
}

test('attests the exact public-only Adapter Amnesia boundary', () => {
  const boundary = boundaryReport('direct-boundary')
  const boundaryWitness = amnesiaBoundaryWitness(boundary)
  const candidates = DATASETS.map((datasetId) => ({
    datasetId,
    caseId: `${datasetId}-fixture`,
    authoredBy: 'codex',
    recipeHash: recipeSemanticHash(recipe(datasetId)),
  }))
  const payload = {
    kind: 'egolens-adapter-amnesia-attestation', schemaVersion: 2,
    candidateCommit: CANDIDATE_COMMIT,
    authoringRuntimeId: 'egolens-adapter-amnesia-author-v1',
    publicContract: { recipeSchemaVersion: 1, recipeEngineVersion: '1.0.0', normalizedSceneVersion: 1 },
    publicTools: [...AMNESIA_PUBLIC_TOOLS], deniedResources: [...AMNESIA_DENIED_RESOURCES],
    externalToolNetworkEgress: false, interactiveJudgeAccess: false,
    boundaryReportHash: boundary.reportHash,
    boundaryWitness,
    mounts: [
      { name: 'application', access: 'read-only', contents: 'amnesia-author-browser-build' },
      { name: 'dataset', access: 'read-only', contents: 'held-out-source-case' },
      { name: 'candidate-output', access: 'write-only', contents: 'one-exported-recipe' },
    ], candidates,
  }
  const attestation = { ...payload, attestationHash: sha256Canonical(payload) }
  assert.equal(verifyAmnesiaAttestation(attestation, CANDIDATE_COMMIT), true)
  assert.equal(verifyAmnesiaAttestation({ ...attestation, interactiveJudgeAccess: true }, CANDIDATE_COMMIT), false)
  assert.equal(verifyAmnesiaAttestation(attestation, 'f'.repeat(40)), false)
})

test('Phase 9 fixes reviewed coverage while binding recipe hashes to author attestation', () => {
  const phase6 = JSON.parse(readFileSync('benchmarks/oracle/phase6-requirements.json', 'utf8'))
  const phase9 = JSON.parse(readFileSync('benchmarks/oracle/phase9-requirements.json', 'utf8'))
  const phase6ByDataset = new Map(phase6.targets.map((target) => [target.datasetId, target]))
  assert.equal(phase9.schemaVersion, 2)
  assert.equal(phase9.recipeBinding, 'author-attestation')
  for (const target of phase9.targets) {
    assert.equal(Object.hasOwn(target, 'recipeHash'), false)
    assert.deepEqual(target.coverage, phase6ByDataset.get(target.datasetId).coverage)
  }
})

test('Phase 9 workflow uploads only public receipts after destroying protected boundary evidence', () => {
  const workflow = readFileSync('.github/workflows/phase9-adapter-amnesia.yml', 'utf8')
  const publicScan = workflow.indexOf('for public_file in "${evidence_dir}"/receipt-staging/*.json')
  const promote = workflow.indexOf('mv "${evidence_dir}/receipt-staging" "${evidence_dir}/receipts"')
  const cleanup = workflow.indexOf('- name: Destroy hidden inputs and trusted reports')
  const upload = workflow.indexOf('- name: Retain public signed evidence only')
  assert.ok(publicScan >= 0 && promote > publicScan && cleanup > promote && upload > cleanup)
  assert.match(workflow, /\.schemaVersion == 3/u)
  assert.match(workflow, /\.boundaryCaseArtifacts/u)
  assert.match(workflow, /--boundary-case "\$\{evidence_dir\}\/\$\{dataset\}\.boundary-case\.json"/u)
  assert.match(workflow, /rm -f "\$\{evidence_dir\}\/boundary-report\.json"/u)
  assert.match(workflow, /"\$\{evidence_dir\}\/\$\{dataset\}\.boundary-case\.json"/u)
  assert.match(workflow, /rm -rf "\$\{evidence_dir\}\/trusted-reports" "\$\{evidence_dir\}\/receipt-staging"/u)
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/phase9-amnesia-evidence\/receipts/u)
  assert.match(workflow, /JUDGE_VERSION: spec013-phase9-v1/u)
  assert.equal(PHASE9_EXPECTED_JUDGE_VERSION, 'spec013-phase9-v1')
  const judgePinFlags = workflow.match(/--expected-judge-tool-commit "\$\{JUDGE_TOOL_COMMIT\}"/gu) ?? []
  assert.equal(judgePinFlags.length, 2, 'judge and gate must both receive the pinned judge tool commit')
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\{JUDGE_TOOL_COMMIT\}"/u)
  for (const protectedKey of [
    'sourceFingerprint',
    'sourceContentHash',
    'policyHash',
    'negativeProbeReportHash',
    'canonicalPath',
  ]) assert.match(workflow, new RegExp(`has\\("${protectedKey}"\\)`, 'u'))
  assert.doesNotMatch(workflow, /cp .*boundary-(?:report|case)/u)
})

test('accepts fresh authored hashes and rejects attestation, hash, runtime, artifact, coverage, and judge checkout swaps', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'egolens-amnesia-gate-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const tool = judgeToolCheckout(context)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' })
  const privatePath = join(directory, 'private.pem')
  const publicPath = join(directory, 'public.pem')
  writeFileSync(privatePath, privatePem)
  writeFileSync(publicPath, publicPem)

  const authored = await createAttestation(directory, 'fresh', 'arbitrary-unreviewed-semantics')
  const receiptPaths = []
  const receipts = new Map()
  const targets = []
  const evidence = new Map()
  for (const datasetId of DATASETS) {
    const recipeHash = authored.recipes.get(datasetId).recipeHash
    const candidate = artifact(datasetId, recipeHash)
    const oracle = bundle(artifact(datasetId, recipeHash, PRODUCER_COMMIT))
    const oraclePath = join(directory, `${datasetId}.oracle.json`)
    const candidatePath = join(directory, `${datasetId}.candidate.json`)
    const receiptPath = join(directory, `${datasetId}.receipt.json`)
    const reportPath = join(directory, `${datasetId}.trusted.json`)
    writeJson(oraclePath, oracle)
    writeJson(candidatePath, candidate)
    evidence.set(datasetId, { oraclePath, candidatePath })
    targets.push({ ...candidate.target, coverage: candidate.coverage })
    const judgeArguments = ({ judgeVersion = PHASE9_EXPECTED_JUDGE_VERSION, expectedJudgeToolCommit = tool.commit, suffix = '' } = {}) => [
      '--oracle', oraclePath, '--candidate', candidatePath,
      '--attestation', authored.attestationPath,
      '--boundary-report', authored.boundaryReportPath,
      '--boundary-case', authored.boundaryCasePaths.get(datasetId),
      '--private-key', privatePath, '--key-id', 'test-key', '--judge-version', judgeVersion,
      '--expected-candidate-commit', CANDIDATE_COMMIT,
      '--expected-judge-tool-commit', expectedJudgeToolCommit,
      '--output', `${receiptPath}${suffix}`, '--trusted-report', `${reportPath}${suffix}`,
    ]
    if (datasetId === 'waymo') {
      // Forged version, mismatched workflow pin, and dirty judge checkout each
      // fail before any receipt is written.
      const forgedVersion = runNode(tool.judge, judgeArguments({ judgeVersion: 'phase9-test-v1', suffix: '.forged-version' }))
      assert.notEqual(forgedVersion.status, 0)
      assert.match(forgedVersion.stderr, /judge version must be exactly spec013-phase9-v1/u)
      const mismatchedPin = runNode(tool.judge, judgeArguments({ expectedJudgeToolCommit: 'f'.repeat(40), suffix: '.mismatched-pin' }))
      assert.notEqual(mismatchedPin.status, 0)
      assert.match(mismatchedPin.stderr, /does not match the pinned PHASE9_AMNESIA_JUDGE_TOOL_COMMIT/u)
      const untracked = join(tool.root, 'scripts/lib/untracked-edit.mjs')
      writeFileSync(untracked, 'export const tampered = true\n')
      const dirty = runNode(tool.judge, judgeArguments({ suffix: '.dirty' }))
      rmSync(untracked)
      assert.notEqual(dirty.status, 0)
      assert.match(dirty.stderr, /clean exact reviewed checkout/u)
      const fromDirtyTree = runNode('scripts/phase9-oracle-judge.mjs', judgeArguments({
        expectedJudgeToolCommit: tool.commit, suffix: '.dirty-tree',
      }))
      assert.notEqual(fromDirtyTree.status, 0)
    }
    const judge = runNode(tool.judge, judgeArguments())
    assert.equal(judge.status, 0, judge.stderr)
    receiptPaths.push(receiptPath)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const boundaryCaseArtifact = JSON.parse(readFileSync(authored.boundaryCasePaths.get(datasetId), 'utf8'))
    assert.equal(receipt.amnesiaBoundaryCaseArtifactHash, boundaryCaseArtifact.artifactHash)
    assert.equal(receipt.judgeToolCommit, tool.commit)
    assert.equal(receipt.judgeVersion, PHASE9_EXPECTED_JUDGE_VERSION)
    const trustedReport = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(trustedReport.judgeToolCommit, tool.commit)
    assert.equal(trustedReport.judgeVersion, PHASE9_EXPECTED_JUDGE_VERSION)
    assert.equal(JSON.parse(judge.stdout).judgeToolCommit, tool.commit)
    receipts.set(datasetId, receipt)
  }

  const requirements = {
    kind: 'egolens-adapter-amnesia-gate-requirements',
    schemaVersion: 2,
    recipeBinding: 'author-attestation',
    targets,
  }
  const requirementsPath = join(directory, 'requirements.json')
  writeJson(requirementsPath, requirements)

  const runGate = ({
    paths = receiptPaths,
    requirementsFile = requirementsPath,
    attestationFile = authored.attestationPath,
    expectedJudgeToolCommit = tool.commit,
    gateScript = tool.gate,
  } = {}) => runNode(gateScript, [
    ...paths.flatMap((receiptPath) => ['--receipt', receiptPath]),
    '--requirements', requirementsFile, '--attestation', attestationFile,
    '--public-key', publicPath, '--key-id', 'test-key',
    '--expected-generator-commit', PRODUCER_COMMIT,
    '--expected-candidate-commit', CANDIDATE_COMMIT,
    '--expected-judge-tool-commit', expectedJudgeToolCommit,
  ])
  const runStage = ({
    datasetEvidence = evidence,
    boundaryCases = authored.boundaryCasePaths,
    requirementsFile = requirementsPath,
    attestationFile = authored.attestationPath,
  } = {}) => runNode('scripts/phase9-stage-amnesia-evidence.mjs', [
    '--environment', 'fixture', '--requirements', requirementsFile, '--attestation', attestationFile,
    '--boundary-report', authored.boundaryReportPath,
    '--expected-producer-commit', PRODUCER_COMMIT, '--expected-candidate-commit', CANDIDATE_COMMIT,
    ...[...datasetEvidence].flatMap(([datasetId, value]) => [
      `--${datasetId}-boundary-case`, boundaryCases.get(datasetId),
      `--${datasetId}-oracle`, value.oraclePath, `--${datasetId}-candidate`, value.candidatePath,
    ]), '--dry-run',
  ])

  const gate = runGate()
  assert.equal(gate.status, 0, gate.stderr)
  const gateReport = JSON.parse(gate.stdout)
  assert.equal(gateReport.passed, true)
  assert.equal(gateReport.judgeToolCommit, tool.commit)
  assert.equal(gateReport.judgeVersion, PHASE9_EXPECTED_JUDGE_VERSION)
  assert.equal(gateReport.checks.every((entry) => /^sha256-[0-9a-f]{64}$/u.test(entry.boundaryCaseArtifactHash)), true)
  // The gate itself must run from the pinned clean checkout, and it rejects a
  // validly signed receipt that another judge commit produced.
  assert.notEqual(runGate({ expectedJudgeToolCommit: 'f'.repeat(40) }).status, 0)
  assert.notEqual(runGate({ gateScript: 'scripts/phase9-oracle-receipt-gate.mjs' }).status, 0)
  const foreignJudgePath = join(directory, 'waymo.foreign-judge.receipt.json')
  writeJson(foreignJudgePath, resignReceipt(receipts.get('waymo'), { judgeToolCommit: 'e'.repeat(40) }, privatePem))
  const foreignJudge = runGate({ paths: [foreignJudgePath, ...receiptPaths.slice(1)] })
  assert.notEqual(foreignJudge.status, 0)
  assert.equal(JSON.parse(foreignJudge.stdout).checks.find((entry) => entry.datasetId === 'waymo').passed, false)
  const forgedVersionPath = join(directory, 'waymo.forged-version.receipt.json')
  writeJson(forgedVersionPath, resignReceipt(receipts.get('waymo'), { judgeVersion: 'phase9-test-v1' }, privatePem))
  assert.notEqual(runGate({ paths: [forgedVersionPath, ...receiptPaths.slice(1)] }).status, 0)
  const stage = runStage()
  assert.equal(stage.status, 0, stage.stderr)
  assert.equal(JSON.parse(stage.stdout).staged, false)

  const alternate = await createAttestation(directory, 'alternate', 'different-authoring-session')
  assert.notEqual(alternate.attestation.attestationHash, authored.attestation.attestationHash)
  assert.notEqual(runGate({ attestationFile: alternate.attestationPath }).status, 0)
  assert.notEqual(runStage({ attestationFile: alternate.attestationPath }).status, 0)

  const artifactSwap = runNode(tool.judge, [
    '--oracle', evidence.get('waymo').oraclePath,
    '--candidate', evidence.get('waymo').candidatePath,
    '--attestation', authored.attestationPath,
    '--boundary-report', authored.boundaryReportPath,
    '--boundary-case', authored.boundaryCasePaths.get('nuscenes'),
    '--private-key', privatePath, '--key-id', 'test-key', '--judge-version', PHASE9_EXPECTED_JUDGE_VERSION,
    '--expected-candidate-commit', CANDIDATE_COMMIT,
    '--expected-judge-tool-commit', tool.commit,
    '--output', join(directory, 'artifact-swap.receipt.json'),
    '--trusted-report', join(directory, 'artifact-swap.trusted.json'),
  ])
  assert.notEqual(artifactSwap.status, 0)
  const swappedBoundaryCases = new Map(authored.boundaryCasePaths)
  swappedBoundaryCases.set('waymo', authored.boundaryCasePaths.get('nuscenes'))
  assert.notEqual(runStage({ boundaryCases: swappedBoundaryCases }).status, 0)

  const waymoReceipt = receipts.get('waymo')
  const hashSwapPath = join(directory, 'waymo.hash-swap.receipt.json')
  writeJson(hashSwapPath, resignReceipt(waymoReceipt, {
    candidateRecipeHash: authored.recipes.get('nuscenes').recipeHash,
  }, privatePem))
  assert.notEqual(runGate({ paths: [hashSwapPath, ...receiptPaths.slice(1)] }).status, 0)

  const runtimeSwapPath = join(directory, 'waymo.runtime-swap.receipt.json')
  const swappedRuntimeId = `egolens-amnesia-${CANDIDATE_COMMIT}-${authored.recipes.get('nuscenes').recipeHash}`
  writeJson(runtimeSwapPath, resignReceipt(waymoReceipt, { candidateRuntimeId: swappedRuntimeId }, privatePem))
  assert.notEqual(runGate({ paths: [runtimeSwapPath, ...receiptPaths.slice(1)] }).status, 0)
  const runtimeSwapCandidatePath = join(directory, 'waymo.runtime-swap.candidate.json')
  writeJson(runtimeSwapCandidatePath, artifact('waymo', authored.recipes.get('nuscenes').recipeHash))
  const runtimeSwapEvidence = new Map(evidence)
  runtimeSwapEvidence.set('waymo', { ...evidence.get('waymo'), candidatePath: runtimeSwapCandidatePath })
  assert.notEqual(runStage({ datasetEvidence: runtimeSwapEvidence }).status, 0)

  const coverageMismatch = structuredClone(requirements)
  coverageMismatch.targets[0].coverage.frameIndices = [999]
  const coverageMismatchPath = join(directory, 'requirements.coverage-mismatch.json')
  writeJson(coverageMismatchPath, coverageMismatch)
  assert.notEqual(runGate({ requirementsFile: coverageMismatchPath }).status, 0)
  assert.notEqual(runStage({ requirementsFile: coverageMismatchPath }).status, 0)

  const stale = runNode(tool.gate, [
    ...receiptPaths.flatMap((receiptPath) => ['--receipt', receiptPath]),
    '--requirements', requirementsPath, '--attestation', authored.attestationPath,
    '--public-key', publicPath, '--key-id', 'test-key',
    '--expected-generator-commit', PRODUCER_COMMIT,
    '--expected-candidate-commit', 'f'.repeat(40),
    '--expected-judge-tool-commit', tool.commit,
  ])
  assert.notEqual(stale.status, 0)
})
