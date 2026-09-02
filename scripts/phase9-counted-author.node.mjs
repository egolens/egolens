import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  COUNTED_COORDINATOR_ID,
  REQUIRED_PROBE_CHECKS,
  REVIEWED_AUTHOR_SOURCE_PATHS,
  assembleBoundaryReport,
  controllerExecArguments,
  createBoundaryCaseArtifact,
  createProbeReport,
  createSourceManifestArtifact,
  countedAuthorTypecheckConfigText,
  currentTrustedToolManifest,
  makeBoundaryCase,
  sha256Colon,
  verifyBoundaryCaseArtifact,
  verifyPolicyDescriptor,
  verifySourceManifestArtifact,
} from './lib/phase9-counted-author-boundary.mjs'
import { sha256Canonical } from './lib/oracle-receipts.mjs'
import {
  COUNTED_PUBLIC_TOOLS,
  createBrokerHttpServer,
  writeCandidateExport,
} from './phase9-counted-author-broker.mjs'
import {
  COUNTED_TARGETS,
  buildAuthorPrompt,
  runProcess,
  parseOptions,
  sandboxArguments,
} from './phase9-counted-author-coordinator.mjs'

const COMMIT = 'a'.repeat(40)
const hash = (label) => sha256Colon(label)
const canonicalHash = (label) => sha256Canonical({ label })

function contentManifest(files) {
  const entries = Object.entries(files).map(([filePath, contents]) => ({
    path: filePath,
    bytes: Buffer.byteLength(contents),
    sha256: hash(contents),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    kind: 'egolens-canonical-content-manifest',
    schemaVersion: 1,
    files: entries,
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  }
}

function runtimeManifest() {
  const payload = {
    kind: 'egolens-counted-author-runtime-manifest',
    schemaVersion: 1,
    node: { version: 'v24.19.0', executableHash: hash('node') },
    playwright: {
      version: '1.62.1',
      coreVersion: '1.62.1',
      entryHash: hash('playwright'),
      corePackageHash: hash('playwright-core'),
    },
    chrome: { version: 'Google Chrome 152.0.7977.66', executableHash: hash('chrome') },
    codex: { version: 'codex-cli 0.150.0-alpha.12.2', executableHash: hash('codex') },
  }
  return { ...payload, manifestHash: sha256Colon(payload) }
}

function dependencyManifest() {
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
    packages: Object.entries(versions).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, version]) => ({ name, version, contentHash: hash(name), fileCount: 1, totalBytes: 1 })),
  }
  return { ...payload, manifestHash: sha256Colon(payload) }
}

function fixture(datasetId = 'waymo', suffix = datasetId) {
  const runRoot = `/private/tmp/egolens-phase9-counted-${suffix}`
  const applicationManifest = contentManifest({ 'amnesia.html': 'a' })
  const sourceManifest = contentManifest({ 'source.bin': `source-${suffix}` })
  const tools = currentTrustedToolManifest()
  const trustedFiles = new Map(tools.files.map((entry) => [entry.path, entry]))
  const generatedConfig = countedAuthorTypecheckConfigText()
  const stageFiles = [
    ...REVIEWED_AUTHOR_SOURCE_PATHS.map((filePath) => structuredClone(trustedFiles.get(filePath))),
    {
      path: 'tsconfig.counted-author.json',
      bytes: Buffer.byteLength(generatedConfig),
      sha256: hash(generatedConfig),
    },
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const authorSourceStageManifest = {
    kind: 'egolens-canonical-content-manifest',
    schemaVersion: 1,
    files: stageFiles,
    fileCount: stageFiles.length,
    totalBytes: stageFiles.reduce((total, entry) => total + entry.bytes, 0),
  }
  const graphModules = authorSourceStageManifest.files.filter((entry) => [
    'amnesia.html', 'src/AmnesiaAuthorApp.tsx', 'src/amnesia-main.tsx',
  ].includes(entry.path))
  const graphPayload = {
    kind: 'egolens-counted-author-source-graph',
    schemaVersion: 1,
    sourceCommit: COMMIT,
    modules: graphModules,
    moduleCount: graphModules.length,
    totalBytes: graphModules.reduce((total, entry) => total + entry.bytes, 0),
    stageContentHash: sha256Colon(authorSourceStageManifest),
  }
  const authorSourceGraph = { ...graphPayload, graphHash: sha256Colon(graphPayload) }
  const toolHash = (name) => tools.files.find((entry) => entry.path === name).sha256
  const brokerParameters = {
    APPLICATION_REAL_ROOT: `${runRoot}/installed-author-build/dist-amnesia-author`,
    APPLICATION_ROOT: `${runRoot}/installed-author-build/dist-amnesia-author`,
    BROKER_FILE: '/Users/fixture/repo/scripts/phase9-counted-author-broker.mjs',
    BROWSER_PROFILE: `${runRoot}/browser-profile`,
    BROWSER_PROFILE_REAL: `${runRoot}/browser-profile`,
    CHROME_ROOT: '/Applications/Google Chrome.app',
    DATASET_REAL_ROOT: `/private/tmp/egolens-phase9-dataset-${suffix}`,
    DATASET_ROOT: `/private/tmp/egolens-phase9-dataset-${suffix}`,
    LOOPBACK_BIND_ENDPOINT: 'localhost:45123',
    LOOPBACK_REMOTE_ENDPOINT: 'localhost:45123',
    NODE_RUNTIME_ROOT: '/Users/fixture/.cache/codex-runtimes/codex-primary-runtime/dependencies/node',
    OUTPUT_REAL_ROOT: `/private/tmp/egolens-phase9-output-${suffix}`,
    OUTPUT_ROOT: `/private/tmp/egolens-phase9-output-${suffix}`,
    PLAYWRIGHT_CORE_ROOT: '/Users/fixture/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core',
    PLAYWRIGHT_ROOT: '/Users/fixture/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
    PROBE_FILE: '/Users/fixture/repo/scripts/phase9-counted-boundary-probe.mjs',
    RUNTIME_SCRATCH: `${runRoot}/runtime-scratch`,
    RUNTIME_SCRATCH_REAL: `${runRoot}/runtime-scratch`,
    SYSTEM_SOCKET_REAL_ROOT: '/private/var/folders/ab/fixture/T',
    SYSTEM_SOCKET_ROOT: '/var/folders/ab/fixture/T',
  }
  const controllerParameters = {
    BROKER_REMOTE_ENDPOINT: 'localhost:45123',
    CODEX_BINARY: '/Applications/ChatGPT.app/Contents/Resources/codex',
    CODEX_HOME_ROOT: `${runRoot}/controller-home/.codex`,
    CODEX_RUNTIME_ROOT: '/Applications/ChatGPT.app',
    CODEX_SUPPORT_ROOT: `${runRoot}/controller-home/Library/Application Support/Codex`,
    CONTROL_REAL_ROOT: `${runRoot}/controller`,
    CONTROL_ROOT: `${runRoot}/controller`,
    OPENAI_SUPPORT_ROOT: `${runRoot}/controller-home/Library/Application Support/OpenAI`,
    SYSTEM_TMP: `${runRoot}/controller-tmp`,
  }
  const buildParameters = {
    BUILD_HOME: `${runRoot}/build-home`,
    BUILD_HOME_REAL: `${runRoot}/build-home`,
    NODE_MODULES_REAL_ROOT: `${runRoot}/detached-source/node_modules`,
    NODE_MODULES_ROOT: `${runRoot}/detached-source/node_modules`,
    NODE_RUNTIME_ROOT: brokerParameters.NODE_RUNTIME_ROOT,
    OUTPUT_REAL_ROOT: `${runRoot}/author-source-stage/dist-amnesia-author`,
    OUTPUT_ROOT: `${runRoot}/author-source-stage/dist-amnesia-author`,
    SOURCE_STAGE_REAL_ROOT: `${runRoot}/author-source-stage`,
    SOURCE_STAGE_ROOT: `${runRoot}/author-source-stage`,
  }
  const descriptor = {
    brokerSeatbeltTemplateHash: toolHash('scripts/phase9-counted-author-broker.sb'),
    brokerSeatbeltParameters: brokerParameters,
    controllerSeatbeltTemplateHash: toolHash('scripts/phase9-counted-author-controller.sb'),
    controllerSeatbeltParameters: controllerParameters,
    buildSeatbeltTemplateHash: toolHash('scripts/phase9-counted-author-build.sb'),
    buildSeatbeltParameters: buildParameters,
    applicationBuild: {
      sourceCommit: COMMIT,
      applicationBuildHash: sha256Colon(applicationManifest),
      fileCount: applicationManifest.fileCount,
      totalBytes: applicationManifest.totalBytes,
    },
    sourceManifest: {
      sourceFingerprint: canonicalHash(`identity-${suffix}`),
      sourceContentHash: sha256Canonical(sourceManifest),
      captureConfigHash: hash(`capture-${suffix}`),
      fileCount: sourceManifest.fileCount,
      totalBytes: sourceManifest.totalBytes,
    },
    authorSourceGraph,
    authorSourceStageManifest,
    runtimeManifest: runtimeManifest(),
    buildDependencyManifest: dependencyManifest(),
    protectedRoots: {
      captureConfigFile: `/private/tmp/egolens-phase9-config-${suffix}.json`,
      evidenceRoot: `/private/tmp/egolens-phase9-evidence-${suffix}`,
    },
    controllerState: { authMaterial: 'auth-json-only', destroyedAfter: true, freshBefore: true },
    trustedToolManifest: tools,
    coordinatorRuntimeId: COUNTED_COORDINATOR_ID,
  }
  const policyHash = sha256Colon(descriptor)
  const runId = `phase9-${datasetId}-${suffix}`
  const probeReport = createProbeReport({
    candidateCommit: COMMIT,
    datasetId,
    caseId: COUNTED_TARGETS[datasetId].caseId,
    runId,
    policyHash,
    checks: REQUIRED_PROBE_CHECKS.map((id) => ({ id, passed: true, observation: 'test-proof' })),
  })
  const boundaryCase = makeBoundaryCase({
    datasetId,
    caseId: COUNTED_TARGETS[datasetId].caseId,
    runId,
    sourceCommit: COMMIT,
    applicationBuildHash: descriptor.applicationBuild.applicationBuildHash,
    recipeHash: hash(`recipe-${datasetId}`),
    sourceFingerprint: descriptor.sourceManifest.sourceFingerprint,
    sourceContentHash: descriptor.sourceManifest.sourceContentHash,
    policyHash,
    negativeProbeReportHash: probeReport.probeHash,
    applicationRoot: brokerParameters.APPLICATION_ROOT,
    datasetRoot: brokerParameters.DATASET_ROOT,
    outputRoot: brokerParameters.OUTPUT_ROOT,
    browserProfile: brokerParameters.BROWSER_PROFILE,
    runtimeScratch: brokerParameters.RUNTIME_SCRATCH,
  })
  const sourceManifestArtifact = createSourceManifestArtifact({
    datasetId,
    caseId: boundaryCase.caseId,
    sourceFingerprint: boundaryCase.sourceFingerprint,
    captureConfigHash: descriptor.sourceManifest.captureConfigHash,
    sourceContentManifest: sourceManifest,
  })
  const artifact = createBoundaryCaseArtifact({
    candidateCommit: COMMIT,
    boundaryCase,
    policyDescriptor: descriptor,
    probeReport,
    brokerAuditHash: hash('audit'),
    applicationContentManifest: applicationManifest,
    sourceManifestArtifact,
  })
  return { artifact, descriptor, sourceManifestArtifact }
}

test('creates a compact, source-bound boundary case artifact', () => {
  const { artifact, descriptor, sourceManifestArtifact } = fixture()
  assert.equal(verifyPolicyDescriptor(descriptor, artifact.boundaryCase), true)
  assert.equal(verifySourceManifestArtifact(sourceManifestArtifact), true)
  assert.equal(verifyBoundaryCaseArtifact(artifact, COMMIT), true)
  assert.equal('sourceContentManifest' in artifact, false)
  assert.equal('sourceManifestCommitment' in artifact, true)
  assert.equal(JSON.stringify(artifact).includes('source.bin'), false)
  assert.equal(artifact.sourceManifestCommitment.manifestArtifactHash, sourceManifestArtifact.artifactHash)
})

test('rejects broad, overlapping, and unreviewed policy roots', () => {
  const { descriptor } = fixture()
  const broad = structuredClone(descriptor)
  broad.brokerSeatbeltParameters.NODE_RUNTIME_ROOT = '/'
  assert.equal(verifyPolicyDescriptor(broad), false)
  const overlap = structuredClone(descriptor)
  overlap.protectedRoots.captureConfigFile = `${overlap.brokerSeatbeltParameters.DATASET_ROOT}/capture.json`
  assert.equal(verifyPolicyDescriptor(overlap), false)
  const toolTamper = structuredClone(descriptor)
  toolTamper.trustedToolManifest.files[0].sha256 = hash('tampered')
  assert.equal(verifyPolicyDescriptor(toolTamper), false)
})

test('assembles three path-disjoint cases with the same exact build provenance', () => {
  const artifacts = ['waymo', 'nuscenes', 'argoverse2'].map((dataset) => fixture(dataset, dataset).artifact)
  const report = assembleBoundaryReport({ candidateCommit: COMMIT, caseArtifacts: artifacts })
  assert.equal(report.passed, true)
  assert.equal(report.cases.length, 3)
  const nested = ['waymo', 'nuscenes', 'argoverse2'].map((dataset) => fixture(dataset, dataset).artifact)
  nested[1] = structuredClone(nested[1])
  nested[1].policyDescriptor.protectedRoots.evidenceRoot = nested[0].policyDescriptor.protectedRoots.evidenceRoot
  assert.throws(() => assembleBoundaryReport({ candidateCommit: COMMIT, caseArtifacts: nested }))
})

test('author prompt exposes public capabilities and no protected path or expected recipe hash', () => {
  const prompt = buildAuthorPrompt({
    datasetId: 'waymo',
    caseId: COUNTED_TARGETS.waymo.caseId,
    capabilities: COUNTED_TARGETS.waymo.requiredCapabilities,
    port: 45123,
    controllerToken: 'b'.repeat(64),
  })
  assert.match(prompt, /Public required capabilities:/u)
  assert.match(prompt, /General public knowledge/u)
  assert.doesNotMatch(prompt, /\/Users\/|\/private\/tmp\/|expected.*hash/iu)
  const args = controllerExecArguments({ controlRoot: '/private/tmp/control', prompt })
  for (const feature of ['memories', 'external_agent_memory_import', 'shell_snapshot', 'web_search_request']) {
    assert.equal(args.includes(feature), true)
  }
})

test('coordinator CLI rejects unknown, duplicate, misplaced, and unsafe timeout options', () => {
  assert.throws(() => parseOptions(['run-case', '--candidate-comit', COMMIT]), /Unknown/u)
  assert.throws(() => parseOptions(['run-case', '--case', '/tmp/case.json']), /Unknown/u)
  assert.throws(() => parseOptions([
    'assemble-report', '--candidate-commit', COMMIT, '--candidate-commit', COMMIT,
  ]), /Duplicate/u)
  for (const timeout of ['NaN', '1.5', '59999', '7200001', '9007199254740992']) {
    assert.throws(() => parseOptions(['run-case', '--timeout-ms', timeout]), /timeout-ms/u)
  }
  assert.equal(parseOptions(['run-case', '--timeout-ms', '60000']).options['timeout-ms'], '60000')
})

test('broker exposes exactly five authenticated public tools and a pathless export', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'phase9-broker-test-'))
  await writeFile(path.join(root, 'amnesia.html'), '<html></html>')
  let exported = false
  const adapter = {
    ready: true,
    get exported() { return exported },
    tools: async () => COUNTED_PUBLIC_TOOLS.map((name) => ({ name })),
    call: async (name, argumentsValue) => ({ ok: true, name, argumentsValue }),
    view: async () => ({ text: 'view' }),
    review: async () => {},
    export: async () => { exported = true; return { filename: 'candidate.json' } },
  }
  const server = createBrokerHttpServer({
    adapter,
    applicationRoot: root,
    controllerToken: 'controller',
    browserToken: 'browser',
    adminToken: 'admin',
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true })
  })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}/__phase9`
  const headers = { authorization: 'Bearer controller', 'content-type': 'application/json' }
  const tools = await fetch(`${base}/tools`, { headers }).then((response) => response.json())
  assert.deepEqual(tools.tools.map((entry) => entry.name), COUNTED_PUBLIC_TOOLS)
  const unknown = await fetch(`${base}/call`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'hidden_oracle', arguments: {} }),
  })
  assert.equal(unknown.status, 400)
  const pathful = await fetch(`${base}/export`, {
    method: 'POST', headers, body: JSON.stringify({ path: '/tmp/leak' }),
  })
  assert.equal(pathful.status, 400)
  const exportedResponse = await fetch(`${base}/export`, {
    method: 'POST', headers, body: '{}',
  })
  assert.equal(exportedResponse.status, 200)
})

test('macOS controller profile permits initial Codex only and denies child re-entry/auth reads', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const codex = '/Applications/ChatGPT.app/Contents/Resources/codex'
  const profile = path.resolve('scripts/phase9-counted-author-controller.sb')
  await Promise.all([access('/usr/bin/sandbox-exec'), access(codex), access(profile)])
  const root = await mkdtemp('/private/tmp/egolens-phase9-controller-test-')
  const control = path.join(root, 'control')
  const home = path.join(root, 'controller-home')
  const codexHome = path.join(home, '.codex')
  const openaiSupport = path.join(home, 'Library', 'Application Support', 'OpenAI')
  const codexSupport = path.join(home, 'Library', 'Application Support', 'Codex')
  const temporary = path.join(root, 'controller-tmp')
  for (const directory of [control, codexHome, openaiSupport, codexSupport, temporary]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  const auth = path.join(codexHome, 'auth.json')
  await writeFile(auth, '{}\n', { mode: 0o600 })
  t.after(async () => await rm(root, { recursive: true }))
  const parameters = {
    BROKER_REMOTE_ENDPOINT: 'localhost:45123',
    CODEX_BINARY: codex,
    CODEX_HOME_ROOT: codexHome,
    CODEX_RUNTIME_ROOT: '/Applications/ChatGPT.app',
    CODEX_SUPPORT_ROOT: codexSupport,
    CONTROL_REAL_ROOT: control,
    CONTROL_ROOT: control,
    OPENAI_SUPPORT_ROOT: openaiSupport,
    SYSTEM_TMP: temporary,
  }
  const environment = {
    HOME: home, CODEX_HOME: codexHome, TMPDIR: temporary, CFFIXED_USER_HOME: home,
    XDG_CACHE_HOME: temporary, XDG_CONFIG_HOME: temporary,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C',
  }
  const initial = await runProcess('/usr/bin/sandbox-exec', sandboxArguments(profile, parameters, [
    codex, '--version',
  ]), { cwd: control, env: environment, timeoutMs: 30_000 })
  assert.equal(initial.code, 0)
  const reentry = await runProcess('/usr/bin/sandbox-exec', sandboxArguments(profile, parameters, [
    '/bin/sh', '-c', 'exec "$1" --version', 'reentry', codex,
  ]), { cwd: control, env: environment, timeoutMs: 30_000 })
  assert.notEqual(reentry.code, 0)
  assert.match(`${reentry.stdout}\n${reentry.stderr}`, /Operation not permitted|Permission denied/u)
  const authRead = await runProcess('/usr/bin/sandbox-exec', sandboxArguments(profile, parameters, [
    '/bin/cat', auth,
  ]), { cwd: control, env: environment, timeoutMs: 30_000 })
  assert.notEqual(authRead.code, 0)
})

test('macOS build profile reads only staged source and denies protected source and network', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const profile = path.resolve('scripts/phase9-counted-author-build.sb')
  await access('/usr/bin/sandbox-exec')
  const root = await mkdtemp('/private/tmp/egolens-phase9-build-policy-test-')
  const source = path.join(root, 'author-source-stage')
  const nodeModules = path.join(root, 'detached-source', 'node_modules')
  const output = path.join(source, 'dist-amnesia-author')
  const buildHome = path.join(root, 'build-home')
  const forbidden = path.join(root, 'protected-candidate-source', 'recipe.json')
  for (const directory of [source, nodeModules, output, buildHome, path.dirname(forbidden)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  const allowed = path.join(source, 'amnesia.html')
  await writeFile(allowed, 'public author entry\n', { mode: 0o600 })
  await writeFile(forbidden, 'protected recipe\n', { mode: 0o600 })
  t.after(async () => await rm(root, { recursive: true }))
  const parameters = {
    NODE_RUNTIME_ROOT: '/usr',
    SOURCE_STAGE_ROOT: source,
    SOURCE_STAGE_REAL_ROOT: source,
    NODE_MODULES_ROOT: nodeModules,
    NODE_MODULES_REAL_ROOT: nodeModules,
    OUTPUT_ROOT: output,
    OUTPUT_REAL_ROOT: output,
    BUILD_HOME: buildHome,
    BUILD_HOME_REAL: buildHome,
  }
  const environment = {
    HOME: buildHome, TMPDIR: buildHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C', LC_ALL: 'C', NO_PROXY: '*', no_proxy: '*',
  }
  const readable = await runProcess('/usr/bin/sandbox-exec', sandboxArguments(profile, parameters, [
    '/bin/cat', allowed,
  ]), { cwd: source, env: environment, timeoutMs: 10_000 })
  assert.equal(readable.code, 0)
  const denied = await runProcess('/usr/bin/sandbox-exec', sandboxArguments(profile, parameters, [
    '/bin/cat', forbidden,
  ]), { cwd: source, env: environment, timeoutMs: 10_000 })
  assert.notEqual(denied.code, 0)
  assert.match(`${denied.stdout}\n${denied.stderr}`, /Operation not permitted|Permission denied/u)
  const network = await runProcess('/usr/bin/sandbox-exec', sandboxArguments(profile, parameters, [
    '/usr/bin/curl', '--connect-timeout', '1', '--max-time', '2', '-sS', '-o', '/dev/null', 'http://1.1.1.1/',
  ]), { cwd: source, env: environment, timeoutMs: 10_000 })
  assert.notEqual(network.code, 0)
})

test('candidate export is an exclusive write-only copy of the download', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'egolens-export-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const source = path.join(root, 'download.bin')
  const body = JSON.stringify({ recipe: 'x'.repeat(70_000) })
  await writeFile(source, body)
  const outputFile = path.join(root, 'waymo.egolens-adapter.json')
  const download = { failure: async () => null, path: async () => source }

  await writeCandidateExport(download, outputFile)
  assert.equal(await readFile(outputFile, 'utf8'), body)
  assert.equal((await stat(outputFile)).mode & 0o777, 0o600)

  await assert.rejects(writeCandidateExport(download, outputFile), { code: 'EEXIST' })
  await assert.rejects(
    writeCandidateExport({ failure: async () => 'canceled', path: async () => source }, path.join(root, 'other.json')),
    /download failed: canceled/,
  )
  await assert.rejects(access(path.join(root, 'other.json')), { code: 'ENOENT' })
})
