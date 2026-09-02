import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  AMNESIA_BOUNDARY_REPORT_KIND,
  AMNESIA_BOUNDARY_RUNTIME_ID,
  AMNESIA_DATASETS,
  AMNESIA_PUBLIC_TOOLS,
  amnesiaBoundaryWitness,
  boundaryReportPayload,
  verifyAmnesiaBoundaryReport,
  verifyAmnesiaBoundaryWitness,
} from './lib/amnesia-evidence.mjs'
import { sha256Canonical } from './lib/oracle-receipts.mjs'

const CANDIDATE_COMMIT = '1d34b6f000000000000000000000000000000000'

function boundaryCase(datasetId, index) {
  const root = `/private/tmp/egolens-amnesia-${datasetId}-${index}`
  return {
    datasetId,
    caseId: `${datasetId}-fixture`,
    runId: `fixture-${datasetId}-${index}`,
    sourceCommit: CANDIDATE_COMMIT,
    applicationBuildHash: `sha256:${'a'.repeat(64)}`,
    recipeHash: `sha256:${String(index + 7).repeat(64)}`,
    sourceFingerprint: `sha256-${String(index + 1).repeat(64)}`,
    sourceContentHash: `sha256-${String(index + 2).repeat(64)}`,
    policyHash: `sha256:${String(index + 1).repeat(64)}`,
    negativeProbeReportHash: `sha256:${String(index + 4).repeat(64)}`,
    sourceCount: 1,
    controllerDatasetAccess: false,
    externalToolNetworkDenied: true,
    loopbackOnly: true,
    outputReadDenied: true,
    datasetWriteDenied: true,
    forbiddenResourceReadDenied: true,
    oneSourceAtATime: true,
    publicTools: [...AMNESIA_PUBLIC_TOOLS],
    mounts: [
      { name: 'application', access: 'read-only', canonicalPath: `${root}/application` },
      { name: 'dataset', access: 'read-only', canonicalPath: `${root}/dataset` },
      { name: 'candidate-output', access: 'write-only', canonicalPath: `${root}/output` },
    ],
    browserProfile: {
      canonicalPath: `${root}/browser-profile`, fresh: true, emptyBefore: true, destroyedAfter: true,
    },
    runtimeScratch: {
      canonicalPath: `${root}/runtime-scratch`, fresh: true, emptyBefore: true, destroyedAfter: true,
    },
  }
}

function report() {
  const payload = {
    kind: AMNESIA_BOUNDARY_REPORT_KIND,
    schemaVersion: 1,
    candidateCommit: CANDIDATE_COMMIT,
    enforcement: {
      platform: 'macos-seatbelt',
      coordinatorRuntimeId: AMNESIA_BOUNDARY_RUNTIME_ID,
    },
    controller: {
      datasetAccess: false,
      applicationAccess: false,
      candidateOutputAccess: false,
      toolNetwork: 'loopback-only',
      modelControlPlane: 'exact-controller-process-only',
    },
    cases: AMNESIA_DATASETS.map(boundaryCase),
    passed: true,
  }
  return { ...payload, reportHash: sha256Canonical(payload) }
}

test('accepts only a closed, machine-bound three-case Adapter Amnesia report', () => {
  const value = report()
  assert.equal(verifyAmnesiaBoundaryReport(value, CANDIDATE_COMMIT), true)
  assert.equal(sha256Canonical(boundaryReportPayload(value)), value.reportHash)

  const schema = JSON.parse(readFileSync(
    'benchmarks/oracle/schemas/egolens-adapter-amnesia-boundary-report-v1.schema.json',
    'utf8',
  ))
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
  assert.equal(validate(value), true, JSON.stringify(validate.errors))

  const witness = amnesiaBoundaryWitness(value)
  assert.equal(verifyAmnesiaBoundaryWitness(witness, CANDIDATE_COMMIT), true)
  assert.equal(witness.reportHash, value.reportHash)
  assert.equal(JSON.stringify(witness).includes('/private/tmp/'), false)
  assert.equal(JSON.stringify(witness).includes('canonicalPath'), false)
  for (const witnessCase of witness.cases) {
    assert.equal(Object.hasOwn(witnessCase, 'sourceFingerprint'), false)
    assert.equal(Object.hasOwn(witnessCase, 'sourceContentHash'), false)
    assert.equal(Object.hasOwn(witnessCase, 'policyHash'), false)
    assert.equal(Object.hasOwn(witnessCase, 'negativeProbeReportHash'), false)
  }
  const witnessSchema = JSON.parse(readFileSync(
    'benchmarks/oracle/schemas/egolens-adapter-amnesia-boundary-witness-v1.schema.json',
    'utf8',
  ))
  const validateWitness = new Ajv2020({ allErrors: true, strict: true }).compile(witnessSchema)
  assert.equal(validateWitness(witness), true, JSON.stringify(validateWitness.errors))
})

test('rejects stale, tampered, duplicated, and weakened boundary reports', () => {
  const value = report()
  assert.equal(verifyAmnesiaBoundaryReport(value, 'f'.repeat(40)), false)
  assert.equal(verifyAmnesiaBoundaryReport({ ...value, passed: false }, CANDIDATE_COMMIT), false)

  const duplicatePayload = {
    ...boundaryReportPayload(value),
    cases: [value.cases[0], value.cases[0], value.cases[2]],
  }
  const duplicate = { ...duplicatePayload, reportHash: sha256Canonical(duplicatePayload) }
  assert.equal(verifyAmnesiaBoundaryReport(duplicate, CANDIDATE_COMMIT), false)

  const weakenedPayload = structuredClone(boundaryReportPayload(value))
  weakenedPayload.cases[0].outputReadDenied = false
  const weakened = { ...weakenedPayload, reportHash: sha256Canonical(weakenedPayload) }
  assert.equal(verifyAmnesiaBoundaryReport(weakened, CANDIDATE_COMMIT), false)

  const staleSourcePayload = structuredClone(boundaryReportPayload(value))
  staleSourcePayload.cases[0].sourceCommit = 'f'.repeat(40)
  const staleSource = { ...staleSourcePayload, reportHash: sha256Canonical(staleSourcePayload) }
  assert.equal(verifyAmnesiaBoundaryReport(staleSource, CANDIDATE_COMMIT), false)

  const mixedBuildPayload = structuredClone(boundaryReportPayload(value))
  mixedBuildPayload.cases[0].applicationBuildHash = `sha256:${'b'.repeat(64)}`
  const mixedBuild = { ...mixedBuildPayload, reportHash: sha256Canonical(mixedBuildPayload) }
  assert.equal(verifyAmnesiaBoundaryReport(mixedBuild, CANDIDATE_COMMIT), false)

  const extraPayload = { ...boundaryReportPayload(value), unverifiedClaim: true }
  const extra = { ...extraPayload, reportHash: sha256Canonical(extraPayload) }
  assert.equal(verifyAmnesiaBoundaryReport(extra, CANDIDATE_COMMIT), false)
})
