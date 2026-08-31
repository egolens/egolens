#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  closeFreshProcessWorkspaceV1,
  createFreshProcessWorkspaceV1,
  validateFreshProcessEvidenceSetV1,
} from './lib/fresh-process-evidence.mjs'
import { perceptualRasterSha256V1 } from './lib/perceptual-raster.mjs'

const CHROME = process.env.EGOLENS_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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
const preflightIdentityKeys = [
  'datasetId', 'caseId', 'sourceManifestHash', 'catalogHash', 'shareDescriptorHash',
  'recipeHash', 'formatFingerprint', 'operatorSetFingerprint',
]
if (expectedPreflightIdentity
  && JSON.stringify(Object.keys(expectedPreflightIdentity).sort()) !== JSON.stringify([...preflightIdentityKeys].sort())) {
  throw new Error('--expected-preflight-identity must contain the closed Phase 10 identity shape')
}
if (expectedSourceManifestHash && !/^sha256:[0-9a-f]{64}$/u.test(expectedSourceManifestHash)) {
  throw new Error('--expected-source-manifest-hash must be a lowercase sha256: digest')
}
if (localSourceRoot && !expectedSourceManifestHash) {
  throw new Error('--local-source requires --expected-source-manifest-hash for counted identity verification')
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
if (localSourceRoot && (() => {
  const params = new URL(String(options.url)).searchParams
  return params.has('share') || params.get('shareVersion') === '1'
})()) {
  throw new Error('--local-source cannot be combined with a portable share URL')
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

async function evaluate(client, sessionId, expression, commandTimeoutMs = 60_000) {
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
    || (preflightScene && descriptor.sceneId !== preflightScene)
    || JSON.stringify(descriptor.capabilities) !== JSON.stringify(expectedCapabilities)
    || (adapterAmnesia && (descriptor.mode !== 'adapter-amnesia'
      || !/^sha256:[0-9a-f]{64}$/u.test(descriptor.recipeHash)))
    || Math.max(...conformanceConfig.frameIndices) >= descriptor.frameCount) {
    throw new Error(`Conformance descriptor does not match the reviewed target: ${JSON.stringify(descriptor)}`)
  }

  if (perceptualOutputDirectory) await mkdir(perceptualOutputDirectory, { recursive: true })
  const references = []
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
    const clip = await evaluate(client, pageSession, `(() => {
      const element = document.querySelector(${JSON.stringify(capture.selector)});
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      // Capture the deterministic inner integer-pixel rectangle. Flex layout
      // can place an edge at N + 0.5 CSS pixels and Chromium may round the
      // same transport-neutral view to N or N + 1 across fresh processes.
      const x = Math.ceil(rect.left);
      const y = Math.ceil(rect.top);
      return {
        x, y,
        width: Math.max(0, Math.floor(rect.right) - x),
        height: Math.max(0, Math.floor(rect.bottom) - y),
        scale: 1,
      };
    })()`)
    if (!clip || clip.width <= 0 || clip.height <= 0) {
      throw new Error(`Perceptual capture selector is missing or empty: ${capture.selector}`)
    }
    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip,
    }, pageSession, timeoutMs)
    const bytes = Buffer.from(screenshot.data, 'base64')
    const reference = {
      id: capture.id,
      sha256: perceptualRasterSha256V1(bytes),
      width: Math.round(clip.width),
      height: Math.round(clip.height),
    }
    references.push(reference)
    if (perceptualOutputDirectory) {
      await writeFile(path.join(perceptualOutputDirectory, `${capture.id}.png`), bytes, { flag: 'wx' })
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
    recipeHash: descriptor.recipeHash,
    identity: descriptor.preflightIdentity,
    presentation,
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
  const initialMarks = run.snapshots.afterWarmup.app?.marks ?? []
  const start = initialMarks.find((mark) => mark.name.startsWith('egolens:scene-load-start:'))
  const ready = initialMarks.find((mark) => mark.name.startsWith('egolens:dataset-ready:'))
  const first = initialMarks.find((mark) => mark.name.startsWith('egolens:first-usable-frame:'))
  const initialGeneration = ready?.detail?.sceneGeneration ?? first?.detail?.sceneGeneration
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
  await client.send('Page.navigate', { url: withPerf(options.url) }, pageSession)
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
    await enumerateLocalSourceFiles(localSourceRoot)
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
  const preflight = expectedPreflightIdentity
    ? await evaluate(client, pageSession, `(() => {
        const descriptor = globalThis.__EGOLENS_ORACLE_CAPTURE__?.descriptor();
        const presentation = globalThis.__EGOLENS_ORACLE_CAPTURE__?.presentation();
        return descriptor ? {
          datasetId: descriptor.datasetId,
          sceneId: descriptor.sceneId,
          identity: descriptor.preflightIdentity,
          presentation,
        } : null;
      })()`)
    : null
  if (expectedPreflightIdentity) {
    const actualIdentity = preflight?.identity
    const expectedRuntimeIdentity = Object.fromEntries(preflightIdentityKeys.slice(2)
      .map((key) => [key, expectedPreflightIdentity[key]]))
    if (!preflight || preflight.datasetId !== expectedPreflightIdentity.datasetId
      || (preflightScene && preflight.sceneId !== preflightScene)
      || JSON.stringify(actualIdentity) !== JSON.stringify(expectedRuntimeIdentity)) {
      throw new Error(`Observed preflight identity does not match the counted mode: ${JSON.stringify(preflight)}`)
    }
  }
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

async function launchBrowser() {
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

async function closeBrowser(isolatedBrowser) {
  const { chrome, client } = isolatedBrowser
  client.close()
  return closeFreshProcessWorkspaceV1(isolatedBrowser, chrome)
}

const warmups = []
const samples = []
let recordedBrowserVersion = null
for (let index = 0; index < warmupCount + runCount; index++) {
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
  if (index < warmupCount) warmups.push(run)
  else samples.push(run)
  process.stderr.write(`[phase6] run ${index + 1}/${warmupCount + runCount} completed in ${Math.round((Date.now() - startedAt) / 1000)}s\n`)
}

validateFreshProcessEvidenceSetV1([...warmups, ...samples].map((run) => run.browserProcess))

{
  const output = {
    schemaVersion: 1,
    scenario: {
      dataset: options.dataset ?? 'unspecified',
      url: withPerf(options.url),
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
      sourceMode: localSourceRoot
        ? 'local-directory-input'
        : (new URL(String(options.url)).searchParams.has('share')
            || new URL(String(options.url)).searchParams.get('shareVersion') === '1')
          ? 'portable-share'
          : 'remote-url',
      viewport: { width: viewport[0], height: viewport[1] },
    },
    environment: {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
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
}
