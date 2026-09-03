import { describe, expect, it } from 'vitest'
import { sourceInventoryFromFilesV1 } from '../authoring/SourceInventory'
import { inspectSourceInventoryV1 } from '../authoring/inspection'

describe('inspect value budgets', () => {
  const inventory = sourceInventoryFromFilesV1([['meta/poses.json', new File([JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ i })))], 'poses.json')]])
  it('clamps an oversized json-sample budget instead of failing', async () => {
    const result = await inspectSourceInventoryV1(inventory, { mode: 'json-sample', path: 'meta/poses.json', maxValues: 500 })
    expect(result.mode).toBe('json-sample')
  })
  it('still rejects non-numeric budgets', async () => {
    await expect(inspectSourceInventoryV1(inventory, { mode: 'json-sample', path: 'meta/poses.json', maxValues: Number.NaN })).rejects.toThrow(/maxValues/u)
  })
})
