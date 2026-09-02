#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  loadPhase10ProductionTrustV1,
  phase10HashV1,
  phase10VerifierBindingV1,
} from './lib/phase10-evidence.mjs'
import { loadPhase10SchemasV1, validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'
import { runPhase10ReviewedGateV1 } from './lib/phase10-test-gate.mjs'

function args(argv) {
  const allowed = new Set(['candidate-repository', 'expected-commit', 'output', 'tap-report'])
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

const options = args(process.argv.slice(2))
for (const name of ['candidate-repository', 'expected-commit', 'output']) if (!options[name]) throw new Error(`Missing --${name}`)
if (!/^[0-9a-f]{40}$/u.test(options['expected-commit'])) throw new Error('--expected-commit must be a full Git SHA')
if (options['tap-report']) throw new Error('Caller-supplied TAP reports are forbidden')
const trust = await loadPhase10ProductionTrustV1()
const verifierBinding = phase10VerifierBindingV1(trust)
const { resultBytes, execution } = await runPhase10ReviewedGateV1({
  candidateRepository: options['candidate-repository'],
  expectedCommit: options['expected-commit'],
  expectedVerifierDependencyClosureHash: trust.verifierDependencyClosureHash,
  expectedVerifierNodeRuntimeHash: trust.verifierNodeRuntimeHash,
  kind: 'harness',
})
const tap = resultBytes.toString('utf8')
const metric = (name) => Number(new RegExp(`^# ${name} ([0-9]+)$`, 'mu').exec(tap)?.[1] ?? NaN)
const tests = metric('tests')
const pass = metric('pass')
const fail = metric('fail')
const skipped = metric('skipped')
const cancelled = metric('cancelled')
const todo = metric('todo')
// The harness runs inside a deny-default Seatbelt profile, and macOS refuses to
// apply a second deny-default profile from an already sandboxed process. The
// one test that would do so (the nested negative-gate execution) is skipped
// with an exact reason; the negative gate is executed as its own outer gate.
const NESTED_GATE_SKIP = /^ok \d+ - negative gate executes the exact reviewed matrix and rejects caller-supplied reports # SKIP nested deny-default Seatbelt profiles are not permitted; the negative gate runs as its own outer gate$/mu
const nestedNegativeGateSkipped = NESTED_GATE_SKIP.test(tap)
if (!tap.startsWith('TAP version 13') || !Number.isSafeInteger(tests) || tests < 6
  || fail !== 0 || cancelled !== 0 || todo !== 0
  || skipped !== (nestedNegativeGateSkipped ? 1 : 0)
  || pass + skipped !== tests
  || !tap.includes('fresh-process harness observes distinct process exits and removes every empty profile')) {
  throw new Error('TAP report does not prove the complete Phase 10 evidence harness')
}
const { schemaHashes } = await loadPhase10SchemasV1()
const payload = {
  schema: 'egolens-phase10-evidence-harness-gate-report-v1',
  candidateCommit: options['expected-commit'],
  verifierBinding,
  execution,
  tests,
  nestedNegativeGateSkipped,
  schemaHashes,
  freshProcessSelfTest: true,
  tapHash: phase10HashV1(tap),
  passed: true,
}
const result = { ...payload, reportHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(result)
await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
