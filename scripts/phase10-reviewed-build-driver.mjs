#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, readdir } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { phase10ReviewedViteBuildInvocationV1 } from './lib/phase10-build-policy.mjs'
import { phase10VerifierDependencyClosureV1 } from './lib/phase10-evidence.mjs'
import {
  phase10CleanupContainedResidualsV1,
  phase10ContainedEnvironmentV1,
  phase10ContainmentTokenV1,
} from './lib/phase10-process-containment.mjs'

const MAX_OUTPUT = 16 * 1024 * 1024
const TIMEOUT_MS = 15 * 60_000
const DRIVER = fileURLToPath(import.meta.url)
const FIXED_SANDBOX = '/usr/bin/sandbox-exec'

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function parseArgs(argv) {
  const allowed = new Set([
    'production-source', 'author-source', 'node', 'node-modules', 'build-home', 'profile',
    'expected-commit', 'source-tree-hash', 'protected-candidate-repository', 'protected-verifier-root',
    'expected-dependency-closure-hash', 'expected-node-runtime-hash',
  ])
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!allowed.has(name) || result[name] !== undefined) throw new Error(`Invalid option: --${name}`)
    result[name] = argv[++index]
  }
  return result
}

async function canonicalDirectory(value, label) {
  const resolved = path.resolve(value)
  const canonical = await realpath(resolved)
  const details = await lstat(resolved)
  if (canonical !== resolved || !details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a canonical non-symlink directory`)
  }
  return canonical
}

async function canonicalFile(value, label) {
  const resolved = path.resolve(value)
  const canonical = await realpath(resolved)
  const details = await lstat(resolved)
  if (canonical !== resolved || !details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a canonical non-symlink regular file`)
  }
  return canonical
}

async function sourceManifest(root, exclusions) {
  const files = []
  const visit = async (relative) => {
    const entries = (await readdir(path.join(root, relative), { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (exclusions.has(child.split('/')[0])) continue
      const absolute = path.join(root, child)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`Build source contains a symbolic link: ${child}`)
      if (info.isDirectory()) await visit(child)
      else if (info.isFile()) {
        const bytes = await readFile(absolute)
        files.push({ path: child, bytes: bytes.length, sha256: sha256(bytes) })
      } else throw new Error(`Build source contains an unsupported entry: ${child}`)
    }
  }
  await visit('')
  return {
    kind: 'egolens-canonical-content-manifest', schemaVersion: 1, files,
    fileCount: files.length, totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
  try { child.kill('SIGKILL') } catch { /* already exited */ }
}

async function run(file, argv, { cwd, env, timeoutMs = TIMEOUT_MS } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killGroup(child)
      callback()
    }
    const append = (current, chunk) => {
      if (Buffer.byteLength(current) + chunk.length > MAX_OUTPUT) {
        finish(() => reject(new Error('Sandboxed build output exceeded its bounded limit')))
        return current
      }
      return current + chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code, signal) => finish(() => resolve({ code, signal, stdout, stderr })))
    timer = setTimeout(() => finish(() => reject(new Error('Sandboxed build timed out'))), timeoutMs)
  })
}

function sandboxArguments(profile, parameters, command) {
  const result = ['-f', profile]
  for (const [name, value] of Object.entries(parameters)) result.push('-D', `${name}=${value}`)
  result.push(...command)
  return result
}

function environment(node, buildHome, expectedCommit, sourceTreeHash, containmentToken, extra = {}) {
  return phase10ContainedEnvironmentV1({
    HOME: buildHome, TMPDIR: buildHome, CFFIXED_USER_HOME: buildHome,
    XDG_CACHE_HOME: buildHome, XDG_CONFIG_HOME: buildHome, XDG_DATA_HOME: buildHome,
    PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'C', LC_ALL: 'C', CI: 'true', NO_PROXY: '*', no_proxy: '*',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', EGOLENS_GIT_COMMIT: expectedCommit,
    EGOLENS_SOURCE_TREE_HASH: sourceTreeHash,
    ...extra,
  }, containmentToken)
}

async function decoyServer() {
  const server = net.createServer((socket) => socket.end('unexpected'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start network-denial probe')
  return {
    port: address.port,
    async close() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const PROBE = String.raw`
const fs = require('node:fs'); const net = require('node:net'); const {spawn} = require('node:child_process');
const [candidate, verifier, home, tracked, port, residualMarker] = process.argv.slice(1); const results = {};
for (const [name, filename] of Object.entries({candidateGit: candidate + '/.git/HEAD', verifier: verifier + '/package.json'})) {
  try { fs.readFileSync(filename); results[name] = false } catch (error) { results[name] = error.code === 'EPERM' }
}
try { fs.readdirSync(home); results.home = false } catch (error) { results.home = error.code === 'EPERM' }
try { fs.writeFileSync(tracked, 'tamper'); results.trackedWrite = false } catch (error) { results.trackedWrite = error.code === 'EPERM' }
const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', residualMarker], {detached: true, stdio: 'ignore'}); escaped.unref(); results.detachedPid = escaped.pid;
const socket = net.connect({host: '127.0.0.1', port: Number(port)}); let finished = false; let timer;
const done = value => { if (finished) return; finished = true; clearTimeout(timer); results.network = value; socket.destroy(); process.stdout.write(JSON.stringify(results)) };
socket.once('connect', () => done(false)); socket.once('error', (error) => done(error.code === 'EPERM')); timer = setTimeout(() => done(false), 2000);
`

const options = parseArgs(process.argv.slice(2))
for (const name of [
  'production-source', 'author-source', 'node', 'node-modules', 'build-home', 'profile',
  'expected-commit', 'source-tree-hash', 'protected-candidate-repository', 'protected-verifier-root',
  'expected-dependency-closure-hash', 'expected-node-runtime-hash',
]) if (!options[name]) throw new Error(`Missing --${name}`)
if (process.platform !== 'darwin' || !/^[0-9a-f]{40}$/u.test(options['expected-commit'])
  || !/^sha256:[0-9a-f]{64}$/u.test(options['source-tree-hash'])
  || !/^sha256:[0-9a-f]{64}$/u.test(options['expected-dependency-closure-hash'])
  || !/^sha256:[0-9a-f]{64}$/u.test(options['expected-node-runtime-hash'])) {
  throw new Error('Reviewed Phase 10 builds require macOS and exact candidate identities')
}
const [productionSource, authorSource, node, nodeModules, buildHome, profile, candidateRepository, verifierRoot] = await Promise.all([
  canonicalDirectory(options['production-source'], 'production source stage'),
  canonicalDirectory(options['author-source'], 'author source stage'),
  canonicalFile(options.node, 'Node executable'), canonicalDirectory(options['node-modules'], 'node_modules'),
  canonicalDirectory(options['build-home'], 'build home'), canonicalFile(options.profile, 'Seatbelt profile'),
  canonicalDirectory(options['protected-candidate-repository'], 'protected candidate repository'),
  canonicalDirectory(options['protected-verifier-root'], 'protected verifier root'),
])
for (const protectedRoot of [candidateRepository, verifierRoot]) {
  if ([productionSource, authorSource].some((source) => protectedRoot === source
    || protectedRoot.startsWith(`${source}${path.sep}`) || source.startsWith(`${protectedRoot}${path.sep}`))) {
    throw new Error('Reviewed source stages and protected roots must be disjoint')
  }
}
const production = await canonicalDirectory(path.join(productionSource, 'dist'), 'production output')
const author = await canonicalDirectory(path.join(authorSource, 'dist-amnesia-author'), 'author output')
const nodeRuntimeHash = sha256(await readFile(node))
const dependencyBefore = await phase10VerifierDependencyClosureV1(nodeModules)
if (nodeRuntimeHash !== options['expected-node-runtime-hash']
  || dependencyBefore.closureHash !== options['expected-dependency-closure-hash']) {
  throw new Error('Build runtime does not match the operator-approved dependency closure')
}
const common = {
  NODE_RUNTIME_ROOT: path.dirname(path.dirname(node)), NODE_MODULES_ROOT: nodeModules,
  BUILD_HOME: buildHome,
}
const sandbox = async (sourceRoot, outputRoot, command, extraEnv = {}, cwd = sourceRoot) => {
  const containmentToken = phase10ContainmentTokenV1()
  let result
  let runError
  try {
    result = await run(
      FIXED_SANDBOX,
      sandboxArguments(profile, { ...common, SOURCE_ROOT: sourceRoot, OUTPUT_ROOT: outputRoot }, command),
      {
        cwd,
        env: environment(
          node, buildHome, options['expected-commit'], options['source-tree-hash'], containmentToken, extraEnv,
        ),
      },
    )
  } catch (error) {
    runError = error
  }
  let residualPids
  try {
    residualPids = await phase10CleanupContainedResidualsV1(containmentToken)
  } catch (cleanupError) {
    if (runError) {
      throw new AggregateError([runError, cleanupError], 'Sandboxed build failed and residual cleanup did not complete')
    }
    throw cleanupError
  }
  if (runError) throw runError
  return { ...result, residualPids }
}
const exclusions = new Set(['dist', 'dist-amnesia-author', 'node_modules'])
const [productionBefore, authorBefore] = await Promise.all([
  sourceManifest(productionSource, exclusions), sourceManifest(authorSource, exclusions),
])
const decoy = await decoyServer()
let probe
let probeResidualPids
try {
  const result = await sandbox(productionSource, production, [node, '-e', PROBE,
    candidateRepository, verifierRoot, os.homedir(), path.join(productionSource, 'package.json'),
    String(decoy.port), options['source-tree-hash']])
  if (result.code !== 0) throw new Error(`Build boundary negative probe failed (${sha256(result.stderr)})`)
  probe = JSON.parse(result.stdout)
  probeResidualPids = result.residualPids
} finally { await decoy.close() }
if (Object.keys(probe).sort().join(',') !== 'candidateGit,detachedPid,home,network,trackedWrite,verifier'
  || !Number.isSafeInteger(probe.detachedPid)
  || !probeResidualPids.includes(probe.detachedPid)
  || Object.entries(probe).some(([key, passed]) => key !== 'detachedPid' && passed !== true)) {
  throw new Error('Build boundary negative probes did not prove deny-default isolation')
}

// Vite runs with its cwd in the fresh driver-owned build home, never in a
// candidate stage: see phase10ReviewedViteBuildInvocationV1 for why the
// runner config loader makes the process cwd an auto-discovery surface.
const productionVite = phase10ReviewedViteBuildInvocationV1({
  node, nodeModules, configFile: path.join(productionSource, 'vite.config.ts'),
  sourceRoot: productionSource, cwd: buildHome,
})
for (const { command, cwd } of [
  { command: [node, path.join(nodeModules, 'typescript', 'bin', 'tsc'), '-b', path.join(productionSource, 'tsconfig.counted-production.json')], cwd: buildHome },
  productionVite,
]) {
  const result = await sandbox(productionSource, production, command, {}, cwd)
  if (result.code !== 0) throw new Error(`Sandboxed production build failed (${sha256(result.stderr)})`)
  if (result.residualPids.length !== 0) throw new Error('Production build spawned a detached residual process')
}
const graphReport = path.join(buildHome, 'author-source-graph.json')
const authorEnvironment = { PHASE9_AUTHOR_GRAPH_REPORT: graphReport, PHASE9_SOURCE_COMMIT: options['expected-commit'] }
const authorVite = phase10ReviewedViteBuildInvocationV1({
  node, nodeModules, configFile: path.join(authorSource, 'scripts', 'phase9-counted-author-vite.config.ts'),
  sourceRoot: authorSource, cwd: buildHome,
})
for (const { command, cwd } of [
  { command: [node, path.join(nodeModules, 'typescript', 'bin', 'tsc'), '--project', path.join(authorSource, 'tsconfig.counted-author.json')], cwd: buildHome },
  authorVite,
]) {
  const result = await sandbox(authorSource, author, command, authorEnvironment, cwd)
  if (result.code !== 0) throw new Error(`Sandboxed author-closure build failed (${sha256(result.stderr)})`)
  if (result.residualPids.length !== 0) throw new Error('Author build spawned a detached residual process')
}
const rawGraph = JSON.parse(await readFile(graphReport, 'utf8'))
if (rawGraph?.kind !== 'egolens-counted-author-source-graph' || rawGraph.schemaVersion !== 1
  || rawGraph.sourceCommit !== options['expected-commit'] || !Array.isArray(rawGraph.modules)
  || rawGraph.moduleCount !== rawGraph.modules.length
  || rawGraph.modules.some((entry, index) => !entry.path || !/^sha256:[0-9a-f]{64}$/u.test(entry.sha256)
    || (index > 0 && rawGraph.modules[index - 1].path >= entry.path))) {
  throw new Error('Pinned author graph policy did not emit a canonical reviewed graph report')
}
const [productionAfter, authorAfter] = await Promise.all([
  sourceManifest(productionSource, exclusions), sourceManifest(authorSource, exclusions),
])
const dependencyAfter = await phase10VerifierDependencyClosureV1(nodeModules)
if (canonicalize(productionAfter) !== canonicalize(productionBefore)
  || canonicalize(authorAfter) !== canonicalize(authorBefore)
  || dependencyAfter.closureHash !== dependencyBefore.closureHash) {
  throw new Error('Sandboxed build changed an immutable staged source closure')
}
const payload = {
  schema: 'egolens-phase10-reviewed-build-driver-v1', candidateCommit: options['expected-commit'],
  sourceTreeHash: options['source-tree-hash'], productionSourceStageHash: sha256(canonicalize(productionBefore)),
  authorSourceStageHash: sha256(canonicalize(authorBefore)), authorSourceGraphHash: sha256(canonicalize(rawGraph)),
  sandboxProfileHash: sha256(await readFile(profile)), reviewedDriverHash: sha256(await readFile(DRIVER)),
  nodeRuntimeHash, dependencyEntryHash: dependencyBefore.closureHash,
  denyDefault: true, gitHistoryAbsent: true, networkDenied: true,
  protectedCandidateRepositoryDenied: true, protectedVerifierCheckoutDenied: true,
  operatorHomeDenied: true, trackedSourceWriteDenied: true,
  authorAllowlistedStage: true, authorPinnedGraphPolicy: true, candidateScriptsInvoked: false,
  reviewedExecutableConfigsOnly: true, detachedChildCleanupVerified: true,
  residualProcessAuditPassed: true, dependencyClosureUnchanged: true,
  trustedEntrypoints: ['typescript/bin/tsc', 'vite/bin/vite.js'], processGroupCleanup: true,
  sourceUnchanged: true, passed: true,
}
process.stdout.write(`${JSON.stringify(payload)}\n`)
