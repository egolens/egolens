#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import os from 'node:os'
import path from 'node:path'

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
  url.searchParams.set('perf', '1')
  url.searchParams.set('benchmarkHold', '1')
  url.searchParams.set('speed', '4')
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
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
        else pending.resolve(message.result ?? {})
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new CdpClient(socket)
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
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

async function evaluate(client, sessionId, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId)
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

function quantile(values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}

function summarizeRun(run) {
  // Initial-load milestones come from the coordinated post-warmup snapshot so
  // later scene generations cannot be paired with the first run's start mark.
  const initialMarks = run.snapshots.afterWarmup.app?.marks ?? []
  const soakMarks = run.snapshots.afterSoak.app?.marks ?? []
  const start = initialMarks.find((mark) => mark.name.startsWith('egolens:scene-load-start:'))
  const ready = initialMarks.find((mark) => mark.name.startsWith('egolens:dataset-ready:'))
  const first = initialMarks.find((mark) => mark.name.startsWith('egolens:first-usable-frame:'))
  const latencies = soakMarks
    .filter((mark) => mark.name.startsWith('egolens:frame-presented:'))
    .map((mark) => mark.detail?.inputToFrameMs)
    .filter(Number.isFinite)
  const drawFrames = run.trace.filter((event) => event.name === 'DrawFrame').length
  const frameTimestamps = run.trace
    .filter((event) => event.name === 'DrawFrame')
    .map((event) => event.ts)
    .filter(Number.isFinite)
  const traceSeconds = frameTimestamps.length > 1
    ? (Math.max(...frameTimestamps) - Math.min(...frameTimestamps)) / 1_000_000
    : 0
  const longTaskMs = run.trace
    .filter((event) => event.name === 'RunTask' && Number(event.dur) >= 50_000)
    .reduce((sum, event) => sum + Number(event.dur) / 1000, 0)
  return {
    datasetReadyMs: start && ready ? ready.startTime - start.startTime : null,
    firstUsableFrameMs: start && first ? first.startTime - start.startTime : null,
    frameLatencyP50Ms: quantile(latencies, 0.5),
    frameLatencyP95Ms: quantile(latencies, 0.95),
    tracedFrameRate: traceSeconds > 0 ? drawFrames / traceSeconds : null,
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
      'datasetReadyMs', 'firstUsableFrameMs', 'frameLatencyP50Ms', 'frameLatencyP95Ms',
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
  const offTrace = client.on('Tracing.dataCollected', (message) => trace.push(...message.params.value))
  const offTraceComplete = client.on('Tracing.tracingComplete', () => traceCompleteResolve())

  await Promise.all([
    client.send('Page.enable', {}, pageSession),
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
    try {
      app = await evaluate(client, pageSession, 'globalThis.__EGOLENS_PERF__?.snapshot() ?? null')
    } catch { /* The document may be between navigations. */ }
    return {
      label,
      wallTime: new Date().toISOString(),
      pageHeap,
      workerHeaps,
      dom,
      performanceMetrics: performanceMetrics.metrics,
      app,
      liveWorkerTargets: [...workers.values()].map(({ sessionId: _sessionId, ...worker }) => worker),
    }
  }

  const snapshots = { beforeLoad: await capture('before-load'), soakCheckpoints: [] }
  await client.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,loading,v8',
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
    bufferUsageReportingInterval: 1000,
  }, pageSession)
  await client.send('Page.navigate', { url: withPerf(options.url) }, pageSession)
  await waitFor(client, pageSession, 'Boolean(globalThis.__EGOLENS_PERF__)')
  snapshots.beforeSceneLoad = await capture('before-scene-load')
  await evaluate(client, pageSession, `window.dispatchEvent(new Event('egolens:benchmark-start')); true`)
  await waitFor(client, pageSession, `Boolean(globalThis.__EGOLENS_PERF__?.snapshot().marks.some((mark) => mark.name.startsWith('egolens:dataset-ready:')))`)
  await waitFor(client, pageSession, `Boolean(globalThis.__EGOLENS_PERF__?.snapshot().marks.some((mark) => mark.name.startsWith('egolens:first-usable-frame:')))`)
  await delay(settleMs)
  snapshots.afterWarmup = await capture('after-warmup-settle')

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
      const code = index % 2 === 0 ? 'ArrowRight' : 'ArrowLeft'
      await evaluate(client, pageSession, `window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', shiftKey: true, bubbles: true })); true`)
    }
    await waitFor(client, pageSession, `globalThis.__EGOLENS_PERF__?.snapshot().scene?.sceneGeneration !== ${JSON.stringify(previousGeneration)}`)
    await waitFor(client, pageSession, `globalThis.__EGOLENS_PERF__?.snapshot().marks.some((mark) => mark.name.startsWith('egolens:dataset-ready:') && mark.detail?.sceneGeneration === globalThis.__EGOLENS_PERF__.snapshot().scene?.sceneGeneration)`)
    await exerciseFeatureToggles(client, pageSession)
    await delay(settleMs)
    snapshots.soakCheckpoints.push(await capture(`${crossScenario ? `cross-${crossScenario.dataset}` : 'scene'}-switch-${index + 1}-settle`))
  }

  await delay(settleMs)
  snapshots.afterSoak = await capture('after-soak-settle')
  await evaluate(client, pageSession, `history.pushState({}, '', location.pathname + '?perf=1'); window.dispatchEvent(new PopStateEvent('popstate')); true`)
  await waitFor(client, pageSession, 'globalThis.__EGOLENS_PERF__?.snapshot().scene === null')
  snapshots.afterDispose = await capture('immediately-after-dispose')
  await delay(settleMs)
  snapshots.afterDisposeSettle = await capture('after-dispose-settle')

  await client.send('Tracing.end', {}, pageSession)
  await Promise.race([traceComplete, delay(30_000)])
  await client.send('Target.closeTarget', { targetId: target.targetId })
  offAttached(); offDetached(); offRequest(); offResponse(); offLoaded(); offTrace(); offTraceComplete()

  return {
    runIndex,
    browserVersion,
    snapshots,
    workerEvents,
    network: [...network.values()],
    trace,
  }
}

const profileDir = await mkdtemp(path.join(tmpdir(), 'egolens-phase6-chrome-'))
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
  const warmups = []
  const samples = []
  for (let index = 0; index < warmupCount + runCount; index++) {
    const run = await runScenario(client, browserVersion, index)
    if (index < warmupCount) warmups.push(run)
    else samples.push(run)
  }
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
      browser: browserVersion,
      heapAggregation: 'sum of Runtime.getHeapUsage.usedSize across the page and attached worker targets; not total browser memory',
    },
    warmups,
    samples,
    summary: aggregate(samples),
  }
  await writeFile(path.resolve(String(options.output)), `${JSON.stringify(output, null, 2)}\n`)
} finally {
  client?.close()
  if (chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve))
    chrome.kill('SIGTERM')
    await Promise.race([exited, delay(5_000)])
  }
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
