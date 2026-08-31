#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { judgeBundle, sha256Canonical, signReceipt } from './lib/oracle-receipts.mjs'
import { verifyAmnesiaAttestation } from './lib/amnesia-evidence.mjs'

function argumentsByName(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const next = argv[index + 1]
    result[key.slice(2)] = next && !next.startsWith('--') ? argv[++index] : true
  }
  return result
}

const options = argumentsByName(process.argv.slice(2))
for (const required of ['oracle', 'candidate', 'attestation', 'private-key', 'key-id', 'judge-version', 'expected-candidate-commit', 'output', 'trusted-report']) {
  if (!options[required]) throw new Error(`Missing --${required}`)
}
const [oracle, candidate, attestation, privateKey] = await Promise.all([
  readFile(path.resolve(String(options.oracle)), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options.candidate)), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options.attestation)), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options['private-key'])), 'utf8'),
])
const expectedCommit = String(options['expected-candidate-commit'])
if (!verifyAmnesiaAttestation(attestation, expectedCommit)) throw new Error('Invalid Adapter Amnesia attestation.')
if (candidate.provenance?.generatorCommit !== expectedCommit) throw new Error('Candidate artifact was not captured from the expected commit.')
const authored = attestation.candidates.find((entry) => entry.datasetId === candidate.target?.datasetId)
if (!authored || candidate.provenance.runtimeId !== `egolens-amnesia-${expectedCommit}-${authored.recipeHash}`) {
  throw new Error('Candidate artifact was not produced by the attested Adapter Amnesia recipe runtime.')
}
const judged = judgeBundle(oracle, candidate, {
  judgeVersion: String(options['judge-version']),
})
const { receiptHash: _oldHash, ...judgedPayload } = judged
const receipt = {
  ...judgedPayload,
  candidateRecipeHash: authored.recipeHash,
  amnesiaAttestationHash: attestation.attestationHash,
}
const signed = signReceipt({ ...receipt, receiptHash: sha256Canonical(receipt) }, privateKey, String(options['key-id']))
await Promise.all([
  writeFile(path.resolve(String(options.output)), `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx' }),
  writeFile(path.resolve(String(options['trusted-report'])), `${JSON.stringify({
    kind: 'egolens-adapter-amnesia-trusted-report',
    schemaVersion: 1,
    target: candidate.target,
    coverage: candidate.coverage,
    attestationHash: attestation.attestationHash,
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
  candidateGeneratorCommit: signed.candidateGeneratorCommit,
  candidateRecipeHash: signed.candidateRecipeHash,
  amnesiaAttestationHash: signed.amnesiaAttestationHash,
}, null, 2)}\n`)
if (!signed.passed) process.exitCode = 1

