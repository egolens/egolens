import { createServer } from 'node:http'
import type { AsyncBuffer } from 'hyparquet'
import { SourceInventoryV1 } from '../authoring/SourceInventory'
import type { ByteSourceBackingV1 } from '../source/ByteSource'
import { generateSourceCatalogV1, sourceCatalogInventoryEntriesV1 } from '../source/SourceCatalog'

async function backingBytes(backing: ByteSourceBackingV1): Promise<ArrayBuffer> {
  if (typeof backing === 'string') throw new Error('REMOTE_FIXTURE_URL_BACKING_UNSUPPORTED')
  if (backing instanceof File) return await backing.arrayBuffer()
  return await (backing as AsyncBuffer).slice(0, backing.byteLength)
}

export async function remoteTransportFixtureV1(
  rawEntries: Iterable<readonly [string, ByteSourceBackingV1]>,
) {
  const entries = [...rawEntries]
  const hosted = new Map<string, Uint8Array>()
  const localFiles = new Map<string, File>()
  for (const [path, backing] of entries) {
    const bytes = new Uint8Array(await backingBytes(backing))
    hosted.set(path, bytes)
    const type = backing instanceof File ? backing.type : 'application/octet-stream'
    localFiles.set(path, new File([bytes], path.split('/').at(-1) ?? 'source.bin', { type }))
  }
  const inventory = new SourceInventoryV1(localFiles)
  const validated = await generateSourceCatalogV1(inventory, { transportChunkSize: 65_536 })
  const requests: Array<{ readonly path: string; readonly range: string | null }> = []
  const rootPath = '/original-source/'
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.startsWith(rootPath)
      ? url.pathname.slice(rootPath.length).split('/').map(decodeURIComponent).join('/')
      : ''
    const bytes = hosted.get(path)
    const range = typeof request.headers.range === 'string' ? request.headers.range : null
    requests.push({ path, range })
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range')
    response.setHeader('Accept-Ranges', 'bytes')
    if (!bytes) {
      response.writeHead(404)
      response.end()
      return
    }
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range)
      if (!match) {
        response.writeHead(416)
        response.end()
        return
      }
      const start = Number(match[1])
      const end = Number(match[2]) + 1
      const body = bytes.slice(start, end)
      response.writeHead(206, {
        'content-length': String(body.byteLength),
        'content-range': `bytes ${start}-${end - 1}/${bytes.byteLength}`,
      })
      response.end(body)
      return
    }
    const body = bytes.slice()
    response.writeHead(200, { 'content-length': String(body.byteLength) })
    response.end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('REMOTE_FIXTURE_LISTEN_FAILED')
  const rootUrl = `http://127.0.0.1:${address.port}${rootPath}`
  const remote = {
    rootUrl,
    catalog: validated.catalog,
    expectedCatalogHash: validated.catalogHash,
    expectedSourceManifestHash: validated.sourceManifestHash,
  }
  return {
    remote,
    inventory,
    inventoryEntries: sourceCatalogInventoryEntriesV1(validated.catalog),
    catalog: validated.catalog,
    sourceManifestHash: validated.sourceManifestHash,
    requests,
    async dispose() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
