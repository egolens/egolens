#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyArtifact } from './lib/oracle-receipts.mjs'
import {
  phase10HashV1,
  validatePreflightModeObservationSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { validateFreshProcessEvidenceSetV1 } from './lib/fresh-process-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

async function json(filename) {
  return JSON.parse(await readFile(path.resolve(filename), 'utf8'))
}

function assertBenchmarkIdentity(artifact, expectedCommit, label) {
  if (artifact.environment?.commit !== expectedCommit || artifact.environment?.dirty !== false) {
    throw new Error(`${label} was not captured from the clean exact candidate commit`)
  }
  if (artifact.scenario?.browserIsolation !== 'per-run'
    || artifact.scenario?.freshProcessEvidence !== 'egolens-fresh-browser-process-v1') {
    throw new Error(`${label} lacks fresh-process isolation`)
  }
  const runs = [...(artifact.warmups ?? []), ...(artifact.samples ?? [])]
  if (runs.length === 0) throw new Error(`${label} has no browser runs`)
  validateFreshProcessEvidenceSetV1(runs.map((run) => run.browserProcess))
}

function assertPerformanceArtifact(artifact) {
  if (artifact.scenario.warmupRuns < 1 || artifact.scenario.measuredRuns < 5
    || artifact.scenario.seeks < 100 || artifact.scenario.playbackLoops < 2
    || artifact.scenario.traceEnabled !== true) {
    throw new Error('Performance evidence does not satisfy the Spec 012 measured scenario')
  }
  for (const run of artifact.samples) {
    if (run.traceCollection?.complete !== true || run.traceCollection?.truncated) {
      throw new Error('Performance trace is incomplete or truncated')
    }
  }
  const summaries = artifact.summary?.runSummaries ?? []
  if (summaries.length < 5 || summaries.some((summary) =>
    !Number.isFinite(summary.datasetReadyMs)
      || !Number.isFinite(summary.firstUsableFrameMs)
      || !Number.isFinite(summary.frameLatencyP95Ms)
      || summary.frameLatencySamples < 1)) {
    throw new Error('Performance evidence is missing required latency samples')
  }
}

function assertLifecycleArtifact(artifact) {
  if (artifact.scenario.measuredRuns < 1 || artifact.scenario.sceneSwitches < 20) {
    throw new Error('Lifecycle evidence does not contain a 20-switch soak')
  }
  for (const run of artifact.samples) {
    const settled = run.snapshots?.afterDisposeSettle
    if (!settled || settled.app?.scene !== null || settled.liveWorkerTargets?.length !== 0
      || settled.app?.resources?.liveObjectUrls !== 0
      || settled.app?.resources?.liveImageBitmaps !== 0) {
      throw new Error('Lifecycle evidence retained scene-owned resources after disposal')
    }
  }
}

const options = args(process.argv.slice(2))
for (const name of [
  'mode', 'identity', 'capture', 'conformance', 'performance', 'lifecycle',
  'expected-commit', 'output',
]) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
const [identity, capture, conformance, performance, lifecycle] = await Promise.all([
  json(options.identity), json(options.capture), json(options.conformance),
  json(options.performance), json(options.lifecycle),
])
const identityKeys = [
  'datasetId', 'caseId', 'sourceManifestHash', 'catalogHash', 'shareDescriptorHash',
  'recipeHash', 'formatFingerprint', 'operatorSetFingerprint',
]
if (JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify([...identityKeys].sort())) {
  throw new Error('Preflight identity file is not closed')
}
for (const [label, artifact] of [['capture', capture], ['performance', performance], ['lifecycle', lifecycle]]) {
  assertBenchmarkIdentity(artifact, options['expected-commit'], label)
}
const expectedRuntimeIdentity = Object.fromEntries(identityKeys.slice(2).map((key) => [key, identity[key]]))
const countedPreflight = capture.samples[0]?.preflight
if (!countedPreflight?.sceneId || !countedPreflight.presentation) {
  throw new Error('Capture benchmark lacks a bound preflight observation')
}
const initialPresentationHash = phase10HashV1(countedPreflight.presentation)
for (const [label, artifact] of [['capture', capture], ['performance', performance], ['lifecycle', lifecycle]]) {
  for (const run of [...(artifact.warmups ?? []), ...(artifact.samples ?? [])]) {
    if (run.preflight?.datasetId !== identity.datasetId
      || run.preflight?.sceneId !== countedPreflight.sceneId
      || JSON.stringify(run.preflight?.identity) !== JSON.stringify(expectedRuntimeIdentity)
      || phase10HashV1(run.preflight?.presentation) !== initialPresentationHash) {
      throw new Error(`${label} is not bound to the counted mode identity and initial presentation`)
    }
  }
}
const distinctProcesses = new Map()
for (const artifact of [capture, performance, lifecycle]) {
  for (const run of [...(artifact.warmups ?? []), ...(artifact.samples ?? [])]) {
    distinctProcesses.set(run.browserProcess.evidenceHash, run.browserProcess)
  }
}
validateFreshProcessEvidenceSetV1([...distinctProcesses.values()])
if (capture.scenario.warmupRuns !== 0 || capture.scenario.measuredRuns !== 1
  || capture.scenario.seeks !== 0 || capture.scenario.sceneSwitches !== 0
  || capture.scenario.playbackLoops !== 0 || capture.samples.length !== 1) {
  throw new Error('Conformance capture must be a single isolated browser run')
}
assertPerformanceArtifact(performance)
assertLifecycleArtifact(lifecycle)
if (!verifyArtifact(conformance)
  || conformance.provenance.generatorCommit !== options['expected-commit']
  || conformance.target?.datasetId !== identity.datasetId
  || conformance.target?.caseId !== identity.caseId) {
  throw new Error('Conformance artifact identity or integrity is invalid')
}
const captured = capture.samples[0].conformance
if (!captured || captured.artifactHash !== conformance.artifactHash
  || captured.generatorCommit !== options['expected-commit']) {
  throw new Error('Capture benchmark is not bound to the conformance artifact')
}
const observedIdentity = captured.identity
if (!observedIdentity || identityKeys.slice(2).some((key) => observedIdentity[key] !== identity[key])) {
  throw new Error('Capture runtime identity does not match the preflight identity file')
}
const capabilities = [...conformance.coverage.requiredCapabilities].sort()
const presentation = captured.presentation
if (!presentation || presentation.presentation?.playing !== false) {
  throw new Error('Preflight presentation was not captured paused')
}
const payload = {
  schema: 'egolens-preflight-mode-observation-v1',
  datasetId: identity.datasetId,
  caseId: identity.caseId,
  candidateCommit: options['expected-commit'],
  mode: options.mode,
  browserProcess: capture.samples[0].browserProcess,
  noAgent: true,
  emptyProfile: true,
  sourceManifestHash: identity.sourceManifestHash,
  catalogHash: identity.catalogHash,
  shareDescriptorHash: identity.shareDescriptorHash,
  recipeHash: identity.recipeHash,
  formatFingerprint: identity.formatFingerprint,
  operatorSetFingerprint: identity.operatorSetFingerprint,
  capabilities,
  capabilityHash: phase10HashV1(capabilities),
  structuralHash: phase10HashV1(conformance.structural),
  numericHash: phase10HashV1(conformance.numeric),
  perceptualHash: phase10HashV1(conformance.perceptual),
  presentationHash: phase10HashV1(presentation),
  performanceHash: phase10HashV1(performance),
  lifecycleHash: phase10HashV1(lifecycle),
  paused: true,
  passed: true,
}
const observation = { ...payload, observationHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(observation)
validatePreflightModeObservationSemanticsV1(observation)
await writeFile(path.resolve(options.output), `${JSON.stringify(observation, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify({
  datasetId: observation.datasetId,
  caseId: observation.caseId,
  mode: observation.mode,
  candidateCommit: observation.candidateCommit,
  observationHash: observation.observationHash,
  passed: true,
}, null, 2)}\n`)
