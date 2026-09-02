#!/usr/bin/env node

import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPhase10VerifierTrustManifestV1 } from './lib/phase10-evidence.mjs'

function parseArgs(argv) {
  const allowed = new Set(['review-id', 'approved-at', 'expected-commit', 'output'])
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!allowed.has(name) || result[name] !== undefined) throw new Error(`Invalid option: --${name}`)
    result[name] = argv[++index]
  }
  return result
}

const options = parseArgs(process.argv.slice(2))
for (const name of ['review-id', 'approved-at', 'expected-commit', 'output']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (!path.isAbsolute(options.output)) throw new Error('--output must be an absolute operator-controlled path')
const requestedOutput = path.resolve(options.output)
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let outputParent
const requestedParent = path.dirname(requestedOutput)
try { outputParent = await realpath(requestedParent) } catch { throw new Error('Trust manifest parent must already exist') }
const parentInfo = await lstat(requestedParent)
if (outputParent !== requestedParent || parentInfo.isSymbolicLink() || !parentInfo.isDirectory()
  || parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o077) !== 0) {
  throw new Error('Trust manifest parent must be a canonical owner-only operator directory')
}
if (outputParent === toolRoot || outputParent.startsWith(`${toolRoot}${path.sep}`)) {
  throw new Error('Trust manifest must be stored outside the reviewed verifier checkout')
}
const manifest = await createPhase10VerifierTrustManifestV1({
  reviewId: options['review-id'],
  approvedAt: options['approved-at'],
  expectedCommit: options['expected-commit'],
})
const output = path.join(outputParent, path.basename(requestedOutput))
const handle = await open(output, 'wx', 0o600)
try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`) } finally { await handle.close() }
process.stdout.write(`${JSON.stringify({
  schema: manifest.schema,
  verifierCommit: manifest.verifierCommit,
  verifierClosureHash: manifest.verifierClosureHash,
  verifierDependencyClosureHash: manifest.verifierDependencyClosureHash,
  verifierNodeRuntimeHash: manifest.verifierNodeRuntimeHash,
  manifestHash: manifest.manifestHash,
  operatorPinEnvironment: 'PHASE10_EXPECTED_VERIFIER_TRUST_MANIFEST_HASH',
}, null, 2)}\n`)
