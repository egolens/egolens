#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { phase10HashV1 } from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

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
for (const name of ['vitest-report', 'expected-commit', 'output']) if (!options[name]) throw new Error(`Missing --${name}`)
if (!/^[0-9a-f]{40}$/u.test(options['expected-commit'])) throw new Error('--expected-commit must be a full Git SHA')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
if (head !== options['expected-commit'] || dirty) throw new Error('Regression gate requires a clean exact candidate checkout')
const report = JSON.parse(await readFile(path.resolve(options['vitest-report']), 'utf8'))
const assertions = (report.testResults ?? []).flatMap((suite) => (suite.assertionResults ?? []).map((assertion) => ({
  suite: path.basename(suite.name ?? ''),
  title: assertion.fullName ?? assertion.title,
  status: assertion.status,
})))
const minimumTests = Number(options['minimum-tests'] ?? 1_000)
if (!Number.isSafeInteger(minimumTests) || minimumTests < 1) throw new Error('--minimum-tests must be a positive integer')
if (!report.success || report.numFailedTests !== 0 || report.numPendingTests !== 0
  || report.numPassedTests !== assertions.length || assertions.length < minimumTests
  || assertions.some((assertion) => assertion.status !== 'passed')) {
  throw new Error('Vitest report does not prove the complete passing regression suite')
}
assertions.sort((left, right) => `${left.suite}\0${left.title}`.localeCompare(`${right.suite}\0${right.title}`, 'en'))
const payload = {
  schema: 'egolens-phase10-regression-gate-report-v1',
  candidateCommit: options['expected-commit'],
  testFiles: report.numPassedTestSuites,
  tests: assertions.length,
  suiteHash: phase10HashV1(assertions),
  passed: true,
}
const result = { ...payload, reportHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(result)
await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
