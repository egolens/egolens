import { revisionChanges } from '../teachingRevisionSummary'
import { describe, expect, it, vi } from 'vitest'
import { sanitizeProps, validateRecord, valueShape } from '../teachableTelemetrySchema'
import worker from '../../../workers/teachable-telemetry/index'
const record = { event: 'tool_call', case_id: '12345678-1234-1234-1234-123456789abc', sequence: 1, props: { tool: 'inspect', mode: 'json' } }
describe('teaching diagnostic boundary', () => {
  it('excludes paths, URLs, notes, sample values, and unknown codes', () => {
    expect(sanitizeProps({ source: 'remote', url: 'https://secret/?token=abc', note: 'private', code: 'CUSTOM_SECRET', file_count: 3 })).toEqual({ source: 'remote', code: 'other', file_count: 3 })
    const shape = valueShape({ secret_column: ['private', 1234], token: 'abc' })
    expect(shape).not.toMatch(/secret|private|1234|token|abc/)
    expect(validateRecord({ ...record, detail: { shape } })).not.toBeNull()
    expect(validateRecord({ ...record, props: { path: '/private' } })).toBeNull()
    expect(validateRecord({ ...record, detail: { shape: 'secret' } })).toBeNull()
  })
  it('persists only validated fields and never request metadata', async () => {
    const put = vi.fn(async () => {})
    const env = { ALLOWED_ORIGINS: 'https://egolens.org', INGEST_ENABLED: 'true', RECORDS: { put }, INGEST_LIMIT: { limit: vi.fn(async () => ({ success: true })) } }
    const request = (body: unknown, origin = 'https://egolens.org') => new Request('https://telemetry.example/v1/events', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify(body) })
    expect((await worker.fetch(request({ version: 1, records: [{ ...record, secret: 'discard me' }] }), env)).status).toBe(204)
    expect(put.mock.calls).toHaveLength(1)
    expect(JSON.stringify(put.mock.calls)).not.toMatch(/discard me|192.0.2.1/)
    expect((await worker.fetch(request({ version: 1, records: [record] }, 'https://evil.example'), env)).status).toBe(403)
    expect((await worker.fetch(request({ version: 1, records: [{ ...record, props: { token: 'abc' } }] }), env)).status).toBe(400)
    expect((await worker.fetch(request({ padding: 'x'.repeat(17000) }), env)).status).toBe(413)
    env.INGEST_LIMIT.limit.mockResolvedValue({ success: false })
    expect((await worker.fetch(request({ version: 1, records: [record] }), env)).status).toBe(429)
    expect(put.mock.calls).toHaveLength(1)
  })
})

it('captures parameter-value changes without transmitting values or user identifiers', () => {
  const recipe = (scale: number) => ({ pipelines: { confidential: { nodes: [{ id: 'private-node', op: 'records.derive', params: { derive: [{ scale, from: '/secret/file' }] }, inputs: { rows: 'private.rows' } }] } } })
  const changes = revisionChanges(recipe(1), recipe(1000000))
  expect(changes).toEqual([{ operator: 'records.derive', change: 'modified', parameters: ['derive'], inputs_changed: 0 }])
  expect(JSON.stringify(changes)).not.toMatch(/secret|private|1000000/)
  expect(validateRecord({ ...record, detail: { changes } })).not.toBeNull()
})
