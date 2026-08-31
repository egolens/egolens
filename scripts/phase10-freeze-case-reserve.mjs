#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  phase10HashV1,
  validateCaseReserveManifestSemanticsV1,
  validateSourceCaseManifestSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function parseArgs(argv) {
  const values = { case: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const name = key.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${name}`)
    const value = argv[++index]
    if (name === 'case') values.case.push(value)
    else {
      if (values[name] !== undefined) throw new Error(`Duplicate --${name}`)
      values[name] = value
    }
  }
  return values
}

const options = parseArgs(process.argv.slice(2))
for (const name of ['rung', 'output']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (options.case.length < 4) throw new Error('At least four --case manifests are required')
const rung = Number(options.rung)
if (!Number.isSafeInteger(rung) || rung < 1 || rung > 4) throw new Error('--rung must be 1 through 4')

const protectedManifests = []
for (const filename of options.case) {
  const value = JSON.parse(await readFile(path.resolve(filename), 'utf8'))
  await validatePhase10SchemaV1(value)
  validateSourceCaseManifestSemanticsV1(value)
  protectedManifests.push(value)
}
const [first] = protectedManifests
for (const manifest of protectedManifests) {
  if (manifest.release.datasetId !== first.release.datasetId
    || manifest.release.releaseId !== first.release.releaseId
    || manifest.release.officialSourceUrl !== first.release.officialSourceUrl) {
    throw new Error('Every precommitted case must come from the same official release')
  }
}
protectedManifests.sort((left, right) => left.case.order - right.case.order)
const payload = {
  schema: 'egolens-case-reserve-manifest-v1',
  rung,
  datasetId: first.release.datasetId,
  releaseId: first.release.releaseId,
  officialSourceUrl: first.release.officialSourceUrl,
  frozenBeforeInspection: true,
  cases: protectedManifests.map((manifest) => ({
    order: manifest.case.order,
    role: manifest.case.role,
    reserveFor: manifest.case.reserveFor,
    caseId: manifest.case.caseId,
    sourceCaseManifestHash: manifest.manifestHash,
    sourceManifestHash: manifest.sourceManifestHash,
    fileCount: manifest.aggregate.fileCount,
    totalBytes: manifest.aggregate.totalBytes,
  })),
}
const frozen = { ...payload, manifestHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(frozen)
validateCaseReserveManifestSemanticsV1(frozen)
const output = path.resolve(String(options.output))
await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(frozen, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify({
  datasetId: frozen.datasetId,
  releaseId: frozen.releaseId,
  rung: frozen.rung,
  caseCount: frozen.cases.length,
  manifestHash: frozen.manifestHash,
}, null, 2)}\n`)
