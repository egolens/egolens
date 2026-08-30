#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalize, verifySignedReceipt } from './lib/oracle-receipts.mjs'

const argv = process.argv.slice(2)
const values = (name) => argv.flatMap((value, index) => value === `--${name}` ? [argv[index + 1]] : []).filter(Boolean)
const value = (name) => values(name).at(-1)
const receiptPaths = values('receipt')
const publicKeyPath = value('public-key')
const keyId = value('key-id')
const expectedCommit = value('expected-generator-commit')
const requirementsPath = value('requirements')
const outputPath = value('output')
if (receiptPaths.length === 0 || !publicKeyPath || !keyId || !expectedCommit || !requirementsPath) {
  throw new Error('Usage: --receipt <json> (repeat) --requirements <json> --public-key <pem> --key-id <id> --expected-generator-commit <sha> [--output <json>]')
}

const [publicKey, requirements] = await Promise.all([
  readFile(path.resolve(publicKeyPath), 'utf8'),
  readFile(path.resolve(requirementsPath), 'utf8').then(JSON.parse),
])
if (requirements.kind !== 'egolens-oracle-gate-requirements' || requirements.schemaVersion !== 1
  || !Array.isArray(requirements.targets)) {
  throw new Error('Invalid oracle gate requirements document.')
}
const requiredDatasets = ['argoverse2', 'nuscenes', 'waymo']
const targetKey = (target) => `${target.datasetId}\u0000${target.caseId}`
const requirementKeys = requirements.targets.map(targetKey)
const requirementDatasets = [...new Set(requirements.targets.map((target) => target.datasetId))].sort()
if (new Set(requirementKeys).size !== requirementKeys.length
  || JSON.stringify(requirementDatasets) !== JSON.stringify(requiredDatasets)
  || requirements.targets.some((target) => !target.datasetId || !target.caseId || !target.coverage)) {
  throw new Error('Requirements must contain unique target cases spanning waymo, nuscenes, and argoverse2.')
}
const requirementByTarget = new Map(requirements.targets.map((target) => [targetKey(target), target]))
const receipts = await Promise.all(receiptPaths.map(async (receiptPath) => ({
  path: path.resolve(receiptPath),
  receipt: JSON.parse(await readFile(path.resolve(receiptPath), 'utf8')),
})))
const checks = receipts.map(({ path: receiptPath, receipt }) => {
  const requiredChecks = ['integrity', 'target', 'coverage', 'structural', 'numeric', 'perceptual']
  const receiptChecks = Array.isArray(receipt.checks) ? receipt.checks : []
  const checkNames = new Set(receiptChecks.map((check) => check.name))
  const requirement = requirementByTarget.get(targetKey(receipt.target ?? {}))
  return {
    datasetId: receipt.target?.datasetId ?? null,
    caseId: receipt.target?.caseId ?? null,
    path: receiptPath,
    passed: verifySignedReceipt(receipt, publicKey, keyId)
      && receipt.passed === true
      && receipt.oracleGeneratorCommit === expectedCommit
      && requirement !== undefined
      && receipt.oracleCoverage !== undefined
      && canonicalize(receipt.oracleCoverage) === canonicalize(requirement.coverage)
      && receiptChecks.length === requiredChecks.length
      && receiptChecks.every((check) => check.passed === true)
      && requiredChecks.every((name) => checkNames.has(name)),
    receiptHash: receipt.receiptHash ?? null,
    oracleGeneratorCommit: receipt.oracleGeneratorCommit ?? null,
  }
})
const receiptTargetKeys = checks.map((check) => targetKey(check))
const report = {
  schemaVersion: 1,
  passed: checks.length === requirements.targets.length
    && new Set(receiptTargetKeys).size === receiptTargetKeys.length
    && receiptTargetKeys.every((key) => requirementByTarget.has(key))
    && checks.every((check) => check.passed),
  expectedGeneratorCommit: expectedCommit,
  signingKeyId: keyId,
  requirements: path.resolve(requirementsPath),
  checks,
}
const json = `${JSON.stringify(report, null, 2)}\n`
if (outputPath) await writeFile(path.resolve(outputPath), json, { flag: 'wx' })
process.stdout.write(json)
if (!report.passed) process.exitCode = 1
