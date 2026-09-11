import { validateRecord } from '../../src/utils/teachableTelemetrySchema'
interface Env {
  ALLOWED_ORIGINS: string
  INGEST_ENABLED: string
  RECORDS: { put(key: string, value: string, options: { httpMetadata: { contentType: string } }): Promise<unknown> }
  INGEST_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> }
}
const MAX_BYTES = 16 * 1024
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? ''
    const headers = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' }
    if (!env.ALLOWED_ORIGINS.split(',').includes(origin)) return new Response(null, { status: 403 })
    if (new URL(request.url).pathname !== '/v1/events') return new Response(null, { status: 404, headers })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return new Response(null, { status: 405, headers })
    if (env.INGEST_ENABLED !== 'true') return new Response(null, { status: 503, headers })
    if (!(await env.INGEST_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })).success) return new Response(null, { status: 429, headers })
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return new Response(null, { status: 415, headers })
    if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return new Response(null, { status: 413, headers })
    const reader = request.body?.getReader()
    if (!reader) return new Response(null, { status: 400, headers })
    let total = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) { await reader.cancel(); return new Response(null, { status: 413, headers }) }
      chunks.push(value)
    }
    try {
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const body = JSON.parse(new TextDecoder().decode(bytes))
      if (body.version !== 1 || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 8) return new Response(null, { status: 400, headers })
      const records = body.records.map(validateRecord)
      if (records.some((r: unknown) => !r)) return new Response(null, { status: 400, headers })
      const receivedAt = new Date().toISOString()
      // Private, append-only batches. Never persist request headers, IP, URL, or raw body.
      const receipt = `events/${receivedAt.slice(0, 10)}/${crypto.randomUUID()}.json`
      await env.RECORDS.put(receipt, JSON.stringify({ version: 1, receivedAt, records }), { httpMetadata: { contentType: 'application/json' } })
      return new Response(null, { status: 204, headers: { ...headers, 'X-EgoLens-Receipt': receipt } })
    } catch { return new Response(null, { status: 400, headers }) }
  },
}
