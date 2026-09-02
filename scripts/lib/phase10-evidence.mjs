import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHASE9_EXPECTED_JUDGE_VERSION, verifyAmnesiaAttestation } from './amnesia-evidence.mjs'
import { canonicalize, sha256Canonical, verifySignedReceipt } from './oracle-receipts.mjs'

export const PHASE10_SHIPPED_DATASETS = Object.freeze(['waymo', 'nuscenes', 'argoverse2'])
export const PHASE10_HELD_OUT_DATASETS = Object.freeze(['a2d2', 'kitti-raw', 'once', 'pandaset'])
export const PHASE10_PUBLIC_TOOLS = Object.freeze([
  'egolens_teachable_apply_revision',
  'egolens_teachable_finalize',
  'egolens_teachable_get_contract',
  'egolens_teachable_get_state',
  'egolens_teachable_inspect',
])
export const PHASE10_FAILURE_CLASSIFICATIONS = Object.freeze([
  'source-limitation',
  'generic-reader-operator-gap',
  'extension-security-gap',
  'authoring-observability-gap',
  'runtime-resource-gap',
  'recipe-contract-gap',
  'normalized-scene-contract-gap',
])
export const PHASE10_REQUIRED_NEGATIVE_CASES = Object.freeze([
  'catalog-traversal',
  'cors-denial',
  'credential-isolation',
  'redirect-confinement',
  'source-tampering',
  'oversized-response',
  'abort-propagation',
  'missing-range-support',
  'source-hash-mismatch',
  'recipe-hash-mismatch',
  'descriptor-hash-mismatch',
  'ambiguous-share-form',
  'unavailable-registered-extension',
])
export const PHASE9_EXPECTED_PRODUCER_COMMIT = 'a42f658e27fce118789d3648e2612f5d25b99488'
export const PHASE9_EXPECTED_SIGNING_KEY_ID = 'phase6-2026-08'
export { PHASE9_EXPECTED_JUDGE_VERSION }
export const PHASE9_EXPECTED_REQUIREMENTS_HASH = 'sha256-2f75957b0b257b44d893f031db55c86bebae6cd78cd955dfdd353e1ea9491c77'
export const PHASE10_EXPECTED_REQUIREMENTS_HASH = 'sha256:856f633a7d2aad8c219ba20f7bd1ba3672afc12e9d0b47861b7f92cebab1c92a'
export const PHASE9_EXPECTED_PUBLIC_KEY_HASH = 'sha256:fc10af03bc437c7133157ec1a4e647df409f41fff33254f6896e866d88003135'
export const PHASE6_EXPECTED_PRODUCER_COMMIT = 'a42f658e27fce118789d3648e2612f5d25b99488'
export const PHASE6_EXPECTED_SIGNING_KEY_ID = 'phase6-2026-08'
export const PHASE6_EXPECTED_JUDGE_VERSION = 'spec013-v1'
export const PHASE6_EXPECTED_REQUIREMENTS_HASH = 'sha256-7a019c72453b8b7fd6d03c54f2921911a6ebd8cd68a5a6ce590f98a6ededb720'
export const PHASE6_EXPECTED_PUBLIC_KEY_HASH = 'sha256:fc10af03bc437c7133157ec1a4e647df409f41fff33254f6896e866d88003135'
export const PHASE10_VERIFIER_ID = 'egolens-phase10-p7-reviewed-verifier-v1'
export const PHASE10_VERIFIER_REQUIREMENT = 'external-reviewed-tool-checkout-required'
export const PHASE10_VERIFIER_CLOSURE_VERSION = 2
export const PHASE10_VERIFIER_RUNTIME_ROOT_PACKAGES = Object.freeze([
  '@eslint/js', '@react-three/drei', '@react-three/fiber', '@types/node', '@types/react',
  '@types/react-dom', '@types/three', '@uwdata/flechette', '@vitejs/plugin-react',
  '@vitest/web-worker', 'ajv', 'ajv-formats', 'eslint', 'eslint-plugin-react-hooks',
  'eslint-plugin-react-refresh', 'fbx2gltf', 'globals', 'happy-dom', 'hyparquet',
  'hyparquet-compressors', 'jsonc-parser', 'lz4js', 'react', 'react-dom', 'react-window',
  'three', 'typescript', 'typescript-eslint', 'upng-js', 'vite', 'vitest', 'webgpu',
  'zustand',
])
export const PHASE10_REVIEWED_BASELINE_V1 = Object.freeze([
  Object.freeze({
    datasetId: 'waymo',
    caseId: 'phase6-waymo-rich-001',
    coverage: Object.freeze({
      requiredCapabilities: Object.freeze([
        'boxes2d', 'boxes3d', 'cameraImages', 'cameraSegmentation', 'egoPoses',
        'lidarSegmentation', 'pointClouds', 'segmentMetadata', 'timeline', 'trajectories',
      ]),
      frameIndices: Object.freeze([0, 29, 79, 129, 197]),
      completeTimeline: false,
      perceptualReferenceIds: Object.freeze([
        'front-camera-frame-29', 'front-camera-segmentation-frame-129',
        'viewport-frame-0', 'viewport-lidar-segmentation-frame-79',
      ]),
    }),
  }),
  Object.freeze({
    datasetId: 'nuscenes',
    caseId: 'phase6-nuscenes-urban-vru-001',
    coverage: Object.freeze({
      requiredCapabilities: Object.freeze([
        'boxes2d', 'boxes3d', 'cameraImages', 'egoPoses', 'lidarSegmentation',
        'pointClouds', 'radarPointClouds', 'segmentMetadata', 'timeline', 'trajectories',
      ]),
      frameIndices: Object.freeze([0, 19, 39]),
      completeTimeline: false,
      perceptualReferenceIds: Object.freeze([
        'front-camera-frame-19', 'viewport-frame-0', 'viewport-lidar-segmentation-frame-39',
      ]),
    }),
  }),
  Object.freeze({
    datasetId: 'argoverse2',
    caseId: 'phase6-av2-urban-001',
    coverage: Object.freeze({
      requiredCapabilities: Object.freeze([
        'boxes2d', 'boxes3d', 'cameraImages', 'egoPoses', 'pointClouds',
        'segmentMetadata', 'timeline', 'trajectories',
      ]),
      frameIndices: Object.freeze([0, 78, 156]),
      completeTimeline: false,
      perceptualReferenceIds: Object.freeze([
        'front-camera-frame-78', 'viewport-boxes-frame-156', 'viewport-frame-0',
      ]),
    }),
  }),
])
export const PHASE10_TRUST_ANCHOR_SET_HASH = phase10HashV1({
  verifierId: PHASE10_VERIFIER_ID,
  phase6RequirementsHash: PHASE6_EXPECTED_REQUIREMENTS_HASH,
  phase6PublicKeyHash: PHASE6_EXPECTED_PUBLIC_KEY_HASH,
  phase6ProducerCommit: PHASE6_EXPECTED_PRODUCER_COMMIT,
  phase6SigningKeyId: PHASE6_EXPECTED_SIGNING_KEY_ID,
  phase6JudgeVersion: PHASE6_EXPECTED_JUDGE_VERSION,
  phase9RequirementsHash: PHASE9_EXPECTED_REQUIREMENTS_HASH,
  phase10RequirementsHash: PHASE10_EXPECTED_REQUIREMENTS_HASH,
  phase9PublicKeyHash: PHASE9_EXPECTED_PUBLIC_KEY_HASH,
  phase9ProducerCommit: PHASE9_EXPECTED_PRODUCER_COMMIT,
  phase9SigningKeyId: PHASE9_EXPECTED_SIGNING_KEY_ID,
  phase9JudgeVersion: PHASE9_EXPECTED_JUDGE_VERSION,
})

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '../..')
const PRODUCTION_TRUST_PATHS = Object.freeze({
  phase6Requirements: path.join(REPOSITORY_ROOT, 'benchmarks/oracle/phase6-requirements.json'),
  phase9Requirements: path.join(REPOSITORY_ROOT, 'benchmarks/oracle/phase9-requirements.json'),
  phase10Requirements: path.join(REPOSITORY_ROOT, 'benchmarks/phase10/preflight-requirements.json'),
  phase9PublicKey: path.join(REPOSITORY_ROOT, 'benchmarks/oracle/keys/phase6-2026-08-public.pem'),
})
const PHASE9_REQUIRED_RECEIPT_CHECKS = Object.freeze([
  'coverage', 'integrity', 'numeric', 'perceptual', 'structural', 'target',
])
const PHASE6_ORIGINAL_RECEIPT_KEYS = Object.freeze([
  'candidateArtifactHash', 'candidateGeneratorCommit', 'candidateRuntimeId', 'checks', 'judgeVersion',
  'judgedAt', 'kind', 'oracleBundleHash', 'oracleCoverage', 'oracleGeneratorCommit',
  'oracleLegacyRuntimeId', 'passed', 'receiptHash', 'schemaVersion', 'signature',
  'signatureAlgorithm', 'signingKeyId', 'target',
].sort())
const PHASE10_VERIFIER_CLOSURE_FILES = Object.freeze([
  'benchmarks/oracle/keys/phase6-2026-08-public.pem',
  'benchmarks/oracle/phase6-requirements.json',
  'benchmarks/oracle/phase9-requirements.json',
  'benchmarks/phase10/preflight-requirements.json',
  'src/teachable/__tests__/phase10NegativeGate.test.ts',
  'src/teachable/schema/egolens-share-v1.schema.json',
  'package-lock.json',
  'package.json',
  'amnesia.html',
  'tsconfig.app.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'scripts/lib/amnesia-evidence.mjs',
  'scripts/lib/oracle-receipts.mjs',
  'scripts/lib/phase10-build-policy.mjs',
  'scripts/lib/phase10-counted-browser-boundary.mjs',
  'scripts/lib/phase10-process-containment.mjs',
  'scripts/lib/phase10-test-gate.mjs',
  'scripts/lib/phase10-evidence.mjs',
  'scripts/lib/phase10-schema.mjs',
  'scripts/lib/fresh-process-evidence.mjs',
  'scripts/lib/perceptual-clip.mjs',
  'scripts/lib/perceptual-raster.mjs',
  'scripts/lib/phase6-benchmark-summary.mjs',
  'scripts/phase6-benchmark-summary.node.mjs',
  'scripts/phase6-cdp-benchmark.mjs',
  'scripts/phase10-counted-browser.sb',
  'scripts/phase10-create-verifier-trust-manifest.mjs',
  'scripts/phase10-evidence.node.mjs',
  'scripts/phase10-freeze-case-reserve.mjs',
  'scripts/phase10-ledger.mjs',
  'scripts/phase10-range-host.mjs',
  'scripts/phase10-source-case-manifest.mjs',
  'scripts/phase10-source-catalog.mjs',
  'scripts/phase10-assemble-preflight.mjs',
  'scripts/phase10-baseline-gate.mjs',
  'scripts/phase10-build-boundary.mjs',
  'scripts/phase10-freeze-baseline.mjs',
  'scripts/phase10-harness-gate.mjs',
  'scripts/phase10-negative-gate.mjs',
  'scripts/phase10-prepare-preflight.mjs',
  'scripts/phase10-record-preflight-mode.mjs',
  'scripts/phase10-regression-gate.mjs',
  'scripts/phase10-reviewed-build-driver.mjs',
  'scripts/phase10-reviewed-build.sb',
  'scripts/phase10-reviewed-harness.sb',
  'scripts/phase10-reviewed-test.sb',
  'scripts/phase10-reviewed-vitest.config.mjs',
  'scripts/phase9-counted-author-vite.config.ts',
])

const HASH = /^sha256:[0-9a-f]{64}$/u
const ORACLE_HASH = /^sha256-[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u
const UNC_PATH = /^\\\\/u
const SECRET_QUERY_KEY = /(?:^|[-_])(access[-_]?key|api[-_]?key|auth|bearer|code|credential|jwt|key|pass(?:word)?|policy|secret|session|signature|token)(?:$|[-_])/iu
const PRIVATE_MARKER = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u
const FORBIDDEN_PUBLIC_KEYS = new Set([
  'absolutePath',
  'contentBase64',
  'fileBytes',
  'mediaBytes',
  'privateKey',
  'rawBytes',
  'screenshotBase64',
])
const productionTrustPromises = new Map()

const verifierGitEnvironment = Object.freeze({
  HOME: '/var/empty',
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
})

function verifierGit(argv, { binary = false } = {}) {
  return execFileSync('/usr/bin/git', [
    '-c', 'core.hooksPath=/dev/null', '-C', REPOSITORY_ROOT, ...argv,
  ], {
    encoding: binary ? undefined : 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: verifierGitEnvironment,
    maxBuffer: 64 * 1024 * 1024,
  })
}

async function phase10VerifierClosureV1() {
  const schemaFiles = (await readdir(path.join(REPOSITORY_ROOT, 'benchmarks/phase10/schemas')))
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
    .map((name) => `benchmarks/phase10/schemas/${name}`)
  const conformanceFiles = (await readdir(path.join(REPOSITORY_ROOT, 'benchmarks/phase10/conformance')))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `benchmarks/phase10/conformance/${name}`)
  const paths = [...PHASE10_VERIFIER_CLOSURE_FILES, ...schemaFiles, ...conformanceFiles].sort()
  const files = await Promise.all(paths.map(async (relativePath) => {
    const bytes = await readFile(path.join(REPOSITORY_ROOT, relativePath))
    return { path: relativePath, sha256: phase10BytesHashV1(bytes), size: bytes.length }
  }))
  return Object.freeze({
    version: PHASE10_VERIFIER_CLOSURE_VERSION,
    fileCount: files.length,
    closureHash: phase10HashV1({ version: PHASE10_VERIFIER_CLOSURE_VERSION, files }),
  })
}

async function canonicalRegularDirectory(directory, label) {
  const resolved = path.resolve(directory)
  const [canonical, details] = await Promise.all([realpath(resolved), lstat(resolved)])
  if (canonical !== resolved || !details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a canonical non-symlink directory`)
  }
  return canonical
}

async function regularTreeEntries(root, relativeRoot) {
  const files = []
  const visit = async (relative) => {
    const entries = (await readdir(path.join(root, relative), { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`
      const absolute = path.join(root, child)
      const details = await lstat(absolute)
      if (entry.name === 'node_modules' && details.isDirectory() && !details.isSymbolicLink()) continue
      if (details.isSymbolicLink()) throw new Error(`Verifier dependency closure contains a symlink: ${child}`)
      if (details.isDirectory()) await visit(child)
      else if (details.isFile()) {
        const bytes = await readFile(absolute)
        files.push({ path: `node_modules/${child}`, size: bytes.length, sha256: phase10BytesHashV1(bytes) })
      } else throw new Error(`Verifier dependency closure contains a non-regular entry: ${child}`)
    }
  }
  await visit(relativeRoot)
  return files
}

export async function phase10VerifierDependencyClosureV1(
  nodeModulesDirectory = path.join(REPOSITORY_ROOT, 'node_modules'),
  { rootPackages = PHASE10_VERIFIER_RUNTIME_ROOT_PACKAGES } = {},
) {
  const root = await canonicalRegularDirectory(nodeModulesDirectory, 'verifier node_modules')
  const packagePath = (packageName) => packageName.split('/').join(path.sep)
  const resolveInstalledPackage = async (packageName, importerRoot = null, { optional = false } = {}) => {
    const candidates = []
    if (importerRoot) {
      let cursor = importerRoot
      while (cursor.startsWith(`${root}${path.sep}`)) {
        if (path.basename(cursor) !== 'node_modules') {
          candidates.push(path.join(cursor, 'node_modules', packagePath(packageName)))
        }
        cursor = path.dirname(cursor)
      }
    }
    candidates.push(path.join(root, packagePath(packageName)))
    for (const candidate of [...new Set(candidates)]) {
      try {
        const [canonical, details] = await Promise.all([realpath(candidate), lstat(candidate)])
        if (canonical !== candidate || !details.isDirectory() || details.isSymbolicLink()
          || !(canonical === root || canonical.startsWith(`${root}${path.sep}`))) {
          throw new Error(`Unsafe verifier runtime dependency path: ${packageName}`)
        }
        return canonical
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    if (optional) return null
    throw new Error(`Missing verifier runtime dependency: ${packageName}`)
  }
  const pending = []
  if (!Array.isArray(rootPackages) || rootPackages.length === 0
    || new Set(rootPackages).size !== rootPackages.length) {
    throw new Error('Verifier dependency closure roots must be a non-empty unique package list')
  }
  if (rootPackages === PHASE10_VERIFIER_RUNTIME_ROOT_PACKAGES) {
    const projectMetadata = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
    const declared = [...new Set([
      ...Object.keys(projectMetadata.dependencies ?? {}),
      ...Object.keys(projectMetadata.devDependencies ?? {}),
    ])].sort((left, right) => left.localeCompare(right, 'en'))
    if (canonicalize(declared) !== canonicalize([...rootPackages].sort())) {
      throw new Error('Verifier runtime dependency roots differ from the reviewed package manifest')
    }
  }
  for (const packageName of [...rootPackages].sort((left, right) => left.localeCompare(right, 'en'))) {
    pending.push({ name: packageName, root: await resolveInstalledPackage(packageName) })
  }
  const packages = new Map()
  while (pending.length > 0) {
    const current = pending.shift()
    const packageName = current.name
    const relativeRoot = path.relative(root, current.root).split(path.sep).join('/')
    if (packages.has(relativeRoot)) continue
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(packageName)) {
      throw new Error(`Invalid verifier runtime dependency name: ${packageName}`)
    }
    const metadata = JSON.parse(await readFile(path.join(current.root, 'package.json'), 'utf8'))
    if (metadata.name !== packageName || typeof metadata.version !== 'string' || metadata.version.length === 0) {
      throw new Error(`Invalid verifier runtime dependency metadata: ${packageName}`)
    }
    packages.set(relativeRoot, { path: relativeRoot, name: packageName, version: metadata.version })
    const dependencies = new Map()
    for (const dependency of Object.keys(metadata.dependencies ?? {})) dependencies.set(dependency, false)
    for (const dependency of Object.keys(metadata.peerDependencies ?? {})) {
      dependencies.set(dependency, metadata.peerDependenciesMeta?.[dependency]?.optional === true)
    }
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) dependencies.set(dependency, true)
    for (const [dependency, optional] of [...dependencies].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
      const dependencyRoot = await resolveInstalledPackage(dependency, current.root, { optional })
      if (dependencyRoot) pending.push({ name: dependency, root: dependencyRoot })
    }
    pending.sort((left, right) => left.root.localeCompare(right.root, 'en'))
  }
  const packageList = [...packages.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const files = (await Promise.all(packageList.map((entry) =>
    regularTreeEntries(root, entry.path)))).flat()
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const payload = {
    version: 1,
    roots: [...rootPackages].sort((left, right) => left.localeCompare(right, 'en')),
    packages: packageList,
    files,
  }
  return Object.freeze({
    packageCount: packageList.length,
    fileCount: files.length,
    closureHash: phase10HashV1(payload),
  })
}

async function verifierNodeRuntimeIdentity() {
  const runtime = await realpath(process.execPath)
  const details = await lstat(runtime)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Verifier Node runtime must be a regular file')
  return Object.freeze({ path: runtime, runtimeHash: phase10BytesHashV1(await readFile(runtime)) })
}

async function verifierToolCheckoutIdentity() {
  try {
    const commit = verifierGit(['rev-parse', 'HEAD']).trim()
    const status = verifierGit(['status', '--porcelain=v1', '--untracked-files=all']).trim()
    const index = verifierGit(['ls-files', '--stage', '-z'], { binary: true })
    const [closure, dependencyClosure, nodeRuntime] = await Promise.all([
      phase10VerifierClosureV1(),
      phase10VerifierDependencyClosureV1(),
      verifierNodeRuntimeIdentity(),
    ])
    return Object.freeze({
      commit,
      clean: status.length === 0,
      sourceTreeHash: phase10BytesHashV1(index),
      closureHash: closure.closureHash,
      closureFileCount: closure.fileCount,
      closureVersion: closure.version,
      dependencyClosureHash: dependencyClosure.closureHash,
      dependencyClosureFileCount: dependencyClosure.fileCount,
      dependencyPackageCount: dependencyClosure.packageCount,
      nodeRuntimeHash: nodeRuntime.runtimeHash,
    })
  } catch {
    return Object.freeze({
      commit: null,
      clean: false,
      sourceTreeHash: null,
      closureHash: null,
      closureFileCount: 0,
      closureVersion: PHASE10_VERIFIER_CLOSURE_VERSION,
      dependencyClosureHash: null,
      dependencyClosureFileCount: 0,
      dependencyPackageCount: 0,
      nodeRuntimeHash: null,
    })
  }
}

export async function createPhase10VerifierTrustManifestV1({ reviewId, approvedAt, expectedCommit }) {
  if (!ID.test(reviewId) || !Number.isFinite(Date.parse(approvedAt)) || !COMMIT.test(expectedCommit)) {
    throw new Error('Verifier review ID, approval timestamp, and expected commit must be explicit and valid')
  }
  const identity = await verifierToolCheckoutIdentity()
  if (!identity.clean || identity.commit !== expectedCommit
    || !HASH.test(identity.sourceTreeHash) || !HASH.test(identity.closureHash)) {
    throw new Error('Verifier trust manifests can be created only from a clean exact reviewed checkout')
  }
  const payload = {
    schema: 'egolens-phase10-verifier-trust-v1',
    verifierId: PHASE10_VERIFIER_ID,
    verifierCommit: identity.commit,
    verifierSourceTreeHash: identity.sourceTreeHash,
    verifierClosureHash: identity.closureHash,
    verifierDependencyClosureHash: identity.dependencyClosureHash,
    verifierNodeRuntimeHash: identity.nodeRuntimeHash,
    reviewId,
    approvedAt,
  }
  return { ...payload, manifestHash: phase10HashV1(payload) }
}

async function loadVerifierTrustManifestV1({ trustManifestPath, expectedManifestHash }) {
  if (!trustManifestPath || !path.isAbsolute(trustManifestPath)) {
    throw new Error('PHASE10_VERIFIER_TRUST_MANIFEST must name an absolute owner-pinned file')
  }
  if (!HASH.test(expectedManifestHash)) {
    throw new Error('PHASE10_EXPECTED_VERIFIER_TRUST_MANIFEST_HASH is required and must be a SHA-256 hash')
  }
  const resolved = path.resolve(trustManifestPath)
  const resolvedParent = path.dirname(resolved)
  const canonicalParent = await realpath(resolvedParent)
  const parentDetails = await lstat(resolvedParent)
  if (canonicalParent !== resolvedParent || !parentDetails.isDirectory() || parentDetails.isSymbolicLink()
    || parentDetails.uid !== process.getuid() || (parentDetails.mode & 0o077) !== 0) {
    throw new Error('Verifier trust manifest parent must be a canonical non-symlink owner-only directory')
  }
  const canonical = await realpath(resolved)
  if (canonical !== resolved || canonical === REPOSITORY_ROOT || canonical.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
    throw new Error('Verifier trust manifest must be a non-symlink file outside the verifier checkout')
  }
  const details = await lstat(resolved)
  if (!details.isFile() || details.isSymbolicLink() || details.uid !== process.getuid()
    || (details.mode & 0o077) !== 0) {
    throw new Error('Verifier trust manifest must be a regular owner-only file owned by the operator')
  }
  const manifest = JSON.parse(await readFile(resolved, 'utf8'))
  const keys = Object.keys(manifest ?? {}).sort()
  const expectedKeys = [
    'approvedAt', 'manifestHash', 'reviewId', 'schema', 'verifierClosureHash',
    'verifierCommit', 'verifierDependencyClosureHash', 'verifierId',
    'verifierNodeRuntimeHash', 'verifierSourceTreeHash',
  ].sort()
  const { manifestHash, ...payload } = manifest ?? {}
  if (canonicalize(keys) !== canonicalize(expectedKeys)
    || manifest.schema !== 'egolens-phase10-verifier-trust-v1'
    || manifest.verifierId !== PHASE10_VERIFIER_ID
    || !COMMIT.test(manifest.verifierCommit)
    || !HASH.test(manifest.verifierSourceTreeHash)
    || !HASH.test(manifest.verifierClosureHash)
    || !HASH.test(manifest.verifierDependencyClosureHash)
    || !HASH.test(manifest.verifierNodeRuntimeHash)
    || !ID.test(manifest.reviewId)
    || !Number.isFinite(Date.parse(manifest.approvedAt))
    || phase10HashV1(payload) !== manifestHash
    || manifestHash !== expectedManifestHash) {
    throw new Error('Verifier trust manifest does not match the explicit operator-pinned manifest hash')
  }
  return Object.freeze({ ...manifest, canonicalPath: canonical })
}

export function phase10HashV1(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
}

export function phase10BytesHashV1(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function phase10PreflightSourceModeV1(url, localSource = false) {
  const params = new URL(String(url)).searchParams
  const referencedShare = params.has('share')
  const inlineShare = params.get('shareVersion') === '1'
  if (referencedShare && inlineShare) {
    throw new Error('A counted preflight URL cannot mix referenced and inline share transports')
  }
  if (localSource) {
    if (referencedShare || inlineShare) {
      throw new Error('--local-source cannot be combined with a portable share URL')
    }
    return 'local-directory-input'
  }
  // Phase 10 calls the inline v1 URL the remote transport. Only the separately
  // fetched, hash-bound `share=` descriptor is the portable-share mode.
  return referencedShare ? 'portable-share' : 'remote-url'
}

export async function loadPhase10ProductionTrustV1(options = {}) {
  const trustManifestPath = options.trustManifestPath ?? process.env.PHASE10_VERIFIER_TRUST_MANIFEST
  const expectedManifestHash = options.expectedManifestHash
    ?? process.env.PHASE10_EXPECTED_VERIFIER_TRUST_MANIFEST_HASH
  const cacheKey = `${trustManifestPath ?? ''}\u0000${expectedManifestHash ?? ''}`
  if (!productionTrustPromises.has(cacheKey)) {
    productionTrustPromises.set(cacheKey, (async () => {
      const [phase6Requirements, phase9Requirements, phase10Requirements, phase9PublicKey, manifest, verifierTool] = await Promise.all([
        readFile(PRODUCTION_TRUST_PATHS.phase6Requirements, 'utf8').then(JSON.parse),
        readFile(PRODUCTION_TRUST_PATHS.phase9Requirements, 'utf8').then(JSON.parse),
        readFile(PRODUCTION_TRUST_PATHS.phase10Requirements, 'utf8').then(JSON.parse),
        readFile(PRODUCTION_TRUST_PATHS.phase9PublicKey, 'utf8'),
        loadVerifierTrustManifestV1({ trustManifestPath, expectedManifestHash }),
        verifierToolCheckoutIdentity(),
      ])
      validatePhase6RequirementsV1(phase6Requirements)
      validatePhase9RequirementsV1(phase9Requirements)
      validatePhase10RecipePolicyV1(phase10Requirements)
      if (sha256Canonical(phase6Requirements) !== PHASE6_EXPECTED_REQUIREMENTS_HASH
        || sha256Canonical(phase9Requirements) !== PHASE9_EXPECTED_REQUIREMENTS_HASH
        || phase10HashV1(phase10Requirements) !== PHASE10_EXPECTED_REQUIREMENTS_HASH
        || phase10BytesHashV1(Buffer.from(phase9PublicKey)) !== PHASE9_EXPECTED_PUBLIC_KEY_HASH) {
        throw new Error('Checked-in Phase 10 trust anchors differ from the reviewed immutable anchor set')
      }
      if (!verifierTool.clean
        || verifierTool.commit !== manifest.verifierCommit
        || verifierTool.sourceTreeHash !== manifest.verifierSourceTreeHash
        || verifierTool.closureHash !== manifest.verifierClosureHash
        || verifierTool.dependencyClosureHash !== manifest.verifierDependencyClosureHash
        || verifierTool.nodeRuntimeHash !== manifest.verifierNodeRuntimeHash) {
        throw new Error('Verifier checkout does not match the separate operator-approved trust manifest')
      }
      return Object.freeze({
        phase6Requirements,
        phase9Requirements,
        phase10Requirements,
        phase9PublicKey,
        expectedProducerCommit: PHASE9_EXPECTED_PRODUCER_COMMIT,
        expectedSigningKeyId: PHASE9_EXPECTED_SIGNING_KEY_ID,
        expectedPublicKeyHash: PHASE9_EXPECTED_PUBLIC_KEY_HASH,
        verifierToolCommit: verifierTool.commit,
        verifierToolClean: verifierTool.clean,
        verifierSourceTreeHash: verifierTool.sourceTreeHash,
        verifierClosureHash: verifierTool.closureHash,
        verifierClosureFileCount: verifierTool.closureFileCount,
        verifierClosureVersion: verifierTool.closureVersion,
        verifierDependencyClosureHash: verifierTool.dependencyClosureHash,
        verifierDependencyClosureFileCount: verifierTool.dependencyClosureFileCount,
        verifierDependencyPackageCount: verifierTool.dependencyPackageCount,
        verifierNodeRuntimeHash: verifierTool.nodeRuntimeHash,
        verifierTrustManifestHash: manifest.manifestHash,
        verifierTrustReviewId: manifest.reviewId,
        productionTrust: true,
      })
    })())
  }
  return productionTrustPromises.get(cacheKey)
}

export async function revalidatePhase10ProductionTrustV1(trust) {
  const verifierTool = await verifierToolCheckoutIdentity()
  if (trust?.productionTrust !== true || !verifierTool.clean
    || verifierTool.commit !== trust.verifierToolCommit
    || verifierTool.sourceTreeHash !== trust.verifierSourceTreeHash
    || verifierTool.closureHash !== trust.verifierClosureHash
    || verifierTool.closureVersion !== trust.verifierClosureVersion
    || verifierTool.dependencyClosureHash !== trust.verifierDependencyClosureHash
    || verifierTool.nodeRuntimeHash !== trust.verifierNodeRuntimeHash) {
    throw new Error('Verifier checkout changed after the operator-pinned trust check')
  }
  return true
}

function targetKey(target) {
  return `${target?.datasetId ?? ''}\u0000${target?.caseId ?? ''}`
}

function sortedChecks(checks) {
  return [...checks].sort((left, right) => targetKey(left).localeCompare(targetKey(right), 'en'))
}

function validatePhase6RequirementsV1(requirements) {
  const targets = requirements?.targets ?? []
  const reviewed = targets.map((requirement) => ({
    datasetId: requirement.datasetId,
    caseId: requirement.caseId,
    coverage: phase10ReviewedCoverageV1(requirement.coverage),
  })).sort((left, right) => left.datasetId.localeCompare(right.datasetId, 'en'))
  const expectedReviewed = [...PHASE10_REVIEWED_BASELINE_V1]
    .sort((left, right) => left.datasetId.localeCompare(right.datasetId, 'en'))
  if (requirements?.kind !== 'egolens-oracle-gate-requirements'
    || requirements.schemaVersion !== 1
    || targets.length !== PHASE10_SHIPPED_DATASETS.length
    || new Set(targets.map(targetKey)).size !== targets.length
    || canonicalize(reviewed) !== canonicalize(expectedReviewed)) {
    throw new Error('Invalid checked-in Phase 6 oracle requirements')
  }
  return true
}

function validatePhase9RequirementsV1(requirements) {
  const targets = requirements?.targets ?? []
  const datasets = targets.map((target) => target.datasetId).sort()
  if (requirements?.kind !== 'egolens-adapter-amnesia-gate-requirements'
    || requirements.schemaVersion !== 2 || requirements.recipeBinding !== 'author-attestation'
    || targets.length !== PHASE10_SHIPPED_DATASETS.length
    || canonicalize(datasets) !== canonicalize([...PHASE10_SHIPPED_DATASETS].sort())
    || new Set(targets.map(targetKey)).size !== targets.length
    || targets.some((target) => !ID.test(target.caseId) || Object.hasOwn(target, 'recipeHash')
      || !target.coverage || typeof target.coverage !== 'object' || Array.isArray(target.coverage))) {
    throw new Error('Invalid checked-in Phase 9 Adapter Amnesia requirements')
  }
  return true
}

export function phase10ReviewedCoverageV1(requirement) {
  const coverage = {
    requiredCapabilities: [...(requirement?.requiredCapabilities ?? [])].sort(),
    frameIndices: [...(requirement?.frameIndices ?? [])],
    completeTimeline: requirement?.completeTimeline,
    perceptualReferenceIds: [...(requirement?.perceptualReferenceIds ?? [])].sort(),
  }
  if (coverage.requiredCapabilities.length === 0
    || coverage.requiredCapabilities.length !== new Set(coverage.requiredCapabilities).size
    || coverage.frameIndices.length === 0
    || coverage.frameIndices.some((frame, index) => !Number.isSafeInteger(frame) || frame < 0
      || (index > 0 && coverage.frameIndices[index - 1] >= frame))
    || typeof coverage.completeTimeline !== 'boolean'
    || coverage.perceptualReferenceIds.length !== new Set(coverage.perceptualReferenceIds).size) {
    throw new Error(`${requirement?.datasetId ?? 'unknown'}: invalid reviewed Phase 10 coverage`)
  }
  return coverage
}

export function phase10ProtectedConformanceConfigV1(template, requirement, sourceManifestHash) {
  const coverage = phase10ReviewedCoverageV1(requirement)
  const templateKeys = [
    'datasetId', 'caseId', 'requiredCapabilities', 'frameIndices',
    'sampleValuesPerBuffer', 'perceptualCaptures',
  ]
  const perceptualIds = (template?.perceptualCaptures ?? []).map((capture) => capture.id).sort()
  if (canonicalize(Object.keys(template ?? {}).sort()) !== canonicalize(templateKeys.sort())
    || template.datasetId !== requirement?.datasetId
    || template.caseId !== requirement?.caseId
    || Object.hasOwn(template, 'sourceFingerprint')
    || canonicalize([...(template.requiredCapabilities ?? [])].sort())
      !== canonicalize(coverage.requiredCapabilities)
    || canonicalize(template.frameIndices) !== canonicalize(coverage.frameIndices)
    || canonicalize(perceptualIds) !== canonicalize(coverage.perceptualReferenceIds)
    || !Number.isSafeInteger(template.sampleValuesPerBuffer) || template.sampleValuesPerBuffer < 1
    || !HASH.test(sourceManifestHash)) {
    throw new Error(`${requirement?.datasetId ?? 'unknown'}: invalid public conformance template`)
  }
  return {
    ...structuredClone(template),
    sourceFingerprint: `sha256-${sourceManifestHash.slice('sha256:'.length)}`,
  }
}

export function phase10VerifierBindingV1(trust) {
  const binding = {
    verifierId: PHASE10_VERIFIER_ID,
    verifierToolCommit: trust?.verifierToolCommit,
    verifierSourceTreeHash: trust?.verifierSourceTreeHash,
    verifierClosureHash: trust?.verifierClosureHash,
    verifierClosureVersion: trust?.verifierClosureVersion,
    verifierDependencyClosureHash: trust?.verifierDependencyClosureHash,
    verifierNodeRuntimeHash: trust?.verifierNodeRuntimeHash,
    verifierTrustManifestHash: trust?.verifierTrustManifestHash,
    verifierTrustReviewId: trust?.verifierTrustReviewId,
    verifierRequirement: PHASE10_VERIFIER_REQUIREMENT,
  }
  validatePhase10VerifierBindingV1(binding)
  return binding
}

export function validatePhase10VerifierBindingV1(binding) {
  if (binding?.verifierId !== PHASE10_VERIFIER_ID
    || !COMMIT.test(binding.verifierToolCommit)
    || !HASH.test(binding.verifierSourceTreeHash)
    || !HASH.test(binding.verifierClosureHash)
    || binding.verifierClosureVersion !== PHASE10_VERIFIER_CLOSURE_VERSION
    || !HASH.test(binding.verifierDependencyClosureHash)
    || !HASH.test(binding.verifierNodeRuntimeHash)
    || !HASH.test(binding.verifierTrustManifestHash)
    || !ID.test(binding.verifierTrustReviewId)
    || binding.verifierRequirement !== PHASE10_VERIFIER_REQUIREMENT) {
    throw new Error('Invalid external Phase 10 verifier trust binding')
  }
  return true
}

export function phase6OracleBindingV1(gate, receipts, expectedCommit, trust) {
  validatePhase6RequirementsV1(trust?.phase6Requirements)
  const requirementsHash = sha256Canonical(trust.phase6Requirements)
  const publicKeyHash = typeof trust?.phase9PublicKey === 'string'
    ? phase10BytesHashV1(Buffer.from(trust.phase9PublicKey))
    : null
  const expectedPublicKeyHash = trust?.productionTrust === true
    ? PHASE6_EXPECTED_PUBLIC_KEY_HASH
    : trust?.testOnly === true ? trust.expectedPublicKeyHash : null
  if (requirementsHash !== PHASE6_EXPECTED_REQUIREMENTS_HASH
    || trust.expectedProducerCommit !== PHASE6_EXPECTED_PRODUCER_COMMIT
    || trust.expectedSigningKeyId !== PHASE6_EXPECTED_SIGNING_KEY_ID
    || publicKeyHash !== expectedPublicKeyHash
    || !Array.isArray(receipts) || receipts.length !== PHASE10_SHIPPED_DATASETS.length) {
    throw new Error('Invalid Phase 6 production trust anchors or receipt count')
  }
  const requirementByTarget = new Map(trust.phase6Requirements.targets.map((target) => [targetKey(target), target]))
  const verifiedChecks = receipts.map((receipt) => {
    const requirement = requirementByTarget.get(targetKey(receipt?.target))
    const receiptChecks = Array.isArray(receipt?.checks) ? receipt.checks : []
    const checkNames = receiptChecks.map((check) => check.name).sort()
    if (canonicalize(Object.keys(receipt ?? {}).sort()) !== canonicalize(PHASE6_ORIGINAL_RECEIPT_KEYS)
      || !requirement
      || !verifySignedReceipt(receipt, trust.phase9PublicKey, PHASE6_EXPECTED_SIGNING_KEY_ID)
      || !ORACLE_HASH.test(receipt.receiptHash)
      || !ORACLE_HASH.test(receipt.oracleBundleHash)
      || !ORACLE_HASH.test(receipt.candidateArtifactHash)
      || !ID.test(receipt.oracleLegacyRuntimeId)
      || !ID.test(receipt.candidateRuntimeId)
      || !Number.isFinite(Date.parse(receipt.judgedAt))
      || receipt.passed !== true
      || receipt.oracleGeneratorCommit !== PHASE6_EXPECTED_PRODUCER_COMMIT
      || receipt.candidateGeneratorCommit !== expectedCommit
      || receipt.judgeVersion !== PHASE6_EXPECTED_JUDGE_VERSION
      || canonicalize(receipt.oracleCoverage) !== canonicalize(requirement.coverage)
      || receiptChecks.length !== PHASE9_REQUIRED_RECEIPT_CHECKS.length
      || canonicalize(checkNames) !== canonicalize(PHASE9_REQUIRED_RECEIPT_CHECKS)
      || receiptChecks.some((check) => canonicalize(Object.keys(check ?? {}).sort())
        !== canonicalize(['mismatchPaths', 'name', 'passed'])
        || check.passed !== true || !Array.isArray(check.mismatchPaths)
        || check.mismatchPaths.length !== 0)) {
      throw new Error(`${receipt?.target?.datasetId ?? 'unknown'}: invalid original signed Phase 6 receipt`)
    }
    return {
      datasetId: receipt.target.datasetId,
      caseId: receipt.target.caseId,
      passed: true,
      receiptHash: receipt.receiptHash,
      oracleGeneratorCommit: receipt.oracleGeneratorCommit,
      candidateGeneratorCommit: receipt.candidateGeneratorCommit,
    }
  })
  const targetKeys = verifiedChecks.map(targetKey)
  const phase6GateKeys = [
    'checks', 'expectedCandidateCommit', 'expectedGeneratorCommit', 'passed',
    'requirementsHash', 'schemaVersion', 'signingKeyId',
  ].sort()
  if (canonicalize(Object.keys(gate ?? {}).sort()) !== canonicalize(phase6GateKeys)
    || gate?.schemaVersion !== 1
    || gate.passed !== true
    || gate.expectedGeneratorCommit !== PHASE6_EXPECTED_PRODUCER_COMMIT
    || gate.expectedCandidateCommit !== expectedCommit
    || gate.signingKeyId !== PHASE6_EXPECTED_SIGNING_KEY_ID
    || gate.requirementsHash !== PHASE6_EXPECTED_REQUIREMENTS_HASH
    || verifiedChecks.length !== requirementByTarget.size
    || new Set(targetKeys).size !== targetKeys.length
    || targetKeys.some((key) => !requirementByTarget.has(key))
    || canonicalize(sortedChecks(gate.checks ?? [])) !== canonicalize(sortedChecks(verifiedChecks))) {
    throw new Error('Phase 6 aggregate gate does not canonically match the three original signed receipts')
  }
  const binding = {
    gateReportHash: phase10HashV1(gate),
    requirementsHash,
    producerCommit: PHASE6_EXPECTED_PRODUCER_COMMIT,
    signingKeyId: PHASE6_EXPECTED_SIGNING_KEY_ID,
    publicKeyHash,
    judgeVersion: PHASE6_EXPECTED_JUDGE_VERSION,
    receipts: sortedChecks(verifiedChecks).map((check) => ({
      datasetId: check.datasetId,
      caseId: check.caseId,
      receiptHash: check.receiptHash,
    })),
  }
  assertPublicSafeV1(binding, 'Phase 6 oracle binding')
  return binding
}

export function phase9AdapterAmnesiaBindingV1(attestation, gate, receipts, expectedCommit, trust) {
  validatePhase9RequirementsV1(trust?.phase9Requirements)
  validatePhase10RecipePolicyV1(trust?.phase10Requirements)
  const phase9RequirementsHash = sha256Canonical(trust?.phase9Requirements)
  const phase10RequirementsHash = phase10HashV1(trust?.phase10Requirements)
  const publicKeyHash = typeof trust?.phase9PublicKey === 'string'
    ? phase10BytesHashV1(Buffer.from(trust.phase9PublicKey))
    : null
  if (phase9RequirementsHash !== PHASE9_EXPECTED_REQUIREMENTS_HASH
    || phase10RequirementsHash !== PHASE10_EXPECTED_REQUIREMENTS_HASH
    || trust?.expectedProducerCommit !== PHASE9_EXPECTED_PRODUCER_COMMIT
    || trust.expectedSigningKeyId !== PHASE9_EXPECTED_SIGNING_KEY_ID
    || typeof trust.phase9PublicKey !== 'string' || trust.phase9PublicKey.length === 0
    || (trust.productionTrust === true
      ? publicKeyHash !== PHASE9_EXPECTED_PUBLIC_KEY_HASH
        || trust.verifierToolClean !== true
        || !COMMIT.test(trust.verifierToolCommit)
        || !HASH.test(trust.verifierSourceTreeHash)
        || !HASH.test(trust.verifierClosureHash)
        || trust.verifierClosureVersion !== PHASE10_VERIFIER_CLOSURE_VERSION
        || !HASH.test(trust.verifierDependencyClosureHash)
        || !HASH.test(trust.verifierNodeRuntimeHash)
        || !HASH.test(trust.verifierTrustManifestHash)
        || !ID.test(trust.verifierTrustReviewId)
      : trust.testOnly !== true || publicKeyHash !== trust.expectedPublicKeyHash)) {
    throw new Error('Invalid Phase 9 production trust anchors')
  }
  if (!verifyAmnesiaAttestation(attestation, expectedCommit)) {
    throw new Error('Invalid Phase 9 Adapter Amnesia authoring attestation')
  }
  const authorBuildHashes = new Set(attestation.boundaryWitness?.cases?.map((entry) => entry.applicationBuildHash))
  if (authorBuildHashes.size !== 1 || !HASH.test([...authorBuildHashes][0])) {
    throw new Error('Phase 9 attestation does not bind one exact reviewed author build')
  }
  const authorApplicationBuildHash = [...authorBuildHashes][0]
  const phase10RequirementByDataset = new Map(
    trust.phase10Requirements.datasets.map((requirement) => [requirement.datasetId, requirement]),
  )
  for (const requirement of trust.phase9Requirements.targets) {
    const phase10Requirement = phase10RequirementByDataset.get(requirement.datasetId)
    if (phase10Requirement?.caseId !== requirement.caseId
      || canonicalize(phase10ReviewedCoverageV1(phase10Requirement)) !== canonicalize(requirement.coverage)) {
      throw new Error(`${requirement.datasetId}: Phase 9 and Phase 10 reviewed coverage do not match`)
    }
  }
  if (gate?.kind !== 'egolens-adapter-amnesia-gate-report' || gate.schemaVersion !== 1
    || gate.passed !== true || gate.expectedCandidateCommit !== expectedCommit
    || gate.expectedGeneratorCommit !== trust.expectedProducerCommit
    || gate.amnesiaAttestationHash !== attestation.attestationHash
    || gate.amnesiaBoundaryReportHash !== attestation.boundaryReportHash
    || gate.requirementsHash !== phase9RequirementsHash
    || gate.signingKeyId !== trust.expectedSigningKeyId
    || gate.judgeVersion !== PHASE9_EXPECTED_JUDGE_VERSION
    || !COMMIT.test(gate.judgeToolCommit)
    // The Phase 9 judge and the Phase 10 verifier must be the same reviewed
    // tool commit: a receipt signed by any other checkout is not evidence here.
    || gate.judgeToolCommit !== trust.verifierToolCommit) {
    throw new Error('Invalid or stale Phase 9 Adapter Amnesia gate report')
  }
  if (!Array.isArray(receipts) || receipts.length !== PHASE10_SHIPPED_DATASETS.length) {
    throw new Error('Exactly three signed Phase 9 receipts are required')
  }
  const requirementByTarget = new Map(trust.phase9Requirements.targets.map((target) => [targetKey(target), target]))
  const attestedByDataset = new Map(attestation.candidates.map((candidate) => [candidate.datasetId, candidate]))
  const verifiedChecks = receipts.map((receipt) => {
    const requirement = requirementByTarget.get(targetKey(receipt.target))
    const authored = attestedByDataset.get(receipt.target?.datasetId)
    const checkNames = (receipt.checks ?? []).map((check) => check.name).sort()
    const expectedRuntimeId = authored
      ? `egolens-amnesia-${expectedCommit}-${authored.recipeHash}`
      : null
    if (!requirement || authored?.caseId !== requirement.caseId
      || !verifySignedReceipt(receipt, trust.phase9PublicKey, trust.expectedSigningKeyId)
      || receipt.passed !== true
      || receipt.oracleGeneratorCommit !== trust.expectedProducerCommit
      || receipt.candidateGeneratorCommit !== expectedCommit
      || receipt.judgeVersion !== PHASE9_EXPECTED_JUDGE_VERSION
      || receipt.judgeToolCommit !== gate.judgeToolCommit
      || receipt.candidateRuntimeId !== expectedRuntimeId
      || receipt.candidateRecipeHash !== authored.recipeHash
      || receipt.amnesiaAttestationHash !== attestation.attestationHash
      || receipt.amnesiaBoundaryReportHash !== attestation.boundaryReportHash
      || !ORACLE_HASH.test(receipt.amnesiaBoundaryCaseArtifactHash)
      || receipt.amnesiaBoundarySourceMatched !== true
      || canonicalize(receipt.oracleCoverage) !== canonicalize(requirement.coverage)
      || receipt.checks?.length !== PHASE9_REQUIRED_RECEIPT_CHECKS.length
      || canonicalize(checkNames) !== canonicalize(PHASE9_REQUIRED_RECEIPT_CHECKS)
      || receipt.checks.some((check) => check.passed !== true)) {
      throw new Error(`${receipt.target?.datasetId ?? 'unknown'}: invalid signed Phase 9 receipt`)
    }
    return {
      datasetId: receipt.target.datasetId,
      caseId: receipt.target.caseId,
      passed: true,
      receiptHash: receipt.receiptHash,
      candidateRecipeHash: receipt.candidateRecipeHash,
      boundaryReportHash: receipt.amnesiaBoundaryReportHash,
      boundaryCaseArtifactHash: receipt.amnesiaBoundaryCaseArtifactHash,
    }
  })
  const verifiedDatasets = verifiedChecks.map((check) => check.datasetId).sort()
  if (canonicalize(verifiedDatasets) !== canonicalize([...PHASE10_SHIPPED_DATASETS].sort())
    || new Set(verifiedChecks.map((check) => check.receiptHash)).size !== verifiedChecks.length
    || new Set(verifiedChecks.map((check) => check.boundaryCaseArtifactHash)).size !== verifiedChecks.length
    || canonicalize(sortedChecks(gate.checks ?? [])) !== canonicalize(sortedChecks(verifiedChecks))) {
    throw new Error('Phase 9 aggregate gate does not match the three verified signed receipts')
  }
  const recipeBindings = sortedChecks(verifiedChecks).map((check) => ({
    datasetId: check.datasetId,
    caseId: check.caseId,
    recipeHash: check.candidateRecipeHash,
    receiptHash: check.receiptHash,
    boundaryReportHash: check.boundaryReportHash,
    boundaryCaseArtifactHash: check.boundaryCaseArtifactHash,
  }))
  const binding = {
    attestationHash: attestation.attestationHash,
    boundaryReportHash: attestation.boundaryReportHash,
    gateReportHash: phase10HashV1(gate),
    phase9RequirementsHash,
    phase10RequirementsHash,
    producerCommit: trust.expectedProducerCommit,
    signingKeyId: trust.expectedSigningKeyId,
    publicKeyHash,
    judgeVersion: PHASE9_EXPECTED_JUDGE_VERSION,
    judgeToolCommit: gate.judgeToolCommit,
    verifierId: PHASE10_VERIFIER_ID,
    verifierToolCommit: trust.verifierToolCommit,
    verifierSourceTreeHash: trust.verifierSourceTreeHash,
    verifierClosureHash: trust.verifierClosureHash,
    verifierClosureVersion: trust.verifierClosureVersion,
    verifierDependencyClosureHash: trust.verifierDependencyClosureHash,
    verifierNodeRuntimeHash: trust.verifierNodeRuntimeHash,
    verifierTrustManifestHash: trust.verifierTrustManifestHash,
    verifierTrustReviewId: trust.verifierTrustReviewId,
    verifierRequirement: PHASE10_VERIFIER_REQUIREMENT,
    trustAnchorSetHash: PHASE10_TRUST_ANCHOR_SET_HASH,
    authorApplicationBuildHash,
    recipeBindings,
  }
  assertPublicSafeV1(binding, 'Phase 9 Adapter Amnesia binding')
  return binding
}

export function validatePhase10RecipePolicyV1(requirements) {
  const expected = {
    source: 'verified-phase9-adapter-amnesia-gate',
    requireExactCandidateCommit: true,
    requireAuthorAttestation: true,
    requireSignedReceipts: true,
  }
  const datasets = requirements?.datasets ?? []
  if (requirements?.kind !== 'egolens-phase10-preflight-requirements' || requirements.schemaVersion !== 1
    || canonicalize(requirements.recipePolicy) !== canonicalize(expected)
    || datasets.length !== PHASE10_SHIPPED_DATASETS.length
    || canonicalize(datasets.map((dataset) => dataset.datasetId).sort())
      !== canonicalize([...PHASE10_SHIPPED_DATASETS].sort())
    || new Set(datasets.map((dataset) => dataset.datasetId)).size !== datasets.length
    || datasets.some((dataset) => !ID.test(dataset.caseId) || Object.hasOwn(dataset, 'recipeHash'))) {
    throw new Error('Phase 10 recipes must come only from the verified Phase 9 author-attested gate')
  }
  for (const requirement of datasets) phase10ReviewedCoverageV1(requirement)
  const reviewed = datasets.map((requirement) => ({
    datasetId: requirement.datasetId,
    caseId: requirement.caseId,
    coverage: phase10ReviewedCoverageV1(requirement),
  })).sort((left, right) => left.datasetId.localeCompare(right.datasetId, 'en'))
  const expectedReviewed = [...PHASE10_REVIEWED_BASELINE_V1]
    .sort((left, right) => left.datasetId.localeCompare(right.datasetId, 'en'))
  if (canonicalize(reviewed) !== canonicalize(expectedReviewed)) {
    throw new Error('Phase 10 reviewed dataset coverage differs from the immutable baseline')
  }
  return true
}

function without(value, key) {
  const { [key]: _removed, ...payload } = value
  return payload
}

function assertHash(value, label) {
  if (!HASH.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`)
}

function assertCommit(value, label) {
  if (!COMMIT.test(value)) throw new Error(`${label} must be a full lowercase Git commit`)
}

function assertIntegrity(value, key, label) {
  assertHash(value?.[key], `${label}.${key}`)
  if (phase10HashV1(without(value, key)) !== value[key]) throw new Error(`${label}: ${key} mismatch`)
}

function assertSortedUnique(values, label) {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && values[index - 1] >= values[index]) {
      throw new Error(`${label} must be strictly sorted and unique`)
    }
  }
}

function assertSameMembers(left, right, label) {
  if (canonicalize([...left].sort()) !== canonicalize([...right].sort())) {
    throw new Error(`${label} do not match`)
  }
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function assertSafePublicUrlV1(raw, label, { allowLoopbackHttp = false, requireOrigin = false } = {}) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (url.username || url.password) throw new Error(`${label} must not contain user-info`)
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(`${label} must use HTTPS${allowLoopbackHttp ? ' outside loopback' : ''}`)
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEY.test(key) || /^X-(?:Amz|Goog)-/iu.test(key)) {
      throw new Error(`${label} contains a credential-bearing query key`)
    }
  }
  if (requireOrigin && (url.pathname !== '/' || url.search || url.hash)) {
    throw new Error(`${label} must be an exact origin`)
  }
  return url
}

export function normalizeContentBlindPathV1(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    throw new Error('Source path must be a non-empty bounded string')
  }
  if (raw.includes('\\') || raw.startsWith('/') || WINDOWS_ABSOLUTE.test(raw) || UNC_PATH.test(raw)) {
    throw new Error(`Source path is absolute or non-portable: ${raw}`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(raw)) throw new Error(`Source path contains a control character: ${raw}`)
  const segments = raw.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Source path is not canonical: ${raw}`)
  }
  return raw.normalize('NFC')
}

export function publicSafetyViolationsV1(value) {
  const violations = []
  const visit = (entry, pointer) => {
    if (typeof entry === 'string') {
      if (PRIVATE_MARKER.test(entry)) violations.push(`${pointer}: private key material`)
      if (entry.startsWith('file:') || entry.startsWith('data:') || entry.startsWith('blob:')) {
        violations.push(`${pointer}: non-public URI`)
      } else if (entry.startsWith('/') || WINDOWS_ABSOLUTE.test(entry) || UNC_PATH.test(entry)) {
        violations.push(`${pointer}: absolute local path`)
      } else if (/^https?:/u.test(entry)) {
        try {
          const url = new URL(entry)
          if (url.username || url.password) violations.push(`${pointer}: URL user-info`)
          for (const key of url.searchParams.keys()) {
            if (SECRET_QUERY_KEY.test(key) || /^X-(?:Amz|Goog)-/iu.test(key)) {
              violations.push(`${pointer}: credential-bearing query key`)
            }
          }
        } catch {
          violations.push(`${pointer}: malformed URL`)
        }
      }
      return
    }
    if (!entry || typeof entry !== 'object') return
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${pointer}/${index}`))
      return
    }
    for (const [key, child] of Object.entries(entry)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) violations.push(`${pointer}/${key}: forbidden raw/private field`)
      visit(child, `${pointer}/${key}`)
    }
  }
  visit(value, '')
  return violations
}

export function assertPublicSafeV1(value, label = 'public evidence') {
  const violations = publicSafetyViolationsV1(value)
  if (violations.length > 0) throw new Error(`${label} is not public-safe: ${violations.join('; ')}`)
}

export function sourceManifestHashFromFilesV1(files) {
  return phase10HashV1({
    version: 1,
    entries: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  })
}

export function sourceCaseManifestPayloadV1(manifest) {
  return without(manifest, 'manifestHash')
}

export function validateSourceCaseManifestSemanticsV1(manifest) {
  if (manifest?.schema !== 'egolens-source-case-manifest-v1') throw new Error('Invalid source case manifest schema')
  validatePhase10VerifierBindingV1(manifest.verifierBinding)
  assertSafePublicUrlV1(manifest.release.officialSourceUrl, 'release.officialSourceUrl')
  if (manifest.case.role === 'reserve' ? manifest.case.reserveFor === null : manifest.case.reserveFor !== null) {
    throw new Error('Only reserve cases declare reserveFor')
  }
  const paths = []
  let totalBytes = 0
  for (const file of manifest.files) {
    const normalized = normalizeContentBlindPathV1(file.path)
    if (normalized !== file.path) throw new Error(`Source path is not NFC canonical: ${file.path}`)
    if (!Number.isSafeInteger(file.size)) throw new Error(`Unsafe file size: ${file.path}`)
    assertHash(file.sha256, `files[${file.path}].sha256`)
    paths.push(file.path)
    totalBytes += file.size
    if (!Number.isSafeInteger(totalBytes)) throw new Error('Source case total byte count is unsafe')
  }
  assertSortedUnique(paths, 'Source case paths')
  if (manifest.aggregate.fileCount !== manifest.files.length || manifest.aggregate.totalBytes !== totalBytes) {
    throw new Error('Source case aggregate mismatch')
  }
  if (sourceManifestHashFromFilesV1(manifest.files) !== manifest.sourceManifestHash) {
    throw new Error('Source case sourceManifestHash mismatch')
  }
  assertIntegrity(manifest, 'manifestHash', 'source case manifest')
  return true
}

export function validateCaseReserveManifestSemanticsV1(manifest) {
  if (manifest?.schema !== 'egolens-case-reserve-manifest-v1') throw new Error('Invalid case reserve manifest schema')
  validatePhase10VerifierBindingV1(manifest.verifierBinding)
  assertSafePublicUrlV1(manifest.officialSourceUrl, 'officialSourceUrl')
  const ids = new Set()
  const manifestHashes = new Set()
  const roleCounts = { D: 0, A: 0, B: 0, reserve: 0 }
  for (const [index, entry] of manifest.cases.entries()) {
    if (entry.order !== index) throw new Error('Case reserve order must be contiguous and canonical')
    if (ids.has(entry.caseId) || manifestHashes.has(entry.sourceCaseManifestHash)) {
      throw new Error('Case reserve entries must be distinct')
    }
    if (entry.role === 'reserve' ? entry.reserveFor === null : entry.reserveFor !== null) {
      throw new Error('Only reserve entries declare reserveFor')
    }
    ids.add(entry.caseId)
    manifestHashes.add(entry.sourceCaseManifestHash)
    roleCounts[entry.role] += 1
  }
  if (roleCounts.D !== 1 || roleCounts.A !== 1 || roleCounts.B !== 1 || roleCounts.reserve < 1) {
    throw new Error('Case reserve manifest requires exactly one D/A/B and at least one reserve')
  }
  if (manifest.cases[0].role !== 'D' || manifest.cases[1].role !== 'A' || manifest.cases[2].role !== 'B') {
    throw new Error('Case reserve manifest must order D, A, B before reserves')
  }
  assertIntegrity(manifest, 'manifestHash', 'case reserve manifest')
  assertPublicSafeV1(manifest, 'case reserve manifest')
  return true
}

export function humanReviewPayloadV1(review) {
  return without(review, 'receiptHash')
}

export function validateHumanReviewSemanticsV1(review) {
  if (review.rejectedRecipeHash === review.correctedRecipeHash) {
    throw new Error('Human review correction must change the semantic recipe hash')
  }
  if (!review.lastGoodScenePreserved) throw new Error('Human review must attest last-good-scene preservation')
  assertIntegrity(review, 'receiptHash', 'human review receipt')
  return true
}

function validateRevisionLineage(lineage, finalRecipeHash) {
  const seen = new Set()
  for (const [index, revision] of lineage.entries()) {
    if (seen.has(revision.revisionId)) throw new Error('Revision IDs must be unique')
    if (index === 0) {
      if (revision.parentRevisionId !== null) throw new Error('First revision parent must be null')
    } else if (!seen.has(revision.parentRevisionId)) {
      throw new Error('Revision parent must reference an earlier revision')
    }
    seen.add(revision.revisionId)
  }
  if (lineage.at(-1)?.recipeHash !== finalRecipeHash) throw new Error('Final lineage recipe hash mismatch')
}

export function validateGeneralizationAttemptSemanticsV1(attempt) {
  if (attempt?.schema !== 'egolens-generalization-attempt-v1') throw new Error('Invalid generalization attempt schema')
  validatePhase10VerifierBindingV1(attempt.verifierBinding)
  assertCommit(attempt.application.commit, 'application.commit')
  assertSafePublicUrlV1(attempt.application.deployedUrlIdentity, 'application.deployedUrlIdentity', { allowLoopbackHttp: true })
  assertIntegrity(attempt, 'attemptHash', 'generalization attempt')
  assertPublicSafeV1(attempt, 'generalization attempt')
  if (Date.parse(attempt.browserProcess.stoppedAt) < Date.parse(attempt.browserProcess.startedAt)) {
    throw new Error('Browser process stop precedes start')
  }
  const persisted = attempt.phase === 'B-persisted-local'
  if (persisted) {
    if (attempt.browserProcess.profileMode !== 'persisted-origin'
      || attempt.browserProcess.userDataDirectoryCreatedFresh
      || attempt.browserProcess.userDataDirectoryRemoved) {
      throw new Error('Persisted-local B must use and retain the persisted origin profile')
    }
  } else if (attempt.browserProcess.profileMode !== 'empty'
    || !attempt.browserProcess.userDataDirectoryCreatedFresh
    || !attempt.browserProcess.userDataDirectoryRemoved) {
    throw new Error('Every non-persisted attempt must use a removed empty profile')
  }
  const isRemote = attempt.phase === 'B-remote-share'
  if (isRemote) {
    if (attempt.transport.mode !== 'remote' || !attempt.transport.catalogHash
      || !attempt.transport.shareDescriptorHash || !attempt.transport.shareUrlHash) {
      throw new Error('Remote-share B requires catalog, descriptor, and URL identities')
    }
    if (attempt.isolation.networkPolicy.mode !== 'exact-origins'
      || attempt.isolation.networkPolicy.allowedOrigins.length === 0) {
      throw new Error('Remote-share B requires an exact-origin network policy')
    }
    for (const origin of attempt.isolation.networkPolicy.allowedOrigins) {
      assertSafePublicUrlV1(origin, 'networkPolicy.allowedOrigins', { allowLoopbackHttp: true, requireOrigin: true })
    }
  } else {
    if (attempt.transport.mode !== 'local' || attempt.transport.catalogHash
      || attempt.transport.shareDescriptorHash || attempt.transport.shareUrlHash) {
      throw new Error('Local attempts must not carry remote transport identities')
    }
    if (attempt.isolation.networkPolicy.mode !== 'disabled'
      || attempt.isolation.networkPolicy.allowedOrigins.length !== 0) {
      throw new Error('Local authoring and reuse attempts require disabled network egress')
    }
  }
  const isB = attempt.phase.startsWith('B-')
  const totalToolCalls = attempt.isolation.toolCalls.reduce((sum, entry) => sum + entry.count, 0)
  if (isB && (attempt.isolation.agentCalls !== 0 || totalToolCalls !== 0)) {
    throw new Error('Every B run must have zero agent and public-tool calls')
  }
  if (attempt.phase === 'D' && attempt.isolation.agentCalls !== 0) {
    throw new Error('Discovery is not an agent-authored run')
  }
  if (attempt.phase === 'A') {
    assertSameMembers(attempt.isolation.publicTools, PHASE10_PUBLIC_TOOLS, 'A public tool catalog')
    if (attempt.result.passed && !attempt.humanReview) throw new Error('Passing A requires human review')
    if (attempt.humanReview) {
      validateHumanReviewSemanticsV1(attempt.humanReview)
      if (attempt.humanReview.correctedRecipeHash !== attempt.fingerprints.recipeHash) {
        throw new Error('Human-corrected recipe must be the finalized attempt recipe')
      }
    }
  } else if (attempt.humanReview !== null) {
    throw new Error('Only A may carry a human-review receipt')
  }
  validateRevisionLineage(attempt.revisionLineage, attempt.fingerprints.recipeHash)
  if (attempt.result.passed) {
    if (attempt.firstFailure !== null) throw new Error('A passing attempt cannot reference a first failure')
    assertSameMembers(attempt.capabilities.declared, attempt.capabilities.bound, 'Declared and bound capabilities')
  } else if (attempt.firstFailure === null) {
    throw new Error('A failed attempt must preserve a first-failure artifact')
  }
  return true
}

export function validateFirstFailureSemanticsV1(artifact) {
  if (artifact?.schema !== 'egolens-first-failure-v1') throw new Error('Invalid first-failure schema')
  validatePhase10VerifierBindingV1(artifact.verifierBinding)
  assertCommit(artifact.applicationCommit, 'applicationCommit')
  assertIntegrity(artifact, 'artifactHash', 'first-failure artifact')
  assertPublicSafeV1(artifact, 'first-failure artifact')
  return true
}

export function validatePreflightModeObservationSemanticsV1(observation) {
  if (observation?.schema !== 'egolens-preflight-mode-observation-v1') {
    throw new Error('Invalid preflight mode observation schema')
  }
  validatePhase10VerifierBindingV1(observation.verifierBinding)
  assertCommit(observation.candidateCommit, 'candidateCommit')
  assertHash(observation.sourceTreeHash, 'sourceTreeHash')
  assertHash(observation.productionBuildInventoryHash, 'productionBuildInventoryHash')
  assertIntegrity(observation, 'observationHash', 'preflight mode observation')
  assertPublicSafeV1(observation, 'preflight mode observation')
  assertSortedUnique(observation.capabilities, 'Preflight capabilities')
  if (observation.coverageHash !== phase10HashV1(observation.coverage)
    || canonicalize(observation.capabilities) !== canonicalize(observation.coverage.requiredCapabilities)) {
    throw new Error('Preflight reviewed coverage identity mismatch')
  }
  if (observation.capabilityHash !== phase10HashV1(observation.capabilities)) {
    throw new Error('Preflight capabilityHash mismatch')
  }
  const processPayload = without(observation.browserProcess, 'evidenceHash')
  if (observation.browserProcess.evidenceHash !== phase10HashV1(processPayload)
    || !observation.browserProcess.processExitObserved
    || !observation.browserProcess.userDataDirectoryCreatedFresh
    || !observation.browserProcess.userDataDirectoryRemoved
    || observation.browserProcess.profileMode !== 'empty'
    || Date.parse(observation.browserProcess.stoppedAt) < Date.parse(observation.browserProcess.startedAt)) {
    throw new Error('Preflight mode lacks valid fresh-process evidence')
  }
  if (!observation.noAgent || !observation.emptyProfile || !observation.paused || !observation.passed) {
    throw new Error('Preflight mode must be a passing, paused, no-agent empty-profile run')
  }
  if (observation.mode === 'local' && (observation.catalogHash || observation.shareDescriptorHash)) {
    throw new Error('Local preflight observation cannot carry remote identities')
  }
  if (observation.mode === 'remote' && (!observation.catalogHash || observation.shareDescriptorHash)) {
    throw new Error('Remote preflight observation requires only a catalog identity')
  }
  if (observation.mode === 'share' && (!observation.catalogHash || !observation.shareDescriptorHash)) {
    throw new Error('Share preflight observation requires catalog and descriptor identities')
  }
  return true
}

function validateLedgerEventSemantics(entry) {
  if (entry.event === 'first-failure' && !entry.firstFailureHash) throw new Error('first-failure event requires firstFailureHash')
  if (entry.event === 'failure-classified' && (!entry.firstFailureHash || !entry.classification)) {
    throw new Error('failure-classified event requires failure and classification')
  }
  if (entry.event === 'generic-change-chosen'
    && (!entry.firstFailureHash || !entry.classification || !entry.chosenLayer || !entry.genericChangeCommit)) {
    throw new Error('generic-change-chosen event requires failure, classification, layer, and commit')
  }
  if (entry.event === 'case-consumed' && !entry.consumedCaseIdHash) throw new Error('case-consumed event requires a case identity hash')
  if (entry.event === 'replacement-selected' && !entry.replacementCaseManifestHash) {
    throw new Error('replacement-selected event requires a replacement manifest hash')
  }
  if (entry.event === 'regression-result' && entry.regressionEvidenceHashes.length === 0) {
    throw new Error('regression-result event requires evidence')
  }
  if (entry.event === 'attempt-retained' && !entry.attemptHash) throw new Error('attempt-retained event requires attemptHash')
}

export function validateDecisionLedgerV1(entries) {
  let previous = null
  let ledgerId = null
  let verifierBindingHash = null
  for (const [index, entry] of entries.entries()) {
    if (entry?.schema !== 'egolens-decision-ledger-entry-v1') throw new Error(`Ledger entry ${index} has the wrong schema`)
    if (entry.sequence !== index || entry.previousEntryHash !== previous) throw new Error(`Ledger entry ${index} breaks the append-only chain`)
    if (ledgerId === null) ledgerId = entry.ledgerId
    if (entry.ledgerId !== ledgerId) throw new Error(`Ledger entry ${index} changes ledgerId`)
    validatePhase10VerifierBindingV1(entry.verifierBinding)
    const currentVerifierBindingHash = phase10HashV1(entry.verifierBinding)
    if (verifierBindingHash === null) verifierBindingHash = currentVerifierBindingHash
    if (currentVerifierBindingHash !== verifierBindingHash) {
      throw new Error(`Ledger entry ${index} changes the reviewed verifier binding`)
    }
    assertIntegrity(entry, 'entryHash', `ledger entry ${index}`)
    assertPublicSafeV1(entry, `ledger entry ${index}`)
    validateLedgerEventSemantics(entry)
    previous = entry.entryHash
  }
  return { ledgerId, length: entries.length, ledgerHash: previous }
}

export function createDecisionLedgerEntryV1(entries, payload) {
  const chain = validateDecisionLedgerV1(entries)
  const entryPayload = {
    schema: 'egolens-decision-ledger-entry-v1',
    verifierBinding: payload.verifierBinding,
    ledgerId: payload.ledgerId ?? chain.ledgerId,
    sequence: entries.length,
    previousEntryHash: chain.ledgerHash,
    event: payload.event,
    occurredAt: payload.occurredAt,
    sourceCaseManifestHash: payload.sourceCaseManifestHash ?? null,
    attemptHash: payload.attemptHash ?? null,
    firstFailureHash: payload.firstFailureHash ?? null,
    classification: payload.classification ?? null,
    chosenLayer: payload.chosenLayer ?? null,
    genericChangeCommit: payload.genericChangeCommit ?? null,
    consumedCaseIdHash: payload.consumedCaseIdHash ?? null,
    replacementCaseManifestHash: payload.replacementCaseManifestHash ?? null,
    regressionEvidenceHashes: payload.regressionEvidenceHashes ?? [],
    detailsHash: payload.detailsHash,
  }
  if (!entryPayload.ledgerId) throw new Error('First ledger entry requires ledgerId')
  const entry = { ...entryPayload, entryHash: phase10HashV1(entryPayload) }
  validateDecisionLedgerV1([...entries, entry])
  return entry
}

function validateModeEvidence(mode, dataset) {
  validatePhase10VerifierBindingV1(mode.verifierBinding)
  assertHash(mode.browserBoundaryHash, `${dataset.datasetId}/${mode.mode}.browserBoundaryHash`)
  if (phase10HashV1(mode.verifierBinding) !== phase10HashV1(dataset.verifierBinding)
    || mode.sourceTreeHash !== dataset.sourceTreeHash
    || mode.productionBuildInventoryHash !== dataset.productionBuildInventoryHash
    || mode.sourceManifestHash !== dataset.sourceManifestHash
    || mode.recipeHash !== dataset.recipeHash
    || mode.formatFingerprint !== dataset.formatFingerprint
    || mode.operatorSetFingerprint !== dataset.operatorSetFingerprint
    || mode.coverageHash !== dataset.coverageHash) {
    throw new Error(`${dataset.datasetId}/${mode.mode}: identity drift`)
  }
  if (!mode.noAgent || !mode.passed) throw new Error(`${dataset.datasetId}/${mode.mode}: baseline proof must pass without an agent`)
  if (!mode.emptyProfile) {
    throw new Error(`${dataset.datasetId}/${mode.mode}: baseline proof must use an empty profile`)
  }
  if (mode.mode === 'local' && (mode.catalogHash || mode.shareDescriptorHash)) {
    throw new Error(`${dataset.datasetId}: local proof has remote/share state`)
  }
  if (mode.mode === 'remote' && (!mode.catalogHash || mode.shareDescriptorHash)) {
    throw new Error(`${dataset.datasetId}: remote proof has invalid catalog/share state`)
  }
  if (mode.mode === 'share' && (!mode.catalogHash || !mode.shareDescriptorHash || !mode.emptyProfile || !mode.paused)) {
    throw new Error(`${dataset.datasetId}: share proof is not a paused empty-profile restore`)
  }
}

export function validateDatasetBaselineEvidenceV1(dataset, candidateCommit) {
  validatePhase10VerifierBindingV1(dataset.verifierBinding)
  if (dataset.candidateCommit !== candidateCommit) throw new Error(`${dataset.datasetId}: stale candidate commit`)
  assertHash(dataset.sourceTreeHash, `${dataset.datasetId}.sourceTreeHash`)
  assertHash(dataset.productionBuildInventoryHash, `${dataset.datasetId}.productionBuildInventoryHash`)
  if (dataset.coverageHash !== phase10HashV1(dataset.coverage)
    || canonicalize(dataset.capabilities) !== canonicalize(dataset.coverage.requiredCapabilities)) {
    throw new Error(`${dataset.datasetId}: reviewed coverage identity mismatch`)
  }
  if (dataset.local.mode !== 'local' || dataset.remote.mode !== 'remote' || dataset.share.mode !== 'share') {
    throw new Error(`${dataset.datasetId}: incomplete local/remote/share matrix`)
  }
  for (const mode of [dataset.local, dataset.remote, dataset.share]) validateModeEvidence(mode, dataset)
  if (new Set([dataset.local.browserRunHash, dataset.remote.browserRunHash, dataset.share.browserRunHash]).size !== 3) {
    throw new Error(`${dataset.datasetId}: preflight modes reused a browser process`)
  }
  for (const key of [
    'capabilityHash', 'structuralHash', 'numericHash', 'rendererFrameHash', 'perceptualAlgorithm',
    'perceptualHash', 'presentationHash',
  ]) {
    if (dataset.local[key] !== dataset.remote[key] || dataset.local[key] !== dataset.share[key]) {
      throw new Error(`${dataset.datasetId}: ${key} parity failed`)
    }
  }
  if (dataset.remote.catalogHash !== dataset.share.catalogHash) throw new Error(`${dataset.datasetId}: catalog identity drift`)
  assertIntegrity(dataset, 'evidenceHash', `${dataset.datasetId} baseline evidence`)
}

export function validatePhase10BaselineFreezeSemanticsV1(freeze, expectedCommit) {
  if (freeze?.schema !== 'egolens-phase10-baseline-freeze-v1') throw new Error('Invalid Phase 10 baseline freeze schema')
  assertCommit(freeze.candidateCommit, 'candidateCommit')
  if (expectedCommit && freeze.candidateCommit !== expectedCommit) throw new Error('Baseline freeze is for a different commit')
  if (freeze.requirementsHash !== PHASE10_EXPECTED_REQUIREMENTS_HASH) {
    throw new Error('Baseline freeze does not use the exact reviewed Phase 10 requirements')
  }
  for (const [key, value] of [
    ['sourceTreeHash', freeze.sourceTreeHash],
    ['productionBuildInventoryHash', freeze.productionBuildInventoryHash],
    ['authorBuildInventoryHash', freeze.authorBuildInventoryHash],
    ['buildBoundaryReportHash', freeze.buildBoundaryReportHash],
  ]) assertHash(value, key)
  const verifierBinding = freeze.verifierBinding
  if (verifierBinding?.verifierId !== PHASE10_VERIFIER_ID
    || !COMMIT.test(verifierBinding?.verifierToolCommit)
    || !HASH.test(verifierBinding?.verifierSourceTreeHash)
    || !HASH.test(verifierBinding?.verifierClosureHash)
    || verifierBinding?.verifierClosureVersion !== PHASE10_VERIFIER_CLOSURE_VERSION
    || !HASH.test(verifierBinding?.verifierDependencyClosureHash)
    || !HASH.test(verifierBinding?.verifierNodeRuntimeHash)
    || !HASH.test(verifierBinding?.verifierTrustManifestHash)
    || !ID.test(verifierBinding?.verifierTrustReviewId)
    || verifierBinding?.verifierRequirement !== PHASE10_VERIFIER_REQUIREMENT) {
    throw new Error('Baseline freeze lacks an exact externally reviewed verifier binding')
  }
  const phase6Receipts = freeze.phase6Binding?.receipts
  const reviewedCaseByDataset = new Map(PHASE10_REVIEWED_BASELINE_V1.map((entry) => [entry.datasetId, entry.caseId]))
  if (freeze.phase6Binding?.requirementsHash !== PHASE6_EXPECTED_REQUIREMENTS_HASH
    || freeze.phase6Binding?.producerCommit !== PHASE6_EXPECTED_PRODUCER_COMMIT
    || freeze.phase6Binding?.signingKeyId !== PHASE6_EXPECTED_SIGNING_KEY_ID
    || freeze.phase6Binding?.publicKeyHash !== PHASE6_EXPECTED_PUBLIC_KEY_HASH
    || freeze.phase6Binding?.judgeVersion !== PHASE6_EXPECTED_JUDGE_VERSION
    || !HASH.test(freeze.phase6Binding?.gateReportHash)
    || !Array.isArray(phase6Receipts)
    || phase6Receipts.length !== PHASE10_SHIPPED_DATASETS.length
    || new Set(phase6Receipts.map((entry) => entry.receiptHash)).size !== phase6Receipts.length
    || canonicalize(phase6Receipts.map((entry) => entry.datasetId).sort())
      !== canonicalize([...PHASE10_SHIPPED_DATASETS].sort())
    || phase6Receipts.some((entry) => reviewedCaseByDataset.get(entry.datasetId) !== entry.caseId
      || !ORACLE_HASH.test(entry.receiptHash))
    || freeze.gates.oracleReceipts.evidenceHash !== freeze.phase6Binding.gateReportHash) {
    throw new Error('Baseline freeze is not bound to exactly three original signed Phase 6 receipts')
  }
  const datasetIds = freeze.datasets.map((dataset) => dataset.datasetId).sort()
  if (canonicalize(datasetIds) !== canonicalize([...PHASE10_SHIPPED_DATASETS].sort())) {
    throw new Error('Baseline freeze requires exact Waymo/nuScenes/Argoverse 2 coverage')
  }
  const reviewedByDataset = new Map(PHASE10_REVIEWED_BASELINE_V1.map((entry) => [entry.datasetId, entry]))
  for (const dataset of freeze.datasets) {
    validateDatasetBaselineEvidenceV1(dataset, freeze.candidateCommit)
    const reviewed = reviewedByDataset.get(dataset.datasetId)
    if (dataset.caseId !== reviewed?.caseId
      || canonicalize(dataset.coverage) !== canonicalize(reviewed.coverage)) {
      throw new Error(`${dataset.datasetId}: baseline evidence does not contain exact reviewed coverage`)
    }
    if (phase10HashV1(dataset.verifierBinding) !== phase10HashV1(verifierBinding)
      || dataset.sourceTreeHash !== freeze.sourceTreeHash
      || dataset.productionBuildInventoryHash !== freeze.productionBuildInventoryHash) {
      throw new Error(`${dataset.datasetId}: baseline evidence is not bound to the frozen production build`)
    }
  }
  const phase9Recipes = freeze.phase9Binding?.recipeBindings
  if (!Array.isArray(phase9Recipes)) throw new Error('Baseline freeze is missing its Phase 9 recipe binding')
  const phase9ByDataset = new Map(phase9Recipes.map((entry) => [entry.datasetId, entry]))
  if (!ORACLE_HASH.test(freeze.phase9Binding.attestationHash)
    || !ORACLE_HASH.test(freeze.phase9Binding.boundaryReportHash)
    || !HASH.test(freeze.phase9Binding.gateReportHash)
    || !ORACLE_HASH.test(freeze.phase9Binding.phase9RequirementsHash)
    || freeze.phase9Binding.phase9RequirementsHash !== PHASE9_EXPECTED_REQUIREMENTS_HASH
    || freeze.phase9Binding.phase10RequirementsHash !== PHASE10_EXPECTED_REQUIREMENTS_HASH
    || freeze.phase9Binding.producerCommit !== PHASE9_EXPECTED_PRODUCER_COMMIT
    || !ID.test(freeze.phase9Binding.signingKeyId)
    || freeze.phase9Binding.signingKeyId !== PHASE9_EXPECTED_SIGNING_KEY_ID
    || freeze.phase9Binding.publicKeyHash !== PHASE9_EXPECTED_PUBLIC_KEY_HASH
    || freeze.phase9Binding.judgeVersion !== PHASE9_EXPECTED_JUDGE_VERSION
    || !COMMIT.test(freeze.phase9Binding.judgeToolCommit)
    || freeze.phase9Binding.judgeToolCommit !== verifierBinding.verifierToolCommit
    || freeze.phase9Binding.verifierId !== PHASE10_VERIFIER_ID
    || !COMMIT.test(freeze.phase9Binding.verifierToolCommit)
    || freeze.phase9Binding.verifierToolCommit !== verifierBinding.verifierToolCommit
    || freeze.phase9Binding.verifierSourceTreeHash !== verifierBinding.verifierSourceTreeHash
    || freeze.phase9Binding.verifierClosureHash !== verifierBinding.verifierClosureHash
    || freeze.phase9Binding.verifierClosureVersion !== verifierBinding.verifierClosureVersion
    || freeze.phase9Binding.verifierDependencyClosureHash !== verifierBinding.verifierDependencyClosureHash
    || freeze.phase9Binding.verifierNodeRuntimeHash !== verifierBinding.verifierNodeRuntimeHash
    || freeze.phase9Binding.verifierTrustManifestHash !== verifierBinding.verifierTrustManifestHash
    || freeze.phase9Binding.verifierTrustReviewId !== verifierBinding.verifierTrustReviewId
    || freeze.phase9Binding.verifierRequirement !== PHASE10_VERIFIER_REQUIREMENT
    || freeze.phase9Binding.trustAnchorSetHash !== PHASE10_TRUST_ANCHOR_SET_HASH
    || phase9ByDataset.size !== PHASE10_SHIPPED_DATASETS.length
    || new Set(phase9Recipes.map((entry) => entry.receiptHash)).size !== phase9Recipes.length
    || new Set(phase9Recipes.map((entry) => entry.boundaryCaseArtifactHash)).size !== phase9Recipes.length
    || canonicalize([...phase9ByDataset.keys()].sort()) !== canonicalize([...PHASE10_SHIPPED_DATASETS].sort())
    || freeze.gates.adapterAmnesia.evidenceHash !== freeze.phase9Binding.gateReportHash) {
    throw new Error('Baseline freeze is not bound to one exact Phase 9 signed gate')
  }
  for (const dataset of freeze.datasets) {
    const binding = phase9ByDataset.get(dataset.datasetId)
    if (binding?.caseId !== dataset.caseId || binding.recipeHash !== dataset.recipeHash
      || binding.boundaryReportHash !== freeze.phase9Binding.boundaryReportHash
      || !ORACLE_HASH.test(binding.boundaryCaseArtifactHash)
      || !ORACLE_HASH.test(binding.receiptHash)) {
      throw new Error(`${dataset.datasetId}: baseline recipe is not bound to its Phase 9 signed receipt`)
    }
  }
  const browserRuns = freeze.datasets.flatMap((dataset) => [
    dataset.local.browserRunHash, dataset.remote.browserRunHash, dataset.share.browserRunHash,
  ])
  if (new Set(browserRuns).size !== browserRuns.length) {
    throw new Error('Baseline freeze reused a browser process across dataset modes')
  }
  const negativeIds = freeze.gates.negativeCases.map((entry) => entry.id).sort()
  if (canonicalize(negativeIds) !== canonicalize([...PHASE10_REQUIRED_NEGATIVE_CASES].sort())) {
    throw new Error('Baseline freeze negative coverage is incomplete or duplicated')
  }
  const gateValues = Object.entries(freeze.gates).filter(([key]) => key !== 'negativeCases' && key !== 'evidenceHarness')
  if (freeze.gates.productionBuild.evidenceHash !== freeze.productionBuildInventoryHash
    || freeze.gates.authorBuild.evidenceHash !== freeze.authorBuildInventoryHash
    || freeze.gates.productionBoundary.evidenceHash !== freeze.buildBoundaryReportHash
    || freeze.gates.authorBoundary.evidenceHash !== freeze.buildBoundaryReportHash) {
    throw new Error('Baseline freeze build gates do not match the reproduced build provenance')
  }
  if (!freeze.allPassed || gateValues.some(([, gate]) => !gate.passed)
    || freeze.gates.negativeCases.some((entry) => !entry.passed)
    || !freeze.gates.evidenceHarness.passed || !freeze.gates.evidenceHarness.freshProcessSelfTest) {
    throw new Error('Baseline freeze contains a failing gate')
  }
  assertIntegrity(freeze, 'freezeHash', 'Phase 10 baseline freeze')
  assertPublicSafeV1(freeze, 'Phase 10 baseline freeze')
  return true
}
