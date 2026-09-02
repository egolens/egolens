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

function requestOrigin(request) {
  const raw = request.headers.origin
  if (typeof raw !== 'string') return null
  try {
    const origin = new URL(raw)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
      || !origin.port || origin.pathname !== '/' || origin.search || origin.hash
      || origin.username || origin.password) return null
    const port = Number(origin.port)
    return Number.isSafeInteger(port) && port >= 1024 && port <= 65_535 ? origin.origin : null
  } catch {
    return null
  }
}

function headers(origin, extra = {}) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
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
for (const name of ['root', 'catalog', 'recipe', 'descriptor', 'port']) {
  if (!options[name]) throw new Error(`Missing --${name}`)
}
const port = Number(options.port)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error('--port must be between 1024 and 65535')
const root = path.resolve(options.root)
const rootDetails = await lstat(root)
if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new Error('--root must be a non-symlink directory')
const catalogBytes = await readFile(path.resolve(options.catalog))
const recipeBytes = await readFile(path.resolve(options.recipe))
const descriptorBytes = await readFile(path.resolve(options.descriptor))
const catalog = JSON.parse(catalogBytes.toString('utf8'))
const expectedCatalogHash = phase10HashV1({ schema: catalog.schema, entries: catalog.entries })
if (catalog.schema !== 'egolens-source-catalog-v1' || catalog.catalogHash !== expectedCatalogHash) {
  throw new Error('Catalog hash or schema is invalid')
}
const byPath = new Map(catalog.entries.map((entry) => [entry.path, entry]))
if (byPath.size !== catalog.entries.length) throw new Error('Catalog contains duplicate paths')
const confinedRoot = `${root}${path.sep}`
const origin = `http://127.0.0.1:${port}`
const descriptor = JSON.parse(descriptorBytes.toString('utf8'))
const protectedUrls = [
  descriptor?.source?.rootUrl,
  descriptor?.source?.catalogUrl,
  descriptor?.recipe?.url,
].map((raw) => new URL(raw))
const capabilityMatches = protectedUrls.map((url) =>
  /^\/access\/([0-9a-f]{64})\/(?:source\/|catalog\.json$|recipe\.json$)/u.exec(url.pathname))
const capability = capabilityMatches[0]?.[1]
if (!capability || capabilityMatches.some((match) => match?.[1] !== capability)
  || protectedUrls.some((url) => url.origin !== origin || url.search || url.hash)
  || descriptor.source.rootUrl !== `${origin}/access/${capability}/source/`
  || descriptor.source.catalogUrl !== `${origin}/access/${capability}/catalog.json`
  || descriptor.recipe.url !== `${origin}/access/${capability}/recipe.json`) {
  throw new Error('Descriptor does not bind one high-entropy capability on this exact range host')
}
const capabilityRoot = `/access/${capability}`

const fixed = new Map([
  [`${capabilityRoot}/catalog.json`, { bytes: catalogBytes, type: 'application/json' }],
  [`${capabilityRoot}/recipe.json`, { bytes: recipeBytes, type: 'application/json' }],
  [`${capabilityRoot}/share.json`, { bytes: descriptorBytes, type: 'application/json' }],
])
const server = createServer(async (request, response) => {
  try {
    const allowedOrigin = requestOrigin(request)
    if (!allowedOrigin || request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403, { 'Cache-Control': 'no-store', 'Content-Length': '0', Vary: 'Origin' })
      response.end()
      return
    }
    if (request.method === 'OPTIONS') {
      if (!['GET', 'HEAD'].includes(String(request.headers['access-control-request-method']))) {
        response.writeHead(403, { 'Cache-Control': 'no-store', 'Content-Length': '0', Vary: 'Origin' })
        response.end()
        return
      }
      response.writeHead(204, headers(allowedOrigin))
      response.end()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, headers(allowedOrigin, { Allow: 'GET, HEAD, OPTIONS' }))
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.search || url.hash) throw new Error('Capability requests cannot carry query or fragment data')
    if (fixed.has(url.pathname)) {
      const asset = fixed.get(url.pathname)
      response.writeHead(200, headers(allowedOrigin, {
        'Content-Type': asset.type,
        'Content-Length': String(asset.bytes.byteLength),
      }))
      if (request.method === 'GET') response.end(asset.bytes)
      else response.end()
      return
    }
    const sourcePrefix = `${capabilityRoot}/source/`
    if (!url.pathname.startsWith(sourcePrefix)) throw new Error('Not found')
    const relative = normalizeContentBlindPathV1(decodeURIComponent(url.pathname.slice(sourcePrefix.length)))
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
      response.writeHead(416, headers(allowedOrigin, { 'Content-Range': `bytes */${entry.size}` }))
      response.end()
      return
    }
    const start = range?.start ?? 0
    const end = range?.end ?? Math.max(0, entry.size - 1)
    const length = entry.size === 0 ? 0 : end - start + 1
    response.writeHead(range ? 206 : 200, headers(allowedOrigin, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      ETag: `"${entry.sha256}"`,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${entry.size}` } : {}),
    }))
    if (request.method === 'HEAD' || length === 0) response.end()
    else createReadStream(filename, { start, end }).pipe(response)
  } catch {
    const allowedOrigin = requestOrigin(request)
    const errorHeaders = allowedOrigin
      ? headers(allowedOrigin, { 'Content-Type': 'text/plain', 'Content-Length': '9' })
      : { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain', 'Content-Length': '9', Vary: 'Origin' }
    response.writeHead(404, errorHeaders)
    response.end(request.method === 'HEAD' ? undefined : 'Not found')
  }
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
process.stdout.write(`${JSON.stringify({
  schema: 'egolens-phase10-range-host-ready-v1',
  origin,
  rootUrl: `${origin}${capabilityRoot}/source/`,
  catalogUrl: `${origin}${capabilityRoot}/catalog.json`,
  recipeUrl: `${origin}${capabilityRoot}/recipe.json`,
  descriptorUrl: `${origin}${capabilityRoot}/share.json`,
})}\n`)
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
