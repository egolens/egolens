#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { phase10HashV1 } from './lib/phase10-evidence.mjs'
import { validatePhase10SchemaV1 } from './lib/phase10-schema.mjs'

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs', '.txt'])
const COMMON_DENIED = [
  '-----BEGIN PRIVATE KEY-----',
  'PHASE6_ORACLE_JUDGE_PRIVATE_KEY',
  'PHASE9_AMNESIA_EVIDENCE_',
  '/Users/',
  '/home/',
  'C:\\Users\\',
]
const PRODUCTION_DENIED = [
  ...COMMON_DENIED,
  'A2D2',
  'KITTI Raw',
  'PandaSet',
  'ONCE for Autonomous Driving',
  'phase9-oracle-judge.mjs',
]
const AUTHOR_DENIED = [
  ...COMMON_DENIED,
  'Waymo Open Dataset',
  'nuScenes',
  'Argoverse 2',
  'A2D2',
  'KITTI Raw',
  'PandaSet',
  'egolens-hidden-oracle',
  'oracleCapture',
  'phase6-oracle',
  'phase9-oracle',
  'useSceneStore',
]

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

async function inventory(directory) {
  const files = []
  const visit = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Build output contains a symbolic link: ${relative}`)
      if (entry.isDirectory()) await visit(absolute, relative)
      else if (entry.isFile()) {
        const stat = await lstat(absolute)
        const bytes = await readFile(absolute)
        files.push({
          path: relative,
          size: stat.size,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          text: TEXT_EXTENSIONS.has(path.extname(relative)) ? bytes.toString('utf8') : null,
        })
      } else {
        throw new Error(`Build output contains a non-regular entry: ${relative}`)
      }
    }
  }
  await visit(directory, '')
  if (files.length === 0) throw new Error(`Build output is empty: ${directory}`)
  return files
}

function inspect(name, files, denied, expectedCommit) {
  const sourceMap = files.find((file) => file.path.endsWith('.map'))
  if (sourceMap) throw new Error(`${name} build emitted a source map: ${sourceMap.path}`)
  const text = files.filter((file) => file.text !== null).map((file) => file.text).join('\n')
  const marker = denied.find((value) => text.includes(value))
  if (marker) throw new Error(`${name} build emitted denied marker: ${marker}`)
  if (!text.includes(expectedCommit)) throw new Error(`${name} build does not bind the exact candidate commit`)
  const publicFiles = files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 }))
  return {
    name,
    fileCount: publicFiles.length,
    totalBytes: publicFiles.reduce((sum, file) => sum + file.size, 0),
    inventoryHash: phase10HashV1(publicFiles),
    sourceMaps: 0,
    deniedMarkers: 0,
    exactCommitEmbedded: true,
    passed: true,
  }
}

const options = args(process.argv.slice(2))
for (const name of ['production', 'author', 'expected-commit']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
if (!/^[0-9a-f]{40}$/u.test(options['expected-commit'])) throw new Error('--expected-commit must be a full Git SHA')
const [productionFiles, authorFiles] = await Promise.all([
  inventory(path.resolve(options.production)),
  inventory(path.resolve(options.author)),
])
const payload = {
  schema: 'egolens-phase10-build-boundary-report-v1',
  candidateCommit: options['expected-commit'],
  production: inspect('production', productionFiles, PRODUCTION_DENIED, options['expected-commit']),
  author: inspect('author', authorFiles, AUTHOR_DENIED, options['expected-commit']),
  passed: true,
}
const report = { ...payload, reportHash: phase10HashV1(payload) }
await validatePhase10SchemaV1(report)
if (options.output) {
  await writeFile(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
