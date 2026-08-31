import { createHash } from 'node:crypto'
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
  if (!attestation || attestation.kind !== 'egolens-adapter-amnesia-attestation'
    || attestation.schemaVersion !== 1) return false
  if (!/^[0-9a-f]{40}$/u.test(attestation.candidateCommit)
    || attestation.candidateCommit !== expectedCommit
    || attestation.authoringRuntimeId !== 'egolens-adapter-amnesia-author-v1') return false
  if (attestation.networkEgress !== false || attestation.interactiveJudgeAccess !== false) return false
  if (canonicalize([...(attestation.publicTools ?? [])].sort()) !== canonicalize([...AMNESIA_PUBLIC_TOOLS].sort())) return false
  if (canonicalize([...(attestation.deniedResources ?? [])].sort()) !== canonicalize([...AMNESIA_DENIED_RESOURCES].sort())) return false
  if (canonicalize(attestation.mounts) !== canonicalize([
    { name: 'application', access: 'read-only', contents: 'amnesia-author-browser-build' },
    { name: 'dataset', access: 'read-only', contents: 'held-out-source-case' },
    { name: 'candidate-output', access: 'write-only', contents: 'recipe-and-conformance-artifacts' },
  ])) return false
  const candidates = attestation.candidates ?? []
  if (candidates.length !== 3
    || canonicalize(candidates.map((candidate) => candidate.datasetId).sort())
      !== canonicalize(['argoverse2', 'nuscenes', 'waymo'])
    || candidates.some((candidate) => candidate.authoredBy !== 'codex'
      || !/^sha256:[0-9a-f]{64}$/u.test(candidate.recipeHash))) return false
  return sha256Canonical(attestationPayload(attestation)) === attestation.attestationHash
}
