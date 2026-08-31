import { createHash } from 'node:crypto'
import { canonicalize } from './oracle-receipts.mjs'

export const PHASE10_SHIPPED_DATASETS = Object.freeze(['waymo', 'nuscenes', 'argoverse2'])
export const PHASE10_HELD_OUT_DATASETS = Object.freeze(['a2d2', 'kitti-raw', 'once', 'pandaset'])
export const PHASE10_PUBLIC_TOOLS = Object.freeze([
  'egolens_teachable_apply_revision',
  'egolens_teachable_finalize',
  'egolens_teachable_get_contract',
  'egolens_teachable_get_state',
  'egolens_teachable_inspect',
])
export const PHASE10_FAILURE_CLASSIFICATIONS = Object.freeze([
  'source-limitation',
  'generic-reader-operator-gap',
  'extension-security-gap',
  'authoring-observability-gap',
  'runtime-resource-gap',
  'recipe-contract-gap',
  'normalized-scene-contract-gap',
])
export const PHASE10_REQUIRED_NEGATIVE_CASES = Object.freeze([
  'catalog-traversal',
  'cors-denial',
  'credential-isolation',
  'redirect-confinement',
  'source-tampering',
  'oversized-response',
  'abort-propagation',
  'missing-range-support',
  'source-hash-mismatch',
  'recipe-hash-mismatch',
  'descriptor-hash-mismatch',
  'ambiguous-share-form',
  'unavailable-registered-extension',
])

const HASH = /^sha256:[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u
const UNC_PATH = /^\\\\/u
const SECRET_QUERY_KEY = /(?:^|[-_])(access[-_]?key|api[-_]?key|auth|bearer|code|credential|jwt|key|pass(?:word)?|policy|secret|session|signature|token)(?:$|[-_])/iu
const PRIVATE_MARKER = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u
const FORBIDDEN_PUBLIC_KEYS = new Set([
  'absolutePath',
  'contentBase64',
  'fileBytes',
  'mediaBytes',
  'privateKey',
  'rawBytes',
  'screenshotBase64',
])

export function phase10HashV1(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
}

export function phase10BytesHashV1(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function without(value, key) {
  const { [key]: _removed, ...payload } = value
  return payload
}

function assertHash(value, label) {
  if (!HASH.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`)
}

function assertCommit(value, label) {
  if (!COMMIT.test(value)) throw new Error(`${label} must be a full lowercase Git commit`)
}

function assertIntegrity(value, key, label) {
  assertHash(value?.[key], `${label}.${key}`)
  if (phase10HashV1(without(value, key)) !== value[key]) throw new Error(`${label}: ${key} mismatch`)
}

function assertSortedUnique(values, label) {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && values[index - 1] >= values[index]) {
      throw new Error(`${label} must be strictly sorted and unique`)
    }
  }
}

function assertSameMembers(left, right, label) {
  if (canonicalize([...left].sort()) !== canonicalize([...right].sort())) {
    throw new Error(`${label} do not match`)
  }
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function assertSafePublicUrlV1(raw, label, { allowLoopbackHttp = false, requireOrigin = false } = {}) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (url.username || url.password) throw new Error(`${label} must not contain user-info`)
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(`${label} must use HTTPS${allowLoopbackHttp ? ' outside loopback' : ''}`)
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEY.test(key) || /^X-(?:Amz|Goog)-/iu.test(key)) {
      throw new Error(`${label} contains a credential-bearing query key`)
    }
  }
  if (requireOrigin && (url.pathname !== '/' || url.search || url.hash)) {
    throw new Error(`${label} must be an exact origin`)
  }
  return url
}

export function normalizeContentBlindPathV1(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    throw new Error('Source path must be a non-empty bounded string')
  }
  if (raw.includes('\\') || raw.startsWith('/') || WINDOWS_ABSOLUTE.test(raw) || UNC_PATH.test(raw)) {
    throw new Error(`Source path is absolute or non-portable: ${raw}`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(raw)) throw new Error(`Source path contains a control character: ${raw}`)
  const segments = raw.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Source path is not canonical: ${raw}`)
  }
  return raw.normalize('NFC')
}

export function publicSafetyViolationsV1(value) {
  const violations = []
  const visit = (entry, pointer) => {
    if (typeof entry === 'string') {
      if (PRIVATE_MARKER.test(entry)) violations.push(`${pointer}: private key material`)
      if (entry.startsWith('file:') || entry.startsWith('data:') || entry.startsWith('blob:')) {
        violations.push(`${pointer}: non-public URI`)
      } else if (entry.startsWith('/') || WINDOWS_ABSOLUTE.test(entry) || UNC_PATH.test(entry)) {
        violations.push(`${pointer}: absolute local path`)
      } else if (/^https?:/u.test(entry)) {
        try {
          const url = new URL(entry)
          if (url.username || url.password) violations.push(`${pointer}: URL user-info`)
          for (const key of url.searchParams.keys()) {
            if (SECRET_QUERY_KEY.test(key) || /^X-(?:Amz|Goog)-/iu.test(key)) {
              violations.push(`${pointer}: credential-bearing query key`)
            }
          }
        } catch {
          violations.push(`${pointer}: malformed URL`)
        }
      }
      return
    }
    if (!entry || typeof entry !== 'object') return
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${pointer}/${index}`))
      return
    }
    for (const [key, child] of Object.entries(entry)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) violations.push(`${pointer}/${key}: forbidden raw/private field`)
      visit(child, `${pointer}/${key}`)
    }
  }
  visit(value, '')
  return violations
}

export function assertPublicSafeV1(value, label = 'public evidence') {
  const violations = publicSafetyViolationsV1(value)
  if (violations.length > 0) throw new Error(`${label} is not public-safe: ${violations.join('; ')}`)
}

export function sourceManifestHashFromFilesV1(files) {
  return phase10HashV1({
    version: 1,
    entries: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  })
}

export function sourceCaseManifestPayloadV1(manifest) {
  return without(manifest, 'manifestHash')
}

export function validateSourceCaseManifestSemanticsV1(manifest) {
  if (manifest?.schema !== 'egolens-source-case-manifest-v1') throw new Error('Invalid source case manifest schema')
  assertSafePublicUrlV1(manifest.release.officialSourceUrl, 'release.officialSourceUrl')
  if (manifest.case.role === 'reserve' ? manifest.case.reserveFor === null : manifest.case.reserveFor !== null) {
    throw new Error('Only reserve cases declare reserveFor')
  }
  const paths = []
  let totalBytes = 0
  for (const file of manifest.files) {
    const normalized = normalizeContentBlindPathV1(file.path)
    if (normalized !== file.path) throw new Error(`Source path is not NFC canonical: ${file.path}`)
    if (!Number.isSafeInteger(file.size)) throw new Error(`Unsafe file size: ${file.path}`)
    assertHash(file.sha256, `files[${file.path}].sha256`)
    paths.push(file.path)
    totalBytes += file.size
    if (!Number.isSafeInteger(totalBytes)) throw new Error('Source case total byte count is unsafe')
  }
  assertSortedUnique(paths, 'Source case paths')
  if (manifest.aggregate.fileCount !== manifest.files.length || manifest.aggregate.totalBytes !== totalBytes) {
    throw new Error('Source case aggregate mismatch')
  }
  if (sourceManifestHashFromFilesV1(manifest.files) !== manifest.sourceManifestHash) {
    throw new Error('Source case sourceManifestHash mismatch')
  }
  assertIntegrity(manifest, 'manifestHash', 'source case manifest')
  return true
}

export function validateCaseReserveManifestSemanticsV1(manifest) {
  if (manifest?.schema !== 'egolens-case-reserve-manifest-v1') throw new Error('Invalid case reserve manifest schema')
  assertSafePublicUrlV1(manifest.officialSourceUrl, 'officialSourceUrl')
  const ids = new Set()
  const manifestHashes = new Set()
  const roleCounts = { D: 0, A: 0, B: 0, reserve: 0 }
  for (const [index, entry] of manifest.cases.entries()) {
    if (entry.order !== index) throw new Error('Case reserve order must be contiguous and canonical')
    if (ids.has(entry.caseId) || manifestHashes.has(entry.sourceCaseManifestHash)) {
      throw new Error('Case reserve entries must be distinct')
    }
    if (entry.role === 'reserve' ? entry.reserveFor === null : entry.reserveFor !== null) {
      throw new Error('Only reserve entries declare reserveFor')
    }
    ids.add(entry.caseId)
    manifestHashes.add(entry.sourceCaseManifestHash)
    roleCounts[entry.role] += 1
  }
  if (roleCounts.D !== 1 || roleCounts.A !== 1 || roleCounts.B !== 1 || roleCounts.reserve < 1) {
    throw new Error('Case reserve manifest requires exactly one D/A/B and at least one reserve')
  }
  if (manifest.cases[0].role !== 'D' || manifest.cases[1].role !== 'A' || manifest.cases[2].role !== 'B') {
    throw new Error('Case reserve manifest must order D, A, B before reserves')
  }
  assertIntegrity(manifest, 'manifestHash', 'case reserve manifest')
  assertPublicSafeV1(manifest, 'case reserve manifest')
  return true
}

export function humanReviewPayloadV1(review) {
  return without(review, 'receiptHash')
}

export function validateHumanReviewSemanticsV1(review) {
  if (review.rejectedRecipeHash === review.correctedRecipeHash) {
    throw new Error('Human review correction must change the semantic recipe hash')
  }
  if (!review.lastGoodScenePreserved) throw new Error('Human review must attest last-good-scene preservation')
  assertIntegrity(review, 'receiptHash', 'human review receipt')
  return true
}

function validateRevisionLineage(lineage, finalRecipeHash) {
  const seen = new Set()
  for (const [index, revision] of lineage.entries()) {
    if (seen.has(revision.revisionId)) throw new Error('Revision IDs must be unique')
    if (index === 0) {
      if (revision.parentRevisionId !== null) throw new Error('First revision parent must be null')
    } else if (!seen.has(revision.parentRevisionId)) {
      throw new Error('Revision parent must reference an earlier revision')
    }
    seen.add(revision.revisionId)
  }
  if (lineage.at(-1)?.recipeHash !== finalRecipeHash) throw new Error('Final lineage recipe hash mismatch')
}

export function validateGeneralizationAttemptSemanticsV1(attempt) {
  if (attempt?.schema !== 'egolens-generalization-attempt-v1') throw new Error('Invalid generalization attempt schema')
  assertCommit(attempt.application.commit, 'application.commit')
  assertSafePublicUrlV1(attempt.application.deployedUrlIdentity, 'application.deployedUrlIdentity', { allowLoopbackHttp: true })
  assertIntegrity(attempt, 'attemptHash', 'generalization attempt')
  assertPublicSafeV1(attempt, 'generalization attempt')
  if (Date.parse(attempt.browserProcess.stoppedAt) < Date.parse(attempt.browserProcess.startedAt)) {
    throw new Error('Browser process stop precedes start')
  }
  const persisted = attempt.phase === 'B-persisted-local'
  if (persisted) {
    if (attempt.browserProcess.profileMode !== 'persisted-origin'
      || attempt.browserProcess.userDataDirectoryCreatedFresh
      || attempt.browserProcess.userDataDirectoryRemoved) {
      throw new Error('Persisted-local B must use and retain the persisted origin profile')
    }
  } else if (attempt.browserProcess.profileMode !== 'empty'
    || !attempt.browserProcess.userDataDirectoryCreatedFresh
    || !attempt.browserProcess.userDataDirectoryRemoved) {
    throw new Error('Every non-persisted attempt must use a removed empty profile')
  }
  const isRemote = attempt.phase === 'B-remote-share'
  if (isRemote) {
    if (attempt.transport.mode !== 'remote' || !attempt.transport.catalogHash
      || !attempt.transport.shareDescriptorHash || !attempt.transport.shareUrlHash) {
      throw new Error('Remote-share B requires catalog, descriptor, and URL identities')
    }
    if (attempt.isolation.networkPolicy.mode !== 'exact-origins'
      || attempt.isolation.networkPolicy.allowedOrigins.length === 0) {
      throw new Error('Remote-share B requires an exact-origin network policy')
    }
    for (const origin of attempt.isolation.networkPolicy.allowedOrigins) {
      assertSafePublicUrlV1(origin, 'networkPolicy.allowedOrigins', { allowLoopbackHttp: true, requireOrigin: true })
    }
  } else {
    if (attempt.transport.mode !== 'local' || attempt.transport.catalogHash
      || attempt.transport.shareDescriptorHash || attempt.transport.shareUrlHash) {
      throw new Error('Local attempts must not carry remote transport identities')
    }
    if (attempt.isolation.networkPolicy.mode !== 'disabled'
      || attempt.isolation.networkPolicy.allowedOrigins.length !== 0) {
      throw new Error('Local authoring and reuse attempts require disabled network egress')
    }
  }
  const isB = attempt.phase.startsWith('B-')
  const totalToolCalls = attempt.isolation.toolCalls.reduce((sum, entry) => sum + entry.count, 0)
  if (isB && (attempt.isolation.agentCalls !== 0 || totalToolCalls !== 0)) {
    throw new Error('Every B run must have zero agent and public-tool calls')
  }
  if (attempt.phase === 'D' && attempt.isolation.agentCalls !== 0) {
    throw new Error('Discovery is not an agent-authored run')
  }
  if (attempt.phase === 'A') {
    assertSameMembers(attempt.isolation.publicTools, PHASE10_PUBLIC_TOOLS, 'A public tool catalog')
    if (attempt.result.passed && !attempt.humanReview) throw new Error('Passing A requires human review')
    if (attempt.humanReview) {
      validateHumanReviewSemanticsV1(attempt.humanReview)
      if (attempt.humanReview.correctedRecipeHash !== attempt.fingerprints.recipeHash) {
        throw new Error('Human-corrected recipe must be the finalized attempt recipe')
      }
    }
  } else if (attempt.humanReview !== null) {
    throw new Error('Only A may carry a human-review receipt')
  }
  validateRevisionLineage(attempt.revisionLineage, attempt.fingerprints.recipeHash)
  if (attempt.result.passed) {
    if (attempt.firstFailure !== null) throw new Error('A passing attempt cannot reference a first failure')
    assertSameMembers(attempt.capabilities.declared, attempt.capabilities.bound, 'Declared and bound capabilities')
  } else if (attempt.firstFailure === null) {
    throw new Error('A failed attempt must preserve a first-failure artifact')
  }
  return true
}

export function validateFirstFailureSemanticsV1(artifact) {
  if (artifact?.schema !== 'egolens-first-failure-v1') throw new Error('Invalid first-failure schema')
  assertCommit(artifact.applicationCommit, 'applicationCommit')
  assertIntegrity(artifact, 'artifactHash', 'first-failure artifact')
  assertPublicSafeV1(artifact, 'first-failure artifact')
  return true
}

export function validatePreflightModeObservationSemanticsV1(observation) {
  if (observation?.schema !== 'egolens-preflight-mode-observation-v1') {
    throw new Error('Invalid preflight mode observation schema')
  }
  assertCommit(observation.candidateCommit, 'candidateCommit')
  assertIntegrity(observation, 'observationHash', 'preflight mode observation')
  assertPublicSafeV1(observation, 'preflight mode observation')
  assertSortedUnique(observation.capabilities, 'Preflight capabilities')
  if (observation.capabilityHash !== phase10HashV1(observation.capabilities)) {
    throw new Error('Preflight capabilityHash mismatch')
  }
  const processPayload = without(observation.browserProcess, 'evidenceHash')
  if (observation.browserProcess.evidenceHash !== phase10HashV1(processPayload)
    || !observation.browserProcess.processExitObserved
    || !observation.browserProcess.userDataDirectoryCreatedFresh
    || !observation.browserProcess.userDataDirectoryRemoved
    || observation.browserProcess.profileMode !== 'empty'
    || Date.parse(observation.browserProcess.stoppedAt) < Date.parse(observation.browserProcess.startedAt)) {
    throw new Error('Preflight mode lacks valid fresh-process evidence')
  }
  if (!observation.noAgent || !observation.emptyProfile || !observation.paused || !observation.passed) {
    throw new Error('Preflight mode must be a passing, paused, no-agent empty-profile run')
  }
  if (observation.mode === 'local' && (observation.catalogHash || observation.shareDescriptorHash)) {
    throw new Error('Local preflight observation cannot carry remote identities')
  }
  if (observation.mode === 'remote' && (!observation.catalogHash || observation.shareDescriptorHash)) {
    throw new Error('Remote preflight observation requires only a catalog identity')
  }
  if (observation.mode === 'share' && (!observation.catalogHash || !observation.shareDescriptorHash)) {
    throw new Error('Share preflight observation requires catalog and descriptor identities')
  }
  return true
}

function validateLedgerEventSemantics(entry) {
  if (entry.event === 'first-failure' && !entry.firstFailureHash) throw new Error('first-failure event requires firstFailureHash')
  if (entry.event === 'failure-classified' && (!entry.firstFailureHash || !entry.classification)) {
    throw new Error('failure-classified event requires failure and classification')
  }
  if (entry.event === 'generic-change-chosen'
    && (!entry.firstFailureHash || !entry.classification || !entry.chosenLayer || !entry.genericChangeCommit)) {
    throw new Error('generic-change-chosen event requires failure, classification, layer, and commit')
  }
  if (entry.event === 'case-consumed' && !entry.consumedCaseIdHash) throw new Error('case-consumed event requires a case identity hash')
  if (entry.event === 'replacement-selected' && !entry.replacementCaseManifestHash) {
    throw new Error('replacement-selected event requires a replacement manifest hash')
  }
  if (entry.event === 'regression-result' && entry.regressionEvidenceHashes.length === 0) {
    throw new Error('regression-result event requires evidence')
  }
  if (entry.event === 'attempt-retained' && !entry.attemptHash) throw new Error('attempt-retained event requires attemptHash')
}

export function validateDecisionLedgerV1(entries) {
  let previous = null
  let ledgerId = null
  for (const [index, entry] of entries.entries()) {
    if (entry?.schema !== 'egolens-decision-ledger-entry-v1') throw new Error(`Ledger entry ${index} has the wrong schema`)
    if (entry.sequence !== index || entry.previousEntryHash !== previous) throw new Error(`Ledger entry ${index} breaks the append-only chain`)
    if (ledgerId === null) ledgerId = entry.ledgerId
    if (entry.ledgerId !== ledgerId) throw new Error(`Ledger entry ${index} changes ledgerId`)
    assertIntegrity(entry, 'entryHash', `ledger entry ${index}`)
    assertPublicSafeV1(entry, `ledger entry ${index}`)
    validateLedgerEventSemantics(entry)
    previous = entry.entryHash
  }
  return { ledgerId, length: entries.length, ledgerHash: previous }
}

export function createDecisionLedgerEntryV1(entries, payload) {
  const chain = validateDecisionLedgerV1(entries)
  const entryPayload = {
    schema: 'egolens-decision-ledger-entry-v1',
    ledgerId: payload.ledgerId ?? chain.ledgerId,
    sequence: entries.length,
    previousEntryHash: chain.ledgerHash,
    event: payload.event,
    occurredAt: payload.occurredAt,
    sourceCaseManifestHash: payload.sourceCaseManifestHash ?? null,
    attemptHash: payload.attemptHash ?? null,
    firstFailureHash: payload.firstFailureHash ?? null,
    classification: payload.classification ?? null,
    chosenLayer: payload.chosenLayer ?? null,
    genericChangeCommit: payload.genericChangeCommit ?? null,
    consumedCaseIdHash: payload.consumedCaseIdHash ?? null,
    replacementCaseManifestHash: payload.replacementCaseManifestHash ?? null,
    regressionEvidenceHashes: payload.regressionEvidenceHashes ?? [],
    detailsHash: payload.detailsHash,
  }
  if (!entryPayload.ledgerId) throw new Error('First ledger entry requires ledgerId')
  const entry = { ...entryPayload, entryHash: phase10HashV1(entryPayload) }
  validateDecisionLedgerV1([...entries, entry])
  return entry
}

function validateModeEvidence(mode, dataset) {
  if (mode.sourceManifestHash !== dataset.sourceManifestHash
    || mode.recipeHash !== dataset.recipeHash
    || mode.formatFingerprint !== dataset.formatFingerprint
    || mode.operatorSetFingerprint !== dataset.operatorSetFingerprint) {
    throw new Error(`${dataset.datasetId}/${mode.mode}: identity drift`)
  }
  if (!mode.noAgent || !mode.passed) throw new Error(`${dataset.datasetId}/${mode.mode}: baseline proof must pass without an agent`)
  if (!mode.emptyProfile) {
    throw new Error(`${dataset.datasetId}/${mode.mode}: baseline proof must use an empty profile`)
  }
  if (mode.mode === 'local' && (mode.catalogHash || mode.shareDescriptorHash)) {
    throw new Error(`${dataset.datasetId}: local proof has remote/share state`)
  }
  if (mode.mode === 'remote' && (!mode.catalogHash || mode.shareDescriptorHash)) {
    throw new Error(`${dataset.datasetId}: remote proof has invalid catalog/share state`)
  }
  if (mode.mode === 'share' && (!mode.catalogHash || !mode.shareDescriptorHash || !mode.emptyProfile || !mode.paused)) {
    throw new Error(`${dataset.datasetId}: share proof is not a paused empty-profile restore`)
  }
}

export function validateDatasetBaselineEvidenceV1(dataset, candidateCommit) {
  if (dataset.candidateCommit !== candidateCommit) throw new Error(`${dataset.datasetId}: stale candidate commit`)
  if (dataset.local.mode !== 'local' || dataset.remote.mode !== 'remote' || dataset.share.mode !== 'share') {
    throw new Error(`${dataset.datasetId}: incomplete local/remote/share matrix`)
  }
  for (const mode of [dataset.local, dataset.remote, dataset.share]) validateModeEvidence(mode, dataset)
  if (new Set([dataset.local.browserRunHash, dataset.remote.browserRunHash, dataset.share.browserRunHash]).size !== 3) {
    throw new Error(`${dataset.datasetId}: preflight modes reused a browser process`)
  }
  for (const key of ['capabilityHash', 'structuralHash', 'numericHash', 'perceptualHash', 'presentationHash']) {
    if (dataset.local[key] !== dataset.remote[key] || dataset.local[key] !== dataset.share[key]) {
      throw new Error(`${dataset.datasetId}: ${key} parity failed`)
    }
  }
  if (dataset.remote.catalogHash !== dataset.share.catalogHash) throw new Error(`${dataset.datasetId}: catalog identity drift`)
  assertIntegrity(dataset, 'evidenceHash', `${dataset.datasetId} baseline evidence`)
}

export function validatePhase10BaselineFreezeSemanticsV1(freeze, expectedCommit) {
  if (freeze?.schema !== 'egolens-phase10-baseline-freeze-v1') throw new Error('Invalid Phase 10 baseline freeze schema')
  assertCommit(freeze.candidateCommit, 'candidateCommit')
  if (expectedCommit && freeze.candidateCommit !== expectedCommit) throw new Error('Baseline freeze is for a different commit')
  const datasetIds = freeze.datasets.map((dataset) => dataset.datasetId).sort()
  if (canonicalize(datasetIds) !== canonicalize([...PHASE10_SHIPPED_DATASETS].sort())) {
    throw new Error('Baseline freeze requires exact Waymo/nuScenes/Argoverse 2 coverage')
  }
  for (const dataset of freeze.datasets) validateDatasetBaselineEvidenceV1(dataset, freeze.candidateCommit)
  const browserRuns = freeze.datasets.flatMap((dataset) => [
    dataset.local.browserRunHash, dataset.remote.browserRunHash, dataset.share.browserRunHash,
  ])
  if (new Set(browserRuns).size !== browserRuns.length) {
    throw new Error('Baseline freeze reused a browser process across dataset modes')
  }
  const negativeIds = freeze.gates.negativeCases.map((entry) => entry.id).sort()
  if (canonicalize(negativeIds) !== canonicalize([...PHASE10_REQUIRED_NEGATIVE_CASES].sort())) {
    throw new Error('Baseline freeze negative coverage is incomplete or duplicated')
  }
  const gateValues = Object.entries(freeze.gates).filter(([key]) => key !== 'negativeCases' && key !== 'evidenceHarness')
  if (!freeze.allPassed || gateValues.some(([, gate]) => !gate.passed)
    || freeze.gates.negativeCases.some((entry) => !entry.passed)
    || !freeze.gates.evidenceHarness.passed || !freeze.gates.evidenceHarness.freshProcessSelfTest) {
    throw new Error('Baseline freeze contains a failing gate')
  }
  assertIntegrity(freeze, 'freezeHash', 'Phase 10 baseline freeze')
  assertPublicSafeV1(freeze, 'Phase 10 baseline freeze')
  return true
}
