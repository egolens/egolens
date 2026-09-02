#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  loadPhase10ProductionTrustV1,
  phase10HashV1,
  phase10VerifierBindingV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'
import { runPhase10ReviewedGateV1 } from './lib/phase10-test-gate.mjs'

function args(argv) {
  const allowed = new Set(['candidate-repository', 'expected-commit', 'output', 'vitest-report', 'minimum-tests'])
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
if (options['vitest-report'] || options['minimum-tests']) {
  throw new Error('Caller-supplied regression reports and thresholds are forbidden')
}
const trust = await loadPhase10ProductionTrustV1()
const verifierBinding = phase10VerifierBindingV1(trust)
const { resultBytes, execution } = await runPhase10ReviewedGateV1({
  candidateRepository: options['candidate-repository'],
  expectedCommit: options['expected-commit'],
  expectedVerifierDependencyClosureHash: trust.verifierDependencyClosureHash,
  expectedVerifierNodeRuntimeHash: trust.verifierNodeRuntimeHash,
  kind: 'regression',
})
const report = JSON.parse(resultBytes.toString('utf8'))
const assertions = (report.testResults ?? []).flatMap((suite) => (suite.assertionResults ?? []).map((assertion) => ({
  suite: path.basename(suite.name ?? ''),
  title: assertion.fullName ?? assertion.title,
  status: assertion.status,
})))
const minimumTests = 1_000
if (!report.success || report.numFailedTests !== 0 || report.numPendingTests !== 0
  || report.numPassedTests !== assertions.length || assertions.length < minimumTests
  || assertions.some((assertion) => assertion.status !== 'passed')) {
  const notPassed = assertions.filter((assertion) => assertion.status !== 'passed').slice(0, 25)
  throw new Error(`Vitest report does not prove the complete passing regression suite: ${JSON.stringify({
    success: report.success,
    numTotalTests: report.numTotalTests,
    numPassedTests: report.numPassedTests,
    numFailedTests: report.numFailedTests,
    numPendingTests: report.numPendingTests,
    numTodoTests: report.numTodoTests,
    assertionCount: assertions.length,
    minimumTests,
    notPassed,
  })}`)
}
assertions.sort((left, right) => `${left.suite}\0${left.title}`.localeCompare(`${right.suite}\0${right.title}`, 'en'))
const payload = {
  schema: 'egolens-phase10-regression-gate-report-v1',
  candidateCommit: options['expected-commit'],
  verifierBinding,
  execution,
  testFiles: report.numPassedTestSuites,
  tests: assertions.length,
  suiteHash: phase10HashV1(assertions),
  passed: true,
}
const result = { ...payload, reportHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(result)
await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
