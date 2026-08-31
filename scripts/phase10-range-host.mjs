#!/usr/bin/env node

import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeContentBlindPathV1, phase10HashV1 } from './lib/phase10-evidence.mjs'

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

function headers(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ...extra,
  }
}

function exactRange(raw, size) {
  if (!raw) return null
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(raw)
  if (!match) throw new Error('Only one canonical closed byte range is supported')
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= size) {
    throw new RangeError('Requested range is outside the catalog entry')
  }
  return { start, end }
}

const options = args(process.argv.slice(2))
for (const name of ['root', 'catalog', 'recipe', 'port']) if (!options[name]) throw new Error(`Missing --${name}`)
const port = Number(options.port)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error('--port must be between 1024 and 65535')
const root = path.resolve(options.root)
const rootDetails = await lstat(root)
if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new Error('--root must be a non-symlink directory')
const catalogBytes = await readFile(path.resolve(options.catalog))
const recipeBytes = await readFile(path.resolve(options.recipe))
const descriptorBytes = options.descriptor ? await readFile(path.resolve(options.descriptor)) : null
const catalog = JSON.parse(catalogBytes.toString('utf8'))
const expectedCatalogHash = phase10HashV1({ schema: catalog.schema, entries: catalog.entries })
if (catalog.schema !== 'egolens-source-catalog-v1' || catalog.catalogHash !== expectedCatalogHash) {
  throw new Error('Catalog hash or schema is invalid')
}
const byPath = new Map(catalog.entries.map((entry) => [entry.path, entry]))
if (byPath.size !== catalog.entries.length) throw new Error('Catalog contains duplicate paths')
const confinedRoot = `${root}${path.sep}`

const fixed = new Map([
  ['/catalog.json', { bytes: catalogBytes, type: 'application/json' }],
  ['/recipe.json', { bytes: recipeBytes, type: 'application/json' }],
  ...(descriptorBytes ? [['/share.json', { bytes: descriptorBytes, type: 'application/json' }]] : []),
])
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers())
      response.end()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, headers({ Allow: 'GET, HEAD, OPTIONS' }))
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (fixed.has(url.pathname)) {
      const asset = fixed.get(url.pathname)
      response.writeHead(200, headers({
        'Content-Type': asset.type,
        'Content-Length': String(asset.bytes.byteLength),
      }))
      if (request.method === 'GET') response.end(asset.bytes)
      else response.end()
      return
    }
    if (!url.pathname.startsWith('/source/')) throw new Error('Not found')
    const relative = normalizeContentBlindPathV1(decodeURIComponent(url.pathname.slice('/source/'.length)))
    const entry = byPath.get(relative)
    if (!entry) throw new Error('Not found')
    const filename = path.resolve(root, ...relative.split('/'))
    if (!filename.startsWith(confinedRoot)) throw new Error('Source path escapes root')
    const details = await lstat(filename)
    if (details.isSymbolicLink() || !details.isFile() || details.size !== entry.size) {
      throw new Error('Hosted source no longer matches its catalog')
    }
    let range
    try {
      range = exactRange(request.headers.range, entry.size)
    } catch (error) {
      response.writeHead(416, headers({ 'Content-Range': `bytes */${entry.size}` }))
      response.end()
      return
    }
    const start = range?.start ?? 0
    const end = range?.end ?? Math.max(0, entry.size - 1)
    const length = entry.size === 0 ? 0 : end - start + 1
    response.writeHead(range ? 206 : 200, headers({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      ETag: `"${entry.sha256}"`,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${entry.size}` } : {}),
    }))
    if (request.method === 'HEAD' || length === 0) response.end()
    else createReadStream(filename, { start, end }).pipe(response)
  } catch {
    response.writeHead(404, headers({ 'Content-Type': 'text/plain', 'Content-Length': '9' }))
    response.end(request.method === 'HEAD' ? undefined : 'Not found')
  }
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
const origin = `http://127.0.0.1:${port}`
process.stdout.write(`${JSON.stringify({
  schema: 'egolens-phase10-range-host-ready-v1',
  origin,
  rootUrl: `${origin}/source/`,
  catalogUrl: `${origin}/catalog.json`,
  recipeUrl: `${origin}/recipe.json`,
  descriptorUrl: descriptorBytes ? `${origin}/share.json` : null,
})}\n`)
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
