#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { phase10HashV1 } from './lib/phase10-evidence.mjs'
import { loadPhase10SchemasV1, validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

const options = args(process.argv.slice(2))
for (const name of ['tap-report', 'expected-commit', 'output']) if (!options[name]) throw new Error(`Missing --${name}`)
if (!/^[0-9a-f]{40}$/u.test(options['expected-commit'])) throw new Error('--expected-commit must be a full Git SHA')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
if (head !== options['expected-commit'] || dirty) throw new Error('Harness gate requires a clean exact candidate checkout')
const tap = await readFile(path.resolve(options['tap-report']), 'utf8')
const metric = (name) => Number(new RegExp(`^# ${name} ([0-9]+)$`, 'mu').exec(tap)?.[1] ?? NaN)
const tests = metric('tests')
const pass = metric('pass')
const fail = metric('fail')
if (!tap.startsWith('TAP version 13') || !Number.isSafeInteger(tests) || tests < 6 || pass !== tests || fail !== 0
  || !tap.includes('fresh-process harness observes distinct process exits and removes every empty profile')) {
  throw new Error('TAP report does not prove the complete Phase 10 evidence harness')
}
const { schemaHashes } = await loadPhase10SchemasV1()
const payload = {
  schema: 'egolens-phase10-evidence-harness-gate-report-v1',
  candidateCommit: options['expected-commit'],
  tests,
  schemaHashes,
  freshProcessSelfTest: true,
  tapHash: phase10HashV1(tap),
  passed: true,
}
const result = { ...payload, reportHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(result)
await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
