#!/usr/bin/env node

// Offline, format-agnostic staging. Extract the approved archive before running.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { canonicalize } from './lib/oracle-receipts.mjs'

export const CHUNK_SIZE = 1024 * 1024
export const MAX_ENTRIES = 50_000
export const MAX_CATALOG_BYTES = 16 * 1024 * 1024
const SCHEMA = 'egolens-source-catalog-v1'
const CATALOG_NAME = 'source-catalog.json'
const repository = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const schema = JSON.parse(await readFile(new URL('../src/teachable/schema/egolens-source-catalog-v1.schema.json', import.meta.url), 'utf8'))
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(schema)
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const hashJson = (value) => digest(canonicalize(value))
const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`)

function assertPath(relative) {
  if (!relative || relative.length > 4096 || !relative.isWellFormed()
    || relative.includes('\\') || /^[A-Za-z]:/u.test(relative)
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Noncanonical source path: ${relative}`)
  }
}

function stamp(details) {
  return [details.dev, details.ino, details.size, details.mtimeMs, details.ctimeMs, details.mode].join(':')
}

async function scan(root, excludeCatalog = false) {
  const files = []
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      assertPath(relative)
      const filename = path.join(directory, entry.name)
      const details = await lstat(filename)
      if (details.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${relative}`)
      if (details.isDirectory()) {
        await visit(filename, relative)
      } else if (details.isFile()) {
        if (relative === CATALOG_NAME) {
          if (excludeCatalog) continue
          throw new Error('Source already contains source-catalog.json; refusing to replace an original file')
        }
        if (!Number.isSafeInteger(details.size)) throw new Error(`Invalid file size: ${relative}`)
        files.push({ path: relative, size: details.size, stamp: stamp(details) })
        if (files.length > MAX_ENTRIES) throw new Error('Source catalog exceeds the 50000 entry limit')
      } else {
        throw new Error(`Source is not a regular file: ${relative}`)
      }
    }
  }
  await visit(root)
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

async function directoryRoot(root) {
  if (!root) throw new Error('Missing source root')
  const details = await lstat(path.resolve(root))
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('Root must be a non-symlink directory')
  return realpath(root)
}

// Resolve even nonexistent destinations through existing symlinked ancestors.
async function resolveOutput(output) {
  try {
    return await realpath(output)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(output)
    if (parent === output) throw error
    return path.join(await resolveOutput(parent), path.basename(output))
  }
}

async function hashFile(root, expected) {
  const filename = path.join(root, ...expected.path.split('/'))
  // O_NOFOLLOW rejects replacement of the final component with a symlink.
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || stamp(before) !== expected.stamp) throw new Error(`Source changed: ${expected.path}`)
    const full = createHash('sha256')
    const digests = []
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
    for (let offset = 0; offset < expected.size; offset += CHUNK_SIZE) {
      const length = Math.min(CHUNK_SIZE, expected.size - offset)
      let read = 0
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, offset + read)
        if (bytesRead === 0) throw new Error(`Short read: ${expected.path}`)
        read += bytesRead
      }
      const bytes = buffer.subarray(0, length)
      full.update(bytes)
      digests.push(digest(bytes))
    }
    if (stamp(await handle.stat()) !== expected.stamp || stamp(await lstat(filename)) !== expected.stamp) {
      throw new Error(`Source changed while hashing: ${expected.path}`)
    }
    return { path: expected.path, size: expected.size, sha256: `sha256:${full.digest('hex')}`, chunks: { size: CHUNK_SIZE, digests } }
  } finally {
    await handle.close()
  }
}

export function validateCatalog(catalog) {
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`
  if (Buffer.byteLength(serialized) > MAX_CATALOG_BYTES) throw new Error('Source catalog exceeds the 16 MiB byte limit')
  if (!validateSchema(catalog)) throw new Error(`Invalid source catalog: ${JSON.stringify(validateSchema.errors)}`)
  let previous = ''
  for (const entry of catalog.entries) {
    assertPath(entry.path)
    if (entry.path === CATALOG_NAME) throw new Error('Catalog must not include itself')
    if (previous && previous >= entry.path) throw new Error('Catalog paths must be unique and sorted')
    if (entry.chunks?.size !== CHUNK_SIZE || entry.chunks.digests.length !== Math.ceil(entry.size / CHUNK_SIZE)) {
      throw new Error(`Invalid 1 MiB chunks: ${entry.path}`)
    }
    previous = entry.path
  }
  if (catalog.catalogHash !== hashJson({ schema: catalog.schema, entries: catalog.entries })) {
    throw new Error('Catalog hash mismatch')
  }
  return serialized
}

function summary(root, catalog, catalogBytes) {
  const totalBytes = catalog.entries.reduce((total, entry) => total + entry.size, 0)
  if (!Number.isSafeInteger(totalBytes + catalogBytes)) throw new Error('Total size is not a safe integer')
  return {
    stagedPath: root,
    catalogPath: path.join(root, CATALOG_NAME),
    catalogHash: catalog.catalogHash,
    sourceManifestHash: hashJson({ version: 1, entries: catalog.entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })) }),
    entryCount: catalog.entries.length,
    totalBytes,
    catalogBytes,
    stagedBytes: totalBytes + catalogBytes,
    chunkSize: CHUNK_SIZE,
    verifiedChunks: catalog.entries.reduce((total, entry) => total + entry.chunks.digests.length, 0),
  }
}

export async function verifyHostedSample({ root, onProgress = () => {} }) {
  root = await directoryRoot(root)
  const catalogPath = path.join(root, CATALOG_NAME)
  const details = await lstat(catalogPath)
  if (!details.isFile() || details.size > MAX_CATALOG_BYTES) throw new Error('Invalid catalog file or byte limit')
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  validateCatalog(catalog)
  const files = await scan(root, true)
  if (files.length !== catalog.entries.length) throw new Error('Staged file count differs from catalog')
  for (const [index, file] of files.entries()) {
    if (file.path !== catalog.entries[index].path) throw new Error('Staged file paths differ from catalog')
    const actual = await hashFile(root, file)
    const expected = catalog.entries[index]
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256
      || canonicalize(actual.chunks) !== canonicalize(expected.chunks)) {
      throw new Error(`Staged bytes or chunks differ from catalog: ${file.path}`)
    }
    onProgress({ verified: index + 1, total: files.length })
  }
  if (canonicalize(await scan(root, true)) !== canonicalize(files)) throw new Error('Staged tree changed during verification')
  return summary(root, catalog, details.size)
}

export async function prepareHostedSample({ root, output, onProgress = () => {} }) {
  root = await directoryRoot(root)
  if (!output) throw new Error('Missing output directory')
  output = await resolveOutput(path.resolve(output))
  if (contains(repository, output) || contains(output, repository)) throw new Error('Output must be outside the repository')
  if (contains(root, output) || contains(output, root)) throw new Error('Source and output directories must not overlap')
  const files = await scan(root)
  if (files.length === 0) throw new Error('Source contains no files')
  await mkdir(path.dirname(output), { recursive: true })
  // Exclusive creation: existing directories are never merged, overwritten, or removed.
  await mkdir(output)
  try {
    const entries = []
    for (const [index, file] of files.entries()) {
      entries.push(await hashFile(root, file))
      const destination = path.join(output, ...file.path.split('/'))
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(path.join(root, ...file.path.split('/')), destination, constants.COPYFILE_EXCL)
      onProgress({ copied: index + 1, total: files.length })
    }
    if (canonicalize(await scan(root)) !== canonicalize(files)) throw new Error('Source tree changed during staging')
    const payload = { schema: SCHEMA, entries }
    const catalog = { ...payload, catalogHash: hashJson(payload) }
    await writeFile(path.join(output, CATALOG_NAME), validateCatalog(catalog), { flag: 'wx', mode: 0o644 })
    // Re-read every copied byte; successful preparation includes full/chunk verification.
    return await verifyHostedSample({ root: output, onProgress })
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: node scripts/prepare-hosted-sample.mjs --root EXTRACTED --output NEW_EXTERNAL_DIRECTORY\n       node scripts/prepare-hosted-sample.mjs --verify STAGED_DIRECTORY\nOffline only. Preserves all source file bytes; adds source-catalog.json with verified 1 MiB chunks.\n')
    return
  }
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!['--root', '--output', '--verify'].includes(key) || options[key] !== undefined
      || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Invalid or duplicate argument: ${key}`)
    options[key] = argv[index + 1]
  }
  const onProgress = ({ copied, verified, total }) => {
    const count = copied ?? verified
    if (count % 100 === 0 || count === total) process.stderr.write(`[hosted-sample] ${copied ? 'copied' : 'verified'} ${count}/${total}\n`)
  }
  let result
  if (options['--verify'] && Object.keys(options).length === 1) {
    result = await verifyHostedSample({ root: options['--verify'], onProgress })
  } else if (!options['--verify'] && options['--root'] && options['--output']) {
    result = await prepareHostedSample({ root: options['--root'], output: options['--output'], onProgress })
  } else {
    throw new Error('Use --root DIR --output NEW_DIR, or --verify DIR (see --help)')
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[hosted-sample] ${error.message}\n`)
    process.exitCode = 1
  })
}
