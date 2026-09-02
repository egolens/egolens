#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalize, judgeBundle, sha256Canonical, signReceipt } from './lib/oracle-receipts.mjs'
import {
  assertPhase9JudgeToolCheckout,
  assertPhase9JudgeVersion,
  verifyAmnesiaBoundaryBinding,
} from './lib/amnesia-evidence.mjs'
import { verifyBoundaryCaseArtifact } from './lib/phase9-counted-author-boundary.mjs'

function argumentsByName(argv, allowed, flags = new Set()) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!allowed.has(name) || result[name] !== undefined) throw new Error(`Invalid option: --${name}`)
    if (flags.has(name)) {
      result[name] = true
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${name}`)
    result[name] = argv[++index]
  }
  return result
}

const REQUIRED_OPTIONS = Object.freeze([
  'oracle', 'candidate', 'attestation', 'boundary-report', 'private-key', 'key-id',
  'boundary-case', 'judge-version', 'expected-candidate-commit', 'expected-judge-tool-commit',
  'output', 'trusted-report',
])
const options = argumentsByName(process.argv.slice(2), new Set(REQUIRED_OPTIONS))
for (const required of REQUIRED_OPTIONS) {
  if (!options[required]) throw new Error(`Missing --${required}`)
}
// The judge binds its own clean checkout into every signed receipt. A dirty
// checkout, a checkout other than the workflow pin, or a non-reviewed version
// string fails before any protected input is read.
const judgeToolCommit = assertPhase9JudgeToolCheckout(String(options['expected-judge-tool-commit']))
const judgeVersion = assertPhase9JudgeVersion(String(options['judge-version']))
const [oracle, candidate, attestation, boundaryReport, boundaryCaseArtifact, privateKey] = await Promise.all([
  readFile(path.resolve(String(options.oracle)), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options.candidate)), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options.attestation)), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options['boundary-report'])), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options['boundary-case'])), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options['private-key'])), 'utf8'),
])
const expectedCommit = String(options['expected-candidate-commit'])
if (!verifyAmnesiaBoundaryBinding(attestation, boundaryReport, expectedCommit)) {
  throw new Error('Invalid Adapter Amnesia attestation or protected boundary report.')
}
if (candidate.provenance?.generatorCommit !== expectedCommit) throw new Error('Candidate artifact was not captured from the expected commit.')
const authored = attestation.candidates.find((entry) => entry.datasetId === candidate.target?.datasetId)
const boundaryCase = boundaryReport.cases.find((entry) => entry.datasetId === candidate.target?.datasetId)
if (!authored || !boundaryCase
  || !verifyBoundaryCaseArtifact(boundaryCaseArtifact, expectedCommit)
  || canonicalize(boundaryCaseArtifact.boundaryCase) !== canonicalize(boundaryCase)
  || boundaryCaseArtifact.boundaryCase.sourceCommit !== expectedCommit
  || boundaryCaseArtifact.boundaryCase.applicationBuildHash !== boundaryCase?.applicationBuildHash
  || boundaryCaseArtifact.boundaryCase.recipeHash !== authored?.recipeHash) {
  throw new Error('Protected boundary-case artifact does not prove this exact counted author run.')
}
if (candidate.provenance.runtimeId !== `egolens-amnesia-${expectedCommit}-${authored.recipeHash}`) {
  throw new Error('Candidate artifact was not produced by the attested Adapter Amnesia recipe runtime.')
}
if (boundaryCase?.caseId !== authored.caseId || boundaryCase.recipeHash !== authored.recipeHash
  || boundaryCase.sourceFingerprint !== candidate.provenance.sourceFingerprint) {
  throw new Error('Candidate artifact is not bound to the counted author source and recipe export.')
}
const judged = judgeBundle(oracle, candidate, { judgeVersion })
const { receiptHash: _oldHash, ...judgedPayload } = judged
const receipt = {
  ...judgedPayload,
  judgeToolCommit,
  candidateRecipeHash: authored.recipeHash,
  amnesiaAttestationHash: attestation.attestationHash,
  amnesiaBoundaryReportHash: boundaryReport.reportHash,
  amnesiaBoundaryCaseArtifactHash: boundaryCaseArtifact.artifactHash,
  amnesiaBoundarySourceMatched: true,
}
const signed = signReceipt({ ...receipt, receiptHash: sha256Canonical(receipt) }, privateKey, String(options['key-id']))
await Promise.all([
  writeFile(path.resolve(String(options.output)), `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx' }),
  writeFile(path.resolve(String(options['trusted-report'])), `${JSON.stringify({
    kind: 'egolens-adapter-amnesia-trusted-report',
    schemaVersion: 1,
    judgeVersion,
    judgeToolCommit,
    target: candidate.target,
    coverage: candidate.coverage,
    attestationHash: attestation.attestationHash,
    boundaryReportHash: boundaryReport.reportHash,
    boundaryCaseArtifactHash: boundaryCaseArtifact.artifactHash,
    boundarySourceMatched: true,
    candidateRecipeHash: authored.recipeHash,
    candidateArtifactHash: candidate.artifactHash,
    oracleBundleHash: oracle.bundleHash,
    checks: signed.checks,
    passed: signed.passed,
  }, null, 2)}\n`, { flag: 'wx' }),
])
process.stdout.write(`${JSON.stringify({
  target: signed.target,
  passed: signed.passed,
  receiptHash: signed.receiptHash,
  signingKeyId: signed.signingKeyId,
  judgeVersion: signed.judgeVersion,
  judgeToolCommit: signed.judgeToolCommit,
  candidateGeneratorCommit: signed.candidateGeneratorCommit,
  candidateRecipeHash: signed.candidateRecipeHash,
  amnesiaAttestationHash: signed.amnesiaAttestationHash,
  amnesiaBoundaryCaseArtifactHash: signed.amnesiaBoundaryCaseArtifactHash,
}, null, 2)}\n`)
if (!signed.passed) process.exitCode = 1
