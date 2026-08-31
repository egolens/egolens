#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyAmnesiaAttestation } from './lib/amnesia-evidence.mjs'
import { canonicalize, sha256Canonical, verifySignedReceipt } from './lib/oracle-receipts.mjs'

const argv = process.argv.slice(2)
const values = (name) => argv.flatMap((entry, index) => entry === `--${name}` ? [argv[index + 1]] : []).filter(Boolean)
const value = (name) => values(name).at(-1)
const receiptPaths = values('receipt')
const options = {
  requirements: value('requirements'),
  attestation: value('attestation'),
  publicKey: value('public-key'),
  keyId: value('key-id'),
  expectedGeneratorCommit: value('expected-generator-commit'),
  expectedCandidateCommit: value('expected-candidate-commit'),
  output: value('output'),
}
if (receiptPaths.length === 0 || Object.entries(options).some(([key, entry]) => key !== 'output' && !entry)) {
  throw new Error('Usage: --receipt <json> (repeat) --requirements <json> --attestation <json> --public-key <pem> --key-id <id> --expected-generator-commit <sha> --expected-candidate-commit <sha> [--output <json>]')
}
const [publicKey, requirements, attestation] = await Promise.all([
  readFile(path.resolve(options.publicKey), 'utf8'),
  readFile(path.resolve(options.requirements), 'utf8').then(JSON.parse),
  readFile(path.resolve(options.attestation), 'utf8').then(JSON.parse),
])
if (requirements.kind !== 'egolens-adapter-amnesia-gate-requirements'
  || requirements.schemaVersion !== 1 || !Array.isArray(requirements.targets)) {
  throw new Error('Invalid Adapter Amnesia requirements document.')
}
if (!verifyAmnesiaAttestation(attestation, options.expectedCandidateCommit)) {
  throw new Error('Invalid Adapter Amnesia authoring attestation.')
}
const requiredDatasets = ['argoverse2', 'nuscenes', 'waymo']
const targetKey = (target) => `${target.datasetId}\u0000${target.caseId}`
const requirementKeys = requirements.targets.map(targetKey)
const datasets = [...new Set(requirements.targets.map((target) => target.datasetId))].sort()
if (new Set(requirementKeys).size !== requirementKeys.length
  || canonicalize(datasets) !== canonicalize(requiredDatasets)
  || requirements.targets.some((target) => !target.coverage || !/^sha256:[0-9a-f]{64}$/u.test(target.recipeHash))) {
  throw new Error('Requirements must contain unique reviewed targets and recipe hashes for all three datasets.')
}
const requirementByTarget = new Map(requirements.targets.map((target) => [targetKey(target), target]))
const receipts = await Promise.all(receiptPaths.map(async (receiptPath) => ({
  path: path.resolve(receiptPath),
  receipt: JSON.parse(await readFile(path.resolve(receiptPath), 'utf8')),
})))
const checks = receipts.map(({ receipt }) => {
  const requiredChecks = ['integrity', 'target', 'coverage', 'structural', 'numeric', 'perceptual']
  const receiptChecks = Array.isArray(receipt.checks) ? receipt.checks : []
  const requirement = requirementByTarget.get(targetKey(receipt.target ?? {}))
  const expectedRuntimeId = requirement
    ? `egolens-amnesia-${options.expectedCandidateCommit}-${requirement.recipeHash}`
    : null
  return {
    datasetId: receipt.target?.datasetId ?? null,
    caseId: receipt.target?.caseId ?? null,
    passed: verifySignedReceipt(receipt, publicKey, options.keyId)
      && receipt.passed === true
      && receipt.oracleGeneratorCommit === options.expectedGeneratorCommit
      && receipt.candidateGeneratorCommit === options.expectedCandidateCommit
      && receipt.candidateRuntimeId === expectedRuntimeId
      && receipt.candidateRecipeHash === requirement?.recipeHash
      && receipt.amnesiaAttestationHash === attestation.attestationHash
      && canonicalize(receipt.oracleCoverage) === canonicalize(requirement?.coverage)
      && receiptChecks.length === requiredChecks.length
      && receiptChecks.every((check) => check.passed === true)
      && requiredChecks.every((name) => receiptChecks.some((check) => check.name === name)),
    receiptHash: receipt.receiptHash ?? null,
    candidateRecipeHash: receipt.candidateRecipeHash ?? null,
  }
})
const receiptTargetKeys = checks.map(targetKey)
const report = {
  kind: 'egolens-adapter-amnesia-gate-report',
  schemaVersion: 1,
  passed: checks.length === requirements.targets.length
    && new Set(receiptTargetKeys).size === receiptTargetKeys.length
    && receiptTargetKeys.every((key) => requirementByTarget.has(key))
    && checks.every((check) => check.passed),
  expectedGeneratorCommit: options.expectedGeneratorCommit,
  expectedCandidateCommit: options.expectedCandidateCommit,
  amnesiaAttestationHash: attestation.attestationHash,
  signingKeyId: options.keyId,
  requirementsHash: sha256Canonical(requirements),
  checks,
}
const json = `${JSON.stringify(report, null, 2)}\n`
if (options.output) await writeFile(path.resolve(options.output), json, { flag: 'wx' })
process.stdout.write(json)
if (!report.passed) process.exitCode = 1
