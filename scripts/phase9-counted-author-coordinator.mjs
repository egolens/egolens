#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  assembleBoundaryReport,
  assertDisjointBoundaryPaths,
  assertSupportedCountedHost,
  canonicalDirectory,
  canonicalFile,
  countedAuthorTypecheckConfigText,
  controllerExecArguments,
  createBoundaryCaseArtifact,
  createProbeReport,
  createSourceManifestArtifact,
  effectivePolicyDescriptor,
  makeBoundaryCase,
  randomToken,
  REVIEWED_AUTHOR_SOURCE_PATHS,
  sha256Colon,
  verifyBoundaryCaseArtifact,
} from './lib/phase9-counted-author-boundary.mjs'
import {
  AMNESIA_DATASETS,
  AMNESIA_PUBLIC_TOOLS,
  recipeSemanticHash,
} from './lib/amnesia-evidence.mjs'
import { canonicalize, sha256Canonical } from './lib/oracle-receipts.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.dirname(SCRIPT_DIRECTORY)
const BROKER_PROFILE = path.join(SCRIPT_DIRECTORY, 'phase9-counted-author-broker.sb')
const CONTROLLER_PROFILE = path.join(SCRIPT_DIRECTORY, 'phase9-counted-author-controller.sb')
const BUILD_PROFILE = path.join(SCRIPT_DIRECTORY, 'phase9-counted-author-build.sb')
const BROKER_PROGRAM = path.join(SCRIPT_DIRECTORY, 'phase9-counted-author-broker.mjs')
const BROKER_PROBE = path.join(SCRIPT_DIRECTORY, 'phase9-counted-boundary-probe.mjs')
const MAX_PROCESS_OUTPUT = 2 * 1024 * 1024
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const CANONICAL_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MIN_AUTHOR_TIMEOUT_MS = 60_000
const MAX_AUTHOR_TIMEOUT_MS = 2 * 60 * 60_000
const OPTION_NAMES = Object.freeze({
  'run-case': Object.freeze([
    'candidate-commit', 'dataset-id', 'case-id', 'dataset', 'capture-config',
    'output-root', 'evidence-dir', 'timeout-ms',
  ]),
  'assemble-report': Object.freeze(['candidate-commit', 'case', 'output']),
})

export const COUNTED_TARGETS = Object.freeze({
  waymo: Object.freeze({
    caseId: 'phase6-waymo-rich-001',
    requiredCapabilities: Object.freeze([
      'boxes2d', 'boxes3d', 'cameraImages', 'cameraSegmentation', 'egoPoses',
      'lidarSegmentation', 'pointClouds', 'segmentMetadata', 'timeline', 'trajectories',
    ]),
    forbiddenRecipe: 'waymo.egolens-adapter.json',
  }),
  nuscenes: Object.freeze({
    caseId: 'phase6-nuscenes-urban-vru-001',
    requiredCapabilities: Object.freeze([
      'boxes2d', 'boxes3d', 'cameraImages', 'egoPoses', 'lidarSegmentation',
      'pointClouds', 'radarPointClouds', 'segmentMetadata', 'timeline', 'trajectories',
    ]),
    forbiddenRecipe: 'nuscenes.egolens-adapter.json',
  }),
  argoverse2: Object.freeze({
    caseId: 'phase6-av2-urban-001',
    requiredCapabilities: Object.freeze([
      'boxes2d', 'boxes3d', 'cameraImages', 'egoPoses', 'pointClouds',
      'segmentMetadata', 'timeline', 'trajectories',
    ]),
    forbiddenRecipe: 'argoverse2.egolens-adapter.json',
  }),
})

function exactStringSet(actual, expected) {
  return Array.isArray(actual) && actual.length === new Set(actual).size
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
}

export function parseOptions(argv) {
  const command = argv[0]
  if (command !== 'run-case' && command !== 'assemble-report') {
    throw new Error('Expected run-case or assemble-report.')
  }
  const options = {}
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid coordinator argument: ${key}`)
    }
    const name = key.slice(2)
    if (!OPTION_NAMES[command].includes(name)) {
      throw new Error(`Unknown ${command} option: --${name}`)
    }
    if (name === 'case') {
      options.case ??= []
      options.case.push(value)
    } else {
      if (options[name] !== undefined) throw new Error(`Duplicate --${name}`)
      options[name] = value
    }
    index += 1
  }
  if (options['timeout-ms'] !== undefined) {
    const timeout = Number(options['timeout-ms'])
    if (!Number.isSafeInteger(timeout)
      || timeout < MIN_AUTHOR_TIMEOUT_MS
      || timeout > MAX_AUTHOR_TIMEOUT_MS) {
      throw new Error(`--timeout-ms must be an integer from ${MIN_AUTHOR_TIMEOUT_MS} to ${MAX_AUTHOR_TIMEOUT_MS}.`)
    }
  }
  return { command, options }
}

function requireOptions(options, names) {
  for (const name of names) if (!options[name]) throw new Error(`Missing --${name}`)
}

function assertValue(value, pattern, message) {
  if (!pattern.test(value)) throw new Error(message)
  return value
}

async function canonicalMaybeMissing(value) {
  try {
    return await realpath(value)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return path.resolve(value)
  }
}

async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

export async function contentManifest(root, label, {
  maxEntries = 100_000,
  maxFileBytes = 256 * 1024 ** 3,
  maxTotalBytes = 1024 ** 4,
} = {}) {
  const queue = [root]
  let firstFile
  let visited = 0
  let totalBytes = 0
  const files = []
  while (queue.length > 0) {
    const directory = queue.shift()
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      visited += 1
      if (visited > maxEntries) throw new Error(`${label} exceeds the bounded tree inspection limit.`)
      const filename = path.join(directory, entry.name)
      const info = await lstat(filename)
      if (info.isSymbolicLink()) throw new Error(`${label} may not contain symbolic links.`)
      if (info.isDirectory()) queue.push(filename)
      else if (info.isFile()) {
        if (info.size > maxFileBytes) throw new Error(`${label} contains an over-limit file.`)
        totalBytes += info.size
        if (totalBytes > maxTotalBytes) throw new Error(`${label} exceeds its total byte limit.`)
        firstFile ??= filename
        files.push({
          path: path.relative(root, filename).split(path.sep).join('/'),
          bytes: info.size,
          sha256: await hashFile(filename),
        })
      }
      else throw new Error(`${label} contains an unsupported filesystem entry.`)
    }
  }
  if (!firstFile) throw new Error(`${label} must contain at least one regular file.`)
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const manifest = {
    kind: 'egolens-canonical-content-manifest',
    schemaVersion: 1,
    files,
    fileCount: files.length,
    totalBytes,
  }
  return {
    firstFile: await canonicalFile(firstFile, `${label} probe`),
    manifest,
    canonicalHash: sha256Canonical(manifest),
    contentHash: sha256Colon(manifest),
  }
}

function applicationProbe(applicationRoot) {
  return path.join(applicationRoot, 'amnesia.html')
}

function safeSandboxParameter(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new Error(`Invalid Seatbelt parameter ${name}.`)
  }
  return value
}

export function sandboxArguments(profilePath, parameters, command) {
  if (!path.isAbsolute(profilePath) || !Array.isArray(command) || command.length === 0) {
    throw new Error('Invalid Seatbelt invocation.')
  }
  const definitions = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ['-D', `${name}=${safeSandboxParameter(value, name)}`])
  return [...definitions, '-f', profilePath, ...command]
}

function appendBounded(current, chunk, onOverflow) {
  const next = current + chunk.toString('utf8')
  if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT) {
    onOverflow()
    throw new Error('A counted subprocess exceeded its bounded output limit.')
  }
  return next
}

export async function runProcess(file, argumentsValue, {
  cwd,
  env,
  timeoutMs = 60_000,
} = {}) {
  if (env === undefined || env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('Counted subprocesses require an explicit minimal environment.')
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argumentsValue, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (callback) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      callback()
    }
    const overflow = () => {
      child.kill('SIGKILL')
      finish(() => reject(new Error('A counted subprocess exceeded its bounded output limit.')))
    }
    child.stdout.on('data', (chunk) => {
      try { stdout = appendBounded(stdout, chunk, overflow) } catch { /* handled by overflow */ }
    })
    child.stderr.on('data', (chunk) => {
      try { stderr = appendBounded(stderr, chunk, overflow) } catch { /* handled by overflow */ }
    })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code, signal) => finish(() => resolve({ code, signal, stdout, stderr })))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error('A counted subprocess timed out.')))
    }, timeoutMs)
  })
}

async function runSandbox(profile, parameters, command, options) {
  return await runProcess('/usr/bin/sandbox-exec', sandboxArguments(profile, parameters, command), options)
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port.')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function liveDecoyServer() {
  const server = net.createServer((socket) => socket.end('decoy'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate the decoy loopback port.')
  return {
    port: address.port,
    async close() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      if (server.listening) await new Promise((resolve) => server.close(resolve))
    },
  }
}

function protectedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeProtectedJson(filename, value) {
  if (!path.isAbsolute(filename)) throw new Error('Protected evidence path must be absolute.')
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(protectedJson(value), 'utf8')
  } finally {
    await handle.close()
  }
  await chmod(filename, 0o600)
}

async function readProtectedArtifact(filename, candidateCommit) {
  const canonicalPath = await canonicalFile(filename, 'protected boundary case')
  const info = await stat(canonicalPath)
  if ((info.mode & 0o077) !== 0) throw new Error('Protected boundary case has group/other permissions.')
  const artifact = JSON.parse(await readFile(canonicalPath, 'utf8'))
  if (!verifyBoundaryCaseArtifact(artifact, candidateCommit)) throw new Error('Invalid protected boundary case artifact.')
  return artifact
}

async function readTrustedCaptureConfig(filename, { datasetId, caseId, requiredCapabilities }) {
  const canonicalPath = await canonicalFile(path.resolve(filename), 'protected Phase 6 capture config')
  const info = await stat(canonicalPath)
  if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
    throw new Error('Protected capture config must be owner-only and owned by the coordinator user.')
  }
  const bytes = await readFile(canonicalPath)
  const value = JSON.parse(bytes.toString('utf8'))
  if (value?.datasetId !== datasetId || value?.caseId !== caseId
    || !CANONICAL_HASH_PATTERN.test(value?.sourceFingerprint)
    || !exactStringSet(value?.requiredCapabilities, requiredCapabilities)) {
    throw new Error('Protected capture config does not match the reviewed target and coverage.')
  }
  return {
    value,
    sourceFingerprint: value.sourceFingerprint,
    captureConfigHash: sha256Colon(canonicalize(value)),
    canonicalPath,
  }
}

function requestJson({ port, token, method = 'GET', pathname, payload }) {
  return new Promise((resolve, reject) => {
    const encoded = payload === undefined ? null : Buffer.from(JSON.stringify(payload))
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        authorization: `Bearer ${token}`,
        ...(encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}),
      },
      timeout: 10_000,
    }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_PROCESS_OUTPUT) request.destroy(new Error('Broker response exceeded its limit.'))
        else chunks.push(chunk)
      })
      response.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if ((response.statusCode ?? 500) >= 400) reject(new Error('Broker API rejected the trusted coordinator request.'))
          else resolve(value)
        } catch (error) { reject(error) }
      })
    })
    request.once('timeout', () => request.destroy(new Error('Broker API request timed out.')))
    request.once('error', reject)
    if (encoded) request.end(encoded); else request.end()
  })
}

async function startBroker({ argumentsValue, cwd, env }) {
  const child = spawn('/usr/bin/sandbox-exec', argumentsValue, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    if (Buffer.byteLength(stderr) <= MAX_PROCESS_OUTPUT) stderr += chunk.toString('utf8')
    if (Buffer.byteLength(stderr) > MAX_PROCESS_OUTPUT) killBrokerGroup(child)
  })
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Counted broker readiness timed out.')), 90_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', () => {
        clearTimeout(timer)
        reject(new Error(`Counted broker exited before readiness (${sha256Colon(stderr)}).`))
      })
      lines.on('line', (line) => {
        try {
          const value = JSON.parse(line)
          if (value.ready === true) {
            clearTimeout(timer)
            resolve(value)
          }
        } catch { /* stdout is accepted only when it becomes a valid readiness envelope */ }
      })
    })
    lines.close()
    return { child, closed, ready, stderrHash: () => sha256Colon(stderr) }
  } catch (error) {
    killBrokerGroup(child)
    await closed
    lines.close()
    throw error
  }
}

function killBrokerGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function brokerGroupExists(child) {
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function stopBroker(broker, port, adminToken) {
  await requestJson({ port, token: adminToken, method: 'POST', pathname: '/__phase9/shutdown', payload: {} })
    .catch(() => {})
  const result = await Promise.race([
    broker.closed,
    new Promise((resolve) => setTimeout(() => resolve(null), 15_000)),
  ])
  if (!result) {
    killBrokerGroup(broker.child)
    await broker.closed
    throw new Error('Counted broker did not shut down cleanly.')
  }
  if (result.code !== 0) throw new Error(`Counted broker failed during shutdown (${broker.stderrHash()}).`)
  if (brokerGroupExists(broker.child)) {
    killBrokerGroup(broker.child)
    throw new Error('Counted broker left a descendant process after browser shutdown.')
  }
}

function expectedWorkspaceRuntimeRoot() {
  return path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node')
}

async function resolveRuntime() {
  const workspaceRuntime = await canonicalDirectory(expectedWorkspaceRuntimeRoot(), 'trusted Node runtime')
  const node = await canonicalFile(path.join(workspaceRuntime, 'bin', 'node'), 'trusted Node executable')
  const codexRoot = await canonicalDirectory('/Applications/ChatGPT.app', 'trusted Codex runtime')
  const codex = await canonicalFile(
    path.join(codexRoot, 'Contents', 'Resources', 'codex'),
    'trusted Codex executable',
  )
  const playwrightRoot = await canonicalDirectory(
    path.join(workspaceRuntime, 'node_modules', 'playwright'),
    'trusted Playwright runtime',
  )
  const playwrightCoreRoot = await canonicalDirectory(
    path.join(workspaceRuntime, 'node_modules', 'playwright-core'),
    'trusted Playwright Core runtime',
  )
  const playwright = await canonicalFile(path.join(playwrightRoot, 'index.js'), 'trusted Playwright entry')
  const chromeRoot = await canonicalDirectory('/Applications/Google Chrome.app', 'trusted Chrome runtime')
  const chrome = await canonicalFile(
    path.join(chromeRoot, 'Contents', 'MacOS', 'Google Chrome'),
    'trusted Chrome executable',
  )
  const [playwrightPackage, playwrightCorePackage] = await Promise.all([
    readFile(path.join(playwrightRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(playwrightCoreRoot, 'package.json'), 'utf8').then(JSON.parse),
  ])
  if (playwrightPackage.version !== '1.62.1' || playwrightCorePackage.version !== '1.62.1') {
    throw new Error('Trusted workspace Playwright runtime is not the reviewed 1.62.1 pair.')
  }
  const versionEnvironment = {
    HOME: '/var/empty',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
  }
  const [nodeVersion, chromeVersion, codexVersion] = await Promise.all([
    runProcess(node, ['--version'], { env: versionEnvironment, timeoutMs: 30_000 }),
    runProcess(chrome, ['--version'], { env: versionEnvironment, timeoutMs: 30_000 }),
    runProcess(codex, ['--version'], { env: versionEnvironment, timeoutMs: 30_000 }),
  ])
  if (nodeVersion.code !== 0 || chromeVersion.code !== 0 || codexVersion.code !== 0) {
    throw new Error('Could not identify one of the reviewed counted runtimes.')
  }
  const runtimePayload = {
    kind: 'egolens-counted-author-runtime-manifest',
    schemaVersion: 1,
    node: { version: nodeVersion.stdout.trim(), executableHash: await hashFile(node) },
    playwright: {
      version: playwrightPackage.version,
      coreVersion: playwrightCorePackage.version,
      entryHash: await hashFile(playwright),
      corePackageHash: await hashFile(path.join(playwrightCoreRoot, 'package.json')),
    },
    chrome: { version: chromeVersion.stdout.trim(), executableHash: await hashFile(chrome) },
    codex: { version: codexVersion.stdout.trim(), executableHash: await hashFile(codex) },
  }
  const runtimeManifest = { ...runtimePayload, manifestHash: sha256Colon(runtimePayload) }
  const systemTmp = path.resolve(tmpdir())
  if (!/^\/var\/folders\/[A-Za-z0-9_-]{2}\/[A-Za-z0-9_-]+\/T$/u.test(systemTmp)) {
    throw new Error('Darwin temporary root is not the reviewed per-user alias.')
  }
  const systemTmpReal = await canonicalDirectory(systemTmp, 'Darwin per-user temporary root')
  if (systemTmpReal !== `/private${systemTmp}`) {
    throw new Error('Darwin temporary root alias does not resolve to the reviewed canonical root.')
  }
  return {
    node,
    nodeRoot: workspaceRuntime,
    codex,
    codexRoot,
    playwright,
    playwrightRoot,
    playwrightCoreRoot,
    chrome,
    chromeRoot,
    systemTmp,
    systemTmpReal,
    runtimeManifest,
  }
}

function gitEnvironment() {
  return {
    HOME: '/var/empty',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

async function git(argumentsValue, options = {}) {
  const result = await runProcess('/usr/bin/git', ['-C', REPOSITORY_ROOT, ...argumentsValue], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: options.timeoutMs ?? 120_000,
    env: gitEnvironment(),
  })
  if (result.code !== 0) throw new Error(`Trusted git operation failed (${sha256Colon(result.stderr)}).`)
  return result.stdout.trim()
}

async function assertCleanExactHead(candidateCommit) {
  const [head, status] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain=v1', '--untracked-files=all']),
  ])
  if (head !== candidateCommit) throw new Error('Candidate commit must equal the exact current HEAD.')
  if (status !== '') throw new Error('Counted authoring refuses a dirty or untracked working tree.')
}

function buildSeatbeltParameters({ runtime, sourceStage, nodeModules, output, buildHome }) {
  return {
    NODE_RUNTIME_ROOT: runtime.nodeRoot,
    SOURCE_STAGE_ROOT: sourceStage,
    SOURCE_STAGE_REAL_ROOT: sourceStage,
    NODE_MODULES_ROOT: nodeModules,
    NODE_MODULES_REAL_ROOT: nodeModules,
    OUTPUT_ROOT: output,
    OUTPUT_REAL_ROOT: output,
    BUILD_HOME: buildHome,
    BUILD_HOME_REAL: buildHome,
  }
}

async function prepareAuthorSourceStage({ checkout, runRoot }) {
  const sourceStage = path.join(runRoot, 'author-source-stage')
  await mkdir(sourceStage, { mode: 0o700 })
  for (const relative of REVIEWED_AUTHOR_SOURCE_PATHS) {
    const source = await canonicalFile(path.join(checkout, relative), `reviewed author source ${relative}`)
    if (source !== path.join(checkout, relative)) throw new Error('Author source allowlist may not traverse symlinks.')
    const destination = path.join(sourceStage, relative)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await cp(source, destination, { force: false, errorOnExist: true })
  }
  const typecheckConfig = path.join(sourceStage, 'tsconfig.counted-author.json')
  await writeFile(typecheckConfig, countedAuthorTypecheckConfigText(), { flag: 'wx', mode: 0o600 })
  const canonicalStage = await canonicalDirectory(sourceStage, 'allowlisted author source stage', {
    ownerOnly: true,
  })
  const sourceStageTree = await contentManifest(canonicalStage, 'allowlisted author source stage', {
    maxEntries: 5_000,
    maxFileBytes: 8 * 1024 ** 2,
    maxTotalBytes: 128 * 1024 ** 2,
  })
  return { sourceStage: canonicalStage, sourceStageManifest: sourceStageTree.manifest }
}

async function assertManifestFilesUnchanged(root, manifest, label) {
  for (const entry of manifest.files) {
    const expected = path.join(root, ...entry.path.split('/'))
    const canonical = await canonicalFile(expected, `${label} ${entry.path}`)
    const info = await stat(canonical)
    if (canonical !== expected || info.size !== entry.bytes || await hashFile(canonical) !== entry.sha256) {
      throw new Error(`${label} changed after its trusted manifest was captured.`)
    }
  }
}

const BUILD_DEPENDENCIES = Object.freeze([
  '@esbuild/darwin-arm64',
  '@rollup/rollup-darwin-arm64',
  '@vitejs/plugin-react',
  'esbuild',
  'rollup',
  'typescript',
  'vite',
])

async function buildDependencyManifest(nodeModules) {
  const packages = []
  for (const name of BUILD_DEPENDENCIES) {
    const packageRoot = await canonicalDirectory(path.join(nodeModules, name), `reviewed build dependency ${name}`)
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    const tree = await contentManifest(packageRoot, `reviewed build dependency ${name}`, {
      maxEntries: 10_000,
      maxFileBytes: 256 * 1024 ** 2,
      maxTotalBytes: 512 * 1024 ** 2,
    })
    packages.push({
      name,
      version: packageJson.version,
      contentHash: tree.contentHash,
      fileCount: tree.manifest.fileCount,
      totalBytes: tree.manifest.totalBytes,
    })
  }
  packages.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const payload = {
    kind: 'egolens-counted-author-build-dependency-manifest',
    schemaVersion: 1,
    packages,
  }
  return { ...payload, manifestHash: sha256Colon(payload) }
}

async function prepareExactApplication({ candidateCommit, runRoot, runtime }) {
  await assertCleanExactHead(candidateCommit)
  const checkout = path.join(runRoot, 'detached-source')
  const buildHome = path.join(runRoot, 'build-home')
  await mkdir(buildHome, { mode: 0o700 })
  let worktreeAdded = false
  try {
    await git(['worktree', 'add', '--detach', checkout, candidateCommit], { timeoutMs: 120_000 })
    worktreeAdded = true
    if (await canonicalDirectory(checkout, 'detached exact-commit checkout') !== checkout) {
      throw new Error('Detached checkout path changed through a symbolic link.')
    }
    const checkoutHead = await runProcess('/usr/bin/git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      cwd: checkout,
      timeoutMs: 30_000,
      env: gitEnvironment(),
    })
    if (checkoutHead.code !== 0 || checkoutHead.stdout.trim() !== candidateCommit) {
      throw new Error('Detached build checkout does not match the candidate commit.')
    }
    const detachedStatus = await runProcess('/usr/bin/git', [
      '-C', checkout, 'status', '--porcelain=v1', '--untracked-files=all',
    ], { cwd: checkout, env: gitEnvironment(), timeoutMs: 30_000 })
    if (detachedStatus.code !== 0 || detachedStatus.stdout.trim() !== '') {
      throw new Error('Detached build checkout is not initially clean.')
    }
    const packageJson = JSON.parse(await readFile(path.join(checkout, 'package.json'), 'utf8'))
    if (packageJson?.scripts?.['build:amnesia-author'] !== 'tsc -b && vite build --config vite.amnesia.config.ts') {
      throw new Error('Exact commit changed the reviewed author build command.')
    }
    const installNode = await canonicalFile(process.execPath, 'trusted npm host Node executable')
    const installRuntimeRoot = path.dirname(path.dirname(installNode))
    const npmCli = await canonicalFile(
      path.join(installRuntimeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      'trusted npm CLI',
    )
    // npm refuses to load the same file as both the user and the global
    // config ("double-loading config"), so each points at its own empty file
    // inside the fresh build home; neither can inherit operator settings.
    const npmUserConfig = path.join(buildHome, 'npmrc.user')
    const npmGlobalConfig = path.join(buildHome, 'npmrc.global')
    await Promise.all([
      writeFile(npmUserConfig, '', { flag: 'wx', mode: 0o600 }),
      writeFile(npmGlobalConfig, '', { flag: 'wx', mode: 0o600 }),
    ])
    const installEnvironment = {
      HOME: buildHome,
      TMPDIR: buildHome,
      PATH: `${path.dirname(installNode)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'C',
      LC_ALL: 'C',
      npm_config_audit: 'false',
      npm_config_cache: path.join(buildHome, 'npm-cache'),
      npm_config_fund: 'false',
      npm_config_globalconfig: npmGlobalConfig,
      npm_config_ignore_scripts: 'true',
      npm_config_userconfig: npmUserConfig,
      npm_config_update_notifier: 'false',
    }
    const install = await runProcess(installNode, [npmCli,
      'ci', '--ignore-scripts', '--no-audit', '--no-fund',
    ], { cwd: checkout, env: installEnvironment, timeoutMs: 15 * 60_000 })
    if (install.code !== 0) throw new Error(`Clean detached npm install failed (${sha256Colon(install.stderr)}).`)
    const nodeModules = await canonicalDirectory(path.join(checkout, 'node_modules'), 'detached dependencies')
    const dependencyManifest = await buildDependencyManifest(nodeModules)
    const { sourceStage, sourceStageManifest } = await prepareAuthorSourceStage({ checkout, runRoot })
    await symlink(nodeModules, path.join(sourceStage, 'node_modules'), 'dir')
    const detachedOutput = path.join(sourceStage, 'dist-amnesia-author')
    await mkdir(detachedOutput, { mode: 0o700 })
    const canonicalOutput = await canonicalDirectory(detachedOutput, 'fresh detached author output', {
      mustBeEmpty: true,
      ownerOnly: true,
    })
    const canonicalBuildHome = await canonicalDirectory(buildHome, 'fresh private build home', {
      ownerOnly: true,
    })
    const buildParameters = buildSeatbeltParameters({
      runtime,
      sourceStage,
      nodeModules,
      output: canonicalOutput,
      buildHome: canonicalBuildHome,
    })
    const candidateBuildEnvironment = {
      HOME: canonicalBuildHome,
      TMPDIR: canonicalBuildHome,
      CFFIXED_USER_HOME: canonicalBuildHome,
      XDG_CACHE_HOME: canonicalBuildHome,
      XDG_CONFIG_HOME: canonicalBuildHome,
      PATH: `${path.dirname(runtime.node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'C',
      LC_ALL: 'C',
      NO_PROXY: '*',
      no_proxy: '*',
      PHASE9_AUTHOR_GRAPH_REPORT: path.join(canonicalBuildHome, 'author-source-graph.json'),
      PHASE9_SOURCE_COMMIT: candidateCommit,
    }
    const buildSourceProbe = await canonicalFile(
      path.join(sourceStage, 'amnesia.html'),
      'allowlisted author build source probe',
    )
    const buildForbiddenProbe = await canonicalFile(
      path.join(checkout, 'src', 'adapters', 'recipes', 'waymo.egolens-adapter.json'),
      'forbidden author build source probe',
    )
    const buildSourceRead = await runSandbox(BUILD_PROFILE, buildParameters, [
      '/bin/cat', buildSourceProbe,
    ], { cwd: sourceStage, env: candidateBuildEnvironment, timeoutMs: 10_000 })
    const buildForbiddenRead = await runSandbox(BUILD_PROFILE, buildParameters, [
      '/bin/cat', buildForbiddenProbe,
    ], { cwd: sourceStage, env: candidateBuildEnvironment, timeoutMs: 10_000 })
    const buildExternalNetwork = await runSandbox(BUILD_PROFILE, buildParameters, [
      '/usr/bin/curl', ...EXTERNAL_PROBE_ARGUMENTS,
    ], { cwd: sourceStage, env: candidateBuildEnvironment, timeoutMs: 10_000 })
    const buildExternalReachable = await externalProbeReachable()
    const buildChecks = [
      check('build-source-stage-read-allowed', buildSourceRead.code === 0,
        buildSourceRead.code === 0 ? 'allowlisted-source-readable' : 'unexpected-source-denial'),
      check('build-forbidden-resource-read-denied', fileDenied(buildForbiddenRead),
        fileDenied(buildForbiddenRead) ? 'seatbelt-eperm' : 'unexpected-forbidden-read'),
      externalDenialCheck('build-external-network-denied', buildExternalReachable, buildExternalNetwork),
    ]
    if (buildChecks.some((entry) => !entry.passed)) {
      throw new Error('Strict candidate build boundary probe failed.')
    }
    const typecheckConfig = path.join(sourceStage, 'tsconfig.counted-author.json')
    const typecheck = await runSandbox(BUILD_PROFILE, buildParameters, [
      runtime.node,
      path.join(nodeModules, 'typescript', 'bin', 'tsc'),
      '--project', typecheckConfig,
    ], { cwd: sourceStage, env: candidateBuildEnvironment, timeoutMs: 15 * 60_000 })
    if (typecheck.code !== 0) {
      throw new Error(`Sandboxed exact-commit typecheck failed (${sha256Colon(typecheck.stderr)}).`)
    }
    const bundle = await runSandbox(BUILD_PROFILE, buildParameters, [
      runtime.node,
      path.join(nodeModules, 'vite', 'bin', 'vite.js'),
      'build', '--config', path.join(sourceStage, 'scripts', 'phase9-counted-author-vite.config.ts'),
    ], { cwd: sourceStage, env: candidateBuildEnvironment, timeoutMs: 15 * 60_000 })
    if (bundle.code !== 0) {
      throw new Error(`Sandboxed exact-commit author bundle failed (${sha256Colon(bundle.stderr)}).`)
    }
    await assertManifestFilesUnchanged(sourceStage, sourceStageManifest, 'Allowlisted author source stage')
    const postBuildDependencyManifest = await buildDependencyManifest(nodeModules)
    if (canonicalize(postBuildDependencyManifest) !== canonicalize(dependencyManifest)) {
      throw new Error('Sandboxed author build changed its reviewed dependency closure.')
    }
    const postBuildStatus = await runProcess('/usr/bin/git', [
      '-C', checkout, 'status', '--porcelain=v1', '--untracked-files=all',
    ], { cwd: checkout, env: gitEnvironment(), timeoutMs: 30_000 })
    if (postBuildStatus.code !== 0 || postBuildStatus.stdout.trim() !== '') {
      throw new Error('Sandboxed build changed tracked exact-commit source.')
    }
    const graphReportPath = candidateBuildEnvironment.PHASE9_AUTHOR_GRAPH_REPORT
    const graphInfo = await stat(graphReportPath)
    if (graphInfo.uid !== process.getuid() || (graphInfo.mode & 0o077) !== 0
      || graphInfo.size < 1 || graphInfo.size > MAX_PROCESS_OUTPUT) {
      throw new Error('Trusted author graph report has unsafe permissions or size.')
    }
    const rawGraph = JSON.parse(await readFile(graphReportPath, 'utf8'))
    const authorSourceGraphPayload = {
      ...rawGraph,
      stageContentHash: sha256Colon(sourceStageManifest),
    }
    const authorSourceGraph = {
      ...authorSourceGraphPayload,
      graphHash: sha256Colon(authorSourceGraphPayload),
    }
    const built = await contentManifest(detachedOutput, 'detached author build', {
      maxEntries: 20_000,
      maxFileBytes: 512 * 1024 ** 2,
      maxTotalBytes: 4 * 1024 ** 3,
    })
    const installedParent = path.join(runRoot, 'installed-author-build')
    await mkdir(installedParent, { mode: 0o700 })
    const applicationRoot = path.join(installedParent, 'dist-amnesia-author')
    await cp(detachedOutput, applicationRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: false,
    })
    const canonicalRoot = await canonicalDirectory(applicationRoot, 'exact-head author build')
    const installed = await contentManifest(canonicalRoot, 'installed exact-head author build', {
      maxEntries: 20_000,
      maxFileBytes: 512 * 1024 ** 2,
      maxTotalBytes: 4 * 1024 ** 3,
    })
    if (canonicalize(installed.manifest) !== canonicalize(built.manifest)) {
      throw new Error('Installed author build differs from the clean detached build.')
    }
    return {
      applicationRoot: canonicalRoot,
      applicationBuildHash: installed.contentHash,
      applicationManifest: installed.manifest,
      buildParameters,
      authorSourceGraph,
      authorSourceStageManifest: sourceStageManifest,
      buildDependencyManifest: dependencyManifest,
      buildChecks,
    }
  } finally {
    if (worktreeAdded) {
      await git(['worktree', 'remove', '--force', checkout], { timeoutMs: 120_000 }).catch(() => {})
    }
  }
}

function brokerParameters({ runtime, applicationRoot, datasetRoot, outputRoot, profile, scratch, port }) {
  return {
    NODE_RUNTIME_ROOT: runtime.nodeRoot,
    PLAYWRIGHT_ROOT: runtime.playwrightRoot,
    PLAYWRIGHT_CORE_ROOT: runtime.playwrightCoreRoot,
    CHROME_ROOT: runtime.chromeRoot,
    BROKER_FILE: BROKER_PROGRAM,
    PROBE_FILE: BROKER_PROBE,
    APPLICATION_ROOT: applicationRoot,
    APPLICATION_REAL_ROOT: applicationRoot,
    DATASET_ROOT: datasetRoot,
    DATASET_REAL_ROOT: datasetRoot,
    BROWSER_PROFILE: profile,
    BROWSER_PROFILE_REAL: profile,
    RUNTIME_SCRATCH: scratch,
    RUNTIME_SCRATCH_REAL: scratch,
    SYSTEM_SOCKET_ROOT: runtime.systemTmp,
    SYSTEM_SOCKET_REAL_ROOT: runtime.systemTmpReal,
    OUTPUT_ROOT: outputRoot,
    OUTPUT_REAL_ROOT: outputRoot,
    LOOPBACK_BIND_ENDPOINT: `localhost:${port}`,
    LOOPBACK_REMOTE_ENDPOINT: `localhost:${port}`,
  }
}

function brokerEnvironment(scratch) {
  return {
    HOME: scratch,
    TMPDIR: scratch,
    CFFIXED_USER_HOME: scratch,
    XDG_CACHE_HOME: scratch,
    XDG_CONFIG_HOME: scratch,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

async function prepareControllerState(runRoot) {
  const home = path.join(runRoot, 'controller-home')
  const codexHome = path.join(home, '.codex')
  const openaiSupport = path.join(home, 'Library', 'Application Support', 'OpenAI')
  const codexSupport = path.join(home, 'Library', 'Application Support', 'Codex')
  const temporary = path.join(runRoot, 'controller-tmp')
  for (const directory of [codexHome, openaiSupport, codexSupport, temporary]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await canonicalDirectory(directory, 'fresh controller state directory', {
      mustBeEmpty: true,
      ownerOnly: true,
    })
  }
  const sourceAuth = await canonicalFile(path.join(homedir(), '.codex', 'auth.json'), 'Codex auth material')
  const sourceInfo = await stat(sourceAuth)
  if (sourceInfo.uid !== process.getuid() || (sourceInfo.mode & 0o077) !== 0) {
    throw new Error('Codex auth material must be owner-only.')
  }
  const authFile = path.join(codexHome, 'auth.json')
  await cp(sourceAuth, authFile, { force: false, errorOnExist: true })
  await chmod(authFile, 0o600)
  return { home, codexHome, openaiSupport, codexSupport, temporary, authFile }
}

async function controllerParameters({ runtime, controlRoot, port, state }) {
  return {
    CODEX_RUNTIME_ROOT: runtime.codexRoot,
    CONTROL_ROOT: controlRoot,
    CONTROL_REAL_ROOT: controlRoot,
    CODEX_BINARY: runtime.codex,
    CODEX_HOME_ROOT: state.codexHome,
    OPENAI_SUPPORT_ROOT: state.openaiSupport,
    CODEX_SUPPORT_ROOT: state.codexSupport,
    SYSTEM_TMP: state.temporary,
    BROKER_REMOTE_ENDPOINT: `localhost:${port}`,
  }
}

function controllerEnvironment(state) {
  return {
    HOME: state.home,
    CODEX_HOME: state.codexHome,
    TMPDIR: state.temporary,
    CFFIXED_USER_HOME: state.home,
    XDG_CACHE_HOME: state.temporary,
    XDG_CONFIG_HOME: state.temporary,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C',
    LC_ALL: 'C',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

export function buildAuthorPrompt({ datasetId, caseId, capabilities, port, controllerToken }) {
  if (!AMNESIA_DATASETS.includes(datasetId) || !SAFE_ID_PATTERN.test(caseId)
    || !exactStringSet(capabilities, COUNTED_TARGETS[datasetId].requiredCapabilities)
    || !Number.isSafeInteger(port) || port < 1024 || port > 65535
    || !/^[0-9a-f]{64}$/u.test(controllerToken)) throw new Error('Invalid author prompt inputs.')
  const api = `http://127.0.0.1:${port}/__phase9`
  return [
    'You are the fresh isolated EgoLens Adapter Amnesia author for one counted source case.',
    `Dataset identity: ${datasetId}. Public case identity: ${caseId}.`,
    `Public required capabilities: ${[...capabilities].sort().join(', ')}.`,
    '',
    'You have no application, source-path, repository, existing-recipe, oracle, judge, or candidate-output mount.',
    'Do not use live web search, documentation bundles, SDK/devkit loaders, plugins, or prior candidates.',
    'General public knowledge about the named dataset format is allowed, but every source-specific claim must be tested through the public authoring tools.',
    '',
    `The only data interface is the authenticated broker at ${api}.`,
    `For every request pass this header: Authorization: Bearer ${controllerToken}`,
    'Use /usr/bin/curl with only these routes:',
    'GET /ready and GET /tools; POST /call with {"name":<one public tool>,"arguments":{...}};',
    'GET /view; POST /review with {"name":<rendered checkbox label>,"checked":true}; POST /export with {}.',
    `The exact public tool catalog is: ${[...AMNESIA_PUBLIC_TOOLS].sort().join(', ')}.`,
    '',
    'Inspect first, read the public operator contract, and apply transactional revisions. After every accepted revision, use get_state and compare validation capabilities with every required capability above.',
    'Use rendered /view and /review for the human-review controls. Finalize only after public sample validation proves the source facts and all required capabilities.',
    'If the public surface has a capability gap, use other public inspect modes and validator diagnostics to test a minimal hypothesis. If no successful public sample can establish it, stop with authoring-observability-gap and do not export.',
    'Never guess merely to obtain an export. The hidden judge is one-shot and unavailable here.',
    'When the recipe is valid, finalize, complete rendered review, and call /export exactly once. The broker chooses the output path.',
  ].join('\n')
}

function check(id, passed, observation) {
  return { id, passed, observation }
}

function fileDenied(result) {
  return result.code !== 0 && /Operation not permitted|Permission denied/u.test(`${result.stdout}\n${result.stderr}`)
}

// External-egress probes are meaningful only when the same endpoint is
// reachable from outside the sandbox. Without this control an offline host
// would report a denial that Seatbelt never enforced. `-f` is deliberately
// absent: any completed HTTP exchange, whatever its status, proves egress.
const EXTERNAL_PROBE_ARGUMENTS = Object.freeze([
  '--connect-timeout', '1', '--max-time', '2', '-sS', '-o', '/dev/null', 'http://93.184.216.34/',
])

async function externalProbeReachable() {
  const control = await runProcess('/usr/bin/curl', [...EXTERNAL_PROBE_ARGUMENTS], {
    cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, timeoutMs: 10_000,
  })
  return control.code === 0
}

function externalDenialCheck(id, reachable, sandboxed) {
  const passed = reachable && sandboxed.code !== 0
  const observation = !reachable
    ? 'external-control-unreachable'
    : sandboxed.code !== 0 ? 'seatbelt-network-denied' : 'unexpected-external-connect'
  return check(id, passed, observation)
}

async function controllerNegativeChecks({
  controllerParams,
  controllerEnv,
  controlRoot,
  paths,
  port,
  controllerToken,
  codexBinary,
  authFile,
}) {
  const commands = [
    ['controller-application-read-denied', paths.application],
    ['controller-dataset-read-denied', paths.dataset],
    ['controller-output-read-denied', paths.output],
    ['controller-forbidden-resource-read-denied', paths.forbidden],
  ]
  const checks = []
  for (const [id, filename] of commands) {
    const result = await runSandbox(CONTROLLER_PROFILE, controllerParams, ['/bin/cat', filename], {
      cwd: controlRoot,
      timeoutMs: 10_000,
      env: controllerEnv,
    })
    checks.push(check(id, fileDenied(result), fileDenied(result) ? 'seatbelt-eperm' : 'unexpected-access-result'))
  }
  const external = await runSandbox(CONTROLLER_PROFILE, controllerParams, [
    '/usr/bin/curl', ...EXTERNAL_PROBE_ARGUMENTS,
  ], { cwd: controlRoot, env: controllerEnv, timeoutMs: 10_000 })
  checks.push(externalDenialCheck('controller-external-network-denied', await externalProbeReachable(), external))

  const reexec = await runSandbox(CONTROLLER_PROFILE, controllerParams, [
    '/bin/sh', '-c', 'exec "$1" --version', 'phase9-reexec-probe', codexBinary,
  ], { cwd: controlRoot, env: controllerEnv, timeoutMs: 10_000 })
  checks.push(check('controller-privileged-reexec-denied', fileDenied(reexec),
    fileDenied(reexec) ? 'privileged-path-eperm' : 'unexpected-privileged-reexec'))

  const authRead = await runSandbox(CONTROLLER_PROFILE, controllerParams, ['/bin/cat', authFile], {
    cwd: controlRoot,
    env: controllerEnv,
    timeoutMs: 10_000,
  })
  checks.push(check('controller-auth-read-denied', fileDenied(authRead),
    fileDenied(authRead) ? 'auth-path-eperm' : 'unexpected-auth-read'))

  const decoy = await liveDecoyServer()
  try {
    const nonBroker = await runSandbox(CONTROLLER_PROFILE, controllerParams, [
      '/usr/bin/curl', '--connect-timeout', '1', '--max-time', '2', '-fsS', `http://127.0.0.1:${decoy.port}/`,
    ], { cwd: controlRoot, env: controllerEnv, timeoutMs: 10_000 })
    checks.push(check('controller-nonbroker-loopback-denied', nonBroker.code !== 0,
      nonBroker.code !== 0 ? 'nonbroker-port-denied' : 'unexpected-nonbroker-connect'))
  } finally { await decoy.close() }

  const ready = await runSandbox(CONTROLLER_PROFILE, controllerParams, [
    '/usr/bin/curl', '-fsS', '-H', `Authorization: Bearer ${controllerToken}`,
    `http://127.0.0.1:${port}/__phase9/ready`,
  ], { cwd: controlRoot, env: controllerEnv, timeoutMs: 10_000 })
  let readyValue
  try { readyValue = JSON.parse(ready.stdout) } catch { readyValue = null }
  const loopbackPassed = ready.code === 0 && readyValue?.ok === true
    && exactStringSet(readyValue.tools?.map((entry) => entry.name), AMNESIA_PUBLIC_TOOLS)
  checks.push(check('controller-loopback-allowed', loopbackPassed,
    loopbackPassed ? 'fixed-port-round-trip-ok' : 'unexpected-loopback-result'))
  checks.push(check('public-tool-catalog-exact', loopbackPassed,
    loopbackPassed ? 'exact-five' : 'unexpected-catalog'))
  return checks
}

function parseProbe(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean)
  const value = JSON.parse(lines.at(-1) ?? '{}')
  if (!Array.isArray(value.checks)) throw new Error('Broker negative probe did not return checks.')
  return value
}

async function assertDestroyed(directory, label) {
  try {
    await lstat(directory)
    throw new Error(`${label} was not destroyed.`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function runCase(options) {
  assertSupportedCountedHost()
  requireOptions(options, [
    'candidate-commit', 'dataset-id', 'case-id',
    'dataset', 'capture-config', 'output-root', 'evidence-dir',
  ])
  const candidateCommit = assertValue(options['candidate-commit'], COMMIT_PATTERN, 'Invalid candidate commit.')
  const datasetId = options['dataset-id']
  if (!AMNESIA_DATASETS.includes(datasetId)) throw new Error('Invalid dataset id.')
  const target = COUNTED_TARGETS[datasetId]
  const caseId = assertValue(options['case-id'], SAFE_ID_PATTERN, 'Invalid case id.')
  if (caseId !== target.caseId) throw new Error('Case id does not match the reviewed counted target.')

  let runRoot
  let broker
  let brokerPort
  let adminToken
  try {
    const captureConfig = await readTrustedCaptureConfig(options['capture-config'], {
      datasetId,
      caseId,
      requiredCapabilities: target.requiredCapabilities,
    })
    const sourceFingerprint = captureConfig.sourceFingerprint
    const datasetRoot = await canonicalDirectory(options.dataset, 'one source case')
    const outputRoot = await canonicalDirectory(options['output-root'], 'candidate output', {
      mustBeEmpty: true,
      ownerOnly: true,
    })
    await mkdir(options['evidence-dir'], { recursive: true, mode: 0o700 })
    const evidenceRoot = await canonicalDirectory(options['evidence-dir'], 'protected evidence', {
      ownerOnly: true,
    })
    const sourceTree = await contentManifest(datasetRoot, 'one source case')
    const datasetProbe = sourceTree.firstFile
    const forbiddenProbe = await canonicalFile(
      path.join(REPOSITORY_ROOT, 'src', 'adapters', 'recipes', target.forbiddenRecipe),
      'forbidden bundled recipe',
    )
    runRoot = await mkdtemp('/private/tmp/egolens-phase9-counted-')
    runRoot = await canonicalDirectory(runRoot, 'atomic counted run root', {
      mustBeEmpty: true,
      ownerOnly: true,
    })
    const runtime = await resolveRuntime()
    const exactBuild = await prepareExactApplication({ candidateCommit, runRoot, runtime })
    const { applicationRoot, applicationBuildHash } = exactBuild
    const appProbe = await canonicalFile(applicationProbe(applicationRoot), 'author application entry')
    const controlRoot = path.join(runRoot, 'controller')
    const profileRoot = path.join(runRoot, 'browser-profile')
    const scratchRoot = path.join(runRoot, 'runtime-scratch')
    await Promise.all([controlRoot, profileRoot, scratchRoot].map(async (directory) => {
      await mkdir(directory, { mode: 0o700 })
      await canonicalDirectory(directory, 'fresh runtime directory', {
        mustBeEmpty: true,
        ownerOnly: true,
      })
    }))
    const controllerState = await prepareControllerState(runRoot)
    assertDisjointBoundaryPaths({
      applicationRoot,
      datasetRoot,
      outputRoot,
      evidenceRoot,
      captureConfigFile: captureConfig.canonicalPath,
      controlRoot,
      profileRoot,
      scratchRoot,
      controllerHome: controllerState.home,
      controllerTemporary: controllerState.temporary,
      buildSourceStage: exactBuild.buildParameters.SOURCE_STAGE_ROOT,
      buildHome: exactBuild.buildParameters.BUILD_HOME,
      buildNodeModules: exactBuild.buildParameters.NODE_MODULES_ROOT,
    })

    for (const [runtimeName, runtimeRoot] of Object.entries({
      nodeRuntime: runtime.nodeRoot,
      playwrightRuntime: runtime.playwrightRoot,
      playwrightCoreRuntime: runtime.playwrightCoreRoot,
      chromeRuntime: runtime.chromeRoot,
      codexRuntime: runtime.codexRoot,
      systemSocketRuntime: runtime.systemTmp,
      systemSocketRealRuntime: runtime.systemTmpReal,
    })) {
      assertDisjointBoundaryPaths({
        [runtimeName]: runtimeRoot,
        applicationRoot,
        datasetRoot,
        outputRoot,
        evidenceRoot,
        captureConfigFile: captureConfig.canonicalPath,
        controlRoot,
        profileRoot,
        scratchRoot,
        controllerHome: controllerState.home,
        controllerTemporary: controllerState.temporary,
        buildSourceStage: exactBuild.buildParameters.SOURCE_STAGE_ROOT,
        buildHome: exactBuild.buildParameters.BUILD_HOME,
        buildNodeModules: exactBuild.buildParameters.NODE_MODULES_ROOT,
      })
    }
    for (const [forbiddenName, forbiddenRoot] of Object.entries({
      repositoryRoot: await canonicalDirectory(REPOSITORY_ROOT, 'repository root'),
      oracleRoot: await canonicalDirectory(path.join(REPOSITORY_ROOT, 'benchmarks', 'oracle'), 'oracle root'),
      recipeRoot: await canonicalDirectory(path.join(REPOSITORY_ROOT, 'src', 'adapters', 'recipes'), 'recipe root'),
    })) {
      assertDisjointBoundaryPaths({
        [forbiddenName]: forbiddenRoot,
        applicationRoot,
        datasetRoot,
        outputRoot,
        evidenceRoot,
        captureConfigFile: captureConfig.canonicalPath,
        controlRoot,
        profileRoot,
        scratchRoot,
        controllerHome: controllerState.home,
        controllerTemporary: controllerState.temporary,
        buildSourceStage: exactBuild.buildParameters.SOURCE_STAGE_ROOT,
        buildHome: exactBuild.buildParameters.BUILD_HOME,
        buildNodeModules: exactBuild.buildParameters.NODE_MODULES_ROOT,
      })
    }
    brokerPort = await unusedPort()
    const controllerToken = randomToken()
    const browserToken = randomToken()
    adminToken = randomToken()
    const outputFile = path.join(outputRoot, `${datasetId}.egolens-adapter.json`)
    const brokerParams = brokerParameters({
      runtime, applicationRoot, datasetRoot, outputRoot,
      profile: profileRoot, scratch: scratchRoot, port: brokerPort,
    })
    const controllerParams = await controllerParameters({
      runtime,
      controlRoot,
      port: brokerPort,
      state: controllerState,
    })
    const brokerEnv = brokerEnvironment(scratchRoot)
    const controllerEnv = controllerEnvironment(controllerState)
    const { descriptor: policyDescriptor, policyHash } = await effectivePolicyDescriptor({
      brokerProfilePath: BROKER_PROFILE,
      brokerParameters: brokerParams,
      controllerProfilePath: CONTROLLER_PROFILE,
      controllerParameters: controllerParams,
      buildProfilePath: BUILD_PROFILE,
      buildParameters: exactBuild.buildParameters,
      authorSourceGraph: exactBuild.authorSourceGraph,
      authorSourceStageManifest: exactBuild.authorSourceStageManifest,
      runtimeManifest: runtime.runtimeManifest,
      buildDependencyManifest: exactBuild.buildDependencyManifest,
      applicationBuild: {
        sourceCommit: candidateCommit,
        applicationBuildHash,
        fileCount: exactBuild.applicationManifest.fileCount,
        totalBytes: exactBuild.applicationManifest.totalBytes,
      },
      sourceManifest: {
        sourceFingerprint,
        sourceContentHash: sourceTree.canonicalHash,
        captureConfigHash: captureConfig.captureConfigHash,
        fileCount: sourceTree.manifest.fileCount,
        totalBytes: sourceTree.manifest.totalBytes,
      },
      protectedRoots: {
        captureConfigFile: captureConfig.canonicalPath,
        evidenceRoot,
      },
      controllerState: {
        authMaterial: 'auth-json-only',
        destroyedAfter: true,
        freshBefore: true,
      },
    })

    const systemSocketProbe = path.join(runtime.systemTmp, `.egolens-phase9-socket-probe-${randomToken()}`)
    await writeFile(systemSocketProbe, 'ambient temporary contents must remain unreadable\n', {
      flag: 'wx',
      mode: 0o600,
    })

    let brokerProbeResult
    try {
      brokerProbeResult = await runSandbox(BROKER_PROFILE, brokerParams, [
        runtime.node,
        BROKER_PROBE,
        '--application-probe', appProbe,
        '--dataset-probe', datasetProbe,
        '--output-root', outputRoot,
        '--forbidden-probe', forbiddenProbe,
        '--system-socket-probe', systemSocketProbe,
        '--port', String(brokerPort),
      ], { cwd: scratchRoot, env: brokerEnv, timeoutMs: 20_000 })
    } finally {
      await unlink(systemSocketProbe).catch(() => {})
    }
    const brokerProbeReport = parseProbe(brokerProbeResult.stdout)
    if (brokerProbeResult.code !== 0 || brokerProbeReport.passed !== true) {
      throw new Error('Strict broker negative probe failed.')
    }
    await canonicalDirectory(outputRoot, 'candidate output', {
      mustBeEmpty: true,
      ownerOnly: true,
    })

    const brokerCommand = [
      runtime.node,
      BROKER_PROGRAM,
      '--application', applicationRoot,
      '--dataset', datasetRoot,
      '--profile', profileRoot,
      '--scratch', scratchRoot,
      '--output-file', outputFile,
      '--port', String(brokerPort),
      '--controller-token', controllerToken,
      '--browser-token', browserToken,
      '--admin-token', adminToken,
      '--chrome', runtime.chrome,
      '--playwright', runtime.playwright,
    ]
    broker = await startBroker({
      argumentsValue: sandboxArguments(BROKER_PROFILE, brokerParams, brokerCommand),
      cwd: scratchRoot,
      env: brokerEnv,
    })
    if (!exactStringSet(broker.ready.publicTools, AMNESIA_PUBLIC_TOOLS)) {
      throw new Error('Counted broker exposed an invalid public tool catalog.')
    }

    const outputProbe = path.join(outputRoot, '.controller-read-probe')
    await writeFile(outputProbe, 'controller must not read this\n', { flag: 'wx', mode: 0o600 })
    let controllerChecks
    try {
      controllerChecks = await controllerNegativeChecks({
        controllerParams,
        controllerEnv,
        controlRoot,
        paths: { application: appProbe, dataset: datasetProbe, output: outputProbe, forbidden: forbiddenProbe },
        port: brokerPort,
        controllerToken,
        codexBinary: runtime.codex,
        authFile: controllerState.authFile,
      })
    } finally { await unlink(outputProbe).catch(() => {}) }
    if (controllerChecks.some((entry) => !entry.passed)) throw new Error('Controller isolation probe failed.')

    const prompt = buildAuthorPrompt({
      datasetId,
      caseId,
      capabilities: target.requiredCapabilities,
      port: brokerPort,
      controllerToken,
    })
    const controllerResult = await runSandbox(CONTROLLER_PROFILE, controllerParams, [
      runtime.codex,
      ...controllerExecArguments({ controlRoot, prompt }),
    ], {
      cwd: controlRoot,
      env: controllerEnv,
      timeoutMs: Number(options['timeout-ms'] ?? 45 * 60_000),
    })
    if (controllerResult.code !== 0) {
      throw new Error(`Isolated Codex author did not complete (${sha256Colon(controllerResult.stderr)}).`)
    }

    const auditEnvelope = await requestJson({
      port: brokerPort,
      token: adminToken,
      pathname: '/__phase9/audit',
    })
    const audit = auditEnvelope?.audit
    if (auditEnvelope?.ok !== true || audit?.exported !== true
      || !exactStringSet(audit.publicTools, AMNESIA_PUBLIC_TOOLS)) {
      throw new Error('Broker audit does not prove a public-only candidate export.')
    }
    await stopBroker(broker, brokerPort, adminToken)
    broker = null

    const [postApplication, postSource] = await Promise.all([
      contentManifest(applicationRoot, 'post-run exact-head author build', {
        maxEntries: 20_000,
        maxFileBytes: 512 * 1024 ** 2,
        maxTotalBytes: 4 * 1024 ** 3,
      }),
      contentManifest(datasetRoot, 'post-run one source case'),
    ])
    if (postApplication.contentHash !== applicationBuildHash
      || canonicalize(postApplication.manifest) !== canonicalize(exactBuild.applicationManifest)) {
      throw new Error('Author application changed during the counted run.')
    }
    if (postSource.canonicalHash !== sourceTree.canonicalHash
      || canonicalize(postSource.manifest) !== canonicalize(sourceTree.manifest)) {
      throw new Error('Source case changed during the counted run.')
    }
    const postCaptureConfig = await readTrustedCaptureConfig(captureConfig.canonicalPath, {
      datasetId,
      caseId,
      requiredCapabilities: target.requiredCapabilities,
    })
    if (postCaptureConfig.captureConfigHash !== captureConfig.captureConfigHash
      || postCaptureConfig.sourceFingerprint !== sourceFingerprint) {
      throw new Error('Protected Phase 6 capture config changed during the counted run.')
    }

    const outputEntries = await readdir(outputRoot)
    if (outputEntries.length !== 1 || outputEntries[0] !== path.basename(outputFile)) {
      throw new Error('Candidate output mount contains an unexpected artifact.')
    }
    const recipe = JSON.parse(await readFile(outputFile, 'utf8'))
    if (recipe?.kind !== 'egolens-adapter' || recipe?.schemaVersion !== 1
      || recipe?.provenance?.author !== 'codex') {
      throw new Error('Candidate export is not a Codex-authored EgoLens adapter recipe.')
    }
    const recipeHash = recipeSemanticHash(recipe)
    if (!SHA256_PATTERN.test(recipeHash)) throw new Error('Candidate recipe semantic hash is invalid.')

    const runId = `phase9-${datasetId}-${randomToken().slice(0, 16)}`
    const allChecks = [...exactBuild.buildChecks, ...brokerProbeReport.checks, ...controllerChecks]
    const probeReport = createProbeReport({
      candidateCommit, datasetId, caseId, runId, policyHash, checks: allChecks,
    })
    if (probeReport.passed !== true) throw new Error('Counted negative-probe report is incomplete.')

    await rm(runRoot, { recursive: true })
    await Promise.all([
      assertDestroyed(profileRoot, 'browser profile'),
      assertDestroyed(scratchRoot, 'runtime scratch'),
      assertDestroyed(controlRoot, 'controller root'),
      assertDestroyed(controllerState.home, 'controller home'),
      assertDestroyed(controllerState.temporary, 'controller temporary root'),
      assertDestroyed(applicationRoot, 'installed author build'),
      assertDestroyed(exactBuild.buildParameters.SOURCE_STAGE_ROOT, 'author source stage'),
      assertDestroyed(exactBuild.buildParameters.BUILD_HOME, 'author build home'),
      assertDestroyed(exactBuild.buildParameters.NODE_MODULES_ROOT, 'detached build dependencies'),
    ])
    runRoot = null
    const boundaryCase = makeBoundaryCase({
      datasetId,
      caseId,
      runId,
      sourceCommit: candidateCommit,
      applicationBuildHash,
      recipeHash,
      sourceFingerprint,
      sourceContentHash: sourceTree.canonicalHash,
      policyHash,
      negativeProbeReportHash: probeReport.probeHash,
      applicationRoot,
      datasetRoot,
      outputRoot,
      browserProfile: profileRoot,
      runtimeScratch: scratchRoot,
    })
    const sourceManifestArtifact = createSourceManifestArtifact({
      datasetId,
      caseId,
      sourceFingerprint,
      captureConfigHash: captureConfig.captureConfigHash,
      sourceContentManifest: sourceTree.manifest,
    })
    const artifact = createBoundaryCaseArtifact({
      candidateCommit,
      boundaryCase,
      policyDescriptor,
      probeReport,
      brokerAuditHash: sha256Colon(audit),
      applicationContentManifest: exactBuild.applicationManifest,
      sourceManifestArtifact,
    })
    const probeFile = path.join(evidenceRoot, `${datasetId}.${runId}.negative-probe.json`)
    const caseFile = path.join(evidenceRoot, `${datasetId}.${runId}.boundary-case.json`)
    const sourceFile = path.join(evidenceRoot, `${datasetId}.${runId}.source-manifest.json`)
    await writeProtectedJson(probeFile, probeReport)
    await writeProtectedJson(caseFile, artifact)
    await writeProtectedJson(sourceFile, sourceManifestArtifact)
    process.stdout.write(`${JSON.stringify({
      datasetId,
      caseId,
      runId,
      recipeHash,
      applicationBuildHash,
      boundaryCaseArtifactHash: artifact.artifactHash,
      passed: true,
    })}\n`)
  } finally {
    if (broker) {
      await stopBroker(broker, brokerPort, adminToken).catch(() => {
        killBrokerGroup(broker.child)
      })
    }
    if (runRoot) await rm(runRoot, { recursive: true }).catch(() => {})
  }
}

async function assembleReport(options) {
  assertSupportedCountedHost()
  requireOptions(options, ['candidate-commit', 'output'])
  const candidateCommit = assertValue(options['candidate-commit'], COMMIT_PATTERN, 'Invalid candidate commit.')
  if (!Array.isArray(options.case) || options.case.length !== AMNESIA_DATASETS.length) {
    throw new Error('Exactly three --case artifacts are required.')
  }
  const artifacts = await Promise.all(options.case.map((filename) => readProtectedArtifact(filename, candidateCommit)))
  const report = assembleBoundaryReport({ candidateCommit, caseArtifacts: artifacts })
  const output = path.resolve(options.output)
  const parent = await canonicalDirectory(path.dirname(output), 'protected report directory')
  if (parent !== path.dirname(output)) throw new Error('Protected report directory must already be canonical.')
  await writeProtectedJson(output, report)
  process.stdout.write(`${JSON.stringify({
    candidateCommit,
    reportHash: report.reportHash,
    cases: report.cases.map((entry) => ({
      datasetId: entry.datasetId,
      caseId: entry.caseId,
      runId: entry.runId,
      recipeHash: entry.recipeHash,
      applicationBuildHash: entry.applicationBuildHash,
    })),
    passed: true,
  })}\n`)
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseOptions(argv)
  if (command === 'run-case') await runCase(options)
  else await assembleReport(options)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main()
}
