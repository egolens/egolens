import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AMNESIA_BOUNDARY_REPORT_KIND,
  AMNESIA_BOUNDARY_RUNTIME_ID,
  AMNESIA_DATASETS,
  AMNESIA_PUBLIC_TOOLS,
  verifyAmnesiaBoundaryReport,
} from './amnesia-evidence.mjs'
import { canonicalize, sha256Canonical } from './oracle-receipts.mjs'

export const COUNTED_CASE_KIND = 'egolens-adapter-amnesia-boundary-case-artifact'
export const COUNTED_PROBE_KIND = 'egolens-adapter-amnesia-negative-probe-report'
export const COUNTED_SOURCE_MANIFEST_KIND = 'egolens-adapter-amnesia-protected-source-manifest'
export const COUNTED_COORDINATOR_ID = AMNESIA_BOUNDARY_RUNTIME_ID

export const REQUIRED_PROBE_CHECKS = Object.freeze([
  'build-source-stage-read-allowed',
  'build-forbidden-resource-read-denied',
  'build-external-network-denied',
  'application-read-allowed',
  'dataset-read-allowed',
  'dataset-write-denied',
  'output-write-allowed',
  'output-read-denied',
  'forbidden-resource-read-denied',
  'broker-external-network-denied',
  'broker-loopback-allowed',
  'system-socket-root-read-denied',
  'system-socket-root-unrelated-write-denied',
  'controller-application-read-denied',
  'controller-dataset-read-denied',
  'controller-output-read-denied',
  'controller-forbidden-resource-read-denied',
  'controller-external-network-denied',
  'controller-nonbroker-loopback-denied',
  'controller-privileged-reexec-denied',
  'controller-auth-read-denied',
  'controller-loopback-allowed',
  'public-tool-catalog-exact',
])

const REPOSITORY_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
export const REVIEWED_AUTHOR_SOURCE_PATHS = Object.freeze([
  'amnesia.html',
  'scripts/phase9-counted-author-vite.config.ts',
  'src/AmnesiaAuthorApp.tsx',
  'src/amnesia-main.tsx',
  'src/components/TeachableLens/TeachableLensPanel.tsx',
  'src/teachable/authoring/AuthoringSession.ts',
  'src/teachable/authoring/BrowserGraphPreviewRuntime.ts',
  'src/teachable/authoring/InventoryBindingEvaluator.ts',
  'src/teachable/authoring/SourceInventory.ts',
  'src/teachable/authoring/browserSession.ts',
  'src/teachable/authoring/hashes.ts',
  'src/teachable/authoring/inspection.ts',
  'src/teachable/authoring/persistence.ts',
  'src/teachable/authoring/portability.ts',
  'src/teachable/authoring/previewStore.ts',
  'src/teachable/authoring/review.ts',
  'src/teachable/authoring/semanticDiff.ts',
  'src/teachable/authoring/sourceSelectors.ts',
  'src/teachable/authoring/webMcp.ts',
  'src/teachable/extensions/ExtensionOperatorExecutor.ts',
  'src/teachable/extensions/extensionWorker.ts',
  'src/teachable/extensions/extensionWorkerRuntime.ts',
  'src/teachable/extensions/packageManifest.ts',
  'src/teachable/extensions/protocol.ts',
  'src/teachable/extensions/registeredPackages.ts',
  'src/teachable/extensions/resourceLimits.ts',
  'src/teachable/extensions/testExtensionManifest.ts',
  'src/teachable/extensions/workerPackages.ts',
  'src/teachable/operators/binaryReaders.ts',
  'src/teachable/operators/bundledPhase2.ts',
  'src/teachable/operators/coreGraphOperators.ts',
  'src/teachable/operators/expressionAst.ts',
  'src/teachable/operators/featherColumns.ts',
  'src/teachable/operators/jsonRecords.ts',
  'src/teachable/operators/parquetColumns.ts',
  'src/teachable/operators/registry.ts',
  'src/teachable/operators/sceneGeometry.ts',
  'src/teachable/operators/temporal.ts',
  'src/teachable/recipe/canonicalize.ts',
  'src/teachable/recipe/compiler.ts',
  'src/teachable/recipe/diagnostics.ts',
  'src/teachable/recipe/fingerprints.ts',
  'src/teachable/recipe/types.ts',
  'src/teachable/runtime/GraphKernel.ts',
  'src/teachable/runtime/GraphSceneAssembler.ts',
  'src/teachable/runtime/GraphValues.ts',
  'src/teachable/runtime/ManagedNormalizedScene.ts',
  'src/teachable/runtime/RecipeBackedDatasetAdapter.ts',
  'src/teachable/runtime/bindRecipeScene.ts',
  'src/teachable/runtime/compatibilityBridge.ts',
  'src/teachable/runtime/normalizedScene.ts',
  'src/teachable/runtime/parity.ts',
  'src/teachable/runtime/parityHarness.ts',
  'src/teachable/runtime/performanceProbe.ts',
  'src/teachable/runtime/versionRoot.ts',
  'src/teachable/schema/egolens-adapter-v1.schema.json',
  'src/teachable/schema/egolens-share-v1.schema.json',
  'src/teachable/schema/egolens-source-catalog-v1.schema.json',
  'src/teachable/schema/validateSchema.ts',
  'src/teachable/share/PortableShareRuntime.ts',
  'src/teachable/share/RecipeTransport.ts',
  'src/teachable/share/ShareDescriptor.ts',
  'src/teachable/source/ByteSource.ts',
  'src/teachable/source/RemoteByteSource.ts',
  'src/teachable/source/SourceCatalog.ts',
  'src/teachable/source/sha256.ts',
  'src/theme.ts',
  'src/types/dataset.ts',
  'src/types/lz4js.d.ts',
  'src/types/waymo.ts',
  'src/utils/matrix.ts',
  'src/utils/merge.ts',
  'src/utils/parquet.ts',
  'src/utils/quaternion.ts',
  'src/utils/rangeImage.ts',
  'src/utils/themeParams.ts',
  'src/vite-env.d.ts',
  'src/workers/fetchHelper.ts',
  'tsconfig.app.json',
].sort())

const TRUSTED_POLICY_PATHS = Object.freeze([
  'package-lock.json',
  'package.json',
  'vite.amnesia.config.ts',
  'scripts/lib/amnesia-evidence.mjs',
  'scripts/lib/oracle-receipts.mjs',
  'scripts/lib/phase9-counted-author-boundary.mjs',
  'scripts/phase9-counted-author-broker.mjs',
  'scripts/phase9-counted-author-broker.sb',
  'scripts/phase9-counted-author-build.sb',
  'scripts/phase9-counted-author-controller.sb',
  'scripts/phase9-counted-author-coordinator.mjs',
  'scripts/phase9-counted-boundary-probe.mjs',
])
const TRUSTED_TOOL_PATHS = Object.freeze([
  ...new Set([...TRUSTED_POLICY_PATHS, ...REVIEWED_AUTHOR_SOURCE_PATHS]),
].sort())

export function countedAuthorTypecheckConfigText() {
  return `${JSON.stringify({
    extends: './tsconfig.app.json',
    compilerOptions: {
      incremental: true,
      tsBuildInfoFile: '../build-home/counted-author.tsbuildinfo',
    },
    files: ['./src/amnesia-main.tsx', './src/vite-env.d.ts', './src/types/lz4js.d.ts'],
    include: [],
    exclude: [],
  })}\n`
}

export function currentTrustedToolManifest() {
  const files = [...TRUSTED_TOOL_PATHS].sort().map((relativePath) => {
    const bytes = readFileSync(path.join(REPOSITORY_ROOT, relativePath))
    return { path: relativePath, bytes: bytes.length, sha256: sha256Colon(bytes) }
  })
  const payload = {
    kind: 'egolens-counted-author-trusted-tool-manifest',
    schemaVersion: 1,
    files,
  }
  return { ...payload, manifestHash: sha256Colon(payload) }
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const COLON_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u
const CANONICAL_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/u
const BROKER_PARAMETER_NAMES = Object.freeze([
  'APPLICATION_REAL_ROOT', 'APPLICATION_ROOT', 'BROKER_FILE', 'BROWSER_PROFILE',
  'BROWSER_PROFILE_REAL', 'CHROME_ROOT', 'DATASET_REAL_ROOT', 'DATASET_ROOT',
  'LOOPBACK_BIND_ENDPOINT', 'LOOPBACK_REMOTE_ENDPOINT', 'NODE_RUNTIME_ROOT',
  'OUTPUT_REAL_ROOT', 'OUTPUT_ROOT', 'PLAYWRIGHT_CORE_ROOT', 'PLAYWRIGHT_ROOT',
  'PROBE_FILE', 'RUNTIME_SCRATCH', 'RUNTIME_SCRATCH_REAL', 'SYSTEM_SOCKET_REAL_ROOT',
  'SYSTEM_SOCKET_ROOT',
])
const CONTROLLER_PARAMETER_NAMES = Object.freeze([
  'BROKER_REMOTE_ENDPOINT', 'CODEX_BINARY', 'CODEX_HOME_ROOT', 'CODEX_RUNTIME_ROOT',
  'CODEX_SUPPORT_ROOT', 'CONTROL_REAL_ROOT', 'CONTROL_ROOT', 'OPENAI_SUPPORT_ROOT',
  'SYSTEM_TMP',
])
const BUILD_PARAMETER_NAMES = Object.freeze([
  'BUILD_HOME', 'BUILD_HOME_REAL',
  'NODE_MODULES_REAL_ROOT', 'NODE_MODULES_ROOT', 'NODE_RUNTIME_ROOT',
  'OUTPUT_REAL_ROOT', 'OUTPUT_ROOT', 'SOURCE_STAGE_REAL_ROOT', 'SOURCE_STAGE_ROOT',
])

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && canonicalize(Object.keys(value).sort()) === canonicalize([...keys].sort())
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual) && actual.length === new Set(actual).size
    && canonicalize([...actual].sort()) === canonicalize([...expected].sort())
}

export function sha256Colon(value) {
  const bytes = typeof value === 'string' || value instanceof Uint8Array
    ? value
    : canonicalize(value)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function randomToken() {
  return randomBytes(32).toString('hex')
}

export function assertSupportedCountedHost({ platform = process.platform, sandboxExec = '/usr/bin/sandbox-exec' } = {}) {
  if (platform !== 'darwin') throw new Error('Counted Adapter Amnesia authoring requires macOS Seatbelt.')
  if (sandboxExec !== '/usr/bin/sandbox-exec') {
    throw new Error('Counted Adapter Amnesia authoring requires the system /usr/bin/sandbox-exec.')
  }
}

export async function canonicalDirectory(value, label, { mustBeEmpty = false, ownerOnly = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`)
  const info = await lstat(value)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory, not a symlink.`)
  const canonicalPath = await realpath(value)
  const canonicalInfo = await lstat(canonicalPath)
  if (ownerOnly && (canonicalInfo.uid !== process.getuid() || (canonicalInfo.mode & 0o077) !== 0)) {
    throw new Error(`${label} must be owned by the coordinator user and have owner-only permissions.`)
  }
  if (mustBeEmpty) {
    const { opendir } = await import('node:fs/promises')
    const directory = await opendir(canonicalPath)
    try {
      const first = await directory.read()
      if (first) throw new Error(`${label} must be empty before the counted run.`)
    } finally {
      await directory.close().catch(() => {})
    }
  }
  return canonicalPath
}

export async function canonicalFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`)
  const info = await lstat(value)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a real file, not a symlink.`)
  return await realpath(value)
}

export function assertDisjointBoundaryPaths(pathsByName) {
  const entries = Object.entries(pathsByName)
  for (let index = 0; index < entries.length; index += 1) {
    const [leftName, left] = entries[index]
    if (!path.isAbsolute(left)) throw new Error(`${leftName} is not absolute.`)
    for (let other = index + 1; other < entries.length; other += 1) {
      const [rightName, right] = entries[other]
      const leftContainsRight = right === left || right.startsWith(`${left}${path.sep}`)
      const rightContainsLeft = left.startsWith(`${right}${path.sep}`)
      if (leftContainsRight || rightContainsLeft) {
        throw new Error(`${leftName} and ${rightName} must be disjoint boundary paths.`)
      }
    }
  }
}

export function controllerExecArguments({ controlRoot, prompt }) {
  const disabledFeatures = [
    'apps',
    'auth_elicitation',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'computer_use',
    'enable_mcp_apps',
    'external_agent_memory_import',
    'goals',
    'hooks',
    'image_generation',
    'in_app_browser',
    'multi_agent',
    'multi_agent_v2',
    'mcp_2026_07_28',
    'memories',
    'plugins',
    'remote_plugin',
    'recommended_plugins',
    'skill_search',
    'skill_mcp_dependency_install',
    'standalone_web_search',
    'shell_snapshot',
    'tool_call_mcp_elicitation',
    'tool_suggest',
    'web_search_cached',
    'web_search_request',
    'workspace_dependencies',
  ]
  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--strict-config',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c', 'shell_environment_policy.inherit="none"',
    ...disabledFeatures.flatMap((feature) => ['--disable', feature]),
    '--enable', 'skip_host_skill_discovery',
    '-C', controlRoot,
    prompt,
  ]
}

export async function effectivePolicyDescriptor({
  brokerProfilePath,
  brokerParameters,
  controllerProfilePath,
  controllerParameters,
  applicationBuild,
  sourceManifest,
  protectedRoots,
  controllerState,
  buildProfilePath,
  buildParameters,
  authorSourceGraph,
  authorSourceStageManifest,
  runtimeManifest,
  buildDependencyManifest,
}) {
  const [brokerProfile, controllerProfile, buildProfile] = await Promise.all([
    readFile(brokerProfilePath),
    readFile(controllerProfilePath),
    readFile(buildProfilePath),
  ])
  const descriptor = {
    brokerSeatbeltTemplateHash: sha256Colon(brokerProfile),
    brokerSeatbeltParameters: Object.fromEntries(Object.entries(brokerParameters)
      .sort(([left], [right]) => left.localeCompare(right))),
    controllerSeatbeltTemplateHash: sha256Colon(controllerProfile),
    controllerSeatbeltParameters: Object.fromEntries(Object.entries(controllerParameters)
      .sort(([left], [right]) => left.localeCompare(right))),
    buildSeatbeltTemplateHash: sha256Colon(buildProfile),
    buildSeatbeltParameters: Object.fromEntries(Object.entries(buildParameters)
      .sort(([left], [right]) => left.localeCompare(right))),
    applicationBuild,
    sourceManifest,
    authorSourceGraph,
    authorSourceStageManifest,
    runtimeManifest,
    buildDependencyManifest,
    protectedRoots,
    controllerState,
    trustedToolManifest: currentTrustedToolManifest(),
    coordinatorRuntimeId: COUNTED_COORDINATOR_ID,
  }
  if (!verifyPolicyDescriptor(descriptor)) throw new Error('Unsafe counted boundary policy descriptor.')
  return { descriptor, policyHash: sha256Colon(descriptor) }
}

function safeCanonicalPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) return false
  const broad = new Set([
    '/', '/Applications', '/Library', '/Network', '/System', '/Users', '/Volumes',
    '/bin', '/private', '/private/tmp', '/private/var', '/usr', '/usr/bin', '/usr/lib',
  ])
  const exactTrustedApps = new Set(['/Applications/ChatGPT.app', '/Applications/Google Chrome.app'])
  return !broad.has(value)
    && (exactTrustedApps.has(value) || value.split(path.sep).filter(Boolean).length >= 3)
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
}

function allowedAuthorGraphPath(relative) {
  if (relative === 'amnesia.html' || relative === 'src/amnesia-main.tsx' || relative === 'src/AmnesiaAuthorApp.tsx'
    || relative === 'src/theme.ts') return true
  if (relative.startsWith('src/components/TeachableLens/')) return true
  if (relative.startsWith('src/teachable/')
    && !relative.includes('/__tests__/')
    && !relative.includes('/__fixtures__/')
    && !relative.startsWith('src/teachable/conformance/')) return true
  return new Set([
    'src/types/dataset.ts',
    'src/utils/matrix.ts',
    'src/utils/merge.ts',
    'src/utils/parquet.ts',
    'src/utils/quaternion.ts',
    'src/utils/rangeImage.ts',
    'src/utils/themeParams.ts',
    'src/workers/fetchHelper.ts',
  ]).has(relative)
}

function allowedAuthorStagePath(relative) {
  return relative === 'tsconfig.counted-author.json' || REVIEWED_AUTHOR_SOURCE_PATHS.includes(relative)
}

function verifyReviewedAuthorStageManifest(manifest, trustedToolManifest) {
  if (!verifyContentManifest(manifest)
    || !sameStringSet(
      manifest.files.map((entry) => entry.path),
      [...REVIEWED_AUTHOR_SOURCE_PATHS, 'tsconfig.counted-author.json'],
    )) return false
  const trustedFiles = new Map(trustedToolManifest.files.map((entry) => [entry.path, entry]))
  const generatedText = countedAuthorTypecheckConfigText()
  const generated = {
    bytes: Buffer.byteLength(generatedText),
    sha256: sha256Colon(generatedText),
  }
  return manifest.files.every((entry) => {
    const expected = entry.path === 'tsconfig.counted-author.json'
      ? generated
      : trustedFiles.get(entry.path)
    return expected?.bytes === entry.bytes && expected?.sha256 === entry.sha256
  })
}

function authorSourceGraphPayload(graph) {
  const { graphHash: _graphHash, ...payload } = graph
  return payload
}

function payloadWithoutHash(value, hashKey) {
  const { [hashKey]: _hash, ...payload } = value
  return payload
}

function verifyRuntimeManifest(manifest) {
  if (!exactKeys(manifest, [
    'kind', 'schemaVersion', 'node', 'playwright', 'chrome', 'codex', 'manifestHash',
  ]) || manifest.kind !== 'egolens-counted-author-runtime-manifest' || manifest.schemaVersion !== 1
    || !exactKeys(manifest.node, ['version', 'executableHash'])
    || manifest.node.version !== 'v24.19.0' || !COLON_HASH_PATTERN.test(manifest.node.executableHash)
    || !exactKeys(manifest.playwright, ['version', 'coreVersion', 'entryHash', 'corePackageHash'])
    || manifest.playwright.version !== '1.62.1' || manifest.playwright.coreVersion !== '1.62.1'
    || !COLON_HASH_PATTERN.test(manifest.playwright.entryHash)
    || !COLON_HASH_PATTERN.test(manifest.playwright.corePackageHash)
    || !exactKeys(manifest.chrome, ['version', 'executableHash'])
    || manifest.chrome.version !== 'Google Chrome 152.0.7977.66'
    || !COLON_HASH_PATTERN.test(manifest.chrome.executableHash)
    || !exactKeys(manifest.codex, ['version', 'executableHash'])
    || manifest.codex.version !== 'codex-cli 0.150.0-alpha.12.2'
    || !COLON_HASH_PATTERN.test(manifest.codex.executableHash)
    || !COLON_HASH_PATTERN.test(manifest.manifestHash)) return false
  return sha256Colon(payloadWithoutHash(manifest, 'manifestHash')) === manifest.manifestHash
}

const EXPECTED_BUILD_DEPENDENCIES = Object.freeze({
  '@esbuild/darwin-arm64': '0.27.3',
  '@rollup/rollup-darwin-arm64': '4.59.0',
  '@vitejs/plugin-react': '5.1.4',
  esbuild: '0.27.3',
  rollup: '4.59.0',
  typescript: '5.9.3',
  vite: '7.3.1',
})

function verifyBuildDependencyManifest(manifest) {
  if (!exactKeys(manifest, ['kind', 'schemaVersion', 'packages', 'manifestHash'])
    || manifest.kind !== 'egolens-counted-author-build-dependency-manifest'
    || manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)
    || manifest.packages.length !== Object.keys(EXPECTED_BUILD_DEPENDENCIES).length
    || !COLON_HASH_PATTERN.test(manifest.manifestHash)) return false
  let previous = ''
  for (const entry of manifest.packages) {
    if (!exactKeys(entry, ['name', 'version', 'contentHash', 'fileCount', 'totalBytes'])
      || entry.name <= previous || EXPECTED_BUILD_DEPENDENCIES[entry.name] !== entry.version
      || !COLON_HASH_PATTERN.test(entry.contentHash)
      || !Number.isSafeInteger(entry.fileCount) || entry.fileCount < 1
      || !Number.isSafeInteger(entry.totalBytes) || entry.totalBytes < 1) return false
    previous = entry.name
  }
  return sha256Colon(payloadWithoutHash(manifest, 'manifestHash')) === manifest.manifestHash
}

function verifyAuthorSourceGraph(graph, sourceCommit, stageManifest) {
  if (!exactKeys(graph, [
    'kind', 'schemaVersion', 'sourceCommit', 'modules', 'moduleCount', 'totalBytes',
    'stageContentHash', 'graphHash',
  ]) || graph.kind !== 'egolens-counted-author-source-graph' || graph.schemaVersion !== 1
    || graph.sourceCommit !== sourceCommit || !Array.isArray(graph.modules)
    || graph.modules.length < 2 || graph.moduleCount !== graph.modules.length
    || !Number.isSafeInteger(graph.totalBytes) || graph.totalBytes < 1
    || !COLON_HASH_PATTERN.test(graph.stageContentHash)
    || !COLON_HASH_PATTERN.test(graph.graphHash)
    || graph.stageContentHash !== sha256Colon(stageManifest)) return false
  const staged = new Map(stageManifest.files.map((entry) => [entry.path, entry]))
  let totalBytes = 0
  let previous = ''
  for (const entry of graph.modules) {
    if (!exactKeys(entry, ['path', 'bytes', 'sha256'])
      || !allowedAuthorGraphPath(entry.path) || entry.path <= previous
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !COLON_HASH_PATTERN.test(entry.sha256)) return false
    const stagedEntry = staged.get(entry.path)
    if (!stagedEntry || stagedEntry.bytes !== entry.bytes || stagedEntry.sha256 !== entry.sha256) return false
    previous = entry.path
    totalBytes += entry.bytes
  }
  return totalBytes === graph.totalBytes
    && graph.modules.some((entry) => entry.path === 'src/amnesia-main.tsx')
    && graph.modules.some((entry) => entry.path === 'src/AmnesiaAuthorApp.tsx')
    && sha256Colon(authorSourceGraphPayload(graph)) === graph.graphHash
}

export function verifyPolicyDescriptor(descriptor, boundaryCase) {
  if (!exactKeys(descriptor, [
    'brokerSeatbeltTemplateHash', 'brokerSeatbeltParameters',
    'controllerSeatbeltTemplateHash', 'controllerSeatbeltParameters',
    'buildSeatbeltTemplateHash', 'buildSeatbeltParameters',
    'applicationBuild', 'sourceManifest', 'protectedRoots', 'controllerState',
    'authorSourceGraph', 'authorSourceStageManifest',
    'runtimeManifest', 'buildDependencyManifest', 'trustedToolManifest', 'coordinatorRuntimeId',
  ]) || descriptor.coordinatorRuntimeId !== COUNTED_COORDINATOR_ID
    || canonicalize(descriptor.trustedToolManifest) !== canonicalize(currentTrustedToolManifest())
    || !exactKeys(descriptor.brokerSeatbeltParameters, BROKER_PARAMETER_NAMES)
    || !exactKeys(descriptor.controllerSeatbeltParameters, CONTROLLER_PARAMETER_NAMES)
    || !exactKeys(descriptor.buildSeatbeltParameters, BUILD_PARAMETER_NAMES)
    || !exactKeys(descriptor.applicationBuild, [
      'sourceCommit', 'applicationBuildHash', 'fileCount', 'totalBytes',
    ])
    || !COMMIT_PATTERN.test(descriptor.applicationBuild.sourceCommit)
    || !COLON_HASH_PATTERN.test(descriptor.applicationBuild.applicationBuildHash)
    || !Number.isSafeInteger(descriptor.applicationBuild.fileCount) || descriptor.applicationBuild.fileCount < 1
    || !Number.isSafeInteger(descriptor.applicationBuild.totalBytes) || descriptor.applicationBuild.totalBytes < 1
    || !exactKeys(descriptor.sourceManifest, [
      'sourceFingerprint', 'sourceContentHash', 'captureConfigHash', 'fileCount', 'totalBytes',
    ])
    || !CANONICAL_HASH_PATTERN.test(descriptor.sourceManifest.sourceFingerprint)
    || !CANONICAL_HASH_PATTERN.test(descriptor.sourceManifest.sourceContentHash)
    || !COLON_HASH_PATTERN.test(descriptor.sourceManifest.captureConfigHash)
    || !Number.isSafeInteger(descriptor.sourceManifest.fileCount) || descriptor.sourceManifest.fileCount < 1
    || !Number.isSafeInteger(descriptor.sourceManifest.totalBytes) || descriptor.sourceManifest.totalBytes < 1
    || !exactKeys(descriptor.protectedRoots, ['captureConfigFile', 'evidenceRoot'])
    || !exactKeys(descriptor.controllerState, ['authMaterial', 'destroyedAfter', 'freshBefore'])
    || descriptor.controllerState.authMaterial !== 'auth-json-only'
    || descriptor.controllerState.freshBefore !== true
    || descriptor.controllerState.destroyedAfter !== true
    || !verifyReviewedAuthorStageManifest(
      descriptor.authorSourceStageManifest,
      descriptor.trustedToolManifest,
    )
    || descriptor.authorSourceStageManifest.files.some((entry) => !allowedAuthorStagePath(entry.path))
    || !verifyAuthorSourceGraph(
      descriptor.authorSourceGraph,
      descriptor.applicationBuild.sourceCommit,
      descriptor.authorSourceStageManifest,
    )
    || !verifyRuntimeManifest(descriptor.runtimeManifest)
    || !verifyBuildDependencyManifest(descriptor.buildDependencyManifest)
    ) return false

  const toolHash = (relativePath) => descriptor.trustedToolManifest.files
    .find((entry) => entry.path === relativePath)?.sha256
  if (descriptor.brokerSeatbeltTemplateHash !== toolHash('scripts/phase9-counted-author-broker.sb')
    || descriptor.controllerSeatbeltTemplateHash !== toolHash('scripts/phase9-counted-author-controller.sb')
    || descriptor.buildSeatbeltTemplateHash !== toolHash('scripts/phase9-counted-author-build.sb')) return false

  const broker = descriptor.brokerSeatbeltParameters
  const controller = descriptor.controllerSeatbeltParameters
  const build = descriptor.buildSeatbeltParameters
  const pathParameters = [
    ...BROKER_PARAMETER_NAMES.filter((name) => !name.startsWith('LOOPBACK_')).map((name) => broker[name]),
    ...CONTROLLER_PARAMETER_NAMES.filter((name) => name !== 'BROKER_REMOTE_ENDPOINT').map((name) => controller[name]),
    descriptor.protectedRoots.captureConfigFile,
    descriptor.protectedRoots.evidenceRoot,
    ...BUILD_PARAMETER_NAMES.map((name) => build[name]),
  ]
  if (pathParameters.some((value) => !safeCanonicalPath(value))) return false
  if (broker.APPLICATION_ROOT !== broker.APPLICATION_REAL_ROOT
    || broker.DATASET_ROOT !== broker.DATASET_REAL_ROOT
    || broker.OUTPUT_ROOT !== broker.OUTPUT_REAL_ROOT
    || broker.BROWSER_PROFILE !== broker.BROWSER_PROFILE_REAL
    || broker.RUNTIME_SCRATCH !== broker.RUNTIME_SCRATCH_REAL
    || broker.LOOPBACK_BIND_ENDPOINT !== broker.LOOPBACK_REMOTE_ENDPOINT
    || !/^localhost:[1-9][0-9]{3,4}$/u.test(broker.LOOPBACK_BIND_ENDPOINT)
    || controller.BROKER_REMOTE_ENDPOINT !== broker.LOOPBACK_REMOTE_ENDPOINT
    || controller.CONTROL_ROOT !== controller.CONTROL_REAL_ROOT
    || !/^\/Users\/[^/]+\/\.cache\/codex-runtimes\/codex-primary-runtime\/dependencies\/node$/u
      .test(broker.NODE_RUNTIME_ROOT)
    || broker.PLAYWRIGHT_ROOT !== path.join(broker.NODE_RUNTIME_ROOT, 'node_modules', 'playwright')
    || broker.PLAYWRIGHT_CORE_ROOT !== path.join(broker.NODE_RUNTIME_ROOT, 'node_modules', 'playwright-core')
    || broker.CHROME_ROOT !== '/Applications/Google Chrome.app'
    || !/^\/var\/folders\/[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]+\/T$/u.test(broker.SYSTEM_SOCKET_ROOT)
    || broker.SYSTEM_SOCKET_REAL_ROOT !== `/private${broker.SYSTEM_SOCKET_ROOT}`
    || controller.CODEX_RUNTIME_ROOT !== '/Applications/ChatGPT.app'
    || controller.CODEX_BINARY !== '/Applications/ChatGPT.app/Contents/Resources/codex'
    || !controller.CODEX_HOME_ROOT.startsWith('/private/tmp/egolens-phase9-counted-')
    || !controller.CODEX_HOME_ROOT.endsWith('/controller-home/.codex')
    || controller.OPENAI_SUPPORT_ROOT !== path.join(
      path.dirname(controller.CODEX_HOME_ROOT), 'Library', 'Application Support', 'OpenAI',
    )
    || controller.CODEX_SUPPORT_ROOT !== path.join(
      path.dirname(controller.CODEX_HOME_ROOT), 'Library', 'Application Support', 'Codex',
    )
    || controller.SYSTEM_TMP !== path.join(
      path.dirname(path.dirname(controller.CODEX_HOME_ROOT)), 'controller-tmp',
    )
    || !broker.BROKER_FILE.endsWith('/scripts/phase9-counted-author-broker.mjs')
    || !broker.PROBE_FILE.endsWith('/scripts/phase9-counted-boundary-probe.mjs')
    || !broker.APPLICATION_ROOT.startsWith('/private/tmp/egolens-phase9-counted-')
    || !broker.APPLICATION_ROOT.endsWith('/installed-author-build/dist-amnesia-author')
    || !controller.CONTROL_ROOT.startsWith('/private/tmp/egolens-phase9-counted-')
    || !broker.BROWSER_PROFILE.startsWith('/private/tmp/egolens-phase9-counted-')
    || !broker.RUNTIME_SCRATCH.startsWith('/private/tmp/egolens-phase9-counted-')) return false

  if (build.SOURCE_STAGE_ROOT !== build.SOURCE_STAGE_REAL_ROOT
    || build.NODE_MODULES_ROOT !== build.NODE_MODULES_REAL_ROOT
    || build.OUTPUT_ROOT !== build.OUTPUT_REAL_ROOT
    || build.BUILD_HOME !== build.BUILD_HOME_REAL
    || build.NODE_RUNTIME_ROOT !== broker.NODE_RUNTIME_ROOT
    || !build.SOURCE_STAGE_ROOT.startsWith('/private/tmp/egolens-phase9-counted-')
    || path.basename(build.SOURCE_STAGE_ROOT) !== 'author-source-stage'
    || build.NODE_MODULES_ROOT !== path.join(
      path.dirname(build.SOURCE_STAGE_ROOT), 'detached-source', 'node_modules',
    )
    || build.OUTPUT_ROOT !== path.join(build.SOURCE_STAGE_ROOT, 'dist-amnesia-author')
    || build.BUILD_HOME !== path.join(path.dirname(build.SOURCE_STAGE_ROOT), 'build-home')) return false

  const controllerHome = path.dirname(controller.CODEX_HOME_ROOT)
  const repositoryRoot = path.dirname(path.dirname(broker.BROKER_FILE))
  const semanticPaths = [
    broker.APPLICATION_ROOT, broker.DATASET_ROOT, broker.OUTPUT_ROOT,
    broker.BROWSER_PROFILE, broker.RUNTIME_SCRATCH, controller.CONTROL_ROOT,
    controllerHome, controller.SYSTEM_TMP, descriptor.protectedRoots.captureConfigFile,
    descriptor.protectedRoots.evidenceRoot,
  ]
  for (let index = 0; index < semanticPaths.length; index += 1) {
    for (let other = index + 1; other < semanticPaths.length; other += 1) {
      if (overlaps(semanticPaths[index], semanticPaths[other])) return false
    }
  }
  for (const runtimeRoot of [
    broker.NODE_RUNTIME_ROOT, broker.PLAYWRIGHT_ROOT, broker.PLAYWRIGHT_CORE_ROOT,
    broker.CHROME_ROOT, controller.CODEX_RUNTIME_ROOT, broker.SYSTEM_SOCKET_ROOT,
    broker.SYSTEM_SOCKET_REAL_ROOT,
  ]) if (semanticPaths.some((semantic) => overlaps(runtimeRoot, semantic))) return false
  for (const forbiddenRoot of [
    repositoryRoot,
    path.join(repositoryRoot, 'benchmarks', 'oracle'),
    path.join(repositoryRoot, 'src', 'adapters', 'recipes'),
  ]) if (semanticPaths.some((semantic) => overlaps(forbiddenRoot, semantic))) return false
  for (const buildPrivateRoot of [build.SOURCE_STAGE_ROOT, build.BUILD_HOME, build.NODE_MODULES_ROOT]) {
    if (semanticPaths.some((semantic) => overlaps(buildPrivateRoot, semantic))
      || overlaps(buildPrivateRoot, repositoryRoot)
      || overlaps(buildPrivateRoot, broker.NODE_RUNTIME_ROOT)
      || overlaps(buildPrivateRoot, broker.CHROME_ROOT)
      || overlaps(buildPrivateRoot, controller.CODEX_RUNTIME_ROOT)) return false
  }

  if (boundaryCase) {
    const mount = (name) => boundaryCase.mounts?.find((entry) => entry.name === name)?.canonicalPath
    if (descriptor.applicationBuild.sourceCommit !== boundaryCase.sourceCommit
      || descriptor.applicationBuild.applicationBuildHash !== boundaryCase.applicationBuildHash
      || descriptor.sourceManifest.sourceFingerprint !== boundaryCase.sourceFingerprint
      || descriptor.sourceManifest.sourceContentHash !== boundaryCase.sourceContentHash
      || broker.APPLICATION_ROOT !== mount('application')
      || broker.DATASET_ROOT !== mount('dataset')
      || broker.OUTPUT_ROOT !== mount('candidate-output')
      || broker.BROWSER_PROFILE !== boundaryCase.browserProfile?.canonicalPath
      || broker.RUNTIME_SCRATCH !== boundaryCase.runtimeScratch?.canonicalPath) return false
  }
  return true
}

export function probePayload(report) {
  const { probeHash: _probeHash, ...payload } = report
  return payload
}

export function createProbeReport({ candidateCommit, datasetId, caseId, runId, policyHash, checks }) {
  if (!COMMIT_PATTERN.test(candidateCommit)) throw new Error('Invalid candidate commit.')
  if (!AMNESIA_DATASETS.includes(datasetId)) throw new Error('Invalid dataset id.')
  const payload = {
    kind: COUNTED_PROBE_KIND,
    schemaVersion: 1,
    candidateCommit,
    datasetId,
    caseId,
    runId,
    policyHash,
    checks: [...checks].sort((left, right) => left.id.localeCompare(right.id)),
    passed: checks.length === REQUIRED_PROBE_CHECKS.length
      && sameStringSet(checks.map((entry) => entry.id), REQUIRED_PROBE_CHECKS)
      && checks.every((entry) => entry.passed === true),
  }
  return { ...payload, probeHash: sha256Colon(payload) }
}

export function verifyProbeReport(report, { candidateCommit, datasetId, caseId, runId, policyHash }) {
  if (!exactKeys(report, [
    'kind', 'schemaVersion', 'candidateCommit', 'datasetId', 'caseId', 'runId',
    'policyHash', 'checks', 'passed', 'probeHash',
  ]) || report.kind !== COUNTED_PROBE_KIND || report.schemaVersion !== 1
    || report.candidateCommit !== candidateCommit || report.datasetId !== datasetId
    || report.caseId !== caseId || report.runId !== runId || report.policyHash !== policyHash
    || report.passed !== true || !COLON_HASH_PATTERN.test(report.probeHash)
    || !Array.isArray(report.checks) || report.checks.some((entry) => !exactKeys(entry, ['id', 'passed', 'observation'])
      || typeof entry.id !== 'string' || entry.passed !== true || typeof entry.observation !== 'string')
    || !sameStringSet(report.checks.map((entry) => entry.id), REQUIRED_PROBE_CHECKS)) return false
  return sha256Colon(probePayload(report)) === report.probeHash
}

export function caseArtifactPayload(artifact) {
  const { artifactHash: _artifactHash, ...payload } = artifact
  return payload
}

function verifyContentManifest(manifest) {
  if (!exactKeys(manifest, ['kind', 'schemaVersion', 'files', 'fileCount', 'totalBytes'])
    || manifest.kind !== 'egolens-canonical-content-manifest' || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 100_000
    || manifest.fileCount !== manifest.files.length || !Number.isSafeInteger(manifest.totalBytes)
    || manifest.totalBytes < 1) return false
  let totalBytes = 0
  let previous = ''
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ['path', 'bytes', 'sha256'])
      || typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.length > 1024
      || path.isAbsolute(entry.path) || entry.path.includes('\\')
      || entry.path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || entry.path <= previous
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !COLON_HASH_PATTERN.test(entry.sha256)) return false
    previous = entry.path
    totalBytes += entry.bytes
    if (!Number.isSafeInteger(totalBytes)) return false
  }
  return totalBytes === manifest.totalBytes
}

export function sourceManifestArtifactPayload(artifact) {
  const { artifactHash: _artifactHash, ...payload } = artifact
  return payload
}

export function createSourceManifestArtifact({
  datasetId,
  caseId,
  sourceFingerprint,
  captureConfigHash,
  sourceContentManifest,
}) {
  if (!AMNESIA_DATASETS.includes(datasetId) || typeof caseId !== 'string' || caseId.length === 0
    || !CANONICAL_HASH_PATTERN.test(sourceFingerprint)
    || !COLON_HASH_PATTERN.test(captureConfigHash)
    || !verifyContentManifest(sourceContentManifest)) {
    throw new Error('Invalid protected source manifest artifact inputs.')
  }
  const payload = {
    kind: COUNTED_SOURCE_MANIFEST_KIND,
    schemaVersion: 1,
    datasetId,
    caseId,
    sourceFingerprint,
    sourceContentHash: sha256Canonical(sourceContentManifest),
    captureConfigHash,
    manifest: sourceContentManifest,
  }
  return { ...payload, artifactHash: sha256Canonical(payload) }
}

export function verifySourceManifestArtifact(artifact) {
  return exactKeys(artifact, [
    'kind', 'schemaVersion', 'datasetId', 'caseId', 'sourceFingerprint',
    'sourceContentHash', 'captureConfigHash', 'manifest', 'artifactHash',
  ]) && artifact.kind === COUNTED_SOURCE_MANIFEST_KIND && artifact.schemaVersion === 1
    && AMNESIA_DATASETS.includes(artifact.datasetId)
    && typeof artifact.caseId === 'string' && artifact.caseId.length > 0
    && CANONICAL_HASH_PATTERN.test(artifact.sourceFingerprint)
    && CANONICAL_HASH_PATTERN.test(artifact.sourceContentHash)
    && COLON_HASH_PATTERN.test(artifact.captureConfigHash)
    && CANONICAL_HASH_PATTERN.test(artifact.artifactHash)
    && verifyContentManifest(artifact.manifest)
    && sha256Canonical(artifact.manifest) === artifact.sourceContentHash
    && sha256Canonical(sourceManifestArtifactPayload(artifact)) === artifact.artifactHash
}

function sourceManifestCommitment(artifact) {
  return {
    sourceContentHash: artifact.sourceContentHash,
    fileCount: artifact.manifest.fileCount,
    totalBytes: artifact.manifest.totalBytes,
    manifestArtifactHash: artifact.artifactHash,
  }
}

function verifySourceManifestCommitment(commitment, boundaryCase, policyDescriptor) {
  return exactKeys(commitment, [
    'sourceContentHash', 'fileCount', 'totalBytes', 'manifestArtifactHash',
  ]) && CANONICAL_HASH_PATTERN.test(commitment.sourceContentHash)
    && CANONICAL_HASH_PATTERN.test(commitment.manifestArtifactHash)
    && Number.isSafeInteger(commitment.fileCount) && commitment.fileCount > 0
    && Number.isSafeInteger(commitment.totalBytes) && commitment.totalBytes > 0
    && commitment.sourceContentHash === boundaryCase.sourceContentHash
    && commitment.sourceContentHash === policyDescriptor.sourceManifest.sourceContentHash
    && commitment.fileCount === policyDescriptor.sourceManifest.fileCount
    && commitment.totalBytes === policyDescriptor.sourceManifest.totalBytes
}

export function createBoundaryCaseArtifact({
  candidateCommit,
  boundaryCase,
  policyDescriptor,
  probeReport,
  brokerAuditHash,
  applicationContentManifest,
  sourceManifestArtifact,
}) {
  if (!verifyProbeReport(probeReport, {
    candidateCommit,
    datasetId: boundaryCase.datasetId,
    caseId: boundaryCase.caseId,
    runId: boundaryCase.runId,
    policyHash: boundaryCase.policyHash,
  })) throw new Error('Cannot create a boundary case from an invalid probe report.')
  if (probeReport.probeHash !== boundaryCase.negativeProbeReportHash) {
    throw new Error('Boundary case does not bind the negative probe report.')
  }
  if (boundaryCase.sourceCommit !== candidateCommit || !verifyPolicyDescriptor(policyDescriptor, boundaryCase)) {
    throw new Error('Boundary case is not bound to the exact safe policy and source commit.')
  }
  if (!verifyContentManifest(applicationContentManifest)
    || !verifySourceManifestArtifact(sourceManifestArtifact)
    || sha256Colon(applicationContentManifest) !== boundaryCase.applicationBuildHash
    || sourceManifestArtifact.datasetId !== boundaryCase.datasetId
    || sourceManifestArtifact.caseId !== boundaryCase.caseId
    || sourceManifestArtifact.sourceFingerprint !== boundaryCase.sourceFingerprint
    || sourceManifestArtifact.sourceContentHash !== boundaryCase.sourceContentHash
    || sourceManifestArtifact.captureConfigHash !== policyDescriptor.sourceManifest.captureConfigHash) {
    throw new Error('Boundary case content manifests are invalid or unbound.')
  }
  const payload = {
    kind: COUNTED_CASE_KIND,
    schemaVersion: 1,
    candidateCommit,
    boundaryCase,
    policyDescriptor,
    probeReport,
    brokerAuditHash,
    applicationContentManifest,
    sourceManifestCommitment: sourceManifestCommitment(sourceManifestArtifact),
    passed: true,
  }
  return { ...payload, artifactHash: sha256Canonical(payload) }
}

export function verifyBoundaryCaseArtifact(artifact, expectedCommit) {
  if (!exactKeys(artifact, [
    'kind', 'schemaVersion', 'candidateCommit', 'boundaryCase', 'policyDescriptor',
    'probeReport', 'brokerAuditHash', 'applicationContentManifest', 'sourceManifestCommitment',
    'passed', 'artifactHash',
  ]) || artifact.kind !== COUNTED_CASE_KIND || artifact.schemaVersion !== 1
    || artifact.candidateCommit !== expectedCommit || artifact.passed !== true
    || !CANONICAL_HASH_PATTERN.test(artifact.artifactHash)
    || !COLON_HASH_PATTERN.test(artifact.brokerAuditHash)
    || !COLON_HASH_PATTERN.test(artifact.boundaryCase?.recipeHash)
    || !CANONICAL_HASH_PATTERN.test(artifact.boundaryCase?.sourceFingerprint)
    || !CANONICAL_HASH_PATTERN.test(artifact.boundaryCase?.sourceContentHash)
    || artifact.boundaryCase?.sourceCommit !== expectedCommit
    || !COLON_HASH_PATTERN.test(artifact.boundaryCase?.applicationBuildHash)
    || !verifyPolicyDescriptor(artifact.policyDescriptor, artifact.boundaryCase)
    || !verifyContentManifest(artifact.applicationContentManifest)
    || sha256Colon(artifact.applicationContentManifest) !== artifact.boundaryCase?.applicationBuildHash
    || !verifySourceManifestCommitment(
      artifact.sourceManifestCommitment,
      artifact.boundaryCase,
      artifact.policyDescriptor,
    )
    || sha256Colon(artifact.policyDescriptor) !== artifact.boundaryCase?.policyHash
    || !verifyProbeReport(artifact.probeReport, {
      candidateCommit: expectedCommit,
      datasetId: artifact.boundaryCase?.datasetId,
      caseId: artifact.boundaryCase?.caseId,
      runId: artifact.boundaryCase?.runId,
      policyHash: artifact.boundaryCase?.policyHash,
    })
    || artifact.probeReport.probeHash !== artifact.boundaryCase?.negativeProbeReportHash) return false
  return sha256Canonical(caseArtifactPayload(artifact)) === artifact.artifactHash
}

export function assembleBoundaryReport({ candidateCommit, caseArtifacts }) {
  if (!COMMIT_PATTERN.test(candidateCommit)) throw new Error('Invalid candidate commit.')
  if (!Array.isArray(caseArtifacts) || caseArtifacts.length !== AMNESIA_DATASETS.length
    || caseArtifacts.some((artifact) => !verifyBoundaryCaseArtifact(artifact, candidateCommit))) {
    throw new Error('Exactly three valid counted boundary case artifacts are required.')
  }
  const cases = caseArtifacts.map((artifact) => artifact.boundaryCase)
  if (!sameStringSet(cases.map((entry) => entry.datasetId), AMNESIA_DATASETS)) {
    throw new Error('Counted boundary cases must cover all shipped datasets exactly once.')
  }
  if (new Set(cases.map((entry) => entry.applicationBuildHash)).size !== 1) {
    throw new Error('Every counted boundary case must use byte-identical exact-head author builds.')
  }
  for (const field of [
    'authorSourceGraph', 'authorSourceStageManifest', 'runtimeManifest',
    'buildDependencyManifest', 'trustedToolManifest',
  ]) {
    if (new Set(caseArtifacts.map((artifact) => canonicalize(artifact.policyDescriptor[field]))).size !== 1) {
      throw new Error(`Every counted boundary case must bind the same reviewed ${field}.`)
    }
  }
  assertDisjointBoundaryPaths(Object.fromEntries(caseArtifacts.flatMap((artifact) => {
    const entry = artifact.boundaryCase
    const suffix = `${entry.datasetId}-${entry.runId}`
    const controller = artifact.policyDescriptor.controllerSeatbeltParameters
    const protectedRoots = artifact.policyDescriptor.protectedRoots
    return [
      [`application-${suffix}`, entry.mounts.find((mount) => mount.name === 'application')?.canonicalPath],
      [`dataset-${suffix}`, entry.mounts.find((mount) => mount.name === 'dataset')?.canonicalPath],
      [`output-${suffix}`, entry.mounts.find((mount) => mount.name === 'candidate-output')?.canonicalPath],
      [`profile-${suffix}`, entry.browserProfile.canonicalPath],
      [`scratch-${suffix}`, entry.runtimeScratch.canonicalPath],
      [`control-${suffix}`, controller.CONTROL_ROOT],
      [`controller-home-${suffix}`, path.dirname(controller.CODEX_HOME_ROOT)],
      [`controller-tmp-${suffix}`, controller.SYSTEM_TMP],
      [`evidence-${suffix}`, protectedRoots.evidenceRoot],
      [`capture-config-${suffix}`, protectedRoots.captureConfigFile],
    ]
  })))
  const payload = {
    kind: AMNESIA_BOUNDARY_REPORT_KIND,
    schemaVersion: 1,
    candidateCommit,
    enforcement: {
      platform: 'macos-seatbelt',
      coordinatorRuntimeId: COUNTED_COORDINATOR_ID,
    },
    controller: {
      datasetAccess: false,
      applicationAccess: false,
      candidateOutputAccess: false,
      toolNetwork: 'loopback-only',
      modelControlPlane: 'exact-controller-process-only',
    },
    cases: cases.sort((left, right) => left.datasetId.localeCompare(right.datasetId)),
    passed: true,
  }
  const report = { ...payload, reportHash: sha256Canonical(payload) }
  if (!verifyAmnesiaBoundaryReport(report, candidateCommit)) {
    throw new Error('Assembled report does not satisfy the Adapter Amnesia v2 boundary contract.')
  }
  return report
}

export function makeBoundaryCase({
  datasetId,
  caseId,
  runId,
  sourceCommit,
  applicationBuildHash,
  recipeHash,
  sourceFingerprint,
  sourceContentHash,
  policyHash,
  negativeProbeReportHash,
  applicationRoot,
  datasetRoot,
  outputRoot,
  browserProfile,
  runtimeScratch,
}) {
  if (!COMMIT_PATTERN.test(sourceCommit)) throw new Error('Invalid source commit.')
  if (!COLON_HASH_PATTERN.test(applicationBuildHash)) throw new Error('Invalid application build hash.')
  if (!COLON_HASH_PATTERN.test(recipeHash)) throw new Error('Invalid authored recipe hash.')
  if (!CANONICAL_HASH_PATTERN.test(sourceFingerprint)) throw new Error('Invalid source fingerprint.')
  if (!CANONICAL_HASH_PATTERN.test(sourceContentHash)) throw new Error('Invalid source content hash.')
  return {
    datasetId,
    caseId,
    runId,
    sourceCommit,
    applicationBuildHash,
    recipeHash,
    sourceFingerprint,
    sourceContentHash,
    policyHash,
    negativeProbeReportHash,
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
      { name: 'application', access: 'read-only', canonicalPath: applicationRoot },
      { name: 'dataset', access: 'read-only', canonicalPath: datasetRoot },
      { name: 'candidate-output', access: 'write-only', canonicalPath: outputRoot },
    ],
    browserProfile: {
      canonicalPath: browserProfile,
      fresh: true,
      emptyBefore: true,
      destroyedAfter: true,
    },
    runtimeScratch: {
      canonicalPath: runtimeScratch,
      fresh: true,
      emptyBefore: true,
      destroyedAfter: true,
    },
  }
}
