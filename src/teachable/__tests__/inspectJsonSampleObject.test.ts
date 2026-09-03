import { describe, expect, it } from 'vitest'
import { sourceInventoryFromFilesV1 } from '../authoring/SourceInventory'
import { inspectSourceInventoryV1 } from '../authoring/inspection'

describe('json-sample on a top-level object', () => {
  it('returns bounded keys instead of refusing', async () => {
    const inventory = sourceInventoryFromFilesV1([['camera/front/intrinsics.json', new File([JSON.stringify({ fx: 1970.0, fy: 1970.0, cx: 970.5, cy: 483.5 })], 'intrinsics.json')]])
    const result = await inspectSourceInventoryV1(inventory, { mode: 'json-sample', path: 'camera/front/intrinsics.json' })
    expect((result.data as { shape: string; value: Record<string, unknown> }).shape).toBe('object')
    expect((result.data as { value: Record<string, unknown> }).value).toEqual({ fx: 1970, fy: 1970, cx: 970.5, cy: 483.5 })
  })
  it('still samples leading records of an array', async () => {
    const inventory = sourceInventoryFromFilesV1([['meta/timestamps.json', new File([JSON.stringify([1.5, 2.5, 3.5])], 'timestamps.json')]])
    const result = await inspectSourceInventoryV1(inventory, { mode: 'json-sample', path: 'meta/timestamps.json', maxValues: 2 })
    expect((result.data as { records: unknown[] }).records).toEqual([1.5, 2.5])
  })
})
