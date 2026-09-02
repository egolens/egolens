#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadPhase10ProductionTrustV1,
  phase10BytesHashV1,
  phase10HashV1,
  phase10VerifierBindingV1,
  revalidatePhase10ProductionTrustV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'
import { phase10AuthorStageFilesV1 } from './lib/phase10-build-policy.mjs'

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs', '.txt'])
const COMMON_DENIED = [
  '-----BEGIN PRIVATE KEY-----',
  'PHASE6_ORACLE_JUDGE_PRIVATE_KEY',
  'PHASE9_AMNESIA_EVIDENCE_',
  '/Users/',
  '/home/',
  'C:\\Users\\',
]
const PRODUCTION_DENIED = [
  ...COMMON_DENIED,
  'A2D2',
  'KITTI Raw',
  'PandaSet',
  'ONCE for Autonomous Driving',
  'phase9-oracle-judge.mjs',
]
const AUTHOR_DENIED = [
  ...COMMON_DENIED,
  'Waymo Open Dataset',
  'nuScenes',
  'Argoverse 2',
  'A2D2',
  'KITTI Raw',
  'PandaSet',
  'egolens-hidden-oracle',
  'oracleCapture',
  'phase6-oracle',
  'phase9-oracle',
  'useSceneStore',
]

function args(argv) {
  const allowed = new Set(['production', 'author', 'candidate-repository', 'expected-commit', 'output'])
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

function run(command, argv, options = {}) {
  return execFileSync(command, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim()
}

const FIXED_GIT = '/usr/bin/git'
const FIXED_TEMP_ROOT = '/tmp'
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeExecutable = await realpath(process.execPath)
for (const [label, filename] of [['Node executable', nodeExecutable], ['Git', FIXED_GIT]]) {
  const details = await lstat(filename)
  if (!details.isFile()) throw new Error(`${label} must resolve to a regular file`)
}

function isolatedEnvironment(temporaryDirectory = FIXED_TEMP_ROOT, extra = {}) {
  return {
    PATH: `${path.dirname(nodeExecutable)}:/usr/bin:/bin`,
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: path.join(temporaryDirectory, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(temporaryDirectory, 'xdg-config'),
    XDG_DATA_HOME: path.join(temporaryDirectory, 'xdg-data'),
    LANG: 'C',
    LC_ALL: 'C',
    CI: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...extra,
  }
}

function git(repository, argv, temporaryDirectory) {
  return run(FIXED_GIT, [
    '-c', 'core.hooksPath=/dev/null', '-C', repository, ...argv,
  ], { env: isolatedEnvironment(temporaryDirectory) })
}

function sourceTreeHash(repository) {
  const index = execFileSync(FIXED_GIT, [
    '-c', 'core.hooksPath=/dev/null', '-C', repository, 'ls-files', '--stage', '-z',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: isolatedEnvironment(),
  })
  return `sha256:${createHash('sha256').update(index).digest('hex')}`
}

async function inventory(directory) {
  const files = []
  const visit = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Build output contains a symbolic link: ${relative}`)
      if (entry.isDirectory()) await visit(absolute, relative)
      else if (entry.isFile()) {
        const stat = await lstat(absolute)
        const bytes = await readFile(absolute)
        files.push({
          path: relative,
          size: stat.size,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          text: TEXT_EXTENSIONS.has(path.extname(relative)) ? bytes.toString('utf8') : null,
        })
      } else {
        throw new Error(`Build output contains a non-regular entry: ${relative}`)
      }
    }
  }
  await visit(directory, '')
  if (files.length === 0) throw new Error(`Build output is empty: ${directory}`)
  return files
}

function inspect(name, files, denied, expectedCommit) {
  const sourceMap = files.find((file) => file.path.endsWith('.map'))
  if (sourceMap) throw new Error(`${name} build emitted a source map: ${sourceMap.path}`)
  const text = files.filter((file) => file.text !== null).map((file) => file.text).join('\n')
  const marker = denied.find((value) => text.includes(value))
  if (marker) throw new Error(`${name} build emitted denied marker: ${marker}`)
  if (!text.includes(expectedCommit)) throw new Error(`${name} build does not bind the exact candidate commit`)
  const publicFiles = files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 }))
  return {
    name,
    fileCount: publicFiles.length,
    totalBytes: publicFiles.reduce((sum, file) => sum + file.size, 0),
    inventoryHash: phase10HashV1(publicFiles),
    sourceMaps: 0,
    deniedMarkers: 0,
    exactCommitEmbedded: true,
    passed: true,
  }
}

function phase9ContentHash(files) {
  const manifest = {
    kind: 'egolens-canonical-content-manifest',
    schemaVersion: 1,
    files: files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, bytes: size, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path, 'en')),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  }
  return phase10HashV1(manifest)
}

async function prepareSourceStages(detachedCheckout, temporaryRoot, expectedCommit) {
  const archive = path.join(temporaryRoot, 'candidate-source.tar')
  const productionSource = path.join(temporaryRoot, 'production-source')
  const authorSource = path.join(temporaryRoot, 'author-source')
  await Promise.all([
    mkdir(productionSource, { mode: 0o700 }),
    mkdir(authorSource, { mode: 0o700 }),
  ])
  run(FIXED_GIT, [
    '-c', 'core.hooksPath=/dev/null', '-C', detachedCheckout,
    'archive', '--format=tar', `--output=${archive}`, expectedCommit,
  ], { env: isolatedEnvironment(temporaryRoot) })
  run('/usr/bin/tar', [
    '-x', '--no-same-owner', '--no-same-permissions', '-f', archive, '-C', productionSource,
  ], { env: isolatedEnvironment(temporaryRoot) })
  await rm(archive, { force: true })
  const visit = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (relative.includes('\\') || relative.startsWith('/')
        || relative.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new Error(`Git archive produced a non-canonical path: ${relative}`)
      }
      if (prefix === '' && ['dist', 'dist-amnesia-author', 'node_modules'].includes(entry.name)) {
        throw new Error(`Candidate source reserves trusted build path: ${entry.name}`)
      }
      const absolute = path.join(directory, entry.name)
      const details = await lstat(absolute)
      if (details.isSymbolicLink()) throw new Error(`Candidate source archive contains a symlink: ${relative}`)
      if (details.isDirectory()) await visit(absolute, relative)
      else if (!details.isFile()) throw new Error(`Candidate source archive contains a non-regular entry: ${relative}`)
    }
  }
  await visit(productionSource)
  const authorFiles = await phase10AuthorStageFilesV1(productionSource)
  for (const relative of authorFiles) {
    const source = path.join(productionSource, relative)
    const canonical = await realpath(source)
    if (canonical !== source || !(await lstat(source)).isFile()) {
      throw new Error(`Unsafe author source closure entry: ${relative}`)
    }
    const destination = path.join(authorSource, relative)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await cp(source, destination, { force: false, errorOnExist: true })
  }
  const pinnedConfigSource = path.join(TOOL_ROOT, 'scripts/phase9-counted-author-vite.config.ts')
  const pinnedConfigDestination = path.join(authorSource, 'scripts/phase9-counted-author-vite.config.ts')
  await mkdir(path.dirname(pinnedConfigDestination), { recursive: true, mode: 0o700 })
  await cp(pinnedConfigSource, pinnedConfigDestination, { force: false, errorOnExist: true })
  await writeFile(path.join(authorSource, 'tsconfig.counted-author.json'), `${JSON.stringify({
    extends: './tsconfig.app.json',
    compilerOptions: {
      incremental: true,
      tsBuildInfoFile: '../build-home/counted-author.tsbuildinfo',
    },
    files: ['./src/amnesia-main.tsx', './src/vite-env.d.ts', './src/types/lz4js.d.ts'],
    include: [], exclude: [],
  })}\n`, { flag: 'wx', mode: 0o600 })
  await Promise.all([
    writeFile(path.join(productionSource, 'tsconfig.counted-production-app.json'), `${JSON.stringify({
      extends: './tsconfig.app.json',
      compilerOptions: { tsBuildInfoFile: '../build-home/production-app.tsbuildinfo' },
    })}\n`, { flag: 'wx', mode: 0o600 }),
    writeFile(path.join(productionSource, 'tsconfig.counted-production-node.json'), `${JSON.stringify({
      extends: './tsconfig.node.json',
      compilerOptions: { tsBuildInfoFile: '../build-home/production-node.tsbuildinfo' },
    })}\n`, { flag: 'wx', mode: 0o600 }),
    writeFile(path.join(productionSource, 'tsconfig.counted-production.json'), `${JSON.stringify({
      files: [],
      references: [
        { path: './tsconfig.counted-production-app.json' },
        { path: './tsconfig.counted-production-node.json' },
      ],
    })}\n`, { flag: 'wx', mode: 0o600 }),
  ])
  return { productionSource, authorSource }
}

const options = args(process.argv.slice(2))
for (const name of ['production', 'author', 'candidate-repository', 'expected-commit']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (!/^[0-9a-f]{40}$/u.test(options['expected-commit'])) throw new Error('--expected-commit must be a full Git SHA')
if (process.platform !== 'darwin' || !await lstat('/usr/bin/sandbox-exec').then((entry) => entry.isFile())) {
  throw new Error('Phase 10 build boundary requires macOS /usr/bin/sandbox-exec')
}
const trust = await loadPhase10ProductionTrustV1()
const verifierBinding = phase10VerifierBindingV1(trust)
if (phase10BytesHashV1(await readFile(nodeExecutable)) !== trust.verifierNodeRuntimeHash) {
  throw new Error('Current Node executable differs from the operator-approved verifier runtime')
}
const candidateRepository = await realpath(path.resolve(options['candidate-repository']))
if (candidateRepository === TOOL_ROOT
  || candidateRepository.startsWith(`${TOOL_ROOT}${path.sep}`)
  || TOOL_ROOT.startsWith(`${candidateRepository}${path.sep}`)) {
  throw new Error('Candidate repository and separately reviewed verifier checkout must be disjoint')
}
if (path.resolve(git(candidateRepository, ['rev-parse', '--show-toplevel'])) !== candidateRepository) {
  throw new Error('--candidate-repository must be the exact repository root')
}
const canonicalOutputPath = async (value) => path.join(
  await realpath(path.dirname(path.resolve(value))),
  path.basename(path.resolve(value)),
)
const productionOutput = await canonicalOutputPath(options.production)
const authorOutput = await canonicalOutputPath(options.author)
if (productionOutput !== path.join(candidateRepository, 'dist')
  || authorOutput !== path.join(candidateRepository, 'dist-amnesia-author')) {
  throw new Error('Build outputs must be the candidate repository dist and dist-amnesia-author directories')
}
const candidateHead = git(candidateRepository, ['rev-parse', 'HEAD'])
const candidateDirty = git(candidateRepository, ['status', '--porcelain', '--untracked-files=all'])
if (candidateHead !== options['expected-commit'] || candidateDirty) {
  throw new Error('Build boundary requires the candidate repository at a clean exact HEAD')
}
const candidatePreSourceTreeHash = sourceTreeHash(candidateRepository)

// /tmp is a symlink to /private/tmp on macOS; the reviewed driver and the
// Seatbelt profile both operate on canonical paths, so canonicalize once here.
const temporaryRoot = await realpath(await mkdtemp(path.join(FIXED_TEMP_ROOT, 'egolens-phase10-build-')))
const detachedCheckout = path.join(temporaryRoot, 'candidate')
const buildHome = path.join(temporaryRoot, 'build-home')
let productionFiles
let authorFiles
let detachedSourceTreeHash
let reviewedBuild
let dependencyManifestHash
let reviewedBuildInputManifestHash
let productionSource
let authorSource
try {
  await mkdir(buildHome, { mode: 0o700 })
  run(FIXED_GIT, [
    '-c', 'core.hooksPath=/dev/null', 'clone', '--no-local', '--no-checkout', '--',
    candidateRepository, detachedCheckout,
  ], { env: isolatedEnvironment(temporaryRoot) })
  git(detachedCheckout, ['checkout', '--detach', options['expected-commit']], temporaryRoot)
  git(detachedCheckout, ['remote', 'remove', 'origin'], temporaryRoot)
  if (git(detachedCheckout, ['rev-parse', 'HEAD']) !== options['expected-commit']
    || git(detachedCheckout, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Detached build checkout is not the clean exact candidate commit')
  }
  detachedSourceTreeHash = sourceTreeHash(detachedCheckout)
  if (detachedSourceTreeHash !== candidatePreSourceTreeHash) {
    throw new Error('Detached build index differs from the protected candidate source tree')
  }
  const reviewedInputFiles = await Promise.all([
    'package.json', 'package-lock.json', 'vite.config.ts',
    'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  ].map(async (name) => {
    const [candidateBytes, reviewedBytes] = await Promise.all([
      readFile(path.join(detachedCheckout, name)),
      readFile(path.join(TOOL_ROOT, name)),
    ])
    if (!candidateBytes.equals(reviewedBytes)) {
      throw new Error(`Candidate ${name} differs from the separately reviewed verifier dependency manifest`)
    }
    return { path: name, sha256: phase10BytesHashV1(candidateBytes), size: candidateBytes.length }
  }))
  const dependencyFiles = reviewedInputFiles.filter((entry) =>
    entry.path === 'package.json' || entry.path === 'package-lock.json')
  dependencyManifestHash = phase10HashV1(dependencyFiles)
  reviewedBuildInputManifestHash = phase10HashV1(reviewedInputFiles)
  ;({ productionSource, authorSource } = await prepareSourceStages(
    detachedCheckout,
    temporaryRoot,
    options['expected-commit'],
  ))
  await Promise.all([
    symlink(path.join(TOOL_ROOT, 'node_modules'), path.join(productionSource, 'node_modules'), 'dir'),
    symlink(path.join(TOOL_ROOT, 'node_modules'), path.join(authorSource, 'node_modules'), 'dir'),
  ])
  await Promise.all([
    mkdir(path.join(productionSource, 'dist'), { mode: 0o700 }),
    mkdir(path.join(authorSource, 'dist-amnesia-author'), { mode: 0o700 }),
  ])
  const reviewedDriver = path.join(TOOL_ROOT, 'scripts/phase10-reviewed-build-driver.mjs')
  const reviewedProfile = path.join(TOOL_ROOT, 'scripts/phase10-reviewed-build.sb')
  reviewedBuild = JSON.parse(run(nodeExecutable, [
    reviewedDriver,
    '--production-source', productionSource,
    '--author-source', authorSource,
    '--node', nodeExecutable,
    '--node-modules', path.join(TOOL_ROOT, 'node_modules'),
    '--build-home', buildHome,
    '--profile', reviewedProfile,
    '--expected-commit', options['expected-commit'],
    '--source-tree-hash', detachedSourceTreeHash,
    '--protected-candidate-repository', candidateRepository,
    '--protected-verifier-root', TOOL_ROOT,
    '--expected-dependency-closure-hash', trust.verifierDependencyClosureHash,
    '--expected-node-runtime-hash', trust.verifierNodeRuntimeHash,
  ], { cwd: TOOL_ROOT, env: isolatedEnvironment(temporaryRoot) }))
  const [expectedDriverHash, expectedProfileHash] = await Promise.all([
    readFile(reviewedDriver).then(phase10BytesHashV1),
    readFile(reviewedProfile).then(phase10BytesHashV1),
  ])
  if (reviewedBuild?.schema !== 'egolens-phase10-reviewed-build-driver-v1'
    || reviewedBuild.candidateCommit !== options['expected-commit']
    || reviewedBuild.sourceTreeHash !== detachedSourceTreeHash
    || reviewedBuild.passed !== true
    || reviewedBuild.reviewedDriverHash !== expectedDriverHash
    || reviewedBuild.sandboxProfileHash !== expectedProfileHash
    || reviewedBuild.nodeRuntimeHash !== trust.verifierNodeRuntimeHash
    || reviewedBuild.dependencyEntryHash !== trust.verifierDependencyClosureHash
    || reviewedBuild.gitHistoryAbsent !== true
    || reviewedBuild.authorAllowlistedStage !== true
    || reviewedBuild.authorPinnedGraphPolicy !== true
    || reviewedBuild.reviewedExecutableConfigsOnly !== true
    || reviewedBuild.detachedChildCleanupVerified !== true
    || reviewedBuild.residualProcessAuditPassed !== true
    || reviewedBuild.dependencyClosureUnchanged !== true
    || Object.entries(reviewedBuild)
      .filter(([key]) => key.endsWith('Denied') || key.endsWith('Cleanup') || key.endsWith('Unchanged'))
      .some(([, value]) => value !== true)
    || reviewedBuild.candidateScriptsInvoked !== false) {
    throw new Error('Reviewed sandbox build driver did not prove the complete build boundary')
  }
  ;[productionFiles, authorFiles] = await Promise.all([
    inventory(path.join(productionSource, 'dist')),
    inventory(path.join(authorSource, 'dist-amnesia-author')),
  ])
  await Promise.all([
    rm(productionOutput, { recursive: true, force: true }),
    rm(authorOutput, { recursive: true, force: true }),
  ])
  await Promise.all([
    cp(path.join(productionSource, 'dist'), productionOutput, { recursive: true, errorOnExist: true }),
    cp(path.join(authorSource, 'dist-amnesia-author'), authorOutput, { recursive: true, errorOnExist: true }),
  ])
  const [copiedProduction, copiedAuthor] = await Promise.all([
    inventory(productionOutput),
    inventory(authorOutput),
  ])
  if (phase10HashV1(copiedProduction.map(({ text: _text, ...entry }) => entry))
      !== phase10HashV1(productionFiles.map(({ text: _text, ...entry }) => entry))
    || phase10HashV1(copiedAuthor.map(({ text: _text, ...entry }) => entry))
      !== phase10HashV1(authorFiles.map(({ text: _text, ...entry }) => entry))) {
    throw new Error('Copied build outputs differ from the detached reproducible build')
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
const candidatePostSourceTreeHash = sourceTreeHash(candidateRepository)
if (git(candidateRepository, ['rev-parse', 'HEAD']) !== options['expected-commit']
  || git(candidateRepository, ['status', '--porcelain', '--untracked-files=all'])
  || candidatePostSourceTreeHash !== candidatePreSourceTreeHash) {
  throw new Error('Protected candidate checkout changed during the reviewed build')
}
await revalidatePhase10ProductionTrustV1(trust)
const payload = {
  schema: 'egolens-phase10-build-boundary-report-v1',
  candidateCommit: options['expected-commit'],
  sourceTreeHash: detachedSourceTreeHash,
  cleanHeadVerified: true,
  detachedCheckoutVerified: true,
  ignoredInputsExcluded: true,
  sanitizedEnvironmentVerified: true,
  dependencyInstall: 'reviewed-verifier-node-modules-closure',
  dependencyManifestHash,
  reviewedBuildInputManifestHash,
  verifierBinding,
  sandbox: {
    platform: 'macos-seatbelt-deny-default',
    sandboxProfileHash: reviewedBuild.sandboxProfileHash,
    reviewedDriverHash: reviewedBuild.reviewedDriverHash,
    nodeRuntimeHash: reviewedBuild.nodeRuntimeHash,
    dependencyEntryHash: reviewedBuild.dependencyEntryHash,
    candidatePreSourceTreeHash,
    candidatePostSourceTreeHash,
    verifierPreSourceTreeHash: verifierBinding.verifierSourceTreeHash,
    verifierPostSourceTreeHash: verifierBinding.verifierSourceTreeHash,
    productionSourceStageHash: reviewedBuild.productionSourceStageHash,
    authorSourceStageHash: reviewedBuild.authorSourceStageHash,
    authorSourceGraphHash: reviewedBuild.authorSourceGraphHash,
    candidateScriptsInvoked: false,
    gitHistoryAbsent: true,
    authorAllowlistedStage: true,
    authorPinnedGraphPolicy: true,
    reviewedExecutableConfigsOnly: true,
    detachedChildCleanupVerified: true,
    residualProcessAuditPassed: true,
    dependencyClosureUnchanged: true,
    networkDenied: true,
    protectedRootsDenied: true,
    trackedSourceWriteDenied: true,
    processGroupCleanup: true,
    candidateRepositoryUnchanged: true,
    verifierCheckoutUnchanged: true,
    sourceUnchanged: true,
    passed: true,
  },
  production: {
    ...inspect('production', productionFiles, PRODUCTION_DENIED, options['expected-commit']),
    phase9ContentHash: phase9ContentHash(productionFiles),
  },
  author: {
    ...inspect('author', authorFiles, AUTHOR_DENIED, options['expected-commit']),
    phase9ContentHash: phase9ContentHash(authorFiles),
  },
  passed: true,
}
const report = { ...payload, reportHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(report)
if (options.output) {
  await writeFile(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
