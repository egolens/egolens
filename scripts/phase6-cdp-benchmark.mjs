#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recipeSemanticHash } from './lib/amnesia-evidence.mjs'
import {
  boundaryHashV1,
  countedBrowserSeatbeltArgumentsV1,
  countedSourceBoundaryV1,
  endpointForOriginV1,
  inspectOfficialChromeIdentityV1,
  makeBoundaryEnvironmentV1,
  makeBoundaryRunEvidenceV1,
  requestAuditV1,
  sourceRootCommitmentV1,
} from './lib/phase10-counted-browser-boundary.mjs'
import {
  closeFreshProcessWorkspaceV1,
  createFreshProcessWorkspaceV1,
  validateFreshProcessEvidenceSetV1,
} from './lib/fresh-process-evidence.mjs'
import {
  phase6PerceptualClipV1,
  transportPerceptualClipV2,
} from './lib/perceptual-clip.mjs'
import { selectInitialSceneMilestones } from './lib/phase6-benchmark-summary.mjs'
import {
  loadPhase10ProductionTrustV1,
  phase10HashV1,
  phase10PreflightSourceModeV1,
  phase10VerifierBindingV1,
} from './lib/phase10-evidence.mjs'
import { perceptualRasterSha256V1, perceptualRasterSha256V2 } from './lib/perceptual-raster.mjs'

const CHROME = process.env.EGOLENS_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COUNTED_BROWSER_PROFILE = path.join(TOOL_ROOT, 'scripts/phase10-counted-browser.sb')

function gitRead(argv, encoding = 'utf8') {
  return execFileSync('/usr/bin/git', [
    '-c', 'core.hooksPath=/dev/null', '-C', TOOL_ROOT, ...argv,
  ], {
    encoding,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })
}

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const next = argv[index + 1]
    result[key.slice(2)] = next && !next.startsWith('--') ? argv[++index] : true
  }
  return result
}

function numberArg(options, name, fallback) {
  const value = options[name] === undefined ? fallback : Number(options[name])
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`)
  return value
}

const options = args(process.argv.slice(2))
if (!options.url || !options.output) {
  throw new Error('Usage: npm run benchmark:phase6 -- --url <app-url> --output <json> [--dataset name] [--runs 5]')
}

const runCount = numberArg(options, 'runs', 5)
const warmupCount = numberArg(options, 'warmups', 1)
const seekCount = numberArg(options, 'seeks', 100)
const sceneSwitchCount = numberArg(options, 'scene-switches', 20)
const settleMs = numberArg(options, 'settle-ms', 3_000)
const timeoutMs = numberArg(options, 'timeout-ms', 180_000)
const playbackLoops = numberArg(options, 'playback-loops', 2)
const nominalFps = numberArg(options, 'fps', 10)
const traceEventLimit = numberArg(options, 'trace-event-limit', 100_000)
const traceEnabled = options.trace !== 'off'
if (!Number.isSafeInteger(traceEventLimit) || traceEventLimit <= 0) {
  throw new Error('--trace-event-limit must be a positive integer')
}
const heapSnapshotOutput = options['heap-snapshot']
  ? path.resolve(String(options['heap-snapshot']))
  : null
if (heapSnapshotOutput && warmupCount + runCount !== 1) {
  throw new Error('--heap-snapshot is diagnostic-only and requires exactly one total run')
}
const conformanceConfig = options['conformance-config']
  ? JSON.parse(await readFile(path.resolve(String(options['conformance-config'])), 'utf8'))
  : null
const conformanceOutput = options['conformance-output']
  ? path.resolve(String(options['conformance-output']))
  : null
const perceptualOutputDirectory = options['perceptual-output-dir']
  ? path.resolve(String(options['perceptual-output-dir']))
  : null
const adapterRecipePath = options['adapter-recipe']
  ? path.resolve(String(options['adapter-recipe']))
  : null
const adapterRecipe = adapterRecipePath
  ? JSON.parse(await readFile(adapterRecipePath, 'utf8'))
  : null
const adapterAmnesia = options['adapter-amnesia'] === true
const preflightRecipePath = options['preflight-recipe']
  ? path.resolve(String(options['preflight-recipe']))
  : null
const preflightRecipe = preflightRecipePath
  ? JSON.parse(await readFile(preflightRecipePath, 'utf8'))
  : null
const localSourceRoot = options['local-source']
  ? path.resolve(String(options['local-source']))
  : null
const expectedSourceManifestHash = options['expected-source-manifest-hash']
  ? String(options['expected-source-manifest-hash'])
  : null
const preflightScene = options.scene ? String(options.scene) : null
const preflightPresentation = options.presentation
  ? JSON.parse(await readFile(path.resolve(String(options.presentation)), 'utf8'))
  : null
const expectedPreflightIdentity = options['expected-preflight-identity']
  ? JSON.parse(await readFile(path.resolve(String(options['expected-preflight-identity'])), 'utf8'))
  : null
const expectedCandidateCommit = options['expected-commit'] ? String(options['expected-commit']) : null
const expectedSourceTreeHash = options['expected-source-tree-hash']
  ? String(options['expected-source-tree-hash'])
  : null
const appBuildRootInput = options['app-build-root']
  ? path.resolve(String(options['app-build-root']))
  : null
const expectedAppBuildInventoryHash = options['expected-app-build-inventory-hash']
  ? String(options['expected-app-build-inventory-hash'])
  : null
const preflightIdentityKeys = [
  'datasetId', 'caseId', 'sourceManifestHash', 'catalogHash', 'shareDescriptorHash',
  'recipeHash', 'formatFingerprint', 'operatorSetFingerprint',
]
if (expectedPreflightIdentity
  && JSON.stringify(Object.keys(expectedPreflightIdentity).sort()) !== JSON.stringify([...preflightIdentityKeys].sort())) {
  throw new Error('--expected-preflight-identity must contain the closed Phase 10 identity shape')
}
if (expectedCandidateCommit && !/^[0-9a-f]{40}$/u.test(expectedCandidateCommit)) {
  throw new Error('--expected-commit must be a full lowercase Git SHA')
}
if (expectedSourceTreeHash && !/^sha256:[0-9a-f]{64}$/u.test(expectedSourceTreeHash)) {
  throw new Error('--expected-source-tree-hash must be a lowercase sha256: digest')
}
if (expectedPreflightIdentity && (!expectedCandidateCommit || !expectedSourceTreeHash)) {
  throw new Error('Counted preflight requires --expected-commit and --expected-source-tree-hash')
}
if (expectedSourceManifestHash && !/^sha256:[0-9a-f]{64}$/u.test(expectedSourceManifestHash)) {
  throw new Error('--expected-source-manifest-hash must be a lowercase sha256: digest')
}
if (localSourceRoot && !expectedSourceManifestHash) {
  throw new Error('--local-source requires --expected-source-manifest-hash for counted identity verification')
}
if (preflightRecipe && !localSourceRoot) {
  throw new Error('--preflight-recipe is accepted only with --local-source')
}
if (localSourceRoot && expectedPreflightIdentity && !preflightRecipe) {
  throw new Error('Counted local preflight requires --preflight-recipe')
}
if (preflightRecipe && recipeSemanticHash(preflightRecipe) !== expectedPreflightIdentity?.recipeHash) {
  throw new Error('--preflight-recipe does not match the expected Phase 9 recipe hash')
}
if (adapterRecipe && preflightRecipe) {
  throw new Error('--adapter-recipe and --preflight-recipe are distinct capture modes')
}
if (Boolean(appBuildRootInput) !== Boolean(expectedAppBuildInventoryHash)) {
  throw new Error('--app-build-root and --expected-app-build-inventory-hash must be provided together')
}
if (expectedAppBuildInventoryHash && !/^sha256:[0-9a-f]{64}$/u.test(expectedAppBuildInventoryHash)) {
  throw new Error('--expected-app-build-inventory-hash must be a lowercase sha256: digest')
}
if (expectedPreflightIdentity && !appBuildRootInput) {
  throw new Error('Counted preflight requires --app-build-root and its expected inventory hash')
}
if (expectedPreflightIdentity && localSourceRoot
  && expectedPreflightIdentity.sourceManifestHash !== expectedSourceManifestHash) {
  throw new Error('Local source and expected preflight identity hashes disagree')
}
if (Boolean(conformanceConfig) !== Boolean(conformanceOutput)) {
  throw new Error('--conformance-config and --conformance-output must be provided together')
}
if (adapterAmnesia !== Boolean(adapterRecipe)) {
  throw new Error('--adapter-amnesia and --adapter-recipe <json> must be provided together')
}
if (adapterAmnesia && !conformanceConfig) {
  throw new Error('Adapter Amnesia is available only for a one-shot conformance capture')
}
const preflightSourceMode = phase10PreflightSourceModeV1(
  String(options.url),
  Boolean(localSourceRoot),
)
const countedSourceBoundary = expectedPreflightIdentity
  ? countedSourceBoundaryV1(String(options.url), preflightSourceMode)
  : null
if (expectedPreflightIdentity && process.platform !== 'darwin') {
  throw new Error('Counted Phase 10 browser evidence requires macOS Seatbelt')
}
if (expectedPreflightIdentity && process.env.EGOLENS_CHROME !== undefined) {
  throw new Error('Counted Phase 10 browser evidence does not accept an environment-selected Chrome executable')
}
if (conformanceConfig && (warmupCount !== 0 || runCount !== 1)) {
  throw new Error('conformance capture requires --warmups 0 --runs 1')
}
if (conformanceConfig && (seekCount !== 0 || sceneSwitchCount !== 0 || playbackLoops !== 0)) {
  throw new Error('conformance capture requires --seeks 0 --scene-switches 0 --playback-loops 0')
}
if (conformanceConfig && (!conformanceConfig.datasetId || !conformanceConfig.caseId
  || !/^sha256-[0-9a-f]{64}$/u.test(conformanceConfig.sourceFingerprint)
  || !Array.isArray(conformanceConfig.frameIndices) || conformanceConfig.frameIndices.length === 0
  || !Array.isArray(conformanceConfig.requiredCapabilities)
  || !Array.isArray(conformanceConfig.perceptualCaptures))) {
  throw new Error('Invalid conformance capture configuration')
}
const viewport = String(options.viewport ?? '1440x900').split('x').map(Number)
const switchScenarios = options['switch-scenarios']
  ? JSON.parse(await readFile(path.resolve(String(options['switch-scenarios'])), 'utf8'))
  : []
if (!Array.isArray(switchScenarios)) throw new Error('--switch-scenarios must point to a JSON array')
for (const [index, scenario] of switchScenarios.entries()) {
  if (!scenario || typeof scenario.dataset !== 'string' || typeof scenario.data !== 'string') {
    throw new Error(`Cross-dataset switch scenario ${index} requires string dataset and data fields`)
  }
}
const verifierToolCommit = gitRead(['rev-parse', 'HEAD']).trim()
const verifierToolClean = gitRead(['status', '--porcelain', '--untracked-files=all']).trim().length === 0
const verifierSourceTreeHash = `sha256:${createHash('sha256').update(
  gitRead(['ls-files', '--stage', '-z'], null),
).digest('hex')}`
if (expectedPreflightIdentity && !verifierToolClean) {
  throw new Error('Counted preflight requires a clean external verifier-tool checkout')
}

function withPerf(urlString) {
  const url = new URL(urlString)
  if (url.searchParams.has('share') || url.searchParams.get('shareVersion') === '1') {
    return url.href
  }
  url.searchParams.set('perf', '1')
  url.searchParams.set('benchmarkHold', '1')
  url.searchParams.set('speed', '4')
  if (conformanceConfig || expectedPreflightIdentity) url.searchParams.set('oracleCapture', '1')
  if (adapterAmnesia) url.searchParams.set('adapterAmnesia', '1')
  return url.href
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timeout)
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
        else pending.resolve(message.result ?? {})
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message)
    })
    const rejectPending = () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(`${pending.method}: CDP connection closed`))
        this.pending.delete(id)
      }
    }
    socket.addEventListener('close', rejectPending)
    socket.addEventListener('error', rejectPending)
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new CdpClient(socket)
  }

  send(method, params = {}, sessionId, commandTimeoutMs = 60_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out after ${commandTimeoutMs}ms`))
      }, commandTimeoutMs)
      this.pending.set(id, { resolve, reject, method, timeout })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
    return () => this.listeners.set(method, listeners.filter((entry) => entry !== listener))
  }

  close() {
    this.socket.close()
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForEndpoint(port, processHandle) {
  const endpoint = `http://127.0.0.1:${port}/json/version`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Chrome exited with code ${processHandle.exitCode}`)
    try {
      const response = await fetch(endpoint)
      if (response.ok) return response.json()
    } catch { /* Chrome is still starting. */ }
    await delay(100)
  }
  throw new Error('Timed out waiting for the Chrome debugging endpoint')
}

// A counted run's explicit timeout governs both wait loops and the CDP command
// that awaits an in-page workload. Keeping a hidden 60-second command cap made
// a valid slow Range-backed playback fail before --timeout-ms could apply.
async function evaluate(client, sessionId, expression, commandTimeoutMs = timeoutMs) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId, commandTimeoutMs)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed')
  return result.result?.value
}

async function waitFor(client, sessionId, expression, timeout = timeoutMs) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, sessionId, expression)) return
    } catch { /* The document may be navigating. */ }
    await delay(100)
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

async function enumerateLocalSourceFiles(root) {
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink()) throw new Error('--local-source cannot be a symbolic link')
  if (rootStat.isFile()) return [root]
  if (!rootStat.isDirectory()) throw new Error('--local-source must be a regular file or directory')
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`--local-source contains a symbolic link: ${entry.name}`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(absolute)
      else throw new Error(`--local-source contains a non-regular entry: ${entry.name}`)
      if (files.length > 50_000) throw new Error('--local-source exceeds the 50,000-file browser inventory limit')
    }
  }
  await visit(root)
  if (files.length === 0) throw new Error('--local-source is empty')
  return files
}

const APP_BUILD_CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
})

async function readAppBuildSnapshot(root, retainBytes) {
  const rootDetails = await lstat(root)
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error('--app-build-root must be a real directory, not a symbolic link')
  }
  const canonicalRoot = await realpath(root)
  const files = []
  const responses = new Map()
  let totalBytes = 0
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`App build contains a symbolic link: ${relative}`)
      if (entry.isDirectory()) {
        await visit(absolute, relative)
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute)
        totalBytes += bytes.byteLength
        if (files.length >= 20_000 || totalBytes > 1024 * 1024 * 1024) {
          throw new Error('App build exceeds the immutable serving limit')
        }
        files.push({
          path: relative,
          size: bytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        })
        if (retainBytes) responses.set(relative, bytes)
      } else {
        throw new Error(`App build contains a non-regular entry: ${relative}`)
      }
    }
  }
  await visit(canonicalRoot, '')
  if (files.length === 0 || !responses.has('index.html') && retainBytes) {
    throw new Error('App build must contain index.html and at least one regular file')
  }
  return {
    canonicalRoot,
    files,
    responses,
    inventoryHash: phase10HashV1(files),
  }
}

function requestBuildPath(requestUrl) {
  let decoded
  try {
    decoded = decodeURIComponent(new URL(requestUrl ?? '/', 'http://127.0.0.1/').pathname)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const parts = decoded.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..')) return null
  return parts.length === 0 ? 'index.html' : parts.join('/')
}

async function createImmutableAppBuildServer(root, expectedInventoryHash) {
  const snapshot = await readAppBuildSnapshot(root, true)
  if (snapshot.inventoryHash !== expectedInventoryHash) {
    throw new Error('App build inventory does not match the reproduced production build')
  }
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }
    const requested = requestBuildPath(request.url)
    const bytes = requested ? snapshot.responses.get(requested) : null
    if (!requested || !bytes) {
      response.writeHead(404, { 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': bytes.byteLength,
      'Content-Type': APP_BUILD_CONTENT_TYPES[path.extname(requested).toLowerCase()]
        ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(request.method === 'HEAD' ? undefined : bytes)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Immutable app server has no TCP address')
  return {
    canonicalRoot: snapshot.canonicalRoot,
    inventoryHash: snapshot.inventoryHash,
    origin: `http://127.0.0.1:${address.port}`,
    async diskInventoryHash() {
      return (await readAppBuildSnapshot(snapshot.canonicalRoot, false)).inventoryHash
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
}

async function waitForChromeSelectedEndpoint(profileDir, processHandle) {
  const activePort = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Seatbelt-confined Chrome exited with code ${processHandle.exitCode}`)
    }
    try {
      const [portLine, browserPath, extra] = (await readFile(activePort, 'utf8')).trim().split('\n')
      const port = Number(portLine)
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535 || extra !== undefined
        || !/^\/devtools\/browser\/[0-9a-f-]+$/iu.test(browserPath ?? '')) {
        throw new Error('Chrome emitted an invalid DevToolsActivePort file')
      }
      const endpoint = await waitForEndpoint(port, processHandle)
      if (new URL(endpoint.webSocketDebuggerUrl).port !== String(port)) {
        throw new Error('Chrome debugging endpoint disagrees with its self-selected port')
      }
      return { endpoint, port }
    } catch (error) {
      if (!['ENOENT', 'EBUSY'].includes(error?.code)) {
        if (/invalid DevToolsActivePort|disagrees/u.test(String(error?.message))) throw error
      }
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for Chrome to select its debugging port')
}

async function liveProbeServer(hostname) {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' })
    response.end('ok')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, hostname, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Negative-probe server has no TCP address')
  const literal = address.family === 'IPv6' ? `[${address.address}]` : address.address
  return {
    url: `http://${literal}:${address.port}/live-denial-sentinel`,
    hits: () => hits,
    async close() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function nonLoopbackIpv4Address() {
  return Object.values(os.networkInterfaces()).flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal && entry.address !== '0.0.0.0')?.address ?? null
}

async function fetchFromProbePage(client, sessionId, url) {
  return evaluate(client, sessionId, `(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch(${JSON.stringify(url)}, {
        cache: 'no-store', credentials: 'omit', mode: 'no-cors', redirect: 'error', signal: controller.signal,
      });
      return { resolved: true };
    } catch (error) {
      return { resolved: false, errorName: error?.name ?? 'Error' };
    } finally {
      clearTimeout(timer);
    }
  })()`, 5_000)
}

async function runCountedBrowserNegativeProbe(client, appOrigin, forbiddenFile) {
  const forbiddenLoopback = await liveProbeServer('127.0.0.1')
  const nonLoopbackAddress = nonLoopbackIpv4Address()
  if (!nonLoopbackAddress) {
    await forbiddenLoopback.close()
    throw new Error('A live non-loopback interface is required for counted external-egress denial evidence')
  }
  const externalEgress = await liveProbeServer(nonLoopbackAddress)
  const target = await client.send('Target.createTarget', { url: 'about:blank' })
  const attached = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const session = attached.sessionId
  try {
    await Promise.all([
      client.send('Page.enable', {}, session),
      client.send('DOM.enable', {}, session),
      client.send('Runtime.enable', {}, session),
    ])
    const app = await fetchFromProbePage(client, session, `${appOrigin}/index.html`)
    const forbidden = await fetchFromProbePage(client, session, forbiddenLoopback.url)
    const external = await fetchFromProbePage(client, session, externalEgress.url)

    await evaluate(client, session, `document.body.innerHTML = '<input id="ambient" type="file">'; true`)
    const document = await client.send('DOM.getDocument', { depth: 2 }, session)
    const input = await client.send('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '#ambient',
    }, session)
    let ambientRead = false
    try {
      await client.send('DOM.setFileInputFiles', { files: [forbiddenFile], nodeId: input.nodeId }, session, 5_000)
      ambientRead = await evaluate(client, session, `(async () => {
        try {
          const file = document.querySelector('#ambient')?.files?.[0];
          return file ? (await file.text()).includes('EGOLENS_FORBIDDEN_SENTINEL') : false;
        } catch { return false; }
      })()`, 5_000)
    } catch { /* Seatbelt can reject before Chromium creates the File handle. */ }

    const checks = [
      { name: 'ambient-file-read-denied', passed: ambientRead === false, evidence: 'live-browser-file-read-rejected' },
      { name: 'app-loopback-allowed', passed: app.resolved === true, evidence: 'immutable-app-fetch-resolved' },
      {
        name: 'external-network-denied',
        passed: external.resolved === false && externalEgress.hits() === 0,
        evidence: 'live-non-loopback-listener-unreached',
      },
      {
        name: 'forbidden-loopback-denied',
        passed: forbidden.resolved === false && forbiddenLoopback.hits() === 0,
        evidence: 'live-nonallowlisted-loopback-listener-unreached',
      },
    ]
    if (checks.some((check) => !check.passed)) {
      throw new Error(`Counted browser negative probe failed: ${JSON.stringify(checks)}`)
    }
    return checks
  } finally {
    await client.send('Target.closeTarget', { targetId: target.targetId }, undefined, 5_000).catch(() => {})
    await Promise.all([forbiddenLoopback.close(), externalEgress.close()])
  }
}

async function exerciseFeatureToggles(client, pageSession) {
  await evaluate(client, pageSession, `(async () => {
    const pause = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const click = async (label) => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === label);
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click(); await pause(); return true;
    };
    // Optional controls are exercised only when the active recipe bound them.
    for (const label of ['Models', 'Boxes', 'LiDAR → Camera', 'Keypoints 3D', 'Keypoints 2D', 'Cam Seg', 'Seg', 'Pan', 'Cam', 'Int']) {
      await click(label);
    }
    for (const code of ['Digit1', 'Digit1', 'KeyC', 'KeyC', 'KeyP', 'KeyP']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
      await pause();
    }
    return true;
  })()`)
}

async function perceptualRect(client, pageSession, selector) {
  return evaluate(client, pageSession, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  })()`)
}

async function phase6PerceptualClip(client, pageSession, selector) {
  const rect = await perceptualRect(client, pageSession, selector)
  return rect ? phase6PerceptualClipV1(rect) : null
}

async function transportPerceptualClip(client, pageSession, selector) {
  const rect = await perceptualRect(client, pageSession, selector)
  return rect ? transportPerceptualClipV2(rect) : null
}

async function capturePng(client, pageSession, clip) {
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip,
  }, pageSession, timeoutMs)
  return Buffer.from(screenshot.data, 'base64')
}

async function captureConformanceArtifact(client, pageSession) {
  if (adapterRecipe) {
    await evaluate(
      client,
      pageSession,
      `globalThis.__EGOLENS_ORACLE_CAPTURE__.installRecipe(${JSON.stringify(adapterRecipe)})`,
      timeoutMs,
    )
  }
  const descriptor = await evaluate(
    client,
    pageSession,
    'globalThis.__EGOLENS_ORACLE_CAPTURE__?.descriptor() ?? null',
  )
  const expectedCapabilities = [...conformanceConfig.requiredCapabilities].sort()
  if (!descriptor || descriptor.datasetId !== conformanceConfig.datasetId
    || !/^[0-9a-f]{40}$/u.test(descriptor.buildCommit)
    || !/^sha256:[0-9a-f]{64}$/u.test(descriptor.sourceTreeHash)
    || (preflightScene && descriptor.sceneId !== preflightScene)
    || JSON.stringify(descriptor.capabilities) !== JSON.stringify(expectedCapabilities)
    || (adapterAmnesia && (descriptor.mode !== 'adapter-amnesia'
      || !/^sha256:[0-9a-f]{64}$/u.test(descriptor.recipeHash)))
    || Math.max(...conformanceConfig.frameIndices) >= descriptor.frameCount) {
    throw new Error(`Conformance descriptor does not match the reviewed target: ${JSON.stringify(descriptor)}`)
  }

  if (perceptualOutputDirectory) await mkdir(perceptualOutputDirectory, { recursive: true })
  const references = []
  const parityReferences = []
  for (const capture of conformanceConfig.perceptualCaptures) {
    if (!capture?.id || !Number.isSafeInteger(capture.frameIndex) || !capture.selector) {
      throw new Error('Each perceptual capture requires id, frameIndex, and selector')
    }
    await evaluate(client, pageSession, `globalThis.__EGOLENS_ORACLE_CAPTURE__.setPresentation(${JSON.stringify(capture.presentation ?? {})}); true`)
    const actualFrame = await evaluate(
      client,
      pageSession,
      `globalThis.__EGOLENS_ORACLE_CAPTURE__.seekFrame(${capture.frameIndex})`,
      timeoutMs,
    )
    if (actualFrame !== capture.frameIndex) throw new Error(`Failed to present conformance frame ${capture.frameIndex}`)
    await waitFor(client, pageSession, `[...document.images].every((image) => image.complete)`)
    await delay(settleMs)
    const clip = await phase6PerceptualClip(client, pageSession, capture.selector)
    if (!clip || clip.width <= 0 || clip.height <= 0) {
      throw new Error(`Perceptual capture selector is missing or empty: ${capture.selector}`)
    }
    const bytes = await capturePng(client, pageSession, clip)
    let parityClip = await transportPerceptualClip(client, pageSession, capture.selector)
    if (!parityClip || parityClip.width <= 0 || parityClip.height <= 0) {
      throw new Error(`Transport perceptual capture selector is missing or empty: ${capture.selector}`)
    }
    let parityBytes = await capturePng(client, pageSession, parityClip)
    if (capture.parityViewport !== undefined) {
      const { width, height } = capture.parityViewport
      if (!Number.isSafeInteger(width) || width <= 0
        || !Number.isSafeInteger(height) || height <= 0) {
        throw new Error(`Invalid parityViewport for ${capture.id}`)
      }
      const previousStyle = await evaluate(client, pageSession, `(() => {
        const element = document.querySelector(${JSON.stringify(capture.selector)});
        if (!(element instanceof HTMLElement)) return null;
        const previous = { flex: element.style.flex, width: element.style.width, height: element.style.height };
        element.style.flex = '0 0 ${height}px';
        element.style.width = '${width}px';
        element.style.height = '${height}px';
        return previous;
      })()`)
      if (!previousStyle) throw new Error(`Parity viewport target is missing: ${capture.selector}`)
      try {
        await delay(settleMs)
        parityClip = await transportPerceptualClip(client, pageSession, capture.selector)
        if (parityClip?.width !== width || parityClip?.height !== height) {
          throw new Error(`Parity viewport did not settle at ${width}x${height}: ${JSON.stringify(parityClip)}`)
        }
        parityBytes = await capturePng(client, pageSession, parityClip)
      } finally {
        await evaluate(client, pageSession, `(() => {
          const element = document.querySelector(${JSON.stringify(capture.selector)});
          if (!(element instanceof HTMLElement)) return false;
          element.style.flex = ${JSON.stringify(previousStyle.flex)};
          element.style.width = ${JSON.stringify(previousStyle.width)};
          element.style.height = ${JSON.stringify(previousStyle.height)};
          return true;
        })()`)
        await delay(settleMs)
      }
    }
    const reference = {
      id: capture.id,
      sha256: perceptualRasterSha256V1(bytes),
      width: Math.round(clip.width),
      height: Math.round(clip.height),
    }
    references.push(reference)
    parityReferences.push({
      id: capture.id,
      sha256: perceptualRasterSha256V2(parityBytes),
      width: Math.round(parityClip.width),
      height: Math.round(parityClip.height),
    })
    if (perceptualOutputDirectory) {
      await writeFile(path.join(perceptualOutputDirectory, `${capture.id}.png`), bytes, { flag: 'wx' })
      await writeFile(
        path.join(perceptualOutputDirectory, `${capture.id}.parity.png`),
        parityBytes,
        { flag: 'wx' },
      )
    }
  }

  const capturedAt = new Date().toISOString()
  const artifact = await evaluate(client, pageSession, `globalThis.__EGOLENS_ORACLE_CAPTURE__.capture(${JSON.stringify({
    datasetId: conformanceConfig.datasetId,
    caseId: conformanceConfig.caseId,
    sourceFingerprint: conformanceConfig.sourceFingerprint,
    capturedAt,
    frameIndices: conformanceConfig.frameIndices,
    requiredCapabilities: conformanceConfig.requiredCapabilities,
    sampleValuesPerBuffer: conformanceConfig.sampleValuesPerBuffer ?? 64,
    perceptualReferences: references,
  })})`, timeoutMs)
  if (!artifact?.artifactHash) throw new Error('Conformance capture returned no artifact')
  const presentation = await evaluate(
    client,
    pageSession,
    'globalThis.__EGOLENS_ORACLE_CAPTURE__.presentation()',
  )
  await mkdir(path.dirname(conformanceOutput), { recursive: true })
  await writeFile(conformanceOutput, `${JSON.stringify(artifact)}\n`, { flag: 'wx' })
  return {
    target: artifact.target,
    coverage: artifact.coverage,
    artifactHash: artifact.artifactHash,
    generatorCommit: artifact.provenance?.generatorCommit ?? null,
    runtimeId: artifact.provenance?.runtimeId ?? null,
    buildCommit: descriptor.buildCommit,
    sourceTreeHash: descriptor.sourceTreeHash,
    recipeHash: descriptor.recipeHash,
    identity: descriptor.preflightIdentity,
    presentation,
    perceptualParity: {
      algorithm: 'egolens-perceptual-raster-v2',
      references: parityReferences,
    },
  }
}

function quantile(values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}

function traceMarkDetail(event) {
  const detail = event?.args?.data?.detail
  if (detail && typeof detail === 'object') return detail
  if (typeof detail !== 'string') return null
  try {
    return JSON.parse(detail)
  } catch {
    return null
  }
}

function tracedInitialSceneFrameRate(run, initialGeneration) {
  const ready = run.trace.find((event) =>
    event.name.startsWith('egolens:dataset-ready:')
      && traceMarkDetail(event)?.sceneGeneration === initialGeneration)
  if (!ready || !Number.isFinite(ready.ts)) return null
  const terminal = run.trace
    .filter((event) => Number.isFinite(event.ts) && event.ts > ready.ts)
    .filter((event) => {
      const detail = traceMarkDetail(event)
      return (event.name.startsWith('egolens:scene-load-start:')
          && detail?.sceneGeneration !== initialGeneration)
        || (event.name.startsWith('egolens:scene-dispose-start:')
          && detail?.sceneGeneration === initialGeneration)
    })
    .sort((left, right) => left.ts - right.ts)[0]
  const end = terminal?.ts ?? Math.max(...run.trace.map((event) => event.ts).filter(Number.isFinite))
  const seconds = (end - ready.ts) / 1_000_000
  if (!(seconds > 0)) return null
  const frames = run.trace.filter((event) =>
    event.name === 'DrawFrame' && event.ts >= ready.ts && event.ts < end).length
  return frames / seconds
}

function summarizeRun(run) {
  // Initial-load milestones come from the coordinated post-warmup snapshot so
  // later scene generations cannot be paired with the first run's start mark.
  const { start, ready, first, initialGeneration } = selectInitialSceneMilestones(run)
  // The app snapshot is intentionally bounded and can contain only the last
  // cross-dataset generations after a long soak. Trace events retain the full
  // run, so warm/rapid latency must select only the initially loaded scene and
  // must not mix later cold first frames into this distribution.
  const latencies = run.trace
    .filter((event) => event.name.startsWith('egolens:frame-presented:'))
    .map(traceMarkDetail)
    .filter((detail) => detail?.sceneGeneration === initialGeneration)
    .map((detail) => detail?.inputToFrameMs)
    .filter(Number.isFinite)
  const longTaskMs = run.trace
    .filter((event) => event.name === 'RunTask' && Number(event.dur) >= 50_000)
    .reduce((sum, event) => sum + Number(event.dur) / 1000, 0)
  return {
    datasetReadyMs: start && ready ? ready.startTime - start.startTime : null,
    firstUsableFrameMs: start && first ? first.startTime - start.startTime : null,
    frameLatencyP50Ms: quantile(latencies, 0.5),
    frameLatencyP95Ms: quantile(latencies, 0.95),
    frameLatencySamples: latencies.length,
    tracedFrameRate: tracedInitialSceneFrameRate(run, initialGeneration),
    longTaskMs,
    requests: run.network.length,
    rangeRequests: run.network.filter((request) => request.range).length,
    encodedBytes: run.network.reduce((sum, request) => sum + (request.encodedDataLength ?? 0), 0),
    decompressions: run.snapshots.afterSoak.app?.scene?.operations.decompressions ?? null,
    rowGroupFetches: run.snapshots.afterSoak.app?.scene?.operations.rowGroupFetches ?? null,
    retainedBytes: run.snapshots.afterSoak.app?.scene
      ? run.snapshots.afterSoak.app.scene.cache.pointBytes + run.snapshots.afterSoak.app.scene.cache.cameraBytes
      : null,
  }
}

function aggregate(runs) {
  const summaries = runs.map(summarizeRun)
  const values = (key) => summaries.map((entry) => entry[key]).filter(Number.isFinite)
  return {
    runSummaries: summaries,
    distribution: Object.fromEntries([
      'datasetReadyMs', 'firstUsableFrameMs', 'frameLatencyP50Ms', 'frameLatencyP95Ms', 'frameLatencySamples',
      'tracedFrameRate', 'longTaskMs', 'requests', 'rangeRequests', 'encodedBytes',
      'decompressions', 'rowGroupFetches', 'retainedBytes',
    ].map((key) => [key, {
      p50: quantile(values(key), 0.5),
      p95: quantile(values(key), 0.95),
      samples: values(key),
    }])),
  }
}

async function observedPreflight(client, pageSession) {
  if (!expectedPreflightIdentity) return null
  return evaluate(client, pageSession, `(async () => {
    const descriptor = globalThis.__EGOLENS_ORACLE_CAPTURE__?.descriptor();
    const presentation = globalThis.__EGOLENS_ORACLE_CAPTURE__?.presentation();
    const renderedFrame = await globalThis.__EGOLENS_ORACLE_CAPTURE__?.renderedFrame();
    const agentActivity = globalThis.__EGOLENS_ORACLE_CAPTURE__?.agentActivity?.() ?? null;
    return descriptor ? {
      datasetId: descriptor.datasetId,
      sceneId: descriptor.sceneId,
      buildCommit: descriptor.buildCommit,
      sourceTreeHash: descriptor.sourceTreeHash,
      identity: descriptor.preflightIdentity,
      presentation,
      renderedFrame,
      agentActivity,
    } : null;
  })()`)
}

function assertObservedPreflight(preflight, label, expectedScene = null) {
  const expectedRuntimeIdentity = Object.fromEntries(preflightIdentityKeys.slice(2)
    .map((key) => [key, expectedPreflightIdentity[key]]))
  if (!preflight || preflight.datasetId !== expectedPreflightIdentity.datasetId
    || (expectedScene && preflight.sceneId !== expectedScene)
    || preflight.buildCommit !== expectedCandidateCommit
    || preflight.sourceTreeHash !== expectedSourceTreeHash
    || JSON.stringify(preflight.identity) !== JSON.stringify(expectedRuntimeIdentity)) {
    throw new Error(`${label} does not match the counted preflight identity: ${JSON.stringify(preflight)}`)
  }
}

async function runScenario(client, browserVersion, runIndex) {
  const target = await client.send('Target.createTarget', {
    url: 'about:blank',
  })
  const attached = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const pageSession = attached.sessionId
  const workers = new Map()
  const workerEvents = []
  const network = new Map()
  const trace = []
  let traceEventsSeen = 0
  let traceEventsDropped = 0
  let traceCompleteObserved = false
  let traceCompleteResolve
  const traceComplete = new Promise((resolve) => { traceCompleteResolve = resolve })

  const offAttached = client.on('Target.attachedToTarget', (message) => {
    const info = message.params.targetInfo
    if (info.type !== 'worker' && info.type !== 'service_worker') return
    workers.set(info.targetId, { targetId: info.targetId, sessionId: message.params.sessionId, type: info.type, url: info.url })
    workerEvents.push({ event: 'created', timestampMs: Date.now(), targetId: info.targetId, type: info.type, url: info.url })
    void client.send('Runtime.enable', {}, message.params.sessionId)
    void client.send('Network.enable', { maxTotalBufferSize: 100_000_000 }, message.params.sessionId)
  })
  const offDetached = client.on('Target.detachedFromTarget', (message) => {
    const worker = [...workers.values()].find((entry) => entry.sessionId === message.params.sessionId)
    if (!worker) return
    workerEvents.push({ event: 'destroyed', timestampMs: Date.now(), targetId: worker.targetId, type: worker.type, url: worker.url })
    workers.delete(worker.targetId)
  })
  const requestKey = (message) => `${message.sessionId ?? pageSession}:${message.params.requestId}`
  const offRequest = client.on('Network.requestWillBeSent', (message) => {
    const request = message.params.request
    network.set(requestKey(message), {
      requestId: message.params.requestId,
      targetSessionId: message.sessionId ?? pageSession,
      url: request.url,
      method: request.method,
      range: request.headers.Range ?? request.headers.range ?? null,
      initiator: message.params.initiator?.type ?? null,
      timestamp: message.params.timestamp,
      fromDiskCache: false,
      fromServiceWorker: false,
      encodedDataLength: 0,
    })
  })
  const offResponse = client.on('Network.responseReceived', (message) => {
    const entry = network.get(requestKey(message))
    if (!entry) return
    entry.status = message.params.response.status
    entry.mimeType = message.params.response.mimeType
    entry.fromDiskCache = message.params.response.fromDiskCache
    entry.fromServiceWorker = message.params.response.fromServiceWorker
    entry.responseTimestamp = message.params.timestamp
  })
  const offLoaded = client.on('Network.loadingFinished', (message) => {
    const entry = network.get(requestKey(message))
    if (entry) entry.encodedDataLength = message.params.encodedDataLength
  })
  const offTrace = client.on('Tracing.dataCollected', (message) => {
    traceEventsSeen += message.params.value.length
    for (const event of message.params.value) {
      const keep = event.name === 'DrawFrame'
        || (event.name === 'RunTask' && Number(event.dur) >= 50_000)
        || String(event.cat ?? '').includes('blink.user_timing')
      if (!keep) continue
      if (trace.length < traceEventLimit) trace.push(event)
      else traceEventsDropped++
    }
  })
  const offTraceComplete = client.on('Tracing.tracingComplete', () => {
    traceCompleteObserved = true
    traceCompleteResolve()
  })

  await Promise.all([
    client.send('Page.enable', {}, pageSession),
    client.send('DOM.enable', {}, pageSession),
    client.send('Runtime.enable', {}, pageSession),
    client.send('Network.enable', { maxTotalBufferSize: 100_000_000 }, pageSession),
    client.send('Performance.enable', {}, pageSession),
    client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport[0],
      height: viewport[1],
      deviceScaleFactor: 1,
      mobile: false,
    }, pageSession),
    client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'worker', exclude: false }, { type: 'service_worker', exclude: false }, { exclude: true }],
    }, pageSession),
  ])
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperties(globalThis, {
        __EGOLENS_BENCHMARK_MODE__: { value: true, configurable: false, enumerable: false, writable: false },
        __EGOLENS_BENCHMARK_HOLD__: { value: true, configurable: false, enumerable: false, writable: false },
        __EGOLENS_ORACLE_CAPTURE_REQUESTED__: { value: ${Boolean(conformanceConfig || expectedPreflightIdentity)}, configurable: false, enumerable: false, writable: false },
        __EGOLENS_ADAPTER_AMNESIA_CAPTURE__: { value: ${adapterAmnesia}, configurable: false, enumerable: false, writable: false },
        __EGOLENS_EXPECTED_SOURCE_MANIFEST_HASH__: { value: ${JSON.stringify(expectedSourceManifestHash)}, configurable: false, enumerable: false, writable: false },
        __EGOLENS_PREFLIGHT_RECIPE__: { value: ${JSON.stringify(preflightRecipe)}, configurable: false, enumerable: false, writable: false },
        __EGOLENS_PREFLIGHT_SCENE__: { value: ${JSON.stringify(preflightScene)}, configurable: false, enumerable: false, writable: false },
        __EGOLENS_PREFLIGHT_PRESENTATION__: { value: ${JSON.stringify(preflightPresentation)}, configurable: false, enumerable: false, writable: false },
      });
    `,
  }, pageSession)

  const capture = async (label) => {
    const pageHeap = await client.send('Runtime.getHeapUsage', {}, pageSession)
    const workerHeaps = []
    for (const worker of workers.values()) {
      try {
        workerHeaps.push({
          targetId: worker.targetId,
          type: worker.type,
          url: worker.url,
          ...(await client.send('Runtime.getHeapUsage', {}, worker.sessionId)),
        })
      } catch { /* A worker may disappear between enumeration and sampling. */ }
    }
    let dom = null
    try { dom = await client.send('Memory.getDOMCounters', {}, pageSession) } catch { /* unavailable on worker-only targets */ }
    const performanceMetrics = await client.send('Performance.getMetrics', {}, pageSession)
    let app = null
    let oracleCapture = null
    try {
      app = await evaluate(client, pageSession, 'globalThis.__EGOLENS_PERF__?.snapshot() ?? null')
    } catch { /* The document may be between navigations. */ }
    try {
      oracleCapture = await evaluate(
        client,
        pageSession,
        'globalThis.__EGOLENS_ORACLE_CAPTURE__?.descriptor() ?? null',
      )
    } catch { /* The optional trusted capture hook is absent in normal runs. */ }
    let documentShape = null
    try {
      documentShape = await evaluate(client, pageSession, `({
        url: location.href,
        elements: document.querySelectorAll('*').length,
        bodyChildren: document.body?.children.length ?? 0,
        canvases: document.querySelectorAll('canvas').length,
        images: document.querySelectorAll('img').length,
        buttons: document.querySelectorAll('button').length,
        inputs: document.querySelectorAll('input').length,
        bodyTextLength: document.body?.innerText.length ?? 0,
      })`)
    } catch { /* The document may be between navigations. */ }
    return {
      label,
      wallTime: new Date().toISOString(),
      pageHeap,
      workerHeaps,
      dom,
      performanceMetrics: performanceMetrics.metrics,
      app,
      oracleCapture,
      documentShape,
      liveWorkerTargets: [...workers.values()].map(({ sessionId: _sessionId, ...worker }) => worker),
    }
  }

  const collectGarbageAcrossTargets = async () => {
    const sessions = [pageSession, ...[...workers.values()].map((worker) => worker.sessionId)]
    const results = await Promise.allSettled(sessions.map((sessionId) =>
      client.send('HeapProfiler.collectGarbage', {}, sessionId)))
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Forced-GC diagnostic could not collect every live page/worker target.')
    }
  }

  const snapshots = {
    beforeLoad: await capture('before-load'),
    soakCheckpoints: [],
    soakForcedGcCheckpoints: [],
  }
  if (traceEnabled) {
    await client.send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,loading,v8',
      options: 'record-as-much-as-possible',
      transferMode: 'ReportEvents',
      bufferUsageReportingInterval: 1000,
    }, pageSession)
  }
  await client.send('Page.navigate', { url: withPerf(benchmarkUrl) }, pageSession, timeoutMs)
  await waitFor(client, pageSession, 'Boolean(globalThis.__EGOLENS_PERF__)')
  await waitFor(client, pageSession, 'globalThis.__EGOLENS_BENCHMARK_READY__ === true')
  // The pre-scene comparison point must represent a committed, naturally
  // settled landing view. Sampling immediately after the hook appears races
  // React effects and produces false DOM/listener growth after disposal.
  await delay(settleMs)
  snapshots.beforeSceneLoad = await capture('before-scene-load')
  if (localSourceRoot) {
    // Enumerate first so symlinks, special entries, empty roots, and the
    // browser inventory cap are rejected before granting the browser access.
    // A webkitdirectory input itself must receive the directory path; passing
    // the enumerated leaves loses webkitRelativePath in Chromium and no
    // change event is dispatched.
    if (!countedLocalSourceFiles) await enumerateLocalSourceFiles(localSourceRoot)
    const document = await client.send('DOM.getDocument', { depth: 2, pierce: true }, pageSession)
    const input = await client.send('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '[data-testid="dataset-folder-input"]',
    }, pageSession)
    if (!input.nodeId) throw new Error('Ordinary local folder input is missing')
    await client.send('DOM.setFileInputFiles', { files: [localSourceRoot], nodeId: input.nodeId }, pageSession, timeoutMs)
  } else {
    await evaluate(client, pageSession, `window.dispatchEvent(new Event('egolens:benchmark-start')); true`)
  }
  await waitFor(client, pageSession, `Boolean(globalThis.__EGOLENS_PERF__?.snapshot().marks.some((mark) => mark.name.startsWith('egolens:dataset-ready:')))`)
  await waitFor(client, pageSession, `Boolean(globalThis.__EGOLENS_PERF__?.snapshot().marks.some((mark) => mark.name.startsWith('egolens:first-usable-frame:')))`)
  if (localSourceRoot && (conformanceConfig || expectedPreflightIdentity)) {
    await waitFor(client, pageSession, `(() => {
      const descriptor = globalThis.__EGOLENS_ORACLE_CAPTURE__?.descriptor();
      return descriptor?.preflightIdentity?.sourceManifestHash === ${JSON.stringify(expectedSourceManifestHash)}
        && (${JSON.stringify(preflightScene)} === null || descriptor.sceneId === ${JSON.stringify(preflightScene)});
    })()`)
  }
  await delay(settleMs)
  snapshots.afterWarmup = await capture('after-warmup-settle')
  const preflight = await observedPreflight(client, pageSession)
  if (expectedPreflightIdentity) assertObservedPreflight(preflight, 'Initial managed scene', preflightScene)
  const conformance = conformanceConfig
    ? await captureConformanceArtifact(client, pageSession)
    : null

  if (playbackLoops > 0) {
    await evaluate(client, pageSession, `(async () => {
      const slider = document.querySelector('[data-testid="frame-timeline"]');
      if (!(slider instanceof HTMLInputElement) || Number(slider.max) <= 0) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(slider, '0'); slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, (${playbackLoops} * (Number(slider.max) + 1) * 1000 / Math.max(1, ${nominalFps} * 4)) + 1000));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
      return true;
    })()`)
  }

  await evaluate(client, pageSession, `(async () => {
    const slider = document.querySelector('[data-testid="frame-timeline"]');
    if (!(slider instanceof HTMLInputElement) || Number(slider.max) <= 0) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const max = Number(slider.max);
    for (let index = 0; index < ${seekCount}; index++) {
      setter.call(slider, String((index * 37) % (max + 1)));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  })()`)
  await exerciseFeatureToggles(client, pageSession)

  for (let index = 0; index < sceneSwitchCount; index++) {
    const previousGeneration = await evaluate(client, pageSession, 'globalThis.__EGOLENS_PERF__?.snapshot().scene?.sceneGeneration ?? null')
    const crossScenario = switchScenarios.length > 0
      ? switchScenarios[index % switchScenarios.length]
      : null
    if (crossScenario) {
      await evaluate(client, pageSession, `window.dispatchEvent(new CustomEvent('egolens:benchmark-load', { detail: ${JSON.stringify(crossScenario)} })); true`)
    } else {
      await evaluate(client, pageSession, `window.dispatchEvent(new Event('egolens:benchmark-reload')); true`)
    }
    await waitFor(client, pageSession, `globalThis.__EGOLENS_PERF__?.snapshot().scene?.sceneGeneration !== ${JSON.stringify(previousGeneration)}`)
    await waitFor(client, pageSession, `globalThis.__EGOLENS_PERF__?.snapshot().marks.some((mark) => mark.name.startsWith('egolens:dataset-ready:') && mark.detail?.sceneGeneration === globalThis.__EGOLENS_PERF__.snapshot().scene?.sceneGeneration)`)
    await exerciseFeatureToggles(client, pageSession)
    await delay(settleMs)
    const checkpointLabel = `${crossScenario ? `cross-${crossScenario.dataset}` : 'scene'}-switch-${index + 1}`
    snapshots.soakCheckpoints.push(await capture(`${checkpointLabel}-settle`))
    // Natural state above remains authoritative for live ownership and cache
    // behavior. This second diagnostic removes allocator/GC scheduling noise
    // so retained-growth slopes compare the same dataset across later cycles.
    try {
      await collectGarbageAcrossTargets()
      snapshots.soakForcedGcCheckpoints.push(await capture(`${checkpointLabel}-forced-gc-diagnostic`))
    } catch {
      snapshots.soakForcedGcCheckpoints.push(null)
    }
  }

  await delay(settleMs)
  snapshots.afterSoak = await capture('after-soak-settle')
  const postSoakPreflight = await observedPreflight(client, pageSession)
  if (expectedPreflightIdentity) {
    assertObservedPreflight(postSoakPreflight, 'Managed scene after lifecycle/performance exercise')
  }
  await evaluate(client, pageSession, `window.dispatchEvent(new Event('egolens:benchmark-dispose')); true`)
  await waitFor(client, pageSession, 'globalThis.__EGOLENS_PERF__?.snapshot().scene === null')
  snapshots.afterDispose = await capture('immediately-after-dispose')
  await delay(settleMs)
  snapshots.afterDisposeSettle = await capture('after-dispose-settle')
  // Diagnostic only: the natural post-disposal snapshot above remains the
  // acceptance input. This distinguishes reachable leaks from detached trees
  // that V8 can reclaim but has not collected under low memory pressure.
  try {
    await collectGarbageAcrossTargets()
    snapshots.afterDisposeForcedGcDiagnostic = await capture('after-dispose-forced-gc-diagnostic')
  } catch { /* HeapProfiler is not available in every Chromium build. */ }
  let heapSnapshot = null
  if (heapSnapshotOutput) {
    const chunks = []
    const offHeapChunk = client.on('HeapProfiler.addHeapSnapshotChunk', (message) => {
      if (message.sessionId === pageSession) chunks.push(message.params.chunk)
    })
    try {
      await client.send('HeapProfiler.enable', {}, pageSession)
      await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, pageSession, timeoutMs)
      await writeFile(heapSnapshotOutput, chunks.join(''))
      heapSnapshot = heapSnapshotOutput
    } finally {
      offHeapChunk()
    }
  }

  if (traceEnabled) {
    await client.send('Tracing.end', {}, pageSession)
    await Promise.race([traceComplete, delay(30_000)])
  }
  // Some Chrome builds detach the page before acknowledging closeTarget.
  // Cleanup is best-effort after all required evidence has been captured.
  await client.send('Target.closeTarget', { targetId: target.targetId }, undefined, 10_000).catch(() => {})
  offAttached(); offDetached(); offRequest(); offResponse(); offLoaded(); offTrace(); offTraceComplete()

  return {
    runIndex,
    browserVersion,
    snapshots,
    workerEvents,
    network: [...network.values()],
    trace,
    heapSnapshot,
    conformance,
    preflight,
    postSoakPreflight,
    adapterAmnesia: adapterAmnesia ? {
      recipeFile: path.basename(adapterRecipePath),
      recipeHash: conformance?.recipeHash ?? null,
    } : null,
    traceCollection: {
      eventsSeen: traceEventsSeen,
      retainedEvents: trace.length,
      droppedRelevantEvents: traceEventsDropped,
      limit: traceEventLimit,
      truncated: traceEventsDropped > 0,
      complete: traceEnabled ? traceCompleteObserved : null,
      enabled: traceEnabled,
    },
  }
}

async function launchOrdinaryBrowser() {
  const workspace = await createFreshProcessWorkspaceV1('egolens-phase6-chrome-')
  const { profileDir } = workspace
  const port = 9222 + Math.floor(Math.random() * 500)
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-precise-memory-info',
    '--use-angle=metal',
    'about:blank',
  ], { stdio: 'ignore' })
  let client
  try {
    const endpoint = await waitForEndpoint(port, chrome)
    client = await CdpClient.connect(endpoint.webSocketDebuggerUrl)
    const browserVersion = await client.send('Browser.getVersion')
    return { ...workspace, chrome, client, browserVersion }
  } catch (error) {
    await closeFreshProcessWorkspaceV1(workspace, chrome)
    throw error
  }
}

async function signalProcessGroup(processHandle, signal) {
  if (!processHandle?.pid) return
  try {
    process.kill(-processHandle.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function closeCountedBrowserWorkspace(isolatedBrowser) {
  const { chrome, client, runtimeScratch, forbiddenRoot } = isolatedBrowser
  client?.close()
  await signalProcessGroup(chrome, 'SIGTERM')
  await delay(100)
  if (chrome.exitCode === null && chrome.signalCode === null) await signalProcessGroup(chrome, 'SIGKILL')
  let evidence
  try {
    evidence = await closeFreshProcessWorkspaceV1(isolatedBrowser, chrome)
  } finally {
    await Promise.all([
      rm(runtimeScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      rm(forbiddenRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ])
  }
  return evidence
}

async function launchCountedBrowser() {
  if (!browserBoundaryEnvironment || !appBuildServer) {
    throw new Error('Counted browser boundary was not initialized from the immutable app server')
  }
  const workspace = await createFreshProcessWorkspaceV1('egolens-phase10-browser-profile-')
  const runtimeScratch = await mkdtemp(path.join(os.tmpdir(), 'egolens-phase10-browser-scratch-'))
  const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), 'egolens-phase10-browser-forbidden-'))
  const forbiddenFile = path.join(forbiddenRoot, 'ambient-secret.txt')
  await writeFile(forbiddenFile, 'EGOLENS_FORBIDDEN_SENTINEL\n', { mode: 0o600, flag: 'wx' })
  let chrome = null
  let client = null
  try {
    const [profileReal, scratchReal, forbiddenReal, chromeExecutable, chromeRoot, systemSocketReal] = await Promise.all([
      realpath(workspace.profileDir),
      realpath(runtimeScratch),
      realpath(forbiddenRoot),
      realpath(CHROME),
      realpath(path.resolve(CHROME, '../../..')),
      realpath(os.tmpdir()),
    ])
    const sourceRoot = localSourceRoot ?? workspace.profileDir
    const sourceRealRoot = localSourceRoot ? await realpath(localSourceRoot) : profileReal
    for (const [leftName, left, rightName, right] of [
      ['source root', sourceRealRoot, 'browser profile', profileReal],
      ['source root', sourceRealRoot, 'runtime scratch', scratchReal],
      ['source root', sourceRealRoot, 'ambient probe', forbiddenReal],
      ['browser profile', profileReal, 'runtime scratch', scratchReal],
      ['browser profile', profileReal, 'ambient probe', forbiddenReal],
      ['runtime scratch', scratchReal, 'ambient probe', forbiddenReal],
    ]) {
      if (pathsOverlap(left, right)) throw new Error(`${leftName} and ${rightName} must be disjoint`)
    }
    if (!chromeExecutable.startsWith(`${chromeRoot}${path.sep}`)) {
      throw new Error('Counted Chrome executable escapes its canonical application bundle')
    }
    const parameters = {
      APP_REMOTE_ENDPOINT: endpointForOriginV1(appBuildServer.origin),
      BROWSER_PROFILE: workspace.profileDir,
      BROWSER_PROFILE_REAL: profileReal,
      CHROME_ROOT: chromeRoot,
      RUNTIME_SCRATCH: runtimeScratch,
      RUNTIME_SCRATCH_REAL: scratchReal,
      SOURCE_REAL_ROOT: sourceRealRoot,
      SOURCE_REMOTE_ENDPOINT: endpointForOriginV1(
        countedSourceBoundary.sourceOrigin ?? appBuildServer.origin,
      ),
      SOURCE_ROOT: sourceRoot,
      SYSTEM_SOCKET_REAL_ROOT: systemSocketReal,
      SYSTEM_SOCKET_ROOT: os.tmpdir(),
    }
    const chromeArguments = [
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${workspace.profileDir}`,
      `--crash-dumps-dir=${runtimeScratch}`,
      `--disk-cache-dir=${path.join(runtimeScratch, 'cache')}`,
      '--headless=new',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-crash-reporter',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pings',
      '--password-store=basic',
      '--use-mock-keychain',
      '--enable-precise-memory-info',
      '--use-angle=metal',
      // The deny-default outer Seatbelt profile is the enforced counted
      // boundary. Chrome's own nested helper sandbox cannot initialize inside
      // it ("sandbox initialization failed: Operation not permitted"), which
      // kills the GPU and network services and aborts the browser, so the
      // inner sandbox is disabled exactly as the Phase 9 counted broker does.
      '--no-sandbox',
      'about:blank',
    ]
    chrome = spawn('/usr/bin/sandbox-exec', countedBrowserSeatbeltArgumentsV1(
      COUNTED_BROWSER_PROFILE,
      parameters,
      [chromeExecutable, ...chromeArguments],
    ), {
      detached: true,
      stdio: 'ignore',
      env: {
        HOME: workspace.profileDir,
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
        TMPDIR: runtimeScratch,
      },
    })
    const { endpoint, port } = await waitForChromeSelectedEndpoint(workspace.profileDir, chrome)
    client = await CdpClient.connect(endpoint.webSocketDebuggerUrl)
    const browserVersion = await client.send('Browser.getVersion')
    const boundaryChecks = await runCountedBrowserNegativeProbe(
      client,
      appBuildServer.origin,
      forbiddenFile,
    )
    return {
      ...workspace,
      chrome,
      client,
      browserVersion,
      runtimeScratch,
      forbiddenRoot,
      boundaryChecks,
      boundaryDebugPort: port,
      boundaryParametersHash: boundaryHashV1({
        parameters,
        processNonce: workspace.processNonce,
        profileNonce: workspace.profileNonce,
      }),
    }
  } catch (error) {
    if (chrome) {
      await signalProcessGroup(chrome, 'SIGKILL').catch(() => {})
      await closeFreshProcessWorkspaceV1(workspace, chrome).catch(() => {})
    } else {
      await rm(workspace.profileDir, { recursive: true, force: true })
    }
    client?.close()
    await Promise.all([
      rm(runtimeScratch, { recursive: true, force: true }),
      rm(forbiddenRoot, { recursive: true, force: true }),
    ])
    throw error
  }
}

async function launchBrowser() {
  return expectedPreflightIdentity ? launchCountedBrowser() : launchOrdinaryBrowser()
}

async function closeBrowser(isolatedBrowser) {
  if (expectedPreflightIdentity) return closeCountedBrowserWorkspace(isolatedBrowser)
  const { chrome, client } = isolatedBrowser
  client.close()
  return closeFreshProcessWorkspaceV1(isolatedBrowser, chrome)
}

const warmups = []
const samples = []
let recordedBrowserVersion = null
let benchmarkUrl = String(options.url)
let appBuildServer = null
let appBuildInitialDiskHash = null
let appBuildFinalDiskHash = null
let trustedVerifierBinding = null
let browserBoundaryEnvironment = null
let countedLocalSourceFiles = null
let initialBrowserBinaryIdentity = null
try {
  if (appBuildRootInput) {
    const requestedUrl = new URL(String(options.url))
    if (requestedUrl.protocol !== 'http:' || requestedUrl.hostname !== '127.0.0.1') {
      throw new Error('Counted app URL must use an exact 127.0.0.1 HTTP origin')
    }
    appBuildServer = await createImmutableAppBuildServer(
      appBuildRootInput,
      expectedAppBuildInventoryHash,
    )
    appBuildInitialDiskHash = await appBuildServer.diskInventoryHash()
    if (appBuildInitialDiskHash !== appBuildServer.inventoryHash) {
      throw new Error('App build changed while its immutable serving snapshot was created')
    }
    if (expectedPreflightIdentity) {
      trustedVerifierBinding = phase10VerifierBindingV1(await loadPhase10ProductionTrustV1())
      if (trustedVerifierBinding.verifierToolCommit !== verifierToolCommit
        || trustedVerifierBinding.verifierSourceTreeHash !== verifierSourceTreeHash) {
        throw new Error('Loaded verifier trust does not describe this benchmark checkout')
      }
    }
    const servedUrl = new URL(requestedUrl.pathname + requestedUrl.search + requestedUrl.hash, appBuildServer.origin)
    benchmarkUrl = servedUrl.href
    if (expectedPreflightIdentity) {
      initialBrowserBinaryIdentity = await inspectOfficialChromeIdentityV1(CHROME)
      const profileTemplateHash = `sha256:${createHash('sha256')
        .update(await readFile(COUNTED_BROWSER_PROFILE)).digest('hex')}`
      if (localSourceRoot) {
        const sourceDetails = await lstat(localSourceRoot)
        if (sourceDetails.isSymbolicLink() || !sourceDetails.isDirectory()) {
          throw new Error('Counted local source must be one real directory')
        }
        countedLocalSourceFiles = await enumerateLocalSourceFiles(localSourceRoot)
      }
      browserBoundaryEnvironment = makeBoundaryEnvironmentV1({
        profileTemplateHash,
        sourceMode: preflightSourceMode,
        appOrigin: appBuildServer.origin,
        sourceOrigin: countedSourceBoundary.sourceOrigin,
        localSourceRootCommitment: localSourceRoot
          ? sourceRootCommitmentV1(await realpath(localSourceRoot))
          : boundaryHashV1({ kind: 'no-local-source-root' }),
        browserBinary: initialBrowserBinaryIdentity,
      })
    }
  }

  for (let index = 0; index < warmupCount + runCount; index++) {
    const preRunInventoryHash = appBuildServer ? await appBuildServer.diskInventoryHash() : null
    if (appBuildServer && preRunInventoryHash !== appBuildServer.inventoryHash) {
      throw new Error(`App build changed before browser run ${index}`)
    }
    const browserBinaryIdentityBefore = expectedPreflightIdentity
      ? await inspectOfficialChromeIdentityV1(CHROME)
      : null
    if (browserBinaryIdentityBefore?.identityHash !== initialBrowserBinaryIdentity?.identityHash) {
      throw new Error(`Official Chrome identity changed before browser run ${index}`)
    }
    const isolatedBrowser = await launchBrowser()
    recordedBrowserVersion ??= isolatedBrowser.browserVersion
    const startedAt = Date.now()
    process.stderr.write(`[phase6] ${index < warmupCount ? 'warmup' : 'sample'} ${index + 1}/${warmupCount + runCount} started\n`)
    let run
    try {
      run = await runScenario(isolatedBrowser.client, isolatedBrowser.browserVersion, index)
    } finally {
      const browserProcess = await closeBrowser(isolatedBrowser)
      if (run) run.browserProcess = browserProcess
    }
    const browserBinaryIdentityAfter = expectedPreflightIdentity
      ? await inspectOfficialChromeIdentityV1(CHROME)
      : null
    if (browserBinaryIdentityAfter?.identityHash !== initialBrowserBinaryIdentity?.identityHash) {
      throw new Error(`Official Chrome identity changed during browser run ${index}`)
    }
    if (expectedPreflightIdentity) {
      const requestAudit = requestAuditV1(
        run.network,
        browserBoundaryEnvironment,
        countedSourceBoundary.allowedPaths,
      )
      run.browserBoundary = makeBoundaryRunEvidenceV1({
        boundary: browserBoundaryEnvironment,
        parametersHash: isolatedBrowser.boundaryParametersHash,
        debugPort: isolatedBrowser.boundaryDebugPort,
        checks: isolatedBrowser.boundaryChecks,
        requestAudit,
        browserBinaryIdentityHashBefore: browserBinaryIdentityBefore.identityHash,
        browserBinaryIdentityHashAfter: browserBinaryIdentityAfter.identityHash,
      })
    }
    const postRunInventoryHash = appBuildServer ? await appBuildServer.diskInventoryHash() : null
    if (appBuildServer && postRunInventoryHash !== appBuildServer.inventoryHash) {
      throw new Error(`App build changed during browser run ${index}`)
    }
    if (appBuildServer) {
      run.appBuild = {
        immutableSnapshotServed: true,
        loopbackOnly: true,
        servedInventoryHash: appBuildServer.inventoryHash,
        preRunInventoryHash,
        postRunInventoryHash,
      }
    }
    if (index < warmupCount) warmups.push(run)
    else samples.push(run)
    process.stderr.write(`[phase6] run ${index + 1}/${warmupCount + runCount} completed in ${Math.round((Date.now() - startedAt) / 1000)}s\n`)
  }

  validateFreshProcessEvidenceSetV1([...warmups, ...samples].map((run) => run.browserProcess))
  appBuildFinalDiskHash = appBuildServer ? await appBuildServer.diskInventoryHash() : null
  if (appBuildServer && appBuildFinalDiskHash !== appBuildServer.inventoryHash) {
    throw new Error('App build changed before the benchmark artifact was finalized')
  }

  const output = {
    schemaVersion: 1,
    scenario: {
      dataset: options.dataset ?? 'unspecified',
      url: withPerf(benchmarkUrl),
      warmupRuns: warmupCount,
      measuredRuns: runCount,
      seeks: seekCount,
      sceneSwitches: sceneSwitchCount,
      crossDatasetSwitches: switchScenarios.length > 0,
      switchScenarioDatasets: [...new Set(switchScenarios.map((scenario) => scenario.dataset))],
      playbackLoops,
      settleMs,
      traceEventLimit,
      traceEnabled,
      browserIsolation: 'per-run',
      freshProcessEvidence: 'egolens-fresh-browser-process-v1',
      countedBrowserBoundary: expectedPreflightIdentity
        ? 'egolens-counted-browser-boundary-v1'
        : null,
      preflightRecipeHash: preflightRecipe ? recipeSemanticHash(preflightRecipe) : null,
      sourceMode: preflightSourceMode,
      viewport: { width: viewport[0], height: viewport[1] },
    },
    environment: {
      commit: expectedCandidateCommit ?? verifierToolCommit,
      dirty: expectedCandidateCommit ? false : !verifierToolClean,
      sourceTreeHash: expectedSourceTreeHash ?? verifierSourceTreeHash,
      candidateIdentitySource: expectedCandidateCommit
        ? 'reviewed-build-boundary-inputs'
        : 'verifier-checkout',
      verifierToolCommit,
      verifierToolClean,
      verifierSourceTreeHash,
      verifierBinding: trustedVerifierBinding,
      browserBoundary: browserBoundaryEnvironment,
      servedBuildInventoryHash: appBuildServer?.inventoryHash ?? null,
      appBuildInitialDiskHash,
      appBuildFinalDiskHash,
      immutableAppBuildSnapshotServed: appBuildServer !== null,
      appBuildLoopbackOnly: appBuildServer !== null,
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
      browser: recordedBrowserVersion,
      heapAggregation: 'sum of Runtime.getHeapUsage.usedSize across the page and attached worker targets; not total browser memory',
    },
    warmups,
    samples,
    summary: aggregate(samples),
  }
  await writeFile(path.resolve(String(options.output)), `${JSON.stringify(output, null, 2)}\n`)
} finally {
  if (appBuildServer) await appBuildServer.close()
}
