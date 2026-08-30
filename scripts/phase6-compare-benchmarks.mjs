#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const argv = process.argv.slice(2)
const value = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const baselinePath = value('baseline')
const candidatePath = value('candidate')
const outputPath = value('output')
if (!baselinePath || !candidatePath) {
  throw new Error('Usage: npm run benchmark:phase6:compare -- --baseline <json> --candidate <json> [--output <json>]')
}

const baseline = JSON.parse(await readFile(path.resolve(baselinePath), 'utf8'))
const candidate = JSON.parse(await readFile(path.resolve(candidatePath), 'utf8'))
const MiB = 1024 * 1024

function quantile(values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}

function distValue(result, metric, statistic = 'p95') {
  return result.summary?.distribution?.[metric]?.[statistic] ?? null
}

function heapUsed(snapshot) {
  if (!snapshot) return null
  return (snapshot.pageHeap?.usedSize ?? 0)
    + (snapshot.workerHeaps ?? []).reduce((sum, worker) => sum + (worker.usedSize ?? 0), 0)
}

function settledHeapDistribution(result) {
  return result.samples.map((run) => heapUsed(run.snapshots.afterSoak)).filter(Number.isFinite)
}

function linearSlope(values) {
  if (values.length < 2) return 0
  const meanX = (values.length - 1) / 2
  const meanY = values.reduce((sum, entry) => sum + entry, 0) / values.length
  let numerator = 0
  let denominator = 0
  values.forEach((entry, index) => {
    numerator += (index - meanX) * (entry - meanY)
    denominator += (index - meanX) ** 2
  })
  return denominator === 0 ? 0 : numerator / denominator
}

const checks = []
function check(name, pass, evidence) {
  checks.push({ name, pass: Boolean(pass), evidence })
}

const comparableScenarioFields = [
  'dataset', 'url', 'seeks', 'sceneSwitches', 'crossDatasetSwitches',
  'switchScenarioDatasets', 'playbackLoops', 'settleMs', 'traceEventLimit', 'viewport',
]
const baselineScenario = Object.fromEntries(comparableScenarioFields.map((key) => [key, baseline.scenario?.[key]]))
const candidateScenario = Object.fromEntries(comparableScenarioFields.map((key) => [key, candidate.scenario?.[key]]))
const baselineBrowser = baseline.environment?.browser
const candidateBrowser = candidate.environment?.browser
const environmentSignature = (result) => ({
  platform: result.environment?.platform,
  architecture: result.environment?.architecture,
  cpu: result.environment?.cpu,
  cpuCount: result.environment?.cpuCount,
  memoryBytes: result.environment?.memoryBytes,
  browserProduct: result.environment?.browser?.product,
  browserRevision: result.environment?.browser?.revision,
  browserJsVersion: result.environment?.browser?.jsVersion,
})
check('baseline and candidate scenario match',
  JSON.stringify(baselineScenario) === JSON.stringify(candidateScenario),
  { baseline: baselineScenario, candidate: candidateScenario })
check('browser and hardware environment match',
  JSON.stringify(environmentSignature(baseline)) === JSON.stringify(environmentSignature(candidate)),
  { baseline: environmentSignature(baseline), candidate: environmentSignature(candidate) })
check('benchmark artifacts are committed builds',
  baseline.environment?.dirty === false && candidate.environment?.dirty === false,
  { baselineDirty: baseline.environment?.dirty, candidateDirty: candidate.environment?.dirty })
check('required sample counts are present',
  baseline.scenario?.warmupRuns >= 1
    && candidate.scenario?.warmupRuns >= 1
    && baseline.samples?.length >= 5
    && candidate.samples?.length >= 5,
  {
    baselineWarmups: baseline.scenario?.warmupRuns,
    candidateWarmups: candidate.scenario?.warmupRuns,
    baselineRuns: baseline.samples?.length,
    candidateRuns: candidate.samples?.length,
  })
check('required soak workload is present',
  baseline.scenario?.seeks >= 100
    && baseline.scenario?.sceneSwitches >= 20
    && baseline.scenario?.playbackLoops >= 2
    && baseline.scenario?.crossDatasetSwitches === true
    && baseline.scenario?.switchScenarioDatasets?.length >= 2
    && candidate.scenario?.seeks >= 100
    && candidate.scenario?.sceneSwitches >= 20
    && candidate.scenario?.playbackLoops >= 2
    && candidate.scenario?.crossDatasetSwitches === true
    && candidate.scenario?.switchScenarioDatasets?.length >= 2,
  { scenario: candidate.scenario })
check('CDP browser identity is present',
  Boolean(baselineBrowser?.product && baselineBrowser?.revision && candidateBrowser?.product && candidateBrowser?.revision),
  { baseline: baselineBrowser, candidate: candidateBrowser })
check('bounded traces are complete',
  [...(baseline.warmups ?? []), ...(baseline.samples ?? []), ...(candidate.warmups ?? []), ...(candidate.samples ?? [])]
    .every((run) => run.traceCollection?.complete === true && run.traceCollection?.truncated === false),
  {
    baseline: [...(baseline.warmups ?? []), ...(baseline.samples ?? [])].map((run) => run.traceCollection),
    candidate: [...(candidate.warmups ?? []), ...(candidate.samples ?? [])].map((run) => run.traceCollection),
  })

const baselineFirst = distValue(baseline, 'firstUsableFrameMs')
const candidateFirst = distValue(candidate, 'firstUsableFrameMs')
const firstAllowance = Math.max((baselineFirst ?? 0) * 0.1, 50)
check('first usable frame p95', candidateFirst !== null && baselineFirst !== null && candidateFirst <= baselineFirst + firstAllowance, {
  baselineMs: baselineFirst, candidateMs: candidateFirst, allowanceMs: firstAllowance,
})

const baselineFrame = distValue(baseline, 'frameLatencyP95Ms')
const candidateFrame = distValue(candidate, 'frameLatencyP95Ms')
const frameAllowance = Math.max((baselineFrame ?? 0) * 0.1, 16.7)
check('warm/rapid frame latency p95', candidateFrame !== null && baselineFrame !== null && candidateFrame <= baselineFrame + frameAllowance, {
  baselineMs: baselineFrame, candidateMs: candidateFrame, allowanceMs: frameAllowance,
})

const baselineFps = distValue(baseline, 'tracedFrameRate', 'p50')
const candidateFps = distValue(candidate, 'tracedFrameRate', 'p50')
check('steady traced frame rate', candidateFps !== null && baselineFps !== null && candidateFps >= baselineFps * 0.95, {
  baselineFps, candidateFps, minimumFps: baselineFps === null ? null : baselineFps * 0.95,
})

for (const metric of ['rowGroupFetches', 'decompressions']) {
  const before = distValue(baseline, metric)
  const after = distValue(candidate, metric)
  check(`${metric} does not increase`, before !== null && after !== null && after <= before, { baseline: before, candidate: after })
}

const baselineHeap = quantile(settledHeapDistribution(baseline), 0.95)
const candidateHeap = quantile(settledHeapDistribution(candidate), 0.95)
const heapAllowance = Math.max((baselineHeap ?? 0) * 0.1, 32 * MiB)
check('settled page plus worker V8 usedSize p95', baselineHeap !== null && candidateHeap !== null && candidateHeap <= baselineHeap + heapAllowance, {
  baselineBytes: baselineHeap,
  candidateBytes: candidateHeap,
  allowanceBytes: heapAllowance,
  aggregation: candidate.environment?.heapAggregation,
})

for (const [runIndex, run] of candidate.samples.entries()) {
  const disposed = run.snapshots.afterDisposeSettle
  const app = disposed.app
  const beforeRenderer = run.snapshots.beforeSceneLoad.app?.renderer ?? { textures: 0, geometries: 0, programs: 0, materials: 0 }
  check(`run ${runIndex + 1} disposed workers and browser resources`,
    disposed.liveWorkerTargets.length === 0
      && app?.resources.liveObjectUrls === 0
      && app?.resources.liveImageBitmaps === 0
      && app?.lastDisposedScene?.cache.pointBytes === 0
      && app?.lastDisposedScene?.cache.cameraBytes === 0
      && app?.lastDisposedScene?.cache.metadataFrames === 0
      && [app?.lastDisposedScene?.workers.point, app?.lastDisposedScene?.workers.camera]
        .filter(Boolean)
        .every((pool) => pool.terminated && pool.workers === 0 && pool.queued === 0 && pool.inFlight === 0),
    {
      workers: disposed.liveWorkerTargets.length,
      resources: app?.resources,
      disposedScene: app?.lastDisposedScene,
    })
  check(`run ${runIndex + 1} renderer returns to pre-scene counts`,
    JSON.stringify(app?.renderer) === JSON.stringify(beforeRenderer),
    { before: beforeRenderer, after: app?.renderer })
  const beforeDocument = run.snapshots.beforeSceneLoad.documentShape
  const afterDocument = disposed.documentShape
  const structuralDocumentShape = (shape) => {
    if (!shape) return null
    const { url: _url, ...structure } = shape
    return structure
  }
  check(`run ${runIndex + 1} live document returns to pre-scene shape`,
    beforeDocument !== null && afterDocument !== null
      && JSON.stringify(structuralDocumentShape(afterDocument)) === JSON.stringify(structuralDocumentShape(beforeDocument)),
    { before: beforeDocument, after: afterDocument })
  const beforeDom = run.snapshots.beforeSceneLoad.dom
  const naturalDom = disposed.dom
  const forcedGc = run.snapshots.afterDisposeForcedGcDiagnostic
  const forcedDom = forcedGc?.dom
  check(`run ${runIndex + 1} forced-GC diagnostic has no reachable detached DOM/listeners`,
    beforeDom !== null && forcedDom !== null && forcedDom !== undefined
      && forcedDom.documents <= beforeDom.documents
      && forcedDom.nodes <= beforeDom.nodes
      && forcedDom.jsEventListeners <= beforeDom.jsEventListeners,
    { before: beforeDom, natural: naturalDom, forcedGc: forcedDom })

  const checkpoints = run.snapshots.soakCheckpoints ?? []
  if (checkpoints.length > 1) {
    const retained = checkpoints.map((snapshot) => {
      const cache = snapshot.app?.scene?.cache
      return heapUsed(snapshot) + (cache ? cache.pointBytes + cache.cameraBytes : 0)
    })
    const slope = linearSlope(retained)
    check(`run ${runIndex + 1} settled soak slope`, slope <= MiB, {
      bytesPerSwitch: slope,
      maximumBytesPerSwitch: MiB,
      checkpoints: retained,
    })
  }
}

const report = {
  schemaVersion: 1,
  baseline: { path: path.resolve(baselinePath), commit: baseline.environment?.commit },
  candidate: { path: path.resolve(candidatePath), commit: candidate.environment?.commit },
  passed: checks.every((entry) => entry.pass),
  checks,
}
const json = `${JSON.stringify(report, null, 2)}\n`
if (outputPath) await writeFile(path.resolve(outputPath), json)
process.stdout.write(json)
if (!report.passed) process.exitCode = 1
