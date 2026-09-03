import { describe, expect, it } from 'vitest'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'

const rows = { kind: 'records', rows: [{ frame_index: 0, value: 1557539924.49981 }, { frame_index: 7, value: 1557539925.2 }] }
const derive = (params: Record<string, unknown>) => coreGraphOperatorImplementationsV1['records.derive']({ rows }, params, {} as never) as Promise<{ rows: { rows: Record<string, unknown>[] } }>

describe('records.derive without a pattern', () => {
  it('copies and pads a numeric field instead of dropping the row (the agent timeline case)', async () => {
    const out = await derive({ derive: [{ field: 'frame_key', from: 'frame_index', pad: 2, padChar: '0' }, { field: 'timestamp_us', from: 'value', scale: 1000000, integer: true }] })
    expect(out.rows.rows.map((r) => r.frame_key)).toEqual(['00', '07'])
    expect(out.rows.rows[0]!.timestamp_us).toBe(1557539924499810)
  })
  it('keeps rows whose copied field is missing unless required is true', async () => {
    const lax = await derive({ derive: [{ field: 'x', from: 'missing' }] })
    expect(lax.rows.rows).toHaveLength(2)
    const strict = await derive({ derive: [{ field: 'x', from: 'missing', required: true }] })
    expect(strict.rows.rows).toHaveLength(0)
  })
  it('still drops rows when a pattern does not match', async () => {
    const out = await derive({ derive: [{ field: 'k', from: 'frame_index', pattern: '^7$', replacement: 'seven' }] })
    expect(out.rows.rows.map((r) => r.k)).toEqual(['seven'])
  })
})
