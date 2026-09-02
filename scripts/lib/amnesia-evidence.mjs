import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalize, sha256Canonical } from './oracle-receipts.mjs'

export const AMNESIA_DENIED_RESOURCES = Object.freeze([
  'bundled-recipes',
  'dataset-loader-source',
  'legacy-runtime',
  'oracle-bundles',
  'oracle-values',
  'judge-cli',
  'judge-private-key',
])

export const AMNESIA_PUBLIC_TOOLS = Object.freeze([
  'egolens_teachable_apply_revision',
  'egolens_teachable_finalize',
  'egolens_teachable_get_contract',
  'egolens_teachable_get_state',
  'egolens_teachable_inspect',
])

export const AMNESIA_DATASETS = Object.freeze(['waymo', 'nuscenes', 'argoverse2'])
export const AMNESIA_BOUNDARY_REPORT_KIND = 'egolens-adapter-amnesia-boundary-report'
export const AMNESIA_BOUNDARY_WITNESS_KIND = 'egolens-adapter-amnesia-boundary-witness'
export const AMNESIA_BOUNDARY_RUNTIME_ID = 'egolens-amnesia-boundary-coordinator-v1'

/**
 * The only judge version the Phase 9 gate, staging, and Phase 10 binding
 * accept. Pinning it here keeps a forged `--judge-version` from producing a
 * receipt that later verifiers would treat as reviewed.
 */
export const PHASE9_EXPECTED_JUDGE_VERSION = 'spec013-phase9-v1'

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const CANONICAL_SHA256_PATTERN = /^sha256-[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

const JUDGE_TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const JUDGE_GIT = '/usr/bin/git'
const JUDGE_GIT_ENVIRONMENT = Object.freeze({
  HOME: '/var/empty',
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
})

function judgeGit(argv) {
  return execFileSync(JUDGE_GIT, ['-c', 'core.hooksPath=/dev/null', '-C', JUDGE_TOOL_ROOT, ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: JUDGE_GIT_ENVIRONMENT,
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

/**
 * Identity of the checkout that contains this judge/gate implementation. The
 * judge signs `judgeToolCommit` from this value, so it is derived from the
 * module location rather than from the caller's working directory or argv.
 */
export function phase9JudgeToolCheckoutIdentity() {
  let toplevel = null
  let commit = null
  let status = null
  try {
    toplevel = path.resolve(judgeGit(['rev-parse', '--show-toplevel']))
    commit = judgeGit(['rev-parse', 'HEAD'])
    status = judgeGit(['status', '--porcelain=v1', '--untracked-files=all'])
  } catch {
    return Object.freeze({ root: JUDGE_TOOL_ROOT, commit: null, clean: false })
  }
  const clean = toplevel === realpathSync(JUDGE_TOOL_ROOT)
    && COMMIT_PATTERN.test(commit)
    && status === ''
  return Object.freeze({ root: JUDGE_TOOL_ROOT, commit, clean })
}

/**
 * Fail closed unless this tool runs from the clean checkout pinned as
 * `PHASE9_AMNESIA_JUDGE_TOOL_COMMIT`. Returns the verified commit.
 */
export function assertPhase9JudgeToolCheckout(expectedCommit) {
  if (!COMMIT_PATTERN.test(expectedCommit ?? '')) {
    throw new Error('Expected Phase 9 judge tool commit must be a full 40-character Git SHA')
  }
  const identity = phase9JudgeToolCheckoutIdentity()
  if (!identity.clean) {
    throw new Error('Phase 9 judge tools must run from a clean exact reviewed checkout')
  }
  if (identity.commit !== expectedCommit) {
    throw new Error('Phase 9 judge checkout does not match the pinned PHASE9_AMNESIA_JUDGE_TOOL_COMMIT')
  }
  return identity.commit
}

export function assertPhase9JudgeVersion(value) {
  if (value !== PHASE9_EXPECTED_JUDGE_VERSION) {
    throw new Error(`Phase 9 judge version must be exactly ${PHASE9_EXPECTED_JUDGE_VERSION}`)
  }
  return PHASE9_EXPECTED_JUDGE_VERSION
}

const EXPECTED_MOUNTS = Object.freeze([
  { name: 'application', access: 'read-only' },
  { name: 'dataset', access: 'read-only' },
  { name: 'candidate-output', access: 'write-only' },
])

function hasExactKeys(value, expected) {
  return value && canonicalize(Object.keys(value).sort()) === canonicalize([...expected].sort())
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual)
    && actual.length === new Set(actual).size
    && canonicalize([...actual].sort()) === canonicalize([...expected].sort())
}

function validCanonicalPath(value) {
  return typeof value === 'string'
    && value.length > 1
    && value.startsWith('/')
    && !value.includes('//')
    && !value.includes('/./')
    && !value.endsWith('/.')
    && !value.includes('/../')
    && !value.endsWith('/..')
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function pathsAreDisjoint(values) {
  for (let index = 0; index < values.length; index += 1) {
    for (let other = index + 1; other < values.length; other += 1) {
      if (pathsOverlap(values[index], values[other])) return false
    }
  }
  return true
}

function validFreshDirectory(value) {
  return hasExactKeys(value, ['canonicalPath', 'fresh', 'emptyBefore', 'destroyedAfter'])
    && validCanonicalPath(value.canonicalPath)
    && value.fresh === true
    && value.emptyBefore === true
    && value.destroyedAfter === true
}

function validFreshDirectoryWitness(value) {
  return hasExactKeys(value, ['fresh', 'emptyBefore', 'destroyedAfter'])
    && value.fresh === true
    && value.emptyBefore === true
    && value.destroyedAfter === true
}

function validBoundaryCase(entry) {
  if (!hasExactKeys(entry, [
    'datasetId',
    'caseId',
    'runId',
    'sourceCommit',
    'applicationBuildHash',
    'recipeHash',
    'sourceFingerprint',
    'sourceContentHash',
    'policyHash',
    'negativeProbeReportHash',
    'sourceCount',
    'controllerDatasetAccess',
    'externalToolNetworkDenied',
    'loopbackOnly',
    'outputReadDenied',
    'datasetWriteDenied',
    'forbiddenResourceReadDenied',
    'oneSourceAtATime',
    'publicTools',
    'mounts',
    'browserProfile',
    'runtimeScratch',
  ]) || !AMNESIA_DATASETS.includes(entry.datasetId)
    || !ID_PATTERN.test(entry.caseId)
    || !ID_PATTERN.test(entry.runId)
    || !COMMIT_PATTERN.test(entry.sourceCommit)
    || !SHA256_PATTERN.test(entry.applicationBuildHash)
    || !SHA256_PATTERN.test(entry.recipeHash)
    || !CANONICAL_SHA256_PATTERN.test(entry.sourceFingerprint)
    || !CANONICAL_SHA256_PATTERN.test(entry.sourceContentHash)
    || !SHA256_PATTERN.test(entry.policyHash)
    || !SHA256_PATTERN.test(entry.negativeProbeReportHash)
    || entry.sourceCount !== 1
    || entry.controllerDatasetAccess !== false
    || entry.externalToolNetworkDenied !== true
    || entry.loopbackOnly !== true
    || entry.outputReadDenied !== true
    || entry.datasetWriteDenied !== true
    || entry.forbiddenResourceReadDenied !== true
    || entry.oneSourceAtATime !== true
    || !sameStringSet(entry.publicTools, AMNESIA_PUBLIC_TOOLS)
    || !validFreshDirectory(entry.browserProfile)
    || !validFreshDirectory(entry.runtimeScratch)) return false

  if (!Array.isArray(entry.mounts) || entry.mounts.length !== EXPECTED_MOUNTS.length) return false
  const mounts = [...entry.mounts].sort((left, right) => left.name.localeCompare(right.name))
  const expected = [...EXPECTED_MOUNTS].sort((left, right) => left.name.localeCompare(right.name))
  if (mounts.some((mount, index) => !hasExactKeys(mount, ['name', 'access', 'canonicalPath'])
    || mount.name !== expected[index].name
    || mount.access !== expected[index].access
    || !validCanonicalPath(mount.canonicalPath))) return false
  const isolatedPaths = [
    ...mounts.map((mount) => mount.canonicalPath),
    entry.browserProfile.canonicalPath,
    entry.runtimeScratch.canonicalPath,
  ]
  if (!pathsAreDisjoint(isolatedPaths)) return false
  return true
}

export function boundaryReportPayload(report) {
  const { reportHash: _reportHash, ...payload } = report
  return payload
}

export function verifyAmnesiaBoundaryReport(report, expectedCommit) {
  if (!hasExactKeys(report, [
    'kind',
    'schemaVersion',
    'candidateCommit',
    'enforcement',
    'controller',
    'cases',
    'passed',
    'reportHash',
  ]) || report.kind !== AMNESIA_BOUNDARY_REPORT_KIND || report.schemaVersion !== 1
    || report.candidateCommit !== expectedCommit || !COMMIT_PATTERN.test(report.candidateCommit)
    || !hasExactKeys(report.enforcement, ['platform', 'coordinatorRuntimeId'])
    || report.enforcement?.platform !== 'macos-seatbelt'
    || report.enforcement?.coordinatorRuntimeId !== AMNESIA_BOUNDARY_RUNTIME_ID
    || !hasExactKeys(report.controller, [
      'datasetAccess',
      'applicationAccess',
      'candidateOutputAccess',
      'toolNetwork',
      'modelControlPlane',
    ])
    || report.controller?.datasetAccess !== false
    || report.controller?.applicationAccess !== false
    || report.controller?.candidateOutputAccess !== false
    || report.controller?.toolNetwork !== 'loopback-only'
    || report.controller?.modelControlPlane !== 'exact-controller-process-only'
    || report.passed !== true
    || !CANONICAL_SHA256_PATTERN.test(report.reportHash)) return false

  const cases = report.cases ?? []
  if (cases.length !== AMNESIA_DATASETS.length
    || !sameStringSet(cases.map((entry) => entry.datasetId), AMNESIA_DATASETS)
    || new Set(cases.map((entry) => entry.caseId)).size !== cases.length
    || new Set(cases.map((entry) => entry.runId)).size !== cases.length
    || new Set(cases.map((entry) => entry.sourceFingerprint)).size !== cases.length
    || new Set(cases.map((entry) => entry.sourceContentHash)).size !== cases.length
    || new Set(cases.map((entry) => entry.applicationBuildHash)).size !== 1
    || cases.some((entry) => entry.sourceCommit !== expectedCommit)
    || cases.some((entry) => !validBoundaryCase(entry))) return false

  const isolatedPaths = cases.flatMap((entry) => [
    entry.mounts.find((mount) => mount.name === 'application').canonicalPath,
    entry.mounts.find((mount) => mount.name === 'dataset').canonicalPath,
    entry.mounts.find((mount) => mount.name === 'candidate-output').canonicalPath,
    entry.browserProfile.canonicalPath,
    entry.runtimeScratch.canonicalPath,
  ])
  if (!pathsAreDisjoint(isolatedPaths)) return false

  return sha256Canonical(boundaryReportPayload(report)) === report.reportHash
}

export function amnesiaBoundaryWitness(report) {
  if (!verifyAmnesiaBoundaryReport(report, report?.candidateCommit)) {
    throw new Error('Cannot publish an invalid Adapter Amnesia boundary report')
  }
  return {
    kind: AMNESIA_BOUNDARY_WITNESS_KIND,
    schemaVersion: 1,
    candidateCommit: report.candidateCommit,
    reportHash: report.reportHash,
    enforcement: structuredClone(report.enforcement),
    controller: structuredClone(report.controller),
    cases: report.cases.map((entry) => ({
      datasetId: entry.datasetId,
      caseId: entry.caseId,
      runId: entry.runId,
      sourceCommit: entry.sourceCommit,
      applicationBuildHash: entry.applicationBuildHash,
      recipeHash: entry.recipeHash,
      sourceCount: entry.sourceCount,
      controllerDatasetAccess: entry.controllerDatasetAccess,
      externalToolNetworkDenied: entry.externalToolNetworkDenied,
      loopbackOnly: entry.loopbackOnly,
      outputReadDenied: entry.outputReadDenied,
      datasetWriteDenied: entry.datasetWriteDenied,
      forbiddenResourceReadDenied: entry.forbiddenResourceReadDenied,
      oneSourceAtATime: entry.oneSourceAtATime,
      publicTools: [...entry.publicTools],
      mounts: entry.mounts.map((mount) => ({
        name: mount.name,
        access: mount.access,
      })),
      browserProfile: {
        fresh: entry.browserProfile.fresh,
        emptyBefore: entry.browserProfile.emptyBefore,
        destroyedAfter: entry.browserProfile.destroyedAfter,
      },
      runtimeScratch: {
        fresh: entry.runtimeScratch.fresh,
        emptyBefore: entry.runtimeScratch.emptyBefore,
        destroyedAfter: entry.runtimeScratch.destroyedAfter,
      },
    })),
    passed: report.passed,
  }
}

function validBoundaryWitnessCase(entry) {
  if (!hasExactKeys(entry, [
    'datasetId',
    'caseId',
    'runId',
    'sourceCommit',
    'applicationBuildHash',
    'recipeHash',
    'sourceCount',
    'controllerDatasetAccess',
    'externalToolNetworkDenied',
    'loopbackOnly',
    'outputReadDenied',
    'datasetWriteDenied',
    'forbiddenResourceReadDenied',
    'oneSourceAtATime',
    'publicTools',
    'mounts',
    'browserProfile',
    'runtimeScratch',
  ]) || !AMNESIA_DATASETS.includes(entry.datasetId)
    || !ID_PATTERN.test(entry.caseId)
    || !ID_PATTERN.test(entry.runId)
    || !COMMIT_PATTERN.test(entry.sourceCommit)
    || !SHA256_PATTERN.test(entry.applicationBuildHash)
    || !SHA256_PATTERN.test(entry.recipeHash)
    || entry.sourceCount !== 1
    || entry.controllerDatasetAccess !== false
    || entry.externalToolNetworkDenied !== true
    || entry.loopbackOnly !== true
    || entry.outputReadDenied !== true
    || entry.datasetWriteDenied !== true
    || entry.forbiddenResourceReadDenied !== true
    || entry.oneSourceAtATime !== true
    || !sameStringSet(entry.publicTools, AMNESIA_PUBLIC_TOOLS)
    || !validFreshDirectoryWitness(entry.browserProfile)
    || !validFreshDirectoryWitness(entry.runtimeScratch)) return false

  if (!Array.isArray(entry.mounts) || entry.mounts.length !== EXPECTED_MOUNTS.length) return false
  const mounts = [...entry.mounts].sort((left, right) => left.name.localeCompare(right.name))
  const expected = [...EXPECTED_MOUNTS].sort((left, right) => left.name.localeCompare(right.name))
  if (mounts.some((mount, index) => !hasExactKeys(mount, ['name', 'access'])
    || mount.name !== expected[index].name
    || mount.access !== expected[index].access)) return false
  return true
}

export function verifyAmnesiaBoundaryWitness(witness, expectedCommit) {
  if (!hasExactKeys(witness, [
    'kind',
    'schemaVersion',
    'candidateCommit',
    'reportHash',
    'enforcement',
    'controller',
    'cases',
    'passed',
  ]) || witness.kind !== AMNESIA_BOUNDARY_WITNESS_KIND || witness.schemaVersion !== 1
    || witness.candidateCommit !== expectedCommit || !COMMIT_PATTERN.test(witness.candidateCommit)
    || !CANONICAL_SHA256_PATTERN.test(witness.reportHash)
    || !hasExactKeys(witness.enforcement, ['platform', 'coordinatorRuntimeId'])
    || witness.enforcement?.platform !== 'macos-seatbelt'
    || witness.enforcement?.coordinatorRuntimeId !== AMNESIA_BOUNDARY_RUNTIME_ID
    || !hasExactKeys(witness.controller, [
      'datasetAccess',
      'applicationAccess',
      'candidateOutputAccess',
      'toolNetwork',
      'modelControlPlane',
    ])
    || witness.controller?.datasetAccess !== false
    || witness.controller?.applicationAccess !== false
    || witness.controller?.candidateOutputAccess !== false
    || witness.controller?.toolNetwork !== 'loopback-only'
    || witness.controller?.modelControlPlane !== 'exact-controller-process-only'
    || witness.passed !== true) return false

  const cases = witness.cases ?? []
  return cases.length === AMNESIA_DATASETS.length
    && sameStringSet(cases.map((entry) => entry.datasetId), AMNESIA_DATASETS)
    && new Set(cases.map((entry) => entry.caseId)).size === cases.length
    && new Set(cases.map((entry) => entry.runId)).size === cases.length
    && new Set(cases.map((entry) => entry.applicationBuildHash)).size === 1
    && cases.every((entry) => entry.sourceCommit === expectedCommit)
    && cases.every(validBoundaryWitnessCase)
}

export function recipeSemanticHash(recipe) {
  const semantic = structuredClone(recipe)
  delete semantic.identity
  delete semantic.provenance
  delete semantic.hashes
  return `sha256:${createHash('sha256').update(canonicalize(semantic)).digest('hex')}`
}

export function attestationPayload(attestation) {
  const { attestationHash: _attestationHash, ...payload } = attestation
  return payload
}

export function verifyAmnesiaAttestation(attestation, expectedCommit) {
  if (!hasExactKeys(attestation, [
    'kind',
    'schemaVersion',
    'candidateCommit',
    'authoringRuntimeId',
    'publicContract',
    'publicTools',
    'deniedResources',
    'externalToolNetworkEgress',
    'interactiveJudgeAccess',
    'boundaryReportHash',
    'boundaryWitness',
    'mounts',
    'candidates',
    'attestationHash',
  ]) || attestation.kind !== 'egolens-adapter-amnesia-attestation'
    || attestation.schemaVersion !== 2) return false
  if (!COMMIT_PATTERN.test(attestation.candidateCommit)
    || attestation.candidateCommit !== expectedCommit
    || attestation.authoringRuntimeId !== 'egolens-adapter-amnesia-author-v1') return false
  if (attestation.externalToolNetworkEgress !== false || attestation.interactiveJudgeAccess !== false) return false
  if (!hasExactKeys(attestation.publicContract, [
    'recipeSchemaVersion', 'recipeEngineVersion', 'normalizedSceneVersion',
  ]) || canonicalize(attestation.publicContract) !== canonicalize({
    recipeSchemaVersion: 1,
    recipeEngineVersion: '1.0.0',
    normalizedSceneVersion: 1,
  })) return false
  if (canonicalize([...(attestation.publicTools ?? [])].sort()) !== canonicalize([...AMNESIA_PUBLIC_TOOLS].sort())) return false
  if (canonicalize([...(attestation.deniedResources ?? [])].sort()) !== canonicalize([...AMNESIA_DENIED_RESOURCES].sort())) return false
  if (canonicalize(attestation.mounts) !== canonicalize([
    { name: 'application', access: 'read-only', contents: 'amnesia-author-browser-build' },
    { name: 'dataset', access: 'read-only', contents: 'held-out-source-case' },
    { name: 'candidate-output', access: 'write-only', contents: 'one-exported-recipe' },
  ])) return false
  if (!verifyAmnesiaBoundaryWitness(attestation.boundaryWitness, expectedCommit)
    || attestation.boundaryReportHash !== attestation.boundaryWitness.reportHash) return false
  const candidates = attestation.candidates ?? []
  if (candidates.length !== 3
    || !sameStringSet(candidates.map((candidate) => candidate.datasetId), AMNESIA_DATASETS)
    || candidates.some((candidate) => !hasExactKeys(candidate, [
      'datasetId', 'caseId', 'authoredBy', 'recipeHash',
    ]) || candidate.authoredBy !== 'codex'
      || !SHA256_PATTERN.test(candidate.recipeHash)
      || candidate.caseId !== attestation.boundaryWitness.cases
        .find((entry) => entry.datasetId === candidate.datasetId)?.caseId
      || candidate.recipeHash !== attestation.boundaryWitness.cases
        .find((entry) => entry.datasetId === candidate.datasetId)?.recipeHash)) return false
  return sha256Canonical(attestationPayload(attestation)) === attestation.attestationHash
}

export function verifyAmnesiaBoundaryBinding(attestation, report, expectedCommit) {
  if (!verifyAmnesiaAttestation(attestation, expectedCommit)
    || !verifyAmnesiaBoundaryReport(report, expectedCommit)
    || attestation.boundaryReportHash !== report.reportHash) return false
  if (canonicalize(attestation.boundaryWitness) !== canonicalize(amnesiaBoundaryWitness(report))) return false
  const reportByDataset = new Map(report.cases.map((entry) => [entry.datasetId, entry]))
  return attestation.candidates.every((candidate) => {
    const boundaryCase = reportByDataset.get(candidate.datasetId)
    return boundaryCase?.caseId === candidate.caseId && boundaryCase.recipeHash === candidate.recipeHash
  })
}
