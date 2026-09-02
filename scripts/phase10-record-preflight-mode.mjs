#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyArtifact } from './lib/oracle-receipts.mjs'
import {
  loadPhase10ProductionTrustV1,
  phase10HashV1,
  phase10ReviewedCoverageV1,
  phase10VerifierBindingV1,
  validatePreflightModeObservationSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { validateFreshProcessEvidenceSetV1 } from './lib/fresh-process-evidence.mjs'
import {
  makeBoundaryObservationV1,
  validateBoundaryEnvironmentV1,
  validateBoundaryRunEvidenceV1,
  validateBoundaryObservationV1,
} from './lib/phase10-counted-browser-boundary.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function args(argv) {
  const allowed = new Set([
    'mode', 'identity', 'capture', 'conformance', 'performance', 'lifecycle',
    'build-boundary', 'expected-commit', 'output',
  ])
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

async function json(filename) {
  return JSON.parse(await readFile(path.resolve(filename), 'utf8'))
}

function assertBenchmarkIdentity(
  artifact,
  expectedCommit,
  sourceTreeHash,
  productionBuildInventoryHash,
  verifierBinding,
  label,
) {
  if (artifact.environment?.commit !== expectedCommit || artifact.environment?.dirty !== false) {
    throw new Error(`${label} was not captured from the clean exact candidate commit`)
  }
  if (artifact.environment?.sourceTreeHash !== sourceTreeHash) {
    throw new Error(`${label} source tree does not match the reproduced production build`)
  }
  if (artifact.scenario?.browserIsolation !== 'per-run'
    || artifact.scenario?.freshProcessEvidence !== 'egolens-fresh-browser-process-v1'
    || artifact.scenario?.countedBrowserBoundary !== 'egolens-counted-browser-boundary-v1') {
    throw new Error(`${label} lacks fresh-process isolation`)
  }
  validateBoundaryEnvironmentV1(artifact.environment?.browserBoundary)
  if (artifact.environment?.candidateIdentitySource !== 'reviewed-build-boundary-inputs'
    || artifact.environment?.verifierToolCommit !== verifierBinding.verifierToolCommit
    || artifact.environment?.verifierToolClean !== true
    || artifact.environment?.verifierSourceTreeHash !== verifierBinding.verifierSourceTreeHash
    || phase10HashV1(artifact.environment?.verifierBinding) !== phase10HashV1(verifierBinding)
    || artifact.environment?.servedBuildInventoryHash !== productionBuildInventoryHash
    || artifact.environment?.appBuildInitialDiskHash !== productionBuildInventoryHash
    || artifact.environment?.appBuildFinalDiskHash !== productionBuildInventoryHash
    || artifact.environment?.immutableAppBuildSnapshotServed !== true
    || artifact.environment?.appBuildLoopbackOnly !== true) {
    throw new Error(`${label} is not bound to the reviewed verifier and immutable production build`)
  }
  const runs = [...(artifact.warmups ?? []), ...(artifact.samples ?? [])]
  if (runs.length === 0) throw new Error(`${label} has no browser runs`)
  for (const run of runs) {
    if (run.appBuild?.immutableSnapshotServed !== true
      || run.appBuild?.loopbackOnly !== true
      || run.appBuild?.servedInventoryHash !== productionBuildInventoryHash
      || run.appBuild?.preRunInventoryHash !== productionBuildInventoryHash
      || run.appBuild?.postRunInventoryHash !== productionBuildInventoryHash) {
      throw new Error(`${label} browser run is not bound to unchanged served production bytes`)
    }
    validateBoundaryRunEvidenceV1(run.browserBoundary, artifact.environment.browserBoundary)
  }
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
  'build-boundary', 'expected-commit', 'output',
]) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
const [identity, capture, conformance, performance, lifecycle, buildBoundary, trust] = await Promise.all([
  json(options.identity), json(options.capture), json(options.conformance),
  json(options.performance), json(options.lifecycle), json(options['build-boundary']),
  loadPhase10ProductionTrustV1(),
])
const verifierBinding = phase10VerifierBindingV1(trust)
await validatePhase10SchemaV1(buildBoundary)
const { reportHash: buildReportHash, ...buildPayload } = buildBoundary
if (buildReportHash !== phase10HashV1(buildPayload)
  || buildBoundary.candidateCommit !== options['expected-commit']
  || !buildBoundary.passed || !buildBoundary.cleanHeadVerified
  || !buildBoundary.detachedCheckoutVerified || !buildBoundary.ignoredInputsExcluded
  || !buildBoundary.sanitizedEnvironmentVerified
  || phase10HashV1(buildBoundary.verifierBinding) !== phase10HashV1(verifierBinding)) {
  throw new Error('Build boundary is not a clean detached reproducible build of the candidate')
}
const identityKeys = [
  'datasetId', 'caseId', 'sourceManifestHash', 'catalogHash', 'shareDescriptorHash',
  'recipeHash', 'formatFingerprint', 'operatorSetFingerprint',
]
if (JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify([...identityKeys].sort())) {
  throw new Error('Preflight identity file is not closed')
}
for (const [label, artifact] of [['capture', capture], ['performance', performance], ['lifecycle', lifecycle]]) {
  assertBenchmarkIdentity(
    artifact,
    options['expected-commit'],
    buildBoundary.sourceTreeHash,
    buildBoundary.production.inventoryHash,
    verifierBinding,
    label,
  )
}
const expectedRuntimeIdentity = Object.fromEntries(identityKeys.slice(2).map((key) => [key, identity[key]]))
const expectedSourceMode = options.mode === 'local'
  ? 'local-directory-input'
  : options.mode === 'share' ? 'portable-share' : 'remote-url'
for (const [label, artifact] of [['capture', capture], ['performance', performance], ['lifecycle', lifecycle]]) {
  if (artifact.scenario?.sourceMode !== expectedSourceMode
    || (options.mode === 'local'
      ? artifact.scenario?.preflightRecipeHash !== identity.recipeHash
      : artifact.scenario?.preflightRecipeHash !== null)) {
    throw new Error(`${label} did not execute the counted mode's exact recipe transport`)
  }
}
const browserBoundary = makeBoundaryObservationV1(options.mode, [capture, performance, lifecycle])
validateBoundaryObservationV1(browserBoundary, options.mode)
const countedPreflight = capture.samples[0]?.preflight
if (!countedPreflight?.sceneId || !countedPreflight.presentation) {
  throw new Error('Capture benchmark lacks a bound preflight observation')
}
const initialPresentationHash = phase10HashV1(countedPreflight.presentation)
if (!countedPreflight.renderedFrame) throw new Error('Capture benchmark lacks ordinary renderer-frame evidence')
const rendererFrameHash = phase10HashV1(countedPreflight.renderedFrame)
for (const [label, artifact] of [['capture', capture], ['performance', performance], ['lifecycle', lifecycle]]) {
  for (const run of [...(artifact.warmups ?? []), ...(artifact.samples ?? [])]) {
    if (run.preflight?.datasetId !== identity.datasetId
      || run.preflight?.sceneId !== countedPreflight.sceneId
      || run.preflight?.buildCommit !== options['expected-commit']
      || run.preflight?.sourceTreeHash !== buildBoundary.sourceTreeHash
      || JSON.stringify(run.preflight?.identity) !== JSON.stringify(expectedRuntimeIdentity)
      || phase10HashV1(run.preflight?.presentation) !== initialPresentationHash
      || phase10HashV1(run.preflight?.renderedFrame) !== rendererFrameHash) {
      throw new Error(`${label} is not bound to the counted mode identity and initial presentation`)
    }
    if (run.postSoakPreflight?.datasetId !== identity.datasetId
      || run.postSoakPreflight?.sceneId !== countedPreflight.sceneId
      || run.postSoakPreflight?.buildCommit !== options['expected-commit']
      || run.postSoakPreflight?.sourceTreeHash !== buildBoundary.sourceTreeHash
      || JSON.stringify(run.postSoakPreflight?.identity) !== JSON.stringify(expectedRuntimeIdentity)) {
      throw new Error(`${label} did not preserve the counted recipe on its exercised managed scene`)
    }
    // `noAgent` below is backed by page-level evidence from every observed
    // run: the counted page exposed no WebMCP model context and its authoring
    // session was never engaged by a tool call, before and after the exercise.
    for (const [phase, observation] of [['preflight', run.preflight], ['postSoakPreflight', run.postSoakPreflight]]) {
      const activity = observation?.agentActivity
      if (activity?.modelContextAvailable !== false || activity?.agentEngaged !== false) {
        throw new Error(`${label} ${phase} does not prove an agent-free counted run`)
      }
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
const requirement = trust.phase10Requirements.datasets.find((entry) => entry.datasetId === identity.datasetId)
const reviewedCoverage = phase10ReviewedCoverageV1(requirement)
if (requirement?.caseId !== identity.caseId
  || phase10HashV1(conformance.coverage) !== phase10HashV1(reviewedCoverage)) {
  throw new Error('Conformance artifact does not contain the exact checked-in reviewed coverage')
}
const captured = capture.samples[0].conformance
if (!captured || captured.artifactHash !== conformance.artifactHash
  || captured.generatorCommit !== options['expected-commit']
  || captured.buildCommit !== options['expected-commit']
  || captured.sourceTreeHash !== buildBoundary.sourceTreeHash) {
  throw new Error('Capture benchmark is not bound to the conformance artifact')
}
const perceptualParity = captured.perceptualParity
const expectedPerceptualIds = [...(conformance.coverage?.perceptualReferenceIds ?? [])].sort()
if (perceptualParity?.algorithm !== 'egolens-perceptual-raster-v2'
  || !Array.isArray(perceptualParity.references)
  || JSON.stringify(perceptualParity.references.map((entry) => entry.id).sort())
    !== JSON.stringify(expectedPerceptualIds)
  || perceptualParity.references.some((entry) => !/^sha256-[0-9a-f]{64}$/u.test(entry.sha256)
    || !Number.isSafeInteger(entry.width) || entry.width <= 0
    || !Number.isSafeInteger(entry.height) || entry.height <= 0
    || (entry.id.startsWith('viewport-') && (entry.width !== 1440 || entry.height !== 600)))) {
  throw new Error('Capture benchmark lacks the reviewed Phase 10 perceptual parity surface')
}
const observedIdentity = captured.identity
if (!observedIdentity || identityKeys.slice(2).some((key) => observedIdentity[key] !== identity[key])) {
  throw new Error('Capture runtime identity does not match the preflight identity file')
}
const capabilities = [...reviewedCoverage.requiredCapabilities]
const presentation = captured.presentation
if (!presentation || presentation.presentation?.playing !== false) {
  throw new Error('Preflight presentation was not captured paused')
}
const payload = {
  schema: 'egolens-preflight-mode-observation-v1',
  verifierBinding,
  datasetId: identity.datasetId,
  caseId: identity.caseId,
  candidateCommit: options['expected-commit'],
  sourceTreeHash: buildBoundary.sourceTreeHash,
  productionBuildInventoryHash: buildBoundary.production.inventoryHash,
  mode: options.mode,
  browserProcess: capture.samples[0].browserProcess,
  browserBoundary,
  noAgent: true,
  emptyProfile: true,
  sourceManifestHash: identity.sourceManifestHash,
  catalogHash: identity.catalogHash,
  shareDescriptorHash: identity.shareDescriptorHash,
  recipeHash: identity.recipeHash,
  formatFingerprint: identity.formatFingerprint,
  operatorSetFingerprint: identity.operatorSetFingerprint,
  coverage: reviewedCoverage,
  coverageHash: phase10HashV1(reviewedCoverage),
  capabilities,
  capabilityHash: phase10HashV1(capabilities),
  structuralHash: phase10HashV1(conformance.structural),
  numericHash: phase10HashV1(conformance.numeric),
  rendererFrameHash,
  perceptualAlgorithm: perceptualParity.algorithm,
  perceptualHash: phase10HashV1(perceptualParity),
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
  verifierBinding: observation.verifierBinding,
  datasetId: observation.datasetId,
  caseId: observation.caseId,
  mode: observation.mode,
  candidateCommit: observation.candidateCommit,
  observationHash: observation.observationHash,
  passed: true,
}, null, 2)}\n`)
