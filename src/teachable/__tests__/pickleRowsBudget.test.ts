import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'

const fixture = new Uint8Array(readFileSync(path.join(__dirname, '..', '__fixtures__', 'pandas-lidar-sample.pkl.gz')))
const context = {
  signal: new AbortController().signal,
  throwIfAborted() {},
  async read() { return fixture },
} as never

describe('archive.pickle_rows row budget', () => {
  const files = [{ path: 'lidar/00.pkl.gz', size: fixture.byteLength }, { path: 'lidar/01.pkl.gz', size: fixture.byteLength }]
  it('materializes metadata-sized tables', async () => {
    const out = await coreGraphOperatorImplementationsV1['archive.pickle_rows']({ files }, { pathField: 'path' }, context) as { rows: { rows: unknown[] } }
    expect(out.rows.rows).toHaveLength(4)
  })
  it('refuses to materialize past the budget and points at the streaming reader', async () => {
    await expect(coreGraphOperatorImplementationsV1['archive.pickle_rows']({ files }, { maxTotalRows: 3 }, context))
      .rejects.toThrow(/GRAPH_ROWS_BUDGET_EXCEEDED.*lidar\/01\.pkl\.gz.*archive\.pickle_records/u)
  })
})
