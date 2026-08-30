#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { judgeBundle, signReceipt } from './lib/oracle-receipts.mjs'

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
for (const required of ['oracle', 'candidate', 'private-key', 'key-id', 'judge-version', 'expected-candidate-commit', 'output']) {
  if (!options[required]) throw new Error(`Missing --${required}`)
}

const [oracle, candidate, privateKey] = await Promise.all([
  readFile(path.resolve(String(options.oracle)), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options.candidate)), 'utf8').then(JSON.parse),
  readFile(path.resolve(String(options['private-key'])), 'utf8'),
])
if (candidate.provenance?.generatorCommit !== String(options['expected-candidate-commit'])) {
  throw new Error('Candidate artifact was not captured from the expected commit.')
}
const receipt = judgeBundle(oracle, candidate, {
  judgeVersion: String(options['judge-version']),
})
const signed = signReceipt(receipt, privateKey, String(options['key-id']))
await writeFile(path.resolve(String(options.output)), `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx' })
process.stdout.write(`${JSON.stringify({
  target: signed.target,
  passed: signed.passed,
  receiptHash: signed.receiptHash,
  signingKeyId: signed.signingKeyId,
  candidateGeneratorCommit: signed.candidateGeneratorCommit,
}, null, 2)}\n`)
if (!signed.passed) process.exitCode = 1
