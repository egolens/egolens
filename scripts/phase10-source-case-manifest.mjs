#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeContentBlindPathV1,
  loadPhase10ProductionTrustV1,
  phase10HashV1,
  phase10VerifierBindingV1,
  sourceManifestHashFromFilesV1,
  validateSourceCaseManifestSemanticsV1,
} from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const name = key.slice(2)
    const next = argv[index + 1]
    const value = next && !next.startsWith('--') ? argv[++index] : true
    if (name === 'capability') {
      values.capability ??= []
      values.capability.push(value)
    } else {
      if (values[name] !== undefined) throw new Error(`Duplicate --${name}`)
      values[name] = value
    }
  }
  return values
}

async function digestFile(filename) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filename)) digest.update(chunk)
  return `sha256:${digest.digest('hex')}`
}

async function enumerate(root) {
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink()) throw new Error('The selected source root cannot be a symbolic link')
  if (rootStat.isFile()) {
    return [{ absolute: root, path: normalizeContentBlindPathV1(path.basename(root)), size: rootStat.size }]
  }
  if (!rootStat.isDirectory()) throw new Error('The selected source must be a regular file or directory')
  const files = []
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relative = normalizeContentBlindPathV1(prefix ? `${prefix}/${entry.name}` : entry.name)
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in a counted source: ${relative}`)
      if (entry.isDirectory()) await visit(absolute, relative)
      else if (entry.isFile()) {
        const details = await lstat(absolute)
        files.push({ absolute, path: relative, size: details.size })
      } else {
        throw new Error(`Non-regular source entry is forbidden: ${relative}`)
      }
    }
  }
  await visit(root, '')
  return files
}

const options = parseArgs(process.argv.slice(2))
for (const name of [
  'root', 'dataset-id', 'release-id', 'official-source-url', 'case-id', 'role',
  'order', 'original-form', 'output', 'public-output',
]) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (!Array.isArray(options.capability) || options.capability.length === 0) {
  throw new Error('At least one --capability is required')
}
const order = Number(options.order)
if (!Number.isSafeInteger(order) || order < 0) throw new Error('--order must be a non-negative integer')
const archiveChecksum = options['archive-checksum']
  ? (() => {
      const match = /^(md5|sha1|sha256|sha512):([0-9a-f]+)$/u.exec(String(options['archive-checksum']))
      if (!match) throw new Error('--archive-checksum must be algorithm:lowercase-hex')
      return { algorithm: match[1], value: match[2] }
    })()
  : null
const entries = await enumerate(path.resolve(String(options.root)))
if (entries.length === 0) throw new Error('A counted source case cannot be empty')

const files = []
let totalBytes = 0
const progressEvery = Math.max(1, Math.ceil(entries.length / 100))
for (const [index, entry] of entries.entries()) {
  const sha256 = await digestFile(entry.absolute)
  files.push({ path: entry.path, size: entry.size, sha256 })
  totalBytes += entry.size
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Source byte total exceeds safe integer range')
  if ((index + 1) % progressEvery === 0 || index + 1 === entries.length) {
    process.stderr.write(`[phase10-manifest] hashed ${index + 1}/${entries.length}\r`)
  }
}
process.stderr.write('\n')
const verifierBinding = phase10VerifierBindingV1(await loadPhase10ProductionTrustV1())
files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
const payload = {
  schema: 'egolens-source-case-manifest-v1',
  verifierBinding,
  release: {
    datasetId: String(options['dataset-id']),
    releaseId: String(options['release-id']),
    officialSourceUrl: String(options['official-source-url']),
    officialArchiveChecksum: archiveChecksum,
  },
  case: {
    caseId: String(options['case-id']),
    role: String(options.role),
    reserveFor: options['reserve-for'] ? String(options['reserve-for']) : null,
    order,
    originalForm: String(options['original-form']),
    unchangedOriginal: true,
    archiveExtractionOnly: options['archive-extraction-only'] === true,
    declaredCapabilities: [...new Set(options.capability.map(String))].sort(),
  },
  files,
  aggregate: { fileCount: files.length, totalBytes },
  sourceManifestHash: sourceManifestHashFromFilesV1(files),
}
const manifest = { ...payload, manifestHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(manifest)
validateSourceCaseManifestSemanticsV1(manifest)

const output = path.resolve(String(options.output))
const publicOutput = path.resolve(String(options['public-output']))
await mkdir(path.dirname(output), { recursive: true })
await mkdir(path.dirname(publicOutput), { recursive: true })
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const publicSummary = {
  schema: 'egolens-source-case-public-summary-v1',
  datasetId: manifest.release.datasetId,
  releaseId: manifest.release.releaseId,
  caseId: manifest.case.caseId,
  role: manifest.case.role,
  reserveFor: manifest.case.reserveFor,
  sourceCaseManifestHash: manifest.manifestHash,
  verifierBinding: manifest.verifierBinding,
  sourceManifestHash: manifest.sourceManifestHash,
  ...manifest.aggregate,
}
await writeFile(publicOutput, `${JSON.stringify(publicSummary, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
process.stdout.write(`${JSON.stringify(publicSummary, null, 2)}\n`)
