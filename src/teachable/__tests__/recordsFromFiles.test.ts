import { describe, expect, it } from 'vitest'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'

describe('records.from_files', () => {
  const collection = { kind: 'binary-collection', files: [{ path: 'lidar/00.pkl', size: 10 }, { path: 'lidar/01.pkl', size: 11 }] }
  it('lists a collection as one row per file with stem and directory', async () => {
    const out = await coreGraphOperatorImplementationsV1['records.from_files']({ collection }, {}, {} as never) as { rows: { rows: Record<string, unknown>[] } }
    expect(out.rows.rows).toEqual([
      { path: 'lidar/00.pkl', index: 0, name: '00.pkl', stem: '00', directory: 'lidar', size: 10 },
      { path: 'lidar/01.pkl', index: 1, name: '01.pkl', stem: '01', directory: 'lidar', size: 11 },
    ])
  })
  it('names the failing input when given records', async () => {
    await expect(Promise.resolve().then(() => coreGraphOperatorImplementationsV1['records.from_files']({ collection: { kind: 'records', rows: [] } }, {}, {} as never)))
      .rejects.toThrow(/GRAPH_COLLECTION_INPUT_INVALID.*got records/u)
  })
  it('is registered with a doc', () => {
    const descriptor = bundledPhase2OperatorRegistry.list().find((op) => op.name === 'records.from_files')
    expect(descriptor?.doc).toContain('sampleData')
  })
})
