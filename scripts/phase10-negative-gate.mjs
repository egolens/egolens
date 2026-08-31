#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PHASE10_REQUIRED_NEGATIVE_CASES,
  phase10HashV1,
} from './lib/phase10-evidence.mjs'
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
for (const name of ['vitest-report', 'expected-commit', 'output']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (!/^[0-9a-f]{40}$/u.test(options['expected-commit'])) throw new Error('--expected-commit must be a full Git SHA')
const report = JSON.parse(await readFile(path.resolve(options['vitest-report']), 'utf8'))
const assertions = (report.testResults ?? []).flatMap((result) => result.assertionResults ?? [])
const required = [...PHASE10_REQUIRED_NEGATIVE_CASES].sort()
const titles = assertions.map((assertion) => assertion.title).sort()
if (!report.success || report.numFailedTests !== 0 || report.numPassedTests !== required.length
  || JSON.stringify(titles) !== JSON.stringify(required)
  || assertions.some((assertion) => assertion.status !== 'passed'
    || assertion.ancestorTitles?.join('/') !== 'Phase 10 required negative gates')) {
  throw new Error('Vitest report does not prove the exact Phase 10 negative matrix')
}
const sourceBytes = await readFile(path.resolve('src/teachable/__tests__/phase10NegativeGate.test.ts'))
const sourceTestHash = `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`
const payload = {
  schema: 'egolens-phase10-negative-gate-report-v1',
  candidateCommit: options['expected-commit'],
  sourceTestHash,
  cases: assertions.map((assertion) => ({
    id: assertion.title,
    passed: true,
    evidenceHash: phase10HashV1({
      candidateCommit: options['expected-commit'],
      sourceTestHash,
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
