#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeContentBlindPathV1,
  phase10HashV1,
  validateSourceCaseManifestSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

const MAX_ENTRIES = 50_000
const MAX_CATALOG_BYTES = 16 * 1024 * 1024

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

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function hashEntry(root, expected, chunkSize) {
  const relative = normalizeContentBlindPathV1(expected.path)
  const filename = path.resolve(root, ...relative.split('/'))
  const confinedRoot = `${path.resolve(root)}${path.sep}`
  if (filename !== path.resolve(root) && !filename.startsWith(confinedRoot)) {
    throw new Error(`Catalog entry escapes source root: ${relative}`)
  }
  const details = await lstat(filename)
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Catalog source is not a regular file: ${relative}`)
  if (details.size !== expected.size) throw new Error(`Catalog source size drift: ${relative}`)
  const handle = await open(filename, 'r')
  const full = createHash('sha256')
  const chunks = []
  try {
    for (let offset = 0; offset < expected.size; offset += chunkSize) {
      const length = Math.min(chunkSize, expected.size - offset)
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead !== length) throw new Error(`Catalog source short read: ${relative}`)
      full.update(buffer)
      chunks.push(digest(buffer))
    }
  } finally {
    await handle.close()
  }
  const sha256 = `sha256:${full.digest('hex')}`
  if (sha256 !== expected.sha256) throw new Error(`Catalog source digest drift: ${relative}`)
  return {
    path: relative,
    size: expected.size,
    sha256,
    chunks: { size: chunkSize, digests: chunks },
  }
}

const options = args(process.argv.slice(2))
for (const name of ['root', 'source-case', 'output', 'public-output']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
const chunkSize = Number(options['chunk-size'] ?? 1024 * 1024)
if (!Number.isSafeInteger(chunkSize) || chunkSize < 65_536 || chunkSize > 67_108_864) {
  throw new Error('--chunk-size must be an integer between 65536 and 67108864')
}
const root = path.resolve(options.root)
const rootDetails = await lstat(root)
if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
  throw new Error('--root must be a non-symlink directory')
}
const sourceCase = JSON.parse(await readFile(path.resolve(options['source-case']), 'utf8'))
await validatePhase10SchemaV1(sourceCase)
validateSourceCaseManifestSemanticsV1(sourceCase)
if (sourceCase.files.length > MAX_ENTRIES) throw new Error('Source catalog exceeds the entry limit')

const entries = []
const progressEvery = Math.max(1, Math.ceil(sourceCase.files.length / 100))
for (const [index, expected] of sourceCase.files.entries()) {
  entries.push(await hashEntry(root, expected, chunkSize))
  if ((index + 1) % progressEvery === 0 || index + 1 === sourceCase.files.length) {
    process.stderr.write(`[phase10-catalog] verified ${index + 1}/${sourceCase.files.length}\r`)
  }
}
process.stderr.write('\n')
const payload = { schema: 'egolens-source-catalog-v1', entries }
const catalog = { ...payload, catalogHash: phase10HashV1(payload) }
const serialized = `${JSON.stringify(catalog, null, 2)}\n`
if (Buffer.byteLength(serialized) > MAX_CATALOG_BYTES) throw new Error('Source catalog exceeds the byte limit')
await writeFile(path.resolve(options.output), serialized, { flag: 'wx', mode: 0o600 })
const summaryPayload = {
  schema: 'egolens-phase10-source-catalog-summary-v1',
  datasetId: sourceCase.release.datasetId,
  caseId: sourceCase.case.caseId,
  sourceCaseManifestHash: sourceCase.manifestHash,
  sourceManifestHash: sourceCase.sourceManifestHash,
  catalogHash: catalog.catalogHash,
  entryCount: entries.length,
  totalBytes: sourceCase.aggregate.totalBytes,
  transportChunkSize: chunkSize,
}
const summary = { ...summaryPayload, summaryHash: phase10HashV1(summaryPayload) }
await writeFile(path.resolve(options['public-output']), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
