#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PHASE10_REQUIRED_NEGATIVE_CASES,
  loadPhase10ProductionTrustV1,
  phase10HashV1,
  phase10VerifierBindingV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'
import { runPhase10ReviewedGateV1 } from './lib/phase10-test-gate.mjs'

function args(argv) {
  const allowed = new Set(['candidate-repository', 'expected-commit', 'output', 'vitest-report'])
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
for (const name of ['candidate-repository', 'expected-commit', 'output']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (!/^[0-9a-f]{40}$/u.test(options['expected-commit'])) throw new Error('--expected-commit must be a full Git SHA')
if (options['vitest-report']) throw new Error('Caller-supplied Vitest reports are forbidden')
const trust = await loadPhase10ProductionTrustV1()
const verifierBinding = phase10VerifierBindingV1(trust)
const { resultBytes, execution, testSourceHash: sourceTestHash } = await runPhase10ReviewedGateV1({
  candidateRepository: options['candidate-repository'],
  expectedCommit: options['expected-commit'],
  expectedVerifierDependencyClosureHash: trust.verifierDependencyClosureHash,
  expectedVerifierNodeRuntimeHash: trust.verifierNodeRuntimeHash,
  kind: 'negative',
})
const report = JSON.parse(resultBytes.toString('utf8'))
const assertions = (report.testResults ?? []).flatMap((result) => result.assertionResults ?? [])
const required = [...PHASE10_REQUIRED_NEGATIVE_CASES].sort()
const titles = assertions.map((assertion) => assertion.title).sort()
if (!report.success || report.numFailedTests !== 0 || report.numPassedTests !== required.length
  || JSON.stringify(titles) !== JSON.stringify(required)
  || assertions.some((assertion) => assertion.status !== 'passed'
    || assertion.ancestorTitles?.join('/') !== 'Phase 10 required negative gates')) {
  throw new Error('Vitest report does not prove the exact Phase 10 negative matrix')
}
const payload = {
  schema: 'egolens-phase10-negative-gate-report-v1',
  candidateCommit: options['expected-commit'],
  verifierBinding,
  sourceTestHash,
  execution,
  cases: assertions.map((assertion) => ({
    id: assertion.title,
    passed: true,
    evidenceHash: phase10HashV1({
      candidateCommit: options['expected-commit'],
      sourceTestHash,
      freshRunId: execution.freshRunId,
      resultHash: execution.resultHash,
      id: assertion.title,
      suite: assertion.ancestorTitles,
      status: assertion.status,
    }),
  })).sort((left, right) => left.id.localeCompare(right.id)),
  passed: true,
}
const result = { ...payload, reportHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(result)
await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
